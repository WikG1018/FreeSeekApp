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
        await a.backup.clearHistory()
        const { added: count } = await a.backup.importHistory(new File([pack.blob], pack.name))
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
    'data import appends chats, confirms duplicates, and cancellation or invalid ZIP keeps history',
    async (page) => {
      const encoded = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        const target = f.session({
          id: 'import-ui-new',
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
            id: 'import-ui-original',
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
      await page.getByRole('button', { name: '开始导入', exact: true }).click()
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
      const titles = () => page.evaluate(() =>
        window.__audit.store.useChatStore.getState().sessions.map(({ title }) => title).sort()
      )
      assert.deepEqual(await titles(), ['Imported UI', 'Original UI'])
      await page.getByRole('button', { name: '稍后', exact: true }).click()
      await input.setInputFiles({
        name: 'broken.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from('Invalid ZIP'),
      })
      await page.getByRole('button', { name: '开始导入', exact: true }).click()
      await page.getByRole('dialog', { name: '导入失败', exact: true }).waitFor()
      assert.deepEqual(await titles(), ['Imported UI', 'Original UI'])
      await page
        .getByRole('dialog', { name: '导入失败', exact: true })
        .getByRole('button', { name: '关闭', exact: true })
        .click()
      await input.setInputFiles(file)
      await page.getByRole('button', { name: '开始导入', exact: true }).click()
      const duplicates = page.getByRole('dialog', { name: '选择保留哪一份', exact: true })
      await duplicates.waitFor()
      assert.equal(await duplicates.getByRole('radio', { name: /保留本机/ }).isChecked(), true)
      await duplicates.getByRole('button', { name: '取消', exact: true }).click()
      await duplicates.waitFor({ state: 'hidden' })
      assert.deepEqual(await titles(), ['Imported UI', 'Original UI'])
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
    'foreground restores the composer when a transient visual viewport reports zero height',
    async (page) => {
      const input = page.getByTestId('chat-composer').locator('textarea')
      await input.fill('保留输入草稿')
      const output = await page.evaluate(async () => {
        const viewport = window.visualViewport
        const frame = document.querySelector('[data-fs-app-frame]')
        Object.defineProperty(viewport, 'height', { configurable: true, value: 0 })
        viewport.dispatchEvent(new Event('resize'))
        await new Promise(requestAnimationFrame)
        const minimum = frame.getBoundingClientRect().height
        Object.defineProperty(viewport, 'height', { configurable: true, value: 575 })
        window.dispatchEvent(new Event('freeseek:native-foreground'))
        const recovered = frame.getBoundingClientRect().height
        delete viewport.height
        viewport.dispatchEvent(new Event('resize'))
        return { minimum, recovered }
      })
      assert.ok(output.minimum > 300)
      assert.equal(output.recovered, 575)
      assert.equal(await input.inputValue(), '保留输入草稿')
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
    'startup page selection persists and opens the new-chat home while preserving history',
    async (page) => {
      const id = 'startup-page-saved-chat'
      const title = '周末计划'
      const originalText = '周六上午去图书馆'
      const draft = '还没发出的补充计划'
      await page.evaluate(
        async ({ id, title, originalText, draft }) => {
          const a = window.__audit
          await a.seed([
            a.fixtures.session({
              id,
              title,
              messages: [a.fixtures.user('weekend-plan', originalText)],
            }),
          ])
          a.drafts.setDraftText(id, draft)
          a.drafts.flushDraftTexts()
        },
        { id, title, originalText, draft }
      )

      const openPreferences = async () => {
        await page.locator('#fs-startup').waitFor({ state: 'hidden' })
        await page.evaluate(() => window.__audit.settingsDialog.openSettings('home'))
        await page.getByRole('button', { name: '对话偏好', exact: true }).click()
      }
      const row = page.getByRole('button', { name: '启动后打开', exact: true })
      const menu = page.getByRole('listbox', { name: '启动后打开', exact: true })

      await openPreferences()
      await row.getByText('上次对话', { exact: true }).waitFor()
      await row.click()
      await menu.waitFor()
      assert.deepEqual(await menu.getByRole('option').allTextContents(), ['上次对话', '新对话首页'])
      assert.equal(
        await menu
          .getByRole('option', { name: '上次对话', exact: true })
          .getAttribute('aria-selected'),
        'true'
      )
      await page.evaluate(() => {
        const setItem = Storage.prototype.setItem
        window.__restoreStartupStorage = () => {
          Storage.prototype.setItem = setItem
        }
        Storage.prototype.setItem = function (key, value) {
          if (key === 'freeseek:startup-page') {
            throw new DOMException('Test storage failure', 'QuotaExceededError')
          }
          return setItem.call(this, key, value)
        }
      })
      await menu.getByRole('option', { name: '新对话首页', exact: true }).click()
      await page.getByRole('alert').filter({ hasText: '启动选项保存失败' }).waitFor()
      await row.getByText('上次对话', { exact: true }).waitFor()
      await page.evaluate(() => window.__restoreStartupStorage())

      await row.click()
      await menu.getByRole('option', { name: '新对话首页', exact: true }).click()
      await row.getByText('新对话首页', { exact: true }).waitFor()
      assert.equal(
        await page.evaluate(() => window.__audit.store.useChatStore.getState().activeId),
        id
      )

      await page.reload()
      await page.getByTestId('welcome-whale').waitFor()
      assert.deepEqual(
        await page.evaluate(async (id) => {
          const a = window.__audit
          const state = a.store.useChatStore.getState()
          return {
            active: state.activeId,
            ids: state.sessions.map((session) => session.id),
            loaded: Object.keys(state.sessionCache),
            savedText: (await a.db.loadSession(id)).messages[0].content,
            savedDraft: a.drafts.getDraft(id).text,
          }
        }, id),
        { active: null, ids: [id], loaded: [], savedText: originalText, savedDraft: draft }
      )

      await openPreferences()
      await row.getByText('新对话首页', { exact: true }).waitFor()
      await row.click()
      await menu.getByRole('option', { name: '上次对话', exact: true }).click()
      await row.getByText('上次对话', { exact: true }).waitFor()
      await page.reload()
      await page.getByTestId('chat-header').getByText(title, { exact: true }).waitFor()
      await page.getByText(originalText, { exact: true }).waitFor()
      assert.equal(
        await page.evaluate(() => window.__audit.store.useChatStore.getState().activeId),
        id
      )
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
      await page.getByRole('heading', { name: 'FreeSeek 界面显示异常', exact: true }).waitFor()
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
  await run(
    'a slow network keeps waiting instead of failing the startup',
    async (page) => {
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Network.enable')
      // 约 80 KB/s：页面在 10 秒时肯定还没就绪，正是国内直连慢网络下的真实情况
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 300,
        downloadThroughput: 80 * 1024,
        uploadThroughput: 80 * 1024,
      })
      const slow = page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
      const loadedAt = Date.now()
      // 7 秒提示「正在加载」，10 秒不得判死（旧行为是 10 秒直接停在错误页，缓存也再填不满）
      await page.waitForFunction(
        () => {
          const hint = document.getElementById('fs-startup-hint')
          return !!hint && getComputedStyle(hint).display !== 'none'
        },
        null,
        { timeout: 12000 }
      )
      // 必须真正越过 10 秒这一关再判断，否则测不出旧行为
      const elapsed = Date.now() - loadedAt
      if (elapsed < 11000) {
        await page.waitForTimeout(11000 - elapsed)
      }
      const atEleven = await page.evaluate(() => ({
        failure:
          getComputedStyle(document.getElementById('fs-startup-failure')).display !== 'none',
        starting: document.documentElement.hasAttribute('data-fs-starting'),
      }))
      assert.equal(atEleven.failure, false, 'slow load must not fail the startup')
      assert.equal(atEleven.starting, true, 'still loading after 11s')
      // 放开限速后应当自己完成，不需要用户手动重试
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      })
      await slow
      await page.waitForFunction(() => !!window.__audit?.store.useChatStore.getState().ready, null, {
        timeout: 60000,
      })
      await page.locator('#fs-startup').waitFor({ state: 'hidden', timeout: 30000 })
    }
  )
}
