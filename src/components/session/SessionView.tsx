import clsx from 'clsx'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { isWindowsDesktop } from '../../services/api/windowsTransport.js'
import { newChat, saveSessionVoiceRole } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { computeReplyUsage, hasKnownPricing, usePricing } from '../../services/usage.js'
import { useSettings } from '../../services/settings.js'
import { useProviders } from '../../services/providers.js'
import { sessionRoles } from '../../services/speech/roleTable.js'
import { roleVoiceProfile } from '../../services/speech/roleVoiceProfile.js'
import { describeReadAloudError, previewRoleVoice } from '../../services/speech/readAloud.js'
import { showToast } from '../base/toastState.js'
import { RoleVoiceButton } from './RoleVoice.js'
import { conversationRounds, sessionArtifacts } from '../../services/tasks/sessionArtifacts.js'
import { IconNewChatOutline20 } from '../base/icons.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MessageList } from '../messages/MessageList.js'
import { MobileHeader } from './MobileHeader.js'
import { SessionAssistant, useSessionAgent } from './SessionAssistant.js'
import { SessionArtifactsButton } from './SessionArtifacts.js'
import { useAssistantLibrary } from '../../services/assistants/library.js'
import styles from './SessionView.module.css'

/** 会话内所有已记录回复的 token 总量（输入含缓存 + 输出） */
const sessionTokens = (session: Session): number =>
  getVisibleMessages(session).reduce((total, message) => {
    if (message.role !== 'assistant' || !message.usage) {
      return total
    }
    return (
      total +
      (message.usage.input_tokens ?? 0) +
      (message.usage.cache_read_input_tokens ?? 0) +
      (message.usage.cache_creation_input_tokens ?? 0) +
      (message.usage.output_tokens ?? 0)
    )
  }, 0)

const formatTokens = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)

const formatCost = (value: number) =>
  value === 0 ? '—' : value >= 0.01 ? `¥${value.toFixed(2)}` : `¥${value.toFixed(4)}`

/** 会话页：标题栏（移动端为顶栏）+ 消息列表，输入框吸底 */
export const SessionView = ({
  session,
  streaming,
  siderCollapsed,
}: {
  session: Session
  streaming: boolean
  siderCollapsed: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const showUsage = useSettings((state) => state.showUsage)
  const roleVoice = useSettings((state) => state.roleVoice)
  const profiles = useProviders((state) => state.profiles)
  const agent = useSessionAgent(session.id)
  const controls = useAssistantLibrary(
    (state) => state.data.enabled || (!isWindowsDesktop() && state.data.agents.length > 0)
  )
  const [assistantOpen, setAssistantOpen] = useState(false)
  const { artifacts, rounds } = useMemo(() => {
    if (
      !session.messages.some(
        (message) => message.role === 'assistant' && message.task?.artifacts.length
      )
    ) {
      return { artifacts: [] }
    }
    const rounds = conversationRounds(session.messages)
    return { artifacts: sessionArtifacts(session.messages, rounds), rounds }
  }, [session.messages])
  const artifactsButton = artifacts.length > 0 && (
    <SessionArtifactsButton key={session.id} files={artifacts} sessionId={session.id} />
  )
  // 角色配音：开关开且本会话已有角色时才出现，和成果按钮同一槽位
  const roles = sessionRoles(session)
  const roleProfile = roleVoiceProfile(profiles, roleVoice)
  const previewRole = (role: (typeof roles)[number], context?: AudioContext) => {
    if (!roleProfile) {
      void context?.close().catch(() => {})
      showToast(t('settingsRoleVoiceNeedKey'))
      return
    }
    previewRoleVoice(
      {
        role,
        text: t('roleVoicePreviewText', { name: role.name }),
        messageId: `preview-${role.id}`,
        profile: roleProfile,
        extrasShareVoice: roleVoice.extrasShareVoice,
        extraVoice: roleVoice.extraVoice,
        context,
      },
      (error) => showToast(describeReadAloudError(error))
    )
  }
  const roleVoiceButton = roleVoice.enabled && session.mode !== 'agent' && roles.length > 0 && (
    <RoleVoiceButton
      key={session.id}
      roles={roles}
      onPreview={previewRole}
      onSave={(next) => saveSessionVoiceRole(session.id, next)}
    />
  )
  const agentName = agent?.name ?? session.agent?.name
  const title =
    (session.mode === 'agent' ? 'Agent · ' : '') +
    (session.title || t(session.inherited ? 'inheritedChatTitle' : 'untitledChat')) +
    (agentName ? ' · ' + agentName : '')
  const openAssistant =
    controls || (!isWindowsDesktop() && session.agent) ? () => setAssistantOpen(true) : undefined
  const tokens = useMemo(() => sessionTokens(session), [session])
  const pricing = usePricing()
  const cost = useMemo(
    () =>
      getVisibleMessages(session).reduce((total, message) => {
        if (message.role !== 'assistant' || !message.usage) {
          return total
        }
        return total + computeReplyUsage(message, pricing.pricing).costCny
      }, 0),
    [session, pricing]
  )
  const viewRef = useRef<HTMLDivElement>(null),
    dockRef = useRef<HTMLDivElement>(null),
    headerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const focusComposer = useCallback(() => editorRef.current?.focus({ preventScroll: true }), [])
  // 遮罩和末尾留白随输入框真实高度变化，长草稿、附件和字体缩放不会盖住最后一条消息。
  useLayoutEffect(() => {
    const view = viewRef.current,
      dock = dockRef.current,
      header = headerRef.current
    if (!view || !dock || !header) {
      return
    }
    const measure = () => {
      const height = view.clientHeight,
        top = header.offsetHeight,
        bottom = dock.offsetHeight,
        dockHeight = Math.min(bottom, height),
        compact = height < 260
      view.style.setProperty('--composer-height', `${dockHeight}px`)
      view.style.setProperty('--composer-inset', `${bottom + (compact ? 8 : 40)}px`)
      view.style.setProperty('--message-list-top-inset', `${top ? top + 16 : 8}px`)
      // Start fading before the toolbar; the rest of the gradient continues under the dock.
      const fadeBottom = dockHeight + Math.min(40, Math.max(0, height - dockHeight - 24))
      view.style.setProperty('--message-fade-bottom', fadeBottom + 'px')
      view.style.setProperty(
        '--message-fade-top',
        Math.min(top ? top + 28 : 0, Math.max(0, height - fadeBottom - 24)) + 'px'
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(view)
    observer.observe(dock)
    observer.observe(header)
    return () => observer.disconnect()
  }, [isMobile, session.id])
  const priced = getVisibleMessages(session).every(
    (message) => message.role !== 'assistant' || hasKnownPricing(message)
  )
  return (
    <div ref={viewRef} className={styles.view} data-testid="chat-view">
      {isMobile ? (
        <MobileHeader
          title={title}
          headerRef={headerRef}
          openAssistant={openAssistant}
          artifactsButton={artifactsButton}
          voicesButton={roleVoiceButton}
        />
      ) : (
        <div ref={headerRef} className={styles.header} data-testid="chat-header">
          <div className={clsx(styles.headerPill, siderCollapsed && styles.withCollapsedSider)}>
            {openAssistant ? (
              <button
                type="button"
                className={clsx(styles.title, styles.assistantTitle)}
                aria-label={t('assistantChatOptions')}
                onClick={openAssistant}
              >
                {title}
              </button>
            ) : (
              <div className={styles.title}>{title}</div>
            )}
            {showUsage && tokens > 0 ? (
              <span className={styles.usage} title={t('usageTokensTitle')}>
                {formatTokens(tokens)} tok{priced ? ` · ${formatCost(cost)}` : ''}
              </span>
            ) : null}
          </div>
          <div className={styles.headerActions}>
            {artifactsButton}
            {roleVoiceButton}
            <button
              type="button"
              className={styles.headerAction}
              aria-label={t('newChat')}
              data-chat-mode-anchor
              onClick={(event) => newChat(event.currentTarget)}
            >
              <IconNewChatOutline20 />
            </button>
          </div>
        </div>
      )}
      <MessageList
        session={session}
        streaming={streaming}
        rounds={rounds}
        onPlanReply={focusComposer}
      />
      <div ref={dockRef} className={styles.dock} data-testid="chat-dock">
        <div className={styles.dockInner}>
          <ChatInput sessionId={session.id} editorRef={editorRef} />
        </div>
      </div>
      {assistantOpen && (
        <SessionAssistant
          key={session.id}
          session={session}
          streaming={streaming}
          close={() => setAssistantOpen(false)}
        />
      )}
    </div>
  )
}
