import type { CapacitorConfig } from '@capacitor/cli'

/**
 * FreeSeek：基于 DeepSeek 官方开源 chat-demo 二次开发的自带 API Key 聊天 App。
 * webDir 指向 rspack 的静态产物；androidScheme 使用 https 以获得标准的源隔离与存储行为。
 */
const config: CapacitorConfig = {
  appId: 'app.freeseek.chat',
  appName: 'FreeSeek',
  webDir: 'dist',
  // 桥接参数可能含第三方密钥；诊断只使用独立的脱敏结构化日志。
  loggingBehavior: 'none',
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    // WindowEdges 提供原生安全区与键盘尺寸，SystemBars 继续管理图标明暗。
    SystemBars: {
      insetsHandling: 'disable',
      style: 'DEFAULT',
      hidden: false,
    },
  },
}

export default config
