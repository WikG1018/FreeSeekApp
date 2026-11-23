import type { TaskEvidence } from './evidence.js'

const DEFAULT_CHARS = 10_000
export const readPosition = {
  offset: { type: 'integer', minimum: 0 },
  find: { type: 'string', maxLength: 96 },
  start_line: { type: 'integer', minimum: 1 },
  end_line: { type: 'integer', minimum: 1 },
}

export type TextPosition = {
  offset: number
  find?: string
  startLine?: number
  endLine?: number
}

export const textPosition = (input: Record<string, unknown>): TextPosition | undefined => {
  const { offset = 0, find, start_line, end_line } = input
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
    return undefined
  }
  if (find !== undefined && (typeof find !== 'string' || !find.trim() || find.length > 96)) {
    return undefined
  }
  const line = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
  if (
    (start_line !== undefined && !line(start_line)) ||
    (end_line !== undefined && !line(end_line)) ||
    (line(start_line) && line(end_line) && start_line > end_line)
  ) {
    return undefined
  }
  return {
    offset,
    find: typeof find === 'string' ? find.trim() : undefined,
    startLine: line(start_line) ? start_line : undefined,
    endLine: line(end_line) ? end_line : undefined,
  }
}

const offsetAtLine = (text: string, line: number) => {
  let at = 0
  for (let number = 1; number < line; number++) {
    const newline = text.indexOf('\n', at)
    if (newline < 0) {
      return text.length
    }
    at = newline + 1
  }
  return at
}

const lineAtOffset = (text: string, offset: number) => {
  let line = 1
  let newline = text.indexOf('\n')
  while (newline >= 0 && newline < offset) {
    line++
    newline = text.indexOf('\n', newline + 1)
  }
  return line
}

type TextExcerpt =
  | {
      offset: number
      start_line: number
      end_line: number
      content: string
      next_offset: number | null
    }
  | {
      find: string
      matches: Array<{ offset: number; line: number; excerpt: string }>
      next_offset: number | null
    }

export const textExcerpt = (
  text: string,
  position: TextPosition,
  limit = DEFAULT_CHARS
): TextExcerpt => {
  const lower = Math.max(
    position.offset,
    position.startLine ? offsetAtLine(text, position.startLine) : 0
  )
  const upper = position.endLine ? offsetAtLine(text, position.endLine + 1) : text.length
  const start = Math.min(lower, upper)
  if (position.find) {
    const matches: Array<{ offset: number; line: number; excerpt: string }> = []
    const pattern = new RegExp(position.find.replace(/[.*+?^\x24{}()|[\]\\]/g, '\\$&'), 'gi')
    pattern.lastIndex = start
    for (let i = 0; i < 8; i++) {
      const match = pattern.exec(text)
      if (!match || match.index + match[0].length > upper) {
        break
      }
      matches.push({
        offset: match.index,
        line: lineAtOffset(text, match.index),
        excerpt: text.slice(
          Math.max(start, match.index - 120),
          Math.min(upper, pattern.lastIndex + 180)
        ),
      })
    }
    return {
      find: position.find,
      matches,
      next_offset: matches.length === 8 && pattern.lastIndex < upper ? pattern.lastIndex : null,
    }
  }
  const end = Math.min(upper, start + limit)
  const content = text.slice(start, end)
  return {
    offset: start,
    start_line: lineAtOffset(text, start),
    end_line: lineAtOffset(text, Math.max(start, end - 1)),
    content,
    next_offset: end < upper ? end : null,
  }
}

export const excerptEvidence = (
  evidence: TaskEvidence,
  excerpt: TextExcerpt,
  position: TextPosition,
  availableChars: number
): TaskEvidence => {
  const plain = 'content' in excerpt
  const deliveredChars = plain
    ? excerpt.content.length
    : excerpt.matches.reduce((sum, match) => sum + match.excerpt.length, 0)
  return {
    ...evidence,
    availableChars,
    deliveredChars,
    ...(deliveredChars > 0 && {
      excerpt: (plain
        ? excerpt.content
        : excerpt.matches.map((match) => match.excerpt).join('\n\n')
      ).slice(0, 1200),
    }),
    partial: evidence.partial || !plain || excerpt.offset !== 0 || deliveredChars < availableChars,
    ...(plain &&
      deliveredChars > 0 && {
        characterRange: { start: excerpt.offset, end: excerpt.offset + deliveredChars },
        range:
          position.startLine !== undefined || position.endLine !== undefined
            ? { unit: 'lines', start: excerpt.start_line, end: excerpt.end_line }
            : { unit: 'characters', start: excerpt.offset, end: excerpt.offset + deliveredChars },
      }),
    ...(excerpt.next_offset !== null && { nextOffset: excerpt.next_offset }),
  }
}
