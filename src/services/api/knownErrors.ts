import type { TranslationMessage } from '../../i18n/index.js'

/**
 * 能识别出原因的 400：直接给本地文案，避免把整段英文报错展示给用户。
 * 只依赖文案 key，不依赖 ApiError，供 client 与 errors 共用。
 */
export const describeKnownApiError = (message: string): TranslationMessage | undefined => {
  if (/uploaded an (unsupported|invalid) image/i.test(message)) {
    return { key: 'apiImageUnsupported' }
  }
  if (/The image is too large to process/i.test(message)) {
    return { key: 'apiImageTooLarge' }
  }
  return undefined
}
