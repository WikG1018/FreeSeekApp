import { useTranslate } from '../../i18n/index.js'
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
import { useSettings } from '../../services/settings.js'
import { useChatStore } from '../../services/chat/store.js'
import { parseRoleMarkers, stripRoleMarkers } from '../../services/speech/roleMarkers.js'
import { sessionRoles } from '../../services/speech/roleTable.js'
import { roleVoiceProfile } from '../../services/speech/roleVoiceProfile.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import { openSettings } from '../settings/settingsDialogState.js'

/**
 * 朗读按钮：未朗读时点击开始，加载中或朗读中点击停止。
 *
 * 带角色标注的答案按角色朗读。普通答案优先用 DeepSeek，只有 MiMo 时用旁白音色。
 * 聊天模型和声音服务分别配置。
 */
export const ReadAloudButton = ({
  message,
  text,
  sessionId,
  allowed = true,
}: {
  message: AssistantMessage
  text: string
  sessionId: string
  allowed?: boolean
}) => {
  const t = useTranslate()
  const messageId = message.id
  const status = useReadAloud((state) => (state.messageId === messageId ? state.status : 'idle'))
  const custom = useProviders((state) => state.selection.providerId !== 'deepseek')
  const roleVoice = useSettings((state) => state.roleVoice)
  const profiles = useProviders((state) => state.profiles)
  const hasDeepSeekKey = useSettings((state) => Boolean(state.apiKey?.trim()))
  const mode = useChatStore((state) => state.sessionCache[sessionId]?.mode)
  if (!allowed) {
    return null
  }
  const profile =
    roleVoice.enabled && mode !== 'agent' && !message.task
      ? roleVoiceProfile(profiles, roleVoice)
      : null
  if (custom && !profile && !hasDeepSeekKey && status === 'idle') {
    return null
  }
  const reportError = (error: unknown) => showToast(describeReadAloudError(error))
  return (
    <IconButton
      icon={status === 'idle' ? <IconPlayMediaOutline16 /> : <ReadingBars mode={status} />}
      tooltip={status === 'idle' ? t('ttsPlay') : t('ttsStop')}
      tooltipPlacement="bottom"
      onClick={() => {
        if (status !== 'idle') {
          stopReadAloud()
          return
        }
        const session = useChatStore.getState().sessionCache[sessionId]
        // Parse the selected reply on demand. Other messages do not need to reparse while it streams.
        if (profile) {
          const roles = session ? sessionRoles(session) : []
          const raw = message.blocks
            .flatMap((block) => (block.type === 'text' && !block.isTemplate ? [block.text] : []))
            .join('')
          const parsed = parseRoleMarkers(raw, roles, {
            includeNarration: true,
            narratorVoice: roleVoice.narratorVoice,
            extraVoice: roleVoice.extraVoice,
            allowDescription: roleVoice.leadVoice === 'description',
          })
          const segments = parsed.segments
            .map((piece) => ({
              ...piece,
              text: stripRoleMarkers(piece.text),
            }))
            .filter(({ text }) => text.trim())
          if (segments.length || !hasDeepSeekKey) {
            toggleRoleReadAloud(
              {
                messageId,
                segments: segments.length ? segments : [{ roleId: null, tone: '', text }],
                roles: [...roles, ...parsed.newRoles],
                profile,
                extrasShareVoice: roleVoice.extrasShareVoice,
                extraVoice: roleVoice.extraVoice,
                narratorVoice: roleVoice.narratorVoice,
                narratorLabel: t('roleVoiceNarrator'),
              },
              reportError
            )
            return
          }
        }
        if (!hasDeepSeekKey) {
          showToast({ key: 'ttsNeedDeepSeek' })
          openSettings('account')
          return
        }
        toggleReadAloud(messageId, text, reportError)
      }}
    />
  )
}
