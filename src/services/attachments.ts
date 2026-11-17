import { create } from 'zustand'
import type { LinkedMessage, TranslationMessage } from '../i18n/index.js'
import { uploadFile } from './api/client.js'
import { classifyApiError, getUploadErrorInfo, isRetryableUploadError } from './api/errors.js'
import type { UploadProgress } from './api/multipart.js'
import { diagnosticError, logEvent } from './diagnostics/log.js'
import type { FilePurpose } from './api/types.js'
import {
  ImageDecodeTimeoutError,
  ImageDimensionsError,
  UnsupportedImageError,
  normalizeImageFile,
} from './image.js'
import { ACCEPT_FILE_EXTS } from './uploadExts.js'
import { abortReason } from '../utils/abort.js'

/** 允许上传的扩展名，按扩展名白名单过滤，清单见 uploadExts.ts */
export const ACCEPTED_EXTS = ACCEPT_FILE_EXTS
/** 选择文件对话框的过滤条件 */
export const ACCEPT = ACCEPTED_EXTS.map((ext) => `.${ext}`).join(',')
/** 单文件大小上限与 Files API 一致 */
export const MAX_SIZE_MB = 64
/** 按 user_data 上传的文件（纯文本、代码、表格、电子书）原文件上限更小 */
export const MAX_USER_DATA_SIZE_MB = 32
export const MAX_COUNT = 50
/** 同时上传的文件数 */
const MAX_CONCURRENT = 3

/** 文件扩展名（小写，不含点）；没有扩展名时为空 */
export const getFileExt = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export const isAcceptedExt = (name: string) => ACCEPTED_EXTS.includes(getFileExt(name))

/** 需要服务端做版面解析的文档；其余非图片文件（纯文本、代码、表格、电子书）无需解析 */
const LAYOUT_RECOGNITION_EXTS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx'])

/** 上传时的 purpose：图片不传，PDF 与 Word、PPT 做版面解析，其余按 user_data 上传 */
export const getUploadPurpose = (name: string, isImage: boolean): FilePurpose | null => {
  if (isImage) {
    return null
  }
  return LAYOUT_RECOGNITION_EXTS.has(getFileExt(name)) ? 'rich_layout_recognition' : 'user_data'
}

/** 文件允许的最大体积（MB），按上传时的 purpose 区分 */
const getMaxSizeMB = (file: File) =>
  getUploadPurpose(file.name, isImage(resolveMimeType(file))) === 'user_data'
    ? MAX_USER_DATA_SIZE_MB
    : MAX_SIZE_MB

/** 添加前校验：格式 → 大小 → 数量，任一不满足即整批不添加 */
export const validateFiles = (files: File[], currentCount: number): TranslationMessage | null => {
  if (files.some((file) => !isAcceptedExt(file.name))) {
    return { key: 'uploadUnsupportedFormat' }
  }
  const oversized = files.find((file) => file.size > getMaxSizeMB(file) * 1024 * 1024)
  if (oversized) {
    return { key: 'uploadMaxMBSize', params: { size: getMaxSizeMB(oversized) } }
  }
  if (currentCount + files.length > MAX_COUNT) {
    return { key: 'uploadMaxFiles', params: { count: MAX_COUNT } }
  }
  return null
}

/**
 * 上传失败在附件上显示的文案：与设计稿状态对应的用具体原因，其余统一「上传失败」。
 * 服务端原文多为英文且较长，不直接展示。
 */
export const describeUploadError = (error: unknown): TranslationMessage => {
  if (error instanceof ImageDecodeTimeoutError) {
    return { key: 'uploadImageDecodeTimeout' }
  }
  if (error instanceof ImageDimensionsError) {
    return { key: 'uploadImageTooLarge' }
  }
  if (error instanceof UnsupportedImageError) {
    return { key: 'uploadImageUnsupported' }
  }
  if (error && typeof error === 'object' && 'localMessage' in error && error.localMessage) {
    return error.localMessage as TranslationMessage
  }
  // 逐类给出可操作的原因；一律「上传失败」会让用户以为是文件问题，实际可能是 Key 或网络
  switch (classifyApiError(error)) {
    case 'unauthorized':
      return { key: 'uploadUnauthorized' }
    case 'insufficientBalance':
      return { key: 'uploadInsufficientBalance' }
    case 'tooLarge':
      return { key: 'uploadTooLarge' }
    case 'rateLimited':
      return { key: 'uploadRateLimited' }
    case 'serverBusy':
      return { key: 'uploadServerBusy' }
    case 'network':
      return { key: 'uploadNetworkError' }
    default:
      break
  }
  if (getUploadErrorInfo(error)?.code === 'parseFailed') {
    return { key: 'uploadParseFailed' }
  }
  return { key: 'uploadFileStatusFailed' }
}

type NoticeListener = (notice: LinkedMessage) => void
const noticeListeners = new Set<NoticeListener>()

/** 订阅需要额外提示的上传失败（配额达到上限），由界面层转成 toast */
export const onUploadNotice = (listener: NoticeListener) => {
  noticeListeners.add(listener)
  return () => {
    noticeListeners.delete(listener)
  }
}

/** 删除已上传文件的接口文档 */
const DELETE_FILE_DOCS_URL = 'https://api-docs.deepseek.com/api/delete-file'

/** 文件数或存储空间达到上限：附件上只放得下「上传失败」，原因另用 toast 说明并引导删除旧文件 */
export const describeUploadQuota = (error: unknown): LinkedMessage | undefined => {
  const info = getUploadErrorInfo(error)
  const link = { key: 'uploadDeleteFiles', href: DELETE_FILE_DOCS_URL } as const
  if (info?.code === 'fileCountLimit') {
    return { type: 'error', key: 'uploadFileCountLimit', params: { limit: info.limit ?? '' }, link }
  }
  if (info?.code === 'storageLimit') {
    return { type: 'error', key: 'uploadStorageLimit', params: { limit: info.limit ?? '' }, link }
  }
  return undefined
}

type Job = () => Promise<void>
const queue: Job[] = []
let running = 0

const next = () => {
  while (running < MAX_CONCURRENT) {
    const job = queue.shift()
    if (!job) {
      return
    }
    running++
    void job().finally(() => {
      running--
      next()
    })
  }
}

/** 排队上传，最多同时上传 MAX_CONCURRENT 个；排队期间中止的任务不会发出请求 */
const enqueueUpload = (
  apiKey: string,
  file: Blob,
  name: string,
  isImage: boolean,
  signal: AbortSignal,
  onProgress?: (progress: UploadProgress) => void
) =>
  new Promise<string>((resolve, reject) => {
    const abort = () => {
      const index = queue.indexOf(job)
      if (index >= 0) {
        queue.splice(index, 1)
      }
      signal.removeEventListener('abort', abort)
      reject(abortReason(signal))
    }
    const job = async () => {
      if (signal.aborted) {
        abort()
        return
      }
      try {
        const raw = file instanceof File ? file : new File([file], name, { type: file.type })
        // 图片先规范格式：BMP/TIFF/HEIC 等接口不收的，转成 PNG 再传
        const body = isImage ? await normalizeImageFile(raw, signal) : raw
        signal.throwIfAborted()
        resolve(
          (await uploadFile(apiKey, body, getUploadPurpose(name, isImage), signal, onProgress)).id
        )
      } catch (error) {
        reject(error)
      } finally {
        signal.removeEventListener('abort', abort)
      }
    }
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    queue.push(job)
    next()
  })

/**
 * 上传任务按附件的本地 id 登记：输入框选中即开始上传，全部成功后携带 serverId 发送，
 * 不会重复上传；导入的历史附件没有任务，发送前按本地原件补传。
 * 任务只在内存里，历史附件补传未完成时，刷新后会在下次请求前重新上传。
 */
export type UploadTask =
  | { status: 'uploading'; progress?: number; processing?: boolean }
  | { status: 'done'; serverId: string }
  | { status: 'error'; error: TranslationMessage; retryable: boolean }

type UploadState = { tasks: Record<string, UploadTask> }

export const useUploads = create<UploadState>(() => ({ tasks: {} }))

const setTask = (id: string, task: UploadTask | null) =>
  useUploads.setState((state) => ({
    tasks: task
      ? { ...state.tasks, [id]: task }
      : Object.fromEntries(Object.entries(state.tasks).filter(([key]) => key !== id)),
  }))

const pending = new Map<string, { promise: Promise<string>; controller: AbortController }>()

/** 开始（或复用进行中的）上传，返回服务端 file_id；失败时任务记为 error 并抛出原错误 */
export const uploadAttachment = (
  apiKey: string,
  id: string,
  blob: Blob,
  name: string,
  isImage: boolean
): Promise<string> => {
  const current = pending.get(id)
  if (current && !current.controller.signal.aborted) {
    return current.promise
  }
  const controller = new AbortController()
  const ownsTask = () => pending.get(id)?.controller === controller
  const started = performance.now()
  logEvent('upload', 'queued', {
    fileId: id,
    extension: getFileExt(name),
    bytes: blob.size,
    mimeType: blob.type,
    image: isImage,
    queuedJobs: queue.length,
    activeJobs: running,
  })
  setTask(id, { status: 'uploading' })
  let lastProgressAt = 0,
    processing = false,
    transportLinked = false
  const promise = enqueueUpload(apiKey, blob, name, isImage, controller.signal, (progress) => {
    if (!transportLinked) {
      transportLinked = true
      logEvent('upload', 'transport.linked', { fileId: id, requestId: progress.requestId })
    }
    const nextProcessing = progress.phase !== 'uploading'
    if (performance.now() - lastProgressAt < 200 && processing === nextProcessing) {
      return
    }
    lastProgressAt = performance.now()
    processing = nextProcessing
    if (!controller.signal.aborted && ownsTask()) {
      setTask(id, {
        status: 'uploading',
        processing,
        progress:
          !processing && progress.total
            ? Math.min(99, Math.floor((progress.loaded / progress.total) * 100))
            : undefined,
      })
    }
  })
    .then((serverId) => {
      if (controller.signal.aborted || !ownsTask()) {
        throw abortReason(controller.signal)
      }
      setTask(id, { status: 'done', serverId })
      logEvent('upload', 'completed', {
        fileId: id,
        elapsedMs: Math.round(performance.now() - started),
      })
      return serverId
    })
    .catch((error: unknown) => {
      logEvent(
        'upload',
        controller.signal.aborted ? 'cancelled' : 'failed',
        {
          fileId: id,
          elapsedMs: Math.round(performance.now() - started),
          ...diagnosticError(error),
        },
        controller.signal.aborted ? 'info' : 'error'
      )
      if (controller.signal.aborted) {
        if (ownsTask()) {
          setTask(id, null)
        }
      } else if (ownsTask()) {
        setTask(id, {
          status: 'error',
          error: describeUploadError(error),
          retryable: !(error instanceof UnsupportedImageError) && isRetryableUploadError(error),
        })
        const notice = describeUploadQuota(error)
        if (notice) {
          for (const listener of noticeListeners) {
            listener(notice)
          }
        }
      }
      throw error
    })
    .finally(() => {
      if (ownsTask()) {
        pending.delete(id)
      }
    })
  pending.set(id, { promise, controller })
  return promise
}

export const cancelUpload = (id: string) => {
  pending.get(id)?.controller.abort()
  setTask(id, null)
}

export const markAttachmentLocal = (id: string) => {
  cancelUpload(id)
  pending.delete(id)
  setTask(id, { status: 'done', serverId: `local:${id}` })
}

/** 本次进程内不反复提交已证实无法解析的原件；原件与消息元数据均保留。 */
export const markAttachmentInvalid = (id: string) =>
  setTask(id, { status: 'error', retryable: false, error: { key: 'uploadParseFailed' } })

/** 各扩展名对应的 MIME：部分系统（如 Windows）给不出 file.type，按扩展名补齐 */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  svgz: 'image/svg+xml',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ico: 'image/x-icon',
  jfif: 'image/jpeg',
}

/** 取文件的 MIME：优先用浏览器给出的类型，缺失时按扩展名推断 */
export const resolveMimeType = (file: File) => MIME_BY_EXT[getFileExt(file.name)] || file.type || ''

export const isImage = (mimeType: string) => mimeType.startsWith('image/')

/** 文件扩展名（大写），用于卡片元信息 */
export const getExtension = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : ''
}

export const formatSize = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
