export type AutoPreference = {
  text: string
  topic?: string
  relative?: boolean
  format?: string
}

const format = '(?:Markdown|Word|DOCX|PDF|Excel|XLSX|CSV|PPTX?|JSON|TXT)'
const useFormat = new RegExp(
  '^(.{0,80}?)\\s*(?:默认采用|默认使用|默认用|统一用|改为|改用|采用|使用|用)\\s*(' +
    format +
    ')\\s*(?:格式|版)?$',
  'iu'
)
const englishFormat = new RegExp(
  '^(?:use|switch to)\\s+(' + format + ')(?:\\s+(?:for|in)\\s+(.{2,80}))?$',
  'iu'
)
const enduring =
  /^(?:(?:请|麻烦)?记住[：:\s]*|(?:以后|今后|从现在起|长期)[，,：:\s]*(?:都|要|请|默认)?\s*|(?:please\s+)?remember(?:\s+that)?[\s:]+|from now on[,\s]+|always\s+)/iu
const habit = /^(?:我(?:通常|一直|平时|习惯|偏好|更喜欢)|i (?:usually|prefer|always)\b)/iu
const temporary =
  /(?:这次|本次|本轮|今天|临时|只这一次|仅限本次|for this (?:one|reply|task)|just this once)/iu
const imagined =
  /(?:假设|假如|举例|虚构|角色扮演|小说里|引用|引述|as an example|pretend|roleplay|quoted)/iu
export const isMemoryEvidence = (text: string) =>
  !!text.trim() &&
  !/^(?:[>“「『"'‘\x60]|[-*] )/u.test(text.trim()) &&
  !temporary.test(text) &&
  !imagined.test(text)
const formatKey = (topic: string) =>
  topic
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s的]+/gu, '')
    .slice(0, 80)

export const automaticPreference = (input: string, stored = false): AutoPreference | undefined => {
  const source = input.trim()
  if (!source || source.length > 4_000) {
    return
  }
  const first = source.split(/[。！!?\n；;]/u, 1)[0].trim()
  if (!isMemoryEvidence(first)) {
    return
  }
  const prefix = enduring.exec(first)
  if (!stored && !prefix && !habit.test(first)) {
    return
  }
  const text = (prefix ? first.slice(prefix[0].length) : first)
    .replace(/[,，]\s*(?:之前|以前|原来|原先).+$/u, '')
    .replace(/[.。]+$/u, '')
    .trim()
  if (text.length < 3 || text.length > 370) {
    return
  }
  const local = useFormat.exec(text)
  const english = englishFormat.exec(text)
  if (local || english) {
    const subject = (local?.[1] ?? english?.[2] ?? '').trim()
    const key = formatKey(subject)
    const relative = !key && /^(?:改用|改为|switch to)/iu.test(text)
    if (/(?:不|不要|别)$/u.test(subject)) {
      return { text }
    }
    return {
      text,
      format: local?.[2] ?? english?.[1],
      ...(key || !relative ? { topic: 'format:' + (key || 'default') } : { relative }),
    }
  }
  if (
    /^(?:回复|回答)?(?:默认)?(?:用|使用|换成)(?:简体中文|繁體中文|中文|英文|英语)|^(?:answer|reply) in [a-z]+$/iu.test(
      text
    )
  ) {
    return { text, topic: 'reply-language' }
  }
  return { text }
}
