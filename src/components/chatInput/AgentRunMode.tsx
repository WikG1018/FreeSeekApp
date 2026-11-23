import type { RefObject } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { agentRunModeLabels } from '../../i18n/agentWorkflow.js'
import { setAgentRunMode, useChatStore } from '../../services/chat/store.js'
import type { AgentRunMode } from '../../services/tasks/runState.js'
import { useOptionPanel } from '../base/OptionPanel.js'
import optionStyles from '../base/OptionPanel.module.css'
import { IconCheckOutline16, IconChevronDownOutline14 } from '../base/icons.js'
import styles from './ChatInput.module.css'

const modes = [
  ['task', 'agentModeTaskHelp'],
  ['plan', 'agentModePlanHelp'],
  ['goal', 'agentModeGoalHelp'],
] as const

export const AgentRunModeControl = ({
  sessionId,
  disabled,
  lockedToPlan,
  editorRef,
}: {
  sessionId: string | null
  disabled: boolean
  lockedToPlan: boolean
  editorRef: RefObject<HTMLTextAreaElement>
}) => {
  const t = useTranslate()
  const selected = useChatStore(
    (state): AgentRunMode =>
      (sessionId === null
        ? state.draftAgentRunMode
        : state.sessionCache[sessionId]?.agentRunMode) ?? 'task'
  )
  const mode = lockedToPlan ? 'plan' : selected
  const title = t('agentRunMode')
  const panel = useOptionPanel(title, { side: 'top', kind: 'chat-mode', editorRef, disabled })
  return (
    <>
      <button
        type="button"
        className={styles.tool}
        data-testid="agent-run-mode"
        data-toolbar-control="mode"
        aria-label={title + ' · ' + t(agentRunModeLabels[mode])}
        disabled={disabled}
        ref={panel.anchorRef}
        {...panel.trigger}
      >
        <span className={styles.toolFace}>
          <span>{t(agentRunModeLabels[mode])}</span>
          <span className={styles.effortChevron}>
            <IconChevronDownOutline14 />
          </span>
        </span>
      </button>
      {panel.render(
        modes.map(([value, help]) => (
          <button
            type="button"
            key={value}
            data-panel-item=""
            className={optionStyles.option}
            aria-label={t(agentRunModeLabels[value])}
            aria-pressed={value === mode}
            onClick={() => {
              setAgentRunMode(sessionId, value)
              panel.close(true)
            }}
          >
            <span className={optionStyles.copy}>
              <strong>{t(agentRunModeLabels[value])}</strong>
              <small>{t(help)}</small>
            </span>
            {value === mode && <IconCheckOutline16 />}
          </button>
        ))
      )}
    </>
  )
}
