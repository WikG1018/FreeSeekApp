import test from 'node:test'
import assert from 'node:assert/strict'
import { register, seedBalance, startServer } from './helpers.js'

test('mock 支付：下单 → 模拟支付 → 余额到账，重复确认不重复加钱', async (t) => {
  const ctx = await startServer()
  t.after(ctx.close)
  const created = await register(ctx, 'alice', 'passw0rd1')
  const token = created.json.token

  const order = await ctx.call('/api/pay/orders', {
    method: 'POST',
    token,
    body: { amountCny: 10 },
  })
  assert.equal(order.status, 201)
  assert.equal(order.json.mock, true)
  assert.equal(order.json.amountCny, 10)

  const before = await ctx.call('/api/me', { token })
  assert.equal(before.json.balanceMicro, 0)

  const paid = await ctx.call(`/api/pay/dev/${order.json.id}/confirm`, { method: 'POST', token })
  assert.equal(paid.status, 200)
  assert.equal(paid.json.status, 'paid')

  const after = await ctx.call('/api/me', { token })
  assert.equal(after.json.balanceMicro, 10_000_000)

  // 再确认一次：幂等
  const again = await ctx.call(`/api/pay/orders/${order.json.id}/confirm`, {
    method: 'POST',
    token,
  })
  assert.equal(again.status, 200)
  assert.equal(again.json.status, 'paid')
  const final = await ctx.call('/api/me', { token })
  assert.equal(final.json.balanceMicro, 10_000_000)
})

test('充值金额范围校验', async (t) => {
  const ctx = await startServer()
  t.after(ctx.close)
  const created = await register(ctx, 'bob', 'passw0rd1')
  const token = created.json.token

  const tooSmall = await ctx.call('/api/pay/orders', {
    method: 'POST',
    token,
    body: { amountCny: 0.5 },
  })
  assert.equal(tooSmall.status, 400)
  assert.equal(tooSmall.json.error.code, 'invalid_amount')

  const tooBig = await ctx.call('/api/pay/orders', {
    method: 'POST',
    token,
    body: { amountCny: 5000 },
  })
  assert.equal(tooBig.status, 400)
})

test('卡密兑换：只能使用一次，余额到账', async (t) => {
  const ctx = await startServer()
  t.after(ctx.close)
  const created = await register(ctx, 'carol', 'passw0rd1')
  const token = created.json.token

  const code = 'FS-ABC123DEF456'
  ctx.db
    .prepare('INSERT INTO redeem_codes (code_hash, amount_micro, created_at) VALUES (?, ?, ?)')
    .run(
      (await import('./helpers.js')).sha256(code),
      5_000_000,
      Date.now()
    )

  const ok = await ctx.call('/api/billing/redeem', { method: 'POST', token, body: { code } })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.balanceMicro, 5_000_000)

  const again = await ctx.call('/api/billing/redeem', { method: 'POST', token, body: { code } })
  assert.equal(again.status, 400)
})

test('订单只能查看自己的，别人的订单 404', async (t) => {
  const ctx = await startServer()
  t.after(ctx.close)
  const a = await register(ctx, 'user_a', 'passw0rd1')
  const b = await register(ctx, 'user_b', 'passw0rd1')
  const order = await ctx.call('/api/pay/orders', {
    method: 'POST',
    token: a.json.token,
    body: { amountCny: 5 },
  })
  const peek = await ctx.call(`/api/pay/orders/${order.json.id}`, { token: b.json.token })
  assert.equal(peek.status, 404)
  const own = await ctx.call(`/api/pay/orders/${order.json.id}`, { token: a.json.token })
  assert.equal(own.status, 200)
  assert.equal(own.json.status, 'pending')
})

test('管理员加款后余额可消费', async (t) => {
  const ctx = await startServer()
  t.after(ctx.close)
  const created = await register(ctx, 'dave', 'passw0rd1')
  seedBalance(ctx.db, 'dave', 2_000_000)
  const me = await ctx.call('/api/me', { token: created.json.token })
  assert.equal(me.json.balanceMicro, 2_000_000)
})
