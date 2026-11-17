/** 订单入账：状态原子流转，重复回调/重复导入不会重复加钱 */
import { applyBalanceTx, tx } from './db.js'
import { toMicro } from './pricing.js'

export const getOrder = (db, id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id)

/**
 * 把订单标记为已支付并入账。
 * @param totalAmount 支付渠道回传的金额（元）；提供时必须与订单金额一致
 */
export const creditOrder = (db, orderId, { tradeNo, totalAmount } = {}) =>
  tx(db, () => {
    const order = getOrder(db, orderId)
    if (!order) {
      throw Object.assign(new Error('订单不存在'), { status: 404 })
    }
    if (order.status === 'paid') {
      return { already: true, amountMicro: order.amount_micro }
    }
    if (totalAmount !== undefined) {
      const paidMicro = toMicro(Number(totalAmount))
      if (paidMicro !== order.amount_micro) {
        throw Object.assign(new Error('支付金额与订单不一致'), { status: 400 })
      }
    }
    db.prepare('UPDATE orders SET status = ?, trade_no = ?, paid_at = ? WHERE id = ?').run(
      'paid',
      tradeNo ?? null,
      Date.now(),
      orderId
    )
    applyBalanceTx(db, order.user_id, order.amount_micro, 'topup', {
      orderId,
      tradeNo: tradeNo ?? null,
    })
    return { already: false, amountMicro: order.amount_micro }
  })
