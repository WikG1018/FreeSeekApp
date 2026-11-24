import { useId, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { MIMO_PRESET_VOICES, type MiMoPresetVoice, type RoleImportance, type VoiceRole } from '../../services/speech/roleMarkers.js'
import { regenerateVoiceDescription } from '../../services/speech/roleVoiceGenerate.js'
import styles from './RoleVoice.module.css'

/**
 * 编辑一个角色的声音。用户改的是「不含语气的部分」：音色、别名、性格底色、重要性。
 * 语气不在这里——由模型每段临场演绎，界面上注明。
 */
export const RoleVoiceDialog = ({
  role,
  extraVoice,
  onSave,
  onPreview,
  onClose,
}: {
  role: VoiceRole
  /** 设置里配的路人共用音色：改成「路人」时要切到它 */
  extraVoice: MiMoPresetVoice
  onSave: (next: VoiceRole) => void
  onPreview: (role: VoiceRole) => void
  onClose: () => void
}) => {
  const t = useTranslate()
  const nameId = useId()
  const natureId = useId()
  const descriptionId = useId()
  const [name, setName] = useState(role.name)
  const [aliases, setAliases] = useState<string[]>(role.aliases)
  const [aliasDraft, setAliasDraft] = useState('')
  const [importance, setImportance] = useState<RoleImportance>(role.importance)
  const [mode, setMode] = useState<'preset' | 'description'>(
    role.description && !role.preset ? 'description' : 'preset'
  )
  const [preset, setPreset] = useState<MiMoPresetVoice>(role.preset ?? '白桦')
  const [description, setDescription] = useState(role.description ?? '')
  const [nature, setNature] = useState(role.nature)
  const [error, setError] = useState<string | null>(null)
  const [rewriting, setRewriting] = useState(false)

  // 路人只能用预置音色：解析器和提示词都按这个约束走
  const isExtra = importance === 'extra'
  const effectiveMode = isExtra ? 'preset' : mode
  // 改成路人时跟着切到路人共用音色，否则面板里显示的音色和实际听到的不一致
  const changeImportance = (level: RoleImportance) => {
    setImportance(level)
    if (level === 'extra') {
      setMode('preset')
      setPreset(extraVoice)
    }
  }

  const addAlias = () => {    const next = aliasDraft.trim()
    if (!next || aliases.includes(next) || next === name.trim()) {
      setAliasDraft('')
      return
    }
    setAliases([...aliases, next])
    setAliasDraft('')
  }

  /** 让模型重写音色描述；结果填进输入框，用户还能接着改 */
  const rewrite = async () => {
    setRewriting(true)
    setError(null)
    const controller = new AbortController()
    try {
      const next = await regenerateVoiceDescription(
        { name: name.trim() || role.name, nature, aliases, importance },
        controller.signal
      )
      setDescription(next)
      setMode('description')
    } catch {
      setError(t('roleVoiceRewriteFailed'))
    } finally {
      setRewriting(false)
    }
  }

  const build = (): VoiceRole => ({
    ...role,
    name: name.trim() || role.name,
    aliases,
    nature: nature.trim(),
    importance,
    source: 'user',
    ...(effectiveMode === 'preset'
      ? { preset, description: undefined }
      : { description: description.trim(), preset: undefined }),
  })

  const save = () => {
    if (!name.trim()) {
      setError(t('roleVoiceNameRequired'))
      return
    }
    if (effectiveMode === 'description' && !description.trim()) {
      setError(t('roleVoiceDescriptionRequired'))
      return
    }
    onSave(build())
    onPreview(build())
  }

  return (
    <Modal
      title={t('roleVoiceEditTitle')}
      centered
      onClose={onClose}
      footer={
        <>
          <Button variant="outlined" onClick={onClose}>
            {t('roleVoiceCancel')}
          </Button>
          <Button onClick={save}>{t('roleVoiceSaveAndPreview')}</Button>
        </>
      }
    >
      <div className={styles.form}>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={nameId}>
            {t('roleVoiceName')}
          </label>
          <input
            id={nameId}
            className={styles.input}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t('roleVoiceAliases')}</span>
          <div className={styles.aliasRow}>
            {aliases.map((alias) => (
              <button
                key={alias}
                type="button"
                className={styles.alias}
                aria-label={t('roleVoiceRemoveAlias', { name: alias })}
                onClick={() => setAliases(aliases.filter((item) => item !== alias))}
              >
                {alias}
                <span aria-hidden>×</span>
              </button>
            ))}
            <input
              className={styles.input}
              style={{ width: 96 }}
              value={aliasDraft}
              aria-label={t('roleVoiceAddAlias')}
              placeholder={t('roleVoiceAddAlias')}
              onChange={(event) => setAliasDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addAlias()
                }
              }}
              onBlur={addAlias}
            />
          </div>
        </div>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t('roleVoiceImportance')}</span>
          <div className={styles.choices} role="radiogroup" aria-label={t('roleVoiceImportance')}>
            {(['lead', 'supporting', 'extra'] as const).map((level) => (
              <label key={level} className={styles.choice}>
                <input
                  type="radio"
                  name={`importance-${role.id}`}
                  checked={importance === level}
                  onChange={() => changeImportance(level)}
                />
                <span className={styles.choiceName}>{t(`roleVoiceImportance_${level}`)}</span>
              </label>
            ))}
          </div>
        </div>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t('roleVoiceVoice')}</span>
          {!isExtra && (
            <div className={styles.choices} role="radiogroup" aria-label={t('roleVoiceVoice')}>
              <label className={styles.choice}>
                <input
                  type="radio"
                  name={`mode-${role.id}`}
                  checked={mode === 'preset'}
                  onChange={() => setMode('preset')}
                />
                <span className={styles.choiceName}>{t('settingsRoleVoiceLeadPreset')}</span>
              </label>
              <label className={styles.choice}>
                <input
                  type="radio"
                  name={`mode-${role.id}`}
                  checked={mode === 'description'}
                  onChange={() => setMode('description')}
                />
                <span className={styles.choiceName}>{t('settingsRoleVoiceLeadDescription')}</span>
              </label>
            </div>
          )}
          {effectiveMode === 'preset' ? (
            <div className={styles.choices} role="radiogroup" aria-label={t('roleVoicePreset')}>
              {MIMO_PRESET_VOICES.map((voice) => (
                <label key={voice.id} className={styles.choice}>
                  <input
                    type="radio"
                    name={`preset-${role.id}`}
                    checked={preset === voice.id}
                    onChange={() => setPreset(voice.id)}
                  />
                  <span className={styles.choiceName}>{voice.id}</span>
                  <span className={styles.choiceMeta}>{voice.label}</span>
                </label>
              ))}
            </div>
          ) : (
            <>
              <textarea
                id={descriptionId}
                className={styles.textarea}
                value={description}
                aria-label={t('roleVoiceDescription')}
                onChange={(event) => setDescription(event.target.value)}
              />
              <div className={styles.rewriteRow}>
                <button
                  type="button"
                  className={styles.rewrite}
                  disabled={rewriting}
                  onClick={() => void rewrite()}
                >
                  {rewriting ? t('roleVoiceRewriting') : t('roleVoiceRewrite')}
                </button>
                <span className={styles.hint}>{t('roleVoiceRewriteHint')}</span>
              </div>
              <p className={styles.hint}>{t('settingsRoleVoiceLeadHint')}</p>
            </>
          )}
          {isExtra && <p className={styles.hint}>{t('roleVoiceExtraHint')}</p>}
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={natureId}>
            {t('roleVoiceNature')}
          </label>
          <textarea
            id={natureId}
            className={styles.textarea}
            value={nature}
            onChange={(event) => setNature(event.target.value)}
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
