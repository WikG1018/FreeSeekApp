#!/usr/bin/env node
/**
 * 采集 GitHub 上的发行数据，零后端。
 *
 * 产出（提交回仓库，供 README / 页面展示）：
 * - docs/stats/downloads.csv  长表：日期、版本、该版本累计下载、当天全部版本累计
 * - docs/stats/traffic.csv    仓库访问/克隆（需要 push 权限，取不到就跳过）
 * - docs/stats/trend.svg      总下载量走势图
 * - docs/stats/README.md      最新数字摘要
 *
 * 用法：
 *   GITHUB_TOKEN=xxx node scripts/collect-stats.mjs [owner/repo]
 * 不带 token 也能跑（未认证 API 限 60 次/小时），但 traffic 接口会 403。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(root, 'docs', 'stats')
const REPO = process.argv[2] ?? process.env.STATS_REPO ?? 'WikG1018/FreeSeekApp'
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
const today = new Date().toISOString().slice(0, 10)

const api = async (path) => {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      'User-Agent': 'FreeSeek-stats',
    },
  })
  if (!response.ok) {
    throw new Error(`${path} -> HTTP ${response.status}`)
  }
  return response.json()
}

const parseCsv = (file) => {
  if (!existsSync(file)) {
    return { header: null, rows: [] }
  }
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  const header = lines.shift()?.split(',') ?? null
  return { header, rows: lines.filter(Boolean).map((line) => line.split(',')) }
}

const writeCsv = (file, header, rows) => {
  writeFileSync(file, [header.join(','), ...rows.map((row) => row.join(','))].join('\n') + '\n', 'utf8')
}

/** 同一日期重复运行时就地更新，不产生重复行 */
const upsert = (rows, predicate, next) => {
  const index = rows.findIndex(predicate)
  if (index >= 0) {
    rows[index] = next
  } else {
    rows.push(next)
  }
}

const sparkline = (values, width = 640, height = 140) => {
  if (values.length === 0) {
    return ''
  }
  const max = Math.max(...values, 1)
  const step = values.length > 1 ? width / (values.length - 1) : 0
  const points = values
    .map((value, index) => {
      const x = (index * step).toFixed(1)
      const y = (height - 12 - (value / max) * (height - 24)).toFixed(1)
      return `${x},${y}`
    })
    .join(' ')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="下载量趋势">
  <rect width="${width}" height="${height}" fill="#f6f8fc" rx="12"/>
  ${values.length === 1 ? `<circle cx="${width / 2}" cy="${(height - 12 - (values[0] / Math.max(values[0], 1)) * (height - 24)).toFixed(1)}" r="4" fill="#2563eb"/>` : ''}
  <polyline fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="${points}"/>
  <polyline fill="url(#g)" stroke="none" points="0,${height} ${points} ${width},${height}"/>
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2563eb" stop-opacity="0.22"/><stop offset="1" stop-color="#2563eb" stop-opacity="0"/></linearGradient></defs>
  <text x="12" y="${height - 8}" font-family="system-ui, sans-serif" font-size="11" fill="#6b7280">峰值 ${max} · 最新 ${values.at(-1)}</text>
</svg>
`
}

const main = async () => {
  mkdirSync(OUT_DIR, { recursive: true })

  const releases = await api(`/repos/${REPO}/releases?per_page=100`)
  const perTag = releases
    .filter((release) => !release.draft)
    .map((release) => ({
      tag: release.tag_name,
      downloads: (release.assets ?? []).reduce((sum, asset) => sum + (asset.download_count ?? 0), 0),
    }))
    .filter((item) => item.downloads >= 0)
    .sort((a, b) => (a.tag < b.tag ? 1 : -1))

  const total = perTag.reduce((sum, item) => sum + item.downloads, 0)

  // downloads.csv：长表，每天每个版本一行，便于之后透视
  const downloadsFile = join(OUT_DIR, 'downloads.csv')
  const { rows: downloadRows } = parseCsv(downloadsFile)
  for (const item of perTag) {
    upsert(
      downloadRows,
      (row) => row[0] === today && row[1] === item.tag,
      [today, item.tag, String(item.downloads), String(total)]
    )
  }
  downloadRows.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? 1 : -1) : a[0] < b[0] ? -1 : 1))
  writeCsv(downloadsFile, ['date', 'tag', 'downloads', 'total'], downloadRows)

  // traffic.csv：仓库访问与克隆，需要 push 权限
  let traffic = null
  try {
    const views = await api(`/repos/${REPO}/traffic/views`)
    const clones = await api(`/repos/${REPO}/traffic/clones`)
    traffic = { views: views.count, viewers: views.uniques, clones: clones.count, cloners: clones.uniques }
  } catch (error) {
    console.warn(`traffic 跳过（${error.message}），不影响下载统计`)
  }
  if (traffic) {
    const trafficFile = join(OUT_DIR, 'traffic.csv')
    const { rows: trafficRows } = parseCsv(trafficFile)
    upsert(trafficRows, (row) => row[0] === today, [
      today,
      String(traffic.views),
      String(traffic.viewers),
      String(traffic.clones),
      String(traffic.cloners),
    ])
    trafficRows.sort((a, b) => (a[0] < b[0] ? -1 : 1))
    writeCsv(trafficFile, ['date', 'views', 'unique_visitors', 'clones', 'unique_cloners'], trafficRows)
  }

  // 按日期取「当天全部版本累计」，画趋势
  const totalsByDate = new Map()
  for (const row of downloadRows) {
    totalsByDate.set(row[0], Number(row[3]) || 0)
  }
  const dates = [...totalsByDate.keys()].sort()
  const series = dates.map((date) => totalsByDate.get(date))
  writeFileSync(join(OUT_DIR, 'trend.svg'), sparkline(series), 'utf8')

  // 摘要页
  const table = perTag.map((item) => `| ${item.tag} | ${item.downloads} |`).join('\n')
  const first = series[0] ?? 0
  const lastValue = series.at(-1) ?? 0
  writeFileSync(
    join(OUT_DIR, 'README.md'),
    `# 发行数据

> 由 \`scripts/collect-stats.mjs\` 每日自动采集，只读 GitHub 公开数据，不含任何 App 内埋点。

![趋势](trend.svg)

- **累计下载**：${total}
- **统计起始**：${dates[0] ?? today}（当时 ${first}）
- **最近一次采集**：${today}（${lastValue}）
- **采集天数**：${dates.length}

## 各版本累计下载

| 版本 | 下载 |
| --- | --- |
${table}

## 说明

- 统计的是 **Release 资源下载次数**，不是用户数：重装、换机、镜像下载都不计入。
- GitHub 会过滤部分重复请求，数字偏保守；反代镜像的下载完全统计不到。
- 想要真实的活跃用户数，需要 App 内匿名心跳 + 一个后端，这个仓库目前**没有**做。

原始数据：[downloads.csv](downloads.csv) · [traffic.csv](traffic.csv)
`,
    'utf8'
  )

  console.log(`采集完成：${REPO} ${today} 累计下载 ${total}，版本 ${perTag.length} 个，趋势点 ${series.length} 个`)
}

main().catch((error) => {
  console.error('采集失败：', error.message)
  process.exit(1)
})
