import { useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { useTranslate } from '../../i18n/index.js'
import {
  currentVersion,
  isNewer,
  downloadUpdate,
  installUpdate,
  openReleasePage,
  useUpdate,
} from '../../services/update.js'
import { Button } from '../base/Button.js'
import { IconUploadOutline14 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './Update.module.css'

/** 统一处理「安装」的提示（未授权安装未知应用时引导去系统设置） */
export const runInstall = async () => {
  const result = await installUpdate()
  if (!result.installed && result.reason === 'permission') {
    showToast({ key: 'updateInstallPermission' })
  } else if (!result.installed && result.reason === 'history-unsaved') {
    showToast({ key: 'updateHistoryUnsaved', type: 'error' })
  } else if (!result.installed && result.reason !== 'web') {
    showToast({ key: 'updateInstallFailed', type: 'error' })
  }
  return result
}

/** Keep the notes available while checking, downloading or waiting for installation. */
export const SidebarUpdate = () => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const { status, release, percent, error } = useUpdate()
  if (!release || !isNewer(release.version, currentVersion())) {
    return null
  }
  const detail =
    status === 'ready'
      ? t('updateDownloaded')
      : status === 'downloading'
        ? percent >= 0
          ? t('updateDownloadingShort', { percent })
          : t('updateDownloading')
        : error === 'download-failed'
          ? t('updateRetryDownload')
          : t('updateViewNotes')
  const label =
    status === 'downloading'
      ? detail
      : `${t(status === 'ready' ? 'updateSidebarReady' : 'updateSidebarLabel')} v${release.version}`
  return (
    <>
      <button
        type="button"
        data-testid="sidebar-update"
        className={styles.sidebar}
        aria-haspopup="dialog"
        aria-label={t('updateSidebarAvailable', { version: release.version }) + ' · ' + detail}
        title={detail}
        onClick={() => setOpen(true)}
      >
        <span className={styles.sidebarIcon} aria-hidden>
          <IconUploadOutline14 />
        </span>
        <span className={styles.sidebarText}>{label}</span>
        {status === 'downloading' && percent >= 0 && (
          <span className={styles.sidebarBar} aria-hidden>
            <span className={styles.sidebarBarFill} style={{ width: percent + '%' }} />
          </span>
        )}
      </button>
      {open && <UpdateDialog onClose={() => setOpen(false)} />}
    </>
  )
}

/** 关于页「检查更新」当前状态文案 */
export const useUpdateStatusText = (): string => {
  const t = useTranslate()
  const status = useUpdate((state) => state.status)
  const release = useUpdate((state) => state.release)
  const percent = useUpdate((state) => state.percent)
  switch (status) {
    case 'checking':
      return t('updateChecking')
    case 'downloading':
      return percent >= 0 ? t('updateDownloadingShort', { percent }) : t('updateDownloading')
    case 'ready':
      return t('updateReadyShort')
    case 'available':
      return release ? t('updateAvailable', { version: release.version }) : t('updateLatest')
    case 'latest':
      return t('updateLatest')
    case 'error':
      return t('updateFailed')
    default:
      return t('updateNotChecked')
  }
}

/** 更新说明弹窗：查看发布说明、下载 / 安装 */
export const UpdateDialog = ({
  onClose,
  installed = false,
}: {
  onClose: () => void
  installed?: boolean
}) => {
  const t = useTranslate()
  const { status, release, percent, error } = useUpdate()
  const info = installed ? { version: currentVersion(), notes: __CURRENT_RELEASE_NOTES__ } : release
  if (!info || (!installed && !isNewer(info.version, currentVersion()))) {
    return null
  }
  const version = info.version,
    notes = info.notes.trim()
  return (
    <Modal
      title={t('updateNotesTitle', { version })}
      centered
      closable
      onClose={onClose}
      footer={
        installed ? undefined : (
          <>
            <Button
              variant={Capacitor.isNativePlatform() ? 'outlined' : 'primary'}
              onClick={() => void openReleasePage()}
            >
              {t('updateOpenPage')}
            </Button>
            {Capacitor.isNativePlatform() &&
              (status === 'ready' ? (
                <Button onClick={() => void runInstall()}>{t('updateInstallNow')}</Button>
              ) : (
                <Button disabled={status !== 'available'} onClick={() => void downloadUpdate()}>
                  {t(status === 'downloading' ? 'updateDownloading' : 'updateDownloadNow')}
                </Button>
              ))}
          </>
        )
      }
    >
      <div className={styles.notes} data-testid="release-notes">
        {(notes || t('updateNoNotes')).split(/\n\s*\n/).map((paragraph, i) => {
          const lines = paragraph.split(/\r?\n/)
          return lines.every((line) => /^\s*[-*] /.test(line)) ? (
            <ul key={i}>
              {lines.map((line, j) => (
                <li key={j}>{line.replace(/^\s*[-*] /, '')}</li>
              ))}
            </ul>
          ) : (
            <p key={i}>{paragraph}</p>
          )
        })}
      </div>
      {!installed && status === 'downloading' && (
        <div className={styles.downloadStatus} role="status">
          {percent >= 0 ? t('updateDownloadingShort', { percent }) : t('updateDownloading')}
          {percent >= 0 && (
            <div
              className={styles.progress}
              role="progressbar"
              aria-label={t('updateDownloading')}
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span className={styles.progressFill} style={{ width: percent + '%' }} />
            </div>
          )}
        </div>
      )}
      {!installed && error === 'download-failed' && (
        <p role="alert" className={styles.downloadStatus}>
          {t('updateRetryDownload')}
        </p>
      )}
    </Modal>
  )
}
