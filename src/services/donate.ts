import { Capacitor, registerPlugin } from '@capacitor/core'

/**
 * 打赏相关的原生能力：
 * - saveImage：把收款码存进系统相册
 * - openApp：尝试拉起支付宝 / 微信
 * 网页端没有插件，两者都会退化为浏览器行为。
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

export type PayApp = 'alipay' | 'wechat'

/** 网页端兜底：支付宝/微信的官方扫码/首页链接 */
const WEB_FALLBACK: Record<PayApp, string> = {
  alipay: 'https://render.alipay.com/p/s/i/?scheme=alipays%3A%2F%2Fplatformapi%2Fstartapp',
  wechat: 'https://weixin.qq.com/',
}

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      // 去掉 data:image/png;base64, 前缀，原生只接受纯 base64
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })

export const isNative = () => Capacitor.isNativePlatform()

/** 把图片存进相册；返回是否成功（网页端返回 false，由调用方给出「长按保存」提示） */
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

/** 尝试打开支付 App；返回是否成功拉起（失败时调用方退化为网页链接） */
export const openPayApp = async (target: PayApp): Promise<boolean> => {
  if (Capacitor.isNativePlatform()) {
    try {
      const result = await Donate.openApp({ target })
      return result.opened === true
    } catch {
      return false
    }
  }
  // 网页端：新标签打开支付宝首页/微信，尽力而为
  window.open(WEB_FALLBACK[target], '_blank', 'noopener,noreferrer')
  return true
}
