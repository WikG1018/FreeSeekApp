import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { createAlipay, signParams, verifyParams } from '../src/alipay.js'

const keypair = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

test('RSA2 签名与验签往返；篡改参数验签失败', () => {
  const { publicKey, privateKey } = keypair()
  const params = {
    app_id: '2021000000000000',
    method: 'alipay.trade.wap.pay',
    biz_content: '{"out_trade_no":"FS1","total_amount":"10.00"}',
    sign_type: 'RSA2',
  }
  params.sign = signParams(params, privateKey)
  assert.equal(verifyParams(params, publicKey, ['sign']), true)

  const tampered = { ...params, biz_content: '{"out_trade_no":"FS1","total_amount":"1.00"}' }
  assert.equal(verifyParams(tampered, publicKey, ['sign']), false)
})

test('手机网站支付 URL：包含签名与必要参数，不含二维码', () => {
  const { privateKey } = keypair()
  const alipay = createAlipay({
    appId: '2021000000000000',
    privateKey,
    publicKey: '',
    gateway: 'https://openapi.alipay.com/gateway.do',
    notifyUrl: 'https://api.example.com/api/pay/notify',
  })
  const url = alipay.buildWapPayUrl({
    outTradeNo: 'FS123',
    amountCny: 10,
    subject: 'FreeSeek 余额充值',
    returnUrl: 'https://api.example.com/pay/return',
  })
  assert.match(url, /method=alipay\.trade\.wap\.pay/)
  assert.match(url, /sign=/)
  assert.match(url, /sign_type=RSA2/)
  assert.match(url, /notify_url=/)
  assert.match(url, /return_url=/)
  assert.match(url, /product_code%22%3A%22QUICK_WAP_WAY/)
  assert.ok(!url.includes('precreate'))
})

test('异步通知验签：签名正确且状态成功才通过', () => {
  const { publicKey, privateKey } = keypair()
  const alipay = createAlipay({
    appId: '2021000000000000',
    privateKey,
    publicKey,
    gateway: '',
    notifyUrl: '',
  })
  const notify = {
    app_id: '2021000000000000',
    out_trade_no: 'FS123',
    trade_no: '2026111722001',
    trade_status: 'TRADE_SUCCESS',
    total_amount: '10.00',
    sign_type: 'RSA2',
  }
  notify.sign = signParams(notify, privateKey, ['sign', 'sign_type'])
  const ok = alipay.verifyNotify(notify)
  assert.equal(ok.ok, true)
  assert.equal(ok.outTradeNo, 'FS123')
  assert.equal(ok.totalAmount, 10)

  const wrongStatus = { ...notify, trade_status: 'WAIT_BUYER_PAY' }
  wrongStatus.sign = signParams(wrongStatus, privateKey, ['sign', 'sign_type'])
  assert.equal(alipay.verifyNotify(wrongStatus).ok, false)

  const tampered = { ...notify, total_amount: '0.01' }
  assert.equal(alipay.verifyNotify(tampered).ok, false)
})

test('查单：TRADE_SUCCESS 返回成功状态', async () => {
  const { privateKey } = keypair()
  const alipay = createAlipay(
    {
      appId: '2021000000000000',
      privateKey,
      publicKey: '',
      gateway: 'https://gateway.example.com',
      notifyUrl: '',
    },
    async () =>
      new Response(
        JSON.stringify({
          alipay_trade_query_response: {
            code: '10000',
            trade_status: 'TRADE_SUCCESS',
            trade_no: '2026111722001',
            total_amount: '10.00',
            out_trade_no: 'FS123',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
  )
  const result = await alipay.query('FS123')
  assert.equal(result.ok, true)
  assert.equal(result.tradeStatus, 'TRADE_SUCCESS')
  assert.equal(result.tradeNo, '2026111722001')
})
