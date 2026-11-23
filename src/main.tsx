import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import { Component, useLayoutEffect, type ReactNode } from 'react'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { detectFlexSpacing } from './app/layoutSupport.js'
import { ensureKatex } from './services/markdown/katex.js'
import { initUpdateChecker } from './services/update.js'
import { ensureNotificationPermission } from './services/notifications.js'
import { initDiagnostics } from './services/diagnostics/log.js'
import { diagnosticError, logEvent } from './services/diagnostics/log.js'
import { markStartupMounted, markStartupReady, reportRenderFailure } from './services/startup.js'
import { useChatStore } from './services/chat/store.js'
import './app/theme.css'
import './app/global.css'

document.documentElement.toggleAttribute(
  'data-android-window',
  Capacitor.getPlatform() === 'android'
)
initDiagnostics()
detectFlexSpacing()
ensureKatex()
setupTheme()
initUpdateChecker()
// 通知权限：首次安装或版本更新后主动申请一次。
// 延迟到首屏渲染完成之后，避免和启动动画、免责声明弹窗抢焦点。
window.setTimeout(() => {
  void ensureNotificationPermission()
}, 6000)

class RenderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override componentDidCatch(error: Error) {
    logEvent('ui', 'render.failed', diagnosticError(error), 'error')
    reportRenderFailure(error)
  }
  override render() {
    return this.state.failed ? null : this.props.children
  }
}
const Ready = () => {
  const settled = useChatStore(
    ({ ready, initError, activeId, sessionCache, sessionLoadErrors }) =>
      initError ||
      (ready &&
        (activeId === null ||
          Object.hasOwn(sessionCache, activeId) ||
          sessionLoadErrors[activeId] === true))
  )
  useLayoutEffect(markStartupMounted, [])
  useLayoutEffect(() => {
    if (settled) {
      markStartupReady()
    }
  }, [settled])
  return null
}
createRoot(document.getElementById('root') as HTMLElement).render(
  <RenderBoundary>
    <div className="app-scaler">
      <App />
      <Ready />
    </div>
  </RenderBoundary>
)
