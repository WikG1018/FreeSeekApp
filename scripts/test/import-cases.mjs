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

export const runImportCases = async ({ run }) => {
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
            count = await a.backup.importHistory(file(valid))
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
      await page.getByRole('button', { name: '我已了解，继续', exact: true }).click()
      assert.match(await page.getByRole('dialog').last().innerText(), /将永久删除/)
      await page.getByRole('button', { name: '覆盖并导入', exact: true }).click()
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
        await a.backup.importHistory(file)
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
      assert.equal(result.count, 1)
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
      await page.getByRole('button', { name: '我已了解，继续', exact: true }).click()
      await page.getByRole('button', { name: '覆盖并导入', exact: true }).click()
      const failed = page.getByRole('dialog', { name: '导入失败', exact: true })
      await failed.waitFor()
      assert.doesNotMatch(await failed.innerText(), /将永久删除|再次确认覆盖|覆盖并导入/)
      assert.match(await failed.innerText(), /原对话未被替换/)
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
