import clsx from 'clsx'
import { useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import logo from '../../assets/logo.png'
import { LICENSE_TEXT } from '../../assets/licenseText.js'
import {
  IconChevronRightOutline14,
  IconBookOutline16,
  IconDownloadOutline16,
  IconShareOutline16,
  IconFileOutline16,
  IconRefreshOutline16,
  IconTrashOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
} from '../../services/chat/backup.js'
import { useChatStore } from '../../services/chat/store.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { saveBackup } from '../../services/saveBackup.js'
import { diagnosticError, logEvent } from '../../services/diagnostics/log.js'
import { saveNativeDiagnostics } from '../../services/diagnostics/native.js'
import { shareDiagnostics } from '../../services/shareDiagnostics.js'
import { UsageContent } from '../usage/UsagePanel.js'
import { PricingForm } from '../usage/PricingForm.js'
import { checkForUpdate, downloadUpdate, useUpdate } from '../../services/update.js'
import { runInstall, UpdateDialog, useUpdateStatusText } from '../update/Update.js'
import { useSettingsDialog } from './settingsDialogState.js'
import styles from './Settings.module.css'
import { ProviderSettingsPage } from './ProviderSettings.js'
import { SettingsDisclosure } from './SettingsDisclosure.js'
import { Section, Row } from './SettingsRows.js'
import { AccountPage } from './AccountPage.js'
import { AppearancePage, ChatPreferencesPage } from './PreferencesPages.js'
import { SettingsShell } from './SettingsShell.js'
import type { Persona } from '../../services/personas.js'
import { PersonaEditor, PersonaLibrary } from '../personas/PersonaLibrary.js'

/** 构建期注入的应用版本（rspack HtmlRspackPlugin 的 application-version meta） */
const APP_VERSION =
  document.querySelector('meta[name="application-version"]')?.getAttribute('content') ?? '—'

/** 目录、返回及跨屏布局由 SettingsShell 管理，导入中的文件随弹窗保留。 */
export const SettingsDialog = () =>
  useSettingsDialog((state) => state.open) ? <SettingsRoot /> : null

const SettingsRoot = () => {
  const [guideOpen, setGuideOpen] = useState(true)
  const [persona, setPersona] = useState<Persona>({ id: '', name: '', prompt: '' })
  const historyImport = useHistoryImport(),
    historyDelete = useHistoryDelete()
  const replacing = useChatStore((state) => state.importingHistory)
  return (
    <>
      <SettingsShell>
        {(page, open, finish) => {
          switch (page) {
            case 'account':
              return (
                <AccountPage
                  guideOpen={guideOpen}
                  toggleGuide={() => setGuideOpen((value) => !value)}
                  openAdvanced={() => open('providers')}
                />
              )
            case 'providers':
              return <ProviderSettingsPage onOfficial={finish} />
            case 'chat':
              return <ChatPreferencesPage />
            case 'personas':
              return (
                <PersonaLibrary
                  onEdit={(value) => {
                    setPersona(value)
                    open('personaEdit')
                  }}
                />
              )
            case 'personaEdit':
              return <PersonaEditor persona={persona} onDone={finish} />
            case 'appearance':
              return <AppearancePage />
            case 'data':
              return (
                <DataPage
                  historyImport={historyImport}
                  historyDelete={historyDelete}
                  disabled={replacing || historyImport.busy || historyDelete.busy}
                />
              )
            case 'usage':
              return <UsageContent onOpenPricing={() => open('usagePricing')} />
            case 'usagePricing':
              return <PricingForm />
            case 'about':
              return <AboutPage openInfo={() => open('aboutInfo')} />
            case 'aboutInfo':
              return <AboutInfoPage />
            default:
              return null
          }
        }}
      </SettingsShell>
      {historyImport.file && <ImportConfirm historyImport={historyImport} />}
      {historyImport.result !== null && <ImportDone historyImport={historyImport} />}
      {historyDelete.opened && <DeleteAllConfirm historyDelete={historyDelete} />}
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
      <Section title={t('settingsBackupGroup')}>
        <ExportHistory disabled={disabled} />
        <ImportHistory historyImport={historyImport} disabled={disabled} />
      </Section>
      <SettingsDisclosure guide title={t('officialExportTitle')} icon={<IconBookOutline16 />}>
        <ol className={styles.officialTipSteps}>
          <li>{t('officialExportStep1')}</li>
          <li>{t('officialExportStep2')}</li>
          <li>{t('officialExportStep3')}</li>
          <li>{t('officialExportStep4')}</li>
        </ol>
        <p className={styles.officialTipHint}>{t('officialExportHint')}</p>
      </SettingsDisclosure>
      <Section title={t('settingsRemoveGroup')}>
        <DeleteAllSetting historyDelete={historyDelete} disabled={disabled} />
      </Section>
    </>
  )
}

/** 二级页：关于（完全本地，不跳转私有仓库） */
const AboutPage = ({ openInfo }: { openInfo: () => void }) => {
  const t = useTranslate()
  const [updateOpen, setUpdateOpen] = useState(false)
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false)
  const exportDiagnostics = async (share = true) => {
    if (diagnosticsBusy) {
      return
    }
    setDiagnosticsBusy(true)
    let bundleReady = false
    try {
      const { createDiagnosticBundle } = await import('../../services/diagnostics/export.js')
      const pack = await createDiagnosticBundle()
      bundleReady = true
      const saved = await (share
        ? shareDiagnostics(pack.name, pack.blob)
        : saveBackup(pack.name, pack.blob).then((saved) => (saved ? ('saved' as const) : false)))
      logEvent(
        'diagnostics',
        saved ? (saved === 'shared' ? 'export.share-opened' : 'export.saved') : 'export.cancelled',
        {
          bytes: pack.blob.size,
        }
      )
      if (saved) {
        showToast({ key: saved === 'shared' ? 'diagnosticsShareOpened' : 'diagnosticsExported' })
      }
    } catch (error) {
      logEvent('diagnostics', 'export.failed', diagnosticError(error), 'error')
      if (Capacitor.getPlatform() === 'android' && !bundleReady) {
        showToast({ key: 'diagnosticsFallback' })
        try {
          if (await saveNativeDiagnostics(error, share)) {
            showToast({ key: share ? 'diagnosticsShareOpened' : 'diagnosticsExported' })
          }
        } catch (fallbackError) {
          logEvent(
            'diagnostics',
            'export.native-fallback-failed',
            diagnosticError(fallbackError),
            'error'
          )
          showToast({ key: 'diagnosticsExportFailed', type: 'error' })
        }
      } else {
        showToast({
          key: share ? 'diagnosticsShareFailed' : 'diagnosticsExportFailed',
          type: 'error',
        })
      }
    } finally {
      setDiagnosticsBusy(false)
    }
  }
  const updateStatus = useUpdate((state) => state.status)
  const updateRelease = useUpdate((state) => state.release)
  const updateStatusText = useUpdateStatusText()
  return (
    <>
      <div className={styles.brandBlock}>
        <img className={styles.brandLogo} src={logo} alt="" draggable={false} />
        <div className={styles.brandName}>FreeSeek</div>
        <div className={styles.brandVersion}>
          {t('settingsVersion')} {APP_VERSION}
        </div>
      </div>
      <Section title={t('updateSectionTitle')}>
        <button
          type="button"
          className={styles.row}
          onClick={() => {
            if (updateStatus === 'ready') {
              void runInstall()
            } else if (updateStatus === 'available') {
              void downloadUpdate()
            } else {
              void checkForUpdate({ force: true })
            }
          }}
        >
          <span className={styles.rowLabel}>{t('updateCheck')}</span>
          <span className={styles.rowValue}>{updateStatusText}</span>
          <span className={styles.rowChevron}>
            <IconRefreshOutline16 />
          </span>
        </button>
        {updateRelease &&
        (updateStatus === 'available' ||
          updateStatus === 'downloading' ||
          updateStatus === 'ready') ? (
          <button type="button" className={styles.row} onClick={() => setUpdateOpen(true)}>
            <span className={styles.rowLabel}>{t('updateNotes')}</span>
            <span className={styles.rowValue}>v{updateRelease.version}</span>
            <span className={styles.rowChevron}>
              <IconChevronRightOutline14 />
            </span>
          </button>
        ) : null}
      </Section>

      <Section title={t('diagnosticsTitle')}>
        <button
          type="button"
          className={styles.row}
          disabled={diagnosticsBusy}
          onClick={() => void exportDiagnostics()}
        >
          <span className={styles.rowLabel}>{t('diagnosticsShare')}</span>
          <span className={styles.rowValue}>
            {diagnosticsBusy ? t('diagnosticsPreparing') : null}
          </span>
          <IconShareOutline16 />
        </button>
        <button
          type="button"
          className={styles.row}
          disabled={diagnosticsBusy}
          onClick={() => void exportDiagnostics(false)}
        >
          <span className={styles.rowLabel}>{t('diagnosticsSaveFile')}</span>
          <IconDownloadOutline16 />
        </button>
        <p className={styles.paragraph}>{t('diagnosticsPrivacy')}</p>
      </Section>
      <Section>
        <Row label={t('settingsPrivacyLicenses')} onClick={openInfo} target="aboutInfo" />
      </Section>
      {updateOpen && <UpdateDialog onClose={() => setUpdateOpen(false)} />}
    </>
  )
}

const AboutInfoPage = () => {
  const t = useTranslate()
  return (
    <>
      <Section title={t('settingsPrivacyTitle')}>
        <p className={styles.paragraph}>{t('settingsPrivacyText')}</p>
      </Section>
      <Section title={t('settingsUpstreamTitle')}>
        <p className={styles.paragraph}>{t('settingsUpstreamText')}</p>
      </Section>
      <Section title={t('settingsFontCredits')}>
        <p className={styles.paragraph}>{t('settingsFontAttribution')}</p>
      </Section>
      <Section title={t('settingsLicense')}>
        <pre className={styles.licenseText}>{LICENSE_TEXT}</pre>
      </Section>
    </>
  )
}

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
      dismissible={!historyDelete.busy}
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
/**
 * 覆盖导入确认：分两步，第一步强调「会删掉现有聊天」，第二步再确认一次，
 * 两次都显示当前对话数量，避免误操作把本地记录清空。
 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  const [stage, setStage] = useState<'warn' | 'final'>('warn')
  const sessionCount = useChatStore((state) => state.sessions.length)
  const fileName = historyImport.file?.name ?? ''

  if (stage === 'warn') {
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
            <Button variant="danger" size="m" onClick={() => setStage('final')}>
              {t('historyImportContinue')}
            </Button>
          </>
        }
      >
        <div className={styles.importFile}>
          <IconFileOutline16 />
          <span>{fileName}</span>
        </div>
        <div className={styles.importWarn}>
          <div className={styles.importWarnTitle}>{t('historyImportWarnTitle')}</div>
          <div className={styles.importWarnBody}>
            {t('historyImportWarnBody', { count: sessionCount })}
          </div>
        </div>
      </Modal>
    )
  }

  const { busy, phase, progress, errorKey } = historyImport
  const percent =
    progress && progress.total > 0
      ? Math.min(
          100,
          Math.round(
            ((progress.processed +
              (progress.reading && progress.reading.total > 0
                ? progress.reading.bytes / progress.reading.total
                : 0)) /
              progress.total) *
              100
          )
        )
      : null
  return (
    <Modal
      title={
        busy
          ? t('historyImportBusyTitle')
          : errorKey
            ? t('historyImportFailedTitle')
            : t('historyImportFinalTitle')
      }
      centered
      dismissible={!busy}
      onClose={historyImport.cancel}
      footer={
        <div className={styles.importFooter}>
          {busy ? (
            <div className={styles.importBusy}>
              <span className={styles.importSpinner} aria-hidden />
              <span>
                {phase === 'checking'
                  ? t('historyImportChecking')
                  : progress && progress.total > 0 && progress.processed < progress.total
                    ? t('historyImportProgress', {
                        processed: progress.processed,
                        total: progress.total,
                      })
                    : t('historyImportWriting')}
              </span>
            </div>
          ) : null}
          {!busy && (
            <div className={styles.importActions}>
              <Button
                variant="outlined"
                size="m"
                autoFocus
                onClick={() => (errorKey ? historyImport.cancel() : setStage('warn'))}
              >
                {errorKey ? t('close') : t('historyImportBack')}
              </Button>
              <Button
                variant={errorKey ? 'primary' : 'danger'}
                size="m"
                onClick={() => void historyImport.confirm()}
              >
                {errorKey ? t('historyImportRetry') : t('historyImportFinalConfirm')}
              </Button>
            </div>
          )}
        </div>
      }
    >
      {!busy && !errorKey && (
        <div className={styles.importWarnFinal}>
          {t('historyImportFinalBody', { count: sessionCount })}
        </div>
      )}
      {busy ? (
        <div className={styles.importProgress}>
          <div
            className={styles.importProgressTrack}
            role="progressbar"
            aria-label={t('historyImportBusyTitle')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
          >
            <span
              className={
                percent === null ? styles.importProgressIndeterminate : styles.importProgressFill
              }
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
          {progress?.reading && progress.reading.total >= 1024 * 1024 && (
            <div className={styles.importProgressHint}>
              {t('historyImportReading', {
                read: (progress.reading.bytes / 1024 / 1024).toFixed(1),
                total: (progress.reading.total / 1024 / 1024).toFixed(1),
              })}
            </div>
          )}
          <div className={styles.importProgressHint}>{t('historyImportNoClose')}</div>
        </div>
      ) : null}
      {errorKey ? (
        <div className={styles.importErrorBox}>
          <div className={styles.importErrorBody}>{t(errorKey)}</div>
          <div className={styles.importErrorHint}>{t('historyImportFailedHint')}</div>
        </div>
      ) : null}
    </Modal>
  )
}

/** 导入完成：提示并给「立即重启」，让界面切到新数据 */
const ImportDone = ({ historyImport }: { historyImport: ReturnType<typeof useHistoryImport> }) => {
  const t = useTranslate()
  const count = historyImport.result ?? 0
  return (
    <Modal
      title={t('historyImportDoneTitle')}
      centered
      onClose={historyImport.dismissResult}
      footer={
        <>
          <Button variant="outlined" size="m" onClick={historyImport.dismissResult}>
            {t('restartLater')}
          </Button>
          <Button
            size="m"
            onClick={() => {
              window.location.reload()
            }}
          >
            {t('restartNow')}
          </Button>
        </>
      }
    >
      <div className={styles.importDone}>{t('historyImportDoneBody', { count })}</div>
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
  status ? t(status.key, status.reason ? { message: t(status.reason) } : status.params) : ''

/** 选文件后先提示覆盖；确认后才检查文件并执行导入，任何错误都提示导入失败。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  /** 成功导入的会话数；非 null 时弹出「导入完成」对话框 */
  const [result, setResult] = useState<number | null>(null)
  /** 导入阶段：checking 校验 / importing 写入；失败回到 idle 并给出原因 */
  const [phase, setPhase] = useState<'idle' | 'checking' | 'importing'>('idle')
  const [progress, setProgress] = useState<{
    processed: number
    total: number
    reading?: { bytes: number; total: number }
  } | null>(null)
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null)
  const importing = useRef(false)

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setBusy(true)
    setStatus(null)
    setErrorKey(null)
    setProgress(null)
    setPhase('checking')
    try {
      const count = await importHistory(file, (processed, total, reading) => {
        setPhase('importing')
        setProgress({ processed, total, reading })
      })
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
      setFile(null)
      setResult(count)
      setPhase('idle')
    } catch (error) {
      // 失败时保留文件与弹窗：把原因写在按钮上方，可直接重试
      setErrorKey(error instanceof BackupError ? error.key : 'historyImportFailed')
      setStatus({ key: 'historyImportFailed', error: true })
      setPhase('idle')
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  return {
    file,
    busy,
    status,
    result,
    phase,
    progress,
    errorKey,
    select: (next: File) => {
      setErrorKey(null)
      setStatus(null)
      setProgress(null)
      setFile(next)
    },
    cancel: () => setFile(null),
    dismissResult: () => setResult(null),
    confirm,
  }
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
        disabled={disabled}
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
      await saveBackup(name, blob)
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
        disabled={disabled || busy || empty}
        onClick={() => void onExport()}
      />
      {status ? (
        <div className={clsx(styles.rowNote, styles.errorNote)}>{statusText(t, status)}</div>
      ) : null}
    </div>
  )
}
