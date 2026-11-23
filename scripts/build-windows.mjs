import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Arch, build, Platform } from 'electron-builder'

const root = fileURLToPath(new URL('../', import.meta.url))
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const work = path.join(root, 'build')
await mkdir(work, { recursive: true })
const stage = await mkdtemp(path.join(work, 'windows-app-'))

try {
  for (const source of ['dist', 'desktop']) {
    await cp(path.join(root, source), path.join(stage, source), { recursive: true })
  }
  await writeFile(
    path.join(stage, 'package.json'),
    JSON.stringify({
      name: 'freeseek',
      version: metadata.version,
      main: 'desktop/main.cjs',
      productName: 'FreeSeek',
      description: 'FreeSeek',
      license: 'MIT',
      author: 'FreeSeek contributors',
    })
  )

  // Signing is explicit for this app. Do not use a certificate set up for another project.
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  delete process.env.CSC_LINK
  delete process.env.WIN_CSC_LINK
  await build({
    projectDir: stage,
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    publish: 'never',
    config: {
      appId: 'app.freeseek.desktop',
      productName: 'FreeSeek',
      electronVersion: metadata.devDependencies.electron,
      npmRebuild: false,
      publish: null,
      directories: { output: path.join(work, 'windows') },
      files: ['desktop/**/*', 'dist/**/*', '!**/node_modules/**/*'],
      win: {
        icon: path.join(root, 'src/assets/logo.png'),
        artifactName: 'freeseek-v${version}-windows-x64-setup.${ext}',
      },
      nsis: {
        oneClick: false,
        perMachine: false,
        allowElevation: false,
        allowToChangeInstallationDirectory: true,
        deleteAppDataOnUninstall: false,
      },
    },
  })
} finally {
  const absoluteStage = await realpath(stage)
  if (
    path.dirname(absoluteStage) === (await realpath(work)) &&
    path.basename(absoluteStage).startsWith('windows-app-')
  ) {
    await rm(absoluteStage, { recursive: true, force: true })
  }
}
