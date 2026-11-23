import { useTranslate } from '../../i18n/index.js'
import { isWindowsDesktop } from '../../services/api/windowsTransport.js'
import { localizePersona, setDefaultPersona, usePersonas } from '../../services/personas.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { useAssistantLibrary } from '../../services/assistants/library.js'
import { setSessionAgent, useChatStore } from '../../services/chat/store.js'
import { useSettings } from '../../services/settings.js'

export const PersonaPicker = () => {
  const t = useTranslate()
  const personas = usePersonas((state) => state.personas)
  const id = usePersonas((state) => state.defaultId)
  const profiles = useAssistantLibrary((state) => state.data.agents)
  const agent = useChatStore((state) => state.draftAgent)
  const taskMode = useChatStore((state) => state.draftMode === 'agent')
  const askMode = useSettings((state) => state.askChatMode)
  const locale = useSettings((state) => state.locale)
  const agents = !isWindowsDesktop() && (taskMode || !askMode) ? profiles : []
  const usesAgentPicker = taskMode || agents.length > 0
  return (
    <Select
      pill
      prefix={t(
        taskMode ? 'assistantTaskMode' : usesAgentPicker ? 'assistantPick' : 'personaRowLabel'
      )}
      ariaLabel={t(usesAgentPicker ? 'assistantPickTitle' : 'personaPickerTitle')}
      value={agent && usesAgentPicker ? 'agent:' + agent.id : taskMode ? 'task:default' : id}
      placeholder={t('personaDefaultName')}
      options={[
        ...(taskMode
          ? [{ value: 'task:default', label: t('assistantDefaultTaskAgent') }]
          : personas.map((p) => {
              const persona = localizePersona(p, locale)
              return {
                value: p.id,
                label: persona.name,
                detail: persona.prompt ? persona.prompt.slice(0, 80) : t('personaDefaultHint'),
              }
            })),
        ...agents.map((profile) => ({
          value: 'agent:' + profile.id,
          label: profile.name,
          detail: 'Agent · ' + profile.prompt.slice(0, 70),
        })),
      ]}
      onChange={(value) => {
        if (value === 'task:default') {
          setSessionAgent(null, null)
          return
        }
        const selected = agents.find((profile) => 'agent:' + profile.id === value)
        if (selected) {
          setSessionAgent(null, { id: selected.id, name: selected.name })
          return
        }
        try {
          setDefaultPersona(value)
          setSessionAgent(null, null)
        } catch {
          showToast({ key: 'personaSaveFailed', type: 'error' })
        }
      }}
      footer={{
        label: t(usesAgentPicker ? 'assistantAgents' : 'personaManage'),
        onSelect: () => openSettings(usesAgentPicker ? 'agents' : 'personas'),
      }}
    />
  )
}
