import { useTranslate } from '../../i18n/index.js'
import {
  currentVersion,
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
  }
  return result
}

/** 侧边栏更新入口：有更新时出现；下载中显示进度；下好即可一键安装 */
export const SidebarUpdate = () => {
  const t = useTranslate()
  const status = useUpdate((state) => state.status)
  const release = useUpdate((state) => state.release)
  const percent = useUpdate((state) => state.percent)

  if (!release || (status !== 'available' && status !== 'downloading' && status !== 'ready')) {
    return null
  }

  const label =
    status === 'ready'
      ? t('updateSidebarReady', { version: release.version })
      : status === 'downloading'
        ? percent >= 0
          ? t('updateDownloadingShort', { percent })
          : t('updateDownloading')
        : t('updateSidebarAvailable', { version: release.version })

  return (
    <button
      type="button"
      className={status === 'ready' ? styles.sidebarReady : styles.sidebar}
      onClick={() => {
        if (status === 'ready') {
          void runInstall()
        } else if (status === 'available') {
          void downloadUpdate()
        }
      }}
    >
      <span className={styles.sidebarIcon}>
        <IconUploadOutline14 />
      </span>
      <span className={styles.sidebarText}>{label}</span>
      {status === 'downloading' && percent >= 0 ? (
        <span className={styles.sidebarBar} aria-hidden>
          <span className={styles.sidebarBarFill} style={{ width: `${percent}%` }} />
        </span>
      ) : null}
    </button>
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
      return percent >= 0
        ? t('updateDownloadingShort', { percent })
        : t('updateDownloading')
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
export const UpdateDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const status = useUpdate((state) => state.status)
  const release = useUpdate((state) => state.release)
  const percent = useUpdate((state) => state.percent)
  if (!release) {
    return null
  }
  return (
    <Modal
      title={t('updateNotesTitle', { version: release.version })}
      centered
      closable
      onClose={onClose}
      footer={
        <>
          <Button variant="outlined" onClick={() => void openReleasePage()}>
            {t('updateOpenPage')}
          </Button>
          {status === 'ready' ? (
            <Button onClick={() => void runInstall()}>{t('updateInstallNow')}</Button>
          ) : (
            <Button disabled={status === 'downloading'} onClick={() => void downloadUpdate()}>
              {status === 'downloading' ? t('updateDownloading') : t('updateDownloadNow')}
            </Button>
          )}
        </>
      }
    >
      <pre className={styles.notes}>{release.notes || t('updateNoNotes')}</pre>
      {status === 'downloading' && percent >= 0 ? (
        <div className={styles.progress}>
          <span className={styles.progressFill} style={{ width: `${percent}%` }} />
        </div>
      ) : null}
    </Modal>
  )
}

export const appVersion = currentVersion
