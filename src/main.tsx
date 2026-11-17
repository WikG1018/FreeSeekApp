import { createRoot } from 'react-dom/client'
import { Component, useLayoutEffect, type ReactNode } from 'react'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import { initUpdateChecker } from './services/update.js'
import { initDiagnostics } from './services/diagnostics/log.js'
import { diagnosticError, logEvent } from './services/diagnostics/log.js'
import { markStartupReady, reportRenderFailure } from './services/startup.js'
import './app/theme.css'
import './app/global.css'

initDiagnostics()
ensureKatex()
setupTheme()
initUpdateChecker()

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
  useLayoutEffect(markStartupReady, [])
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
