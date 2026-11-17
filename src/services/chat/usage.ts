import type { MessageUsage } from '../api/types.js'
import type { AssistantMessage } from './types.js'

export const usageEntries = (message: AssistantMessage) =>
  message.usageHistory?.length
    ? message.usageHistory
    : message.usage
      ? [{ createdAt: message.createdAt, usage: message.usage }]
      : []

export const sumMessageUsage = (
  base: MessageUsage | undefined,
  current: MessageUsage
): MessageUsage => ({
  input_tokens: (base?.input_tokens ?? 0) + current.input_tokens,
  cache_creation_input_tokens:
    (base?.cache_creation_input_tokens ?? 0) + current.cache_creation_input_tokens,
  cache_read_input_tokens: (base?.cache_read_input_tokens ?? 0) + current.cache_read_input_tokens,
  output_tokens: (base?.output_tokens ?? 0) + current.output_tokens,
  ...(base?.server_tool_use || current.server_tool_use
    ? {
        server_tool_use: {
          web_search_requests:
            (base?.server_tool_use?.web_search_requests ?? 0) +
            (current.server_tool_use?.web_search_requests ?? 0),
          ...(['tool_search', 'tool_fetch', 'tool_image_search'] as const).reduce((result, key) => {
            const left =
              base?.server_tool_use?.[key] ??
              (key === 'tool_search' ? base?.server_tool_use?.web_search_requests : undefined)
            const right =
              current.server_tool_use?.[key] ??
              (key === 'tool_search' ? current.server_tool_use?.web_search_requests : undefined)
            return left !== undefined || right !== undefined
              ? { ...result, [key]: (left ?? 0) + (right ?? 0) }
              : result
          }, {}),
        },
      }
    : {}),
})
