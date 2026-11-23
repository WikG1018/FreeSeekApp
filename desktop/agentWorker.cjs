const { createHash, randomUUID } = require('node:crypto')
const {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} = require('node:fs/promises')
const path = require('node:path')
const { runInNewContext } = require('node:vm')
const { DatabaseSync } = require('node:sqlite')
const { fetchText } = require('./publicWeb.cjs')

const idPattern = /^[\w-]{1,80}$/
const shaPattern = /^[a-f0-9]{64}$/
const terminal = (run) => run.status !== 'running'
const resumable = new Set(['paused', 'blocked', 'partial', 'failed'])
const protocols = new Set(['openai', 'responses', 'anthropic', 'gemini'])
const maxReplyBytes = 8 * 1024 * 1024
const publicAttempts = 24
let db, kernel, folder, active
let forgetting
let cleanup = Promise.resolve()

const saveCheckpoint = (id, checkpoint, identity) => {
  db.prepare(
    'INSERT INTO goals(id,state,identity) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state'
  ).run(id, checkpoint, identity)
}
const rowFor = (id) => db.prepare('SELECT state, identity FROM goals WHERE id=?').get(id)
const resultFor = (id) => {
  const row = rowFor(id)
  return row ? JSON.parse(kernel.view(row.state)) : undefined
}
const publish = (id, state) => {
  process.parentPort.postMessage({ type: 'state', id, status: state.run.status })
}
const openStore = async (root) => {
  folder = path.resolve(root)
  await mkdir(path.join(folder, 'files'), { recursive: true })
  const source = await readFile(path.join(__dirname, '..', 'dist', 'agent-kernel.js'), 'utf8')
  kernel = runInNewContext(
    source + '\nFreeSeekAgentKernel',
    {},
    { timeout: 3000, contextCodeGeneration: { strings: false, wasm: false } }
  )
  db = new DatabaseSync(path.join(folder, 'runs.sqlite'))
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS goals(id TEXT PRIMARY KEY,state TEXT NOT NULL,identity TEXT NOT NULL)'
  )
  for (const row of db.prepare('SELECT id,state,identity FROM goals').iterate()) {
    const state = JSON.parse(kernel.view(row.state))
    if (!terminal(state.run)) {
      saveCheckpoint(row.id, kernel.stop(row.state, 'interrupted', Date.now()), row.identity)
    }
  }
}

const readResponse = async (response) => {
  const buffer = []
  let length = 0
  for await (const chunk of response.body ?? []) {
    length += chunk.length
    if (length > maxReplyBytes) {
      throw new Error('agent-body-limit')
    }
    buffer.push(chunk)
  }
  return Buffer.concat(buffer).toString('utf8')
}

const retryAt = (headers) => {
  const now = Date.now()
  const after = headers?.retryAfter ?? ''
  const wait = /^\d{1,9}$/.test(after) ? now + Number(after) * 1000 : Date.parse(after)
  const reset = headers?.rateRemaining === '0' ? Number(headers.rateReset) * 1000 : 0
  const until = Math.max(wait > now ? wait : now, reset > now ? reset : now)
  return until > now ? Math.min(until, now + 7 * 24 * 60 * 60 * 1000) : now + 60_000
}

const nextGithubPage = (url, header) => {
  const link = /<([^>]+)>;\s*rel="next"/.exec(header ?? '')?.[1]
  if (!link) return undefined
  try {
    const current = new URL(url)
    const next = new URL(link)
    const page = Number(current.searchParams.get('page'))
    const following = Number(next.searchParams.get('page'))
    if (
      current.hostname === 'api.github.com' &&
      next.hostname === current.hostname &&
      next.pathname === current.pathname &&
      Number.isInteger(page) &&
      page > 0 &&
      following === page + 1 &&
      following <= 1000
    ) {
      return 'p' + following
    }
  } catch {
    return undefined
  }
}

const writeArtifact = async (runId, effect, signal) => {
  if (signal.aborted) {
    return { error: 'cancelled' }
  }
  const data = Buffer.from(effect.base64, 'base64')
  if (
    !data.length ||
    data.length > 2 * 1024 * 1024 ||
    typeof effect.name !== 'string' ||
    !/^[^\x00-\x1f\\/:"*?<>|]{1,90}$/.test(effect.name)
  ) {
    return { error: 'invalid-artifact' }
  }
  const sha256 = createHash('sha256').update(data).digest('hex')
  const id = createHash('sha256')
    .update(runId)
    .update('\0')
    .update(effect.name)
    .update('\0')
    .update(data)
    .digest('hex')
  const destination = path.join(folder, 'files', runId + '.' + id)
  let exists = false
  try {
    const current = await stat(destination)
    exists =
      current.isFile() &&
      current.size === data.length &&
      createHash('sha256')
        .update(await readFile(destination))
        .digest('hex') === sha256
    if (!exists) {
      return { error: 'storage' }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return { error: 'storage' }
    }
  }
  if (!exists) {
    const temporary = destination + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(temporary, data, { flag: 'wx', flush: true })
      if (signal.aborted) {
        return { error: 'cancelled' }
      }
      await rename(temporary, destination)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }
  return {
    artifact: {
      id,
      sha256,
      name: effect.name,
      size: data.length,
      mimeType: effect.mimeType,
      isImage: false,
      serverId: null,
      createdAt: Date.now(),
    },
  }
}

const observe = async (effect, job, run) => {
  const remaining = Math.max(1, run.startedAt + run.budgetMinutes * 60_000 - Date.now())
  const signal = AbortSignal.any([
    job.controller.signal,
    AbortSignal.timeout(Math.min(remaining, 25_000)),
  ])
  if (effect.kind === 'model') {
    let status
    try {
      const response = await fetch(job.wire.url, {
        method: 'POST',
        headers: job.wire.headers,
        body: JSON.stringify(effect.body),
        signal,
        redirect: 'error',
        credentials: 'omit',
      })
      status = response.status
      const content = await readResponse(response)
      if (!response.ok) {
        const rejected = [400, 422].includes(status) && /\btool|function[\s_-]?call/i.test(content)
        return { status, confirmed: true, error: rejected ? 'tools-unavailable' : 'provider-error' }
      }
      return { status, confirmed: true, content }
    } catch {
      return { status, confirmed: false, error: 'provider-error' }
    }
  }
  if (effect.kind === 'public') {
    try {
      const github = new URL(effect.url).hostname === 'api.github.com'
      if (github && job.githubRetryAt > Date.now()) {
        return { error: 'rate-limit', retryAt: job.githubRetryAt }
      }
      if (job.publicAttempts >= publicAttempts) {
        return { error: 'read-budget' }
      }
      job.publicAttempts++
      const data = await fetchText({ url: effect.url, raw: effect.raw }, signal)
      const { status, headers } = data
      if (
        status === 429 ||
        (status === 403 && (headers?.rateRemaining === '0' || headers?.retryAfter))
      ) {
        const until = retryAt(headers)
        if (github) job.githubRetryAt = until
        return { status, error: 'rate-limit', retryAt: until }
      }
      const bytes = typeof data.bytes === 'string' ? Buffer.from(data.bytes, 'base64') : undefined
      return {
        status,
        type: data.contentType,
        url: data.url,
        content: bytes?.toString('utf8'),
        error: data.error ?? (status >= 400 ? 'http-' + status : undefined),
        downloadedBytes: bytes?.length,
        truncated: data.truncated,
        nextPage: nextGithubPage(effect.url, headers?.link),
      }
    } catch (error) {
      return {
        error: signal.aborted
          ? 'timeout'
          : ['blocked', 'dns', 'redirect'].includes(error.code)
            ? error.code
            : 'network',
      }
    }
  }
  return writeArtifact(job.id, effect, signal)
}

const runLoop = async (job, state, identity) => {
  let settledStatus
  try {
    for (;;) {
      if (job.reason) {
        state = kernel.stop(state, job.reason, Date.now())
        break
      }
      const outcome = JSON.parse(kernel.next(state, Date.now()))
      state = JSON.stringify(outcome.state)
      saveCheckpoint(job.id, state, identity)
      const progress = JSON.parse(kernel.view(state))
      publish(job.id, progress)
      if (terminal(progress.run)) {
        break
      }
      if (outcome.effect) {
        const observed = await observe(outcome.effect, job, progress.run)
        // A write already committed to disk is included even if a pause arrived at that instant.
        state = kernel.apply(state, JSON.stringify(observed))
        saveCheckpoint(job.id, state, identity)
      } else {
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
  } catch {
    state = kernel.stop(state, 'interrupted', Date.now())
  } finally {
    try {
      saveCheckpoint(job.id, state, identity)
      const settled = JSON.parse(kernel.view(state))
      publish(job.id, settled)
      settledStatus = settled.run.status
    } finally {
      if (active === job) {
        active = undefined
      }
    }
  }
  return settledStatus
}

const start = (options) => {
  const { id, input, wire, resume } = options
  if (
    active ||
    forgetting === '*' ||
    forgetting === id ||
    !idPattern.test(id || '') ||
    input?.run?.id !== id ||
    input.run.mode !== 'goal' ||
    !protocols.has(input.protocol) ||
    !wire ||
    typeof wire.url !== 'string' ||
    wire.url.length > 4096 ||
    !wire.headers ||
    JSON.stringify(wire.headers).length > 16 * 1024 ||
    JSON.stringify(input).length > 14 * 1024 * 1024
  ) {
    return { started: false, reason: active ? 'busy' : 'invalid' }
  }
  const endpoint = URL.parse(wire.url)
  const model = input.body?.model
  if (
    !endpoint ||
    !['https:', 'http:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    (input.protocol !== 'gemini' && (typeof model !== 'string' || !model))
  ) {
    return { started: false, reason: 'invalid' }
  }
  // Gemini identifies its model in the request path.
  const identity = createHash('sha256')
    .update(JSON.stringify([endpoint.href, input.protocol, model ?? '']))
    .digest('hex')
  const old = rowFor(id)
  if (resume) {
    if (!old) {
      return { started: false, reason: 'checkpoint-missing' }
    }
    if (old.identity !== identity || !resumable.has(resultFor(id)?.run.status)) {
      return { started: false, reason: 'interrupted' }
    }
  } else if (old) {
    return { started: false, reason: 'interrupted' }
  }
  const checkpoint = resume
    ? kernel.resume(
        old.state,
        Date.now(),
        JSON.stringify({
          retryUnconfirmed: options.retryUnconfirmed === true,
          requestLimit: input.run?.requestLimit,
        })
      )
    : kernel.create(JSON.stringify({ ...input, run: { ...input.run, startedAt: Date.now() } }))
  saveCheckpoint(id, checkpoint, identity)
  const run = JSON.parse(kernel.view(checkpoint)).run
  if (run.status !== 'running') return { started: false, reason: run.reason || 'interrupted' }
  const job = { id, wire, controller: new AbortController(), publicAttempts: 0, githubRetryAt: 0 }
  active = job
  publish(id, JSON.parse(kernel.view(checkpoint)))
  job.done = runLoop(job, checkpoint, identity).catch(() => undefined)
  return { started: true }
}

const fileRange = async ({ id, fileId, offset }) => {
  if (
    !idPattern.test(id || '') ||
    !shaPattern.test(fileId || '') ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw new Error('invalid')
  }
  const file = resultFor(id)?.artifacts.find((item) => item.id === fileId)
  if (!file || offset >= file.size) {
    throw new Error('missing')
  }
  const handle = await open(path.join(folder, 'files', id + '.' + fileId), 'r')
  try {
    const bytes = Buffer.alloc(Math.min(256 * 1024, file.size - offset))
    const result = await handle.read(bytes, 0, bytes.length, offset)
    if (result.bytesRead !== bytes.length) {
      throw new Error('missing')
    }
    return { base64: bytes.toString('base64'), nextOffset: offset + bytes.length }
  } finally {
    await handle.close()
  }
}

const forget = async ({ id, all }) => {
  if (
    all === true
      ? id !== undefined
      : all !== undefined || typeof id !== 'string' || !idPattern.test(id)
  ) {
    return { deleted: false }
  }
  forgetting = all ? '*' : id
  try {
    if (active && (all || active.id === id)) {
      const job = active
      job.reason = 'end'
      job.controller.abort()
      await job.done
    }
    const directory = path.join(folder, 'files')
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (
        item.isFile() &&
        /^[\w-]{1,80}\.[a-f0-9]{64}(?:\.[a-f0-9-]{36}\.tmp)?$/.test(item.name) &&
        (all || item.name.startsWith(id + '.'))
      ) {
        await unlink(path.join(directory, item.name))
      }
    }
    if (all) {
      db.prepare('DELETE FROM goals').run()
    } else {
      db.prepare('DELETE FROM goals WHERE id=?').run(id)
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return { deleted: true }
  } finally {
    forgetting = undefined
  }
}

const dispatch = async (name, args) => {
  if (name === 'init') {
    await openStore(args.root)
    return { ready: true }
  }
  if (!db) {
    throw new Error('unavailable')
  }
  if (name === 'start') {
    return start(args)
  }
  if (name === 'snapshot') {
    return { snapshot: idPattern.test(args.id || '') ? resultFor(args.id) : undefined }
  }
  if (name === 'file') {
    return fileRange(args)
  }
  if (name === 'forget') {
    const deleted = cleanup.then(() => forget(args))
    cleanup = deleted.catch(() => undefined)
    return deleted
  }
  if (name === 'control') {
    if (!['pause', 'end'].includes(args.action) || !idPattern.test(args.id || '')) {
      return { changed: false }
    }
    const job = active
    if (job?.id === args.id) {
      if (job.reason !== 'end') {
        job.reason = args.action
      }
      job.controller.abort()
      const status = await job.done
      return { changed: status === (args.action === 'pause' ? 'paused' : 'stopped') }
    }
    const row = rowFor(args.id)
    if (row && args.action === 'end' && resumable.has(resultFor(args.id)?.run.status)) {
      saveCheckpoint(args.id, kernel.stop(row.state, 'end', Date.now()), row.identity)
      return { changed: true }
    }
    return { changed: false }
  }
  throw new Error('invalid')
}

process.parentPort.on('message', ({ data }) => {
  void dispatch(data.method, data.args).then(
    (value) => process.parentPort.postMessage({ seq: data.seq, value }),
    () => process.parentPort.postMessage({ seq: data.seq, error: 'agent-host-unavailable' })
  )
})
