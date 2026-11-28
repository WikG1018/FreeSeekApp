import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const chunkSize = 256 * 1024
const mime = 'application/octet-stream'
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const rejected = (code) => Object.assign(new Error(`Synthetic native fault ${code}`), { code })
const fileRoute = '/__history-vault-test/'
const methods = {
  HistoryVault: [
    'status', 'begin', 'putSession', 'putOriginal', 'append', 'finishEntry',
    'prepare', 'commit', 'cancel', 'deleteSession', 'listSessions', 'listOriginals',
    'readSession', 'restoreOriginal',
  ],
  HistoryFiles: ['begin', 'append', 'finish', 'locate', 'prune', 'remove'],
  Diagnostics: ['checkHistory', 'retainClientEvents'],
}

// Keep the simulated native state outside the page, just as it survives WebView loss on Android.
class VaultFixture {
  sessions = new Map()
  originals = new Map()
  disk = new Map()
  diskWrites = new Map()
  diskFaults = new Map()
  generation = 0
  sequence = 0
  calls = []
  faults = new Map()

  async install(context) {
    await context.exposeBinding('__vaultTestCall', async (_, plugin, method, args = {}) => {
      try {
        return { value: await this.invoke(plugin, method, args) }
      } catch (error) {
        return { error: { code: error.code, message: error.message } }
      }
    })
    await context.addInitScript((methods) => {
      window.CapacitorCustomPlatform = { name: 'android' }
      window.Capacitor = {
        PluginHeaders: Object.entries(methods).map(([name, members]) => ({
          name,
          methods: members.map((name) => ({ name, rtype: 'promise' })),
        })),
        nativePromise: async (plugin, method, args) => {
          const result = await window.__vaultTestCall(plugin, method, args)
          if (result.error) throw Object.assign(new Error(result.error.message), result.error)
          return result.value
        },
      }
    }, methods)
    await context.route(`**${fileRoute}*`, async (route) => {
      const key = decodeURIComponent(new URL(route.request().url()).pathname.slice(fileRoute.length))
      const bytes = this.disk.get(key)
      await route.fulfill(bytes ? { body: bytes, contentType: mime } : { status: 404 })
    })
  }

  async invoke(plugin, method, args) {
    if (plugin === 'Diagnostics') return { present: false }
    if (plugin === 'HistoryFiles') {
      if (method === 'begin') {
        this.diskWrites.set(args.key, { size: args.size, chunks: [] })
        return {}
      }
      if (method === 'append') {
        this.diskWrites.get(args.key).chunks.push(Buffer.from(args.data, 'base64'))
        return {}
      }
      if (method === 'finish') {
        const { size, chunks } = this.diskWrites.get(args.key)
        const bytes = Buffer.concat(chunks)
        assert.equal(bytes.length, size)
        this.disk.set(args.key, bytes)
        this.diskWrites.delete(args.key)
        return {}
      }
      if (method === 'locate') {
        if (this.diskFaults.has(args.key)) throw rejected(this.diskFaults.get(args.key))
        if (this.disk.get(args.key)?.length !== args.size) throw rejected('MISSING_ORIGINAL')
        return { path: fileRoute + encodeURIComponent(args.key) }
      }
      const keys = method === 'prune'
        ? [...this.disk.keys()].filter((key) => !args.keep.includes(key))
        : args.keys
      for (const key of keys) this.disk.delete(key)
      return {}
    }

    const chunk = method === 'append' ? Buffer.from(args.data, 'base64') : undefined
    this.calls.push({ method, args: chunk ? {
      id: args.id, bytes: chunk.length, entryId: this.batch?.entry?.row.id,
    } : args })
    if (this.faults.has(method)) throw rejected(this.faults.get(method))
    if (method === 'status') {
      const status = this.status()
      await this.waitOnPause(method)
      return status
    }
    if ('generation' in args && args.generation !== this.generation) throw rejected('CHANGED')
    if (method === 'begin') {
      if (this.batch) throw rejected('BUSY')
      this.batch = {
        id: `batch-${++this.sequence}`, sessions: new Map(), originals: new Map(),
        deleted: [], replace: args.mode === 'replace',
      }
      return { id: this.batch.id }
    }
    if (method === 'listSessions' || method === 'listOriginals') {
      const source = method === 'listSessions' ? this.sessions : this.originals
      const keys = [...source.keys()].sort().filter((id) => args.after === undefined || id > args.after)
      return {
        items: keys.slice(0, 1).map((id) => this.describe(source.get(id))),
        ...(keys.length > 1 && { next: keys[0] }),
      }
    }
    if (method === 'readSession') {
      const bytes = this.checked(this.sessions.get(args.sessionId))
      assert(args.limit <= chunkSize)
      const part = bytes.subarray(args.offset, args.offset + args.limit)
      const nextOffset = args.offset + part.length
      return { data: part.toString('base64'), nextOffset, eof: nextOffset === bytes.length }
    }
    if (method === 'restoreOriginal') {
      assert(!this.disk.has(args.key), 'restore requires a fresh disk key')
      const row = this.originals.get(args.fileId)
      this.disk.set(args.key, Buffer.from(this.checked(row)))
      return { ...this.describe(row), key: args.key }
    }
    const batch = this.batch
    assert(batch && batch.id === args.id, `Unknown fixture batch for ${method}`)
    if (method === 'cancel') {
      this.batch = undefined
      return {}
    }
    if (method === 'prepare') {
      assert(!batch.entry)
      batch.prepared = true
      await this.waitOnPause(method)
      return {}
    }
    if (method === 'commit') {
      assert(!batch.entry)
      const sessions = batch.replace ? new Map() : new Map(this.sessions)
      for (const id of batch.deleted) sessions.delete(id)
      for (const [id, entry] of batch.sessions) sessions.set(id, entry)
      const originals = new Map()
      for (const entry of sessions.values()) {
        for (const id of entry.originalIds) {
          const original = batch.originals.get(id) ?? this.originals.get(id)
          assert(original && (!batch.replace || batch.originals.has(id)), `Unstaged original ${id}`)
          originals.set(id, original)
        }
      }
      this.sessions = sessions
      this.originals = originals
      this.generation++
      this.batch = undefined
      return this.status()
    }
    assert(!batch.prepared, `Cannot change a prepared batch through ${method}`)
    if (method === 'deleteSession') batch.deleted.push(args.sessionId)
    if (method === 'putSession') {
      assert(!batch.entry)
      const { sessionId: id, size, revision, originalIds, missingIds } = args
      batch.entry = { row: { id, size, revision, originalIds, missingIds }, chunks: [], to: batch.sessions }
    }
    if (method === 'putOriginal') {
      assert(!batch.entry)
      const { fileId: id, size, type, diskKey, sourceRevision, verifyExisting, sha256 } = args
      const previous = batch.originals.get(id) ?? this.originals.get(id)
      const sameRevision = sourceRevision && previous?.sourceRevision === sourceRevision
      let expected = sha256
      if (sameRevision) {
        if (previous.size !== size || (sha256 && sha256 !== previous.sha256)) throw rejected('CHANGED')
        expected = previous.sha256
      }
      if (sameRevision && previous.type === type && (!verifyExisting || digest(previous.bytes) === expected)) {
        batch.originals.set(id, previous)
        return { needsAppend: false }
      }
      const row = { id, size, type, sourceRevision }
      if (diskKey) {
        const bytes = this.disk.get(diskKey)
        if (bytes?.length !== size) throw rejected('UNREADABLE')
        this.write(batch.originals, row, bytes, expected)
        return { needsAppend: false }
      }
      if (expected && previous?.sha256 === expected && previous.size === size && digest(previous.bytes) === expected) {
        batch.originals.set(id, { ...previous, sourceRevision })
        return { needsAppend: false }
      }
      batch.entry = { row, chunks: [], to: batch.originals, expected }
      return { needsAppend: true }
    }
    if (method === 'append') {
      assert(chunk.length > 0 && chunk.length <= chunkSize)
      batch.entry.chunks.push(chunk)
    }
    if (method === 'finishEntry') {
      const { row, chunks, to, expected } = batch.entry
      batch.entry = undefined
      return this.write(to, row, Buffer.concat(chunks), expected)
    }
    return {}
  }

  write(to, row, bytes, expected) {
    assert.equal(bytes.length, row.size, `fixture size ${row.id}`)
    const sha256 = digest(bytes)
    if (expected && expected !== sha256) throw rejected('UNREADABLE')
    to.set(row.id, { ...row, bytes: Buffer.from(bytes), sha256 })
    return { sha256 }
  }

  describe({ bytes: _, ...row }) {
    return row
  }

  checked(row) {
    if (!row || row.bytes.length !== row.size || digest(row.bytes) !== row.sha256) {
      throw rejected('UNREADABLE')
    }
    return row.bytes
  }

  status() {
    const records = [...this.sessions.values(), ...this.originals.values()]
    return {
      generation: this.generation,
      sessionCount: this.sessions.size,
      originalCount: this.originals.size,
      missingOriginalCount: [...this.sessions.values()].reduce((sum, row) => sum + row.missingIds.length, 0),
      bytes: records.reduce((sum, row) => sum + row.size, 0),
      ...(this.batch?.prepared && { pendingId: this.batch.id }),
    }
  }

  pauseNext(method) {
    let entered, release
    const deadline = AbortSignal.timeout(10000)
    const reached = new Promise((resolve, reject) => {
      entered = resolve
      deadline.addEventListener('abort', () => reject(deadline.reason), { once: true })
    })
    const wait = new Promise((resolve) => { release = resolve })
    this.pause = { method, entered, wait }
    return { reached, release }
  }

  async waitOnPause(method) {
    const gate = this.pause
    if (gate?.method === method) {
      this.pause = undefined
      gate.entered()
      await gate.wait
    }
  }
}

const body = (fixture, id) => JSON.parse(fixture.sessions.get(id).bytes.toString()).messages[0].content
const nativeApp = (run, description, test) => {
  const fixture = new VaultFixture()
  return run(`history vault service ${description}`, async (page) => {
    await page.evaluate(() => window.__audit.historyVault.protectAllHistory(false))
    await test(page, fixture)
  }, (context) => fixture.install(context))
}

const localState = (page) => page.evaluate(async () => {
  const { db } = window.__audit
  const rows = await db.vaultSessionIndex()
  return Object.fromEntries(await Promise.all(rows.map(async ({ id }) => [
    id, (await db.loadSession(id)).messages[0].content,
  ])))
})

const saveChats = (page, values) => page.evaluate(async (values) => {
  const { db, fixtures } = window.__audit
  for (const [id, text] of Object.entries(values)) {
    await db.saveSession(fixtures.session({ id, messages: [fixtures.user('u', text)] }))
  }
}, values)

const inspectAfterReload = async (page) => {
  await page.reload()
  await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
  await page.evaluate(() => window.__audit.historyVault.refreshHistoryVault())
}

const losePrimaryHistory = (page, confirmedEmpty = false) => page.evaluate(async (confirmedEmpty) => {
  const opening = indexedDB.open('freeseek')
  const primary = await new Promise((resolve, reject) => {
    opening.onsuccess = () => resolve(opening.result)
    opening.onerror = () => reject(opening.error)
  })
  const names = ['sessions', 'sessionsStaging', 'sessionSummaries', 'files', 'filesStaging', 'historyState']
  const tx = primary.transaction(names, 'readwrite')
  for (const name of names) tx.objectStore(name).clear()
  if (confirmedEmpty) tx.objectStore('historyState').put(true, 'confirmedEmpty')
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
  primary.close()
}, confirmedEmpty)

const digestLocalOriginal = (page, fileId) => page.evaluate(async (fileId) => {
  const original = await window.__audit.db.loadFile(fileId)
  if (!original) return null
  const hash = await crypto.subtle.digest('SHA-256', await original.arrayBuffer())
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}, fileId)

const removePrimaryOriginalRecord = (page, fileId) => page.evaluate((fileId) => new Promise((resolve, reject) => {
  const request = indexedDB.open('freeseek')
  request.onerror = () => reject(request.error)
  request.onsuccess = () => {
    const database = request.result
    const tx = database.transaction(['files', 'filesStaging'], 'readwrite')
    for (const name of tx.objectStoreNames) tx.objectStore(name).delete(fileId)
    tx.oncomplete = () => {
      database.close()
      resolve()
    }
    tx.onabort = () => {
      database.close()
      reject(tx.error)
    }
  }
}), fileId)

export const runHistoryVaultCases = async (run) => {
  await nativeApp(run, 'reconciles a restart on both sides of a single delete receipt', async (page, vault) => {
    await saveChats(page, { targeted: '已确认删除的会话', retained: '另一个会话' })
    const before = vault.generation
    const gate = vault.pauseNext('prepare')
    const interrupted = page.evaluate(() => window.__audit.db.deleteSession('targeted')).catch(() => {})
    try {
      await gate.reached
      assert(vault.status().pendingId)
      assert.equal(body(vault, 'targeted'), '已确认删除的会话')
      await inspectAfterReload(page)
    } finally {
      gate.release()
      await interrupted
    }
    assert.deepEqual(await localState(page), { retained: '另一个会话', targeted: '已确认删除的会话' })
    assert.equal(vault.generation, before, 'uncommitted main store cancels prepared deletion')
    assert.equal(vault.status().pendingId, undefined)

    vault.faults.set('commit', 'IO')
    await page.evaluate(() => window.__audit.db.deleteSession('targeted'))
    const pending = vault.status().pendingId
    assert(pending)
    assert.equal(body(vault, 'targeted'), '已确认删除的会话', 'old copy is visible before reconciliation')
    assert.deepEqual(await localState(page), { retained: '另一个会话' })
    assert.equal(await page.evaluate(async () => (await window.__audit.db.vaultCommitProof()).id), pending)
    vault.faults.delete('commit')
    await inspectAfterReload(page)
    assert.deepEqual(await localState(page), { retained: '另一个会话' })
    assert.deepEqual([...vault.sessions.keys()], ['retained'])
    assert.equal(vault.status().pendingId, undefined)
  })

  await nativeApp(run, 'honors a confirmed clear after loss of the whole WebView database', async (page, vault) => {
    await saveChats(page, { first: '正文一', second: '正文二' })
    vault.faults.set('prepare', 'NO_SPACE')
    const clear = () => page.evaluate(async () => {
      try {
        await window.__audit.backup.clearHistory()
        return 'resolved'
      } catch (error) {
        return error.key
      }
    })
    assert.equal(await clear(), 'backupProtectionNoSpace')
    assert.deepEqual(await localState(page), { first: '正文一', second: '正文二' })
    assert.equal(vault.sessions.size, 2)
    assert.equal(vault.status().pendingId, undefined)

    vault.faults.delete('prepare')
    vault.faults.set('commit', 'IO')
    assert.equal(await clear(), 'resolved')
    assert.deepEqual(await localState(page), {})
    assert.equal(vault.sessions.size, 2)
    assert(vault.status().pendingId)

    const url = page.url()
    const fresh = await page.context().browser().newContext()
    try {
      await fresh.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1'
        ? route.continue()
        : route.fulfill({ status: 503, body: '{}' }))
      await vault.install(fresh)
      await page.close()
      vault.faults.delete('commit')
      const restarted = await fresh.newPage()
      await restarted.goto(url)
      await restarted.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      assert.deepEqual(await localState(restarted), {})
      assert.equal(vault.sessions.size, 0)
      assert.equal(vault.originals.size, 0)
      assert.equal(vault.status().pendingId, undefined)
    } finally {
      await fresh.close()
    }
  })

  await nativeApp(run, 'allows deleting the remaining on-device copy after the user skips recovery', async (page, vault) => {
    await page.evaluate(async () => {
      const { db, fixtures } = window.__audit
      const blob = new Blob(['可删除的测试原件'])
      const id = 'remaining-original'
      await db.saveSession(fixtures.session({ id: 'remaining-chat', messages: [fixtures.user('u', '测试', {
        files: [{ id, name: '测试.txt', size: blob.size, mimeType: 'text/plain', isImage: false }],
      })] }), [{ id, blob }])
    })
    await losePrimaryHistory(page)
    vault.faults.set('readSession', 'UNREADABLE')
    await page.reload()
    await page.getByRole('alert').getByText(/没能从备份找回聊天/).waitFor()
    await page.getByRole('main').getByRole('button', { name: '暂不恢复，进入首页', exact: true }).click()
    await page.getByTestId('chat-composer').waitFor()
    await page.evaluate(() => window.__audit.settingsDialog.openSettings('data'))
    const remove = page.getByRole('button', { name: '删除所有对话', exact: true })
    const confirm = page.getByRole('dialog', { name: '删除后，所有对话都将被清空且无法找回', exact: true })
    await remove.click({ timeout: 4000 })
    await confirm.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(vault.sessions.size, 1)
    assert.equal(vault.originals.size, 1)
    await remove.click()
    await confirm.getByRole('button', { name: '删除所有对话', exact: true }).click()
    await confirm.waitFor({ state: 'hidden' })
    await remove.waitFor({ state: 'hidden' })
    assert.equal(vault.sessions.size, 0)
    assert.equal(vault.originals.size, 0)
    assert.equal(vault.calls.some((call) => call.method === 'restoreOriginal'), false)
  })

  await nativeApp(run, 'automatically restores both message text and original bytes after primary history disappears', async (page, vault) => {
    const fileId = 'auto-recovery-original'
    const originalText = '这份附件要逐字找回来。'
    await page.evaluate(async ({ fileId, originalText }) => {
      const { db, fixtures } = window.__audit
      const blob = new Blob([originalText], { type: 'text/plain' })
      await db.saveSession(fixtures.session({
        id: 'auto-recovery-chat', pinned: true, title: '自动找回的对话',
        messages: [fixtures.user('u', '这段正文也要找回来。', {
          files: [{ id: fileId, name: '原件.txt', size: blob.size, mimeType: blob.type, isImage: false }],
        })],
      }), [{ id: fileId, blob }])
    }, { fileId, originalText })
    assert.equal(vault.originals.get(fileId).sha256, digest(Buffer.from(originalText)))
    await losePrimaryHistory(page)
    await inspectAfterReload(page)
    assert.deepEqual(await localState(page), { 'auto-recovery-chat': '这段正文也要找回来。' })
    assert.equal(await digestLocalOriginal(page, fileId), digest(Buffer.from(originalText)))
    assert.equal(await page.evaluate(async () => (await window.__audit.db.loadSession('auto-recovery-chat')).pinned), true)
    assert.equal(vault.calls.filter(({ method }) => method === 'restoreOriginal').length, 1)
    await inspectAfterReload(page)
    assert.equal(vault.calls.filter(({ method }) => method === 'restoreOriginal').length, 1)
  })

  await nativeApp(run, 'honors a confirmed empty marker even with an older on-device copy still present', async (page, vault) => {
    await saveChats(page, { former: '用户删除前的正文' })
    assert.equal(vault.sessions.size, 1)
    await losePrimaryHistory(page, true)
    await inspectAfterReload(page)
    assert.deepEqual(await localState(page), {})
    assert.equal(vault.calls.some(({ method }) => method === 'readSession' || method === 'restoreOriginal'), false)
  })

  await nativeApp(run, 'keeps a conversation branch and its attachment after source deletion and device recovery', async (page, vault) => {
    const sourceId = 'branch-vault-source'
    const fileId = 'branch-vault-file'
    const text = '分支独立保存后的附件。'
    await page.evaluate(async ({ sourceId, fileId, text }) => {
      const { db, fixtures } = window.__audit
      const blob = new Blob([text], { type: 'text/plain' })
      const file = { id: fileId, name: '清单.txt', mimeType: blob.type, size: blob.size, serverId: null, isImage: false }
      await db.saveSession(fixtures.session({
        id: sourceId, title: '整理清单',
        messages: [
          fixtures.user('u', '看看清单', { files: [file] }),
          fixtures.assistant('ready-to-branch', '我已经看完清单。'),
        ],
      }), [{ id: fileId, blob }])
    }, { sourceId, fileId, text })
    await inspectAfterReload(page)
    await page.evaluate((id) => window.__audit.store.selectSession(id), sourceId)
    await page.getByRole('button', { name: '从这条回复开分支', exact: true }).click()
    await page.getByTestId('chat-header').getByText('分支 · 看看清单', { exact: true }).waitFor()
    const branchId = await page.evaluate(() => window.__audit.store.useChatStore.getState().activeId)
    assert.equal(vault.sessions.size, 2)
    assert.equal(vault.originals.size, 1)
    assert.equal(await page.evaluate((id) => window.__audit.store.removeSession(id), sourceId), true)
    assert.deepEqual([...vault.sessions.keys()], [branchId])
    assert.equal(vault.originals.get(fileId).sha256, digest(Buffer.from(text)))
    await losePrimaryHistory(page)
    await inspectAfterReload(page)
    assert.deepEqual(await localState(page), { [branchId]: '看看清单' })
    assert.equal(await digestLocalOriginal(page, fileId), digest(Buffer.from(text)))
    assert.deepEqual(
      await page.evaluate(async (id) => (await window.__audit.db.loadSession(id)).branchFrom, branchId),
      { sessionId: sourceId, messageId: 'ready-to-branch' }
    )
  })

  await nativeApp(run, 'commits ZIP conflict choices and disk-backed originals across a retry', async (page, vault) => {
    await saveChats(page, { duplicate: '本机旧正文', unaffected: '无关会话' })
    const reduceImport = (choice) => page.evaluate(async (choice) => {
      const { backup, writeArchive, fixtures } = window.__audit
      const chat = (id, text) => fixtures.session({ id, messages: [fixtures.user('u', text)] })
      const records = [chat('duplicate', '选用 ZIP 正文'), chat('new-chat', '新增 ZIP 会话')]
      const json = (name, value) => ({ name, blob: new Blob([JSON.stringify(value)]) })
      const archive = await writeArchive([
        json('manifest.json', {
          freeseek_backup_version: 2, sessions: records.map(({ id }) => id), files: [],
          personas: [], defaultPersonaId: 'builtin-default',
        }),
        ...records.map((record) => json(`freeseek/sessions/${record.id}.json`, record)),
      ])
      let conflicts
      try {
        const result = await backup.importHistory(new File([archive], 'synthetic.zip'), undefined, (preview) => {
          conflicts = preview.conflicts.map(({ local }) => local.id)
          return Promise.resolve(choice ? new Set(conflicts) : null)
        })
        return { result, conflicts }
      } catch (error) {
        return { error: error.key, conflicts }
      }
    }, choice)
    assert.deepEqual(await reduceImport(false), { result: null, conflicts: ['duplicate'] })
    const original = { duplicate: '本机旧正文', unaffected: '无关会话' }
    assert.deepEqual(await localState(page), original)
    vault.faults.set('prepare', 'NO_SPACE')
    assert.deepEqual(await reduceImport(true), { error: 'backupProtectionNoSpace', conflicts: ['duplicate'] })
    assert.deepEqual(await localState(page), original)
    assert.equal(body(vault, 'duplicate'), original.duplicate)
    assert.equal(vault.sessions.has('new-chat'), false)

    vault.faults.delete('prepare')
    vault.faults.set('commit', 'BUSY')
    const accepted = await reduceImport(true)
    assert.equal(accepted.result.added, 1)
    assert.equal(accepted.result.replaced, 1)
    assert.deepEqual(await localState(page), {
      duplicate: '选用 ZIP 正文', 'new-chat': '新增 ZIP 会话', unaffected: '无关会话',
    })
    assert(vault.status().pendingId)
    assert.equal(body(vault, 'duplicate'), original.duplicate)
    vault.faults.delete('commit')
    await inspectAfterReload(page)
    assert.equal(body(vault, 'duplicate'), '选用 ZIP 正文')
    assert.equal(body(vault, 'new-chat'), '新增 ZIP 会话')
    assert.equal(body(vault, 'unaffected'), '无关会话')

    const diskBytes = Buffer.from('由原生文件直接复制📎')
    const diskKey = await page.evaluate(async ({ base64, mime }) => {
      const { db, store, stageArchiveFile, fixtures } = window.__audit
      const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))
      await store.mergeHistory(async () => {
        const file = { id: 'disk-only', name: '原件.bin', size: bytes.length, mimeType: mime, isImage: false }
        await db.addStagingSession(fixtures.session({
          id: 'disk-chat', messages: [fixtures.user('u', '带磁盘原件', { files: [file] })],
        }))
        await stageArchiveFile({ path: 'original.bin', size: bytes.length, stream: (async function* () {
          yield bytes.subarray(0, 7)
          yield bytes.subarray(7)
        })() }, file.id, mime, () => {}, true)
      }, async () => new Set(), async () => {})
      return (await db.loadDiskOriginalRef('disk-only')).key
    }, { base64: diskBytes.toString('base64'), mime })
    assert.equal(vault.originals.get('disk-only').sha256, digest(diskBytes))
    assert.equal(await digestLocalOriginal(page, 'disk-only'), digest(diskBytes))
    assert(vault.calls.some(({ method, args }) => method === 'putOriginal' && args.diskKey === diskKey))
    assert(!vault.calls.some(({ method, args }) => method === 'append' && args.entryId === 'disk-only'))

    vault.originals.get('disk-only').bytes[0] ^= 1
    vault.disk.get(diskKey)[0] ^= 1
    const beforeDamage = vault.originals.get('disk-only').sha256
    const verify = () => page.evaluate(() => window.__audit.historyVault.protectAllHistory(true))
    const [, verified] = await page.evaluate(() => Promise.all([
      window.__audit.historyVault.protectAllHistory(false),
      window.__audit.historyVault.protectAllHistory(true),
    ]))
    assert.equal(verified, false, 'a simultaneous automatic scan cannot mark two damaged copies as verified')
    assert.equal(vault.originals.get('disk-only').sha256, beforeDamage)
    assert.equal(body(vault, 'disk-chat'), '带磁盘原件')
    vault.disk.set(diskKey, Buffer.from(diskBytes))
    assert.equal(await verify(), true)
    assert.equal(digest(vault.originals.get('disk-only').bytes), beforeDamage)
  })

  await nativeApp(run, 'verifies originals on demand and repairs originals with no missing conversation', async (page, vault) => {
    const size = chunkSize * 2 + 31
    const fileId = 'manual-original'
    const expected = digest(Buffer.from(Uint8Array.from({ length: size }, (_, i) => (i * 17 + 123) & 255)))
    await page.evaluate(async ({ size, fileId, mime }) => {
      const { db, fixtures } = window.__audit
      const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 17 + 123) & 255)
      const file = { id: fileId, name: '原件.bin', size, mimeType: mime, isImage: false }
      await db.saveSession(fixtures.session({
        id: 'manual-chat', messages: [fixtures.user('u', '始终保留的正文', { files: [file] })],
      }), [{ id: fileId, blob: new Blob([bytes], { type: mime }) }])
    }, { size, fileId, mime })
    const chunks = () => vault.calls.filter(({ method, args }) => method === 'append' && args.entryId === fileId)
      .map(({ args }) => args.bytes)
    assert.deepEqual(chunks(), [chunkSize, chunkSize, 31])
    assert.equal(vault.originals.get(fileId).sha256, expected)
    const revision = vault.originals.get(fileId).sourceRevision

    await page.evaluate(() => window.__audit.db.renameSession('manual-chat', '原件不变'))
    assert.deepEqual(chunks(), [chunkSize, chunkSize, 31], 'normal save reuses the immutable original')
    vault.originals.get(fileId).bytes[0] ^= 1
    assert.notEqual(digest(vault.originals.get(fileId).bytes), expected)
    assert.equal(await page.evaluate(() => window.__audit.historyVault.protectAllHistory(true)), true)
    assert(vault.calls.some(({ method, args }) => method === 'putOriginal' && args.fileId === fileId && args.verifyExisting))
    assert.equal(vault.originals.get(fileId).sourceRevision, revision)
    assert.equal(digest(vault.originals.get(fileId).bytes), expected)
    assert.deepEqual(chunks(), [chunkSize, chunkSize, 31, chunkSize, chunkSize, 31])

    const restore = () => page.evaluate(() => window.__audit.historyVault.restoreHistoryVault())
    await removePrimaryOriginalRecord(page, fileId)
    assert.equal(await digestLocalOriginal(page, fileId), null)
    assert.equal(await page.evaluate(() => window.__audit.historyVault.protectAllHistory(true)), true)
    assert.deepEqual(chunks(), [chunkSize, chunkSize, 31, chunkSize, chunkSize, 31], 'the native-only original needs no retransmission')
    vault.originals.get(fileId).bytes[0] ^= 1
    const beforeFailedCheck = vault.generation
    assert.equal(await page.evaluate(() => window.__audit.historyVault.protectAllHistory(true)), false)
    assert.equal(vault.generation, beforeFailedCheck, 'a corrupt native-only original cannot be verified')
    assert.equal(await restore(), null)
    assert.equal(await page.evaluate(() => window.__audit.historyVault.useHistoryVault.getState().issue), 'unreadable')
    assert.equal(await digestLocalOriginal(page, fileId), null)
    assert.deepEqual(await localState(page), { 'manual-chat': '始终保留的正文' })

    vault.originals.get(fileId).bytes[0] ^= 1
    assert.deepEqual(await restore(), { sessions: 0, originals: 1, kept: 1, missing: 0 })
    assert.equal(await digestLocalOriginal(page, fileId), expected)
    const key = () => page.evaluate(async (fileId) => (await window.__audit.db.loadDiskOriginalRef(fileId)).key, fileId)
    const brokenKey = await key()
    assert(vault.disk.delete(brokenKey), 'simulate missing private original with a surviving database reference')
    assert.deepEqual(await restore(), { sessions: 0, originals: 1, kept: 1, missing: 0 })
    assert.notEqual(await key(), brokenKey)
    assert.equal(await digestLocalOriginal(page, fileId), expected)
    assert.deepEqual(await restore(), { sessions: 0, originals: 0, kept: 1, missing: 0 })
    assert.deepEqual(await localState(page), { 'manual-chat': '始终保留的正文' })

    await page.evaluate(async ({ size, fileId, mime }) => {
      const bytes = new Uint8Array(size).fill(7)
      await window.__audit.db.saveFiles([{ id: fileId, blob: new Blob([bytes], { type: mime }) }])
    }, { size, fileId, mime })
    const replacement = digest(Buffer.alloc(size, 7))
    assert.equal(await digestLocalOriginal(page, fileId), replacement)
    assert.equal(vault.originals.get(fileId).sha256, replacement, 'a new source revision updates the same original ID')
    assert.deepEqual(vault.sessions.get('manual-chat').originalIds, [fileId])
  })

  await nativeApp(run, 'repairs a missing original after a concurrent conversation deletion', async (page, vault) => {
    const fileId = 'recoverable-original'
    const original = '找回附件时同时删除另一个会话'
    await saveChats(page, { 'delete-during-recovery': '用户已确认删除' })
    await page.evaluate(async ({ fileId, original }) => {
      const { db, fixtures } = window.__audit
      const blob = new Blob([original])
      const file = { id: fileId, name: '附件.txt', size: blob.size, mimeType: blob.type, isImage: false }
      await db.saveSession(fixtures.session({
        id: 'retain-during-recovery',
        messages: [fixtures.user('u', '保留', { files: [file] })],
      }), [{ id: fileId, blob }])
    }, { fileId, original })
    await removePrimaryOriginalRecord(page, fileId)

    const gate = vault.pauseNext('status')
    const restore = page.evaluate(() => window.__audit.historyVault.restoreHistoryVault())
    try {
      await gate.reached
      await page.evaluate(() => {
        window.__deletionDuringRestore = window.__audit.store.removeSession('delete-during-recovery')
      })
    } finally {
      gate.release()
    }

    assert.equal(await page.evaluate(() => window.__deletionDuringRestore), true)
    assert.deepEqual(await restore, { sessions: 0, originals: 1, kept: 1, missing: 0 })
    assert.deepEqual(await localState(page), { 'retain-during-recovery': '保留' })
    assert(!vault.sessions.has('delete-during-recovery'))
    assert.equal(await digestLocalOriginal(page, fileId), digest(Buffer.from(original)))
  })

  await nativeApp(run, 'restores paged snapshots with a colliding original ID and preserves both byte streams', async (page, vault) => {
    const local = '本机已有附件'
    const fromCopy = '另一设备的原件 📎'
    const fileId = 'same-external-file-id'
    const longText = '中文及 emoji 🌊 检查边界\n'.repeat(17000) + '完整结尾 ✔️'
    const copied = await page.evaluate(async ({ local, fromCopy, fileId, longText, mime }) => {
      const { db, fixtures } = window.__audit
      const withFile = (id, text, original) => fixtures.session({ id, messages: [fixtures.user('u', text, {
        files: [{ id: fileId, name: '同名.bin', size: new Blob([original]).size, mimeType: mime, isImage: false }],
      })] })
      await db.saveSession(withFile('local-chat', '本机对话', local), [
        { id: fileId, blob: new Blob([local], { type: mime }) },
      ])
      return withFile('copy-chat', longText, fromCopy)
    }, { local, fromCopy, fileId, longText, mime })
    const document = Buffer.from(JSON.stringify(copied))
    const bytes = Buffer.from(fromCopy)
    vault.write(vault.sessions, { id: copied.id, size: document.length, revision: 'old-zip-collision', originalIds: [fileId], missingIds: [] }, document)
    vault.write(vault.originals, { id: fileId, size: bytes.length, type: mime, sourceRevision: 'old-zip-collision' }, bytes)
    vault.generation++

    const result = await page.evaluate(() => window.__audit.historyVault.restoreHistoryVault())
    assert.deepEqual(result, { sessions: 1, originals: 1, kept: 1, missing: 0 })
    assert.deepEqual(await localState(page), { 'copy-chat': longText, 'local-chat': '本机对话' })
    const copiedId = await page.evaluate(async () => (await window.__audit.db.loadSession('copy-chat')).messages[0].files[0].id)
    assert.notEqual(copiedId, fileId)
    assert.equal(await digestLocalOriginal(page, copiedId), digest(bytes))
    assert.equal(await digestLocalOriginal(page, fileId), digest(Buffer.from(local)))
    assert(vault.calls.some(({ method, args }) => method === 'listSessions' && args.after === 'copy-chat'))
    assert.deepEqual(vault.calls.filter(({ method }) => method === 'readSession').map(({ args }) => args.offset),
      Array.from({ length: Math.ceil(document.length / chunkSize) }, (_, i) => i * chunkSize))
  })

  await nativeApp(run, 'keeps old disk-backed conversations and surviving originals when a file has disappeared', async (page, vault) => {
    const keys = await page.evaluate(async (mime) => {
      const { db, store, stageArchiveFile, fixtures } = window.__audit
      const files = [
        { id: 'intact-original', name: '健康原件.bin', mimeType: mime, size: 4, isImage: false },
        { id: 'missing-original', name: '缺失原件.bin', mimeType: mime, size: 4, isImage: false },
      ]
      // Save through the normal import storage path as an earlier Android version without the vault would.
      const pluginAvailable = window.Capacitor.isPluginAvailable
      window.Capacitor.isPluginAvailable = (name) => name !== 'HistoryVault' && pluginAvailable(name)
      try {
        await store.mergeHistory(async () => {
          await db.addStagingSession(fixtures.session({
            id: 'legacy-disk-chat', messages: [fixtures.user('u', '早期版本磁盘原件正文', { files })],
          }))
          for (const file of files) {
            await stageArchiveFile({ path: file.name, size: file.size, stream: (async function* () {
              yield new TextEncoder().encode(file.id === 'intact-original' ? 'GOOD' : 'GONE')
            })() }, file.id, mime, () => {}, true)
          }
        }, async () => new Set(), async () => {})
      } finally {
        window.Capacitor.isPluginAvailable = pluginAvailable
      }
      return Object.fromEntries(await Promise.all(files.map(async ({ id }) => [id, (await db.loadDiskOriginalRef(id)).key])))
    }, mime)
    assert.equal(vault.sessions.size, 0, 'the primary files were saved before the recovery copy existed')
    const intact = 'intact-original'
    const missing = 'missing-original'
    assert(vault.disk.delete(keys[missing]))
    const verify = () => page.evaluate(() => window.__audit.historyVault.protectAllHistory(true))
    assert.equal(await verify(), true)
    assert.equal(body(vault, 'legacy-disk-chat'), '早期版本磁盘原件正文')
    assert.deepEqual(vault.sessions.get('legacy-disk-chat').missingIds, [missing])
    assert.equal(vault.status().missingOriginalCount, 1)
    assert.equal(vault.originals.get(intact).sha256, digest(Buffer.from('GOOD')))

    vault.diskFaults.set(keys[intact], 'IO')
    const generation = vault.generation
    assert.equal(await verify(), false, 'an unexpected disk failure is not treated as a missing file')
    assert.equal(vault.generation, generation)
    vault.diskFaults.delete(keys[intact])
    assert(vault.disk.delete(keys[intact]))
    assert.equal(await verify(), true, 'the healthy original survives in the native vault')
    assert.equal(vault.status().missingOriginalCount, 1)
    assert.deepEqual(await page.evaluate(() => window.__audit.historyVault.restoreHistoryVault()), {
      sessions: 0, originals: 1, kept: 1, missing: 1,
    })
    assert.equal(await digestLocalOriginal(page, intact), digest(Buffer.from('GOOD')))
    assert.deepEqual(await localState(page), { 'legacy-disk-chat': '早期版本磁盘原件正文' })
  })
}
