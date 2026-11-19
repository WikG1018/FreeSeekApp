import { readMessageEvent } from '../../api/parseEvent.js'
import type { MessageUsage } from '../../api/types.js'
import type { FileAttachment, Message, ReplyBlock, Session } from '../types.js'
import { fail } from './errors.js'
import { isTranslationKey, type TranslationMessage } from '../../../i18n/index.js'
import { MAX_SUMMARY_CHARS } from '../contextCompression.js'
import { validModel } from '../../providers.js'
import { isReasoningAdapter, isReasoningLevel } from '../../reasoning.js'

const invalid = (): never => fail('backupIncomplete')
export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid()
export const string = (value: unknown): string => (typeof value === 'string' ? value : invalid())
export const id = (value: unknown): string => {
  const text = string(value)
  return text && text.length <= 512 && !text.includes('\0') ? text : invalid()
}
const boolean = (value: unknown): boolean => (typeof value === 'boolean' ? value : invalid())
export const number = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : invalid()
export const list = <T>(value: unknown, read: (item: unknown) => T): T[] =>
  Array.isArray(value) ? value.map(read) : invalid()
const optional = <T>(value: unknown, read: (item: unknown) => T): T | undefined =>
  value === undefined ? undefined : read(value)
const nullableString = (value: unknown) => (value === null ? null : string(value))

const usage = (value: unknown): MessageUsage => {
  const item = record(value)
  const tools = item.server_tool_use === undefined ? undefined : record(item.server_tool_use)
  return {
    input_tokens: number(item.input_tokens),
    cache_creation_input_tokens: number(item.cache_creation_input_tokens),
    cache_read_input_tokens: number(item.cache_read_input_tokens),
    output_tokens: number(item.output_tokens),
    standalone_search_requests: optional(item.standalone_search_requests, number),
    ...(tools
      ? {
          server_tool_use: {
            web_search_requests: number(tools.web_search_requests),
            ...Object.fromEntries(
              ['tool_search', 'tool_fetch', 'tool_image_search']
                .filter((key) => tools[key] !== undefined)
                .map((key) => [key, number(tools[key])])
            ),
          },
        }
      : {}),
  }
}

const attachment = (value: unknown): FileAttachment => {
  const file = record(value)
  return {
    id: id(file.id),
    serverId: nullableString(file.serverId),
    name: string(file.name),
    size: number(file.size),
    isImage: boolean(file.isImage),
    mimeType: string(file.mimeType),
  }
}

/** 原生备份也可能来自别人，只接收可安全展示与回传的内容块。 */
const block = (value: unknown): ReplyBlock => {
  const item = record(value)
  const event = readMessageEvent({ type: 'content_block_start', index: 0, content_block: item })
  if (event?.type !== 'content_block_start' || event.content_block.type === 'tool_use') {
    return invalid()
  }
  const checkUrls = (input: unknown): void => {
    if (Array.isArray(input)) {
      input.forEach(checkUrls)
    } else if (input !== null && typeof input === 'object') {
      for (const [key, child] of Object.entries(input)) {
        if (['url', 'site_icon', 'image_url'].includes(key) && child) {
          try {
            if (!['https:', 'http:'].includes(new URL(string(child)).protocol)) {
              invalid()
            }
          } catch {
            invalid()
          }
        } else {
          checkUrls(child)
        }
      }
    }
  }
  checkUrls(event.content_block)
  if (event.content_block.type === 'thinking') {
    return {
      ...event.content_block,
      startedAt: optional(item.startedAt, number),
      endedAt: optional(item.endedAt, number),
      elapsedSeconds: optional(item.elapsedSeconds, number),
    }
  }
  if (event.content_block.type === 'text') {
    return { ...event.content_block, isTemplate: optional(item.isTemplate, boolean) }
  }
  return event.content_block
}

const message = (value: unknown): Message => {
  const item = record(value)
  const branch = {
    parentId: optional(item.parentId, (value) => (value === null ? null : id(value))),
    selectedChildId: optional(item.selectedChildId, id),
  }
  const base = { id: id(item.id), createdAt: number(item.createdAt), ...branch }
  if (item.role === 'user') {
    return {
      ...base,
      role: 'user',
      content: string(item.content),
      files: list(item.files, attachment),
    }
  }
  if (
    item.role !== 'assistant' ||
    !['pending', 'streaming', 'done', 'stopped', 'error'].includes(string(item.status)) ||
    (item.model !== null && !validModel(item.model))
  ) {
    return invalid()
  }
  const error = item.error === undefined ? undefined : record(item.error)
  let localMessage: TranslationMessage | undefined
  if (error?.localMessage !== undefined) {
    const local = record(error.localMessage)
    if (typeof local.key === 'string' && isTranslationKey(local.key)) {
      const params = local.params === undefined ? undefined : record(local.params)
      if (
        params &&
        Object.values(params).some(
          (value) => typeof value !== 'string' && typeof value !== 'number'
        )
      ) {
        invalid()
      }
      localMessage = {
        key: local.key,
        params: params as Record<string, string | number> | undefined,
      }
    }
  }
  if (
    error &&
    !['http', 'stream', 'network', 'interrupted', 'protocol', 'upload'].includes(string(error.kind))
  ) {
    return invalid()
  }
  if (
    item.stopReason !== undefined &&
    !['end_turn', 'max_tokens', 'tool_use', 'refusal'].includes(string(item.stopReason))
  ) {
    return invalid()
  }
  return {
    ...base,
    role: 'assistant',
    model: item.model as string | null,
    responseModel: optional(item.responseModel, (value) => (validModel(value) ? value : invalid())),
    connection: optional(item.connection, (value) => {
      const ref = record(value),
        providerId = id(ref.providerId)
      if (providerId !== 'deepseek' && !/^custom-[\w-]+$/.test(providerId)) {
        return invalid()
      }
      return { providerId, revision: optional(ref.revision, id) }
    }),
    systemPrompt: optional(item.systemPrompt, string),
    status: item.status as 'pending' | 'streaming' | 'done' | 'stopped' | 'error',
    prefix: boolean(item.prefix),
    blocks: list(item.blocks, block),
    thinking: optional(item.thinking, boolean),
    reasoning: optional(item.reasoning, (value) => {
      const { adapter, level } = record(value)
      return isReasoningAdapter(adapter) && isReasoningLevel(level) ? { adapter, level } : invalid()
    }),
    search: optional(item.search, boolean),
    latestReminder: optional(item.latestReminder, string),
    contextWarnings: optional(item.contextWarnings, (value) =>
      list(value, (raw) => {
        const warning = record(raw),
          key = string(warning.key)
        if (!isTranslationKey(key)) {
          return invalid()
        }
        const params = warning.params === undefined ? undefined : record(warning.params)
        if (
          params &&
          Object.values(params).some(
            (value) => typeof value !== 'string' && typeof value !== 'number'
          )
        ) {
          return invalid()
        }
        return { key, params: params as Record<string, string | number> | undefined }
      })
    ),
    stopReason: item.stopReason as 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal' | undefined,
    ...(item.stopDetails === undefined
      ? {}
      : {
          stopDetails: {
            type: 'refusal' as const,
            category: null,
            explanation: null,
          },
        }),
    usage: optional(item.usage, usage),
    usageHistory: optional(item.usageHistory, (value) =>
      list(value, (raw) => {
        const entry = record(raw)
        return {
          createdAt: number(entry.createdAt),
          usage: usage(entry.usage),
          model: optional(entry.model, (value) => (validModel(value) ? value : invalid())),
        }
      })
    ),
    ...(error
      ? {
          error: {
            kind: error.kind as
              | 'http'
              | 'stream'
              | 'network'
              | 'interrupted'
              | 'protocol'
              | 'upload',
            message: string(error.message),
            status: optional(error.status, number),
            retryable: optional(error.retryable, boolean),
            localMessage,
          },
        }
      : {}),
  }
}

const contextSummary = (value: unknown) => {
  const raw = record(value),
    text = string(raw.text),
    coveredRounds = number(raw.coveredRounds)
  const signature = string(raw.signature)
  if (
    !text.trim() ||
    text.length > MAX_SUMMARY_CHARS ||
    !Number.isSafeInteger(coveredRounds) ||
    coveredRounds < 1 ||
    !/^[a-z0-9]{1,7}-[a-z0-9]{1,7}$/.test(signature)
  ) {
    return invalid()
  }
  const historyEstimate = optional(raw.historyEstimate, (value) => {
    const estimate = record(value)
    return { before: number(estimate.before), after: number(estimate.after) }
  })
  return { text, coveredRounds, signature, updatedAt: number(raw.updatedAt), historyEstimate }
}

export const readNativeSession = (value: unknown): Session => {
  const item = record(value)
  const messages = list(item.messages, message)
  const byId = new Map(messages.map((message) => [message.id, message]))
  if (byId.size !== messages.length) {
    invalid()
  }
  const rootMessageId = optional(item.rootMessageId, (value) => (value === null ? null : id(value)))
  if (rootMessageId !== undefined) {
    if (
      rootMessageId !== null &&
      (!byId.has(rootMessageId) || byId.get(rootMessageId)?.parentId != null)
    ) {
      invalid()
    }
    const checked = new Set<string>()
    for (const current of messages) {
      if (
        current.parentId == null
          ? current.role !== 'user'
          : !byId.has(current.parentId) || byId.get(current.parentId)?.role === current.role
      ) {
        invalid()
      }
      if (current.selectedChildId && byId.get(current.selectedChildId)?.parentId !== current.id) {
        invalid()
      }
      const visiting = new Set<string>()
      let node: Message | undefined = current
      while (node && !checked.has(node.id)) {
        if (visiting.has(node.id)) {
          invalid()
        }
        visiting.add(node.id)
        node = node.parentId ? byId.get(node.parentId) : undefined
      }
      visiting.forEach((id) => checked.add(id))
    }
  }
  const inherited =
    item.inherited == null ? (item.inherited as null | undefined) : record(item.inherited)
  const persona = item.persona == null ? (item.persona as null | undefined) : record(item.persona)
  return {
    id: id(item.id),
    title: string(item.title),
    ...(item.pinned === undefined ? {} : { pinned: boolean(item.pinned) }),
    createdAt: number(item.createdAt),
    updatedAt: number(item.updatedAt),
    messages,
    contextSummary: optional(item.contextSummary, contextSummary),
    compressionPromptShown: optional(item.compressionPromptShown, boolean),
    compressionUsage: optional(item.compressionUsage, (value) =>
      list(value, (raw) => {
        const entry = record(raw),
          ref = record(entry.connection),
          providerId = id(ref.providerId)
        if (providerId !== 'deepseek' && !/^custom-[\w-]+$/.test(providerId)) {
          return invalid()
        }
        return {
          usage: usage(entry.usage),
          createdAt: number(entry.createdAt),
          model: validModel(entry.model) ? entry.model : invalid(),
          connection: { providerId, revision: optional(ref.revision, id) },
        }
      })
    ),
    rootMessageId,
    inherited: inherited
      ? {
          fromId: id(inherited.fromId),
          fromTitle: string(inherited.fromTitle),
          contextSummary: optional(inherited.contextSummary, contextSummary),
          messages: list(inherited.messages, message),
        }
      : inherited,
    persona: persona ? { name: string(persona.name), prompt: string(persona.prompt) } : persona,
  }
}
