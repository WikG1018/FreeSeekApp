import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const roots = [
  '@jitl/quickjs-wasmfile-release-sync',
  '@jitl/quickjs-wasmfile-release-sync-legacy',
  'quickjs-emscripten-core',
  'linkedom',
  'es-module-lexer',
  'docx-preview',
  'pptx-browser',
  'pdfjs-dist',
  'ssf',
  '@deepseek-ai/dsh-fs-patch',
  'three',
  'diff',
]

const packageManifest = (require, name) => {
  try {
    return require.resolve(name + '/package.json')
  } catch {
    // Some packages export just their entry point.
    let directory = path.dirname(require.resolve(name))
    while (true) {
      const manifest = path.join(directory, 'package.json')
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) {
        return manifest
      }
      const parent = path.dirname(directory)
      if (parent === directory) {
        throw new Error('Unable to locate browser dependency ' + name)
      }
      directory = parent
    }
  }
}

export const browserLicensePatterns = () => {
  const seen = new Set()
  const patterns = []
  const visit = (require, name) => {
    const manifest = packageManifest(require, name)
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    const id = pkg.name.replace(/[^a-z0-9-]/gi, '-') + '-' + pkg.version
    if (seen.has(id)) {
      return
    }
    seen.add(id)
    const folder = path.dirname(manifest)
    const files = readdirSync(folder)
    const license =
      files.find((file) => /^(?:LICENSE|COPYING)(?:\.(?:txt|md|markdown))?$/i.test(file)) ??
      files.find(
        (file) =>
          /^README\.(?:md|markdown)$/i.test(file) &&
          /^## License\s*[\s\S]*?Permission is hereby granted/m.test(
            readFileSync(path.join(folder, file), 'utf8')
          )
      )
    if (!license) {
      throw new Error('Missing browser license for ' + pkg.name)
    }
    for (const file of [license, 'NOTICE', 'NOTICE.txt']) {
      const from = path.join(folder, file)
      if (existsSync(from)) {
        patterns.push({ from, to: 'static/third-party/' + id + '/' + file, toType: 'file' })
      }
    }
    const next = createRequire(manifest)
    for (const dependency of Object.keys(pkg.dependencies ?? {})) {
      visit(next, dependency)
    }
  }
  const require = createRequire(import.meta.url)
  for (const name of roots) {
    visit(require, name)
  }
  return patterns
}
