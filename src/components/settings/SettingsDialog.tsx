import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconChevronLeftOutline16,
  IconChevronRightOutline14,
  IconDarkOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconGlobeLanguageOutline14,
  IconInfoOutline16,
  IconLightOutline16,
  IconLinkOutline16,
  IconPlayMediaOutline16,
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
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  isChineseBrowser,
  setLocale,
  setLocation,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { hasOpenModal, Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { useApiKeyEditor } from './ApiKeyField.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import styles from './Settings.module.css'

const REPO_URL = 'https://github.com/WikG1018/freeseek'
const CHANGELOG_URL = `${REPO_URL}/blob/master/CHANGELOG.md`
const LICENSE_URL = `${REPO_URL}/blob/master/LICENSE`
const UPSTREAM_URL = 'https://github.com/deepseek-ai/chat-demo'
const ISSUES_URL = `${REPO_URL}/issues`

/** 构建期注入的应用版本（rspack HtmlRspackPlugin 的 application-version meta） */
const APP_VERSION =
  document.querySelector('meta[name="application-version"]')?.getAttribute('content') ?? '—'

/**
 * 设置页：参考官方 App 的「分组卡片」布局。
 * 移动端为全屏页面（返回圆钮 + 居中标题），桌面端为居中卡片；分组依次为账户 / 应用 / 数据 / 关于。
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsPage /> : null
}

const SettingsPage = () => {
  const t = useTranslate()
  // 打开时定位到调用方指定的分组
  const [section] = useState(() => useSettingsDialog.getState().section)
  const apiKeyEditor = useApiKeyEditor()
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const target = scrollRef.current?.querySelector<HTMLElement>(
      `[data-section="${section}"]`
    )
    target?.scrollIntoView({ block: 'start' })
  }, [section])

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
      <div className={styles.page} role="dialog" aria-modal="true" aria-label={t('settings')}>
        <div className={styles.header}>
          <button
            type="button"
            className={styles.back}
            aria-label={t('close')}
            onClick={closeSettings}
          >
            <IconChevronLeftOutline16 />
          </button>
        <div className={styles.title}>{t('settings')}</div>
        <span className={styles.backPlaceholder} />
      </div>
      <div ref={scrollRef} className={styles.scroll}>
        <Section id="account" title={t('settingsSectionAccount')}>
          <ApiKeySetting editor={apiKeyEditor} />
        </Section>

        <Section id="app" title={t('settingsSectionApp')}>
          <Row
            icon={<IconGlobeLanguageOutline14 />}
            label={t('settingsLocalePreference')}
            action={<LocaleSetting />}
          />
          <ThemeSetting />
          <Row
            icon={<IconPlayMediaOutline16 />}
            label={t('settingsTtsVoice')}
            action={<TtsVoiceSetting />}
          />
          <LocationSetting />
        </Section>

        <Section id="data" title={t('settingsSectionData')}>
          <ImportHistory historyImport={historyImport} disabled={historyBusy} />
          <ExportHistory disabled={historyBusy} />
          <DeleteAllSetting historyDelete={historyDelete} disabled={historyBusy} />
        </Section>

        <Section id="about" title={t('settingsSectionAbout')}>
          <Row
            icon={<IconInfoOutline16 />}
            label={t('settingsVersion')}
            value={APP_VERSION}
          />
          <Row
            icon={<IconLinkOutline16 />}
            label={t('settingsProjectHome')}
            href={REPO_URL}
          />
          <Row label={t('settingsChangelog')} href={CHANGELOG_URL} />
          <Row label={t('settingsLicense')} href={LICENSE_URL} />
          <Row label={t('settingsUpstream')} href={UPSTREAM_URL} />
          <Row label={t('settingsFeedback')} href={ISSUES_URL} />
        </Section>

        <div className={styles.footer}>{t('settingsFooter')}</div>
      </div>
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
      </div>
    </>
  )
}

/** 分组：标题 + 白色卡片 */
const Section = ({
  id,
  title,
  children,
}: {
  id: SettingsSection
  title: string
  children: ReactNode
}) => (
  <section className={styles.section} data-section={id}>
    <div className={styles.sectionTitle}>{title}</div>
    <div className={styles.card}>{children}</div>
  </section>
)

/** 行：可选图标、标签、右侧值/操作、箭头；href 为外链，onClick 为可点击行 */
const Row = ({
  icon,
  label,
  value,
  action,
  href,
  onClick,
  danger,
  className,
}: {
  icon?: ReactNode
  label: string
  value?: string
  action?: ReactNode
  href?: string
  onClick?: () => void
  danger?: boolean
  className?: string
}) => {
  const content = (
    <>
      {icon ? <span className={styles.rowIcon}>{icon}</span> : null}
      <span className={clsx(styles.rowLabel, danger && styles.rowDanger)}>{label}</span>
      {value !== undefined ? <span className={styles.rowValue}>{value}</span> : null}
      {action ? <span className={styles.rowAction}>{action}</span> : null}
      {href || onClick ? (
        <span className={styles.rowChevron}>
          <IconChevronRightOutline14 />
        </span>
      ) : null}
    </>
  )
  if (href) {
    return (
      <a
        className={clsx(styles.row, styles.rowInteractive, className)}
        href={href}
        target="_blank"
        rel="noreferrer"
      >
        {content}
      </a>
    )
  }
  if (onClick) {
    return (
      <button
        type="button"
        className={clsx(styles.row, styles.rowInteractive, className)}
        onClick={onClick}
      >
        {content}
      </button>
    )
  }
  return <div className={clsx(styles.row, className)}>{content}</div>
}

/** API Key：未配置时直接显示输入框，已配置时显示状态与「更换」 */
const ApiKeySetting = ({ editor }: { editor: ReturnType<typeof useApiKeyEditor> }) => {
  const t = useTranslate()
  const { apiKey, editing, setEditing, form, showInput } = editor
  return (
    <div className={styles.apiKeyBlock}>
      <Row
        icon={<IconUserOutline16 />}
        label={t('settingsApiKey')}
        value={apiKey && !editing ? t('settingsApiKeyConfigured') : t('settingsApiKeyMissing')}
        action={
          apiKey && !editing ? (
            <button type="button" className={styles.textButton} onClick={() => setEditing(true)}>
              {t('changeApiKey')}
            </button>
          ) : null
        }
      />
      {showInput ? (
        <div className={styles.apiKeyEditor}>
          <input
            className={styles.apiKeyInput}
            type="password"
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
  )
}

/** 语言选择 */
const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <Select
      ariaLabel={t('settingsLocalePreference')}
      value={locale}
      options={[
        { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
        { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
      ]}
      onChange={setLocale}
    />
  )
}

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

/** 外观：浅色 / 深色 / 跟随系统分段选择 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <Row
      icon={<IconLightOutline16 />}
      label={label}
      action={
        <div className={styles.segmented} role="radiogroup" aria-label={label}>
          {themeOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={themePreference === option.value}
              className={clsx(
                styles.segButton,
                themePreference === option.value && styles.segButtonActive
              )}
              onClick={() => setThemePreference(option.value)}
            >
              {option.icon}
              {t(option.label)}
            </button>
          ))}
        </div>
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <Select
      ariaLabel={t('settingsTtsVoice')}
      value={ttsVoice}
      options={[
        { value: 'stella', label: t('settingsTtsVoiceStella') },
        { value: 'tide', label: t('settingsTtsVoiceTide') },
      ]}
      onChange={setTtsVoice}
    />
  )
}

/** 位置：中文浏览器选省/市，其他选择区域 */
const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <Row
      icon={<IconGlobeLanguageOutline14 />}
      label={t('settingsLocation')}
      className={styles.locationRow}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
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

/** 删除全部对话：危险操作行 */
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
      action={
        <Button
          variant="dangerOutlined"
          size="m"
          disabled={disabled}
          onClick={historyDelete.open}
        >
          {t('delete')}
        </Button>
      }
    />
  )
}

/** 覆盖导入的二次确认，叠在设置之上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
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
        action={
          <>
            <Button
              variant="outlined"
              size="m"
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
            >
              {t('upload')}
            </Button>
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
          </>
        }
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
        action={
          <Button
            variant="outlined"
            size="m"
            disabled={disabled || busy || empty}
            onClick={() => void onExport()}
          >
            {t('exportAllDownload')}
          </Button>
        }
      />
      {status ? (
        <div className={clsx(styles.rowNote, styles.errorNote)}>{statusText(t, status)}</div>
      ) : null}
    </div>
  )
}
