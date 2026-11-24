import assert from 'node:assert/strict'

export const runHistoryRecoveryCases = async (run) => {
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
        await a.backup.importHistory(new File([blob], name))
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
          original: await (await a.db.loadFile('keep-file')).text(),
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
        await a.backup.importHistory(new File([pack.blob], pack.name))
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
    'export skips conversations whose record is gone instead of failing',
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
        const { blob, skipped } = await a.backup.exportHistory()
        const paths = []
        // 归档是流式解析的：每条 entry 必须读掉再往下走
        for await (const entry of a.readArchive(new File([blob], 'backup.zip'))) {
          paths.push(entry.path)
          await (await a.readEntry(entry)).text()
        }
        return { skipped, bytes: blob.size, paths }
      })
      // 一条读不到不该让整次备份失败：导出剩下的，并如实报告跳过数
      assert.equal(result.skipped, 1)
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
    'a large drop in conversation count is recorded for diagnosis',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([
          a.fixtures.session({ id: 'drop-a', messages: [] }),
          a.fixtures.session({ id: 'drop-b', messages: [] }),
        ])
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
      await page.getByRole('button', { name: '重试', exact: true }).click()
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
      await page.evaluate(() => window.__audit.store.selectSession('uncertain-keep'))
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
    'a conversation whose body is gone leaves the list instead of stalling on a retry loop',
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
      await page.waitForTimeout(800)
      const state = await page.evaluate(async () => {
        const a = window.__audit
        const store = a.store.useChatStore.getState()
        const logs = await a.diagnostics.readDiagnosticLogs()
        return {
          ids: store.sessions.map((session) => session.id),
          activeId: store.activeId,
          loadErrors: Object.keys(store.sessionLoadErrors),
          orphanLogged: logs.events.some((event) => event.event === 'session.orphan-summary'),
          storage: await a.db.getStorageSummary(),
        }
      })
      assert.deepEqual(state.ids, ['healthy-row'])
      assert.equal(state.activeId, null, 'the unreadable conversation is not left as the active one')
      assert.deepEqual(state.loadErrors, [])
      assert.equal(state.orphanLogged, true)
      assert.equal(state.storage.sessionCount, 1)
      assert.equal(await page.getByText('对话加载失败，请重试', { exact: true }).count(), 0)
      assert.equal(await page.getByText('正文丢了', { exact: true }).count(), 0)
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
