/** Split at nearby sentence boundaries and keep surrogate pairs intact. */
export const splitSpeechText = (text: string, limit: number): string[] => {
  limit = Math.max(2, limit)
  const parts: string[] = []
  for (let start = 0; start < text.length; ) {
    let end = start
    let boundary = start
    let wordBoundary = start
    let units = 0
    while (end < text.length) {
      const code = text.codePointAt(end) ?? 0
      units += code <= 0x7f ? 1 : 2
      if (units > limit) {
        break
      }
      const character = text[end]
      end += code > 0xffff ? 2 : 1
      if (units >= limit / 2) {
        if (/[。！？；，、.!?;,\n]/.test(character)) {
          boundary = end
        } else if (/\s/.test(character)) {
          wordBoundary = end
        }
      }
    }
    const preferred = boundary > start ? boundary : wordBoundary
    const cut = end < text.length && preferred > start ? preferred : end
    const part = text.slice(start, cut).trim()
    if (part) {
      parts.push(part)
    }
    start = cut
  }
  return parts
}
