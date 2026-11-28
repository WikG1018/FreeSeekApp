const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { EventEmitter } = require('node:events')
const { mkdtemp, mkdir, readdir, readFile, writeFile, rm, rmdir } = require('node:fs/promises')
const Module = require('node:module')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const { test } = require('node:test')

const version = '3.2.1'
const name = 'freeseek-v3.2.1-windows-x64-setup.exe'
const asset = 'https://github.com/WikG1018/FreeSeekApp/releases/download/v3.2.1/' + name
const mirror = 'https://ghfast.top/' + asset
const metadata = 'https://api.github.com/repos/WikG1018/FreeSeekApp/releases/latest'
const payload = Buffer.from('synthetic installer bytes for update testing')
const check = {
  version,
  expectedSize: payload.length,
  sha256: createHash('sha256').update(payload).digest('hex'),
}
const prefix = 10
const tail = payload.subarray(prefix)
const rangeHeader = 'bytes ' + prefix + '-' + (payload.length - 1) + '/' + payload.length
const filename = name + '.' + check.sha256 + '.part'

const testFolder = async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), 'freeseek-windows-update-'))
  const updates = path.join(folder, 'updates')
  await mkdir(updates)
  t.after(async () => {
    for (const item of await readdir(updates)) {
      await rm(path.join(updates, item), { force: true })
    }
    await rmdir(updates)
    await rmdir(folder)
  })
  return { folder, updates }
}

const fixture = (folder, serve) => {
  const handlers = new Map()
  const sender = { mainFrame: {}, isDestroyed: () => false, send: () => {} }
  const electron = {
    app: { getPath: () => folder, getVersion: () => '3.1.16' },
    ipcMain: { handle: (topic, handler) => handlers.set(topic, handler) },
    net: {
      fetch: async (url) => {
        assert.equal(url, metadata)
        return Response.json({
          tag_name: 'v' + version,
          assets: [
            {
              name,
              browser_download_url: asset,
              size: payload.length,
              digest: 'sha256:' + check.sha256,
            },
          ],
        })
      },
      request: ({ url }) => {
        const request = new EventEmitter()
        const headers = {}
        request.setHeader = (key, value) => {
          headers[key] = value
        }
        request.abort = () => request.emit('close')
        request.end = () => {
          const { status, body, range } = serve(url, headers.Range)
          const incoming = Readable.from([body])
          incoming.statusCode = status
          incoming.headers = {
            'content-length': String(status === 206 ? body.length : payload.length),
            'content-type': 'application/octet-stream',
            ...(range ? { 'content-range': range } : {}),
          }
          incoming.on('close', () => request.emit('close'))
          queueMicrotask(() => request.emit('response', incoming))
        }
        return request
      },
    },
  }
  const updater = require.resolve('../../desktop/updates.cjs')
  delete require.cache[updater]
  const load = Module._load
  try {
    Module._load = function (id, ...args) {
      return id === 'electron' ? electron : load.call(this, id, ...args)
    }
    require(updater).registerWindowsUpdates(() => true)
  } finally {
    Module._load = load
  }
  return (topic, options = check) =>
    handlers.get('freeseek:update:' + topic)({ sender, senderFrame: sender.mainFrame }, options)
}

test('Windows preserves an interrupted installer across launch and resumes a verified mirror asset', async (t) => {
  const { folder, updates } = await testFolder(t)
  const first = fixture(folder, (url, range) => {
    assert.equal(url, asset)
    assert.equal(range, undefined)
    return { status: 200, body: payload.subarray(0, prefix) }
  })
  await first('get', { url: metadata })
  await assert.rejects(first('download', { ...check, url: asset }), /incomplete/)
  assert.equal((await first('has')).partialBytes, prefix)
  await writeFile(path.join(updates, 'freeseek-v3.1.16-windows-x64-setup.exe'), 'old')

  const next = fixture(folder, (url, range) => {
    assert.equal(url, mirror)
    assert.equal(range, 'bytes=10-')
    return { status: 206, body: tail, range: rangeHeader }
  })
  assert.equal((await next('has')).partialBytes, prefix)
  await assert.rejects(
    next('download', { ...check, sha256: 'b'.repeat(64), url: mirror }),
    /verified GitHub metadata/
  )
  const result = await next('download', { ...check, url: mirror })
  assert.deepEqual(await readFile(result.path), payload)
  assert.equal((await next('has')).exists, true)
  assert.deepEqual((await readdir(updates)).sort(), [name, 'windows-release.json'].sort())
})

test('Windows never appends an ignored or mismatched range and rejects a bad complete digest', async (t) => {
  const { folder, updates } = await testFolder(t)
  await writeFile(path.join(updates, filename), payload.subarray(0, prefix))
  let expectedRange = 'bytes=10-'
  let reply = { status: 206, body: tail, range: rangeHeader.replace('bytes 10-', 'bytes 9-') }
  const invoke = fixture(folder, (url, range) => {
    assert.equal(url, asset)
    assert.equal(range, expectedRange)
    return reply
  })
  await assert.rejects(invoke('download', { ...check, url: asset }), /range mismatch/)
  assert.equal((await invoke('has')).partialBytes, prefix)
  reply = { status: 200, body: payload }
  assert.deepEqual(await invoke('download', { ...check, url: asset }), { restartRequired: true })
  assert.equal((await invoke('has')).partialBytes, prefix)
  expectedRange = undefined
  reply = { status: 200, body: Buffer.alloc(payload.length) }
  await assert.rejects(
    invoke('download', { ...check, url: asset, allowRestart: true }),
    /verification failed/
  )
  assert.deepEqual(await readdir(updates), [])
})
