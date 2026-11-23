import { useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { useTranslate } from '../../i18n/index.js'
import { isWindowsDesktop } from '../../services/api/windowsTransport.js'
import { useSettings } from '../../services/settings.js'
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
import { closeTopModal, Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './Update.module.css'

/** 统一处理「安装」的提示（未授权安装未知应用时引导去系统设置） */
export const runInstall = async () => {
  const result = await installUpdate()
  if (!result.installed && result.reason === 'permission') {
    showToast({ key: 'updateInstallPermission' })
  } else if (!result.installed && result.reason === 'history-unsaved') {
    showToast({ key: 'updateHistoryUnsaved', type: 'error' })
  } else if (!result.installed && result.reason === 'active-chat') {
    showToast({
      key: isWindowsDesktop() ? 'updateWindowsActiveChat' : 'updateWebActiveChat',
      type: 'error',
    })
  } else if (!result.installed && result.reason === 'web-offline') {
    showToast({ key: 'updateWebOffline', type: 'error' })
  } else if (!result.installed) {
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
      ? t(release.webFiles ? 'updateWebPrepared' : 'updateDownloaded')
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
      : `${t(status === 'ready' ? (release.webFiles ? 'updateWebReady' : 'updateSidebarReady') : 'updateSidebarLabel')} v${release.version}`
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
      return t(release?.webFiles ? 'updateWebPrepared' : 'updateReadyShort')
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
  const nativeApp = Capacitor.isNativePlatform()
  const native = nativeApp || isWindowsDesktop()
  const locale = useSettings((state) => state.locale)
  const currentNotes =
    locale === 'en-US' && __CURRENT_RELEASE_NOTES_EN__
      ? __CURRENT_RELEASE_NOTES_EN__
      : __CURRENT_RELEASE_NOTES__
  const info = installed ? { version: currentVersion(), notes: currentNotes } : release
  if (!info || (!installed && !isNewer(info.version, currentVersion()))) {
    return null
  }
  const version = info.version,
    notes = info.notes.trim()
  return (
    <Modal
      title={t('updateNotesTitle', { version })}
      centered
      closable={nativeApp}
      onClose={onClose}
      footer={
        installed ? (
          nativeApp ? undefined : (
            <Button onClick={closeTopModal}>{t('close')}</Button>
          )
        ) : (
          <>
            <Button
              variant="outlined"
              onClick={native ? () => void openReleasePage() : closeTopModal}
            >
              {t(native ? 'updateOpenPage' : 'close')}
            </Button>
            {status === 'ready' ? (
              <Button onClick={() => void runInstall()}>
                {t(native ? 'updateInstallNow' : 'updateWebReload')}
              </Button>
            ) : (
              <Button disabled={status !== 'available'} onClick={() => void downloadUpdate()}>
                {t(status === 'downloading' ? 'updateDownloading' : 'updateDownloadNow')}
              </Button>
            )}
          </>
        )
      }
    >
      <div className={styles.notes} data-testid="release-notes">
        {(notes || t('updateNoNotes')).split(/\n\s*\n/).map((paragraph, i) => {
          const lines = paragraph.split(/\r?\n/)
          // 小节标题后面常常紧跟列表（中间没有空行），标题和内容要在同一个分块里拆开。
          const heading = /^#{2,4} (\S.*)$/.exec(lines[0].trim())
          const body = heading ? lines.slice(1) : lines
          const bullets = body.every((line) => /^\s*[-*] /.test(line))
          const content = bullets ? (
            <ul>
              {body.map((line, j) => (
                <li key={j}>{line.replace(/^\s*[-*] /, '')}</li>
              ))}
            </ul>
          ) : body.length ? (
            <p>{body.join('\n')}</p>
          ) : null
          return heading || content ? (
            <div key={i} className={styles.noteBlock}>
              {heading ? <h4 className={styles.notesHeading}>{heading[1]}</h4> : null}
              {content}
            </div>
          ) : null
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
