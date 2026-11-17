import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeBill, parseAlipayBill, reconcileBill } from '../src/bills.js'
import { openDb } from '../src/db.js'
import { getOrder } from '../src/orders.js'
import { register, startServer } from './helpers.js'

/** 生成一份支付宝风格账单（UTF-8 便于测试；真实账单是 GBK，decodeBill 会回落） */
const bill = (rows) =>
  Buffer.from(
    '支付宝交易记录明细查询\n' +
      '账号:[test@example.com]\n' +
      '交易号,商家订单号,交易创建时间,付款时间,交易来源地,类型,交易对方,商品名称,金额（元）,收/支,交易状态,服务费（元）,备注\n' +
      rows.join('\n') +
      '\n',
    'utf8'
  )

test('账单解析：只认收款成功且备注含订单号的记录', () => {
  const csv = bill([
    '20261117001,,2026-11-17 10:00:00,2026-11-17 10:00:10,其他,即时到账交易,用户A,,10.00,收,交易成功,0.00,FSABC12345',
    '20261117002,,2026-11-17 10:05:00,2026-11-17 10:05:10,其他,即时到账交易,用户B,,5.00,支,交易成功,0.00,FSBBB12345',
    '20261117003,,2026-11-17 10:06:00,,其他,即时到账交易,用户C,,7.00,收,等待付款,0.00,FSCCC12345',
    '20261117004,,2026-11-17 10:07:00,2026-11-17 10:07:10,其他,即时到账交易,用户D,,9.00,收,交易成功,0.00,没有备注',
  ])
  const records = parseAlipayBill(csv)
  assert.equal(records.length, 1)
  assert.equal(records[0].orderId, 'FSABC12345')
  assert.equal(records[0].amount, 10)
  assert.equal(records[0].tradeNo, '20261117001')
})

test('账单解码：GBK 也能解析（支付宝导出默认编码）', () => {
  // "备注" 的 GBK 字节
  assert.equal(decodeBill(Buffer.from([0xb1, 0xb8, 0xd7, 0xa2])), '备注')
  const utf8 = Buffer.from('备注,交易号', 'utf8')
  assert.equal(decodeBill(utf8), '备注,交易号')
})

test('核销：金额一致才入账，重复导入幂等，金额不符报错', async (t) => {
  const ctx = await startServer()
  t.after(ctx.close)
  const created = await register(ctx, 'manual_user', 'passw0rd1')
  const token = created.json.token
  const order = await ctx.call('/api/pay/orders', { method: 'POST', token, body: { amountCny: 10 } })
  const orderId = order.json.id

  const wrong = reconcileBill(ctx.db, [{ orderId, amount: 1 }])
  assert.equal(wrong[0].ok, false)
  assert.match(wrong[0].reason, /金额/)

  const ok = reconcileBill(ctx.db, [{ orderId, amount: 10, tradeNo: 'T1' }])
  assert.equal(ok[0].ok, true)
  assert.equal(ok[0].already, false)

  const again = reconcileBill(ctx.db, [{ orderId, amount: 10, tradeNo: 'T1' }])
  assert.equal(again[0].already, true)

  const me = await ctx.call('/api/me', { token })
  assert.equal(me.json.balanceMicro, 10_000_000)
  assert.equal(getOrder(ctx.db, orderId).status, 'paid')
})

test('CLI 账单文件核销：从 CSV 文件读入并加款', async (t) => {
  const ctx = await startServer()
  t.after(ctx.close)
  const created = await register(ctx, 'file_user', 'passw0rd1')
  const order = await ctx.call('/api/pay/orders', {
    method: 'POST',
    token: created.json.token,
    body: { amountCny: 5 },
  })
  const dir = mkdtempSync(join(tmpdir(), 'bill-'))
  const file = join(dir, 'alipay.csv')
  writeFileSync(
    file,
    bill([`20261117999,,2026-11-17 11:00:00,2026-11-17 11:00:10,其他,即时到账交易,用户,,5.00,收,交易成功,0.00,${order.json.id}`])
  )
  const rows = parseAlipayBill(readFileSync(file))
  assert.equal(rows.length, 1)
  const result = reconcileBill(ctx.db, rows)
  assert.equal(result[0].ok, true)
})
