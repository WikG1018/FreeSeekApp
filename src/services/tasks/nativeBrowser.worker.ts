import { parse as parseModule } from 'es-module-lexer/js'
import domModule from 'linkedom/worker?agent-guest'
import {
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from 'quickjs-emscripten-core'
import guestModule from './nativeBrowserGuest.js?agent-guest'
import type { BrowserWorkerInput, BrowserWorkerOutput, ResourceReply } from './nativeBrowser.js'
import { loadQuickJS } from './quickJS.js'

const channel = globalThis as unknown as {
  postMessage(message: BrowserWorkerOutput): void
  onmessage: ((event: MessageEvent<BrowserWorkerInput>) => void) | null
}

const DOM_MODULE = 'freeseek:document-dom'
const BOOTSTRAP = 'freeseek:document-bootstrap'
const MAX_BYTES = 1_500_000
const MODULE_LIMIT = 24

type Source = { src: string; code: string; module: boolean }
type DocumentView = {
  title: string
  text: string
  headings: string[]
  links: { label: string; url: string }[]
  truncated: boolean
}

let nextResource = 0
let started = false
const pendingResources = new Map<number, (reply: ResourceReply) => void>()

const readResource = (url: string, purpose: 'script' | 'data') => {
  const id = ++nextResource
  return new Promise<ResourceReply>((resolve) => {
    pendingResources.set(id, resolve)
    channel.postMessage({ type: 'resource', id, url, purpose })
  })
}

const scopedUrl = (value: string, base: URL, origin: string) => {
  try {
    if (value.length > 2048) {
      return undefined
    }
    const url = new URL(value, base)
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) {
      return undefined
    }
    url.hash = ''
    return url
  } catch {
    return undefined
  }
}

const normalizeImport = (specifier: string, importer: string, page: URL) => {
  if (!/^(?:\.{1,2}\/|\/|https:\/\/)/.test(specifier)) {
    return undefined
  }
  return scopedUrl(specifier, new URL(importer, page), page.origin)?.href
}

const getJson = <T>(context: QuickJSContext, fn: QuickJSHandle, limit: number): T => {
  const result = context.callFunction(fn, context.undefined)
  if (result.error) {
    result.error.dispose()
    throw new Error('Document snapshot unavailable')
  }
  const value = result.value
  try {
    const data = context.getString(value)
    if (data.length > limit) {
      throw new Error('Document snapshot exceeds the limit')
    }
    return JSON.parse(data) as T
  } finally {
    value.dispose()
  }
}

const render = async (request: Extract<BrowserWorkerInput, { type: 'start' }>) => {
  const page = new URL(request.url)
  const expires = Date.now() + Math.min(15_000, request.timeoutMs)
  const module = await loadQuickJS()
  const runtime = module.newRuntime({
    memoryLimitBytes: 24 * 1024 * 1024,
    maxStackSizeBytes: 256 * 1024,
  })
  let sliceEnd = expires
  runtime.setInterruptHandler(() => Date.now() >= sliceEnd)
  const context = runtime.newContext()
  const handles: QuickJSHandle[] = []
  const inFlight = new Set<Promise<void>>()
  const deferreds = new Set<QuickJSDeferredPromise>()
  let available = true
  let incomplete = request.truncated
  let sourceBytes = 0
  const modules = new Map<string, string>()
  runtime.setModuleLoader(
    (name) => {
      if (name === DOM_MODULE) {
        return domModule
      }
      const code = modules.get(name)
      if (code === undefined) {
        return { error: new Error('Module is not available') }
      }
      return code
    },
    (base, name) => {
      if (base === BOOTSTRAP && name === DOM_MODULE) {
        return name
      }
      const resolved = normalizeImport(name, base, page)
      return resolved ?? { error: new Error('Module is outside this document') }
    }
  )
  const nextSlice = () => {
    sliceEnd = Math.min(expires, Date.now() + 900)
  }
  const run = (code: string, filename: string, type: 'global' | 'module') => {
    nextSlice()
    const result = context.evalCode(code, filename, { type })
    if (result.error) {
      result.error.dispose()
      incomplete = true
      return false
    }
    result.value.dispose()
    return true
  }
  const drain = () => {
    nextSlice()
    const results = runtime.executePendingJobs(96)
    if (results.error) {
      incomplete = true
    }
    results.dispose()
  }
  const asset = async (url: string) => {
    const response = await readResource(url, 'script')
    if (!response.text || response.status !== 200 || response.truncated) {
      incomplete = true
      return undefined
    }
    return response.text
  }

  const preloadModules = async (code: string, entry: string) => {
    // Reserve the entry before traversing dependencies because public modules can import each other.
    if (modules.has(entry)) {
      return
    }
    if (modules.size >= MODULE_LIMIT || sourceBytes + code.length > MAX_BYTES) {
      incomplete = true
      return
    }
    sourceBytes += code.length
    modules.set(entry, code)
    const [imports] = parseModule(code)
    for (const importer of imports) {
      if (importer.d === -2) {
        continue
      }
      const target = importer.n && normalizeImport(importer.n, entry, page)
      if (!target || modules.size >= MODULE_LIMIT) {
        incomplete = true
      } else if (!modules.has(target)) {
        const script = await asset(target)
        if (script) {
          await preloadModules(script, target)
        }
      }
    }
  }

  try {
    const input = context.newString(
      JSON.stringify({
        html: request.html,
        location: {
          href: page.href,
          protocol: page.protocol,
          origin: page.origin,
          host: page.host,
          hostname: page.hostname,
          pathname: page.pathname,
          search: page.search,
          hash: '',
        },
      })
    )
    try {
      // Only this trusted bootstrap parses the input before installing the guest Document.
      const parsed = context.evalCode('JSON.parse', BOOTSTRAP, { type: 'global' }).unwrap()
      try {
        const data = context.callFunction(parsed, context.undefined, input).unwrap()
        try {
          context.setProp(context.global, '__freeSeekDocumentInput', data)
        } finally {
          data.dispose()
        }
      } finally {
        parsed.dispose()
      }
    } finally {
      input.dispose()
    }

    const requestHandle = context.newFunction('readPublicDocumentResource', (argument) => {
      if (!available || context.typeof(argument) !== 'string' || inFlight.size >= 4) {
        incomplete = true
        return context.newString('{}')
      }
      const target = scopedUrl(context.getString(argument), page, page.origin)
      if (!target) {
        incomplete = true
        return context.newString('{}')
      }
      const deferred = context.newPromise()
      deferreds.add(deferred)
      const job = readResource(target.href, 'data')
        .then((response) => {
          if (!available || !context.alive || !deferred.alive) {
            return
          }
          if (!response.status || response.truncated || response.status >= 400) {
            incomplete = true
          }
          const value = context.newString(JSON.stringify(response.truncated ? {} : response))
          try {
            deferred.resolve(value)
          } finally {
            value.dispose()
          }
        })
        .finally(() => {
          inFlight.delete(job)
          deferreds.delete(deferred)
          if (deferred.alive) {
            deferred.dispose()
          }
        })
      inFlight.add(job)
      return deferred.handle
    })
    try {
      context.setProp(context.global, '__freeSeekDocumentRead', requestHandle)
    } finally {
      requestHandle.dispose()
    }
    const base64 = context.newFunction('atob', (argument) => {
      if (context.typeof(argument) !== 'string') {
        throw new TypeError('Expected base64 text')
      }
      const text = context.getString(argument)
      if (text.length > 1_000_000) {
        throw new RangeError('Base64 input is too large')
      }
      return context.newString(atob(text))
    })
    context.setProp(context.global, 'atob', base64)
    base64.dispose()
    // The DOM stylesheet serializer uses a locale-independent decimal formatter.
    run(
      'globalThis.Intl = { NumberFormat: class { format(value) { return String(Math.round(Number(value) * 1e6) / 1e6) } } }',
      BOOTSTRAP,
      'global'
    )
    if (!run(guestModule, BOOTSTRAP, 'module')) {
      channel.postMessage({ type: 'unavailable', reason: 'engine-unavailable' })
      return
    }
    const api = context.getProp(context.global, '__freeSeekDocumentApi')
    handles.push(api)
    const snapshot = context.getProp(api, 'snapshot')
    const scripts = context.getProp(api, 'scripts')
    const emitReady = context.getProp(api, 'emitReady')
    const timers = context.getProp(api, 'drainTimers')
    handles.push(snapshot, scripts, emitReady, timers)
    run('delete globalThis.__freeSeekDocumentApi', BOOTSTRAP, 'global')
    nextSlice()
    const initial = getJson<DocumentView>(context, snapshot, 900_000)
    const sources = getJson<{ scripts: Source[]; truncated: boolean }>(context, scripts, 1_600_000)
    if (!sources.scripts.length) {
      channel.postMessage({ type: 'unavailable', reason: 'no-scripts' })
      return
    }
    incomplete ||= sources.truncated
    for (const [index, source] of sources.scripts.entries()) {
      if (Date.now() >= expires) {
        incomplete = true
        break
      }
      const href = source.src ? scopedUrl(source.src, page, page.origin) : new URL(page.href)
      if (!href) {
        incomplete = true
        continue
      }
      if (!source.src) {
        href.hash = 'inline-' + index
      }
      try {
        const code = source.src ? await asset(href.href) : source.code
        if (!code || sourceBytes + code.length > MAX_BYTES) {
          incomplete = true
          continue
        }
        if (source.module) {
          await preloadModules(code, href.href)
        } else {
          sourceBytes += code.length
        }
        run(code, href.href, source.module ? 'module' : 'global')
        drain()
      } catch {
        incomplete = true
      }
    }
    nextSlice()
    const ready = context.callFunction(emitReady, context.undefined)
    incomplete ||= Boolean(ready.error)
    ready.dispose()

    let pendingTimers = 0
    for (let round = 0; round < 44 && Date.now() < expires; round++) {
      drain()
      nextSlice()
      const tick = context.callFunction(timers, context.undefined)
      pendingTimers = tick.error ? 0 : context.getNumber(tick.value)
      incomplete ||= Boolean(tick.error)
      tick.dispose()
      if (inFlight.size) {
        await Promise.race(inFlight)
      } else if (pendingTimers || runtime.hasPendingJob()) {
        await new Promise<void>((resolve) => setTimeout(resolve, 16))
      } else {
        break
      }
    }
    // Extraction is read-only. A page-defined getter cannot schedule a new native request now.
    available = false
    nextSlice()
    const view = getJson<DocumentView>(context, snapshot, 900_000)
    if (
      (!view.text && !view.links.length) ||
      (initial.text === view.text &&
        initial.title === view.title &&
        JSON.stringify(initial.links) === JSON.stringify(view.links))
    ) {
      channel.postMessage({ type: 'unavailable', reason: 'no-dynamic-content' })
      return
    }
    channel.postMessage({
      type: 'snapshot',
      data: {
        ...view,
        url: page.href,
        truncated: view.truncated || incomplete || Boolean(pendingTimers) || Boolean(inFlight.size),
      },
    })
  } finally {
    available = false
    for (const deferred of deferreds) {
      deferred.dispose()
    }
    pendingResources.clear()
    for (const handle of handles) {
      handle.dispose()
    }
    context.dispose()
    runtime.dispose()
  }
}

channel.onmessage = (event) => {
  const message = event.data
  if (message.type === 'resource-result') {
    const resolve = pendingResources.get(message.id)
    pendingResources.delete(message.id)
    resolve?.(message.result)
    return
  }
  if (!started) {
    started = true
    void render(message).catch(() =>
      channel.postMessage({ type: 'unavailable', reason: 'engine-unavailable' })
    )
  }
}
