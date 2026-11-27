const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const LIMIT = 160
const RETENTION = 7 * 24 * 60 * 60_000
const MAX_BYTES = 256 * 1024

const createDesktopDiagnostics = (app) => {
  const file = path.join(app.getPath('userData'), 'freeseek-desktop-diagnostics.json')
  const pending = file + '.new'
  const runId = randomUUID()
  let events = []
  let readFailure
  let failedWrites = 0
  const retained = () => events.filter(({ timestamp }) => timestamp > Date.now() - RETENTION).slice(-LIMIT)
  try {
    if (fs.statSync(file).size > MAX_BYTES) {
      readFailure = 'size-limit'
    } else {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!Array.isArray(stored)) throw new Error('Invalid desktop diagnostic log')
      events = stored.filter((entry) => entry && Number.isFinite(entry.timestamp))
      events = retained()
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') readFailure = 'unreadable'
  }

  // Only application-defined events and metadata enter this journal.
  const record = (event, details = {}, level = 'info') => {
    events.push({ timestamp: Date.now(), runId, scope: 'app', event, level, details })
    events = retained()
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(pending, JSON.stringify(events))
      fs.renameSync(pending, file)
    } catch {
      failedWrites++
    }
  }

  return {
    record,
    snapshot: () => ({
      events: retained(),
      failedWrites,
      readFailure,
      environment: {
        platform: os.platform(),
        architecture: os.arch(),
        osRelease: os.release(),
        version: app.getVersion(),
        electronVersion: process.versions.electron,
        chromiumVersion: process.versions.chrome,
        systemTotalMemoryBytes: os.totalmem(),
        systemAvailableMemoryBytes: os.freemem(),
      },
    }),
  }
}

module.exports = { createDesktopDiagnostics }
