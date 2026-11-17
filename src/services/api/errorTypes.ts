import { translate, type TranslationMessage } from '../../i18n/index.js'

export type ApiErrorKind = 'http' | 'stream' | 'network' | 'interrupted' | 'protocol'
export class ApiError extends Error {
  readonly localMessage?: TranslationMessage
  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number,
    localMessage?: TranslationMessage
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = localMessage ?? (typeof message === 'string' ? undefined : message)
  }
}
