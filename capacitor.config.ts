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
}

export default config
