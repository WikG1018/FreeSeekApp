import { useEffect, useRef, useState } from 'react'
import { useTranslate, type TranslationMessage } from '../../i18n/index.js'
import {
  readAgentSkill,
  saveAgentExtensions,
  useAgentExtensions,
  validMcpEndpoint,
} from '../../services/tasks/extensions.js'
import { Button } from '../base/Button.js'
import { Section, SwitchRow } from './SettingsRows.js'
import workspaceStyles from '../session/Workspace.module.css'
import styles from './AssistantSettings.module.css'

export const AgentExtensionsPage = () => {
  const t = useTranslate()
  const { skills, skillId, mcp } = useAgentExtensions()
  const [endpoint, setEndpoint] = useState(mcp?.endpoint ?? '')
  const [key, setKey] = useState(mcp?.key ?? '')
  const [skillNotice, setSkillNotice] = useState<TranslationMessage>()
  const [notice, setNotice] = useState<TranslationMessage>()
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const controller = useRef<AbortController>()
  useEffect(() => () => controller.current?.abort(), [])
  const saveFailure = () => setNotice({ key: 'assistantSaveFailed' })
  const connect = async () => {
    const address = validMcpEndpoint(endpoint)
    if (!address || controller.current) {
      return
    }
    const active = new AbortController()
    controller.current = active
    setBusy(true)
    setNotice(undefined)
    const token = key.trim()
    try {
      const { createMcpClient } = await import('../../services/tasks/mcpClient.js')
      const tools = await createMcpClient({ endpoint: address, key: token }).list(active.signal)
      active.signal.throwIfAborted()
      const previous = useAgentExtensions.getState().mcp
      const enabled =
        previous?.endpoint === address && previous.key.trim() === token
          ? previous.enabled.filter((name) => tools.some((tool) => tool.name === name))
          : []
      if (saveAgentExtensions({ mcp: { endpoint: address, key: token, tools, enabled } })) {
        setNotice({ key: 'projectMcpConnected', params: { count: tools.length } })
      } else {
        saveFailure()
      }
    } catch {
      if (!active.signal.aborted) {
        setNotice({ key: 'projectMcpError' })
      }
    } finally {
      controller.current = undefined
      setBusy(false)
    }
  }
  return (
    <div className={styles.stack}>
      <Section title={t('projectSkills')}>
        <input
          ref={file}
          data-testid="skill-file-import"
          type="file"
          accept=".md,text/markdown"
          hidden
          onChange={async (event) => {
            const chosen = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (!chosen) {
              return
            }
            try {
              const skill = await readAgentSkill(chosen)
              const current = useAgentExtensions.getState()
              if (current.skills.length >= 30) {
                setSkillNotice({ key: 'projectSkillLimit' })
              } else if (!saveAgentExtensions({ skills: [...current.skills, skill] })) {
                setSkillNotice({ key: 'assistantSaveFailed' })
              } else {
                setSkillNotice(undefined)
              }
            } catch {
              setSkillNotice({ key: 'projectSkillInvalid' })
            }
          }}
        />
        <div className={workspaceStyles.form}>
          <p className={styles.hint}>{t('projectSkillHelp')}</p>
          <Button size="s" variant="outlined" onClick={() => file.current?.click()}>
            {t('projectSkillImport')}
          </Button>
          {skillNotice && <p role="alert">{t(skillNotice.key)}</p>}
        </div>
        {skills.map((skill) => (
          <details className={workspaceStyles.extensionDetail} key={skill.id}>
            <summary>{skill.name}</summary>
            {skill.description && <p className={styles.hint}>{skill.description}</p>}
            <p className={workspaceStyles.extensionDescription}>{skill.text}</p>
            <SwitchRow
              label={t('assistantAllowed')}
              checked={skillId === skill.id}
              change={(enabled) => {
                if (!saveAgentExtensions({ skillId: enabled ? skill.id : undefined })) {
                  setSkillNotice({ key: 'assistantSaveFailed' })
                }
              }}
            />
            <Button
              variant="outlined"
              size="s"
              onClick={() => {
                if (
                  !saveAgentExtensions({
                    skills: skills.filter(({ id }) => id !== skill.id),
                    ...(skillId === skill.id && { skillId: undefined }),
                  })
                ) {
                  setSkillNotice({ key: 'assistantSaveFailed' })
                }
              }}
            >
              {t('projectSkillRemove')}
            </Button>
          </details>
        ))}
      </Section>
      <Section title={t('projectMcp')}>
        <form
          className={workspaceStyles.form}
          onSubmit={(event) => {
            event.preventDefault()
            void connect()
          }}
        >
          <input
            type="url"
            required
            disabled={busy}
            className={workspaceStyles.field}
            value={endpoint}
            aria-label={t('projectMcpEndpoint')}
            placeholder={t('projectMcpEndpoint')}
            onChange={(event) => setEndpoint(event.target.value)}
          />
          <input
            type="password"
            disabled={busy}
            className={workspaceStyles.field}
            value={key}
            aria-label={t('projectMcpToken')}
            placeholder={t('projectMcpToken')}
            onChange={(event) => setKey(event.target.value)}
          />
          <div className={workspaceStyles.changeActions}>
            {busy && (
              <Button
                type="button"
                variant="outlined"
                size="s"
                onClick={() => controller.current?.abort()}
              >
                {t('cancel')}
              </Button>
            )}
            <Button type="submit" size="s" disabled={busy || !validMcpEndpoint(endpoint)}>
              {t('projectMcpConnect')}
            </Button>
          </div>
        </form>
        {notice && (
          <p
            className={notice.key === 'projectMcpConnected' ? styles.hint : styles.error}
            role="status"
          >
            {t(notice.key, notice.params)}
          </p>
        )}
        {mcp && mcp.endpoint === validMcpEndpoint(endpoint) && mcp.key.trim() === key.trim() && (
          <>
            {mcp.tools.map((tool) => (
              <SwitchRow
                key={tool.name}
                label={tool.name}
                description={[t('projectMcpApproval'), tool.description]
                  .filter(Boolean)
                  .join(' · ')}
                checked={mcp.enabled.includes(tool.name)}
                change={(enabled) => {
                  if (
                    !saveAgentExtensions({
                      mcp: {
                        ...mcp,
                        enabled: enabled
                          ? [...mcp.enabled, tool.name]
                          : mcp.enabled.filter((name) => name !== tool.name),
                      },
                    })
                  ) {
                    saveFailure()
                  }
                }}
              />
            ))}
            <div className={workspaceStyles.changeActions}>
              <Button
                variant="outlined"
                size="s"
                disabled={busy}
                onClick={() => {
                  if (saveAgentExtensions({ mcp: undefined })) {
                    setEndpoint('')
                    setKey('')
                    setNotice(undefined)
                  } else {
                    saveFailure()
                  }
                }}
              >
                {t('projectMcpForget')}
              </Button>
            </div>
          </>
        )}
      </Section>
    </div>
  )
}
