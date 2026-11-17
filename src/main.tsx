import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import { initUpdateChecker } from './services/update.js'
import { initDiagnostics } from './services/diagnostics/log.js'
import './app/theme.css'
import './app/global.css'

initDiagnostics()
ensureKatex()
setupTheme()
initUpdateChecker()

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="app-scaler">
    <App />
  </div>
)
