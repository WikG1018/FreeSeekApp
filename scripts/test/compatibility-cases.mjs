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
      await page.evaluate(() =>
        window.__FreeSeekStartup.fail(
          'render',
          new TypeError('sk-SECRET_STARTUP_CANARY chat content')
        )
      )
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
      assert.doesNotMatch(text, /SECRET_STARTUP_CANARY|chat content/)
      assert.equal(JSON.parse(text).report.errorName, 'TypeError')
    }
  )
}
