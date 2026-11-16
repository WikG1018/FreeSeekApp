/**
 * SQLite：Node 22+ 内置 node:sqlite，无需原生依赖。
 * 只存账号、余额、订单与用量计数；**不保存任何对话内容**（请求体只在内存中转发）。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  balance_micro INTEGER NOT NULL DEFAULT 0,
  spent_micro INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  amount_micro INTEGER NOT NULL,
  balance_after_micro INTEGER NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, id DESC);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_micro INTEGER NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  qr_code TEXT,
  trade_no TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS redeem_codes (
  code_hash TEXT PRIMARY KEY,
  amount_micro INTEGER NOT NULL,
  used_by TEXT,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS voice_usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
`

export const openDb = (path) => {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  const db = new DatabaseSync(path)
  db.exec(SCHEMA)
  return db
}

/** 事务封装：node:sqlite 没有内置事务 API，用 BEGIN/COMMIT + 回滚 */
export const tx = (db, fn) => {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 回滚失败时保留原始错误
    }
    throw error
  }
}

/** 余额变更的「事务内」版本：调用方负责 BEGIN/COMMIT（避免嵌套事务） */
export const applyBalanceTx = (db, userId, amountMicro, kind, meta = {}) => {
  const user = db.prepare('SELECT balance_micro FROM users WHERE id = ?').get(userId)
  if (!user) {
    throw new Error('user not found')
  }
  const next = user.balance_micro + amountMicro
  db.prepare('UPDATE users SET balance_micro = ? WHERE id = ?').run(next, userId)
  if (kind === 'usage') {
    db.prepare('UPDATE users SET spent_micro = spent_micro + ? WHERE id = ?').run(
      -amountMicro,
      userId
    )
  }
  db.prepare(
    'INSERT INTO ledger (user_id, kind, amount_micro, balance_after_micro, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, kind, amountMicro, next, JSON.stringify(meta), Date.now())
  return next
}

/** 余额变更的唯一入口：自带事务 */
export const applyBalance = (db, userId, amountMicro, kind, meta = {}) =>
  tx(db, () => applyBalanceTx(db, userId, amountMicro, kind, meta))
