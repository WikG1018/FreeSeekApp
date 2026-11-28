const { app, ipcMain, net } = require('electron')
const { createReadStream, createWriteStream } = require('node:fs')
const { lstat, mkdir, readdir, readFile, rename, rm, writeFile } = require('node:fs/promises')
const { performance } = require('node:perf_hooks')
const { createHash, randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const path = require('node:path')

const releaseOrigin = 'https://github.com'
const repository = 'WikG1018/FreeSeekApp'
const releaseBase = `/${repository}/releases/download/`
const releasesApi = `https://api.github.com/repos/${repository}/releases`
const latestMetadataUrls = [
  `${releasesApi}/latest`,
  `${releaseOrigin}/${repository}/releases/latest/download/update.json`,
]
const metadataUrls = new Set([
  ...latestMetadataUrls,
  ...Array.from({ length: 10 }, (_, index) => `${releasesApi}?per_page=30&page=${index + 1}`),
])
const allowedHosts = new Set([
  'github.com',
  'api.github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
])
const mirrorOrigins = ['https://gh-proxy.com', 'https://ghfast.top', 'https://ghproxy.net']
const sampleBytes = 96 * 1024
const versionPattern = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/
const installerName =
  /^freeseek-v(\d{1,6}\.\d{1,6}\.\d{1,6})-windows-x64-setup\.exe(?:\.([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{64})\.part)?$/
let downloading = false

const updateFolder = () => path.join(app.getPath('userData'), 'updates')

const isNewer = (version, installed) => {
  const [major, minor, patch] = version.split('.').map(Number)
  const [currentMajor, currentMinor, currentPatch] = installed.split('.').map(Number)
  return (
    major > currentMajor ||
    (major === currentMajor &&
      (minor > currentMinor || (minor === currentMinor && patch > currentPatch)))
  )
}

const pruneInstallers = async (version, { keep, onlyPartials = false } = {}) => {
  const folder = updateFolder()
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
  const hasVersion = versionPattern.test(version)
  const obsolete = entries.filter((entry) => {
    if (!entry.isFile() || entry.name === keep) return false
    const match = installerName.exec(entry.name)
    if (!match || (onlyPartials && !match[2])) return false
    const legacyPartial = match[2] && match[2].length !== 64
    return legacyPartial || (hasVersion && !isNewer(match[1], version))
  })
  await Promise.all(
    obsolete.map((entry) => rm(path.join(folder, entry.name), { force: true }).catch(() => {}))
  )
}

const packageCheck = (options) => {
  const { version, expectedSize, sha256 } = options ?? {}
  if (
    typeof version !== 'string' ||
    !versionPattern.test(version) ||
    !Number.isSafeInteger(expectedSize) ||
    expectedSize <= 0 ||
    expectedSize > 512 * 1024 ** 2 ||
    typeof sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sha256)
  ) {
    throw new Error('Invalid Windows update metadata')
  }
  const filename = `freeseek-v${version}-windows-x64-setup.exe`
  const folder = updateFolder()
  return { filename, folder, target: path.join(folder, filename), expectedSize, sha256, version }
}

const verified = async ({ target, expectedSize, sha256 }) => {
  try {
    const item = await lstat(target)
    if (!item.isFile() || item.size !== expectedSize) return false
    const hash = createHash('sha256')
    for await (const part of createReadStream(target)) hash.update(part)
    return hash.digest('hex') === sha256
  } catch {
    return false
  }
}

const fetchGithub = async (initial, signal) => {
  // This is only used after validating a fixed public GitHub URL. No credentials follow redirects.
  const response = await net.fetch(initial.href, { signal, credentials: 'omit', cache: 'no-store' })
  const source = new URL(response.url || initial.href)
  if (source.protocol !== 'https:' || source.port || !allowedHosts.has(source.hostname)) {
    await response.body?.cancel()
    throw new Error('Windows update redirect refused')
  }
  return response
}

const assetUrl = ({ version, filename }) => `${releaseOrigin}${releaseBase}v${version}/${filename}`
const receiptPath = () => path.join(updateFolder(), 'windows-release.json')

const rememberOfficialAsset = async (body) => {
  const release = JSON.parse(body)
  if (release.draft || release.prerelease || !Array.isArray(release.assets)) return
  const version = typeof release.tag_name === 'string' && release.tag_name.slice(1)
  if (!version || release.tag_name !== `v${version}` || !versionPattern.test(version)) return
  const asset = release.assets.find(
    (item) => item?.name === `freeseek-v${version}-windows-x64-setup.exe`
  )
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset?.digest)
  if (!digest) return
  const receipt = { version, expectedSize: asset.size, sha256: digest[1].toLowerCase() }
  const update = packageCheck(receipt)
  if (asset.browser_download_url !== assetUrl(update)) return

  await mkdir(update.folder, { recursive: true })
  const temporary = path.join(update.folder, `windows-release-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(receipt), { flag: 'wx' })
    await rename(temporary, receiptPath())
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

const readMetadata = async (_event, options) => {
  if (!metadataUrls.has(options?.url)) {
    throw new Error('Windows metadata location refused')
  }
  const response = await fetchGithub(new URL(options.url), AbortSignal.timeout(8000))
  const chunks = []
  let size = 0
  for await (const bytes of response.body ?? []) {
    size += bytes.length
    if (size > 2_000_000) {
      await response.body.cancel().catch(() => {})
      throw new Error('Windows metadata is too large')
    }
    chunks.push(bytes)
  }
  const body = Buffer.concat(chunks, size).toString('utf8')
  if (response.ok && latestMetadataUrls.includes(options.url)) {
    // An installer served by a mirror must match the digest obtained by the main process.
    await rememberOfficialAsset(body).catch(() => {})
  }
  return { status: response.status, body }
}

const downloadAddress = async (value, update) => {
  if (!isNewer(update.version, app.getVersion())) throw new Error('Windows update is obsolete')
  const direct = assetUrl(update)
  if (value === direct) return new URL(value)
  if (!mirrorOrigins.some((origin) => value === `${origin}/${direct}`)) {
    throw new Error('Windows update location refused')
  }
  const receipt = await readFile(receiptPath(), 'utf8')
    .then(JSON.parse)
    .catch(() => null)
  if (
    receipt?.version !== update.version ||
    receipt.expectedSize !== update.expectedSize ||
    receipt.sha256 !== update.sha256
  ) {
    throw new Error('Windows mirror requires verified GitHub metadata')
  }
  return new URL(value)
}

const requestAsset = (address, range, signal) =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const request = net.request({
      url: address.href,
      credentials: 'omit',
      redirect: 'manual',
      cache: 'no-store',
    })
    let response
    let redirects = 0
    const fail = (error) => {
      if (response) response.destroy(error)
      else reject(error)
    }
    const abort = () => {
      fail(signal.reason)
      request.abort()
    }
    signal.addEventListener('abort', abort, { once: true })
    request.on('close', () => signal.removeEventListener('abort', abort))
    request.on('error', fail)
    request.on('redirect', (_status, _method, url) => {
      const next = new URL(url)
      if (
        ++redirects <= 5 &&
        next.protocol === 'https:' &&
        !next.port &&
        !next.username &&
        !next.password &&
        (next.origin === address.origin || allowedHosts.has(next.hostname))
      ) {
        request.followRedirect()
      } else {
        reject(new Error('Windows update redirect refused'))
      }
    })
    request.on('response', (incoming) => {
      response = incoming
      response.on('error', () => {})
      response.on('aborted', () => response.destroy(new Error('Windows download interrupted')))
      resolve(response)
    })
    request.setHeader('Accept-Encoding', 'identity')
    if (range) request.setHeader('Range', range)
    request.end()
  })

const packageResponse = (response, expectedSize, offset, end) => {
  const type = response.headers['content-type'] ?? ''
  const encoding = response.headers['content-encoding'] ?? 'identity'
  if (/^text\/html/i.test(type) || encoding.toLowerCase() !== 'identity') {
    throw new Error('Unexpected Windows package response')
  }
  const length = response.headers['content-length']
  if (response.statusCode === 206) {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers['content-range'])
    const last = Number(match?.[2])
    if (
      !match ||
      Number(match[1]) !== offset ||
      (last !== end && last !== expectedSize - 1) ||
      Number(match[3]) !== expectedSize ||
      (length !== undefined && Number(length) !== last - offset + 1)
    ) {
      throw new Error('Windows package range mismatch')
    }
    return true
  }
  if (response.statusCode !== 200) {
    throw new Error(`Windows update HTTP ${response.statusCode}`)
  }
  if (length !== undefined && Number(length) !== expectedSize) {
    throw new Error('Windows package size mismatch')
  }
  return false
}

const probe = async (_event, options) => {
  const update = packageCheck(options)
  const address = await downloadAddress(options.url, update)
  if (address.origin === releaseOrigin) throw new Error('Only mirror sources are probed')
  const offset = options.offset
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= update.expectedSize) {
    throw new Error('Invalid Windows probe offset')
  }
  const limit = Math.min(sampleBytes, update.expectedSize - offset)
  const started = performance.now()
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 3500)
  let received = 0
  try {
    const end = offset + limit - 1
    const response = await requestAsset(address, `bytes=${offset}-${end}`, controller.signal)
    const supportsRange = packageResponse(response, update.expectedSize, offset, end)
    try {
      for await (const part of response) {
        received += Math.min(part.length, limit - received)
        if (received === limit) break
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error
    }
    if (received < Math.min(16 * 1024, limit)) throw new Error('Windows mirror sample incomplete')
    return {
      supportsRange,
      bytesPerSecond: Math.round((received * 1000) / Math.max(1, performance.now() - started)),
    }
  } finally {
    clearTimeout(deadline)
    controller.abort()
  }
}

const partialPath = (update) => `${update.target}.${update.sha256}.part`
const partialSize = async (file, expectedSize) => {
  const item = await lstat(file).catch(() => null)
  if (!item) return 0
  if (item.isFile() && item.size <= expectedSize) return item.size
  await rm(file, { force: true })
  return 0
}

const transfer = async (event, options, address, update, temporary, offset) => {
  const controller = new AbortController()
  const deadline = setTimeout(
    () => controller.abort(new Error('Windows download deadline')),
    3600_000
  )
  const noProgress = () => controller.abort(new Error('Windows download stalled'))
  const idle = setTimeout(noProgress, 12_000)
  try {
    const signal = controller.signal
    const response = await requestAsset(address, offset ? `bytes=${offset}-` : '', signal)
    if (offset && [200, 416].includes(response.statusCode)) return { restartRequired: true }
    const ranged = packageResponse(response, update.expectedSize, offset, update.expectedSize - 1)
    const append = offset > 0 && ranged
    let received = append ? offset : 0
    let windowStart = performance.now()
    let windowBytes = received
    let lastProgress = 0
    let slowRate
    const check = new Transform({
      transform(part, _encoding, callback) {
        idle.refresh()
        received += part.length
        if (received > update.expectedSize) {
          callback(new Error('Windows update exceeds the published size'))
          return
        }
        const now = performance.now()
        if (now - lastProgress >= 150 && !event.sender.isDestroyed()) {
          lastProgress = now
          event.sender.send('freeseek:update:progress', { received, total: update.expectedSize })
        }
        if (options.stopIfSlow && now - windowStart >= 12_000) {
          const rate = ((received - windowBytes) * 1000) / (now - windowStart)
          if (rate < 128 * 1024 && update.expectedSize - received > rate * 30) {
            slowRate = Math.round(rate)
          }
          windowStart = now
          windowBytes = received
        }
        callback(null, part)
        if (slowRate !== undefined) controller.abort(new Error('Windows direct download is slow'))
      },
    })
    try {
      await pipeline(response, check, createWriteStream(temporary, { flags: append ? 'a' : 'w' }), {
        signal,
      })
    } catch (error) {
      if (slowRate !== undefined) return { slow: true, bytesPerSecond: slowRate }
      throw signal.aborted ? signal.reason : error
    }
    if (received !== update.expectedSize) throw new Error('Windows update download incomplete')
    return null
  } finally {
    clearTimeout(idle)
    clearTimeout(deadline)
    controller.abort()
  }
}

const download = async (event, options) => {
  if (downloading) throw new Error('Windows update download already running')
  downloading = true
  try {
    const update = packageCheck(options)
    const address = await downloadAddress(options.url, update)
    const temporary = partialPath(update)
    if (await verified(update)) {
      await pruneInstallers(update.version, { keep: update.filename })
      return { path: update.target, size: update.expectedSize, cached: true }
    }
    await mkdir(update.folder, { recursive: true })
    await pruneInstallers(update.version, { keep: path.basename(temporary), onlyPartials: true })
    let offset = await partialSize(temporary, update.expectedSize)
    const partial = { ...update, target: temporary }
    if (offset === update.expectedSize && !(await verified(partial))) {
      await rm(temporary, { force: true })
      offset = 0
    }
    if (offset < update.expectedSize) {
      const result = await transfer(
        event,
        options,
        address,
        update,
        temporary,
        options.allowRestart ? 0 : offset
      )
      if (result) return result
      if (!(await verified(partial))) {
        await rm(temporary, { force: true })
        if (offset > 0 && !options.allowRestart) return { restartRequired: true }
        throw new Error('Windows update verification failed')
      }
    }
    await rename(temporary, update.target)
    await pruneInstallers(update.version, { keep: update.filename })
    return { path: update.target, size: update.expectedSize }
  } finally {
    downloading = false
  }
}

const registerWindowsUpdates = (authorize) => {
  const startupCleanup = pruneInstallers(app.getVersion())
  const handle = (name, action) =>
    ipcMain.handle(name, async (event, options) => {
      if (!authorize(event) || event.senderFrame !== event.sender.mainFrame) {
        throw new Error('Untrusted update request')
      }
      await startupCleanup
      return action(event, options)
    })
  handle('freeseek:update:get', readMetadata)
  handle('freeseek:update:has', async (_event, options) => {
    const update = packageCheck(options)
    const exists = await verified(update)
    return {
      exists,
      path: exists ? update.target : '',
      size: exists ? update.expectedSize : 0,
      partialBytes: exists ? 0 : await partialSize(partialPath(update), update.expectedSize),
    }
  })
  handle('freeseek:update:probe', probe)
  handle('freeseek:update:download', download)
  handle('freeseek:update:install', async (_event, options) => {
    const update = packageCheck(options)
    if (
      !isNewer(update.version, app.getVersion()) ||
      options.path !== update.target ||
      !(await verified(update))
    ) {
      return { installed: false, reason: 'verification-or-install-failed' }
    }
    const child = spawn(update.target, [], { detached: true, stdio: 'ignore', shell: false })
    await once(child, 'spawn')
    child.unref()
    setTimeout(() => app.quit(), 100)
    return { installed: true }
  })
}

module.exports = { registerWindowsUpdates }
