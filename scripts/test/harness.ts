import '../../src/compatibility.js'
import { createId } from '../../src/utils/id.js'
import { readJsonEntry } from '../../src/services/chat/history/readJson.js'
import { writeArchive } from '../../src/services/chat/history/zipWriter.js'
import { toIndexEntry } from '../../src/services/chat/history/toArchive.js'
import * as personas from '../../src/services/personas.js'
import * as branches from '../../src/services/chat/branches.js'
import * as diagnostics from '../../src/services/diagnostics/log.js'
import * as multipart from '../../src/services/api/multipart.js'
import * as diagnosticBundle from '../../src/services/diagnostics/export.js'
import * as image from '../../src/services/image.js'
import * as speech from '../../src/services/api/speech.js'
import { sumMessageUsage } from '../../src/services/chat/usage.js'
import type { Session, UserMessage, AssistantMessage } from '../../src/services/chat/types.js'
import type { MessageUsage, StopReason } from '../../src/services/api/types.js'

const user = (id: string, content: string, patch: Partial<UserMessage> = {}): UserMessage => ({
  id,
  role: 'user',
  content,
  files: [],
  createdAt: Date.now(),
  ...patch,
})
const assistant = (
  id: string,
  text: string,
  patch: Partial<AssistantMessage> = {}
): AssistantMessage => ({
  id,
  role: 'assistant',
  blocks: [{ type: 'text', text }],
  status: 'done',
  prefix: true,
  model: 'deepseek-flash',
  createdAt: Date.now(),
  ...patch,
})
const session = (patch: Partial<Session> = {}): Session => ({
  id: createId(),
  title: 'Regression',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [],
  ...patch,
})
const seed = async (sessions: Session[], files: db.StoredFile[] = []) => {
  for (const session of sessions) {
    await db.saveSession(session)
  }
  await db.saveFiles(files)
  store.useChatStore.setState({
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })),
    sessionCache: Object.fromEntries(sessions.map((s) => [s.id, s])),
    activeId: sessions[0]?.id ?? null,
  })
}
const waitIdle = async () => {
  const deadline = Date.now() + 10000
  while (Object.keys(store.useChatStore.getState().streaming).length) {
    if (Date.now() > deadline) {
      throw new Error('Reply did not settle')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
const response = (
  text = 'Mock answer',
  usage: MessageUsage = {
    input_tokens: 2,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 2,
  },
  stopReason: StopReason = 'end_turn'
) =>
  new Response(
    [
      { type: 'message_start', message: { usage: { ...usage, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: stopReason }, usage },
      { type: 'message_stop' },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
import * as db from '../../src/services/chat/db.js'
import * as store from '../../src/services/chat/store.js'
import * as settings from '../../src/services/settings.js'
import * as providers from '../../src/services/providers.js'
import * as providerClient from '../../src/services/api/providerClient.js'
import * as providerContent from '../../src/services/api/providerContent.js'
import * as providerTransport from '../../src/services/api/providerTransport.js'
import * as diagnosticShare from '../../src/services/shareDiagnostics.js'
import * as drafts from '../../src/services/chat/drafts.js'
import * as uploads from '../../src/services/attachments.js'
import * as reply from '../../src/services/chat/reply.js'
import * as backup from '../../src/services/chat/backup.js'
import * as usage from '../../src/services/usage.js'
import * as screenTime from '../../src/services/screenTime.js'
import * as update from '../../src/services/update.js'
import * as client from '../../src/services/api/client.js'
import * as sse from '../../src/services/api/sse.js'
import * as readAloud from '../../src/services/speech/readAloud.js'
import * as searchPanel from '../../src/components/search/searchPanelState.js'
import * as settingsDialog from '../../src/components/settings/settingsDialogState.js'
import { toSessionFile } from '../../src/services/chat/history/toArchive.js'
import { toLocalSession } from '../../src/services/chat/history/toLocal.js'
import { exportArchive } from '../../src/services/chat/history/exportArchive.js'
import { importArchive } from '../../src/services/chat/history/importArchive.js'
import { readArchive, readEntry } from '../../src/services/chat/history/zipReader.js'
import { renderMermaid } from '../../src/services/markdown/mermaid.js'

Object.assign(window, {
  __audit: {
    db,
    store,
    settings,
    providers,
    providerClient,
    providerContent,
    providerTransport,
    diagnosticShare,
    drafts,
    uploads,
    reply,
    backup,
    usage,
    screenTime,
    update,
    client,
    sse,
    readAloud,
    settingsDialog,
    searchPanel,
    toSessionFile,
    toLocalSession,
    exportArchive,
    importArchive,
    readArchive,
    readEntry,
    renderMermaid,
    writeArchive,
    toIndexEntry,
    personas,
    sumMessageUsage,
    fixtures: { user, assistant, session },
    seed,
    waitIdle,
    response,
    branches,
    diagnostics,
    multipart,
    diagnosticBundle,
    image,
    speech,
    readJsonEntry,
  },
})
await (window as Window & { __seedReady?: Promise<void> }).__seedReady
await import('../../src/main.tsx')
