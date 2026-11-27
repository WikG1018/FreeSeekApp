import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { Capacitor } from '@capacitor/core'
import logo from '../../assets/logo.png'
import { LICENSE_TEXT } from '../../assets/licenseText.js'
import {
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
  importHistory,
  saveHistoryBackup,
  type HistoryImportPreview,
  type HistoryImportResult,
} from '../../services/chat/backup.js'
import type { ArchivePartial } from '../../services/chat/history/importArchive.js'
import { useChatStore, selectSession } from '../../services/chat/store.js'
import { historyVaultAvailable, useHistoryVault } from '../../services/chat/historyVault.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { hasHistoryVaultCopy, type HistoryVaultResult } from '../session/HistoryVaultRecovery.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { closeMobileSider } from '../sider/mobileSiderState.js'
import { showToast } from '../base/toastState.js'
import { saveBackup } from '../../services/saveBackup.js'
import { diagnosticError, logEvent } from '../../services/diagnostics/log.js'
import { saveNativeDiagnostics } from '../../services/diagnostics/native.js'
import { shareDiagnostics } from '../../services/shareDiagnostics.js'
import { UsageContent } from '../usage/UsagePanel.js'
import { PricingForm } from '../usage/PricingForm.js'
import {
  ModelUsageDetail,
  ModelUsagePage,
  initialModelUsageFilters,
  useModelUsage,
} from '../usage/ModelUsagePage.js'
import { ScreenTimePage } from './ScreenTimePage.js'
import { EasterEggsPage } from '../milestones/UsageMilestone.js'
import { useScreenTimeMilestones } from '../../services/screenTimeMilestones.js'
import { checkForUpdate, currentVersion, isNewer, useUpdate } from '../../services/update.js'
import { UpdateDialog, useUpdateStatusText } from '../update/Update.js'
import { GettingStarted, UsageNotice } from '../onboarding/Onboarding.js'
import { useSettings } from '../../services/settings.js'
import { closeSettings, useSettingsDialog, type SettingsPageId } from './settingsDialogState.js'
import styles from './Settings.module.css'
import {
  newProviderConnection,
  ProviderAccessPage,
  ProviderCatalogPage,
  ProviderSettingsPage,
} from './ProviderSettings.js'
import {
  ProviderConnectionPage,
  ProviderModelPage,
  ProviderModelsPage,
  ProviderSearchPage,
  ProviderSpeechPage,
} from './ProviderEditors.js'
import { emptyProfile, useProviders } from '../../services/providers.js'
import { providerPreset, type ProviderPreset } from '../../services/providerPresets.js'
import type { ProviderCatalogModel } from '../../services/api/providerClient.js'
import { SettingsDisclosure } from './SettingsDisclosure.js'
import { Section, Row, TutorialSteps } from './SettingsRows.js'
import { AccountPage } from './AccountPage.js'
import { AppearancePage, ChatPreferencesPage } from './PreferencesPages.js'
import { SettingsShell } from './SettingsShell.js'
import { HistoryVaultSettings } from './HistoryVaultSettings.js'
import type { Persona } from '../../services/personas.js'
import { PersonaEditor, PersonaLibrary } from '../personas/PersonaLibrary.js'

/** 构建期注入的应用版本（rspack HtmlRspackPlugin 的 application-version meta） */
const APP_VERSION =
  document.querySelector('meta[name="application-version"]')?.getAttribute('content') ?? '—'
const useDiagnosticExport = create(() => ({ busy: false }))

/** 目录、返回及跨屏布局由 SettingsShell 管理，导入中的文件随弹窗保留。 */
type VaultResultProps = { onVaultResult: (result: HistoryVaultResult) => void }

export const SettingsDialog = ({ onVaultResult }: VaultResultProps) =>
  useSettingsDialog((state) => state.open) ? <SettingsRoot onVaultResult={onVaultResult} /> : null
import type { AgentProfile } from '../../services/assistants/library.js'
import { MemoryActivityPage } from './MemoryActivityPage.js'
import { AgentDetailsPage, AgentToolsPage } from './AssistantWorkflowPages.js'
import { AgentExtensionsPage } from './AgentExtensionsPage.js'
import {
  AgentEditor,
  AgentListPage,
  AssistantSettingsPage,
  MemoryDetailsPage,
  MemoryListPage,
  emptyAgent,
  type AgentDraft,
} from './AssistantSettings.js'

const SettingsRoot = ({ onVaultResult }: VaultResultProps) => {
  const [guideOpen, setGuideOpen] = useState(
    () => !useSettings.getState().apiKey || useSettingsDialog.getState().showTutorial
  )
  const [persona, setPersona] = useState<Persona>({ id: '', name: '', prompt: '' })
  const [agentEditor, setAgentEditor] = useState<{ initial: AgentDraft; previous?: AgentProfile }>(
    () => ({ initial: emptyAgent() })
  )
  const historyImport = useHistoryImport(),
    historyDelete = useHistoryDelete()
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const replacing = useChatStore((state) => state.importingHistory)
  const restoringVault = useHistoryVault((state) => state.phase === 'restoring')
  const historyBusy = replacing || historyImport.busy || historyDelete.busy || restoringVault
  const pageId = useSettingsDialog((state) => state.page)
  const modelUsage = useModelUsage(pageId === 'usageModels' || pageId === 'usageModel')
  const [modelUsageFilters, setModelUsageFilters] = useState(initialModelUsageFilters)
  const [usageModelKey, setUsageModelKey] = useState<string | null>(null)
  const [preset, setPreset] = useState<ProviderPreset>()
  const [connection, setConnection] = useState(emptyProfile)
  const [connectionId, setConnectionId] = useState('')
  const [model, setModel] = useState<ProviderCatalogModel>({ id: '' })
  const [catalog, setCatalog] = useState<{
    id: string
    revision: string
    models: ProviderCatalogModel[]
  }>()
  const profile = useProviders((state) => state.profiles.find((item) => item.id === connectionId))
  const connectionParent = connection.id
    ? 'providerModels'
    : (providerPreset(connection.preset?.id)?.access.length ?? 0) > 1
      ? 'providerAccess'
      : 'providerCatalog'
  return (
    <>
      <SettingsShell backTarget={pageId === 'providerConnection' ? connectionParent : undefined}>
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
              return (
                <ProviderSettingsPage
                  add={() => open('providerCatalog')}
                  edit={(id) => {
                    setConnectionId(id)
                    open('providerModels')
                  }}
                  search={() => open('providerSearch')}
                  speech={() => open('providerSpeech')}
                  onOfficial={() => finish()}
                />
              )
            case 'providerCatalog':
              return (
                <ProviderCatalogPage
                  choose={(value) => {
                    setPreset(value)
                    if (value.access.length > 1) {
                      open('providerAccess')
                    } else {
                      setConnection(newProviderConnection(value, value.access[0]))
                      open('providerConnection')
                    }
                  }}
                  manual={() => {
                    setConnection(emptyProfile())
                    open('providerConnection')
                  }}
                />
              )
            case 'providerAccess':
              return (
                preset && (
                  <ProviderAccessPage
                    preset={preset}
                    choose={(access) => {
                      setConnection(newProviderConnection(preset, access))
                      open('providerConnection')
                    }}
                  />
                )
              )
            case 'providerConnection':
              return (
                <ProviderConnectionPage
                  initial={connection}
                  onSaved={(id) => {
                    setConnectionId(id)
                    finish('providerModels')
                  }}
                  onDeleted={() => finish('providers')}
                />
              )
            case 'providerModels':
              return (
                profile && (
                  <ProviderModelsPage
                    profile={profile}
                    catalog={
                      catalog?.id === profile.id && catalog.revision === profile.revision
                        ? catalog.models
                        : []
                    }
                    setCatalog={(models) =>
                      setCatalog({ id: profile.id, revision: profile.revision, models })
                    }
                    editConnection={() => {
                      setConnection(profile)
                      open('providerConnection')
                    }}
                    editModel={(value) => {
                      setModel(value)
                      open('providerModel')
                    }}
                  />
                )
              )
            case 'providerModel':
              return (
                profile && (
                  <ProviderModelPage profile={profile} selected={model} onDone={() => finish()} />
                )
              )
            case 'providerSearch':
              return <ProviderSearchPage onDone={() => finish()} />
            case 'providerSpeech':
            case 'chatSpeech':
              return <ProviderSpeechPage onDone={() => finish()} />
            case 'chat':
              return <ChatPreferencesPage openSpeech={() => open('chatSpeech')} />
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
              return <PersonaEditor persona={persona} onDone={() => finish()} />
            case 'appearance':
              return <AppearancePage />
            case 'assistantSettings':
              return <AssistantSettingsPage open={open} />
            case 'memoryDetails':
              return <MemoryDetailsPage />
            case 'memorySuggestions':
              return <MemoryActivityPage />
            case 'agentDetails':
              return <AgentDetailsPage />
            case 'agentTools':
              return <AgentToolsPage open={open} />
            case 'agentExtensions':
              return <AgentExtensionsPage />
            case 'memories':
              return <MemoryListPage />
            case 'agents':
              return (
                <AgentListPage
                  edit={(initial, previous) => {
                    setAgentEditor({ initial, previous })
                    open('agentEdit')
                  }}
                />
              )
            case 'agentEdit':
              return <AgentEditor {...agentEditor} done={finish} />
            case 'data':
              return (
                <DataPage
                  historyImport={historyImport}
                  historyDelete={historyDelete}
                  disabled={!ready || historyBusy}
                  importDisabled={(!ready && !initError) || historyBusy}
                  ready={ready}
                  onVaultResult={onVaultResult}
                />
              )
            case 'usage':
              return (
                <UsageContent
                  onOpenPricing={() => open('usagePricing')}
                  onOpenModels={() => open('usageModels')}
                />
              )
            case 'usagePricing':
              return <PricingForm />
            case 'usageModels':
              return (
                <ModelUsagePage
                  source={modelUsage}
                  filters={modelUsageFilters}
                  change={setModelUsageFilters}
                  selected={usageModelKey}
                  openModel={(key) => {
                    setUsageModelKey(key)
                    open('usageModel')
                  }}
                />
              )
            case 'usageModel':
              return (
                <ModelUsageDetail
                  source={modelUsage}
                  modelKey={usageModelKey}
                  period={modelUsageFilters.period}
                />
              )
            case 'screenTime':
              return <ScreenTimePage />
            case 'about':
              return <AboutPage open={open} />
            case 'easterEggs':
              return <EasterEggsPage />
            case 'disclaimer':
              return (
                <Section>
                  <div className={styles.paragraph}>
                    <UsageNotice />
                  </div>
                </Section>
              )
            case 'guide':
              return (
                <GettingStarted
                  open={(next) => {
                    if (next === 'account') {
                      setGuideOpen(true)
                    }
                    open(next)
                  }}
                />
              )
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
  importDisabled,
  ready,
  onVaultResult,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  historyDelete: ReturnType<typeof useHistoryDelete>
  disabled: boolean
  importDisabled: boolean
  ready: boolean
} & VaultResultProps) => {
  const t = useTranslate()
  const hasHistory = useChatStore((state) => state.sessions.length > 0)
  const hasRecoveryCopy = useHistoryVault(hasHistoryVaultCopy)
  const showTutorial = useSettingsDialog((state) => state.showTutorial)
  return (
    <>
      <Section title={t('settingsBackupGroup')}>
        <ImportHistory historyImport={historyImport} disabled={importDisabled} />
        {hasHistory && <ExportHistory disabled={disabled} />}
      </Section>
      {historyVaultAvailable() && (
        <HistoryVaultSettings disabled={importDisabled} ready={ready} onResult={onVaultResult} />
      )}
      <SettingsDisclosure
        guide
        defaultOpen={showTutorial}
        title={t('officialExportTitle')}
        icon={<IconBookOutline16 />}
      >
        <TutorialSteps
          steps={[
            'officialExportStep1',
            'officialExportStep2',
            'officialExportStep3',
            'officialExportStep4',
          ]}
        />
        <p className={styles.officialTipHint}>
          {t(hasHistory ? 'officialExportHint' : 'guideKeyFree')}
        </p>
      </SettingsDisclosure>
      {(hasHistory || (historyVaultAvailable() && hasRecoveryCopy)) && (
        <Section title={t('settingsRemoveGroup')}>
          <DeleteAllSetting historyDelete={historyDelete} disabled={disabled} />
        </Section>
      )}
    </>
  )
}

/** 二级页：关于（完全本地，不跳转私有仓库） */
const AboutPage = ({ open }: { open: (page: SettingsPageId) => void }) => {
  const t = useTranslate()
  const hasEasterEggs = useScreenTimeMilestones((state) => state.triggered.length > 0)
  const [notes, setNotes] = useState<'installed' | 'incoming' | null>(null)
  const diagnosticsBusy = useDiagnosticExport((state) => state.busy)
  const exportDiagnostics = async (share = true) => {
    if (useDiagnosticExport.getState().busy) {
      return
    }
    useDiagnosticExport.setState({ busy: true })
    let bundleReady = false
    try {
      const { createDiagnosticBundle } = await import('../../services/diagnostics/export.js')
      const pack = await createDiagnosticBundle()
      bundleReady = true
      const saved = await (share
        ? shareDiagnostics(pack.name, pack.blob)
        : saveBackup(pack.name, pack.blob, 'diagnostics').then((saved) =>
            saved ? ('saved' as const) : false
          ))
      logEvent(
        'diagnostics',
        saved ? (saved === 'shared' ? 'export.share-opened' : 'export.saved') : 'export.cancelled',
        {
          bytes: pack.blob.size,
        }
      )
      if (saved) {
        showToast({
          key:
            saved === 'shared'
              ? 'diagnosticsShareOpened'
              : Capacitor.getPlatform() === 'android'
                ? 'diagnosticsExported'
                : 'diagnosticsDownloadStarted',
        })
      }
    } catch (error) {
      logEvent(
        'diagnostics',
        'export.failed',
        { stage: bundleReady ? (share ? 'share' : 'save') : 'generate', ...diagnosticError(error) },
        'error'
      )
      if (Capacitor.getPlatform() === 'android' && (!bundleReady || share)) {
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
          showToast({
            key: share ? 'diagnosticsShareFailed' : 'diagnosticsExportFailed',
            type: 'error',
          })
        }
      } else {
        showToast({
          key: share ? 'diagnosticsShareFailed' : 'diagnosticsExportFailed',
          type: 'error',
        })
      }
    } finally {
      useDiagnosticExport.setState({ busy: false })
    }
  }
  const updateStatus = useUpdate((state) => state.status)
  const updateRelease = useUpdate((state) => state.release)
  const updateStatusText = useUpdateStatusText()
  const hasIncoming = Boolean(updateRelease && isNewer(updateRelease.version, currentVersion()))
  return (
    <>
      <div className={styles.brandBlock}>
        <img
          className={clsx(styles.brandLogo, 'fs-whale-image')}
          src={logo}
          alt=""
          draggable={false}
        />
        <div className={styles.brandName}>FreeSeek</div>
        <div className={styles.brandVersion}>
          {t('settingsVersion')} {APP_VERSION}
        </div>
      </div>
      <Section title={t('updateSectionTitle')}>
        <button
          type="button"
          className={styles.row}
          disabled={updateStatus === 'checking' && !hasIncoming}
          onClick={async () => {
            if (hasIncoming || (await checkForUpdate({ force: true }))) {
              setNotes('incoming')
            }
          }}
        >
          <span className={styles.rowLabel}>{t('updateCheck')}</span>
          <span className={styles.rowValue}>{updateStatusText}</span>
          <span className={styles.rowChevron}>
            <IconRefreshOutline16 />
          </span>
        </button>
        <Row
          label={t('updateInstalledNotes')}
          value={'v' + APP_VERSION}
          onClick={() => setNotes('installed')}
          target="installed-release-notes"
        />
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
        <Row label={t('guideTitle')} onClick={() => open('guide')} target="guide" />
        <Row label={t('disclaimerTitle')} onClick={() => open('disclaimer')} target="disclaimer" />
        {hasEasterEggs && (
          <Row
            label={t('milestoneEasterEggs')}
            onClick={() => open('easterEggs')}
            target="easterEggs"
          />
        )}
        <Row
          label={t('settingsPrivacyLicenses')}
          onClick={() => open('aboutInfo')}
          target="aboutInfo"
        />
      </Section>
      {notes && <UpdateDialog installed={notes === 'installed'} onClose={() => setNotes(null)} />}
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
      <Section title={t('settingsPrivacyServicesTitle')}>
        <p className={styles.paragraph}>{t('settingsPrivacyServices')}</p>
      </Section>
      <Section title={t('settingsPrivacyReportsTitle')}>
        <p className={styles.paragraph}>{t('settingsPrivacyReports')}</p>
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
      {t(historyVaultAvailable() ? 'historyVaultDeleteAll' : 'deleteAllSessionsModalDescription')}
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

const ArchivePartialSummary = ({ partial }: { partial: ArchivePartial }) => {
  const t = useTranslate()
  return (
    <>
      {partial.skippedSessions > 0 && (
        <p className={styles.importSummary}>
          {t('historyImportArchiveMissingSessions', { count: partial.skippedSessions })}
        </p>
      )}
      {partial.missingOriginals > 0 && (
        <p className={styles.importSummary}>
          {t('historyImportArchiveMissingFiles', { count: partial.missingOriginals })}
        </p>
      )}
    </>
  )
}

const ImportReview = ({
  preview,
  useBackup,
  setUseBackup,
}: {
  preview: HistoryImportPreview
  useBackup: ReadonlySet<string>
  setUseBackup: (ids: Set<string>) => void
}) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const [limit, setLimit] = useState(30)
  const focus = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    focus.current?.focus({ preventScroll: true })
  }, [])
  const date = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  return (
    <>
      <p ref={focus} tabIndex={-1} className={styles.importSummary}>
        {preview.conflicts.length
          ? t('historyImportConflictsBody', { added: preview.added, count: preview.conflicts.length })
          : t('historyImportAvailable', { count: preview.added })}
      </p>
      {preview.skipped > 0 && (
        <p className={styles.importSummary}>{t('historyImportWillSkip', { count: preview.skipped })}</p>
      )}
      {preview.archivePartial && <ArchivePartialSummary partial={preview.archivePartial} />}
      {preview.conflicts.length > 1 && (
        <div className={styles.importBulkChoices}>
          <button type="button" className={styles.quietAction} onClick={() => setUseBackup(new Set())}>
            {t('historyImportKeepAll')}
          </button>
          <button
            type="button"
            className={styles.quietAction}
            onClick={() => setUseBackup(new Set(preview.conflicts.map(({ local }) => local.id)))}
          >
            {t('historyImportUseAll')}
          </button>
        </div>
      )}
      {preview.conflicts.slice(0, limit).map(({ local, backup }) => (
        <fieldset className={styles.importConflict} key={local.id}>
          <legend title={local.title}>{local.title || t('newChat')}</legend>
          <div className={styles.importChoices}>
            {([['local', local], ['backup', backup]] as const).map(([source, session]) => {
              const selected = useBackup.has(local.id) === (source === 'backup')
              const timestamp = new Date(session.updatedAt)
              return (
                <label
                  className={clsx(styles.importChoice, selected && styles.importChoiceSelected)}
                  key={source}
                >
                  <input
                    type="radio"
                    name={'import-version-' + local.id}
                    checked={selected}
                    onChange={() => {
                      const next = new Set(useBackup)
                      if (source === 'backup') {
                        next.add(local.id)
                      } else {
                        next.delete(local.id)
                      }
                      setUseBackup(next)
                    }}
                  />
                  <span>{t(source === 'local' ? 'historyImportKeepLocal' : 'historyImportUseBackup')}</span>
                  {local.title !== backup.title && (
                    <span className={styles.importChoiceTitle} title={session.title}>
                      {session.title || t('newChat')}
                    </span>
                  )}
                  <time>{Number.isFinite(timestamp.getTime()) ? date.format(timestamp) : t('historyImportUnknownDate')}</time>
                </label>
              )
            })}
          </div>
        </fieldset>
      ))}
      {limit < preview.conflicts.length && (
        <Button variant="outlined" size="s" onClick={() => setLimit(limit + 30)}>
          {t('historyImportShowMore', { count: preview.conflicts.length - limit })}
        </Button>
      )}
    </>
  )
}

const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  const { busy, phase, progress, errorKey, preview, useBackup } = historyImport
  const showingProgress = busy && !preview
  const hasConflicts = Boolean(preview?.conflicts.length)
  const branchFailure = errorKey === 'backupInvalidBranches'
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
  const title = preview
    ? hasConflicts
      ? 'historyImportConflictsTitle'
      : preview.skipped > 0
        ? 'historyImportPartialTitle'
        : 'historyImportArchivePartialTitle'
    : busy
      ? 'historyImportBusyTitle'
      : errorKey
        ? 'historyImportFailedTitle'
        : 'importEmpty'
  const confirmLabel = preview
    ? hasConflicts
      ? 'historyImportMerge'
      : 'historyImportAvailableAction'
    : errorKey
      ? 'historyImportRetry'
      : 'importStart'
  return (
    <Modal
      title={t(title)}
      centered
      dismissible={!showingProgress}
      onClose={historyImport.cancel}
      footer={
        <div className={styles.importFooter}>
          {showingProgress ? (
            <div className={styles.importBusy} role="status">
              <span className={styles.importSpinner} aria-hidden />
              <span>
                {phase === 'checking'
                  ? t('historyImportChecking')
                  : phase === 'reading' && progress && progress.processed < progress.total
                    ? t('historyImportProgress', {
                        processed: progress.processed,
                        total: progress.total,
                      })
                    : t('historyImportWriting')}
              </span>
            </div>
          ) : (
            <>
              {preview && useBackup.size > 0 && (
                <div className={styles.importReplacementNote} aria-live="polite">
                  {t('historyImportReplacing', { count: useBackup.size })}
                </div>
              )}
              <div className={styles.importActions}>
                <Button variant="outlined" size="m" onClick={historyImport.cancel}>
                  {t(errorKey ? 'close' : 'cancel')}
                </Button>
                {!branchFailure && (
                  <Button
                    size="m"
                    onClick={() => {
                      if (preview) {
                        historyImport.acceptChoices()
                      } else {
                        void historyImport.confirm()
                      }
                    }}
                  >
                    {t(confirmLabel)}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      }
    >
      {preview ? (
        <ImportReview
          preview={preview}
          useBackup={useBackup}
          setUseBackup={historyImport.setUseBackup}
        />
      ) : !busy && !errorKey ? (
        <>
          <div className={styles.importFile}>
            <IconFileOutline16 />
            <span>{historyImport.file?.name}</span>
          </div>
          <p className={styles.importSummary}>{t('historyImportMergeBody')}</p>
        </>
      ) : null}
      {showingProgress && (
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
              style={percent === null ? undefined : { width: String(percent) + '%' }}
            />
          </div>
          {phase === 'reading' && progress?.reading && progress.reading.total >= 1024 * 1024 && (
            <div className={styles.importProgressHint}>
              {t('historyImportReading', {
                read: (progress.reading.bytes / 1024 / 1024).toFixed(1),
                total: (progress.reading.total / 1024 / 1024).toFixed(1),
              })}
            </div>
          )}
          <div className={styles.importProgressHint}>{t('historyImportNoClose')}</div>
        </div>
      )}
      {errorKey && (
        <div className={styles.importErrorBox} role="alert">
          <div className={styles.importErrorBody}>{t(errorKey)}</div>
          <div className={styles.importErrorHint}>
            {t(branchFailure ? 'historyImportPreserved' : 'historyImportFailedHint')}
          </div>
        </div>
      )}
    </Modal>
  )
}

const ImportDone = ({ historyImport }: { historyImport: ReturnType<typeof useHistoryImport> }) => {
  const t = useTranslate()
  const result = historyImport.result
  if (!result) {
    return null
  }
  const { firstImportedId: id, added, kept, replaced, skipped, archivePartial } = result
  return (
    <Modal
      title={t('historyImportDoneTitle')}
      centered
      onClose={historyImport.dismissResult}
      footer={
        <>
          {id && (
            <Button variant="outlined" size="m" onClick={historyImport.dismissResult}>
              {t('restartLater')}
            </Button>
          )}
          <Button
            size="m"
            onClick={() => {
              historyImport.dismissResult()
              if (id) {
                selectSession(id)
                closeMobileSider()
                closeSettings()
              }
            }}
          >
            {t(id ? 'importView' : 'importFinish')}
          </Button>
        </>
      }
    >
      <div className={styles.importDone}>{t('historyImportDoneBody', { added, kept, replaced })}</div>
      {skipped > 0 && (
        <div className={styles.importDone}>{t('historyImportSkipped', { count: skipped })}</div>
      )}
      {archivePartial && <ArchivePartialSummary partial={archivePartial} />}
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

const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<Status>(null)
  const [result, setResult] = useState<HistoryImportResult | null>(null)
  const [phase, setPhase] = useState<'idle' | 'checking' | 'reading' | 'writing'>('idle')
  const [progress, setProgress] = useState<{
    processed: number
    total: number
    reading?: { bytes: number; total: number }
  } | null>(null)
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null)
  const [preview, setPreview] = useState<HistoryImportPreview | null>(null)
  const [useBackup, setUseBackup] = useState(() => new Set<string>())
  const importing = useRef(false)
  const pendingChoice = useRef<(ids: ReadonlySet<string> | null) => void>()

  useEffect(() => () => pendingChoice.current?.(null), [])

  const resolveChoices = (ids: ReadonlySet<string> | null) => {
    const resolve = pendingChoice.current
    pendingChoice.current = undefined
    setPreview(null)
    setPhase('writing')
    resolve?.(ids)
  }

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setStatus(null)
    setErrorKey(null)
    setProgress(null)
    setPhase('checking')
    try {
      const result = await importHistory(
        file,
        (processed, total, reading) => {
          setPhase(processed < total ? 'reading' : 'writing')
          setProgress({ processed, total, reading })
        },
        (preview) =>
          new Promise((resolve) => {
            pendingChoice.current = resolve
            setUseBackup(new Set())
            setPreview(preview)
          })
      )
      setFile(null)
      if (result) {
        const { added, kept, replaced } = result
        setStatus({ key: 'historyImportDoneBody', params: { added, kept, replaced } })
        setResult(result)
      }
    } catch (error) {
      const key = error instanceof BackupError ? error.key : 'historyImportFailed'
      setErrorKey(key)
      setStatus({ key, error: true })
    } finally {
      importing.current = false
      setPhase('idle')
    }
  }

  return {
    file,
    busy: phase !== 'idle',
    status,
    result,
    phase,
    progress,
    errorKey,
    preview,
    useBackup,
    setUseBackup,
    acceptChoices: () => resolveChoices(useBackup),
    select: (next: File) => {
      logEvent('backup', 'import.file-selected', { bytes: next.size })
      setErrorKey(null)
      setStatus(null)
      setProgress(null)
      setFile(next)
    },
    cancel: () => {
      if (pendingChoice.current) {
        resolveChoices(null)
      } else if (!importing.current) {
        logEvent('backup', 'import.confirmation-cancelled')
        setFile(null)
      }
    },
    dismissResult: () => setResult(null),
    confirm,
  }
}

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
        description={t('guideFileType')}
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
  const [report, setReport] = useState<Awaited<ReturnType<typeof saveHistoryBackup>>>()

  const onExport = async () => {
    if (disabled || busy || empty) {
      return
    }
    setBusy(true)
    setStatus(null)
    setReport(undefined)
    try {
      const result = await saveHistoryBackup()
      setReport(result)
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
        <div className={clsx(styles.rowNote, styles.errorNote)} role="alert">{statusText(t, status)}</div>
      ) : null}
      {report ? (
        <div className={styles.rowNote} role="status">
          {t(report.destination === 'document' ? 'historyExportSaved' : 'historyExportDownloadStarted')}
        </div>
      ) : null}
      {report && report.skipped > 0 ? (
        <div className={clsx(styles.rowNote, styles.warnNote)}>
          {t('historyExportSkipped', { count: report.skipped })}
        </div>
      ) : null}
      {report && report.missingOriginals > 0 ? (
        <div className={clsx(styles.rowNote, styles.warnNote)}>
          {t('historyExportMissingOriginals', { count: report.missingOriginals })}
        </div>
      ) : null}
    </div>
  )
}
