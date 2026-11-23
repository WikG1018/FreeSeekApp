import { ApiError } from './errorTypes.js'
import type { MessageStreamEvent } from './types.js'
import type { TaskToolset } from './searchTool.js'
import { logEvent } from '../diagnostics/log.js'

export const agentProbePrompt =
  'Call freeseek_tool_probe once with value 42. Then reply with exactly the tool result.'
export const agentProbeSystem =
  'This is a read-only connection capability test. Use the provided tool.'

export type AgentToolIdentity = { id: string; revision: string; model: string; protocol: string }
type Check = { at: number; verified: boolean }
const storageKey = 'freeseek:agent-tool-checks'
const keyFor = (value: AgentToolIdentity) =>
  JSON.stringify([value.id, value.revision, value.model, value.protocol])

const readChecks = (): [string, Check][] => {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]')
    return Array.isArray(values)
      ? values
          .filter(
            (entry): entry is [string, Check] =>
              Array.isArray(entry) &&
              typeof entry[0] === 'string' &&
              Number.isFinite(entry[1]?.at) &&
              typeof entry[1]?.verified === 'boolean'
          )
          .slice(-64)
      : []
  } catch {
    return []
  }
}

export const previousAgentToolCheck = (identity: AgentToolIdentity) =>
  readChecks().find(([key]) => key === keyFor(identity))?.[1]

export const verifyAgentTools = async (
  identity: AgentToolIdentity,
  send: (task: TaskToolset) => AsyncIterable<MessageStreamEvent>,
  signal: AbortSignal
) => {
  const started = performance.now()
  const marker = 'FREESK42'
  let requests = 0
  let called = false
  let unavailable = false
  let verified = false
  let result = ''
  try {
    for await (const event of send({
      definitions: [
        {
          name: 'freeseek_tool_probe',
          description: 'Return a connection test value.',
          parameters: {
            type: 'object',
            properties: { value: { type: 'integer' } },
            required: ['value'],
          },
        },
      ],
      async beforeRound() {
        if (requests >= 2) {
          return 'budget-requests'
        }
        requests++
        return undefined
      },
      async execute(_name, input) {
        if (!input || typeof input !== 'object' || !('value' in input) || input.value !== 42) {
          return { isError: true, text: 'The probe requires the number 42.' }
        }
        called = true
        return { text: marker }
      },
      unavailable: () => {
        unavailable = true
      },
      limited: () => {
        unavailable = true
      },
    })) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        result = (result + event.delta.text).slice(-200)
      }
    }
    if (!called || !result.includes(marker) || unavailable) {
      throw new ApiError('protocol', { key: 'providerToolUnsupported' })
    }
    verified = true
    return { elapsedMs: Math.round(performance.now() - started), requests }
  } finally {
    if (!signal.aborted) {
      const key = keyFor(identity)
      try {
        const checks = readChecks().filter(([candidate]) => candidate !== key)
        localStorage.setItem(
          storageKey,
          JSON.stringify([...checks.slice(-63), [key, { at: Date.now(), verified }]])
        )
      } catch {
        logEvent(
          'storage',
          'provider.tool-probe.save-failed',
          { protocol: identity.protocol },
          'warn'
        )
      }
      logEvent(
        'api',
        verified ? 'provider.tool-probe.passed' : 'provider.tool-probe.failed',
        {
          protocol: identity.protocol,
          requests,
          elapsedMs: Math.round(performance.now() - started),
        },
        verified ? 'info' : 'warn'
      )
    }
  }
}
