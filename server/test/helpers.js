import { createServer } from 'node:http'
import { createApp } from '../src/app.js'
import { openDb } from '../src/db.js'
import { createUpstream } from '../src/upstream.js'
import { createHash } from 'node:crypto'

export const testConfig = (overrides = {}) => ({
  host: '127.0.0.1',
  port: 0,
  publicOrigin: '',
  staticDir: '',
  dbPath: ':memory:',
  upstreamOrigin: 'https://api.example.com',
  upstreamKey: 'sk-server-secret',
  mockUpstream: true,
  markup: 1.1,
  sessionDays: 30,
  voiceDailyQuota: 2,
  maxBodyBytes: 1024 * 1024,
  messagesPerMinute: 1000,
  authPerMinute: 1000,
  allowedOrigins: ['http://localhost:8090'],
  adminToken: '',
  pay: {
    provider: 'mock',
    appId: '',
    privateKey: '',
    publicKey: '',
    gateway: '',
    notifyUrl: '',
    minCny: 1,
    maxCny: 2000,
    orderMinutes: 30,
  },
  ...overrides,
})

export const startServer = async (overrides = {}) => {
  const config = testConfig(overrides)
  const db = openDb(':memory:')
  const upstream = createUpstream(config)
  const alipay = {
    buildWapPayUrl: () => '',
    query: async () => ({ ok: false }),
    verifyNotify: () => ({ ok: false }),
  }
  const app = createApp({ config, db, upstream, alipay })
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`

  const call = async (path, { method = 'GET', body, token, form } = {}) => {
    const headers = {}
    if (token) headers['x-api-key'] = token
    let payload
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      payload = new URLSearchParams(form).toString()
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    const response = await fetch(`${base}${path}`, { method, headers, body: payload })
    const text = await response.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
    return { status: response.status, json, text, headers: response.headers }
  }

  const close = () =>
    new Promise((resolve) => {
      server.close(() => {
        db.close()
        resolve()
      })
    })

  return { base, config, db, call, close }
}

export const register = async (ctx, username = 'alice', password = 'passw0rd1') => {
  const res = await ctx.call('/api/auth/register', {
    method: 'POST',
    body: { username, password },
  })
  return res
}

export const seedBalance = (db, username, micro) => {
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  db.prepare('UPDATE users SET balance_micro = ? WHERE id = ?').run(micro, user.id)
  return user.id
}

export const sha256 = (value) => createHash('sha256').update(value).digest('hex')
