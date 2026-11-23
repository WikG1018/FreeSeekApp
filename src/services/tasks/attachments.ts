import { docxText, isLocalOfficeText } from '../api/providerContent.js'
import { archiveSize, readArchive, readEntry, skipEntry } from '../chat/history/zipReader.js'
import type { FileAttachment } from '../chat/types.js'
import { MAX_SOURCE_CHARS, sourceIdFor, type TaskReadResult } from './evidence.js'
import { excerptEvidence, textExcerpt, type TextPosition } from './readerRange.js'

const FILE_LIMIT = 4 * 1024 * 1024
const PACKAGE_LIMIT = 16 * 1024 * 1024
const PREVIEW_LIMIT = 180_000
const SHEET_XML_LIMIT = 2 * 1024 * 1024
const TEXT_CHUNK_BYTES = 64 * 1024

export const isTaskReadable = (file: FileAttachment) =>
  !file.isImage &&
  file.size <= FILE_LIMIT &&
  (isLocalOfficeText(file) || /\.xlsx$/i.test(file.name))

const elements = (node: Document | Element, name: string) =>
  Array.from(node.getElementsByTagNameNS('*', name))

const parseXml = (value: string) => {
  if (/<!\s*(?:doctype|entity)\b/i.test(value)) {
    throw new Error('Unexpected XML declaration')
  }
  const doc = new DOMParser().parseFromString(value, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('Invalid spreadsheet XML')
  }
  return doc
}

const renderedCellText = (element: Element) =>
  elements(element, 't')
    .filter((part) => !part.closest('rPh'))
    .map((part) => part.textContent ?? '')
    .join('')

const rowReference = (row: Element, fallback: number) => {
  const number = Number(row.getAttribute('r'))
  return Number.isSafeInteger(number) && number > 0 && number <= 1_048_576 ? number : fallback
}

const worksheetData = (
  sheet: Document,
  shared: string[],
  limit: number,
  signal: AbortSignal,
  partial: boolean
) => {
  const rows: string[][] = []
  const rowNumbers: number[] = []
  let characters = 0
  let truncated = false
  const data = elements(sheet, 'sheetData')[0]
  if (!data) {
    throw new Error('Worksheet has no data section')
  }
  for (const row of elements(data, 'row')) {
    signal.throwIfAborted()
    const cells: string[] = []
    for (const cell of elements(row, 'c')) {
      const label = /^[A-Z]{1,3}(?=\d+$)/.exec(cell.getAttribute('r') ?? '')?.[0]
      const index = label
        ? [...label].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0) - 1
        : cells.length
      if (index >= 256) {
        if (!partial) {
          throw new Error('Too many columns')
        }
        truncated = true
        continue
      }
      const type = cell.getAttribute('t')
      const value = elements(cell, 'v')[0]?.textContent ?? ''
      const sharedIndex = /^\d+$/.test(value) ? Number(value) : -1
      const formula = elements(cell, 'f')[0]?.textContent ?? ''
      cells[index] =
        type === 's'
          ? (shared[sharedIndex] ?? '')
          : type === 'inlineStr'
            ? renderedCellText(cell)
            : type === 'b'
              ? value === '1'
                ? 'TRUE'
                : value === '0'
                  ? 'FALSE'
                  : ''
              : value || (formula ? '=' + formula : '')
    }
    // Preserve column positions and reported row numbers without expanding arbitrary blank ranges.
    const padded = Array.from(cells, (value) => value ?? '')
    const cost = JSON.stringify(padded).length + 16
    if (characters + cost > limit) {
      if (!partial) {
        throw new Error('Workbook text is too large to read locally')
      }
      truncated = true
      break
    }
    characters += cost
    rows.push(padded)
    rowNumbers.push(rowReference(row, (rowNumbers.at(-1) ?? 0) + 1))
  }
  return { rows, rowNumbers, characters, truncated }
}

export type PreviewSheet = {
  name: string
  rows: string[][]
  rowNumbers?: number[]
  truncated?: boolean
  layout?: import('./spreadsheetLayout.js').SheetLayout
}

const sheetPath = (target: string) => {
  const candidate = target.startsWith('/') ? target.slice(1) : 'xl/' + target
  return /^xl\/worksheets\/[^/\\]+\.xml$/.test(candidate) ? candidate : undefined
}

export const workbookSheets = async (
  blob: Blob,
  signal: AbortSignal,
  {
    partial = false,
    textLimit = PREVIEW_LIMIT,
    layout = false,
  }: {
    partial?: boolean
    textLimit?: number
    layout?: boolean
  } = {}
): Promise<PreviewSheet[]> => {
  const archive = new File([blob], 'workbook.xlsx')
  const size = await archiveSize(archive)
  signal.throwIfAborted()
  if (size.expandedBytes > PACKAGE_LIMIT || size.total > 400) {
    throw new Error('Workbook is too large to read locally')
  }
  let workbook: Document | undefined
  let relationships: Document | undefined
  let styleBook: Document | undefined
  let shared: string[] = []
  // Retain worksheet bytes and parse one sheet at a time to bound peak DOM memory.
  const sheets = new Map<string, Blob>()
  for await (const entry of readArchive(archive)) {
    signal.throwIfAborted()
    const isWorksheet = /^xl\/worksheets\/[^/]+\.xml$/.test(entry.path)
    const recognized =
      ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml'].includes(
        entry.path
      ) ||
      isWorksheet ||
      (layout && entry.path === 'xl/styles.xml')
    if (!recognized) {
      await skipEntry(entry)
      continue
    }
    if (entry.size > SHEET_XML_LIMIT || (isWorksheet && sheets.size >= 20)) {
      throw new Error('Workbook is too large to read locally')
    }
    const bytes = await readEntry(entry)
    if (isWorksheet) {
      sheets.set(entry.path, bytes)
      continue
    }
    const xml = parseXml(await bytes.text())
    if (entry.path === 'xl/workbook.xml') {
      workbook = xml
    } else if (entry.path === 'xl/_rels/workbook.xml.rels') {
      relationships = xml
    } else if (entry.path === 'xl/styles.xml') {
      styleBook = xml
    } else {
      shared = elements(xml, 'si').map(renderedCellText)
    }
  }
  signal.throwIfAborted()
  if (!workbook || !relationships) {
    throw new Error('Workbook parts are missing')
  }
  const paths = new Map(
    elements(relationships, 'Relationship')
      .filter((node) => node.getAttribute('TargetMode')?.toLowerCase() !== 'external')
      .map((node) => [node.getAttribute('Id'), sheetPath(node.getAttribute('Target') ?? '')])
  )
  const result: PreviewSheet[] = []
  const preview = layout ? await import('./spreadsheetLayout.js') : undefined
  const styles = preview?.stylesFromWorkbook(styleBook) ?? []
  const date1904 = /^(?:1|true)$/.test(
    elements(workbook, 'workbookPr')[0]?.getAttribute('date1904') ?? ''
  )
  let remaining = Math.max(1, Math.min(layout ? 3_000_000 : MAX_SOURCE_CHARS, textLimit))
  for (const sheet of elements(workbook, 'sheet')) {
    signal.throwIfAborted()
    const id =
      sheet.getAttributeNS(
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
        'id'
      ) ??
      sheet.getAttributeNS('http://purl.oclc.org/ooxml/officeDocument/relationships', 'id') ??
      ''
    const target = paths.get(id)
    const bytes = target && sheets.get(target)
    if (bytes) {
      const name = (sheet.getAttribute('name') ?? '').slice(0, 160)
      remaining -= JSON.stringify(name).length + 8
      if (partial && remaining <= 0) {
        result.push({ name, rows: [], rowNumbers: [], truncated: true })
        continue
      }
      const document = parseXml(await bytes.text())
      const { rows, rowNumbers, characters, truncated } = worksheetData(
        document,
        shared,
        remaining,
        signal,
        partial
      )
      remaining -= characters
      if (remaining < 0) {
        throw new Error('Workbook text is too large to read locally')
      }
      result.push({
        name,
        rows,
        rowNumbers,
        ...(truncated && { truncated: true }),
        layout: preview?.readSheetLayout(document, styles, rows, rowNumbers, date1904),
      })
    }
  }
  if (result.length === 0) {
    throw new Error('Workbook has no readable worksheets')
  }
  return result
}

export type TaskFilePreview =
  | { kind: 'xlsx'; sheets: PreviewSheet[] }
  | { kind: 'text'; text: string; truncated?: boolean }

export type TaskAttachmentSource = {
  text: string
  downloadedBytes: number
  sourceTruncated: boolean
}

const readBoundedText = async (
  blob: Blob,
  signal: AbortSignal,
  limit: number
): Promise<TaskAttachmentSource> => {
  signal.throwIfAborted()
  const first = new Uint8Array(await blob.slice(0, 2).arrayBuffer())
  const charset =
    first[0] === 0xff && first[1] === 0xfe
      ? 'utf-16le'
      : first[0] === 0xfe && first[1] === 0xff
        ? 'utf-16be'
        : 'utf-8'
  const decoder = new TextDecoder(charset, { fatal: true })
  const parts: string[] = []
  let chars = 0
  let downloadedBytes = 0
  let sourceTruncated = false
  while (downloadedBytes < blob.size) {
    signal.throwIfAborted()
    const chunk = await blob
      .slice(downloadedBytes, downloadedBytes + TEXT_CHUNK_BYTES)
      .arrayBuffer()
    signal.throwIfAborted()
    downloadedBytes += chunk.byteLength
    const last = downloadedBytes === blob.size
    const part = decoder.decode(chunk, { stream: !last })
    if (part.includes('\0')) {
      throw new Error('Read blocked on binary text')
    }
    const accepted = part.slice(0, limit - chars)
    parts.push(accepted)
    chars += accepted.length
    if (accepted.length < part.length || (chars >= limit && !last)) {
      sourceTruncated = true
      break
    }
  }
  return {
    text: parts.join('').replace(/\r\n?/g, '\n'),
    downloadedBytes,
    sourceTruncated,
  }
}

export const loadTaskAttachmentSource = async (
  file: FileAttachment,
  blob: Blob,
  signal: AbortSignal,
  limit = MAX_SOURCE_CHARS
): Promise<TaskAttachmentSource | undefined> => {
  if (!isTaskReadable({ ...file, size: blob.size })) {
    return undefined
  }
  if (/\.(?:docx|xlsx)$/i.test(file.name)) {
    const excel = /\.xlsx$/i.test(file.name)
    const sheets = excel
      ? await workbookSheets(blob, signal, { partial: true, textLimit: limit })
      : undefined
    const text = sheets
      ? sheets
          .map(
            ({ name, rows, rowNumbers }) =>
              'Sheet ' +
              JSON.stringify(name) +
              '\n' +
              rows
                .map(
                  (row, index) =>
                    String(rowNumbers?.[index] ?? index + 1) + '\t' + JSON.stringify(row)
                )
                .join('\n')
          )
          .join('\n')
      : await docxText(blob, signal)
    signal.throwIfAborted()
    if (!text?.trim()) {
      return undefined
    }
    return {
      text: text.replace(/\r\n?/g, '\n').slice(0, limit),
      downloadedBytes: blob.size,
      sourceTruncated: text.length > limit || Boolean(sheets?.some((sheet) => sheet.truncated)),
    }
  }
  const result = await readBoundedText(blob, signal, limit)
  return result.text.trim() ? result : undefined
}

export const readTaskAttachment = (
  file: FileAttachment,
  source: TaskAttachmentSource,
  position: TextPosition,
  limit = 12_000
): TaskReadResult => {
  const excerpt = textExcerpt(source.text, position, limit)
  const title = file.name.replace(/[\r\n]/g, ' ').slice(0, 140)
  const evidence = excerptEvidence(
    {
      sourceId: sourceIdFor('attachment', file.id),
      kind: 'attachment',
      title,
      downloadedBytes: source.downloadedBytes,
      partial: source.sourceTruncated,
      sourceTruncated: source.sourceTruncated,
    },
    excerpt,
    position,
    source.text.length
  )
  if ('content' in excerpt && !excerpt.content.length) {
    return {
      isError: true,
      reason: 'empty-range',
      evidence,
      text: 'There is no text at that offset or line range in the available attachment.',
    }
  }
  return {
    evidence,
    text: JSON.stringify({
      name: title,
      external_reference: true,
      ...excerpt,
      evidence,
    }),
  }
}

export const readTaskPreview = async (
  file: FileAttachment,
  blob: Blob,
  signal: AbortSignal
): Promise<TaskFilePreview> => {
  if (blob.size > FILE_LIMIT) {
    throw new Error('Task preview exceeds the size limit')
  }
  if (/\.xlsx$/i.test(file.name)) {
    return { kind: 'xlsx', sheets: await workbookSheets(blob, signal, { partial: true }) }
  }
  if (/\.(?:docx|md|csv|txt|json)$/i.test(file.name)) {
    const source = await loadTaskAttachmentSource(file, blob, signal, PREVIEW_LIMIT)
    if (source) {
      return { kind: 'text', text: source.text, ...(source.sourceTruncated && { truncated: true }) }
    }
  }
  throw new Error('Task preview is unavailable')
}

// Legacy callers expecting plain text retain their narrow interface.
export const taskAttachmentText = async (file: FileAttachment, blob: Blob, signal: AbortSignal) =>
  (await loadTaskAttachmentSource(file, blob, signal))?.text
