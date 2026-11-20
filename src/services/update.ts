import { create } from 'zustand'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { App as CapacitorApp } from '@capacitor/app'
import { openExternal } from '../utils/openExternal.js'
import { beginDiagnosticOperation, diagnosticError, logEvent } from './diagnostics/log.js'

/**
 * 应用内更新：检查版本，展示发行说明，用户选择下载和安装。
 *
 * - 发布 API 与独立更新清单分别探测，兼容只代理 Release 附件的镜像站
 * - 结果缓存 6 小时，避免每次启动都请求
 * - 原生流式下载与已下载包均须验证大小、摘要、包名、版本与签名
 */
const REPO = 'WikG1018/FreeSeekApp'
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASE_MANIFEST = `https://github.com/${REPO}/releases/latest/download/update.json`
/** 国内网络常见的 GitHub 反代；顺序即优先级 */
const MIRRORS = ['', 'https://gh-proxy.com/', 'https://ghfast.top/', 'https://ghproxy.net/']
const METADATA_SOURCES = [
  RELEASE_API,
  `https://gh-proxy.com/${RELEASE_API}`,
  ...MIRRORS.map((mirror) => `${mirror}${RELEASE_MANIFEST}`),
]
const CACHE_KEY = 'freeseek:update-cache'
const CACHE_TTL = 6 * 3600_000
const FETCH_TIMEOUT = 8000

type NativeUpdate = {
  /** 原生代发 GET：镜像站普遍不带 CORS 头，WebView 的 fetch 会被拦 */
  get: (o: { url: string; timeoutMs?: number }) => Promise<{ status: number; body: string }>
  hasFile: (
    o: PackageCheck & { fileName: string }
  ) => Promise<{ exists: boolean; path: string; size: number }>
  download: (o: PackageCheck & { url: string; fileName: string }) => Promise<{
    path: string
    size: number
    cached?: boolean
  }>
  cancel: () => Promise<void>
  install: (o: PackageCheck & { path: string }) => Promise<{ installed: boolean; reason?: string }>
  addListener: (
    event: 'progress',
    cb: (payload: { received: number; total: number }) => void
  ) => Promise<{ remove: () => void }>
}

const UpdateNative = registerPlugin<NativeUpdate>('Update')
type PackageCheck = { expectedSize: number; sha256: string | null; version: string }

export type ReleaseInfo = {
  version: string
  tag: string
  notes: string
  publishedAt: string
  pageUrl: string
  apk: { name: string; size: number; url: string; sha256: string | null } | null
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
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'at' in parsed &&
      typeof parsed.at === 'number' &&
      Number.isFinite(parsed.at) &&
      'release' in parsed
    ) {
      const cached = parsed.release as ReleaseInfo | null
      if (!cached) {
        return { at: parsed.at, release: null }
      }
      const release = toRelease({
        tag_name: cached.tag,
        body: typeof cached.notes === 'string' ? cached.notes : '',
        published_at: typeof cached.publishedAt === 'string' ? cached.publishedAt : '',
        assets: cached.apk
          ? [
              {
                name: cached.apk.name,
                size: cached.apk.size,
                browser_download_url: cached.apk.url,
                ...(cached.apk.sha256 ? { digest: `sha256:${cached.apk.sha256}` } : {}),
              },
            ]
          : [],
      })
      return { at: parsed.at, release }
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

type GithubAsset = { name: string; size: number; browser_download_url: string; digest?: string }
type GithubRelease = {
  tag_name: string
  name?: string
  body?: string
  published_at?: string
  html_url?: string
  assets?: GithubAsset[]
}

export const toRelease = (data: GithubRelease): ReleaseInfo => {
  const tag = data.tag_name ?? ''
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error('Invalid release tag')
  }
  const assets = data.assets ?? []
  const apk = assets.find((asset) => asset.name === `freeseek-${tag}-release.apk`) ?? null
  if (apk) {
    const url = new URL(apk.browser_download_url)
    if (
      url.origin !== 'https://github.com' ||
      url.pathname !== `/${REPO}/releases/download/${tag}/${apk.name}` ||
      url.search ||
      url.hash ||
      !Number.isSafeInteger(apk.size) ||
      apk.size <= 0 ||
      apk.size > 512 * 1024 * 1024
    ) {
      throw new Error('Invalid release asset')
    }
    if (apk.digest != null && !/^sha256:[a-f0-9]{64}$/i.test(apk.digest)) {
      throw new Error('Invalid release digest')
    }
  }
  return {
    version: tag.replace(/^v/i, ''),
    tag,
    notes: (data.body ?? '').trim(),
    publishedAt: data.published_at ?? '',
    pageUrl: `https://github.com/${REPO}/releases/tag/${tag}`,
    apk: apk
      ? {
          name: apk.name,
          size: apk.size,
          url: apk.browser_download_url,
          sha256: /^sha256:[a-f0-9]{64}$/i.test(apk.digest ?? '')
            ? (apk.digest ?? '').slice(7).toLowerCase()
            : null,
        }
      : null,
  }
}

/** 超时覆盖响应头和完整响应体；拒绝无限滴流与过大的 HTML 错误页。 */
const readText = async (url: string): Promise<{ status: number; text: string }> => {
  if (Capacitor.isNativePlatform()) {
    const result = await UpdateNative.get({ url, timeoutMs: FETCH_TIMEOUT })
    return { status: result.status, text: result.body }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    })
    const reader = response.body?.getReader()
    if (!reader) {
      return { status: response.status, text: '' }
    }
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        size += value.byteLength
        if (size > 2_000_000) {
          throw new Error('Metadata too large')
        }
        chunks.push(value)
      }
      const all = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        all.set(chunk, offset)
        offset += chunk.length
      }
      return { status: response.status, text: new TextDecoder().decode(all) }
    } finally {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 依次尝试直连与镜像，返回第一个可用结果；全部失败返回 null */
const readReleaseSource = async (
  url: string
): Promise<{ release: ReleaseInfo; mirror: string } | null> => {
  const source = new URL(url).host,
    started = performance.now()
  try {
    const { status, text } = await readText(url)
    logEvent('update', 'metadata.response', {
      source,
      status,
      elapsedMs: Math.round(performance.now() - started),
    })
    if (status === 200) {
      const data = JSON.parse(text) as GithubRelease
      if (data?.tag_name) {
        const release = toRelease(data)
        if (release.apk) {
          return { release, mirror: source }
        }
      }
    }
  } catch (error) {
    logEvent('update', 'metadata.failed', { source, ...diagnosticError(error) }, 'warn')
  }
  return null
}

const fetchRelease = async () => {
  const official = await readReleaseSource(RELEASE_API)
  if (official) {
    return official
  }
  // A successful mirror response can still be stale. Try the fallback sources within one timeout window.
  const results = await Promise.all(METADATA_SOURCES.slice(1).map(readReleaseSource))
  let latest: Awaited<ReturnType<typeof readReleaseSource>> = null
  for (const candidate of results) {
    if (candidate && (!latest || isNewer(candidate.release.version, latest.release.version))) {
      latest = candidate
    }
  }
  return latest
}

/** 把资源地址映射到某个镜像前缀下 */
const mirrored = (mirror: string, url: string) => (mirror ? `${mirror}${url}` : url)

const fileNameFor = (release: ReleaseInfo) => `freeseek-${release.version}.apk`

const showRelease = async (release: ReleaseInfo, at: number): Promise<boolean> => {
  const newer = isNewer(release.version, currentVersion())
  let path = ''
  if (newer && release.apk && Capacitor.isNativePlatform()) {
    const cached = await UpdateNative.hasFile({
      fileName: fileNameFor(release),
      expectedSize: release.apk.size,
      sha256: release.apk.sha256,
      version: release.version,
    }).catch(() => null)
    if (cached?.exists) {
      path = cached.path
    }
  }
  useUpdate.setState({
    release,
    lastCheckedAt: at,
    status: path ? 'ready' : newer ? 'available' : 'latest',
    filePath: path,
    percent: path ? 100 : 0,
    error: '',
  })
  return newer
}

/** 检查更新；返回是否有新版本 */
export const checkForUpdate = async ({ force = false } = {}): Promise<boolean> => {
  const state = useUpdate.getState()
  if (state.status === 'checking' || state.status === 'downloading') {
    return false
  }
  const cache = readCache()
  const known =
    state.release && (!cache.release || !isNewer(cache.release.version, state.release.version))
      ? state.release
      : cache.release
  if (!force && cache.release && Date.now() - cache.at < CACHE_TTL) {
    return showRelease(known ?? cache.release, cache.at)
  }

  logEvent('update', 'check.started', { force })
  useUpdate.setState({ status: 'checking', error: '' })
  const offline = async () => {
    if (known && isNewer(known.version, currentVersion())) {
      await showRelease(known, cache.at || state.lastCheckedAt)
      useUpdate.setState({ error: 'network' })
      logEvent(
        'update',
        'check.cached',
        { version: known.version, ready: useUpdate.getState().status === 'ready' },
        'warn'
      )
      return true
    }
    useUpdate.setState({ status: 'error', error: 'network' })
    return false
  }
  try {
    const found = await fetchRelease()
    if (!found) {
      return await offline()
    }
    const release = known && isNewer(known.version, found.release.version) ? known : found.release
    writeCache(release)
    const newer = await showRelease(release, Date.now())
    logEvent('update', 'check.completed', { version: release.version, newer, source: found.mirror })
    return newer
  } catch (error) {
    logEvent('update', 'check.failed', diagnosticError(error), 'error')
    return offline()
  }
}

/** 下载更新包：依次尝试直连和镜像，始终保留校验与手动重试。 */
export const downloadUpdate = async (): Promise<boolean> => {
  const { release, status } = useUpdate.getState()
  const apk = release?.apk
  if (!apk) {
    return false
  }
  if (status !== 'available' || !isNewer(release.version, currentVersion())) {
    return status === 'ready'
  }
  if (!Capacitor.isNativePlatform()) {
    // 网页端不做预下载，直接给出发布页
    useUpdate.setState({ status: 'available' })
    return false
  }

  useUpdate.setState({ status: 'downloading', percent: 0, error: '', filePath: '' })
  const finish = beginDiagnosticOperation('update', 'download.transfer', {
    version: release.version,
    expectedBytes: apk.size,
    checksumAvailable: Boolean(apk.sha256),
  })
  let receivedBytes = 0
  const listener = await UpdateNative.addListener('progress', ({ received, total }) => {
    receivedBytes = received
    useUpdate.setState({
      percent: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : -1,
    })
  }).catch(() => null)

  const fileName = fileNameFor(release)
  try {
    const check = { expectedSize: apk.size, sha256: apk.sha256 ?? null, version: release.version }
    const cached = await UpdateNative.hasFile({ fileName, ...check })
    if (cached.exists) {
      useUpdate.setState({ status: 'ready', percent: 100, filePath: cached.path })
      finish('completed', { cached: true })
      return true
    }
    const mirrors = MIRRORS.map((m) => mirrored(m, apk.url))
    for (const url of mirrors) {
      receivedBytes = 0
      const source = new URL(url).host
      try {
        const result = await UpdateNative.download({ url, fileName, ...check })
        useUpdate.setState({ status: 'ready', percent: 100, filePath: result.path })
        finish('completed', { source, receivedBytes })
        return true
      } catch (error) {
        logEvent(
          'update',
          'download.source-failed',
          { source, receivedBytes, ...diagnosticError(error) },
          'warn'
        )
        // 换下一个源
      }
    }
    // 不让系统下载器绕过包名、证书与摘要验证；保留手动重试入口。
    useUpdate.setState({ status: 'available', error: 'download-failed', filePath: '' })
    finish('failed', { reason: 'sources-exhausted', attempts: mirrors.length, receivedBytes })
    return false
  } catch (error) {
    finish('failed', { receivedBytes, ...diagnosticError(error) })
    logEvent('update', 'download.failed', diagnosticError(error), 'error')
    useUpdate.setState({ status: 'available', error: 'download-failed', filePath: '' })
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
    if (!release?.apk) {
      return { installed: false, reason: 'no-release' }
    }
    logEvent('update', 'install.requested', { version: release.version })
    const { saveChatsBeforeRestart } = await import('./chat/store.js')
    if (!(await saveChatsBeforeRestart())) {
      logEvent('update', 'install.waiting-for-history', {}, 'warn')
      return { installed: false, reason: 'history-unsaved' }
    }
    const result = await UpdateNative.install({
      path: filePath,
      expectedSize: release.apk.size,
      sha256: release.apk.sha256 ?? null,
      version: release.version,
    })
    logEvent(
      'update',
      'install.result',
      {
        launched: result.installed,
        permissionRequired: result.reason === 'permission',
        version: release.version,
      },
      result.installed ? 'info' : 'warn'
    )
    if (!result.installed && result.reason !== 'permission') {
      useUpdate.setState({ status: 'available', filePath: '', percent: 0, error: 'install-failed' })
    }
    return result
  } catch (error) {
    logEvent('update', 'install.failed', diagnosticError(error), 'error')
    useUpdate.setState({ status: 'available', filePath: '', percent: 0, error: 'install-failed' })
    return { installed: false, reason: 'install-failed' }
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
 * 查到新版本时显示侧边栏入口，由更新说明页发起下载。
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
    logEvent('update', 'auto-check', { reason })
  }

  // 启动检查：避开首屏渲染高峰
  window.setTimeout(() => run('startup'), 2500)

  // 回到前台补查（WebView 切后台会暂停定时器，所以用可见性事件兜底）
  const onVisible = () => {
    if (
      document.visibilityState === 'visible' &&
      Date.now() - lastAutoCheck > FOREGROUND_INTERVAL
    ) {
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
