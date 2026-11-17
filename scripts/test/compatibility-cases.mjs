import assert from 'node:assert/strict'

export const runCompatibilityCases = async (run) => {
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
      await page.getByRole('button', { name: '覆盖并导入', exact: true }).click()
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
