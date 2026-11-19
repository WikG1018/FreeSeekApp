import { App as NativeApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { localDayKey } from '../utils/localDate.js'

export type DurationCounter = {
  totalMs: number
  days: Record<string, number>
  lastUsedAt: number
}

interface ScreenTimeDB extends DBSchema {
  counters: { key: string; value: DurationCounter }
}

const APP = 'app'
const CHAT_PREFIX = 'chat:'
const CHECKPOINT_MS = 15_000
const emptyCounter = (): DurationCounter => ({ totalMs: 0, days: {}, lastUsedAt: 0 })

let database: Promise<IDBPDatabase<ScreenTimeDB>> | undefined
const getDatabase = () =>
  (database ??= openDB<ScreenTimeDB>('freeseek-screen-time', 1, {
    upgrade(db) {
      db.createObjectStore('counters')
    },
  }).catch((error: unknown) => {
    database = undefined
    throw error
  }))

const addCounter = (a: DurationCounter, b: DurationCounter): DurationCounter => {
  const days = { ...a.days }
  for (const [day, ms] of Object.entries(b.days)) {
    days[day] = (days[day] ?? 0) + ms
  }
  // Keep a small daily history for the 7-day view while preserving the lifetime total.
  const dates = Object.keys(days)
  return {
    totalMs: a.totalMs + b.totalMs,
    days:
      dates.length > 21
        ? Object.fromEntries(
            dates
              .sort()
              .slice(-21)
              .map((day) => [day, days[day]])
          )
        : days,
    lastUsedAt: Math.max(a.lastUsedAt, b.lastUsedAt),
  }
}

const elapsedCounter = (start: number, ms: number): DurationCounter => {
  const end = start + ms
  const days: Record<string, number> = {}
  for (let cursor = start; cursor < end; ) {
    const midnight = new Date(cursor)
    midnight.setHours(24, 0, 0, 0)
    const stop = Math.min(end, midnight.getTime())
    const key = localDayKey(cursor)
    days[key] = (days[key] ?? 0) + stop - cursor
    cursor = stop
  }
  return { totalMs: ms, days, lastUsedAt: end }
}

const sample = () => ({ wall: Date.now(), tick: performance.now() })
let active: ReturnType<typeof sample> | null = null
let viewingChat: string | null = null
let pending = new Map<string, DurationCounter>()
let stored = new Map<string, DurationCounter>()
let queue = Promise.resolve()

const addPending = (key: string, value: DurationCounter) => {
  pending.set(key, addCounter(pending.get(key) ?? emptyCounter(), value))
}

const checkpoint = () => {
  if (!active) {
    return
  }
  const now = sample()
  const gap = now.tick - active.tick
  // Clamp gaps left by a suspended event loop. Wall time is only used for date grouping.
  const elapsed = Math.round(Math.min(gap, CHECKPOINT_MS * 2))
  if (elapsed >= 1) {
    const wall = Math.abs(now.wall - active.wall - gap) < 2000 ? active.wall : now.wall - elapsed
    const update = elapsedCounter(wall, elapsed)
    addPending(APP, update)
    if (viewingChat !== null) {
      addPending(CHAT_PREFIX + viewingChat, update)
    }
  }
  active = now
}

const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
  const result = queue.then(action)
  queue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

const writePending = async (): Promise<boolean> => {
  const batch = pending
  if (!batch.size) {
    return true
  }
  pending = new Map()
  try {
    const tx = (await getDatabase()).transaction('counters', 'readwrite')
    const updates = new Map<string, DurationCounter>()
    try {
      for (const [key, delta] of batch) {
        const value = addCounter((await tx.store.get(key)) ?? emptyCounter(), delta)
        await tx.store.put(value, key)
        updates.set(key, value)
      }
      await tx.done
    } catch (error) {
      try {
        tx.abort()
      } catch {
        // A failed request can already have aborted the transaction.
      }
      await tx.done.catch(() => {})
      throw error
    }
    for (const [key, value] of updates) {
      stored.set(key, value)
    }
    return true
  } catch {
    for (const [key, value] of batch) {
      addPending(key, value)
    }
    return false
  }
}

let flushScheduled = false
const scheduleWrite = () => {
  if (flushScheduled || !pending.size) {
    return
  }
  flushScheduled = true
  void enqueue(async () => {
    flushScheduled = false
    await writePending()
  })
}

/** Only a conversation that is actually shown receives conversation time. */
export const setScreenTimeChat = (chatId: string | null) => {
  if (viewingChat !== chatId) {
    checkpoint()
    viewingChat = chatId
  }
}

export const isTrackingScreenTime = () => active !== null

export const bindScreenTime = (onCheckpoint?: () => void) => {
  const native = Capacitor.isNativePlatform()
  let nativeActive = false,
    nativeKnown = false,
    pageShown = true,
    disposed = false
  let timer: ReturnType<typeof setInterval> | undefined

  const isForeground = () =>
    pageShown &&
    document.visibilityState === 'visible' &&
    (native ? nativeActive : document.hasFocus())
  const sync = () => {
    if (isForeground()) {
      if (!active) {
        active = sample()
        timer = setInterval(() => {
          if (!isForeground()) {
            sync()
            return
          }
          checkpoint()
          scheduleWrite()
          onCheckpoint?.()
        }, CHECKPOINT_MS)
        onCheckpoint?.()
      }
    } else if (active) {
      checkpoint()
      active = null
      clearInterval(timer)
      scheduleWrite()
    }
  }
  const show = () => {
    pageShown = true
    sync()
  }
  const hide = () => {
    pageShown = false
    sync()
  }
  const nativeChange = (isActive: boolean) => {
    if (!disposed) {
      nativeKnown = true
      nativeActive = isActive
      sync()
    }
  }

  document.addEventListener('visibilitychange', sync)
  window.addEventListener('focus', sync)
  window.addEventListener('blur', sync)
  window.addEventListener('pageshow', show)
  window.addEventListener('pagehide', hide)
  const subscription = native
    ? NativeApp.addListener('appStateChange', ({ isActive }) => nativeChange(isActive))
    : undefined
  void subscription
    ?.then(() => NativeApp.getState())
    .then(({ isActive }) => {
      if (!nativeKnown) {
        nativeChange(isActive)
      }
    })
    .catch(() => {
      if (!nativeKnown) {
        nativeChange(true)
      }
    })
  sync()
  return () => {
    disposed = true
    hide()
    document.removeEventListener('visibilitychange', sync)
    window.removeEventListener('focus', sync)
    window.removeEventListener('blur', sync)
    window.removeEventListener('pageshow', show)
    window.removeEventListener('pagehide', hide)
    void subscription?.then((listener) => listener.remove()).catch(() => {})
  }
}

/** Dashboard refreshes can read the single app counter without scanning every chat. */
export const readScreenTime = (includeChats: boolean) => {
  checkpoint()
  return enqueue(async () => {
    let durable = await writePending()
    try {
      const db = await getDatabase()
      if (includeChats) {
        const tx = db.transaction('counters', 'readonly')
        const [keys, values] = await Promise.all([tx.store.getAllKeys(), tx.store.getAll()])
        await tx.done
        stored = new Map(keys.map((key, index) => [key, values[index]]))
      } else {
        stored.set(APP, (await db.get('counters', APP)) ?? emptyCounter())
      }
    } catch {
      durable = false
    }
    const counter = (key: string) =>
      addCounter(stored.get(key) ?? emptyCounter(), pending.get(key) ?? emptyCounter())
    const chats = new Map<string, DurationCounter>()
    if (includeChats) {
      for (const key of new Set([...stored.keys(), ...pending.keys()])) {
        if (key.startsWith(CHAT_PREFIX)) {
          chats.set(key.slice(CHAT_PREFIX.length), counter(key))
        }
      }
    }
    return { overall: counter(APP), chats, durable }
  })
}
