import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@rspack/cli'
import { browserLicensePatterns } from './scripts/browser-license-patterns.mjs'
import { rspack, type Compiler, type Configuration } from '@rspack/core'

// 以 CLI 子命令判断模式（serve 为开发、build 为生产），避免依赖 shell 设置 NODE_ENV
const dev = !process.argv.includes('build')
const targets = ['chrome >= 60', 'edge >= 105', 'safari >= 16', 'firefox >= 110']
const root = path.dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version: string }

// Bundle only this version's changelog so About works without network access.
const notesForCurrentVersion = (file: string) =>
  readFileSync(path.join(root, file), 'utf8')
    .replace(/\r\n?/g, '\n')
    .split(/^## /m)
    .find((section) => section.split(/\s+/)[0] === 'v' + version)
    ?.split('\n')
    .slice(1)
    .join('\n')
    .trim() ?? ''
const currentNotes = notesForCurrentVersion('CHANGELOG.md')
const currentNotesEn = notesForCurrentVersion('CHANGELOG.en.md')

const cssLoader = {
  loader: 'builtin:lightningcss-loader',
  options: { targets },
}

type ConfigOptions = {
  /** 公开 API 的地址，注入为 __API_ORIGIN__ */
  apiOrigin?: string
  /** 开发服务器配置，支持本地接口代理 */
  devServer?: Configuration['devServer']
}

/** 创建构建配置，支持自定义 API 地址和开发服务器选项 */
export const createConfig = ({
  apiOrigin = 'https://api.deepseek.com',
  devServer,
}: ConfigOptions = {}): Configuration => ({
  mode: dev ? 'development' : 'production',
  entry: './src/bootstrap.ts',
  target: ['web', 'es2017'],
  output: {
    path: path.resolve(root, 'dist'),
    // 运行时按当前脚本地址推导资源路径，file:// 下异步 chunk、字体都按相对位置加载
    publicPath: 'auto',
    filename: 'static/js/[name].[contenthash:8].js',
    chunkFilename: 'static/js/async/[name].[contenthash:8].js',
    cssFilename: 'static/css/[name].[contenthash:8].css',
    cssChunkFilename: 'static/css/async/[name].[contenthash:8].css',
    assetModuleFilename: 'static/media/[name].[contenthash:8][ext]',
    clean: true,
  },
  devtool: dev ? 'cheap-module-source-map' : false,
  // 开发模式预编译异步模块，保持首次加载代码高亮和公式时的页面状态
  lazyCompilation: false,
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    // 将 .js 导入路径解析到同名 .ts、.tsx 或 .js 文件
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
  module: {
    // CSS Modules 使用默认导出：`import styles from './x.module.css'`
    parser: { 'css/module': { namedExports: false } },
    generator: { 'css/module': { localIdentName: '[local]-[hash:6]' } },
    rules: [
      { test: /\.module\.css$/, type: 'css/module', use: [cssLoader] },
      { test: /\.css$/, exclude: /\.module\.css$/, type: 'css', use: [cssLoader] },
      {
        test: /\.[cm]?[jt]sx?$/,
        // 依赖包也可能含可选链等新语法；仅排除本身按 ES5 发布的 core-js。
        exclude: /[\\/]core-js[\\/]/,
        resourceQuery: { not: [/agent-guest/] },
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            transform: { react: { runtime: 'automatic', development: dev } },
            externalHelpers: true,
          },
          env: { targets },
        },
        type: 'javascript/auto',
      },
      { resourceQuery: /agent-guest/, type: 'asset/source' },
      { test: /\.wasm$/, type: 'asset/resource' },
      { test: /\.(woff2?|ttf)$/, type: 'asset/resource' },
      { test: /\.(png|jpe?g|svg|webp)$/, type: 'asset/resource' },
    ],
  },
  plugins: [
    // 经典 defer 脚本支持 file:// 页面的资源加载
    new rspack.HtmlRspackPlugin({
      minify: false,
      template: './src/index.html',
      scriptLoading: 'defer',
      meta: { 'application-version': version },
    }),
    {
      apply(compiler: Compiler) {
        compiler.hooks.thisCompilation.tap('FreeSeekWebVersion', (compilation) => {
          compilation.hooks.processAssets.tap(
            {
              name: 'FreeSeekWebVersion',
              stage: rspack.Compilation.PROCESS_ASSETS_STAGE_REPORT,
            },
            () => {
              const entry = compilation.entrypoints.get('main')?.getFiles() ?? []
              // The app group also contains the split dependencies needed before mounting.
              const app = compilation.namedChunkGroups.get('app')?.getFiles() ?? []
              const files = [...new Set([...entry, ...app])].filter((name) =>
                /\.(?:js|css)$/.test(name)
              )
              const worker = !dev && compilation.getAsset('sw.js')
              if (worker) {
                const source = readFileSync(path.resolve(root, 'src/pwa/sw.js'), 'utf8')
                const build = createHash('sha256')
                  .update(JSON.stringify({ version, files, source }))
                  .update(compilation.getAsset('index.html')?.source.source().toString() ?? '')
                  .digest('hex')
                  .slice(0, 16)
                compilation.updateAsset(
                  'sw.js',
                  new rspack.sources.RawSource(
                    source
                      .replace("'__FREESEEK_WEB_BUILD__'", JSON.stringify(build))
                      .replace('/* FreeSeek startup assets */ []', JSON.stringify(files))
                  )
                )
              }
              compilation.emitAsset(
                'web-version.json',
                new rspack.sources.RawSource(
                  JSON.stringify({ version, notes: currentNotes, files })
                )
              )
            }
          )
        })
      },
    },
    new rspack.DefinePlugin({
      __API_ORIGIN__: JSON.stringify(apiOrigin),
      __CURRENT_RELEASE_NOTES__: JSON.stringify(currentNotes),
      __CURRENT_RELEASE_NOTES_EN__: JSON.stringify(currentNotesEn),
    }),
    new rspack.CopyRspackPlugin({
      patterns: [
        { from: path.resolve(root, 'LICENSE'), to: 'LICENSE', toType: 'file' },
        ...browserLicensePatterns(),
        ...[
          'cmaps',
          'iccs',
          'standard_fonts',
          'wasm',
          'legacy/build/pdf.min.mjs',
          'legacy/build/pdf.worker.min.mjs',
          'legacy/build/pdf.renderer.min.mjs',
        ].map((name) => ({
          from: path.resolve(root, 'node_modules/pdfjs-dist', name),
          to: 'static/pdfjs/' + path.basename(name),
          toType: name.endsWith('.mjs') ? ('file' as const) : ('dir' as const),
        })),
        {
          from: path.resolve(root, 'src/services/tasks/pdfRuntime.mjs'),
          to: 'static/pdfjs/runtime.mjs',
          toType: 'file',
        },
        { from: path.resolve(root, 'src/assets/logo.png'), to: 'startup-mark.png', toType: 'file' },
        // 网页 App（PWA）外壳：manifest、Service Worker 与图标按原样放到站点根目录
        { from: path.resolve(root, 'src/pwa'), to: '.', toType: 'dir' },
      ],
    }),
  ],
  performance: { hints: false },
  devServer: { port: 8090, ...devServer },
})

// eslint-disable-next-line import/no-default-export
export default defineConfig(createConfig())
