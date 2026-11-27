const { app, ipcMain, net } = require('electron')
const { createReadStream, createWriteStream } = require('node:fs')
const { mkdir, readdir, rename, rm, stat } = require('node:fs/promises')
const { createHash, randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const path = require('node:path')

const releaseOrigin = 'https://github.com'
const repository = 'WikG1018/FreeSeekApp'
const releaseBase = `/${repository}/releases/download/`
const releasesApi = `https://api.github.com/repos/${repository}/releases`
const metadataUrls = new Set([
  `${releasesApi}/latest`,
  `${releaseOrigin}/${repository}/releases/latest/download/update.json`,
  ...Array.from({ length: 10 }, (_, index) => `${releasesApi}?per_page=30&page=${index + 1}`),
])
const allowedHosts = new Set([
  'github.com',
  'api.github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
])
const versionPattern = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/
const installerName =
  /^freeseek-v(\d{1,6}\.\d{1,6}\.\d{1,6})-windows-x64-setup\.exe(?:\.([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.part)?$/
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

const pruneInstallers = async (version, { keep, partials = false } = {}) => {
  const folder = updateFolder()
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
  const hasVersion = versionPattern.test(version)
  const obsolete = entries.filter((entry) => {
    if (!entry.isFile() || entry.name === keep) return false
    const match = installerName.exec(entry.name)
    return match && (match[2] ? partials : hasVersion && !isNewer(match[1], version))
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
    const item = await stat(target)
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
      throw new Error('Windows metadata is too large')
    }
    chunks.push(bytes)
  }
  return { status: response.status, body: Buffer.concat(chunks, size).toString('utf8') }
}

const download = async (event, options) => {
  const update = packageCheck(options)
  const address = new URL(options.url)
  if (
    downloading ||
    address.origin !== releaseOrigin ||
    address.username ||
    address.password ||
    address.search ||
    address.hash ||
    address.pathname !== `${releaseBase}v${update.version}/${update.filename}`
  ) {
    throw new Error('Windows update location refused')
  }
  downloading = true
  const temporary = `${update.target}.${randomUUID()}.part`
  try {
    if (await verified(update)) {
      await pruneInstallers(update.version, { keep: update.filename })
      return { path: update.target, size: update.expectedSize, cached: true }
    }
    await mkdir(update.folder, { recursive: true })
    const signal = AbortSignal.timeout(6 * 60_000)
    const response = await fetchGithub(address, signal)
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error('Windows update asset unavailable')
    }
    const hash = createHash('sha256')
    let received = 0
    let lastProgress = 0
    const check = new Transform({
      transform(part, _encoding, callback) {
        received += part.length
        if (received > update.expectedSize) {
          callback(new Error('Windows update exceeds the published size'))
          return
        }
        hash.update(part)
        if (Date.now() - lastProgress >= 150 && !event.sender.isDestroyed()) {
          lastProgress = Date.now()
          event.sender.send('freeseek:update:progress', { received, total: update.expectedSize })
        }
        callback(null, part)
      },
    })
    await pipeline(
      Readable.fromWeb(response.body),
      check,
      createWriteStream(temporary, { flags: 'wx' }),
      {
        signal,
      }
    )
    if (received !== update.expectedSize || hash.digest('hex') !== update.sha256) {
      throw new Error('Windows update verification failed')
    }
    await rename(temporary, update.target)
    await pruneInstallers(update.version, { keep: update.filename })
    return { path: update.target, size: received }
  } finally {
    downloading = false
    await rm(temporary, { force: true }).catch(() => {})
  }
}

const registerWindowsUpdates = (authorize) => {
  const startupCleanup = pruneInstallers(app.getVersion(), { partials: true })
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
    return { exists, path: exists ? update.target : '', size: exists ? update.expectedSize : 0 }
  })
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
