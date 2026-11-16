import type { CapacitorConfig } from '@capacitor/cli'

/**
 * FreeSeek：基于 DeepSeek 官方开源 chat-demo 二次开发的自带 API Key 聊天 App。
 * webDir 指向 rspack 的静态产物；androidScheme 使用 https 以获得标准的源隔离与存储行为。
 */
const config: CapacitorConfig = {
  appId: 'app.freeseek.chat',
  appName: 'FreeSeek',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    // Capacitor 8 内置 SystemBars：native 模式由原生把 WebView 放到安全区内，
    // 避免旧版 WebView 无法提供 env(safe-area-inset-*) 时内容压到状态栏。
    SystemBars: {
      insetsHandling: 'native',
      style: 'DEFAULT',
      hidden: false,
    },
  },
}

export default config
