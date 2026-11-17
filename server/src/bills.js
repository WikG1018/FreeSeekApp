/**
 * 个人收款码对账：导入支付宝导出的账单 CSV，按「备注里的订单号」自动核销。
 *
 * 为什么需要：没有商户资质时，支付宝/微信个人收款码没有异步回调，
 * 只能靠用户付款时在备注里填订单号，再拿账单来匹配。支付宝账单是 GBK 编码，
 * Node 的 TextDecoder 原生支持。
 */
import { readFileSync } from 'node:fs'
import { creditOrder } from './orders.js'

const ORDER_ID = /FS[0-9A-F]{8,}/i

/** 解码：优先 UTF-8（微信账单），失败则按 GBK（支付宝账单） */
export const decodeBill = (buffer) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder('gbk').decode(buffer)
  }
}

/** 极简 CSV 解析：支持引号包裹与逗号转义 */
export const parseCsv = (text) => {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/**
 * 从支付宝账单里提取「收款成功且备注含订单号」的记录。
 * 只认「收」「交易成功/交易完成」，其余（退款、支出、关闭）忽略。
 */
export const parseAlipayBill = (buffer) => {
  const rows = parseCsv(decodeBill(buffer))
  const headerIndex = rows.findIndex((row) => row.some((cell) => cell.includes('交易号')))
  if (headerIndex < 0) {
    return []
  }
  const header = rows[headerIndex].map((cell) => cell.trim())
  const column = (...names) => {
    for (const name of names) {
      const index = header.findIndex((cell) => cell === name || cell.includes(name))
      if (index >= 0) {
        return index
      }
    }
    return -1
  }
  const idx = {
    tradeNo: column('交易号'),
    orderNo: column('商家订单号'),
    amount: column('金额（元）', '金额(元)', '金额'),
    direction: column('收/支'),
    status: column('交易状态'),
    note: column('备注', '商品名称', '商品说明'),
  }
  if (idx.amount < 0 || idx.status < 0) {
    return []
  }
  const results = []
  for (const row of rows.slice(headerIndex + 1)) {
    const cell = (index) => (index >= 0 ? (row[index] ?? '').trim() : '')
    const status = cell(idx.status)
    const direction = cell(idx.direction)
    if (!/交易成功|交易完成|已收款/.test(status)) {
      continue
    }
    if (direction && direction !== '收') {
      continue
    }
    const text = `${cell(idx.note)} ${cell(idx.orderNo)}`
    const match = ORDER_ID.exec(text)
    if (!match) {
      continue
    }
    const amount = Number(cell(idx.amount).replace(/[^\d.]/g, ''))
    if (!Number.isFinite(amount) || amount <= 0) {
      continue
    }
    results.push({
      orderId: match[0].toUpperCase(),
      amount,
      tradeNo: cell(idx.tradeNo) || undefined,
    })
  }
  return results
}

/**
 * 用账单记录核销订单：金额一致才入账，返回逐条结果。
 * 重复导入是安全的（creditOrder 幂等）。
 */
export const reconcileBill = (db, records) =>
  records.map((record) => {
    try {
      const result = creditOrder(db, record.orderId, {
        tradeNo: record.tradeNo,
        totalAmount: record.amount,
      })
      return { ...record, ok: true, already: result.already, amountMicro: result.amountMicro }
    } catch (error) {
      return { ...record, ok: false, reason: error.message }
    }
  })

/** 便捷入口：读文件 → 解析 → 核销 */
export const reconcileBillFile = (db, file) =>
  reconcileBill(db, parseAlipayBill(readFileSync(file)))
