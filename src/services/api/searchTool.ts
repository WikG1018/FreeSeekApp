import { ApiError } from './errorTypes.js'
import { diagnosticError, logEvent } from '../diagnostics/log.js'
import type { ProviderProfile } from '../providers.js'
import type { MessageStreamEvent } from './types.js'

type Json = Record<string, unknown>
const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
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
export const anthropicSearchTool = { name, description, input_schema: parameters }

export type SearchInput = { query: string; count: number }
export type SearchOutput = { text: string; isError?: boolean }
export type SearchTool = {
  execute: (input: SearchInput, timeoutMs: number) => Promise<SearchOutput>
  unavailable: () => void
}

type ToolCall = { id: string; name: string; input: unknown }
type ToolTurn<T> = { calls: ToolCall[]; continuation: (outputs: SearchOutput[]) => T }

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

const uniqueCallIds = (calls: ToolCall[]) =>
  calls.every((call) => call.id && call.name) &&
  new Set(calls.map((call) => call.id)).size === calls.length

/** The companion request needs complete native blocks, especially signed thinking and tool IDs. */
const collectAnthropicSearchTurn = () => {
  const blocks = new Map<number, Json>()
  const argumentsByIndex = new Map<number, string>()
  const invalidArguments = new Set<number>()
  return {
    read(raw: unknown) {
      const data = object(raw)
      if (data.type === 'message') {
        list(data.content).forEach((part, index) => blocks.set(index, object(part)))
      }
      const index = data.index
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
        return
      }
      if (data.type === 'content_block_start') {
        blocks.set(index, { ...object(data.content_block) })
      }
      const block = blocks.get(index)
      if (data.type !== 'content_block_delta' || !block) {
        return
      }
      const delta = object(data.delta)
      if (block.type === 'tool_use' && delta.type === 'input_json_delta') {
        const args = (argumentsByIndex.get(index) ?? '') + str(delta.partial_json)
        if (args.length > 4096) {
          invalidArguments.add(index)
        } else {
          argumentsByIndex.set(index, args)
        }
      } else if (block.type === 'thinking' && delta.type === 'thinking_delta') {
        block.thinking = str(block.thinking) + str(delta.thinking)
      } else if (block.type === 'thinking' && delta.type === 'signature_delta') {
        block.signature = str(block.signature) + str(delta.signature)
      } else if (block.type === 'text' && delta.type === 'text_delta') {
        block.text = str(block.text) + str(delta.text)
      }
    },
    finish(): ToolTurn<Json[]> | undefined {
      const content = [...blocks]
        .sort(([first], [second]) => first - second)
        .map(([index, block]) =>
          block.type === 'tool_use' && argumentsByIndex.has(index)
            ? { ...block, input: parseArguments(argumentsByIndex.get(index)) ?? {} }
            : block
        )
      const calls = content
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({ id: str(block.id), name: str(block.name), input: block.input }))
      if (invalidArguments.size || !calls.length || !uniqueCallIds(calls)) {
        return undefined
      }
      return {
        calls,
        continuation: (outputs) => [
          { role: 'assistant', content },
          {
            role: 'user',
            content: outputs.map(({ text, isError }, i) => ({
              type: 'tool_result',
              tool_use_id: calls[i].id,
              content: text,
              ...(isError && { is_error: true }),
            })),
          },
        ],
      }
    },
  }
}

const announceProviderSearch = (body: Json, protocol: ProviderProfile['protocol']): Json => {
  const declaration = { name, description, parameters }
  if (protocol === 'gemini') {
    return {
      ...body,
      tools: [{ functionDeclarations: [{ name, description, parametersJsonSchema: parameters }] }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    }
  }
  if (protocol === 'anthropic') {
    return { ...body, tools: [anthropicSearchTool], tool_choice: { type: 'auto' } }
  }
  if (protocol === 'responses') {
    return {
      ...body,
      tools: [{ type: 'function', ...declaration, strict: false }],
      tool_choice: 'auto',
      // Responses runs statelessly. Replay opaque reasoning state when the provider returns it.
      include: [...new Set([...list(body.include), 'reasoning.encrypted_content'])],
    }
  }
  return { ...body, tools: [{ type: 'function', function: declaration }], tool_choice: 'auto' }
}

type ProviderToolTurn = ToolTurn<Json>
const collectChatCompletions = (body: Json) => {
  const calls = new Map<number, { id: string; name: string; arguments: string }>()
  const reasoningDetails: unknown[] = []
  let content = ''
  let reasoning = ''
  let reasoningContent = ''
  let invalid = false
  return {
    read(data: Json) {
      const choice = object(list(data.choices)[0])
      const delta = object(choice.delta ?? choice.message)
      content += Array.isArray(delta.content)
        ? delta.content.map((part) => str(object(part).text)).join('')
        : str(delta.content)
      reasoning += str(delta.reasoning)
      reasoningContent += str(delta.reasoning_content)
      reasoningDetails.push(...list(delta.reasoning_details))
      list(delta.tool_calls).forEach((entry, i) => {
        const part = object(entry)
        const index = typeof part.index === 'number' ? part.index : i
        const item = calls.get(index) ?? { id: '', name: '', arguments: '' }
        const fn = object(part.function)
        item.id ||= str(part.id)
        item.name ||= str(fn.name)
        item.arguments += str(fn.arguments)
        invalid ||=
          item.arguments.length > 4096 || (part.type !== undefined && part.type !== 'function')
        if (!invalid) {
          calls.set(index, item)
        }
      })
    },
    finish(): ProviderToolTurn | undefined {
      const items = [...calls].sort(([first], [second]) => first - second).map(([, call]) => call)
      const toolCalls = items.map((item) => ({
        id: item.id,
        name: item.name,
        input: item.arguments,
      }))
      if (invalid || !toolCalls.length || !uniqueCallIds(toolCalls)) {
        return undefined
      }
      return {
        calls: toolCalls,
        continuation: (outputs) => ({
          ...body,
          messages: [
            ...list(body.messages),
            {
              role: 'assistant',
              content: content || null,
              ...(reasoning && { reasoning }),
              ...(reasoningContent && { reasoning_content: reasoningContent }),
              ...(reasoningDetails.length && { reasoning_details: reasoningDetails }),
              tool_calls: items.map(({ id, name, arguments: args }) => ({
                id,
                type: 'function',
                function: { name, arguments: args },
              })),
            },
            ...outputs.map(({ text }, i) => ({
              role: 'tool',
              tool_call_id: items[i].id,
              content: text,
            })),
          ],
        }),
      }
    },
  }
}

const collectResponses = (body: Json) => {
  let output: unknown[] = []
  return {
    read(data: Json) {
      if (data.type === 'response.completed' || (!data.type && data.status === 'completed')) {
        output = list(object(data.response ?? data).output)
      }
    },
    finish(): ProviderToolTurn | undefined {
      const calls = output
        .map(object)
        .filter((item) => item.type === 'function_call')
        .map((item) => ({
          id: str(item.call_id),
          name: str(item.name),
          input: item.arguments,
        }))
      if (!calls.length || !uniqueCallIds(calls)) {
        return undefined
      }
      return {
        calls,
        continuation: (outputs) => ({
          ...body,
          input: [
            ...list(body.input),
            ...output,
            ...outputs.map(({ text }, i) => ({
              type: 'function_call_output',
              call_id: calls[i].id,
              output: text,
            })),
          ],
        }),
      }
    },
  }
}

const collectGemini = (body: Json) => {
  const parts: unknown[] = []
  let completed = false
  return {
    read(data: Json) {
      const candidate = object(list(data.candidates)[0])
      parts.push(...list(object(candidate.content).parts))
      if (candidate.finishReason) {
        completed = candidate.finishReason === 'STOP'
      }
    },
    finish(): ProviderToolTurn | undefined {
      const calls = parts
        .map(object)
        .filter((part) => part.functionCall)
        .map(({ functionCall }) => {
          const call = object(functionCall)
          return { id: str(call.id), name: str(call.name), input: call.args }
        })
      if (!completed || !calls.length || calls.some((call) => !call.name)) {
        return undefined
      }
      return {
        calls,
        continuation: (outputs) => ({
          ...body,
          contents: [
            ...list(body.contents),
            { role: 'model', parts },
            {
              role: 'user',
              parts: outputs.map(({ text, isError }, i) => ({
                functionResponse: {
                  name: calls[i].name,
                  ...(calls[i].id && { id: calls[i].id }),
                  response: isError ? { error: text } : { output: text },
                },
              })),
            },
          ],
        }),
      }
    },
  }
}

const collectProviderSearchTurn = (body: Json, protocol: ProviderProfile['protocol']) => {
  if (protocol === 'openai') {
    return collectChatCompletions(body)
  }
  if (protocol === 'responses') {
    return collectResponses(body)
  }
  if (protocol === 'gemini') {
    return collectGemini(body)
  }
  const turn = collectAnthropicSearchTurn()
  return {
    read: turn.read,
    finish(): ProviderToolTurn | undefined {
      const result = turn.finish()
      return (
        result && {
          calls: result.calls,
          continuation: (outputs) => ({
            ...body,
            messages: [...list(body.messages), ...result.continuation(outputs)],
          }),
        }
      )
    },
  }
}

export type SearchTurnCollector = ReturnType<typeof collectProviderSearchTurn>

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
  let request = announceProviderSearch(body, protocol)
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
