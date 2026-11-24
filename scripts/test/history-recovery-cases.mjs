import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { unzipSync } from 'fflate'

const changeHistory = (page, ops) =>
  page.evaluate((ops) => new Promise((resolve, reject) => {
    const request = indexedDB.open('freeseek')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const tx = database.transaction([...new Set(ops.map(([name]) => name))], 'readwrite')
      for (const [name, method, ...args] of ops) {
        tx.objectStore(name)[method](...args)
      }
      tx.oncomplete = () => {
        database.close()
        resolve()
      }
      tx.onabort = () => {
        database.close()
        reject(tx.error)
      }
    }
  }), ops)

export const runHistoryRecoveryCases = async (run) => {
  await run(
    'history visibility honors the legacy Android presence marker without a count',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        a.historyCheckpoint.historyCheckpointReader.read = async () => ({ present: true })
        a.store.useChatStore.setState({ ready: false })
        await a.store.initChat()
        const { ready, historyMissing, historyMayStartFresh } = a.store.useChatStore.getState()
        return { ready, historyMissing, historyMayStartFresh }
      })
      assert.deepEqual(result, { ready: false, historyMissing: true, historyMayStartFresh: true })
    },
    (context) => context.addInitScript(() => {
      window.CapacitorCustomPlatform = { name: 'android' }
    })
  )

  await run(
    'history visibility loads verified chats when the legacy count preference throws',
    async (page) => {
      const titles = await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([a.fixtures.session({ id: 'known-chat', title: '标题仍然可读' })])
        a.store.useChatStore.setState({ ready: false, sessions: [] })
        const getItem = Storage.prototype.getItem
        try {
          Storage.prototype.getItem = function (key) {
            if (key === 'freeseek:history-count') throw new DOMException('Denied', 'SecurityError')
            return getItem.call(this, key)
          }
          await a.store.initChat()
        } finally {
          Storage.prototype.getItem = getItem
        }
        const state = a.store.useChatStore.getState()
        return { ready: state.ready, titles: state.sessions.map(({ title }) => title) }
      })
      assert.deepEqual(titles, { ready: true, titles: ['标题仍然可读'] })
    }
  )

  await run(
    'history visibility recovers the only committed bank after the active pointer and index break',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        const session = a.fixtures.session({
          id: 'committed-body',
          title: '保留下来的会话',
          messages: [a.fixtures.user('u', '恢复后的完整正文')],
        })
        await a.backup.importHistory(new File([await a.exportArchive([session])], 'backup.zip'))
      })
      await changeHistory(page, [
        ['historyState', 'put', false, 'useStagingStores'],
        ['sessionSummaries', 'clear'],
      ])
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      await page.evaluate(() => window.__audit.store.selectSession('committed-body'))
      await page.getByText('恢复后的完整正文', { exact: true }).waitFor()
    }
  )

  await run(
    'history visibility rebuilds around a malformed record without deleting any data',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([a.fixtures.session({
          id: 'healthy-chat',
          title: '可读会话',
          messages: [a.fixtures.user('u', '有完整正文')],
        })])
      })
      await changeHistory(page, [
        ['sessions', 'put', { id: 'damaged-chat', title: '正文损坏的会话', createdAt: 1, updatedAt: 1 }],
        ['sessionSummaries', 'clear'],
      ])
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      const result = await page.evaluate(async () => {
        const a = window.__audit
        return {
          ids: a.store.useChatStore.getState().sessions.map(({ id }) => id).sort(),
          count: (await a.db.getStorageSummary()).sessionCount,
        }
      })
      assert.deepEqual(result, { ids: ['damaged-chat', 'healthy-chat'], count: 2 })
      await page.evaluate(() => window.__audit.store.selectSession('healthy-chat'))
      await page.getByText('有完整正文', { exact: true }).waitFor()
      await page.evaluate(() => window.__audit.store.selectSession('damaged-chat'))
      await page.getByText('对话加载失败，请重试', { exact: true }).waitFor()
    }
  )

  await run(
    'history visibility treats a single missing read as recoverable and keeps the attachment',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([
          a.fixtures.session({
            id: 'only-conversation',
            title: '唯一的聊天',
            messages: [a.fixtures.user('u', '不能消失的正文', {
              files: [{ id: 'saved-original', name: 'fixture.txt', size: 7, mimeType: 'text/plain', isImage: false }],
            })],
          }),
        ], [{ id: 'saved-original', blob: new Blob(['fixture']) }])
        a.store.useChatStore.setState({ sessionCache: {} })
        const original = IDBObjectStore.prototype.get
        IDBObjectStore.prototype.get = function (key) {
          return original.call(this, this.name === 'sessions' && key === 'only-conversation' ? 'miss-on-get' : key)
        }
        a.store.selectSession('only-conversation')
      })
      await page.getByText('不能消失的正文', { exact: true }).waitFor()
      const actual = await page.evaluate(async () => {
        const db = window.__audit.db
        return {
          count: (await db.getStorageSummary()).sessionCount,
          original: await (await db.loadFile('saved-original')).text(),
        }
      })
      assert.deepEqual(actual, { count: 1, original: 'fixture' })
    }
  )

  await run(
    'history visibility restores from the startup recovery screen and watches the restored list',
    async (page) => {
      await page.setViewportSize({ width: 1366, height: 860 })
      const encoded = await page.evaluate(async () => {
        const a = window.__audit
        const session = a.fixtures.session({
          id: 'recovered-here', title: '从恢复入口导入', messages: [a.fixtures.user('u', '恢复入口正文')],
        })
        return btoa(String.fromCharCode(...new Uint8Array(await (await a.exportArchive([session])).arrayBuffer())))
      })
      await page.getByRole('button', { name: '打开备份设置', exact: true }).click()
      const importButton = page.getByRole('button', { name: /导入历史对话/ })
      await importButton.waitFor()
      assert.equal(await importButton.isEnabled(), true)
      await page.locator('input[type="file"][accept*="application/zip"]').setInputFiles({
        name: '恢复测试.zip', mimeType: 'application/zip', buffer: Buffer.from(encoded, 'base64'),
      })
      await page.getByRole('button', { name: '开始导入', exact: true }).click()
      await page.getByRole('button', { name: '查看已导入的对话', exact: true }).click()
      await page.getByText('恢复入口正文', { exact: true }).waitFor()
      await changeHistory(page, [
        ['sessionsStaging', 'clear'],
        ['sessionSummaries', 'clear'],
        ['historyState', 'clear'],
      ])
      await page.evaluate(() => window.dispatchEvent(new Event('freeseek:history-terminated')))
      const sidebar = page.getByTestId('sider-list')
      await sidebar.getByText(/暂时读取不到之前的聊天记录/).waitFor({ timeout: 3000 })
      await sidebar.getByText('从恢复入口导入', { exact: true }).waitFor()
    },
    (context) => context.addInitScript(() => {
      localStorage.setItem('freeseek:history-count', '40')
    }),
    false
  )

  await run(
    'history visibility keeps the last readable list and retries after a live storage loss',
    async (page) => {
      await page.setViewportSize({ width: 1366, height: 860 })
      await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([a.fixtures.session({
          id: 'lived-history', title: '最后读到的列表', messages: [a.fixtures.user('old', '缓存正文')],
        })])
      })
      await changeHistory(page, [
        ['sessions', 'clear'],
        ['sessionSummaries', 'clear'],
        ['historyState', 'clear'],
      ])
      await page.evaluate(() => window.dispatchEvent(new Event('freeseek:history-terminated')))
      const sidebar = page.getByTestId('sider-list')
      await sidebar.getByText(/暂时读取不到之前的聊天记录/).waitFor()
      await sidebar.getByText('最后读到的列表', { exact: true }).waitFor()
      assert.equal(await sidebar.getByText('还没有对话', { exact: true }).count(), 0)
      await page.evaluate(async () => {
        const a = window.__audit
        await a.db.saveSession(a.fixtures.session({
          id: 'lived-history', title: '再次可读的列表', messages: [a.fixtures.user('old', '恢复正文')],
        }))
      })
      await sidebar.getByRole('button', { name: '重试', exact: true }).click()
      await sidebar.getByText('再次可读的列表', { exact: true }).waitFor()
      assert.equal(await sidebar.getByText(/暂时读取不到之前的聊天记录/).count(), 0)
    }
  )

  await run(
    'history visibility reports a blocked upgrade and recovers when the old window closes',
    async (page) => {
      await page.getByText('另一个窗口正在使用旧版聊天存储。关闭那个窗口后重试。', { exact: true }).waitFor()
      await page.evaluate(() => window.__legacyHistory.close())
      await page.getByRole('button', { name: '重试', exact: true }).click()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      const ids = await page.evaluate(() =>
        window.__audit.store.useChatStore.getState().sessions.map(({ id }) => id).sort()
      )
      assert.deepEqual(ids, ['legacy-damaged', 'legacy-readable'])
      await page.evaluate(() => window.__audit.store.selectSession('legacy-readable'))
      await page.getByText('升级保留的历史正文', { exact: true }).waitFor()
    },
    (context) => context.addInitScript(() => {
      const request = indexedDB.open('freeseek', 12)
      request.onupgradeneeded = () => {
        const sessions = request.result.createObjectStore('sessions', { keyPath: 'id' })
        sessions.put({
          id: 'legacy-readable',
          title: '旧版里正常的对话',
          createdAt: 1,
          updatedAt: 1,
          messages: [{ id: 'u', role: 'user', content: '升级保留的历史正文', files: [], createdAt: 1 }],
        })
        sessions.put({ id: 'legacy-damaged', title: '旧版里损坏的对话', createdAt: 2, updatedAt: 2 })
      }
      request.onsuccess = () => { window.__legacyHistory = request.result }
    }),
    false
  )

  await run(
    'history visibility shows verified chats while interrupted import cleanup is waiting',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([a.fixtures.session({ id: 'visible-history', title: '可立即查看' })])
        await a.db.addStagingSession(a.fixtures.session({ id: 'interrupted-import' }))
        const request = navigator.locks.request
        let unblock
        const pause = new Promise((resolve) => { unblock = resolve })
        let started
        const waiting = new Promise((resolve) => { started = resolve })
        navigator.locks.request = function (name, options, callback) {
          return request.call(this, name, options, async (lock) => {
            started()
            await pause
            return callback(lock)
          })
        }
        a.store.useChatStore.setState({ ready: false, sessions: [] })
        const initial = a.store.initChat()
        try {
          await waiting
          const before = a.store.useChatStore.getState()
          return { ready: before.ready, titles: before.sessions.map(({ title }) => title) }
        } finally {
          unblock()
          navigator.locks.request = request
          await initial
        }
      })
      assert.deepEqual(result, { ready: true, titles: ['可立即查看'] })
      await page.waitForFunction(async () =>
        (await window.__audit.db.getStorageSummary()).alternateSessionCount === 0
      )
    }
  )

  await run(
    'history recovery finds committed chats when the active store selector is missing',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        const f = a.fixtures
        await a.seed(
          [
            f.session({
              id: 'keep-id',
              title: '保存的对话',
              pinned: true,
              messages: [
                f.user('u', '完整的历史正文', {
                  files: [
                    {
                      id: 'keep-file',
                      size: 7,
                      name: 'proof.txt',
                      serverId: null,
                      mimeType: 'text/plain',
                      isImage: false,
                    },
                  ],
                }),
              ],
            }),
          ],
          [{ id: 'keep-file', blob: new Blob(['keep me'], { type: 'text/plain' }) }]
        )
        const { name, blob } = await a.backup.exportHistory()
        await a.backup.importHistory(new File([blob], name), undefined, async () => new Set(['keep-id']))
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('freeseek')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            const tx = db.transaction('historyState', 'readwrite')
            tx.objectStore('historyState').delete('useStagingStores')
            tx.objectStore('historyState').delete('committedUseStagingStores')
            tx.oncomplete = () => {
              db.close()
              resolve()
            }
            tx.onabort = () => reject(tx.error)
          }
        })
      })
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      const found = await page.evaluate(async () => {
        const a = window.__audit
        const session = await a.db.loadSession('keep-id')
        return {
          count: (await a.db.loadSessionSummaries()).length,
          usingAlternate: (await a.db.getStorageSummary()).useStagingStores,
          title: session.title,
          pinned: session.pinned,
          text: session.messages[0].content,
          original: await (await a.db.loadFile(session.messages[0].files[0].id)).text(),
        }
      })
      assert.deepEqual(found, {
        count: 1,
        usingAlternate: true,
        title: '保存的对话',
        pinned: true,
        text: '完整的历史正文',
        original: 'keep me',
      })
    }
  )

  await run(
    'history recovery restores the sidebar from the committed bank if both the selector and index disappear',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([
          a.fixtures.session({
            id: 'saved-bank',
            title: '导入后保留的会话',
            messages: [a.fixtures.user('u', '重要正文')],
          }),
        ])
        const pack = await a.backup.exportHistory()
        await a.backup.importHistory(new File([pack.blob], pack.name), undefined, async () =>
          new Set(['saved-bank'])
        )
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('freeseek')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            const tx = db.transaction(['historyState', 'sessionSummaries'], 'readwrite')
            tx.objectStore('historyState').delete('useStagingStores')
            tx.objectStore('sessionSummaries').clear()
            tx.oncomplete = () => {
              db.close()
              resolve()
            }
            tx.onabort = () => reject(tx.error)
          }
        })
      })
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const history = await a.db.getStorageSummary()
        const session = await a.db.loadSession('saved-bank')
        return {
          sessions: history.sessionCount,
          index: history.indexCount,
          title: session.title,
          body: session.messages[0].content,
        }
      })
      assert.deepEqual(result, {
        sessions: 1,
        index: 1,
        title: '导入后保留的会话',
        body: '重要正文',
      })
    }
  )

  await run(
    'history recovery preserves unmarked records when neither bank nor index can establish which import committed',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        await a.db.addStagingSession(
          a.fixtures.session({ id: 'unconfirmed', title: '未确认的记录' })
        )
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('freeseek')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            const tx = db.transaction('historyState', 'readwrite')
            tx.objectStore('historyState').delete('incompleteStaging')
            tx.oncomplete = () => {
              db.close()
              resolve()
            }
            tx.onabort = () => reject(tx.error)
          }
        })
      })
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().historyMissing)
      const state = await page.evaluate(async () => {
        const a = window.__audit
        await a.db.recoverStaging()
        return {
          ...(await a.db.getStorageSummary()),
          incident: (await a.diagnostics.readDiagnosticLogs()).events.find(
            ({ event }) => event === 'history.selection-uncertain'
          )?.details,
        }
      })
      assert.equal(state.alternateSessionCount, 1)
      assert.equal(state.incident.alternateCount, 1)
      assert.equal(await page.getByText('还没有对话', { exact: true }).count(), 0)
    }
  )

  await run(
    'a damaged list index is rebuilt on the first load instead of showing an error page',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([
          a.fixtures.session({
            id: 'repair-index',
            title: '应保留的旧对话',
            messages: [a.fixtures.user('u', '完整内容')],
          }),
        ])
        a.store.useChatStore.setState({ ready: false })
        // 让键集合与实体集合对不上：以前这会在只读检查里抛「列表读取不完整」
        const original = IDBObjectStore.prototype.getAllKeys
        IDBObjectStore.prototype.getAllKeys = function (...args) {
          return original.apply(this, this.name === 'sessions' ? ['not-an-existing-id'] : args)
        }
        await a.store.initChat()
        IDBObjectStore.prototype.getAllKeys = original
        const store = a.store.useChatStore.getState()
        return {
          ready: store.ready,
          initError: store.initError,
          titles: store.sessions.map((session) => session.title),
          storage: await a.db.getStorageSummary(),
          repaired: (await a.diagnostics.readDiagnosticLogs()).events.some(
            (event) => event.event === 'history.index-repair-needed'
          ),
        }
      })
      assert.equal(result.ready, true, 'a damaged index must not block startup')
      assert.equal(result.initError, false)
      assert.deepEqual(result.titles, ['应保留的旧对话'])
      assert.equal(result.storage.sessionCount, 1)
      assert.equal(result.storage.indexCount, 1)
      assert.equal(result.repaired, true, 'the damage is recorded so it can be diagnosed')

      // 列表索引被清空、但正文还在：再读一次应当重新建索引，而不是报错
      const second = await page.evaluate(async () => {
        const a = window.__audit
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('freeseek')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            const tx = db.transaction('sessionSummaries', 'readwrite')
            tx.objectStore('sessionSummaries').clear()
            tx.oncomplete = () => {
              db.close()
              resolve()
            }
            tx.onabort = () => reject(tx.error)
          }
        })
        a.store.useChatStore.setState({ ready: false })
        await a.store.initChat()
        const store = a.store.useChatStore.getState()
        const session = await a.db.loadSession('repair-index')
        return {
          ready: store.ready,
          titles: store.sessions.map((item) => item.title),
          body: session.messages[0].content,
          indexCount: (await a.db.getStorageSummary()).indexCount,
        }
      })
      assert.equal(second.ready, true)
      assert.deepEqual(second.titles, ['应保留的旧对话'])
      assert.equal(second.body, '完整内容')
      assert.equal(second.indexCount, 1)

      // A WebView can return equally short arrays for both reads. The count still exposes the loss.
      const truncated = await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([
          a.fixtures.session({ id: 'chat-a', title: '第一条' }),
          a.fixtures.session({ id: 'chat-b', title: '第二条' }),
        ])
        const { getAll, getAllKeys } = IDBObjectStore.prototype
        IDBObjectStore.prototype.getAll = function (...args) {
          return getAll.apply(this, this.name === 'sessionSummaries' ? [undefined, 1] : args)
        }
        IDBObjectStore.prototype.getAllKeys = function (...args) {
          return getAllKeys.apply(this, this.name === 'sessions' ? [undefined, 1] : args)
        }
        try {
          return (await a.db.loadSessionSummaries()).map(({ id }) => id).sort()
        } finally {
          IDBObjectStore.prototype.getAll = getAll
          IDBObjectStore.prototype.getAllKeys = getAllKeys
        }
      })
      assert.deepEqual(truncated, ['chat-a', 'chat-b', 'repair-index'])
    }
  )

  await run(
    'history recovery makes unexpected empty storage visible and honors an explicit clear',
    async (page) => {
      await page
        .getByText(/暂时读取不到之前的聊天记录/)
        .first()
        .waitFor()
      await page.getByRole('button', { name: '打开备份设置', exact: true }).waitFor()
      await page.evaluate(async () => {
        const a = window.__audit
        await a.backup.exportHistory().then(
          () => {
            throw new Error('Unexpected empty backup was exported')
          },
          (error) => {
            if (error.key !== 'sessionListLoadFailed') throw error
          }
        )
      })
      await page.getByRole('button', { name: '暂不恢复，进入首页', exact: true }).click()
      await page.getByTestId('chat-composer').waitFor()
      await page.evaluate(async () => {
        await window.__audit.backup.clearHistory()
        // Simulate a crash between the IDB commit and updating independent metadata.
        localStorage.setItem('freeseek:history-had-conversations', '1')
      })
      await page.reload()
      await page.getByTestId('chat-composer').waitFor()
      assert.equal(await page.getByText(/暂时读取不到之前的聊天记录/).count(), 0)
    },
    (context) =>
      context.addInitScript(() => {
        if (!sessionStorage.getItem('started-with-checkpoint')) {
          localStorage.setItem('freeseek:history-had-conversations', '1')
          sessionStorage.setItem('started-with-checkpoint', '1')
        }
      }),
    false
  )
  await run(
    'a marked partial backup merges safely into existing history',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const keep = a.fixtures.session({ id: 'export-keep', title: '保留', messages: [] })
        const gone = a.fixtures.session({ id: 'export-gone', title: '丢失', messages: [] })
        await a.seed([keep, gone])
        // 复现「索引里有、正文读不到」：缓存和数据库里都没有这条正文
        const { sessionCache } = a.store.useChatStore.getState()
        const cache = { ...sessionCache }
        delete cache['export-gone']
        a.store.useChatStore.setState({ sessionCache: cache })
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('freeseek')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const database = request.result
            const tx = database.transaction('sessions', 'readwrite')
            tx.objectStore('sessions').delete('export-gone')
            tx.oncomplete = () => {
              database.close()
              resolve()
            }
            tx.onerror = () => reject(tx.error)
          }
        })
        const { blob, name, skipped } = await a.backup.exportHistory()
        const file = new File([blob], name)
        const paths = []
        let manifest
        // 归档是流式解析的：每条 entry 必须读掉再往下走
        for await (const entry of a.readArchive(file)) {
          paths.push(entry.path)
          const value = await (await a.readEntry(entry)).text()
          if (entry.path === 'manifest.json') {
            manifest = JSON.parse(value)
          }
        }
        await a.seed([keep, a.fixtures.session({ id: 'keep-after-export', messages: [] })])
        const merged = await a.backup.importHistory(file)
        const retained = Boolean(await a.db.loadSession('keep-after-export'))
        await a.backup.clearHistory()
        const restored = await a.backup.importHistory(file)
        return { skipped, name, bytes: blob.size, paths, manifest, merged, retained, restored }
      })
      // 一条读不到不该让整次备份失败：导出剩下的，并如实报告跳过数
      assert.equal(result.skipped, 1)
      assert.match(result.name, /^freeseek-partial-backup-/)
      assert.equal(result.manifest.freeseek_backup_version, 8)
      assert.deepEqual(result.manifest.partial, { kind: 'unreadable', skippedSessions: 1 })
      assert.equal(result.merged.added, 0)
      assert.equal(result.merged.kept, 1)
      assert.equal(result.retained, true)
      assert.equal(result.restored.added, 1)
      assert.ok(result.bytes > 0)
      assert.ok(
        result.paths.some((path) => path.includes('export-keep')),
        `backup should keep the readable conversation, got ${result.paths.join(',')}`
      )
      assert.equal(
        result.paths.some((path) => path.includes('export-gone')),
        false,
        'the missing conversation must not appear in the archive'
      )
    }
  )
  await run(
    'history export downloads valid chats and originals despite a broken conversation or missing attachment',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        const file = (id, name) => ({ id, name, serverId: null, size: 12, mimeType: 'text/plain', isImage: false })
        const present = file('export-original', '可用原件.txt')
        const missing = file('export-missing-original', '找不到的原件.txt')
        const healthy = a.fixtures.session({
          id: 'export-readable', title: '可用会话',
          messages: [
            a.fixtures.user('u1', '请读附件', { files: [present, missing] }),
            a.fixtures.assistant('a1', '好的。'),
            a.fixtures.user('u2', '再看同一份附件', { files: [missing] }),
          ],
        })
        const broken = a.fixtures.session({
          id: 'export-unreadable', title: '待恢复会话',
          voiceRoles: [{ id: 'bad-role', name: '甲'.repeat(81), preset: '白桦', aliases: [],
            nature: '', importance: 'lead', source: 'model', createdAt: 1 }],
        })
        await a.seed([healthy, broken], [{ id: present.id, blob: new Blob(['fixture text'], { type: 'text/plain' }) }])
        a.settingsDialog.openSettings('data')
      })
      const [saved] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: '导出所有历史对话', exact: true }).click(),
      ])
      const name = saved.suggestedFilename()
      assert.match(name, /^freeseek-partial-backup-/)
      const bytes = await readFile(await saved.path())
      const entries = unzipSync(bytes)
      const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
      assert.deepEqual(manifest.sessions, ['export-readable'])
      assert.deepEqual(manifest.partial, { kind: 'unreadable', skippedSessions: 1, missingOriginals: 1 })
      assert.equal(Buffer.from(entries['freeseek/files/export-original.bin']).toString(), 'fixture text')
      assert.equal(entries['freeseek/files/export-missing-original.bin'], undefined)
      await page.getByText(/已跳过 1 个无法备份的会话/).waitFor()
      await page.getByText(/有 1 个附件原件未能读取/).waitFor()
      const restored = await page.evaluate(async ({ encoded, name }) => {
        const a = window.__audit
        const sourceUnchanged = Boolean(await a.db.loadSession('export-unreadable'))
        const file = new File([Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))], name)
        await a.backup.clearHistory()
        const imported = await a.backup.importHistory(file)
        const chat = await a.db.loadSession('export-readable')
        const reexported = await a.backup.exportHistory()
        let partial
        for await (const entry of a.readArchive(new File([reexported.blob], reexported.name))) {
          const chunk = await a.readEntry(entry)
          if (entry.path === 'manifest.json') partial = JSON.parse(await chunk.text()).partial
        }
        await a.backup.clearHistory()
        const recovered = await a.backup.importHistory(new File([reexported.blob], reexported.name))
        return {
          sourceUnchanged, imported: imported.added, recovered: recovered.added, partial,
          missingName: chat.messages[0].files[1].name,
          original: await (await a.db.loadFile('export-original')).text(),
        }
      }, { encoded: bytes.toString('base64'), name })
      assert.deepEqual(restored, {
        sourceUnchanged: true, imported: 1, recovered: 1, missingName: '找不到的原件.txt',
        original: 'fixture text', partial: { kind: 'unreadable', skippedSessions: 0, missingOriginals: 1 },
      })
    }
  )
  await run(
    'history retry keeps committed conversations even when interrupted staging is larger',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([a.fixtures.session({ id: 'valid-history', messages: [] })])
        for (const id of ['unfinished-a', 'unfinished-b']) {
          await a.db.addStagingSession(a.fixtures.session({ id, messages: [] }))
        }
        const repair = await a.db.repairHistoryStateAndIndex()
        return {
          switched: repair.switched,
          active: (await a.db.loadSessionSummaries()).map(({ id }) => id),
          staged: (await a.db.getStorageSummary()).alternateSessionCount,
        }
      })
      assert.equal(result.switched, false)
      assert.deepEqual(result.active, ['valid-history'])
      assert.equal(result.staged, 2)
    }
  )
  await run(
    'a large drop in conversation count is recorded for diagnosis',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([
          a.fixtures.session({ id: 'drop-a', messages: [] }),
          a.fixtures.session({ id: 'drop-b', messages: [] }),
        ])
        // An unfinished import must not hide the size of the committed history loss.
        for (let index = 0; index < 18; index++) {
          await a.db.addStagingSession(a.fixtures.session({ id: 'drop-staged-' + index, messages: [] }))
        }
        // 模拟「上次还有 20 个会话、这次只剩 2 个」——正是库被系统清空后的样子
        localStorage.setItem('freeseek:history-had-conversations', '1')
        localStorage.setItem(
          'freeseek:history-verified',
          JSON.stringify({ sessionCount: 20, verifiedAt: Date.now() })
        )
      })
      await page.reload()
      await page.waitForFunction(
        () => window.__audit?.store.useChatStore.getState().ready,
        null,
        { timeout: 30000 }
      )
      const found = await page.evaluate(async () => {
        const logs = await window.__audit.diagnostics.readDiagnosticLogs()
        const hit = logs.events.filter((event) => event.event === 'history.shrank').at(-1)
        return hit ? { level: hit.level, details: hit.details } : null
      })
      assert.ok(found, 'a large drop must be recorded')
      assert.equal(found.details.previousCount, 20)
      assert.equal(found.details.sessionCount, 2)
      assert.equal(found.details.alternateCount, 18)
      assert.equal(found.level, 'error')
    }
  )

  await run(
    'a thousand-millisecond native checkpoint timeout is unknown, not a reason to block startup',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        a.store.useChatStore.setState({ ready: false })
        localStorage.removeItem('freeseek:history-had-conversations')
        localStorage.removeItem('freeseek:history-verified')
        a.historyCheckpoint.historyCheckpointTimeoutMs.value = 60
        // 原生桥读取挂住：这正是线上 Android 上发生的那一种
        a.historyCheckpoint.historyCheckpointReader.read = () => new Promise(() => {})
        const started = performance.now()
        await a.store.initChat()
        const state = a.store.useChatStore.getState()
        return {
          ready: state.ready,
          initError: state.initError,
          historyMissing: state.historyMissing,
          count: state.sessions.length,
          elapsed: Math.round(performance.now() - started),
        }
      })
      assert.equal(result.ready, true, 'a slow native bridge must not block the first screen')
      assert.equal(result.initError, false)
      assert.equal(result.historyMissing, false)
      assert.equal(result.count, 0)
      assert.ok(result.elapsed < 3000, `startup waited ${result.elapsed}ms on the native bridge`)
      const logged = await page.evaluate(async () => {
        const logs = await window.__audit.diagnostics.readDiagnosticLogs()
        return logs.events.some((event) => event.event === 'history.checkpoint-read-timed-out')
      })
      assert.equal(logged, true, 'the timeout is recorded so the diagnosis can see it')
    },
    (context) =>
      context.addInitScript(() => {
        window.CapacitorCustomPlatform = { name: 'android' }
      })
  )

  await run(
    'retry repairs the history selection instead of repeating the same failure',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        await a.db.addStagingSession(
          a.fixtures.session({
            id: 'uncertain-keep',
            title: '暂存里的对话',
            messages: [a.fixtures.user('u', '不能丢的正文')],
          })
        )
        // 去掉「导入中断」标记：两个指针都缺失、也说不清哪一侧提交过——线上就是卡在这里
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('freeseek')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            const tx = db.transaction('historyState', 'readwrite')
            tx.objectStore('historyState').delete('incompleteStaging')
            tx.oncomplete = () => {
              db.close()
              resolve()
            }
            tx.onabort = () => reject(tx.error)
          }
        })
      })
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().historyMissing)
      if (!(await page.evaluate(() => window.matchMedia('(min-width: 768px)').matches))) {
        await page.getByRole('button', { name: '打开边栏', exact: true }).click()
      }
      await page.getByTestId('sider-list').getByRole('button', { name: '重试', exact: true }).click()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      const state = await page.evaluate(async () => {
        const a = window.__audit
        const store = a.store.useChatStore.getState()
        const logs = await a.diagnostics.readDiagnosticLogs()
        return {
          ready: store.ready,
          titles: store.sessions.map((session) => session.title),
          storage: await a.db.getStorageSummary(),
          repaired: logs.events.filter((event) => event.event === 'history.repaired').at(-1)?.details,
          body: (await a.db.loadSession('uncertain-keep')).messages[0].content,
        }
      })
      assert.equal(state.ready, true, 'retry must get past the error page')
      assert.deepEqual(state.titles, ['暂存里的对话'])
      assert.equal(state.storage.sessionCount, 1, 'the records that existed are now the active bank')
      assert.equal(state.repaired.state, 'one-store')
      assert.equal(state.repaired.switched, true)
      assert.equal(state.body, '不能丢的正文', 'no record may be dropped while repairing')
      // 恢复出来的会话真的能打开，正文完整
      await page.getByTestId('sider-list').getByText('暂存里的对话', { exact: true }).click()
      await page.getByText('不能丢的正文', { exact: true }).waitFor()
    }
  )

  await run(
    'a summary row with no conversation is rebuilt away instead of failing the whole list',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([
          a.fixtures.session({
            id: 'real-one',
            title: '真会话',
            messages: [a.fixtures.user('u', '正文还在')],
          }),
        ])
        // 摘要表里多一条没有正文的幽灵记录：同一事务里的计数立刻对不上
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('freeseek')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            const tx = db.transaction('sessionSummaries', 'readwrite')
            tx.objectStore('sessionSummaries').put({
              id: 'ghost-summary',
              title: '幽灵',
              createdAt: 1,
              updatedAt: 1,
              mode: 'chat',
              fileIds: [],
            })
            tx.oncomplete = () => {
              db.close()
              resolve()
            }
            tx.onabort = () => reject(tx.error)
          }
        })
        a.store.useChatStore.setState({ ready: false })
        await a.store.initChat()
        const store = a.store.useChatStore.getState()
        return {
          ready: store.ready,
          initError: store.initError,
          titles: store.sessions.map((session) => session.title),
          storage: await a.db.getStorageSummary(),
        }
      })
      assert.equal(result.ready, true, 'a broken index must not block startup')
      assert.equal(result.initError, false)
      assert.deepEqual(result.titles, ['真会话'])
      assert.equal(result.storage.indexCount, 1, 'the orphan summary is rebuilt away')
    }
  )

  await run(
    'a missing body preserves the row and leaves the other conversations usable',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([
          a.fixtures.session({
            id: 'orphan-row',
            title: '正文丢了',
            messages: [a.fixtures.user('u', 'x')],
          }),
          a.fixtures.session({
            id: 'healthy-row',
            title: '正常会话',
            messages: [a.fixtures.user('u', '好')],
          }),
        ])
        const { sessionCache } = a.store.useChatStore.getState()
        const cache = { ...sessionCache }
        delete cache['orphan-row']
        a.store.useChatStore.setState({ sessionCache: cache })
        // 只删正文，摘要与列表保持原样
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('freeseek')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            const tx = db.transaction('sessions', 'readwrite')
            tx.objectStore('sessions').delete('orphan-row')
            tx.oncomplete = () => {
              db.close()
              resolve()
            }
            tx.onabort = () => reject(tx.error)
          }
        })
        a.store.selectSession('orphan-row')
      })
      await page.getByText('对话加载失败，请重试', { exact: true }).waitFor()
      const state = await page.evaluate(async () => {
        const a = window.__audit
        const store = a.store.useChatStore.getState()
        const logs = await a.diagnostics.readDiagnosticLogs()
        return {
          ids: store.sessions.map((session) => session.id).sort(),
          activeId: store.activeId,
          loadErrors: Object.keys(store.sessionLoadErrors),
          unavailable: logs.events.some((event) => event.event === 'session.body-unavailable'),
          storage: await a.db.getStorageSummary(),
        }
      })
      assert.deepEqual(state.ids, ['healthy-row', 'orphan-row'])
      assert.equal(state.activeId, 'orphan-row')
      assert.deepEqual(state.loadErrors, ['orphan-row'])
      assert.equal(state.unavailable, true)
      assert.equal(state.storage.sessionCount, 1)
      assert.equal(state.storage.indexCount, 2)
      await page.evaluate(() => window.__audit.store.selectSession('healthy-row'))
      await page.getByText('好', { exact: true }).waitFor()
    }
  )

  await run(
    'a conversation with an unreadable body offers to delete it so the rest stays usable',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([a.fixtures.session({ id: 'healthy-row', title: '正常会话', messages: [] })])
        const broken = { id: 'packed-bad', title: '读不出的对话', createdAt: 2, updatedAt: 2, mode: 'chat', fileIds: [] }
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('freeseek')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
            tx.objectStore('sessions').put({
              id: 'packed-bad',
              payload: new Blob(['{"id":"packed-bad"']),
              summary: broken,
            })
            tx.objectStore('sessionSummaries').put(broken)
            tx.oncomplete = () => {
              db.close()
              resolve()
            }
            tx.onabort = () => reject(tx.error)
          }
        })
        const store = a.store.useChatStore.getState()
        a.store.useChatStore.setState({ sessions: [...store.sessions, broken] })
        a.store.selectSession('packed-bad')
      })
      await page.getByText('对话加载失败，请重试', { exact: true }).waitFor()
      await page.getByRole('button', { name: '删除这条读不出的对话', exact: true }).click()
      await page.getByTestId('chat-composer').waitFor()
      const state = await page.evaluate(async () => {
        const store = window.__audit.store.useChatStore.getState()
        return {
          ids: store.sessions.map((session) => session.id),
          activeId: store.activeId,
          storage: await window.__audit.db.getStorageSummary(),
        }
      })
      assert.deepEqual(state.ids, ['healthy-row'])
      assert.equal(state.activeId, null)
      assert.equal(state.storage.sessionCount, 1, 'only the unreadable record is deleted')
    }
  )
}
