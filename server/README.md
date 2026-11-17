# FreeSeek 服务端

账号、余额、计费与上游转发。**上游 Key 只在这里，客户端只拿到会话令牌；服务端不保存任何对话内容。**

## 为什么需要它

App 默认是「自带 API Key」的纯本地客户端，不需要服务端。只有开启「账号登录 + 余额付费」时才需要部署这个服务：

- 用户注册 / 登录 → 拿到会话令牌
- 每次对话请求带上令牌，服务端换成你的上游 Key 转发给 DeepSeek
- 服务端解析流式响应里的 token 用量，按 **官方价 × 1.1** 从余额扣费
- 余额不足返回 402，客户端提示充值
- 充值：手机网站支付（直接跳支付宝），或后台发卡密

## 快速开始（本地联调，不花钱）

```sh
cd server
cp .env.example .env        # 填 MOCK_UPSTREAM=1、PAY_PROVIDER=mock
node src/index.js
```

`MOCK_UPSTREAM=1` 时上游返回固定回复（不产生真实费用），`PAY_PROVIDER=mock` 时 App 里显示「模拟支付」按钮，可以直接跑通完整链路。

启动后：

```sh
curl -s localhost:8787/api/health
```

## 生产部署

```sh
# 1. 真实上游
DEEPSEEK_API_KEY=sk-xxx
PRICE_MARKUP=1.1
PUBLIC_ORIGIN=https://api.your-domain.com

# 2. 支付宝手机网站支付
PAY_PROVIDER=alipay
ALIPAY_APP_ID=2021...
ALIPAY_PRIVATE_KEY_FILE=./secrets/alipay_private_key.pem
ALIPAY_PUBLIC_KEY_FILE=./secrets/alipay_public_key.pem
ALIPAY_NOTIFY_URL=https://api.your-domain.com/api/pay/notify

# 3. 启动（建议 docker compose）
docker compose up -d
```

反向代理（Caddy 示例，自动 HTTPS）：

```caddyfile
api.your-domain.com {
  reverse_proxy 127.0.0.1:8787
}
```

**必须走 HTTPS**：令牌与支付宝通知都在请求里，明文 HTTP 一律不要用。

## 收款方式（按资质选）

| 方式 | 需要资质 | 用户体验 | 到账 |
| --- | --- | --- | --- |
| `mock` | 无 | 本地联调用「模拟支付」 | 立即 |
| `alipay`（手机网站支付） | 支付宝商户号 | 最好：App 内点一下直接唤起支付宝 | 异步通知，秒级 |
| `manual`（个人收款码） | **无需资质** | 扫码付款并在备注填订单号 | 运营者导入账单后自动核销（分钟级） |
| 卡密 | 无 | 在发卡平台购买后回 App 兑换 | 立即 |

### 个人收款码（manual）怎么配

1. 把个人收款码图片放到 `server/secrets/pay-qr.png`，或设置 `MANUAL_QR_URL` 指向图片地址
2. `PAY_PROVIDER=manual`、`MANUAL_PAYEE=支付宝：你的名字`
3. 用户在 App 里下单后看到收款码 + 订单号，付款时把订单号填进「备注」
4. 你隔一段时间导入支付宝账单，按备注自动核销：

```sh
node scripts/admin.js import-bill 支付宝账单.csv
```

支付宝 App →「我的」→「账单」→ 右上角导出账单，收到的 CSV 直接导入即可（GBK 编码原生支持）。
单笔临时到账也可以 `node scripts/admin.js confirm-order FS...` 手动确认。

> 个人收款码没有支付回调，所以是「半自动」：用户的便利性来自扫码 + 备注，你的工作量只有定期导账单。

## 计费口径

- 单价：DeepSeek 官方刊例价（元 / 百万 tokens），高峰/空闲按北京时间工作日 9–12、14–18 区分
- 加价：`PRICE_MARKUP`（默认 1.1）
- 账本以「微元」整数记账，避免浮点误差
- 附件（Files API）本身不计费，但会作为输入 token 计入对话费用
- 语音（ASR/TTS）没有 token 计费口径：**不收费，按 `VOICE_DAILY_QUOTA` 每日限次**

## 安全设计

| 项 | 做法 |
| --- | --- |
| 上游 Key | 只存在服务端环境变量/文件，客户端永远拿不到 |
| 密码 | Node 内置 scrypt（N=16384）加盐哈希 |
| 会话令牌 | 随机 32 字节，数据库只存 SHA-256；退出登录即删除 |
| 对话内容 | **不落盘、不写日志**；请求体只在内存中转发 |
| 支付 | RSA2 签名；异步通知验签 + 校验 app_id / 订单号 / 金额；订单状态原子流转防重复入账 |
| 限流 | 登录/注册按 IP、对话按用户、语音按日配额 |
| CORS | 仅回显白名单来源（手机 App 为 `https://localhost`） |
| 越权 | 订单、账单都按 user_id 过滤 |

## 运维命令

```sh
node scripts/admin.js users                 # 用户与余额
node scripts/admin.js credit alice 10 补偿   # 手动加款
node scripts/admin.js create-code 10 5      # 生成 5 张 10 元卡密
node scripts/admin.js codes
node scripts/admin.js disable <用户名> 1
```

卡密在 App 的「账号」页兑换。

## 测试

```sh
node --test          # 22 项：鉴权、计费、幂等、支付验签、不保存对话等
```

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | 注册，返回令牌 |
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/logout` | 退出（删除会话） |
| GET | `/api/me` | 当前用户与余额 |
| GET | `/api/billing/ledger` | 最近 50 条账单 |
| POST | `/api/billing/redeem` | 兑换卡密 |
| POST | `/api/pay/orders` | 创建充值订单（返回支付宝收银台 URL） |
| GET | `/api/pay/orders/:id` | 订单状态 |
| POST | `/api/pay/orders/:id/confirm` | 主动查单确认 |
| POST | `/api/pay/notify` | 支付宝异步通知（验签） |
| POST | `/anthropic/v1/messages` | 对话（流式，计费） |
| POST | `/anthropic/v1/files` | 附件上传（转发） |
| POST | `/v1/tools/asr` · `/v1/tools/tts` | 语音（转发，限次） |
