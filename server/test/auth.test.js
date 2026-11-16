import test from 'node:test'
import assert from 'node:assert/strict'
import { register, startServer, sha256 } from './helpers.js'

test('注册 → 登录 → /api/me → 登出', async (t) => {
  const ctx = await startServer()
  t.after(ctx.close)

  const created = await register(ctx, 'alice', 'passw0rd1')
  assert.equal(created.status, 201)
  assert.ok(created.json.token)
  assert.equal(created.json.user.username, 'alice')
  assert.equal(created.json.user.balanceMicro, 0)

  const me = await ctx.call('/api/me', { token: created.json.token })
  assert.equal(me.status, 200)
  assert.equal(me.json.username, 'alice')

  const login = await ctx.call('/api/auth/login', {
    method: 'POST',
    body: { username: 'alice', password: 'passw0rd1' },
  })
  assert.equal(login.status, 200)
  assert.notEqual(login.json.token, created.json.token)

  const out = await ctx.call('/api/auth/logout', { method: 'POST', token: login.json.token })
  assert.equal(out.status, 200)
  const afterLogout = await ctx.call('/api/me', { token: login.json.token })
  assert.equal(afterLogout.status, 401)
})

test('密码与用户名规则、重复注册', async (t) => {
  const ctx = await startServer()
  t.after(ctx.close)

  const weak = await register(ctx, 'bob', 'short')
  assert.equal(weak.status, 400)

  const noDigit = await register(ctx, 'bob', 'onlyletters')
  assert.equal(noDigit.status, 400)

  const badName = await register(ctx, 'a', 'passw0rd1')
  assert.equal(badName.status, 400)

  await register(ctx, 'bob', 'passw0rd1')
  const dup = await register(ctx, 'bob', 'passw0rd1')
  assert.equal(dup.status, 409)
})

test('错误密码返回 401，且不泄露用户是否存在', async (t) => {
  const ctx = await startServer()
  t.after(ctx.close)
  await register(ctx, 'carol', 'passw0rd1')

  const wrong = await ctx.call('/api/auth/login', {
    method: 'POST',
    body: { username: 'carol', password: 'wrongpass1' },
  })
  assert.equal(wrong.status, 401)
  const missing = await ctx.call('/api/auth/login', {
    method: 'POST',
    body: { username: 'nobody', password: 'wrongpass1' },
  })
  assert.equal(missing.status, 401)
  assert.equal(wrong.json.error.message, missing.json.error.message)
})

test('数据库只存令牌哈希，不存明文令牌', async (t) => {
  const ctx = await startServer()
  t.after(ctx.close)
  const created = await register(ctx, 'dave', 'passw0rd1')
  const rows = ctx.db.prepare('SELECT token_hash FROM sessions').all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].token_hash, sha256(created.json.token))
  assert.ok(!rows[0].token_hash.includes(created.json.token))
})
