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
    'history recovery reports incomplete reads and repairs a missing sidebar index on retry',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([
          a.fixtures.session({
            id: 'repair-index',
            title: '应保留的旧对话',
            messages: [a.fixtures.user('u', '完整内容')],
          }),
        ])
        const state = a.store.useChatStore
        state.setState({ ready: false })
        const original = IDBObjectStore.prototype.getAllKeys
        IDBObjectStore.prototype.getAllKeys = function (...args) {
          return original.apply(this, this.name === 'sessions' ? ['not-an-existing-id'] : args)
        }
        await a.store.initChat()
        IDBObjectStore.prototype.getAllKeys = original
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
      })
      await page.getByText('对话列表加载失败，请重试', { exact: true }).first().waitFor()
      await page.getByRole('button', { name: '重试', exact: true }).last().click()
      await page.getByText('完整内容', { exact: true }).waitFor()
      const state = await page.evaluate(() => window.__audit.db.getStorageSummary())
      assert.equal(state.indexCount, 1)
      assert.equal(state.sessionCount, 1)
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
}
