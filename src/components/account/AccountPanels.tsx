import { useCallback, useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  confirmTopup,
  createTopup,
  fetchLedger,
  isApiFailure,
  orderStatus,
  redeemCode,
  refreshMe,
  useAccount,
  type LedgerItem,
  type TopupOrder,
} from '../../services/account.js'
import { openExternal } from '../../utils/openExternal.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './Account.module.css'

const PRESETS = [10, 30, 50, 100]

const ledgerLabel = (t: ReturnType<typeof useTranslate>, kind: LedgerItem['kind']) => {
  switch (kind) {
    case 'usage':
      return t('accountLedgerUsage')
    case 'topup':
      return t('accountLedgerTopup')
    case 'code':
      return t('accountLedgerCode')
    default:
      return t('accountLedgerAdjust')
  }
}

const formatMoney = (micro: number, digits = 2) => `¥${(micro / 1_000_000).toFixed(digits)}`

/**
 * 充值：手机网站支付——服务端签名出收银台 URL，用系统浏览器打开并唤起支付宝。
 * 回到 App 后可轮询订单状态，或手动点「我已完成支付」主动查单。
 */
export const TopupDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const [amount, setAmount] = useState(30)
  const [order, setOrder] = useState<TopupOrder | null>(null)
  const [busy, setBusy] = useState(false)

  const finish = useCallback(async () => {
    await refreshMe().catch(() => {})
    showToast({ key: 'accountPaySuccess' })
    onClose()
  }, [onClose])

  // 下单后每 3 秒查一次订单状态；支付到账即关闭
  useEffect(() => {
    if (!order) {
      return
    }
    let alive = true
    const timer = window.setInterval(() => {
      orderStatus(order.id)
        .then((status) => {
          if (alive && status.status === 'paid') {
            window.clearInterval(timer)
            void finish()
          }
        })
        .catch(() => {})
    }, 3000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [order, finish])

  const pay = async () => {
    setBusy(true)
    try {
      const created = await createTopup(amount)
      setOrder(created)
      if (created.payUrl) {
        await openExternal(created.payUrl)
      }
    } catch (error) {
      showToast(isApiFailure(error) ? error.message : t('accountPayFailed'))
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    if (!order) {
      return
    }
    setBusy(true)
    try {
      const result = await confirmTopup(order.id)
      if (result.status === 'paid') {
        await finish()
      } else {
        showToast({ key: 'accountPayPending' })
      }
    } catch {
      showToast({ key: 'accountPayPending' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('accountTopupTitle')}
      centered
      onClose={onClose}
      footer={
        order ? (
          <>
            <Button variant="outlined" onClick={onClose}>
              {t('cancel')}
            </Button>
            {order.manual ? (
              <Button disabled={busy} onClick={() => void confirm()}>
                {t('accountRefresh')}
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => void confirm()}>
                {order.mock ? t('accountPayMock') : t('accountPayConfirm')}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button variant="outlined" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button disabled={busy || amount <= 0} onClick={() => void pay()}>
              {t('accountPayNow')}
            </Button>
          </>
        )
      }
    >
      {order ? (
        order.manual ? (
          <div className={styles.manualPay}>
            <div className={styles.payAmount}>{formatMoney(order.amountCny * 1_000_000)}</div>
            <div className={styles.manualTitle}>{t('accountManualScan')}</div>
            {order.payee ? (
              <div className={styles.hint}>
                {t('accountManualPayee')}：{order.payee}
              </div>
            ) : null}
            <img
              className={styles.qrImage}
              src={
                order.qrUrl && /^https?:/.test(order.qrUrl)
                  ? order.qrUrl
                  : `${useAccount.getState().serverUrl.replace(/\/+$/, '')}${order.qrUrl ?? ''}`
              }
              alt={t('accountManualScan')}
            />
            <div className={styles.orderNo}>
              <span>
                {t('accountManualOrderNo')} <b>{order.id}</b>
              </span>
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  void copyText(order.id).then((ok) => {
                    if (ok) {
                      showToast(t('accountManualCopied'))
                    }
                  })
                }}
              >
                {t('accountManualCopy')}
              </button>
            </div>
            <p className={styles.hint}>{t('accountManualNote')}</p>
            <p className={styles.hint}>{t('accountManualWaiting')}</p>
          </div>
        ) : (
          <div className={styles.payWaiting}>
            <div className={styles.payAmount}>{formatMoney(order.amountCny * 1_000_000)}</div>
            <p className={styles.hint}>{t('accountPaying')}</p>
          </div>
        )
      ) : (
        <div className={styles.amountGrid}>
          {PRESETS.map((value) => (
            <button
              key={value}
              type="button"
              className={amount === value ? styles.amountActive : styles.amount}
              onClick={() => setAmount(value)}
            >
              ¥{value}
            </button>
          ))}
          <label className={styles.customAmount}>
            <span>{t('accountTopupCustom')}</span>
            <input
              type="number"
              inputMode="decimal"
              min={1}
              step={1}
              value={amount}
              onChange={(event) => setAmount(Number(event.target.value))}
            />
          </label>
        </div>
      )}
    </Modal>
  )
}

/** 兑换卡密 */
export const RedeemDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      const result = await redeemCode(code.trim())
      await refreshMe().catch(() => {})
      showToast(`${t('accountRedeemSuccess')} +${formatMoney(result.amountMicro)}`)
      onClose()
    } catch {
      showToast(t('accountRedeemFailed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={t('accountRedeemTitle')}
      centered
      onClose={onClose}
      footer={
        <>
          <Button variant="outlined" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button disabled={busy || !code.trim()} onClick={() => void submit()}>
            {t('confirm')}
          </Button>
        </>
      }
    >
      <input
        className={styles.redeemInput}
        value={code}
        placeholder={t('accountRedeemPlaceholder')}
        autoFocus
        onChange={(event) => setCode(event.target.value.toUpperCase())}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && code.trim() && !busy) {
            void submit()
          }
        }}
      />
    </Modal>
  )
}

/** 余额 + 充值/卡密入口 + 账单（已登录时展示） */
export const BalanceBlock = () => {
  const t = useTranslate()
  const user = useAccount((state) => state.user)
  const [ledger, setLedger] = useState<LedgerItem[] | null>(null)
  const [topupOpen, setTopupOpen] = useState(false)
  const [redeemOpen, setRedeemOpen] = useState(false)

  useEffect(() => {
    fetchLedger()
      .then(setLedger)
      .catch(() => setLedger([]))
  }, [user?.balanceMicro])

  if (!user) {
    return null
  }
  return (
    <>
      <div className={styles.balanceCard}>
        <div>
          <div className={styles.balanceLabel}>{t('accountBalance')}</div>
          <div className={styles.balanceValue}>{formatMoney(user.balanceMicro)}</div>
        </div>
        <div className={styles.balanceSpent}>
          {t('accountSpent')} {formatMoney(user.spentMicro)}
        </div>
      </div>
      <div className={styles.actionsRow}>
        <button type="button" className={styles.primaryAction} onClick={() => setTopupOpen(true)}>
          {t('accountTopup')}
        </button>
        <button
          type="button"
          className={styles.secondaryAction}
          onClick={() => setRedeemOpen(true)}
        >
          {t('accountRedeem')}
        </button>
      </div>

      <div className={styles.ledgerTitle}>{t('accountLedger')}</div>
      <div className={styles.ledger}>
        {ledger === null ? null : ledger.length === 0 ? (
          <div className={styles.ledgerEmpty}>{t('accountLedgerEmpty')}</div>
        ) : (
          ledger.map((item) => (
            <div key={item.id} className={styles.ledgerRow}>
              <div className={styles.ledgerMain}>
                <span className={styles.ledgerKind}>{ledgerLabel(t, item.kind)}</span>
                <span className={styles.ledgerTime}>{new Date(item.createdAt).toLocaleString()}</span>
              </div>
              <span className={item.amountMicro > 0 ? styles.ledgerIn : styles.ledgerOut}>
                {item.amountMicro > 0 ? '+' : ''}
                {formatMoney(item.amountMicro, Math.abs(item.amountMicro) >= 100_000 ? 2 : 4)}
              </span>
            </div>
          ))
        )}
      </div>

      {topupOpen ? <TopupDialog onClose={() => setTopupOpen(false)} /> : null}
      {redeemOpen ? <RedeemDialog onClose={() => setRedeemOpen(false)} /> : null}
    </>
  )
}
