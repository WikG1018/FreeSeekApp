const { app, BrowserWindow, ipcMain, net, protocol, session, shell } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { registerWindowsUpdates } = require('./updates.cjs')
const { registerOutputShare } = require('./share.cjs')
const { registerOfficePreview } = require('./officePreview.cjs')
const { registerAgentHost } = require('./agentHost.cjs')
const { registerPublicWeb } = require('./publicWeb.cjs')
const { createDesktopDiagnostics } = require('./diagnostics.cjs')

const SCHEME = 'freeseek'
const HOME = 'freeseek://app/'
const assets = path.join(__dirname, '..', 'dist')
const allowedAssets =
  /^(?:index\.html|startup-mark\.png|web-version\.json|LICENSE|static\/[\w./~-]+)$/
let mainWindow, agentHost, diagnostics

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

const isAppUrl = (value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'freeseek:' && url.host === 'app' && !url.username && !url.password
  } catch {
    return false
  }
}

const httpUrl = (value) => {
  try {
    const url = new URL(value)
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
      return url
    }
  } catch {
    // Renderer URLs can be malformed.
  }
  return null
}

// Only the packaged renderer can use this route. Requests and responses stream through Chromium.
const requestProvider = async (request, address) => {
  const target = httpUrl(address)
  const origin = request.headers.get('origin')
  if (
    !target ||
    target.hash ||
    request.headers.get('x-freeseek-network') !== '1' ||
    (origin && !isAppUrl(origin)) ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  ) {
    return new Response(null, { status: 403 })
  }
  const headers = new Headers(request.headers)
  for (const header of [...headers.keys()]) {
    if (
      /^(?:sec-|proxy-)/i.test(header) ||
      [
        'cookie',
        'origin',
        'referer',
        'host',
        'connection',
        'content-length',
        'transfer-encoding',
        'upgrade',
        'x-freeseek-network',
      ].includes(header)
    ) {
      headers.delete(header)
    }
  }
  try {
    const response = await net.fetch(target.href, {
      method: request.method,
      headers,
      signal: request.signal,
      redirect: 'error',
      credentials: 'omit',
      ...(request.body ? { body: request.body, duplex: 'half' } : {}),
    })
    const forwarded = new Headers()
    for (const field of ['content-type', 'x-ds-request-id', 'x-request-id', 'request-id']) {
      const value = response.headers.get(field)
      if (value) {
        forwarded.set(field, value)
      }
    }
    return new Response(response.body, { status: response.status, headers: forwarded })
  } catch {
    return new Response(null, { status: 502 })
  }
}

const appResponse = async (request) => {
  if (!isAppUrl(request.url)) {
    return new Response(null, { status: 403 })
  }
  const url = new URL(request.url)
  if (url.pathname === '/_api' && ['POST', 'GET'].includes(request.method)) {
    return requestProvider(request, url.searchParams.get('url'))
  }
  const name = url.pathname.slice(1) || 'index.html'
  if (
    !['GET', 'HEAD'].includes(request.method) ||
    !allowedAssets.test(name) ||
    name.split('/').some((part) => part === '..')
  ) {
    return new Response(null, { status: 404 })
  }
  return net
    .fetch(pathToFileURL(path.join(assets, name)).href)
    .catch(() => new Response(null, { status: 404 }))
}

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 850,
    minWidth: 370,
    minHeight: 420,
    autoHideMenuBar: true,
    icon: path.join(assets, 'startup-mark.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      navigateOnDragDrop: false,
    },
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  mainWindow.webContents.on('did-finish-load', () => diagnostics.record('desktop.renderer-ready'))
  mainWindow.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3) diagnostics.record('desktop.renderer-load-failed', { code }, 'error')
  })
  mainWindow.webContents.on('render-process-gone', (_event, { reason, exitCode }) => {
    diagnostics.record('desktop.renderer-exited', { reason, exitCode }, reason === 'clean-exit' ? 'info' : 'error')
  })
  mainWindow.on('unresponsive', () => diagnostics.record('desktop.renderer-unresponsive', {}, 'warn'))
  mainWindow.on('responsive', () => diagnostics.record('desktop.renderer-responsive'))
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const target = httpUrl(url)
    if (target) {
      void shell.openExternal(target.href).catch(() => {})
    }
    return { action: 'deny' }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  agentHost?.attach(mainWindow)
  void mainWindow.loadURL(HOME).catch(() => {})
}

const showMainWindow = () => {
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.show()
  mainWindow?.focus()
}

if (app.requestSingleInstanceLock()) {
  diagnostics = createDesktopDiagnostics(app)
  diagnostics.record('desktop.started', { version: app.getVersion() })
  app.on('will-quit', () => diagnostics.record('desktop.quitting'))
  app.on('second-instance', showMainWindow)
  app.on('window-all-closed', () => app.quit())
  app
    .whenReady()
    .then(() => {
      const permissions = new Set(['media', 'fullscreen', 'clipboard-sanitized-write'])
      session.defaultSession.setPermissionCheckHandler(
        (_webContents, permission, origin) => isAppUrl(origin) && permissions.has(permission)
      )
      session.defaultSession.setPermissionRequestHandler(
        (_webContents, permission, respond, details) => {
          respond(isAppUrl(details.requestingUrl) && permissions.has(permission))
        }
      )
      protocol.handle(SCHEME, appResponse)
      registerWindowsUpdates(
        (event) => event.sender === mainWindow?.webContents && isAppUrl(event.senderFrame?.url)
      )
      const isMainFrame = (event) =>
        event.sender === mainWindow?.webContents &&
        event.senderFrame === event.sender.mainFrame &&
        isAppUrl(event.senderFrame?.url)
      ipcMain.handle('freeseek:diagnostics:snapshot', (event) => {
        if (!isMainFrame(event)) throw new Error('Diagnostics require the app window')
        return diagnostics.snapshot()
      })
      registerOutputShare(isMainFrame)
      registerOfficePreview(isMainFrame)
      registerPublicWeb(isMainFrame)
      agentHost = registerAgentHost(isMainFrame, () => {
        if (!mainWindow) createWindow()
        showMainWindow()
      })
      createWindow()
    })
    .catch(() => {
      diagnostics.record('desktop.start-failed', {}, 'error')
      app.exit(1)
    })
} else {
  app.quit()
}
