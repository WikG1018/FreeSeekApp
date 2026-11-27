export type AutoPreference = {
  text: string
  topic?: string
  relative?: boolean
  format?: string
}

const format = '(?:Markdown|Word|DOCX|PDF|Excel|XLSX|CSV|PPTX?|JSON|TXT|表格|列表|纯文本)'
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
  /^(?:(?:请|麻烦)?(?:帮我)?记住[，,：:\s]*|(?:(?:我希望|我想要|请|麻烦)你?\s*)?(?:以后|今后|往后|从现在起|从现在开始|长期)[，,：:\s]*(?:都|要|请|默认)?\s*|(?:please\s+)?remember(?:\s+that)?[\s:]+|from now on[,\s]+|always\s+)/iu
const habit = /^(?:我(?:通常|一直|平时|习惯|偏好|更喜欢)|i (?:usually|prefer|always)\b)/iu
const temporary =
  /(?:这次|本次|本轮|今天|临时|只这一次|仅限本次|for this (?:one|reply|task)|just this once)/iu
const imagined =
  /(?:假设|假如|举例|举个例子|虚构|角色扮演|(?:小说|故事|剧本)[里中]|(?:对白|台词|角色说)[：:]|引用|引述|as an example|pretend|roleplay|quoted)/iu
const preferenceCue =
  /(?:喜欢|偏好|更想|希望|习惯|尽量|优先|一般|惯例|风格|prefer|usually|tend to|like to)/iu
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

// Preserve sentence boundaries without attributing quoted speech, example code or Markdown
// quotes to the user. Skip a sentence containing masked text instead of saving a partial quote.
function* statements(input: string) {
  if (imagined.test(input)) {
    return
  }
  const prose = input
    .replace(
      /\x60{3}[\s\S]*?(?:\x60{3}|(?![\s\S]))|~{3}[\s\S]*?(?:~{3}|(?![\s\S]))|^[ \t]*>[^\n]*|“[^”]*(?:”|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|‘[^’]*(?:’|$)|"[^"]*(?:"|$)|\x60[^\x60\n]*(?:\x60|$)/gmu,
      '\uFFFC'
    )
    .replace(/(^|[\s（(：:，,。！？!?])'[^']*(?:'|$)/gu, '$1\uFFFC')
  const sentences = /[^。！？!?\n；;]+?(?:[。！？!?\n；;]|\.(?=\s)|$)/gu
  let match: RegExpExecArray | null
  while ((match = sentences.exec(prose))) {
    const raw = match[0].trim()
    if (!raw || raw.includes('\uFFFC') || /[？?]$/u.test(raw) || !isMemoryEvidence(raw)) {
      continue
    }
    yield raw.replace(/[。！!；;.]$/u, '').trim()
  }
}

export const maintenanceEvidence = (input: string) => {
  for (const sentence of statements(input)) {
    if (sentence.length <= 640 && preferenceCue.test(sentence)) {
      return sentence
    }
  }
  return undefined
}

export const automaticPreference = (input: string, stored = false): AutoPreference | undefined => {
  for (const sentence of statements(input)) {
    const prefix = enduring.exec(sentence)
    if (stored || prefix || habit.test(sentence)) {
      const preference = parsePreference(prefix ? sentence.slice(prefix[0].length) : sentence)
      if (preference) {
        return preference
      }
    }
  }
  return undefined
}

const parsePreference = (statement: string): AutoPreference | undefined => {
  const text = statement
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
