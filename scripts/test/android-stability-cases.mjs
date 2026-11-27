import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const runAndroidStabilityCases = async ({ run, behavior }) => {
  await run(
    'Android camera opens its own capture, never opens the photo picker on failure, and releases the photo',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: 'Camera attachment test',
            url: 'https://camera-test.example/v1',
            model: 'test-model',
            apiKey: 'fixture',
          },
          true
        )
        const canvas = document.createElement('canvas')
        canvas.width = 120
        canvas.height = 80
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg'))
        window.cameraFixture = blob
        const fetchBefore = window.fetch
        window.fetch = (url, options) =>
          String(url).includes('/_capacitor_file_/data/photo-test.jpg')
            ? Promise.resolve(new Response(blob))
            : fetchBefore(url, options)
      })
      const choose = async (action) => {
        await page.getByRole('button', { name: '添加附件', exact: true }).click()
        await page.getByRole('button', { name: action, exact: true }).click()
      }
      const opened = []
      page.on('filechooser', (chooser) => opened.push(chooser))
      await choose('拍照')
      await page.waitForFunction(() => window.nativeCameraCalls.take === 1)
      assert.equal(opened.length, 0)
      await page.evaluate(() => (window.nativeCameraMode = 'unavailable'))
      await choose('拍照')
      await page.getByText('找不到可用的相机应用。可以从相册选图。', { exact: true }).waitFor()
      assert.equal(opened.length, 0)
      await page.evaluate(() => (window.nativeCameraMode = 'photo'))
      await choose('拍照')
      await page.waitForFunction(
        () => window.__audit.drafts.getDraft(null).attachments.length === 1
      )
      const result = await page.evaluate(() => ({
        calls: window.nativeCameraCalls,
        name: window.__audit.drafts.getDraft(null).attachments[0].file.name,
        bytes: window.__audit.drafts.getDraft(null).attachments[0].file.size,
        expected: window.cameraFixture.size,
      }))
      assert.deepEqual(result.calls, { take: 3, release: 1 })
      assert.match(result.name, /^照片-\d+\.jpg$/)
      assert.equal(result.bytes, result.expected)
      assert.equal(opened.length, 0)
      const picker = page.waitForEvent('filechooser')
      await choose('相册')
      assert.equal(await (await picker).element().getAttribute('capture'), null)
      assert.equal(await page.evaluate(() => window.nativeCameraCalls.take), 3)
    },
    async (context) => {
      await context.addInitScript(() => {
        window.CapacitorCustomPlatform = { name: 'android' }
        window.nativeCameraCalls = { take: 0, release: 0 }
        window.nativeCameraMode = 'cancel'
        window.Capacitor = {
          convertFileSrc: (path) => '/_capacitor_file_' + path,
          PluginHeaders: [
            {
              name: 'App',
              methods: [
                { name: 'addListener', rtype: 'callback' },
                { name: 'removeListener', rtype: 'promise' },
                { name: 'getState', rtype: 'promise' },
              ],
            },
            {
              name: 'PhotoCapture',
              methods: ['take', 'release'].map((name) => ({ name, rtype: 'promise' })),
            },
          ],
          nativeCallback: () => 'camera-test-listener',
          nativePromise: async (plugin, method) => {
            if (plugin !== 'PhotoCapture') return { isActive: true }
            window.nativeCameraCalls[method]++
            if (method === 'release') return {}
            if (window.nativeCameraMode === 'unavailable') throw { code: 'camera-unavailable' }
            if (window.nativeCameraMode === 'photo') {
              return {
                id: 'test.jpg',
                path: '/data/photo-test.jpg',
                size: window.cameraFixture.size,
              }
            }
            return { cancelled: true }
          },
        }
      })
    }
  )
  await run(
    'chat image preview closes on tap or Android Back and the reply survives switching chats',
    async (page) => {
      const id = await page.evaluate(async () => {
        const a = window.__audit
        const canvas = document.createElement('canvas')
        canvas.width = 160
        canvas.height = 100
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
        const file = {
          id: 'image-preview-file',
          name: '历史图片.png',
          size: blob.size,
          mimeType: 'image/png',
          isImage: true,
          serverId: 'saved-image-server-id',
        }
        const session = a.fixtures.session({
          messages: [
            a.fixtures.user('image-preview-user', '原来的聊天', { files: [file] }),
            a.fixtures.assistant('image-preview-assistant', '这里有张图片'),
          ],
        })
        const other = a.fixtures.session({ id: 'different-chat', title: '另一段对话' })
        await a.seed([session, other], [{ id: file.id, blob }])
        a.settings.setApiKey('preview-test-key')
        const original = window.fetch
        const encoder = new TextEncoder()
        window.previewTestRequests = 0
        window.fetch = async (url, init) => {
          if (!String(url).endsWith('/messages')) return original(url, init)
          window.previewTestRequests++
          return new Response(
            new ReadableStream({
              start(controller) {
                const push = (event) =>
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
                push({
                  type: 'content_block_start',
                  index: 0,
                  content_block: { type: 'text', text: '第一段' },
                })
                window.finishPreviewReply = () => {
                  push({
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'text_delta', text: '继续生成完成' },
                  })
                  push({ type: 'content_block_stop', index: 0 })
                  push({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })
                  push({ type: 'message_stop' })
                  controller.close()
                }
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } }
          )
        }
        a.drafts.setDraftText(session.id, '继续聊')
        return session.id
      })
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await page.getByText('第一段', { exact: true }).waitFor()
      const thumb = page.getByRole('button', { name: '查看图片 历史图片.png' })
      const preview = page.getByRole('dialog', { name: '历史图片.png', exact: true })
      await thumb.click()
      assert.equal(
        await preview
          .getByRole('img', { name: '历史图片.png' })
          .evaluate((img) => img.naturalWidth),
        160
      )
      await preview.getByRole('button', { name: '关闭图片预览' }).click()
      await preview.waitFor({ state: 'hidden' })
      await thumb.click()
      await preview.waitFor()
      await page.evaluate(() => window.previewTestBack())
      await preview.waitFor({ state: 'hidden' })
      const openDrawer = async () => {
        const opener = page.getByRole('button', { name: '打开边栏', exact: true })
        if (await opener.isVisible()) {
          await opener.click()
        }
      }
      await openDrawer()
      const generating = page.locator(`[data-session-id="${id}"]`)
      await generating.locator('button').first().getByText('回复中', { exact: true }).waitFor()
      await page.getByRole('button', { name: '另一段对话', exact: true }).click()
      await page.getByTestId('chat-header').getByText('另一段对话', { exact: true }).waitFor()
      const result = await page.evaluate(async (id) => {
        const a = window.__audit
        const active = a.store.useChatStore.getState()
        const stillStreaming =
          active.activeId === 'different-chat' && Object.hasOwn(active.streaming, id)
        window.finishPreviewReply()
        await a.waitIdle()
        const reply = a.store.useChatStore.getState().sessionCache[id].messages.at(-1)
        return {
          stillStreaming,
          status: reply.status,
          text: a.reply.getReplyText(reply),
          requests: window.previewTestRequests,
        }
      }, id)
      assert.deepEqual(result, {
        stillStreaming: true,
        status: 'done',
        text: '第一段继续生成完成',
        requests: 1,
      })
      await openDrawer()
      assert.equal(await generating.getAttribute('data-session-activity'), null)
      await generating.locator('button').first().click()
      await page.getByText('第一段继续生成完成', { exact: true }).waitFor()
      assert.equal(page.context().pages().length, 1)
    },
    async (context) => {
      await context.addInitScript(() => {
        const listeners = []
        window.CapacitorCustomPlatform = { name: 'android' }
        window.Capacitor = {
          PluginHeaders: [
            {
              name: 'App',
              methods: [
                { name: 'addListener', rtype: 'callback' },
                { name: 'removeListener', rtype: 'promise' },
                { name: 'getState', rtype: 'promise' },
              ],
            },
          ],
          nativeCallback: (_, method, options, callback) => {
            if (method === 'addListener' && options.eventName === 'backButton')
              listeners.push(callback)
            return 'preview-test-listener'
          },
          nativePromise: async () => ({ isActive: true }),
        }
        window.previewTestBack = () =>
          listeners.forEach((callback) => callback({ canGoBack: false }))
      })
    }
  )
  await run(
    'image preview becomes operable when the thumbnail dimensions are available',
    async (page) => {
      let deliver
      const ready = new Promise((resolve) => {
        deliver = resolve
      })
      await page.route('**/controlled-photo.png', async (route) => {
        await ready
        await route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
            'base64'
          ),
        })
      })
      await page.evaluate(async () => {
        const a = window.__audit
        const url = URL.createObjectURL
        URL.createObjectURL = (blob) =>
          blob.type === 'image/png' ? '/controlled-photo.png' : url(blob)
        const file = {
          id: 'loading-photo',
          name: '加载中的照片.png',
          size: 3,
          mimeType: 'image/png',
          isImage: true,
          serverId: null,
        }
        await a.seed(
          [
            a.fixtures.session({
              messages: [a.fixtures.user('loading-image', '', { files: [file] })],
            }),
          ],
          [{ id: file.id, blob: new Blob(['png'], { type: file.mimeType }) }]
        )
      })
      const thumb = page.getByRole('button', { name: '查看图片 加载中的照片.png' })
      try {
        await thumb.waitFor()
        assert.equal(await thumb.isEnabled(), false)
      } finally {
        deliver()
      }
      await thumb.click()
      await page.getByRole('dialog', { name: '加载中的照片.png' }).waitFor()
      await page.keyboard.press('Escape')
      await page.getByRole('dialog', { name: '加载中的照片.png' }).waitFor({ state: 'hidden' })
      await page.waitForFunction(
        () => document.activeElement?.getAttribute('aria-label') === '查看图片 加载中的照片.png'
      )
    }
  )
  await run(
    'full-screen image viewer keeps the pinch focal point and separates panning from taps',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        const canvas = document.createElement('canvas')
        canvas.width = 260
        canvas.height = 520
        const drawing = canvas.getContext('2d')
        for (const [index, color] of ['#ffd691', '#fb9168', '#166876', '#62bbaa'].entries()) {
          drawing.fillStyle = color
          drawing.fillRect(0, index * 130, 260, 130)
        }
        drawing.fillStyle = '#faf2e1'
        drawing.fillRect(108, 0, 44, 520)
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
        const file = {
          id: 'pinch-photo',
          name: '竖版照片.png',
          size: blob.size,
          mimeType: 'image/png',
          isImage: true,
          serverId: null,
        }
        await a.seed(
          [a.fixtures.session({ messages: [a.fixtures.user('photo', '', { files: [file] })] })],
          [{ id: file.id, blob }]
        )
      })
      const touch = await page.context().newCDPSession(page)
      await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
      const contact = (id, x, y) => ({ id, x, y })
      const send = (type, touchPoints) =>
        touch.send('Input.dispatchTouchEvent', { type, touchPoints })
      const thumb = page.getByRole('button', { name: '查看图片 竖版照片.png' })
      const dialog = page.getByRole('dialog', { name: '竖版照片.png' })
      const stage = dialog.getByRole('button', { name: '关闭图片预览' })
      const img = dialog.getByRole('img', { name: '竖版照片.png' })
      const evidence = process.env.FREESEEK_UX_EVIDENCE
      const prefix = `${page.viewportSize().width}-image`
      await page.evaluate(() => {
        const snapshots = new WeakMap()
        const events = []
        for (const type of [
          'pointerdown',
          'pointermove',
          'pointerup',
          'pointercancel',
          'lostpointercapture',
          'click',
        ]) {
          document.addEventListener(
            type,
            (event) => {
              if (event.target.closest('[role="dialog"]')) {
                events.push([
                  type,
                  event.pointerId,
                  event.pointerType,
                  event.clientX,
                  event.clientY,
                ])
              }
            },
            true
          )
        }
        window.__imagePointerTrace = events
        const animate = Element.prototype.animate
        Element.prototype.animate = function (...args) {
          const animation = animate.apply(this, args)
          if (this instanceof HTMLImageElement) {
            snapshots.set(this, [...(snapshots.get(this) ?? []), animation.effect.getKeyframes()])
          }
          return animation
        }
        window.__imageMotion = snapshots
      })
      const motion = (locator) =>
        locator.evaluate((element) => window.__imageMotion.get(element) ?? [])
      const waitFor = async (label, predicate, value) => {
        try {
          await page.waitForFunction(predicate, value)
        } catch (cause) {
          const scene = await page.evaluate(() => {
            const image = document.querySelector('[role="dialog"] img')
            return {
              pointerEvents: window.__imagePointerTrace,
              transform: image ? getComputedStyle(image).transform : null,
              rect: image?.getBoundingClientRect().toJSON(),
              animations: image ? window.__imageMotion.get(image) : [],
            }
          })
          throw new Error(`${label}: ${cause.message}\n${JSON.stringify(scene)}`, { cause })
        }
      }
      const expectMotion = (label, count) =>
        waitFor(
          label,
          (prior) => {
            const image = document.querySelector('[role="dialog"] img')
            return (window.__imageMotion.get(image)?.length ?? 0) > prior
          },
          count
        )
      const capture = async (name) => {
        if (evidence) {
          await page.screenshot({ path: resolve(evidence, `${prefix}-${name}.png`) })
        }
      }
      const settle = () =>
        img.evaluate(async (element) => {
          await Promise.all(element.getAnimations().map((animation) => animation.finished))
          await new Promise(requestAnimationFrame)
        })
      await thumb.click()
      await img.waitFor()
      await expectMotion('opening crop animation', 0)
      const opening = await motion(img)
      assert.ok(
        opening.some(
          ([from, to]) => from.transform !== to.transform && from.clipPath !== to.clipPath
        )
      )
      await settle()
      const initial = await img.boundingBox()
      const area = await stage.boundingBox()
      await capture('open')
      assert.equal(Math.round(area.width), page.viewportSize().width)
      assert.ok(Math.abs(initial.height / initial.width - 2) < 0.01)
      const x = initial.x + initial.width * 0.48
      const y = initial.y + initial.height * 0.51
      // Leave space to pan horizontally even when the stage is wider than the fitted portrait.
      const factor = Math.max(2, (area.width + 100) / initial.width)
      const endSpan = factor * 40
      await send('touchStart', [contact(1, x - 40, y), contact(2, x + 40, y)])
      await send('touchMove', [contact(1, x - endSpan, y), contact(2, x + endSpan, y)])
      await waitFor(
        'two-contact pinch',
        () => !!document.querySelector('[role="dialog"] [data-zoomed]')
      )
      const zoomed = await img.boundingBox()
      assert.ok(
        Math.abs(zoomed.width / initial.width - factor) < 0.03,
        JSON.stringify({ initial, zoomed })
      )
      assert.ok(Math.abs(x - (zoomed.x + zoomed.width * 0.48)) < 3)
      assert.ok(Math.abs(y - (zoomed.y + zoomed.height * 0.51)) < 3)
      await capture('pinched')
      await send('touchEnd', [contact(2, x + endSpan, y)])
      await send('touchMove', [contact(1, x - endSpan + 28, y + 32)])
      await waitFor(
        'one-contact pan after pinch',
        ({ left }) => {
          const img = document.querySelector('[role="dialog"] img')
          return img && Math.abs(img.getBoundingClientRect().left - left) < 3
        },
        { left: zoomed.x + 28 }
      )
      await send('touchEnd', [])
      assert.ok(await dialog.isVisible())
      const panned = await img.boundingBox()
      await capture('panned')

      // An intentional tap after dragging closes, and returns toward the original square crop.
      const prior = (await motion(img)).length
      await send('touchStart', [contact(3, x, y)])
      await send('touchEnd', [])
      await expectMotion('intentional tap starts closing crop animation', prior)
      const closing = (await motion(img)).slice(prior)
      assert.ok(
        closing.some(
          ([from, to]) => from.transform !== to.transform && from.clipPath !== to.clipPath
        )
      )
      await dialog.waitFor({ state: 'hidden' })

      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.setViewportSize({ width: 750, height: 390 })
      await thumb.click()
      const landscape = await img.boundingBox()
      assert.ok(landscape.height <= 390 && Math.abs(landscape.height / landscape.width - 2) < 0.01)
      assert.deepEqual(await motion(img), [])
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(await page.context().pages().length, 1)
      if (evidence) {
        const pointerEvents = await page.evaluate(() => window.__imagePointerTrace)
        await writeFile(
          resolve(evidence, `${prefix}-trace.json`),
          JSON.stringify(
            {
              area,
              initial,
              zoomed,
              panned,
              landscape,
              focalPoint: { x, y },
              opening,
              closing,
              pointerEvents,
            },
            null,
            2
          )
        )
      }
      await touch.detach()
    }
  )
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
        let read = false
        const limits = [
          ['metadata.json', 128, 'metadata'],
          ['manifest.json', 128, 'metadata'],
          ['chat_session_index.json', 128, 'metadata'],
          ['freeseek/sessions/long.json', 256, 'session'],
        ]
        const keys = []
        for (const [path, limit, kind] of limits) {
          try {
            await a.readJsonEntry({
              path,
              size: limit * 1024 * 1024 + 1,
              stream: {
                async *[Symbol.asyncIterator]() {
                  read = true
                  yield new Uint8Array(1)
                },
              },
            }, undefined, kind)
          } catch (error) {
            keys.push(error.key)
          }
        }
        return { read, keys }
      })
      assert.deepEqual(result, {
        read: false,
        keys: ['backupJsonTooLarge', 'backupManifestJsonTooLarge', 'backupIndexJsonTooLarge', 'backupSessionJsonTooLarge'],
      })
    }
  )
  await run(
    'failed chat writes preserve the submitted draft and pause update installation',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        await a.seed([
          f.session({
            id: 'old',
            title: 'Saved history',
            messages: [f.user('u', 'Existing message')],
          }),
        ])
        a.settings.setApiKey('fixture')
        a.drafts.setDraftText('old', 'Recover this text after restart')
        a.drafts.flushDraftTexts()
        const fetch = window.fetch
        window.fetch = (url, init) =>
          String(url).endsWith('/messages') ? Promise.resolve(a.response()) : fetch(url, init)
        const put = IDBObjectStore.prototype.put
        IDBObjectStore.prototype.put = function (value, ...args) {
          if (this.name === 'sessions') {
            throw new DOMException('Fixture write failure', 'QuotaExceededError')
          }
          return put.call(this, value, ...args)
        }
        a.store.sendMessage('old')
        await a.waitIdle()
        return {
          canInstall: await a.store.saveChatsBeforeRestart(),
          draft: a.drafts.getDraft('old').text,
        }
      })
      assert.deepEqual(result, { canInstall: false, draft: 'Recover this text after restart' })
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      const reopened = await page.evaluate(async () => {
        const a = window.__audit
        return {
          draft: a.drafts.getDraft('old').text,
          original: (await a.db.loadSession('old')).messages.map(({ content }) => content),
        }
      })
      assert.deepEqual(reopened, {
        draft: 'Recover this text after restart',
        original: ['Existing message'],
      })
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
