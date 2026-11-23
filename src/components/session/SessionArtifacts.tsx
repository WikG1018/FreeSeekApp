import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslate, type TranslationMessage } from '../../i18n/index.js'
import { addDraftFiles } from '../../services/chat/drafts.js'
import { useProviders } from '../../services/providers.js'
import { showToast } from '../base/toastState.js'
import { loadBackupFile } from '../../services/chat/store.js'
import { diagnosticError, logEvent } from '../../services/diagnostics/log.js'
import { saveBackup } from '../../services/saveBackup.js'
import { useSettings } from '../../services/settings.js'
import { taskFileKind, taskFileLabel } from '../../services/tasks/artifacts.js'
import { DocumentPreviewError } from '../../services/tasks/documentPreview.js'
import type { ArtifactReading } from '../../services/tasks/preview.js'
import {
  openTaskOriginal,
  shareTaskOutput,
  type SessionArtifact,
} from '../../services/tasks/sessionArtifacts.js'
import { Button } from '../base/Button.js'
import {
  IconChevronLeftOutline16,
  IconDownloadOutline16,
  IconEllipsisOutline16,
  IconFileOutline16,
  IconSearchOutline16,
  IconShareOutline16,
} from '../base/icons.js'
import { Modal, closeTopModal } from '../base/Modal.js'
import { useOptionPanel } from '../base/OptionPanel.js'
import optionStyles from '../base/OptionPanel.module.css'
import { ArtifactReader } from './ArtifactReader.js'
import { useChatMode, useSessionAgent } from './SessionAssistant.js'
import styles from './SessionArtifacts.module.css'

export const ArtifactMeta = ({ file }: { file: SessionArtifact }) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const date = new Date(file.createdAt)
  const today = new Date()
  const dateTime = Number.isFinite(date.getTime()) ? date.toISOString() : undefined
  const displayTime =
    dateTime &&
    date.toLocaleString(
      locale,
      date.toDateString() === today.toDateString()
        ? { hour: '2-digit', minute: '2-digit' }
        : {
            month: 'numeric',
            day: 'numeric',
            ...(date.getFullYear() !== today.getFullYear() && { year: 'numeric' }),
          }
    )
  return (
    <span className={styles.meta}>
      {file.round && (
        <span className={styles.round}>{t('agentConversationRound', { round: file.round })}</span>
      )}
      <span>{taskFileLabel(file.name)}</span>
      <span>{Math.max(1, Math.ceil(file.size / 1024))} KB</span>
      {displayTime && (
        <time dateTime={dateTime} title={date.toLocaleString(locale)}>
          {displayTime}
        </time>
      )}
    </span>
  )
}

export const ArtifactPreview = ({
  file,
  sessionId,
  back,
  close,
}: {
  file: SessionArtifact
  sessionId: string
  back?: () => void
  close: () => void
}) => {
  const t = useTranslate()
  const [revision, setRevision] = useState(0)
  const [blob, setBlob] = useState<Blob>()
  const [preview, setPreview] = useState<ArtifactReading>()
  const [loading, setLoading] = useState(true)
  const [textOnly, setTextOnly] = useState(false)
  const hasTextMode = taskFileKind(file.name) === 'docx'
  const [readError, setReadError] = useState<TranslationMessage['key']>()
  const [pending, setPending] = useState<'save' | 'share' | 'open'>()
  const lock = useRef(false)
  const [notice, setNotice] = useState<TranslationMessage & { error?: boolean }>()
  const ending = /(?:[_ -]v\d+(?:\.\d+){0,2})?\.[a-z0-9]{1,8}$/i.exec(file.name)
  const suffix = ending && ending.index > 0 ? ending[0] : ''
  const agent = useSessionAgent(sessionId)
  const mode = useChatMode(sessionId)
  const attachmentsAllowed = useSettings((state) => mode !== 'agent' || state.agentTools.attachment)
  const actions = useOptionPanel(t('more'), {
    kind: 'compact-choices',
    align: 'end',
    disabled: !!pending,
  })

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    let closeDocument: (() => void) | undefined
    setPreview(undefined)
    setReadError(undefined)
    setLoading(true)
    void (async () => {
      let hasFile = false
      try {
        const next = await loadBackupFile(file.id)
        signal.throwIfAborted()
        if (!next || next.size !== file.size) {
          throw new Error('Task file is missing')
        }
        hasFile = true
        setBlob(next)
        const { readArtifact } = await import('../../services/tasks/preview.js')
        const value = await readArtifact(file, next, signal, textOnly)
        if (value.kind === 'pages') {
          if (signal.aborted) {
            value.document.close()
          } else {
            closeDocument = value.document.close
          }
        }
        if (!signal.aborted) {
          setPreview(value)
        }
      } catch (error) {
        if (!signal.aborted) {
          setReadError(
            !hasFile
              ? 'taskFileMissing'
              : error instanceof DocumentPreviewError && error.reason === 'password'
                ? 'readerPassword'
                : error instanceof DocumentPreviewError && error.reason === 'limit'
                  ? 'readerFileTooLarge'
                  : 'taskFilePreviewFailed'
          )
          logEvent(
            'chat',
            'task.file-preview.failed',
            { hasFile, ...diagnosticError(error) },
            'warn'
          )
        }
      } finally {
        if (!signal.aborted) {
          setLoading(false)
        }
      }
    })()
    return () => {
      controller.abort()
      closeDocument?.()
    }
  }, [file, revision, textOnly])

  const act = async (action: 'save' | 'share' | 'open') => {
    if (!blob || lock.current) {
      return
    }
    lock.current = true
    setPending(action)
    setNotice(undefined)
    try {
      if (action === 'save') {
        if (await saveBackup(file.name, blob, 'chat')) {
          setNotice({ key: 'taskOutputSaved' })
        }
      } else if (action === 'open') {
        await openTaskOriginal(file.name, blob)
      } else {
        const result = await shareTaskOutput(file.name, blob)
        const keys = {
          opened: 'taskFileShareOpened',
          copied: 'taskFileCopied',
          unavailable: 'taskFileShareUnavailable',
        } as const
        if (result !== 'cancelled') {
          setNotice({ key: keys[result] })
        }
      }
    } catch (error) {
      setNotice({
        key:
          action === 'save'
            ? 'taskOutputSaveFailed'
            : action === 'open'
              ? 'readerOpenFailed'
              : 'taskFileShareFailed',
        error: true,
      })
      logEvent('chat', 'task.file-action.failed', { action, ...diagnosticError(error) }, 'warn')
    } finally {
      lock.current = false
      setPending(undefined)
    }
  }
  const reuse = () => {
    if (!blob || lock.current || !attachmentsAllowed || agent?.attachments === false) {
      return
    }
    const error = addDraftFiles(sessionId, [new File([blob], file.name, { type: blob.type })], '', {
      selection: agent?.model ?? useProviders.getState().selection,
      deferUpload: true,
    })
    if (error) {
      setNotice({ ...error, error: true })
      return
    }
    close()
    showToast({ key: 'agentFileReused' })
  }
  const feedback =
    pending === 'share'
      ? t('taskFileSharing')
      : pending === 'save'
        ? t('taskOutputSaving')
        : pending === 'open'
          ? t('readerOpening')
          : notice && t(notice.key, notice.params)

  return (
    <Modal
      title={
        <div className={styles.readerHeader}>
          <button
            type="button"
            className={styles.readerBack}
            aria-label={t(back ? 'taskFileBack' : 'agentFileBackChat')}
            disabled={!!pending}
            onClick={closeTopModal}
          >
            <IconChevronLeftOutline16 />
          </button>
          <div className={styles.detailTitle}>
            <strong
              className={styles.fileName}
              title={file.name}
              tabIndex={-1}
              data-modal-initial-focus=""
            >
              <span>{file.name.slice(0, file.name.length - suffix.length)}</span>
              {suffix && <span>{suffix}</span>}
            </strong>
            <ArtifactMeta file={file} />
          </div>
          <button
            type="button"
            className={styles.readerBack}
            aria-label={t('more')}
            disabled={!!pending || !blob}
            ref={actions.anchorRef}
            {...actions.trigger}
          >
            <IconEllipsisOutline16 />
          </button>
        </div>
      }
      ariaLabel={t('taskFilePreview', { name: file.name })}
      className={styles.readerPanel}
      titleClassName={styles.readerTitle}
      mainClassName={styles.readerMain}
      dismissible={!pending}
      onClose={back ?? close}
      footer={
        <div className={styles.detailFooter}>
          {feedback && (
            <p
              className={styles.feedback}
              role={notice?.error ? 'alert' : 'status'}
              data-error={notice?.error}
            >
              {feedback}
            </p>
          )}
          <div className={styles.detailActions}>
            <Button
              size="m"
              variant="outlined"
              disabled={!blob || !!pending}
              onClick={() => void act('share')}
            >
              <IconShareOutline16 />
              <span>{t('taskFileShare')}</span>
            </Button>
            <Button size="m" disabled={!blob || !!pending} onClick={() => void act('save')}>
              <IconDownloadOutline16 />
              <span>{t('agentArtifactSaveOriginal')}</span>
            </Button>
          </div>
        </div>
      }
    >
      {actions.render(
        <>
          <button
            type="button"
            className={optionStyles.option}
            data-panel-item=""
            onClick={() => {
              actions.close(true)
              void act('open')
            }}
          >
            {t('readerOpenOriginal')}
          </button>
          {hasTextMode && (
            <button
              type="button"
              className={optionStyles.option}
              data-panel-item=""
              onClick={() => {
                actions.close(true)
                setTextOnly((previous) => !previous)
              }}
            >
              {t(textOnly ? 'readerLayoutMode' : 'readerTextMode')}
            </button>
          )}
          {attachmentsAllowed && agent?.attachments !== false && (
            <button
              type="button"
              className={optionStyles.option}
              data-panel-item=""
              onClick={() => {
                actions.close(true)
                reuse()
              }}
            >
              {t('agentFileReuse')}
            </button>
          )}
        </>
      )}
      {preview ? (
        <ArtifactReader value={preview} fileId={file.id} fileName={file.name} />
      ) : loading ? (
        <p className={styles.feedback} role="status">
          {t('taskFileLoading')}
        </p>
      ) : (
        readError && (
          <>
            <p className={styles.feedback} role="alert" data-error="true">
              {t(readError)}
            </p>
            <Button
              variant="outlined"
              onClick={() => {
                setLoading(true)
                setReadError(undefined)
                setRevision((value) => value + 1)
              }}
            >
              {t('retry')}
            </Button>
            {blob && (
              <Button variant="outlined" onClick={() => void act('open')}>
                {t('readerOpenOriginal')}
              </Button>
            )}
          </>
        )
      )}
    </Modal>
  )
}

export const SessionArtifactsButton = ({
  files,
  sessionId,
}: {
  files: SessionArtifact[]
  sessionId: string
}) => {
  const t = useTranslate()
  const panel = useOptionPanel(t('taskFilesTitle'), {
    kind: 'artifacts',
    align: 'end',
    focusFirst: false,
  })
  const [selected, setSelected] = useState<SessionArtifact>()
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const restore = useRef<{ id: string; scrollTop: number }>()
  const needle = query.trim().toLocaleLowerCase()
  const condensedNeedle = needle.replace(/\s/g, '')
  const results = needle
    ? files.filter(
        ({ name, round }) =>
          name.toLocaleLowerCase().includes(needle) ||
          (round !== undefined &&
            (String(round) === needle ||
              t('agentConversationRound', { round })
                .toLocaleLowerCase()
                .replace(/\s/g, '')
                .includes(condensedNeedle)))
      )
    : files
  useLayoutEffect(() => {
    const list = listRef.current
    if (panel.open && panel.positioned && list && restore.current) {
      list.scrollTop = restore.current.scrollTop
      Array.from(list.querySelectorAll<HTMLButtonElement>('[data-artifact-id]'))
        .find((button) => button.dataset.artifactId === restore.current?.id)
        ?.focus({ preventScroll: true })
      restore.current = undefined
    }
  }, [panel.open, panel.positioned])
  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        aria-label={t('taskFiles')}
        title={t('agentArtifactCount', { count: files.length })}
        ref={panel.anchorRef}
        {...panel.trigger}
        data-testid="session-artifacts-button"
      >
        <IconFileOutline16 />
        <span>{t('agentArtifactCount', { count: files.length })}</span>
      </button>
      {panel.open &&
        panel.render(
          <>
            <div className={styles.listHeading}>
              <strong>{t('taskFilesTitle')}</strong>
              <span>{files.length}</span>
            </div>
            {files.length > 6 && (
              <label className={optionStyles.filter}>
                <IconSearchOutline16 />
                <input
                  type="search"
                  value={query}
                  data-panel-input=""
                  aria-label={t('agentArtifactSearch')}
                  placeholder={t('agentArtifactSearch')}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    if (listRef.current) {
                      listRef.current.scrollTop = 0
                    }
                  }}
                />
              </label>
            )}
            <div
              ref={listRef}
              className={styles.listScroll}
              data-testid="agent-artifact-list"
              data-scroll-edge=""
            >
              {results.length > 0 ? (
                <ul className={styles.list} data-scroll-edge-content="">
                  {results.map((file) => (
                    <li key={file.id}>
                      <button
                        type="button"
                        className={styles.row}
                        data-artifact-id={file.id}
                        data-panel-item=""
                        aria-label={t('taskFilePreview', { name: file.name })}
                        onClick={() => {
                          restore.current = {
                            id: file.id,
                            scrollTop: listRef.current?.scrollTop ?? 0,
                          }
                          panel.close()
                          setSelected(file)
                        }}
                      >
                        <span className={styles.fileIcon} data-sheet={file.name.endsWith('.xlsx')}>
                          <IconFileOutline16 />
                        </span>
                        <span className={styles.fileInfo}>
                          <strong>{file.name}</strong>
                          <ArtifactMeta file={file} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.listEmpty} role="status">
                  {t('agentArtifactSearchEmpty')}
                </p>
              )}
            </div>
          </>
        )}
      {selected && (
        <ArtifactPreview
          key={selected.id}
          file={selected}
          sessionId={sessionId}
          back={() => {
            setSelected(undefined)
            panel.show()
          }}
          close={() => {
            restore.current = undefined
            setSelected(undefined)
          }}
        />
      )}
    </>
  )
}
