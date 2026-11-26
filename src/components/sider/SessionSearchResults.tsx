import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { selectSession } from '../../services/chat/store.js'
import { useSettings } from '../../services/settings.js'
import { IconChevronDownOutline14, IconChevronRightOutline14 } from '../base/icons.js'
import { closeMobileSider } from './mobileSiderState.js'
import {
  SEARCH_PAGE_SIZE,
  SEARCH_PREVIEW_SIZE,
  type MessageMatch,
  type ReadMatchPage,
  type SessionMatches,
} from './useSessionSearch.js'
import styles from './SessionItem.module.css'

export const SessionSearchResults = ({
  sessionId,
  matches,
  readPage,
}: {
  sessionId: string
  matches: SessionMatches
  readPage: ReadMatchPage
}) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const formatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    [locale]
  )
  const [expanded, setExpanded] = useState(false)
  const [page, setPage] = useState<{ index: number; items: MessageMatch[] }>()
  const [loading, setLoading] = useState(false)
  const [failedPage, setFailedPage] = useState<number>()
  const pending = useRef<AbortController>()
  const toggle = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const pageCount = Math.ceil(matches.total / SEARCH_PAGE_SIZE)

  useEffect(() => () => pending.current?.abort(), [])
  const load = async (index: number, revealStart = false) => {
    pending.current?.abort()
    const request = new AbortController()
    pending.current = request
    setFailedPage(undefined)
    setLoading(true)
    try {
      const items = await readPage(sessionId, index * SEARCH_PAGE_SIZE, request.signal)
      if (request.signal.aborted) {
        return
      }
      if (!items.length) {
        setFailedPage(index)
        return
      }
      setPage({ index, items })
      if (revealStart) {
        toggle.current?.focus({ preventScroll: true })
        toggle.current?.scrollIntoView({ block: 'nearest' })
      }
    } catch {
      if (!request.signal.aborted) {
        setFailedPage(index)
      }
    } finally {
      if (!request.signal.aborted) {
        setLoading(false)
      }
    }
  }
  const onToggle = () => {
    if (expanded) {
      pending.current?.abort()
      setLoading(false)
      setFailedPage(undefined)
      setPage(undefined)
    } else {
      void load(0)
    }
    setExpanded(!expanded)
  }
  const items = (expanded ? page?.items : undefined) ?? matches.items
  return (
    <div className={styles.matches} data-session-search-results={sessionId}>
      {matches.total > SEARCH_PREVIEW_SIZE && (
        <button
          type="button"
          className={styles.matchToggle}
          ref={toggle}
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={onToggle}
        >
          {t(expanded ? 'siderSearchCollapse' : 'siderSearchExpand', { count: matches.total })}
          <IconChevronDownOutline14 />
        </button>
      )}
      <div id={listId} aria-busy={loading}>
        {items.map((item) => (
          <button
            type="button"
            className={styles.matchRow}
            key={item.messageId}
            data-search-message-id={item.messageId}
            onClick={() => {
              selectSession(sessionId, item.messageId)
              closeMobileSider()
            }}
          >
            <span className={styles.matchMeta}>
              <span>{t(item.role === 'user' ? 'siderSearchQuestion' : 'siderSearchReply')}</span>
              {Number.isFinite(new Date(item.createdAt).getTime()) && <span>{formatter.format(item.createdAt)}</span>}
            </span>
            <span className={styles.excerpt} dir="auto">
              {item.before}
              <mark>{item.keyword}</mark>
              {item.after}
            </span>
          </button>
        ))}
      </div>
      {loading && <p className={styles.matchStatus} role="status">{t('siderSearching')}</p>}
      {failedPage !== undefined && (
        <button type="button" className={styles.matchToggle} onClick={() => void load(failedPage)}>
          {t('siderSearchRetryPage')}
        </button>
      )}
      {expanded && page && pageCount > 1 && (
        <nav className={styles.matchPager} aria-label={t('siderSearchPages')}>
          <button
            type="button"
            aria-label={t('siderSearchPrevious')}
            disabled={loading || page.index === 0}
            onClick={() => void load(page.index - 1, true)}
          >
            <IconChevronRightOutline14 />
          </button>
          <span>{t('siderSearchPage', { page: page.index + 1, total: pageCount })}</span>
          <button
            type="button"
            aria-label={t('siderSearchNext')}
            disabled={loading || page.index + 1 >= pageCount}
            onClick={() => void load(page.index + 1, true)}
          >
            <IconChevronRightOutline14 />
          </button>
        </nav>
      )}
    </div>
  )
}
