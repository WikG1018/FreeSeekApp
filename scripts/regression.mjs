import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { runStabilityCases } from './test/stability-cases.mjs'
import { runCompatibilityCases } from './test/compatibility-cases.mjs'
import { runAndroidStabilityCases } from './test/android-stability-cases.mjs'
import { runProviderCases } from './test/provider-cases.mjs'
import { runImmersiveCases } from './test/immersive-cases.mjs'
import { runImportCases } from './test/import-cases.mjs'
import { runNavigationCases } from './test/navigation-cases.mjs'
import { runInterfaceCases } from './test/interface-cases.mjs'
import { runCompressionCases } from './test/compression-cases.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.FREESEEK_TEST_PORT) || 8187
const base = `http://127.0.0.1:${port}`
const results = []
let uploadBehavior = { status: 200, body: { id: 'file-api-new' }, mode: 'normal', delay: 0 }
let uploadRequests = [],
  activeUploads = 0,
  maxActiveUploads = 0
const apiServer = createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Headers', '*')
  response.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  response.setHeader('Access-Control-Expose-Headers', 'x-ds-request-id')
  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }
  if (request.url === '/models') {
    response.setHeader('Content-Type', 'application/json')
    response.end('{"data":[]}')
    return
  }
  if (!['/anthropic/v1/files', '/v1/tools/asr'].includes(request.url)) {
    response.writeHead(404)
    response.end()
    return
  }
  const behavior = { ...uploadBehavior },
    chunks = []
  let bytes = 0
  request.on('data', (chunk) => {
    bytes += chunk.length
    if (bytes <= 64 * 1024) {
      chunks.push(chunk)
    }
  })
  request.on('end', () => {
    uploadRequests.push({ bytes, prefix: Buffer.concat(chunks) })
    activeUploads++
    maxActiveUploads = Math.max(maxActiveUploads, activeUploads)
    response.once('close', () => {
      activeUploads--
    })
    response.setHeader('Content-Type', 'application/json')
    response.setHeader('x-ds-request-id', 'test-upstream-request')
    if (behavior.mode === 'network') {
      response.destroy()
      return
    }
    if (behavior.mode === 'stall-response') {
      response.writeHead(200)
      response.write('{"id":')
      return
    }
    setTimeout(() => {
      response.writeHead(behavior.status)
      response.end(behavior.mode === 'raw' ? String(behavior.body) : JSON.stringify(behavior.body))
    }, behavior.delay)
  })
  request.on('error', () => response.destroy())
})
await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve))
const apiOrigin = `http://127.0.0.1:${apiServer.address().port}`
let output = ''
const server = spawn(
  process.execPath,
  [
    resolve(root, 'node_modules/@rspack/cli/bin/rspack.js'),
    'serve',
    '-c',
    'scripts/test/rspack.config.mjs',
  ],
  {
    cwd: root,
    env: { ...process.env, FREESEEK_TEST_API_ORIGIN: apiOrigin },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }
)
server.stdout.on('data', (data) => {
  output += data
})
server.stderr.on('data', (data) => {
  output += data
})
let browser
const run = async (name, test, setup, waitReady = true) => {
  if (process.env.FREESEEK_TEST_FILTER && !new RegExp(process.env.FREESEEK_TEST_FILTER).test(name))
    return
  uploadBehavior = { status: 200, body: { id: 'file-api-new' }, mode: 'normal', delay: 0 }
  uploadRequests = []
  maxActiveUploads = 0
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 390, height: 844 },
  })
  await context.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1'
      ? route.continue()
      : route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
  )
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  try {
    if (setup) {
      await setup(context)
    }
    await page.goto(`${base}/?e2e=1`)
    if (waitReady) {
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
    }
    await test(page)
    assert.deepEqual(pageErrors, [], 'uncaught page errors')
    results.push({ name, passed: true })
    console.log(`PASS ${name}`)
  } catch (error) {
    results.push({ name, passed: false, error: String(error) })
    console.error(`FAIL ${name}: ${error}`)
  } finally {
    await context.close()
  }
}

try {
  const deadline = Date.now() + 30000
  while (true) {
    try {
      if ((await fetch(base)).ok) {
        break
      }
    } catch {}
    if (Date.now() > deadline || server.exitCode !== null) {
      throw new Error(output)
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  browser = await chromium.launch({ headless: true })
  await mkdir(resolve(root, 'tmp/regression'), { recursive: true })
  await runCompressionCases(run)
  await runCompatibilityCases(run)
  await runAndroidStabilityCases({
    run,
    behavior: (value) => {
      uploadBehavior = { ...uploadBehavior, ...value }
    },
  })
  await runProviderCases({ run })
  await runImmersiveCases({ run })
  await runImportCases({ run })
  await runNavigationCases({ run })
  await runInterfaceCases({ run })
  await runStabilityCases({
    run,
    root,
    behavior: (value) => {
      uploadBehavior = { ...uploadBehavior, ...value }
    },
    uploads: () => uploadRequests,
    maxActive: () => maxActiveUploads,
  })

  await run('current mobile UI and persona picker', async (page) => {
    assert.equal(await page.title(), 'FreeSeek')
    await page.getByRole('button', { name: /选择新对话的人设/ }).click()
    await page.getByRole('option', { name: /^写作助手/ }).click()
    assert.equal(
      await page.evaluate(() => localStorage.getItem('freeseek:default-persona')),
      'builtin-writer'
    )
    await page.getByRole('button', { name: /选择新对话的人设/ }).click()
    await page.getByRole('button', { name: '管理人设', exact: true }).click()
    await page.getByRole('button', { name: '新建人设' }).click()
    await page.locator('#persona-name').fill('回归测试人设')
    await page.locator('#persona-prompt').fill('用于回归测试。')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    assert.equal(
      await page.evaluate(() =>
        window.__audit.personas.usePersonas
          .getState()
          .personas.some((p) => p.name === '回归测试人设')
      ),
      true
    )
  })

  await run(
    'lossless backup preserves files, context, branches, usage and personas',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures,
          fid = crypto.randomUUID()
        a.settings.setApiKey('audit-secret-key-must-not-be-exported')
        const personaId = a.personas.addPersona('Custom', 'A custom persona')
        a.usage.setPricing({ ...a.usage.DEFAULT_PRICING, offPeakOut: 6 })
        a.personas.setDefaultPersona(personaId)
        const session = f.session({
          persona: { name: 'Custom', prompt: 'A custom persona' },
          inherited: {
            fromId: crypto.randomUUID(),
            fromTitle: 'Previous',
            messages: [f.user('iu', 'Inherited'), f.assistant('ia', 'Inherited answer')],
          },
          messages: [
            f.user('u', 'Document', {
              files: [
                {
                  id: fid,
                  serverId: 'file-api-old',
                  name: 'report.pdf',
                  size: 7,
                  mimeType: 'application/pdf',
                  isImage: false,
                },
              ],
            }),
            f.assistant('a', 'First answer', {
              usage: {
                input_tokens: 10,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
                output_tokens: 20,
              },
              latestReminder: 'original reminder',
              thinking: true,
            }),
          ],
        })
        const branched = a.branches.appendBranch(session, 'u', [f.assistant('alt', 'Alternative')])
        await a.seed(
          [branched],
          [{ id: fid, blob: new Blob(['PDFDATA'], { type: 'application/pdf' }) }]
        )
        const zip = await a.exportArchive([branched])
        const file = new File([zip], 'backup.zip')
        const paths = [],
          strings = []
        for await (const entry of a.readArchive(file)) {
          paths.push(entry.path)
          const blob = await a.readEntry(entry)
          if (entry.path.endsWith('.json')) {
            strings.push(await blob.text())
          }
        }
        a.personas.removePersona(personaId)
        a.usage.setPricing(a.usage.DEFAULT_PRICING)
        await a.backup.importHistory(file)
        const restored = await a.db.loadSession(session.id)
        return {
          persona: restored.persona,
          inherited: restored.inherited.messages[0].content,
          usage: restored.messages[1].usage.output_tokens,
          reminder: restored.messages[1].latestReminder,
          document: await (await a.db.loadFile(fid)).text(),
          mime: (await a.db.loadFile(fid)).type,
          libraryRestored: a.personas.usePersonas.getState().defaultId === personaId,
          pricingRestored: a.usage.usePricing.getState().pricing.offPeakOut === 6,
          branchCount: restored.messages.length,
          visibleAnswer: a.branches.getVisibleMessages(restored).at(-1).blocks[0].text,
          apiKeyLeaked: strings.join('').includes('audit-secret-key-must-not-be-exported'),
          filesCount: paths.filter((path) => path.includes('/files/')).length,
        }
      })
      assert.deepEqual(result, {
        persona: { name: 'Custom', prompt: 'A custom persona' },
        inherited: 'Inherited',
        usage: 20,
        reminder: 'original reminder',
        document: 'PDFDATA',
        mime: 'application/pdf',
        libraryRestored: true,
        pricingRestored: true,
        branchCount: 3,
        visibleAnswer: 'Alternative',
        apiKeyLeaked: false,
        filesCount: 1,
      })
    }
  )

  await run(
    'backup retains unsaved attachment originals when local storage is full',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        a.settings.setApiKey('fake-key')
        window.fetch = async (url) =>
          String(url).endsWith('/files')
            ? new Response(JSON.stringify({ id: 'file-api-test' }))
            : a.response()
        a.drafts.addDraftFiles(
          null,
          [new File(['UNSAVED ORIGINAL'], 'file.txt', { type: 'text/plain' })],
          'fake-key'
        )
        while (
          Object.values(a.uploads.useUploads.getState().tasks).some(
            (task) => task.status === 'uploading'
          )
        ) {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        const put = IDBObjectStore.prototype.put
        IDBObjectStore.prototype.put = function (...args) {
          if (this.name === 'files' || this.name === 'sessions') {
            throw new DOMException('Quota full', 'QuotaExceededError')
          }
          return put.apply(this, args)
        }
        let exported
        try {
          a.drafts.setDraftText(null, 'Keep the attachment')
          a.store.sendMessage(null)
          await a.waitIdle()
          exported = await a.backup.exportHistory()
        } finally {
          IDBObjectStore.prototype.put = put
        }
        await a.backup.importHistory(new File([exported.blob], exported.name))
        const session = (await a.db.loadAllSessions())[0]
        return await (await a.db.loadFile(session.messages[0].files[0].id)).text()
      })
      assert.equal(result, 'UNSAVED ORIGINAL')
    }
  )

  await run('legacy official backup remains importable', async (page) => {
    const result = await page.evaluate(async () => {
      const a = window.__audit,
        f = a.fixtures
      const session = f.session({
        messages: [f.user('u', 'Legacy question'), f.assistant('a', 'Legacy answer')],
      })
      const data = a.toSessionFile(session, () => null)
      const json = (value) => new Blob([JSON.stringify(value)])
      const zip = await a.writeArchive([
        { name: 'manifest.json', blob: json({ export_format_version: 3 }) },
        { name: `chat_sessions/${session.id}.json`, blob: json(data) },
        { name: 'chat_session_index.json', blob: json([a.toIndexEntry(data)]) },
      ])
      await a.backup.importHistory(new File([zip], 'official.zip'))
      return (await a.db.loadSession(session.id)).messages.map((m) =>
        m.role === 'user' ? m.content : m.blocks[0].text
      )
    })
    assert.deepEqual(result, ['Legacy question', 'Legacy answer'])
  })

  await run('incomplete native backup rolls back existing history', async (page) => {
    const result = await page.evaluate(async () => {
      const a = window.__audit,
        session = a.fixtures.session({ messages: [a.fixtures.user('u', 'Keep me')] })
      await a.seed([session])
      const zip = await a.writeArchive([
        {
          name: 'manifest.json',
          blob: new Blob([
            JSON.stringify({
              freeseek_backup_version: 1,
              sessions: [crypto.randomUUID()],
              files: [],
              personas: [],
              defaultPersonaId: 'builtin-default',
            }),
          ]),
        },
      ])
      let rejected = false
      try {
        await a.backup.importHistory(new File([zip], 'missing.zip'))
      } catch {
        rejected = true
      }
      return {
        rejected,
        text: (await a.db.loadSession(session.id)).messages[0].content,
        importing: a.store.useChatStore.getState().importingHistory,
      }
    })
    assert.deepEqual(result, { rejected: true, text: 'Keep me', importing: false })
  })

  await run(
    'continuation retains earlier generations and clearing removes pending context',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        const session = f.session({
          messages: [f.user('u', 'Second'), f.assistant('a', 'Second answer')],
          inherited: {
            fromId: crypto.randomUUID(),
            fromTitle: 'First',
            messages: [f.user('iu', 'First'), f.assistant('ia', 'First answer')],
          },
        })
        await a.seed([session])
        a.store.startInheritSession(session.id)
        const carried = a.store.useChatStore
          .getState()
          .inheritFrom.messages.filter((m) => m.role === 'user')
          .map((m) => m.content)
        await a.backup.clearHistory()
        return {
          carried,
          inheritance: a.store.useChatStore.getState().inheritFrom,
          stored: (await a.db.loadAllSessions()).length,
        }
      })
      assert.deepEqual(result, { carried: ['First', 'Second'], inheritance: null, stored: 0 })
    }
  )

  await run('deleting source preserves inherited attachment original', async (page) => {
    const result = await page.evaluate(async () => {
      const a = window.__audit,
        f = a.fixtures,
        fid = crypto.randomUUID()
      const messages = [
        f.user('u', 'File', {
          files: [
            {
              id: fid,
              serverId: 'file-api-old',
              name: 't.txt',
              size: 4,
              isImage: false,
              mimeType: 'text/plain',
            },
          ],
        }),
        f.assistant('a', 'Answer'),
      ]
      const source = f.session({ messages }),
        continuation = f.session({
          inherited: { fromId: source.id, fromTitle: 'Source', messages },
        })
      await a.seed([source, continuation], [{ id: fid, blob: new Blob(['DATA']) }])
      await a.db.deleteSession(source.id)
      const retained = await (await a.db.loadFile(fid)).text()
      await a.db.deleteSession(continuation.id)
      return { retained, removedAfterLastReference: !(await a.db.loadFile(fid)) }
    })
    assert.deepEqual(result, { retained: 'DATA', removedAfterLastReference: true })
  })

  await run('expired inherited file is uploaded again and request recovers', async (page) => {
    const result = await page.evaluate(async () => {
      const a = window.__audit,
        f = a.fixtures,
        fid = crypto.randomUUID()
      a.settings.setApiKey('fake-key')
      const session = f.session({
        inherited: {
          fromId: crypto.randomUUID(),
          fromTitle: 'Source',
          messages: [
            f.user('iu', 'File', {
              files: [
                {
                  id: fid,
                  serverId: 'file-api-expired',
                  name: 't.txt',
                  size: 3,
                  isImage: false,
                  mimeType: 'text/plain',
                },
              ],
            }),
            f.assistant('ia', 'Answer'),
          ],
        },
      })
      await a.seed([session], [{ id: fid, blob: new Blob(['123']) }])
      let uploads = 0,
        requests = 0
      window.fetch = async (url, init) => {
        if (String(url).endsWith('/files')) {
          uploads++
          return new Response(JSON.stringify({ id: 'file-api-new' }))
        }
        requests++
        if (JSON.stringify(JSON.parse(init.body).messages).includes('file-api-expired')) {
          return new Response(
            JSON.stringify({
              error: {
                message:
                  'file_ids do not exist or are not created under your account: file-api-expired',
              },
            }),
            { status: 400 }
          )
        }
        return a.response()
      }
      a.drafts.setDraftText(session.id, 'Continue')
      a.store.sendMessage(session.id)
      await a.waitIdle()
      const final = a.store.useChatStore.getState().sessionCache[session.id]
      return {
        uploads,
        requests,
        status: final.messages.at(-1).status,
        fileId: final.inherited.messages[0].files[0].serverId,
      }
    })
    result.uploads = uploadRequests.length
    assert.deepEqual(result, { uploads: 1, requests: 2, status: 'done', fileId: 'file-api-new' })
  })

  await run('normal chat, regeneration, edits and rejected invalid import', async (page) => {
    const result = await page.evaluate(async () => {
      const a = window.__audit
      a.settings.setApiKey('fake-key')
      window.fetch = async () => a.response()
      a.drafts.setDraftText(null, 'Question')
      a.store.sendMessage(null)
      await a.waitIdle()
      const id = a.store.useChatStore.getState().activeId
      a.store.regenerateReply(id)
      await a.waitIdle()
      const root = a.store.useChatStore.getState().sessionCache[id].messages[0].id
      a.store.editMessage(id, root, 'Edited')
      await a.waitIdle()
      const session = a.store.useChatStore.getState().sessionCache[id]
      let invalidRejected = false
      try {
        await a.backup.importHistory(new File(['BAD'], 'bad.zip'))
      } catch {
        invalidRejected = true
      }
      return {
        count: session.messages.length,
        original: session.messages[0].content,
        last: session.messages.at(-1).status,
        invalidRejected,
        preserved: (await a.db.loadSession(id)).messages.length === 5,
      }
    })
    assert.deepEqual(result, {
      count: 5,
      original: 'Question',
      last: 'done',
      invalidRejected: true,
      preserved: true,
    })
  })

  await run('continuation usage is cumulative and statistics count both requests', async (page) => {
    const result = await page.evaluate(async () => {
      const a = window.__audit
      a.settings.setApiKey('fake-key')
      let count = 0
      window.fetch = async () => {
        const second = ++count === 2
        return a.response(
          second ? 'continued' : 'first',
          {
            input_tokens: second ? 600 : 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: second ? 10 : 500,
          },
          second ? 'end_turn' : 'max_tokens'
        )
      }
      a.drafts.setDraftText(null, 'Question')
      a.store.sendMessage(null)
      await a.waitIdle()
      const id = a.store.useChatStore.getState().activeId
      a.store.continueReply(id, a.store.useChatStore.getState().sessionCache[id].messages.at(-1).id)
      await a.waitIdle()
      const reply = a.store.useChatStore.getState().sessionCache[id].messages.at(-1)
      const totals = (await a.usage.collectUsage()).total
      return {
        output: reply.usage.output_tokens,
        input: reply.usage.input_tokens,
        history: reply.usageHistory.length,
        requests: totals.requests,
        statsOutput: totals.outputTokens,
      }
    })
    assert.deepEqual(result, { output: 510, input: 700, history: 2, requests: 2, statsOutput: 510 })
  })

  await run(
    'headers and body both have bounded idle waits; manual abort remains distinct',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        window.__FS_REQUEST_HEADERS_MS__ = 20
        window.fetch = (_url, init) =>
          new Promise((_, reject) =>
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
          )
        let headerError
        try {
          await a.client.request('https://example.invalid', {})
        } catch (e) {
          headerError = [e.kind, e.localMessage.key]
        }
        let bodyError
        try {
          for await (const _event of a.sse.readServerSentEvents(
            new ReadableStream({ start() {} }),
            undefined,
            20
          )) {
          }
        } catch (e) {
          bodyError = e.name
        }
        const controller = new AbortController()
        const pending = a.client
          .request('https://example.invalid', { signal: controller.signal })
          .catch((e) => e.name)
        controller.abort()
        return { headerError, bodyError, manual: await pending }
      })
      assert.deepEqual(result, {
        headerError: ['network', 'streamIdleTimeout'],
        bodyError: 'StreamIdleTimeoutError',
        manual: 'AbortError',
      })
    }
  )

  await run('TTS finishes when audio ends before the network stream', async (page) => {
    await page.evaluate(() => {
      const a = window.__audit
      window.fetch = async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(480))
              setTimeout(() => controller.close(), 500)
            },
          })
        )
      document.body.addEventListener(
        'click',
        () => a.readAloud.toggleReadAloud('audio', 'Test', () => {}),
        { once: true }
      )
    })
    await page.mouse.click(20, 400)
    await page.waitForTimeout(1000)
    assert.equal(
      await page.evaluate(() => window.__audit.readAloud.useReadAloud.getState().status),
      'idle'
    )
  })

  await run('Mermaid renders valid charts and cannot inject global CSS', async (page) => {
    const result = await page.evaluate(async () => {
      const a = window.__audit,
        target = document.createElement('div')
      document.body.append(target)
      const before = getComputedStyle(target).backgroundColor
      const valid = await a.renderMermaid('flowchart LR\n A --> B', false, () => false)
      const code =
        '%%{init: {"fontFamily": "x;a{b} :not(&){background:rgb(3, 123, 99) !important} c{d}"}}%%\nflowchart LR\n A --> B'
      const host = document.createElement('div')
      host.innerHTML = await a.renderMermaid(code, false, () => false)
      document.body.append(host)
      return {
        valid: valid.includes('<svg'),
        unchanged: getComputedStyle(target).backgroundColor === before,
      }
    })
    assert.deepEqual(result, { valid: true, unchanged: true })
  })

  await run('math rendering survives KaTeX dependency upgrade', async (page) => {
    await page.evaluate(async () => {
      const a = window.__audit,
        f = a.fixtures
      await a.seed([
        f.session({ messages: [f.user('u', 'Formula'), f.assistant('a', '$$E=mc^2$$')] }),
      ])
    })
    await page.locator('.katex math').first().waitFor()
    assert.ok((await page.locator('.katex').first().textContent()).includes('E'))
  })

  await run('settings trap focus and scaled mobile input remains visible', async (page) => {
    await page.evaluate(() => window.__audit.settingsDialog.openSettings('home'))
    await page.waitForTimeout(250)
    assert.equal(
      await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]')),
      true
    )
    await page.locator('[role="dialog"] button').last().focus()
    await page.keyboard.press('Tab')
    assert.equal(
      await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]')),
      true
    )
    await page.evaluate(() => window.__audit.settingsDialog.closeSettings())
    await page.waitForTimeout(250)
    for (const scale of [0.85, 1, 1.25]) {
      await page.evaluate((scale) => window.__audit.settings.setFontScale(scale), scale)
      await page.locator('textarea').focus()
      await page.waitForTimeout(80)
      const rect = await page.locator('textarea').boundingBox()
      assert.ok(
        rect.y >= 0 && rect.y + rect.height <= 845,
        `scale ${scale}: ${JSON.stringify(rect)}`
      )
      await page.locator('textarea').blur()
    }
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 })
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => {
          window.__audit.settings.setFontScale(1)
          window.__audit.settings.setThemePreference(theme)
        }, theme)
        await page.waitForTimeout(80)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width)
        await page.screenshot({ path: resolve(root, `tmp/regression/${theme}-${width}.png`) })
      }
    }
  })

  await run('release metadata rejects foreign APK URLs', async (page) => {
    const result = await page.evaluate(() => {
      const parse = (url) =>
        window.__audit.update.toRelease({
          tag_name: 'v9.9.9',
          assets: [
            {
              name: 'freeseek-v9.9.9-release.apk',
              size: 1234567,
              browser_download_url: url,
            },
          ],
        })
      let rejected = false
      try {
        parse('https://evil.example/app.apk')
      } catch {
        rejected = true
      }
      const valid = parse(
        'https://github.com/WikG1018/FreeSeekApp/releases/download/v9.9.9/freeseek-v9.9.9-release.apk'
      )
      return { rejected, version: valid.version }
    })
    assert.deepEqual(result, { rejected: true, version: '9.9.9' })
  })

  await run(
    'v11 upgrade rebuilds inherited attachment references',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        await a.db.deleteSession('migration-source')
        return {
          original: await (await a.db.loadFile('migration-file')).text(),
          version: (await indexedDB.databases()).find((db) => db.name === 'freeseek').version,
        }
      })
      assert.deepEqual(result, { original: 'KEPT', version: 13 })
    },
    (context) =>
      context.addInitScript(() => {
        window.__seedReady = new Promise((resolve, reject) => {
          const request = indexedDB.open('freeseek', 11)
          request.onupgradeneeded = () => {
            for (const name of [
              'sessions',
              'sessionSummaries',
              'files',
              'sessionsStaging',
              'filesStaging',
            ]) {
              const store = request.result.createObjectStore(name, { keyPath: 'id' })
              if (name === 'sessionSummaries') {
                store.createIndex('fileIds', 'fileIds', { multiEntry: true })
              }
            }
          }
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result,
              now = Date.now()
            const tx = db.transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
            const message = {
              id: 'u',
              role: 'user',
              createdAt: now,
              content: 'File',
              files: [
                {
                  id: 'migration-file',
                  name: 't.txt',
                  size: 4,
                  mimeType: 'text/plain',
                  isImage: false,
                  serverId: null,
                },
              ],
            }
            const source = {
              id: 'migration-source',
              title: 'Source',
              createdAt: now,
              updatedAt: now,
              messages: [message],
            }
            const continuation = {
              id: 'migration-copy',
              title: 'Copy',
              createdAt: now,
              updatedAt: now,
              messages: [],
              inherited: { fromId: source.id, fromTitle: 'Source', messages: [message] },
            }
            for (const session of [source, continuation]) {
              tx.objectStore('sessions').put(session)
              tx.objectStore('sessionSummaries').put({
                id: session.id,
                title: session.title,
                createdAt: now,
                updatedAt: now,
                fileIds: session.id === source.id ? ['migration-file'] : [],
              })
            }
            tx.objectStore('files').put({ id: 'migration-file', blob: new Blob(['KEPT']) })
            tx.oncomplete = () => {
              db.close()
              resolve()
            }
            tx.onerror = () => reject(tx.error)
          }
        })
      })
  )
} finally {
  await browser?.close()
  server.kill()
  apiServer.closeAllConnections()
  await new Promise((resolve) => apiServer.close(resolve))
  await mkdir(resolve(root, 'tmp/regression'), { recursive: true })
  await writeFile(resolve(root, 'tmp/regression/results.json'), JSON.stringify(results, null, 2))
}
const failed = results.filter((result) => !result.passed)
console.log(`${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  process.exitCode = 1
}
