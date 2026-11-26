import { useId, useLayoutEffect, useRef, useState } from 'react'
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
import { SwitchRow } from '../settings/SettingsRows.js'
import styles from './RoleVoice.module.css'

export const RoleVoiceButton = ({
  roles,
  live,
  onLiveChange,
  onPreview,
  onSave,
}: {
  roles: ReadonlyArray<VoiceRole>
  live: boolean
  onLiveChange: (enabled: boolean) => void
  onPreview: (role: VoiceRole, context?: AudioContext) => void
  onSave: (next: VoiceRole, sample?: Blob) => Promise<RoleVoiceSaveResult>
}) => {
  const t = useTranslate()
  const roleVoice = useSettings((state) => state.roleVoice)
  const profiles = useProviders((state) => state.profiles)
  const [editing, setEditing] = useState<VoiceRole | null>(null)
  const [showExtras, setShowExtras] = useState(false)
  const extraList = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const listTop = useRef(0)
  const count = visibleRoleCount(roles) || roles.length
  const panel = useOptionPanel(t('settingsRoleVoice'), {
    kind: 'artifacts',
    align: 'end',
    disabled: !roleVoice.enabled || (!count && !live),
  })
  useLayoutEffect(() => {
    if (panel.positioned && listRef.current) {
      listRef.current.scrollTop = listTop.current
    }
  }, [panel.positioned])
  if (!roleVoice.enabled || (!count && !live)) {
    return null
  }

  const profile = roleVoiceProfile(profiles, roleVoice)
  const ordered = sortRoles(roles)
  const named = ordered.filter((role) => role.importance !== 'extra')
  const extras = ordered.filter((role) => role.importance === 'extra')
  const renderRole = (role: VoiceRole) => {
    const voice = effectiveVoice(role, roleVoice)
    const label = role.voiceSample && voice.description
      ? t('roleVoiceSampleFixed')
      : voice.description
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
          listTop.current = listRef.current?.scrollTop ?? 0
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
        {count > 0 && <span aria-hidden>{count}</span>}
      </button>
      {panel.open &&
        panel.render(
          <>
            <div className={styles.heading}>
              <strong>{t('settingsRoleVoice')}</strong>
              {roles.length > 0 && <span>{roles.length}</span>}
            </div>
            <div ref={listRef} className={styles.scroll} data-testid="role-voice-list" data-scroll-edge="">
              <div data-scroll-edge-content="">
                {(profile || live) && <div className={styles.livePreference}>
                  <SwitchRow panelItem label={t('roleVoiceLive')} checked={live}
                    change={onLiveChange} description={t('roleVoiceLiveDescription')} />
                </div>}
                {!profile && (
                  <button
                    type="button"
                    className={styles.configuration}
                    data-panel-item=""
                    onClick={() => {
                      panel.close()
                      openSettings('chatSpeech', { backToConversation: true })
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
                          ? t('roleVoiceSharedVoice')
                          : t('roleVoiceOwnVoices')}
                      </span>
                    </button>
                    <ul id={extraList} className={styles.list} hidden={!showExtras}>
                      {showExtras && extras.map(renderRole)}
                    </ul>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      {editing && (
        <RoleVoiceDialog
          role={editing}
          profile={profile}
          extraVoice={roleVoice.extraVoice}
          extrasShareVoice={roleVoice.extrasShareVoice}
          onClose={() => {
            setEditing(null)
            panel.show()
          }}
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
          {playback === 'loading' || playback === 'playing' ? <ReadingBars mode={playback} /> : <IconPlayMediaOutline16 />}
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
