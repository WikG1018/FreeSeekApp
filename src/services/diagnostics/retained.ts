import { Capacitor } from '@capacitor/core'
import type { DiagnosticEvent } from './log.js'
import { NativeDiagnostics } from './native.js'

const pending: DiagnosticEvent[] = []
const BATCH = 16
const LIMIT = 128
let timer: ReturnType<typeof setTimeout> | undefined
let writing: Promise<void> | undefined
let dropped = 0
let failedWrites = 0

const operationBoundary =
  /(?:^|\.)(?:started|completed|failed|cancelled|rejected|settled|finished|recovered|unavailable)$/

const isHistory = ({ scope, event }: DiagnosticEvent) =>
  (scope === 'storage' && /^(?:history\.|sessions\.loaded$|session\.deleted$)/.test(event)) ||
  (scope === 'backup' && (event.startsWith('history.') || event.startsWith('import.')))

export const retainClientEvent = (entry: DiagnosticEvent) => {
  const { scope, event, level } = entry
  const important = isHistory(entry) || (scope === 'app' && /^startup\.|^started$/.test(event))
  if (
    !(
      important ||
      level !== 'info' ||
      operationBoundary.test(event) ||
      (scope === 'api' &&
        /^(?:request|response\.headers|provider\.(?:request|response))$/.test(event)) ||
      (scope === 'update' && event.startsWith('install.'))
    ) ||
    Capacitor.getPlatform() !== 'android' ||
    !Capacitor.isPluginAvailable('Diagnostics')
  ) {
    return
  }
  if (pending.length === LIMIT) {
    const ordinary = pending.findIndex((queued) => queued.level === 'info' && !isHistory(queued))
    pending.splice(ordinary === -1 ? 0 : ordinary, 1)
    dropped++
  }
  pending.push(entry)
  if (important || level !== 'info' || pending.length >= BATCH) {
    void flushRetainedClientEvents()
  } else if (timer === undefined) {
    timer = setTimeout(() => void flushRetainedClientEvents(), 200)
  }
}

export const flushRetainedClientEvents = () => {
  clearTimeout(timer)
  timer = undefined
  if (!pending.length || writing) {
    return writing ?? Promise.resolve()
  }
  writing = Promise.resolve()
    .then(async () => {
      while (pending.length) {
        const batch = pending.splice(0, BATCH)
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            NativeDiagnostics.retainClientEvents({ events: batch }),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error('Native diagnostic write timed out')),
                1500
              )
            }),
          ])
        } catch {
          failedWrites += batch.length
        } finally {
          clearTimeout(timeout)
        }
      }
    })
    .finally(() => {
      writing = undefined
      if (pending.length) {
        void flushRetainedClientEvents()
      }
    })
  return writing
}

export const retainedClientWriteStatus = () => ({ dropped, failedWrites })
