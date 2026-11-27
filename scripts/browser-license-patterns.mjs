import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

// These exact releases omitted the shared MIT text from their npm files.
const micromarkLicense = fileURLToPath(new URL('./licenses/micromark-2.0.0.txt', import.meta.url))
const micromarkPackages = new Set([
  'micromark-factory-destination',
  'micromark-factory-label',
  'micromark-factory-title',
  'micromark-factory-whitespace',
  'micromark-util-chunked',
  'micromark-util-classify-character',
  'micromark-util-combine-extensions',
  'micromark-util-decode-numeric-character-reference',
  'micromark-util-html-tag-name',
  'micromark-util-normalize-identifier',
  'micromark-util-resolve-all',
  'micromark-util-subtokenize',
])

const packageId = ({ name, version }) => name.replace(/[^a-z0-9-]/gi, '-') + '-' + version

const findLicense = (folder) => {
  const files = readdirSync(folder)
  return (
    files.find((file) => /^(?:LICENSE|COPYING)(?:\.(?:txt|md|markdown))?$/i.test(file)) ??
    files.find(
      (file) =>
        /^README\.(?:md|markdown)$/i.test(file) &&
        /^## License\s*[\s\S]*?Permission is hereby granted/m.test(
          readFileSync(path.join(folder, file), 'utf8')
        )
    )
  )
}

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
    const id = packageId(pkg)
    if (seen.has(id)) {
      return
    }
    seen.add(id)
    const folder = path.dirname(manifest)
    const license = findLicense(folder)
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

// A package can enter the build through a dependency or a transpiler helper.
// Read only the modules that contributed to emitted chunks.
export const bundledBrowserLicenses = (chunks, root) => {
  const folders = new Set()
  const collect = (module) => {
    const resource = module.nameForCondition?.replaceAll('\\', '/') ?? ''
    const dependency = '/node_modules/'
    const index = resource.lastIndexOf(dependency)
    if (index >= 0) {
      const end = index + dependency.length
      const name = /^((?:@[^/]+\/)?[^/]+)\//.exec(resource.slice(end))?.[1]
      if (name) folders.add(path.resolve(root, resource.slice(0, end) + name))
    }
    for (const child of module.modules ?? []) collect(child)
    for (const child of module.children ?? []) collect(child)
  }
  for (const chunk of chunks) for (const module of chunk.modules ?? []) collect(module)

  const assets = new Map()
  for (const folder of folders) {
    const manifest = path.join(folder, 'package.json')
    if (!existsSync(manifest)) continue
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    if (!pkg.name || !pkg.version) continue
    const prefix = 'static/third-party/' + packageId(pkg) + '/'
    const license = findLicense(folder)
    if (!license && pkg.version === '2.0.0' && micromarkPackages.has(pkg.name)) {
      assets.set(prefix + 'LICENSE', readFileSync(micromarkLicense))
    }
    for (const file of [license, 'NOTICE', 'NOTICE.txt'].filter(Boolean)) {
      const source = path.join(folder, file)
      if (existsSync(source)) assets.set(prefix + file, readFileSync(source))
    }
  }
  return assets
}
