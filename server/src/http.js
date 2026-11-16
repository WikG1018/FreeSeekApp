/** 轻量 HTTP 工具：JSON 读写、CORS、限流、静态文件 */
import { createReadStream, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

export const sendJson = (res, status, data, headers = {}) => {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(body)
}

/** 统一错误体：与 Anthropic 兼容（客户端只读 error.message） */
export const sendError = (res, status, message, code = '') => {
  sendJson(res, status, { error: { message, ...(code ? { code } : {}) } })
}

export const readJson = (req, limit) =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })

export const readForm = (req, limit) =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))))
    req.on('error', reject)
  })

/** CORS：只回显白名单内的来源，不做通配 */
export const applyCors = (req, res, allowedOrigins) => {
  const origin = req.headers.origin
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-api-key, anthropic-beta, anthropic-version')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Max-Age', '86400')
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(origin && allowedOrigins.includes(origin) ? 204 : 403)
    res.end()
    return true
  }
  return false
}

export const clientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim()
  }
  return req.socket.remoteAddress ?? 'unknown'
}

/** 滑动窗口限流：内存实现，单实例足够；多实例部署请换 Redis */
export class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit
    this.windowMs = windowMs
    this.hits = new Map()
  }

  /** 返回 true 表示允许，false 表示超限 */
  take(key) {
    const now = Date.now()
    const list = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs)
    if (list.length >= this.limit) {
      this.hits.set(key, list)
      return false
    }
    list.push(now)
    this.hits.set(key, list)
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) {
        if (v.every((at) => now - at >= this.windowMs)) {
          this.hits.delete(k)
        }
      }
    }
    return true
  }
}

/** 静态站点：只读、防目录穿越、不做缓存头 */
export const serveStatic = (root, req, res) => {
  if (!root) {
    return false
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  let pathname = decodeURIComponent(url.pathname)
  if (pathname.endsWith('/')) {
    pathname += 'index.html'
  }
  const target = normalize(join(root, pathname))
  if (!target.startsWith(normalize(root))) {
    sendError(res, 403, 'forbidden')
    return true
  }
  try {
    const stat = statSync(target)
    if (!stat.isFile()) {
      return false
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    })
    createReadStream(target).pipe(res)
    return true
  } catch {
    return false
  }
}
