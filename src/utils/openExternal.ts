import { Capacitor } from '@capacitor/core'
import { Browser } from '@capacitor/browser'

/** 在系统浏览器（App 内为外部浏览器）打开链接；网页预览使用新标签页 */
export const openExternal = async (url: string): Promise<void> => {
  if (Capacitor.isNativePlatform()) {
    await Browser.open({ url })
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
