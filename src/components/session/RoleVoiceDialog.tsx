import { useEffect, useId, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { IconCloseOutline16, IconPlayMediaOutline16, IconStopOutline16 } from '../base/icons.js'
import { Select } from '../base/Select.js'
import { SettingsDisclosure } from '../settings/SettingsDisclosure.js'
import {
  DEFAULT_NARRATOR_VOICE,
  MAX_ROLE_ALIASES,
  MAX_ROLE_NAME,
  MAX_ROLE_TEXT,
  MIMO_PRESET_VOICES,
  presetForGender,
  presetVoiceGender,
  roleNameKey,
  voiceGenderFromDescription,
  type MiMoPresetVoice,
  type RoleImportance,
  type VoiceGender,
  type VoiceRole,
} from '../../services/speech/roleMarkers.js'
import { ApiError } from '../../services/api/errorTypes.js'
import { regenerateVoiceDescription } from '../../services/speech/roleVoiceGenerate.js'
import {
  describeReadAloudError, prepareSpeechOutput, previewRoleVoiceSample, stopReadAloud, useReadAloud,
} from '../../services/speech/readAloud.js'
import { useSettings } from '../../services/settings.js'
import { createId } from '../../utils/id.js'
import type { MiMoSpeechProfile } from '../../services/api/speech.js'
import { generateRoleVoiceSample } from '../../services/speech/voiceSample.js'
import { styleInstruction } from '../../services/speech/roleTable.js'
import styles from './RoleVoice.module.css'

export type RoleVoiceSaveResult = 'saved' | 'conflict' | 'failed'

export const RoleVoiceDialog = ({
  role,
  profile,
  extraVoice,
  extrasShareVoice,
  onSave,
  onPreview,
  onClose,
}: {
  role: VoiceRole
  profile: MiMoSpeechProfile | null
  extraVoice: MiMoPresetVoice
  extrasShareVoice: boolean
  onSave: (next: VoiceRole, sample?: Blob) => Promise<RoleVoiceSaveResult>
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
  const [voiceGender, setVoiceGender] = useState<VoiceGender | undefined>(role.voiceGender)
  const [mode, setMode] = useState<'preset' | 'description'>(
    role.description && !role.preset ? 'description' : 'preset'
  )
  const [preset, setPreset] = useState<MiMoPresetVoice>(() =>
    presetForGender(role.preset ?? DEFAULT_NARRATOR_VOICE, role.voiceGender)
  )
  const [description, setDescription] = useState(role.description ?? '')
  const [nature, setNature] = useState(role.nature)
  const [error, setError] = useState('')
  const [rewriteError, setRewriteError] = useState('')
  const [rewriting, setRewriting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [candidate, setCandidate] = useState<{
    id: string
    blob: Blob
    description: string
    gender?: VoiceGender
  }>()
  const [sampling, setSampling] = useState(false)
  const [sampleError, setSampleError] = useState('')
  const mounted = useRef(true)
  const rewriteController = useRef<AbortController>()
  const sampleOutput = useRef<AudioContext>()
  const sampleController = useRef<AbortController>()
  const auditionId = 'audition-' + role.id
  const previewId = 'preview-' + role.id
  const auditioning = useReadAloud((state) => state.messageId === auditionId || state.messageId === previewId)
  const narrator = roleNameKey(name) === '旁白'
  const presetOnly = importance === 'extra' || narrator
  const useDescription = !presetOnly && mode === 'description'
  const candidateVoice = useDescription && candidate?.description === description.trim() &&
    candidate.gender === voiceGender ? candidate : undefined
  const savedReference = useDescription && description.trim() === role.description &&
    voiceGender === role.voiceGender ? role.voiceSample : undefined
  const shared = importance === 'extra' && extrasShareVoice && role.source === 'model' && !narrator
  const sharedVoice = presetForGender(extraVoice, voiceGender ?? presetVoiceGender(preset))
  const catalog =
    preset === 'mimo_default'
      ? [...MIMO_PRESET_VOICES, { id: 'mimo_default' as const, label: '', enLabel: '' }]
      : MIMO_PRESET_VOICES

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      rewriteController.current?.abort()
      sampleController.current?.abort()
      void sampleOutput.current?.close().catch(() => {})
      const audio = useReadAloud.getState().messageId
      if (audio === auditionId || audio === previewId) {
        stopReadAloud()
      }
    }
  }, [auditionId, previewId])

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
    setRewriteError('')
  }

  const rewrite = async () => {
    if (rewriteController.current) {
      return
    }
    const controller = new AbortController()
    rewriteController.current = controller
    setRewriting(true)
    setRewriteError('')
    try {
      const result = await regenerateVoiceDescription(
        { name: name.trim() || role.name, nature, aliases: collectAliases(), importance, voiceGender, description },
        controller.signal
      )
      if (!controller.signal.aborted) {
        setDescription(result)
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        const message = reason instanceof ApiError && reason.status !== undefined && reason.status >= 500
          ? { key: 'roleVoiceRewriteServiceUnavailable' as const, params: { status: reason.status } }
          : reason instanceof ApiError ? reason.localMessage : undefined
        setRewriteError(message ? t(message.key, message.params) : t('roleVoiceRewriteFailed'))
      }
    } finally {
      if (rewriteController.current === controller) {
        rewriteController.current = undefined
        setRewriting(false)
      }
    }
  }

  const reportSampleError = (reason: unknown) => {
    const message = describeReadAloudError(reason)
    setSampleError(t(message.key, message.params))
  }

  const generateSample = async () => {
    const value = description.trim()
    if (!profile || sampleController.current || !value) {
      return
    }
    const gender = voiceGenderFromDescription(value)
    if (voiceGender && gender && voiceGender !== gender) {
      setSampleError(t('roleVoiceDescriptionGenderMismatch'))
      return
    }
    const controller = new AbortController()
    sampleController.current = controller
    setSampling(true)
    setSampleError('')
    try {
      sampleOutput.current = prepareSpeechOutput()
    } catch {
      // Users can replay a generated sample from a fresh playback gesture.
    }
    try {
      const blob = await generateRoleVoiceSample(
        profile, t('roleVoiceSampleText'), value,
        styleInstruction({ ...role, nature, description: value, voiceGender, preset: undefined }, ''),
        controller.signal
      )
      controller.signal.throwIfAborted()
      setCandidate({ id: createId(), blob, description: value, gender: voiceGender })
      const context = sampleOutput.current
      sampleOutput.current = undefined
      if (context) {
        previewRoleVoiceSample(auditionId, name.trim() || role.name, blob, context, reportSampleError)
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        reportSampleError(reason)
      }
    } finally {
      void sampleOutput.current?.close().catch(() => {})
      sampleOutput.current = undefined
      sampleController.current = undefined
      if (mounted.current) {
        setSampling(false)
      }
    }
  }

  const stopAudition = () => {
    if (auditioning) {
      stopReadAloud()
    }
  }
  const previewPreset = () => {
    if (auditioning) {
      stopAudition()
      return
    }
    onPreview?.({
      ...role,
      name: name.trim() || role.name,
      nature: nature.trim(),
      importance,
      voiceGender: narrator ? undefined : voiceGender,
      preset: presetForGender(preset, narrator ? undefined : voiceGender),
      description: undefined,
      voiceSample: undefined,
      source: 'user',
    })
  }
  const replaySample = () => {
    if (auditioning) {
      stopAudition()
    } else if (candidateVoice) {
      previewRoleVoiceSample(auditionId, name.trim() || role.name, candidateVoice.blob, undefined, reportSampleError)
    } else {
      onPreview?.(role)
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
    const describedGender = voiceGenderFromDescription(description)
    if (useDescription && voiceGender && describedGender && voiceGender !== describedGender) {
      setRewriteError(t('roleVoiceDescriptionGenderMismatch'))
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
      voiceGender: narrator ? undefined : voiceGender,
      nature: nature.trim(),
      importance,
      source: 'user',
      voiceSample: candidateVoice
        ? { id: candidateVoice.id, size: candidateVoice.blob.size }
        : savedReference,
      ...(useDescription
        ? { description: description.trim(), preset: undefined }
        : {
            preset: presetForGender(preset, narrator ? undefined : voiceGender),
            description: undefined,
          }),
    }
    setSaving(true)
    setError('')
    stopRewrite()
    const result = await onSave(next, candidateVoice?.blob).catch(() => 'failed')
    if (!mounted.current) {
      return
    }
    if (result !== 'saved') {
      setSaving(false)
      setError(t(result === 'conflict' ? 'roleVoiceNameConflict' : 'roleVoiceEditSaveFailed'))
      return
    }
    onClose()
  }

  const busy = sampling || saving
  const presetOptions = catalog
    .filter((item) => narrator || !voiceGender || presetVoiceGender(item.id) === voiceGender)
    .map((item) => ({
      value: item.id,
      label: item.id === 'mimo_default' ? t('roleVoiceDefaultPreset') : item.id,
      detail: english ? item.enLabel : item.label,
    }))
  const genderOptions = (['auto', 'female', 'male'] as const).map((value) => ({
    value, label: t(`roleVoiceGender_${value}`),
  }))
  const importanceOptions = (['lead', 'supporting', 'extra'] as const).map((value) => ({
    value, label: t(`roleVoiceImportance_${value}`),
  }))

  return (
    <Modal
      title={
        <h2 className={styles.editorHeading} tabIndex={-1} data-modal-initial-focus>
          {t('roleVoiceEditTitle')}
        </h2>
      }
      className={styles.editor}
      scrollEdgeFeedback
      dismissible={!saving}
      onClose={onClose}
      footer={
        <div className={styles.editorFooter}>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <div className={styles.editorActions}>
            <Button className={styles.editorAction} size="m" variant="outlined" disabled={saving} onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button className={styles.editorAction} size="m" disabled={busy} onClick={() => void save()}>
              {t(saving ? 'roleVoiceSaving' : candidateVoice ? 'roleVoiceSampleSave' : 'roleVoiceSave')}
            </Button>
          </div>
        </div>
      }
    >
      <div className={styles.form}>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={id + '-name'}>{t('roleVoiceName')}</label>
          <input
            id={id + '-name'}
            className={styles.input}
            maxLength={MAX_ROLE_NAME}
            value={name}
            disabled={busy}
            onChange={(event) => {
              stopRewrite()
              setError('')
              setName(event.target.value)
            }}
          />
        </div>

        <section className={styles.voiceEditor}>
          <h3 className={styles.fieldLabel}>{t('roleVoiceVoice')}</h3>
          <div className={styles.voiceRows}>
            {!narrator && (
              <Select
                ariaLabel={t('roleVoiceGender')}
                settingRow="value"
                compactMenu
                value={voiceGender ?? 'auto'}
                options={genderOptions}
                disabled={busy}
                onChange={(choice) => {
                  stopRewrite()
                  stopAudition()
                  const next = choice === 'auto' ? undefined : choice
                  setVoiceGender(next)
                  setPreset((current) => presetForGender(current, next))
                }}
              />
            )}
            {!presetOnly && (
              <Select
                ariaLabel={t('roleVoiceVoiceMode')}
                settingRow="value"
                compactMenu
                value={mode}
                options={[
                  { value: 'preset', label: t('roleVoicePreset') },
                  { value: 'description', label: t('roleVoiceDescriptionShort') },
                ]}
                disabled={busy}
                onChange={(next) => {
                  stopRewrite()
                  stopAudition()
                  setMode(next)
                }}
              />
            )}
            {!useDescription && (
              <Select
                ariaLabel={t('roleVoicePreset')}
                settingRow="value"
                value={preset}
                options={presetOptions}
                disabled={busy}
                onChange={(next) => {
                  stopAudition()
                  setPreset(next)
                }}
              />
            )}
          </div>
          {shared && <p className={styles.hint}>{t('roleVoiceSharedEditHint', { voice: sharedVoice })}</p>}
          {useDescription ? (
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={id + '-description'}>
                {t('roleVoiceDescription')}
              </label>
              <textarea
                id={id + '-description'}
                className={styles.textarea}
                maxLength={MAX_ROLE_TEXT}
                value={description}
                aria-label={t('roleVoiceDescription')}
                readOnly={busy}
                onChange={(event) => {
                  stopRewrite()
                  stopAudition()
                  setDescription(event.target.value)
                }}
              />
              <div className={styles.voiceActions} aria-busy={sampling || rewriting}>
                <Button
                  size="s"
                  variant="outlined"
                  className={styles.voiceAction}
                  disabled={rewriting || busy}
                  onClick={() => void rewrite()}
                >
                  {t(rewriting ? 'roleVoiceRewriting' : 'roleVoiceRewrite')}
                </Button>
                {profile && (
                  <Button
                    size="s"
                    variant="outlined"
                    className={styles.voiceAction}
                    disabled={busy || rewriting || !description.trim()}
                    onClick={() => void generateSample()}
                  >
                    {t(sampling ? 'roleVoiceSampleCreating' : candidateVoice || savedReference
                      ? 'roleVoiceSampleTryAgain' : 'roleVoiceSampleCreate')}
                  </Button>
                )}
              </div>
              {rewriteError && <p className={styles.error} role="alert">{rewriteError}</p>}
              {sampleError && <p className={styles.error} role="alert">{sampleError}</p>}
              {profile && (
                <div className={styles.auditionRow}>
                  <p className={styles.hint}>{t(savedReference && !candidateVoice
                    ? 'roleVoiceSampleSavedHint' : 'roleVoiceSampleHint')}</p>
                  {(candidateVoice || savedReference) && (
                    <Button
                      size="s"
                      variant="outlined"
                      className={styles.voiceAction}
                      disabled={busy}
                      onClick={replaySample}
                    >
                      {auditioning ? <IconStopOutline16 /> : <IconPlayMediaOutline16 />}
                      {t(auditioning ? 'ttsStop' : 'roleVoiceSampleReplay')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ) : onPreview ? (
            <Button
              size="s"
              variant="outlined"
              className={styles.voiceAction}
              disabled={busy}
              onClick={previewPreset}
            >
              {auditioning ? <IconStopOutline16 /> : <IconPlayMediaOutline16 />}
              {t(auditioning ? 'ttsStop' : 'roleVoiceAudition')}
            </Button>
          ) : null}
        </section>

        <SettingsDisclosure title={t('roleVoiceDetails')} settingRow>
          <div className={styles.roleDetails}>
            <Select
              ariaLabel={t('roleVoiceImportance')}
              settingRow="value"
              compactMenu
              value={importance}
              options={importanceOptions}
              disabled={busy}
              onChange={(level) => {
                stopRewrite()
                stopAudition()
                setImportance(level)
              }}
            />
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={id + '-alias'}>{t('roleVoiceAliases')}</label>
              {aliases.length > 0 && (
                <div className={styles.aliasRow}>
                  {aliases.map((alias) => (
                    <button
                      key={alias}
                      type="button"
                      className={styles.alias}
                      aria-label={t('roleVoiceRemoveAlias', { name: alias })}
                      disabled={busy}
                      onClick={() => {
                        stopRewrite()
                        setAliases(aliases.filter((item) => item !== alias))
                      }}
                    >
                      <span>{alias}</span>
                      <IconCloseOutline16 />
                    </button>
                  ))}
                </div>
              )}
              <input
                id={id + '-alias'}
                className={styles.aliasInput}
                maxLength={MAX_ROLE_NAME}
                value={aliasDraft}
                aria-label={t('roleVoiceAddAlias')}
                placeholder={t('roleVoiceAddAlias')}
                disabled={busy}
                onChange={(event) => {
                  stopRewrite()
                  setAliasDraft(event.target.value)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    addAlias()
                  }
                }}
                onBlur={addAlias}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={id + '-nature'}>{t('roleVoiceNature')}</label>
              <textarea
                id={id + '-nature'}
                className={styles.textarea}
                maxLength={MAX_ROLE_TEXT}
                value={nature}
                readOnly={busy}
                onChange={(event) => {
                  stopRewrite()
                  setNature(event.target.value)
                }}
              />
              <p className={styles.hint}>{t('roleVoiceNatureHint')}</p>
            </div>
          </div>
        </SettingsDisclosure>
      </div>
    </Modal>
  )
}
