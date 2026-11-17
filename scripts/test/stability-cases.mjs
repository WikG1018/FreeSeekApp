import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'

export const runStabilityCases = async ({ run, behavior, uploads, maxActive, root }) => {
  await run(
    'chat usage display switch persists while costs remain recorded and attachment notes stay hidden',
    async (page) => {
      await page.setViewportSize({ width: 1100, height: 850 })
      await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        const session = f.session({
          title: '显示偏好验收',
          messages: [
            f.user('u', '演示问题'),
            f.assistant('a', '演示回答', {
              usage: {
                input_tokens: 100,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                output_tokens: 50,
              },
              contextWarnings: [
                { key: 'contextAttachmentsSkipped', params: { count: 1, files: '测试附件.docx' } },
              ],
            }),
          ],
        })
        await a.seed([session])
        localStorage.setItem('freeseek:active-session', session.id)
      })
      await page.getByText('演示回答', { exact: true }).waitFor()
      assert.equal(await page.getByText(/本轮未读取/).count(), 0)
      assert.equal(await page.getByText(/150 tok/).count(), 2)
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('home'))
      const control = page.getByRole('switch', { name: '对话中显示 Token 与费用', exact: true })
      assert.equal(await control.getAttribute('aria-checked'), 'true')
      await control.click()
      assert.equal(await control.getAttribute('aria-checked'), 'false')
      assert.equal(await page.evaluate(() => localStorage.getItem('freeseek:show-usage')), 'false')
      await page.evaluate(() => window.__audit.settingsDialog.closeSettings())
      await page.getByRole('dialog', { name: '设置', exact: true }).waitFor({ state: 'hidden' })
      assert.equal(await page.getByText(/150 tok/).count(), 0)
      await page.reload()
      await page.getByText('演示回答', { exact: true }).waitFor()
      assert.equal(await page.getByText(/150 tok/).count(), 0)
      assert.equal(await page.getByText(/本轮未读取/).count(), 0)
      const recorded = await page.evaluate(async () => {
        const stats = await window.__audit.usage.collectUsage()
        return {
          requests: stats.total.requests,
          input: stats.total.cacheMissTokens,
          output: stats.total.outputTokens,
        }
      })
      assert.deepEqual(recorded, { requests: 1, input: 100, output: 50 })
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('home'))
      const saved = page.getByRole('switch', { name: '对话中显示 Token 与费用', exact: true })
      assert.equal(await saved.getAttribute('aria-checked'), 'false')
      await saved.focus()
      await page.keyboard.press('Space')
      assert.equal(await saved.getAttribute('aria-checked'), 'true')
      await page.evaluate(() => window.__audit.settingsDialog.closeSettings())
      await page.getByRole('dialog', { name: '设置', exact: true }).waitFor({ state: 'hidden' })
      assert.equal(await page.getByText(/150 tok/).count(), 2)
    }
  )

  await run(
    'switching an early answer into a long branch keeps its version selector visible',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        let session = a.branches.normalizeSession(
          f.session({
            messages: [
              f.user('root', 'Branch question'),
              f.assistant('short', 'Short branch answer'),
            ],
          })
        )
        const path = [f.assistant('long-version', 'Selected long branch answer')]
        for (let i = 0; i < 80; i++) {
          path.push(
            f.user('u' + i, 'Following question ' + i),
            f.assistant('a' + i, 'Following answer ' + i)
          )
        }
        session = a.branches.selectVersion(a.branches.appendBranch(session, 'root', path), 'short')
        await a.seed([session])
      })
      await page.getByRole('button', { name: '下一个版本', exact: true }).click()
      assert.equal(await page.getByText('Selected long branch answer', { exact: true }).count(), 1)
      assert.equal(await page.locator('[data-message-version="long-version"]').count(), 1)
      await page.getByRole('button', { name: '上一个版本', exact: true }).click()
      assert.equal(await page.getByText('Short branch answer', { exact: true }).count(), 1)
    }
  )

  await run(
    'offline update check restores verified ready APK and failed installation stays recoverable',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        window.androidBridge = {}
        const release = a.update.toRelease({
          tag_name: 'v99.0.0',
          assets: [
            {
              name: 'freeseek-v99.0.0-release.apk',
              size: 123,
              browser_download_url:
                'https://github.com/WikG1018/FreeSeekApp/releases/download/v99.0.0/freeseek-v99.0.0-release.apk',
              digest: 'sha256:' + 'a'.repeat(64),
            },
          ],
        })
        localStorage.setItem('freeseek:update-cache', JSON.stringify({ at: Date.now(), release }))
        window.Capacitor.nativePromise = async (_, method) => {
          if (method === 'hasFile') {
            return { exists: true, path: '/verified.apk', size: 123 }
          }
          if (method === 'install') {
            return { installed: false, reason: 'verification-or-install-failed' }
          }
          throw new TypeError('Offline')
        }
        a.update.useUpdate.setState({
          release,
          status: 'ready',
          filePath: '/verified.apk',
          percent: 100,
        })
        await a.update.checkForUpdate({ force: true })
        const offline = a.update.useUpdate.getState().status
        await a.update.checkForUpdate()
        const cached = a.update.useUpdate.getState().status
        const install = await a.update.installUpdate(),
          after = a.update.useUpdate.getState()
        delete window.androidBridge
        return {
          offline,
          cached,
          installed: install.installed,
          status: after.status,
          path: after.filePath,
        }
      })
      assert.deepEqual(result, {
        offline: 'ready',
        cached: 'ready',
        installed: false,
        status: 'available',
        path: '',
      })
    },
    async (context) => {
      await context.addInitScript(() => {
        window.Capacitor = {
          PluginHeaders: [
            {
              name: 'Update',
              methods: ['get', 'hasFile', 'install'].map((name) => ({ name, rtype: 'promise' })),
            },
          ],
        }
      })
    }
  )

  for (const [mode, body, key] of [
    ['network', {}, 'uploadNetworkError'],
    ['raw', '<html>upstream failure</html>', 'uploadResponseInvalid'],
  ]) {
    await run(`upload ${mode} failure stays retryable and never completes`, async (page) => {
      behavior({ mode, body })
      const task = await page.evaluate(async () => {
        const a = window.__audit
        try {
          await a.uploads.uploadAttachment(
            'fake-key',
            'network-test',
            new Blob(['file']),
            'document.txt',
            false
          )
        } catch {}
        return a.uploads.useUploads.getState().tasks['network-test']
      })
      assert.equal(task.status, 'error')
      assert.equal(task.retryable, true)
      assert.equal(task.error.key, key)
    })
  }

  await run(
    'server-side processing has its own timeout and records progress before completion',
    async (page) => {
      behavior({ delay: 900 })
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          phases = [],
          body = new FormData()
        a.multipart.uploadPolicy.idleTimeoutMs = 400
        a.multipart.uploadPolicy.processingTimeoutMs = 2500
        body.append('file', new Blob(['x'.repeat(512 * 1024)]), 'document.txt')
        const response = await a.multipart.postMultipart(
          a.client.API_ORIGIN + '/anthropic/v1/files',
          {
            operation: 'upload',
            headers: { 'x-api-key': 'fake-key' },
            body,
            onProgress: (p) => phases.push(p.phase),
          }
        )
        return { response, phases }
      })
      assert.equal(result.response.id, 'file-api-new')
      assert.ok(result.phases.includes('processing'))
    }
  )

  await run(
    'ASR shares bounded multipart transport and never logs the transcript',
    async (page) => {
      behavior({ body: { text: 'TRANSCRIPT_PRIVACY_CANARY' } })
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          transcript = await a.speech.transcribe(
            'fake-asr-key',
            new Blob(['test audio'], { type: 'audio/wav' })
          )
        const logs = await a.diagnostics.readDiagnosticLogs()
        return { transcript, logs: JSON.stringify(logs.events) }
      })
      assert.equal(result.transcript, 'TRANSCRIPT_PRIVACY_CANARY')
      assert.doesNotMatch(result.logs, /TRANSCRIPT_PRIVACY_CANARY|fake-asr-key|test audio/)
    }
  )

  for (const status of [401, 402, 408, 413, 429, 500, 503]) {
    await run(`upload HTTP ${status} has actionable recovery`, async (page) => {
      behavior({ status, body: { error: { message: 'Test failure' } } })
      const result = await page.evaluate(async () => {
        const a = window.__audit
        a.settings.setApiKey('fake-upload-key')
        a.drafts.addDraftFiles(
          null,
          [new File(['test'], 'document.txt', { type: 'text/plain' })],
          'fake-upload-key'
        )
        while (
          Object.values(a.uploads.useUploads.getState().tasks).some((t) => t.status === 'uploading')
        ) {
          await new Promise((r) => setTimeout(r, 5))
        }
        return Object.values(a.uploads.useUploads.getState().tasks)[0]
      })
      assert.equal(result.status, 'error')
      assert.equal(result.retryable, status !== 413)
      assert.equal(uploads().length, 1)
      if ([401, 402].includes(status)) {
        assert.equal(
          await page
            .getByRole('button', {
              name: status === 401 ? '配置 API Key' : '前往充值',
              exact: true,
            })
            .count(),
          1
        )
        behavior({ status: 200, body: { id: 'file-api-recovered' } })
        await page.evaluate(() => window.__audit.settings.setApiKey('fake-corrected-key'))
        await page.getByRole('button', { name: '重试失败附件', exact: true }).click()
        await page.waitForFunction(() =>
          Object.values(window.__audit.uploads.useUploads.getState().tasks).every(
            (t) => t.status === 'done'
          )
        )
        assert.equal(
          await page.evaluate(() =>
            Boolean(
              window.__audit.drafts.prepareDraftMessage(
                window.__audit.drafts.getDraft(null),
                window.__audit.uploads.useUploads.getState().tasks
              )
            )
          ),
          true
        )
        assert.equal(uploads().length, 2)
      }
    })
  }

  await run('upload malformed success never becomes a completed attachment', async (page) => {
    behavior({ body: { success: true } })
    const result = await page.evaluate(async () => {
      const a = window.__audit
      try {
        await a.uploads.uploadAttachment(
          'fake-key',
          'malformed-upload',
          new Blob(['test']),
          'test.txt',
          false
        )
      } catch {}
      return a.uploads.useUploads.getState().tasks['malformed-upload']
    })
    assert.deepEqual(result, {
      status: 'error',
      retryable: true,
      error: { key: 'uploadResponseInvalid' },
    })
  })

  await run('upload stalled response and manual cancellation release queue slots', async (page) => {
    behavior({ mode: 'stall-response' })
    const result = await page.evaluate(async () => {
      const a = window.__audit
      a.multipart.uploadPolicy.idleTimeoutMs = 100
      const started = performance.now()
      try {
        await a.uploads.uploadAttachment('fake-key', 'stall', new Blob(['test']), 'test.txt', false)
      } catch {}
      const task = a.uploads.useUploads.getState().tasks.stall
      const controller = new AbortController(),
        body = new FormData()
      body.append('file', new Blob(['test']), 'test.txt')
      const request = a.multipart
        .postMultipart(a.client.API_ORIGIN + '/anthropic/v1/files', {
          operation: 'upload',
          body,
          headers: { 'x-api-key': 'fake-key' },
          signal: controller.signal,
        })
        .catch((error) => error.name)
      controller.abort()
      return { task, elapsed: performance.now() - started, abort: await request }
    })
    assert.equal(result.task.error.key, 'uploadTimedOut')
    assert.equal(result.task.retryable, true)
    assert.equal(result.abort, 'AbortError')
    assert.ok(result.elapsed < 2500)
  })

  await run(
    'upload queue permits three requests and cancelling queued files sends nothing',
    async (page) => {
      behavior({ delay: 180 })
      await page.evaluate(async () => {
        const a = window.__audit
        const pending = Array.from({ length: 7 }, (_, i) =>
          a.uploads
            .uploadAttachment('fake-key', 'queue-' + i, new Blob(['data']), 'test.txt', false)
            .catch(() => null)
        )
        a.uploads.cancelUpload('queue-6')
        await Promise.all(pending)
      })
      assert.equal(maxActive(), 3)
      assert.equal(uploads().length, 6)
      assert.equal(
        await page.evaluate(() => window.__audit.uploads.useUploads.getState().tasks['queue-6']),
        undefined
      )
    }
  )

  await run(
    'corrupt images stop retrying; missing MIME BMP converts and oversized PNG resizes',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        try {
          await a.uploads.uploadAttachment(
            'fake-key',
            'broken',
            new Blob(['not an image'], { type: 'image/png' }),
            'broken.png',
            true
          )
        } catch {}
        const bmp = new Uint8Array(58),
          view = new DataView(bmp.buffer)
        bmp.set([66, 77])
        view.setUint32(2, 58, true)
        view.setUint32(10, 54, true)
        view.setUint32(14, 40, true)
        view.setInt32(18, 1, true)
        view.setInt32(22, 1, true)
        view.setUint16(26, 1, true)
        view.setUint16(28, 24, true)
        bmp.set([0, 0, 255, 0], 54)
        const file = new File([bmp], 'photo.bmp'),
          inferred = a.uploads.resolveMimeType(file)
        await a.uploads.uploadAttachment(
          'fake-key',
          'bmp',
          file,
          file.name,
          a.uploads.isImage(inferred)
        )
        const canvas = document.createElement('canvas')
        canvas.width = 10000
        canvas.height = 1
        const png = await new Promise((resolve) => canvas.toBlob(resolve))
        const normalized = await a.image.normalizeImageFile(
          new File([png], 'wide.png', { type: 'image/png' })
        )
        const bitmap = await createImageBitmap(normalized)
        const output = {
          broken: a.uploads.useUploads.getState().tasks.broken,
          inferred,
          width: bitmap.width,
          height: bitmap.height,
        }
        bitmap.close()
        return output
      })
      assert.equal(result.broken.retryable, false)
      assert.equal(result.inferred, 'image/bmp')
      assert.equal(result.width, 4096)
      assert.equal(result.height, 1)
      assert.equal(uploads().length, 1)
      const multipart = uploads()[0].prefix.toString('latin1')
      assert.match(multipart, /filename="photo.png"/)
      assert.doesNotMatch(multipart, /name="purpose"/)
      assert.match(multipart, /Content-Type: image\/png/)
    }
  )

  await run(
    'historical attachment outage blocks chat and recovers without losing originals',
    async (page) => {
      behavior({ status: 503, body: { error: { message: 'Busy' } } })
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures,
          fid = crypto.randomUUID()
        const file = {
          id: fid,
          serverId: null,
          name: 'context.txt',
          size: 4,
          isImage: false,
          mimeType: 'text/plain',
        }
        const session = f.session({
          messages: [f.user('u', 'Read attachment', { files: [file] }), f.assistant('a', 'Answer')],
        })
        await a.seed([session], [{ id: fid, blob: new Blob(['DATA'], { type: 'text/plain' }) }])
        a.settings.setApiKey('fake-key')
        window.__messageCalls = 0
        const fetch = window.fetch
        window.fetch = async (url, init) => {
          if (String(url).endsWith('/messages')) {
            window.__messageCalls++
            window.__lastPayload = JSON.parse(init.body)
            return a.response()
          }
          return fetch(url, init)
        }
        a.drafts.setDraftText(session.id, 'Continue')
        a.store.sendMessage(session.id)
        await a.waitIdle()
        const final = a.store.useChatStore.getState().sessionCache[session.id]
        window.__historyId = session.id
        return {
          status: final.messages.at(-1).status,
          error: final.messages.at(-1).error,
          files: final.messages[0].files.length,
          calls: window.__messageCalls,
        }
      })
      assert.equal(result.status, 'error')
      assert.equal(result.error.retryable, true)
      assert.equal(result.error.status, 503)
      assert.equal(result.files, 1)
      assert.equal(result.calls, 0)
      behavior({ status: 200, body: { id: 'file-api-recovered' } })
      const recovered = await page.evaluate(async () => {
        const a = window.__audit,
          id = window.__historyId
        const reply = a.store.useChatStore.getState().sessionCache[id].messages.at(-1)
        a.store.retryUpload(id, reply.id)
        await a.waitIdle()
        const final = a.store.useChatStore.getState().sessionCache[id]
        return {
          status: final.messages.at(-1).status,
          files: final.messages[0].files.length,
          payload: JSON.stringify(window.__lastPayload),
        }
      })
      assert.equal(recovered.status, 'done')
      assert.equal(recovered.files, 1)
      assert.match(recovered.payload, /file-api-recovered/)
    }
  )

  await run(
    'rejected historical image is omitted with warning while source and backup remain intact',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures,
          fid = crypto.randomUUID()
        const file = {
          id: fid,
          serverId: 'file-api-old',
          name: 'photo.png',
          size: 68,
          isImage: true,
          mimeType: 'image/png',
        }
        const session = f.session({
          messages: [f.user('u', 'Read image', { files: [file] }), f.assistant('a', 'Answer')],
        })
        const bytes = Uint8Array.from(
          atob(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5i8AAAAASUVORK5CYII='
          ),
          (x) => x.charCodeAt(0)
        )
        await a.seed([session], [{ id: fid, blob: new Blob([bytes], { type: 'image/png' }) }])
        a.settings.setApiKey('fake-key')
        let calls = 0
        const fetch = window.fetch
        window.fetch = async (url, init) => {
          if (!String(url).endsWith('/messages')) {
            return fetch(url, init)
          }
          calls++
          return JSON.stringify(JSON.parse(init.body).messages).includes('"type":"image"')
            ? new Response(
                JSON.stringify({
                  error: {
                    message: 'messages.0.content.0: You have uploaded an unsupported image',
                  },
                }),
                { status: 400 }
              )
            : a.response()
        }
        a.drafts.setDraftText(session.id, 'Continue')
        a.store.sendMessage(session.id)
        await a.waitIdle()
        const final = a.store.useChatStore.getState().sessionCache[session.id],
          pack = await a.backup.exportHistory()
        const names = []
        for await (const entry of a.readArchive(new File([pack.blob], pack.name))) {
          names.push(entry.path)
          await a.readEntry(entry)
        }
        return {
          status: final.messages.at(-1).status,
          warnings: final.messages.at(-1).contextWarnings,
          files: final.messages[0].files.length,
          original: Boolean(await a.db.loadFile(fid)),
          names,
          calls,
        }
      })
      assert.equal(result.status, 'done')
      assert.equal(result.files, 1)
      assert.equal(result.original, true)
      assert.ok(result.warnings.length > 0)
      assert.equal(result.calls, 3)
      assert.ok(result.names.some((name) => name.startsWith('freeseek/files/')))
    }
  )

  await run(
    'diagnostic logs persist, remain bounded and redact secrets and conversation content',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit,
          d = a.diagnostics
        a.settings.setApiKey('sk-privacy-canary-12345678')
        const session = a.fixtures.session({
          messages: [a.fixtures.user('private-user', 'CHAT_CONTENT_CANARY')],
        })
        await a.seed([session])
        d.logEvent('api', 'privacy.canary', {
          apiKey: 'sk-privacy-canary-12345678',
          text: 'CHAT_CONTENT_CANARY',
          filename: 'PRIVATE_FILENAME',
          content: 'ATTACHMENT_CONTENT_CANARY',
          detail: 'Bearer fake-secret-token sk-privacy-canary-12345678',
          ...d.diagnosticError(new Error('CHAT_CONTENT_CANARY')),
        })
        for (let i = 0; i < 2100; i++) {
          d.logEvent('upload', 'retention.check', { index: i })
        }
        d.logEvent('api', 'privacy.retained', {
          apiKey: 'sk-privacy-canary-12345678',
          text: 'CHAT_CONTENT_CANARY',
          filename: 'PRIVATE_FILENAME',
          content: 'ATTACHMENT_CONTENT_CANARY',
          detail: 'Bearer fake-secret-token sk-privacy-canary-12345678',
          ...d.diagnosticError(new Error('CHAT_CONTENT_CANARY')),
        })
        d.logEvent('api', 'persist.canary', { stage: 'after-retention' })
        await d.flushDiagnosticLogs()
      })
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          logs = await a.diagnostics.readDiagnosticLogs()
        const pack = await a.diagnosticBundle.createDiagnosticBundle(),
          texts = {}
        for await (const entry of a.readArchive(new File([pack.blob], pack.name))) {
          texts[entry.path] = await (await a.readEntry(entry)).text()
        }
        return {
          logs: logs.events.length,
          persisted: logs.events.some((e) => e.event === 'persist.canary'),
          texts,
        }
      })
      assert.equal(result.persisted, true)
      assert.ok(result.logs <= 2000)
      assert.equal(Object.keys(result.texts).length, 6)
      assert.doesNotMatch(
        JSON.stringify(result.texts),
        /sk-privacy-canary-12345678|CHAT_CONTENT_CANARY|PRIVATE_FILENAME|ATTACHMENT_CONTENT_CANARY|fake-secret-token/
      )
      assert.match(result.texts['environment.json'], /apiKeyConfigured/)
      assert.match(result.texts['client-events.jsonl'], /privacy.retained/)
      assert.match(result.texts['client-events.jsonl'], /REDACTED/)
    }
  )

  await run(
    'diagnostic export survives unavailable log storage using its bounded memory fallback',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const open = indexedDB.open.bind(indexedDB)
        indexedDB.open = (name, version) => {
          if (name === 'freeseek-diagnostics') {
            throw new DOMException('Blocked', 'SecurityError')
          }
          return open(name, version)
        }
        a.diagnostics.logEvent('storage', 'memory.fallback')
        await a.diagnostics.flushDiagnosticLogs()
        const pack = await a.diagnosticBundle.createDiagnosticBundle(),
          texts = {}
        for await (const entry of a.readArchive(new File([pack.blob], pack.name))) {
          texts[entry.path] = await (await a.readEntry(entry)).text()
        }
        indexedDB.open = open
        return texts
      })
      assert.match(result['client-events.jsonl'], /memory.fallback/)
      assert.equal(Object.keys(result).length, 6)
    },
    async (context) => {
      await context.addInitScript(() => {
        const open = indexedDB.open.bind(indexedDB)
        indexedDB.open = (name, version) => {
          if (name === 'freeseek-diagnostics') {
            throw new DOMException('Blocked', 'SecurityError')
          }
          return open(name, version)
        }
      })
    }
  )

  await run(
    'usage bills successful search and fetch calls and retains old backup compatibility',
    async (page) => {
      const result = await page.evaluate(() => {
        const a = window.__audit,
          usage = {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
            server_tool_use: {
              web_search_requests: 10,
              tool_search: 2,
              tool_fetch: 3,
              tool_image_search: 1,
            },
          }
        const current = a.usage.computeMessageUsage(usage, Date.now())
        const sum = a.sumMessageUsage(usage, usage)
        const legacy = a.usage.computeMessageUsage(
          { ...usage, server_tool_use: { web_search_requests: 4 } },
          Date.now()
        )
        return {
          searches: current.searches,
          summed: a.usage.computeMessageUsage(sum, Date.now()).searches,
          legacy: legacy.searches,
        }
      })
      assert.deepEqual(result, { searches: 6, summed: 12, legacy: 4 })
    }
  )

  await run(
    'About exports a readable diagnostic ZIP through the actual download button',
    async (page) => {
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('about'))
      const waiting = page.waitForEvent('download')
      await page.getByRole('button', { name: '保存诊断包到文件', exact: true }).click()
      const download = await waiting,
        path = resolve(root, 'tmp/regression/diagnostics-web.zip')
      await download.saveAs(path)
      const entries = unzipSync(await readFile(path))
      assert.equal(Object.keys(entries).length, 6)
      assert.equal(JSON.parse(strFromU8(entries['manifest.json'])).diagnostic_format_version, 1)
      assert.match(strFromU8(entries['client-events.jsonl']), /export.started/)
      await page.waitForFunction(
        () =>
          !Array.from(document.querySelectorAll('button')).find((e) =>
            e.textContent.includes('保存诊断包到文件')
          )?.disabled
      )
    }
  )

  await run(
    '1M text token payload remains complete while long history is paged for display',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures,
          messages = [],
          text = ' x'.repeat(500)
        for (let i = 0; i < 1000; i++) {
          messages.push(f.user('u' + i, text), f.assistant('a' + i, text))
        }
        const request = a.reply.toRequestMessages(messages, f.user('new', 'Continue'))
        await a.seed([f.session({ messages })])
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        return {
          count: request.length,
          textCharacters: request
            .map((m) =>
              typeof m.content === 'string'
                ? m.content
                : m.content
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text)
                    .join('')
            )
            .join('').length,
          rendered: document.querySelectorAll('.ds-assistant-message-main-content').length,
          domNodes: document.querySelectorAll('*').length,
        }
      })
      assert.equal(result.count, 2001)
      assert.ok(result.textCharacters >= 2_000_000)
      assert.equal(result.rendered, 20)
      assert.ok(result.domNodes < 1500)
      await page.getByRole('button', { name: /加载更早的消息/ }).click()
      assert.equal(await page.locator('.ds-assistant-message-main-content').count(), 40)
    }
  )

  await run(
    'single long message folds visually and keeps the full original in request and backup',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures,
          text = ' x'.repeat(500000)
        const session = f.session({
          messages: [f.user('long', text), f.assistant('answer', 'Answer')],
        })
        await a.seed([session])
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        return {
          original:
            a.store.useChatStore.getState().sessionCache[session.id].messages[0].content.length,
          rendered: document.body.textContent.length,
          payload: JSON.stringify(
            a.reply.toRequestMessages(session.messages, f.user('new', 'Continue'))
          ).length,
        }
      })
      assert.equal(result.original, 1_000_000)
      assert.ok(result.rendered < 20000)
      assert.ok(result.payload > 1_000_000)
      await page.getByRole('button', { name: /展开全文/ }).click()
      assert.ok((await page.locator('body').textContent()).length > 1_000_000)
      await page.getByRole('button', { name: '收起全文', exact: true }).click()
      assert.ok((await page.locator('body').textContent()).length < 20000)
    }
  )

  await run(
    'update manifest works when all API routes fail and stale mirror metadata keeps the known newer release',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          attempts = []
        const release = {
          tag_name: 'v99.0.0',
          assets: [
            {
              name: 'freeseek-v99.0.0-release.apk',
              size: 123,
              browser_download_url:
                'https://github.com/WikG1018/FreeSeekApp/releases/download/v99.0.0/freeseek-v99.0.0-release.apk',
              digest: 'sha256:' + 'a'.repeat(64),
            },
          ],
        }
        const fetch = window.fetch
        window.fetch = async (url) => {
          attempts.push(String(url))
          return String(url).startsWith('https://ghfast.top/') &&
            String(url).endsWith('/update.json')
            ? new Response(JSON.stringify(release))
            : new Response('{}', { status: 503 })
        }
        const found = await a.update.checkForUpdate({ force: true }),
          current = a.update.useUpdate.getState()
        window.fetch = async () =>
          new Response(JSON.stringify({ ...release, tag_name: 'v1.0.0', assets: [] }))
        await a.update.checkForUpdate({ force: true })
        const preserved = a.update.useUpdate.getState().release.version
        window.fetch = async () => {
          throw new TypeError('Offline')
        }
        await a.update.checkForUpdate({ force: true })
        const offline = a.update.useUpdate.getState()
        window.fetch = fetch
        return {
          found,
          version: current.release.version,
          attempts,
          preserved,
          offline: { status: offline.status, version: offline.release.version },
        }
      })
      assert.equal(result.found, true)
      assert.equal(result.version, '99.0.0')
      assert.equal(result.preserved, '99.0.0')
      assert.deepEqual(result.offline, { status: 'available', version: '99.0.0' })
      assert.ok(
        result.attempts.some(
          (url) =>
            url ===
            'https://ghfast.top/https://github.com/WikG1018/FreeSeekApp/releases/latest/download/update.json'
        )
      )
    }
  )

  await run('HTTP error response body cannot leave a chat stuck after headers', async (page) => {
    const result = await page.evaluate(async () => {
      const a = window.__audit,
        fetch = window.fetch
      globalThis.__FS_RESPONSE_BODY_MS__ = 30
      window.fetch = async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{'))
            },
          }),
          { status: 401 }
        )
      const started = performance.now()
      try {
        await a.client.request('https://invalid.test/messages', {})
      } catch (error) {
        window.fetch = fetch
        return { status: error.status, elapsed: performance.now() - started }
      }
    })
    assert.equal(result.status, 401)
    assert.ok(result.elapsed < 1000)
  })

  await run(
    'context limit error offers a fresh chat and preserves the full original history',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        const session = f.session({
          messages: [f.user('u', 'Original history'), f.assistant('a', 'Original answer')],
        })
        await a.seed([session])
        a.settings.setApiKey('fake-key')
        const fetch = window.fetch
        window.fetch = async (url, init) =>
          String(url).endsWith('/messages')
            ? new Response(
                JSON.stringify({ error: { message: 'Maximum context length exceeded' } }),
                { status: 400 }
              )
            : fetch(url, init)
        a.drafts.setDraftText(session.id, 'Continue')
        a.store.sendMessage(session.id)
        await a.waitIdle()
        const final = a.store.useChatStore.getState().sessionCache[session.id]
        return {
          original: final.messages[0].content,
          key: final.messages.at(-1).error.localMessage.key,
        }
      })
      assert.equal(result.original, 'Original history')
      assert.equal(result.key, 'replyContextTooLong')
      assert.equal(
        await page.getByRole('button', { name: '新建不带历史的对话', exact: true }).count(),
        1
      )
    }
  )
}
