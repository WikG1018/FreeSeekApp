import type { TranslationMessage } from '../../i18n/index.js'

/**
 * 能识别出原因的 400：直接给本地文案，避免把整段英文报错展示给用户。
 * 只依赖文案 key，不依赖 ApiError，供 client 与 errors 共用。
 */
export const isContextRejection = (key?: string) =>
  key === 'replyContextTooLong' ||
  key === 'replyDocumentCountLimit' ||
  key === 'replyDocumentTextLimit'

export const describeKnownApiError = (
  message: string,
  code = ''
): TranslationMessage | undefined => {
  if (
    /\bcontent exists risk\b/i.test(message) ||
    /^(?:content_policy_violation|content_filter|safety_violation)$/i.test(code)
  ) {
    return { key: 'replyRefused' }
  }
  if (
    /\blatest_reminder\b/i.test(message) &&
    /\bdeepseek-v4-pro\b/i.test(message) &&
    /unavailable|not supported|does not support/i.test(message)
  ) {
    return { key: 'replyProReminderUnavailable' }
  }
  if (
    /\bdeepseek-v4-pro\b/i.test(message) &&
    /server[-\s]side tool calls|title generation|deepseek_(?:web_search|read_url)/i.test(message) &&
    /unavailable|not supported|does not support/i.test(message)
  ) {
    return { key: 'replyProExtensionsUnavailable' }
  }
  if (
    /^(?:tool_use_not_supported|tools_not_supported|function_calling_not_supported)$/i.test(code) ||
    /\b(?:tools|tool_choice|tool_config|toolConfig|function calling|tool calling)\b.{0,50}\b(?:not supported|unsupported|unavailable)\b|\b(?:does not support|doesn't support|unsupported|(?:unknown|unrecognized) (?:field|name|parameter))\b.{0,25}\b(?:tools|tool_choice|tool_config|toolConfig|function calling|tool calling)\b/i.test(
      message
    ) ||
    /^tools: other tools cannot be used together with .{0,80}safety_check/i.test(message)
  ) {
    return { key: 'providerSearchToolRejected' }
  }
  if (
    /\brich_layout_recognition\b/i.test(message) &&
    /\bcontains\s+images\b[\s\S]{0,48}\bnot\s+supported\s+by\s+(?:this|the(?: current)?)\s+model\b/i.test(
      message
    )
  ) {
    return { key: 'apiDocumentImagesUnsupported' }
  }
  if (
    /too many (?:referenced )?documents|(?:max(?:imum)? (?:number|count) of|at most) (?:\d+ )?documents|\b(?:document count|number of (?:referenced )?documents)\b.{0,55}(?:exceed|limit|maximum)/i.test(
      message
    )
  ) {
    const match =
      /(?:at most\s+|(?:maximum|limit)\s*(?:of|is|:)?\s*)(\d+)\s*(?:referenced\s+)?documents|(?:number of documents[^.\n]{0,48}(?:is|:)\s*)(\d+)/i.exec(
        message
      )
    const limit = Number(match?.[1] ?? match?.[2])
    return {
      key: 'replyDocumentCountLimit',
      params: limit > 0 && limit <= 10000 ? { documentLimit: limit } : undefined,
    }
  }
  if (
    /(?:total|combined) (?:\w+ ){0,3}(?:document|file) text.{0,75}(?:exceed|limit|too large)|\b(?:document|file) text.{0,60}(?:8\s*mi?b|size limit)/i.test(
      message
    )
  ) {
    return { key: 'replyDocumentTextLimit' }
  }
  if (
    /\b(?:max_tokens|max_completion_tokens|max_output_tokens)\b[\s:=]*(?:\d+\s+)?(?:is invalid|must\b|exceeds?\b|out of range|should\b)|\b(?:invalid|unsupported)\s+(?:value for\s+)?['"]?(?:max_tokens|max_completion_tokens|max_output_tokens)\b|maximum.{0,24}output.{0,20}tokens/i.test(
      message
    )
  ) {
    return { key: 'replyOutputLimitInvalid', params: apiLimitCounts(message) }
  }
  if (
    /^(?:context_length_exceeded|context_window_exceeded|prompt_too_long|user_input_too_long)$/i.test(code) ||
    /\bcontext[_-](?:length|window)[_-]exceeded\b|\bmax(?:imum)?\s+(?:model\s+)?context\s+(?:length|window|limit)\b|\bcontext\s+(?:length|window|limit)\s+(?:is\s+)?(?:exceeded|too long|of\s+[\d,]+)|\b(?:exceeds?|over)\s+(?:the\s+)?(?:model['’]s\s+)?(?:max(?:imum)?\s+)?context\s+(?:length|window|limit)\b|\b(?:prompt|input|context)\s+is\s+too\s+long\b|\binput\s+tokens?.{0,38}(?:exceeds?|too\s+long)\b|\buser\s+input\s+too\s+long\b|\btokens?\b.{0,40}\b(?:but\s+)?(?:the\s+)?max(?:imum)?\s+(?:is|of)\s*[:=]?\s*[\d,]+/i.test(
      message
    )
  ) {
    return { key: 'replyContextTooLong', params: apiLimitCounts(message) }
  }
  if (/uploaded an (unsupported|invalid) image/i.test(message)) {
    return { key: 'apiImageUnsupported' }
  }
  if (/The image is too large to process/i.test(message)) {
    return { key: 'apiImageTooLarge' }
  }
  return undefined
}

/** 只提取服务端固定错误句式中的有限 Token 计数，不输出原始报错/正文。 */
export const apiLimitCounts = (message: string): Record<string, number> => {
  const patterns: [string, RegExp][] = [
    [
      'contextLimitTokens',
      // 第三方网关与官方文档解析常见句式：… exceeds max 32768 tokens / limit is 32768
      /\bexceeds?\s+(?:the\s+)?(?:max(?:imum)?|limit)(?:\s+(?:of|is))?\s*[:=]?\s*([\d,]+)\s*tokens?\b/i,
    ],
    [
      'contextLimitTokens',
      /(?:maximum context length|context (?:window|limit))(?:\s+(?:is|of))?\s*[:=]?\s*([\d,]+)(?=\s*(?:tokens?\b|[.;,)]|$))/i,
    ],
    [
      'contextLimitTokens',
      /\b(?:but\s+)?(?:the\s+)?max(?:imum)?\s+(?:is|of)\s*[:=]?\s*([\d,]+)/i,
    ],
    [
      'requestedTokens',
      /(?:you requested|request contains)\s*([\d,]+)\s+tokens?\b|requested tokens?\s*[:=]\s*([\d,]+)/i,
    ],
    [
      // 同上句式里的实际用量：159058 tokens exceeds max …
      'requestedTokens',
      /\b([\d,]+)\s*tokens?\s+exceeds?\b/i,
    ],
    [
      'outputLimitTokens',
      /(?:max_tokens|max_completion_tokens|max_output_tokens).{0,40}(?:at most|less than(?: or equal to)?|maximum(?: of)?)\s+([\d,]+)/i,
    ],
  ]
  const result: Record<string, number> = {}
  for (const [key, pattern] of patterns) {
    if (result[key] !== undefined) {
      continue
    }
    const match = pattern.exec(message),
      value = match ? Number((match[1] ?? match[2]).replaceAll(',', '')) : NaN
    if (Number.isInteger(value) && value > 0 && value <= 10000000) {
      result[key] = value
    }
  }
  return result
}
