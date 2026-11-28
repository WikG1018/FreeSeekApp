import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { unzipSync, zipSync } from 'fflate'

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

const vaultFixture = (context, checkpoint = false, withRecoveredChat = false) =>
  context.addInitScript(({ checkpoint, withRecoveredChat }) => {
    if (checkpoint) localStorage.setItem('freeseek:history-had-conversations', '1')
    window.CapacitorCustomPlatform = { name: 'android' }
    window.__vaultStatusReads = 0
    window.__vaultSavedIds = new Set()
    window.__vaultNoSpace = false
    window.__vaultExternalCopy = checkpoint && withRecoveredChat
    let recoveredChat
    const status = () => {
      const sessionCount = window.__vaultExternalCopy ? 1 : checkpoint ? 3 : window.__vaultSavedIds.size
      return {
        generation: sessionCount ? 4 : 0,
        sessionCount,
        originalCount: checkpoint && !withRecoveredChat ? 5 : 0,
        missingOriginalCount: checkpoint || window.__vaultExternalCopy ? 1 : 0,
        bytes: sessionCount ? 1300 : 0,
      }
    }
    window.Capacitor = {
      PluginHeaders: [
        {
          name: 'HistoryVault',
          methods: [
            'status', 'listSessions', 'listOriginals', 'readSession',
            'begin', 'putSession', 'append', 'finishEntry', 'commit', 'cancel',
          ].map((name) => ({ name, rtype: 'promise' })),
        },
        { name: 'Diagnostics', methods: ['checkHistory', 'retainClientEvents'].map((name) => ({ name, rtype: 'promise' })) },
      ],
      nativePromise: async (plugin, method, args) => {
        if (plugin === 'HistoryVault' && method === 'status') {
          window.__vaultStatusReads++
          return status()
        }
        if (plugin === 'HistoryVault' && method === 'begin') {
          if (window.__vaultNoSpace) throw Object.assign(new Error('synthetic low space'), { code: 'NO_SPACE' })
          return { id: 'fixture-batch' }
        }
        if (plugin === 'HistoryVault' && method === 'putSession') window.__vaultSavedIds.add(args.sessionId)
        if (plugin === 'HistoryVault' && method === 'commit') return status()
        if (plugin === 'HistoryVault' && ['listSessions', 'readSession'].includes(method)) {
          if (!checkpoint && !window.__vaultExternalCopy) return { items: [] }
          if (!withRecoveredChat) throw new Error('synthetic vault read failure')
          if (!recoveredChat) {
            const f = window.__audit.fixtures
            const chat = f.session({
              id: 'vault-ui-restored',
              title: '从本机副本找回的会话',
              messages: [f.user('user', '从本机副本找回的正文', {
                files: [{
                  id: 'vault-ui-missing-original', name: '样本.txt', size: 14,
                  mimeType: 'text/plain', isImage: false,
                }],
              })],
            })
            const bytes = new TextEncoder().encode(JSON.stringify(chat))
            const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
            const sha256 = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')
            recoveredChat = { id: chat.id, bytes, sha256 }
          }
          const { id, bytes, sha256 } = recoveredChat
          if (method === 'listSessions') {
            return { items: [{ id, size: bytes.length, revision: 'fixture', sha256 }] }
          }
          const chunk = bytes.subarray(args.offset, args.offset + args.limit)
          const nextOffset = args.offset + chunk.length
          return { data: btoa(String.fromCharCode(...chunk)), nextOffset, eof: nextOffset === bytes.length }
        }
        if (plugin === 'HistoryVault' && method === 'listOriginals') return { items: [] }
        if (plugin === 'Diagnostics' && method === 'checkHistory') return { present: checkpoint }
        return {}
      },
    }
  }, { checkpoint, withRecoveredChat })

export const runHistoryRecoveryCases = async (run) => {
  await run('on-device recovery status keeps unknown counts separate and gives each action once', async (page) => {
    await page.locator('#fs-startup').waitFor({ state: 'hidden' })
    await page.evaluate(() => window.__audit.settingsDialog.openSettings('data'))
    const backupEntry = page.getByRole('button', { name: '本机聊天备份', exact: true })
    await backupEntry.waitFor()
    assert.equal(await page.getByRole('heading', { name: '备份状态', exact: true }).count(), 0)
    await backupEntry.click()
    await page.getByRole('heading', { name: '本机聊天备份', exact: true }).waitFor()
    await page.waitForFunction(() => window.__audit.historyVault.useHistoryVault.getState().phase !== 'checking')
    const display = (state) => page.evaluate(
      (state) => window.__audit.historyVault.useHistoryVault.setState(state), state
    )
    await display({
      phase: 'idle', generation: 4, totalSessions: null, protectedSessions: 3,
      protectedOriginals: 5, missingOriginals: 1,
      protectedBytes: 16 * 1024 * 1024,
    })
    await page.getByText('备份里有 3 个对话', { exact: true }).waitFor()
    const metric = (label) => page.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')
    assert.equal(await metric('已备份的附件').innerText(), '5')
    await page.getByText('还有 1 份附件未备份。', { exact: true }).waitFor()
    assert.equal(await metric('占用空间').innerText(), '16 MB')
    assert.equal(await metric('当前对话数').count(), 0)
    assert.equal(await page.getByRole('button', { name: '检查备份', exact: true }).count(), 0)

    await display({ totalSessions: 8 })
    await page.getByText('已备份 3/8 个对话', { exact: true }).waitFor()
    const protect = page.getByRole('button', { name: '检查备份', exact: true })
    const restore = page.getByRole('button', { name: '找回聊天和附件', exact: true })
    assert.equal(await protect.count(), 1)
    assert.equal(await restore.count(), 1)
    await page.getByText('从备份补回缺少的内容，保留现在的聊天。', { exact: true }).waitFor()
    if (process.env.FREESEEK_VAULT_UI_PROOF) {
      await page.getByRole('dialog').screenshot({
        path: process.env.FREESEEK_VAULT_UI_PROOF + '/history-vault-data-' + page.viewportSize().width + '-zh.png',
        animations: 'disabled',
      })
    }
    await display({ phase: 'protecting', processed: 4, total: 8 })
    await page.getByText('正在备份，已检查 4/8 个对话。', { exact: true }).waitFor()
    assert.equal(await protect.getAttribute('aria-busy'), 'true')
    assert.equal(await protect.isDisabled(), true)
    assert.equal(await restore.isDisabled(), true)

    await display({ phase: 'error', issue: 'space' })
    await page.getByRole('alert').getByText('手机空间不足。腾出空间后可以重试。', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '重试备份', exact: true }).count(), 1)
    assert.equal(await page.getByRole('button', { name: '重新检查备份', exact: true }).count(), 0)
    await page.evaluate(() => window.__audit.settings.setLocale('en-US'))
    await page.getByRole('heading', { name: 'On-device chat backup', exact: true }).waitFor()
    await page.getByText('3 of 8 chats backed up', { exact: true }).waitFor()
    await page.getByText('Device storage is low. Free some space and try again.', { exact: true }).waitFor()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 320, height: 700 })
    await page.evaluate(() => {
      window.__audit.settings.setThemePreference('dark')
      window.__audit.settings.setFontScale(1.2)
    })
    const check = page.getByRole('button', { name: 'Retry backup', exact: true })
    const recover = page.getByRole('button', { name: 'Recover chats and attachments', exact: true })
    await recover.waitFor()
    const [checkBounds, recoverBounds] = await check.evaluate((row) =>
      [...row.closest('section').querySelectorAll('button')].map((button) => {
        const { x, y, width, height } = button.getBoundingClientRect()
        return { x, y, width, height }
      })
    )
    assert.equal(checkBounds.x, recoverBounds.x)
    assert.equal(checkBounds.width, recoverBounds.width)
    assert.ok(recoverBounds.y >= checkBounds.y + checkBounds.height)
    assert.ok(recoverBounds.x + recoverBounds.width <= 320)
    await display({ totalSessions: null, issue: 'unreadable' })
    const checks = await page.evaluate(() => window.__vaultStatusReads)
    await page.getByRole('button', { name: 'Check the backup again', exact: true }).click()
    await page.waitForFunction((checks) => window.__vaultStatusReads > checks, checks)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'On-device chat backup', exact: true }).waitFor()
  }, (context) => vaultFixture(context))

  await run('data management restores from its recovery row and shows the outcome', async (page) => {
    await page.locator('#fs-startup').waitFor({ state: 'hidden' })
    await page.evaluate(() => {
      window.__vaultExternalCopy = true
      window.__audit.settingsDialog.openSettings('data')
    })
    await page.getByRole('button', { name: '本机聊天备份', exact: true }).click()
    await page.getByRole('button', { name: '找回聊天和附件', exact: true }).click()
    const result = page.getByRole('dialog', { name: '已找回备份中可用的内容', exact: true })
    await result.getByText('找回 1 个对话。', { exact: true }).waitFor()
    await result.getByText('备份里缺少 1 份附件。', { exact: true }).waitFor()
  }, (context) => vaultFixture(context, false, true))

  await run('on-device recovery protection can retry low storage without losing the original chats', async (page) => {
    await page.locator('#fs-startup').waitFor({ state: 'hidden' })
    await page.evaluate(async () => {
      const a = window.__audit
      await a.seed([
        a.fixtures.session({ id: 'vault-protect-a', title: '第一条', messages: [a.fixtures.user('u', '仍在本机')] }),
        a.fixtures.session({ id: 'vault-protect-b', title: '第二条' }),
      ])
      a.settingsDialog.openSettings('data')
    })
    await page.getByRole('button', { name: '本机聊天备份', exact: true }).click()
    const protect = page.getByRole('button', { name: '检查备份', exact: true })
    await protect.waitFor()
    await page.evaluate(() => { window.__vaultNoSpace = true })
    await protect.click()
    await page.getByText('手机空间不足。腾出空间后可以重试。', { exact: true }).waitFor()
    assert.equal(
      await page.evaluate(async () => (await window.__audit.db.loadSession('vault-protect-a')).messages[0].content),
      '仍在本机'
    )
    await page.evaluate(() => { window.__vaultNoSpace = false })
    await page.getByRole('button', { name: '重试备份', exact: true }).click()
    await protect.waitFor()
    await page.getByText('已备份 2/2 个对话', { exact: true }).waitFor()
    assert.equal(await page.getByText('手机空间不足。腾出空间后可以重试。', { exact: true }).count(), 0)
  }, (context) => vaultFixture(context))

  await run('startup recovery offers the Android copy alongside retry and ZIP', async (page) => {
    await page.locator('#fs-startup').waitFor({ state: 'hidden' })
    const main = page.getByRole('main')
    const restore = main.getByRole('button', { name: '找回聊天和附件', exact: true })
    await restore.waitFor()
    await main.getByText('本机备份里有 3 个对话可以找回。', { exact: true }).waitFor()
    await main.getByRole('alert').getByText(/没能从备份找回聊天/).waitFor()
    const retry = main.getByRole('button', { name: '重试', exact: true })
    const zip = main.getByRole('button', { name: '打开备份设置', exact: true })
    assert.equal(await retry.isEnabled(), true)
    assert.equal(await zip.isEnabled(), true)
    assert.equal(await page.getByRole('button', { name: '重试', exact: true }).count(), 1)
    if (process.env.FREESEEK_VAULT_UI_PROOF) {
      await page.screenshot({
        path: process.env.FREESEEK_VAULT_UI_PROOF + '/history-vault-restore-' + page.viewportSize().width + '-zh.png',
        animations: 'disabled',
      })
    }
    await page.evaluate(() => window.__audit.historyVault.useHistoryVault.setState({
      phase: 'restoring', processed: 1, total: 3,
    }))
    await main.getByText('正在找回，已检查 1/3 项。', { exact: true }).waitFor()
    assert.equal(await restore.isEnabled(), false)
    assert.equal(await retry.isEnabled(), false)
    assert.equal(await zip.isEnabled(), false)
    await page.evaluate(() => window.__audit.historyVault.useHistoryVault.setState({ phase: 'idle' }))
    await restore.click()
    await main.getByRole('alert').getByText(/没能从备份找回聊天/).waitFor()
    assert.equal(await restore.isEnabled(), true)
    assert.equal(await retry.isEnabled(), true)
    assert.equal(await zip.isEnabled(), true)
    assert.equal(await page.getByRole('dialog', { name: '已从备份找回' }).count(), 0)
    await zip.click()
    await page.getByRole('button', { name: /导入历史对话/ }).waitFor()
    assert.equal(await page.getByRole('dialog').getByRole('button', {
      name: '找回聊天和附件', exact: true,
    }).count(), 0)
  }, (context) => vaultFixture(context, true), false)

  await run('on-device recovery automatically restores chats at startup and reports missing attachments', async (page) => {
    await page.locator('#fs-startup').waitFor({ state: 'hidden' })
    await page.getByText('已自动找回 1 个对话，备份里缺少 1 份附件。', { exact: true }).waitFor()
    await page.getByTestId('chat-composer').waitFor()
    const session = await page.evaluate(() => window.__audit.db.loadSession('vault-ui-restored'))
    assert.equal(session.messages[0].content, '从本机副本找回的正文')
    assert.equal(session.messages[0].files[0].name, '样本.txt')
    await page.evaluate(() => window.__audit.settingsDialog.openSettings('data'))
    await page.getByRole('button', { name: '删除所有对话', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: /所有对话都将被清空/ })
    await confirm.getByText(/聊天记录、本机备份、附件和未发送的草稿会一并清空/).waitFor()
    await confirm.getByRole('button', { name: '取消', exact: true }).click()
    await page.evaluate(() => window.__audit.settingsDialog.closeSettings())
    await page.getByRole('heading', { name: '数据管理', exact: true }).waitFor({ state: 'hidden' })
    const mobile = await page.evaluate(() => !window.matchMedia('(min-width: 768px)').matches)
    if (mobile) await page.getByRole('button', { name: '打开边栏', exact: true }).click()
    const row = page.locator('[data-session-id="vault-ui-restored"]:visible')
    await row.hover()
    await row.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('menuitem', { name: '删除', exact: true }).click()
    const deleteChat = page.getByRole('dialog', { name: '永久删除对话', exact: true })
    await deleteChat.getByText(/此对话及其本机备份会一并删除/).waitFor()
    await deleteChat.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await page.evaluate(() => window.__audit.store.useChatStore.getState().sessions.length), 1)
  }, (context) => vaultFixture(context, true, true), false)

  await run('data management on the web retains ZIP without the on-device recovery controls', async (page) => {
    await page.evaluate(() => window.__audit.settingsDialog.openSettings('data'))
    await page.getByRole('button', { name: /导入历史对话/ }).waitFor()
    assert.equal(await page.getByRole('heading', { name: '本机聊天备份' }).count(), 0)
    assert.equal(await page.getByRole('button', { name: '本机聊天备份' }).count(), 0)
    assert.equal(await page.getByRole('button', { name: '找回聊天和附件' }).count(), 0)
  })

  await run(
    'Android large history saves disk originals without creating a WebView archive and retries a failed destination',
    async (page) => {
      const originalBytes = 4 * 512 * 1024 * 1024
      const legacyBytes = 600 * 1024
      await page.evaluate(async ({ originalBytes, legacyBytes }) => {
        const a = window.__audit
        const files = Array.from({ length: 4 }, (_, index) => ({
          id: 'archive-large-' + index, name: '原件' + index + '.bin', serverId: null,
          size: originalBytes / 4, mimeType: 'application/octet-stream', isImage: false,
        }))
        const legacy = {
          id: 'archive-legacy', name: '旧版原件.bin', serverId: null,
          size: legacyBytes, mimeType: 'application/octet-stream', isImage: false,
        }
        const chat = a.fixtures.session({
          id: 'large-history-native-export', title: '两吉字节验收', pinned: true,
          messages: [a.fixtures.user('archive-q', '检查原件。', { files: [...files, legacy] })],
        })
        await a.seed([chat], [{ id: legacy.id, blob: new Blob([new Uint8Array(legacyBytes)]) }])
        a.settingsDialog.openSettings('data')
      }, { originalBytes, legacyBytes })
      await changeHistory(page, Array.from({ length: 4 }, (_, index) => [
        'files', 'put', {
          id: 'archive-large-' + index,
          disk: { key: 'original-test-key-' + index, size: originalBytes / 4, type: 'application/octet-stream' },
        },
      ]))
      const exportButton = page.getByRole('button', { name: '导出所有历史对话', exact: true })
      const success = page.getByRole('status').filter({ hasText: '备份已保存' })
      await exportButton.click()
      await page.waitForFunction(() => window.__historySave.tries === 1)
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(
        (button) => button.textContent === '导出所有历史对话' && !button.disabled
      ))
      assert.equal(await page.evaluate(() => window.__historySave.writes.length), 0)
      assert.equal(await success.count(), 0)

      await exportButton.click()
      await page.getByText(/无法写完备份/).waitFor()
      let result = await page.evaluate(() => window.__historySave)
      assert.deepEqual(result.cancelled, ['broken'])
      assert.deepEqual(result.finished, [])
      assert.equal(await exportButton.isEnabled(), true)
      assert.equal(await success.count(), 0)
      const logs = await page.evaluate(async () =>
        (await window.__audit.diagnostics.readDiagnosticLogs()).events.filter(({ scope }) => scope === 'backup')
      )
      assert.ok(logs.some(({ event }) => event === 'export.cancelled'))
      const failure = logs.find(({ event }) => event === 'file.save.failed')
      assert.equal(failure?.details.stage, 'write')
      assert.equal(failure?.details.faultCode, 'HISTORY_ARCHIVE_WRITE')
      assert.doesNotMatch(JSON.stringify(logs), /private-fixture-destination/)

      await exportButton.click()
      await success.waitFor()
      result = await page.evaluate(() => window.__historySave)
      assert.deepEqual(result.finished, ['retry'])
      const entries = result.entries.filter(({ id }) => id === 'retry')
      const blobs = entries.filter(({ key }) => !key)
      const disk = entries.filter(({ key }) => key)
      assert.deepEqual(entries.map(({ name }) => name), [
        'manifest.json', 'freeseek/sessions/large-history-native-export.json',
        'freeseek/files/archive-large-0.bin', 'freeseek/files/archive-large-1.bin',
        'freeseek/files/archive-large-2.bin', 'freeseek/files/archive-large-3.bin',
        'freeseek/files/archive-legacy.bin',
      ])
      assert.deepEqual(disk.map(({ size }) => size), Array(4).fill(originalBytes / 4))
      const writes = result.writes.filter(({ id }) => id === 'retry')
      assert.ok(writes.every(({ size }) => size <= 256 * 1024))
      assert.equal(writes.reduce((bytes, chunk) => bytes + chunk.size, 0), blobs.reduce((bytes, entry) => bytes + entry.size, 0))
      assert.equal(result.creates.at(-1).archiveEntries, 7)
      assert.equal(result.creates.at(-1).size, originalBytes + writes.reduce((bytes, chunk) => bytes + chunk.size, 0))
      assert.equal(result.unexpectedFetches, 0, 'disk files never travel through response.blob()')
      assert.equal(await page.evaluate(async () =>
        (await window.__audit.db.loadSession('large-history-native-export')).messages[0].files.length
      ), 5)
    },
    (context) => context.addInitScript(() => {
      const methods = (names) => names.map((name) => ({ name, rtype: 'promise' }))
      const proof = {
        tries: 0, creates: [], entries: [], writes: [], cancelled: [], finished: [], unexpectedFetches: 0,
      }
      window.__historySave = proof
      const fetchOriginal = window.fetch
      window.fetch = (...args) => {
        if (String(args[0]).includes('native-history-backing.bin')) {
          proof.unexpectedFetches++
          return Promise.reject(new DOMException('The DOM File could not be read', 'NotReadableError'))
        }
        return fetchOriginal(...args)
      }
      window.CapacitorCustomPlatform = { name: 'android' }
      window.Capacitor = {
        PluginHeaders: [
          { name: 'HistoryFiles', methods: methods(['locate']) },
          { name: 'Backup', methods: methods(['create', 'beginArchiveEntry', 'write', 'finish', 'cancel']) },
        ],
        async nativePromise(plugin, method, options) {
          if (plugin === 'HistoryFiles' && method === 'locate') {
            return { path: '/data/user/0/fixture/native-history-backing.bin' }
          }
          if (plugin !== 'Backup') return {}
          if (method === 'create') {
            proof.creates.push(options)
            switch (++proof.tries) {
              case 1: return { cancelled: true }
              case 2: return { id: 'broken' }
              default: return { id: 'retry' }
            }
          }
          if (method === 'beginArchiveEntry') {
            if (options.id === 'broken' && options.key) {
              throw Object.assign(new Error('private-fixture-destination'), { code: 'HISTORY_ARCHIVE_WRITE' })
            }
            proof.entries.push(options)
          } else if (method === 'write') {
            proof.writes.push({ id: options.id, size: atob(options.data).length })
          } else if (method === 'finish') {
            proof.finished.push(options.id)
          } else if (method === 'cancel') {
            proof.cancelled.push(options.id)
          }
          return {}
        },
      }
    })
  )

  await run('the conversation menu saves the latest committed branch, originals and its project only', async (page) => {
    const ids = { selected: 'menu-backup-selected', unrelated: 'menu-backup-unrelated' }
    const projects = await page.evaluate(async (ids) => {
      const a = window.__audit
      const project = await a.workspaces.createWorkspace('所选工程', [{ path: 'src/main.txt', text: 'selected project' }])
      const otherProject = await a.workspaces.createWorkspace('无关工程', [{ path: 'other.txt', text: 'unrelated project' }])
      const file = (id) => ({
        id, name: id + '.txt', serverId: null, mimeType: 'text/plain', size: 8, isImage: false,
      })
      const files = [file('selected-original'), file('missing-original')]
      const artifact = file('selected-artifact')
      const unrelated = file('unrelated-original')
      const selected = a.fixtures.session({
        id: ids.selected, title: '较旧的标题', mode: 'agent', workspaceId: project.id,
        rootMessageId: 'q',
        voiceRoles: [{
          id: 'voice-a', name: '合成角色', description: '沉稳', nature: '', aliases: [],
          importance: 'lead', source: 'user', createdAt: 1, voiceSample: { id: 'selected-voice', size: 48 },
        }],
        messages: [
          a.fixtures.user('q', '所选问题', { files, parentId: null, selectedChildId: 'a1' }),
          a.fixtures.assistant('a1', '旧窗口里的答复', { parentId: 'q' }),
          a.fixtures.assistant('a2', '另一条历史分支', {
            parentId: 'q', task: { plan: [], steps: [], artifacts: [artifact], workspaceId: project.id },
          }),
        ],
      })
      const other = a.fixtures.session({
        id: ids.unrelated, title: '无关对话', mode: 'agent', workspaceId: otherProject.id,
        messages: [a.fixtures.user('other-q', '无关内容保留', { files: [unrelated] })],
      })
      const persona = a.personas.addPersona('全局合成人设', '只用于检查全局配置')
      a.personas.setDefaultPersona(persona)
      a.settings.setApiKey('fixture-key-not-for-archive')
      await a.seed([selected, other], [
        { id: files[0].id, blob: new Blob(['original'], { type: 'text/plain' }) },
        { id: artifact.id, blob: new Blob(['artifact'], { type: 'text/plain' }) },
        { id: 'selected-voice', blob: new Blob([new Uint8Array(48).fill(17)], { type: 'audio/wav' }) },
        { id: unrelated.id, blob: new Blob(['separate'], { type: 'text/plain' }) },
      ])
      return { selected: project.id, unrelated: otherProject.id }
    }, ids)
    const stale = await page.context().newPage()
    try {
      await stale.goto(page.url())
      await stale.waitForFunction((id) => window.__audit?.store.useChatStore.getState().sessions.some((s) => s.id === id), ids.selected)
      await stale.evaluate((id) => window.__audit.store.selectSession(id), ids.selected)
      await stale.waitForFunction((id) => !!window.__audit?.store.useChatStore.getState().sessionCache[id], ids.selected)
      const staleTitle = () => stale.evaluate((id) => window.__audit.store.useChatStore.getState().sessionCache[id].title, ids.selected)
      assert.equal(await staleTitle(), '较旧的标题')
      await page.evaluate(async (id) => {
        const a = window.__audit
        const local = await a.db.loadSession(id)
        await a.db.saveSession({
          ...local, title: '已提交的新标题', updatedAt: Date.now() + 60_000,
          messages: local.messages.map((m) => m.id === 'a1'
            ? { ...m, blocks: [{ type: 'text', text: '已提交的新版答复' }] }
            : m),
        })
      }, ids.selected)
      assert.equal(await staleTitle(), '较旧的标题', 'the exporting window still has the stale record in its cache')
      const opener = stale.getByRole('button', { name: '打开边栏', exact: true })
      if (await opener.isVisible()) await opener.click()
      await stale.locator('[data-session-id="' + ids.selected + '"]:visible').getByRole('button', { name: '更多', exact: true }).click()
      if (process.env.FREESEEK_BACKUP_PREVIEWS) {
        await stale.getByRole('menuitem', { name: '备份此对话', exact: true }).waitFor()
        await stale.screenshot({ path: process.env.FREESEEK_BACKUP_PREVIEWS + '/single-chat-menu-zh.png' })
      }
      const [file] = await Promise.all([
        stale.waitForEvent('download'),
        stale.getByRole('menuitem', { name: '备份此对话', exact: true }).click(),
      ])
      await stale.getByRole('status').filter({ hasText: '已开始下载备份' }).filter({ hasText: '有 1 个附件原件未能读取' }).waitFor()
      if (process.env.FREESEEK_BACKUP_PREVIEWS) {
        await stale.screenshot({ path: process.env.FREESEEK_BACKUP_PREVIEWS + '/single-chat-partial-zh.png' })
      }
      assert.match(file.suggestedFilename(), /^freeseek-conversation-partial-backup-/)
      const bytes = await readFile(await file.path())
      const entries = unzipSync(bytes)
      const json = (path) => JSON.parse(Buffer.from(entries[path]).toString('utf8'))
      const manifest = json('manifest.json')
      assert.equal(manifest.freeseek_backup_version, 9)
      assert.deepEqual(manifest.sessions, [ids.selected])
      assert.deepEqual(manifest.workspaces, [projects.selected])
      assert.deepEqual(manifest.partial, { kind: 'unreadable', skippedSessions: 0, missingOriginals: 1 })
      assert.deepEqual(manifest.files.map(({ id }) => id), ['selected-original', 'selected-artifact', 'selected-voice'])
      assert.deepEqual(Object.keys(entries).sort(), [
        'manifest.json', 'freeseek/sessions/' + ids.selected + '.json',
        'freeseek/workspaces/' + projects.selected + '.json',
        'freeseek/files/selected-original.bin', 'freeseek/files/selected-artifact.bin', 'freeseek/files/selected-voice.bin',
      ].sort())
      for (const key of ['personas', 'defaultPersonaId', 'pricing', 'modelPrices']) assert.equal(Object.hasOwn(manifest, key), false)
      assert.equal(Buffer.from(entries['freeseek/files/selected-original.bin']).toString(), 'original')
      assert.equal(Buffer.from(entries['freeseek/files/selected-artifact.bin']).toString(), 'artifact')
      assert.deepEqual(Buffer.from(entries['freeseek/files/selected-voice.bin']), Buffer.alloc(48, 17))
      const saved = json('freeseek/sessions/' + ids.selected + '.json')
      assert.equal(saved.title, '已提交的新标题')
      assert.equal(saved.messages.find(({ id }) => id === 'a1').blocks[0].text, '已提交的新版答复')
      assert.equal(saved.messages.find(({ id }) => id === 'a2').blocks[0].text, '另一条历史分支')
      assert.equal(saved.messages.find(({ id }) => id === 'q').selectedChildId, 'a1')
      assert.equal(await staleTitle(), '较旧的标题')

      const before = await page.evaluate(async (ids) => {
        const a = window.__audit
        const local = await a.db.loadSession(ids.selected)
        await a.db.saveSession({ ...local, title: '导入时的本机版本', updatedAt: local.updatedAt + 500 })
        return {
          unrelated: await a.db.loadSession(ids.unrelated),
          persona: a.personas.usePersonas.getState().defaultId,
        }
      }, ids)
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('data'))
      const importFile = (buffer = bytes) => page.locator('input[type="file"][accept*="application/zip"]').setInputFiles({
        name: file.suggestedFilename(), mimeType: 'application/zip', buffer,
      })
      const review = page.getByRole('dialog', { name: '选择保留哪一份', exact: true })
      const done = page.getByRole('dialog', { name: '导入完成', exact: true })
      for (const missingId of [undefined, 'selected-artifact', 'selected-voice']) {
        const damaged = {
          ...entries,
          'manifest.json': Buffer.from(JSON.stringify({
            ...manifest, files: manifest.files.filter(({ id }) => id !== missingId),
            partial: missingId ? manifest.partial : undefined,
          })),
        }
        if (missingId) delete damaged['freeseek/files/' + missingId + '.bin']
        await importFile(Buffer.from(zipSync(damaged)))
        await page.getByRole('button', { name: '开始导入', exact: true }).click()
        const failure = page.getByRole('dialog', { name: '导入失败', exact: true })
        await failure.getByRole('alert').getByText('文件内容不完整，无法导入', { exact: true }).waitFor()
        await failure.getByRole('button', { name: '关闭', exact: true }).last().click()
        assert.equal(await review.count(), 0)
        const preserved = await page.evaluate(async ({ id, missingId }) => {
          const a = window.__audit
          return { title: (await a.db.loadSession(id)).title, original: Boolean(await a.db.loadFile(missingId)) }
        }, { id: ids.selected, missingId: missingId ?? 'selected-original' })
        assert.deepEqual(preserved, { title: '导入时的本机版本', original: true })
      }
      for (const replace of [false, true]) {
        await importFile()
        await page.getByRole('button', { name: '开始导入', exact: true }).click()
        await review.getByText('此备份缺少 1 份附件原件。', { exact: true }).waitFor()
        if (!replace && process.env.FREESEEK_BACKUP_PREVIEWS) {
          await page.screenshot({ path: process.env.FREESEEK_BACKUP_PREVIEWS + '/single-chat-import-zh.png' })
        }
        assert.equal(await review.getByRole('radio', { name: /保留本机/ }).isChecked(), true)
        if (replace) await review.getByRole('radio', { name: /使用备份/ }).check()
        await review.getByRole('button', { name: '合并导入', exact: true }).click()
        await done.getByText('此备份缺少 1 份附件原件。', { exact: true }).waitFor()
        await done.getByRole('button', { name: /^(稍后|完成)$/ }).click()
        const result = await page.evaluate(async ({ ids, projects }) => {
          const a = window.__audit
          const selected = await a.db.loadSession(ids.selected)
          const original = selected.messages.find(({ id }) => id === 'q').files[0]
          const artifact = selected.messages.find(({ id }) => id === 'a2').task.artifacts[0]
          return {
            selected,
            original: await (await a.db.loadFile(original.id)).text(),
            artifact: await (await a.db.loadFile(artifact.id)).text(),
            voice: Array.from(new Uint8Array(await (await a.db.loadFile(selected.voiceRoles[0].voiceSample.id)).arrayBuffer())),
            linkedProject: (await a.workspaces.readWorkspace(selected.workspaceId)).files,
            unrelatedProject: (await a.workspaces.readWorkspace(projects.unrelated)).files,
            unrelated: await a.db.loadSession(ids.unrelated),
            persona: a.personas.usePersonas.getState().defaultId,
            key: a.settings.useSettings.getState().apiKey === 'fixture-key-not-for-archive',
          }
        }, { ids, projects })
        assert.equal(result.selected.title, replace ? '已提交的新标题' : '导入时的本机版本')
        assert.equal(result.original, 'original')
        assert.equal(result.artifact, 'artifact')
        assert.deepEqual(result.voice, Array(48).fill(17))
        assert.equal(result.linkedProject[0].text, 'selected project')
        assert.equal(result.unrelatedProject[0].text, 'unrelated project')
        assert.deepEqual(result.unrelated, before.unrelated)
        assert.equal(result.persona, before.persona)
        assert.equal(result.key, true)
      }
      const restoredToEmpty = await page.evaluate(async ({ encoded, id }) => {
        const a = window.__audit
        await a.backup.clearHistory()
        const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
        const result = await a.backup.importHistory(new File([bytes], 'one-chat.zip', { type: 'application/zip' }))
        return {
          added: result.added,
          ids: (await a.db.loadAllSessions()).map((session) => session.id),
          persona: a.personas.usePersonas.getState().defaultId,
          title: (await a.db.loadSession(id)).title,
        }
      }, { encoded: bytes.toString('base64'), id: ids.selected })
      assert.deepEqual(restoredToEmpty, { added: 1, ids: [ids.selected], persona: before.persona, title: '已提交的新标题' })
    } finally {
      await stale.close()
    }
  })

  await run('the English conversation menu reports a native save only after a picker retry succeeds', async (page) => {
    await page.evaluate(async () => {
      const a = window.__audit
      a.settings.setLocale('en-US')
      await a.seed([
        a.fixtures.session({ id: 'one-english-chat', title: 'One chat', messages: [a.fixtures.user('q', 'Save only this chat')] }),
      ])
    })
    const opener = page.getByRole('button', { name: 'Open sidebar', exact: true })
    if (await opener.isVisible()) await opener.click()
    const more = page.locator('[data-session-id="one-english-chat"]:visible').getByRole('button', { name: 'More', exact: true })
    const action = page.getByRole('menuitem', { name: 'Back up this chat', exact: true })
    const success = page.getByRole('status').filter({ hasText: 'Backup saved' })
    await more.click()
    await action.click()
    await page.waitForFunction(() => window.__singleNativeSave.creates === 1)
    await page.getByText('Preparing backup…', { exact: true }).waitFor({ state: 'hidden' })
    assert.equal(await success.count(), 0)
    await more.click()
    await action.click()
    await success.waitFor()
    if (process.env.FREESEEK_BACKUP_PREVIEWS) {
      await page.screenshot({ path: process.env.FREESEEK_BACKUP_PREVIEWS + '/single-chat-native-en.png' })
    }
    const proof = await page.evaluate(() => window.__singleNativeSave)
    assert.equal(proof.creates, 2)
    assert.equal(proof.finish, 1)
    assert.deepEqual(proof.entries, ['manifest.json', 'freeseek/sessions/one-english-chat.json'])
    assert.equal(await page.getByText('Backup download started', { exact: true }).count(), 0)
  }, (context) => context.addInitScript(() => {
    const proof = window.__singleNativeSave = { creates: 0, finish: 0, entries: [] }
    window.CapacitorCustomPlatform = { name: 'android' }
    window.Capacitor = {
      PluginHeaders: [{
        name: 'Backup', methods: ['create', 'beginArchiveEntry', 'write', 'finish', 'cancel'].map((name) => ({ name, rtype: 'promise' })),
      }],
      async nativePromise(plugin, method, options) {
        if (plugin !== 'Backup') return {}
        if (method === 'create') return ++proof.creates === 1 ? { cancelled: true } : { id: 'replay-save' }
        if (method === 'beginArchiveEntry') proof.entries.push(options.name)
        if (method === 'finish') proof.finish++
        return {}
      },
    }
  }))


  await run('a history backup saves an in-progress local reply without stopping the live stream', async (page) => {
    const id = 'backup-live-stream'
    await page.evaluate(async (id) => {
      const a = window.__audit
      a.settings.setApiKey('fixture-stream-during-backup')
      a.settings.setSearch(false)
      await a.seed([a.fixtures.session({ id, title: '流式备份', rootMessageId: null })])
      window.fetch = async () => {
        const encoder = new TextEncoder()
        const usage = { input_tokens: 8, output_tokens: 4 }
        return new Response(new ReadableStream({
          start(controller) {
            const emit = (event) => controller.enqueue(encoder.encode('data: ' + JSON.stringify(event) + '\n\n'))
            emit({ type: 'message_start', message: { usage } })
            emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
            emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正在生成的正文。' } })
            window.finishBackupProof = () => {
              emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '回复正常完成。' } })
              emit({ type: 'content_block_stop', index: 0 })
              emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage })
              emit({ type: 'message_stop' })
              controller.close()
            }
          },
        }), { headers: { 'content-type': 'text/event-stream' } })
      }
      a.drafts.setDraftText(id, '请测试正在生成时备份')
      a.store.sendMessage(id)
    }, id)
    await page.locator('.ds-assistant-message-main-content').getByText('正在生成的正文。', { exact: true }).waitFor()
    const result = await page.evaluate(async (id) => {
      const a = window.__audit
      const shownInDatabase = (await a.db.loadSession(id)).messages.at(-1).blocks
      const { blob } = await a.backup.exportHistory()
      const stillStreaming = Boolean(a.store.useChatStore.getState().streaming[id])
      window.finishBackupProof()
      await a.waitIdle()
      const final = (await a.db.loadSession(id)).messages.at(-1)
      return { bytes: Array.from(new Uint8Array(await blob.arrayBuffer())), shownInDatabase, stillStreaming, final }
    }, id)
    const entries = unzipSync(Buffer.from(result.bytes))
    const saved = JSON.parse(Buffer.from(entries['freeseek/sessions/' + id + '.json']).toString('utf8'))
    assert.doesNotMatch(JSON.stringify(result.shownInDatabase), /正在生成的正文。/)
    assert.equal(saved.messages.at(-1).status, 'stopped')
    assert.equal(saved.messages.at(-1).blocks.at(-1).text, '正在生成的正文。')
    assert.equal(result.stillStreaming, true)
    assert.equal(result.final.status, 'done')
    assert.equal(result.final.blocks[0].text, '正在生成的正文。回复正常完成。')
  })


  await run('a stale second window cannot erase a saved turn or resurrect a deleted conversation', async (page) => {
    const id = 'concurrent-history'
    await page.evaluate(async (id) => {
      const a = window.__audit
      const file = { id: 'window-only-file', serverId: 'file-api-already-ready', name: 'test.txt', size: 1, isImage: false, mimeType: 'text/plain' }
      await a.seed([a.fixtures.session({id, title: '两个窗口', messages: [
        a.fixtures.user('shared-first', '旧问题', { files: [file] }),
        a.fixtures.assistant('shared-answer', '旧回复'),
      ]})], [{ id: file.id, blob: new Blob(['X']) }])
    }, id)
    const second = await page.context().newPage()
    await second.goto(page.url())
    await second.waitForFunction((id) => window.__audit?.store.useChatStore.getState().sessions.some(s => s.id === id), id)
    await second.evaluate((id) => window.__audit.store.selectSession(id), id)
    await second.waitForFunction((id) => !!window.__audit.store.useChatStore.getState().sessionCache[id], id)
    await page.evaluate(async (id) => {
      const a = window.__audit
      a.settings.setApiKey('synthetic-concurrent-history')
      a.settings.setSearch(false)
      window.fetch = async () => a.response('先写入的完整答复。')
      a.drafts.setDraftText(id, '这个窗口新增一轮')
      a.store.sendMessage(id)
      await a.waitIdle()
    }, id)
    assert.equal(await page.evaluate(async (id) => (await window.__audit.db.loadSession(id)).messages.length, id), 4)
    await second.evaluate(async (id) => window.__audit.store.setSessionPinned(id, true), id)
    const saved = await page.evaluate(async (id) => (await window.__audit.db.loadSession(id)).messages, id)
    assert.equal(saved.length, 4, 'pinning a stale copy must preserve the latest saved reply')
    await page.evaluate(async (id) => window.__audit.store.removeSession(id), id)
    await second.evaluate(async (id) => window.__audit.store.setSessionPinned(id, false), id)
    assert.equal(await page.evaluate(async (id) => !!(await window.__audit.db.loadSession(id)), id), false)
    await second.getByRole('button', { name: '另存为新对话' }).click()
    await second.getByText(/本机缺少 1 个原件/).waitFor()
    await second.waitForFunction((id) => {
      const state = window.__audit.store.useChatStore.getState()
      return state.activeId && state.activeId !== id && Object.keys(state.sessionSaveErrors).length === 0
    }, id)
    const copies = await page.evaluate(async () => (await window.__audit.db.loadAllSessions()).map(x => x.title))
    assert.deepEqual(copies, ['两个窗口（本窗口副本）'])
  })
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
      await page.getByRole('main').getByText(/本次读取本机存储时未找到任何会话/).waitFor()
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
      await sidebar.getByText(/本次读取本机存储时未找到任何会话/).waitFor({ timeout: 3000 })
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
      await sidebar.getByText(/本次读取本机存储时未找到任何会话/).waitFor()
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
      assert.equal(await sidebar.getByText(/本次读取本机存储时未找到任何会话/).count(), 0)
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
      assert.equal(state.incident.historyReason, 'selection-uncertain')
      await page.getByRole('main').getByText(/暂时无法确认哪一份是已保存的聊天记录/).waitFor()
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
      const main = page.getByRole('main')
      await main.getByText(/本次读取本机存储时未找到任何会话/).waitFor()
      const incident = await page.evaluate(async () => {
        const { events } = await window.__audit.diagnostics.readDiagnosticLogs()
        return events.find(({ event }) => event === 'history.unexpected-empty')?.details
      })
      assert.equal(incident.historyReason, 'empty-after-known-history')
      assert.equal(incident.activeCount, 0)
      assert.equal(incident.alternateCount, 0)
      assert.equal(incident.indexCount, 0)
      await page.getByRole('button', { name: '打开备份设置', exact: true }).waitFor()
      await page.evaluate(() => window.__audit.settings.setLocale('en-US'))
      await main.getByText(/No saved chats were found in local storage this time/).waitFor()
      await main.getByRole('button', { name: 'Open backup settings', exact: true }).waitFor()
      await page.evaluate(() => window.__audit.settings.setLocale('zh-CN'))
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
      assert.equal(await page.getByText(/本次读取本机存储时未找到任何会话/).count(), 0)
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
      await page.getByRole('status').filter({ hasText: '已开始下载备份' }).waitFor()
      assert.equal(await page.getByText('备份已保存', { exact: true }).count(), 0)
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
    'a verified deletion supersedes older history evidence but never a new or undated chat',
    async (page) => {
      const outcomes = await page.evaluate(async () => {
        const { db, historyCheckpoint } = window.__audit
        const probe = async (localCount, localTime, nativeCount, nativeTime) => {
          localStorage.setItem('freeseek:history-had-conversations', localCount ? '1' : '0')
          localStorage.removeItem('freeseek:history-count')
          localStorage.removeItem('freeseek:history-verified')
          if (localTime) {
            localStorage.setItem('freeseek:history-verified', JSON.stringify({
              sessionCount: localCount, verifiedAt: localTime,
            }))
          }
          historyCheckpoint.historyCheckpointReader.read = async () => ({
            present: nativeCount > 0, sessionCount: nativeCount, verifiedAt: nativeTime,
          })
          try {
            await db.loadSessionSummaries({ previousSelection: true })
            return 'empty-home'
          } catch (error) {
            return error.reason
          }
        }
        return [
          await probe(2, 100, 0, 200),
          await probe(0, 200, 2, 100),
          await probe(2, 300, 0, 200),
          await probe(1, undefined, 0, 200),
          await probe(2, 200, 0, 200),
        ]
      })
      assert.deepEqual(outcomes, [
        'empty-home', 'empty-home', 'empty-after-known-history',
        'empty-after-known-history', 'empty-after-known-history',
      ])
    },
    (context) => context.addInitScript(() => {
      window.CapacitorCustomPlatform = { name: 'android' }
    })
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
        return logs.events.find(({ event }) => event === 'history.checkpoint-read-timed-out')?.details
      })
      assert.equal(logged.historyReason, 'checkpoint-timeout')
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
