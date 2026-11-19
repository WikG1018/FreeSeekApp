import { memo, useMemo, type RefObject } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { isContextRejection } from '../../services/api/knownErrors.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import {
  applicableSummary,
  CONTEXT_NEAR_LIMIT,
  contextLength,
  contextReplyReserve,
  contextRounds,
  estimateContextHistory,
  estimatedFileTokens,
  estimatedSystemTokens,
  estimatedTokens,
  formatContextTokens,
  type ContextModel,
} from '../../services/chat/contextCompression.js'
import { EMPTY_DRAFT, useDrafts } from '../../services/chat/drafts.js'
import { replySystemPrompt, useChatStore } from '../../services/chat/store.js'
import { usePersonas } from '../../services/personas.js'
import { providerModelLabel, useProviders } from '../../services/providers.js'
import { IconCloseOutline16 } from '../base/icons.js'
import { useOptionPanel } from '../base/OptionPanel.js'
import styles from './ContextUsage.module.css'

const RING_LENGTH = 2 * Math.PI * 8

export const ContextUsage = memo(function ContextUsage({
  sessionId,
  editorRef,
  disabled,
}: {
  sessionId: string | null
  editorRef: RefObject<HTMLTextAreaElement>
  disabled: boolean
}) {
  const t = useTranslate()
  const { providerId, model } = useProviders((state) => state.selection)
  const official = providerId === 'deepseek'
  const profile = useProviders((state) =>
    official ? undefined : state.profiles.find((item) => item.id === providerId)
  )
  const connection: ContextModel | undefined = official
    ? { kind: 'deepseek' }
    : profile && { kind: 'custom', model, profile }
  // Recalculate settled history after generation or compression, never on stream frames.
  const session = useChatStore((state) =>
    sessionId !== null && !state.streaming[sessionId] ? state.sessionCache[sessionId] : undefined
  )
  const inheritance = useChatStore((state) => (sessionId === null ? state.inheritFrom : null))
  const defaultPrompt = usePersonas((state) =>
    sessionId === null
      ? state.personas.find((item) => item.id === state.defaultId)?.prompt
      : undefined
  )
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const visible = useMemo(() => (session ? getVisibleMessages(session) : []), [session])
  const lastReply = visible.at(-1)
  const lastQuestion = visible.at(-2)
  const lastError =
    lastReply?.role === 'assistant' && lastReply.status === 'error'
      ? lastReply.error?.localMessage
      : undefined
  const rejected =
    isContextRejection(lastError?.key) ||
    lastError?.key === 'compressionInputLarge' ||
    lastError?.key === 'compressionStillTooLong' ||
    lastError?.key === 'replyDocumentInputLimit'
  const reported = lastError?.params
  const requestFiles = Number(
    reported?.requestQuestionFiles ??
      (lastQuestion?.role === 'user' ? lastQuestion.files.length : 0)
  )
  const requestDocs = Number(reported?.requestDocumentCount)
  const documentLimit = Number(reported?.documentLimit)
  const requestCount = Number(reported?.requestedTokens)
  const requestLimit = Number(reported?.contextLimitTokens)
  const requestEstimate = Number(reported?.estimatedRequestTokens)
  const historyTokens = useMemo(() => {
    if (sessionId !== null && !session) {
      return undefined
    }
    const rounds = contextRounds(visible, session?.inherited ?? inheritance)
    const summary = applicableSummary(
      session?.contextSummary ?? inheritance?.contextSummary,
      rounds
    )
    return estimateContextHistory(rounds, summary).tokens
  }, [inheritance, session, sessionId, visible])
  const draftTokens = useMemo(
    () =>
      estimatedTokens(draft.text.trim()) +
      draft.attachments.reduce(
        (total, file) => total + estimatedFileTokens(file.file.size, file.isImage),
        0
      ),
    [draft]
  )
  const prompt = session?.persona?.prompt ?? defaultPrompt
  const systemTokens = useMemo(
    () => estimatedSystemTokens(replySystemPrompt(prompt, official)),
    [prompt, official]
  )
  const history = historyTokens === undefined ? undefined : historyTokens + systemTokens
  const reserved = connection ? contextReplyReserve(connection) : undefined
  const limit = connection ? contextLength(connection) : undefined
  const ratio = history !== undefined && limit ? history / limit : null
  const roundedPercent = Math.round((ratio ?? 0) * 100)
  const percent = ratio === null ? null : ratio < 1 ? Math.min(99, roundedPercent) : roundedPercent
  const progress = Math.min(1, ratio ?? 0)
  const level = progress >= 1 ? 'full' : progress >= CONTEXT_NEAR_LIMIT ? 'near' : undefined
  const title = t('contextUsageTitle')
  const label = percent === null ? title : t('contextUsageLabel', { percent })
  const displayModel = providerModelLabel(model, profile)
  const panel = useOptionPanel(title, {
    side: 'top',
    kind: 'details',
    align: 'end',
    editorRef,
    disabled,
    measureKey: draft,
  })

  return (
    <>
      <button
        type="button"
        ref={panel.anchorRef}
        className={styles.trigger}
        data-testid="context-usage"
        data-toolbar-control="context"
        data-level={level}
        aria-label={label}
        title={label}
        disabled={disabled}
        {...panel.trigger}
      >
        <span className={styles.face}>
          <svg
            className={styles.ring}
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="none"
            strokeWidth="2.5"
          >
            <circle className={styles.ringTrack} cx="10" cy="10" r="8" />
            <circle
              className={styles.ringFill}
              cx="10"
              cy="10"
              r="8"
              strokeDasharray={RING_LENGTH}
              strokeDashoffset={RING_LENGTH * (1 - progress)}
              transform="rotate(-90 10 10)"
            />
          </svg>
        </span>
      </button>
      {panel.render(
        <div className={styles.detail} data-level={level}>
          <div className={styles.heading}>
            <div className={styles.headingText}>
              <h2>{title}</h2>
              <p title={displayModel}>{displayModel}</p>
            </div>
            <button
              type="button"
              className={styles.close}
              aria-label={t('close')}
              data-panel-item=""
              onClick={() => panel.close(true)}
            >
              <IconCloseOutline16 />
            </button>
          </div>
          {history === undefined || reserved === undefined ? (
            <p className={styles.status}>
              {t(connection ? 'contextUsageUpdating' : 'contextUsageUnavailable')}
            </p>
          ) : (
            <>
              <div className={styles.meter}>
                <span>
                  {percent !== null && <strong>{percent}%</strong>}
                  {t('contextUsageEstimated')}
                </span>
                <span title={limit?.toLocaleString()}>
                  {limit
                    ? t('contextUsageFraction', {
                        count: formatContextTokens(history),
                        limit: official ? '1M' : formatContextTokens(limit),
                      })
                    : t('contextUsageCount', { count: formatContextTokens(history) })}
                </span>
              </div>
              {limit ? (
                <div className={styles.bar} aria-hidden="true">
                  <span style={{ width: `${progress * 100}%` }} />
                </div>
              ) : (
                <p className={styles.status}>{t('contextUsageLimitUnknown')}</p>
              )}
              <dl className={styles.breakdown}>
                <div>
                  <dt>{t('contextUsageHistory')}</dt>
                  <dd>{formatContextTokens(history)}</dd>
                </div>
                <div>
                  <dt>{t('contextUsageDraft')}</dt>
                  <dd>{formatContextTokens(draftTokens)}</dd>
                </div>
                <div>
                  <dt>{t('contextUsageReserved')}</dt>
                  <dd>{formatContextTokens(reserved)}</dd>
                </div>
              </dl>
              {rejected && (
                <div className={styles.rejected}>
                  <strong>{t('contextUsageRejected')}</strong>
                  {requestCount > 0 ? (
                    <p>
                      {requestLimit > 0
                        ? t('contextUsageReportedCounts', {
                            count: requestCount.toLocaleString(),
                            limit: requestLimit.toLocaleString(),
                          })
                        : t('contextUsageReportedRequest', {
                            count: requestCount.toLocaleString(),
                          })}
                    </p>
                  ) : (
                    <p>
                      {requestEstimate > 0
                        ? t('contextUsageEstimatedRequest', {
                            count: formatContextTokens(requestEstimate),
                          })
                        : t('contextUsageMissingRequest')}
                    </p>
                  )}
                  {!requestCount && requestLimit > 0 && (
                    <p>
                      {t('contextUsageReportedLimit', { limit: requestLimit.toLocaleString() })}
                    </p>
                  )}
                  {requestDocs > 0 && documentLimit > 0 && (
                    <p>
                      {t('contextUsageDocumentCount', { count: requestDocs, limit: documentLimit })}
                    </p>
                  )}
                  {requestFiles > 0 && (
                    <p>{t('contextUsageRequestFiles', { count: requestFiles })}</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  )
})
