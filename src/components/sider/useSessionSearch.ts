import { useCallback, useEffect, useMemo, useState } from 'react'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { loadSession, reportStorageError } from '../../services/chat/db.js'
import { useChatStore } from '../../services/chat/store.js'
import { beginDiagnosticOperation } from '../../services/diagnostics/log.js'
import { stripRoleMarkers } from '../../services/speech/roleMarkers.js'
import type { Message, Session, SessionSummary } from '../../services/chat/types.js'

export const SEARCH_PREVIEW_SIZE = 2
export const SEARCH_PAGE_SIZE = 12

export type MessageMatch = {
  messageId: string
  role: Message['role']
  createdAt: number
  before: string
  keyword: string
  after: string
}

export type SessionMatches = { total: number; items: MessageMatch[] }
export type ReadMatchPage = (id: string, offset: number, signal: AbortSignal) => Promise<MessageMatch[]>

type Scan = {
  sourceKey: string
  branchRevision: number
  query: string
  matches: Map<string, SessionMatches>
  complete: boolean
  failed: boolean
}

const makeMatcher = (keyword: string) =>
  new RegExp(keyword.replace(/[.*+?^{}$()|[\]\\]/g, '\\$&'), 'iu')

const findText = (message: Message, matcher: RegExp) => {
  if (message.role === 'user') {
    const match = matcher.exec(message.content)
    return match && { content: message.content, match }
  }
  if (message.stopReason === 'refusal') {
    return null
  }
  for (const block of message.blocks) {
    if (block.type === 'text' && !block.isTemplate && matcher.test(block.text)) {
      const content = stripRoleMarkers(block.text)
      const match = matcher.exec(content)
      if (match) {
        return { content, match }
      }
    }
  }
  return null
}

const matchExcerpt = (message: Message, content: string, match: RegExpExecArray): MessageMatch => {
  const start = Math.max(0, match.index - 12)
  const matchEnd = match.index + match[0].length
  const end = Math.min(content.length, matchEnd + 56)
  return {
    messageId: message.id,
    role: message.role,
    createdAt: message.createdAt,
    before: (start > 0 ? '…' : '') + content.slice(start, match.index).replace(/\s+/g, ' '),
    keyword: match[0].slice(0, 96).replace(/\s+/g, ' '),
    after: match[0].length > 96
      ? '…'
      : content.slice(matchEnd, end).replace(/\s+/g, ' ') + (end < content.length ? '…' : ''),
  }
}

const readSessionForSearch = (id: string) => {
  const cache = useChatStore.getState().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : loadSession(id)
}

const yieldToInput = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const findMatches = async (
  session: Session,
  matcher: RegExp,
  signal: AbortSignal,
  offset: number,
  limit: number,
  countAll: boolean
): Promise<SessionMatches> => {
  if (signal.aborted) {
    return { total: 0, items: [] }
  }
  const visible = getVisibleMessages(session)
  const items: MessageMatch[] = []
  let total = 0
  let yieldAfter = performance.now() + 8
  for (let index = visible.length - 1; index >= 0 && !signal.aborted; index--) {
    const message = visible[index]
    const result = findText(message, matcher)
    if (result) {
      if (total >= offset && items.length < limit) {
        items.push(matchExcerpt(message, result.content, result.match))
      }
      total++
      if (!countAll && items.length === limit) {
        break
      }
    }
    if (performance.now() > yieldAfter) {
      await yieldToInput()
      yieldAfter = performance.now() + 8
    }
  }
  return { total, items }
}

export const useSessionSearch = (sessions: SessionSummary[], query: string) => {
  const [scan, setScan] = useState<Scan | null>(null)
  const [attempt, setAttempt] = useState(0)
  const replacing = useChatStore((state) => state.importingHistory)
  const ready = useChatStore((state) => state.ready)
  const branchRevision = useChatStore((state) => state.historyBranchRevision)
  const streaming = useChatStore((state) => state.streaming)
  const matcher = useMemo(() => (query ? makeMatcher(query) : null), [query])
  // Sorting, pinning and filling missing type metadata do not change the messages.
  const sourceKey = useMemo(
    () => (matcher ? JSON.stringify(sessions.map(({ id, updatedAt }) => [id, updatedAt])) : ''),
    [sessions, matcher]
  )
  const searchIds = useMemo(
    () => (sourceKey ? (JSON.parse(sourceKey) as [string, number][]).map(([id]) => id) : []),
    [sourceKey]
  )

  useEffect(() => {
    if (!matcher || replacing || !ready || searchIds.length === 0) {
      setScan(null)
      return
    }
    const controller = new AbortController()
    const { signal } = controller
    let failed = false
    let changed = false
    let matchedMessages = 0
    const matches = new Map<string, SessionMatches>()
    const report = reportStorageError('search conversation')
    const publish = (complete: boolean) => {
      if (!signal.aborted) {
        setScan({ sourceKey, branchRevision, query, matches: new Map(matches), failed, complete })
        changed = false
      }
    }
    const search = async () => {
      const finish = beginDiagnosticOperation('search', 'history', { sessionCount: searchIds.length })
      // Read one session at a time and keep only the two previews per session.
      for (let index = 0; index < searchIds.length && !signal.aborted; index++) {
        const id = searchIds[index]
        try {
          const session = await readSessionForSearch(id)
          if (!session) {
            throw Error('Search session could not be read')
          }
          const group = await findMatches(session, matcher, signal, 0, SEARCH_PREVIEW_SIZE, true)
          if (group.total && !signal.aborted) {
            matches.set(id, group)
            matchedMessages += group.total
            changed = true
          }
        } catch (error) {
          if (!failed && !signal.aborted) {
            report(error)
          }
          failed = true
        }
        if (changed && (index === 0 || index % 24 === 23)) {
          publish(false)
        }
        if (index % 24 === 23) {
          await yieldToInput()
        }
      }
      publish(true)
      finish(signal.aborted ? 'cancelled' : failed ? 'failed' : 'completed', {
        matchedSessionCount: matches.size,
        matchedMessageCount: matchedMessages,
      })
    }
    const timer = window.setTimeout(() => void search(), 160)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [matcher, ready, replacing, searchIds, sourceKey, branchRevision, query, streaming, attempt])

  const readPage: ReadMatchPage = useCallback(async (id, offset, signal) => {
    if (!matcher || signal.aborted || replacing) {
      return []
    }
    const session = await readSessionForSearch(id)
    if (!session) {
      throw Error('Search session could not be read')
    }
    return (await findMatches(session, matcher, signal, offset, SEARCH_PAGE_SIZE, false)).items
  }, [matcher, replacing])

  const current = scan?.query === query && scan.sourceKey === sourceKey &&
    scan.branchRevision === branchRevision && !replacing ? scan : null
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
    readPage,
    searching: Boolean(matcher && (!ready || replacing || (sessions.length > 0 && !current?.complete))),
    failed: current?.failed ?? false,
    retry: () => {
      setScan(null)
      setAttempt((value) => value + 1)
    },
  }
}
