/*
 * FreeSeek 网页 App（PWA）的离线外壳。
 * 只在网页端注册：Android/Windows 原生壳由 src/index.html 拦截，不会注册本文件。
 *
 * 策略：
 * - 外壳（index.html、manifest、启动图标）安装时预缓存，弱网也能起得来；
 * - 静态产物（static/ 下的 js、css、字体、图片、wasm）缓存优先、后台更新；
 * - 导航请求联网优先，断网时回落到缓存的外壳；
 * - web-version.json 永不缓存，页面内的更新检查必须拿到最新版本；
 * - 带 Range 的请求（PDF 分片阅读）不接管，避免返回整份内容破坏断点读取。
 */
const CACHE = 'freeseek-shell-v1'
const SHELL = ['./', './manifest.webmanifest', './startup-mark.png', './icons/icon-192.png']
const NETWORK_ONLY = /\/web-version\.json$/
const STATIC_ASSET = /\.(?:js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|wasm|mjs|json)$/

/** 只缓存完整的同源响应；206 分片、跨域 opaque 一律不碰。 */
const cachePut = async (request, response) => {
  if (!response || response.status !== 200 || response.type !== 'basic') {
    return
  }
  try {
    const cache = await caches.open(CACHE)
    await cache.put(request, response)
  } catch (error) {
    // 配额不足等情况不影响页面本身
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // 单个文件失败（例如首访时刚好断网）不阻断安装
      await Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined)))
      await self.skipWaiting()
    })()
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
      await self.clients.claim()
    })()
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') {
    self.skipWaiting()
  }
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') {
    return
  }

  let url
  try {
    url = new URL(request.url)
  } catch (error) {
    return
  }
  // 模型接口等跨域请求直接交给浏览器，避免缓存干扰流式响应
  if (url.origin !== self.location.origin) {
    return
  }
  if (NETWORK_ONLY.test(url.pathname)) {
    return
  }
  if (request.headers.has('range')) {
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          cachePut(request, response.clone())
          return response
        })
        .catch(async () => {
          const cached = (await caches.match(request)) || (await caches.match('./'))
          return cached || Response.error()
        })
    )
    return
  }

  if (STATIC_ASSET.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request)
        const network = fetch(request)
          .then((response) => {
            cachePut(request, response.clone())
            return response
          })
          .catch(() => cached)
        return cached || (await network) || Response.error()
      })()
    )
  }
})
