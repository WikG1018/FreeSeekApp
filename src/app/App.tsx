import { Onboarding } from '../components/onboarding/Onboarding.js'
import { shouldShowOnboarding } from '../services/onboarding.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { hasSettingsOpen } from '../components/settings/settingsDialogState.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { useEffect, useState } from 'react'
import {
  Capacitor,
  registerPlugin,
  SystemBars,
  SystemBarsStyle,
  SystemBarType,
} from '@capacitor/core'
import { App as CapacitorApp } from '@capacitor/app'
import { useTranslate } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
import { useTheme } from './theme.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import {
  bindChatPersistence,
  initChat,
  newChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel, useSearchPanel } from '../components/search/searchPanelState.js'
import { closeTopModal, hasOpenModal } from '../components/base/Modal.js'
import { SessionView } from '../components/session/SessionView.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { onUploadNotice } from '../services/attachments.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import { closeMobileSider, useMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import styles from './App.module.css'

/** 字体大小原生插件（Android WebView textZoom） */
const FontScale = registerPlugin<{ setFontScale(options: { scale: number }): Promise<void> }>(
  'FontScale'
)

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  // 首次使用：没绑 Key 且没看过引导时弹一次
  const [onboarding, setOnboarding] = useState(() =>
    shouldShowOnboarding(useSettings.getState().apiKey)
  )
  const initError = useChatStore((state) => state.initError)
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
  const importingHistory = useChatStore((state) => state.importingHistory)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  const fontScale = useSettings((state) => state.fontScale)
  const frameRef = useMobileViewport(
    isMobile,
    Capacitor.getPlatform() === 'android' ? 1 : fontScale
  )
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)

  usePreventPageScroll(isMobile)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // 字体大小：Android 用原生 textZoom（只缩放文字，不改布局）；网页预览用 #root 等比缩放
  useEffect(() => {
    if (Capacitor.getPlatform() === 'android') {
      document.documentElement.style.setProperty('--fs-ui-scale', '1')
      void FontScale.setFontScale({ scale: fontScale }).catch(() => {})
      return
    }
    document.documentElement.style.setProperty('--fs-ui-scale', String(fontScale))
  }, [fontScale])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  useEffect(bindChatPersistence, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') {
        stopReadAloud()
      }
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => document.removeEventListener('visibilitychange', onHidden)
  }, [])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  useEffect(() => {
    void initChat()
  }, [])

  // 沉浸式：系统栏图标颜色跟随应用主题（浅色主题用深色图标，深色主题反之）
  const theme = useTheme()
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      return
    }
    const style = theme === 'dark' ? SystemBarsStyle.Dark : SystemBarsStyle.Light
    void SystemBars.setStyle({ style }).catch(() => {})
    void SystemBars.setStyle({ style, bar: SystemBarType.NavigationBar }).catch(() => {})
  }, [theme])

  // Android 返回键：设置/弹窗 → 搜索面板 → 侧边抽屉 → 退出确认（双击），不吞掉任务栈返回
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      return
    }
    let lastBack = 0
    const subscription = CapacitorApp.addListener('backButton', () => {
      // 1. 设置页打开时交由其内部返回（二级页 → 一级 → 关闭），绝不直接退出
      if (hasSettingsOpen()) {
        return // SettingsDialog 自己监听 Escape/返回关闭层级
      }
      if (hasOpenModal() && closeTopModal()) {
        return
      }
      if (useSearchPanel.getState().entry !== null) {
        closeSearchPanel()
        return
      }
      if (useMobileSider.getState().open) {
        closeMobileSider()
        return
      }
      // 2. 在会话页按返回：回到欢迎页（官方 App 行为），而不是退出
      if (useChatStore.getState().activeId !== null) {
        newChat()
        return
      }
      // 3. 已在欢迎页：2 秒内再按一次才退出，避免误触直接回桌面
      const now = Date.now()
      if (now - lastBack < 2000) {
        void CapacitorApp.exitApp()
        return
      }
      lastBack = now
      showToast({ key: 'pressBackAgainToExit' })
    })
    return () => {
      void subscription.then((handle) => handle.remove())
    }
  }, [])

  return (
    <>
      <div ref={frameRef} className={styles.frame}>
        {isMobile ? <MobileSider /> : siderCollapsed ? null : <Sider />}
        <main className={styles.main}>
          {saveError ? (
            <div className={styles.saveError} role="alert">
              <span>{t('sessionSaveFailed')}</span>
              <Button
                variant="outlined"
                size="s"
                disabled={importingHistory}
                onClick={retrySaveSessions}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div className={styles.content}>
            {siderCollapsed ? <CollapsedSider /> : null}
            {!ready || (activeId !== null && !session) ? (
              <div className={styles.loadingView}>
                {isMobile ? <MobileHeader /> : null}
                <div className={styles.loadingState} role="status" aria-live="polite">
                  <span>
                    {(!ready ? initError : sessionLoadError)
                      ? t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')
                      : t('sessionLoading')}
                  </span>
                  {(!ready ? initError : sessionLoadError) ? (
                    <Button
                      variant="outlined"
                      size="m"
                      onClick={() => {
                        if (!ready) {
                          void initChat()
                        } else if (activeId !== null) {
                          selectSession(activeId)
                        }
                      }}
                    >
                      {t('retry')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : session ? (
              <SessionView
                session={session}
                streaming={streaming}
                siderCollapsed={siderCollapsed}
              />
            ) : (
              <Welcome />
            )}
          </div>
        </main>
        <SearchPanel />
      </div>
      <SettingsDialog />
      {onboarding ? <Onboarding onDone={() => setOnboarding(false)} /> : null}
      <Toast />
    </>
  )
}
