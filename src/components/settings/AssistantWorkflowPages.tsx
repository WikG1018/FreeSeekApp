import { useState } from 'react'
import { agentRunModeLabels } from '../../i18n/agentWorkflow.js'
import { useTranslate } from '../../i18n/index.js'
import { setAgentTool, useSettings } from '../../services/settings.js'
import type { AgentRunMode } from '../../services/tasks/runState.js'
import { Row, Section, SwitchRow } from './SettingsRows.js'
import styles from './AssistantSettings.module.css'
import type { SettingsPageId } from './settingsDialogState.js'

const modeHelp = {
  task: 'agentModeTaskHelp',
  plan: 'agentModePlanHelp',
  goal: 'agentModeGoalHelp',
} as const
const modes: AgentRunMode[] = ['task', 'plan', 'goal']

export const AgentDetailsPage = () => {
  const t = useTranslate()
  return (
    <Section>
      {modes.map((mode) => (
        <Row key={mode} label={t(agentRunModeLabels[mode])} description={t(modeHelp[mode])} />
      ))}
    </Section>
  )
}

const toolGroups = [
  {
    label: 'agentCreatorTools',
    items: [
      ['code', 'agentToolCode', 'agentToolCodeHelp'],
      ['model3d', 'agentToolModel', 'agentToolModelHelp'],
      ['review', 'projectReviewTools', 'projectReviewToolsHelp'],
    ],
  },
  {
    label: 'assistantToolsNetwork',
    items: [
      ['search', 'assistantToolSearch', 'assistantToolSearchHelp'],
      ['web', 'assistantToolWeb'],
      ['github', 'assistantToolGitHub', 'assistantToolGitHubHelp'],
    ],
  },
  {
    label: 'assistantToolsFiles',
    items: [
      ['attachment', 'assistantToolAttachments', 'assistantToolAttachmentsHelp'],
      ['table', 'assistantToolTable'],
      ['output', 'assistantToolOutput', 'assistantToolOutputHelp'],
    ],
  },
] as const

export const AgentToolsPage = ({ open }: { open: (page: SettingsPageId) => void }) => {
  const t = useTranslate()
  const tools = useSettings((state) => state.agentTools)
  const [failed, setFailed] = useState(false)
  return (
    <>
      <p className={styles.hint}>{t('assistantToolsApplies')}</p>
      {toolGroups.map((group) => (
        <Section key={group.label} title={t(group.label)}>
          {group.items.map(([name, label, description]) => (
            <SwitchRow
              key={name}
              label={t(label)}
              description={description && t(description)}
              checked={tools[name]}
              change={(value) => setFailed(!setAgentTool(name, value))}
            />
          ))}
        </Section>
      ))}
      <Section>
        <Row
          label={t('projectExtensions')}
          target="agentExtensions"
          onClick={() => open('agentExtensions')}
        />
      </Section>
      {failed && (
        <p className={styles.error} role="alert">
          {t('assistantSaveFailed')}
        </p>
      )}
    </>
  )
}
