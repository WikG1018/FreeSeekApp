import { useEffect, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { openBrowserPreview, readerDocument } from '../../services/tasks/browser.js'
import type { BrowserPage } from '../../services/tasks/browserDocument.js'
import { openExternal } from '../../utils/openExternal.js'
import { saveBackup } from '../../services/saveBackup.js'
import { captureReader, workspaceDeviceFiles } from '../../services/tasks/workspacePlatform.js'
import { Button } from '../base/Button.js'
import { Modal, closeTopModal } from '../base/Modal.js'
import styles from './AssistantTask.module.css'

export const TaskBrowserViewer = ({ source, close }: { source: string; close: () => void }) => {
  const t = useTranslate()
  const [trail, setTrail] = useState({ urls: [source], index: 0 })
  const [page, setPage] = useState<BrowserPage>()
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  const [query, setQuery] = useState('')
  const [matchCount, setMatchCount] = useState<number>()
  const [capturing, setCapturing] = useState(false)
  const [notice, setNotice] = useState<TranslationKey>()
  const frame = useRef<HTMLIFrameElement>(null)
  const match = useRef(-1)
  const address = trail.urls[trail.index] ?? source
  const dark = document.body.hasAttribute('data-ds-dark-theme')

  useEffect(() => {
    const controller = new AbortController()
    setPage(undefined)
    setFailed(false)
    setMatchCount(undefined)
    setNotice(undefined)
    match.current = -1
    void openBrowserPreview(address, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) {
          return
        }
        if ('page' in result && result.page && (result.page.text || result.page.links.length)) {
          setPage(result.page)
        } else {
          setFailed(true)
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setFailed(true)
        }
      }
    )
    return () => controller.abort()
  }, [address, revision])

  const setPageLinks = (frame: HTMLIFrameElement) => {
    const doc = frame.contentDocument
    if (!doc || !page) {
      return
    }
    doc.querySelectorAll('[data-link]').forEach((element) => {
      const link = page.links.find(({ id }) => String(id) === element.getAttribute('data-link'))
      if (!link) {
        return
      }
      element.setAttribute('role', 'link')
      element.setAttribute('tabindex', '0')
      const follow = () =>
        setTrail((previous) => {
          const urls = [...previous.urls.slice(0, previous.index + 1), link.url].slice(-12)
          return { urls, index: urls.length - 1 }
        })
      element.addEventListener('click', follow)
      element.addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Enter') {
          follow()
        }
      })
    })
    doc.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeTopModal()
      }
    })
  }

  const find = () => {
    const doc = frame.current?.contentDocument
    const target = query.trim()
    if (!doc?.body || !target) {
      return
    }
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    const expression = new RegExp(target.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'), 'giu')
    const entries: { node: Node; offset: number; length: number }[] = []
    let node = walker.nextNode()
    while (node && entries.length < 240) {
      const text = node.textContent ?? ''
      expression.lastIndex = 0
      let found = expression.exec(text)
      while (found && entries.length < 240) {
        entries.push({ node, offset: found.index, length: found[0].length })
        found = expression.exec(text)
      }
      node = walker.nextNode()
    }
    setMatchCount(entries.length)
    if (!entries.length) {
      return
    }
    match.current = (match.current + 1) % entries.length
    const entry = entries[match.current]
    const range = doc.createRange()
    range.setStart(entry.node, entry.offset)
    range.setEnd(entry.node, entry.offset + entry.length)
    const selection = doc.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    entry.node.parentElement?.scrollIntoView({ block: 'center' })
  }
  const screenshot = async () => {
    if (!frame.current || capturing) {
      return
    }
    setCapturing(true)
    setNotice(undefined)
    try {
      const blob = await captureReader(frame.current.getBoundingClientRect())
      if (await saveBackup('freeseek-reader-' + Date.now() + '.png', blob, 'chat')) {
        setNotice('projectSaved')
      }
    } catch {
      setNotice('browserCaptureFailed')
    } finally {
      setCapturing(false)
    }
  }

  return (
    <Modal
      title={<span className={styles.browserTitle}>{page?.title ?? t('taskBrowser')}</span>}
      ariaLabel={t('taskBrowser')}
      className={styles.browserPanel}
      dismissible={!capturing}
      onClose={close}
      footer={
        <div className={styles.browserActions}>
          {trail.index > 0 && (
            <Button
              variant="outlined"
              onClick={() => setTrail((previous) => ({ ...previous, index: previous.index - 1 }))}
            >
              {t('taskBrowserBack')}
            </Button>
          )}
          {trail.index + 1 < trail.urls.length && (
            <Button
              variant="outlined"
              onClick={() => setTrail((previous) => ({ ...previous, index: previous.index + 1 }))}
            >
              {t('browserNextPage')}
            </Button>
          )}
          {page && workspaceDeviceFiles() && (
            <Button variant="outlined" disabled={capturing} onClick={() => void screenshot()}>
              {t('browserCapture')}
            </Button>
          )}
          <Button variant="outlined" onClick={() => void openExternal(page?.url ?? address)}>
            {t('taskBrowserOriginal')}
          </Button>
          <Button onClick={() => closeTopModal()}>{t('taskBrowserDone')}</Button>
        </div>
      }
    >
      <div className={styles.browserAddress} title={page?.url ?? address}>
        {page?.url ?? address}
      </div>
      {page && (
        <form
          className={styles.readerFind}
          onSubmit={(event) => {
            event.preventDefault()
            find()
          }}
        >
          <input
            type="search"
            value={query}
            maxLength={96}
            aria-label={t('browserFind')}
            placeholder={t('browserFind')}
            onChange={(event) => {
              setQuery(event.target.value)
              setMatchCount(undefined)
              match.current = -1
            }}
          />
          <Button variant="outlined" type="submit" size="s" disabled={!query.trim()}>
            {t('browserFindNext')}
          </Button>
        </form>
      )}
      {matchCount === 0 && (
        <div className={styles.browserAddress} role="status">
          {t('projectNoMatches')}
        </div>
      )}
      {notice && (
        <div className={styles.browserAddress} role="status">
          {t(notice)}
        </div>
      )}
      {page ? (
        <iframe
          ref={frame}
          className={styles.browserFrame}
          title={page.title}
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          srcDoc={readerDocument(page, dark)}
          onLoad={(event) => setPageLinks(event.currentTarget)}
        />
      ) : failed ? (
        <div className={styles.browserState} role="status">
          <p>{t('taskBrowserLoadError')}</p>
          <Button variant="outlined" onClick={() => setRevision((value) => value + 1)}>
            {t('taskBrowserRetry')}
          </Button>
        </div>
      ) : (
        <p className={styles.browserState} role="status">
          {t('taskBrowserLoading')}
        </p>
      )}
    </Modal>
  )
}
