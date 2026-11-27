import assert from 'node:assert/strict'

export const runDiagnosticRetentionCases = async (run) => {
  await run(
    'Android keeps the recovery prompt when its checkpoint says history existed but the native read is delayed',
    async (page) => {
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().initError)
      const state = await page.evaluate(() => {
        const { ready, historyMissing, historyMayStartFresh, historyRecoveryReason } =
          window.__audit.store.useChatStore.getState()
        return { ready, historyMissing, historyMayStartFresh, historyRecoveryReason }
      })
      // 本地检查点记着「有过对话」：这时候超时不能当成空库，仍然要给出恢复入口
      assert.deepEqual(state, {
        ready: false,
        historyMissing: true,
        historyMayStartFresh: true,
        historyRecoveryReason: 'checkpoint-timeout',
      })
      await page.getByRole('main').getByText(/暂时读取不到之前的聊天记录/).waitFor()
      await page.getByRole('button', { name: '暂不恢复，进入首页', exact: true }).click()
      await page.getByTestId('chat-composer').waitFor()
    },
    (context) =>
      context.addInitScript(() => {
        if (!sessionStorage.getItem('checkpoint-seeded')) {
          sessionStorage.setItem('checkpoint-seeded', '1')
          localStorage.setItem('freeseek:history-had-conversations', '1')
        }
        window.CapacitorCustomPlatform = { name: 'android' }
        window.Capacitor = {
          PluginHeaders: [
            {
              name: 'Diagnostics',
              methods: ['checkHistory', 'retainClientEvents'].map((name) => ({
                name,
                rtype: 'promise',
              })),
            },
          ],
          nativePromise: async (_plugin, method) =>
            method === 'checkHistory' ? new Promise(() => {}) : {},
        }
      }),
    false
  )

  await run(
    'Android diagnostic evidence survives resetting both WebView databases and preferences',
    async (page) => {
      const records = async () =>
        page.evaluate(async () => {
          const a = window.__audit
          const { name, blob } = await a.diagnosticBundle.createDiagnosticBundle()
          const entries = {}
          for await (const entry of a.readArchive(new File([blob], name))) {
            entries[entry.path] = await (await a.readEntry(entry)).text()
          }
          return {
            summary: JSON.parse(entries['summary.json']),
            environment: JSON.parse(entries['environment.json']),
            events: entries['client-events.jsonl']
              .trim()
              .split('\n')
              .map((row) => JSON.parse(row)),
          }
        })
      await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([a.fixtures.session({ id: 'evidence-qa', title: 'PRIVATE_CHAT_TITLE' })])
        a.diagnostics.logEvent(
          'api',
          'http.failed',
          { status: 429, reason: 'quota', prompt: 'PRIVATE_CHAT_BODY' },
          'warn'
        )
      })
      const before = await records()
      assert.equal(before.events.filter(({ event }) => event === 'http.failed').length, 1)
      assert.equal(before.summary.recoveredClientEvents, 0)
      assert.equal(before.environment.historyCheckpoint.sessionCount, 1)
      const startupRoute = before.events.find(({ event }) => event === 'startup.chat-route')
      assert.equal(startupRoute.details.startupPage, 'last-chat')
      for (const key of ['startupPreferenceSource', 'lastSelectionSource']) {
        assert.ok(['native', 'database', 'legacy'].includes(startupRoute.details[key]))
      }

      const devtools = await page.context().newCDPSession(page)
      await devtools.send('Storage.clearDataForOrigin', {
        origin: new URL(page.url()).origin,
        storageTypes: 'indexeddb,local_storage',
      })
      await devtools.detach()
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().historyMissing)
      const after = await records()
      const failure = after.events.find(({ event }) => event === 'http.failed')
      assert.equal(failure.recoveredFromNative, true)
      assert.equal(failure.details.status, 429)
      assert.equal(after.summary.clientIndexedDBCreatedThisRun, true)
      const suspect = after.events.find(({ event }) => event === 'history.unexpected-empty')
      assert.equal(suspect.details.previousSessionCount, 1)
      assert.equal(suspect.details.activeCount, 0)
      assert.equal(suspect.details.alternateCount, 0)
      assert.equal(suspect.details.indexCount, 0)
      assert.equal(suspect.details.historyReason, 'empty-after-known-history')
      assert.equal(after.environment.state.historyRecoveryReason, 'empty-after-known-history')
      const recoveredRoute = after.events.find(({ id }) => id === startupRoute.id)
      assert.equal(recoveredRoute.recoveredFromNative, true)
      assert.deepEqual(recoveredRoute.details, startupRoute.details)
      assert.ok(
        after.events.some(
          ({ event, details }) => event === 'history.db-opened' && details.createdDatabase
        )
      )
      assert.ok(after.summary.timeline.retainedClient.firstAt <= failure.timestamp)
      assert.doesNotMatch(JSON.stringify(after), /PRIVATE_CHAT_TITLE|PRIVATE_CHAT_BODY/)

      await page.evaluate(() => {
        window.__failDiagnosticEnvironment = true
      })
      const partial = await records()
      assert.equal(partial.summary.collection.native, 'failed')
      assert.ok(partial.summary.recoveredClientEvents >= 1)
      assert.ok(
        partial.events.some(
          ({ event, recoveredFromNative }) => event === 'http.failed' && recoveredFromNative
        )
      )
    },
    async (context) => {
      const outsideWebView = new Map()
      let checkpoint = { present: false }
      await context.exposeBinding('retainedNativeFixture', (_source, method, options) => {
        if (method === 'recordHistory') {
          checkpoint = { ...options, verifiedAt: Date.now() }
        }
        if (method === 'checkHistory') return checkpoint
        if (method === 'retainClientEvents') {
          for (const event of options.events) outsideWebView.set(event.id, event)
        }
        return {
          events: [],
          failedWrites: 0,
          historyCheckpoint: checkpoint,
          environment: { sdk: 29 },
          retainedClient: {
            events: [...outsideWebView.values()],
            limit: 512,
            historyReserve: 96,
            issueReserve: 128,
            readState: 'available',
          },
        }
      })
      await context.addInitScript(() => {
        window.CapacitorCustomPlatform = { name: 'android' }
        window.Capacitor = {
          PluginHeaders: [
            {
              name: 'Diagnostics',
              methods: [
                'recordHistory',
                'checkHistory',
                'retainClientEvents',
                'snapshot',
                'readEvents',
              ].map((name) => ({ name, rtype: 'promise' })),
            },
          ],
          nativePromise: async (plugin, method, options) => {
            if (plugin !== 'Diagnostics') return {}
            if (method === 'snapshot' && window.__failDiagnosticEnvironment) {
              throw new Error('PRIVATE_DEVICE_PROBE_DETAILS')
            }
            return window.retainedNativeFixture(method, options)
          },
        }
      })
    }
  )

  await run(
    'history recovery distinguishes failed and timed-out database reads and preserves the original chat',
    async (page) => {
      await page.locator('#fs-startup').waitFor({ state: 'hidden' })
      await page.evaluate(async () => {
        const a = window.__audit
        a.settings.setLocale('en-US')
        await a.seed([a.fixtures.session({
          id: 'temporary-read-failure',
          title: 'Stored conversation',
          messages: [a.fixtures.user('one', 'The original body remains.')],
        })])
      })
      const main = page.getByRole('main')
      for (const [kind, expected] of [
        ['UnknownError', 'unreadable'],
        ['TimeoutError', 'read-timeout'],
      ]) {
        const result = await page.evaluate(async (kind) => {
          const { store, db, diagnostics } = window.__audit
          const getAll = IDBObjectStore.prototype.getAll
          IDBObjectStore.prototype.getAll = function (...args) {
            if (this.name === 'sessionSummaries') throw new DOMException('synthetic history read', kind)
            return getAll.apply(this, args)
          }
          try {
            store.useChatStore.setState({ ready: false })
            await store.initChat()
          } finally {
            IDBObjectStore.prototype.getAll = getAll
          }
          const { historyRecoveryReason, historyMayStartFresh } = store.useChatStore.getState()
          const { events } = await diagnostics.readDiagnosticLogs()
          return {
            historyRecoveryReason,
            historyMayStartFresh,
            logged: events.filter(({ event }) => event === 'history.startup-read-failed').at(-1)?.details.historyReason,
            body: (await db.loadSession('temporary-read-failure')).messages[0].content,
          }
        }, kind)
        assert.deepEqual(result, {
          historyRecoveryReason: expected,
          historyMayStartFresh: false,
          logged: expected,
          body: 'The original body remains.',
        })
        await main.getByText('Local chats are temporarily unavailable. Try again, or restore from an existing backup.', { exact: true }).waitFor()
        await main.getByRole('button', { name: 'Open backup settings', exact: true }).waitFor()
        assert.equal(await main.getByRole('button', { name: 'Continue without restoring' }).count(), 0)
        await main.getByRole('button', { name: 'Retry', exact: true }).click()
        await page.waitForFunction(() => window.__audit.store.useChatStore.getState().ready)
      }
    }
  )

  await run(
    'diagnostic export includes bounded on-device recovery facts without private identifiers or writes',
    async (page) => {
      await page.locator('#fs-startup').waitFor({ state: 'hidden' })
      const snapshot = (mode) => page.evaluate(async (mode) => {
        const a = window.__audit
        a.historyVault.useHistoryVault.setState({ phase: mode === 'invalid' ? 'PRIVATE_VAULT_PHASE' : 'protecting' })
        window.__vaultProbeMode = mode
        window.__vaultProbeCalls = []
        const started = performance.now()
        const { name, blob } = await a.diagnosticBundle.createDiagnosticBundle()
        const elapsed = Math.round(performance.now() - started)
        const entries = {}
        for await (const entry of a.readArchive(new File([blob], name))) {
          entries[entry.path] = await (await a.readEntry(entry)).text()
        }
        return {
          environment: JSON.parse(entries['environment.json']),
          summary: JSON.parse(entries['summary.json']),
          combined: Object.values(entries).join('\n'),
          calls: window.__vaultProbeCalls,
          elapsed,
        }
      }, mode)
      for (const [mode, status] of [
        ['available', 'available'], ['permission', 'permission'], ['timeout', 'timeout'], ['invalid', 'failed'],
      ]) {
        const { environment, summary, combined, calls, elapsed } = await snapshot(mode)
        assert.equal(environment.app.nativePlugins.HistoryVault, true)
        assert.equal(environment.app.nativePlugins.StartupRoute, true)
        const expected = { status, ...(mode === 'invalid' ? {} : { phase: 'protecting' }) }
        if (mode === 'available') Object.assign(expected, {
          sessionCount: 8,
          originalCount: 53,
          missingOriginalCount: 2,
          bytes: 2148205687,
          pendingCommit: true,
        })
        assert.deepEqual(environment.historyVault, expected)
        assert.equal(summary.collection.historyVault, status)
        assert.deepEqual(calls, ['status'])
        assert.doesNotMatch(combined, /PRIVATE_VAULT|PRIVATE_STARTUP_PATH/)
        if (mode === 'timeout') {
          assert.ok(elapsed >= 1400 && elapsed < 5000, 'the timed-out bridge must release the export')
        }
      }
    },
    (context) => context.addInitScript(() => {
      window.CapacitorCustomPlatform = { name: 'android' }
      window.Capacitor = {
        PluginHeaders: [
          { name: 'HistoryVault', methods: ['status', 'listSessions', 'commit'].map((name) => ({ name, rtype: 'promise' })) },
          { name: 'Diagnostics', methods: ['checkHistory', 'retainClientEvents', 'snapshot'].map((name) => ({ name, rtype: 'promise' })) },
          { name: 'StartupRoute', methods: ['save', 'read'].map((name) => ({ name, rtype: 'promise' })) },
        ],
        nativePromise: async (plugin, method) => {
          if (plugin === 'HistoryVault') {
            const mode = window.__vaultProbeMode
            if (mode) window.__vaultProbeCalls.push(method)
            if (method === 'listSessions') return { items: [] }
            if (method !== 'status') throw new Error('unexpected mutation in diagnostic probe')
            if (!mode) return { generation: 0, sessionCount: 0, originalCount: 0, missingOriginalCount: 0, bytes: 0 }
            if (mode === 'timeout') return new Promise(() => {})
            if (mode === 'permission') throw Object.assign(new Error('PRIVATE_VAULT_PERMISSION_DETAIL'), { code: 'PERMISSION' })
            return {
              generation: 4,
              sessionCount: mode === 'invalid' ? -1 : 8,
              originalCount: 53,
              missingOriginalCount: 2,
              bytes: 2148205687,
              pendingId: 'PRIVATE_VAULT_PENDING_ID',
              path: 'PRIVATE_VAULT_PATH',
              fileId: 'PRIVATE_VAULT_ORIGINAL_ID',
              startupPath: 'PRIVATE_STARTUP_PATH',
            }
          }
          if (plugin === 'Diagnostics' && method === 'checkHistory') return { present: false }
          return {}
        },
      }
    })
  )
}
