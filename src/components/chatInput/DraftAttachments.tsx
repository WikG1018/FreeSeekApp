import clsx from 'clsx'
import { memo } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useUploads, type UploadTask } from '../../services/attachments.js'
import type { DraftAttachment } from '../../services/chat/drafts.js'
import { IconCloseFill14, IconRefreshOutline16 } from '../base/icons.js'
import { Tooltip } from '../base/Tooltip.js'
import { FileCard } from '../files/FileCard.js'
import styles from './ChatInput.module.css'
import { openSettings } from '../settings/settingsDialogState.js'
import { openExternal } from '../../utils/openExternal.js'
import { logEvent } from '../../services/diagnostics/log.js'

const UPLOADING: UploadTask = { status: 'uploading' }

/** 列表只随草稿附件变化更新；每张卡片独立订阅自己的上传状态。 */
export const DraftAttachments = memo(function DraftAttachments({
  items,
  onRetry,
  onRemove,
}: {
  items: DraftAttachment[]
  onRetry: (id: string) => void
  onRemove: (id: string) => void
}) {
  if (items.length === 0) {
    return null
  }
  return (
    <>
      <div className={styles.attachments}>
        {items.map((item) => (
          <AttachmentItem
            key={item.id}
            item={item}
            onRetry={() => onRetry(item.id)}
            onRemove={() => onRemove(item.id)}
          />
        ))}
      </div>
      <UploadRecovery items={items} onRetry={onRetry} />
    </>
  )
})

/** 输入框里的文件：图片显示缩略图，其余显示文件卡片 */
const AttachmentItem = ({
  item,
  onRetry,
  onRemove,
}: {
  item: DraftAttachment
  onRetry: () => void
  onRemove: () => void
}) => {
  const t = useTranslate()
  const task = useUploads((state) => state.tasks[item.id] ?? UPLOADING)
  const status = task.status
  const error = task.status === 'error' ? t(task.error.key, task.error.params) : undefined
  // 过大、格式不支持等重试无效的失败只提示原因，需删除后再发送
  const retry = task.status === 'error' && task.retryable ? onRetry : undefined
  const failed = status === 'error'
  const retryLabel = t('uploadRetry', { message: error ?? t('uploadFileStatusFailed') })
  // 「上传失败」只显示重试图标，其余原因写在图片上：可重试时在图标下方，不可重试时贴底
  const showReason = failed && error !== undefined && error !== t('uploadFileStatusFailed')
  return item.previewUrl ? (
    <div
      className={clsx(styles.attachment, failed && styles.attachmentFailed)}
      title={error ?? item.file.name}
    >
      <img src={item.previewUrl} alt={item.file.name} />
      {status === 'uploading' ? (
        <div className={styles.uploading} role="status">
          <span className={styles.uploadProgress}>
            {task.processing
              ? t('uploadProcessing')
              : task.progress !== undefined
                ? t('uploadProgress', { percent: task.progress })
                : t('uploadFileStatusUploading')}
          </span>
        </div>
      ) : null}
      {failed && retry ? (
        <Tooltip content={retryLabel}>
          <button type="button" className={styles.failed} aria-label={retryLabel} onClick={retry}>
            <IconRefreshOutline16 />
            {showReason ? <span className={styles.failedReason}>{error}</span> : null}
          </button>
        </Tooltip>
      ) : null}
      {failed && !retry ? (
        <div className={clsx(styles.failed, styles.failedStatic)} aria-label={error}>
          {showReason ? <span className={styles.failedReason}>{error}</span> : null}
        </div>
      ) : null}
      <button
        type="button"
        className={clsx(styles.remove, failed && !retry && styles.invalidRemove)}
        aria-label={t('delete')}
        onClick={onRemove}
      >
        <IconCloseFill14 />
      </button>
    </div>
  ) : (
    <FileCard
      name={item.file.name}
      size={item.file.size}
      status={status}
      error={error}
      onRetry={retry}
      onRemove={onRemove}
      progress={task.status === 'uploading' ? task.progress : undefined}
      processing={task.status === 'uploading' && task.processing}
    />
  )
}

const UploadRecovery = ({
  items,
  onRetry,
}: {
  items: DraftAttachment[]
  onRetry: (id: string) => void
}) => {
  const t = useTranslate()
  const tasks = useUploads((state) => state.tasks)
  const failed = items.filter((item) => tasks[item.id]?.status === 'error')
  if (!failed.length) {
    return null
  }
  const keys = failed
    .map((item) => tasks[item.id])
    .filter((task) => task?.status === 'error')
    .map((task) => task.error.key)
  return (
    <div className={styles.uploadRecovery} role="alert">
      <span>{t('uploadFailedCount', { count: failed.length })}</span>
      {keys.includes('uploadUnauthorized') ? (
        <button type="button" onClick={() => openSettings('account')}>
          {t('uploadConfigureKey')}
        </button>
      ) : null}
      {keys.includes('uploadInsufficientBalance') ? (
        <button
          type="button"
          onClick={() => void openExternal('https://platform.deepseek.com/top_up')}
        >
          {t('topUp')}
        </button>
      ) : null}
      {failed.some((item) => {
        const task = tasks[item.id]
        return task?.status === 'error' && task.retryable
      }) ? (
        <button
          type="button"
          onClick={() => {
            logEvent('ui', 'upload.retry-clicked', { failedCount: failed.length })
            failed.forEach((item) => {
              const task = tasks[item.id]
              if (task?.status === 'error' && task.retryable) {
                onRetry(item.id)
              }
            })
          }}
        >
          {t('uploadRetryFailed')}
        </button>
      ) : null}
    </div>
  )
}
