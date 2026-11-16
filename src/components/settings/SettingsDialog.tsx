import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Capacitor } from '@capacitor/core'
import { App as CapacitorApp } from '@capacitor/app'
import logo from '../../assets/logo.png'
import { LICENSE_TEXT } from '../../assets/licenseText.js'
import {
  IconCheckOutline16,
  IconChevronLeftOutline16,
  IconChevronRightOutline14,
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconEyeOffOutline16,
  IconEyeOutline16,
  IconFollowsystemOutline16,
  IconGlobeLanguageOutline14,
  IconInfoOutline16,
  IconLightOutline16,
  IconLinkOutline16,
  IconPlayMediaOutline16,
  IconTextSizeOutline16,
  IconTrashOutline16,
  IconUploadOutline14,
  IconUserOutline16,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
} from '../../services/chat/backup.js'
import { useChatStore } from '../../services/chat/store.js'
import {
  setApiKey,
  setFontScale,
  setLocale,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { hasOpenModal, closeTopModal, Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { useApiKeyEditor } from './ApiKeyField.js'
import { UsageContent } from '../usage/UsagePanel.js'
import { PricingForm } from '../usage/PricingForm.js'
import { collectUsage, todayKey } from '../../services/usage.js'
import { openExternal } from '../../utils/openExternal.js'
import {
  closeSettings,
  useSettingsDialog,
  type SettingsPageId,
} from './settingsDialogState.js'
import styles from './Settings.module.css'

/** 构建期注入的应用版本（rspack HtmlRspackPlugin 的 application-version meta） */
const APP_VERSION =
  document.querySelector('meta[name="application-version"]')?.getAttribute('content') ?? '—'

/** DeepSeek 开放平台：申请与管理 API Key（唯一的必要外链） */
const PLATFORM_URL = 'https://platform.deepseek.com/'

const PAGE_TITLES: Record<SettingsPageId, TranslationKey> = {
  home: 'settings',
  account: 'settingsApiService',
  appearance: 'avatarMenuSettingsDialogThemeItemLabel',
  font: 'settingsFontSize',
  language: 'settingsLocalePreference',
  voice: 'settingsTtsVoice',
  data: 'settingsDataManage',
  usage: 'usageTitle',
  usagePricing: 'usagePricingTitle',
  about: 'settingsAboutApp',
}

/**
 * 设置：一级目录 + 二级页面（路由栈）。
 * 移动端为全屏页面、桌面端为居中卡片；所有行共用一套行组件与触控尺寸。
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsRoot /> : null
}

const SettingsRoot = () => {
  const t = useTranslate()
  const [stack, setStack] = useState<SettingsPageId[]>(() => {
    const initial = useSettingsDialog.getState().page
    return initial === 'home' ? ['home'] : ['home', initial]
  })
  const page = stack[stack.length - 1] ?? 'home'
  const push = (next: SettingsPageId) => setStack((previous) => [...previous, next])
  const back = () => {
    if (stack.length > 1) {
      setStack((previous) => previous.slice(0, -1))
    } else {
      closeSettings()
    }
  }

  // Android 返回键：确认弹窗 → 上一级设置页 → 关闭设置；由设置页自身处理，避免退出 App
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      return
    }
    const subscription = CapacitorApp.addListener('backButton', () => {
      if (hasOpenModal() && closeTopModal()) {
        return
      }
      if (stack.length > 1) {
        setStack((previous) => previous.slice(0, -1))
        return
      }
      closeSettings()
    })
    return () => {
      void subscription.then((handle) => handle.remove())
    }
  }, [stack.length])

  // 跨页面共享的表单与数据操作状态，切换二级页面不丢失输入
  const apiKeyEditor = useApiKeyEditor()
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory

  // Esc 关闭设置页；确认弹窗打开时交给弹窗自己处理
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !hasOpenModal()) {
        closeSettings()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <>
      <div className={styles.scrim} aria-hidden="true" />
      <div
        className={styles.page}
        role="dialog"
        aria-modal="true"
        aria-label={t(PAGE_TITLES[page])}
      >
        <div className={styles.header}>
          <button
            type="button"
            className={styles.back}
            aria-label={stack.length > 1 ? t('back') : t('close')}
            onClick={back}
          >
            <IconChevronLeftOutline16 />
          </button>
          <div className={styles.title}>{t(PAGE_TITLES[page])}</div>
          <span className={styles.backPlaceholder} />
        </div>
        <div className={styles.scroll}>
          <div key={page} className={styles.pageBody}>
            {page === 'home' ? <HomePage push={push} /> : null}
            {page === 'account' ? <AccountPage editor={apiKeyEditor} /> : null}
            {page === 'appearance' ? <AppearancePage /> : null}
            {page === 'font' ? <FontPage /> : null}
            {page === 'language' ? <LanguagePage /> : null}
            {page === 'voice' ? <VoicePage /> : null}
            {page === 'data' ? (
              <DataPage
                historyImport={historyImport}
                historyDelete={historyDelete}
                disabled={historyBusy}
              />
            ) : null}
            {page === 'usage' ? <UsageContent onOpenPricing={() => push('usagePricing')} /> : null}
            {page === 'usagePricing' ? <PricingForm /> : null}
            {page === 'about' ? <AboutPage /> : null}
          </div>
        </div>
      </div>
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </>
  )
}

/** 一级目录：只放导航行，不放输入框与操作按钮 */
const HomePage = ({ push }: { push: (page: SettingsPageId) => void }) => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey)
  const theme = useSettings((state) => state.themePreference)
  const locale = useSettings((state) => state.locale)
  const ttsVoice = useSettings((state) => state.ttsVoice)
  const fontScale = useSettings((state) => state.fontScale)
  const sessionCount = useChatStore((state) => state.sessions.length)
  const fontLabel =
    fontScale < 0.95
      ? t('fontSmall')
      : fontScale < 1.05
        ? t('fontDefault')
        : fontScale < 1.15
          ? t('fontLarge')
          : t('fontExtraLarge')
  // 设置首页直接显示今日用量摘要，证明统计确实生效
  const [usageValue, setUsageValue] = useState<string | undefined>()
  useEffect(() => {
    let alive = true
    collectUsage()
      .then((stats) => {
        if (!alive) {
          return
        }
        const today = stats.days.find((day) => day.date === todayKey())
        if (!today || today.requests === 0) {
          return
        }
        const tokens = today.cacheReadTokens + today.cacheMissTokens + today.outputTokens
        const cost =
          today.costCny >= 0.01 ? `¥${today.costCny.toFixed(2)}` : `¥${today.costCny.toFixed(4)}`
        setUsageValue(`${cost} · ${tokens.toLocaleString()} tok`)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  const themeLabel =
    theme === 'light' ? t('themeLight') : theme === 'dark' ? t('themeDark') : t('themeSystem')
  const localeLabel =
    locale === 'zh-CN' ? t('settingsLocaleZhCN') : t('settingsLocaleEnUS')
  const voiceLabel =
    ttsVoice === 'stella' ? t('settingsTtsVoiceStella') : t('settingsTtsVoiceTide')
  return (
    <>
      <Section title={t('settingsSectionAccount')}>
        <Row
          icon={<IconUserOutline16 />}
          label={t('settingsApiService')}
          value={apiKey ? t('settingsApiKeyConfigured') : t('settingsApiKeyMissing')}
          onClick={() => push('account')}
        />
      </Section>
      <Section title={t('settingsSectionApp')}>
        <Row
          icon={<IconLightOutline16 />}
          label={t('avatarMenuSettingsDialogThemeItemLabel')}
          value={themeLabel}
          onClick={() => push('appearance')}
        />
        <Row
          icon={<IconTextSizeOutline16 />}
          label={t('settingsFontSize')}
          value={fontLabel}
          onClick={() => push('font')}
        />
        <Row
          icon={<IconGlobeLanguageOutline14 />}
          label={t('settingsLocalePreference')}
          value={localeLabel}
          onClick={() => push('language')}
        />
        <Row
          icon={<IconPlayMediaOutline16 />}
          label={t('settingsTtsVoice')}
          value={voiceLabel}
          onClick={() => push('voice')}
        />
      </Section>
      <Section title={t('settingsSectionUsage')}>
        <Row
          icon={<IconDataOutline16 />}
          label={t('usageTitle')}
          value={usageValue}
          onClick={() => push('usage')}
        />
      </Section>
      <Section title={t('settingsSectionData')}>
        <Row
          icon={<IconDataOutline16 />}
          label={t('settingsDataManage')}
          value={
            sessionCount > 0 ? t('settingsSessionsCount', { count: sessionCount }) : undefined
          }
          onClick={() => push('data')}
        />
      </Section>
      <Section title={t('settingsSectionAbout')}>
        <Row
          icon={<IconInfoOutline16 />}
          label={t('settingsAboutApp')}
          value={APP_VERSION}
          onClick={() => push('about')}
        />
      </Section>
    </>
  )
}

/** 二级页：API 服务 */
const AccountPage = ({ editor }: { editor: ReturnType<typeof useApiKeyEditor> }) => {
  const t = useTranslate()
  const { apiKey, editing, setEditing, form, showInput } = editor
  const [showKey, setShowKey] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  return (
    <>
      <Section>
        <div className={styles.accountBlock}>
          <div className={styles.accountStatus}>
            <span className={styles.accountStatusLabel}>{t('settingsApiKey')}</span>
            <span
              className={clsx(styles.accountStatusValue, apiKey && styles.accountStatusOk)}
            >
              {apiKey && !editing ? t('settingsApiKeyConfigured') : t('settingsApiKeyMissing')}
            </span>
          </div>
          {apiKey && !editing ? (
            <div className={styles.maskRow}>
              <span className={styles.keyMask}>{maskKey(apiKey)}</span>
              <button type="button" className={styles.textButton} onClick={() => setEditing(true)}>
                {t('changeApiKey')}
              </button>
            </div>
          ) : null}
          {showInput ? (
            <div className={styles.apiKeyEditor}>
              <div className={styles.apiKeyField}>
                <input
                  className={styles.apiKeyInput}
                  type={showKey ? 'text' : 'password'}
                  placeholder={t('apiKeyPlaceholder')}
                  autoComplete="off"
                  spellCheck={false}
                  value={form.value}
                  onChange={(event) => form.setValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      void form.submit()
                    }
                  }}
                />
                <button
                  type="button"
                  className={styles.eyeButton}
                  aria-label={showKey ? t('settingsApiKeyHide') : t('settingsApiKeyShow')}
                  onClick={() => setShowKey((value) => !value)}
                >
                  {showKey ? <IconEyeOffOutline16 /> : <IconEyeOutline16 />}
                </button>
              </div>
              <button
                type="button"
                className={styles.confirm}
                disabled={form.verifying || !form.value.trim()}
                onClick={() => void form.submit()}
              >
                {form.verifying ? t('apiKeyVerifying') : t('confirm')}
              </button>
            </div>
          ) : null}
          {showInput && form.error ? <div className={styles.error}>{form.error}</div> : null}
          <div className={styles.hint}>{t('settingsApiKeyHint')}</div>
        </div>
      </Section>
      {apiKey && !editing ? (
        <Section>
          <Row
            icon={<IconTrashOutline16 />}
            label={t('settingsApiKeyClear')}
            danger
            onClick={() => setClearOpen(true)}
          />
        </Section>
      ) : null}
      <Section title={t('settingsApiService')}>
        <Row label={t('settingsApiModelLabel')} value="deepseek-flash" />
        <Row label={t('settingsApiBillingLabel')} value={t('settingsApiBillingValue')} />
        <Row
          icon={<IconLinkOutline16 />}
          label={t('settingsLoginOfficial')}
          onClick={() => void openExternal(PLATFORM_URL)}
        />
      </Section>
      <p className={styles.paragraph}>{t('settingsLoginOfficialHint')}</p>
      {clearOpen ? (
        <Modal
          title={t('settingsApiKeyClear')}
          centered
          onClose={() => setClearOpen(false)}
          footer={
            <>
              <Button variant="outlined" autoFocus onClick={() => setClearOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setApiKey(null)
                  setEditing(false)
                  setClearOpen(false)
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
      ) : null}
    </>
  )
}

/** API Key 掩码：保留首尾便于辨认 */
const maskKey = (key: string) =>
  key.length <= 10 ? '••••••' : `${key.slice(0, 4)}••••${key.slice(-4)}`

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/** 二级页：外观 */
const AppearancePage = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  return (
    <Section>
      {themeOptions.map((option) => (
        <ChoiceRow
          key={option.value}
          icon={option.icon}
          label={t(option.label)}
          selected={themePreference === option.value}
          onSelect={() => setThemePreference(option.value)}
        />
      ))}
    </Section>
  )
}

/** 二级页：字体大小 */
const fontOptions: { value: number; label: TranslationKey }[] = [
  { value: 0.9, label: 'fontSmall' },
  { value: 1, label: 'fontDefault' },
  { value: 1.1, label: 'fontLarge' },
  { value: 1.2, label: 'fontExtraLarge' },
]

const FontPage = () => {
  const t = useTranslate()
  const fontScale = useSettings((state) => state.fontScale)
  return (
    <>
      <Section>
        {fontOptions.map((option) => (
          <ChoiceRow
            key={option.value}
            icon={<IconTextSizeOutline16 />}
            label={t(option.label)}
            selected={Math.abs(fontScale - option.value) < 0.001}
            onSelect={() => setFontScale(option.value)}
          />
        ))}
      </Section>
      <div className={styles.fontPreview}>{t('settingsFontPreview')}</div>
      <div className={styles.hint}>{t('settingsFontSizeHint')}</div>
      <div className={styles.hint}>{t('settingsFontAttribution')}</div>
    </>
  )
}

/** 二级页：语言 */
const LanguagePage = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <Section>
      <ChoiceRow
        icon={<IconGlobeLanguageOutline14 />}
        label={t('settingsLocaleZhCN')}
        selected={locale === 'zh-CN'}
        onSelect={() => setLocale('zh-CN')}
      />
      <ChoiceRow
        icon={<IconGlobeLanguageOutline14 />}
        label={t('settingsLocaleEnUS')}
        selected={locale === 'en-US'}
        onSelect={() => setLocale('en-US')}
      />
    </Section>
  )
}

/** 二级页：语音 */
const VoicePage = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <>
      <Section>
        <ChoiceRow
          label={t('settingsTtsVoiceStella')}
          selected={ttsVoice === 'stella'}
          onSelect={() => setTtsVoice('stella')}
        />
        <ChoiceRow
          label={t('settingsTtsVoiceTide')}
          selected={ttsVoice === 'tide'}
          onSelect={() => setTtsVoice('tide')}
        />
      </Section>
      <div className={styles.hint}>{t('settingsVoiceHint')}</div>
    </>
  )
}

/** 二级页：数据管理 */
const DataPage = ({
  historyImport,
  historyDelete,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  historyDelete: ReturnType<typeof useHistoryDelete>
  disabled: boolean
}) => {
  const t = useTranslate()
  return (
    <>
      <Section>
        <ImportHistory historyImport={historyImport} disabled={disabled} />
        <ExportHistory disabled={disabled} />
      </Section>
      <Section title={t('deleteAllSessions')}>
        <DeleteAllSetting historyDelete={historyDelete} disabled={disabled} />
      </Section>
    </>
  )
}

/** 二级页：关于（完全本地，不跳转私有仓库） */
const AboutPage = () => {
  const t = useTranslate()
  const [licenseOpen, setLicenseOpen] = useState(false)
  return (
    <>
      <div className={styles.brandBlock}>
        <img className={styles.brandLogo} src={logo} alt="" draggable={false} />
        <div className={styles.brandName}>FreeSeek</div>
        <div className={styles.brandVersion}>
          {t('settingsVersion')} {APP_VERSION}
        </div>
      </div>
      <Section title={t('settingsPrivacyTitle')}>
        <p className={styles.paragraph}>{t('settingsPrivacyText')}</p>
      </Section>
      <Section title={t('settingsUpstreamTitle')}>
        <p className={styles.paragraph}>{t('settingsUpstreamText')}</p>
      </Section>
      <Section title={t('settingsFontSize')}>
        <p className={styles.paragraph}>{t('settingsFontAttribution')}</p>
      </Section>
      <Section title={t('settingsLicense')}>
        <Row label={t('settingsLicenseTextTitle')} onClick={() => setLicenseOpen(true)} />
      </Section>
      {licenseOpen ? (
        <Modal
          title={t('settingsLicenseTextTitle')}
          closable
          centered
          onClose={() => setLicenseOpen(false)}
        >
          <pre className={styles.licenseText}>{LICENSE_TEXT}</pre>
        </Modal>
      ) : null}
      <div className={styles.footer}>FreeSeek</div>
    </>
  )
}

/** 分组：可选标题 + 卡片 */
const Section = ({ title, children }: { title?: string; children: ReactNode }) => (
  <section className={styles.section}>
    {title ? <div className={styles.sectionTitle}>{title}</div> : null}
    <div className={styles.card}>{children}</div>
  </section>
)

/** 导航行：图标 + 标题 + 右侧值/箭头 */
const Row = ({
  icon,
  label,
  value,
  href,
  onClick,
  danger,
}: {
  icon?: ReactNode
  label: string
  value?: string
  href?: string
  onClick?: () => void
  danger?: boolean
}) => {
  const content = (
    <>
      {icon ? <span className={styles.rowIcon}>{icon}</span> : null}
      <span className={clsx(styles.rowLabel, danger && styles.rowDanger)}>{label}</span>
      {value !== undefined ? <span className={styles.rowValue}>{value}</span> : null}
      <span className={styles.rowChevron}>
        <IconChevronRightOutline14 />
      </span>
    </>
  )
  if (href) {
    return (
      <a className={clsx(styles.row, styles.rowInteractive)} href={href} target="_blank" rel="noreferrer">
        {content}
      </a>
    )
  }
  if (onClick) {
    return (
      <button type="button" className={clsx(styles.row, styles.rowInteractive)} onClick={onClick}>
        {content}
      </button>
    )
  }
  return <div className={styles.row}>{content}</div>
}

/** 选项行：单选项，右侧对勾 */
const ChoiceRow = ({
  icon,
  label,
  selected,
  onSelect,
}: {
  icon?: ReactNode
  label: string
  selected: boolean
  onSelect: () => void
}) => (
  <button
    type="button"
    role="radio"
    aria-checked={selected}
    className={clsx(styles.row, styles.rowInteractive, selected && styles.choiceActive)}
    onClick={onSelect}
  >
    {icon ? <span className={styles.rowIcon}>{icon}</span> : null}
    <span className={styles.rowLabel}>{label}</span>
    <span className={styles.choiceCheck}>{selected ? <IconCheckOutline16 /> : null}</span>
  </button>
)

/** 删除确认：危险操作使用居中弹窗，而不是底部 Sheet */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      centered
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

/** 删除全部对话：危险行 */
const DeleteAllSetting = ({
  historyDelete,
  disabled,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
  disabled: boolean
}) => {
  const t = useTranslate()
  return (
    <Row
      icon={<IconTrashOutline16 />}
      label={t('deleteAllSessions')}
      danger
      onClick={disabled ? undefined : historyDelete.open}
    />
  )
}

/** 覆盖导入的二次确认 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      centered
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="dangerOutlined" size="m" onClick={() => void historyImport.confirm()}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
    </Modal>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const statusText = (t: ReturnType<typeof useTranslate>, status: Status): string =>
  status
    ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
    : ''

/** 选文件后先提示覆盖；确认后才检查文件并执行导入，任何错误都提示导入失败。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const importing = useRef(false)

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setFile(null)
    setBusy(true)
    setStatus(null)
    try {
      const count = await importHistory(file)
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
    } catch {
      setStatus({ key: 'historyImportFailed', error: true })
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  return { file, busy, status, select: setFile, cancel: () => setFile(null), confirm }
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div>
      <Row
        icon={<IconUploadOutline14 />}
        label={t('historyImport')}
        onClick={() => {
          if (!disabled) {
            inputRef.current?.click()
          }
        }}
      />
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) {
            historyImport.select(file)
          }
        }}
      />
      {historyImport.status ? (
        <div className={clsx(styles.rowNote, historyImport.status.error && styles.errorNote)}>
          {statusText(t, historyImport.status)}
        </div>
      ) : null}
    </div>
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    if (disabled || busy || empty) {
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Row
        icon={<IconDownloadOutline16 />}
        label={t('exportAllLabel')}
        onClick={() => void onExport()}
      />
      {status ? (
        <div className={clsx(styles.rowNote, styles.errorNote)}>{statusText(t, status)}</div>
      ) : null}
    </div>
  )
}
