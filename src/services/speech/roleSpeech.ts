import type { VoiceSegment } from './roleMarkers.js'

const MAX_LIVE_PART = 220

const speakableText = (text: string) => text
  .replace(/!?\[([^\]\n]+)\]\([^\n)]*\)/g, '$1')
  .replace(/^ {0,3}(?:#{1,6} +|> *|[*+-] +)/gm, '')
  .replace(/\*\*|__|~~/g, '')
  .trim()

/** English periods with a following digit or letter can still be part of a number or URL. */
const sentenceEnd = (text: string, start: number) => {
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (/[。！？!?\n]/.test(char) || (char === '.' && /[\s”’"'）)]/.test(text[i + 1] ?? ''))) {
      let end = i + 1
      while (end < text.length && /[。！？.!?…」』”’"'）)]/.test(text[end])) {
        end++
      }
      return end
    }
  }
  return -1
}

/** The cursor is an offset in the original reply, independent of whitespace and hidden tags. */
export const readyRoleSpeech = (
  segments: VoiceSegment[],
  cursor: number,
  done: boolean
) => {
  const ready: VoiceSegment[] = []
  for (const segment of segments) {
    if (!segment.span) {
      continue
    }
    const { text, span, roleId, tone } = segment
    let start = Math.max(0, cursor - span.start)
    while (start < text.length) {
      const boundary = sentenceEnd(text, start)
      let end = boundary < 0 ? text.length : boundary
      if (end - start > MAX_LIVE_PART) {
        end = start + MAX_LIVE_PART
        const next = text.charCodeAt(end)
        if (next >= 0xdc00 && next <= 0xdfff) {
          end++
        }
      } else if (boundary < 0 && !done && !span.closed) {
        break
      }
      const spoken = speakableText(text.slice(start, end))
      if (/[\p{L}\p{N}]/u.test(spoken)) {
        ready.push({ text: spoken, roleId, tone, span: { start: span.start + start, closed: true } })
      }
      start = end
      cursor = span.start + end
    }
  }
  return { segments: ready, cursor }
}
