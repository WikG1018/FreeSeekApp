import { providerFetch } from '../api/providerTransport.js'
import { readServerSentEvents } from '../api/sse.js'
import { validMcpEndpoint, type McpConnection, type McpTool } from './extensions.js'

type Json = Record<string, unknown>
const record = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
const schemaVersion = '2025-11-25'
const maxBytes = 384 * 1024
const readJson = async (response: Response) => {
  if (!response.body) {
    return {}
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let length = 0
  let text = ''
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) {
        return record(JSON.parse(text + decoder.decode()))
      }
      length += part.value.length
      if (length > maxBytes) {
        throw new Error('MCP response too large')
      }
      text += decoder.decode(part.value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export const createMcpClient = (connection: Pick<McpConnection, 'endpoint' | 'key'>) => {
  const endpoint = validMcpEndpoint(connection.endpoint)
  if (!endpoint) {
    throw new Error('MCP requires an HTTPS address')
  }
  let protocol = schemaVersion
  let sessionId: string | undefined
  let sequence = 0
  let initialized = false
  const send = async (
    method: string,
    params: Json,
    signal: AbortSignal,
    notification = false
  ): Promise<Json> => {
    signal.throwIfAborted()
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    const timeout = setTimeout(() => controller.abort(), 20_000)
    signal.addEventListener('abort', abort, { once: true })
    const id = ++sequence
    try {
      const reply = await providerFetch(
        endpoint,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': protocol,
            ...(sessionId && { 'Mcp-Session-Id': sessionId }),
            ...(connection.key.trim() && { Authorization: 'Bearer ' + connection.key.trim() }),
          },
          signal: controller.signal,
          body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(!notification && { id }) }),
        },
        undefined,
        false
      )
      if (!reply.ok) {
        await reply.body?.cancel().catch(() => {})
        if (reply.status === 404 && sessionId) {
          sessionId = undefined
          initialized = false
        }
        throw new Error('MCP HTTP ' + reply.status)
      }
      if (method === 'initialize') {
        const received = reply.headers.get('Mcp-Session-Id')
        if (received && /^[!-~]{1,256}$/.test(received)) {
          sessionId = received
        }
      }
      if (notification) {
        await reply.body?.cancel().catch(() => {})
        return {}
      }
      let message: Json | undefined
      if (reply.body && (reply.headers.get('Content-Type') ?? '').includes('text/event-stream')) {
        let received = 0
        for await (const { data } of readServerSentEvents(reply.body, controller.signal, 20_000)) {
          received += data.length
          if (received > maxBytes) {
            throw new Error('MCP event stream too large')
          }
          if (!data.trim()) {
            continue
          }
          const candidate = record(JSON.parse(data))
          if (candidate.id === id) {
            message = candidate
            break
          }
        }
      } else {
        message = await readJson(reply)
      }
      if (!message || message.id !== id || message.error || !message.result) {
        throw new Error('Invalid MCP tool response')
      }
      controller.signal.throwIfAborted()
      return record(message.result)
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      if (method === 'tools/call' && controller.signal.aborted) {
        const cleanup = new AbortController()
        const end = setTimeout(() => cleanup.abort(), 3_000)
        void send('notifications/cancelled', { requestId: id }, cleanup.signal, true)
          .catch(() => {})
          .finally(() => clearTimeout(end))
      }
    }
  }
  const connect = async (signal: AbortSignal) => {
    if (initialized) {
      return
    }
    const hello = await send(
      'initialize',
      {
        protocolVersion: schemaVersion,
        capabilities: {},
        clientInfo: { name: 'FreeSeek', version: '2' },
      },
      signal
    )
    if (
      typeof hello.protocolVersion !== 'string' ||
      !['2025-03-26', '2025-06-18', schemaVersion, '2026-07-28'].includes(hello.protocolVersion)
    ) {
      throw new Error('MCP protocol version is not supported')
    }
    protocol = hello.protocolVersion
    await send('notifications/initialized', {}, signal, true)
    initialized = true
  }
  return {
    async list(signal: AbortSignal) {
      await connect(signal)
      const tools = new Map<string, McpTool>()
      let cursor: string | undefined
      for (let page = 0; page < 5; page++) {
        const batch = await send('tools/list', cursor ? { cursor } : {}, signal)
        if (!Array.isArray(batch.tools)) {
          throw new Error('MCP tool list is invalid')
        }
        for (const item of batch.tools) {
          const info = record(item)
          if (typeof info.name === 'string' && /^[a-zA-Z0-9_.-]{1,96}$/.test(info.name)) {
            const schema = record(info.inputSchema)
            tools.set(info.name, {
              name: info.name,
              description:
                typeof info.description === 'string' ? info.description.slice(0, 500) : '',
              ...(Object.keys(schema).length &&
                JSON.stringify(schema).length <= 3_500 && { schema }),
            })
          }
          if (tools.size >= 120) {
            return [...tools.values()]
          }
        }
        cursor = typeof batch.nextCursor === 'string' ? batch.nextCursor.slice(0, 2_000) : undefined
        if (!cursor) {
          break
        }
      }
      return [...tools.values()]
    },
    async call(name: string, args: Json, signal: AbortSignal) {
      await connect(signal)
      const result = await send('tools/call', { name, arguments: args }, signal)
      const output = Array.isArray(result.content)
        ? result.content
            .map(record)
            .filter((item) => item.type === 'text' && typeof item.text === 'string')
            .map((item) => item.text)
            .join('\n')
            .slice(0, 12_000)
        : ''
      return {
        text: output || JSON.stringify(result.structuredContent ?? {}).slice(0, 12_000),
        isError: result.isError === true,
      }
    },
  }
}
