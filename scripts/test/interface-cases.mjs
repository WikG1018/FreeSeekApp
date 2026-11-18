import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

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
      const success = page.getByRole('dialog', { name: 'DeepSeek 官方 API 已就绪', exact: true })
      await success.waitFor()
      assert.match(await success.textContent(), /只有接入其他模型服务商或自建网关/)
      assert.doesNotMatch(await success.textContent(), /synthetic-ui-verified-key/)
      await success.getByRole('button', { name: '留在设置', exact: true }).click()
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
      const menuBox = await panel.boundingBox(),
        fieldBox = await field.boundingBox()
      assert.ok(menuBox.height < 265)
      assert.ok(
        Math.abs(menuBox.width - fieldBox.width) < 2 && Math.abs(menuBox.x - fieldBox.x) < 2
      )
      assert.ok(await panel.getByText('/chat/completions', { exact: true }).isVisible())
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
      const channelColors = () =>
        donate
          .getByRole('radio')
          .evaluateAll((radios) =>
            radios.map((r) =>
              getComputedStyle(r.nextElementSibling)
                .backgroundColor.match(/\d+/g)
                .slice(0, 3)
                .map(Number)
            )
          )
      const [green, paleBlue] = await channelColors()
      assert.ok(green[1] > green[0] && green[1] > green[2] && paleBlue[2] > paleBlue[1])
      await donate.getByRole('radio', { name: '支付宝', exact: true }).check()
      await donate.evaluate((el) =>
        Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished))
      )
      const [paleGreen, blue] = await channelColors()
      assert.ok(paleGreen[1] > paleGreen[0] && blue[2] > blue[1] && blue[2] > blue[0])
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

  await run(
    'settings disclosures reverse cleanly and preserve nested values, links and keyboard access',
    async (page) => {
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('account'))
      const guide = page.getByTestId('api-tutorial'),
        header = guide.getByRole('button', { name: /如何获取 API Key/ })
      assert.equal(await header.getAttribute('aria-expanded'), 'true')
      await header.click()
      await header.click()
      await guide.getByRole('listitem').first().waitFor()
      assert.equal(await guide.getByRole('listitem').count(), 4)
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('providers'))
      const more = page.getByRole('button', { name: '更多参数与输入能力', exact: true }),
        shelf = page.locator('[data-settings-page=providers]').getByRole('spinbutton').first()
      await more.click()
      await shelf.fill('7777')
      await more.click()
      const id = await more.getAttribute('aria-controls')
      await page.waitForFunction((id) => document.getElementById(id).hidden, id)
      assert.equal(
        await page.evaluate(
          (id) => document.getElementById(id).querySelector('fieldset').disabled,
          id
        ),
        true
      )
      await more.click()
      assert.equal(await shelf.inputValue(), '7777')
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await more.click()
      assert.ok(await page.evaluate((id) => document.getElementById(id).hidden, id))
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('data'))
      const official = page.getByRole('button', { name: /从 DeepSeek 官方 App 导入聊天记录/ })
      assert.equal(await official.getAttribute('aria-expanded'), 'false')
      await official.focus()
      await page.keyboard.press('Enter')
      assert.equal(await official.getAttribute('aria-expanded'), 'true')
      assert.equal(await page.locator('[data-settings-page=data]').getByRole('listitem').count(), 4)
    }
  )

  await run(
    'onboarding only announces a verified and persisted official key, then returns to the existing draft',
    async (page) => {
      const u = new URL(page.url())
      u.search = ''
      await page.goto(u.href)
      await page.getByRole('button', { name: '去绑定 API Key', exact: true }).click()
      const ready = page.getByRole('dialog', { name: 'DeepSeek 官方 API 已就绪', exact: true }),
        key = page.getByLabel('API Key', { exact: true })
      await page.evaluate(() => window.__audit.drafts.setDraftText(null, '保留原有草稿'))
      let status = 401
      await page.route('**/models', (r) =>
        r.fulfill({
          status,
          contentType: 'application/json',
          body: status === 200 ? '{"data":[]}' : '{"error":{"message":"Unauthorized"}}',
        })
      )
      await key.fill('official-ui-fixture')
      const submit = page.getByRole('button', { name: '验证并保存', exact: true })
      await submit.click()
      await page
        .getByRole('alert')
        .filter({ hasText: /API Key 无效/ })
        .waitFor()
      assert.equal(await ready.count(), 0)
      assert.equal(await page.evaluate(() => localStorage.getItem('freeseek:api-key')), null)
      status = 200
      await page.evaluate(() => {
        const orig = Storage.prototype.setItem
        window.__restoreSettingsWrite = () => {
          Storage.prototype.setItem = orig
        }
        Storage.prototype.setItem = function (name, value) {
          if (name === 'freeseek:api-key') throw new DOMException('quota', 'QuotaExceededError')
          return orig.call(this, name, value)
        }
      })
      await submit.click()
      await page
        .getByRole('alert')
        .filter({ hasText: /未能保存到本机/ })
        .waitFor()
      assert.equal(await ready.count(), 0)
      assert.equal(await key.inputValue(), 'official-ui-fixture')
      assert.equal(
        await page.evaluate(() => window.__audit.settings.useSettings.getState().apiKey),
        null
      )
      await page.evaluate(() => window.__restoreSettingsWrite())
      await submit.click()
      await ready.waitFor()
      await ready.getByRole('button', { name: '开始聊天', exact: true }).click()
      await page.waitForFunction(() => !window.__audit.settingsDialog.hasSettingsOpen())
      assert.equal(
        await page.getByTestId('chat-composer').locator('textarea').inputValue(),
        '保留原有草稿'
      )
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('account'))
      await page.getByText('已配置', { exact: true }).waitFor()
      assert.equal(await ready.count(), 0)
    }
  )

  await run(
    'advanced guidance routes back safely and changing an official key respects the selected provider',
    async (page) => {
      await page.evaluate(() => {
        const a = window.__audit
        a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: '我的服务商',
            url: 'https://private.example/v1',
            model: 'custom-choice',
          },
          true
        )
        a.settingsDialog.openSettings('providers')
      })
      const guide = page.getByTestId('advanced-provider-notice')
      assert.match(await guide.innerText(), /验证并保存官方 Key/)
      await page.getByLabel('配置名称', { exact: true }).fill('未保存的名称')
      const official = guide.getByRole('button', { name: '返回官方 API 设置', exact: true })
      await official.click()
      await page.getByRole('button', { name: '继续编辑', exact: true }).click()
      assert.equal(await page.getByLabel('配置名称', { exact: true }).inputValue(), '未保存的名称')
      await official.click()
      await page.getByRole('button', { name: '放弃修改', exact: true }).click()
      await page.route('**/models', (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' })
      )
      const key = page.getByLabel('API Key', { exact: true }),
        ready = page.getByRole('dialog', { name: 'DeepSeek 官方 API 已就绪', exact: true })
      await key.fill('replace-one')
      await page.getByRole('button', { name: '验证并保存', exact: true }).click()
      await ready.waitFor()
      assert.match(await ready.innerText(), /我的服务商/)
      await ready.getByRole('button', { name: '留在设置' }).click()
      assert.equal(
        await page.evaluate(() => window.__audit.providers.useProviders.getState().selection.model),
        'custom-choice'
      )
      await page.getByRole('button', { name: '高级自定义配置', exact: true }).click()
      assert.match(await guide.innerText(), /官方 Key 已配置/)
      await official.click()
      await page.getByRole('button', { name: '更换 API Key', exact: true }).click()
      await key.fill('replace-two')
      await page.getByRole('button', { name: '验证并保存', exact: true }).click()
      await ready.getByRole('button', { name: '使用 DeepSeek 聊天', exact: true }).click()
      await page.waitForFunction(() => !window.__audit.settingsDialog.hasSettingsOpen())
      assert.equal(
        await page.evaluate(() => localStorage.getItem('freeseek:api-key')),
        'replace-two'
      )
      assert.deepEqual(
        await page.evaluate(() => window.__audit.providers.useProviders.getState().selection),
        { providerId: 'deepseek', model: 'deepseek-flash' }
      )
    }
  )

  await run(
    'one footer row and one scroll owner for the persona library and long prompt editor',
    async (page) => {
      await page.setViewportSize({ width: 320, height: 620 })
      await page.evaluate(() => {
        const a = window.__audit
        a.settings.setFontScale(1.25)
        for (let i = 0; i < 18; i++) a.personas.addPersona('导航回归 ' + i, '一段可以编辑的提示词')
      })
      await page.getByRole('button', { name: '打开边栏', exact: true }).click()
      const footer = page.getByTestId('sider-footer'),
        gear = footer.getByRole('button', { name: '设置', exact: true })
      // The drawer moves horizontally during entry. Read both buttons in the same frame.
      const [support, settings] = await footer.getByRole('button').evaluateAll((buttons) =>
        buttons.map((button) => {
          const { left, right, top, width } = button.getBoundingClientRect()
          return { name: button.getAttribute('aria-label'), left, right, top, width }
        })
      )
      assert.deepEqual([support.name, settings.name], ['打赏开发者', '设置'])
      assert.equal((await gear.innerText()).trim(), '')
      assert.equal(settings.top, support.top)
      assert.ok(
        settings.width >= 44 && support.right < settings.left,
        JSON.stringify({ support, settings })
      )
      await footer.getByRole('button', { name: '打赏开发者', exact: true }).focus()
      await page.keyboard.press('Tab')
      assert.ok(await gear.evaluate((el) => el === document.activeElement))
      await page.keyboard.press('Enter')
      await page.getByRole('button', { name: /人设与提示词/ }).click()
      const scroll = page.getByTestId('settings-scroll')
      const owners = () =>
        scroll.evaluate((el) =>
          [el, ...el.querySelectorAll('*')]
            .filter(
              (x) =>
                x.scrollHeight > x.clientHeight + 2 &&
                ['auto', 'scroll'].includes(getComputedStyle(x).overflowY)
            )
            .map((x) => (x === el ? 'page' : x.tagName))
        )
      assert.deepEqual(await owners(), ['page'])
      const target = page.getByRole('button', { name: '导航回归 12的更多操作', exact: true })
      await target.click()
      await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
      const prompt = page.locator('#persona-prompt')
      await prompt.fill('保留换行及所有内容。\n'.repeat(350))
      assert.ok(await prompt.evaluate((el) => el.scrollHeight <= el.clientHeight + 2))
      assert.deepEqual(await owners(), ['page'])
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await target.waitFor()
      await target.click()
      await page.getByRole('menuitem', { name: '删除', exact: true }).click()
      await page.getByRole('button', { name: '取消', exact: true }).click()
      await target.waitFor()
      assert.deepEqual(await owners(), ['page'])
    }
  )

  await run(
    'update notices show notes before download or install, and About keeps the installed notes offline',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        window.androidBridge = {}
        const metadata = {
          tag_name: 'v99.2.1',
          body: '- 第一项新版改进\n- 第二项新版改进',
          assets: [
            {
              name: 'freeseek-v99.2.1-release.apk',
              size: 123,
              browser_download_url:
                'https://github.com/WikG1018/FreeSeekApp/releases/download/v99.2.1/freeseek-v99.2.1-release.apk',
              digest: 'sha256:' + 'a'.repeat(64),
            },
          ],
        }
        window.__updateCalls = { download: 0, install: 0 }
        window.__readyFile = false
        window.Capacitor.nativeCallback = () => 'fixture-listener'
        window.Capacitor.nativePromise = async (plugin, method) => {
          if (plugin !== 'Update') throw new Error('Unsupported test plugin')
          if (method === 'get') return { status: 200, body: JSON.stringify(metadata) }
          if (method === 'hasFile')
            return {
              exists: window.__readyFile,
              path: window.__readyFile ? '/verified.apk' : '',
              size: 123,
            }
          if (method === 'download') {
            window.__updateCalls.download++
            return new Promise(
              (resolve) =>
                (window.__finishDownload = () => {
                  window.__readyFile = true
                  resolve({ path: '/verified.apk', size: 123 })
                })
            )
          }
          if (method === 'install') {
            window.__updateCalls.install++
            return { installed: true }
          }
          if (method === 'removeListener') return {}
          throw new Error('Unsupported test method ' + method)
        }
        await a.update.checkForUpdate({ force: true })
      })
      const calls = () => page.evaluate(() => window.__updateCalls)
      assert.deepEqual(await calls(), { download: 0, install: 0 })
      await page.getByRole('button', { name: '打开边栏', exact: true }).click()
      const notice = page.getByTestId('sidebar-update'),
        notes = page.getByRole('dialog', { name: '版本 v99.2.1 更新内容', exact: true })
      assert.match(await notice.innerText(), /v99.2.1/)
      await notice.click()
      assert.equal(await notes.getByRole('listitem').count(), 2)
      assert.deepEqual(await calls(), { download: 0, install: 0 })
      await notes.getByRole('button', { name: '下载更新', exact: true }).click()
      await page
        .waitForFunction(() => typeof window.__finishDownload === 'function')
        .catch(async (error) => {
          throw new Error(
            String(error) +
              ' ' +
              JSON.stringify(
                await page.evaluate(() => ({
                  calls: window.__updateCalls,
                  status: window.__audit.update.useUpdate.getState().status,
                  error: window.__audit.update.useUpdate.getState().error,
                  stored: window.__readyFile,
                }))
              )
          )
        })
      await page.keyboard.press('Escape')
      await notes.waitFor({ state: 'detached' })
      await page.evaluate(() => window.__audit.update.useUpdate.setState({ percent: 57 }))
      assert.match(await notice.innerText(), /57%/)
      await notice.click()
      assert.equal(await notes.getByRole('progressbar').getAttribute('aria-valuenow'), '57')
      await page.evaluate(() => window.__finishDownload())
      await page.keyboard.press('Escape')
      await notes.waitFor({ state: 'detached' })
      await notice.click()
      assert.deepEqual(await calls(), { download: 1, install: 0 })
      await notes.getByRole('button', { name: '安装更新', exact: true }).click()
      assert.deepEqual(await calls(), { download: 1, install: 1 })
      await page.keyboard.press('Escape')
      await notes.waitFor({ state: 'detached' })
      await page.evaluate(() => {
        localStorage.removeItem('freeseek:update-cache')
        window.__audit.update.useUpdate.setState({
          release: null,
          status: 'idle',
          filePath: '',
          percent: 0,
        })
        window.__audit.settingsDialog.openSettings('about')
      })
      await page.getByRole('button', { name: /本版本更新内容/ }).click()
      const installed = page.getByTestId('release-notes')
      const version = await page.evaluate(() => window.__audit.update.currentVersion())
      const changelog = await readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8')
      const section = changelog
        .split(/^## /m)
        .find((entry) => entry.split(/\s+/)[0] === 'v' + version)
      assert.ok(section, 'installed version has release notes')
      const bullets = section
        .split(/\r?\n/)
        .filter((line) => line.startsWith('- '))
        .map((line) => line.slice(2).trim())
      assert.ok(bullets.length > 0)
      assert.deepEqual(await installed.getByRole('listitem').allTextContents(), bullets)
      assert.equal(
        await installed
          .locator('..')
          .locator('..')
          .getByRole('button', { name: '安装更新', exact: true })
          .count(),
        0
      )
      await page.keyboard.press('Escape')
      await installed.waitFor({ state: 'detached' })
      await page.getByRole('button', { name: /检查更新/ }).click()
      await notes.waitFor()
      assert.deepEqual(await calls(), { download: 1, install: 1 })
    },
    async (context) => {
      await context.addInitScript(() => {
        window.Capacitor = {
          PluginHeaders: [
            {
              name: 'Update',
              methods: [
                'get',
                'hasFile',
                'download',
                'install',
                'removeListener',
                'addListener',
              ].map((name) => ({
                name,
                rtype: name === 'addListener' ? 'callback' : 'promise',
              })),
            },
          ],
        }
      })
    }
  )
}
