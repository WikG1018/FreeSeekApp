import { useEffect, useMemo, useState } from 'react'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { loadSession, reportStorageError } from '../../services/chat/db.js'
import { useChatStore } from '../../services/chat/store.js'
import { beginDiagnosticOperation } from '../../services/diagnostics/log.js'
import type { Session, SessionSummary } from '../../services/chat/types.js'

export type MessageMatch = {
  messageId: string
  before: string
  keyword: string
  after: string
}

const makeMatcher = (keyword: string) =>
  new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')

const findMessage = (session: Session, matcher: RegExp): MessageMatch | undefined => {
  const visible = getVisibleMessages(session)
  for (let index = visible.length - 1; index >= 0; index--) {
    const message = visible[index]
    const texts =
      message.role === 'user'
        ? [message.content]
        : message.blocks.flatMap((block) =>
            block.type === 'text' && !block.isTemplate ? [block.text] : []
          )
    for (const content of texts) {
      const match = matcher.exec(content)
      if (match) {
        const start = Math.max(0, match.index - 9)
        const end = Math.min(content.length, match.index + match[0].length + 42)
        return {
          messageId: message.id,
          before: (start > 0 ? '…' : '') + content.slice(start, match.index),
          keyword: match[0].slice(0, 96),
          after:
            match[0].length > 96
              ? '…'
              : content.slice(match.index + match[0].length, end) +
                (end < content.length ? '…' : ''),
        }
      }
    }
  }
  return undefined
}

type Scan = {
  sessions: SessionSummary[]
  query: string
  matches: Map<string, MessageMatch>
  complete: boolean
  failed: boolean
}

export const useSessionSearch = (sessions: SessionSummary[], query: string) => {
  const [scan, setScan] = useState<Scan | null>(null)
  const replacing = useChatStore((state) => state.importingHistory)
  const ready = useChatStore((state) => state.ready)
  const streaming = useChatStore((state) => state.streaming)
  const matcher = useMemo(() => (query ? makeMatcher(query) : null), [query])

  useEffect(() => {
    if (!matcher || !ready || replacing || sessions.length === 0) {
      return
    }
    let cancelled = false
    let failed = false
    let changed = false
    const matches = new Map<string, MessageMatch>()
    const report = reportStorageError('search conversation')
    const publish = (complete: boolean) => {
      if (!cancelled) {
        setScan({ sessions, query, matches: new Map(matches), failed, complete })
        changed = false
      }
    }
    const search = async () => {
      const finish = beginDiagnosticOperation('search', 'history', {
        sessionCount: sessions.length,
      })
      // One record at a time keeps imported history out of the open-chat cache.
      for (let index = 0; index < sessions.length && !cancelled; index++) {
        const { id } = sessions[index]
        try {
          const cache = useChatStore.getState().sessionCache
          const session = Object.hasOwn(cache, id) ? cache[id] : await loadSession(id)
          const match = !cancelled && session ? findMessage(session, matcher) : undefined
          if (match) {
            matches.set(id, match)
            changed = true
          }
        } catch (error) {
          if (!failed && !cancelled) {
            report(error)
          }
          failed = true
        }
        if (changed && (index === 0 || index % 24 === 23)) {
          publish(false)
        }
        if (index % 24 === 23) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }
      }
      publish(true)
      finish(cancelled ? 'cancelled' : failed ? 'failed' : 'completed', {
        matchedSessionCount: matches.size,
      })
    }
    const timer = window.setTimeout(() => void search(), 160)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [matcher, ready, replacing, sessions, query, streaming])

  const current = scan?.query === query && scan.sessions === sessions && !replacing ? scan : null
  const matches = current?.matches
  const filtered = useMemo(
    () =>
      matcher
        ? sessions.filter(({ id, title }) => matcher.test(title) || matches?.has(id))
        : sessions,
    [sessions, matcher, matches]
  )
  return {
    sessions: filtered,
    matches,
    searching: Boolean(
      matcher && (!ready || replacing || (sessions.length > 0 && !current?.complete))
    ),
    failed: current?.failed ?? false,
  }
}
