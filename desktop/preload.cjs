const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('freeseekDesktopDiagnostics', () =>
  ipcRenderer.invoke('freeseek:diagnostics:snapshot')
)

contextBridge.exposeInMainWorld('freeseekCopyTaskOutput', (options) =>
  ipcRenderer.invoke('freeseek:file:copy-task-output', options)
)
contextBridge.exposeInMainWorld('freeseekOpenTaskOutput', (options) =>
  ipcRenderer.invoke('freeseek:file:open-task-output', options)
)
contextBridge.exposeInMainWorld('freeseekOfficePreview', (options) =>
  ipcRenderer.invoke('freeseek:file:office-layout', options)
)

contextBridge.exposeInMainWorld('freeseekWindowsUpdate', {
  get: (options) => ipcRenderer.invoke('freeseek:update:get', options),
  hasFile: (options) => ipcRenderer.invoke('freeseek:update:has', options),
  probe: (options) => ipcRenderer.invoke('freeseek:update:probe', options),
  download: (options) => ipcRenderer.invoke('freeseek:update:download', options),
  install: (options) => ipcRenderer.invoke('freeseek:update:install', options),
  addListener: async (_event, receive) => {
    const listener = (_ipcEvent, progress) => receive(progress)
    ipcRenderer.on('freeseek:update:progress', listener)
    return { remove: async () => ipcRenderer.removeListener('freeseek:update:progress', listener) }
  },
})

contextBridge.exposeInMainWorld('freeseekPublicWeb', {
  read: (options) => ipcRenderer.invoke('freeseek:task-web:read', options),
  cancel: (options) => ipcRenderer.invoke('freeseek:task-web:cancel', options),
})

contextBridge.exposeInMainWorld(
  'freeseekAgentGoals',
  Object.fromEntries(
    ['permission', 'start', 'snapshot', 'control', 'file', 'forget'].map((method) => [
      method,
      (args) => ipcRenderer.invoke('freeseek:goal:' + method, args),
    ])
  )
)
