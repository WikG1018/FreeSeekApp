/**
 * 服务端配置：全部来自环境变量，启动时校验关键项。
 * 生产环境必须设置 DEEPSEEK_API_KEY、ADMIN_TOKEN 与 HTTPS 反向代理。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const env = process.env

const readSecret = (value, file) => {
  if (value) {
    return value
  }
  if (file) {
    try {
      return readFileSync(resolve(file), 'utf8').trim()
    } catch {
      return ''
    }
  }
  return ''
}

const num = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const list = (value, fallback) =>
  (value ?? fallback)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

export const config = {
  /** 监听地址：默认只监听本机，由 Caddy/Nginx 反代并提供 HTTPS */
  host: env.HOST ?? '127.0.0.1',
  port: num(env.PORT, 8787),
  /** 静态站点目录（可选）：与 API 同源部署时直接托管 dist/ */
  staticDir: env.STATIC_DIR ? resolve(env.STATIC_DIR) : '',
  dbPath: resolve(env.DB_PATH ?? './data/freeseek.db'),
  /** 对外地址（如 https://api.example.com）：用于支付回跳页 /pay/return */
  publicOrigin: (env.PUBLIC_ORIGIN ?? '').replace(/\/$/, ''),

  /** 上游：DeepSeek 官方 API；密钥只存在服务端，永不下发客户端 */
  upstreamOrigin: env.UPSTREAM_ORIGIN ?? 'https://api.deepseek.com',
  upstreamKey: readSecret(env.DEEPSEEK_API_KEY, env.DEEPSEEK_API_KEY_FILE),
  /** 本地联调用：不访问上游，返回固定流式回复（不产生费用） */
  mockUpstream: env.MOCK_UPSTREAM === '1',

  /** 对用户的加价倍率：官方价 × 1.1 */
  markup: num(env.PRICE_MARKUP, 1.1),
  /** 会话有效期（天） */
  sessionDays: num(env.SESSION_DAYS, 30),
  /** 语音接口每日次数上限（ASR/TTS 无 token 计费口径，用配额防滥用） */
  voiceDailyQuota: num(env.VOICE_DAILY_QUOTA, 200),
  /** 单条消息请求体上限（字节） */
  maxBodyBytes: num(env.MAX_BODY_BYTES, 4 * 1024 * 1024),
  /** 每用户每分钟消息请求上限 */
  messagesPerMinute: num(env.MESSAGES_PER_MINUTE, 30),
  /** 登录/注册每 IP 每分钟上限 */
  authPerMinute: num(env.AUTH_PER_MINUTE, 10),

  /** 允许的浏览器来源：Capacitor 安卓为 https://localhost，iOS 为 capacitor://localhost */
  allowedOrigins: list(
    env.ALLOWED_ORIGINS,
    'https://localhost,capacitor://localhost,http://localhost:8090,http://localhost:8091,http://127.0.0.1:8091'
  ),

  /** 管理口令：CLI 之外的 HTTP 管理接口使用；为空则关闭 HTTP 管理 */
  adminToken: readSecret(env.ADMIN_TOKEN, env.ADMIN_TOKEN_FILE),

  pay: {
    /** mock：本地联调（页面显示「模拟支付」按钮）；alipay：当面付预下单 */
    provider: env.PAY_PROVIDER === 'alipay' ? 'alipay' : 'mock',
    appId: env.ALIPAY_APP_ID ?? '',
    privateKey: readSecret(env.ALIPAY_PRIVATE_KEY, env.ALIPAY_PRIVATE_KEY_FILE),
    publicKey: readSecret(env.ALIPAY_PUBLIC_KEY, env.ALIPAY_PUBLIC_KEY_FILE),
    gateway: env.ALIPAY_GATEWAY ?? 'https://openapi.alipay.com/gateway.do',
    notifyUrl: env.ALIPAY_NOTIFY_URL ?? '',
    /** 充值金额范围（元） */
    minCny: num(env.TOPUP_MIN_CNY, 1),
    maxCny: num(env.TOPUP_MAX_CNY, 2000),
    /** 订单有效期（分钟） */
    orderMinutes: num(env.ORDER_MINUTES, 30),
  },
}

/** 启动前校验：生产模式缺关键配置直接报错，避免带病上线 */
export const assertConfig = () => {
  const problems = []
  if (!config.mockUpstream && !config.upstreamKey) {
    problems.push('缺少 DEEPSEEK_API_KEY（或 DEEPSEEK_API_KEY_FILE）')
  }
  if (config.pay.provider === 'alipay') {
    if (!config.pay.appId) problems.push('缺少 ALIPAY_APP_ID')
    if (!config.pay.privateKey) problems.push('缺少 ALIPAY_PRIVATE_KEY')
    if (!config.pay.publicKey) problems.push('缺少 ALIPAY_PUBLIC_KEY')
    if (!config.pay.notifyUrl) problems.push('缺少 ALIPAY_NOTIFY_URL')
  }
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.staticDir) {
    // 只是提示：真实部署应放在 HTTPS 反代之后
    console.warn('[warn] 正在监听非本机地址，请确保前面有 HTTPS 反向代理')
  }
  if (problems.length > 0) {
    throw new Error(`配置不完整：\n- ${problems.join('\n- ')}`)
  }
}
