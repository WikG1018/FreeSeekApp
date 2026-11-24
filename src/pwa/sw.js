/* Offline shell for the web app. Each deployment path has its own cache. */
const BUILD = '__FREESEEK_WEB_BUILD__'
const STARTUP_FILES = /* FreeSeek startup assets */ []
const scope = new URL(self.registration.scope)
const prefix = 'freeseek-shell-v2:' + scope.href + '|'
const cacheName = prefix + BUILD
const shell = scope.href
const icons = ['./manifest.webmanifest', './startup-mark.png', './icons/icon-192.png']
const optional = new Set(icons.map((path) => new URL(path, scope).pathname))
const assetPath = scope.pathname + 'static/'
const staticAsset = /\.(?:js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|wasm|mjs|json)$/

const stagedRequest = (path) =>
  new Request(new URL(path, scope), { cache: 'reload', credentials: 'omit' })

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName)
      // Leave the previous worker active if a deployment is still missing a startup file.
      await cache.addAll(['./', ...STARTUP_FILES].map(stagedRequest))
      await Promise.all(icons.map((path) => cache.add(stagedRequest(path)).catch(() => undefined)))
      await self.skipWaiting()
    })()
  )
})

const previousCaches = async () =>
  (await caches.keys().catch(() => [])).filter(
    (name) => name !== cacheName && name.startsWith(prefix)
  )

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Keep the last build's hashed assets for tabs that are still running its code.
      const outdated = (await previousCaches()).slice(0, -1)
      await Promise.all(outdated.map((name) => caches.delete(name)))
      await self.clients.claim()
    })()
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') {
    event.waitUntil(self.skipWaiting())
  }
})

const cacheable = (response) =>
  response.status === 200 &&
  response.type === 'basic' &&
  !response.redirected &&
  !/\b(?:no-store|private)\b/i.test(response.headers.get('cache-control') || '')

const save = async (request, response) => {
  try {
    await (await caches.open(cacheName)).put(request, response)
  } catch {
    // Quota or private browsing restrictions should leave the network response usable.
  }
}

const lookup = (request, name = cacheName) =>
  caches
    .open(name)
    .then((cache) => cache.match(request))
    .catch(() => undefined)

const network = async (request) => {
  const response = await fetch(request)
  return {
    response,
    saved: cacheable(response) ? save(request, response.clone()) : undefined,
  }
}

const navigate = async (request) => {
  try {
    const response = await fetch(request)
    // The offline HTML only changes when its matching scripts were staged at install.
    return { response: response.status < 500 ? response : (await lookup(shell)) || response }
  } catch {
    return { response: (await lookup(shell)) || Response.error() }
  }
}

const loadAsset = async (request) => {
  const cached = await lookup(request)
  if (cached) {
    return { response: cached }
  }
  // Current requests can still reference an immutable chunk from the preceding build.
  if (/\.[a-f0-9]{8}\.[^./]+$/i.test(new URL(request.url).pathname)) {
    const previous = (await previousCaches()).slice(-1)[0]
    if (previous) {
      const old = await lookup(request, previous)
      if (old) {
        return { response: old }
      }
    }
  }
  return network(request).catch(() => ({ response: Response.error() }))
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (
    request.method !== 'GET' ||
    request.headers.has('range') ||
    request.headers.has('authorization')
  ) {
    return
  }
  const url = new URL(request.url)
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) {
    return
  }
  const navigation = request.mode === 'navigate'
  const isShell = url.pathname === scope.pathname || url.pathname === scope.pathname + 'index.html'
  const asset =
    optional.has(url.pathname) ||
    (url.pathname.startsWith(assetPath) && staticAsset.test(url.pathname))
  if (
    navigation ? !isShell : !asset || request.cache === 'no-store' || request.cache === 'reload'
  ) {
    return
  }
  const result = navigation ? navigate(request) : loadAsset(request)
  event.respondWith(result.then(({ response }) => response))
  event.waitUntil(result.then(({ saved }) => saved).catch(() => undefined))
})
