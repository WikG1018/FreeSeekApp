const { app, clipboard, ClipboardItem, ipcMain, shell } = require('electron')
const { mkdir, readdir, rmdir, stat, unlink, writeFile } = require('node:fs/promises')
const { randomUUID } = require('node:crypto')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const channel = 'freeseek:file:copy-task-output'
const validName = (name) =>
  typeof name === 'string' &&
  /^[^\p{Cc}<>:"/\\|?*]{1,81}\.(xlsx|docx|pdf|pptx|md|csv|json|txt|zip|glb|stl|patch)$/iu.test(name) &&
  !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name)

const clearExpired = async (root) => {
  const now = Date.now()
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue
    const directory = path.join(root, entry.name)
    if (now - (await stat(directory)).mtimeMs < 24 * 60 * 60 * 1000) continue
    for (const file of await readdir(directory, { withFileTypes: true })) {
      if (file.isFile() && validName(file.name)) await unlink(path.join(directory, file.name))
    }
    await rmdir(directory).catch(() => {})
  }
}

const registerOutputShare = (isTrusted) => {
  const handle = (action) => async (event, options) => {
    const { name, bytes } = options ?? {}
    if (
      !isTrusted(event) ||
      !validName(name) ||
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < 1 ||
      bytes.byteLength > 128 * 1024 * 1024
    ) {
      throw new Error('Invalid output file')
    }

    const root = path.join(app.getPath('userData'), 'task-shares')
    await mkdir(root, { recursive: true })
    // Refresh the clipboard immediately even if an older exported file is still open.
    void clearExpired(root).catch(() => {})
    const directory = path.join(root, randomUUID())
    await mkdir(directory)
    const file = path.join(directory, name)
    try {
      await writeFile(file, bytes, { flag: 'wx' })
      if (action === 'open') {
        if (await shell.openPath(file)) throw new Error('No document viewer')
      } else {
        await clipboard.write([new ClipboardItem({ 'text/uri-list': pathToFileURL(file).href })])
      }
    } catch {
      await unlink(file).catch(() => {})
      await rmdir(directory).catch(() => {})
      throw new Error('Unable to copy output file')
    }
  }
  ipcMain.handle(channel, handle('copy'))
  ipcMain.handle('freeseek:file:open-task-output', handle('open'))
}

module.exports = { registerOutputShare }
