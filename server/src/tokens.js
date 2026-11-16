/**
 * 会话令牌：随机 32 字节，数据库只存 SHA-256（泄露库也拿不到可用令牌）。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'

export const newId = () => randomUUID()

export const newToken = () => randomBytes(32).toString('base64url')

export const hashToken = (token) => createHash('sha256').update(token).digest('hex')

export const createSession = (db, userId, days) => {
  const token = newToken()
  const now = Date.now()
  const expiresAt = now + days * 86400_000
  db.prepare(
    'INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(newId(), userId, hashToken(token), now, expiresAt, now)
  return { token, expiresAt }
}

/** 校验令牌；顺带清理过期会话 */
export const findSession = (db, token) => {
  if (!token || token.length > 200) {
    return null
  }
  const row = db
    .prepare(
      'SELECT s.id, s.user_id, s.expires_at, u.username, u.balance_micro, u.spent_micro, u.disabled FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
    )
    .get(hashToken(token))
  if (!row) {
    return null
  }
  if (row.expires_at < Date.now() || row.disabled) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id)
    return null
  }
  db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(Date.now(), row.id)
  return row
}

export const revokeSession = (db, token) => {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
}

export const revokeAllSessions = (db, userId) => {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
}
