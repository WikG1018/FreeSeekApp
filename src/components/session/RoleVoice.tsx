import { useId, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconChevronRightOutline14,
  IconMasksOutline16,
  IconPlayMediaOutline16,
} from '../base/icons.js'
import { useOptionPanel } from '../base/OptionPanel.js'
import { useSettings } from '../../services/settings.js'
import { useProviders } from '../../services/providers.js'
import { roleVoiceProfile } from '../../services/speech/roleVoiceProfile.js'
import { effectiveVoice, sortRoles, visibleRoleCount } from '../../services/speech/roleTable.js'
import { useReadAloud } from '../../services/speech/readAloud.js'
import type { VoiceRole } from '../../services/speech/roleMarkers.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { ReadingBars } from '../messages/ReadingBars.js'
import { RoleVoiceDialog, type RoleVoiceSaveResult } from './RoleVoiceDialog.js'
import styles from './RoleVoice.module.css'

export const RoleVoiceButton = ({
  roles,
  onPreview,
  onSave,
}: {
  roles: ReadonlyArray<VoiceRole>
  onPreview: (role: VoiceRole, context?: AudioContext) => void
  onSave: (next: VoiceRole) => Promise<RoleVoiceSaveResult>
}) => {
  const t = useTranslate()
  const roleVoice = useSettings((state) => state.roleVoice)
  const profiles = useProviders((state) => state.profiles)
  const [editing, setEditing] = useState<VoiceRole | null>(null)
  const [showExtras, setShowExtras] = useState(false)
  const extraList = useId()
  const count = visibleRoleCount(roles) || roles.length
  const panel = useOptionPanel(t('settingsRoleVoice'), {
    kind: 'artifacts',
    align: 'end',
    disabled: !roleVoice.enabled || !count,
  })
  if (!roleVoice.enabled || !count) {
    return null
  }

  const profile = roleVoiceProfile(profiles, roleVoice)
  const ordered = sortRoles(roles)
  const named = ordered.filter((role) => role.importance !== 'extra')
  const extras = ordered.filter((role) => role.importance === 'extra')
  const renderRole = (role: VoiceRole) => {
    const voice = effectiveVoice(role, roleVoice)
    const label = voice.description
      ? t('roleVoiceDescriptionShort')
      : voice.preset === 'mimo_default'
        ? t('roleVoiceDefaultPreset')
        : (voice.preset ?? roleVoice.extraVoice)
    return (
      <VoiceRoleRow
        key={role.id}
        role={role}
        label={label}
        canPreview={!!profile}
        onEdit={() => {
          panel.close()
          setEditing(role)
        }}
        onPreview={() => onPreview(role)}
      />
    )
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
        <span aria-hidden>{count}</span>
      </button>
      {panel.open &&
        panel.render(
          <>
            <div className={styles.heading}>
              <strong>{t('settingsRoleVoice')}</strong>
              <span>{roles.length}</span>
            </div>
            <div className={styles.scroll} data-testid="role-voice-list">
              {!profile && (
                <button
                  type="button"
                  className={styles.configuration}
                  data-panel-item=""
                  onClick={() => {
                    panel.close()
                    openSettings('providerSpeech')
                  }}
                >
                  <span>
                    <strong>{t('settingsRoleVoiceModelMissing')}</strong>
                    <small>{t('settingsRoleVoiceModelGo')}</small>
                  </span>
                  <IconChevronRightOutline14 />
                </button>
              )}
              {named.length > 0 && <ul className={styles.list}>{named.map(renderRole)}</ul>}
              {extras.length > 0 && (
                <>
                  <button
                    type="button"
                    className={styles.foldRow}
                    data-panel-item=""
                    aria-expanded={showExtras}
                    aria-controls={extraList}
                    onClick={() => setShowExtras(!showExtras)}
                  >
                    <IconChevronRightOutline14 />
                    <span>{t('roleVoiceOthers', { count: extras.length })}</span>
                    <span>
                      {roleVoice.extrasShareVoice
                        ? t('roleVoiceSharedVoice', { voice: roleVoice.extraVoice })
                        : t('roleVoiceOwnVoices')}
                    </span>
                  </button>
                  <ul id={extraList} className={styles.list} hidden={!showExtras}>
                    {showExtras && extras.map(renderRole)}
                  </ul>
                </>
              )}
            </div>
          </>
        )}
      {editing && (
        <RoleVoiceDialog
          role={editing}
          extraVoice={roleVoice.extraVoice}
          extrasShareVoice={roleVoice.extrasShareVoice}
          onClose={() => setEditing(null)}
          onSave={onSave}
          onPreview={profile ? onPreview : undefined}
        />
      )}
    </>
  )
}

const VoiceRoleRow = ({
  role,
  label,
  canPreview,
  onEdit,
  onPreview,
}: {
  role: VoiceRole
  label: string
  canPreview: boolean
  onEdit: () => void
  onPreview: () => void
}) => {
  const t = useTranslate()
  const playback = useReadAloud((state) =>
    state.messageId === 'preview-' + role.id ? state.status : 'idle'
  )
  const previewLabel =
    playback === 'idle' ? t('roleVoicePreview', { name: role.name }) : t('ttsStop')
  const meta = [t(`roleVoiceImportance_${role.importance}`), ...role.aliases].join(' · ')
  return (
    <li className={styles.row}>
      {canPreview && (
        <button
          type="button"
          className={styles.preview}
          aria-label={previewLabel}
          title={previewLabel}
          data-panel-item=""
          onClick={onPreview}
        >
          {playback === 'idle' ? <IconPlayMediaOutline16 /> : <ReadingBars mode={playback} />}
        </button>
      )}
      <button
        type="button"
        className={styles.editRole}
        aria-label={t('roleVoiceEdit', { name: role.name })}
        data-panel-item=""
        onClick={onEdit}
      >
        <span className={styles.copy}>
          <span className={styles.copyName}>{role.name}</span>
          <span className={styles.copyMeta}>{meta}</span>
        </span>
        <span className={styles.copyVoice}>{label}</span>
        <IconChevronRightOutline14 />
      </button>
    </li>
  )
}
