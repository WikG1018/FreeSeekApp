import { Capacitor, registerPlugin } from '@capacitor/core'
import alipayQr from '../assets/donate-alipay.png'
import wechatQr from '../assets/donate-wechat.png'
import { openExternal } from '../utils/openExternal.js'

/**
 * 打赏相关的原生能力：
 * - saveImage：把收款码存进系统相册
 * - openApp：按 scheme 拉起支付 App（微信收款页是 wxp:// 这类私有 scheme）
 */
type DonatePlugin = {
  saveImage: (options: { data: string; fileName?: string }) => Promise<{
    saved: boolean
    reason?: string
  }>
  openApp: (options: { target: 'alipay' | 'wechat'; scheme?: string }) => Promise<{
    opened: boolean
  }>
}

const Donate = registerPlugin<DonatePlugin>('Donate')

export type PayMethod = 'alipay' | 'wechat'

/**
 * 收款码：图片 + 从二维码里解码出来的跳转链路。
 * - 支付宝：https://qr.alipay.com/... 是官方通用链接，用系统浏览器打开会唤起支付宝收款页
 * - 微信：wxp://... 是微信注册的收款 scheme，用 Intent 打开即进入收款页
 */
export const PAY_CHANNELS: Record<PayMethod, { label: string; qr: string; link: string }> = {
  alipay: {
    label: '支付宝',
    qr: alipayQr,
    link: 'https://qr.alipay.com/fkx10702mjvxw5lrmexj364',
  },
  wechat: {
    label: '微信',
    qr: wechatQr,
    link: 'wxp://f2f0z87084tDt0A_ZaDHLTX5W1J5Fb3y-8W8DCT4jaqn2HE',
  },
}

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })

/** 把收款码存进相册；返回是否成功（网页端返回 false，由调用方提示长按保存） */
export const saveImageToGallery = async (
  src: string,
  fileName = 'freeseek-donate'
): Promise<boolean> => {
  if (!Capacitor.isNativePlatform()) {
    return false
  }
  try {
    const response = await fetch(src)
    const blob = await response.blob()
    const data = await blobToBase64(blob)
    const result = await Donate.saveImage({ data, fileName })
    return result.saved === true
  } catch {
    return false
  }
}

/**
 * 直接打开收款页：
 * - 支付宝：通用链接交给系统浏览器（会拉起支付宝 App 的收款页）
 * - 微信：wxp:// 用原生 Intent（Chrome 之类不认识这个 scheme）
 */
export const openPayPage = async (method: PayMethod): Promise<boolean> => {
  const { link } = PAY_CHANNELS[method]
  if (!Capacitor.isNativePlatform()) {
    window.open(link, '_blank', 'noopener,noreferrer')
    return true
  }
  if (method === 'alipay') {
    await openExternal(link)
    return true
  }
  try {
    const result = await Donate.openApp({ target: method, scheme: link })
    return result.opened === true
  } catch {
    return false
  }
}
