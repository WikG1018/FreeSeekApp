import { verifyCriterion } from './verification.js'
import { analyzeTableData, calculate } from './dataOperations.js'
import {
  announceClientTools,
  collectProviderSearchTurn,
  collectNativeModelStream,
  compactTaskResults,
  continueGoalConversation,
} from '../api/toolProtocols.js'
import type { SearchOutput, ToolDefinition } from '../api/searchTool.js'
import type { ProviderProfile } from '../providers.js'
import { makeTaskFileBytes, type TaskFileKind } from './artifacts.js'
import { excerptEvidence, textExcerpt, textPosition } from './readerRange.js'
import { taskRequestLimit, type AgentTaskRun } from './runState.js'
import type { TaskReadResult } from './evidence.js'
import type { TaskArtifact, TaskPlanStep, TaskStep } from './tools.js'
import { foregroundTools } from './creatorTools.js'
import { addCacheCounts, normalizeProviderUsage } from '../api/providerUsage.js'
import type { CacheCounts, MessageUsage } from '../api/types.js'

type Json = Record<string, unknown>
type Protocol = ProviderProfile['protocol']

export type GoalInput = {
  run: AgentTaskRun
  protocol: Protocol
  body: Json
  definitions: ToolDefinition[]
  links: string[]
  files: {
    id: string
    name: string
    text: string
    sourceTruncated?: boolean
    downloadedBytes?: number
    table?: { name: string; rows: string[][] }[]
  }[]
  contextBudget?: number
}
type GoalEffect =
  | { kind: 'model'; body: Json }
  | { kind: 'public'; url: string; raw?: boolean }
  | { kind: 'save'; name: string; mimeType: string; base64: string }
type Observation = {
  status?: number
  content?: string
  type?: string
  error?: string
  url?: string
  nextPage?: string
  downloadedBytes?: number
  truncated?: boolean
  retryAt?: number
  confirmed?: boolean
  artifact?: TaskArtifact
}
type Pending = {
  token: string
  step?: TaskStep
  operation: 'model' | 'source' | 'pin' | 'write' | 'foreground'
  tool?: string
  source?: string
  args?: Json
  media?: string
}
type GoalState = {
  run: AgentTaskRun
  protocol: Protocol
  request: Json
  definitions: ToolDefinition[]
  links: string[]
  files: GoalInput['files']
  contextBudget?: number
  plan: TaskPlanStep[]
  steps: TaskStep[]
  artifacts: TaskArtifact[]
  answer: string
  blocks?: { type: 'text'; text: string }[]
  blockOffset?: number
  response?: Json
  outputs: SearchOutput[]
  pending?: Pending
  cache: Record<string, SearchOutput>
  pins: Record<string, string>
  pages?: Record<string, Observation>
  sequence: number
  idleRounds: number
  goalIdleRounds?: number
  goalWorked?: boolean
  worked: boolean
  usageEntries?: { createdAt: number; usage: MessageUsage; model?: string }[]
  usage: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    cacheCounts?: CacheCounts | null
  }
}

const asRecord = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const text = (value: unknown) => (typeof value === 'string' ? value : '')
const finite = (value: unknown) =>
  typeof value === 'number' && value >= 0 && Number.isFinite(value) ? value : 0
const failure = (message: string, reason?: TaskReadResult['reason']): TaskReadResult => ({
  text: message,
  isError: true,
  reason,
})
const publicFailure = (value: Observation): TaskReadResult => {
  const error = value.error
  switch (error) {
    case 'rate-limit':
    case 'timeout':
    case 'blocked':
    case 'dns':
    case 'redirect':
    case 'unsupported':
    case 'network':
      return { ...failure(error), failure: error }
    case 'read-budget':
      return failure(error, error)
    default: {
      const reason = value.status && value.status >= 400 ? 'http' : 'empty'
      return { ...failure(error || reason), failure: reason }
    }
  }
}
const inputOf = (source: unknown) => {
  try {
    return asRecord(typeof source === 'string' ? JSON.parse(source) : source)
  } catch {
    return {}
  }
}

const allowedTools = new Set([
  'update_task_plan',
  'verify_goal_criteria',
  'list_task_files',
  'read_selected_attachment',
  'read_web_page',
  'browse_github_repository',
  'browser_open',
  'calculate',
  'analyze_table',
  'create_spreadsheet',
  'create_document',
  'create_markdown',
  'create_data_file',
])

export const create = (json: string): string => {
  const input = JSON.parse(json) as GoalInput
  const definitions = input.definitions.filter(
    ({ name }) => allowedTools.has(name) || foregroundTools.has(name)
  )
  const request = announceClientTools(input.body, input.protocol, definitions)
  if (input.protocol !== 'gemini' && request.stream !== true) {
    request.stream = false
    delete request.stream_options
  }
  const state: GoalState = {
    ...input,
    request,
    definitions,
    run: { ...input.run, requestLimit: taskRequestLimit(input.run), background: true },
    plan: [],
    steps: [],
    artifacts: [],
    answer: '',
    blocks: [],
    outputs: [],
    cache: {},
    pins: {},
    pages: {},
    sequence: 0,
    idleRounds: 0,
    worked: false,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
  delete (state as Partial<GoalInput>).body
  return JSON.stringify(state)
}

const toolTurn = (state: GoalState) => {
  if (!state.response) {
    return undefined
  }
  const collector = collectProviderSearchTurn(state.request, state.protocol, 160_000)
  collector.read(state.response)
  return collector.finish()
}

const base64 = (bytes: Uint8Array) => {
  const digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let result = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index],
      b = bytes[index + 1] || 0,
      c = bytes[index + 2] || 0
    result +=
      digits[a >> 2] +
      digits[((a & 3) << 4) | (b >> 4)] +
      (index + 1 < bytes.length ? digits[((b & 15) << 2) | (c >> 6)] : '=') +
      (index + 2 < bytes.length ? digits[c & 63] : '=')
  }
  return result
}

const formatOf = (name: string, args: Json): TaskFileKind | undefined =>
  name === 'create_spreadsheet'
    ? 'xlsx'
    : name === 'create_document'
      ? 'docx'
      : name === 'create_markdown'
        ? 'md'
        : name === 'create_data_file' &&
            (args.format === 'csv' || args.format === 'json' || args.format === 'txt')
          ? args.format
          : undefined

const publicRepo = (url: string) => {
  const match =
    /^https:\/\/(?:www\.)?github\.com\/([\w.-]{1,100})\/([\w.-]{1,100})(?:[/?#]|$)/i.exec(url)
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') {
    return undefined
  }
  return match[1] + '/' + match[2].replace(/\.git$/, '')
}

const sourceRequest = (
  state: GoalState,
  name: string,
  args: Json
): { url: string; raw?: boolean; pin?: string } | undefined => {
  if (name !== 'browse_github_repository') {
    const url = text(args.url)
    return state.links.includes(url) ? { url } : undefined
  }
  const repo = publicRepo(text(args.repository_url))
  if (!repo || !state.links.some((url) => publicRepo(url)?.toLowerCase() === repo.toLowerCase())) {
    return undefined
  }
  const api = 'https://api.github.com/repos/' + repo
  const action = text(args.action)
  if (action === 'issue' || action === 'pull') {
    const id = finite(args.number)
    return Number.isSafeInteger(id) && id > 0
      ? { url: api + '/' + (action === 'pull' ? 'pulls' : 'issues') + '/' + id }
      : undefined
  }
  if (action === 'issues' || action === 'pulls') {
    const page = /^p(\d{1,4})$/.test(text(args.cursor))
      ? Number(text(args.cursor).slice(1))
      : Math.floor(finite(args.page)) || 1
    const state = args.state === 'open' || args.state === 'closed' ? args.state : 'all'
    return page <= 1000
      ? { url: api + '/' + action + '?state=' + state + '&per_page=10&page=' + page }
      : undefined
  }
  if (action === 'latest_release') {
    return { url: api + '/releases/latest' }
  }
  if (!['directory', 'readme', 'file'].includes(action)) {
    return undefined
  }
  const ref = text(args.ref) || 'HEAD'
  if (ref.length > 180 || /[\s?#\\]/.test(ref)) {
    return undefined
  }
  const key = repo.toLowerCase() + ':' + ref
  const sha = state.pins[key]
  if (!sha) {
    return { url: api + '/commits/' + encodeURIComponent(ref), pin: key }
  }
  const path = text(args.path).replace(/^\/|\/$/g, '')
  const parts = path ? path.split('/') : []
  if (parts.some((part) => part === '.' || part === '..' || !part) || path.length > 512) {
    return undefined
  }
  if (action === 'readme') {
    return { url: api + '/readme?ref=' + sha, raw: true }
  }
  return {
    url:
      api +
      '/contents' +
      (parts.length ? '/' + parts.map(encodeURIComponent).join('/') : '') +
      '?ref=' +
      sha,
    raw: action === 'file',
  }
}

const markdownText = (value: string) =>
  value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const outputText = (output: Json, protocol: Protocol): string => {
  if (protocol === 'openai') {
    return text(asRecord(asRecord(asArray(output.choices)[0]).message).content)
  }
  if (protocol === 'gemini') {
    return asArray(asRecord(asRecord(asArray(output.candidates)[0]).content).parts)
      .map(asRecord)
      .filter((part) => !part.thought)
      .map((part) => text(part.text))
      .join('')
  }
  const blocks =
    protocol === 'responses'
      ? asArray(output.output)
          .map(asRecord)
          .flatMap((item) => asArray(item.content))
      : asArray(output.content)
  return blocks
    .map(asRecord)
    .filter((part) => part.type === 'text' || part.type === 'output_text')
    .map((part) => text(part.text))
    .join('')
}

const recordUsage = (state: GoalState, output: Json) => {
  const reported = asRecord(output.usage ?? output.usageMetadata)
  if (!Object.keys(reported).length) {
    return
  }
  const usage = normalizeProviderUsage(reported, state.protocol)
  const previous =
    state.usage.cacheCounts !== undefined
      ? state.usage.cacheCounts
      : state.usage.cacheRead > 0 || state.usage.cacheWrite > 0
        ? {
            hit: state.usage.cacheRead,
            input: state.usage.input + state.usage.cacheRead + state.usage.cacheWrite,
          }
        : null
  state.usage.cacheCounts = addCacheCounts(previous, usage.cache_counts ?? null)
  state.usage.input += usage.input_tokens
  state.usage.output += usage.output_tokens
  state.usage.cacheRead += usage.cache_read_input_tokens
  state.usage.cacheWrite += usage.cache_creation_input_tokens
  const entries = (state.usageEntries ??= [])
  entries.push({
    createdAt: Date.now(),
    usage,
    model: text(output.model || state.request.model) || undefined,
  })
}

const recordAnswer = (state: GoalState, answer: string) => {
  if (!answer) {
    return
  }
  const blocks = (state.blocks ??= [])
  for (let i = 0; i < answer.length; ) {
    let end = Math.min(i + 24_000, answer.length)
    if (end < answer.length && /[\ud800-\udbff]/.test(answer[end - 1])) {
      end--
    }
    blocks.push({ type: 'text', text: answer.slice(i, end) })
    i = end
  }
  const previous = state.answer ?? ''
  state.answer = (previous + (previous ? '\n\n' : '') + answer).slice(-160_000)
}

const suspend = (
  state: GoalState,
  reason: AgentTaskRun['reason'],
  status: AgentTaskRun['status'] = 'partial'
) => {
  state.run = { ...state.run, status, reason }
  if (state.pending?.step) {
    state.steps.push({ ...state.pending.step, status: 'stopped', detail: reason })
  }
  state.pending = undefined
}

export const stop = (json: string, code: string, now: number): string => {
  const state = JSON.parse(json) as GoalState
  state.run.elapsedMs = Math.max(0, now - state.run.startedAt)
  suspend(
    state,
    code === 'storage'
      ? 'storage'
      : code === 'notification-permission'
        ? 'notification-permission'
        : code === 'system-timeout'
          ? 'system-timeout'
          : code === 'budget-time'
            ? 'budget-time'
            : state.run.requestInFlight && code !== 'end'
              ? 'request-unconfirmed'
              : code === 'interrupted'
                ? 'interrupted'
                : 'user',
    code === 'end' ? 'stopped' : 'paused'
  )
  return JSON.stringify(state)
}

export const resume = (json: string, now: number, optionsJson = '{}'): string => {
  const state = JSON.parse(json) as GoalState
  if (!['paused', 'blocked', 'partial', 'failed'].includes(state.run.status)) {
    return json
  }
  if (state.pending?.operation === 'foreground') {
    return json
  }
  const options = asRecord(JSON.parse(optionsJson))
  const previousLimit = taskRequestLimit(state.run)
  const requestedLimit = finite(options.requestLimit)
  const requestLimit =
    requestedLimit === previousLimit + state.run.budgetRequests ? requestedLimit : previousLimit
  if (state.run.retryAt && state.run.retryAt > now) {
    return json
  }
  if (state.run.requestInFlight && options.retryUnconfirmed !== true) {
    suspend(state, 'request-unconfirmed', 'blocked')
    return JSON.stringify(state)
  }
  if (state.run.totalRequests >= requestLimit) {
    suspend(state, 'budget-requests', 'blocked')
    return JSON.stringify(state)
  }
  if (state.protocol !== 'gemini' && typeof options.stream === 'boolean') {
    state.request.stream = options.stream
  }
  state.run = {
    ...state.run,
    status: 'running',
    reason: undefined,
    retryAt: undefined,
    requestLimit,
    segmentRequests: 0,
    requestInFlight: false,
    startedAt: now,
    elapsedBeforeResume: (state.run.elapsedBeforeResume ?? 0) + state.run.elapsedMs,
    elapsedMs: 0,
    background: true,
  }
  state.idleRounds = 0
  return JSON.stringify(state)
}

const outcome = (state: GoalState, result: TaskReadResult, step?: TaskStep) => {
  if (step) {
    step.status = result.isError ? 'failed' : 'done'
    step.failure = result.failure
    if (result.evidence) {
      step.evidence = [result.evidence]
    }
    if (result.isError && !step.detail && !result.failure) {
      step.detail = result.reason ?? result.text.slice(0, 160)
    }
    state.steps.push(step)
    state.steps = state.steps.slice(-240)
    if (!result.isError && !['files', 'plan', 'verification'].includes(step.kind)) {
      state.worked = true
      state.goalWorked = true
    }
  }
  state.outputs.push(
    step && !result.isError
      ? { ...result, text: result.text + '\nResult reference: ' + step.id }
      : result
  )
}

const localTool = (state: GoalState, name: string, args: Json): TaskReadResult => {
  if (name === 'list_task_files') {
    return {
      text: JSON.stringify(
        state.files.map(({ id, name, text }, index) => ({
          id,
          name,
          file: index + 1,
          readable: Boolean(text),
        }))
      ),
    }
  }
  if (name === 'read_selected_attachment') {
    const file = state.files[finite(args.file) - 1]
    if (!file?.text) {
      return failure('Choose a readable file in the selected inventory.', 'attachment-unreadable')
    }
    const position = textPosition(args)
    if (!position) {
      return failure('Choose a valid offset, line range or search phrase.', 'invalid-arguments')
    }
    const part = textExcerpt(file.text, position)
    const evidence = excerptEvidence(
      {
        kind: 'attachment',
        sourceId: 'attachment:' + file.id,
        title: file.name,
        downloadedBytes: file.downloadedBytes,
        partial: Boolean(file.sourceTruncated),
        sourceTruncated: file.sourceTruncated,
      },
      part,
      position,
      file.text.length
    )
    const result = JSON.stringify({
      file: file.name,
      ...part,
      complete: !evidence.partial,
      source_truncated: file.sourceTruncated,
    })
    return evidence.deliveredChars ? { text: result, evidence } : failure(result, 'empty-range')
  }
  if (name === 'update_task_plan') {
    const incoming = asArray(args.steps).map(asRecord)
    if (
      !incoming.length ||
      incoming.length > 8 ||
      incoming.some(
        (item) =>
          !text(item.label).trim() ||
          text(item.label).length > 120 ||
          !['todo', 'working', 'done'].includes(text(item.status))
      )
    ) {
      return failure('Provide up to eight labeled steps and valid states.')
    }
    state.plan = incoming as TaskPlanStep[]
    return { text: 'Working plan updated.' }
  }
  if (name === 'verify_goal_criteria') {
    const met = new Set(state.run.met)
    for (const verification of asArray(args.checks).map(asRecord).slice(0, 8)) {
      const criterion = finite(verification.criterion)
      const ids = asArray(verification.evidence).slice(0, 16)
      if (
        Number.isInteger(criterion) &&
        criterion > 0 &&
        criterion <= state.run.criteria.length &&
        verifyCriterion(state.run.criteria[criterion - 1], ids, state.artifacts, state.steps)
      ) {
        met.add(criterion)
      } else {
        met.delete(criterion)
      }
    }
    state.run.met = Array.from(met)
    return {
      text: JSON.stringify({ verified: state.run.met, required: state.run.criteria.length }),
    }
  }
  if (name === 'calculate') {
    return calculate(args)
  }
  if (name === 'analyze_table') {
    const file = state.files[finite(args.file) - 1]
    return file?.table?.length
      ? analyzeTableData(file.table, args, {
          sourceId: 'attachment:' + file.id,
          kind: 'attachment',
          title: file.name,
        })
      : failure('The selected file is not a fully readable table.', 'attachment-unreadable')
  }
  return failure('This operation needs the app in the foreground.')
}

export const next = (json: string, now: number): string => {
  const state = JSON.parse(json) as GoalState
  let effect: GoalEffect | undefined
  state.run.elapsedMs = Math.max(0, now - state.run.startedAt)
  // This loop only handles local transitions. Each network or disk effect returns to the host.
  for (let actions = 0; actions < 26 && state.run.status === 'running' && !effect; actions++) {
    const turn = toolTurn(state)
    if (turn && state.outputs.length < turn.calls.length) {
      const call = turn.calls[state.outputs.length]
      const args = inputOf(call.input)
      const token = call.name + ':' + JSON.stringify(args)
      const prior = state.cache[token]
      if (prior && call.name !== 'verify_goal_criteria' && call.name !== 'update_task_plan') {
        outcome(state, prior)
        continue
      }
      const format = formatOf(call.name, args)
      const kind: TaskStep['kind'] =
        call.name === 'browse_github_repository'
          ? 'github'
          : call.name === 'browser_open'
            ? 'browser'
            : call.name === 'read_web_page'
              ? 'web'
              : call.name === 'update_task_plan'
                ? 'plan'
                : call.name === 'verify_goal_criteria'
                  ? 'verification'
                  : call.name === 'list_task_files'
                    ? 'files'
                    : call.name === 'read_selected_attachment'
                      ? 'read'
                      : call.name === 'analyze_table'
                        ? 'table'
                        : call.name === 'calculate'
                          ? 'calculate'
                          : format === 'xlsx' || format === 'docx' || format === 'md'
                            ? format
                            : 'data'
      const step: TaskStep = {
        id: state.run.id + '-call-' + ++state.sequence,
        kind,
        status: 'working',
        blockIndex: (state.blockOffset ?? 0) + (state.blocks?.length ?? 0),
        file:
          text(args.file_name || args.path || args.url || args.repository_url).slice(0, 140) ||
          undefined,
      }
      if (!state.definitions.some(({ name }) => name === call.name)) {
        outcome(state, failure('This tool is not available in this run.'), {
          ...step,
          kind: 'tool',
          detail: 'unknown-tool',
        })
      } else if (foregroundTools.has(call.name)) {
        state.run = {
          ...state.run,
          status: 'paused',
          reason: 'waiting-foreground',
          foregroundTool: { id: step.id, name: call.name },
        }
        state.pending = {
          token,
          step: { ...step, status: 'stopped' },
          args,
          tool: call.name,
          operation: 'foreground',
        }
      } else if (kind === 'browser' || kind === 'web' || kind === 'github') {
        const request = sourceRequest(state, call.name, args)
        if (!request) {
          outcome(
            state,
            failure('Use an approved public address or a known repository and valid path.'),
            step
          )
        } else {
          state.pending = {
            token: request.pin || token,
            step,
            operation: request.pin ? 'pin' : 'source',
            source: request.url,
            args,
            media: call.name,
          }
          const cached = !request.pin && state.pages?.[request.url]
          if (cached) {
            const pending = state.pending
            state.pending = undefined
            recordSource(state, pending, cached)
          } else {
            effect = { kind: 'public', url: request.url, raw: request.raw }
          }
        }
      } else if (format) {
        try {
          const file = makeTaskFileBytes(format, args)
          if (file.bytes.length > 2 * 1024 * 1024 || state.artifacts.length >= 12) {
            throw new Error('size')
          }
          state.pending = { token, step, operation: 'write' }
          effect = {
            kind: 'save',
            name: file.name,
            mimeType: file.type,
            base64: base64(file.bytes),
          }
        } catch {
          outcome(
            state,
            failure('The requested file could not be constructed. Use supported rows or sections.'),
            step
          )
        }
      } else {
        outcome(state, localTool(state, call.name, args), step)
      }
      continue
    }
    if (turn) {
      state.request = compactTaskResults(turn.continuation(state.outputs), state.protocol)
      state.response = undefined
      state.outputs = []
      state.idleRounds = state.worked ? 0 : state.idleRounds + 1
      state.worked = false
      if (state.idleRounds >= 4) {
        suspend(state, 'no-progress')
        break
      }
    }
    if (state.run.totalRequests >= taskRequestLimit(state.run)) {
      suspend(state, 'budget-requests')
    } else if (
      state.contextBudget &&
      JSON.stringify(state.request).length / 2 > state.contextBudget
    ) {
      suspend(state, 'context-limit')
    } else {
      state.run.segmentRequests++
      state.run.totalRequests++
      state.run.requestInFlight = true
      state.pending = { operation: 'model', token: '' }
      effect = { kind: 'model', body: state.request }
    }
  }
  return JSON.stringify({ state, effect })
}

export const apply = (json: string, result: string): string => {
  const state = JSON.parse(json) as GoalState
  const value = JSON.parse(result) as Observation
  const pending = state.pending
  state.pending = undefined
  if (!pending || state.run.status !== 'running') {
    return JSON.stringify(state)
  }
  if (pending.operation === 'model') {
    state.run.requestInFlight = !value.confirmed
    const response = inputOf(value.content)
    const answer = outputText(response, state.protocol)
    recordUsage(state, response)
    recordAnswer(state, answer)
    if (value.error || !value.content) {
      const reason =
        value.status === 429
          ? 'provider-rate-limit'
          : value.error === 'provider-timeout'
            ? 'provider-timeout'
            : value.error === 'tools-unavailable'
              ? 'tools-unavailable'
              : value.error === 'request-too-large'
                ? 'context-limit'
                : value.confirmed
                  ? 'provider-error'
                  : 'request-unconfirmed'
      state.run.retryAt = value.retryAt
      suspend(state, reason, 'blocked')
    } else {
      if (!Object.keys(response).length || response.error) {
        suspend(state, 'provider-error', 'blocked')
      } else {
        state.response = response
        const turn = toolTurn(state)
        const choice = asRecord(asArray(response.choices)[0])
        const candidate = asRecord(asArray(response.candidates)[0])
        const restricted = ['length', 'max_tokens', 'MAX_TOKENS'].includes(
          text(
            response.stop_reason ||
              choice.finish_reason ||
              candidate.finishReason ||
              asRecord(response.incomplete_details).reason
          )
        )
        if (restricted) {
          suspend(state, 'output-limit')
          return JSON.stringify(state)
        }
        if (turn && turn.calls.length > 24) {
          suspend(state, 'no-progress')
        } else if (!turn) {
          const remaining = state.run.criteria.filter(
            (_, index) => !state.run.met.includes(index + 1)
          )
          if (state.run.criteria.length && !remaining.length) {
            state.run.status = 'completed'
          } else if (
            !remaining.length ||
            state.steps.some((step) =>
              step.evidence?.some(({ sourceTruncated }) => sourceTruncated)
            )
          ) {
            suspend(state, 'criteria-unmet')
          } else {
            state.goalIdleRounds = state.goalWorked ? 0 : (state.goalIdleRounds ?? 0) + 1
            state.goalWorked = false
            if (state.goalIdleRounds >= 3) {
              suspend(state, 'no-progress')
            } else {
              const prompt =
                'Continue the same goal from saved progress. Do not repeat completed effects. Verify the remaining criteria with new evidence: ' +
                JSON.stringify(remaining)
              state.request = compactTaskResults(
                continueGoalConversation(
                  state.request,
                  state.protocol,
                  answer,
                  prompt,
                  asArray(response.output)
                ),
                state.protocol
              )
              state.response = undefined
            }
          }
        }
      }
    }
  } else if (pending.operation === 'pin') {
    const sha = text(inputOf(value.content).sha)
    if (!value.error && /^[0-9a-f]{40}$/i.test(sha)) {
      state.pins[pending.token] = sha
    } else {
      if (pending.step) {
        pending.step.retryAt = value.retryAt
      }
      outcome(
        state,
        value.error
          ? publicFailure(value)
          : failure('Could not verify the repository revision.', 'unverified-revision'),
        pending.step
      )
    }
  } else if (pending.operation === 'write') {
    if (value.artifact) {
      if (!state.artifacts.some((file) => file.id === value.artifact?.id)) {
        state.artifacts.push(value.artifact)
      }
      const recorded = {
        text: JSON.stringify({ saved: value.artifact.name, artifactId: value.artifact.id }),
      }
      state.cache[pending.token] = recorded
      outcome(state, recorded, pending.step)
    } else {
      outcome(state, failure('The local file could not be saved.'), pending.step)
    }
  } else {
    recordSource(state, pending, value)
  }
  return JSON.stringify(state)
}

const recordSource = (state: GoalState, pending: Pending, value: Observation) => {
  if (value.error || !value.content) {
    if (pending.step) {
      pending.step.retryAt = value.retryAt
    }
    outcome(state, publicFailure(value), pending.step)
    return
  }
  if (pending.source && value.content.length <= 180_000) {
    const pages = state.pages ?? (state.pages = {})
    const cachedSize = Object.keys(pages).reduce(
      (total, key) => total + (pages[key]?.content?.length ?? 0),
      0
    )
    if (!pages[pending.source] && cachedSize + value.content.length <= 450_000) {
      pages[pending.source] = value
    }
  }
  const html = /^text\/html/i.test(value.type || '')
  let content = html ? markdownText(value.content) : value.content
  if (
    pending.media === 'browser_open' &&
    html &&
    content.length < 100 &&
    /<script\b/i.test(value.content)
  ) {
    state.pending = pending
    suspend(state, 'waiting-browser', 'paused')
    return
  }
  if (pending.args?.action === 'issues' || pending.args?.action === 'pulls') {
    try {
      const rows = JSON.parse(content) as unknown
      if (Array.isArray(rows)) {
        content = JSON.stringify(
          rows
            .map(asRecord)
            .filter((item) => pending.args?.action === 'pulls' || !item.pull_request)
            .map(({ number, title, state, html_url, updated_at, body }) => ({
              number,
              title,
              state,
              html_url,
              updated_at,
              body: text(body).slice(0, 450),
            })),
          null,
          2
        )
      }
    } catch {
      // Keep the received text and its coverage rather than manufacturing an empty page.
    }
  }
  const position = textPosition(pending.args || {})
  if (!position) {
    outcome(
      state,
      failure('Choose a valid offset or line range.', 'invalid-arguments'),
      pending.step
    )
    return
  }
  const part = textExcerpt(content, position)
  const url = value.url || pending.source
  const evidence = excerptEvidence(
    {
      kind:
        pending.step?.kind === 'github'
          ? 'github'
          : pending.step?.kind === 'browser'
            ? 'browser'
            : 'web',
      title: pending.step?.file || url || 'Source',
      sourceId: url || pending.step?.id || pending.token,
      url,
      partial: Boolean(value.nextPage) || Boolean(value.truncated),
      sourceTruncated: value.truncated,
      nextCursor: value.nextPage,
      downloadedBytes: value.downloadedBytes,
      retrievedAt: Date.now(),
      revision: /[?&]ref=([a-f0-9]{40})(?:&|$)/i.exec(url ?? '')?.[1],
    },
    part,
    position,
    content.length
  )
  const recorded: TaskReadResult = {
    text: JSON.stringify({
      url,
      ...part,
      complete: !evidence.partial,
      next_cursor: value.nextPage,
      source_truncated: value.truncated,
    }),
    evidence,
  }
  if (!evidence.deliveredChars) {
    outcome(state, failure(recorded.text, 'empty-range'), pending.step)
    return
  }
  if (Object.keys(state.cache).length < 80) {
    state.cache[pending.token] = recorded
  }
  if (pending.step) {
    pending.step.source = url
  }
  outcome(state, recorded, pending.step)
}

export const view = (json: string): string => {
  const { run, plan, artifacts, steps, pending, answer, usage, usageEntries, blocks } = JSON.parse(
    json
  ) as GoalState
  return JSON.stringify({
    run,
    plan,
    artifacts,
    steps: pending?.step ? [...steps, pending.step] : steps,
    answer,
    usage,
    usageEntries,
    blocks,
  })
}

let modelStream: ReturnType<typeof collectNativeModelStream> | undefined

export const startModelStream = (protocol: Protocol) => {
  modelStream = collectNativeModelStream(protocol)
  return ''
}

export const readModelEvent = (raw: string) => modelStream?.read(raw) ?? ''

export const finishModelStream = (interrupted: string) => {
  const result = modelStream?.result(interrupted)
  modelStream = undefined
  return JSON.stringify(result ?? { error: 'provider-empty', confirmed: false })
}
