// Run against a production build. The browser and server are confined to loopback.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { chromium } from 'playwright'

const dist = new URL('../../dist/', import.meta.url)
const types = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost')
  if (url.pathname === '/fixture') {
    response.setHeader('Content-Type', 'text/html')
    response.end('<!doctype html><title>Sibling cache fixture</title>')
    return
  }
  if (url.pathname === '/free-a/static/session.json') {
    response.setHeader('Content-Type', 'application/json')
    response.setHeader('Cache-Control', 'public, max-age=60')
    response.end(JSON.stringify({ authenticated: Boolean(request.headers.authorization) }))
    return
  }
  if (url.pathname === '/free-a/static/private.json') {
    response.setHeader('Content-Type', 'application/json')
    response.setHeader('Cache-Control', 'private, no-store')
    response.end('{"private":true}')
    return
  }
  const asset = /^\/free-[ab]\/([a-zA-Z0-9./_-]*)$/.exec(url.pathname)?.[1]
  if (asset === undefined || asset.split('/').includes('..')) {
    response.writeHead(404).end()
    return
  }
  const path = asset || 'index.html'
  try {
    const bytes = await readFile(new URL(path, dist))
    response.setHeader('Content-Type', types[extname(path)] ?? 'application/octet-stream')
    response.setHeader('Cache-Control', 'max-age=0, must-revalidate')
    response.end(bytes)
  } catch {
    response.writeHead(404).end()
  }
})

const siblingCache = 'other-site-cache'
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = 'http://127.0.0.1:' + server.address().port
const browser = await chromium.launch()
try {
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 390, height: 844 },
  })
  await context.addInitScript(() => {
    localStorage.setItem('freeseek:notice-version', '1')
    localStorage.setItem('freeseek:onboarded', '1')
  })
  const page = await context.newPage()
  await page.goto(origin + '/fixture')
  await page.evaluate(async (key) => {
    const cache = await caches.open(key)
    await cache.put('/fixture', new Response('keep sibling data'))
  }, siblingCache)
  await page.goto(origin + '/free-a/')
  await page.getByTestId('chat-composer').waitFor()
  // Localhost is a secure context. Register explicitly since the production page expects HTTPS.
  await page.evaluate(() => navigator.serviceWorker.register('./sw.js').then(() => true))
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  const online = await page.evaluate(async (siblingCache) => {
    const response = await fetch('./static/session.json', {
      headers: { Authorization: 'Bearer test-session' },
    })
    await fetch('./static/private.json')
    await fetch('./web-version.json', { cache: 'no-store' })
    const keys = await caches.keys()
    return {
      sibling: keys.includes(siblingCache),
      authenticated: (await response.json()).authenticated,
      cachedAuthenticated: Boolean(
        await caches.match(new URL('./static/session.json', location.href))
      ),
      cachedPrivate: Boolean(await caches.match(new URL('./static/private.json', location.href))),
      cachedVersion: Boolean(await caches.match(new URL('./web-version.json', location.href))),
      keys,
    }
  }, siblingCache)

  const second = await context.newPage()
  await second.goto(origin + '/free-b/')
  await second.getByTestId('chat-composer').waitFor()
  await second.evaluate(() => navigator.serviceWorker.register('./sw.js').then(() => true))
  await second.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  const afterSecondInstall = await second.evaluate(() => caches.keys())

  await context.setOffline(true)
  const offline = await context.newPage()
  const failures = []
  offline.on('requestfailed', (request) => {
    failures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText })
  })
  offline.on('pageerror', (error) => failures.push({ error: error.message }))
  let composerReady = false
  try {
    await offline.goto(origin + '/free-a/', { waitUntil: 'domcontentloaded', timeout: 10_000 })
    await offline.getByTestId('chat-composer').waitFor({ timeout: 10_000 })
    composerReady = true
  } catch (error) {
    console.log('Offline startup:', error.message.split('\n')[0])
    const state = await offline
      .evaluate(() => ({
        controlled: Boolean(navigator.serviceWorker.controller),
        startup: window.__FreeSeekStartup?.snapshot?.(),
      }))
      .catch(() => undefined)
    console.log(JSON.stringify({ failures, state }))
  }
  console.log(JSON.stringify({ online, afterSecondInstall, composerReady }))
  assert.equal(online.sibling, true, 'activation must keep caches owned by another site')
  assert.equal(online.authenticated, true)
  assert.equal(
    online.cachedAuthenticated,
    false,
    'an authenticated response must never enter the shell cache'
  )
  assert.equal(online.cachedPrivate, false, 'private responses must remain network-only')
  assert.equal(online.cachedVersion, false, 'web updates must be checked against the network')
  assert.equal(afterSecondInstall.includes(siblingCache), true)
  assert.equal(
    afterSecondInstall.filter((key) => key !== siblingCache).length,
    2,
    'scopes keep separate shell caches'
  )
  assert.equal(composerReady, true, 'the app must open offline after just one online visit')
  console.log(
    'PASS production PWA cold offline startup, separate cache scopes and network-only responses'
  )
} finally {
  await browser.close()
  server.close()
}
