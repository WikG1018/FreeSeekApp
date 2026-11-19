import { useTranslate } from '../../i18n/index.js'
import clsx from 'clsx'
import { memo, useState } from 'react'
import { IconRefreshOutline16, IconWarningOutline16 } from '../base/icons.js'
import { describeReply } from '../../services/chat/describe.js'
import { contextWasRejected } from '../../services/chat/contextCompression.js'
import { canContinueReply } from '../../services/chat/reply.js'
import {
  continueReply,
  regenerateReply,
  newChat,
  retryContextReply,
  useChatStore,
} from '../../services/chat/store.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import type { AssistantMessage as AssistantMessageType } from '../../services/chat/types.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { IconButton } from '../base/IconButton.js'
import { Button } from '../base/Button.js'
import { Markdown } from '../markdown/Markdown.js'
import { ExpandableContent } from './ExpandableContent.js'
import { SiteThumbnails } from '../search/SiteLogo.js'
import { toggleSearchPanel, useSearchPanel } from '../search/searchPanelState.js'
import { ReadAloudButton } from './ReadAloudButton.js'
import { CopyButton } from './CopyButton.js'
import { ReplyArea } from './ReplyArea.js'
import { useReplyView } from './useReplyView.js'
import { MessageUsage } from '../usage/MessageUsage.js'
import {
  BranchSwitcher,
  type MessageVersions,
  type SelectMessageVersion,
} from './BranchSwitcher.js'
import styles from './AssistantMessage.module.css'

const TOP_UP_URL = 'https://platform.deepseek.com/top_up'

export const AssistantMessage = memo(function AssistantMessage({
  sessionId,
  message,
  isLast,
  streaming,
  busy,
  versions,
  onSelectVersion,
}: {
  sessionId: string
  message: AssistantMessageType
  isLast: boolean
  streaming: boolean
  busy: boolean
  versions: MessageVersions
  onSelectVersion: SelectMessageVersion
}) {
  const t = useTranslate()
  const view = useReplyView(message, streaming)
  // 新回复（含重新生成）挂载时创建不足 800ms 播放一次入场动画
  const [fresh] = useState(() => Date.now() - message.createdAt < 800)
  const panelEntry = useSearchPanel((state) => state.entry)
  const notice = streaming ? null : describeReply(message)
  const compressionPrompt = message.error?.localMessage?.key === 'compressionSuggested'
  const rejectedContext = contextWasRejected(message.error?.localMessage)
  const summaryExhausted = message.error?.localMessage?.key === 'compressionStillTooLong'
  const projection = compressionPrompt ? message.error?.localMessage?.params : undefined
  // 安全拒绝：已下发的思考与正文按协议丢弃，只显示模板答复。
  const refused = message.stopReason === 'refusal'
  const answer = refused ? null : view.answer
  const responseText = [answer?.text, notice?.presentation === 'response' ? notice.text : null]
    .filter(Boolean)
    .join('\n\n')
  const copyText = responseText || notice?.text
  const compressing = useChatStore((s) => (streaming ? s.compressing[sessionId] : undefined))
  const waiting = streaming && view.steps.length === 0 && !view.answer && !message.thinking
  const summaryEntry = `${message.id}-summary`
  return (
    <div className={clsx(styles.message, fresh && styles.fresh)} data-message-id={message.id}>
      {refused ? null : (
        <ReplyArea
          message={message}
          view={view}
          streaming={streaming}
          hasResponse={!!responseText}
        />
      )}
      {answer ? (
        <ExpandableContent
          text={answer.markdown}
          streaming={streaming}
          render={(content) => (
            <Markdown
              className="ds-assistant-message-main-content"
              content={content}
              loading={streaming}
              cacheKey={message.id}
              disableLink={false}
              sources={view.sources}
            />
          )}
        />
      ) : null}
      {compressing ? (
        <div role="status">{t('compressionProgress', { percent: compressing.percent })}</div>
      ) : waiting ? (
        <div className={styles.waiting}>
          {[0, 1, 2].map((index) => (
            <span key={index} className={styles.waitingDot} />
          ))}
        </div>
      ) : null}
      {notice?.presentation === 'response' ? (
        <Markdown
          className="ds-assistant-message-main-content"
          content={notice.text}
          loading={false}
          cacheKey={`${message.id}-template`}
          disableLink={false}
        />
      ) : notice ? (
        <div className={clsx(styles.notice, compressionPrompt && styles.compressionPrompt)}>
          {compressionPrompt ? null : <IconWarningOutline16 />}
          <div>
            {compressionPrompt && <strong>{t('compressionPromptTitle')}</strong>}
            {notice.text}
            {projection?.before !== undefined && projection.after !== undefined && (
              <div className={styles.compressionEstimate}>
                {t('compressionEstimatedResult', projection)}
              </div>
            )}
            {notice.action === 'apiKey' ? (
              <>
                {' '}
                <button
                  type="button"
                  className={styles.noticeAction}
                  onClick={() => openSettings('account')}
                >
                  {t('changeApiKey')}
                </button>
              </>
            ) : null}
            {notice.action === 'topUp' ? (
              <>
                {' '}
                <a
                  className={styles.noticeAction}
                  href={TOP_UP_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('topUp')}
                </a>
              </>
            ) : null}
            {(notice.action === 'compression' || notice.action === 'newChat') && (
              <div className={styles.contextActions}>
                {!summaryExhausted &&
                  message.error?.localMessage?.key !== 'compressionUnavailable' && (
                    <Button
                      size="s"
                      variant={notice.action === 'compression' ? 'primary' : 'outlined'}
                      disabled={busy}
                      onClick={() => retryContextReply(sessionId, message.id, 'compress')}
                    >
                      {t(
                        compressionPrompt
                          ? 'compressTitle'
                          : notice.action === 'newChat'
                            ? 'compressionRetry'
                            : 'compressionResume'
                      )}
                    </Button>
                  )}
                {rejectedContext ? (
                  <Button
                    size="s"
                    variant={summaryExhausted ? 'primary' : 'outlined'}
                    disabled={busy}
                    onClick={() => retryContextReply(sessionId, message.id, 'recent')}
                  >
                    {t('compressionUseRecent')}
                  </Button>
                ) : (
                  notice.action === 'compression' && (
                    <button
                      type="button"
                      disabled={busy}
                      className={styles.noticeAction}
                      onClick={() => retryContextReply(sessionId, message.id, 'send')}
                    >
                      {t('compressionSendOnce')}
                    </button>
                  )
                )}
              </div>
            )}
            {rejectedContext && (
              <div className={styles.compressionEstimate}>{t('compressionRecentHint')}</div>
            )}
            {notice.action === 'newChat' ? (
              <button type="button" className={styles.noticeAction} onClick={newChat}>
                {t('newChatWithoutHistory')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {!streaming ? (
        <div className={styles.footer}>
          <BranchSwitcher versions={versions} disabled={busy} onSelect={onSelectVersion} />
          {!refused && view.searchResults.length > 0 ? (
            <button
              type="button"
              className={clsx(styles.chip, panelEntry === summaryEntry && styles.chipActive)}
              onClick={() => toggleSearchPanel(summaryEntry, view.searchResults)}
            >
              <SiteThumbnails sources={view.searchResults} />
              <span className={styles.chipLabel}>
                {t(
                  view.searchResults.length === 1
                    ? 'messageSearchSummary'
                    : 'messageSearchSummaries',
                  { count: view.searchResults.length }
                )}
              </span>
            </button>
          ) : null}
          <MessageUsage message={message} />
          <div className={clsx(styles.actions, isLast && styles.alwaysShow)}>
            {copyText ? <CopyButton text={copyText} /> : null}
            {responseText && !refused ? (
              <ReadAloudButton
                messageId={message.id}
                text={responseText}
                allowed={!message.connection || message.connection.providerId === 'deepseek'}
              />
            ) : null}
            <IconButton
              icon={<IconRefreshOutline16 />}
              tooltip={t('regenerate')}
              tooltipPlacement="bottom"
              disabled={busy || refused}
              onClick={() => {
                stopReadAloud()
                regenerateReply(sessionId, message.id)
              }}
            />
          </div>
          {isLast && canContinueReply(message) ? (
            <Button
              variant="outlined"
              size="s"
              className={styles.continueButton}
              disabled={busy}
              onClick={() => {
                stopReadAloud()
                continueReply(sessionId, message.id)
              }}
            >
              {t('continueGenerating')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})
