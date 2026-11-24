import { readMessageEvent } from '../../api/parseEvent.js'
import type { MessageUsage } from '../../api/types.js'
import type { FileAttachment, Message, ReplyBlock, Session } from '../types.js'
import {
  MAX_ROLE_ALIASES,
  MAX_ROLE_NAME,
  MAX_ROLE_TEXT,
  MAX_ROLES,
  type VoiceRole,
} from '../../speech/roleMarkers.js'
import { fail } from './errors.js'
import { isTranslationKey, type TranslationMessage } from '../../../i18n/index.js'
import { MAX_SUMMARY_CHARS } from '../contextCompression.js'
import { validModel } from '../../providers.js'
import { isReasoningAdapter, isReasoningLevel } from '../../reasoning.js'
import {
  goalBudgets,
  isAgentBudgetMinutes,
  isAgentRunMode,
  type AgentTaskRun,
} from '../../tasks/runState.js'
import {
  MAX_BROWSER_CHECKPOINT_BYTES,
  MAX_WEB_CHECKPOINT_BYTES,
  type TaskEvidence,
  type TaskCachedBrowserPage,
  type TaskReadCheckpoint,
} from '../../tasks/evidence.js'
import type { TaskProgress, TaskPlanStep, TaskStep } from '../../tasks/tools.js'
import { taskFileKind, taskFileMime } from '../../tasks/artifacts.js'
import { validateProject } from '../../tasks/projectFiles.js'
import { isTaskWebError, publicWebUrl } from '../../tasks/publicWeb.js'

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
    ...(item.cache_counts === null && { cache_counts: null }),
    ...(item.cache_counts !== null &&
      item.cache_counts !== undefined && {
        cache_counts: {
          hit: number(record(item.cache_counts).hit),
          input: number(record(item.cache_counts).input),
        },
      }),
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

const agentStatuses = [
  'planning',
  'awaiting-review',
  'awaiting-input',
  'running',
  'paused',
  'blocked',
  'partial',
  'completed',
  'stopped',
  'failed',
] as const
const agentReasons = [
  'budget-time',
  'budget-requests',
  'context-limit',
  'output-limit',
  'tools-unavailable',
  'provider-error',
  'source-failed',
  'waiting-browser',
  'waiting-foreground',
  'criteria-unmet',
  'no-progress',
  'interrupted',
  'storage',
  'notification-permission',
  'host-unavailable',
  'checkpoint-missing',
  'host-busy',
  'request-unconfirmed',
  'tool-unconfirmed',
  'provider-rate-limit',
  'provider-timeout',
  'connection-changed',
  'system-timeout',
  'user',
] as const

const readAgentRun = (value: unknown): AgentTaskRun => {
  const raw = record(value)
  const status = agentStatuses.find((entry) => entry === raw.status)
  if (!status || !isAgentRunMode(raw.mode) || !isAgentBudgetMinutes(raw.budgetMinutes)) {
    return invalid()
  }
  const criteria = list(raw.criteria, (entry) => {
    const label = string(entry)
    return label.trim() && label.length <= 240 ? label : invalid()
  })
  if (criteria.length > 8) {
    return invalid()
  }
  const met = [...new Set(list(raw.met, number))]
  if (met.some((entry) => !Number.isInteger(entry) || entry < 1 || entry > criteria.length)) {
    return invalid()
  }
  const live = status === 'running' || status === 'planning'
  const question = optional(raw.question, string)
  if (
    status === 'awaiting-input' &&
    (raw.mode !== 'plan' || !question?.trim() || question.length > 400)
  ) {
    return invalid()
  }
  const approved = optional(raw.approvedRevision, number)
  const revision = number(raw.revision)
  if (approved !== undefined && approved !== revision) {
    return invalid()
  }
  return {
    id: id(raw.id),
    status: live ? 'paused' : status,
    reason: live ? 'interrupted' : agentReasons.find((entry) => entry === raw.reason),
    mode: raw.mode,
    revision,
    approvedRevision: approved,
    question: question?.slice(0, 400),
    criteria,
    met,
    budgetMinutes: raw.budgetMinutes,
    budgetRequests: goalBudgets[raw.budgetMinutes],
    requestLimit: optional(raw.requestLimit, (entry) => {
      const limit = number(entry)
      return Number.isSafeInteger(limit) && limit > 0 ? limit : invalid()
    }),
    segmentRequests: number(raw.segmentRequests),
    totalRequests: number(raw.totalRequests),
    startedAt: number(raw.startedAt),
    elapsedMs: number(raw.elapsedMs),
    elapsedBeforeResume: optional(raw.elapsedBeforeResume, number),
    retryAt: optional(raw.retryAt, number),
    requestInFlight: optional(raw.requestInFlight, boolean),
    background: false,
  }
}

const readTaskEvidence = (value: unknown): TaskEvidence => {
  const found = record(value)
  const kind = (['web', 'github', 'browser', 'attachment'] as const).find(
    (entry) => entry === found.kind
  )
  if (!kind) {
    return invalid()
  }
  const range = optional(found.range, (value) => {
    const raw = record(value)
    const start = number(raw.start),
      end = number(raw.end)
    const unit: 'lines' | 'characters' | undefined =
      raw.unit === 'lines' ? 'lines' : raw.unit === 'characters' ? 'characters' : undefined
    return unit && start <= end ? { start, end, unit } : invalid()
  })
  return {
    sourceId: string(found.sourceId).slice(0, 4_096),
    title: string(found.title).slice(0, 300),
    kind,
    range,
    url: publicWebUrl(found.url)?.href,
    revision: optional(found.revision, string)?.slice(0, 200),
    path: optional(found.path, string)?.slice(0, 512),
    retrievedAt: optional(found.retrievedAt, number),
    downloadedBytes: optional(found.downloadedBytes, number),
    availableChars: optional(found.availableChars, number),
    deliveredChars: optional(found.deliveredChars, number),
    excerpt: optional(found.excerpt, string)?.slice(0, 1200),
    characterRange: optional(found.characterRange, (value) => {
      const span = record(value)
      return { start: number(span.start), end: number(span.end) }
    }),
    nextOffset: optional(found.nextOffset, number),
    nextCursor: optional(found.nextCursor, string)?.slice(0, 2_048),
    partial: boolean(found.partial),
    sourceTruncated: optional(found.sourceTruncated, boolean),
  }
}

const readTaskCheckpoint = (value: unknown): TaskReadCheckpoint | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const raw = value as Record<string, unknown>
  if (raw.version !== 1) {
    return undefined
  }
  try {
    const bytes = (entry: unknown) => new TextEncoder().encode(JSON.stringify(entry)).byteLength
    const web = optional(raw.web, (entry) => {
      if (bytes(entry) > MAX_WEB_CHECKPOINT_BYTES + 16_384) {
        return undefined
      }
      const item = record(entry)
      return {
        pins: list(item.pins, (pair): [string, string] => {
          if (
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            typeof pair[0] !== 'string' ||
            pair[0].length > 512 ||
            typeof pair[1] !== 'string' ||
            !/^[a-f0-9]{40}$/i.test(pair[1])
          ) {
            return invalid()
          }
          return [pair[0], pair[1]]
        }).slice(0, 64),
        sources: list(item.sources, (value) => {
          const source = record(value)
          return {
            key: string(source.key).slice(0, 4_096),
            evidence: readTaskEvidence(source.evidence),
            text: string(source.text).slice(0, MAX_WEB_CHECKPOINT_BYTES),
            links: list(source.links, (value) => publicWebUrl(value)?.href)
              .filter((url): url is string => Boolean(url))
              .slice(0, 100),
            nextCursor: optional(source.nextCursor, string)?.slice(0, 2_048),
          }
        }).slice(0, 100),
        retryAt: optional(item.retryAt, number),
      }
    })
    const browser = optional(raw.browser, (entry) => {
      if (bytes(entry) > MAX_BROWSER_CHECKPOINT_BYTES + 16_384) {
        return undefined
      }
      const item = record(entry)
      return {
        pages: list(item.pages, (value): TaskCachedBrowserPage => {
          const page = record(value)
          const notice = page.renderNotice
          return {
            url: publicWebUrl(page.url)?.href ?? invalid(),
            requestedUrl: publicWebUrl(page.requestedUrl)?.href,
            title: string(page.title).slice(0, 300),
            text: string(page.text).slice(0, MAX_BROWSER_CHECKPOINT_BYTES),
            links: list(page.links, (value) => {
              const link = record(value)
              return {
                label: string(link.label).slice(0, 300),
                url: publicWebUrl(link.url)?.href ?? invalid(),
              }
            }).slice(0, 100),
            headings: list(page.headings, string)
              .map((heading) => heading.slice(0, 300))
              .slice(0, 60),
            bytes: optional(page.bytes, number),
            retrievedAt: optional(page.retrievedAt, number),
            sourceTruncated: boolean(page.sourceTruncated),
            mode: page.mode === 'rendered' ? ('rendered' as const) : ('static' as const),
            renderNotice:
              notice === 'rendering-unavailable' || notice === 'rendering-timeout'
                ? notice
                : undefined,
          }
        }).slice(0, 24),
        currentUrl: publicWebUrl(item.currentUrl)?.href,
        currentIndex: optional(item.currentIndex, number),
        offset: number(item.offset),
      }
    })
    return { version: 1, web, browser }
  } catch {
    // Imported caches are optional. A damaged cached response must not discard a conversation.
    return undefined
  }
}

const taskProgress = (value: unknown): TaskProgress => {
  const raw = record(value)
  const plan = list(raw.plan, (item): TaskPlanStep => {
    const { label, status } = record(item)
    if (
      typeof label !== 'string' ||
      !label.trim() ||
      label.length > 120 ||
      (status !== 'todo' && status !== 'working' && status !== 'done')
    ) {
      return invalid()
    }
    return { label, status: status === 'working' ? 'todo' : status }
  })
  const steps = list(raw.steps, (item): TaskStep => {
    const step = record(item)
    const { kind, status } = step
    const file = optional(step.file, string)
    if (
      (kind !== 'read' &&
        kind !== 'search' &&
        kind !== 'web' &&
        kind !== 'github' &&
        kind !== 'browser' &&
        kind !== 'tool' &&
        kind !== 'plan' &&
        kind !== 'files' &&
        kind !== 'verification' &&
        kind !== 'calculate' &&
        kind !== 'table' &&
        kind !== 'data' &&
        kind !== 'xlsx' &&
        kind !== 'docx' &&
        kind !== 'md' &&
        kind !== 'project' &&
        kind !== 'script' &&
        kind !== 'model3d' &&
        kind !== 'delegate' &&
        kind !== 'integration') ||
      (status !== 'working' && status !== 'done' && status !== 'failed' && status !== 'stopped') ||
      (file && file.length > 140)
    ) {
      return invalid()
    }
    return {
      id: id(step.id),
      kind,
      status: status === 'working' ? 'stopped' : status,
      file,
      ...(isTaskWebError(step.failure) && { failure: step.failure }),
      source: publicWebUrl(step.source)?.href,
      blockIndex: optional(step.blockIndex, number),
      detail: optional(step.detail, string)?.slice(0, 200),
      output: optional(step.output, string)?.slice(0, 8_000),
      assertions: optional(step.assertions, number),
      elapsedMs: optional(step.elapsedMs, number),
      retryAt: optional(step.retryAt, number),
      evidence:
        step.evidence === undefined ? undefined : list(step.evidence, readTaskEvidence).slice(0, 8),
    }
  })
  const artifacts = list(raw.artifacts, (item) => {
    const file = attachment(item)
    const kind = taskFileKind(file.name)
    if (
      !kind ||
      file.mimeType !== taskFileMime[kind] ||
      file.serverId !== null ||
      file.isImage ||
      !file.name.trim() ||
      file.name.length > 90 ||
      /[\p{Cc}<>:"/\\|?*]/u.test(file.name) ||
      !Number.isSafeInteger(file.size) ||
      file.size >
        (kind === 'pdf' ? 128 : kind === 'pptx' || kind === 'docx' || kind === 'xlsx' ? 32 : 2) *
          1024 *
          1024
    ) {
      return invalid()
    }
    const raw = record(item)
    const sizeMm =
      Array.isArray(raw.sizeMm) &&
      raw.sizeMm.length === 3 &&
      raw.sizeMm.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
        ? (raw.sizeMm as [number, number, number])
        : undefined
    return {
      ...file,
      sizeMm,
      createdAt: optional(raw.createdAt, number),
      sha256:
        typeof raw.sha256 === 'string' && /^[a-f0-9]{64}$/.test(raw.sha256)
          ? raw.sha256
          : undefined,
    }
  })
  if (
    plan.length > 8 ||
    steps.length > 240 ||
    artifacts.length > 12 ||
    (raw.warning !== undefined && raw.warning !== 'limit' && raw.warning !== 'unavailable')
  ) {
    return invalid()
  }
  return {
    plan,
    steps,
    artifacts,
    warning: raw.warning,
    run: optional(raw.run, readAgentRun),
    readCheckpoint: readTaskCheckpoint(raw.readCheckpoint),
    workspaceId: optional(raw.workspaceId, id),
    project: optional(raw.project, (value) => {
      try {
        if (!Array.isArray(value) || value.length > 48) {
          return invalid()
        }
        return validateProject(
          list(value, (entry) => {
            const file = record(entry)
            return { path: string(file.path), text: string(file.text) }
          })
        )
      } catch {
        return invalid()
      }
    }),
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
    agent: optional(item.agent, (value) => {
      const agent = record(value)
      const { memory } = agent
      if (memory !== 'shared' && memory !== 'private' && memory !== 'off') {
        return invalid()
      }
      return {
        id: id(agent.id),
        name: string(agent.name),
        search: boolean(agent.search),
        attachments: boolean(agent.attachments),
        memory,
      }
    }),
    memoryUse: optional(item.memoryUse, (value) => {
      const use = record(value)
      const tokens = number(use.tokens)
      if (
        tokens > 800 ||
        !Array.isArray(use.references) ||
        !use.references.length ||
        use.references.length > 6
      ) {
        return invalid()
      }
      const references = list(use.references, (raw) => {
        const note = record(raw)
        return { id: id(note.id), revision: id(note.revision) }
      })
      return { tokens, references }
    }),
    memoryReadFailed: optional(item.memoryReadFailed, boolean),
    task: optional(item.task, taskProgress),
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
  return {
    text,
    coveredRounds,
    signature,
    updatedAt: number(raw.updatedAt),
    historyEstimate,
    ...(raw.recentOnly === undefined ? {} : { recentOnly: boolean(raw.recentOnly) }),
  }
}

const MIMO_PRESETS = ['冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean', 'mimo_default'] as const
const IMPORTANCES = ['lead', 'supporting', 'extra'] as const

const voiceRole = (value: unknown): VoiceRole => {
  const raw = record(value)
  const name = string(raw.name)
  const preset = raw.preset === undefined ? undefined : (string(raw.preset) as VoiceRole['preset'])
  const description = raw.description === undefined ? undefined : string(raw.description)
  if (
    !name.trim() ||
    name.length > MAX_ROLE_NAME ||
    (preset !== undefined && !(MIMO_PRESETS as readonly string[]).includes(preset)) ||
    (description !== undefined && description.length > MAX_ROLE_TEXT) ||
    (preset === undefined && !description?.trim())
  ) {
    return invalid()
  }
  const importance = string(raw.importance) as VoiceRole['importance']
  const source = string(raw.source) as VoiceRole['source']
  if (!(IMPORTANCES as readonly string[]).includes(importance) || (source !== 'model' && source !== 'user')) {
    return invalid()
  }
  const nature = string(raw.nature)
  if (nature.length > MAX_ROLE_TEXT) {
    return invalid()
  }
  return {
    id: id(raw.id),
    name,
    aliases: list(raw.aliases, (alias) => {
      const text = string(alias)
      return text && text.length <= MAX_ROLE_NAME ? text : invalid()
    }).slice(0, MAX_ROLE_ALIASES),
    ...(preset !== undefined && { preset }),
    ...(description !== undefined && { description }),
    nature,
    importance,
    source,
    createdAt: number(raw.createdAt),
  }
}

/** 缺省表示没有角色；存在时必须整表可读，任何一条坏了都不静默丢角色（会让声音悄悄变） */
const voiceRoles = (value: unknown): VoiceRole[] | undefined => {
  if (value === undefined) {
    return undefined
  }
  const roles = list(value, voiceRole)
  if (roles.length > MAX_ROLES) {
    return invalid()
  }
  return roles
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
    mode: optional(item.mode, (value) =>
      value === 'chat' || value === 'agent' ? value : invalid()
    ),
    agentRunMode: isAgentRunMode(item.agentRunMode) ? item.agentRunMode : undefined,
    workspaceId: optional(item.workspaceId, id),
    agent: optional(item.agent, (value) => {
      const agent = record(value)
      return { id: id(agent.id), name: string(agent.name) }
    }),
    memoryPaused: optional(item.memoryPaused, boolean),
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
          ...(inherited.voiceRoles !== undefined && { voiceRoles: voiceRoles(inherited.voiceRoles) }),
        }
      : inherited,
    persona: persona ? { name: string(persona.name), prompt: string(persona.prompt) } : persona,
    ...(item.voiceRoles !== undefined && { voiceRoles: voiceRoles(item.voiceRoles) }),
  }
}
