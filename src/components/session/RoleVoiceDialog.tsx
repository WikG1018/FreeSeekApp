import { useEffect, useId, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { IconCloseOutline16 } from '../base/icons.js'
import {
  MAX_ROLE_ALIASES,
  MAX_ROLE_NAME,
  MAX_ROLE_TEXT,
  MIMO_PRESET_VOICES,
  roleNameKey,
  type MiMoPresetVoice,
  type RoleImportance,
  type VoiceRole,
} from '../../services/speech/roleMarkers.js'
import { regenerateVoiceDescription } from '../../services/speech/roleVoiceGenerate.js'
import { prepareSpeechOutput } from '../../services/speech/readAloud.js'
import { useSettings } from '../../services/settings.js'
import styles from './RoleVoice.module.css'

export type RoleVoiceSaveResult = 'saved' | 'conflict' | 'failed'

export const RoleVoiceDialog = ({
  role,
  extraVoice,
  extrasShareVoice,
  onSave,
  onPreview,
  onClose,
}: {
  role: VoiceRole
  extraVoice: MiMoPresetVoice
  extrasShareVoice: boolean
  onSave: (next: VoiceRole) => Promise<RoleVoiceSaveResult>
  onPreview?: (role: VoiceRole, context?: AudioContext) => void
  onClose: () => void
}) => {
  const t = useTranslate()
  const english = useSettings((state) => state.locale === 'en-US')
  const id = useId()
  const [name, setName] = useState(role.name)
  const [aliases, setAliases] = useState(role.aliases)
  const [aliasDraft, setAliasDraft] = useState('')
  const [importance, setImportance] = useState<RoleImportance>(role.importance)
  const [mode, setMode] = useState<'preset' | 'description'>(
    role.description && !role.preset ? 'description' : 'preset'
  )
  const [preset, setPreset] = useState<MiMoPresetVoice>(role.preset ?? '白桦')
  const [description, setDescription] = useState(role.description ?? '')
  const [nature, setNature] = useState(role.nature)
  const [error, setError] = useState('')
  const [rewriting, setRewriting] = useState(false)
  const [saving, setSaving] = useState(false)
  const mounted = useRef(true)
  const rewriteController = useRef<AbortController>()
  const output = useRef<AudioContext>()
  const narrator = roleNameKey(name) === '旁白'
  const presetOnly = importance === 'extra' || narrator
  const shared = importance === 'extra' && extrasShareVoice
  const useDescription = !presetOnly && mode === 'description'
  const voice = shared ? extraVoice : preset
  const catalog =
    preset === 'mimo_default'
      ? [...MIMO_PRESET_VOICES, { id: 'mimo_default' as const, label: '', enLabel: '' }]
      : MIMO_PRESET_VOICES

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      rewriteController.current?.abort()
      void output.current?.close().catch(() => {})
    }
  }, [])

  const collectAliases = () => {
    const seen = new Set([roleNameKey(name)])
    return [...aliases, aliasDraft]
      .map((alias) => alias.trim())
      .filter((alias) => {
        const key = roleNameKey(alias)
        if (!key || seen.has(key)) {
          return false
        }
        seen.add(key)
        return true
      })
      .slice(0, MAX_ROLE_ALIASES)
  }
  const addAlias = () => {
    setAliases(collectAliases())
    setAliasDraft('')
  }

  const stopRewrite = () => {
    rewriteController.current?.abort()
    rewriteController.current = undefined
    setRewriting(false)
  }

  const rewrite = async () => {
    if (rewriteController.current) {
      return
    }
    const controller = new AbortController()
    rewriteController.current = controller
    setRewriting(true)
    setError('')
    try {
      const result = await regenerateVoiceDescription(
        { name: name.trim() || role.name, nature, aliases: collectAliases(), importance },
        controller.signal
      )
      if (!controller.signal.aborted) {
        setDescription(result)
      }
    } catch {
      if (!controller.signal.aborted) {
        setError(t('roleVoiceRewriteFailed'))
      }
    } finally {
      if (rewriteController.current === controller) {
        rewriteController.current = undefined
        setRewriting(false)
      }
    }
  }

  const save = async () => {
    if (!name.trim()) {
      setError(t('roleVoiceNameRequired'))
      return
    }
    if (useDescription && !description.trim()) {
      setError(t('roleVoiceDescriptionRequired'))
      return
    }
    const editedAliases = collectAliases()
    const originalName = roleNameKey(role.name)
    if (
      originalName !== roleNameKey(name) &&
      !editedAliases.some((alias) => roleNameKey(alias) === originalName)
    ) {
      // Keep the name from when the editor opened, including on a retry after a failed write.
      editedAliases.unshift(role.name)
    }
    const next: VoiceRole = {
      ...role,
      name: name.trim(),
      aliases: editedAliases.slice(0, MAX_ROLE_ALIASES),
      nature: nature.trim(),
      importance,
      source: 'user',
      ...(useDescription
        ? { description: description.trim(), preset: undefined }
        : {
            preset,
            description: undefined,
          }),
    }
    setSaving(true)
    setError('')
    stopRewrite()
    if (onPreview) {
      try {
        output.current = prepareSpeechOutput()
      } catch {
        // Saving is independent of the playback device.
      }
    }
    const result = await onSave(next).catch(() => 'failed')
    if (!mounted.current) {
      return
    }
    const context = output.current
    output.current = undefined
    if (result !== 'saved') {
      void context?.close().catch(() => {})
      setSaving(false)
      setError(t(result === 'conflict' ? 'roleVoiceNameConflict' : 'roleVoiceEditSaveFailed'))
      return
    }
    onClose()
    onPreview?.(next, context)
  }

  return (
    <Modal
      title={
        <span tabIndex={-1} data-modal-initial-focus="">
          {t('roleVoiceEditTitle')}
        </span>
      }
      centered
      dismissible={!saving}
      onClose={onClose}
      footer={
        <div className={styles.editorActions}>
          <Button size="m" variant="outlined" disabled={saving} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button size="m" disabled={saving} onClick={() => void save()}>
            {t(
              saving ? 'roleVoiceSaving' : onPreview ? 'roleVoiceSaveAndPreview' : 'roleVoiceSave'
            )}
          </Button>
        </div>
      }
    >
      <div className={styles.form}>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={id + '-name'}>
            {t('roleVoiceName')}
          </label>
          <input
            id={id + '-name'}
            className={styles.input}
            maxLength={MAX_ROLE_NAME}
            value={name}
            onChange={(event) => {
              stopRewrite()
              setName(event.target.value)
            }}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={id + '-alias'}>
            {t('roleVoiceAliases')}
          </label>
          <div className={styles.aliasRow}>
            {aliases.map((alias) => (
              <button
                key={alias}
                type="button"
                className={styles.alias}
                aria-label={t('roleVoiceRemoveAlias', { name: alias })}
                onClick={() => setAliases(aliases.filter((item) => item !== alias))}
              >
                <span>{alias}</span>
                <IconCloseOutline16 />
              </button>
            ))}
            <input
              id={id + '-alias'}
              className={styles.aliasInput}
              maxLength={MAX_ROLE_NAME}
              value={aliasDraft}
              aria-label={t('roleVoiceAddAlias')}
              placeholder={t('roleVoiceAddAlias')}
              onChange={(event) => setAliasDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  addAlias()
                }
              }}
              onBlur={addAlias}
            />
          </div>
        </div>
        <fieldset className={styles.fieldset}>
          <legend className={styles.fieldLabel}>{t('roleVoiceImportance')}</legend>
          <div className={styles.segmented}>
            {(['lead', 'supporting', 'extra'] as const).map((level) => (
              <label key={level}>
                <input
                  type="radio"
                  name={id + '-importance'}
                  checked={importance === level}
                  onChange={() => {
                    stopRewrite()
                    setImportance(level)
                  }}
                />
                <span>{t(`roleVoiceImportance_${level}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className={styles.fieldset}>
          <legend className={styles.fieldLabel}>{t('roleVoiceVoice')}</legend>
          {!presetOnly && (
            <div className={styles.segmented}>
              {(['preset', 'description'] as const).map((type) => (
                <label key={type}>
                  <input
                    type="radio"
                    name={id + '-mode'}
                    checked={type === mode}
                    onChange={() => {
                      stopRewrite()
                      setMode(type)
                    }}
                  />
                  <span>
                    {t(
                      type === 'preset'
                        ? 'settingsRoleVoiceLeadPreset'
                        : 'settingsRoleVoiceLeadDescription'
                    )}
                  </span>
                </label>
              ))}
            </div>
          )}
          {shared ? (
            <p className={styles.hint}>
              {t('roleVoiceSharedVoice', { voice })} · {t('roleVoiceExtraHint')}
            </p>
          ) : useDescription ? (
            <>
              <textarea
                className={styles.textarea}
                maxLength={MAX_ROLE_TEXT}
                value={description}
                aria-label={t('roleVoiceDescription')}
                onChange={(event) => {
                  stopRewrite()
                  setDescription(event.target.value)
                }}
              />
              <div className={styles.rewriteRow}>
                <Button
                  variant="outlined"
                  size="s"
                  disabled={rewriting}
                  onClick={() => void rewrite()}
                >
                  {t(rewriting ? 'roleVoiceRewriting' : 'roleVoiceRewrite')}
                </Button>
                <span className={styles.hint}>{t('settingsRoleVoiceLeadHint')}</span>
              </div>
            </>
          ) : (
            <div
              className={styles.presetChoices}
              role="radiogroup"
              aria-label={t('roleVoicePreset')}
            >
              {catalog.map((item) => (
                <label key={item.id} className={styles.choice}>
                  <input
                    type="radio"
                    name={id + '-preset'}
                    checked={item.id === voice}
                    onChange={() => setPreset(item.id)}
                  />
                  <span>
                    <strong>
                      {item.id === 'mimo_default' ? t('roleVoiceDefaultPreset') : item.id}
                    </strong>
                    <small>{english ? item.enLabel : item.label}</small>
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={id + '-nature'}>
            {t('roleVoiceNature')}
          </label>
          <textarea
            id={id + '-nature'}
            className={styles.textarea}
            maxLength={MAX_ROLE_TEXT}
            value={nature}
            onChange={(event) => {
              stopRewrite()
              setNature(event.target.value)
            }}
          />
          <p className={styles.hint}>{t('roleVoiceNatureHint')}</p>
        </div>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
