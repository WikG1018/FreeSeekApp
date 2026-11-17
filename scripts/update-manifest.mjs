import { readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { basename } from 'node:path'

// Release 附件镜像不一定支持 api.github.com；同时发布相同来源的独立清单。
const [apkPath, notesPath, output = 'update.json'] = process.argv.slice(2)
if (!apkPath) {
  throw new Error('Usage: node scripts/update-manifest.mjs APK [NOTES.md] [OUTPUT.json]')
}
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const tag = `v${version}`,
  name = `freeseek-${tag}-release.apk`
if (basename(apkPath) !== name) {
  throw new Error(`Expected APK filename ${name}`)
}
const hash = createHash('sha256')
for await (const chunk of createReadStream(apkPath)) {
  hash.update(chunk)
}
const repo = 'https://github.com/WikG1018/FreeSeekApp'
const result = {
  tag_name: tag,
  body: notesPath ? await readFile(notesPath, 'utf8') : '',
  published_at: new Date().toISOString(),
  html_url: `${repo}/releases/tag/${tag}`,
  assets: [
    {
      name,
      size: (await stat(apkPath)).size,
      browser_download_url: `${repo}/releases/download/${tag}/${name}`,
      digest: `sha256:${hash.digest('hex')}`,
    },
  ],
}
await writeFile(output, JSON.stringify(result, null, 2) + '\n')
console.log(`Created ${output} for ${tag} (${result.assets[0].size} bytes)`)
