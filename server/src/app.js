/**
 * HTTP 路由：账号、余额、充值、账单、上游转发与计费。
 *
 * 关键约束（按产品要求）：
 * - 上游 Key 只在服务端；客户端只拿到会话令牌
 * - 不保存任何对话内容：请求体只在内存中转发，账本只记 token 数与金额
 * - 登录非强制：未登录时客户端走自带 Key 模式，不经过这里
 */
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { applyBalance, applyBalanceTx, tx } from './db.js'
import { creditOrder as creditOrderDb, getOrder } from './orders.js'
import { readFileSync } from 'node:fs'
import {
  applyCors,
  clientIp,
  RateLimiter,
  readForm,
  readJson,
  sendError,
  sendJson,
  serveStatic,
} from './http.js'
import { checkPasswordPolicy, checkUsername, hashPassword, verifyPassword } from './passwords.js'
import { costCny, toMicro } from './pricing.js'
import { createSession, findSession, newId, revokeSession } from './tokens.js'

const JSON_LIMIT = 256 * 1024

const parseToken = (req) => {
  const raw = req.headers['x-api-key']
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim()
  }
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim()
  }
  return ''
}

const publicUser = (row) => ({
  username: row.username,
  balanceMicro: row.balance_micro,
  spentMicro: row.spent_micro,
})

export const createApp = ({ config, db, upstream, alipay }) => {
  const authLimiter = new RateLimiter(config.authPerMinute, 60_000)
  const msgLimiter = new RateLimiter(config.messagesPerMinute, 60_000)
  const redeemLimiter = new RateLimiter(5, 60_000)
  const ipLimiters = new Map()
  const userRate = (userId) => {
    let limiter = ipLimiters.get(userId)
    if (!limiter) {
      limiter = new RateLimiter(10, 60_000)
      ipLimiters.set(userId, limiter)
    }
    return limiter
  }

  const sessionOf = (req) => findSession(db, parseToken(req))

  /** 记一次用量并把余额扣掉；金额为 0 也写账本，便于核对 */
  const billUsage = (userId, usage, at) => {
    const cost = costCny({ ...usage, at, markup: config.markup })
    const micro = toMicro(cost)
    const next = applyBalance(db, userId, -micro, 'usage', {
      ...usage,
      costMicro: micro,
      at,
    })
    return { micro, balanceMicro: next }
  }

  // ---------- 账号 ----------
  const register = async (req, res) => {
    const body = await readJson(req, JSON_LIMIT)
    const usernameError = checkUsername(body.username)
    if (usernameError) return sendError(res, 400, usernameError, 'invalid_username')
    const passwordError = checkPasswordPolicy(body.password)
    if (passwordError) return sendError(res, 400, passwordError, 'invalid_password')

    const username = String(body.username).trim()
    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
    if (exists) {
      return sendError(res, 409, '用户名已被占用', 'username_taken')
    }
    const id = newId()
    db.prepare(
      'INSERT INTO users (id, username, pass_hash, balance_micro, spent_micro, created_at) VALUES (?, ?, ?, 0, 0, ?)'
    ).run(id, username, hashPassword(String(body.password)), Date.now())
    const { token } = createSession(db, id, config.sessionDays)
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id)
    sendJson(res, 201, { token, user: publicUser(row) })
  }

  const login = async (req, res) => {
    const body = await readJson(req, JSON_LIMIT)
    const username = String(body.username ?? '').trim()
    const password = String(body.password ?? '')
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username)
    // 用户不存在也跑一次哈希，避免通过响应时间枚举用户名
    const ok = row
      ? verifyPassword(password, row.pass_hash)
      : (verifyPassword(password, hashPassword('dummy-password-1')), false)
    if (!ok || row.disabled) {
      return sendError(res, 401, '用户名或密码错误', 'invalid_credentials')
    }
    const { token } = createSession(db, row.id, config.sessionDays)
    sendJson(res, 200, { token, user: publicUser(row) })
  }

  const logout = async (req, res) => {
    const token = parseToken(req)
    if (token) {
      revokeSession(db, token)
    }
    sendJson(res, 200, { ok: true })
  }

  const me = async (req, res) => {
    const session = sessionOf(req)
    if (!session) return sendError(res, 401, '登录已过期，请重新登录', 'unauthorized')
    sendJson(res, 200, publicUser(session))
  }

  // ---------- 账单与卡密 ----------
  const ledger = async (req, res) => {
    const session = sessionOf(req)
    if (!session) return sendError(res, 401, '登录已过期，请重新登录', 'unauthorized')
    const rows = db
      .prepare(
        'SELECT id, kind, amount_micro, balance_after_micro, meta, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 50'
      )
      .all(session.user_id)
    sendJson(res, 200, {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        amountMicro: row.amount_micro,
        balanceMicro: row.balance_after_micro,
        meta: JSON.parse(row.meta),
        createdAt: row.created_at,
      })),
    })
  }

  const redeem = async (req, res) => {
    const session = sessionOf(req)
    if (!session) return sendError(res, 401, '登录已过期，请重新登录', 'unauthorized')
    if (!userRate(session.user_id).take('redeem')) {
      return sendError(res, 429, '操作过于频繁，请稍后再试', 'rate_limited')
    }
    const body = await readJson(req, JSON_LIMIT)
    const code = String(body.code ?? '').trim().toUpperCase()
    if (!/^[A-Z0-9-]{8,40}$/.test(code)) {
      return sendError(res, 400, '卡密格式不正确', 'invalid_code')
    }
    const hash = createHash('sha256').update(code).digest('hex')
    try {
      const result = tx(db, () => {
        const row = db.prepare('SELECT * FROM redeem_codes WHERE code_hash = ?').get(hash)
        if (!row || row.used_by) {
          throw Object.assign(new Error('卡密无效或已被使用'), { status: 400 })
        }
        db.prepare('UPDATE redeem_codes SET used_by = ?, used_at = ? WHERE code_hash = ?').run(
          session.user_id,
          Date.now(),
          hash
        )
        const balance = applyBalanceTx(db, session.user_id, row.amount_micro, 'code', {})
        return { amount: row.amount_micro, balance }
      })
      sendJson(res, 200, { amountMicro: result.amount, balanceMicro: result.balance })
    } catch (error) {
      sendError(res, error.status ?? 400, error.message, 'redeem_failed')
    }
  }

  // ---------- 充值 ----------
  const newOrderId = () => `FS${Date.now()}${randomBytes(3).toString('hex').toUpperCase()}`

  const createOrder = async (req, res) => {
    const session = sessionOf(req)
    if (!session) return sendError(res, 401, '登录已过期，请重新登录', 'unauthorized')
    if (!userRate(session.user_id).take('order')) {
      return sendError(res, 429, '操作过于频繁，请稍后再试', 'rate_limited')
    }
    const body = await readJson(req, JSON_LIMIT)
    const amount = Math.round(Number(body.amountCny) * 100) / 100
    if (!Number.isFinite(amount) || amount < config.pay.minCny || amount > config.pay.maxCny) {
      return sendError(
        res,
        400,
        `充值金额需在 ¥${config.pay.minCny}–¥${config.pay.maxCny} 之间`,
        'invalid_amount'
      )
    }
    const id = newOrderId()
    const now = Date.now()
    const expiresAt = now + config.pay.orderMinutes * 60_000
    const amountMicro = toMicro(amount)
    db.prepare(
      'INSERT INTO orders (id, user_id, amount_micro, provider, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, session.user_id, amountMicro, config.pay.provider, 'pending', now, expiresAt)

    if (config.pay.provider === 'mock') {
      sendJson(res, 201, {
        id,
        amountCny: amount,
        status: 'pending',
        mock: true,
        expiresAt,
      })
      return
    }

    if (config.pay.provider === 'manual') {
      // 个人收款码：没有回调，靠用户备注订单号 + 运营者导入账单核销
      sendJson(res, 201, {
        id,
        amountCny: amount,
        status: 'pending',
        manual: true,
        qrUrl: config.pay.manualQrUrl || '/pay/qr.png',
        payee: config.pay.manualPayee,
        expiresAt,
      })
      return
    }

    const returnUrl = config.publicOrigin ? `${config.publicOrigin}/pay/return` : ''
    const payUrl = alipay.buildWapPayUrl({
      outTradeNo: id,
      amountCny: amount,
      subject: 'FreeSeek 余额充值',
      returnUrl,
    })
    sendJson(res, 201, { id, amountCny: amount, status: 'pending', payUrl, expiresAt })
  }

  const creditOrder = (orderId, info) => creditOrderDb(db, orderId, info)

  const orderStatus = async (req, res, id) => {
    const session = sessionOf(req)
    if (!session) return sendError(res, 401, '登录已过期，请重新登录', 'unauthorized')
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, session.user_id)
    if (!order) return sendError(res, 404, '订单不存在', 'not_found')
    sendJson(res, 200, {
      id: order.id,
      status: order.status,
      amountCny: order.amount_micro / 1_000_000,
      paidAt: order.paid_at,
    })
  }

  /** 用户从支付宝回来点「我已完成支付」：主动查单，不依赖 notify 是否及时 */
  const confirmOrder = async (req, res, id) => {
    const session = sessionOf(req)
    if (!session) return sendError(res, 401, '登录已过期，请重新登录', 'unauthorized')
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, session.user_id)
    if (!order) return sendError(res, 404, '订单不存在', 'not_found')
    if (order.status === 'paid') {
      return sendJson(res, 200, { status: 'paid', amountCny: order.amount_micro / 1_000_000 })
    }
    if (config.pay.provider === 'mock') {
      const result = creditOrder(order.id, {})
      return sendJson(res, 200, { status: 'paid', amountCny: result.amountMicro / 1_000_000 })
    }
    if (config.pay.provider === 'manual') {
      // 线下收款：默认等运营者导入账单；本地联调可开启 ALLOW_DEV_CONFIRM
      if (config.allowDevConfirm) {
        const result = creditOrder(order.id, {})
        return sendJson(res, 200, { status: 'paid', amountCny: result.amountMicro / 1_000_000 })
      }
      return sendJson(res, 200, { status: order.status })
    }
    const query = await alipay.query(order.id)
    if (!query.ok) {
      return sendError(res, 502, query.message ?? '查单失败', 'query_failed')
    }
    if (query.tradeStatus !== 'TRADE_SUCCESS' && query.tradeStatus !== 'TRADE_FINISHED') {
      return sendJson(res, 200, { status: 'pending', tradeStatus: query.tradeStatus ?? '' })
    }
    const result = creditOrder(order.id, query)
    sendJson(res, 200, { status: 'paid', amountCny: result.amountMicro / 1_000_000 })
  }

  const notify = async (req, res) => {
    if (config.pay.provider !== 'alipay') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('success')
      return
    }
    const params = Object.fromEntries((await readForm(req, 64 * 1024)).entries())
    const verified = alipay.verifyNotify(params)
    if (!verified.ok) {
      // 验签失败不写库，也不回 success，支付宝会重试
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('failure')
      return
    }
    try {
      creditOrder(verified.outTradeNo, verified)
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('success')
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('failure')
      console.warn('[pay] 入账失败', error.message)
    }
  }

  const payReturn = (res) => {
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>支付完成</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f7f7f8;font-family:system-ui,-apple-system,'PingFang SC',sans-serif;color:#1a1a1a">
<div style="text-align:center;padding:32px">
<div style="font-size:48px;line-height:1">✅</div>
<h1 style="font-size:20px;margin:16px 0 8px">支付完成</h1>
<p style="margin:0;color:#666;font-size:14px">请返回 FreeSeek，余额会自动到账</p>
</div></body></html>`
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(html)
  }

  // ---------- 上游转发 ----------
  /** 解析 SSE 用量：边转发边统计，结束时计费 */
  const messages = async (req, res) => {
    const session = sessionOf(req)
    if (!session) return sendError(res, 401, '登录已过期，请重新登录', 'unauthorized')
    if (session.balance_micro <= 0) {
      return sendError(res, 402, '余额不足，请先充值', 'insufficient_balance')
    }
    if (!msgLimiter.take(session.user_id)) {
      return sendError(res, 429, '发送过于频繁，请稍后再试', 'rate_limited')
    }

    const raw = await new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > config.maxBodyBytes) {
          reject(Object.assign(new Error('请求体过大'), { status: 413 }))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    }).catch((error) => {
      sendError(res, error.status ?? 400, error.message)
      return null
    })
    if (raw === null) {
      return
    }

    const startedAt = Date.now()
    let model = 'deepseek-model'
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed.model === 'string') {
        model = parsed.model
      }
    } catch {
      return sendError(res, 400, '请求体不是合法 JSON', 'invalid_json')
    }

    const upstreamController = new AbortController()
    // 只有客户端提前断开才中止上游；正常结束（writableEnded）不要 abort
    res.on('close', () => {
      if (!res.writableEnded) {
        upstreamController.abort()
      }
    })

    let response
    try {
      response = await upstream.request('/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(req.headers['anthropic-beta']
            ? { 'anthropic-beta': req.headers['anthropic-beta'] }
            : {}),
        },
        body: Buffer.from(raw),
        signal: upstreamController.signal,
      })
    } catch (error) {
      if (!res.headersSent) {
        sendError(res, 502, `上游连接失败：${error.message}`, 'upstream_error')
      }
      return
    }

    if (response.status !== 200 || !response.body) {
      res.writeHead(response.status, {
        'Content-Type': response.headers.get('content-type') ?? 'application/json',
        'Cache-Control': 'no-store',
      })
      if (response.body) {
        Readable.fromWeb(response.body).pipe(res)
      } else {
        res.end()
      }
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const usage = {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      searches: 0,
    }
    let seen = false
    let settled = false
    const settle = () => {
      if (settled) {
        return
      }
      settled = true
      if (!seen) {
        return
      }
      try {
        billUsage(session.user_id, usage, startedAt)
      } catch (error) {
        console.warn('[billing] 记账失败', error.message)
      }
    }

    const onData = (text) => {
      let index
      while ((index = text.indexOf('\n\n')) >= 0) {
        const block = text.slice(0, index)
        text = text.slice(index + 2)
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) {
            continue
          }
          let event
          try {
            event = JSON.parse(line.slice(5).trim())
          } catch {
            continue
          }
          if (event.type === 'message_start' && event.message?.usage) {
            const u = event.message.usage
            usage.input = u.input_tokens ?? 0
            usage.cacheRead = u.cache_read_input_tokens ?? 0
            usage.cacheWrite = u.cache_creation_input_tokens ?? 0
            seen = true
          } else if (event.type === 'message_delta') {
            if (event.usage) {
              usage.output = event.usage.output_tokens ?? usage.output
              usage.searches =
                event.usage.server_tool_use?.web_search_requests ?? usage.searches
              seen = true
            }
          }
        }
      }
      return text
    }

    let buffer = ''
    try {
      for await (const chunk of Readable.fromWeb(response.body)) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
        // 只解析一份副本，原样转发给客户端
        buffer = onData(buffer + text)
        if (!res.write(chunk)) {
          await new Promise((resolve) => res.once('drain', resolve))
        }
      }
    } catch (error) {
      if (!upstreamController.signal.aborted) {
        console.warn('[proxy] 流中断', error.message)
      }
    } finally {
      settle()
      res.end()
    }
  }

  /** Files/TTS/ASR：原样转发二进制请求体，不落盘 */
  const forwardBinary = async (req, res, path, { method = 'POST' } = {}) => {
    const session = sessionOf(req)
    if (!session) return sendError(res, 401, '登录已过期，请重新登录', 'unauthorized')
    if (session.balance_micro <= 0) {
      return sendError(res, 402, '余额不足，请先充值', 'insufficient_balance')
    }

    if (path.startsWith('/v1/tools/')) {
      const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
      const row = tx(db, () => {
        db.prepare(
          'INSERT INTO voice_usage (user_id, day, count) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1'
        ).run(session.user_id, day)
        return db
          .prepare('SELECT count FROM voice_usage WHERE user_id = ? AND day = ?')
          .get(session.user_id, day)
      })
      if (row.count > config.voiceDailyQuota) {
        return sendError(
          res,
          429,
          `语音接口每日限 ${config.voiceDailyQuota} 次，请明天再试`,
          'voice_quota_exceeded'
        )
      }
    }

    const headers = {
      ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}),
      ...(req.headers['anthropic-beta'] ? { 'anthropic-beta': req.headers['anthropic-beta'] } : {}),
      ...(req.headers.accept ? { Accept: req.headers.accept } : {}),
    }
    let response
    try {
      response = await upstream.request(path, { method, headers, body: req })
    } catch (error) {
      return sendError(res, 502, `上游连接失败：${error.message}`, 'upstream_error')
    }
    res.writeHead(response.status, {
      'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    if (response.body) {
      Readable.fromWeb(response.body).pipe(res)
    } else {
      res.end()
    }
  }

  // ---------- 路由分发 ----------
  return async (req, res) => {
    try {
      if (applyCors(req, res, config.allowedOrigins)) {
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname
      const method = req.method ?? 'GET'

      if (path === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          mockUpstream: config.mockUpstream,
          payProvider: config.pay.provider,
        })
      }
      if (path === '/api/config') {
        return sendJson(res, 200, {
          payProvider: config.pay.provider,
          mockUpstream: config.mockUpstream,
          markup: config.markup,
          topupMin: config.pay.minCny,
          topupMax: config.pay.maxCny,
          manualPayee: config.pay.manualPayee,
          manualQr: config.pay.provider === 'manual' ? '/pay/qr.png' : '',
        })
      }
      if (path === '/api/auth/register' && method === 'POST') {
        if (!authLimiter.take(clientIp(req))) {
          return sendError(res, 429, '请求过于频繁，请稍后再试', 'rate_limited')
        }
        return await register(req, res)
      }
      if (path === '/api/auth/login' && method === 'POST') {
        if (!authLimiter.take(clientIp(req))) {
          return sendError(res, 429, '请求过于频繁，请稍后再试', 'rate_limited')
        }
        return await login(req, res)
      }
      if (path === '/api/auth/logout' && method === 'POST') return await logout(req, res)
      if (path === '/api/me' && method === 'GET') return await me(req, res)
      if (path === '/api/billing/ledger' && method === 'GET') return await ledger(req, res)
      if (path === '/api/billing/redeem' && method === 'POST') {
        if (!redeemLimiter.take(clientIp(req))) {
          return sendError(res, 429, '请求过于频繁，请稍后再试', 'rate_limited')
        }
        return await redeem(req, res)
      }
      if (path === '/api/pay/orders' && method === 'POST') return await createOrder(req, res)
      if (path === '/api/pay/notify' && method === 'POST') return await notify(req, res)
      if (path === '/pay/return' && method === 'GET') return payReturn(res)
      if (path === '/pay/qr.png' && method === 'GET') {
        if (config.pay.provider !== 'manual') {
          return sendError(res, 404, 'not found')
        }
        try {
          const image = readFileSync(config.pay.manualQrFile)
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': image.length,
            'Cache-Control': 'public, max-age=3600',
          })
          return res.end(image)
        } catch {
          return sendError(res, 404, '收款码未配置')
        }
      }

      const orderMatch = /^\/api\/pay\/orders\/([A-Za-z0-9]+)$/.exec(path)
      if (orderMatch) {
        return await orderStatus(req, res, orderMatch[1])
      }
      const confirmMatch = /^\/api\/pay\/orders\/([A-Za-z0-9]+)\/confirm$/.exec(path)
      if (confirmMatch && method === 'POST') {
        return await confirmOrder(req, res, confirmMatch[1])
      }
      const devMatch = /^\/api\/pay\/dev\/([A-Za-z0-9]+)\/confirm$/.exec(path)
      if (devMatch && method === 'POST') {
        const allowed = config.pay.provider === 'mock' || config.allowDevConfirm
        if (!allowed) {
          return sendError(res, 404, 'not found')
        }
        return await confirmOrder(req, res, devMatch[1])
      }

      if (path === '/anthropic/v1/messages' && method === 'POST') {
        return await messages(req, res)
      }
      if (path === '/anthropic/v1/files' && method === 'POST') {
        return await forwardBinary(req, res, '/anthropic/v1/files')
      }
      const fileMatch = /^\/anthropic\/v1\/files\/([A-Za-z0-9_-]+)$/.exec(path)
      if (fileMatch && method === 'DELETE') {
        return await forwardBinary(req, res, `/anthropic/v1/files/${fileMatch[1]}`, {
          method: 'DELETE',
        })
      }
      if (path === '/v1/tools/asr' && method === 'POST') {
        return await forwardBinary(req, res, '/v1/tools/asr')
      }
      if (path === '/v1/tools/tts' && method === 'POST') {
        return await forwardBinary(req, res, '/v1/tools/tts')
      }

      if (method === 'GET' && serveStatic(config.staticDir, req, res)) {
        return
      }
      sendError(res, 404, 'not found')
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      sendError(res, error.status ?? 500, error.message ?? 'internal error')
    }
  }
}

