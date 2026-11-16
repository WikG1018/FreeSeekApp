import { createServer } from 'node:http'
import { assertConfig, config } from './config.js'
import { openDb } from './db.js'
import { createUpstream } from './upstream.js'
import { createAlipay } from './alipay.js'
import { createApp } from './app.js'

assertConfig()

const db = openDb(config.dbPath)
const upstream = createUpstream(config)
const alipay =
  config.pay.provider === 'alipay'
    ? createAlipay(config.pay)
    : { buildWapPayUrl: () => '', query: async () => ({ ok: false }), verifyNotify: () => ({ ok: false }) }
const app = createApp({ config, db, upstream, alipay })

const server = createServer(app)
server.listen(config.port, config.host, () => {
  const mode = config.mockUpstream ? 'mock 上游（不产生费用）' : '真实上游'
  console.log(`[freeseek-server] http://${config.host}:${config.port} · ${mode} · 支付=${config.pay.provider}`)
  if (config.host !== '127.0.0.1' && !config.publicOrigin) {
    console.warn('[freeseek-server] 未设置 PUBLIC_ORIGIN，支付回跳页地址将不可用')
  }
})

const shutdown = () => {
  server.close(() => {
    db.close()
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
