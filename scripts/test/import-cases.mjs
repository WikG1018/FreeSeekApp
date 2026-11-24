import assert from 'node:assert/strict'
import { zipSync, strToU8 } from 'fflate'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const zip64Fixture = (entries) => {
  const archive = Buffer.from(zipSync(entries, { level: 0 }))
  const end = Buffer.from(archive.subarray(-22))
  const count = end.readUInt16LE(10)
  const offset = end.readUInt32LE(16)
  const records = []
  let cursor = offset
  for (let i = 0; i < count; i++) {
    const header = Buffer.from(archive.subarray(cursor, cursor + 46))
    const name = header.readUInt16LE(28)
    const extra = header.readUInt16LE(30)
    const comment = header.readUInt16LE(32)
    const zip64 = Buffer.alloc(28)
    zip64.writeUInt16LE(1)
    zip64.writeUInt16LE(24, 2)
    zip64.writeBigUInt64LE(BigInt(header.readUInt32LE(24)), 4)
    zip64.writeBigUInt64LE(BigInt(header.readUInt32LE(20)), 12)
    zip64.writeBigUInt64LE(BigInt(header.readUInt32LE(42)), 20)
    header.writeUInt16LE(45, 6)
    header.writeUInt32LE(0xffffffff, 20)
    header.writeUInt32LE(0xffffffff, 24)
    header.writeUInt16LE(extra + zip64.length, 30)
    header.writeUInt32LE(0xffffffff, 42)
    const next = cursor + 46 + name + extra
    records.push(
      header,
      archive.subarray(cursor + 46, next),
      zip64,
      archive.subarray(next, next + comment)
    )
    cursor = next + comment
  }
  const directory = Buffer.concat(records)
  const end64 = Buffer.alloc(56)
  end64.writeUInt32LE(0x06064b50)
  end64.writeBigUInt64LE(44n, 4)
  end64.writeUInt16LE(45, 12)
  end64.writeUInt16LE(45, 14)
  end64.writeBigUInt64LE(BigInt(count), 24)
  end64.writeBigUInt64LE(BigInt(count), 32)
  end64.writeBigUInt64LE(BigInt(directory.length), 40)
  end64.writeBigUInt64LE(BigInt(offset), 48)
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50)
  locator.writeBigUInt64LE(BigInt(offset + directory.length), 8)
  locator.writeUInt32LE(1, 16)
  end.writeUInt16LE(0xffff, 8)
  end.writeUInt16LE(0xffff, 10)
  end.writeUInt32LE(0xffffffff, 12)
  end.writeUInt32LE(0xffffffff, 16)
  return Buffer.concat([archive.subarray(0, offset), directory, end64, locator, end])
}

// 官方格式的合成数据：含长中文、emoji、转义和末尾校验标记，不含任何用户内容。
export const officialFixture = (megabytes = 64, sessions = 1) => {
  const part = '长会话兼容性测试 📚 abcdefghijklmnopqrstuvwxyz\n',
    content =
      part.repeat(Math.ceil((megabytes * 1024 * 1024) / Buffer.byteLength(part))) +
      '末尾完整保留 🌏 "引号" \\ 路径',
    date = '2026-11-18T00:00:00.000000Z',
    entries = { 'manifest.json': strToU8('{"export_format_version":3}') },
    index = []
  let jsonBytes = 0
  for (let i = 0; i < sessions; i++) {
    const id = `official-large-${i}`,
      record = {
        id,
        title: i === 0 ? '官方长会话测试' : `会话 ${i}`,
        pinned: i === 0,
        current_message_id: 2,
        inserted_at: date,
        updated_at: date,
        messages: [
          {
            id: 1,
            parent_id: null,
            role: 'USER',
            status: 'FINISHED',
            thinking_enabled: false,
            search_enabled: false,
            accumulated_token_usage: 0,
            inserted_at: date,
            fragments: [{ type: 'REQUEST', content: i === 0 ? content : '小会话内容' }],
          },
          {
            id: 2,
            parent_id: 1,
            role: 'ASSISTANT',
            status: 'FINISHED',
            thinking_enabled: false,
            search_enabled: false,
            accumulated_token_usage: 4,
            inserted_at: date,
            fragments: [{ type: 'RESPONSE', content: '回答也完整保留' }],
          },
        ],
      }
    entries[`chat_sessions/${id}.json`] = strToU8(JSON.stringify(record))
    if (i === 0) jsonBytes = entries[`chat_sessions/${id}.json`].length
    index.push({
      id,
      title: record.title,
      pinned: record.pinned,
      message_count: 2,
      inserted_at: date,
      updated_at: date,
    })
  }
  entries['chat_session_index.json'] = strToU8(JSON.stringify(index))
  return {
    buffer: Buffer.from(zipSync(entries, { level: 6 })),
    jsonBytes,
    length: content.length,
    tail: content.slice(-60),
  }
}

const branchTime = '2026-11-18T00:00:00Z'
const branchMessage = (id, parent_id, role, content) => ({
  id,
  parent_id,
  role,
  status: 'FINISHED',
  thinking_enabled: false,
  search_enabled: false,
  accumulated_token_usage: 0,
  inserted_at: branchTime,
  fragments: [{ type: role === 'USER' ? 'REQUEST' : 'RESPONSE', content }],
})
const branchSession = (id, messages, current_message_id) => ({
  id,
  title: '备份会话 ' + id,
  inserted_at: branchTime,
  updated_at: branchTime,
  messages,
  current_message_id,
})
const branchBackup = (sessions, images = {}) => {
  const json = (value) => strToU8(JSON.stringify(value))
  return Buffer.from(zipSync({
    'manifest.json': json({ export_format_version: 3 }),
    ...Object.fromEntries(sessions.map((session) => [`chat_sessions/${session.id}.json`, json(session)])),
    'chat_session_index.json': json(sessions.map(({ messages, current_message_id, ...entry }) => ({
      ...entry, message_count: messages.length,
    }))),
    ...images,
  }, { level: 0 }))
}

export const runImportCases = async ({ run }) => {
  await run('merge import selects duplicate versions and keeps both sets of attachment bytes', async (page) => {
    const encoded = await page.evaluate(async () => {
      const a = window.__audit
      const f = a.fixtures
      const attachment = {
        id: 'same-file',
        name: '原件.txt',
        size: 6,
        serverId: null,
        mimeType: 'text/plain',
        isImage: false,
      }
      const chat = (id, title, body, updatedAt) => f.session({
        id,
        title,
        updatedAt,
        messages: [f.user('question', body, { files: [attachment] })],
      })
      const stamp = Date.UTC(2026, 10, 24, 10)
      const local = chat('keep-version', '保留的聊天', '本机保留', stamp)
      await a.seed([
        local,
        chat('replace-version', '待更新的聊天', '本机旧版', stamp),
        f.session({ id: 'same-title-local', title: '同名会话' }),
      ], [{ id: attachment.id, blob: new Blob(['local!'], { type: 'text/plain' }) }])
      const archive = await a.exportArchive([
        chat(local.id, local.title, '备份版本未选', stamp + 86_400_000),
        chat('replace-version', '备份中的新标题', '备份版本已选', stamp + 86_400_000),
        chat('same-title-backup', '同名会话', '这是另一条会话', stamp + 86_400_000),
      ], async () => new Blob(['backup'], { type: 'text/plain' }))
      a.settingsDialog.openSettings('data')
      return btoa(String.fromCharCode(...new Uint8Array(await archive.arrayBuffer())))
    })
    await page.setViewportSize({ width: 320, height: 680 })
    const input = page.locator('input[type="file"][accept*="application/zip"]')
    await input.setInputFiles({
      name: '聊天备份.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(encoded, 'base64'),
    })
    await page.getByRole('button', { name: '开始导入', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '选择保留哪一份', exact: true })
    await dialog.waitFor()
    assert.match(await dialog.innerText(), /1 个新会话，2 个重复会话/)
    assert.equal(await dialog.getByRole('radio', { name: /保留本机/ }).count(), 2)
    for (const radio of await dialog.getByRole('radio', { name: /保留本机/ }).all()) {
      assert.equal(await radio.isChecked(), true)
    }
    await dialog.getByRole('button', { name: '全部使用备份', exact: true }).click()
    for (const radio of await dialog.getByRole('radio', { name: /使用备份/ }).all()) {
      assert.equal(await radio.isChecked(), true)
    }
    await dialog.getByRole('button', { name: '全部保留本机', exact: true }).click()
    const group = dialog.getByRole('group', { name: '待更新的聊天', exact: true })
    await group.getByRole('radio', { name: /使用备份/ }).check()
    assert.match(await dialog.innerText(), /将用备份替换 1 个重复会话/)
    if (process.env.FREESEEK_TASK_PREVIEWS) {
      await page.screenshot({ path: 'tmp/regression/task/import-conflicts-zh.png', animations: 'disabled' })
    }
    await dialog.getByRole('button', { name: '合并导入', exact: true }).click()
    const done = page.getByRole('dialog', { name: '导入完成', exact: true })
    await done.waitFor()
    assert.match(await done.innerText(), /新增 1 个 · 替换 1 个 · 保留 1 个/)
    const stored = await page.evaluate(async () => {
      const a = window.__audit
      const ids = (await a.db.loadSessionSummaries()).map(({ id }) => id).sort()
      const content = async (id) => {
        const [message] = (await a.db.loadSession(id)).messages
        const fileId = message.files[0].id
        return { body: message.content, fileId, bytes: await (await a.db.loadFile(fileId)).text() }
      }
      return {
        ids,
        kept: await content('keep-version'),
        replaced: await content('replace-version'),
        added: await content('same-title-backup'),
      }
    })
    assert.deepEqual(stored.ids, ['keep-version', 'replace-version', 'same-title-backup', 'same-title-local'])
    assert.deepEqual(stored.kept, { body: '本机保留', fileId: 'same-file', bytes: 'local!' })
    assert.equal(stored.replaced.body, '备份版本已选')
    assert.equal(stored.added.body, '这是另一条会话')
    assert.notEqual(stored.replaced.fileId, stored.kept.fileId)
    assert.equal(stored.replaced.fileId, stored.added.fileId)
    assert.equal(stored.replaced.bytes, 'backup')
    assert.equal(stored.added.bytes, 'backup')
    await done.getByRole('button', { name: '查看已导入的对话', exact: true }).click()
    await page.getByText(/备份版本已选|这是另一条会话/).first().waitFor()
  })

  await run('merge import keeps the newer local version if it changes while reviewing', async (page) => {
    const state = await page.evaluate(async () => {
      const a = window.__audit
      const f = a.fixtures
      const original = f.session({ id: 'local-edit', messages: [f.user('u', '原版')] })
      await a.seed([original])
      const archive = await a.exportArchive([
        { ...original, messages: [f.user('u', '备份版本')] },
        f.session({ id: 'only-backup', messages: [f.user('u', '新会话')] }),
      ])
      const file = new File([archive], 'merge.zip')
      let reason
      try {
        await a.backup.importHistory(file, undefined, async ({ conflicts }) => {
          if (conflicts.length !== 1) throw new Error('Expected one duplicate chat')
          await a.db.saveSession({ ...original, messages: [f.user('u', '刚保存的版本')] })
          return new Set([original.id])
        })
      } catch (error) {
        reason = error.key
      }
      const add = IDBObjectStore.prototype.add
      let spaceError
      try {
        await a.backup.importHistory(file, undefined, async () => {
          IDBObjectStore.prototype.add = function (value, ...args) {
            if (value.id === original.id) {
              throw new DOMException('Simulated storage limit during merge', 'QuotaExceededError')
            }
            return add.call(this, value, ...args)
          }
          return new Set()
        })
      } catch (error) {
        spaceError = error.key
      } finally {
        IDBObjectStore.prototype.add = add
      }
      return {
        reason,
        spaceError,
        kept: (await a.db.loadSession(original.id)).messages[0].content,
        added: Boolean(await a.db.loadSession('only-backup')),
        staged: (await a.db.getStorageSummary()).alternateSessionCount,
      }
    })
    assert.deepEqual(state, {
      reason: 'backupMergeChanged',
      spaceError: 'backupStorageFull',
      kept: '刚保存的版本',
      added: false,
      staged: 0,
    })
  })

  await run('official backup imports new chats and detects the same official conversation on reimport', async (page) => {
    const fixture = officialFixture(0, 2)
    const result = await page.evaluate(async (encoded) => {
      const a = window.__audit
      await a.seed([a.fixtures.session({ id: 'local-only', title: '官方长会话测试' })])
      const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
      const file = new File([bytes], 'official.zip')
      const first = await a.backup.importHistory(file)
      const again = await a.backup.importHistory(file)
      return { first, again, ids: (await a.db.loadSessionSummaries()).map(({ id }) => id).sort() }
    }, fixture.buffer.toString('base64'))
    assert.equal(result.first.added, 2)
    assert.equal(result.first.kept, 0)
    assert.equal(result.again.added, 0)
    assert.equal(result.again.kept, 2)
    assert.deepEqual(result.ids, ['local-only', 'official-large-0', 'official-large-1'])
  })

  await run('official backup restores missing branch selections and preserves every resolvable branch', async (page) => {
    const tree = [
      branchMessage(5, 1, 'ASSISTANT', '最后一版回复'),
      branchMessage(1, null, 'USER', '原始提问'),
      branchMessage(2, 1, 'ASSISTANT', '旧回复版本'),
    ]
    const reordered = [
      branchMessage(2, 40, 'ASSISTANT', '旧回复版本'),
      branchMessage(7, 40, 'ASSISTANT', '最后一版回复'),
      branchMessage(40, null, 'USER', '原始提问'),
      branchMessage(9, 2, 'USER', '后续仍保留'),
    ]
    const sessions = [
      branchSession('outdated', tree, 999),
      branchSession('no-cursor', tree),
      branchSession('null-cursor', tree, null),
      branchSession('zero-cursor', tree, 0),
      branchSession('older-cursor', reordered, 2),
      branchSession('latest-leaf', reordered, 999),
    ]
    const result = await page.evaluate(async ({ data, ids }) => {
      const a = window.__audit
      const file = new File([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], 'official-branches.zip')
      const imported = await a.backup.importHistory(file)
      const actual = []
      for (const id of ids) {
        const session = await a.db.loadSession(id)
        const visible = a.branches.getVisibleMessages(session).map(({ id }) => id)
        const switched = a.branches.getVisibleMessages(a.branches.selectVersion(session, visible[0] === '1' ? '2' : '7'))
        actual.push({ visible, total: session.messages.length, alternate: switched.at(-1).blocks[0].text })
      }
      const diagnostic = (await a.diagnostics.readDiagnosticLogs()).events.find(({ event }) => event === 'import.branches-checked')
      return { added: imported.added, skipped: imported.skipped, actual, diagnostic: diagnostic?.details }
    }, { data: branchBackup(sessions).toString('base64'), ids: sessions.map(({ id }) => id) })
    assert.deepEqual(result, {
      added: 6,
      skipped: 0,
      actual: [
        ...Array.from({ length: 4 }, () => ({ visible: ['1', '5'], total: 3, alternate: '旧回复版本' })),
        { visible: ['40', '2'], total: 4, alternate: '最后一版回复' },
        { visible: ['40', '2', '9'], total: 4, alternate: '最后一版回复' },
      ],
      diagnostic: { recoveredSelections: 5, skippedSessions: 0 },
    })
  })

  await run('official backup skips unresolvable branches only after review and preserves local duplicates', async (page) => {
    const healthy = branchSession('readable', [branchMessage(1, null, 'USER', '可以导入的正文')], 1)
    const duplicate = branchSession('existing-version', [branchMessage(1, null, 'USER', '备份里的旧版')], 1)
    const bad = branchSession('missing-parent', [
      branchMessage(1, null, 'USER', '不可导入的分支'),
      branchMessage(2, 99, 'ASSISTANT', '找不到对应提问'),
    ], 2)
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/k3sAAAAASUVORK5CYII=', 'base64')
    const attach = (session, id) => {
      const path = `chat_sessions/${session.id}_files/${id}_fixture.png`
      session.messages[0].fragments.push({
        type: 'FILE',
        files: [{
          id, file_name: 'fixture.png', file_size: png.length, token_usage: null,
          inserted_at: branchTime, export_path: path, is_image: true, width: 1, height: 1,
        }],
      })
      return path
    }
    const cycle = branchSession('loop', [
      branchMessage(1, 2, 'USER', '环中的提问'),
      branchMessage(2, 1, 'ASSISTANT', '环中的回复'),
    ], 2)
    const pack = {
      name: '聊天迁移.zip',
      mimeType: 'application/zip',
      buffer: branchBackup([healthy, duplicate, bad, cycle], {
        [attach(healthy, 'readable-image')]: png,
        [attach(bad, 'broken-image')]: png,
      }),
    }
    await page.setViewportSize({ width: 320, height: 680 })
    await page.evaluate(async () => {
      const a = window.__audit
      const f = a.fixtures
      await a.seed(['missing-parent', 'existing-version'].map((id) =>
        f.session({ id, title: '本机 ' + id, messages: [f.user('u', '本机保留的正文')] })
      ))
      a.settingsDialog.openSettings('data')
    })
    const input = page.locator('input[type="file"][accept*="application/zip"]')
    const review = page.getByRole('dialog', { name: '选择保留哪一份', exact: true })
    const start = async () => {
      await input.setInputFiles(pack)
      await page.getByRole('button', { name: '开始导入', exact: true }).click()
      await review.getByText(/2 个会话的消息顺序无法还原/).waitFor({ timeout: 3500 })
    }
    await start()
    assert.equal(await review.getByRole('radio', { name: /保留本机/ }).isChecked(), true)
    await review.getByRole('button', { name: '取消', exact: true }).click()
    await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().importingHistory === false)
    await review.waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(() => window.__audit.db.loadSession('readable')), undefined)
    await start()
    if (process.env.FREESEEK_TASK_PREVIEWS) {
      await page.screenshot({ path: 'tmp/regression/task/import-branch-review-zh.png', animations: 'disabled' })
    }
    await review.getByRole('button', { name: '合并导入', exact: true }).click()
    const done = page.getByRole('dialog', { name: '导入完成', exact: true })
    await done.getByText('已跳过 2 个无法恢复的会话。').waitFor()
    assert.match(await done.innerText(), /新增 1 个 · 替换 0 个 · 保留 1 个/)
    const stored = await page.evaluate(async () => {
      const a = window.__audit
      const contents = await Promise.all(['missing-parent', 'existing-version', 'readable'].map(async (id) =>
        (await a.db.loadSession(id)).messages[0].content
      ))
      const storage = await a.db.getStorageSummary()
      const file = await a.db.loadFile('readable-image')
      const original = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())))
      const repair = (await a.diagnostics.readDiagnosticLogs()).events.find(({ event }) => event === 'import.branches-checked')
      return { contents, count: storage.sessionCount, originals: storage.fileCount, original, diagnostic: repair?.details }
    })
    assert.deepEqual(stored, {
      contents: ['本机保留的正文', '本机保留的正文', '可以导入的正文'],
      count: 3,
      originals: 1,
      original: png.toString('base64'),
      diagnostic: { recoveredSelections: 0, skippedSessions: 2, missingParent: 1, cycle: 1 },
    })
  })

  await run('official backup leaves history intact when no message tree can be recovered or the ZIP is damaged', async (page) => {
    const bad = branchSession('duplicate-ids', [
      branchMessage(1, null, 'USER', '第一个提问'),
      branchMessage(1, null, 'USER', '重复的消息编号'),
    ], 1)
    const invalid = branchBackup([bad])
    const valid = branchSession('good-before-bad-zip', [branchMessage(1, null, 'USER', '不应部分写入')], 1)
    const corrupt = branchBackup([valid, bad])
    const lastEntry = corrupt.indexOf(Buffer.from('[{"id":"good-before-bad-zip"'))
    const titleOffset = corrupt.indexOf(Buffer.from('备份会话 good-before-bad-zip'), lastEntry)
    assert.ok(lastEntry > 0 && titleOffset > lastEntry)
    // 改动不参与导入规则的索引标题。JSON 仍可解析，只有 ZIP 校验能发现它被改过。
    corrupt[titleOffset + Buffer.byteLength('备份会话 ')] = 0x62
    const result = await page.evaluate(async (fixtures) => {
      const a = window.__audit
      const f = a.fixtures
      await a.seed([f.session({ id: 'kept', messages: [f.user('u', '原本的记录')] })])
      let reviews = 0
      const errors = []
      for (const data of fixtures) {
        const file = new File([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], 'backup.zip')
        try {
          await a.backup.importHistory(file, undefined, async () => {
            reviews += 1
            return new Set()
          })
        } catch (error) {
          errors.push(error.key)
        }
      }
      const storage = await a.db.getStorageSummary()
      return { reviews, errors, count: storage.sessionCount, staged: storage.alternateSessionCount }
    }, [invalid.toString('base64'), corrupt.toString('base64')])
    assert.deepEqual(result, {
      reviews: 0,
      errors: ['backupInvalidBranches', 'backupIncomplete'],
      count: 1,
      staged: 0,
    })
    await page.evaluate(() => window.__audit.settingsDialog.openSettings('data'))
    await page.locator('input[type="file"][accept*="application/zip"]').setInputFiles({
      name: '不可还原.zip', mimeType: 'application/zip', buffer: invalid,
    })
    await page.getByRole('button', { name: '开始导入', exact: true }).click()
    const failure = page.getByRole('dialog', { name: '导入失败', exact: true })
    await failure.getByText('无法还原备份里的会话。请重新导出一份备份。', { exact: true }).waitFor()
    assert.equal(await failure.getByRole('button', { name: '重试', exact: true }).count(), 0)
    await failure.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: /导入历史对话/ }).waitFor()
  })

  await run('official backup offers available chats without duplicate choices in English dark mode', async (page) => {
    const pack = branchBackup([
      branchSession('valid-zero', [branchMessage(0, null, 'USER', '原始消息零')], 0),
      branchSession('invalid-root', [branchMessage(1, null, 'ASSISTANT', '不可还原的根')], 1),
      branchSession('same-role', [
        branchMessage(1, null, 'USER', '提问一'),
        branchMessage(2, 1, 'USER', '无法还原的连续提问'),
      ], 2),
    ])
    await page.setViewportSize({ width: 360, height: 640 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.evaluate(() => {
      window.__audit.settings.setLocale('en-US')
      window.__audit.settingsDialog.openSettings('data')
    })
    await page.locator('input[type="file"][accept*="application/zip"]').setInputFiles({
      name: 'branch-fixture.zip', mimeType: 'application/zip', buffer: pack,
    })
    await page.getByRole('button', { name: 'Start import', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Some chats could not be restored', exact: true })
    await review.getByText('Chats available to import · 1', { exact: true }).waitFor()
    await review.getByText('Chats with unreadable message order will be skipped (2).', { exact: true }).waitFor()
    assert.equal(await review.getByRole('radio').count(), 0)
    if (process.env.FREESEEK_TASK_PREVIEWS) {
      await page.screenshot({ path: 'tmp/regression/task/import-available-dark-en.png', animations: 'disabled' })
    }
    await review.getByRole('button', { name: 'Import available chats', exact: true }).click()
    await page.getByRole('dialog', { name: 'Import finished', exact: true }).getByText('Skipped · 2').waitFor()
    assert.equal(await page.evaluate(async () => (await window.__audit.db.loadSession('valid-zero')).rootMessageId), '0')
  })

  await run(
    'a damaged chat list and interrupted import are recovered while empty backups preserve history',
    async (page) => {
      const emptyNative = zipSync({
        'manifest.json': strToU8(
          JSON.stringify({
            freeseek_backup_version: 2,
            sessions: [],
            files: [],
            personas: [],
            defaultPersonaId: 'builtin-default',
          })
        ),
      })
      const emptyOfficial = zipSync({
        'manifest.json': strToU8('{"export_format_version":3}'),
        'chat_session_index.json': strToU8('[]'),
      })
      await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        await a.seed([
          f.session({
            id: 'retained',
            title: 'Missing from list',
            messages: [f.user('original', 'Original conversation')],
          }),
        ])
        await a.db.addStagingSession(f.session({ id: 'unfinished', title: 'Interrupted import' }))
        await a.db.saveStagingFiles([{ id: 'unfinished-file', blob: new Blob(['partial import']) }])
        await new Promise((resolve, reject) => {
          const open = indexedDB.open('freeseek')
          open.onerror = () => reject(open.error)
          open.onsuccess = () => {
            const db = open.result
            const tx = db.transaction('sessionSummaries', 'readwrite')
            tx.objectStore('sessionSummaries').delete('retained')
            tx.oncomplete = () => {
              db.close()
              resolve()
            }
            tx.onabort = () => {
              db.close()
              reject(tx.error)
            }
          }
        })
      })
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      await page.waitForFunction(async () =>
        (await window.__audit.db.getStorageSummary()).alternateSessionCount === 0
      )
      const state = await page.evaluate(
        async (archives) => {
          const a = window.__audit
          const before = a.store.useChatStore.getState().sessions.map(({ id }) => id)
          const cleaned = (await a.diagnostics.readDiagnosticLogs()).events.some(
            ({ event, details }) => event === 'history.staging-cleared' && details.originals === 1
          )
          const rejected = []
          for (const b64 of archives) {
            try {
              await a.backup.importHistory(
                new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'empty.zip')
              )
              rejected.push(null)
            } catch (error) {
              rejected.push(error.key)
            }
          }
          return {
            before,
            cleaned,
            rejected,
            after: (await a.db.loadSessionSummaries()).map(({ id }) => id),
            message: (await a.db.loadSession('retained')).messages[0].content,
          }
        },
        [emptyNative, emptyOfficial].map((data) => Buffer.from(data).toString('base64'))
      )
      assert.deepEqual(state, {
        before: ['retained'],
        cleaned: true,
        rejected: ['backupEmptyHistory', 'backupEmptyHistory'],
        after: ['retained'],
        message: 'Original conversation',
      })
    }
  )

  await run(
    'ZIP64 history imports large-format offsets and an invalid CRC keeps the current chat',
    async (page) => {
      const original = 'Original ZIP64 attachment'
      const manifest = {
        freeseek_backup_version: 2,
        sessions: ['zip64'],
        files: [{ id: 'attachment', size: original.length, type: 'text/plain' }],
        personas: [],
        defaultPersonaId: 'builtin-default',
      }
      const session = {
        id: 'zip64',
        title: 'ZIP64 backup',
        createdAt: 1720000000000,
        updatedAt: 1720000001000,
        messages: [
          {
            id: 'question',
            role: 'user',
            content: 'Imported ZIP64 history',
            createdAt: 1720000000000,
            files: [
              {
                id: 'attachment',
                name: 'sample.txt',
                serverId: null,
                size: original.length,
                isImage: false,
                mimeType: 'text/plain',
              },
            ],
          },
        ],
      }
      const bytes = zip64Fixture({
        'manifest.json': strToU8(JSON.stringify(manifest)),
        'freeseek/sessions/zip64.json': strToU8(JSON.stringify(session)),
        'freeseek/files/attachment.bin': strToU8(original),
      })
      const corrupt = Buffer.from(bytes)
      const index = corrupt.indexOf(original)
      assert.ok(index > 0)
      corrupt[index] ^= 1
      const result = await page.evaluate(
        async ({ valid, bad }) => {
          const a = window.__audit,
            f = a.fixtures
          const file = (data) =>
            new File([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], 'backup.zip')
          await a.seed([
            f.session({ id: 'keep', messages: [f.user('original', 'Keep my original chat')] }),
          ])
          let reason
          try {
            await a.backup.importHistory(file(bad))
          } catch (error) {
            reason = error.key
          }
          const retained = (await a.db.loadSession('keep')).messages[0].content
          const put = IDBObjectStore.prototype.put
          let count
          try {
            IDBObjectStore.prototype.put = function (value, ...args) {
              if (this.name === 'files' || this.name === 'sessions') {
                throw new DOMException(
                  'The final copy exceeds the demo storage limit',
                  'QuotaExceededError'
                )
              }
              return put.call(this, value, ...args)
            }
            count = (await a.backup.importHistory(file(valid))).added
          } finally {
            IDBObjectStore.prototype.put = put
          }
          return {
            reason,
            retained,
            count,
            chat: (await a.db.loadSession('zip64')).messages[0].content,
            attachment: await (await a.db.loadFile('attachment')).text(),
          }
        },
        { valid: bytes.toString('base64'), bad: corrupt.toString('base64') }
      )
      assert.deepEqual(result, {
        reason: 'backupIncomplete',
        retained: 'Keep my original chat',
        count: 1,
        chat: 'Imported ZIP64 history',
        attachment: original,
      })
    }
  )

  await run(
    'history imports a ZIP larger than 64 MB and keeps the attachment after reopening',
    async (page) => {
      const size = 80 * 1024 * 1024
      const bytes = new Uint8Array(size)
      bytes[0] = 42
      bytes[size - 1] = 99
      const session = {
        id: 'big-backup',
        title: '带大附件的备份',
        createdAt: 1720000000000,
        updatedAt: 1720000001000,
        messages: [
          {
            id: 'question',
            role: 'user',
            content: '完整附件',
            createdAt: 1720000000000,
            files: [
              {
                id: 'original',
                name: 'attachment.txt',
                mimeType: 'text/plain',
                size,
                isImage: false,
                serverId: null,
              },
            ],
          },
        ],
      }
      const manifest = {
        freeseek_backup_version: 2,
        sessions: [session.id],
        files: [{ id: 'original', type: 'text/plain', size }],
        personas: [],
        defaultPersonaId: 'builtin-default',
      }
      const zip = zipSync(
        {
          'manifest.json': strToU8(JSON.stringify(manifest)),
          'freeseek/sessions/big-backup.json': strToU8(JSON.stringify(session)),
          'freeseek/files/original.bin': bytes,
        },
        { level: 0 }
      )
      assert.ok(zip.byteLength > 80 * 1024 * 1024)
      const file = resolve('tmp/regression/big-backup.zip')
      await mkdir(resolve('tmp/regression'), { recursive: true })
      await writeFile(file, zip)
      try {
        await page.evaluate(() => window.__audit.settingsDialog.openSettings('data'))
        await page.locator('input[type="file"][accept*="application/zip"]').setInputFiles(file)
        await page.getByRole('button', { name: '开始导入', exact: true }).click()
        await page
          .getByRole('dialog', { name: '导入完成', exact: true })
          .waitFor({ timeout: 120000 })
        await unlink(file)
        await page.reload()
        await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
        const stored = await page.evaluate(async () => {
          const a = window.__audit,
            chat = await a.db.loadSession('big-backup'),
            attachment = await a.db.loadFile('original')
          return {
            text: chat.messages[0].content,
            bytes: attachment.size,
            first: new Uint8Array(await attachment.slice(0, 1).arrayBuffer())[0],
            last: new Uint8Array(await attachment.slice(-1).arrayBuffer())[0],
          }
        })
        assert.deepEqual(stored, { text: '完整附件', bytes: size, first: 42, last: 99 })
      } finally {
        await unlink(file).catch(() => {})
      }
    }
  )

  await run(
    'history import explains insufficient space and keeps the existing chat',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        await a.seed([f.session({ id: 'keep', messages: [f.user('old', '原来的聊天')] })])
        const archive = await a.exportArchive([
          f.session({ id: 'incoming', messages: [f.user('new', '新聊天')] }),
        ])
        const add = IDBObjectStore.prototype.add
        try {
          IDBObjectStore.prototype.add = function (value, ...args) {
            if (this.name === 'sessionsStaging')
              throw new DOMException('Fixture storage quota', 'QuotaExceededError')
            return add.call(this, value, ...args)
          }
          await a.backup.importHistory(new File([archive], 'backup.zip'))
          return { failure: null }
        } catch (error) {
          return {
            failure: error.key,
            retained: (await a.db.loadSession('keep')).messages[0].content,
            incoming: Boolean(await a.db.loadSession('incoming')),
          }
        } finally {
          IDBObjectStore.prototype.add = add
        }
      })
      assert.deepEqual(result, {
        failure: 'backupStorageFull',
        retained: '原来的聊天',
        incoming: false,
      })
    }
  )

  await run(
    'large native backup restores split parts and a missing part cannot replace history',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures,
          id = 'large-native'
        const usage = {
          input_tokens: 200,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 40,
          output_tokens: 80,
        }
        const messages = Array.from({ length: 12000 }, (_, i) => [
          f.user(
            'q' + i,
            'Original question ' + i,
            i === 0
              ? {
                  files: [
                    {
                      id: 'native-attachment',
                      serverId: null,
                      name: 'sample.txt',
                      size: 14,
                      mimeType: 'text/plain',
                      isImage: false,
                    },
                  ],
                }
              : {}
          ),
          f.assistant('a' + i, 'Original answer ' + i, {
            responseModel: 'deepseek-flash',
            connection: { providerId: 'deepseek' },
            thinking: true,
            reasoning: { adapter: 'deepseek', level: 'high' },
            search: false,
            stopReason: 'end_turn',
            systemPrompt: 'Write a note.',
            blocks: [
              { type: 'thinking', thinking: 'Example reasoning', elapsedSeconds: 1 },
              { type: 'text', text: 'Original answer ' + i },
            ],
            usage,
            usageHistory: [{ createdAt: Date.now(), usage, model: 'deepseek-flash' }],
          }),
        ]).flat()
        const session = a.branches.appendBranch(
          f.session({
            id,
            messages,
            pinned: true,
            inherited: {
              fromId: 'parent',
              fromTitle: 'Parent',
              messages: [f.user('iq', 'Earlier input'), f.assistant('ia', 'Earlier output')],
            },
            compressionUsage: [
              {
                createdAt: Date.now(),
                model: 'deepseek-flash',
                connection: { providerId: 'deepseek' },
                usage,
              },
            ],
          }),
          messages.at(-2).id,
          [f.assistant('alternative', 'Last alternative')]
        )
        const original = new Blob(['original bytes'], { type: 'text/plain' })
        const zip = await a.exportArchive([session], async () => original)
        const file = new File([zip], 'native-split.zip')
        const parts = []
        let manifest
        for await (const entry of a.readArchive(file)) {
          const blob = await a.readEntry(entry)
          if (entry.path === 'manifest.json') manifest = JSON.parse(await blob.text())
          if (entry.path !== 'freeseek/sessions/large-native/2.json')
            parts.push({ name: entry.path, blob })
        }
        await a.backup.importHistory(file)
        const recovered = await a.db.loadSession(id)
        const storedFile = await a.db.loadFile('native-attachment')
        let rejected
        try {
          const incomplete = await a.writeArchive(parts)
          await a.backup.importHistory(new File([incomplete], 'missing-part.zip'))
        } catch (error) {
          rejected = error.key
        }
        return {
          version: manifest.freeseek_backup_version,
          pieces: manifest.splitSessions[0].parts,
          count: recovered.messages.length,
          last: a.branches.getVisibleMessages(recovered).at(-1).id,
          alternate: recovered.messages.at(-2).blocks.at(-1).text,
          inherited: recovered.inherited.messages[1].blocks[0].text,
          compression: recovered.compressionUsage[0].usage.output_tokens,
          original: await storedFile.text(),
          rejected,
          afterFailure: (await a.db.loadSession(id)).messages.length,
        }
      })
      const { pieces, ...rest } = result
      assert.ok(pieces > 1)
      assert.deepEqual(rest, {
        version: 3,
        count: 24001,
        last: 'alternative',
        alternate: 'Original answer 11999',
        inherited: 'Earlier output',
        compression: 80,
        original: 'original bytes',
        rejected: 'backupIncomplete',
        afterFailure: 24001,
      })
    }
  )
  await run(
    'early cursor exhaustion aborts replacement and keeps all original records',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        const archive = await a.exportArchive([
          f.session({ id: 'new-a' }),
          f.session({ id: 'new-b' }),
        ])
        await a.seed([f.session({ id: 'original-a' }), f.session({ id: 'original-b' })])
        const descriptor = Object.getOwnPropertyDescriptor(IDBCursor.prototype, 'request')
        let rejected = false
        try {
          Object.defineProperty(IDBCursor.prototype, 'request', {
            configurable: true,
            get: () => undefined,
          })
          await a.backup.importHistory(new File([archive], 'cursor-failure.zip'))
        } catch {
          rejected = true
        } finally {
          Object.defineProperty(IDBCursor.prototype, 'request', descriptor)
        }
        return { rejected, ids: (await a.db.loadSessionSummaries()).map((s) => s.id).sort() }
      })
      assert.deepEqual(result, { rejected: true, ids: ['original-a', 'original-b'] })
    }
  )
  await run(
    'thousands of ZIP entries use bounded batched reads on legacy Blob implementations',
    async (page) => {
      const fixture = officialFixture(1, 1300)
      const result = await page.evaluate(async (base64) => {
        const raw = atob(base64),
          data = Uint8Array.from(raw, (c) => c.charCodeAt(0)),
          file = new File([data], 'many.zip')
        let reads = 0
        const slice = file.slice.bind(file)
        file.slice = (...args) => {
          reads++
          return slice(...args)
        }
        let entries = 0
        for await (const entry of window.__audit.readArchive(file)) {
          for await (const chunk of entry.stream) {
            void chunk
          }
          entries++
        }
        return { reads, entries }
      }, fixture.buffer.toString('base64'))
      assert.equal(result.entries, 1302)
      assert.ok(result.reads < 120, JSON.stringify(result))
    }
  )
  await run(
    'large official JSON imports through the UI, stays responsive, and round-trips without truncation',
    async (page) => {
      const fixture = officialFixture(136)
      assert.ok(fixture.jsonBytes > 128 * 1024 * 1024)
      await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([
          a.fixtures.session({ title: '原数据', messages: [a.fixtures.user('old', '原记录')] }),
        ])
        a.settingsDialog.openSettings('data')
        window.__importTicks = 0
        window.__importTimer = setInterval(() => window.__importTicks++, 20)
      })
      await page.locator('input[type="file"][accept*="application/zip"]').setInputFiles({
        name: 'official-large.zip',
        mimeType: 'application/zip',
        buffer: fixture.buffer,
      })
      await page.getByRole('button', { name: '开始导入', exact: true }).click()
      const busy = page.getByRole('dialog', { name: '正在导入', exact: true })
      await busy.waitFor()
      assert.doesNotMatch(await busy.innerText(), /永久删除|确定继续|再次确认覆盖|覆盖并导入/)
      await busy.getByRole('progressbar').waitFor()
      await page.getByText(/正在读取当前文件 .* MB/).waitFor()
      await page.screenshot({ path: 'tmp/regression/import-progress.png' })
      await page.getByRole('dialog', { name: '导入完成', exact: true }).waitFor({ timeout: 120000 })
      const result = await page.evaluate(async () => {
        clearInterval(window.__importTimer)
        const a = window.__audit,
          imported = await a.db.loadSession('official-large-0')
        const backup = await a.backup.exportHistory()
        const file = new File([backup.blob], backup.name)
        const entries = a.readArchive(file)
        const first = await entries.next()
        const manifest = JSON.parse(await (await a.readEntry(first.value)).text())
        await entries.return()
        await a.backup.importHistory(file, undefined, async () => new Set(['official-large-0']))
        await a.db.renameSession('official-large-0', '长会话改名')
        const restored = await a.db.loadSession('official-large-0')
        return {
          count: a.store.useChatStore.getState().sessions.length,
          length: restored.messages[0].content.length,
          tail: restored.messages[0].content.slice(-60),
          identical: restored.messages[0].content === imported.messages[0].content,
          reply: restored.messages[1].blocks[0].text,
          pinned: restored.pinned,
          title: restored.title,
          version: manifest.freeseek_backup_version,
          ticks: window.__importTicks,
        }
      })
      assert.equal(result.count, 2)
      assert.equal(result.length, fixture.length)
      assert.equal(result.tail, fixture.tail)
      assert.equal(result.identical, true)
      assert.equal(result.reply, '回答也完整保留')
      assert.equal(result.pinned, true)
      assert.equal(result.title, '长会话改名')
      assert.equal(result.version, 4)
      assert.ok(result.ticks > 5, 'long parsing must yield to the UI')
    }
  )

  await run(
    'streaming JSON handles split Unicode and rejects malformed tails, nesting and token floods',
    async (page) => {
      const result = await page.evaluate(async () => {
        const read = async (source, chunkSize = 1) => {
          const bytes = new TextEncoder().encode(source)
          return window.__audit.readJsonEntry({
            path: 'record.json',
            size: bytes.length,
            stream: {
              async *[Symbol.asyncIterator]() {
                for (let i = 0; i < bytes.length; i += chunkSize)
                  yield bytes.subarray(i, i + chunkSize)
              },
            },
          })
        }
        const source =
            '{"text":"中文🌏\\uD83D\\uDE00\\ud800\\u0000\\n\\\\","__proto__":{"safe":true},"numbers":[1,-2,3.14e-20]}',
          parsed = await read(source),
          errors = []
        for (const bad of [
          '{"a":1} garbage',
          '{}{}',
          '{"a":',
          '[1,]',
          ' '.repeat(32),
          '['.repeat(65) + '0' + ']'.repeat(65),
          '[' + '0,'.repeat(1_000_001) + '0]',
        ]) {
          try {
            await read(bad, 65536)
            errors.push('accepted')
          } catch (error) {
            errors.push(error.key)
          }
        }
        return {
          equal: JSON.stringify(parsed) === JSON.stringify(JSON.parse(source)),
          own: Object.hasOwn(parsed, '__proto__'),
          safe: Object.prototype.safe === undefined,
          errors,
        }
      })
      assert.equal(result.equal, true)
      assert.equal(result.own, true)
      assert.equal(result.safe, true)
      assert.deepEqual(result.errors, [
        'backupInvalidJson',
        'backupInvalidJson',
        'backupInvalidJson',
        'backupInvalidJson',
        'backupInvalidJson',
        'backupJsonTooLarge',
        'backupJsonTooLarge',
      ])
    }
  )

  await run(
    'JSON CRC and trailing corruption preserve existing data and show only failure recovery',
    async (page) => {
      const fixture = officialFixture(1),
        corrupt = Buffer.from(fixture.buffer)
      // 修改中央目录中的会话 CRC；正文是合法 JSON，也必须完成 ZIP 校验后才提交。
      let offset = 0
      while ((offset = corrupt.indexOf(Buffer.from([0x50, 0x4b, 1, 2]), offset)) !== -1) {
        const nameLength = corrupt.readUInt16LE(offset + 28),
          name = corrupt.subarray(offset + 46, offset + 46 + nameLength).toString()
        if (name.startsWith('chat_sessions/')) {
          corrupt[offset + 16] ^= 1
          break
        }
        offset += 46 + nameLength
      }
      await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([
          a.fixtures.session({
            id: 'keep',
            title: '原数据保留',
            messages: [a.fixtures.user('old', '完整原记录')],
          }),
        ])
        a.settingsDialog.openSettings('data')
      })
      await page
        .locator('input[type="file"][accept*="application/zip"]')
        .setInputFiles({ name: 'bad-crc.zip', mimeType: 'application/zip', buffer: corrupt })
      await page.getByRole('button', { name: '开始导入', exact: true }).click()
      const failed = page.getByRole('dialog', { name: '导入失败', exact: true })
      await failed.waitFor()
      assert.doesNotMatch(await failed.innerText(), /将永久删除|再次确认覆盖|覆盖并导入/)
      assert.match(await failed.innerText(), /本机聊天已保留/)
      assert.equal(
        await page.evaluate(
          async () => (await window.__audit.db.loadSession('keep')).messages[0].content
        ),
        '完整原记录'
      )
      await page.screenshot({ path: 'tmp/regression/import-failed.png' })
    }
  )
}
