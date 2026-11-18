import type { TranslationMessage } from '../../i18n/index.js'

/**
 * 能识别出原因的 400：直接给本地文案，避免把整段英文报错展示给用户。
 * 只依赖文案 key，不依赖 ApiError，供 client 与 errors 共用。
 */
export const describeKnownApiError = (message: string): TranslationMessage | undefined => {
  if (
    /\brich_layout_recognition\b/i.test(message) &&
    /\bcontains\s+images\b[\s\S]{0,48}\bnot\s+supported\s+by\s+(?:this|the(?: current)?)\s+model\b/i.test(
      message
    )
  ) {
    return { key: 'apiDocumentImagesUnsupported' }
  }
  if (
    /context.{0,60}(?:length|window|limit|exceed|too.{0,8}long)|maximum.{0,30}context|input.{0,25}tokens?.{0,40}(?:exceed|too.{0,8}long)|prompt is too long/i.test(
      message
    )
  ) {
    return { key: 'replyContextTooLong' }
  }
  if (
    /\b(?:max_tokens|max_completion_tokens|max_output_tokens)\b.{0,70}(?:must|exceed|limit|maximum|range|greater|less)|maximum.{0,20}output.{0,20}tokens/i.test(
      message
    )
  ) {
    return { key: 'replyOutputLimitInvalid' }
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
      /(?:maximum context length|context (?:window|limit))(?:\s+(?:is|of))?\s*[:=]?\s*([\d,]+)/i,
    ],
    ['requestedTokens', /(?:you requested|request contains|requested tokens?\s*[:=])\s*([\d,]+)/i],
    [
      'outputLimitTokens',
      /max_tokens.{0,40}(?:at most|less than(?: or equal to)?|maximum(?: of)?)\s+([\d,]+)/i,
    ],
  ]
  const result: Record<string, number> = {}
  for (const [key, pattern] of patterns) {
    const match = pattern.exec(message),
      value = match ? Number(match[1].replaceAll(',', '')) : NaN
    if (Number.isInteger(value) && value > 0 && value <= 10000000) {
      result[key] = value
    }
  }
  return result
}
