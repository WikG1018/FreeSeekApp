import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type TouchEvent,
} from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { PageImage, PagedDocument } from '../../services/tasks/documentPreview.js'
import { Button } from '../base/Button.js'
import {
  IconChevronDownOutline14,
  IconChevronLeftOutline16,
  IconChevronRightOutline14,
  IconSearchOutline16,
} from '../base/icons.js'
import { Select } from '../base/Select.js'
import { useOptionPanel } from '../base/OptionPanel.js'
import { useTransientPanel } from '../base/transientPanel.js'
import styles from './LayoutReader.module.css'

const positions = new Map<string, { page: number; zoom: number }>()
const savePosition = (id: string, next: { page: number; zoom: number }) => {
  positions.delete(id)
  positions.set(id, next)
  for (const key of positions.keys()) {
    if (positions.size <= 60) {
      break
    }
    positions.delete(key)
  }
}
const between = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const widthOf = (event: TouchEvent) => {
  const [a, b] = Array.from(event.touches)
  return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0
}
const useReaderZoom = (initial: number) => {
  const [zoom, setZoom] = useState(initial)
  const pinch = useRef<{ distance: number; zoom: number }>()
  const change = (amount: number) => setZoom((value) => between(value + amount, 0.7, 3))
  return {
    zoom,
    change,
    gesture: {
      onTouchStart: (event: TouchEvent) => {
        const distance = widthOf(event)
        if (distance > 0) {
          pinch.current = { distance, zoom }
        }
      },
      onTouchMove: (event: TouchEvent) => {
        const distance = widthOf(event)
        if (pinch.current && distance > 0) {
          setZoom(between((pinch.current.zoom * distance) / pinch.current.distance, 0.7, 3))
        }
      },
      onTouchEnd: () => {
        pinch.current = undefined
      },
      onTouchCancel: () => {
        pinch.current = undefined
      },
    },
  }
}

const ZoomControls = ({ scale, change }: { scale: number; change: (amount: number) => void }) => {
  const t = useTranslate()
  return (
    <div className={styles.zoom}>
      <button
        type="button"
        aria-label={t('readerZoomOut')}
        disabled={scale <= 0.7}
        onClick={() => change(-0.2)}
      >
        −
      </button>
      <span>
        {Math.abs(scale - 1) < 0.01 ? t('readerFitWidth') : Math.round(scale * 100) + '%'}
      </span>
      <button
        type="button"
        aria-label={t('readerZoomIn')}
        disabled={scale >= 3}
        onClick={() => change(0.2)}
      >
        +
      </button>
    </div>
  )
}

export const ReaderToolbar = ({
  navigation,
  zoom,
  search,
}: {
  navigation?: ReactNode
  zoom?: ReactNode
  search?: ReactNode
}) => {
  const t = useTranslate()
  const [finding, setFinding] = useState(false)
  const searchId = useId()
  const searchBox = useRef<HTMLDivElement>(null)
  const searchButton = useRef<HTMLButtonElement>(null)
  const close = useCallback((restoreFocus: boolean) => {
    setFinding(false)
    if (restoreFocus) {
      searchButton.current?.focus({ preventScroll: true })
    }
  }, [])
  useTransientPanel(finding && Boolean(search), close)
  useLayoutEffect(() => {
    if (!finding) {
      return
    }
    searchBox.current?.querySelector('input')?.focus({ preventScroll: true })
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        event.stopPropagation()
        close(true)
      }
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  }, [finding, close])
  return (
    <div className={styles.toolbarGroup}>
      <div className={styles.toolbar} data-testid="file-reader-toolbar">
        <div className={styles.navigation}>{navigation}</div>
        {zoom}
        {search && (
          <button
            type="button"
            className={styles.toolIcon}
            ref={searchButton}
            aria-label={t('agentFileSearch')}
            title={t('agentFileSearch')}
            aria-expanded={finding}
            aria-controls={finding ? searchId : undefined}
            onClick={() => (finding ? close(true) : setFinding(true))}
          >
            <IconSearchOutline16 />
          </button>
        )}
      </div>
      {finding && search && (
        <div id={searchId} className={styles.searchBox} ref={searchBox}>
          {search}
        </div>
      )}
    </div>
  )
}

const PageStepper = ({
  page,
  total,
  change,
  label,
}: {
  page: number
  total: number
  change: (index: number) => void
  label?: string
}) => {
  const t = useTranslate()
  return (
    <div className={styles.pager} role="group" aria-label={t('readerPages')}>
      <button
        type="button"
        className={styles.toolIcon}
        aria-label={t('agentFilePrevious')}
        disabled={page === 0}
        onClick={() => change(page - 1)}
      >
        <IconChevronLeftOutline16 />
      </button>
      {label && <span className={styles.pageState}>{label}</span>}
      <button
        type="button"
        className={styles.toolIcon}
        aria-label={t('agentFileNext')}
        disabled={page >= total - 1}
        onClick={() => change(page + 1)}
      >
        <IconChevronRightOutline14 />
      </button>
    </div>
  )
}

const Thumbnail = ({ document, page }: { document: PagedDocument; page: number }) => {
  const [image, setImage] = useState<PageImage>()
  useEffect(() => {
    const controller = new AbortController()
    let loaded: PageImage | undefined
    void document
      .render(page, 120, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) {
          next.dispose?.()
        } else {
          loaded = next
          setImage(next)
        }
      })
      .catch(() => {})
    return () => {
      controller.abort()
      loaded?.dispose?.()
    }
  }, [document, page])
  return image ? (
    <img src={image.url} alt="" />
  ) : (
    <span className={styles.thumbnailBlank} aria-hidden="true" />
  )
}

export const PagedLayoutReader = ({
  document,
  fileId,
}: {
  document: PagedDocument
  fileId: string
}) => {
  const t = useTranslate()
  const prior = positions.get(fileId)
  const [page, setPage] = useState(between(prior?.page ?? 0, 0, document.count - 1))
  const zoom = useReaderZoom(prior?.zoom ?? 1)
  const [image, setImage] = useState<PageImage>()
  const [failed, setFailed] = useState(false)
  const [token, setToken] = useState(0)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<'busy' | 'empty' | 'failed'>()
  const searchRequest = useRef<AbortController>()
  const scroller = useRef<HTMLDivElement>(null)
  const choose = useOptionPanel(t('readerPages'), {
    side: 'bottom',
    kind: 'artifacts',
    focusFirst: false,
  })
  const [target, setTarget] = useState('')
  useEffect(() => savePosition(fileId, { page, zoom: zoom.zoom }), [fileId, page, zoom.zoom])
  useEffect(() => {
    const controller = new AbortController()
    let resource: PageImage | undefined
    setImage(undefined)
    setFailed(false)
    void document
      .render(page, 1600, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) {
          result.dispose?.()
        } else {
          resource = result
          setImage(result)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFailed(true)
        }
      })
    return () => {
      controller.abort()
      resource?.dispose?.()
    }
  }, [document, page, token])
  useEffect(() => () => searchRequest.current?.abort(), [])
  const jump = (index: number) => {
    setPage(between(index, 0, document.count - 1))
    if (scroller.current) {
      scroller.current.scrollTop = 0
    }
  }
  const find = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    searchRequest.current?.abort()
    const needle = query.trim().toLowerCase()
    if (!document.text || !needle) {
      return
    }
    const controller = new AbortController()
    searchRequest.current = controller
    const { signal } = controller
    const textOf = document.text
    setSearch('busy')
    try {
      for (let delta = 1; delta <= document.count; delta++) {
        const index = (page + delta) % document.count
        const value = await textOf(index)
        signal.throwIfAborted()
        if (value.toLowerCase().includes(needle)) {
          jump(index)
          setSearch(undefined)
          return
        }
      }
      setSearch('empty')
    } catch {
      if (!signal.aborted) {
        setSearch('failed')
      }
    }
  }
  const nearby = Math.max(0, Math.min(page - 1, document.count - 4))
  return (
    <div
      className={styles.reader}
      data-testid="paged-layout-reader"
      data-layout-mode={document.mode}
    >
      <ReaderToolbar
        navigation={
          <button
            type="button"
            className={styles.pageToggle}
            ref={choose.anchorRef}
            aria-label={t('readerPages')}
            {...choose.trigger}
          >
            <span>{t('agentFilePage', { page: page + 1, pages: document.count })}</span>
            <IconChevronDownOutline14 />
          </button>
        }
        zoom={<ZoomControls scale={zoom.zoom} change={zoom.change} />}
        search={
          document.text && (
            <form className={styles.find} onSubmit={(event) => void find(event)}>
              <input
                type="search"
                enterKeyHint="search"
                aria-label={t('agentFileSearch')}
                placeholder={t('agentFileSearch')}
                value={query}
                onChange={(event) => {
                  searchRequest.current?.abort()
                  setQuery(event.currentTarget.value)
                  setSearch(undefined)
                }}
              />
              <Button
                size="s"
                variant="outlined"
                type="submit"
                disabled={search === 'busy' || !query.trim()}
              >
                {t('readerFind')}
              </Button>
              {search && (
                <small role="status">
                  {t(
                    search === 'busy'
                      ? 'readerSearching'
                      : search === 'failed'
                        ? 'readerPageFailed'
                        : 'agentFileSearchEmpty'
                  )}
                </small>
              )}
            </form>
          )
        }
      />
      <div
        className={styles.scroller}
        ref={scroller}
        data-scroll-edge=""
        data-preview-zoomed={zoom.zoom > 1.01 || undefined}
        {...zoom.gesture}
      >
        <div data-scroll-edge-content="" className={styles.canvas}>
          {image ? (
            <img
              className={styles.page}
              src={image.url}
              data-testid="rendered-artifact-page"
              alt={t('agentFilePage', { page: page + 1, pages: document.count })}
              style={{ width: zoom.zoom * 100 + '%', maxWidth: (image.width / 1.4) * zoom.zoom }}
            />
          ) : failed ? (
            <div className={styles.notice} role="alert">
              <p>{t('readerPageFailed')}</p>
              <Button variant="outlined" onClick={() => setToken((value) => value + 1)}>
                {t('retry')}
              </Button>
            </div>
          ) : (
            <p className={styles.notice} role="status">
              {t('taskFileLoading')}
            </p>
          )}
        </div>
      </div>
      {document.count > 1 && <PageStepper page={page} total={document.count} change={jump} />}
      {choose.open &&
        choose.render(
          <div className={styles.thumbnails}>
            <form
              className={styles.find}
              onSubmit={(event) => {
                event.preventDefault()
                const next = Number(target)
                if (Number.isSafeInteger(next) && next >= 1 && next <= document.count) {
                  jump(next - 1)
                  choose.close(true)
                  setTarget('')
                }
              }}
            >
              <input
                type="number"
                min={1}
                max={document.count}
                aria-label={t('readerJumpPage')}
                value={target}
                onChange={(event) => setTarget(event.currentTarget.value)}
              />
              <Button type="submit" size="s">
                {t('readerGo')}
              </Button>
            </form>
            <div className={styles.thumbnailsGrid}>
              {Array.from(
                { length: Math.min(4, document.count) },
                (_, index) => nearby + index
              ).map((index) => (
                <button
                  type="button"
                  className={styles.thumbnail}
                  key={index}
                  aria-current={index === page}
                  onClick={() => {
                    jump(index)
                    choose.close(true)
                  }}
                >
                  <Thumbnail document={document} page={index} />
                  <span>{index + 1}</span>
                </button>
              ))}
            </div>
          </div>
        )}
    </div>
  )
}

const wordHtml = `<!doctype html><html><head>
<meta charset="UTF-8"><meta http-equiv="Content-Security-Policy"
 content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'">
<style>body { margin: 0; background: transparent; color: black }
.docx-wrapper { padding: 0 !important; background: transparent !important; align-items: flex-start !important }
.docx-wrapper > section { box-shadow: none !important; margin-bottom: 12px !important; border: 1px solid #dfe3e8 }
[data-word-match] { outline: 2px solid #d89a25; background: #fff4d7 }</style>
</head><body></body></html>`

const wordOutline = (root: Document | Element) =>
  Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p[class]'))
    .filter((node) => node.tagName !== 'P' || /(?:^|[ _-])heading[ _-]?[1-9]/i.test(node.className))
    .slice(0, 100)

export const WordLayoutReader = ({
  document: file,
  fileId,
}: {
  document: Blob
  fileId: string
}) => {
  const t = useTranslate()
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [sections, setSections] = useState<HTMLElement[]>([])
  const [headings, setHeadings] = useState<{ value: string; label: string }[]>([])
  const [query, setQuery] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [current, setCurrent] = useState(positions.get(fileId)?.page ?? 0)
  const zoom = useReaderZoom(positions.get(fileId)?.zoom ?? 1)
  const frame = useRef<HTMLIFrameElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const wordWidth = useRef(816)
  const generation = useRef(0)
  const focusPage = (element: HTMLElement) => {
    if (scroll.current) {
      scroll.current.scrollTop = element.getBoundingClientRect().top
    }
  }
  useEffect(() => {
    const parent = scroll.current
    const node = frame.current
    const content = node?.contentDocument
    if (!parent || !node || !content || phase !== 'ready') {
      return
    }
    const resize = () => {
      const before = node.offsetHeight
      const top = parent.scrollTop
      const factor = Math.min(1, parent.clientWidth / wordWidth.current) * zoom.zoom
      content.body.style.setProperty('zoom', String(factor))
      node.style.width = Math.round(wordWidth.current * factor) + 'px'
      const height = Math.ceil(content.body.getBoundingClientRect().height)
      node.style.height = height + 'px'
      if (before > 0 && height > 0 && Math.abs(height - before) > 2) {
        parent.scrollTop = (top * height) / before
      }
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(parent)
    observer.observe(content.body)
    return () => observer.disconnect()
  }, [phase, zoom.zoom])
  useEffect(
    () => savePosition(fileId, { page: current, zoom: zoom.zoom }),
    [fileId, current, zoom.zoom]
  )
  useEffect(
    () => () => {
      generation.current++
    },
    []
  )
  const loadWord = async () => {
    const request = ++generation.current
    const content = frame.current?.contentDocument
    if (!content) {
      return
    }
    try {
      const { renderAsync } = await import('docx-preview')
      const style = content.createElement('div')
      const pages = content.createElement('div')
      content.body.textContent = ''
      content.body.appendChild(style)
      content.body.appendChild(pages)
      await renderAsync(file, pages, style, {
        useBase64URL: true,
        breakPages: true,
        ignoreLastRenderedPageBreak: false,
        renderAltChunks: false,
        renderComments: false,
      })
      if (request !== generation.current) {
        return
      }
      // Keep navigation in the application and the original Office content in the sandbox.
      for (const anchor of content.querySelectorAll('a[href]')) {
        anchor.removeAttribute('href')
      }
      const blocks = Array.from(pages.querySelectorAll<HTMLElement>('section.docx'))
      if (!blocks.length) {
        throw new Error('Word file contains no pages')
      }
      setSections(blocks)
      wordWidth.current = Math.max(...blocks.map((section) => section.offsetWidth), 200)
      setHeadings(
        wordOutline(pages).map((node, index) => ({
          value: String(index),
          label: node.textContent?.trim() || '—',
        }))
      )
      setPhase('ready')
      requestAnimationFrame(() => {
        const target = blocks[between(current, 0, blocks.length - 1)]
        if (target) {
          focusPage(target)
        }
      })
    } catch {
      if (request === generation.current) {
        setPhase('failed')
      }
    }
  }
  return (
    <div className={styles.reader} data-testid="word-layout-reader">
      <ReaderToolbar
        navigation={
          headings.length > 0 && (
            <Select
              pill
              ariaLabel={t('agentFileOutline')}
              placeholder={t('agentFileOutline')}
              value=""
              options={headings}
              onChange={(value) => {
                const body = frame.current?.contentDocument
                const heading = body && wordOutline(body)[Number(value)]
                if (heading) {
                  focusPage(heading)
                }
              }}
            />
          )
        }
        zoom={<ZoomControls scale={zoom.zoom} change={zoom.change} />}
        search={
          <form
            className={styles.find}
            onSubmit={(event) => {
              event.preventDefault()
              const content = frame.current?.contentDocument
              const needle = query.trim().toLowerCase()
              content?.querySelector('[data-word-match]')?.removeAttribute('data-word-match')
              if (!content || !needle) {
                return
              }
              const match = Array.from(content.querySelectorAll<HTMLElement>('p, th, td')).find(
                (node) => node.textContent?.toLowerCase().includes(needle)
              )
              setNotFound(!match)
              if (match) {
                match.dataset.wordMatch = ''
                focusPage(match)
              }
            }}
          >
            <input
              type="search"
              enterKeyHint="search"
              aria-label={t('agentFileSearch')}
              placeholder={t('agentFileSearch')}
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value)
                setNotFound(false)
              }}
            />
            <Button
              variant="outlined"
              size="s"
              type="submit"
              disabled={phase !== 'ready' || !query.trim()}
            >
              {t('readerFind')}
            </Button>
            {notFound && <small role="status">{t('agentFileSearchEmpty')}</small>}
          </form>
        }
      />
      {phase !== 'ready' && (
        <p className={styles.notice} role={phase === 'failed' ? 'alert' : 'status'}>
          {t(phase === 'loading' ? 'taskFileLoading' : 'readerPageFailed')}
        </p>
      )}
      <div
        className={styles.scroller}
        ref={scroll}
        data-scroll-edge=""
        data-preview-zoomed={zoom.zoom > 1.01 || undefined}
        {...zoom.gesture}
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop
          const index = sections.findIndex(
            (section) => section.getBoundingClientRect().bottom > top + 4
          )
          if (index >= 0) {
            setCurrent(index)
          }
        }}
      >
        <div className={styles.canvas} data-scroll-edge-content="">
          <iframe
            ref={frame}
            title={t('readerWordCanvas')}
            srcDoc={wordHtml}
            sandbox="allow-same-origin"
            scrolling="no"
            className={styles.word}
            onLoad={() => void loadWord()}
          />
        </div>
      </div>
      {sections.length > 1 && (
        <PageStepper
          page={current}
          total={sections.length}
          label={t('agentFilePage', { page: current + 1, pages: sections.length })}
          change={(index) => focusPage(sections[index])}
        />
      )}
    </div>
  )
}
