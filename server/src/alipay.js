/**
 * 支付宝开放平台（RSA2 签名，无 SDK 依赖）。只做手机版需要的两种能力：
 * - 手机网站支付 alipay.trade.wap.pay：返回可直接打开的收银台 URL（唤起支付宝 App）
 * - alipay.trade.query：用户回到 App 后主动查单确认
 * - 异步通知验签：只有验签通过的 notify 才会入账
 * 不做当面付二维码（那是网页/桌面形态）。
 */
import { createPrivateKey, createPublicKey, createSign, createVerify } from 'node:crypto'

const toPem = (key, type) => {
  const trimmed = String(key).trim()
  if (trimmed.includes('BEGIN')) {
    return trimmed
  }
  const header = type === 'private' ? 'PRIVATE KEY' : 'PUBLIC KEY'
  const lines = trimmed.replace(/\s+/g, '').match(/.{1,64}/g) ?? []
  return `-----BEGIN ${header}-----\n${lines.join('\n')}\n-----END ${header}-----`
}

/** 待签名字符串：参数按 key 升序，去掉空值与指定字段，值不编码 */
const signString = (params, excluded = ['sign']) => {
  return Object.keys(params)
    .filter((key) => !excluded.includes(key))
    .filter((key) => {
      const value = params[key]
      return value !== undefined && value !== null && String(value) !== ''
    })
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&')
}

export const signParams = (params, privateKey, excluded = ['sign']) => {
  const signer = createSign('RSA-SHA256')
  signer.update(signString(params, excluded), 'utf8')
  return signer.sign(createPrivateKey(toPem(privateKey, 'private')), 'base64')
}

export const verifyParams = (params, publicKey, excluded = ['sign', 'sign_type']) => {
  if (!params.sign) {
    return false
  }
  const verifier = createVerify('RSA-SHA256')
  verifier.update(signString(params, excluded), 'utf8')
  try {
    return verifier.verify(createPublicKey(toPem(publicKey, 'public')), params.sign, 'base64')
  } catch {
    return false
  }
}

/** 北京时间 'YYYY-MM-DD HH:mm:ss' */
const timestamp = () => {
  const now = new Date(Date.now() + 8 * 3600_000).toISOString()
  return `${now.slice(0, 10)} ${now.slice(11, 19)}`
}

const commonParams = (pay, method) => ({
  app_id: pay.appId,
  method,
  format: 'JSON',
  charset: 'utf-8',
  sign_type: 'RSA2',
  timestamp: timestamp(),
  version: '1.0',
})

const formBody = (params) =>
  Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')

/** 从响应里取出业务节点 */
const parseGatewayResponse = (text, node) => {
  let json
  try {
    json = JSON.parse(text)
  } catch {
    return { error: '支付网关返回了非 JSON 内容' }
  }
  const payload = json[node]
  if (!payload) {
    return { error: json.error?.msg ?? '支付网关返回异常' }
  }
  return { payload }
}

export const createAlipay = (pay, fetchImpl = fetch) => {
  const post = async (method, bizContent, extra = {}) => {
    const params = {
      ...commonParams(pay, method),
      ...extra,
      biz_content: JSON.stringify(bizContent),
    }
    params.sign = signParams(params, pay.privateKey)
    const response = await fetchImpl(pay.gateway, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: formBody(params),
    })
    return response.text()
  }

  /**
   * 手机网站支付：返回可直接在浏览器/WebView 打开的收银台地址。
   * 支付宝会先尝试唤起支付宝 App，未安装则进入 H5 收银台。
   */
  const buildWapPayUrl = ({ outTradeNo, amountCny, subject, returnUrl }) => {
    const params = {
      ...commonParams(pay, 'alipay.trade.wap.pay'),
      notify_url: pay.notifyUrl,
      ...(returnUrl ? { return_url: returnUrl } : {}),
      biz_content: JSON.stringify({
        out_trade_no: outTradeNo,
        total_amount: amountCny.toFixed(2),
        subject,
        product_code: 'QUICK_WAP_WAY',
      }),
    }
    params.sign = signParams(params, pay.privateKey)
    return `${pay.gateway}?${formBody(params)}`
  }

  /** 查单：用户从支付宝回到 App 后主动确认 */
  const query = async (outTradeNo) => {
    const text = await post('alipay.trade.query', { out_trade_no: outTradeNo })
    const parsed = parseGatewayResponse(text, 'alipay_trade_query_response')
    if (parsed.error) {
      return { ok: false, message: parsed.error }
    }
    return {
      ok: true,
      tradeStatus: parsed.payload.trade_status,
      tradeNo: parsed.payload.trade_no,
      totalAmount: parsed.payload.total_amount,
    }
  }

  /** 异步通知验签：成功才返回订单信息 */
  const verifyNotify = (params) => {
    if (!verifyParams(params, pay.publicKey)) {
      return { ok: false, reason: '签名校验失败' }
    }
    if (params.app_id !== pay.appId) {
      return { ok: false, reason: 'app_id 不匹配' }
    }
    const status = params.trade_status
    if (status !== 'TRADE_SUCCESS' && status !== 'TRADE_FINISHED') {
      return { ok: false, reason: `交易状态 ${status}` }
    }
    return {
      ok: true,
      outTradeNo: params.out_trade_no,
      totalAmount: Number(params.total_amount),
      tradeNo: params.trade_no,
    }
  }

  return { buildWapPayUrl, query, verifyNotify }
}
