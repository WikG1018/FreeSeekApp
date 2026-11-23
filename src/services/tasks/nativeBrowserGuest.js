import * as DOM from 'freeseek:document-dom'

const { html, location } = globalThis.__freeSeekDocumentInput
const read = globalThis.__freeSeekDocumentRead
delete globalThis.__freeSeekDocumentInput
delete globalThis.__freeSeekDocumentRead

const { document } = DOM.parseHTML(html)
const parse = JSON.parse
const serialize = JSON.stringify
const listenerTarget = new DOM.EventTarget()
const ignored = new Set(
  'script style iframe object embed noscript template canvas svg video audio form input select textarea button meta link base'.split(
    ' '
  )
)
const blocks = new Set(
  'article blockquote dd div dl dt h1 h2 h3 h4 h5 h6 li main ol p pre section table td tr ul'.split(
    ' '
  )
)
const scriptTypes = new Set([
  '',
  'application/ecmascript',
  'application/javascript',
  'text/ecmascript',
  'text/javascript',
  'module',
])
let documentState = 'loading'

Object.defineProperties(document, {
  cookie: { get: () => '', set: () => {} },
  readyState: { get: () => documentState },
  location: { value: Object.freeze(location) },
  URL: { value: location.href },
  baseURI: { value: location.href },
})

let nextTimer = 0
const timers = new Map()
const clock = Date.now
let skippedTimer = false
const schedule = (callback, delay = 0, ...args) => {
  if (typeof callback !== 'function' || timers.size >= 16 || Number(delay) > 400) {
    skippedTimer = true
    return 0
  }
  const key = ++nextTimer
  timers.set(key, { at: clock() + Math.max(0, Number(delay) || 0), callback, args })
  return key
}
const drainTimers = () => {
  const now = clock()
  for (const [key, timer] of Array.from(timers)) {
    if (timer.at <= now) {
      timers.delete(key)
      timer.callback(...timer.args)
    }
  }
  return timers.size
}

// This environment holds only remote document data. The host function below is the sole I/O.
Object.defineProperties(globalThis, {
  window: { value: globalThis },
  self: { value: globalThis },
  document: { value: document },
  location: { value: document.location },
  navigator: { value: Object.freeze({ userAgent: 'FreeSeek Document Reader', language: 'en' }) },
  console: { value: Object.freeze({ log() {}, debug() {}, warn() {}, info() {}, error() {} }) },
  addEventListener: { value: listenerTarget.addEventListener.bind(listenerTarget) },
  removeEventListener: { value: listenerTarget.removeEventListener.bind(listenerTarget) },
  dispatchEvent: { value: listenerTarget.dispatchEvent.bind(listenerTarget) },
  setTimeout: { value: schedule },
  clearTimeout: { value: (key) => timers.delete(key) },
  requestAnimationFrame: { value: (callback) => schedule(() => callback(clock()), 16) },
  cancelAnimationFrame: { value: (key) => timers.delete(key) },
  queueMicrotask: { value: (callback) => Promise.resolve().then(callback) },
  fetch: {
    value: async (url, options) => {
      const method = options?.method ?? 'GET'
      if (
        typeof url !== 'string' ||
        typeof method !== 'string' ||
        method.toUpperCase() !== 'GET' ||
        options?.body != null ||
        options?.headers != null ||
        (options?.credentials != null && options.credentials !== 'omit')
      ) {
        throw new TypeError('Only credential-free GET is available')
      }
      const result = parse(await read(url))
      if (!result.status) {
        throw new TypeError('Resource could not be read')
      }
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        url: result.url,
        text: async () => result.text,
        json: async () => parse(result.text),
      }
    },
  },
})

for (const [name, value] of Object.entries(DOM)) {
  if (/^[A-Z]/.test(name) && typeof value === 'function' && !(name in globalThis)) {
    Object.defineProperty(globalThis, name, { value })
  }
}

const scripts = []
let scriptsTruncated = false
for (const script of document.querySelectorAll('script')) {
  const type = (script.getAttribute('type') ?? '').trim().toLowerCase()
  if (!scriptTypes.has(type) || script.hasAttribute('nomodule')) {
    continue
  }
  if (scripts.length >= 24) {
    scriptsTruncated = true
    break
  }
  scripts.push({
    src: script.getAttribute('src') ?? '',
    code: script.hasAttribute('src') ? '' : (script.textContent ?? ''),
    module: type === 'module',
  })
}

const emitReady = () => {
  documentState = 'interactive'
  document.dispatchEvent(new DOM.Event('DOMContentLoaded', { bubbles: true }))
  listenerTarget.dispatchEvent(new DOM.Event('DOMContentLoaded'))
  documentState = 'complete'
  listenerTarget.dispatchEvent(new DOM.Event('load'))
}

const snapshot = () => {
  const pieces = []
  const links = []
  const headings = []
  let size = 0
  let nodes = 0
  let truncated = scriptsTruncated || skippedTimer
  // Without layout, use explicit visibility and bounded inline stylesheet rules.
  // Media queries and external styles are not evaluated in a document snapshot.
  const concealed = new Set()
  let ruleCount = 0
  for (const sheet of Array.from(document.querySelectorAll('style')).slice(0, 8)) {
    if ((sheet.textContent || '').length > 64_000) {
      truncated = true
      continue
    }
    try {
      for (const rule of Array.from(sheet.sheet?.cssRules || [])) {
        if (++ruleCount > 128) {
          truncated = true
          break
        }
        if (
          rule.type === 1 &&
          typeof rule.selectorText === 'string' &&
          rule.selectorText.length <= 300 &&
          (rule.style?.display === 'none' || rule.style?.visibility === 'hidden')
        ) {
          for (const element of document.querySelectorAll(rule.selectorText)) {
            concealed.add(element)
          }
        }
      }
    } catch {
      truncated = true
    }
  }
  const append = (value) => {
    const remaining = 150_000 - size
    if (value.length > remaining) {
      truncated = true
    }
    if (remaining > 0 && value) {
      pieces.push(value.slice(0, remaining))
      size += Math.min(value.length, remaining)
    }
  }
  const walk = (node, depth) => {
    if (++nodes > 6500 || size >= 150_000 || depth > 48) {
      truncated = true
      return
    }
    if (node.nodeType === 3) {
      append(node.nodeValue || '')
      return
    }
    if (node.nodeType !== 1 || ignored.has(node.localName)) {
      return
    }
    if (
      concealed.has(node) ||
      node.hasAttribute('hidden') ||
      node.getAttribute('aria-hidden') === 'true' ||
      /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(
        node.getAttribute('style') || ''
      )
    ) {
      return
    }
    const tag = node.localName
    if (tag === 'br' || tag === 'hr') {
      append('\n')
      return
    }
    if (blocks.has(tag)) {
      append('\n')
    }
    const from = pieces.length
    for (
      let child = node.firstChild;
      child && nodes < 6500 && size < 150_000;
      child = child.nextSibling
    ) {
      if (tag !== 'details' || node.hasAttribute('open') || child.localName === 'summary') {
        walk(child, depth + 1)
      }
    }
    if (/^h[1-6]$/.test(tag) && headings.length < 28) {
      const label = pieces.slice(from).join('').replace(/\s+/g, ' ').trim().slice(0, 180)
      if (label) {
        headings.push(label)
      }
    }
    if (tag === 'a' && links.length < 80) {
      const href = node.getAttribute('href')
      const label = pieces.slice(from).join('').replace(/\s+/g, ' ').trim().slice(0, 160)
      if (href && href.length <= 2048 && label) {
        links.push({ label, url: href })
      }
    }
    if (blocks.has(tag)) {
      append('\n')
    }
  }
  const section = document.querySelector('main, [role=main], article') ?? document.body
  if (section) {
    walk(section, 0)
  }
  return serialize({
    title: (document.title ?? '').trim().slice(0, 240),
    text: pieces
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    headings,
    links,
    truncated: truncated || nodes >= 6500 || size >= 150_000,
  })
}

globalThis.__freeSeekDocumentApi = Object.freeze({
  scripts: () => serialize({ scripts, truncated: scriptsTruncated }),
  snapshot,
  emitReady,
  drainTimers,
})
