import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import {
  cancelUpload,
  markAttachmentLocal,
  isImage,
  resolveMimeType,
  uploadAttachment,
  validateFiles,
  type UploadTask,
} from '../attachments.js'
import type { FileAttachment } from './types.js'
import { diagnosticError, logEvent } from '../diagnostics/log.js'
import { useProviders, type ModelSelection } from '../providers.js'

export type DraftAttachment = {
  /** 本地标识，也是 IndexedDB 原件与上传任务的 key */
  id: string
  file: File
  isImage: boolean
  previewUrl: string | null
}

type Draft = { text: string; attachments: DraftAttachment[] }

export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

const DRAFT_TEXT_KEY = 'freeseek:draft-texts'
const restoreDraftTexts = () => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DRAFT_TEXT_KEY) ?? '[]')
    if (!Array.isArray(value)) {
      return new Map<string | null, Draft>()
    }
    return new Map<string | null, Draft>(
      value
        .filter(
          (entry) =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            (entry[0] === null || typeof entry[0] === 'string') &&
            typeof entry[1] === 'string'
        )
        .map(([id, text]) => [id, { text, attachments: [] }])
    )
  } catch {
    return new Map<string | null, Draft>()
  }
}
/** 文字草稿恢复到原会话；附件仍由页面内存与上传任务持有。 */
export const useDrafts = create<{ drafts: Map<string | null, Draft> }>(() => ({
  drafts: restoreDraftTexts(),
}))
let saveTimer: ReturnType<typeof setTimeout> | undefined
export const flushDraftTexts = () => {
  clearTimeout(saveTimer)
  saveTimer = undefined
  try {
    const entries = [...useDrafts.getState().drafts]
      .filter(([, draft]) => draft.text)
      .map(([id, draft]) => [id, draft.text])
    if (entries.length) {
      localStorage.setItem(DRAFT_TEXT_KEY, JSON.stringify(entries))
    } else {
      localStorage.removeItem(DRAFT_TEXT_KEY)
    }
  } catch (error) {
    logEvent('storage', 'drafts.save-failed', diagnosticError(error), 'warn')
  }
}
useDrafts.subscribe(() => {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flushDraftTexts, 300)
})
window.addEventListener('pagehide', flushDraftTexts)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushDraftTexts()
  }
})

export const getDraft = (sessionId: string | null): Draft =>
  useDrafts.getState().drafts.get(sessionId) ?? EMPTY_DRAFT

const updateDraft = (sessionId: string | null, update: (draft: Draft) => Draft) =>
  useDrafts.setState((state) => {
    const draft = update(state.drafts.get(sessionId) ?? EMPTY_DRAFT)
    const drafts = new Map(state.drafts)
    if (draft.text || draft.attachments.length > 0) {
      drafts.set(sessionId, draft)
    } else {
      drafts.delete(sessionId)
    }
    return { drafts }
  })

export const setDraftText = (sessionId: string | null, text: string) =>
  updateDraft(sessionId, (draft) => ({ ...draft, text }))

type DraftRoute = { selection: ModelSelection; deferUpload: boolean }

const upload = (attachment: DraftAttachment, apiKey: string, local: boolean) => {
  if (local) {
    markAttachmentLocal(attachment.id)
    return
  }
  // 上传任务负责记录错误，输入框的附件卡片展示失败及重试入口。
  void uploadAttachment(
    apiKey,
    attachment.id,
    attachment.file,
    attachment.file.name,
    attachment.isImage
  ).catch(() => {})
}

/** 整批校验通过后才创建预览和开始上传。 */
export const addDraftFiles = (
  sessionId: string | null,
  files: File[],
  apiKey: string,
  route?: DraftRoute
): TranslationMessage | null => {
  if (files.length === 0) {
    return null
  }
  const error = validateFiles(files, getDraft(sessionId).attachments.length)
  if (error) {
    logEvent(
      'upload',
      'attachments.rejected',
      { sessionId, count: files.length, localKey: error.key },
      'warn'
    )
    return error
  }
  const selection = route?.selection ?? useProviders.getState().selection
  const local = Boolean(route?.deferUpload || selection.providerId !== 'deepseek')
  if (
    selection.providerId === 'deepseek' &&
    selection.model === 'deepseek-v4-pro' &&
    files.some((file) => isImage(resolveMimeType(file)))
  ) {
    logEvent(
      'upload',
      'attachments.rejected',
      { sessionId, count: files.length, localKey: 'providerProNoImages' },
      'warn'
    )
    return { key: 'providerProNoImages' }
  }
  const added = files.map((file): DraftAttachment => {
    const image = isImage(resolveMimeType(file))
    return {
      id: createId(),
      file,
      isImage: image,
      previewUrl: image ? URL.createObjectURL(file) : null,
    }
  })
  updateDraft(sessionId, (draft) => ({ ...draft, attachments: [...draft.attachments, ...added] }))
  logEvent('upload', 'attachments.added', {
    sessionId,
    count: added.length,
    imageCount: added.filter((attachment) => attachment.isImage).length,
    bytes: files.reduce((total, file) => total + file.size, 0),
    local,
  })
  added.forEach((attachment) => upload(attachment, apiKey, local))
  return null
}

export const retryDraftAttachment = (
  sessionId: string | null,
  attachmentId: string,
  apiKey: string,
  deferUpload = false
) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (attachment) {
    logEvent('upload', 'attachment.retry-requested', { sessionId, fileId: attachmentId })
    upload(
      attachment,
      apiKey,
      deferUpload || useProviders.getState().selection.providerId !== 'deepseek'
    )
  }
}

/** 发送按钮和实际提交共用规则：有内容，且全部附件已上传成功。 */
export const prepareDraftMessage = (
  draft: Draft,
  tasks: Record<string, UploadTask>,
  route?: DraftRoute
) => {
  const text = draft.text.trim()
  if (!text && draft.attachments.length === 0) {
    return null
  }
  const local = (route?.selection ?? useProviders.getState().selection).providerId !== 'deepseek'
  const files: (FileAttachment & { blob: Blob })[] = []
  for (const attachment of draft.attachments) {
    const task = tasks[attachment.id]
    if (!local && !route?.deferUpload && (task?.status !== 'done' || !task.serverId)) {
      return null
    }
    files.push({
      id: attachment.id,
      serverId:
        !local && task?.status === 'done' && !task.serverId.startsWith('local:')
          ? task.serverId
          : null,
      name: attachment.file.name,
      size: attachment.file.size,
      isImage: attachment.isImage,
      mimeType: resolveMimeType(attachment.file),
      blob: attachment.file,
    })
  }
  return { text, files }
}

const releaseAttachment = (attachment: DraftAttachment, cancel: boolean) => {
  if (cancel) {
    cancelUpload(attachment.id)
  }
  if (attachment.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl)
  }
}

export const removeDraftAttachment = (sessionId: string | null, attachmentId: string) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (!attachment) {
    return
  }
  releaseAttachment(attachment, true)
  logEvent('upload', 'attachment.removed', { sessionId, fileId: attachmentId })
  updateDraft(sessionId, (draft) => ({
    ...draft,
    attachments: draft.attachments.filter((item) => item.id !== attachmentId),
  }))
}

/** 发送成功后原件与 serverId 已交给会话，释放预览但保留上传完成态。 */
export const clearSentDraft = (sessionId: string | null) => {
  getDraft(sessionId).attachments.forEach((attachment) => releaseAttachment(attachment, false))
  updateDraft(sessionId, () => EMPTY_DRAFT)
  flushDraftTexts()
}

/** 删除会话或替换历史成功后，释放尚未发送的草稿及上传任务。 */
export const clearDraft = (sessionId: string | null) => {
  getDraft(sessionId).attachments.forEach((attachment) => releaseAttachment(attachment, true))
  updateDraft(sessionId, () => EMPTY_DRAFT)
  flushDraftTexts()
}

export const clearAllDrafts = () => {
  for (const draft of useDrafts.getState().drafts.values()) {
    draft.attachments.forEach((attachment) => releaseAttachment(attachment, true))
  }
  useDrafts.setState({ drafts: new Map() })
  flushDraftTexts()
}

useProviders.subscribe((state, previous) => {
  if (
    state.selection.providerId !== previous.selection.providerId &&
    state.selection.providerId !== 'deepseek'
  ) {
    for (const draft of useDrafts.getState().drafts.values()) {
      for (const attachment of draft.attachments) {
        markAttachmentLocal(attachment.id)
      }
    }
  }
})
