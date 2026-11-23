import { ApiError } from './errorTypes.js'
import { diagnosticError, logEvent } from '../diagnostics/log.js'
import type { ProviderProfile } from '../providers.js'
import type { MessageStreamEvent } from './types.js'
import type { GoalWire } from '../tasks/goalBridge.js'
import type { AgentStopReason } from '../tasks/runState.js'

import {
  announceClientTools,
  compactTaskResults,
  collectProviderSearchTurn,
  continueGoalConversation,
  type ProviderToolTurn,
  type SearchTurnCollector,
} from './toolProtocols.js'
export type { SearchTurnCollector } from './toolProtocols.js'

type Json = Record<string, unknown>
const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}

const str = (value: unknown) => (typeof value === 'string' ? value : '')
const name = 'freeseek_web_search'
const MAX_SEARCH_REQUESTS = 3
const SEARCH_BUDGET_MS = 30_000
const description = `Search public web pages when current information or a source is needed. Answer directly when a search would not help. Send only public keywords, never private details. Choose the number of results needed. Up to ${MAX_SEARCH_REQUESTS} searches are available for this reply. Use different focused queries only when existing sources are insufficient. Cite relevant sources and explain any limits on verification.`
const MAX_QUERY_LENGTH = 128
const MAX_RESULTS = 50
const parameters = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH },
    count: { type: 'integer', minimum: 1, maximum: MAX_RESULTS },
  },
  required: ['query', 'count'],
  additionalProperties: false,
}
export type SearchInput = { query: string; count: number }
export type SearchOutput = { text: string; isError?: boolean; sourceUrls?: string[] }
export type SearchTool = {
  execute: (input: SearchInput, timeoutMs: number) => Promise<SearchOutput>
  unavailable: () => void
}

export type ToolDefinition = { name: string; description: string; parameters: Json }
export type TaskToolset = {
  definitions: ToolDefinition[]
  statefulNames?: string[]
  execute: (name: string, input: unknown, timeoutMs: number) => Promise<SearchOutput>
  unavailable: () => void
  limited: (reason: AgentStopReason) => void
  host?: (wire: GoalWire) => Promise<boolean>
  beforeRound?: (body: Json) => Promise<AgentStopReason | undefined>
  afterRound?: (confirmed: boolean) => void
  failedCall?: (reason: string) => void
  waiting?: () => boolean
  finish?: () => void
  continueGoal?: () => string | undefined
  rememberForegroundResult?: (id: string, value: SearchOutput) => void
  abandonPendingMcp?: () => void
}
export const webSearchDefinition: ToolDefinition = { name, description, parameters }
export const parseSearchInput = (input: unknown): SearchInput | undefined => searchInput(input)

const parseArguments = (value: unknown): unknown => {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    return undefined
  }
}

const searchInput = (value: unknown): SearchInput | undefined => {
  const args = object(parseArguments(value))
  const query = str(args.query).trim().replace(/\s+/g, ' ')
  const count = args.count
  if (
    !query ||
    Array.from(query).length > MAX_QUERY_LENGTH ||
    typeof count !== 'number' ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_RESULTS
  ) {
    return undefined
  }
  return { query, count }
}

const answerWithoutMoreSearch = (body: Json, protocol: ProviderProfile['protocol']): Json => {
  if (protocol === 'gemini') {
    return { ...body, toolConfig: { functionCallingConfig: { mode: 'NONE' } } }
  }
  return { ...body, tool_choice: protocol === 'anthropic' ? { type: 'none' } : 'none' }
}

const searchUnavailable =
  'No more web searches are available for this reply. Use the sources already collected and explain any limits on verification.'

export async function* streamWithProviderSearch(
  body: Json,
  protocol: ProviderProfile['protocol'],
  tool: SearchTool,
  signal: AbortSignal,
  stream: (
    body: Json,
    collector?: SearchTurnCollector
  ) => AsyncGenerator<MessageStreamEvent, ProviderToolTurn | undefined>
): AsyncGenerator<MessageStreamEvent> {
  let request = announceClientTools(body, protocol, [webSearchDefinition])
  const queries = new Set<string>()
  let remainingMs = SEARCH_BUDGET_MS
  let canSearch = true
  while (canSearch) {
    signal.throwIfAborted()
    let turn: ProviderToolTurn | undefined
    try {
      turn = yield* stream(request, collectProviderSearchTurn(request, protocol))
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.kind !== 'http' ||
        error.localMessage?.key !== 'providerSearchToolRejected'
      ) {
        throw error
      }
      signal.throwIfAborted()
      logEvent(
        'search',
        'tool.unavailable',
        { protocol, reason: 'endpoint-rejected', ...diagnosticError(error) },
        'warn'
      )
      tool.unavailable()
      // On a later round, keep the completed tool calls and their results in the request.
      yield* stream(queries.size ? answerWithoutMoreSearch(request, protocol) : body)
      return
    }
    if (!turn) {
      return
    }

    const previousCount = queries.size
    const outputs: SearchOutput[] = []
    for (const call of turn.calls) {
      signal.throwIfAborted()
      const args = call.name === name ? searchInput(call.input) : undefined
      if (!args) {
        outputs.push({
          isError: true,
          text: 'This tool call could not run. Use valid search arguments.',
        })
        continue
      }
      const key = args.query.normalize().toLowerCase()
      if (queries.has(key)) {
        outputs.push({
          isError: true,
          text: 'This query was already searched. Use its results or a different focused query.',
        })
        continue
      }
      if (!canSearch) {
        outputs.push({ isError: true, text: searchUnavailable })
        continue
      }
      queries.add(key)
      const startedAt = performance.now()
      const output = await tool.execute(args, remainingMs)
      remainingMs -= performance.now() - startedAt
      canSearch = !output.isError && queries.size < MAX_SEARCH_REQUESTS && remainingMs > 0
      outputs.push(
        canSearch || output.isError ? output : { text: output.text + '\n' + searchUnavailable }
      )
    }
    signal.throwIfAborted()
    // A batch of only invalid or repeated calls cannot consume another model round.
    canSearch &&= queries.size > previousCount
    request = turn.continuation(outputs)
  }
  yield* stream(answerWithoutMoreSearch(request, protocol))
}

const TASK_ARGUMENT_LIMIT = 160_000
const TASK_BATCH_LIMIT = 24
const TASK_FALLBACK_ROUNDS = 40
const TASK_TOOL_TIMEOUT_MS = 25_000
const TASK_MODEL_IDLE_MS = 300_000

/** Keep the useful parts of prior results in the request, with complete evidence in the run. */
export async function* streamWithTaskTools(
  body: Json,
  protocol: ProviderProfile['protocol'],
  tools: TaskToolset,
  signal: AbortSignal,
  stream: (
    body: Json,
    collector?: SearchTurnCollector,
    requestSignal?: AbortSignal
  ) => AsyncGenerator<MessageStreamEvent, ProviderToolTurn | undefined>
): AsyncGenerator<MessageStreamEvent> {
  let request = announceClientTools(body, protocol, tools.definitions)
  const allowed = new Set(tools.definitions.map((tool) => tool.name))
  const stateful = new Set(tools.statefulNames)
  const completed = new Map<string, SearchOutput>()
  let lastBatch = ''
  let repeats = 0
  for (let round = 0; tools.beforeRound || round < TASK_FALLBACK_ROUNDS; round++) {
    signal.throwIfAborted()
    if (round > 1) {
      request = compactTaskResults(request, protocol)
    }
    const blocked = await tools.beforeRound?.(request)
    if (blocked) {
      tools.limited(blocked)
      return
    }
    signal.throwIfAborted()
    let turn: ProviderToolTurn | undefined
    let outputLimited = false
    let text = ''
    const requestController = new AbortController()
    const abort = () => requestController.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const armIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => requestController.abort(), TASK_MODEL_IDLE_MS)
    }
    armIdle()
    try {
      const iterator = stream(
        request,
        collectProviderSearchTurn(request, protocol, TASK_ARGUMENT_LIMIT),
        requestController.signal
      )
      try {
        for (;;) {
          const result = await iterator.next()
          if (result.done) {
            turn = result.value
            break
          }
          const event = result.value
          if (
            event.type === 'message_start' ||
            event.type === 'content_block_start' ||
            event.type === 'content_block_delta' ||
            event.type === 'agent_tool_input'
          ) {
            armIdle()
          }
          if (event.type === 'content_block_start' && event.content_block.type === 'text') {
            text += event.content_block.text
          } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            text += event.delta.text
          }
          if (event.type === 'message_delta' && event.delta.stop_reason === 'max_tokens') {
            outputLimited = true
          }
          yield event
        }
      } finally {
        await iterator.return(undefined)
      }
      tools.afterRound?.(true)
    } catch (error) {
      const confirmed =
        error instanceof ApiError &&
        (error.kind === 'http' || error.kind === 'protocol' || error.kind === 'stream')
      tools.afterRound?.(confirmed)
      if (signal.aborted) {
        signal.throwIfAborted()
      }
      if (requestController.signal.aborted) {
        tools.limited('provider-timeout')
        return
      }
      if (
        error instanceof ApiError &&
        (error.localMessage?.key === 'providerSearchToolRejected' ||
          error.localMessage?.key === 'providerToolUnsupported')
      ) {
        tools.unavailable()
        return
      }
      throw error
    } finally {
      clearTimeout(idleTimer)
      signal.removeEventListener('abort', abort)
    }
    if (outputLimited) {
      tools.limited('output-limit')
      return
    }
    if (!turn) {
      const followup = tools.continueGoal?.()
      if (followup) {
        request = continueGoalConversation(request, protocol, text, followup)
        continue
      }
      tools.finish?.()
      return
    }
    if (turn.calls.length > TASK_BATCH_LIMIT) {
      tools.failedCall?.('tool-batch-too-large')
      tools.limited('no-progress')
      return
    }
    const keys = turn.calls.map(({ name, input }) => name + ':' + JSON.stringify(input)).join('\n')
    const repeatsStateful = turn.calls.some(({ name }) => stateful.has(name))
    repeats = keys === lastBatch && !repeatsStateful ? repeats + 1 : 1
    lastBatch = keys
    if (repeats >= 4) {
      tools.limited('no-progress')
      return
    }

    const outputs: SearchOutput[] = []
    for (const call of turn.calls) {
      signal.throwIfAborted()
      const raw = typeof call.input === 'string' ? call.input : JSON.stringify(call.input)
      const parsed = raw && raw.length <= TASK_ARGUMENT_LIMIT ? parseArguments(raw) : undefined
      if (
        !allowed.has(call.name) ||
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        tools.failedCall?.(allowed.has(call.name) ? 'invalid-arguments' : 'unknown-tool')
        outputs.push({
          isError: true,
          text: 'This tool or its arguments are unavailable. Use an enabled tool with valid arguments.',
        })
        continue
      }
      const key = call.name + ':' + raw
      const cached = stateful.has(call.name) ? undefined : completed.get(key)
      if (cached) {
        outputs.push(cached)
        continue
      }
      const output = await tools.execute(call.name, parsed, TASK_TOOL_TIMEOUT_MS)
      signal.throwIfAborted()
      if (!stateful.has(call.name) && !output.isError && completed.size < 120) {
        completed.set(key, output)
      }
      outputs.push(output)
      if (tools.waiting?.()) {
        return
      }
    }
    request = turn.continuation(outputs)
  }
  tools.limited('budget-requests')
}
