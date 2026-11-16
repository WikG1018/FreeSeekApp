/**
 * 畅聊 FreeSeek — 端到端 UI 冒烟测试（Playwright / Chromium）
 * 前置：dev server 运行在 http://localhost:8090
 * 运行：node check.mjs
 * 覆盖：应用加载、人设选择与管理、用量面板、设置弹窗、存储键隔离（freeseek: 前缀）。
 */
import { chromium } from 'playwright'

const BASE = 'http://localhost:8090'
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch()
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))

try {
  // 1. 应用加载（中文 locale）
  await page.goto(BASE, { waitUntil: 'networkidle' })
  check('页面标题为「畅聊」', (await page.title()) === '畅聊', await page.title())

  // 无 API Key 时设置弹窗会自动打开，先用 Esc 关掉
  for (let i = 0; i < 3; i += 1) {
    if ((await page.locator('[role="dialog"]').count()) === 0) {
      break
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
  check('首启设置弹窗已关闭', (await page.locator('[role="dialog"]').count()) === 0)

  await page.waitForSelector('text=今天有什么可以帮到你', { timeout: 10000 })
  // 2. 欢迎页渲染：人设 chips
  const chips = page.locator('[class*="personaChip"]')
  const chipCount = await chips.count()
  check('人设 chips 渲染（6 内置 + 管理 = 7）', chipCount === 7, `count=${chipCount}`)
  const chipTexts = await chips.allTextContents()
  check('内置人设包含小红书文案', chipTexts.includes('小红书文案'), chipTexts.join(','))

  // 3. 点选人设 → localStorage 写入 freeseek:default-persona
  await chips.filter({ hasText: '写作助手' }).click()
  const defaultPersona = await page.evaluate(() => localStorage.getItem('freeseek:default-persona'))
  check('选择人设写入 freeseek:default-persona', defaultPersona === 'builtin-writer', String(defaultPersona))
  const activeChip = await chips.filter({ hasText: '写作助手' }).getAttribute('class')
  check('选中人设有激活态样式', (activeChip ?? '').includes('Active'), String(activeChip))

  // 4. 人设管理弹窗：新建一个自定义人设
  await chips.filter({ hasText: '管理人设' }).click()
  await page.waitForSelector('text=人设与提示词')
  await page.getByRole('button', { name: '新建人设' }).click()
  await page.locator('#persona-name').fill('测试猫娘')
  await page.locator('#persona-prompt').fill('你是测试用的人设。')
  await page.getByRole('button', { name: '保存' }).click()
  await page.waitForSelector('text=测试猫娘')
  check('自定义人设创建成功', true)
  await page.getByRole('button', { name: '关闭', exact: true }).first().click()
  await page.waitForTimeout(300)
  const customChips = page.locator('[class*="personaChip"]')
  check('欢迎页出现自定义人设 chip', (await customChips.filter({ hasText: '测试猫娘' }).count()) === 1)

  // 5. 用量与费用面板
  await page.getByRole('button', { name: '用量与费用' }).click()
  await page.waitForSelector('text=暂无用量记录')
  check('用量面板打开并显示空态', true)
  await page.getByRole('button', { name: '关闭', exact: true }).first().click()
  await page.waitForTimeout(300)

  // 6. 设置弹窗
  await page.getByRole('button', { name: '设置' }).click()
  await page.waitForSelector('[class*="settingsDialog"], [role="dialog"]', { timeout: 5000 })
  check('设置弹窗可打开', true)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // 7. 存储键隔离：不得出现 chat-demo: 前缀
  const foreignKeys = await page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith('chat-demo:'))
  )
  check('无 chat-demo: 前缀的存储键（与官方 demo 隔离）', foreignKeys.length === 0, foreignKeys.join(','))

  // 8. IndexedDB 名称为 freeseek
  const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name))
  check('IndexedDB 名为 freeseek', dbs.includes('freeseek'), String(dbs))

  // 9. 无未捕获的页面错误
  const realErrors = pageErrors.filter((e) => !e.includes('favicon'))
  check('无未捕获页面错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
} catch (error) {
  check('测试流程执行', false, String(error).slice(0, 300))
} finally {
  await context.close()
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
