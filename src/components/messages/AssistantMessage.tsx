import { useTranslate } from '../../i18n/index.js'
import { isWindowsDesktop } from '../../services/api/windowsTransport.js'
import clsx from 'clsx'
import { memo, useRef, useState } from 'react'
import { IconBranchOutline16, IconRefreshOutline16, IconWarningOutline16 } from '../base/icons.js'
import { describeReply } from '../../services/chat/describe.js'
import { contextWasRejected } from '../../services/chat/contextCompression.js'
import { canContinueReply } from '../../services/chat/reply.js'
import { canBranchFromReply } from '../../services/chat/forkConversation.js'
import {
  branchConversation,
  continueReply,
  regenerateReply,
  newChat,
  retryContextReply,
  setConversationRoleVoiceLive,
  useChatStore,
} from '../../services/chat/store.js'
import { stopReadAloud, useReadAloud } from '../../services/speech/readAloud.js'
import type { AssistantMessage as AssistantMessageType } from '../../services/chat/types.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { IconButton } from '../base/IconButton.js'
import { showToast } from '../base/toastState.js'
import { Button } from '../base/Button.js'
import { Markdown } from '../markdown/Markdown.js'
import { ExpandableContent } from './ExpandableContent.js'
import { SiteThumbnails } from '../search/SiteLogo.js'
import { toggleSearchPanel, useSearchPanel } from '../search/searchPanelState.js'
import { playReplyRoles, ReadAloudButton } from './ReadAloudButton.js'
import { useSettings } from '../../services/settings.js'
import { useProviders } from '../../services/providers.js'
import { roleVoiceProfile } from '../../services/speech/roleVoiceProfile.js'
import { roleVoiceActive } from '../../services/speech/roleVoiceBridge.js'
import { RoleSpeechControls, RoleSpeechDetails } from './RoleSpeechControls.js'
import { CopyButton } from './CopyButton.js'
import { ReplyArea } from './ReplyArea.js'
import { ReplyActivity } from './ReplyActivity.js'
import { useReplyView } from './useReplyView.js'
import {
  AgentOutputs,
  AgentPlanPrompt,
  AgentProgressButton,
  AgentRunRecovery,
} from './AssistantTask.js'
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
  round,
  isLast,
  streaming,
  busy,
  versions,
  onSelectVersion,
  onPlanReply,
}: {
  sessionId: string
  message: AssistantMessageType
  round?: number
  isLast: boolean
  streaming: boolean
  busy: boolean
  versions: MessageVersions
  onSelectVersion: SelectMessageVersion
  onPlanReply: () => void
}) {
  const t = useTranslate()
  const sessionAgent = useChatStore((state) => state.sessionCache[sessionId]?.mode === 'agent')
  const agentMode = sessionAgent || Boolean(message.task)
  const view = useReplyView(message, streaming, agentMode)
  const roleVoice = useSettings((state) => state.roleVoice)
  const providers = useProviders((state) => state.profiles)
  const speechProfile = !agentMode && roleVoiceActive(roleVoice, message.agent)
    ? roleVoiceProfile(providers, roleVoice)
    : null
  const roleSpeaking = useReadAloud((state) => state.messageId === message.id && state.roleReply)
  const root = useRef<HTMLDivElement>(null)
  const playback = useReadAloud((state) => state.messageId === message.id ? state.status : 'idle')
  // 新回复（含重新生成）挂载时创建不足 800ms 播放一次入场动画
  const [fresh] = useState(() => Date.now() - message.createdAt < 800)
  const [branching, setBranching] = useState(false)
  const fork = async () => {
    setBranching(true)
    try {
      const result = await branchConversation(sessionId, message.id)
      if (!result) {
        showToast({ key: 'branchCreateFailed', type: 'error' })
      } else if (result.missingOriginals > 0) {
        showToast({ key: 'branchMissingOriginals', params: { count: result.missingOriginals } })
      } else if (!result.opened) {
        showToast({ key: 'branchCreated' })
      }
    } finally {
      setBranching(false)
    }
  }
  const panelEntry = useSearchPanel((state) => state.entry)
  const notice = streaming ? null : describeReply(message)
  const compressionPrompt = message.error?.localMessage?.key === 'compressionSuggested'
  const rejectedContext = contextWasRejected(message.error?.localMessage)
  const compressionRefused = message.error?.localMessage?.key === 'compressionFailedRefused'
  const summaryExhausted = message.error?.localMessage?.key === 'compressionStillTooLong'
  const projection = compressionPrompt ? message.error?.localMessage?.params : undefined
  // 安全拒绝：已下发的思考与正文按协议丢弃，只显示模板答复。
  const refused = message.stopReason === 'refusal'
  const answer = refused ? null : view.answer
  const responseText = [answer?.text, notice?.presentation === 'response' ? notice.text : null]
    .filter(Boolean)
    .join('\n\n')
  const hasRoleSpeech = !refused && (roleSpeaking || !!speechProfile && (streaming || !!responseText))
  const startRoleSpeech = () => {
    if (streaming) {
      setConversationRoleVoiceLive(sessionId, true)
    } else if (speechProfile) {
      playReplyRoles(sessionId, message, speechProfile, roleVoice, responseText)
    }
  }
  const outputExhausted = !agentMode && !streaming && !notice && message.status === 'done' &&
    message.stopReason === 'max_tokens'
  const thinkingOnly = !responseText.trim() && message.blocks.some((block) => block.type === 'thinking')
  const copyText = responseText || message.task?.run?.question || notice?.text
  const compressing = useChatStore((s) => (streaming ? s.compressing[sessionId] : undefined))
  const summaryEntry = `${message.id}-summary`
  return (
    <div ref={root} className={clsx(styles.message, fresh && styles.fresh)} data-message-id={message.id}>
      {!refused &&
        (agentMode ? (
          <div data-testid="assistant-task">
            <ReplyArea
              message={message}
              view={view}
              streaming={streaming}
              hasResponse={!!responseText}
              agentMode
              activityPaused={!!compressing}
            />
          </div>
        ) : (
          <ReplyArea
            message={message}
            view={view}
            streaming={streaming}
            hasResponse={!!responseText}
            activityPaused={!!compressing}
            voiceControl={hasRoleSpeech ? (
              <RoleSpeechControls messageId={message.id} streaming={streaming} onStart={startRoleSpeech} />
            ) : undefined}
            voiceDetails={roleSpeaking ? <RoleSpeechDetails messageId={message.id} root={root} /> : undefined}
          />
        ))}
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
      {outputExhausted && (
        <div className={clsx(styles.notice, styles.outputNotice)} role="status">
          <IconWarningOutline16 />
          <div>{t(thinkingOnly ? 'replyThinkingOutputExhausted' : 'replyOutputExhausted')}</div>
        </div>
      )}
      {!refused && agentMode && streaming && !compressing && (
        <ReplyActivity message={message} view={view} transcriptTail />
      )}
      {!refused && !streaming && message.task && (
        <AgentPlanPrompt
          task={message.task}
          sessionId={sessionId}
          replyId={message.id}
          current={isLast && !busy && !isWindowsDesktop()}
          onReply={onPlanReply}
        />
      )}
      {!refused && (!isLast || isWindowsDesktop()) && message.task && (
        <AgentProgressButton
          task={message.task}
          sessionId={sessionId}
          replyId={message.id}
          current={false}
          busy={busy}
          streaming={false}
        />
      )}
      {!refused && message.task && (
        <AgentOutputs
          task={message.task}
          sessionId={sessionId}
          createdAt={message.createdAt}
          round={round}
        />
      )}
      {!refused &&
        !streaming &&
        !busy &&
        isLast &&
        !isWindowsDesktop() &&
        message.task &&
        !notice && (
          <AgentRunRecovery task={message.task} sessionId={sessionId} replyId={message.id} />
        )}
      {compressing ? (
        <div role="status">{t('compressionProgress', { percent: compressing.percent })}</div>
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
                {!summaryExhausted && !compressionRefused &&
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
                {compressionRefused && (
                  <Button
                    size="s"
                    variant="primary"
                    disabled={busy}
                    onClick={() => retryContextReply(sessionId, message.id, 'send')}
                  >
                    {t('compressionRetryWithHistory')}
                  </Button>
                )}
                {rejectedContext && !compressionRefused && (
                  <Button
                    size="s"
                    variant={summaryExhausted ? 'primary' : 'outlined'}
                    disabled={busy}
                    onClick={() => retryContextReply(sessionId, message.id, 'recent')}
                  >
                    {t('compressionUseRecent')}
                  </Button>
                )}
                {!rejectedContext && !compressionRefused && notice.action === 'compression' && (
                  <button
                    type="button"
                    disabled={busy}
                    className={styles.noticeAction}
                    onClick={() => retryContextReply(sessionId, message.id, 'send')}
                  >
                    {t('compressionSendOnce')}
                  </button>
                )}
              </div>
            )}
            {(rejectedContext || compressionRefused) && (
              <div className={styles.compressionEstimate}>
                {t(compressionRefused ? 'compressionRefusalKeepHint' : 'compressionRecentHint')}
              </div>
            )}
            {notice.action === 'newChat' ? (
              <button
                type="button"
                className={styles.noticeAction}
                onClick={(event) => newChat(event.currentTarget)}
              >
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
          <div
            className={clsx(styles.actions, (isLast || playback !== 'idle') && styles.alwaysShow)}
          >
            {playback === 'loading' && !roleSpeaking ? (
              <span className={styles.speakingRole} role="status">
                {t('ttsPreparing')}
              </span>
            ) : null}
            {copyText ? <CopyButton text={copyText} /> : null}
            {responseText && !refused && !hasRoleSpeech ? (
              <ReadAloudButton message={message} text={responseText} sessionId={sessionId} />
            ) : null}
            {canBranchFromReply(message) && (
              <IconButton
                icon={branching ? <span className={styles.branchSpinner} aria-hidden /> : <IconBranchOutline16 />}
                tooltip={t(branching ? 'branchSaving' : 'branchFromReply')}
                tooltipPlacement="bottom"
                aria-busy={branching || undefined}
                disabled={branching}
                onClick={() => void fork()}
              />
            )}
            <IconButton
              icon={<IconRefreshOutline16 />}
              tooltip={t('regenerate')}
              tooltipPlacement="bottom"
              disabled={busy || refused}
              onClick={() => void regenerateReply(sessionId, message.id)}
            />
          </div>
          {isLast && !message.task?.run && canContinueReply(message) ? (
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
