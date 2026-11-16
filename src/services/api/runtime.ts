/**
 * API 运行时地址：自带 Key 模式指向官方 API；账号模式指向自建服务端。
 * 单独一个模块，避免 client ⇄ account 循环依赖。
 */
const DEFAULT_ORIGIN: string = __API_ORIGIN__

let activeOrigin = DEFAULT_ORIGIN

export const apiOrigin = (): string => activeOrigin

export const defaultApiOrigin = (): string => DEFAULT_ORIGIN

/** 传空值恢复默认（自带 Key 模式） */
export const setApiOrigin = (origin: string | null): void => {
  const next = (origin ?? '').trim().replace(/\/+$/, '')
  activeOrigin = next || DEFAULT_ORIGIN
}
