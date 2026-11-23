import type { ProviderProfile } from '../providers.js'
import type { SearchOutput, ToolDefinition } from './searchTool.js'

type Json = Record<string, unknown>
const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const str = (value: unknown) => (typeof value === 'string' ? value : '')

type ToolCall = { id: string; name: string; input: unknown }
type ToolTurn<T> = { calls: ToolCall[]; continuation: (outputs: SearchOutput[]) => T }

const parseArguments = (value: unknown): unknown => {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    return undefined
  }
}

const uniqueCallIds = (calls: ToolCall[]) =>
  calls.every((call) => call.id && call.name) &&
  new Set(calls.map((call) => call.id)).size === calls.length

/** The companion request needs complete native blocks, especially signed thinking and tool IDs. */
const collectAnthropicSearchTurn = (argumentLimit: number) => {
  const blocks = new Map<number, Json>()
  const argumentsByIndex = new Map<number, string>()
  const invalidArguments = new Set<number>()
  const content = () =>
    [...blocks]
      .sort(([first], [second]) => first - second)
      .map(([index, block]) =>
        block.type === 'tool_use' && argumentsByIndex.has(index)
          ? { ...block, input: parseArguments(argumentsByIndex.get(index)) ?? {} }
          : block
      )
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
        if (args.length > argumentLimit) {
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
    content,
    invalid: () => invalidArguments.size > 0,
    finish(): ToolTurn<Json[]> | undefined {
      const assembled = content()
      const calls = assembled
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({ id: str(block.id), name: str(block.name), input: block.input }))
      if (invalidArguments.size || !calls.length || !uniqueCallIds(calls)) {
        return undefined
      }
      return {
        calls,
        continuation: (outputs) => [
          { role: 'assistant', content: assembled },
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

export const announceClientTools = (
  body: Json,
  protocol: ProviderProfile['protocol'],
  tools: ToolDefinition[]
): Json => {
  if (protocol === 'gemini') {
    return {
      ...body,
      tools: [
        {
          functionDeclarations: tools.map(({ name, description, parameters }) => ({
            name,
            description,
            parametersJsonSchema: parameters,
          })),
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    }
  }
  if (protocol === 'anthropic') {
    return {
      ...body,
      tools: tools.map(({ name, description, parameters }) => ({
        name,
        description,
        input_schema: parameters,
      })),
      tool_choice: { type: 'auto' },
    }
  }
  if (protocol === 'responses') {
    return {
      ...body,
      tools: tools.map((tool) => ({ type: 'function', ...tool, strict: false })),
      tool_choice: 'auto',
      // Responses runs statelessly. Replay opaque reasoning state when the provider returns it.
      include: [...new Set([...list(body.include), 'reasoning.encrypted_content'])],
    }
  }
  return {
    ...body,
    tools: tools.map((tool) => ({ type: 'function', function: tool })),
    tool_choice: 'auto',
  }
}

export type ProviderToolTurn = ToolTurn<Json>
const collectChatCompletions = (body: Json, argumentLimit: number) => {
  const calls = new Map<number, { id: string; name: string; arguments: string }>()
  const reasoningDetails: unknown[] = []
  let content = ''
  let reasoning = ''
  let reasoningContent = ''
  let invalid = false
  const orderedCalls = () =>
    [...calls].sort(([first], [second]) => first - second).map(([, call]) => call)
  const message = () => {
    const items = orderedCalls()
    return {
      role: 'assistant',
      content: content || null,
      ...(reasoning && { reasoning }),
      ...(reasoningContent && { reasoning_content: reasoningContent }),
      ...(reasoningDetails.length && { reasoning_details: reasoningDetails }),
      ...(items.length && {
        tool_calls: items.map(({ id, name, arguments: args }) => ({
          id,
          type: 'function',
          function: { name, arguments: args },
        })),
      }),
    }
  }
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
        const fragment = str(fn.name)
        if (fragment && item.name !== fragment) {
          item.name = fragment.startsWith(item.name) ? fragment : item.name + fragment
        }
        if (typeof fn.arguments === 'string') {
          item.arguments += fn.arguments
        } else if (fn.arguments && typeof fn.arguments === 'object') {
          item.arguments = JSON.stringify(fn.arguments)
        }
        invalid ||=
          item.arguments.length > argumentLimit ||
          (part.type !== undefined && part.type !== 'function')
        if (!invalid) {
          calls.set(index, item)
        }
      })
    },
    message,
    invalid: () => invalid,
    finish(): ProviderToolTurn | undefined {
      const items = orderedCalls()
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
            message(),
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
    parts: () => parts,
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

export const collectProviderSearchTurn = (
  body: Json,
  protocol: ProviderProfile['protocol'],
  argumentLimit = 4096
) => {
  if (protocol === 'openai') {
    return collectChatCompletions(body, argumentLimit)
  }
  if (protocol === 'responses') {
    return collectResponses(body)
  }
  if (protocol === 'gemini') {
    return collectGemini(body)
  }
  const turn = collectAnthropicSearchTurn(argumentLimit)
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

export const continueGoalConversation = (
  body: Json,
  protocol: ProviderProfile['protocol'],
  answer: string,
  prompt: string,
  output?: unknown[]
): Json => {
  if (protocol === 'gemini') {
    return {
      ...body,
      contents: [
        ...list(body.contents),
        ...(answer ? [{ role: 'model', parts: [{ text: answer }] }] : []),
        { role: 'user', parts: [{ text: prompt }] },
      ],
    }
  }
  if (protocol === 'responses') {
    return {
      ...body,
      input: [
        ...list(body.input),
        ...(output?.length ? output : answer ? [{ role: 'assistant', content: answer }] : []),
        { role: 'user', content: prompt },
      ],
    }
  }
  return {
    ...body,
    messages: [
      ...list(body.messages),
      ...(answer ? [{ role: 'assistant', content: answer }] : []),
      { role: 'user', content: prompt },
    ],
  }
}

export type ModelActivity = 'thinking' | 'tool-input' | 'writing'

/** Reuse the wire collectors so background requests keep the same signed reasoning and tool inputs. */
export const collectNativeModelStream = (protocol: ProviderProfile['protocol']) => {
  const anthropic = protocol === 'anthropic' ? collectAnthropicSearchTurn(160_000) : undefined
  const openai = protocol === 'openai' ? collectChatCompletions({}, 160_000) : undefined
  const gemini = protocol === 'gemini' ? collectGemini({}) : undefined
  let finish = ''
  let stopped = false
  let error = false
  let responseText = ''
  let terminalResponse: Json | undefined
  let usage: Json = {}

  return {
    read(raw: string): ModelActivity | 'complete' | '' {
      if (raw === '[DONE]') {
        stopped = true
        return 'complete'
      }
      const data = object(JSON.parse(raw))
      if (data.error || data.type === 'error' || data.type === 'response.failed') {
        error = true
        return 'complete'
      }
      anthropic?.read(data)
      openai?.read(data)
      gemini?.read(data)
      const choice = object(list(data.choices)[0])
      const candidate = object(list(data.candidates)[0])
      const delta = object(choice.delta ?? data.delta)
      const parts = list(object(candidate.content).parts).map(object)
      const type = str(data.type)
      const reason = str(delta.stop_reason || choice.finish_reason || candidate.finishReason)
      finish = reason || finish
      stopped ||= type === 'message_stop' || !!reason
      if (type === 'response.completed' || type === 'response.incomplete') {
        terminalResponse = object(data.response)
        stopped = true
      }
      if (type === 'response.output_text.delta') {
        responseText += str(data.delta)
      }
      usage = {
        ...usage,
        ...object(object(data.message).usage),
        ...object(data.usage ?? data.usageMetadata),
      }
      if (
        type === 'message_stop' ||
        type === 'response.completed' ||
        type === 'response.incomplete'
      ) {
        return 'complete'
      }
      if (
        str(delta.partial_json) ||
        list(delta.tool_calls).length ||
        parts.some((part) => part.functionCall) ||
        type === 'response.function_call_arguments.delta' ||
        object(data.content_block).type === 'tool_use'
      ) {
        return 'tool-input'
      }
      if (
        str(delta.thinking || delta.reasoning || delta.reasoning_content) ||
        parts.some((part) => part.thought && part.text) ||
        type === 'response.reasoning_summary_text.delta' ||
        type === 'response.reasoning_text.delta'
      ) {
        return 'thinking'
      }
      if (
        str(delta.text || delta.content || object(data.content_block).text) ||
        list(delta.content).length ||
        parts.some((part) => part.text) ||
        type === 'response.output_text.delta'
      ) {
        return 'writing'
      }
      return ''
    },
    result(interrupted?: string): Json {
      if (error || openai?.invalid() || anthropic?.invalid()) {
        return { error: 'provider-stream', confirmed: true }
      }
      const content = anthropic
        ? { type: 'message', content: anthropic.content(), stop_reason: finish, usage }
        : openai
          ? { choices: [{ message: openai.message(), finish_reason: finish }], usage }
          : gemini
            ? {
                candidates: [{ content: { parts: gemini.parts() }, finishReason: finish }],
                usageMetadata: usage,
              }
            : (terminalResponse ??
              (responseText
                ? {
                    output: [
                      { type: 'message', content: [{ type: 'output_text', text: responseText }] },
                    ],
                  }
                : undefined))
      if (!stopped) {
        return {
          ...(content && { content: JSON.stringify(content) }),
          error: interrupted || 'provider-network',
          confirmed: false,
        }
      }
      return content
        ? { content: JSON.stringify(content), confirmed: true }
        : { error: 'provider-empty', confirmed: true }
    },
  }
}

export const compactTaskResults = (body: Json, protocol: ProviderProfile['protocol']): Json => {
  const clip = (value: unknown) =>
    typeof value === 'string' && value.length > 2_000
      ? value.slice(0, 1_000) +
        '\n[Earlier tool excerpt shortened. Its read reference is saved locally.]\n' +
        value.slice(-700)
      : value
  const field = protocol === 'responses' ? 'input' : protocol === 'gemini' ? 'contents' : 'messages'
  const entries = list(body[field])
  let retained = 0
  const compacted = [...entries]
    .reverse()
    .map((entry) => {
      const item = object(entry)
      if (item.role === 'tool' || item.type === 'function_call_output') {
        const key = item.role === 'tool' ? 'content' : 'output'
        return retained++ < 6 ? entry : { ...item, [key]: clip(item[key]) }
      }
      if (item.role !== 'user') {
        return entry
      }
      const key = protocol === 'gemini' ? 'parts' : 'content'
      const blocks = list(item[key])
      if (
        !blocks.some(
          (block) => object(block).type === 'tool_result' || object(block).functionResponse
        )
      ) {
        return entry
      }
      return {
        ...item,
        [key]: [...blocks]
          .reverse()
          .map((block) => {
            const part = object(block)
            if (part.type === 'tool_result') {
              return retained++ < 6 ? block : { ...part, content: clip(part.content) }
            }
            if (part.functionResponse) {
              const response = object(part.functionResponse)
              const result = object(response.response)
              return retained++ < 6
                ? block
                : {
                    ...part,
                    functionResponse: {
                      ...response,
                      response: { ...result, text: clip(result.text) },
                    },
                  }
            }
            return block
          })
          .reverse(),
      }
    })
    .reverse()
  return { ...body, [field]: compacted }
}
