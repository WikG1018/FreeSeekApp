import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconChevronRightOutline14, IconEditOutline16, IconMasksOutline16, IconPlayMediaOutline16 } from '../base/icons.js'
import { useOptionPanel } from '../base/OptionPanel.js'
import { useSettings } from '../../services/settings.js'
import { useProviders } from '../../services/providers.js'
import { roleVoiceProfile } from '../../services/speech/roleVoiceProfile.js'
import { effectiveVoice, sortRoles, visibleRoleCount } from '../../services/speech/roleTable.js'
import type { VoiceRole } from '../../services/speech/roleMarkers.js'
import { RoleVoiceDialog } from './RoleVoiceDialog.js'
import styles from './RoleVoice.module.css'

/**
 * 顶栏的角色配音按钮与面板。位置与样式沿用会话成果按钮（同一槽位、同款玻璃胶囊）。
 * 只有开关打开且本会话已出现角色时才显示。
 */
export const RoleVoiceButton = ({
  roles,
  onPreview,
  onSave,
}: {
  roles: ReadonlyArray<VoiceRole>
  onPreview: (role: VoiceRole) => void
  onSave: (next: VoiceRole) => void
}) => {
  const t = useTranslate()
  const roleVoice = useSettings((state) => state.roleVoice)
  const profiles = useProviders((state) => state.profiles)
  const panel = useOptionPanel(t('settingsRoleVoice'), { kind: 'artifacts', align: 'end', focusFirst: false })
  const [editing, setEditing] = useState<VoiceRole | null>(null)
  const [showExtras, setShowExtras] = useState(false)
  const profile = roleVoiceProfile(profiles, roleVoice)
  const ordered = sortRoles(roles)
  const named = ordered.filter((role) => role.importance !== 'extra')
  const extras = ordered.filter((role) => role.importance === 'extra')
  const count = visibleRoleCount(roles)
  if (!roleVoice.enabled || count === 0) {
    return null
  }
  const extraVoice = roleVoice.extraVoice
  const voiceLabel = (role: VoiceRole) => {
    const voice = effectiveVoice(role, { extrasShareVoice: roleVoice.extrasShareVoice, extraVoice })
    if (voice.description) {
      return voice.description
    }
    return voice.preset ?? extraVoice
  }
  const importanceLabel = (role: VoiceRole) =>
    t(`roleVoiceImportance_${role.importance}`)
  const meta = (role: VoiceRole) => {
    const parts = [importanceLabel(role)]
    if (role.aliases.length) {
      parts.push(role.aliases.join('、'))
    }
    return parts.join(' · ')
  }
  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        aria-label={t('roleVoiceButtonLabel', { count })}
        title={t('settingsRoleVoice')}
        ref={panel.anchorRef}
        data-role-voice-trigger=""
        data-open={panel.open || undefined}
        {...panel.trigger}
      >
        <IconMasksOutline16 />
        <span>{count}</span>
      </button>
      {panel.open &&
        panel.render(
          <>
            <div className={styles.heading}>
              <strong>{t('settingsRoleVoice')}</strong>
              <span>{count}</span>
            </div>
            {profile ? (
              <>
                <div className={styles.scroll} data-testid="role-voice-list">
                  <ul className={styles.list}>
                    {named.map((role) => (
                      <li key={role.id}>
                        <div
                          className={styles.row}
                          role="button"
                          tabIndex={0}
                          aria-label={t('roleVoiceEdit', { name: role.name })}
                          onClick={() => {
                            panel.close()
                            setEditing(role)
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              panel.close()
                              setEditing(role)
                            }
                          }}
                        >
                          <button
                            type="button"
                            className={styles.preview}
                            aria-label={t('roleVoicePreview', { name: role.name })}
                            onClick={(event) => {
                              event.stopPropagation()
                              onPreview({ ...role, source: 'user' })
                            }}
                          >
                            <IconPlayMediaOutline16 />
                          </button>
                          <span className={styles.copy}>
                            <span className={styles.copyName}>{role.name}</span>
                            <span className={styles.copyMeta}>{meta(role)}</span>
                          </span>
                          <span className={styles.copyVoice}>{voiceLabel(role)}</span>
                          <span className={styles.editButton} aria-hidden>
                            <IconEditOutline16 />
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {extras.length > 0 && (
                    <>
                      <button
                        type="button"
                        className={styles.foldRow}
                        aria-expanded={showExtras}
                        onClick={() => setShowExtras(!showExtras)}
                      >
                        <IconChevronRightOutline14 />
                        <span>{t('roleVoiceOthers', { count: extras.length })}</span>
                        <span>
                          {roleVoice.extrasShareVoice
                            ? t('roleVoiceSharedVoice', { voice: extraVoice })
                            : t('roleVoiceOwnVoices')}
                        </span>
                      </button>
                      {showExtras && (
                        <ul className={styles.list}>
                          {extras.map((role) => (
                            <li key={role.id}>
                              <div
                                className={styles.row}
                                role="button"
                                tabIndex={0}
                                aria-label={t('roleVoiceEdit', { name: role.name })}
                                onClick={() => {
                                  panel.close()
                                  setEditing(role)
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault()
                                    panel.close()
                                    setEditing(role)
                                  }
                                }}
                              >
                                <button
                                  type="button"
                                  className={styles.preview}
                                  aria-label={t('roleVoicePreview', { name: role.name })}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    onPreview({ ...role, source: 'user' })
                                  }}
                                >
                                  <IconPlayMediaOutline16 />
                                </button>
                                <span className={styles.copy}>
                                  <span className={styles.copyName}>{role.name}</span>
                                  <span className={styles.copyMeta}>{meta(role)}</span>
                                </span>
                                <span className={styles.copyVoice}>{voiceLabel(role)}</span>
                                <span className={styles.editButton} aria-hidden>
                                  <IconEditOutline16 />
                                </span>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
                <p className={styles.note}>{t('roleVoiceToneNote')}</p>
              </>
            ) : (
              <p className={styles.note}>{t('settingsRoleVoiceNeedKey')}</p>
            )}
          </>
        )}
      {editing && (
        <RoleVoiceDialog
          role={editing}
          extraVoice={extraVoice}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            onSave(next)
            setEditing(null)
          }}
          onPreview={(next) => onPreview(next)}
        />
      )}
    </>
  )
}
