const { lookup } = require('node:dns')
const { get } = require('node:https')
const { BlockList, isIPv4 } = require('node:net')
const { ipcMain } = require('electron')

const MAX_BYTES = 1024 * 1024
const MAX_REDIRECTS = 4
const MAX_TIMEOUT = 15_000
const scheme = 'freeseek:task-web:'
const redirects = new Set([301, 302, 303, 307, 308])
const hostname = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i
const localDomain = /\.(?:localhost|local|lan|internal|home\.arpa|onion)$/i
const credential =
  /^(?:access[-_]?token|auth(?:orization)?|api[-_]?key|key|token|session(?:id)?|signature|sig|password|x-amz-.+|x-goog-.+)$/i
const textMime =
  /^(?:text\/[^;]+|application\/(?:[\w.-]+\+)?(?:json|xml|xhtml\+xml|x-yaml|yaml|javascript))(?:;|$)/i
const ipv4 = new BlockList()
for (const [address, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
]) {
  ipv4.addSubnet(address, bits)
}
const syntheticDns = new BlockList()
syntheticDns.addSubnet('198.18.0.0', 15)
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
const specialV6 = new BlockList()
for (const [address, bits] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
]) {
  specialV6.addSubnet(address, bits, 'ipv6')
}

const publicAddress = ({ address, family }) =>
  family === 4
    ? !ipv4.check(address)
    : family === 6 && globalV6.check(address, 'ipv6') && !specialV6.check(address, 'ipv6')

const fail = (code) => Object.assign(new Error(code), { code })
const publicUrl = (value) => {
  if (typeof value !== 'string' || value.length > 2048) {
    throw fail('blocked')
  }
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hostname.length > 253 ||
    !hostname.test(url.hostname) ||
    localDomain.test(url.hostname) ||
    [...url.searchParams.keys()].some((key) => credential.test(key))
  ) {
    throw fail('blocked')
  }
  url.hash = ''
  return url
}

// Some VPNs return synthetic 198.18/15 answers. Resolve those public names again over HTTPS
// and pass only the checked, real addresses to the website connection.
const resolvePublicV4 = (host) =>
  new Promise((resolve, reject) => {
    const target = new URL('https://1.1.1.1/dns-query')
    target.searchParams.set('name', host)
    target.searchParams.set('type', 'A')
    const request = get(
      target,
      {
        agent: false,
        signal: AbortSignal.timeout(4500),
        headers: { Accept: 'application/dns-json', 'Accept-Encoding': 'identity' },
      },
      (response) => {
        response.once('error', reject)
        if (response.statusCode !== 200) {
          response.destroy()
          reject(fail('dns'))
          return
        }
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
          if (body.length > 32768) {
            response.destroy(fail('dns'))
          }
        })
        response.on('end', () => {
          try {
            const data = JSON.parse(body)
            resolve(
              data.Status === 0 && Array.isArray(data.Answer)
                ? data.Answer.filter((answer) => answer.type === 1 && isIPv4(answer.data))
                    .map((answer) => ({ address: answer.data, family: 4 }))
                    .filter(publicAddress)
                : []
            )
          } catch {
            reject(fail('dns'))
          }
        })
      }
    )
    request.once('error', reject)
  })

// Pass the checked DNS answers directly to the TLS connection, including after redirects.
const publicLookup = (host, options, callback) => {
  lookup(host, { ...options, all: true }, (error, results) => {
    if (error) return callback(fail('dns'))
    const finish = (addresses) => {
      if (!addresses.length) return callback(fail('blocked'))
      if (options.all) return callback(null, addresses)
      callback(null, addresses[0].address, addresses[0].family)
    }
    const addresses = results.filter(publicAddress)
    if (
      addresses.length ||
      !results.length ||
      !results.every(({ address, family }) => family === 4 && syntheticDns.check(address))
    ) {
      finish(addresses)
    } else {
      void resolvePublicV4(host).then(finish, () => callback(fail('dns')))
    }
  })
}

const fetchOnce = (url, raw, signal) =>
  new Promise((resolve, reject) => {
    const request = get(
      url,
      {
        agent: false,
        lookup: publicLookup,
        signal,
        headers: {
          Accept:
            raw && url.hostname === 'api.github.com'
              ? 'application/vnd.github.raw+json'
              : 'text/html, text/plain, application/json, application/xml;q=0.9, */*;q=0.1',
          'Accept-Encoding': 'identity',
          'User-Agent': 'FreeSeek-WebReader',
        },
      },
      (response) => {
        const status = response.statusCode
        const contentType = response.headers['content-type'] ?? ''
        const header = (name, limit) => {
          const value = response.headers[name]
          return typeof value === 'string' ? value.slice(0, limit) : undefined
        }
        const github = url.hostname === 'api.github.com'
        const headers = {
          status,
          contentType,
          headers: {
            retryAfter: header('retry-after', 96),
            ...(github && {
              link: header('link', 4096),
              rateRemaining: header('x-ratelimit-remaining', 16),
              rateReset: header('x-ratelimit-reset', 16),
            }),
          },
        }
        response.once('error', reject)
        if (redirects.has(status)) {
          resolve({ ...headers, location: response.headers.location })
          response.destroy()
          return
        }
        if (status < 200 || status >= 300) {
          resolve(headers)
          response.destroy()
          return
        }
        if (
          !textMime.test(contentType) ||
          (response.headers['content-encoding'] &&
            response.headers['content-encoding'] !== 'identity')
        ) {
          resolve({ ...headers, error: 'unsupported' })
          response.destroy()
          return
        }
        const chunks = []
        let size = 0
        const finish = (truncated) =>
          resolve({ ...headers, bytes: Buffer.concat(chunks, size).toString('base64'), truncated })
        response.on('data', (chunk) => {
          const accepted = chunk.subarray(0, MAX_BYTES - size)
          chunks.push(accepted)
          size += accepted.length
          if (accepted.length < chunk.length) {
            finish(true)
            response.destroy()
          }
        })
        response.on('end', () => finish(false))
      }
    )
    request.once('error', reject)
  })

const fetchText = async ({ url, raw, sameOrigin }, signal) => {
  let target = publicUrl(url)
  const origin = target.origin
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { location, ...result } = await fetchOnce(target, raw === true, signal)
    if (!redirects.has(result.status)) return { ...result, url: target.href, redirects: hop }
    if (!location || hop === MAX_REDIRECTS) throw fail('redirect')
    target = publicUrl(new URL(location, target).href)
    if (sameOrigin === true && target.origin !== origin) throw fail('blocked')
  }
}

const registerPublicWeb = (isTrusted) => {
  const active = new Map()
  ipcMain.handle(scheme + 'read', async (event, options) => {
    const { id, timeoutMs } = options ?? {}
    if (
      !isTrusted(event) ||
      typeof id !== 'string' ||
      !/^[\w-]{1,80}$/.test(id) ||
      active.size >= 4 ||
      active.has(id) ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0
    ) {
      return { error: 'blocked' }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort('timeout'), Math.min(timeoutMs, MAX_TIMEOUT))
    active.set(id, controller)
    try {
      return await fetchText(options, controller.signal)
    } catch (error) {
      const code = ['blocked', 'dns', 'redirect'].includes(error.code) ? error.code : 'network'
      return { error: controller.signal.aborted ? controller.signal.reason : code }
    } finally {
      clearTimeout(timer)
      active.delete(id)
    }
  })
  ipcMain.handle(scheme + 'cancel', (event, { id } = {}) => {
    if (isTrusted(event)) active.get(id)?.abort('cancelled')
  })
}

module.exports = { registerPublicWeb, fetchText }
