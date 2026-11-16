import test from 'node:test'
import assert from 'node:assert/strict'
import { register, seedBalance, startServer } from './helpers.js'

const messageBody = {
  model: 'deepseek-flash',
  max_tokens: 64,
  messages: [{ role: 'user', content: '这是一段应当只在内存里存在的提问文本' }],
}

test('mock 上游：按用量扣费并写账本', async (t) => {
  const ctx = await startServer()
  t.after(ctx.close)

  const created = await register(ctx, 'alice', 'passw0rd1')
  const token = created.json.token
  seedBalance(ctx.db, 'alice', 10_000_000) // ¥10

  const res = await ctx.call('/anthropic/v1/messages', { method: 'POST', body: messageBody, token })
  assert.equal(res.status, 200)
  assert.match(res.text, /event: message_start/)
  assert.match(res.text, /event: message_stop/)

  const me = await ctx.call('/api/me', { token })
  // mock 上游：input 120000、cache_read 40000、output 2400；空闲/高峰按当前时间计价
  const spent = 10_000_000 - me.json.balanceMicro
  assert.ok(spent > 0, `应当扣费，spent=${spent}`)

  const ledger = await ctx.call('/api/billing/ledger', { token })
  assert.equal(ledger.status, 200)
  assert.equal(ledger.json.items.length, 1)
  const entry = ledger.json.items[0]
  assert.equal(entry.kind, 'usage')
  assert.equal(entry.amountMicro, -spent)
  assert.equal(entry.meta.input, 120_000)
  assert.equal(entry.meta.cacheRead, 40_000)
  assert.equal(entry.meta.output, 2_400)
})

test('余额为 0 时拒绝请求（402）且不扣费', async (t) => {
  const ctx = await startServer()
  t.after(ctx.close)
  const created = await register(ctx, 'bob', 'passw0rd1')
  const res = await ctx.call('/anthropic/v1/messages', {
    method: 'POST',
    body: messageBody,
    token: created.json.token,
  })
  assert.equal(res.status, 402)
  assert.equal(res.json.error.code, 'insufficient_balance')
  const ledger = await ctx.call('/api/billing/ledger', { token: created.json.token })
  assert.equal(ledger.json.items.length, 0)
})

test('未登录 / 令牌无效返回 401', async (t) => {
  const ctx = await startServer()
  t.after(ctx.close)
  const none = await ctx.call('/anthropic/v1/messages', { method: 'POST', body: messageBody })
  assert.equal(none.status, 401)
  const bad = await ctx.call('/anthropic/v1/messages', {
    method: 'POST',
    body: messageBody,
    token: 'not-a-real-token',
  })
  assert.equal(bad.status, 401)
})

test('不保存对话内容：库中任何表都不含提问/回复文本', async (t) => {
  const ctx = await startServer()
  t.after(ctx.close)
  const created = await register(ctx, 'carol', 'passw0rd1')
  seedBalance(ctx.db, 'carol', 10_000_000)
  await ctx.call('/anthropic/v1/messages', { method: 'POST', body: messageBody, token: created.json.token })

  const tables = ctx.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name)
  for (const table of tables) {
    const rows = ctx.db.prepare(`SELECT * FROM ${table}`).all()
    const dump = JSON.stringify(rows)
    assert.ok(!dump.includes('应当只在内存里存在'), `${table} 不应包含提问文本`)
    assert.ok(!dump.includes('mock 上游'), `${table} 不应包含回复文本`)
  }
})

test('附件（files）与语音接口走代理，语音按日限额', async (t) => {
  const ctx = await startServer()
  t.after(ctx.close)
  const created = await register(ctx, 'dave', 'passw0rd1')
  seedBalance(ctx.db, 'dave', 10_000_000)
  const token = created.json.token

  const upload = await ctx.call('/anthropic/v1/files', {
    method: 'POST',
    token,
    form: { purpose: 'user_data' },
  })
  assert.equal(upload.status, 200)
  assert.equal(upload.json.id, 'file_mock')

  // voiceDailyQuota 在测试配置里是 2
  for (let i = 0; i < 2; i += 1) {
    const ok = await ctx.call('/v1/tools/asr', { method: 'POST', token, form: { x: '1' } })
    assert.equal(ok.status, 200)
  }
  const blocked = await ctx.call('/v1/tools/asr', { method: 'POST', token, form: { x: '1' } })
  assert.equal(blocked.status, 429)
  assert.equal(blocked.json.error.code, 'voice_quota_exceeded')
})
