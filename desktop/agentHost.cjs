const { app, dialog, ipcMain, Menu, powerMonitor, Tray, utilityProcess } = require('electron')
const path = require('node:path')

const channels = ['permission', 'start', 'snapshot', 'control', 'file', 'forget']
const registerAgentHost = (isTrusted, openWindow) => {
  let worker,
    initializing,
    workingId,
    hiddenWindow,
    tray,
    trayStatus,
    quitting = false,
    waitingToQuit = false,
    closing = false
  let seq = 0
  const pending = new Map()
  const chinese = app.getLocale().toLowerCase().startsWith('zh')
  const label = (zh, en) => (chinese ? zh : en)

  const request = (method, args) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error('agent-host-unavailable'))
      }, 15_000)
      pending.set(id, { resolve, reject, timeout })
      worker.postMessage({ seq: id, method, args })
    })
  const pauseFailure = () =>
    dialog.showErrorBox(
      'FreeSeek',
      label('未能保存目标进度，请重试。', 'Could not save goal progress. Please try again.')
    )
  const pauseActive = async () => {
    const id = workingId
    if (worker && id) {
      const { changed } = await request('control', { id, action: 'pause' })
      if (!changed && workingId === id) {
        throw new Error('agent-checkpoint-not-saved')
      }
    }
  }
  const quit = async () => {
    if (waitingToQuit || quitting) {
      return
    }
    waitingToQuit = true
    try {
      await pauseActive()
    } catch {
      pauseFailure()
      return
    } finally {
      waitingToQuit = false
    }
    quitting = true
    app.quit()
  }
  const updateTray = () => {
    const nextStatus = workingId ? 'running' : hiddenWindow ? 'hidden' : undefined
    if (trayStatus === nextStatus) {
      return
    }
    if (!nextStatus) {
      tray?.destroy()
      tray = undefined
    } else {
      if (!tray) {
        tray = new Tray(path.join(__dirname, '..', 'dist', 'startup-mark.png'))
        tray.on('click', openWindow)
      }
      const running = nextStatus === 'running'
      tray.setToolTip(
        running ? label('FreeSeek · 目标在后台运行', 'FreeSeek · Goal is running') : 'FreeSeek'
      )
      const items = [{ label: label('打开 FreeSeek', 'Open FreeSeek'), click: openWindow }]
      if (running) {
        items.push({
          label: label('暂停目标', 'Pause goal'),
          click: () => void pauseActive().catch(pauseFailure),
        })
      }
      items.push({
        label: running
          ? label('暂停并退出', 'Pause and quit')
          : label('退出 FreeSeek', 'Quit FreeSeek'),
        click: () => void quit(),
      })
      tray.setContextMenu(Menu.buildFromTemplate(items))
    }
    trayStatus = nextStatus
  }

  const ensureWorker = () => {
    if (initializing) {
      return initializing
    }
    worker = utilityProcess.fork(path.join(__dirname, 'agentWorker.cjs'), [], {
      serviceName: 'FreeSeek Agent',
    })
    worker.on('message', (message) => {
      if (message.type === 'state') {
        workingId = message.status === 'running' ? message.id : undefined
        updateTray()
      } else {
        const item = pending.get(message.seq)
        if (item) {
          clearTimeout(item.timeout)
          pending.delete(message.seq)
          if (message.error) {
            item.reject(new Error(message.error))
          } else {
            item.resolve(message.value)
          }
        }
      }
    })
    worker.on('exit', () => {
      worker = undefined
      workingId = undefined
      initializing = undefined
      for (const item of pending.values()) {
        clearTimeout(item.timeout)
        item.reject(new Error('agent-host-unavailable'))
      }
      pending.clear()
      updateTray()
    })
    initializing = request('init', { root: path.join(app.getPath('userData'), 'agent-runs') })
    return initializing
  }
  for (const method of channels) {
    ipcMain.handle('freeseek:goal:' + method, async (event, args) => {
      if (!isTrusted(event)) {
        throw new Error('not-allowed')
      }
      if (method === 'permission') {
        return { granted: true }
      }
      await ensureWorker()
      return request(method, args ?? {})
    })
  }

  powerMonitor.on('suspend', () => void pauseActive().catch(() => {}))
  app.on('before-quit', (event) => {
    if (workingId && !quitting) {
      event.preventDefault()
      void quit()
    }
  })

  return {
    attach(window) {
      const clearHidden = () => {
        if (hiddenWindow === window) {
          hiddenWindow = undefined
          updateTray()
        }
      }
      window.on('show', clearHidden)
      window.on('closed', clearHidden)
      window.on('close', (event) => {
        if (!workingId || quitting) {
          return
        }
        event.preventDefault()
        if (closing || waitingToQuit) {
          return
        }
        closing = true
        void dialog
          .showMessageBox(window, {
            type: 'question',
            message: label('目标仍在运行', 'Your goal is running'),
            buttons: [
              label('继续在托盘运行', 'Continue in tray'),
              label('暂停并退出', 'Pause and quit'),
              label('取消', 'Cancel'),
            ],
            defaultId: 0,
            cancelId: 2,
          })
          .then(({ response }) => {
            if (response === 0 && !window.isDestroyed()) {
              hiddenWindow = window
              window.hide()
              updateTray()
            } else if (response === 1) {
              void quit()
            }
          })
          .finally(() => {
            closing = false
          })
      })
    },
  }
}

module.exports = { registerAgentHost }
