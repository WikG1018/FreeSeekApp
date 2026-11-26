import { useTranslate } from '../../i18n/index.js'
import { useAssistantLibrary } from '../../services/assistants/library.js'
import { isWindowsDesktop } from '../../services/api/windowsTransport.js'
import { setSessionAgent, setSessionMemoryPaused, useChatStore } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { providerModelLabel, useProviders } from '../../services/providers.js'
import { Button } from '../base/Button.js'
import { Modal, closeTopModal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { Row, Section, SwitchRow } from '../settings/SettingsRows.js'
import { openSettings } from '../settings/settingsDialogState.js'
import styles from '../settings/AssistantSettings.module.css'

export const useSessionAgent = (sessionId: string | null) => {
  const ref = useChatStore((state) =>
    sessionId === null ? state.draftAgent : state.sessionCache[sessionId]?.agent
  )
  return useAssistantLibrary(({ data }) =>
    ref && !isWindowsDesktop() ? data.agents.find(({ id }) => id === ref.id) : undefined
  )
}

export const useChatMode = (sessionId: string | null) =>
  useChatStore((state) =>
    isWindowsDesktop()
      ? 'chat'
      : sessionId === null
        ? state.draftMode
        : (state.sessionCache[sessionId]?.mode ?? 'chat')
  )

export const SessionAssistant = ({
  session,
  streaming,
  close,
}: {
  session: Session
  streaming: boolean
  close: () => void
}) => {
  const t = useTranslate()
  const { enabled, agents } = useAssistantLibrary((state) => state.data)
  const current = useSessionAgent(session.id)
  const profile = useProviders((state) =>
    state.profiles.find(({ id }) => id === current?.model?.providerId)
  )
  return (
    <Modal
      title={t('assistantChatOptions')}
      onClose={close}
      footer={<Button onClick={closeTopModal}>{t('close')}</Button>}
    >
      <div className={styles.stack}>
        {!isWindowsDesktop() && (agents.length > 0 || session.agent) && (
          <Select
            settingRow="value"
            ariaLabel={t('assistantPick')}
            value={current?.id ?? ''}
            options={[
              { value: '', label: t('assistantUsePersona') },
              ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
            ]}
            disabled={streaming}
            onChange={(id) => {
              const agent = agents.find((item) => item.id === id)
              setSessionAgent(session.id, agent ? { id: agent.id, name: agent.name } : null)
            }}
            footer={{
              label: t('assistantAgents'),
              onSelect: () => {
                close()
                openSettings('agents')
              },
            }}
          />
        )}
        {!isWindowsDesktop() && session.agent && !current && (
          <p className={styles.hint}>{t('assistantAgentMissing')}</p>
        )}
        {current && (
          <Section title={t('assistantAgentTools')}>
            <Row
              label={t('assistantAgentModel')}
              value={
                current.model
                  ? providerModelLabel(current.model.model, profile)
                  : t('assistantFollowModel')
              }
            />
            <Row
              label={t('assistantSearchPermission')}
              value={t(current.search ? 'assistantAllowed' : 'assistantDisabled')}
            />
            <Row
              label={t('assistantAttachmentPermission')}
              value={t(current.attachments ? 'assistantAllowed' : 'assistantDisabled')}
            />
          </Section>
        )}
        {enabled ? (
          <Section>
            <SwitchRow
              label={t('assistantMemoryPaused')}
              description={t('assistantMemoryNextTurn')}
              checked={Boolean(session.memoryPaused)}
              change={(paused) => setSessionMemoryPaused(session.id, paused)}
            />
          </Section>
        ) : (
          <Section>
            <Row
              label={t('assistantMemory')}
              value={t('assistantDisabled')}
              onClick={() => {
                close()
                openSettings('assistantSettings')
              }}
            />
          </Section>
        )}
      </div>
    </Modal>
  )
}
