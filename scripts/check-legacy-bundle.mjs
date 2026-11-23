import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'acorn'

// 对最终产物（含第三方依赖和懒加载包）检查，避免只转换 src 后旧机仍报语法错误。
const root = resolve('dist')
const sidecar = resolve(root, 'static/pdfjs')
let count = 0
let modern = 0
async function inspect(directory) {
  for (const file of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, file.name)
    if (file.isDirectory()) {
      await inspect(path)
    } else if (directory.startsWith(sidecar) && /\.[cm]?js$/.test(file.name)) {
      // Loaded through the document viewer only. Android PDF preview uses the native renderer.
      parse(await readFile(path, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' })
      modern++
    } else if (file.name.endsWith('.js')) {
      try {
        parse(await readFile(path, 'utf8'), { ecmaVersion: 2019, sourceType: 'script' })
      } catch (error) {
        throw new Error(`Legacy JavaScript parse failed: ${path}`, { cause: error })
      }
      count++
    }
  }
}
await inspect(root)
const html = await readFile(resolve(root, 'index.html'), 'utf8')
for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
  if (match[1].trim()) {
    parse(match[1], { ecmaVersion: 5, sourceType: 'script' })
  }
}
console.log(
  `legacy syntax: ${count} JavaScript bundles pass ES2019; inline startup guard passes ES5; ${modern} lazy PDF modules checked separately`
)
