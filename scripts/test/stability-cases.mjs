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
      await page.getByRole('button', { name: '对话偏好', exact: true }).click()
      const control = page.getByRole('switch', { name: '显示用量与费用', exact: true })
      assert.equal(await control.getAttribute('aria-checked'), 'true')
      await control.click()
      assert.equal(await control.getAttribute('aria-checked'), 'false')
      assert.equal(await page.evaluate(() => localStorage.getItem('freeseek:show-usage')), 'false')
      await page.evaluate(() => window.__audit.settingsDialog.closeSettings())
      await page.getByRole('dialog', { name: '对话偏好', exact: true }).waitFor({ state: 'hidden' })
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
      await page.getByRole('button', { name: '对话偏好', exact: true }).click()
      const saved = page.getByRole('switch', { name: '显示用量与费用', exact: true })
      assert.equal(await saved.getAttribute('aria-checked'), 'false')
      await saved.focus()
      await page.keyboard.press('Space')
      assert.equal(await saved.getAttribute('aria-checked'), 'true')
      await page.evaluate(() => window.__audit.settingsDialog.closeSettings())
      await page.getByRole('dialog', { name: '对话偏好', exact: true }).waitFor({ state: 'hidden' })
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

  for (const resume of [false, true]) {
    await run(
      resume
        ? 'native update resuming online favors fast mirrors that can keep the partial package'
        : 'native update completes over fast GitHub direct without any mirror probes',
      async (page) => {
        await page.evaluate(async (resume) => {
          const { update } = window.__audit
          const tag = 'v99.0.0'
          const name = 'freeseek-v99.0.0-release.apk'
          const url = 'https://github.com/WikG1018/FreeSeekApp/releases/download/' + tag + '/' + name
          const release = {
            tag_name: tag,
            assets: [{ name, size: 1000, browser_download_url: url, digest: 'sha256:' + 'a'.repeat(64) }],
          }
          window.androidBridge = {}
          window.updateRequests = []
          Object.defineProperty(navigator, 'onLine', { configurable: true, value: !resume })
          window.Capacitor.nativeCallback = () => 'progress-listener'
          let partialBytes = resume ? 300 : 0
          window.Capacitor.nativePromise = async (_, method, options) => {
            if (method === 'get') {
              return { status: 200, body: JSON.stringify(release) }
            }
            if (method === 'hasFile') {
              return { exists: false, partialBytes }
            }
            if (method === 'probe' || method === 'download') {
              const host = new URL(options.url).host
              window.updateRequests.push([method, host, options.offset ?? options.stopIfSlow])
              if (method === 'probe') {
                return {
                  bytesPerSecond: { 'gh-proxy.com': 3000, 'ghfast.top': 2500, 'ghproxy.net': 1000 }[host],
                  supportsRange: host !== 'gh-proxy.com',
                }
              }
              if (host === 'github.com' && resume) {
                partialBytes = 400
                return { slow: true, bytesPerSecond: 500 }
              }
              return { path: '/verified.apk', size: 1000 }
            }
          }
          await update.checkForUpdate({ force: true })
          if (resume) {
            if (update.useUpdate.getState().percent !== 30 || window.updateRequests.length) {
              throw new Error('Saved progress was not restored while offline')
            }
            update.initUpdateChecker()
            Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
            window.dispatchEvent(new Event('online'))
          }
        }, resume)
        await page.waitForFunction(() => window.__audit.update.useUpdate.getState().status === 'ready')
        assert.deepEqual(await page.evaluate(() => window.updateRequests), [
          ['download', 'github.com', true],
          ...(resume
            ? [
                ['probe', 'gh-proxy.com', 400],
                ['probe', 'ghfast.top', 400],
                ['probe', 'ghproxy.net', 400],
                ['download', 'ghfast.top', false],
              ]
            : []),
        ])
      },
      async (context) => {
        await context.addInitScript(() => {
          const method = (name, rtype = 'promise') => ({ name, rtype })
          window.Capacitor = {
            PluginHeaders: [
              {
                name: 'Update',
                methods: [
                  ...['get', 'hasFile', 'probe', 'download', 'removeListener'].map((name) => method(name)),
                  method('addListener', 'callback'),
                ],
              },
              { name: 'App', methods: [method('addListener', 'callback')] },
            ],
          }
        })
      }
    )
  }

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
      assert.match(result.logs, /transcription\.completed/)
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
    'document images rejected by the model are localized in current and saved replies',
    async (page) => {
      const error =
        "messages.1.content.0: file-api-rich-layout-fixture was parsed with 'rich_layout_recognition' " +
        'and contains images, which are not supported by this model (request_id: fixture-request)'
      const result = await page.evaluate(async (message) => {
        const a = window.__audit,
          f = a.fixtures
        a.settings.setApiKey('fake-key')
        a.providers.selectModel({ providerId: 'deepseek', model: 'deepseek-v4-pro' })
        const file = {
          id: 'layout-doc',
          serverId: 'file-api-rich-layout-fixture',
          name: 'report.pdf',
          size: 4,
          isImage: false,
          mimeType: 'application/pdf',
        }
        const session = f.session({
          title: 'Document discussion',
          messages: [
            f.user('first', 'Read the report', { files: [file] }),
            f.assistant('answer', 'Report notes'),
          ],
        })
        await a.seed([session], [{ id: file.id, blob: new Blob(['TEST']) }])
        const fetch = window.fetch
        window.__documentRequests = []
        window.fetch = (url, init) => {
          if (!String(url).endsWith('/messages')) return fetch(url, init)
          const body = JSON.parse(init.body)
          window.__documentRequests.push(body)
          return Promise.resolve(
            body.model === 'deepseek-v4-pro'
              ? new Response(JSON.stringify({ error: { message } }), { status: 400 })
              : a.response('Flash read the attachment')
          )
        }
        a.drafts.setDraftText(session.id, 'Continue with the next section')
        a.store.sendMessage(session.id)
        await a.waitIdle()
        const saved = a.store.useChatStore.getState().sessionCache[session.id]
        const reply = saved.messages.at(-1)
        return {
          reply: reply.id,
          key: reply.error?.localMessage?.key,
          calls: window.__documentRequests.length,
          attachment: saved.messages[0].files[0].serverId,
        }
      }, error)
      assert.equal(result.key, 'apiDocumentImagesUnsupported')
      assert.equal(result.calls, 1)
      assert.equal(result.attachment, 'file-api-rich-layout-fixture')
      assert.equal(uploads().length, 0)
      const reply = page.locator(`[data-message-id="${result.reply}"]`)
      const localized = /本轮或历史附件中有文档包含图片.*DeepSeek Flash.*重新生成/
      await reply.getByText(localized).waitFor()
      assert.doesNotMatch(await reply.innerText(), /rich_layout_recognition|fixture-request/)
      await page.evaluate(() =>
        window.__audit.providers.selectModel({ providerId: 'deepseek', model: 'deepseek-flash' })
      )
      await reply.getByRole('button', { name: '重新生成', exact: true }).click()
      await page.getByText('Flash read the attachment', { exact: true }).waitFor()
      const requests = await page.evaluate(() => window.__documentRequests)
      assert.deepEqual(
        requests.map((request) => request.model),
        ['deepseek-v4-pro', 'deepseek-flash']
      )
      assert.match(JSON.stringify(requests[1].messages), /file-api-rich-layout-fixture/)
      assert.equal(uploads().length, 0)

      await page.evaluate(async (message) => {
        const a = window.__audit,
          f = a.fixtures
        await a.seed([
          f.session({
            title: 'Saved error',
            messages: [
              f.user('legacy-q', 'Read the saved report'),
              f.assistant('legacy-a', '', {
                status: 'error',
                error: { kind: 'http', status: 400, message },
              }),
            ],
          }),
        ])
      }, error)
      const saved = page.locator('[data-message-id="legacy-a"]')
      await saved.getByText(localized).waitFor()
      await page.evaluate(() => window.__audit.settings.setLocale('en-US'))
      await saved
        .getByText(/A document in this chat contains images .*regenerate the reply/)
        .waitFor()
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
        d.logEvent(
          'api',
          'privacy.canary',
          {
            apiKey: 'sk-privacy-canary-12345678',
            text: 'CHAT_CONTENT_CANARY',
            filename: 'PRIVATE_FILENAME',
            content: 'ATTACHMENT_CONTENT_CANARY',
            detail: 'Bearer fake-secret-token sk-privacy-canary-12345678',
            ...d.diagnosticError(new Error('CHAT_CONTENT_CANARY')),
          },
          'warn'
        )
        await d.flushDiagnosticLogs()
        for (let i = 0; i < 2100; i++) {
          d.logEvent('upload', 'retention.check', { index: i })
        }
        const failure = new Error('Request failed\nMULTILINE_PRIVATE_CANARY')
        failure.name = 'CUSTOM_ERROR_NAME_CANARY'
        failure.stack +=
          '\n    at recover (https://private-endpoint.example/static/js/main.a1b2c3d4.js:12:34)'
        d.logEvent('api', 'privacy.retained', {
          apiKey: 'sk-privacy-canary-12345678',
          text: 'CHAT_CONTENT_CANARY',
          filename: 'PRIVATE_FILENAME',
          content: 'ATTACHMENT_CONTENT_CANARY',
          title: 'PRIVATE_TITLE_CANARY',
          query: 'PRIVATE_QUERY_CANARY',
          sessionId: 'privateid-patientrecord',
          url: 'https://private-endpoint.example/request?apikey=QUERY_CANARY',
          detail: 'Bearer fake-secret-token sk-privacy-canary-12345678',
          ...d.diagnosticError(failure),
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
        /sk-privacy-canary-12345678|CHAT_CONTENT_CANARY|PRIVATE_FILENAME|ATTACHMENT_CONTENT_CANARY|fake-secret-token|MULTILINE_PRIVATE_CANARY|CUSTOM_ERROR_NAME_CANARY|PRIVATE_TITLE_CANARY|private-endpoint\.example|QUERY_CANARY|privateid-patientrecord/
      )
      assert.match(result.texts['environment.json'], /apiKeyConfigured/)
      assert.match(result.texts['client-events.jsonl'], /privacy.retained/)
      assert.match(result.texts['client-events.jsonl'], /privacy.canary/)
      assert.match(result.texts['client-events.jsonl'], /legacy.issue/)
      assert.match(result.texts['client-events.jsonl'], /REDACTED/)
      assert.match(result.texts['client-events.jsonl'], /main\.a1b2c3d4\.js:12:34/)
    },
    async (context) => {
      await context.addInitScript(() => {
        if (localStorage.getItem('diag-v1-fixture-seeded')) return
        window.__seedReady = new Promise((resolve, reject) => {
          const open = indexedDB.open('freeseek-diagnostics', 1)
          open.onerror = () => reject(open.error)
          open.onupgradeneeded = () => {
            open.result
              .createObjectStore('events', { keyPath: 'id' })
              .createIndex('timestamp', 'timestamp')
          }
          open.onsuccess = () => {
            const database = open.result
            const transaction = database.transaction('events', 'readwrite')
            transaction.objectStore('events').put({
              id: '7ec29f83-7713-4bc8-b56c-9f84ff8b17e4',
              timestamp: Date.now() - 1000,
              source: 'client',
              scope: 'storage',
              event: 'legacy.issue',
              level: 'warn',
              details: {},
            })
            transaction.onabort = () => reject(transaction.error)
            transaction.oncomplete = () => {
              database.close()
              localStorage.setItem('diag-v1-fixture-seeded', 'true')
              resolve()
            }
          }
        })
      })
    }
  )

  await run(
    'diagnostic ZIP keeps Android environment probes and native events independently',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const collect = async () => {
          const { blob, name } = await a.diagnosticBundle.createDiagnosticBundle()
          const entries = {}
          for await (const entry of a.readArchive(new File([blob], name))) {
            entries[entry.path] = await (await a.readEntry(entry)).text()
          }
          return entries
        }
        const full = await collect()
        window.__diagnosticProbeFailed = true
        return { full, partial: await collect() }
      })
      const fullEnv = JSON.parse(result.full['environment.json'])
      const fullSummary = JSON.parse(result.full['summary.json'])
      assert.equal(fullEnv.app.platform, 'android')
      assert.equal(fullEnv.native.model, 'RMX3619')
      assert.equal(fullEnv.native.manufacturer, 'realme')
      assert.equal(fullEnv.native.sdk, 32)
      assert.equal(fullEnv.native.webviewVersion, '133.0.6943.78')
      assert.deepEqual(fullEnv.native.collection.memory, {
        state: 'unavailable',
        exception: 'SecurityException',
      })
      assert.deepEqual(fullEnv.native.network, { wifi: true, validated: true })
      assert.equal(fullSummary.collection.native, 'available')
      assert.equal(fullSummary.collection.nativeEvents, 'available')
      assert.equal(fullSummary.scopes.ui.issues >= 1, true)

      const partialEnv = JSON.parse(result.partial['environment.json'])
      const partialSummary = JSON.parse(result.partial['summary.json'])
      assert.deepEqual(partialEnv.native, { unavailable: true })
      assert.equal(partialSummary.collection.native, 'failed')
      assert.equal(partialSummary.collection.nativeEvents, 'available')
      assert.match(result.partial['native-events.jsonl'], /webview.renderer-exit/)
      assert.doesNotMatch(
        JSON.stringify(result),
        /PRIVATE_HARDWARE_ID|PRIVATE_CONNECTIVITY_MESSAGE/
      )
    },
    async (context) => {
      await context.addInitScript(() => {
        window.CapacitorCustomPlatform = { name: 'android' }
        window.Capacitor = {
          PluginHeaders: [
            {
              name: 'Diagnostics',
              methods: [
                { name: 'snapshot', rtype: 'promise' },
                { name: 'readEvents', rtype: 'promise' },
              ],
            },
          ],
          nativePromise: async (plugin, method) => {
            if (plugin !== 'Diagnostics') return {}
            const logs = {
              failedWrites: 0,
              events: [
                {
                  scope: 'ui',
                  event: 'webview.renderer-exit',
                  level: 'warn',
                  timestamp: Date.now(),
                  details: { crashed: true, message: 'PRIVATE_CONNECTIVITY_MESSAGE' },
                },
              ],
            }
            if (method === 'readEvents') return logs
            if (window.__diagnosticProbeFailed) throw new Error('PRIVATE_CONNECTIVITY_MESSAGE')
            return {
              ...logs,
              environment: {
                model: 'RMX3619',
                manufacturer: 'realme',
                sdk: 32,
                webviewVersion: '133.0.6943.78',
                imei: 'PRIVATE_HARDWARE_ID',
                collection: { memory: { state: 'unavailable', exception: 'SecurityException' } },
                ...Object.fromEntries(
                  Array.from({ length: 42 }, (_, index) => ['field' + index, index])
                ),
                network: { wifi: true, validated: true },
              },
            }
          },
        }
      })
    }
  )

  await run(
    'diagnostic ZIP links feature results without exposing provider or conversation data',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        await a.settings.setStartupPage('new-chat')
        a.settings.saveThirdPartySearch({
          enabled: true,
          keySource: 'separate',
          apiKey: 'PRIVATE_DIAG_SEARCH_KEY',
        })
        a.settings.setThirdPartySearchOn(true)
        const persona = a.personas.addPersona('PRIVATE_DIAG_PERSONA', 'PRIVATE_DIAG_PROMPT')
        a.personas.setDefaultPersona(persona)
        a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            model: 'PRIVATE_DIAG_MODEL',
            name: 'PRIVATE_DIAG_PROVIDER',
            url: 'https://private-diagnostic-provider.example/v1',
            apiKey: 'PRIVATE_DIAG_API_KEY',
            headers: { 'X-Tenant-Secret': 'PRIVATE_DIAG_HEADER' },
            stream: false,
          },
          true
        )
        const original = window.fetch
        window.fetch = async (url, init) => {
          if (String(url).endsWith('/v1/tools/search')) {
            return Response.json({
              results: [
                {
                  title: 'PRIVATE_DIAG_SOURCE',
                  url: 'https://private-source.example',
                  summary: 'PRIVATE_DIAG_EXCERPT',
                },
              ],
            })
          }
          if (String(url).includes('private-diagnostic-provider.example')) {
            const body = JSON.parse(init.body)
            if (body.tool_choice === 'auto' && !body.messages.some(({ role }) => role === 'tool')) {
              return Response.json({
                choices: [
                  {
                    message: {
                      tool_calls: [
                        {
                          id: 'diag-tool-1',
                          type: 'function',
                          function: {
                            name: 'freeseek_web_search',
                            arguments: JSON.stringify({ query: 'PRIVATE_DIAG_TERMS', count: 12 }),
                          },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
              })
            }
            return Response.json({
              choices: [{ message: { content: 'PRIVATE_DIAG_ANSWER' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 25, completion_tokens: 6 },
            })
          }
          return original(url, init)
        }
        a.drafts.addDraftFiles(
          null,
          [new File(['PRIVATE_DIAG_FILE_BYTES'], 'PRIVATE_DIAG_FILE.invalid')],
          ''
        )
        a.drafts.setDraftText(null, 'PRIVATE_DIAG_QUESTION')
        a.store.sendMessage(null)
        await a.waitIdle()
        const id = a.store.useChatStore.getState().activeId
        if (!id) throw new Error('Fixture chat did not start')
        await a.store.setSessionPinned(id, true)
        a.store.renameSession(id, 'PRIVATE_DIAG_TITLE')
        await a.backup
          .importHistory(new File(['not a zip'], 'PRIVATE_DIAG_BACKUP.zip'))
          .catch(() => {})
        a.settingsDialog.openSettings('usage')
      })
      await page.waitForFunction(async () => {
        const { events } = await window.__audit.diagnostics.readDiagnosticLogs()
        return events.some((event) => event.event === 'totals.read.completed')
      })
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const { blob, name } = await a.diagnosticBundle.createDiagnosticBundle()
        const entries = {}
        for await (const entry of a.readArchive(new File([blob], name))) {
          entries[entry.path] = await (await a.readEntry(entry)).text()
        }
        return entries
      })
      const events = result['client-events.jsonl']
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const find = (name) => events.find((event) => event.event === name)?.details
      const prepared = find('request.prepared')
      assert.equal(prepared.protocol, 'openai')
      assert.equal(prepared.offersIndependentSearch, true)
      assert.equal(find('provider.request').requestId, prepared.requestId)
      const searched = events.find(
        (event) => event.scope === 'search' && event.event === 'standalone.started'
      ).details
      const resultSearch = find('standalone.completed')
      assert.equal(searched.requestedCount, 12)
      assert.equal(resultSearch.operationId, searched.operationId)
      assert.equal(resultSearch.resultCount, 1)
      assert.equal(resultSearch.billed, true)
      assert.equal(find('reply.settled').standaloneSearches, 1)
      assert.equal(find('import.failed').failureKey, 'backupUnrecognized')
      assert.equal(find('import.started').operationId, find('import.failed').operationId)
      assert.equal(find('session.pin-changed').pinned, true)
      assert.equal(find('session.rename-requested').hasTitle, true)
      assert.ok(find('attachments.rejected'))
      assert.ok(find('custom.added'))
      assert.ok(find('totals.read.completed'))
      const environment = JSON.parse(result['environment.json'])
      const summary = JSON.parse(result['summary.json'])
      assert.equal(environment.preferences.startupPage, 'new-chat')
      assert.ok(environment.browser.capabilities.indexedDB)
      assert.ok(summary.scopes.backup.issues > 0)
      assert.ok(summary.scopes.persona.events > 0)
      assert.doesNotMatch(
        JSON.stringify(result),
        /PRIVATE_DIAG_|private-diagnostic-provider\.example|private-source\.example/
      )
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
        Object.defineProperty(navigator.storage, 'estimate', {
          configurable: true,
          value: () => {
            throw new DOMException('Estimate unavailable', 'SecurityError')
          },
        })
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
      assert.equal(JSON.parse(result['summary.json']).clientStorageAvailable, false)
      assert.deepEqual(JSON.parse(result['environment.json']).browserStorage, { unavailable: true })
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
    'diagnostic export reads persisted history when the current log write stalls',
    async (page) => {
      await page.evaluate(async () => {
        const diagnostics = window.__audit.diagnostics
        diagnostics.logEvent('storage', 'previous-run.saved')
        await diagnostics.flushDiagnosticLogs()
      })
      await page.reload()
      await page.waitForFunction(() => Boolean(window.__audit))
      const result = await page.evaluate(async () => {
        const a = window.__audit
        await a.diagnostics.flushDiagnosticLogs()
        const blocker = await new Promise((resolve, reject) => {
          const request = indexedDB.open('diagnostic-write-fixture', 1)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        const blocked = indexedDB.open('diagnostic-write-fixture', 2)
        const put = IDBObjectStore.prototype.put
        IDBObjectStore.prototype.put = function (...args) {
          return this.transaction.db.name === 'freeseek-diagnostics' ? blocked : put.apply(this, args)
        }
        try {
          a.diagnostics.logEvent('storage', 'current-run.pending')
          const pack = await a.diagnosticBundle.createDiagnosticBundle(), texts = {}
          for await (const entry of a.readArchive(new File([pack.blob], pack.name))) {
            texts[entry.path] = await (await a.readEntry(entry)).text()
          }
          return texts
        } finally {
          IDBObjectStore.prototype.put = put
          blocker.close()
        }
      })
      const summary = JSON.parse(result['summary.json'])
      assert.match(result['client-events.jsonl'], /previous-run\.saved/)
      assert.match(result['client-events.jsonl'], /current-run\.pending/)
      assert.equal(summary.clientLogFlush, 'timeout')
      assert.equal(summary.clientLogRead, 'available')
    }
  )

  await run(
    'chat web tool pricing follows both Beijing cutoffs while keeping per-reply and aggregate counts',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures,
          start = Date.UTC(2026, 9, 31, 16),
          end = Date.UTC(2026, 10, 18, 4),
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
        const current = a.usage.computeMessageUsage(usage, end)
        const cutoffCosts = [start - 1, start, end - 1, end, end + 1].map(
          (at) => a.usage.computeMessageUsage(usage, at).costCny
        )
        const sum = a.sumMessageUsage(usage, usage)
        const legacy = a.usage.computeMessageUsage(
          { ...usage, server_tool_use: { web_search_requests: 4 } },
          end - 1
        )
        const tokensAndTools = { ...usage, input_tokens: 1000 }
        const message = f.assistant('priced', 'Answer', {
          model: 'deepseek-flash',
          usage: a.sumMessageUsage(tokensAndTools, tokensAndTools),
          usageHistory: [
            { createdAt: end - 1, usage: tokensAndTools, model: 'deepseek-v4-flash-vision-exp' },
            { createdAt: end, usage: tokensAndTools, model: 'deepseek-flash' },
          ],
        })
        await a.seed([f.session({ messages: [f.user('question', 'Search and read'), message] })])
        const aggregate = (await a.usage.collectUsage()).total
        return {
          searches: current.searches,
          summed: a.usage.computeMessageUsage(sum, end).searches,
          legacy: [legacy.searches, legacy.costCny],
          cutoffCosts,
          replyCost: a.usage.computeReplyUsage(message).costCny,
          aggregate: {
            requests: aggregate.requests,
            calls: aggregate.webSearches,
            tokens: aggregate.cacheMissTokens,
            cost: aggregate.costCny,
            unpriced: aggregate.unpricedRequests,
          },
        }
      })
      assert.deepEqual(result, {
        searches: 6,
        summed: 12,
        legacy: [4, 0.02],
        cutoffCosts: [0, 0.03, 0.03, 0, 0],
        replyCost: 0.033,
        aggregate: { requests: 2, calls: 12, tokens: 2000, cost: 0.033, unpriced: 0 },
      })
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
    'update manifest bypasses a stale mirror and keeps the known newer release offline',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          attempts = []
        const release = (version) => ({
          tag_name: version,
          assets: [
            {
              name: 'freeseek-' + version + '-release.apk',
              size: 123,
              browser_download_url:
                'https://github.com/WikG1018/FreeSeekApp/releases/download/' +
                version +
                '/freeseek-' +
                version +
                '-release.apk',
              digest: 'sha256:' + 'a'.repeat(64),
            },
          ],
        })
        window.webkit = { messageHandlers: { bridge: {} } }
        const metadata = async (url) => {
          attempts.push(String(url))
          if (String(url).startsWith('https://gh-proxy.com/')) {
            return { status: 200, body: JSON.stringify(release('v2.9.1')) }
          }
          return String(url).startsWith('https://ghfast.top/') &&
            String(url).endsWith('/update.json')
            ? { status: 200, body: JSON.stringify(release('v99.0.0')) }
            : { status: 503, body: '{}' }
        }
        window.Capacitor.nativePromise = async (_, method, { url }) => {
          if (method === 'get') return metadata(url)
          throw new Error('APK not cached')
        }
        const found = await a.update.checkForUpdate({ force: true }),
          current = a.update.useUpdate.getState()
        window.Capacitor.nativePromise = async () => ({
          status: 200,
          body: JSON.stringify(release('v2.9.1')),
        })
        await a.update.checkForUpdate({ force: true })
        const preserved = a.update.useUpdate.getState().release.version
        window.Capacitor.nativePromise = async () => {
          throw new TypeError('Offline')
        }
        await a.update.checkForUpdate({ force: true })
        const offline = a.update.useUpdate.getState()
        delete window.webkit
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
    },
    async (context) => {
      await context.addInitScript(() => {
        window.Capacitor = {
          PluginHeaders: [{ name: 'Update', methods: [{ name: 'get', rtype: 'promise' }] }],
        }
      })
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
