import { translate, useTranslate } from '../../i18n/index.js'
import {
  describeReadAloudError,
  stopReadAloud,
  toggleReadAloud,
  toggleRoleReadAloud,
  useReadAloud,
} from '../../services/speech/readAloud.js'
import { IconPlayMediaOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { showToast } from '../base/toastState.js'
import { ReadingBars } from './ReadingBars.js'
import { useProviders } from '../../services/providers.js'
import { useSettings, type RoleVoiceSettings } from '../../services/settings.js'
import { useChatStore } from '../../services/chat/store.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { parseRoleMarkers, stripRoleMarkers } from '../../services/speech/roleMarkers.js'
import { applyParsedRoles, sessionRoles } from '../../services/speech/roleTable.js'
import { roleVoiceActive, roleVoiceReplyText } from '../../services/speech/roleVoiceBridge.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import type { MiMoSpeechProfile } from '../../services/api/speech.js'
import { openSettings } from '../settings/settingsDialogState.js'

const reportError = (error: unknown) => showToast(describeReadAloudError(error))

export const playReplyRoles = (
  sessionId: string,
  message: AssistantMessage,
  profile: MiMoSpeechProfile,
  preferences: RoleVoiceSettings,
  fallback: string
) => {
  const session = useChatStore.getState().sessionCache[sessionId]
  if (!session || session.mode === 'agent' || message.task) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex(({ id }) => id === message.id)
  if (index < 0) {
    return
  }
  const roles = sessionRoles(session, path.slice(0, index + 1))
  const parsed = parseRoleMarkers(roleVoiceReplyText(message), roles, {
    includeNarration: true,
    speechOnly: true,
    narrateUnmarked: true,
    narratorVoice: preferences.narratorVoice,
    extraVoice: preferences.extraVoice,
    allowDescription: preferences.leadVoice === 'description',
    now: message.createdAt,
  })
  const segments = parsed.segments
    .map((piece) => ({ ...piece, text: stripRoleMarkers(piece.text) }))
    .filter(({ text }) => text.trim())
  if (!segments.length && fallback.trim()) {
    segments.push({ roleId: null, tone: '', text: fallback })
  }
  if (!segments.length) {
    return
  }
  toggleRoleReadAloud({
    messageId: message.id,
    segments,
    roles: applyParsedRoles(roles, parsed, roles.length + parsed.newRoles.length),
    profile,
    extrasShareVoice: preferences.extrasShareVoice,
    extraVoice: preferences.extraVoice,
    narratorVoice: preferences.narratorVoice,
    narratorLabel: translate('roleVoiceNarrator'),
  }, reportError)
}

/**
 * 朗读按钮：未朗读时点击开始，加载中或朗读中点击停止。
 * 角色配音模式由选定的语音服务播放人物和旁白。Agent 和备用朗读使用 DeepSeek 音色。
 */
export const ReadAloudButton = ({
  message,
  text,
  sessionId,
}: {
  message: AssistantMessage
  text: string
  sessionId: string
}) => {
  const t = useTranslate()
  const messageId = message.id
  const status = useReadAloud((state) => (state.messageId === messageId ? state.status : 'idle'))
  const custom = useProviders((state) => state.selection.providerId !== 'deepseek')
  const roleVoice = useSettings((state) => state.roleVoice)
  const hasDeepSeekKey = useSettings((state) => Boolean(state.apiKey?.trim()))
  const mode = useChatStore((state) => state.sessionCache[sessionId]?.mode)
  const characters = mode !== 'agent' && !message.task && roleVoiceActive(roleVoice, message.agent)
  if (custom && !characters && !hasDeepSeekKey && status === 'idle') {
    return null
  }
  return (
    <IconButton
      icon={status === 'loading' || status === 'playing' ? <ReadingBars mode={status} /> : <IconPlayMediaOutline16 />}
      tooltip={status === 'idle' ? t('ttsPlay') : t('ttsStop')}
      tooltipPlacement="bottom"
      onClick={() => {
        if (status !== 'idle') {
          stopReadAloud()
          return
        }
        if (!hasDeepSeekKey) {
          showToast({ key: characters ? 'settingsRoleVoiceNeedKey' : 'ttsNeedDeepSeek' })
          if (characters) {
            openSettings('chatSpeech', { backToConversation: true })
          } else {
            openSettings('account')
          }
          return
        }
        toggleReadAloud(messageId, text, reportError)
      }}
    />
  )
}
