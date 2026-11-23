import { lazy, Suspense, useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { bindWorkspace, useChatStore } from '../../services/chat/store.js'
import { logEvent } from '../../services/diagnostics/log.js'
import {
  openProjectArchive,
  ProjectSourceError,
  workspaceLimits,
} from '../../services/tasks/projectFiles.js'
import {
  importGithubWorkspace,
  importWorkspaceFolder,
  workspaceDeviceFiles,
} from '../../services/tasks/workspacePlatform.js'
import {
  createWorkspace,
  importWorkspaceBackup,
  refreshWorkspaces,
  useWorkspaces,
  WorkspaceBackupLimit,
  type Workspace,
} from '../../services/tasks/workspaces.js'
import { Button } from '../base/Button.js'
import { IconChevronDownOutline14, IconFileOutline16 } from '../base/icons.js'
import { useOptionPanel } from '../base/OptionPanel.js'
import styles from './Workspace.module.css'

const WorkspacePage = lazy(() =>
  import('./WorkspacePage.js').then(({ WorkspacePage }) => ({ default: WorkspacePage }))
)

export const WorkspacePicker = ({
  sessionId,
  busy,
  editorRef,
}: {
  sessionId: string | null
  busy: boolean
  editorRef: RefObject<HTMLTextAreaElement>
}) => {
  const t = useTranslate()
  const linked = useChatStore((state) =>
    sessionId === null ? state.draftWorkspaceId : state.sessionCache[sessionId]?.workspaceId
  )
  const legacy = useChatStore((state) => {
    const session = sessionId && state.sessionCache[sessionId]
    return session
      ? getVisibleMessages(session).findLast(
          (message) => message.role === 'assistant' && message.task?.project?.length
        )
      : undefined
  })
  const items = useWorkspaces((state) => state.items)
  const active = items.find(({ id }) => id === linked)
  const [page, setPage] = useState<string>()
  const [create, setCreate] = useState(false)
  const [repository, setRepository] = useState(false)
  const [repoUrl, setRepoUrl] = useState('')
  const [repoRef, setRepoRef] = useState('')
  const [name, setName] = useState('')
  const [notice, setNotice] = useState<TranslationKey>()
  const [progress, setProgress] = useState<{ done: number; total: number }>()
  const [working, setWorking] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const formInput = useRef<HTMLInputElement>(null)
  const controller = useRef<AbortController>()
  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => {
    if (create || repository) {
      formInput.current?.focus({ preventScroll: true })
    }
  }, [create, repository])
  useEffect(() => {
    void refreshWorkspaces().catch(() => setNotice('projectSaveFailed'))
  }, [linked])
  const panel = useOptionPanel(t('projectChoose'), {
    kind: 'compact-choices',
    side: 'top',
    align: 'start',
    editorRef,
    disabled: busy,
    measureKey: create ? 'new' : repository ? 'repository' : undefined,
    onClose: () => {
      setCreate(false)
      setRepository(false)
    },
  })
  const open = items.find(({ id }) => id === page)
  const select = async (id: string | undefined) => {
    if (await bindWorkspace(sessionId, id)) {
      panel.close()
      setNotice(id ? undefined : 'projectUnlinked')
      return true
    }
    setNotice('projectSaveFailed')
    return false
  }
  const load = async (make: (signal: AbortSignal) => Promise<Workspace | undefined>) => {
    if (controller.current || busy) {
      return
    }
    const abort = new AbortController()
    controller.current = abort
    setWorking(true)
    setNotice(undefined)
    setProgress(undefined)
    try {
      const workspace = await make(abort.signal)
      abort.signal.throwIfAborted()
      if (workspace && (await select(workspace.id))) {
        setPage(workspace.id)
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        const reason =
          error instanceof ProjectSourceError
            ? error.reason
            : error instanceof WorkspaceBackupLimit
              ? 'backup-limit'
              : 'read'
        const notices = {
          limits: 'projectSourceLimits',
          encoding: 'projectSourceEncoding',
          paths: 'projectSourcePaths',
          'backup-limit': 'projectBackupImportLarge',
          read: 'projectImportFailed',
        } as const
        logEvent('storage', 'workspace.import-failed', { reason }, 'warn')
        setNotice(notices[reason])
      }
    } finally {
      controller.current = undefined
      setWorking(false)
      setProgress(undefined)
    }
  }
  const reportProgress = (done: number, total: number) => setProgress({ done, total })
  const importFile = (file: File) =>
    load(async (signal) => {
      if (/\.json$/i.test(file.name)) {
        return importWorkspaceBackup(file, signal)
      }
      const files = await openProjectArchive(file, signal, workspaceLimits, reportProgress)
      return createWorkspace(file.name.replace(/\.zip$/i, ''), files, undefined, signal)
    })
  const beforeOpen = panel.trigger.onClick
  return (
    <div className={styles.entry}>
      <input
        ref={input}
        type="file"
        hidden
        data-testid="workspace-file-import"
        accept=".zip,.json"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) {
            void importFile(file)
          }
        }}
      />
      <button
        {...panel.trigger}
        type="button"
        ref={panel.anchorRef}
        className={styles.pill}
        data-testid="workspace-trigger"
        data-linked={!!linked}
        disabled={busy}
        aria-label={active ? t('projectLinked', { name: active.name }) : t('projectChoose')}
        onClick={() => {
          if (!panel.open) {
            setNotice(undefined)
            void refreshWorkspaces().catch(() => setNotice('projectSaveFailed'))
          }
          beforeOpen()
        }}
      >
        <IconFileOutline16 />
        <span className={styles.ellipsis}>{active?.name ?? t('projectPicker')}</span>
        <IconChevronDownOutline14 />
      </button>
      {panel.render(
        <div className={styles.choices}>
          {linked && !active && <p className={styles.note}>{t('projectMissing')}</p>}
          {items.map((item) => (
            <button
              key={item.id}
              className={styles.choice}
              data-panel-item=""
              type="button"
              aria-label={item.id === linked ? t('projectManage') + ' ' + item.name : item.name}
              aria-selected={item.id === linked}
              disabled={working}
              onClick={() => {
                if (item.id === linked) {
                  panel.close()
                  setPage(item.id)
                } else {
                  void select(item.id)
                }
              }}
            >
              <IconFileOutline16 />
              <span className={styles.ellipsis}>{item.name}</span>
            </button>
          ))}
          <div className={items.length ? styles.choiceGroup : undefined}>
            {create ? (
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault()
                  void load((signal) =>
                    createWorkspace(name.trim() || t('projectDefaultName'), [], undefined, signal)
                  )
                }}
              >
                <input
                  data-panel-input=""
                  ref={formInput}
                  className={styles.field}
                  value={name}
                  maxLength={80}
                  aria-label={t('projectName')}
                  placeholder={t('projectName')}
                  onChange={(event) => setName(event.target.value)}
                />
                <Button type="submit" size="s" disabled={working}>
                  {t('projectCreate')}
                </Button>
              </form>
            ) : (
              <button
                className={styles.choice}
                data-panel-item=""
                type="button"
                disabled={working}
                onClick={() => {
                  setRepository(false)
                  setCreate(true)
                }}
              >
                {t('projectNew')}
              </button>
            )}
            <button
              className={styles.choice}
              data-panel-item=""
              type="button"
              disabled={working}
              onClick={() => input.current?.click()}
            >
              {t('projectImport')}
            </button>
            {workspaceDeviceFiles() && (
              <>
                <button
                  className={styles.choice}
                  data-panel-item=""
                  type="button"
                  disabled={working}
                  onClick={() =>
                    void load((signal) =>
                      importWorkspaceFolder(t('projectDefaultName'), signal, reportProgress)
                    )
                  }
                >
                  {t('projectImportFolder')}
                </button>
                {repository ? (
                  <form
                    className={styles.form}
                    onSubmit={(event) => {
                      event.preventDefault()
                      void load((signal) =>
                        importGithubWorkspace(repoUrl, repoRef, signal, reportProgress)
                      )
                    }}
                  >
                    <input
                      data-panel-input=""
                      ref={formInput}
                      className={styles.field}
                      type="url"
                      required
                      value={repoUrl}
                      onChange={(event) => setRepoUrl(event.target.value)}
                      aria-label={t('projectRepoUrl')}
                      placeholder={t('projectRepoUrl')}
                    />
                    <input
                      className={styles.field}
                      value={repoRef}
                      maxLength={110}
                      onChange={(event) => setRepoRef(event.target.value)}
                      aria-label={t('projectRepoRef')}
                      placeholder={t('projectRepoRef')}
                    />
                    <Button type="submit" size="s" disabled={working || !repoUrl.trim()}>
                      {t('projectImportRepo')}
                    </Button>
                  </form>
                ) : (
                  <button
                    className={styles.choice}
                    data-panel-item=""
                    type="button"
                    disabled={working}
                    onClick={() => {
                      setCreate(false)
                      setRepository(true)
                    }}
                  >
                    {t('projectImportRepo')}
                  </button>
                )}
              </>
            )}
            {legacy?.role === 'assistant' && legacy.task?.project?.length ? (
              <button
                className={styles.choice}
                data-panel-item=""
                type="button"
                disabled={working}
                onClick={() =>
                  void load((signal) =>
                    createWorkspace(
                      t('projectDefaultName'),
                      legacy.task?.project,
                      undefined,
                      signal
                    )
                  )
                }
              >
                {t('projectRecover')}
              </button>
            ) : null}
            {linked && (
              <button
                className={styles.choice}
                data-panel-item=""
                type="button"
                disabled={working}
                onClick={() => void select(undefined)}
              >
                {t('projectDetach')}
              </button>
            )}
          </div>
          {working && (
            <div className={styles.form} role="status">
              <span>{progress ? t('projectImportProgress', progress) : t('projectImporting')}</span>
              <Button variant="outlined" size="s" onClick={() => controller.current?.abort()}>
                {t('cancel')}
              </Button>
            </div>
          )}
          {notice && (
            <p className={styles.note} role="status">
              {t(notice)}
            </p>
          )}
        </div>
      )}
      {!panel.open && notice && (
        <div className={styles.compactNote} role="status">
          {t(notice)}
        </div>
      )}
      {open && (
        <Suspense fallback={null}>
          <WorkspacePage key={open.id} workspace={open} close={() => setPage(undefined)} />
        </Suspense>
      )}
    </div>
  )
}
