import assert from 'node:assert/strict'
import { zipSync, strToU8 } from 'fflate'

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
    'large official JSON imports through the UI, stays responsive, and round-trips without truncation',
    async (page) => {
      const fixture = officialFixture()
      assert.ok(fixture.jsonBytes > 64 * 1024 * 1024)
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
        await a.backup.importHistory(new File([backup.blob], backup.name))
        const restored = await a.db.loadSession('official-large-0')
        return {
          count: a.store.useChatStore.getState().sessions.length,
          length: restored.messages[0].content.length,
          tail: restored.messages[0].content.slice(-60),
          identical: restored.messages[0].content === imported.messages[0].content,
          reply: restored.messages[1].blocks[0].text,
          pinned: restored.pinned,
          ticks: window.__importTicks,
        }
      })
      assert.equal(result.count, 1)
      assert.equal(result.length, fixture.length)
      assert.equal(result.tail, fixture.tail)
      assert.equal(result.identical, true)
      assert.equal(result.reply, '回答也完整保留')
      assert.equal(result.pinned, true)
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
