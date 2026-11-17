#!/usr/bin/env node
/**
 * 本机统计面板：只监听 127.0.0.1，别的机器连不上。
 *
 *   node scripts/stats-dashboard.mjs [--port 8092]
 *
 * 数据来源（只读）：
 * - GitHub 公开 API：各版本累计下载、仓库访问/克隆（需要 token 才能看 traffic）
 * - docs/stats/*.csv：每日归档，用来算增量和画趋势
 *
 * 没有外链 CDN，图表是手写 SVG，断网也能打开。
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = process.env.STATS_REPO ?? 'WikG1018/FreeSeekApp'
const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8092
const CACHE_MS = 60_000

const token = (() => {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
})()

const csv = (name) => {
  const file = join(root, 'docs', 'stats', name)
  if (!existsSync(file)) return []
  const [header, ...lines] = readFileSync(file, 'utf8').trim().split('\n')
  const keys = header.split(',')
  return lines.filter(Boolean).map((line) => {
    const values = line.split(',')
    return Object.fromEntries(keys.map((key, index) => [key, values[index]]))
  })
}

const api = async (path) => {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'FreeSeek-dashboard',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}`)
  return response.json()
}

let cache = { at: 0, data: null }

const collect = async () => {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data
  const releases = await api(`/repos/${REPO}/releases?per_page=100`)
  const versions = releases
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => ({
      tag: release.tag_name,
      name: release.name ?? release.tag_name,
      published: release.published_at?.slice(0, 10) ?? '',
      downloads: (release.assets ?? []).reduce((sum, asset) => sum + (asset.download_count ?? 0), 0),
      assets: release.assets?.length ?? 0,
      url: release.html_url,
    }))
  let traffic = null
  try {
    const views = await api(`/repos/${REPO}/traffic/views`)
    traffic = { views: views.count, viewers: views.uniques, days: views.views }
  } catch {
    traffic = null
  }
  const repo = await api(`/repos/${REPO}`)
  const data = {
    versions,
    traffic,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    total: versions.reduce((sum, item) => sum + item.downloads, 0),
    history: csv('downloads.csv'),
    trafficHistory: csv('traffic.csv'),
  }
  cache = { at: Date.now(), data }
  return data
}

const esc = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const lineChart = (points, { width = 880, height = 220, label = '' } = {}) => {
  if (points.length === 0) return '<p class="empty">还没有历史数据，明天开始有趋势。</p>'
  const max = Math.max(...points.map((p) => p.value), 1)
  const min = Math.min(...points.map((p) => p.value), 0)
  const span = Math.max(max - min, 1)
  const padX = 44
  const padY = 24
  const stepX = points.length > 1 ? (width - padX * 2) / (points.length - 1) : 0
  const toX = (index) => padX + index * stepX
  const toY = (value) => height - padY - ((value - min) / span) * (height - padY * 2)
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(p.value).toFixed(1)}`).join(' ')
  const area = `${path} L${toX(points.length - 1).toFixed(1)},${height - padY} L${padX},${height - padY} Z`
  const dots = points
    .map((p, i) => `<circle cx="${toX(i).toFixed(1)}" cy="${toY(p.value).toFixed(1)}" r="3" fill="#2563eb"><title>${esc(p.label)} · ${p.value}</title></circle>`)
    .join('')
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((ratio) => {
      const y = padY + (height - padY * 2) * ratio
      const value = Math.round(max - (span * ratio))
      return `<line x1="${padX}" y1="${y}" x2="${width - padX}" y2="${y}" stroke="#eef1f6"/><text x="${padX - 8}" y="${y + 4}" text-anchor="end" class="axis">${value}</text>`
    })
    .join('')
  return `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="${esc(label)}">
    ${grid}
    <path d="${area}" fill="url(#area)"/>
    <path d="${path}" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linejoin="round"/>
    ${dots}
    <defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2563eb" stop-opacity=".22"/><stop offset="1" stop-color="#2563eb" stop-opacity="0"/></linearGradient></defs>
  </svg>`
}

const render = (data, error) => {
  const { versions, total, traffic, stars, forks, history } = data
  const byDate = new Map()
  for (const row of history) {
    const value = Number(row.total) || 0
    byDate.set(row.date, Math.max(byDate.get(row.date) ?? 0, value))
  }
  const dates = [...byDate.keys()].sort()
  const points = dates.map((date) => ({ label: date, value: byDate.get(date) }))
  const latestDate = dates.at(-1)
  const previousDate = dates.at(-2)
  const delta = latestDate && previousDate ? byDate.get(latestDate) - byDate.get(previousDate) : null
  const maxVersion = Math.max(...versions.map((v) => v.downloads), 1)
  const updated = new Date().toLocaleString('zh-CN', { hour12: false })

  const versionRows = versions
    .map(
      (version) => `<tr>
        <td><a href="${esc(version.url)}" target="_blank" rel="noreferrer">${esc(version.tag)}</a></td>
        <td>${esc(version.published)}</td>
        <td class="num">${version.downloads}</td>
        <td class="bar-cell"><span class="bar" style="width:${Math.round((version.downloads / maxVersion) * 100)}%"></span></td>
        <td class="num">${total > 0 ? Math.round((version.downloads / total) * 100) : 0}%</td>
      </tr>`
    )
    .join('')

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="120">
<title>FreeSeek 发行数据</title>
<style>
  :root { color-scheme: light; --ink:#0f172a; --muted:#64748b; --line:#e6ebf3; --brand:#2563eb; --bg:#f6f8fc; }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 20px 64px; background:var(--bg); color:var(--ink);
         font:14px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
  .wrap { max-width:960px; margin:0 auto; }
  header { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:20px; }
  h1 { margin:0; font-size:22px; letter-spacing:-0.01em; }
  .meta { color:var(--muted); font-size:12px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:16px; }
  .card { padding:16px 18px; border-radius:16px; background:#fff; box-shadow:0 0 0 1px var(--line); }
  .card .label { color:var(--muted); font-size:12px; }
  .card .value { margin-top:4px; font-size:28px; font-weight:650; font-variant-numeric:tabular-nums; letter-spacing:-0.02em; }
  .card .hint { margin-top:2px; color:var(--muted); font-size:11px; }
  .panel { padding:18px; border-radius:18px; background:#fff; box-shadow:0 0 0 1px var(--line); margin-bottom:16px; }
  .panel h2 { margin:0 0 4px; font-size:14px; }
  .panel .sub { margin:0 0 12px; color:var(--muted); font-size:12px; }
  .chart { width:100%; height:auto; display:block; }
  .axis { fill:#94a3b8; font-size:10px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { padding:9px 8px; text-align:left; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:500; font-size:12px; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  a { color:var(--brand); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .bar-cell { width:32%; }
  .bar { display:block; height:8px; border-radius:4px; background:linear-gradient(90deg,#2563eb,#60a5fa); }
  .empty { color:var(--muted); font-size:13px; }
  .error { margin-bottom:16px; padding:12px 14px; border-radius:12px; background:#fef2f2; color:#b91c1c; box-shadow:0 0 0 1px #fecaca; font-size:13px; }
  footer { color:var(--muted); font-size:12px; text-align:center; }
  code { background:#eef2f7; padding:1px 5px; border-radius:5px; font-size:12px; }
</style>
</head><body><div class="wrap">
  <header>
    <div>
      <h1>FreeSeek 发行数据</h1>
      <div class="meta">${esc(REPO)} · 每 2 分钟自动刷新 · 仅本机可访问</div>
    </div>
    <div class="meta">更新于 ${esc(updated)}</div>
  </header>
  ${error ? `<div class="error">拉取失败：${esc(error)}（显示的是本地归档数据）</div>` : ''}
  <div class="cards">
    <div class="card"><div class="label">累计下载</div><div class="value">${total}</div><div class="hint">所有版本合计</div></div>
    <div class="card"><div class="label">较上次采集</div><div class="value">${delta === null ? '—' : (delta >= 0 ? '+' : '') + delta}</div><div class="hint">${esc(latestDate ?? '')}</div></div>
    <div class="card"><div class="label">版本数</div><div class="value">${versions.length}</div><div class="hint">含已下架</div></div>
    <div class="card"><div class="label">仓库访问</div><div class="value">${traffic ? traffic.views : '—'}</div><div class="hint">${traffic ? `${traffic.viewers} 位访客 / 14 天` : '需要 token'}</div></div>
    <div class="card"><div class="label">Star / Fork</div><div class="value">${stars}<span style="font-size:16px;color:#94a3b8"> / ${forks}</span></div><div class="hint">公开仓库</div></div>
  </div>

  <section class="panel">
    <h2>下载量趋势</h2>
    <p class="sub">按天累计值，起点 ${esc(dates[0] ?? '—')}；每天 09:10 自动采集一次</p>
    ${lineChart(points, { label: '累计下载趋势' })}
  </section>

  <section class="panel">
    <h2>各版本下载</h2>
    <p class="sub">统计的是 Release 资源下载次数，不是用户数</p>
    <table>
      <thead><tr><th>版本</th><th>发布</th><th class="num">下载</th><th></th><th class="num">占比</th></tr></thead>
      <tbody>${versionRows || '<tr><td colspan="5" class="empty">暂无发行版</td></tr>'}</tbody>
    </table>
  </section>

  <footer>数据只读自 GitHub；面板绑定 <code>127.0.0.1:${PORT}</code>，不对外暴露。按 Ctrl+C 停止。</footer>
</div></body></html>`
}

const server = createServer(async (request, response) => {
  if (request.url === '/favicon.ico') {
    response.writeHead(204)
    response.end()
    return
  }
  try {
    const data = await collect()
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(render(data))
  } catch (error) {
    // API 失败时退回本地归档，页面仍可用
    const fallback = {
      versions: [],
      total: 0,
      traffic: null,
      stars: 0,
      forks: 0,
      history: csv('downloads.csv'),
      trafficHistory: csv('traffic.csv'),
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(render(fallback, error.message))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`统计面板已启动：http://127.0.0.1:${PORT}`)
  console.log(`数据源：${REPO}${token ? '（已带 token，可看访问量）' : '（无 token，访问量不可用）'}`)
})
