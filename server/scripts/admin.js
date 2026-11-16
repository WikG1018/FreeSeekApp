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
  console.error('可用命令：users | credit | create-code | codes | disable')
  process.exit(1)
}
commands[command]()
db.close()
