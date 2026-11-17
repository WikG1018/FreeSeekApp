import assert from 'node:assert/strict'

export const runAndroidStabilityCases = async ({ run, behavior }) => {
  await run(
    'landscape software keyboard keeps text and send control within the viewport',
    async (page) => {
      await page.setViewportSize({ width: 800, height: 360 })
      await page.evaluate(() => {
        const a = window.__audit
        a.settings.setApiKey('fake')
        a.drafts.setDraftText(null, 'Landscape draft')
        Object.defineProperty(window.visualViewport, 'height', {
          configurable: true,
          get: () => 120,
        })
        Object.defineProperty(window.visualViewport, 'offsetTop', {
          configurable: true,
          get: () => 0,
        })
      })
      for (const existing of [false, true]) {
        if (existing) {
          await page.evaluate(async () => {
            const a = window.__audit,
              f = a.fixtures
            const session = f.session({
              messages: [f.user('u', 'hello'), f.assistant('a', 'reply')],
            })
            await a.seed([session])
            a.drafts.setDraftText(session.id, 'Continue')
          })
        }
        await page.locator('textarea').focus()
        await page.evaluate(() => visualViewport.dispatchEvent(new Event('resize')))
        await page.waitForTimeout(350)
        for (const locator of [
          page.locator('textarea'),
          page.getByRole('button', { name: '发送', exact: true }),
        ]) {
          const rect = await locator.boundingBox()
          assert.ok(
            rect && rect.y >= 0 && rect.height >= 20 && rect.y + rect.height <= 121,
            JSON.stringify({ existing, rect })
          )
        }
        await page.locator('textarea').blur()
      }
    }
  )
  await run(
    'cancel then retry same attachment cannot inherit or overwrite the cancelled job',
    async (page) => {
      behavior({ delay: 150 })
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          blob = new Blob(['data'])
        const old = a.uploads
          .uploadAttachment('fake-key', 'same-id', blob, 'data.txt', false)
          .catch((e) => e?.name)
        a.uploads.cancelUpload('same-id')
        const next = a.uploads.uploadAttachment('fake-key', 'same-id', blob, 'data.txt', false)
        const [oldError, id] = await Promise.all([old, next])
        return { oldError, id, task: a.uploads.useUploads.getState().tasks['same-id'] }
      })
      assert.equal(result.oldError, 'AbortError')
      assert.equal(result.task.status, 'done')
      assert.equal(result.id, 'file-api-new')
    }
  )
  await run(
    'cancelled queued upload settles without waiting for occupied network slots',
    async (page) => {
      behavior({ delay: 450 })
      const elapsed = await page.evaluate(async () => {
        const a = window.__audit,
          blob = new Blob(['data'])
        const running = Array.from({ length: 3 }, (_, i) =>
          a.uploads.uploadAttachment('key', 'run' + i, blob, 'data.txt', false)
        )
        const waiting = a.uploads
          .uploadAttachment('key', 'queued', blob, 'data.txt', false)
          .catch((e) => e?.name)
        const started = performance.now()
        a.uploads.cancelUpload('queued')
        const reason = await waiting,
          elapsed = performance.now() - started
        await Promise.all(running)
        return { elapsed, reason }
      })
      assert.equal(elapsed.reason, 'AbortError')
      assert.ok(elapsed.elapsed < 150)
    }
  )
  await run('SSE cancellation before reading closes source immediately', async (page) => {
    const result = await page.evaluate(async () => {
      const a = window.__audit,
        controller = new AbortController()
      let cancelled = false,
        name
      controller.abort()
      const start = performance.now()
      try {
        for await (const event of a.sse.readServerSentEvents(
          new ReadableStream({
            cancel() {
              cancelled = true
            },
          }),
          controller.signal,
          1000
        )) {
          void event
        }
      } catch (e) {
        name = e.name
      }
      return { name, cancelled, elapsed: performance.now() - start }
    })
    assert.equal(result.name, 'AbortError')
    assert.equal(result.cancelled, true)
    assert.ok(result.elapsed < 200)
  })
  await run('hung image decode times out and releases the next image operation', async (page) => {
    const result = await page.evaluate(async () => {
      const a = window.__audit,
        old = window.createImageBitmap
      a.image.imagePolicy.decodeTimeoutMs = 25
      window.createImageBitmap = () => new Promise(() => {})
      const file = new File(['invalid'], 'photo.png', { type: 'image/png' })
      let name
      try {
        await a.image.normalizeImageFile(file)
      } catch (e) {
        name = e.name
      }
      window.createImageBitmap = old
      const png = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5i8AAAAASUVORK5CYII='
        ),
        (c) => c.charCodeAt(0)
      )
      a.image.imagePolicy.decodeTimeoutMs = 30000
      return {
        name,
        next: (await a.image.normalizeImageFile(new File([png], 'ok.png', { type: 'image/png' })))
          .size,
      }
    })
    assert.equal(result.name, 'ImageDecodeTimeoutError')
    assert.equal(result.next, 68)
  })
  await run(
    'text drafts survive reload, send clears persisted text, and clearing history removes drafts',
    async (page) => {
      await page.evaluate(() => {
        const a = window.__audit
        a.drafts.setDraftText(null, '未发送草稿')
        a.drafts.flushDraftTexts()
      })
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          restored = a.drafts.getDraft(null).text
        a.settings.setApiKey('fake')
        const original = window.fetch
        window.fetch = async (url, init) =>
          String(url).endsWith('/messages') ? a.response() : original(url, init)
        a.store.sendMessage(null)
        await a.waitIdle()
        const afterSend = localStorage.getItem('freeseek:draft-texts')
        a.drafts.setDraftText(null, 'delete with history')
        a.drafts.flushDraftTexts()
        await a.backup.clearHistory()
        return { restored, afterSend, afterClear: localStorage.getItem('freeseek:draft-texts') }
      })
      assert.deepEqual(result, { restored: '未发送草稿', afterSend: null, afterClear: null })
    }
  )
  await run(
    'archive JSON admission rejects huge declared records before reading their bytes',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        let read = false,
          name
        try {
          await a.readJsonEntry({
            path: 'session.json',
            size: 33 * 1024 * 1024,
            stream: {
              async *[Symbol.asyncIterator]() {
                read = true
                yield new Uint8Array(1)
              },
            },
          })
        } catch (e) {
          name = e.key
        }
        return { read, name }
      })
      assert.deepEqual(result, { read: false, name: 'backupJsonTooLarge' })
    }
  )
  await run(
    'long audio playback applies backpressure and cancellation releases the stream',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        let created = 0,
          maxTime = 0,
          cancelled = false,
          error
        class FakeContext {
          state = 'running'
          currentTime = 0
          destination = {}
          createBuffer(_channels, length, rate) {
            created++
            return { duration: length / rate, copyToChannel() {} }
          }
          createBufferSource() {
            return {
              connect() {},
              disconnect() {},
              start(time) {
                maxTime = Math.max(maxTime, time)
              },
              onended: null,
              buffer: null,
            }
          }
          close() {
            this.state = 'closed'
            return Promise.resolve()
          }
        }
        window.AudioContext = FakeContext
        window.fetch = async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array(24000 * 2 * 60))
              },
              cancel() {
                cancelled = true
              },
            })
          )
        a.readAloud.toggleReadAloud('audio-long', 'test', (e) => (error = e.name))
        await new Promise((r) => setTimeout(r, 250))
        const scheduled = created
        a.readAloud.stopReadAloud()
        await new Promise((r) => setTimeout(r, 30))
        return {
          scheduled,
          maxTime,
          cancelled,
          error,
          status: a.readAloud.useReadAloud.getState().status,
        }
      })
      assert.ok(result.scheduled <= 6)
      assert.ok(result.maxTime <= 5.2)
      assert.equal(result.cancelled, true)
      assert.equal(result.status, 'idle')
      assert.equal(result.error, undefined)
    }
  )
  await run(
    'unsupported AudioContext reports failure without an uncaught click error',
    async (page) => {
      const result = await page.evaluate(() => {
        let error
        window.AudioContext = class {
          constructor() {
            throw new DOMException('Unsupported', 'NotSupportedError')
          }
        }
        const a = window.__audit
        a.readAloud.toggleReadAloud('a', 'test', (e) => (error = e.name))
        return { error, status: a.readAloud.useReadAloud.getState().status }
      })
      assert.deepEqual(result, { error: 'NotSupportedError', status: 'idle' })
    }
  )
}
