import { wordText } from '../api/providerContent.js'
import type { FileAttachment } from '../chat/types.js'
import { archiveSize, readArchive, readEntry, skipEntry } from '../chat/history/zipReader.js'
import { parseCsv } from './analysis.js'
import { readTaskPreview, workbookSheets, type PreviewSheet } from './attachments.js'
import { taskFileKind } from './artifacts.js'
import { readLaidOutFile, type LaidOutDocument } from './documentPreview.js'
import type { SourceProject } from './projectFiles.js'

const FILE_LIMIT = 4 * 1024 * 1024
const DOCUMENT_LIMIT = 8 * 1024 * 1024
const ARCHIVE_LIMIT = 64 * 1024 * 1024
const READING_TEXT_LIMIT = 180_000
const WORD_NAMESPACES = [
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]

export type DocumentPart =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph' | 'list'; text: string }
  | { type: 'table'; rows: string[][] }

export type ArtifactReading =
  | LaidOutDocument
  | { kind: 'document'; sections: DocumentPart[] }
  | { kind: 'table'; sheets: PreviewSheet[] }
  | { kind: 'text'; format: 'md' | 'json' | 'txt'; text: string }
  | { kind: 'project'; files: SourceProject }
  | { kind: 'model'; buffer: ArrayBuffer; format: 'glb' | 'stl' }

const sameNamespaceChildren = (element: Element, namespace: string) =>
  Array.from(element.children).filter((child) => child.namespaceURI === namespace)

const parseWord = (source: string): DocumentPart[] => {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) {
    throw new Error('Invalid Word document')
  }
  const xml = new DOMParser().parseFromString(source, 'application/xml')
  const namespace = xml.documentElement.namespaceURI ?? ''
  const body = xml.getElementsByTagNameNS(namespace, 'body')[0]
  if (
    !WORD_NAMESPACES.includes(namespace) ||
    !body ||
    xml.getElementsByTagName('parsererror').length
  ) {
    throw new Error('Invalid Word document')
  }

  const blocks: DocumentPart[] = []
  let characters = 0
  for (const child of sameNamespaceChildren(body, namespace)) {
    if (child.localName === 'p') {
      const text = wordText(xml, child, namespace)
      if (!text.trim()) {
        continue
      }
      const props = sameNamespaceChildren(child, namespace).find((item) => item.localName === 'pPr')
      const preset = props
        ?.getElementsByTagNameNS(namespace, 'pStyle')[0]
        ?.getAttributeNS(namespace, 'val')
      const outlineLevel = props
        ?.getElementsByTagNameNS(namespace, 'outlineLvl')[0]
        ?.getAttributeNS(namespace, 'val')
      const heading = /^heading\s*([1-6])$/i.exec(preset ?? '')
      const level = /^title$/i.test(preset ?? '')
        ? 1
        : heading
          ? Number(heading[1])
          : /^[0-5]$/.test(outlineLevel ?? '')
            ? 1 + Number(outlineLevel)
            : 0
      const list = Boolean(props?.getElementsByTagNameNS(namespace, 'numPr')[0])
      blocks.push(
        level ? { type: 'heading', text, level } : { type: list ? 'list' : 'paragraph', text }
      )
      characters += text.length
    } else if (child.localName === 'tbl') {
      const rows = sameNamespaceChildren(child, namespace)
        .filter((item) => item.localName === 'tr')
        .map((row) =>
          sameNamespaceChildren(row, namespace)
            .filter((cell) => cell.localName === 'tc')
            .map((cell) =>
              sameNamespaceChildren(cell, namespace)
                .filter((item) => item.localName === 'p')
                .map((paragraph) => wordText(xml, paragraph, namespace))
                .join('\n')
            )
        )
      if (rows.length > 0) {
        blocks.push({ type: 'table', rows })
        characters += rows.reduce((total, row) => total + row.join('').length + row.length, 0)
      }
    }
    if (characters > READING_TEXT_LIMIT) {
      throw new Error('File exceeds the reading preview limit')
    }
  }
  if (!blocks.length) {
    throw new Error('Word document contains no readable body')
  }
  return blocks
}

const readWord = async (blob: Blob, signal: AbortSignal) => {
  const file = new File([blob], 'document.docx')
  const size = await archiveSize(file)
  if (size.expandedBytes > ARCHIVE_LIMIT || size.total > 2_048) {
    throw new Error('Word document exceeds the reading preview limit')
  }
  for await (const entry of readArchive(file)) {
    signal.throwIfAborted()
    if (entry.path !== 'word/document.xml') {
      await skipEntry(entry)
      continue
    }
    if (entry.size > DOCUMENT_LIMIT) {
      throw new Error('Word document exceeds the reading preview limit')
    }
    const word = await (await readEntry(entry)).text()
    signal.throwIfAborted()
    return parseWord(word)
  }
  throw new Error('Word document has no body')
}

export const readArtifact = async (
  file: FileAttachment,
  blob: Blob,
  signal: AbortSignal,
  textOnly = false
): Promise<ArtifactReading> => {
  const kind = taskFileKind(file.name)
  if (kind === 'zip') {
    const { openProjectArchive } = await import('./projectFiles.js')
    const files = await openProjectArchive(blob, signal)
    if (!files.length) {
      throw new Error('No project files')
    }
    return { kind: 'project', files }
  }
  if ((kind === 'glb' || kind === 'stl') && blob.size <= 2 * 1024 * 1024) {
    const buffer = await blob.arrayBuffer()
    signal.throwIfAborted()
    return { kind: 'model', buffer, format: kind }
  }
  if (kind === 'pdf' || kind === 'pptx' || (kind === 'docx' && !textOnly)) {
    return readLaidOutFile(kind, blob, signal)
  }
  if (kind === 'xlsx' && blob.size <= 32 * 1024 * 1024) {
    return {
      kind: 'table',
      sheets: await workbookSheets(blob, signal, { layout: true, textLimit: 3_000_000 }),
    }
  }
  if (blob.size > FILE_LIMIT) {
    throw new Error('File exceeds the reading preview limit')
  }
  if (kind === 'docx') {
    return { kind: 'document', sections: await readWord(blob, signal) }
  }
  const preview = await readTaskPreview(file, blob, signal)
  if (preview.kind === 'xlsx') {
    return { kind: 'table', sheets: preview.sheets }
  }
  if (kind === 'csv') {
    return { kind: 'table', sheets: [{ name: file.name, rows: parseCsv(preview.text) }] }
  }
  return {
    kind: 'text',
    format: kind === 'md' || kind === 'json' ? kind : 'txt',
    text: preview.text,
  }
}
