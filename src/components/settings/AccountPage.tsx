import { useId, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { modelLabel, OFFICIAL_MODELS, selectModel, useProviders } from '../../services/providers.js'
import { closeMobileSider } from '../sider/mobileSiderState.js'
import { closeSettings } from './settingsDialogState.js'
import { setApiKey, useSettings } from '../../services/settings.js'
import { openExternal } from '../../utils/openExternal.js'
import { Button } from '../base/Button.js'
import {
  IconBookOutline16,
  IconCheckOutline16,
  IconEyeOffOutline16,
  IconEyeOutline16,
  IconRightUpOutline14,
  IconSettingsOutline16,
} from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { ConnectionSelector } from './ProviderSettings.js'
import { SettingsDisclosure } from './SettingsDisclosure.js'
import { Row, Section } from './SettingsRows.js'
import { useApiKeyForm } from './useApiKeyForm.js'
import { useSettingsLeave } from './useSettingsLeave.js'
import styles from './Settings.module.css'

const steps: TranslationKey[] = [
  'settingsApiStep1',
  'settingsApiStep2',
  'settingsApiStep3',
  'settingsApiStep4',
]
const links = [
  ['apiCreateKey', 'settingsApiOpenKeys', 'https://platform.deepseek.com/api_keys'],
  ['apiTopUp', 'settingsApiOpenTopup', 'https://platform.deepseek.com/top_up'],
  ['apiBalance', 'settingsApiOpenBalance', 'https://platform.deepseek.com/usage'],
] as const

const ApiTutorial = ({ open, toggle }: { open: boolean; toggle: () => void }) => {
  const t = useTranslate()
  return (
    <SettingsDisclosure
      guide
      testId="api-tutorial"
      title={t('settingsApiTutorialTitle')}
      icon={<IconBookOutline16 />}
      open={open}
      onToggle={toggle}
    >
      <ol className={styles.tutorialSteps}>
        {steps.map((step, i) => (
          <li className={styles.tutorialStep} key={step}>
            <span className={styles.tutorialBadge} aria-hidden>
              {i + 1}
            </span>
            <span>{t(step)}</span>
          </li>
        ))}
      </ol>
      <div className={styles.tutorialActions}>
        {links.map(([short, label, url]) => (
          <button
            key={url}
            className={styles.tutorialButton}
            type="button"
            aria-label={t(label)}
            onClick={() => void openExternal(url)}
          >
            {t(short)}
            <IconRightUpOutline14 />
          </button>
        ))}
      </div>
      <p className={styles.tutorialHint}>{t('settingsApiTutorialHint')}</p>
    </SettingsDisclosure>
  )
}

export const AccountPage = ({
  guideOpen,
  toggleGuide,
  openAdvanced,
}: {
  guideOpen: boolean
  toggleGuide: () => void
  openAdvanced: () => void
}) => {
  const t = useTranslate(),
    id = useId()
  const apiKey = useSettings((s) => s.apiKey)
  const [editing, setEditing] = useState(false),
    [visible, setVisible] = useState(false),
    [clearing, setClearing] = useState(false)
  const [ready, setReady] = useState(false)
  const customName = useProviders(({ profiles, selection }) =>
    selection.providerId === 'deepseek'
      ? null
      : (profiles.find((p) => p.id === selection.providerId)?.name ?? selection.model)
  )
  const goChat = () => {
    if (customName !== null) {
      try {
        selectModel({ providerId: 'deepseek', model: OFFICIAL_MODELS[0] })
      } catch {
        showToast({ key: 'providerErrorStorage', type: 'error' })
        return
      }
    }
    setReady(false)
    closeSettings()
    closeMobileSider()
  }
  const form = useApiKeyForm(() => {
    setEditing(false)
    setVisible(false)
    setReady(true)
  })
  const leave = useSettingsLeave(Boolean(form.value.trim()))
  const cancelEdit = () => {
    form.setValue('')
    setEditing(false)
    setVisible(false)
  }
  return (
    <>
      <ApiTutorial open={guideOpen} toggle={toggleGuide} />
      <Section title={t('providerOfficial')}>
        <div className={styles.accountBlock}>
          <div className={styles.accountStatus}>
            <label className={styles.accountStatusLabel} htmlFor={id}>
              {t('settingsApiKey')}
            </label>
            <span className={styles.accountStatusValue} data-configured={Boolean(apiKey)}>
              {t(apiKey ? 'settingsApiKeyConfigured' : 'settingsApiKeyMissing')}
            </span>
          </div>
          {apiKey && !editing ? (
            <div className={styles.maskRow}>
              <span className={styles.keyMask}>
                {apiKey.length > 10 ? apiKey.slice(0, 4) + '••••' + apiKey.slice(-4) : '••••••'}
              </span>
              <button type="button" className={styles.textButton} onClick={() => setEditing(true)}>
                {t('changeApiKey')}
              </button>
              <button
                type="button"
                className={styles.quietAction}
                onClick={() => setClearing(true)}
              >
                {t('settingsApiKeyClear')}
              </button>
            </div>
          ) : (
            <form
              className={styles.apiKeyEditor}
              onSubmit={(event) => {
                event.preventDefault()
                void form.submit()
              }}
            >
              <div className={styles.apiKeyField}>
                <input
                  id={id}
                  className={styles.apiKeyInput}
                  type={visible ? 'text' : 'password'}
                  placeholder={t('apiKeyPlaceholder')}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={form.value}
                  readOnly={form.verifying}
                  aria-invalid={!!form.error}
                  aria-describedby={form.error ? id + '-error' : undefined}
                  onChange={(event) => form.setValue(event.target.value)}
                />
                <button
                  type="button"
                  className={styles.eyeButton}
                  aria-pressed={visible}
                  aria-label={t(visible ? 'settingsApiKeyHide' : 'settingsApiKeyShow')}
                  onClick={() => setVisible((v) => !v)}
                >
                  {visible ? <IconEyeOffOutline16 /> : <IconEyeOutline16 />}
                </button>
              </div>
              {form.error && (
                <p id={id + '-error'} role="alert" className={styles.error}>
                  {form.error}
                </p>
              )}
              <div className={styles.keyActions}>
                {apiKey && (
                  <Button variant="outlined" disabled={form.verifying} onClick={cancelEdit}>
                    {t('cancel')}
                  </Button>
                )}
                <button
                  className={styles.confirm}
                  type="submit"
                  disabled={form.verifying || !form.value.trim()}
                >
                  {t(form.verifying ? 'apiKeyVerifying' : 'settingsVerifySave')}
                </button>
              </div>
            </form>
          )}
          <p className={styles.fieldHint}>{t('settingsApiKeyHint')}</p>
        </div>
      </Section>
      <Section title={t('providerDefaultModel')}>
        <div className={styles.accountBlock}>
          <ConnectionSelector />
        </div>
      </Section>
      <Section title={t('settingsAdvancedGroup')}>
        <Row
          label={t('providerAdvanced')}
          description={t('settingsAdvancedHint')}
          icon={<IconSettingsOutline16 />}
          target="providers"
          onClick={openAdvanced}
        />
      </Section>
      {leave.dialog}
      {ready && (
        <Modal
          centered
          title={
            <span className={styles.readyTitle}>
              <span aria-hidden="true">
                <IconCheckOutline16 />
              </span>
              {t('officialReadyTitle')}
            </span>
          }
          onClose={() => setReady(false)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setReady(false)}>
                {t('officialStayInSettings')}
              </Button>
              <Button onClick={goChat}>
                {t(customName === null ? 'officialStartChat' : 'officialSwitchAndChat')}
              </Button>
            </>
          }
        >
          <p className={styles.readyMessage}>
            {t(customName === null ? 'officialReadyMessage' : 'officialReadyCustomMessage', {
              service: customName ?? '',
              model: modelLabel(OFFICIAL_MODELS[0]),
            })}
          </p>
          <p className={styles.readyHint}>{t('officialReadyAdvancedHint')}</p>
        </Modal>
      )}
      {clearing && (
        <Modal
          centered
          title={t('settingsApiKeyClear')}
          onClose={() => setClearing(false)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setClearing(false)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setApiKey(null)
                  cancelEdit()
                  setClearing(false)
                  showToast({ key: 'apiKeyCleared' })
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('settingsApiKeyClearConfirm')}
        </Modal>
      )}
    </>
  )
}
