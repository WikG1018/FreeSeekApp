import { useTranslate } from '../../i18n/index.js'
import {
  describeReadAloudError,
  toggleReadAloud,
  toggleRoleReadAloud,
  useReadAloud,
} from '../../services/speech/readAloud.js'
import { IconPlayMediaOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { showToast } from '../base/toastState.js'
import { ReadingBars } from './ReadingBars.js'
import { useProviders } from '../../services/providers.js'
import { useSettings } from '../../services/settings.js'
import { useChatStore } from '../../services/chat/store.js'
import { parseRoleMarkers } from '../../services/speech/roleMarkers.js'
import { sessionRoles } from '../../services/speech/roleTable.js'
import { roleVoiceProfile } from '../../services/speech/roleVoiceProfile.js'

/**
 * 朗读按钮：未朗读时点击开始，加载中或朗读中点击停止。
 *
 * 角色配音开启、本会话有角色、且这条回答带标注时，按角色分段朗读（各用各的音色）；
 * 否则保持原有的整段朗读。选第三方聊天模型时仍然隐藏——除非角色配音开着，
 * 因为那时 TTS 走的是独立的 MiMo 配置，与聊天模型无关。
 */
export const ReadAloudButton = ({
  messageId,
  text,
  sessionId,
  allowed = true,
}: {
  messageId: string
  text: string
  sessionId: string
  allowed?: boolean
}) => {
  const t = useTranslate()
  const status = useReadAloud((state) => (state.messageId === messageId ? state.status : 'idle'))
  const custom = useProviders((state) => state.selection.providerId !== 'deepseek')
  const roleVoice = useSettings((state) => state.roleVoice)
  const profiles = useProviders((state) => state.profiles)
  const session = useChatStore((state) => state.sessionCache[sessionId])
  if (!allowed) {
    return null
  }
  const profile = roleVoice.enabled ? roleVoiceProfile(profiles, roleVoice) : null
  const roles = session ? sessionRoles(session) : []
  // 朗读要用原始文本：渲染文本已经把 ⟦…⟧ 剥掉了，解析不出角色段
  const raw = useChatStore((state) => {
    const message = state.sessionCache[sessionId]?.messages.find((item) => item.id === messageId)
    if (!message || message.role !== 'assistant') {
      return ''
    }
    return message.blocks
      .flatMap((block) => (block.type === 'text' && !block.isTemplate ? [block.text] : []))
      .join('\n')
  })
  const parsed = profile && roles.length && raw ? parseRoleMarkers(raw, roles) : null
  const byId = new Set(roles.map((role) => role.id))
  const segments = parsed?.segments.filter((piece) => byId.has(piece.roleId)) ?? []
  if (custom && !(profile && segments.length)) {
    return null
  }
  const reportError = (error: unknown) => showToast(describeReadAloudError(error))
  return (
    <IconButton
      icon={status === 'idle' ? <IconPlayMediaOutline16 /> : <ReadingBars mode={status} />}
      tooltip={status === 'idle' ? t('ttsPlay') : t('ttsStop')}
      tooltipPlacement="bottom"
      onClick={() => {
        if (profile && segments.length) {
          toggleRoleReadAloud(
            {
              messageId,
              segments,
              roles,
              profile,
              extrasShareVoice: roleVoice.extrasShareVoice,
              extraVoice: roleVoice.extraVoice,
            },
            reportError
          )
          return
        }
        toggleReadAloud(messageId, text, reportError)
      }}
    />
  )
}
