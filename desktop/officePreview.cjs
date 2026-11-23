const { app, ipcMain } = require('electron')
const { execFile } = require('node:child_process')
const { existsSync } = require('node:fs')
const { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { promisify } = require('node:util')

const run = promisify(execFile)
const maxBytes = 48 * 1024 * 1024
const office = () => [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
  .filter(Boolean)
  .map((dir) => path.join(dir, 'LibreOffice', 'program', 'soffice.com'))
  .find((file) => path.isAbsolute(file) && existsSync(file))

const registry = '<?xml version="1.0" encoding="UTF-8"?>' +
  '<oor:items xmlns:oor="http://openoffice.org/2001/registry">' +
  '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">' +
  '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>' +
  '<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>' +
  '</item></oor:items>'

const registerOfficePreview = (isTrusted) => {
  let inFlight = false
  ipcMain.handle('freeseek:file:office-layout', async (event, args) => {
    const { kind, bytes } = args ?? {}
    if (
      !isTrusted(event) || !['docx', 'pptx'].includes(kind) ||
      !(bytes instanceof Uint8Array) || bytes.length < 4 || bytes.length > maxBytes ||
      bytes[0] !== 0x50 || bytes[1] !== 0x4b
    ) throw new Error('Invalid Office preview input')
    const executable = office()
    if (!executable || inFlight) return null
    inFlight = true
    let temporary
    try {
      const root = await realpath(app.getPath('temp'))
      temporary = await mkdtemp(path.join(root, 'freeseek-office-'))
      const profile = path.join(temporary, 'profile')
      const input = path.join(temporary, 'preview.' + kind)
      await mkdir(path.join(profile, 'user'), { recursive: true })
      await writeFile(path.join(profile, 'user', 'registrymodifications.xcu'), registry)
      await writeFile(input, bytes, { flag: 'wx' })
      await run(executable, [
        '-env:UserInstallation=' + pathToFileURL(profile).href,
        '--headless', '--nologo', '--nodefault', '--norestore',
        '--convert-to', kind === 'docx' ? 'pdf:writer_pdf_Export' : 'pdf:impress_pdf_Export',
        '--outdir', temporary, input,
      ], { timeout: 20_000, windowsHide: true, maxBuffer: 64 * 1024 })
      const output = path.join(temporary, 'preview.pdf')
      const size = (await stat(output)).size
      if (size > maxBytes) return null
      const pdf = await readFile(output)
      return pdf.subarray(0, 5).toString() === '%PDF-' ? new Uint8Array(pdf) : null
    } catch {
      return null
    } finally {
      inFlight = false
      if (temporary) {
        const resolved = await realpath(temporary).catch(() => '')
        const root = await realpath(app.getPath('temp')).catch(() => '')
        if (root && path.dirname(resolved) === root &&
          path.basename(resolved).startsWith('freeseek-office-')) {
          await rm(resolved, { recursive: true, force: true }).catch(() => {})
        }
      }
    }
  })
}

module.exports = { registerOfficePreview }
