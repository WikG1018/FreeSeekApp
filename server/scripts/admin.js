#!/usr/bin/env node
/**
 * 运维 CLI：直接操作本地数据库（不经网络，最安全）。
 *
 *   node scripts/admin.js users
 *   node scripts/admin.js credit <用户名> <金额元> [备注]
 *   node scripts/admin.js create-code <金额元> [数量]
 *   node scripts/admin.js codes
 *   node scripts/admin.js disable <用户名> <0|1>
 */
import { config } from '../src/config.js'
import { openDb, applyBalance } from '../src/db.js'
import { creditOrder, getOrder } from '../src/orders.js'
import { parseAlipayBill, reconcileBill } from '../src/bills.js'
import { readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'

const db = openDb(config.dbPath)
const [, , command, ...args] = process.argv

const findUser = (name) => {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(name)
  if (!row) {
    console.error(`用户不存在：${name}`)
    process.exit(1)
  }
  return row
}

const yuan = (value) => Math.round(Number(value) * 1_000_000)

const commands = {
  users() {
    const rows = db
      .prepare('SELECT id, username, balance_micro, spent_micro, disabled, created_at FROM users ORDER BY created_at')
      .all()
    for (const row of rows) {
      console.log(
        `${row.username}\t余额 ¥${(row.balance_micro / 1e6).toFixed(2)}\t已消费 ¥${(row.spent_micro / 1e6).toFixed(2)}\t${row.disabled ? '已禁用' : '正常'}\t${new Date(row.created_at).toLocaleString()}`
      )
    }
  },
  credit() {
    const [name, amountYuan, note] = args
    if (!name || !amountYuan) {
      console.error('用法：admin.js credit <用户名> <金额元> [备注]')
      process.exit(1)
    }
    const user = findUser(name)
    const micro = yuan(amountYuan)
    if (!Number.isFinite(micro) || micro === 0) {
      console.error('金额无效')
      process.exit(1)
    }
    const balance = applyBalance(db, user.id, micro, 'topup', { note: note ?? 'manual', by: 'cli' })
    console.log(`已为 ${name} 调整 ¥${(micro / 1e6).toFixed(2)}，当前余额 ¥${(balance / 1e6).toFixed(2)}`)
  },
  'create-code'() {
    const [amountYuan, countRaw] = args
    const count = Math.max(1, Math.min(100, Number(countRaw ?? 1)))
    const micro = yuan(amountYuan)
    if (!Number.isFinite(micro) || micro <= 0) {
      console.error('用法：admin.js create-code <金额元> [数量]')
      process.exit(1)
    }
    const codes = []
    for (let i = 0; i < count; i += 1) {
      const code = `FS-${randomBytes(6).toString('hex').toUpperCase()}`
      db.prepare(
        'INSERT INTO redeem_codes (code_hash, amount_micro, created_at) VALUES (?, ?, ?)'
      ).run(createHash('sha256').update(code).digest('hex'), micro, Date.now())
      codes.push(code)
    }
    console.log(codes.join('\n'))
  },
  codes() {
    const rows = db
      .prepare('SELECT amount_micro, used_by, used_at, created_at FROM redeem_codes ORDER BY created_at DESC LIMIT 50')
      .all()
    for (const row of rows) {
      console.log(
        `¥${(row.amount_micro / 1e6).toFixed(2)}\t${row.used_by ? `已使用 ${new Date(row.used_at).toLocaleString()}` : '未使用'}`
      )
    }
  },
  'confirm-order'() {
    const [orderId] = args
    if (!orderId) {
      console.error('用法：admin.js confirm-order <订单号>')
      process.exit(1)
    }
    const order = getOrder(db, orderId)
    if (!order) {
      console.error(`订单不存在：${orderId}`)
      process.exit(1)
    }
    const result = creditOrder(db, orderId, {})
    console.log(
      result.already
        ? `订单 ${orderId} 已入账，无需重复确认`
        : `订单 ${orderId} 已入账 ¥${(result.amountMicro / 1e6).toFixed(2)}（用户 ${order.user_id.slice(0, 8)}…）`
    )
  },
  /** 导入支付宝账单 CSV（个人收款码对账），按备注里的订单号自动核销 */
  'import-bill'() {
    const [file] = args
    if (!file) {
      console.error('用法：admin.js import-bill <支付宝账单.csv>')
      process.exit(1)
    }
    const records = parseAlipayBill(readFileSync(file))
    if (records.length === 0) {
      console.log('没有找到「收款成功且备注含订单号」的记录')
      return
    }
    const results = reconcileBill(db, records)
    let ok = 0
    for (const row of results) {
      if (row.ok) {
        ok += 1
        console.log(`${row.already ? '已入账' : '入账成功'} ${row.orderId} ¥${row.amount}`)
      } else {
        console.log(`跳过 ${row.orderId} ¥${row.amount}：${row.reason}`)
      }
    }
    console.log(`
共 ${results.length} 条，成功 ${ok} 条`)
  },
  disable() {
    const [name, flag] = args
    const user = findUser(name)
    db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(flag === '1' ? 1 : 0, user.id)
    if (flag === '1') {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id)
    }
    console.log(`${name} 已${flag === '1' ? '禁用' : '启用'}`)
  },
}

if (!commands[command]) {
  console.error('可用命令：users | credit | create-code | codes | confirm-order | import-bill | disable')
  process.exit(1)
}
commands[command]()
db.close()
