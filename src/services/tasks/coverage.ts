import type { TaskEvidence } from './evidence.js'

/** A full file may have been sent in many individually partial excerpts. */
export const coveredTaskSource = (
  target: TaskEvidence,
  reads: readonly TaskEvidence[]
): boolean => {
  const same = reads.filter(({ sourceId }) => sourceId === target.sourceId)
  if (same.some((item) => !item.partial && !item.sourceTruncated)) {
    return true
  }
  if (target.sourceTruncated || target.nextCursor || !target.availableChars) {
    return false
  }
  let end = 0
  const ranges = same
    .filter(
      (item) =>
        !item.sourceTruncated && !item.nextCursor && item.availableChars === target.availableChars
    )
    .map(
      (item) => item.characterRange ?? (item.range?.unit === 'characters' ? item.range : undefined)
    )
    .filter((range): range is { start: number; end: number } => range !== undefined)
    .sort((a, b) => a.start - b.start)
  for (const range of ranges) {
    if (range.start > end) {
      break
    }
    end = Math.max(end, range.end)
  }
  return end >= target.availableChars
}
