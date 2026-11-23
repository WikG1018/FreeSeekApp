import assert from 'node:assert/strict'

const installFixture = (paths) => {
  const origin = 'https://example.org'
  const requests = []
  const stopped = []
  window.freeseekPublicWeb = {
    read: async ({ id, url, sameOrigin }) => {
      requests.push({ id, url, sameOrigin: Boolean(sameOrigin) })
      const response = paths[new URL(url).pathname]
      if (response?.wait) {
        return new Promise(() => {})
      }
      if (!response) {
        return { status: 403, url }
      }
      return {
        status: 200,
        contentType: response.type || 'text/html',
        bytes: new TextEncoder().encode(response.body),
        url,
      }
    },
    cancel: async ({ id }) => {
      stopped.push(id)
    },
  }
  return {
    origin,
    requests,
    stopped,
  }
}

export const runNativeBrowserCases = async (run) => {
  await run(
    'agent dynamic document opens modules and credential-free JSON in an isolated worker',
    async (page) => {
      const result = await page.evaluate((fixture) => {
        const { origin, requests } = new Function('paths', 'return (' + fixture + ')(paths)')({
          '/dynamic': {
            body:
              '<!doctype html><html><head><title>Dynamic fixture</title></head><body>' +
              '<main><h1 id="title">Loading</h1><p id="output"></p><p id="isolation"></p>' +
              '<p aria-hidden="true">Hidden control</p><a href="/next">Open reference</a>' +
              '<a href="javascript:void(0)">Invalid link</a></main>' +
              '<script type="module" src="/entry.js"></script></body></html>',
          },
          '/entry.js': {
            type: 'application/javascript',
            body:
              "import {title} from './chapter.js'; document.querySelector('#title').textContent=title;" +
              "fetch('/summary.json').then(r=>r.json()).then(data=>document.querySelector('#output').textContent= data.text);" +
              "fetch('https://outside.example/resource').catch(()=>{});" +
              "fetch('/unrequested-write', {method:'POST', body:'fixture'}).catch(()=>{});" +
              "fetch('/hidden?token=fixture-token').catch(()=>{});" +
              "document.querySelector('#isolation').textContent=(typeof WebSocket==='undefined'" +
              "&&typeof RTCPeerConnection==='undefined'&&typeof Capacitor==='undefined'" +
              "&&typeof process==='undefined'&&typeof localStorage==='undefined'" +
              "&&document.cookie==='')?'Isolated document':'Unexpected access';",
          },
          '/chapter.js': {
            type: 'application/javascript',
            body: "export const title = 'Dynamic chapter';",
          },
          '/summary.json': {
            type: 'application/json',
            body: '{"text":"Loaded from a public JSON resource"}',
          },
        })
        return window.__audit
          .readNativeBrowser(new URL(origin + '/dynamic'), new AbortController().signal, 10_000)
          .then((result) => ({
            result,
            requests: requests.map(({ url, sameOrigin }) => ({
              path: new URL(url).pathname,
              sameOrigin,
            })),
          }))
      }, installFixture.toString())
      assert.ok(result.result.snapshot, JSON.stringify(result))
      assert.deepEqual(result.result.snapshot.headings, ['Dynamic chapter'])
      assert.match(result.result.snapshot.text, /Loaded from a public JSON resource/)
      assert.match(result.result.snapshot.text, /Isolated document/)
      assert.doesNotMatch(result.result.snapshot.text, /Hidden control|Unexpected access/)
      assert.deepEqual(result.result.snapshot.links, [
        { url: 'https://example.org/next', label: 'Open reference' },
      ])
      assert.deepEqual(result.requests, [
        { path: '/dynamic', sameOrigin: false },
        { path: '/entry.js', sameOrigin: true },
        { path: '/chapter.js', sameOrigin: true },
        { path: '/summary.json', sameOrigin: true },
      ])
    }
  )

  await run(
    'agent dynamic document preserves the static preview when scripting is unavailable',
    async (page) => {
      const result = await page.evaluate((fixture) => {
        const { origin, requests } = new Function('paths', 'return (' + fixture + ')(paths)')({
          '/static': {
            body: '<main><p>A static reference</p></main>',
          },
          '/unsupported': {
            body:
              '<!doctype html><html><body><main><p>A static reference</p></main>' +
              '<script>document.querySelector("main").textContent = new WebSocket("wss://example.org").url</script></body></html>',
          },
        })
        const get = (path) =>
          window.__audit.readNativeBrowser(
            new URL(origin + path),
            new AbortController().signal,
            8000
          )
        return Promise.all([get('/static'), get('/unsupported')]).then((result) => ({
          outcomes: result.map((entry) => ({
            error: entry.error,
            reason: entry.reason,
            fallback: entry.fallback?.text.includes('A static reference'),
          })),
          requests: requests.length,
        }))
      }, installFixture.toString())
      assert.deepEqual(result.outcomes, [
        { error: 'browser', reason: 'no-scripts', fallback: true },
        { error: 'browser', reason: 'no-dynamic-content', fallback: true },
      ])
      assert.equal(result.requests, 2)
    }
  )

  await run('agent dynamic document cancels a native resource read when stopped', async (page) => {
    const result = await page.evaluate((fixture) => {
      const { origin, requests, stopped } = new Function(
        'paths',
        'return (' + fixture + ')(paths)'
      )({
        '/slow-document': {
          body: '<!doctype html><html><body><main><p>Waiting</p></main><script src="/slow-script.js"></script></body></html>',
        },
        '/slow-script.js': { wait: true },
      })
      const controller = new AbortController()
      const interval = setInterval(() => {
        if (requests.length === 2) {
          clearInterval(interval)
          controller.abort()
        }
      }, 20)
      return window.__audit
        .readNativeBrowser(new URL(origin + '/slow-document'), controller.signal, 8000)
        .then(
          () => ({ aborted: false }),
          (error) => ({
            aborted: error.name === 'AbortError',
            cancelledResource: stopped.includes(requests.at(-1)?.id),
          })
        )
        .finally(() => clearInterval(interval))
    }, installFixture.toString())
    assert.deepEqual(result, { aborted: true, cancelledResource: true })
  })
}
