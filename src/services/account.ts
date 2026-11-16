import { create } from 'zustand'
import { setApiOrigin } from './api/runtime.js'
import { useSettings } from './settings.js'

/**
 * 账号模式：登录后请求经自建服务端转发并按余额计费。
 * 默认仍是「自带 API Key」的纯本地模式，登录不是强制的。
 */
export type AccountMode = 'key' | 'account'

export type AccountUser = {
  username: string
  balanceMicro: number
  spentMicro: number
}

export type LedgerItem = {
  id: number
  kind: 'usage' | 'topup' | 'code' | 'adjust'
  amountMicro: number
  balanceMicro: number
  meta: Record<string, unknown>
  createdAt: number
}

type AccountState = {
  mode: AccountMode
  serverUrl: string
  token: string | null
  user: AccountUser | null
  /** 登录 / 注册请求进行中 */
  busy: boolean
}

const STORE_KEY = 'freeseek:account'

type Persisted = {
  mode?: AccountMode
  serverUrl?: string
  token?: string
  username?: string
}

const load = (): Persisted => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null')
    return typeof parsed === 'object' && parsed !== null ? (parsed as Persisted) : {}
  } catch {
    return {}
  }
}

const save = (state: AccountState) => {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        mode: state.mode,
        serverUrl: state.serverUrl,
        token: state.token,
        username: state.user?.username ?? '',
      })
    )
  } catch {
    // 存储不可用时只在内存生效
  }
}

const initial = load()

export const useAccount = create<AccountState>(() => ({
  mode: initial.token ? (initial.mode ?? 'account') : 'key',
  serverUrl: initial.serverUrl || __ACCOUNT_ORIGIN__,
  token: initial.token ?? null,
  user: initial.token && initial.username ? { username: initial.username, balanceMicro: 0, spentMicro: 0 } : null,
  busy: false,
}))

/** 账号模式且已登录时才把请求指向服务端 */
const syncOrigin = () => {
  const { mode, serverUrl, token } = useAccount.getState()
  setApiOrigin(mode === 'account' && token ? serverUrl : null)
}

/** 应用启动时调用：恢复登录状态并刷新余额 */
export const initAccount = async (): Promise<void> => {
  syncOrigin()
  const { mode, token } = useAccount.getState()
  if (mode === 'account' && token) {
    await refreshMe().catch(() => {
      // 网络不可用时保持本地状态，下次请求会得到 401 并引导重新登录
    })
  }
}

const endpoint = (path: string): string => {
  const base = useAccount.getState().serverUrl.trim().replace(/\/+$/, '')
  if (!base) {
    throw new Error('accountNeedServer')
  }
  return `${base}${path}`
}

type ApiFailure = { status: number; message: string; code?: string }

export const isApiFailure = (value: unknown): value is ApiFailure =>
  typeof value === 'object' && value !== null && 'status' in value && 'message' in value

const call = async (
  path: string,
  { method = 'GET', body, token }: { method?: string; body?: unknown; token?: string | null } = {}
): Promise<unknown> => {
  let response: Response
  try {
    response = await fetch(endpoint(path), {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { 'x-api-key': token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw { status: 0, message: 'accountNetworkError' } satisfies ApiFailure
  }
  const text = await response.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!response.ok) {
    const error = (data as { error?: { message?: string; code?: string } })?.error
    throw {
      status: response.status,
      message: error?.message ?? `HTTP ${response.status}`,
      code: error?.code,
    } satisfies ApiFailure
  }
  return data
}

const applySession = (data: { token: string; user: AccountUser }) => {
  useAccount.setState({ token: data.token, user: data.user, mode: 'account', busy: false })
  save(useAccount.getState())
  syncOrigin()
}

export const setServerUrl = (url: string): void => {
  useAccount.setState({ serverUrl: url.trim().replace(/\/+$/, '') })
  save(useAccount.getState())
  syncOrigin()
}

export const login = async (username: string, password: string): Promise<void> => {
  useAccount.setState({ busy: true })
  try {
    const data = (await call('/api/auth/login', { method: 'POST', body: { username, password } })) as {
      token: string
      user: AccountUser
    }
    applySession(data)
  } catch (error) {
    useAccount.setState({ busy: false })
    throw error
  }
}

export const register = async (username: string, password: string): Promise<void> => {
  useAccount.setState({ busy: true })
  try {
    const data = (await call('/api/auth/register', {
      method: 'POST',
      body: { username, password },
    })) as { token: string; user: AccountUser }
    applySession(data)
  } catch (error) {
    useAccount.setState({ busy: false })
    throw error
  }
}

export const logout = async (): Promise<void> => {
  const token = useAccount.getState().token
  if (token) {
    await call('/api/auth/logout', { method: 'POST', token }).catch(() => {})
  }
  useAccount.setState({ token: null, user: null, mode: 'key' })
  save(useAccount.getState())
  syncOrigin()
}

/** 切换使用方式：账号余额 / 自带 Key（保持登录状态） */
export const setAccountMode = (mode: AccountMode): void => {
  const { token } = useAccount.getState()
  useAccount.setState({ mode: mode === 'account' && !token ? 'key' : mode })
  save(useAccount.getState())
  syncOrigin()
}

export const refreshMe = async (): Promise<AccountUser | null> => {
  const token = useAccount.getState().token
  if (!token) {
    return null
  }
  const data = (await call('/api/me', { token })) as AccountUser
  useAccount.setState({ user: data })
  save(useAccount.getState())
  return data
}

export type TopupOrder = {
  id: string
  amountCny: number
  status: 'pending' | 'paid' | 'expired'
  payUrl?: string
  mock?: boolean
  expiresAt: number
}

export const createTopup = async (amountCny: number): Promise<TopupOrder> => {
  const token = useAccount.getState().token
  if (!token) {
    throw { status: 401, message: 'accountLoginRequired' } satisfies ApiFailure
  }
  return (await call('/api/pay/orders', { method: 'POST', token, body: { amountCny } })) as TopupOrder
}

export const confirmTopup = async (orderId: string): Promise<{ status: string }> => {
  const token = useAccount.getState().token
  return (await call(`/api/pay/orders/${orderId}/confirm`, { method: 'POST', token })) as {
    status: string
  }
}

export const orderStatus = async (orderId: string): Promise<{ status: string }> => {
  const token = useAccount.getState().token
  return (await call(`/api/pay/orders/${orderId}`, { token })) as { status: string }
}

export const redeemCode = async (
  code: string
): Promise<{ amountMicro: number; balanceMicro: number }> => {
  const token = useAccount.getState().token
  return (await call('/api/billing/redeem', { method: 'POST', token, body: { code } })) as {
    amountMicro: number
    balanceMicro: number
  }
}

export const fetchLedger = async (): Promise<LedgerItem[]> => {
  const token = useAccount.getState().token
  const data = (await call('/api/billing/ledger', { token })) as { items: LedgerItem[] }
  return data.items
}

/** 账号模式且已登录时，请求应使用会话令牌；否则用自带 Key */
export const credential = (): string => {
  const { mode, token } = useAccount.getState()
  if (mode === 'account' && token) {
    return token
  }
  return useSettings.getState().apiKey ?? ''
}

/** 是否已有可用凭证（账号登录或 API Key） */
export const hasCredential = (): boolean => {
  const { mode, token } = useAccount.getState()
  if (mode === 'account') {
    return !!token
  }
  return !!useSettings.getState().apiKey
}

/** 账号模式下遇到 401：清理会话并回到自带 Key 模式 */
export const handleUnauthorized = (): void => {
  if (useAccount.getState().mode !== 'account') {
    return
  }
  useAccount.setState({ token: null, user: null, mode: 'key' })
  save(useAccount.getState())
  syncOrigin()
}
