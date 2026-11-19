import assert from 'node:assert/strict'

export const runCompatibilityCases = async (run) => {
  await run(
    'legacy cursor requests preserve all imported chats, files and storage totals',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures,
          now = Date.now()
        const file = (id) => ({
          id,
          name: id + '.txt',
          serverId: null,
          size: 4,
          isImage: false,
          mimeType: 'text/plain',
        })
        await a.seed(
          [
            f.session({
              id: 'cursor-a',
              messages: [f.user('a', 'A', { files: [file('file-a')] })],
            }),
            f.session({
              id: 'cursor-b',
              messages: [f.user('b', 'B', { files: [file('file-b')] })],
            }),
            f.session({ id: 'cursor-c', messages: [f.user('c', 'C')] }),
          ],
          [
            { id: 'file-a', blob: new Blob(['AAAA']) },
            { id: 'file-b', blob: new Blob(['BBBB']) },
          ]
        )
        const pack = await a.backup.exportHistory()
        const count = await a.backup.importHistory(new File([pack.blob], pack.name))
        const totals = await a.db.getStorageSummary()
        return {
          count,
          files: totals.fileCount,
          bytes: totals.originalBytes,
          ids: a.store.useChatStore
            .getState()
            .sessions.map((s) => s.id)
            .sort(),
          original: await (await a.db.loadFile('file-b')).text(),
        }
      })
      assert.deepEqual(result, {
        count: 3,
        files: 2,
        bytes: 8,
        ids: ['cursor-a', 'cursor-b', 'cursor-c'],
        original: 'BBBB',
      })
    },
    (context) =>
      context.addInitScript(() => {
        delete IDBCursor.prototype.request
      })
  )

  await run(
    'v13 repairs a partial legacy summary index without changing stored conversations',
    async (page) => {
      const result = await page.evaluate(async () => ({
        ids: (await window.__audit.db.loadSessionSummaries()).map((s) => s.id).sort(),
        text: (await window.__audit.db.loadSession('index-b')).messages[0].content,
      }))
      assert.deepEqual(result, { ids: ['index-a', 'index-b'], text: '完整保留 B' })
    },
    (context) =>
      context.addInitScript(() => {
        delete IDBCursor.prototype.request
        window.__seedReady = new Promise((resolve, reject) => {
          const request = indexedDB.open('freeseek', 12)
          request.onupgradeneeded = () => {
            for (const name of [
              'sessions',
              'sessionSummaries',
              'files',
              'sessionsStaging',
              'filesStaging',
            ]) {
              const store = request.result.createObjectStore(name, { keyPath: 'id' })
              if (name === 'sessionSummaries')
                store.createIndex('fileIds', 'fileIds', { multiEntry: true })
            }
          }
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result,
              tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite'),
              now = Date.now()
            for (const suffix of ['a', 'b']) {
              const session = {
                id: 'index-' + suffix,
                title: suffix,
                createdAt: now,
                updatedAt: now,
                messages: [
                  {
                    id: suffix,
                    role: 'user',
                    content: '完整保留 ' + suffix.toUpperCase(),
                    files: [],
                    createdAt: now,
                  },
                ],
              }
              tx.objectStore('sessions').put(session)
              if (suffix === 'a')
                tx.objectStore('sessionSummaries').put({
                  id: session.id,
                  title: suffix,
                  createdAt: now,
                  updatedAt: now,
                  fileIds: [],
                })
            }
            tx.oncomplete = () => {
              db.close()
              resolve()
            }
            tx.onerror = () => reject(tx.error)
          }
        })
      })
  )
  await run(
    'data import uses both confirmations, cancellation retains history and invalid ZIP rolls back',
    async (page) => {
      const encoded = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        const target = f.session({
          title: 'Imported UI',
          messages: [f.user('target', 'Imported through UI')],
        })
        const blob = await a.exportArchive([target])
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result).split(',')[1])
          reader.onerror = reject
          reader.readAsDataURL(blob)
        })
        await a.seed([
          f.session({
            title: 'Original UI',
            messages: [f.user('original', 'Keep until confirmed')],
          }),
        ])
        a.settingsDialog.openSettings('data')
        return base64
      })
      const input = page.locator('input[type="file"][accept*="application/zip"]'),
        file = {
          name: 'native-backup.zip',
          mimeType: 'application/zip',
          buffer: Buffer.from(encoded, 'base64'),
        }
      await input.setInputFiles(file)
      await page.getByRole('button', { name: '取消', exact: true }).click()
      assert.equal(
        await page.evaluate(() => window.__audit.store.useChatStore.getState().sessions[0].title),
        'Original UI'
      )
      await input.setInputFiles(file)
      await page.getByRole('button', { name: '我已了解，继续', exact: true }).click()
      // 暂停第一次文件读取，在校验期间实际按返回并点遮罩。
      await page.evaluate(() => {
        const read = Blob.prototype.arrayBuffer
        const pause = new Promise((resolve) => {
          window.__resumeImport = resolve
        })
        Blob.prototype.arrayBuffer = async function () {
          Blob.prototype.arrayBuffer = read
          await pause
          return read.call(this)
        }
      })
      await page.getByRole('button', { name: '覆盖并导入', exact: true }).click()
      const working = page.getByRole('dialog', { name: '正在导入', exact: true })
      await working.waitFor()
      await page.keyboard.press('Escape')
      await page.mouse.click(4, 4)
      await page.waitForTimeout(280)
      assert.ok(
        await working.evaluate((el) => {
          const box = el.getBoundingClientRect()
          return el.contains(
            document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          )
        })
      )
      await page.evaluate(() => window.__resumeImport())
      await page.getByRole('dialog', { name: '导入完成', exact: true }).waitFor()
      assert.equal(
        await page.evaluate(() => window.__audit.store.useChatStore.getState().sessions[0].title),
        'Imported UI'
      )
      await page.getByRole('button', { name: '稍后', exact: true }).click()
      await input.setInputFiles({
        name: 'broken.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from('Invalid ZIP'),
      })
      await page.getByRole('button', { name: '我已了解，继续', exact: true }).click()
      await page.getByRole('button', { name: '覆盖并导入', exact: true }).click()
      await page.getByRole('dialog', { name: '导入失败', exact: true }).waitFor()
      assert.equal(
        await page.evaluate(() => window.__audit.store.useChatStore.getState().sessions[0].title),
        'Imported UI'
      )
      await page
        .getByRole('dialog', { name: '导入失败', exact: true })
        .getByRole('button', { name: '关闭', exact: true })
        .click()
      await input.setInputFiles(file)
      await page.getByRole('button', { name: '我已了解，继续', exact: true }).click()
      await page.getByRole('dialog', { name: '再次确认覆盖', exact: true }).waitFor()
    }
  )

  await run(
    'missing legacy WebView APIs cannot prevent startup, chat or diagnostic export',
    async (page) => {
      await page.locator('#fs-startup').waitFor({ state: 'hidden' })
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        a.settings.setApiKey('sk-LEGACY_PRIVATE_CANARY_123')
        const session = f.session()
        await a.seed([session])
        const fetch = window.fetch
        window.fetch = async (url, init) =>
          String(url).endsWith('/messages') ? a.response() : fetch(url, init)
        a.drafts.setDraftText(session.id, 'Legacy test')
        a.store.sendMessage(session.id)
        await a.waitIdle()
        const pack = await a.diagnosticBundle.createDiagnosticBundle(),
          files = {}
        for await (const entry of a.readArchive(new File([pack.blob], pack.name))) {
          files[entry.path] = await (await a.readEntry(entry)).text()
        }
        const stop = new AbortController()
        stop.abort()
        let aborted = false
        try {
          stop.signal.throwIfAborted()
        } catch (error) {
          aborted = error.name === 'AbortError'
        }
        return {
          status: a.store.useChatStore.getState().sessionCache[session.id].messages.at(-1).status,
          ready: getComputedStyle(document.getElementById('fs-startup')).display === 'none',
          zipEntries: Object.keys(files).length,
          json: JSON.stringify(files),
          aborted,
          reverse: [1, 2, 3].toReversed(),
          sorted: [3, 1, 2].toSorted(),
          own: Object.hasOwn({ a: 1 }, 'a'),
        }
      })
      assert.equal(result.status, 'done')
      assert.equal(result.ready, true)
      assert.equal(result.zipEntries, 6)
      assert.doesNotMatch(result.json, /LEGACY_PRIVATE_CANARY/)
      assert.equal(result.aborted, true)
      assert.equal(result.own, true)
      assert.deepEqual(result.reverse, [3, 2, 1])
      assert.deepEqual(result.sorted, [1, 2, 3])
    },
    async (context) => {
      await context.addInitScript(() => {
        for (const [target, names] of [
          [Array.prototype, ['at', 'toReversed', 'toSorted']],
          [Object, ['hasOwn', 'fromEntries']],
          [Promise, ['allSettled']],
          [String.prototype, ['replaceAll']],
          [Blob.prototype, ['text', 'arrayBuffer', 'stream']],
          [AbortSignal.prototype, ['throwIfAborted']],
          [crypto, ['randomUUID']],
          [Intl, ['DisplayNames']],
          [MediaQueryList.prototype, ['addEventListener', 'removeEventListener']],
        ]) {
          for (const name of names) {
            Object.defineProperty(target, name, {
              configurable: true,
              writable: true,
              value: undefined,
            })
          }
        }
        window.ResizeObserver = undefined
      })
    }
  )

  await run(
    'startup shows only the local brand mark and joins the actual home position',
    async (page) => {
      const startup = page.locator('#fs-startup')
      await page.waitForFunction(() => {
        const mark = document.getElementById('fs-startup-mark')
        return (
          mark.complete && mark.naturalWidth > 0 && typeof window.__finishStartup === 'function'
        )
      })
      assert.equal(await startup.locator('img').isVisible(), true)
      assert.equal((await startup.innerText()).trim(), '')
      assert.equal(await startup.getByRole('button').count(), 0)
      assert.equal(
        await startup.evaluate((node) => getComputedStyle(node, '::before').backgroundColor),
        'rgb(21, 21, 23)'
      )
      await page.evaluate(() => window.__finishStartup())
      await page.waitForFunction(() => Boolean(document.querySelector('#root > .app-scaler')))
      assert.equal(
        await page.evaluate(() => window.__audit.store.useChatStore.getState().ready),
        false
      )
      assert.equal(await startup.locator('img').isVisible(), true)
      assert.equal((await startup.innerText()).trim(), '')
      const movement = await page.evaluate(() => {
        const panel = document.getElementById('fs-startup')
        return new Promise((resolve) => {
          const observer = new MutationObserver(() => {
            if (panel.dataset.handoff !== 'home') return
            observer.disconnect()
            const mark = document.getElementById('fs-startup-mark')
            const target = document.querySelector('[data-startup-target]')
            const rect = (element) => {
              const { top, left, width } = element.getBoundingClientRect()
              return { top, left, width }
            }
            const frames = [rect(mark)]
            const facts = {
              landing: rect(target),
              hiddenTarget: getComputedStyle(target).opacity === '0',
              sameImage: target.querySelector('img').src === mark.src,
              interactive: getComputedStyle(panel).pointerEvents === 'none',
            }
            const sample = () => {
              if (panel.style.display === 'none') {
                resolve({ frames, ...facts })
              } else {
                frames.push(rect(mark))
                requestAnimationFrame(sample)
              }
            }
            requestAnimationFrame(sample)
          })
          observer.observe(panel, { attributes: true, attributeFilter: ['data-handoff'] })
          window.__finishStartupStorage()
        })
      })
      const end = movement.frames.at(-1)
      assert.ok(movement.frames[0].width > end.width)
      assert.ok(new Set(movement.frames.map(({ width }) => Math.round(width))).size >= 5)
      for (const axis of ['left', 'top', 'width']) {
        assert.ok(Math.abs(end[axis] - movement.landing[axis]) < 0.75, JSON.stringify(movement))
      }
      assert.ok(movement.hiddenTarget && movement.sameImage && movement.interactive)
      await startup.waitFor({ state: 'hidden' })
      const home = page.getByTestId('welcome-whale')
      assert.equal(await home.evaluate((node) => getComputedStyle(node).opacity), '1')
    },
    async (context) => {
      await context.addInitScript(() => {
        localStorage.setItem('freeseek:theme-preference', 'dark')
        localStorage.setItem('freeseek:font-scale', '1.25')
        window.__seedReady = new Promise((resolve) => {
          window.__finishStartup = resolve
        })
        const storage = new Promise((resolve) => {
          window.__finishStartupStorage = resolve
        })
        const open = IDBFactory.prototype.open
        IDBFactory.prototype.open = function (name, ...args) {
          const request = open.call(this, name, ...args)
          if (name === 'freeseek') {
            const addListener = request.addEventListener.bind(request)
            request.addEventListener = (type, listener, options) => {
              addListener(
                type,
                type === 'success'
                  ? (event) => storage.then(() => listener.call(request, event))
                  : listener,
                options
              )
            }
          }
          return request
        }
      })
    },
    false
  )

  await run(
    'restoring a chat reveals that chat directly and reduced motion skips the handoff',
    async (page) => {
      await page.locator('#fs-startup').waitFor({ state: 'hidden' })
      await page.evaluate(async () => {
        const { seed, fixtures } = window.__audit
        await seed([
          fixtures.session({
            id: 'startup-resume',
            title: '重启衔接测试',
            messages: [fixtures.user('startup-message', '继续整理计划')],
          }),
        ])
      })
      await page.addInitScript(() => {
        window.__startupRoutes = []
        new MutationObserver((records) => {
          for (const { target } of records) {
            if (target.id === 'fs-startup' && target.dataset.handoff) {
              window.__startupRoutes.push(target.dataset.handoff)
            }
          }
        }).observe(document, {
          subtree: true,
          attributes: true,
          attributeFilter: ['data-handoff'],
        })
      })
      const checkResumed = async () => {
        await page.locator('#fs-startup').waitFor({ state: 'hidden' })
        await page.getByTestId('chat-header').getByText('重启衔接测试', { exact: true }).waitFor()
        assert.equal(await page.getByTestId('welcome-whale').count(), 0)
        return page.evaluate(() => window.__startupRoutes)
      }
      await page.reload()
      assert.deepEqual(await checkResumed(), ['page'])
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.reload()
      assert.deepEqual(await checkResumed(), [])
    }
  )

  await run(
    'blocked application script shows recovery controls without loading the application',
    async (page) => {
      await page.getByRole('heading', { name: 'FreeSeek 未能启动', exact: true }).waitFor()
      assert.equal(
        await page.getByRole('button', { name: '重新启动', exact: true }).isVisible(),
        true
      )
      assert.equal(
        await page.getByRole('button', { name: '导出启动诊断', exact: true }).isVisible(),
        true
      )
      assert.equal(await page.evaluate(() => document.getElementById('root').childElementCount), 0)
    },
    async (context) => {
      await context.route('**/static/js/main.*.js', (route) => route.abort())
    },
    false
  )

  await run(
    'startup recovery can export metadata without exposing raw exception content',
    async (page) => {
      await page.evaluate(() => {
        const error = new TypeError('sk-SECRET_STARTUP_CANARY chat content')
        error.name = 'PRIVATE_STARTUP_ERROR_NAME'
        window.__FreeSeekStartup.fail('render', error)
      })
      await page.getByRole('heading', { name: 'FreeSeek 未能启动', exact: true }).waitFor()
      const wait = page.waitForEvent('download')
      await page.getByRole('button', { name: '导出启动诊断', exact: true }).click()
      const download = await wait
      const stream = await download.createReadStream()
      const chunks = []
      for await (const chunk of stream) {
        chunks.push(chunk)
      }
      const text = Buffer.concat(chunks).toString('utf8')
      assert.doesNotMatch(text, /SECRET_STARTUP_CANARY|chat content|PRIVATE_STARTUP_ERROR_NAME/)
      assert.equal(JSON.parse(text).report.errorName, 'Error')
    }
  )
}
