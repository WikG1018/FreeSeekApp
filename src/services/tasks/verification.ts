import { coveredTaskSource } from './coverage.js'
import type { TaskArtifact, TaskStep } from './tools.js'

/** Evidence comes from completed tool effects, not assertions made by the model. */
export const verifyCriterion = (
  criterion: string,
  references: unknown[],
  artifacts: TaskArtifact[],
  steps: TaskStep[]
) => {
  if (!criterion || references.length === 0 || references.length > 16) {
    return false
  }
  const files = references.map((id) => artifacts.find((entry) => entry.id === id))
  const outcomes = references.map((id) => steps.find((entry) => entry.id === id))
  const sources = steps.flatMap(({ evidence }) => evidence ?? [])
  if (
    !references.every(
      (_, index) =>
        files[index] ||
        (outcomes[index]?.status === 'done' &&
          !['files', 'plan', 'verification'].includes(outcomes[index].kind) &&
          (outcomes[index].evidence ?? []).every((entry) => coveredTaskSource(entry, sources)))
    )
  ) {
    return false
  }
  if (
    /测试.{0,8}通过|通过.{0,8}测试|(?:执行|运行|跑).{0,8}测试|\btests?\b.{0,25}\bpass|\brun\b.{0,25}\btests?\b/i.test(
      criterion
    )
  ) {
    return outcomes.some((step) => step?.kind === 'script' && (step.assertions ?? 0) > 0)
  }
  if (/运行.{0,8}(?:脚本|程序)|\b(?:execute|run)\b.{0,25}\b(?:script|program)\b/i.test(criterion)) {
    return outcomes.some((step) => step?.kind === 'script')
  }
  if (/精细度|足够美观|视觉美观|visual quality/i.test(criterion)) {
    return false
  }
  if (/尺寸|\bdimensions?\b/i.test(criterion)) {
    const match =
      /(\d+(?:\.\d+)?)\s*[×x*]\s*(\d+(?:\.\d+)?)\s*[×x*]\s*(\d+(?:\.\d+)?)(?:\s*(毫米|厘米|米|mm|cm|m)\b)?/i.exec(
        criterion
      )
    const factor =
      match?.[4] === '米' || match?.[4] === 'm'
        ? 1000
        : match?.[4] === '厘米' || match?.[4] === 'cm'
          ? 10
          : 1
    const expected = match?.slice(1, 4).map((value) => Number(value) * factor)
    return files.some((file) =>
      file?.sizeMm?.every(
        (size, index) =>
          Number.isFinite(size) &&
          size >= 0 &&
          (!expected || Math.abs(size - expected[index]) <= Math.max(1, expected[index] * 0.01))
      )
    )
  }
  if (/\b(?:GLB|STL)\b|三维模型|3D\s*模型/i.test(criterion)) {
    return files.some((file) => /\.(?:glb|stl)$/i.test(file?.name ?? ''))
  }
  if (
    /\b(?:Markdown|DOCX|XLSX|PDF|PPTX)\b/i.test(criterion) &&
    /写|生成|导出|制作|保存|\b(?:write|create|export|save)\b/i.test(criterion)
  ) {
    const expected = /\b(Markdown|DOCX|XLSX|PDF|PPTX)\b/i.exec(criterion)?.[1].toLowerCase()
    const extension = expected === 'markdown' ? 'md' : expected
    return files.some((file) => file?.name.toLowerCase().endsWith('.' + extension))
  }
  return true
}
