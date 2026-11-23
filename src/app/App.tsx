import { ContextSummaryDialog } from '../components/messages/ContextSummaryDialog.js'
import { ImageViewer } from '../components/messages/ImageViewer.js'
import { useImageViewer } from '../components/messages/imageViewerState.js'
import { Onboarding } from '../components/onboarding/Onboarding.js'
import { initialOnboardingStep } from '../services/onboarding.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { MemoryDialogs } from '../components/settings/MemoryDialogs.js'
import { refreshAssistantLibrary } from '../services/assistants/library.js'
import {
  hasSettingsOpen,
  openSettings,
  useSettingsDialog,
} from '../components/settings/settingsDialogState.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
import {
  onReminderTarget,
  reminderTarget,
  workspaceDeviceFiles,
} from '../services/tasks/workspacePlatform.js'
import { setScreenTimeChat } from '../services/screenTime.js'
import { bindNativeGoalActivity, reportViewedConversation } from '../services/tasks/goalBridge.js'
import { useScreenTimeMilestones } from '../services/screenTimeMilestones.js'
import { useAutomaticScreenTimeMilestones } from './useScreenTimeMilestones.js'
import { useTheme } from './theme.js'
import { installWebBack, registerWebBack } from './webBack.js'
import { logEvent } from '../services/diagnostics/log.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import {
  bindChatPersistence,
  initChat,
  returnToWelcome,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel, useSearchPanel } from '../components/search/searchPanelState.js'
import { closeTopModal, hasOpenModal } from '../components/base/Modal.js'
import { closeTransientPanel } from '../components/base/transientPanel.js'
import { SessionView } from '../components/session/SessionView.js'
import { ChatModeDialog } from '../components/session/ChatModeDialog.js'
import { AgentGoalDialog } from '../components/session/AgentGoalDialog.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { onUploadNotice } from '../services/attachments.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import { closeMobileSider, useMobileSider } from '../components/sider/mobileSiderState.js'
import { Sider } from '../components/sider/Sider.js'
import { MobileSider } from '../components/sider/MobileSider.js'
import { useSiderGesture } from '../components/sider/useSiderGesture.js'
import { DonateDialog } from '../components/donate/DonateDialog.js'
import { UsageMilestoneDialog } from '../components/milestones/UsageMilestone.js'
import styles from './App.module.css'
import { hasChatConnection } from '../services/providers.js'
import { bindEdgeFeedback } from './edgeFeedback.js'
import { ChatSaveNotice } from './ChatSaveNotice.js'

/** 字体大小原生插件（Android WebView textZoom） */
const FontScale = registerPlugin<{ setFontScale(options: { scale: number }): Promise<void> }>(
  'FontScale'
)
const Appearance = registerPlugin<{ setTheme(options: { dark: boolean }): Promise<void> }>(
  'Appearance'
)

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  useEffect(() => {
    if (!ready || !workspaceDeviceFiles()) {
      return
    }
    let live = true
    const visit = ({ sessionId }: { sessionId?: string }) => {
      if (live && sessionId) {
        selectSession(sessionId)
      }
    }
    void reminderTarget()
      .then(visit)
      .catch(() => {})
    const listener = onReminderTarget(visit)
    return () => {
      live = false
      void listener.then((current) => current.remove()).catch(() => {})
    }
  }, [ready])
  // 声明版本和新手指南分别记录。
  const [onboarding, setOnboarding] = useState(() =>
    initialOnboardingStep(Boolean(hasChatConnection() || useSettings.getState().apiKey))
  )
  const [donationOpen, setDonationOpen] = useState(false)
  const [donationFullscreen, setDonationFullscreen] = useState(false)
  const openDonation = () => setDonationOpen(true)
  const milestone = useScreenTimeMilestones((state) => state.playing)
  const initError = useChatStore((state) => state.initError)
  const historyMissing = useChatStore((state) => state.historyMissing)
  const historyMayStartFresh = useChatStore((state) => state.historyMayStartFresh)
  const saveError = useChatStore((state) => Object.keys(state.sessionSaveErrors).length > 0)
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
  const frameRef = useMobileViewport(true, Capacitor.getPlatform() === 'android' ? 1 : fontScale)
  const siderOpen = useMobileSider((state) => state.open) && isMobile
  const settingsOpen = useSettingsDialog((state) => state.open)
  useSiderGesture(frameRef, isMobile)
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)
  useAutomaticScreenTimeMilestones(
    ready && activeId === null && !siderOpen && !settingsOpen && !donationOpen && !onboarding
  )
  const visibleChat =
    ready &&
    !importingHistory &&
    !sessionLoadError &&
    !siderOpen &&
    !settingsOpen &&
    !donationOpen &&
    !onboarding
      ? (session?.id ?? null)
      : null

  useLayoutEffect(() => setScreenTimeChat(visibleChat), [visibleChat])
  useEffect(bindNativeGoalActivity, [])
  useEffect(() => reportViewedConversation(visibleChat), [visibleChat])

  usePreventPageScroll(isMobile || Capacitor.getPlatform() === 'android')
  useEffect(bindEdgeFeedback, [])

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
  useEffect(() => {
    void refreshAssistantLibrary()
  }, [])

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

  // 系统栏图标跟随当前覆盖层。应用配色单独持久化，打开弹窗时无需重设。
  const theme = useTheme()
  const previewImage = useImageViewer((state) => state.image)
  const nativeTheme = useRef<{ dark: boolean; ready: Promise<void> }>()
  const appDark = theme === 'dark'
  const darkMilestone = milestone !== null && milestone > 100
  const darkStatus = appDark || !!previewImage || (darkMilestone && !donationFullscreen)
  const darkNavigation = appDark || !!previewImage || (darkMilestone && !donationOpen)
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      return
    }
    let stale = false
    void (async () => {
      if (Capacitor.getPlatform() === 'android') {
        if (nativeTheme.current?.dark !== appDark) {
          nativeTheme.current = { dark: appDark, ready: Appearance.setTheme({ dark: appDark }) }
        }
        await nativeTheme.current.ready
      }
      if (stale) {
        return
      }
      await SystemBars.setStyle({
        style: darkStatus ? SystemBarsStyle.Dark : SystemBarsStyle.Light,
        bar: SystemBarType.StatusBar,
      })
      if (stale) {
        return
      }
      await SystemBars.setStyle({
        style: darkNavigation ? SystemBarsStyle.Dark : SystemBarsStyle.Light,
        bar: SystemBarType.NavigationBar,
      })
    })().catch(() => {})
    return () => {
      stale = true
    }
  }, [appDark, darkStatus, darkNavigation])

  // Android 返回键：设置/弹窗 → 搜索面板 → 侧边抽屉 → 退出确认（双击），不吞掉任务栈返回
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      return
    }    let lastBack = 0
    const subscription = CapacitorApp.addListener('backButton', () => {
      // 1. 设置页打开时交由其内部返回（二级页 → 一级 → 关闭），绝不直接退出
      if (hasSettingsOpen()) {
        return // SettingsDialog 自己监听 Escape/返回关闭层级
      }
      if (closeTransientPanel() || (hasOpenModal() && closeTopModal())) {
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
        returnToWelcome()
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

  // 网页版/PWA 的系统返回：浏览器的历史后退先交给应用内的层级，都关完才退出。
  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      return
    }
    // iOS 主屏幕 PWA 没有返回键，只有左边缘右滑手势：右滑关一层，到主页后再滑什么都不做。
    // 提示「再按一次返回」或退出都会让用户莫名其妙地被踢出应用。
    const homeScreenPwa = (navigator as Navigator & { standalone?: boolean }).standalone === true
    installWebBack(
      () => showToast({ key: 'pressBackAgainToExit' }),
      homeScreenPwa ? 'stay' : 'exit'
    )
    return registerWebBack(() => {
      logEvent('app', 'web-back-state', {
        settings: hasSettingsOpen(),
        sider: useMobileSider.getState().open,
        search: useSearchPanel.getState().entry !== null,
        session: useChatStore.getState().activeId !== null,
      })
      if (closeTransientPanel() || (hasOpenModal() && closeTopModal())) {
        return true
      }
      if (useSearchPanel.getState().entry !== null) {
        closeSearchPanel()
        return true
      }
      if (useMobileSider.getState().open) {
        closeMobileSider()
        return true
      }
      if (useChatStore.getState().activeId !== null) {
        returnToWelcome()
        return true
      }
      return false
    })
  }, [])

  return (
    <>
      <div
        ref={frameRef}
        className={styles.frame}
        data-fs-app-frame=""
        data-sider-open={siderOpen ? '' : undefined}
      >
        {isMobile ? (
          <MobileSider donationOpen={donationOpen} onDonate={openDonation} />
        ) : siderCollapsed ? null : (
          <Sider donationOpen={donationOpen} onDonate={openDonation} />
        )}
        <main className={styles.main} aria-hidden={siderOpen || undefined}>
          {saveError && <ChatSaveNotice />}
          <div className={styles.content}>
            {siderCollapsed ? <CollapsedSider /> : null}
            {!ready || (activeId !== null && !session) ? (
              <div className={styles.loadingView}>
                {isMobile ? <MobileHeader /> : null}
                <div className={styles.loadingState} role="status" aria-live="polite">
                  <span>
                    {(!ready ? initError : sessionLoadError)
                      ? t(
                          !ready
                            ? historyMissing
                              ? 'historyPreviouslySaved'
                              : 'sessionListLoadFailed'
                            : 'sessionLoadFailed'
                        )
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
                  {!ready && initError && (
                    <Button variant="outlined" size="m" onClick={() => openSettings('data')}>
                      {t('historyOpenBackup')}
                    </Button>
                  )}
                  {!ready && historyMayStartFresh && (
                    <Button variant="outlined" size="m" onClick={() => void initChat(true)}>
                      {t('historyStartWithoutRestore')}
                    </Button>
                  )}
                </div>
              </div>
            ) : session ? (
              <SessionView
                session={session}
                streaming={streaming}
                siderCollapsed={siderCollapsed}
              />
            ) : (
              <Welcome
                motionActive={
                  !siderOpen && !settingsOpen && !donationOpen && !onboarding && milestone === null
                }
              />
            )}
          </div>
        </main>
        <SearchPanel />
      </div>
      {milestone !== null && (
        <UsageMilestoneDialog hours={milestone} covered={donationOpen} onDonate={openDonation} />
      )}
      {donationOpen && (
        <DonateDialog
          onFullscreenChange={setDonationFullscreen}
          onClose={() => {
            setDonationFullscreen(false)
            setDonationOpen(false)
          }}
        />
      )}
      <ContextSummaryDialog />
      <SettingsDialog />
      <MemoryDialogs />
      <ChatModeDialog />
      <AgentGoalDialog />
      {onboarding ? (
        <Onboarding
          initial={onboarding}
          configured={Boolean(hasChatConnection() || useSettings.getState().apiKey)}
          onDone={() => setOnboarding(null)}
        />
      ) : null}
      {previewImage && <ImageViewer image={previewImage} />}
      <Toast />
    </>
  )
}
