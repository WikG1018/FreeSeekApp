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
}
