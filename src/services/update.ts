import { create } from 'zustand'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { App as CapacitorApp } from '@capacitor/app'
import { openExternal } from '../utils/openExternal.js'

/**
 * 应用内更新：查 GitHub Release → 自动预下载 APK → 一键安装。
 *
 * - 多源探测：GitHub API 直连 + 国内常用的 GitHub 反代前缀，谁先返回用谁
 * - 结果缓存 6 小时，避免每次启动都请求
 * - 下载优先走原生流式下载（有进度、可断点式续用已下好的包），失败退回系统下载器
 */
const REPO = 'WikG1018/FreeSeekApp'
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`
/** 国内网络常见的 GitHub 反代；顺序即优先级 */
const MIRRORS = ['', 'https://gh-proxy.com/', 'https://ghfast.top/', 'https://ghproxy.net/']
const CACHE_KEY = 'freeseek:update-cache'
const CACHE_TTL = 6 * 3600_000
const FETCH_TIMEOUT = 8000

type NativeUpdate = {
  /** 原生代发 GET：镜像站普遍不带 CORS 头，WebView 的 fetch 会被拦 */
  get: (o: { url: string; timeoutMs?: number }) => Promise<{ status: number; body: string }>
  hasFile: (o: { fileName: string }) => Promise<{ exists: boolean; path: string; size: number }>
  download: (o: { url: string; fileName: string }) => Promise<{
    path: string
    size: number
    cached?: boolean
  }>
  cancel: () => Promise<void>
  install: (o: { path: string }) => Promise<{ installed: boolean; reason?: string }>
  enqueueSystemDownload: (o: { url: string; fileName: string }) => Promise<{
    enqueued: boolean
    reason?: string
  }>
  addListener: (
    event: 'progress',
    cb: (payload: { received: number; total: number }) => void
  ) => Promise<{ remove: () => void }>
}

const UpdateNative = registerPlugin<NativeUpdate>('Update')

export type ReleaseInfo = {
  version: string
  tag: string
  notes: string
  publishedAt: string
  pageUrl: string
  apk: { name: string; size: number; url: string } | null
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'latest'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

type UpdateState = {
  status: UpdateStatus
  release: ReleaseInfo | null
  /** 下载进度 0–100；未知总大小时为 -1 */
  percent: number
  filePath: string
  error: string
  lastCheckedAt: number
}

export const useUpdate = create<UpdateState>(() => ({
  status: 'idle',
  release: null,
  percent: 0,
  filePath: '',
  error: '',
  lastCheckedAt: 0,
}))

const appVersion = (): string =>
  document.querySelector('meta[name="application-version"]')?.getAttribute('content') ?? '0.0.0'

export const currentVersion = appVersion

const parseVersion = (value: string): number[] =>
  value
    .replace(/^v/i, '')
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10) || 0)

/** 严格 semver 比较：latest > current 才提示更新 */
export const isNewer = (latest: string, current: string): boolean => {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) {
      return left > right
    }
  }
  return false
}

type Cache = { at: number; release: ReleaseInfo | null }

const readCache = (): Cache => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null')
    if (typeof parsed === 'object' && parsed !== null && 'at' in parsed) {
      return parsed as Cache
    }
  } catch {
    // 忽略缓存损坏
  }
  return { at: 0, release: null }
}

const writeCache = (release: ReleaseInfo | null) => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release }))
  } catch {
    // 存储不可用时只在内存生效
  }
}

type GithubAsset = { name: string; size: number; browser_download_url: string }
type GithubRelease = {
  tag_name: string
  name?: string
  body?: string
  published_at?: string
  html_url?: string
  assets?: GithubAsset[]
}

const toRelease = (data: GithubRelease): ReleaseInfo => {
  const tag = data.tag_name ?? ''
  const assets = data.assets ?? []
  const apk =
    assets.find((asset) => asset.name.toLowerCase().endsWith('.apk')) ?? null
  return {
    version: tag.replace(/^v/i, ''),
    tag,
    notes: (data.body ?? '').trim(),
    publishedAt: data.published_at ?? '',
    pageUrl: data.html_url ?? `https://github.com/${REPO}/releases/latest`,
    apk: apk ? { name: apk.name, size: apk.size, url: apk.browser_download_url } : null,
  }
}

const fetchWithTimeout = async (url: string, timeout = FETCH_TIMEOUT): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    })
  } finally {
    clearTimeout(timer)
  }
}

/** 读取一个 URL 的文本：原生走插件（不受 CORS 限制），网页端走 fetch */
const readText = async (url: string): Promise<{ status: number; text: string }> => {
  if (Capacitor.isNativePlatform()) {
    const result = await UpdateNative.get({ url, timeoutMs: FETCH_TIMEOUT })
    return { status: result.status, text: result.body }
  }
  const response = await fetchWithTimeout(url)
  return { status: response.status, text: await response.text() }
}

/** 依次尝试直连与镜像，返回第一个可用结果；全部失败返回 null */
const fetchRelease = async (): Promise<{ release: ReleaseInfo; mirror: string } | null> => {
  for (const mirror of MIRRORS) {
    try {
      const { status, text } = await readText(`${mirror}${RELEASE_API}`)
      if (status !== 200) {
        continue
      }
      const data = JSON.parse(text) as GithubRelease
      if (!data?.tag_name) {
        continue
      }
      return { release: toRelease(data), mirror }
    } catch {
      // 换下一个源
    }
  }
  return null
}

/** 把资源地址映射到某个镜像前缀下 */
const mirrored = (mirror: string, url: string) => (mirror ? `${mirror}${url}` : url)

const fileNameFor = (release: ReleaseInfo) => `freeseek-${release.version}.apk`

/** 检查更新；返回是否有新版本 */
export const checkForUpdate = async ({ force = false } = {}): Promise<boolean> => {
  const state = useUpdate.getState()
  if (state.status === 'checking' || state.status === 'downloading') {
    return false
  }
  const cache = readCache()
  const version = currentVersion()
  if (!force && cache.release && Date.now() - cache.at < CACHE_TTL) {
    const newer = isNewer(cache.release.version, version)
    useUpdate.setState({
      release: cache.release,
      status: newer ? 'available' : 'latest',
      lastCheckedAt: cache.at,
    })
    return newer
  }

  useUpdate.setState({ status: 'checking', error: '' })
  try {
    const found = await fetchRelease()
    if (!found) {
      useUpdate.setState({ status: 'error', error: 'network' })
      return false
    }
    writeCache(found.release)
    const newer = isNewer(found.release.version, version)
    useUpdate.setState({
      release: found.release,
      status: newer ? 'available' : 'latest',
      lastCheckedAt: Date.now(),
      error: '',
    })
    if (newer) {
      void downloadUpdate()
    }
    return newer
  } catch {
    useUpdate.setState({ status: 'error', error: 'network' })
    return false
  }
}

/** 下载更新包：原生流式下载（带进度），失败退回系统下载器 */
export const downloadUpdate = async (): Promise<boolean> => {
  const { release, status } = useUpdate.getState()
  const apk = release?.apk
  if (!apk) {
    return false
  }
  if (status === 'downloading' || status === 'ready') {
    return status === 'ready'
  }
  if (!Capacitor.isNativePlatform()) {
    // 网页端不做预下载，直接给出发布页
    useUpdate.setState({ status: 'available' })
    return false
  }

  useUpdate.setState({ status: 'downloading', percent: 0, error: '' })
  const listener = await UpdateNative.addListener('progress', ({ received, total }) => {
    useUpdate.setState({
      percent: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : -1,
    })
  }).catch(() => null)

  const fileName = fileNameFor(release)
  try {
    const cached = await UpdateNative.hasFile({ fileName })
    if (cached.exists) {
      useUpdate.setState({ status: 'ready', percent: 100, filePath: cached.path })
      return true
    }
    const mirrors = MIRRORS.map((m) => mirrored(m, apk.url))
    for (const url of mirrors) {
      try {
        const result = await UpdateNative.download({ url, fileName })
        useUpdate.setState({ status: 'ready', percent: 100, filePath: result.path })
        return true
      } catch {
        // 换下一个源
      }
    }
    // 原生下载全部失败：交给系统下载器
    await UpdateNative.enqueueSystemDownload({
      url: mirrored(MIRRORS[1] ?? '', apk.url),
      fileName,
    })
    useUpdate.setState({ status: 'available', error: 'system-download' })
    return false
  } catch (error) {
    useUpdate.setState({ status: 'error', error: String(error) })
    return false
  } finally {
    void listener?.remove()
  }
}

/** 安装已下载的包；返回是否成功拉起安装器 */
export const installUpdate = async (): Promise<{ installed: boolean; reason?: string }> => {
  const { filePath, release } = useUpdate.getState()
  if (!Capacitor.isNativePlatform()) {
    if (release) {
      await openExternal(release.pageUrl)
    }
    return { installed: false, reason: 'web' }
  }
  if (!filePath) {
    return { installed: false, reason: 'no-file' }
  }
  try {
    return await UpdateNative.install({ path: filePath })
  } catch (error) {
    return { installed: false, reason: String(error) }
  }
}

/** 打开发布页（查看更新说明 / 手动下载） */
export const openReleasePage = async (): Promise<void> => {
  const { release } = useUpdate.getState()
  await openExternal(release?.pageUrl ?? `https://github.com/${REPO}/releases/latest`)
}

/** 自动检查节流：防止快速重启/切前后台时反复请求 */
const AUTO_CHECK_THROTTLE = 60_000
/** 回到前台时，距上次检查超过这个时间才补查 */
const FOREGROUND_INTERVAL = 30 * 60_000
/** 常驻运行时每 6 小时检查一次 */
const PERIODIC_INTERVAL = 6 * 3600_000

let lastAutoCheck = 0

/**
 * 自动检查更新：
 * 1. 每次启动都查（不再被 6 小时缓存挡住），首屏渲染后 2.5 秒开始
 * 2. 回到前台超过 30 分钟补查一次
 * 3. 常驻运行时每 6 小时查一次
 * 查到新版本会自动开始下载安装包，侧边栏随即出现入口。
 */
export const initUpdateChecker = (): void => {
  const run = (reason: string) => {
    const now = Date.now()
    if (now - lastAutoCheck < AUTO_CHECK_THROTTLE) {
      return
    }
    lastAutoCheck = now
    void checkForUpdate({ force: true }).catch(() => {
      // 网络异常时保持静默，用户手动点「检查更新」会看到失败提示
    })
    void reason
  }

  // 启动检查：避开首屏渲染高峰
  window.setTimeout(() => run('startup'), 2500)

  // 回到前台补查（WebView 切后台会暂停定时器，所以用可见性事件兜底）
  const onVisible = () => {
    if (document.visibilityState === 'visible' && Date.now() - lastAutoCheck > FOREGROUND_INTERVAL) {
      run('foreground')
    }
  }
  document.addEventListener('visibilitychange', onVisible)
  if (Capacitor.isNativePlatform()) {
    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive && Date.now() - lastAutoCheck > FOREGROUND_INTERVAL) {
        run('resume')
      }
    })
  }

  // 常驻检查
  window.setInterval(() => run('periodic'), PERIODIC_INTERVAL)
}
