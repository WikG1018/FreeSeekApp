import { Capacitor, registerPlugin } from '@capacitor/core'
import { diagnosticError, logEvent } from '../diagnostics/log.js'

/**
 * 原生麦克风权限桥：Android 端由 MicPermissionPlugin 显式申请 RECORD_AUDIO。
 * 网页端不存在该插件，权限交给浏览器在 getUserMedia 时询问。
 */
type MicPermissionPlugin = {
  check: () => Promise<{ granted: boolean; state?: string }>
  request: () => Promise<{ granted: boolean }>
  openSettings: () => Promise<void>
}

const MicPermission = registerPlugin<MicPermissionPlugin>('MicPermission')

export const isNativeApp = () => Capacitor.isNativePlatform()

/**
 * 录音前确保已拿到麦克风权限。
 * 插件不可用（网页端、旧版本 APK）时返回 true，让 getUserMedia 自己走浏览器授权。
 */
export const ensureMicPermission = async (): Promise<boolean> => {
  if (!Capacitor.isNativePlatform()) {
    return true
  }
  try {
    const current = await MicPermission.check()
    if (current.granted) {
      return true
    }
    const result = await MicPermission.request()
    return result.granted === true
  } catch (error) {
    logEvent('speech', 'permission.bridge-unavailable', diagnosticError(error), 'warn')
    return true
  }
}

/** 跳转到本应用的系统权限页（仅 Android） */
export const openAppPermissionSettings = async (): Promise<void> => {
  if (!Capacitor.isNativePlatform()) {
    return
  }
  try {
    await MicPermission.openSettings()
  } catch (error) {
    logEvent('speech', 'permission.settings-failed', diagnosticError(error), 'error')
    // 打不开就保持当前页面，用户仍可手动前往设置
  }
}
