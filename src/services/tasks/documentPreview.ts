import { Capacitor, registerPlugin } from '@capacitor/core'
import { strToU8, zipSync } from 'fflate'
import { blobBase64 } from '../../utils/blobBase64.js'
import { archiveSize, readArchive, readEntry, skipEntry } from '../chat/history/zipReader.js'
import { diagnosticError, logEvent } from '../diagnostics/log.js'

export type PageImage = { url: string; width: number; height: number; dispose?: () => void }
export type PagedDocument = {
  mode: 'pdf' | 'office' | 'slides'
  count: number
  render: (index: number, width: number, signal: AbortSignal) => Promise<PageImage>
  text?: (index: number) => Promise<string>
  close: () => void
}
export type LaidOutDocument =
  | { kind: 'pages'; document: PagedDocument }
  | { kind: 'word-layout'; document: Blob }

declare global {
  interface Window {
    freeseekPdfRuntime?: typeof import('pdfjs-dist')
    freeseekOfficePreview?: (options: {
      kind: 'docx' | 'pptx'
      bytes: Uint8Array
    }) => Promise<Uint8Array | null>
  }
}

let pdfRuntime: Promise<typeof import('pdfjs-dist')> | undefined
const loadPdfRuntime = (assets: URL) =>
  (pdfRuntime ??= new Promise<typeof import('pdfjs-dist')>((resolve, reject) => {
    const script = document.createElement('script')
    script.type = 'module'
    script.src = new URL('runtime.mjs', assets).href
    const cleanup = () => {
      clearTimeout(timeout)
      script.remove()
    }
    const fail = () => {
      cleanup()
      pdfRuntime = undefined
      reject(new DocumentPreviewError('format'))
    }
    const timeout = window.setTimeout(fail, 12_000)
    script.onerror = fail
    script.onload = () => {
      if (window.freeseekPdfRuntime) {
        cleanup()
        resolve(window.freeseekPdfRuntime)
      } else {
        fail()
      }
    }
    document.head.appendChild(script)
  }))

const AndroidPdf = registerPlugin<{
  create(options: { size: number }): Promise<{ id: string }>
  write(options: { id: string; data: string }): Promise<void>
  open(options: { id: string }): Promise<{ pages: number; searchable: boolean }>
  page(options: { id: string; index: number; width?: number; text?: boolean }): Promise<{
    url?: string
    text?: string
    width: number
    height: number
  }>
  close(options: { id: string }): Promise<void>
}>('PdfPreview')

export class DocumentPreviewError extends Error {
  constructor(readonly reason: 'limit' | 'password' | 'format' | 'storage') {
    super('Document preview: ' + reason)
    this.name = 'DocumentPreviewError'
  }
}

export const documentPreviewLimit = (extension: string) =>
  extension === 'pdf' ? 128 * 1024 * 1024 : 32 * 1024 * 1024

const imageFromCanvas = async (
  canvas: HTMLCanvasElement,
  signal: AbortSignal
): Promise<PageImage> => {
  signal.throwIfAborted()
  try {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    signal.throwIfAborted()
    if (!blob) {
      throw new DocumentPreviewError('format')
    }
    const url = URL.createObjectURL(blob)
    return {
      url,
      width: canvas.width,
      height: canvas.height,
      dispose: () => URL.revokeObjectURL(url),
    }
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}

const androidPDF = async (file: Blob, signal: AbortSignal): Promise<PagedDocument> => {
  const { id } = await AndroidPdf.create({ size: file.size })
  const close = () => {
    void AndroidPdf.close({ id }).catch(() => {})
  }
  try {
    for (let start = 0; start < file.size; start += 256 * 1024) {
      signal.throwIfAborted()
      await AndroidPdf.write({ id, data: await blobBase64(file.slice(start, start + 256 * 1024)) })
    }
    const opened = await AndroidPdf.open({ id })
    signal.throwIfAborted()
    if (opened.pages < 1) {
      throw new DocumentPreviewError('format')
    }
    return {
      mode: 'pdf',
      count: opened.pages,
      render: async (index, width, pageSignal) => {
        const page = await AndroidPdf.page({ id, index, width })
        pageSignal.throwIfAborted()
        if (!page.url) {
          throw new DocumentPreviewError('format')
        }
        return { ...page, url: Capacitor.convertFileSrc(page.url) }
      },
      text: opened.searchable
        ? async (index) => (await AndroidPdf.page({ id, index, text: true })).text ?? ''
        : undefined,
      close,
    }
  } catch (error) {
    close()
    if ((error as { code?: string })?.code === 'preview-password') {
      throw new DocumentPreviewError('password')
    }
    if ((error as { code?: string })?.code === 'preview-storage') {
      throw new DocumentPreviewError('storage')
    }
    throw error
  }
}

const webPDF = async (
  file: Blob,
  mode: 'pdf' | 'office',
  signal: AbortSignal
): Promise<PagedDocument> => {
  const assets = new URL('static/pdfjs/', document.baseURI)
  const pdfjs = await loadPdfRuntime(assets)
  signal.throwIfAborted()
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', assets).href
  const loading = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: new URL('cmaps/', assets).href,
    standardFontDataUrl: new URL('standard_fonts/', assets).href,
    wasmUrl: new URL('wasm/', assets).href,
    iccUrl: new URL('iccs/', assets).href,
    enableXfa: false,
    maxImageSize: 16_000_000,
  })
  const close = () => {
    void loading.destroy().catch(() => {})
  }
  signal.addEventListener('abort', close, { once: true })
  try {
    const pdf = await loading.promise
    signal.throwIfAborted()
    return {
      mode,
      count: pdf.numPages,
      render: async (index, width, pageSignal) => {
        const page = await pdf.getPage(index + 1)
        pageSignal.throwIfAborted()
        const initial = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({
          scale: Math.min(width / initial.width, 2200 / initial.height),
        })
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(viewport.width))
        canvas.height = Math.max(1, Math.round(viewport.height))
        const task = page.render({ canvas, viewport, background: '#ffffff' })
        const cancel = () => task.cancel()
        pageSignal.addEventListener('abort', cancel, { once: true })
        try {
          await task.promise
          return await imageFromCanvas(canvas, pageSignal)
        } finally {
          pageSignal.removeEventListener('abort', cancel)
          canvas.width = 0
          canvas.height = 0
          page.cleanup()
        }
      },
      text: async (index) => {
        const page = await pdf.getPage(index + 1)
        const content = await page.getTextContent()
        return content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .slice(0, 16_000)
      },
      close,
    }
  } catch (error) {
    close()
    if ((error as Error)?.name === 'PasswordException') {
      throw new DocumentPreviewError('password')
    }
    throw error
  } finally {
    signal.removeEventListener('abort', close)
  }
}

/** Read only bounded OOXML archives. Related resources are resolved to package parts. */
export const readOfficeParts = async (blob: Blob, signal: AbortSignal) => {
  const file = new File([blob], 'preview.zip')
  const size = await archiveSize(file)
  if (size.total > 4096 || size.expandedBytes > 96 * 1024 * 1024) {
    throw new DocumentPreviewError('limit')
  }
  const parts: Record<string, Uint8Array> = Object.create(null)
  let decoded = 0
  for await (const entry of readArchive(file)) {
    signal.throwIfAborted()
    if (entry.size > 20 * 1024 * 1024 || decoded + entry.size > 96 * 1024 * 1024) {
      throw new DocumentPreviewError('limit')
    }
    if (/(?:^|\/)(?:activeX|embeddings)(?:\/|$)|vbaProject\.bin$/i.test(entry.path)) {
      await skipEntry(entry)
      continue
    }
    const data = await readEntry(entry)
    decoded += data.size
    if (/\.(?:xml|rels)$/i.test(entry.path)) {
      const xml = await data.text()
      if (/<!\s*(?:doctype|entity)\b/i.test(xml)) {
        throw new DocumentPreviewError('format')
      }
      if (entry.path.endsWith('.rels')) {
        const doc = new DOMParser().parseFromString(xml, 'application/xml')
        if (doc.getElementsByTagName('parsererror').length) {
          throw new DocumentPreviewError('format')
        }
        for (const relationship of Array.from(doc.documentElement.children)) {
          const target = relationship.getAttribute('Target') ?? ''
          if (
            relationship.getAttribute('TargetMode')?.toLowerCase() === 'external' ||
            /^(?:[a-z][a-z0-9+.-]*:|\/\/|\\)/i.test(target)
          ) {
            relationship.remove()
          }
        }
        parts[entry.path] = strToU8(new XMLSerializer().serializeToString(doc))
        continue
      }
    }
    parts[entry.path] = new Uint8Array(await data.arrayBuffer())
  }
  return parts
}

export const readLaidOutFile = async (
  kind: 'pdf' | 'docx' | 'pptx',
  blob: Blob,
  signal: AbortSignal
): Promise<LaidOutDocument> => {
  if (!blob.size || blob.size > documentPreviewLimit(kind)) {
    throw new DocumentPreviewError('limit')
  }
  if (kind === 'pdf') {
    const native = Capacitor.getPlatform() === 'android'
    return {
      kind: 'pages',
      document: await (native ? androidPDF(blob, signal) : webPDF(blob, 'pdf', signal)),
    }
  }
  const parts = await readOfficeParts(blob, signal)
  signal.throwIfAborted()
  if (window.freeseekOfficePreview || kind === 'docx') {
    const bytes = zipSync(parts, { level: 0 })
    if (window.freeseekOfficePreview && bytes.byteLength <= 48 * 1024 * 1024) {
      try {
        const pdf = await window.freeseekOfficePreview({ kind, bytes })
        signal.throwIfAborted()
        if (pdf?.byteLength) {
          return {
            kind: 'pages',
            document: await webPDF(new Blob([Uint8Array.from(pdf)]), 'office', signal),
          }
        }
      } catch (error) {
        signal.throwIfAborted()
        logEvent('chat', 'task.office-preview.fallback', { kind, ...diagnosticError(error) })
      }
    }
    if (kind === 'docx') {
      return { kind: 'word-layout', document: new Blob([bytes]) }
    }
  }
  const { PptxRenderer } = await import('pptx-browser')
  const deck = new PptxRenderer()
  try {
    await deck.load(new ArrayBuffer(0), undefined, { files: parts, remoteFonts: false })
    signal.throwIfAborted()
    if (deck.slideCount < 1) {
      throw new DocumentPreviewError('format')
    }
    return {
      kind: 'pages',
      document: {
        mode: 'slides',
        count: deck.slideCount,
        render: async (index, width, pageSignal) => {
          const canvas = window.document.createElement('canvas')
          const { cx, cy } = deck.slideSize
          await deck.renderSlide(
            index,
            canvas,
            Math.max(100, Math.floor(Math.min(width, (2200 * cx) / cy)))
          )
          return imageFromCanvas(canvas, pageSignal)
        },
        text: (index) => deck.extractText(index),
        close: () => deck.destroy(),
      },
    }
  } catch (error) {
    deck.destroy()
    throw error
  }
}
