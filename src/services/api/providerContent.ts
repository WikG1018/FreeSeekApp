import { ApiError } from './errorTypes.js'
import { getContextRounds, getReplyText } from '../chat/reply.js'
import type { AssistantMessage, Message, UserMessage, FileAttachment } from '../chat/types.js'
import type { ProviderProfile } from '../providers.js'
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
const docxText = async (blob: Blob, signal: AbortSignal) => {
  let result: string | undefined,
    total = 0
  for await (const entry of readArchive(new File([blob], 'document.docx'))) {
    signal.throwIfAborted()
    total += entry.size
    if (total > 64 * 1024 * 1024 || entry.size > 16 * 1024 * 1024) {
      throw new ApiError('protocol', { key: 'providerFileTooLarge' })
    }
    if (entry.path === 'word/document.xml') {
      if (entry.size > 8 * 1024 * 1024) {
        throw new ApiError('protocol', { key: 'providerFileTooLarge' })
      }
      const text = await (await readEntry(entry)).text()
      const document = new DOMParser().parseFromString(text, 'application/xml')
      if (document.getElementsByTagName('parsererror').length) {
        throw new ApiError('protocol', { key: 'providerFileUnsupported' })
      }
      result = Array.from(document.getElementsByTagNameNS('*', 'p'))
        .map((p) =>
          Array.from(p.getElementsByTagNameNS('*', 't'))
            .map((t) => t.textContent ?? '')
            .join('')
        )
        .join('\n')
    } else {
      await skipEntry(entry)
    }
  }
  if (!result?.trim()) {
    throw new ApiError('protocol', { key: 'providerFileUnsupported' })
  }
  return result
}

/** 第三方附件只从本机原件生成内容，从不提交到 DeepSeek Files API。 */
export const prepareProviderMessages = async (
  profile: ProviderProfile,
  conversation: ProviderConversation,
  signal: AbortSignal,
  getOriginal: (id: string) => Promise<Blob | undefined> = loadFile
): Promise<ProviderMessage[]> => {
  let inlineBytes = 0
  const cache = new Map<string, ProviderPart>()
  const attachment = async (file: FileAttachment): Promise<ProviderPart> => {
    signal.throwIfAborted()
    const cached = cache.get(file.id)
    if (cached) {
      return cached
    }
    const blob = await getOriginal(file.id)
    if (!blob) {
      throw new ApiError('protocol', { key: 'providerOriginalMissing' })
    }
    if (blob.size > 16 * 1024 * 1024) {
      throw new ApiError('protocol', { key: 'providerFileTooLarge' })
    }
    let part: ProviderPart
    const ext = file.name.split('.').at(-1)?.toLowerCase() ?? ''
    if (file.isImage) {
      if (!profile.vision) {
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
      if (!profile.pdf) {
        throw new ApiError('protocol', { key: 'providerPdfDisabled' })
      }
      part = { type: 'pdf', name: file.name, mime: 'application/pdf', data: await base64(blob) }
    } else {
      const text =
        ext === 'docx'
          ? await docxText(blob, signal)
          : file.mimeType.startsWith('text/') ||
              /^(txt|md|markdown|csv|json|jsonl|yaml|yml|xml|html|htm|log|js|ts|jsx|tsx|py|java|c|cpp|h|css|sql|sh|toml|ini)$/.test(
                ext
              )
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
  const user = async (message: UserMessage): Promise<ProviderMessage> => {
    const content: ProviderPart[] = []
    for (const file of message.files) {
      content.push(await attachment(file))
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
    result.push(await user(question), {
      role: 'assistant',
      content: [{ type: 'text', text: getReplyText(reply) }],
    })
  }
  result.push(await user(conversation.question))
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
  return result
}
