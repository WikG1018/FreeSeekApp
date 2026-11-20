import { ApiError } from './errorTypes.js'
import type { ProviderProfile } from '../providers.js'

type Json = Record<string, unknown>
const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const str = (value: unknown) => (typeof value === 'string' ? value : '')

const name = 'freeseek_web_search'
const description =
  'Search public web pages when current information or a source is needed. Answer directly when a search would not help. Send only public keywords, never private details. Choose the number of results needed. One search is available for this reply.'
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
  execute: (input: SearchInput) => Promise<SearchOutput>
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

export const finishSearchTurn = async <T>(
  turn: ToolTurn<T> | undefined,
  tool: SearchTool,
  signal: AbortSignal
): Promise<T> => {
  if (!turn?.calls.length) {
    throw new ApiError('protocol', { key: 'providerToolUnsupported' })
  }
  const outputs: SearchOutput[] = []
  let searched = false
  for (const call of turn.calls) {
    signal.throwIfAborted()
    const args = call.name === name ? searchInput(call.input) : undefined
    if (args && !searched) {
      searched = true
      outputs.push(await tool.execute(args))
    } else {
      outputs.push({
        isError: true,
        text: args
          ? 'This reply has already used its web search. Answer using the available results.'
          : 'This tool call could not run. Answer using the information already available.',
      })
    }
  }
  signal.throwIfAborted()
  return turn.continuation(outputs)
}

const uniqueCallIds = (calls: ToolCall[]) =>
  calls.every((call) => call.id && call.name) &&
  new Set(calls.map((call) => call.id)).size === calls.length

/** The companion request needs complete native blocks, especially signed thinking and tool IDs. */
export const collectAnthropicSearchTurn = () => {
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

export const announceProviderSearch = (body: Json, protocol: ProviderProfile['protocol']): Json => {
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
          tool_choice: 'none',
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
          tool_choice: 'none',
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
          toolConfig: { functionCallingConfig: { mode: 'NONE' } },
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

export const collectProviderSearchTurn = (body: Json, protocol: ProviderProfile['protocol']) => {
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
            tool_choice: { type: 'none' },
            messages: [...list(body.messages), ...result.continuation(outputs)],
          }),
        }
      )
    },
  }
}
