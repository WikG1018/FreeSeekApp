import assert from 'node:assert/strict'

const dialog = (page) => page.getByRole('dialog').last()
const back = (page) => dialog(page).getByRole('button', { name: '返回', exact: true }).click()

export const runInterfaceCases = async ({ run }) => {
  await run(
    'API tutorial leads the page, all official links stay accessible, and a verified key and model survive reopening',
    async (page) => {
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('home'))
      await page.getByRole('button', { name: /API 服务/ }).click()
      const area = page.locator('[data-settings-page="account"]')
      assert.equal(
        await area.locator(':scope > :first-child').getAttribute('data-testid'),
        'api-tutorial'
      )
      assert.equal(
        await area.locator(':scope > :last-child button').getAttribute('data-settings-target'),
        'providers'
      )
      const guide = page.getByTestId('api-tutorial')
      assert.equal(await guide.getByRole('listitem').count(), 4)
      for (const name of ['打开「创建 API Key」页面', '打开「充值」页面', '打开「余额」页面'])
        assert.ok(await guide.getByRole('button', { name, exact: true }).isVisible())
      const disclosure = guide.getByRole('button', { name: /如何获取 API Key/ })
      await disclosure.click()
      await page.getByLabel('API Key', { exact: true }).fill('synthetic-ui-verified-key')
      await page.evaluate(() => {
        const original = window.fetch
        window.fetch = (url, ...args) =>
          String(url).endsWith('/models')
            ? Promise.resolve(new Response('{"data":[]}', { status: 200 }))
            : original(url, ...args)
      })
      await page.getByRole('button', { name: '验证并保存', exact: true }).click()
      await page.getByText('已配置', { exact: true }).waitFor()
      await page.getByRole('radio', { name: /DeepSeek V4 Pro/ }).check()
      await page.getByRole('button', { name: '高级自定义配置', exact: true }).click()
      await back(page)
      assert.equal(await disclosure.getAttribute('aria-expanded'), 'false')
      assert.equal(await page.getByRole('radio', { name: /DeepSeek V4 Pro/ }).isChecked(), true)
      assert.equal(
        await page.evaluate(() => document.activeElement.dataset.settingsTarget),
        'providers'
      )
    }
  )

  await run(
    'settings navigation restores scroll, protects third-party edits and returns one level per Back',
    async (page) => {
      await page.setViewportSize({ width: 320, height: 520 })
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('account'))
      const scroll = page.getByTestId('settings-scroll')
      await scroll.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      const from = await scroll.evaluate((el) => el.scrollTop)
      assert.ok(from > 20)
      await page.getByRole('button', { name: '高级自定义配置', exact: true }).click()
      assert.equal(await scroll.evaluate((el) => el.scrollTop), 0)
      await page.getByLabel('配置名称', { exact: true }).fill('未保存配置')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '继续编辑', exact: true }).click()
      assert.equal(await page.getByLabel('配置名称', { exact: true }).inputValue(), '未保存配置')
      await back(page)
      await page.getByRole('button', { name: '放弃修改', exact: true }).click()
      await page.locator('[data-settings-page="account"]').waitFor()
      assert.ok(Math.abs((await scroll.evaluate((el) => el.scrollTop)) - from) <= 2)
      await page.keyboard.press('Escape')
      await page.getByTestId('settings-directory').waitFor()
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !window.__audit.settingsDialog.hasSettingsOpen())
    }
  )

  await run(
    'wide settings retains the same editor on resize and appearance controls, empty pricing and persona navigation are reachable',
    async (page) => {
      await page.setViewportSize({ width: 1080, height: 780 })
      await page.evaluate(() => window.__audit.settingsDialog.openSettings())
      await page.getByTestId('settings-rail').waitFor()
      await page.getByLabel('API Key', { exact: true }).fill('not-yet-saved')
      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByTestId('settings-rail').waitFor({ state: 'detached' })
      assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), 'not-yet-saved')
      await page.getByLabel('API Key', { exact: true }).fill('')
      await back(page)
      await page.getByRole('button', { name: /外观与语言/ }).click()
      await page.getByRole('radio', { name: '深色', exact: true }).check()
      assert.ok(await page.locator('body').evaluate((el) => el.classList.contains('dark')))
      await back(page)
      await page.getByRole('button', { name: '用量与费用', exact: true }).click()
      const pricing = page.locator('[data-settings-target="usagePricing"]')
      await pricing.click()
      await back(page)
      await back(page)
      await page.getByRole('button', { name: /人设与提示词/ }).click()
      await page.getByRole('button', { name: /新建人设/ }).click()
      const field = page.locator('#persona-name')
      await field.fill('写作伙伴')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '继续编辑', exact: true }).click()
      assert.equal(await field.inputValue(), '写作伙伴')
      await page.locator('#persona-prompt').fill('将说明改成两段短文。')
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await page.locator('[data-settings-page="personas"]').waitFor()
      await page.getByText('写作伙伴', { exact: true }).waitFor()
    }
  )

  await run(
    'safe-area drawer and dock extend to both screen edges while controls respect cutouts and system navigation',
    async (page) => {
      await page.evaluate(async () => {
        Object.entries({ top: '41px', bottom: '33px', left: '9px', right: '13px' }).forEach(
          ([side, value]) =>
            document.documentElement.style.setProperty('--fs-native-' + side, value)
        )
        document.documentElement.setAttribute('data-android-window', '')
        const a = window.__audit,
          f = a.fixtures
        await a.seed([
          f.session({
            messages: [f.user('u', '保留全文'), f.assistant('a', '可滚动的内容。'.repeat(512))],
          }),
        ])
      })
      const menu = page.getByRole('button', { name: '打开边栏', exact: true })
      await page.waitForTimeout(240)
      const top = await menu.boundingBox(),
        composer = await page.getByTestId('chat-composer').boundingBox(),
        view = await page.getByTestId('message-scroll').boundingBox()
      assert.ok(top.y >= 41 && top.x >= 9)
      assert.ok(composer.y + composer.height <= 844 - 33)
      assert.equal(view.y, 0)
      assert.equal(Math.round(view.height), 844)
      await menu.click()
      const drawer = page.getByTestId('mobile-sider')
      await page.waitForTimeout(310)
      const rect = await drawer.boundingBox()
      assert.equal(rect.y, 0)
      assert.equal(rect.height, 844)
      const first = await drawer.getByRole('button', { name: '收起边栏' }).boundingBox(),
        last = await drawer.getByRole('button', { name: '打赏开发者' }).boundingBox()
      assert.ok(first.y >= 41 && last.y + last.height <= 811)
      await drawer.getByRole('button', { name: '更多', exact: true }).first().click()
      const options = page.getByRole('menuitem')
      await page.keyboard.press('End')
      assert.equal(await options.last().evaluate((el) => el === document.activeElement), true)
      await page.keyboard.press('Escape')
      await drawer.getByRole('button', { name: '设置', exact: true }).click()
      const heading = await dialog(page)
        .getByRole('heading', { name: '设置', exact: true })
        .boundingBox()
      assert.ok(heading.y >= 41)
    }
  )

  await run(
    'settings stays opaque throughout mobile enter and exit, including a quick reversal and reduced motion',
    async (page) => {
      const frames = await page.evaluate(async () => {
        const state = window.__audit.settingsDialog
        const capture = async (n) => {
          const result = []
          for (let i = 0; i < n; i++) {
            await new Promise(requestAnimationFrame)
            const body = document.querySelector('[data-settings-page]')
            if (body) {
              const shell = body.closest('[role=dialog]')
              result.push({
                x: shell.getBoundingClientRect().x,
                alpha: [shell, body, shell.parentElement].map((el) => getComputedStyle(el).opacity),
                scrim: getComputedStyle(shell.previousElementSibling).display,
              })
            }
          }
          return result
        }
        state.openSettings('home')
        const enter = await capture(18)
        state.closeSettings()
        const exit = await capture(3)
        state.openSettings('home')
        const reverse = await capture(20)
        return { enter, exit, reverse, open: state.hasSettingsOpen() }
      })
      for (const samples of [frames.enter, frames.exit, frames.reverse]) {
        assert.ok(samples.length > 0)
        for (const f of samples) {
          assert.deepEqual(f.alpha, ['1', '1', '1'])
          assert.equal(f.scrim, 'none')
        }
      }
      assert.ok(frames.open)
      assert.ok(Math.abs(frames.reverse.at(-1).x) < 1)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.keyboard.press('Escape')
      await page.locator('[data-settings-page]').waitFor({ state: 'detached' })
    }
  )

  await run(
    'settings options fit their field, support keyboard selection and close one layer at a time',
    async (page) => {
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('providers'))
      const field = page
        .locator('[data-settings-page=providers]')
        .getByRole('button', { name: '接口协议', exact: true })
      await field.click()
      const panel = page.getByTestId('option-panel')
      assert.equal(await panel.getByRole('option').count(), 4)
      assert.ok((await panel.boundingBox()).height < 265)
      await page.keyboard.press('End')
      await page.keyboard.press('Enter')
      assert.match(await field.textContent(), /Gemini/)
      await field.click()
      await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'detached' })
      assert.equal(await field.evaluate((el) => document.activeElement === el), true)
      assert.equal(await page.locator('[data-settings-page=providers]').isVisible(), true)
    }
  )

  await run(
    'donation switches QR in place, waits for explicit action and reports only system handoff',
    async (page) => {
      await page.evaluate(() => {
        window.__payLaunches = []
        window.open = (url) => {
          window.__payLaunches.push(String(url))
          return null
        }
      })
      await page.getByRole('button', { name: '打开边栏', exact: true }).click()
      const trigger = page.getByRole('button', { name: '打赏开发者', exact: true })
      await trigger.click()
      const donate = page.getByRole('dialog', { name: '打赏开发者', exact: true })
      const qr = donate.getByRole('img', { name: /收款码$/ })
      await donate.evaluate((el) =>
        Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished))
      )
      const wechat = await qr.getAttribute('src'),
        box = await qr.boundingBox()
      await donate.getByRole('radio', { name: '支付宝', exact: true }).check()
      assert.notEqual(await qr.getAttribute('src'), wechat)
      const next = await qr.boundingBox()
      for (const k of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(box[k] - next[k]) < 1)
      assert.deepEqual(await page.evaluate(() => window.__payLaunches), [])
      await donate.getByRole('button', { name: '保存收款码并打开支付宝', exact: true }).click()
      await donate.getByRole('status').getByText('已请求打开支付应用').waitFor()
      assert.equal(await page.evaluate(() => window.__payLaunches.length), 1)
      await page.keyboard.press('Escape')
      await donate.waitFor({ state: 'detached' })
      assert.ok(await trigger.isVisible())
    }
  )

  await run(
    'short mobile source lists take only their content height and long lists scroll inside the sheet',
    async (page) => {
      const open = async (count) =>
        page.evaluate(
          (n) =>
            window.__audit.searchPanel.toggleSearchPanel(
              'sources-' + n,
              Array.from({ length: n }, (_, i) => ({
                url: 'https://example.com/' + i,
                title: '参考资料 ' + i,
                siteName: 'Example',
                publishedAt: null,
                snippet: '检索到的资料摘要。',
                siteIcon: null,
                index: i + 1,
              }))
            ),
          count
        )
      await open(1)
      const sheet = page.getByRole('dialog', { name: '搜索结果', exact: true })
      await sheet.waitFor()
      assert.ok((await sheet.boundingBox()).height < 300)
      await page.keyboard.press('Escape')
      await sheet.waitFor({ state: 'hidden' })
      await open(36)
      await sheet.waitFor()
      assert.ok((await sheet.boundingBox()).height < 650)
      assert.ok(
        await sheet.evaluate((root) =>
          [...root.querySelectorAll('div')].some(
            (el) =>
              el.scrollHeight > el.clientHeight + 100 && getComputedStyle(el).overflowY === 'auto'
          )
        )
      )
    }
  )

  await run(
    'large persona lists filter without resizing the composer or trapping the mobile keyboard',
    async (page) => {
      await page.setViewportSize({ width: 320, height: 600 })
      await page.evaluate(() => {
        for (let i = 0; i < 20; i++)
          window.__audit.personas.addPersona('旅行笔记 ' + i, '记录途中看到的风景。')
      })
      const trigger = page.getByRole('button', { name: /选择新对话的人设/ })
      await trigger.click()
      const chooser = page.getByTestId('option-panel')
      const full = await chooser.boundingBox()
      assert.ok(full.height <= 355 && full.x >= 0 && full.x + full.width <= 321)
      const search = chooser.getByRole('searchbox', { name: '筛选选项' })
      await search.fill('旅行笔记 19')
      assert.equal(await chooser.getByRole('option').count(), 1)
      await search.fill('没有这个人设')
      await chooser.getByRole('status').waitFor()
      await search.fill('旅行笔记 19')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      await chooser.waitFor({ state: 'detached' })
      assert.match(await trigger.textContent(), /旅行笔记 19/)
    }
  )
}
