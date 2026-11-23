import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { saveBackup } from '../../services/saveBackup.js'
import { taskFileName } from '../../services/tasks/artifacts.js'
import {
  exportProjectArchive,
  type ProjectFile,
  type SourceProject,
} from '../../services/tasks/projectFiles.js'
import {
  exportWorkspaceBackup,
  getWorkspaceRevision,
  readWorkspace,
  WorkspaceBackupLimit,
  undoWorkspaceRevision,
  WorkspaceConflict,
  workspaceRevisions,
  type Workspace,
  type WorkspaceChange,
  type WorkspaceRevision,
  type WorkspaceRevisionSummary,
} from '../../services/tasks/workspaces.js'
import { exportWorkspaceDiff, workspaceDiff } from '../../services/tasks/workspaceDiff.js'
import {
  openWorkspacePreview,
  workspaceDeviceFiles,
} from '../../services/tasks/workspacePlatform.js'
import { Button } from '../base/Button.js'
import {
  IconChevronDownOutline14,
  IconChevronLeftOutline16,
  IconFileOutline16,
} from '../base/icons.js'
import { Modal, closeTopModal } from '../base/Modal.js'
import readerStyles from './SessionArtifacts.module.css'
import styles from './Workspace.module.css'

const kindKey = {
  patch: 'projectChangePatch',
  import: 'projectChangeImport',
  restore: 'projectChangeRestore',
} as const

const SourceFile = ({ file, files }: { file: ProjectFile; files: SourceProject }) => {
  const t = useTranslate()
  const [page, setPage] = useState(0)
  const [result, setResult] = useState<{ success: boolean; text: string }>()
  const [running, setRunning] = useState(false)
  const [previewError, setPreviewError] = useState(false)
  const [openingPreview, setOpeningPreview] = useState(false)
  const abort = useRef<AbortController>()
  useEffect(() => () => abort.current?.abort(), [])
  const lines = useMemo(() => file.text.split(/\r?\n/), [file.text])
  const pageSize = 150
  const start = Math.min(page * pageSize, Math.floor((lines.length - 1) / pageSize) * pageSize)
  return (
    <div className={styles.source}>
      <CodeLines lines={lines.slice(start, start + pageSize)} start={start + 1} />
      {lines.length > pageSize && (
        <div className={styles.pages}>
          <Button
            variant="outlined"
            size="s"
            disabled={!start}
            onClick={() => setPage(Math.max(0, start / pageSize - 1))}
          >
            {t('projectShowPrevious')}
          </Button>
          <span>
            {start + 1}–{Math.min(start + pageSize, lines.length)} / {lines.length}
          </span>
          <Button
            variant="outlined"
            size="s"
            disabled={start + pageSize >= lines.length}
            onClick={() => setPage(start / pageSize + 1)}
          >
            {t('projectShowLater')}
          </Button>
        </div>
      )}
      {/\.(?:js|mjs)$/i.test(file.path) && (
        <Button
          size="s"
          variant="outlined"
          disabled={running}
          onClick={async () => {
            abort.current?.abort()
            const controller = new AbortController()
            abort.current = controller
            setRunning(true)
            setResult(undefined)
            try {
              const { runProjectScript } = await import('../../services/tasks/projectScript.js')
              const finished = await runProjectScript(files, file.path, controller.signal)
              if (!controller.signal.aborted) {
                setResult(finished)
              }
            } catch {
              if (!controller.signal.aborted) {
                setResult({ success: false, text: '' })
              }
            } finally {
              if (!controller.signal.aborted) {
                setRunning(false)
              }
            }
          }}
        >
          {t(running ? 'taskWorking' : 'projectPreviewScript')}
        </Button>
      )}
      {result && (
        <div className={styles.scriptResult} role="status">
          <strong>{t(result.success ? 'projectRunPassed' : 'projectRunFailed')}</strong>
          {result.text && <pre>{result.text}</pre>}
        </div>
      )}
      {/\.html$/i.test(file.path) && workspaceDeviceFiles() && (
        <>
          <Button
            size="s"
            variant="outlined"
            disabled={openingPreview}
            onClick={async () => {
              setPreviewError(false)
              setOpeningPreview(true)
              try {
                await openWorkspacePreview(files, file.path, {
                  label: t('projectPreviewWeb'),
                  back: t('agentFileBackChat'),
                  loading: t('taskFileLoading'),
                  failed: t('taskFilePreviewFailed'),
                  dark: document.body.hasAttribute('data-ds-dark-theme'),
                })
              } catch {
                setPreviewError(true)
              } finally {
                setOpeningPreview(false)
              }
            }}
          >
            {t(openingPreview ? 'taskFileLoading' : 'projectPreviewWeb')}
          </Button>
          {previewError && (
            <p className={styles.note} role="alert">
              {t('taskFilePreviewFailed')}
            </p>
          )}
        </>
      )}
    </div>
  )
}

const CodeLines = ({
  lines,
  start,
  previous,
}: {
  lines: string[]
  start: number
  previous?: number
}) => {
  const diff = previous !== undefined
  let oldLine = previous ?? 0
  let newLine = start
  return (
    <pre className={styles.code}>
      {lines.map((line, index) => {
        const marker = diff ? line[0] : undefined
        const oldNumber = diff && (marker === '-' || marker === ' ') ? oldLine++ : undefined
        const newNumber = !diff || marker === '+' || marker === ' ' ? newLine++ : undefined
        return (
          <span
            key={index}
            className={styles.codeLine}
            data-tone={marker}
            data-side-numbers={diff ? '' : undefined}
          >
            {diff && (
              <span className={styles.lineNumber} aria-hidden="true">
                {oldNumber}
              </span>
            )}
            <span className={styles.lineNumber} aria-hidden="true">
              {newNumber}
            </span>
            <code>{line || ' '}</code>
          </span>
        )
      })}
    </pre>
  )
}

const FileChange = ({ change }: { change: WorkspaceChange }) => {
  const t = useTranslate()
  const diff = useMemo(() => workspaceDiff(change), [change])
  return diff && diff.hunks.reduce((n, hunk) => n + hunk.lines.length, 0) <= 750 ? (
    <div className={styles.diff}>
      {diff.hunks.map((hunk, index) => (
        <div key={index}>
          <div className={styles.hunk}>
            @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
          </div>
          <CodeLines lines={hunk.lines} start={hunk.newStart} previous={hunk.oldStart} />
        </div>
      ))}
    </div>
  ) : (
    <p className={styles.note}>{t('projectDiffLarge')}</p>
  )
}

export const WorkspacePage = ({
  workspace,
  close,
}: {
  workspace: Workspace
  close: () => void
}) => {
  const t = useTranslate()
  const [tab, setTab] = useState<'files' | 'changes'>('files')
  const [files, setFiles] = useState<SourceProject>()
  const [revisions, setRevisions] = useState<WorkspaceRevisionSummary[]>([])
  const [detail, setDetail] = useState<WorkspaceRevision>()
  const [limit, setLimit] = useState(12)
  const [query, setQuery] = useState('')
  const [openFile, setOpenFile] = useState<string>()
  const [openChange, setOpenChange] = useState<number>()
  const [openDiff, setOpenDiff] = useState<string>()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<TranslationKey>()
  useEffect(() => {
    let active = true
    void Promise.all([readWorkspace(workspace.id), workspaceRevisions(workspace.id, limit + 1)])
      .then(([data, history]) => {
        if (active) {
          setFiles(data?.files ?? [])
          setRevisions(history)
          if (!data) {
            setNotice('projectMissing')
          }
        }
      })
      .catch(() => {
        if (active) {
          setNotice('projectSaveFailed')
        }
      })
    return () => {
      active = false
    }
  }, [workspace.id, workspace.revision, limit])
  useEffect(() => {
    if (openChange === undefined) {
      return
    }
    let active = true
    void getWorkspaceRevision(workspace.id, openChange)
      .then((revision) => {
        if (!revision) {
          throw new Error('Project revision missing')
        }
        if (active) {
          setDetail(revision)
        }
      })
      .catch(() => {
        if (active) {
          setNotice('projectSaveFailed')
          setOpenChange(undefined)
        }
      })
    return () => {
      active = false
    }
  }, [workspace.id, openChange])
  const current = detail?.revision === openChange ? detail : undefined
  const matches = files?.filter(({ path }) =>
    path.toLowerCase().includes(query.trim().toLowerCase())
  )
  const perform = async (action: () => Promise<boolean>, success: TranslationKey) => {
    setBusy(true)
    setNotice(undefined)
    try {
      if (await action()) {
        setNotice(success)
      }
    } catch (error) {
      setNotice(
        error instanceof WorkspaceConflict
          ? 'projectOldVersion'
          : error instanceof WorkspaceBackupLimit
            ? 'projectBackupLarge'
            : 'projectSaveFailed'
      )
    } finally {
      setBusy(false)
    }
  }
  const switchTab = (next: typeof tab) => {
    setConfirm(false)
    setTab(next)
  }
  return (
    <Modal
      ariaLabel={workspace.name}
      onClose={close}
      dismissible={!busy}
      className={readerStyles.readerPanel}
      mainClassName={readerStyles.readerMain}
      titleClassName={readerStyles.readerTitle}
      title={
        <div className={styles.header}>
          <button
            className={readerStyles.readerBack}
            aria-label={t('agentFileBackChat')}
            disabled={busy}
            type="button"
            onClick={closeTopModal}
          >
            <IconChevronLeftOutline16 />
          </button>
          <div className={styles.titleText}>
            <strong data-modal-initial-focus="" tabIndex={-1}>
              {workspace.name}
            </strong>
            <small>
              {workspace.source
                ? t('projectFromRepository', {
                    repository: workspace.source.repository,
                    revision: workspace.source.revision.slice(0, 7),
                  })
                : t(workspace.fileCount === 1 ? 'projectSingleFile' : 'projectCount', {
                    count: workspace.fileCount,
                  }) +
                  ' · ' +
                  t('projectVersion', { revision: workspace.revision })}
            </small>
          </div>
        </div>
      }
      footer={
        <div className={styles.footer}>
          {notice && (
            <div className={styles.note} role="status">
              {t(notice)}
            </div>
          )}
          <div className={styles.footerActions}>
            <Button
              size="s"
              variant="outlined"
              disabled={busy || !files}
              onClick={() =>
                void perform(async () => {
                  const file = await exportWorkspaceBackup(workspace.id)
                  const name = taskFileName(
                    t('projectBackupFilename', { name: workspace.name.slice(0, 64) }),
                    'json'
                  )
                  return saveBackup(name, file, 'chat')
                }, 'projectSaved')
              }
            >
              {t('projectExportBackup')}
            </Button>
            <Button
              size="s"
              disabled={busy || !files?.length}
              onClick={() =>
                void perform(async () => {
                  const data = await readWorkspace(workspace.id)
                  if (!data) {
                    throw new Error('Project missing')
                  }
                  const file = exportProjectArchive(workspace.name, data.files)
                  return saveBackup(file.name, file.blob, 'chat')
                }, 'projectSaved')
              }
            >
              {t('projectExportSource')}
            </Button>
          </div>
        </div>
      }
    >
      <div className={styles.page}>
        <div className={styles.tabs} role="group" aria-label={t('projectPicker')}>
          <button type="button" aria-pressed={tab === 'files'} onClick={() => switchTab('files')}>
            {t('projectFilesTab')}
          </button>
          <button
            type="button"
            aria-pressed={tab === 'changes'}
            onClick={() => switchTab('changes')}
          >
            {t('projectChangesTab')}
          </button>
        </div>
        {tab === 'files' && files && files.length > 5 && (
          <input
            className={styles.field}
            type="search"
            aria-label={t('projectSearchFiles')}
            placeholder={t('projectSearchFiles')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
        <div className={styles.scroll} data-scroll-edge="" key={tab}>
          <div data-scroll-edge-content="">
            {!files && !notice && (
              <p className={styles.note} role="status">
                {t('taskFileLoading')}
              </p>
            )}
            {tab === 'files' ? (
              <div className={styles.rows}>
                {!!files && !matches?.length && (
                  <p className={styles.note}>
                    {t(files.length ? 'projectNoMatches' : 'projectNoFiles')}
                  </p>
                )}
                {matches?.map((file) => (
                  <div key={file.path}>
                    <button
                      type="button"
                      className={styles.row}
                      aria-expanded={openFile === file.path}
                      onClick={() => setOpenFile(openFile === file.path ? undefined : file.path)}
                    >
                      <IconFileOutline16 />
                      <span className={styles.ellipsis}>{file.path}</span>
                      <IconChevronDownOutline14 />
                    </button>
                    {openFile === file.path && files && <SourceFile file={file} files={files} />}
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.rows}>
                {files && !revisions.length && (
                  <p className={styles.note}>{t('projectNoChanges')}</p>
                )}
                {revisions.slice(0, limit).map((revision) => (
                  <div key={revision.revision}>
                    <button
                      type="button"
                      className={styles.row}
                      aria-expanded={revision.revision === openChange}
                      onClick={() => {
                        setOpenChange(
                          revision.revision === openChange ? undefined : revision.revision
                        )
                        setDetail(undefined)
                        setOpenDiff(undefined)
                        setConfirm(false)
                        setNotice(undefined)
                      }}
                    >
                      <span className={styles.revision}>
                        <strong>{t(kindKey[revision.kind])}</strong>
                        <small>
                          {t('projectVersion', { revision: revision.revision })} ·{' '}
                          {t('projectChanged', { count: revision.fileCount })}
                        </small>
                      </span>
                      <IconChevronDownOutline14 />
                    </button>
                    {revision.revision === openChange && !current && (
                      <p className={styles.note} role="status">
                        {t('taskFileLoading')}
                      </p>
                    )}
                    {current?.revision === revision.revision && (
                      <div className={styles.changeBody}>
                        {current.changes.map((change) => (
                          <div key={change.path}>
                            <button
                              className={styles.row}
                              type="button"
                              aria-expanded={openDiff === change.path}
                              onClick={() =>
                                setOpenDiff(openDiff === change.path ? undefined : change.path)
                              }
                            >
                              <span className={styles.ellipsis}>{change.path}</span>
                              <small
                                data-change={
                                  change.before === null
                                    ? 'added'
                                    : change.after === null
                                      ? 'removed'
                                      : 'updated'
                                }
                              >
                                {t(
                                  change.before === null
                                    ? 'projectAdded'
                                    : change.after === null
                                      ? 'projectDeleted'
                                      : 'projectUpdated'
                                )}
                              </small>
                              <IconChevronDownOutline14 />
                            </button>
                            {openDiff === change.path && <FileChange change={change} />}
                          </div>
                        ))}
                        {confirm && <p className={styles.note}>{t('projectConfirmUndo')}</p>}
                        <div className={styles.changeActions}>
                          <Button
                            size="s"
                            variant="outlined"
                            disabled={busy}
                            onClick={() =>
                              void perform(() => {
                                const patch = exportWorkspaceDiff(workspace.name, current.changes)
                                return saveBackup(patch.name, patch.blob, 'chat')
                              }, 'projectSaved')
                            }
                          >
                            {t('projectExportDiff')}
                          </Button>
                          <Button
                            size="s"
                            variant="outlined"
                            disabled={busy}
                            onClick={() => {
                              if (!confirm) {
                                setConfirm(true)
                                return
                              }
                              setConfirm(false)
                              void perform(async () => {
                                await undoWorkspaceRevision(
                                  workspace.id,
                                  workspace.revision,
                                  current
                                )
                                return true
                              }, 'projectUndoDone')
                            }}
                          >
                            {t(confirm ? 'confirm' : 'projectUndo')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {revisions.length > limit && (
                  <Button variant="outlined" size="s" onClick={() => setLimit(limit + 12)}>
                    {t('projectShowEarlier')}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}
