import assert from 'node:assert/strict'

export const runDiagnosticRetentionCases = async (run) => {
  await run(
    'Android does not present an unverified empty history when its native checkpoint is delayed',
    async (page) => {
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().initError)
      const state = await page.evaluate(() => {
        const { ready, historyMissing, historyMayStartFresh } =
          window.__audit.store.useChatStore.getState()
        return { ready, historyMissing, historyMayStartFresh }
      })
      assert.deepEqual(state, { ready: false, historyMissing: false, historyMayStartFresh: true })
      await page.getByRole('button', { name: '暂不恢复，进入首页', exact: true }).click()
      await page.getByTestId('chat-composer').waitFor()
    },
    (context) =>
      context.addInitScript(() => {
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
      assert.equal(suspect.details.indexCount, 0)
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
}
