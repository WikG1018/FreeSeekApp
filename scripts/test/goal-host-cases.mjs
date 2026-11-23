import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { strFromU8, unzipSync } from 'fflate'
import { _electron as electron } from 'playwright'

const root = path.resolve(import.meta.dirname, '../..')
const temporary = path.join(root, 'tmp', 'goal-host-smoke')
await mkdir(temporary, { recursive: true })
const attempt = await mkdtemp(path.join(temporary, 'run-'))
const stage = process.env.FREESEEK_GOAL_SMOKE_STAGE || attempt
if (stage === attempt) {
  await cp(path.join(root, 'desktop'), path.join(stage, 'desktop'), { recursive: true })
  await cp(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true })
}
const profile = path.join(attempt, 'profile')
const authorization = 'Bearer fixture-goal-a'
let app,
  page,
  failures = 0
const routes = new Map()
const test = async (title, callback) => {
  try {
    await callback()
    console.log('PASS', title)
  } catch (error) {
    failures++
    console.error('FAIL', title, error)
  }
}

async function until(read, predicate, description) {
  const end = Date.now() + 10_000
  let value
  do {
    value = await read()
    if (predicate(value)) return value
    await delay(50)
  } while (Date.now() < end)
  throw new Error('Timed out: ' + description + ' (' + JSON.stringify(value) + ')')
}

const send = (response, status, data, headers = {}) => {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  response.end(JSON.stringify(data))
}
const provider = createServer(async (request, response) => {
  const route = routes.get(request.url)
  if (!route) {
    send(response, 404, { error: 'Unknown smoke fixture route' })
    return
  }
  try {
    assert.equal(request.method, 'POST')
    assert.equal(request.headers.authorization, authorization)
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    assert.equal(body.stream, false)
    assert.equal(body.model, 'fixture-model')
    route.requests.push(body)
    const index = route.requests.length
    await route.respond(index, body, response)
  } catch (error) {
    route.errors.push(error)
    if (!response.headersSent) send(response, 500, { error: 'Broken smoke fixture' })
  }
})
provider.listen(0, '127.0.0.1')
await once(provider, 'listening')
const origin = 'http://127.0.0.1:' + provider.address().port

const reply = (response, { content = null, calls = [] }) => {
  send(response, 200, {
    choices: [
      {
        finish_reason: calls.length ? 'tool_calls' : 'stop',
        message: {
          role: 'assistant',
          content,
          ...(calls.length && { tool_calls: calls }),
        },
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 3,
      prompt_tokens_details: { cached_tokens: 2 },
    },
  })
}
const toolCall = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
})
const plan = (status) =>
  toolCall('plan-' + status, 'update_task_plan', {
    steps: [{ label: 'Write and verify the results', status }],
  })
const word = toolCall('word', 'create_document', {
  file_name: 'goal-test',
  title: 'Fixture document',
  sections: [{ heading: 'Source', text: '原始证据 & source material' }],
})
const sheet = toolCall('sheet', 'create_spreadsheet', {
  file_name: 'goal-sheet',
  sheets: [{ name: 'Evidence', rows: [['Source'], ['Cell witness'], [42]] }],
})
const artifactFor = (body, callId) => {
  const tool = body.messages.find(({ tool_call_id }) => tool_call_id === callId)
  assert.ok(tool, 'Expected persisted tool response for ' + callId)
  const { artifactId } = JSON.parse(tool.content.split('\n')[0])
  assert.match(artifactId, /^[a-f0-9]{64}$/)
  return artifactId
}
const verification = (evidence) =>
  toolCall('verify', 'verify_goal_criteria', { checks: [{ criterion: 1, evidence }] })

const definition = (name) => ({
  name,
  description: 'Smoke fixture tool',
  parameters: { type: 'object', properties: {} },
})
const startOptions = (id, route, options = {}) => ({
  id,
  resume: false,
  wire: {
    url: origin + route,
    headers: { 'Content-Type': 'application/json', Authorization: authorization },
  },
  input: {
    protocol: 'openai',
    body: { model: 'fixture-model', messages: [{ role: 'user', content: 'Write a report' }] },
    definitions: [
      'update_task_plan',
      'create_document',
      'create_spreadsheet',
      'verify_goal_criteria',
      'calculate',
    ].map(definition),
    links: [],
    files: [],
    run: {
      id,
      mode: 'goal',
      status: 'running',
      revision: 0,
      criteria: ['Write and verify report'],
      met: [],
      budgetMinutes: 5,
      budgetRequests: 12,
      segmentRequests: 0,
      totalRequests: 0,
      startedAt: Date.now(),
      elapsedMs: 0,
    },
  },
  ...options,
})

const launch = async (appStage = stage, testEnv = {}) => {
  app = await electron.launch({
    args: [path.join(appStage, 'desktop', 'main.cjs'), '--user-data-dir=' + profile],
    env: { ...process.env, ...testEnv },
    timeout: 20_000,
  })
  page = await app.firstWindow()
  await page.waitForURL('freeseek://app/')
  assert.equal(
    path.resolve(await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))),
    path.resolve(profile)
  )
  assert.deepEqual(await call('permission'), { granted: true })
}
const call = (method, args) =>
  page.evaluate(([channel, value]) => window.freeseekAgentGoals[channel](value), [method, args])
const snapshot = async (id) => (await call('snapshot', { id })).snapshot
const awaitStatus = (id, status) =>
  until(
    () => snapshot(id),
    (result) => result?.run.status === status,
    id + ' ' + status
  )
const route = (url, respond) => {
  const entry = { requests: [], errors: [], respond }
  routes.set(url, entry)
  return entry
}
const readArtifact = async (id, artifact, xmlPath, marker) => {
  const pieces = []
  let offset = 0
  while (offset < artifact.size) {
    const part = await call('file', { id, fileId: artifact.id, offset })
    const bytes = Buffer.from(part.base64, 'base64')
    assert.ok(bytes.length > 0)
    assert.equal(part.nextOffset, offset + bytes.length)
    pieces.push(bytes)
    offset = part.nextOffset
  }
  const file = Buffer.concat(pieces)
  assert.equal(file.length, artifact.size)
  assert.equal(createHash('sha256').update(file).digest('hex'), artifact.sha256)
  const contents = unzipSync(file)
  assert.ok(contents['[Content_Types].xml'])
  assert.ok(contents['_rels/.rels'])
  assert.ok(contents[xmlPath], 'Expected ' + xmlPath)
  assert.ok(strFromU8(contents[xmlPath]).includes(marker))
  const middle = Math.floor(file.length / 2)
  const range = await call('file', { id, fileId: artifact.id, offset: middle })
  assert.deepEqual(Buffer.from(range.base64, 'base64'), file.subarray(middle))
  await assert.rejects(call('file', { id: 'different-run', fileId: artifact.id, offset: 0 }))
  return artifact
}

try {
  await launch()
  await test('Goal uses the utility process and completes with the window closed to its tray', async () => {
    const id = 'hidden'
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const model = route('/hidden', async (count, body, response) => {
      if (count === 1) {
        await gate
        reply(response, { calls: [plan('working'), word, sheet] })
      } else if (count === 2) {
        reply(response, {
          calls: [
            verification([artifactFor(body, 'word'), artifactFor(body, 'sheet')]),
            plan('done'),
          ],
        })
      } else {
        reply(response, { content: 'Both files verified.' })
      }
    })
    await app.evaluate(({ Tray }) => {
      const setToolTip = Tray.prototype.setToolTip
      globalThis.goalSmokeRestoreTray = () => {
        Tray.prototype.setToolTip = setToolTip
        delete globalThis.goalSmokeTray
      }
      Tray.prototype.setToolTip = function (label) {
        globalThis.goalSmokeTray = { icon: this, label }
        setToolTip.call(this, label)
      }
    })
    const options = startOptions(id, '/hidden')
    assert.deepEqual(await call('start', options), { started: true })
    await until(
      () => model.requests.length,
      (count) => count === 1,
      'initial model request'
    )
    assert.equal((await snapshot(id)).run.requestInFlight, true)
    assert.deepEqual(await call('start', startOptions('busy', '/hidden')), {
      started: false,
      reason: 'busy',
    })
    await app.evaluate(({ BrowserWindow, dialog }) => {
      globalThis.goalSmokeOriginalDialog = dialog.showMessageBox
      dialog.showMessageBox = async () => ({ response: 0 })
      BrowserWindow.getAllWindows()[0].close()
    })
    await until(
      () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      (visible) => !visible,
      'window hidden to system tray'
    )
    release()
    // The worker must finish all calls while the renderer has no polling subscription.
    await until(
      () => model.requests.length,
      (count) => count === 3,
      'requests while in tray'
    )
    const trayAfterCompletion = await until(
      () =>
        app.evaluate(() => {
          const tray = globalThis.goalSmokeTray
          return tray && { label: tray.label, destroyed: tray.icon.isDestroyed() }
        }),
      (tray) => tray?.label === 'FreeSeek' || tray?.destroyed,
      'tray state after hidden task completed'
    )
    const reopened = await app.evaluate(({ app: electronApp, BrowserWindow, dialog }) => {
      dialog.showMessageBox = globalThis.goalSmokeOriginalDialog
      electronApp.emit('second-instance')
      const window = BrowserWindow.getAllWindows()[0]
      const visible = window.isVisible()
      if (!visible) window.show()
      const trayDestroyed = globalThis.goalSmokeTray.icon.isDestroyed()
      globalThis.goalSmokeRestoreTray()
      return { visible, trayDestroyed }
    })
    const saved = await awaitStatus(id, 'completed')
    assert.equal(saved.run.totalRequests, 3)
    assert.deepEqual(saved.run.met, [1])
    assert.equal(saved.answer, 'Both files verified.')
    assert.equal(saved.plan.at(-1).status, 'done')
    assert.deepEqual(saved.usage, {
      input: 24,
      output: 9,
      cacheRead: 6,
      cacheWrite: 0,
      cacheCounts: { hit: 6, input: 30 },
    })
    assert.equal(saved.artifacts.length, 2)
    await readArtifact(
      id,
      saved.artifacts[0],
      'word/document.xml',
      '原始证据 &amp; source material'
    )
    await readArtifact(id, saved.artifacts[1], 'xl/worksheets/sheet1.xml', 'Cell witness')
    assert.deepEqual(model.errors, [])
    assert.equal(reopened.visible, true, 'Opening FreeSeek again must restore the hidden window')
    assert.equal(trayAfterCompletion.destroyed, false, 'The hidden app needs a way to return')
    assert.equal(reopened.trayDestroyed, true, 'Tray may close after the app returned')
  })

  await test('429 leaves a durable checkpoint and a manual retry reuses its document', async () => {
    const id = 'retry'
    const model = route('/retry', (count, body, response) => {
      if (count === 1) {
        reply(response, { calls: [word] })
      } else if (count === 2) {
        send(response, 429, { error: 'Fixture rate limit' }, { 'Retry-After': '1' })
      } else if (count === 3) {
        reply(response, { calls: [verification([artifactFor(body, 'word')])] })
      } else {
        reply(response, { content: 'The existing report is ready.' })
      }
    })
    const options = startOptions(id, '/retry')
    assert.deepEqual(await call('start', options), { started: true })
    const beforeRetry = await awaitStatus(id, 'blocked')
    assert.equal(beforeRetry.run.reason, 'provider-rate-limit')
    assert.equal(beforeRetry.run.requestInFlight, false)
    assert.equal(beforeRetry.artifacts.length, 1)
    assert.equal(model.requests.length, 2)
    await app.close()
    await launch()
    const reloaded = await snapshot(id)
    assert.deepEqual(reloaded, beforeRetry)
    await readArtifact(id, reloaded.artifacts[0], 'word/document.xml', 'Fixture document')
    assert.equal(model.requests.length, 2)
    for (const changed of [
      { wire: { ...options.wire, url: origin + '/wrong-model' } },
      { input: { ...options.input, protocol: 'anthropic' } },
    ]) {
      assert.equal((await call('start', { ...options, ...changed, resume: true })).started, false)
    }
    assert.equal(model.requests.length, 2)
    assert.deepEqual(await call('start', { ...options, resume: true }), { started: true })
    const completed = await awaitStatus(id, 'completed')
    assert.deepEqual(model.requests[1].messages, model.requests[2].messages)
    assert.equal(completed.artifacts[0].id, beforeRetry.artifacts[0].id)
    assert.equal(completed.artifacts.length, 1)
    assert.equal(completed.run.totalRequests, 4)
    assert.equal(completed.run.segmentRequests, 2)
    assert.deepEqual(model.errors, [])
  })

  await test('Pause ACK leaves a paused checkpoint and continuing uses the same model identity', async () => {
    const id = 'resume'
    const model = route('/resume', (count, body, response) => {
      if (count === 1) {
        reply(response, { calls: [word] })
      } else if (count === 2) {
        // Leave the model awaiting a response until the worker aborts it.
      } else if (count === 3) {
        reply(response, { calls: [verification([artifactFor(body, 'word')])] })
      } else {
        reply(response, { content: 'Continued from the existing file.' })
      }
    })
    const options = startOptions(id, '/resume')
    assert.deepEqual(await call('start', options), { started: true })
    await until(
      () => model.requests.length,
      (count) => count === 2,
      'request before pause'
    )
    assert.deepEqual(await call('control', { id, action: 'pause' }), { changed: true })
    const paused = await snapshot(id)
    assert.equal(paused.run.status, 'paused')
    assert.equal(paused.run.reason, 'request-unconfirmed')
    assert.equal(paused.run.requestInFlight, true)
    assert.equal(paused.artifacts.length, 1)
    const changed = {
      ...options,
      resume: true,
      input: { ...options.input, body: { ...options.input.body, model: 'different-model' } },
    }
    assert.equal((await call('start', changed)).started, false)
    assert.equal(model.requests.length, 2)
    assert.deepEqual(await call('start', { ...options, resume: true }), {
      started: false,
      reason: 'request-unconfirmed',
    })
    assert.equal(model.requests.length, 2)
    assert.deepEqual(await call('start', { ...options, resume: true, retryUnconfirmed: true }), {
      started: true,
    })
    const resumed = await awaitStatus(id, 'completed')
    assert.equal(resumed.artifacts.length, 1)
    assert.equal(resumed.artifacts[0].id, paused.artifacts[0].id)
    assert.equal(resumed.run.totalRequests, 4)
    assert.equal(resumed.run.requestInFlight, false)
    assert.deepEqual(model.errors, [])
  })

  await test('Terminal and duplicate starts are rejected with no extra model call', async () => {
    for (const [id, address] of [
      ['hidden', '/hidden'],
      ['retry', '/retry'],
    ]) {
      assert.equal((await snapshot(id)).run.status, 'completed')
      const model = routes.get(address)
      const count = model.requests.length
      const options = startOptions(id, address)
      assert.equal((await call('start', options)).started, false)
      assert.equal((await call('start', { ...options, resume: true })).started, false)
      assert.equal((await call('control', { id, action: 'end' })).changed, false)
      assert.equal((await snapshot(id)).run.status, 'completed')
      assert.equal(model.requests.length, count)
    }
  })

  await test('Budget stops native effects without silently starting a new segment', async () => {
    const id = 'budget'
    const model = route('/budget', (count, _body, response) => {
      reply(response, {
        calls: [
          toolCall('compute-' + count, 'calculate', {
            calculations: [{ operation: 'add', values: [count, 1] }],
          }),
        ],
      })
    })
    assert.deepEqual(await call('start', startOptions(id, '/budget')), { started: true })
    const capped = await awaitStatus(id, 'partial')
    assert.equal(capped.run.reason, 'budget-requests')
    assert.equal(capped.run.totalRequests, 12)
    assert.equal(capped.run.segmentRequests, 12)
    assert.equal(model.requests.length, 12)
    assert.deepEqual(model.errors, [])
  })

  await test('Native Goal verifies a file across ranges and keeps a truncated attachment partial', async () => {
    const id = 'file-ranges'
    const document = '资料'.repeat(6000) + '\n末尾标记'
    const read = (id, file, position) =>
      toolCall(id, 'read_selected_attachment', { file, ...position })
    const model = route('/file-ranges', (count, body, response) => {
      if (count === 1) {
        reply(response, {
          calls: [
            read('head', 1, { start_line: 1 }),
            read('partial', 2, { offset: 0 }),
            read('find', 1, { find: '末尾标记' }),
          ],
        })
      } else if (count === 2) {
        const result = (id) => body.messages.find(({ tool_call_id }) => tool_call_id === id).content
        const head = JSON.parse(result('head').split('\n')[0])
        assert.equal(head.next_offset, 10000)
        assert.equal(head.content, document.slice(0, head.next_offset))
        assert.equal(JSON.parse(result('partial').split('\n')[0]).source_truncated, true)
        assert.equal(JSON.parse(result('find').split('\n')[0]).matches[0].line, 2)
        reply(response, { calls: [read('tail', 1, { start_line: 1, offset: head.next_offset })] })
      } else if (count === 3) {
        const reference = (id) =>
          body.messages
            .find(({ tool_call_id }) => tool_call_id === id)
            .content.split('\nResult reference: ')[1]
        reply(response, {
          calls: [
            toolCall('verify-ranges', 'verify_goal_criteria', {
              checks: [
                { criterion: 1, evidence: [reference('head'), reference('tail')] },
                { criterion: 2, evidence: [reference('partial')] },
              ],
            }),
          ],
        })
      } else {
        assert.equal(count, 4)
        reply(response, { content: '原文读完，另一个附件只读到片段。' })
      }
    })
    const options = startOptions(id, '/file-ranges')
    options.input.run.criteria = ['Read the whole file', 'Read the whole truncated attachment']
    options.input.definitions.push(definition('read_selected_attachment'))
    options.input.files = [
      { id: 'full', name: 'long.txt', text: document },
      { id: 'part', name: 'partial.txt', text: '片段', sourceTruncated: true },
    ]
    assert.deepEqual(await call('start', options), { started: true })
    const finished = await awaitStatus(id, 'partial')
    assert.deepEqual(finished.run.met, [1])
    assert.equal(finished.run.reason, 'criteria-unmet')
    assert.equal(finished.run.totalRequests, 4)
    assert.deepEqual(model.errors, [])
  })

  await test('Pause and quit leaves the paused checkpoint after restarting Electron', async () => {
    const id = 'quit'
    const model = route('/quit', (count, _body, response) => {
      if (count === 1) reply(response, { calls: [word] })
    })
    assert.deepEqual(await call('start', startOptions(id, '/quit')), { started: true })
    await until(
      () => model.requests.length,
      (count) => count === 2,
      'request before quit'
    )
    const closed = app.waitForEvent('close', { timeout: 20_000 })
    await app.evaluate(({ BrowserWindow, dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
      setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 0)
    })
    await closed
    await launch()
    const paused = await snapshot(id)
    assert.equal(paused.run.status, 'paused')
    assert.equal(paused.run.reason, 'request-unconfirmed')
    assert.equal(paused.run.totalRequests, 2)
    assert.equal(model.requests.length, 2)
    await readArtifact(id, paused.artifacts[0], 'word/document.xml', 'Fixture document')
    assert.deepEqual(model.errors, [])
    assert.equal((await call('control', { id, action: 'end' })).changed, true)
    assert.equal((await snapshot(id)).run.status, 'stopped')
    assert.equal(
      (await call('start', { ...startOptions(id, '/quit'), resume: true })).started,
      false
    )

    const hostProfile = path.join(profile, 'agent-runs')
    for (const name of await readdir(hostProfile)) {
      if (name.startsWith('runs.sqlite')) {
        const bytes = await readFile(path.join(hostProfile, name)).catch((error) => {
          if (error.code !== 'ENOENT') throw error
          return Buffer.alloc(0)
        })
        assert.ok(!bytes.includes(authorization), 'Fixture API key must not be persisted')
      }
    }
  })
  await test('Deleting Goal caches stops an active request and only removes the selected run', async () => {
    const originals = path.join(profile, 'agent-runs', 'files')
    const id = 'forget-active'
    const model = route('/forget-active', (count, _body, response) => {
      if (count === 1) reply(response, { calls: [word] })
    })
    const options = startOptions(id, '/forget-active')
    assert.deepEqual(await call('start', options), { started: true })
    await until(
      () => model.requests.length,
      (count) => count === 2,
      'active request before deletion'
    )
    assert.equal((await snapshot(id)).artifacts.length, 1)
    assert.deepEqual(await call('forget', { id, all: true }), { deleted: false })
    assert.deepEqual(await call('forget', { id }), { deleted: true })
    assert.equal(await snapshot(id), undefined)
    assert.equal((await snapshot('hidden')).run.status, 'completed')
    assert.ok((await readdir(originals)).every((name) => !name.startsWith(id + '.')))
    assert.deepEqual(await call('start', { ...options, resume: true }), {
      started: false,
      reason: 'checkpoint-missing',
    })
    assert.equal(model.requests.length, 2)
    assert.deepEqual(await call('forget', { all: true }), { deleted: true })
    assert.equal(await snapshot('hidden'), undefined)
    assert.deepEqual(await readdir(originals), [])
  })

  await test('Pause waits for an in-progress file checkpoint before acknowledging', async () => {
    const id = 'settle-write'
    const delayedStage = path.join(attempt, 'delay-write')
    const copiedDesktop = path.join(delayedStage, 'desktop')
    await cp(path.join(stage, 'desktop'), copiedDesktop, { recursive: true })
    await cp(path.join(stage, 'dist'), path.join(delayedStage, 'dist'), { recursive: true })
    await rename(
      path.join(copiedDesktop, 'agentWorker.cjs'),
      path.join(copiedDesktop, 'agentWorker.production.cjs')
    )
    // Delay the filesystem response in an isolated launch after the file reached disk.
    await writeFile(
      path.join(copiedDesktop, 'agentWorker.cjs'),
      [
        "const fs = require('node:fs/promises')",
        "const { setTimeout: delay } = require('node:timers/promises')",
        'const move = fs.rename',
        'fs.rename = async (...args) => {',
        '  await move(...args)',
        "  await fs.writeFile(process.env.FREESEEK_GOAL_SMOKE_WRITE_MARKER, 'written')",
        '  await delay(1200)',
        '}',
        "require('./agentWorker.production.cjs')",
      ].join('\n')
    )
    await app.close()
    const marker = path.join(attempt, 'delayed-write.marker')
    await launch(delayedStage, { FREESEEK_GOAL_SMOKE_WRITE_MARKER: marker })
    const model = route('/settle-write', (_count, _body, response) => {
      reply(response, {
        calls: [
          toolCall('settle-word', 'create_document', {
            file_name: 'new-delayed-write',
            title: 'Fixture document persisted before pause',
            sections: [{ text: 'The file survived.' }],
          }),
        ],
      })
    })
    const options = startOptions(id, '/settle-write')
    assert.deepEqual(await call('start', options), { started: true })
    await until(
      () => readFile(marker, 'utf8').catch(() => ''),
      (value) => value === 'written',
      'file write in progress'
    )
    assert.equal((await snapshot(id)).steps.at(-1).status, 'working')
    assert.deepEqual(await call('control', { id, action: 'pause' }), { changed: true })
    const paused = await snapshot(id)
    assert.equal(paused.run.status, 'paused', 'Pause ACK preceded the pause checkpoint')
    assert.equal(paused.artifacts.length, 1)
    assert.equal(model.requests.length, 1)
    await app.close()
    await launch()
    const restored = await snapshot(id)
    assert.deepEqual(restored, paused)
    await readArtifact(id, restored.artifacts[0], 'word/document.xml', 'The file survived.')
    assert.deepEqual(model.errors, [])
  })
} finally {
  await app?.close().catch(() => {})
  provider.closeAllConnections()
  await new Promise((resolve) => provider.close(resolve))
}
if (failures) {
  process.exitCode = 1
  console.error('Retained isolated fixture at', attempt)
} else if (!process.env.FREESEEK_KEEP_GOAL_SMOKE) {
  // attempt is created directly under the checked workspace temporary root.
  assert.equal(path.dirname(path.resolve(attempt)), path.resolve(temporary))
  await rm(attempt, { recursive: true, force: true, maxRetries: 2 })
} else {
  console.log('Retained isolated fixture at', attempt)
}
