import { ApiError } from './errorTypes.js'
import { getContextRounds, getReplyText } from '../chat/reply.js'
import type { AssistantMessage, Message, UserMessage, FileAttachment } from '../chat/types.js'
import type { ProviderModelParameters } from '../providers.js'
import type { MessageParam } from './types.js'
import { loadFile } from '../chat/db.js'
import { readArchive, readEntry, skipEntry } from '../chat/history/zipReader.js'
import { normalizeImageFile } from '../image.js'

export type ProviderPart =
  | { type: 'text'; text: string }
  | { type: 'image' | 'pdf'; name: string; mime: string; data: string }
export type ProviderMessage = { role: 'user' | 'assistant'; content: ProviderPart[] }
export type ProviderConversation = {
  history: Message[]
  question: UserMessage
  prefix?: AssistantMessage
  inherited?: { messages: Message[] } | null
}
const base64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

export const wordText = (document: Document, paragraph: Element, namespace: string) => {
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => {
      const element = node as Element
      if (element.namespaceURI !== namespace) {
        return NodeFilter.FILTER_SKIP
      }
      if (['del', 'moveFrom'].includes(element.localName)) {
        return NodeFilter.FILTER_REJECT
      }
      return ['t', 'tab', 'br', 'cr'].includes(element.localName)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP
    },
  })
  const pieces: string[] = []
  let node: Node | null
  while ((node = walker.nextNode())) {
    const name = (node as Element).localName
    pieces.push(name === 't' ? (node.textContent ?? '') : name === 'tab' ? '\t' : '\n')
  }
  return pieces.join('')
}

export const docxText = async (blob: Blob, signal: AbortSignal, plainOnly = false) => {
  let result: string | undefined,
    total = 0
  for await (const entry of readArchive(new File([blob], 'document.docx'))) {
    signal.throwIfAborted()
    total += entry.size
    if (total > 64 * 1024 * 1024 || entry.size > 16 * 1024 * 1024) {
      throw new ApiError('protocol', { key: 'providerFileTooLarge' })
    }
    if (
      plainOnly &&
      /^word\/(?:media\/|embeddings\/|(?:footnotes|endnotes|header\d+|footer\d+)\.xml$)/i.test(
        entry.path
      )
    ) {
      return undefined
    }
    if (entry.path === 'word/document.xml') {
      if (entry.size > 8 * 1024 * 1024) {
        throw new ApiError('protocol', { key: 'providerFileTooLarge' })
      }
      const text = await (await readEntry(entry)).text()
      if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) {
        throw new ApiError('protocol', { key: 'providerFileUnsupported' })
      }
      const document = new DOMParser().parseFromString(text, 'application/xml')
      const namespace = document.documentElement.namespaceURI ?? ''
      if (
        ![
          'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
          'http://purl.oclc.org/ooxml/wordprocessingml/main',
        ].includes(namespace) ||
        document.getElementsByTagName('parsererror').length
      ) {
        throw new ApiError('protocol', { key: 'providerFileUnsupported' })
      }
      if (
        plainOnly &&
        ['drawing', 'object', 'pict', 'oMath', 'altChunk', 'tbl'].some(
          (name) => document.getElementsByTagNameNS('*', name).length > 0
        )
      ) {
        return undefined
      }
      const body = document.getElementsByTagNameNS(namespace, 'body')[0]
      if (!body) {
        throw new ApiError('protocol', { key: 'providerFileUnsupported' })
      }
      result = Array.from(body.getElementsByTagNameNS(namespace, 'p'))
        .filter((paragraph) => !paragraph.closest('del, moveFrom'))
        .map((paragraph) => wordText(document, paragraph, namespace))
        .join('\n\n')
    } else {
      await skipEntry(entry)
    }
  }
  if (!result?.trim()) {
    throw new ApiError('protocol', { key: 'providerFileUnsupported' })
  }
  return result
}

const textExtension =
  /\.(?:txt|md|markdown|csv|json|jsonl|ya?ml|xml|html?|log|js|ts|jsx|tsx|py|java|c|cpp|h|css|sql|sh|toml|ini)$/i

export const isLocalOfficeText = (file: FileAttachment) =>
  !file.isImage &&
  (file.mimeType.startsWith('text/') || textExtension.test(file.name) || /\.docx$/i.test(file.name))

export const documentTextFallback = async (
  file: FileAttachment,
  blob: Blob,
  signal: AbortSignal,
  plainOnly = true
): Promise<string | undefined> => {
  if (file.isImage || blob.size > 4 * 1024 * 1024) {
    return undefined
  }
  const raw = /\.docx$/i.test(file.name)
    ? await docxText(blob, signal, plainOnly)
    : file.mimeType.startsWith('text/') || textExtension.test(file.name)
      ? await blob.text()
      : undefined
  signal.throwIfAborted()
  if (!raw?.trim() || raw.includes('\0') || raw.includes('\uFFFD')) {
    return undefined
  }
  const name = file.name.replace(/[\r\n]/g, ' ')
  return '[Document: ' + name + ']\n' + raw
}

export const inlineDocuments = (messages: MessageParam[], texts: ReadonlyMap<string, string>) =>
  messages.map((message): MessageParam => {
    if (message.role !== 'user' || !Array.isArray(message.content)) {
      return message
    }
    return {
      ...message,
      content: message.content.map((part) => {
        const text = part.type === 'document' ? texts.get(part.source.file_id) : undefined
        return text === undefined ? part : { type: 'text', text }
      }),
    }
  })

/** 第三方附件只从本机原件生成内容，从不提交到 DeepSeek Files API。 */
export const prepareProviderMessages = async (
  parameters: Pick<ProviderModelParameters, 'vision' | 'pdf'>,
  conversation: ProviderConversation,
  signal: AbortSignal,
  getOriginal: (id: string) => Promise<Blob | undefined> = loadFile,
  onMissingHistory?: (count: number) => void
): Promise<ProviderMessage[]> => {
  let inlineBytes = 0
  const cache = new Map<string, ProviderPart>()
  const missingHistory = new Set<string>()
  const attachment = async (file: FileAttachment, historical: boolean) => {
    signal.throwIfAborted()
    const cached = cache.get(file.id)
    if (cached) {
      return cached
    }
    if (historical && missingHistory.has(file.id)) {
      return undefined
    }
    const blob = await getOriginal(file.id)
    if (!blob) {
      signal.throwIfAborted()
      if (!historical) {
        throw new ApiError('protocol', { key: 'providerCurrentOriginalMissing' })
      }
      missingHistory.add(file.id)
      return undefined
    }
    if (blob.size > 16 * 1024 * 1024) {
      throw new ApiError('protocol', { key: 'providerFileTooLarge' })
    }
    let part: ProviderPart
    const ext = file.name.split('.').at(-1)?.toLowerCase() ?? ''
    if (file.isImage) {
      if (!parameters.vision) {
        throw new ApiError('protocol', { key: 'providerVisionDisabled' })
      }
      const normalized = await normalizeImageFile(
        new File([blob], file.name, { type: file.mimeType || blob.type }),
        signal
      )
      part = {
        type: 'image',
        name: file.name,
        mime: normalized.type,
        data: await base64(normalized),
      }
    } else if (ext === 'pdf' || file.mimeType === 'application/pdf') {
      if (!parameters.pdf) {
        throw new ApiError('protocol', { key: 'providerPdfDisabled' })
      }
      part = { type: 'pdf', name: file.name, mime: 'application/pdf', data: await base64(blob) }
    } else {
      const text =
        ext === 'docx'
          ? ((await docxText(blob, signal)) ?? null)
          : file.mimeType.startsWith('text/') || textExtension.test(file.name)
            ? await blob.text()
            : null
      if (text === null || text.includes('\0')) {
        throw new ApiError('protocol', { key: 'providerFileUnsupported' })
      }
      if (text.length > 4 * 1024 * 1024) {
        throw new ApiError('protocol', { key: 'providerFileTooLarge' })
      }
      part = { type: 'text', text: `\n[${file.name}]\n${text}\n` }
    }
    inlineBytes += part.type === 'text' ? new Blob([part.text]).size : part.data.length
    if (inlineBytes > 24 * 1024 * 1024) {
      throw new ApiError('protocol', { key: 'providerFileTooLarge' })
    }
    cache.set(file.id, part)
    return part
  }
  const user = async (message: UserMessage, historical: boolean): Promise<ProviderMessage> => {
    const content: ProviderPart[] = []
    let hasUnavailableFile = false
    for (const file of message.files) {
      const part = await attachment(file, historical)
      if (part) {
        content.push(part)
      } else {
        hasUnavailableFile = true
      }
    }
    if (hasUnavailableFile) {
      content.push({ type: 'text', text: '[Earlier attachment unavailable on this device.]' })
    }
    if (message.content) {
      content.push({ type: 'text', text: message.content })
    }
    return { role: 'user', content }
  }
  const result: ProviderMessage[] = []
  for (const [question, reply] of [
    ...getContextRounds(conversation.inherited?.messages ?? []),
    ...getContextRounds(conversation.history),
  ]) {
    result.push(await user(question, true), {
      role: 'assistant',
      content: [{ type: 'text', text: getReplyText(reply) }],
    })
  }
  result.push(await user(conversation.question, false))
  if (conversation.prefix && getReplyText(conversation.prefix).trim()) {
    result.push(
      { role: 'assistant', content: [{ type: 'text', text: getReplyText(conversation.prefix) }] },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Continue the previous answer exactly where it stopped, without repeating its existing text.',
          },
        ],
      }
    )
  }
  signal.throwIfAborted()
  if (missingHistory.size > 0) {
    onMissingHistory?.(missingHistory.size)
  }
  return result
}
