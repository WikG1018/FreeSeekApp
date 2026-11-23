import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('../../dist/agent-kernel.js', import.meta.url), 'utf8')
const runtime = runInNewContext(source + '\nFreeSeekAgentKernel', {}, { timeout: 3000 })
const now = 1_795_300_000_000
let tests = 0
const check = (name, run) => {
  run()
  tests++
  console.log('PASS', name)
}

const tool = (name, args) => ({
  id: name,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
})
const create = (names, criteria, requestLimit = 12) =>
  runtime.create(
    JSON.stringify({
      run: {
        id: 'fixture',
        mode: 'goal',
        status: 'running',
        revision: 0,
        criteria,
        met: [],
        budgetMinutes: 5,
        budgetRequests: 12,
        requestLimit,
        segmentRequests: 0,
        totalRequests: 0,
        startedAt: now,
        elapsedMs: 0,
      },
      protocol: 'openai',
      body: { model: 'fixture', messages: [{ role: 'user', content: 'Run the fixture.' }] },
      definitions: names.map((name) => ({
        name,
        description: name,
        parameters: { type: 'object' },
      })),
      links: [],
      files: [],
    })
  )
const view = (state) =>
  JSON.parse(runtime.view(typeof state === 'string' ? state : JSON.stringify(state)))
const next = (state, elapsed = 1) =>
  JSON.parse(runtime.next(typeof state === 'string' ? state : JSON.stringify(state), now + elapsed))
const apply = (stage, content, calls = []) =>
  runtime.apply(
    JSON.stringify(stage.state),
    JSON.stringify({
      confirmed: true,
      content: JSON.stringify({
        choices: [
          {
            finish_reason: calls.length ? 'tool_calls' : 'stop',
            message: { role: 'assistant', content, ...(calls.length && { tool_calls: calls }) },
          },
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 10 },
        },
      }),
    })
  )

check(
  'healthy rounds continue across 15, 30 and 60 minutes until the cumulative request budget',
  () => {
    let state = create(['calculate'], ['Collect results.'], 4)
    for (const minute of [1, 16, 31, 61]) {
      const stage = next(state, minute * 60_000)
      assert.equal(stage.effect?.kind, 'model')
      state = apply(stage, 'Progress at minute ' + minute, [
        tool('calculate', {
          calculations: [{ operation: 'add', values: [minute, 1] }],
        }),
      ])
    }
    const exhausted = next(state, 62 * 60_000)
    assert.equal(exhausted.state.run.reason, 'budget-requests')
    assert.equal(exhausted.effect, undefined)
    assert.equal(exhausted.state.run.totalRequests, 4)
    assert.equal(view(exhausted.state).usageEntries.length, 4)
    const resumed = runtime.resume(JSON.stringify(exhausted.state), now + 64 * 60_000)
    assert.equal(view(resumed).run.status, 'blocked')
    const allowed = runtime.resume(resumed, now + 64 * 60_000, JSON.stringify({ requestLimit: 16 }))
    assert.equal(next(allowed, 64 * 60_000 + 1).state.run.totalRequests, 5)
  }
)

check('an interrupted and unconfirmed model request requires a distinct retry decision', () => {
  const started = next(create([], ['Run the task.']))
  const stopped = runtime.stop(JSON.stringify(started.state), 'interrupted', now + 2)
  assert.equal(view(stopped).run.reason, 'request-unconfirmed')
  const blocked = runtime.resume(stopped, now + 4)
  assert.equal(view(blocked).run.status, 'blocked')
  assert.equal(next(blocked).effect, undefined)
  const resumed = runtime.resume(blocked, now + 5, JSON.stringify({ retryUnconfirmed: true }))
  assert.deepEqual(next(resumed, 6).effect.body, started.effect.body)
})

check('the exact foreground 3D step stays in the checkpoint instead of running twice', () => {
  const started = next(create(['create_3d_model'], ['Export GLB.']))
  const finished = next(
    apply(started, 'Build the model.', [
      tool('create_3d_model', {
        file_name: 'test',
        format: 'glb',
        parts: [{ shape: 'box', dimensions: [1, 2, 3] }],
      }),
    ])
  )
  assert.equal(finished.effect, undefined)
  assert.equal(finished.state.run.reason, 'waiting-foreground')
  assert.equal(finished.state.run.foregroundTool.name, 'create_3d_model')
  assert.deepEqual(finished.state.pending.args.parts[0].dimensions, [1, 2, 3])
  assert.equal(view(runtime.resume(JSON.stringify(finished.state), now + 3)).run.status, 'paused')
})

check(
  'a saved note cannot verify a program test and unmet goals continue only while there is progress',
  () => {
    const started = next(
      create(
        ['create_markdown', 'verify_goal_criteria'],
        ['Write a Markdown note.', 'Run project tests and verify they pass.']
      )
    )
    const save = next(
      apply(started, 'Writing a note.', [
        tool('create_markdown', { file_name: 'note', content: 'A note.' }),
      ])
    )
    const artifact = { id: 'note', name: 'note.md', mimeType: 'text/markdown', size: 7 }
    const verify = next(runtime.apply(JSON.stringify(save.state), JSON.stringify({ artifact })))
    const last = next(
      apply(verify, 'Check the criteria.', [
        tool('verify_goal_criteria', {
          checks: [
            { criterion: 1, evidence: ['note'] },
            { criterion: 2, evidence: ['note'] },
          ],
        }),
      ])
    )
    let current = apply(last, 'The note was created.')
    assert.deepEqual(view(current).run.met, [1])
    for (let i = 0; i < 3; i++) {
      const attempt = next(current)
      assert.equal(attempt.effect.kind, 'model')
      current = apply(attempt, 'The tests were not run.')
    }
    assert.equal(view(current).run.reason, 'no-progress')
    assert.equal(view(current).artifacts[0].id, artifact.id)
  }
)

check('HTTP 429 carries a retry time and does not authorize duplicate model calls', () => {
  const started = next(create([], ['Complete work.']))
  const blocked = runtime.apply(
    JSON.stringify(started.state),
    JSON.stringify({
      status: 429,
      error: 'provider-http',
      confirmed: true,
      retryAt: now + 60_000,
    })
  )
  assert.equal(view(blocked).run.reason, 'provider-rate-limit')
  assert.equal(view(runtime.resume(blocked, now + 2)).run.status, 'blocked')
  assert.equal(view(runtime.resume(blocked, now + 60_001)).run.status, 'running')
})

const collect = (protocol, entries) => {
  runtime.startModelStream(protocol)
  for (const entry of entries) runtime.readModelEvent(JSON.stringify(entry))
  return JSON.parse(runtime.finishModelStream('provider-timeout'))
}

check('background SSE preserves OpenAI text, tool arguments and per-request usage', () => {
  const result = collect('openai', [
    { choices: [{ delta: { content: '说明' } }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 't',
                type: 'function',
                function: { name: 'calculate', arguments: '{' },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: '"value":2}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    },
    { usage: { prompt_tokens: 20 } },
  ])
  const data = JSON.parse(result.content)
  assert.equal(result.confirmed, true)
  assert.equal(data.choices[0].message.content, '说明')
  assert.equal(data.choices[0].message.tool_calls[0].function.arguments, '{"value":2}')
  assert.equal(data.usage.prompt_tokens, 20)
})

check(
  'Anthropic signed thinking, Responses terminal output and Gemini usage survive native SSE',
  () => {
    const anthropic = collect('anthropic', [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Consider it.' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'signed-sample' },
      },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ])
    assert.equal(JSON.parse(anthropic.content).content[0].signature, 'signed-sample')
    assert.deepEqual(JSON.parse(anthropic.content).usage, { input_tokens: 10, output_tokens: 5 })
    const responses = collect('responses', [
      {
        type: 'response.completed',
        response: {
          output: [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }],
        },
      },
    ])
    assert.equal(JSON.parse(responses.content).output[0].content[0].text, '完成')
    const gemini = collect('gemini', [
      {
        candidates: [{ content: { parts: [{ text: '完成' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 30 },
      },
    ])
    assert.equal(JSON.parse(gemini.content).usageMetadata.promptTokenCount, 30)
  }
)

console.log(`${tests}/${tests} passed`)
