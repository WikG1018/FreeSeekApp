/**
 * 上游转发：真实 DeepSeek API 或本地 mock。
 * 服务端密钥只在这里使用，绝不下发客户端；请求体不落盘、不记录。
 */
import { Readable } from 'node:stream'

const MOCK_REPLY =
  '（本地 mock 上游）收到你的消息。这条回复用于联调账号与计费链路，不产生真实费用。'

/** 生成一段符合 Anthropic 流式协议的 mock SSE */
const mockStream = (usage) => {
  const events = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: 'deepseek-flash',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: usage.input,
          cache_creation_input_tokens: usage.cacheWrite,
          cache_read_input_tokens: usage.cacheRead,
          output_tokens: 1,
        },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: MOCK_REPLY } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: usage.output },
    }],
    ['message_stop', { type: 'message_stop' }],
  ]
  const body = events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('')
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      controller.enqueue(encoder.encode(body))
      controller.close()
    },
  })
}

export const createUpstream = (config) => {
  /** 统一的上游请求：返回原生 Response（可能流式） */
  const request = async (path, init = {}) => {
    if (config.mockUpstream) {
      if (path.endsWith('/messages')) {
        return new Response(mockStream({ input: 120_000, cacheRead: 40_000, cacheWrite: 0, output: 2_400 }), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        })
      }
      if (path.endsWith('/files')) {
        return new Response(JSON.stringify({ id: 'file_mock', type: 'file', size: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (path.startsWith('/v1/tools/')) {
        if (path.endsWith('/asr')) {
          return new Response(JSON.stringify({ text: '这是 mock 转写结果' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response(new Uint8Array(4800), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      }
      return new Response(JSON.stringify({ error: { message: 'mock upstream: unknown path' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const headers = { ...(init.headers ?? {}) }
    // 客户端令牌由服务端替换为上游密钥
    delete headers['x-api-key']
    delete headers.authorization
    headers['x-api-key'] = config.upstreamKey

    const body =
      init.body && !(init.body instanceof Uint8Array) && typeof init.body.pipe === 'function'
        ? Readable.toWeb(init.body)
        : init.body

    return fetch(`${config.upstreamOrigin}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body,
      duplex: body ? 'half' : undefined,
      signal: init.signal,
    })
  }

  return { request }
}
