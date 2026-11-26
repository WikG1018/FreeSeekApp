import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const dialog = (page) => page.getByRole('dialog').last()
const back = (page) => dialog(page).getByRole('button', { name: '返回', exact: true }).click()

const setScreenTimeHours = (page, hours) =>
  page.evaluate(async (value) => {
    // Seed the same foreground-time counter that is used by the dashboard.
    await window.__audit.screenTime.readScreenTime(false)
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('freeseek-screen-time')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('counters', 'readwrite')
        tx.oncomplete = resolve
        tx.onabort = () => reject(tx.error)
        tx.objectStore('counters').put(
          { totalMs: value * 3_600_000, days: {}, lastUsedAt: Date.now() },
          'app'
        )
      })
    } finally {
      db.close()
    }
  }, hours)

const mockMilestoneForeground = (context) =>
  context.addInitScript(() => {
    let visible = true
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (visible ? 'visible' : 'hidden'),
    })
    document.hasFocus = () => visible
    window.__milestoneForeground = (value) => {
      visible = value
      document.dispatchEvent(new Event('visibilitychange'))
    }
  })

export const runInterfaceCases = async ({ run }) => {
  await run(
    'cache hit rates use only measured prompt tokens in the reply and settings',
    async (page) => {
      const measured = await page.evaluate(async () => {
        const a = window.__audit
        const provider = a.normalizeProviderUsage
        const first = provider(
          {
            prompt_tokens: 1000,
            prompt_cache_hit_tokens: 200,
            prompt_cache_miss_tokens: 800,
            completion_tokens: 5,
          },
          'openai'
        )
        const second = provider(
          { input_tokens: 1, cache_read_input_tokens: 9, output_tokens: 3 },
          'anthropic'
        )
        const unknown = provider({ prompt_tokens: 2000, completion_tokens: 1 }, 'openai')
        const reply = a.fixtures.assistant('cache-reply', '这里可以查看缓存命中率。', {
          model: 'synthetic-cache-model',
          usage: first,
          usageHistory: [first, second, unknown].map((usage) => ({ createdAt: Date.now(), usage })),
        })
        await a.seed([
          a.fixtures.session({
            id: 'cache-fixture',
            messages: [a.fixtures.user('q', '统计缓存'), reply],
          }),
        ])
        const models = await a.usage.collectModelUsage()
        return [
          a.usage.formatCacheHitRate(a.usage.replyCacheCounts(reply), 'zh-CN'),
          a.usage.formatCacheHitRate(unknown.cache_counts, 'zh-CN'),
          a.usage.formatCacheHitRate(
            a.usage.totalCacheCounts(a.usage.sumUsage(models[0].days)),
            'zh-CN'
          ),
        ]
      })
      assert.deepEqual(measured, ['20.7%', '—', '20.7%'])
      await page.setViewportSize({ width: 320, height: 720 })
      await page.getByRole('button', { name: /tok/ }).first().click()
      await page.getByText('缓存命中率', { exact: true }).waitFor()
      await page.getByText('20.7%', { exact: true }).waitFor()
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('usage'))
      const totals = page.locator('[data-settings-page="usage"]')
      await totals.getByText('缓存命中率').waitFor()
      await totals.getByText('20.7%', { exact: true }).waitFor()
      await page.evaluate(() => window.__audit.settings.setLocale('en-US'))
      await totals.getByText('Cache hit rate').waitFor()
    }
  )
  await run(
    'chat Enter preference applies to the composer, keeps IME selection safe and leaves search submitting',
    async (page) => {
      await page.setViewportSize({ width: 360, height: 780 })
      await page.evaluate(async () => {
        const a = window.__audit
        a.settings.setApiKey('composer-fixture-key')
        a.settings.setSearch(false)
        await a.seed([a.fixtures.session({ id: 'composer-enter-test', title: '回车验收对话' })])
        const fetcher = window.fetch
        window.__composerRequests = 0
        window.fetch = (url, init) => {
          if (!new URL(url).pathname.endsWith('/anthropic/v1/messages')) return fetcher(url, init)
          window.__composerRequests++
          return Promise.resolve(a.response('发送成功。'))
        }
        a.settingsDialog.openSettings('chat')
      })
      const enterSetting = page.getByRole('button', { name: '回车键', exact: true })
      const choose = async (value) => {
        await enterSetting.click()
        const menu = page.getByRole('dialog', { name: '回车键', exact: true })
        const option = menu.getByRole('option', { name: value, exact: true })
        await option.waitFor()
        const [panel, row] = await Promise.all([menu.boundingBox(), enterSetting.boundingBox()])
        assert.ok(panel.width <= 145 && panel.width < row.width / 2)
        assert.ok(Math.abs(panel.x + panel.width - row.x - row.width) <= 2)
        await option.click()
        await page.evaluate(() => window.__audit.settingsDialog.closeSettings())
      }
      const input = page.getByTestId('chat-composer').locator('textarea')
      await choose('换行')
      assert.equal(await input.getAttribute('enterkeyhint'), 'enter')
      await input.fill('第一行')
      await input.press('Enter')
      assert.equal(await input.inputValue(), '第一行\n')
      assert.equal(await page.evaluate(() => window.__composerRequests), 0)
      assert.equal(
        await page.evaluate(() => localStorage.getItem('freeseek:composer-enter')),
        'newline'
      )

      await page.getByTestId('chat-header').getByRole('button').first().click()
      const search = page.getByTestId('sider-quick-actions').getByRole('searchbox')
      await search.fill('回车验收')
      assert.equal(await search.getAttribute('enterkeyhint'), 'search')
      await search.press('Enter')
      await page.getByTestId('sider-list').getByText('回车验收对话', { exact: true }).waitFor()
      assert.equal(await search.evaluate((element) => document.activeElement === element), false)
      await page.keyboard.press('Escape')

      await page.evaluate(() => window.__audit.settingsDialog.openSettings('chat'))
      await choose('发送消息')
      assert.equal(await input.getAttribute('enterkeyhint'), 'send')
      await input.fill('中文输入')
      await input.evaluate((element) => {
        element.dispatchEvent(
          new CompositionEvent('compositionstart', { bubbles: true, data: 'zhong' })
        )
        element.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', isComposing: true })
        )
        element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }))
      })
      assert.equal(await page.evaluate(() => window.__composerRequests), 0)
      await input.press('Shift+Enter')
      assert.equal(await input.inputValue(), '中文输入\n')
      await input.press('Enter')
      await page.waitForFunction(() => window.__composerRequests === 1)
      await page.evaluate(() => window.__audit.waitIdle())
      await input.fill('软件键盘回车')
      const cancelled = await input.evaluate(
        (element) =>
          !element.dispatchEvent(
            new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType: 'insertLineBreak',
            })
          )
      )
      assert.equal(cancelled, true)
      await page.waitForFunction(() => window.__composerRequests === 2)
      await page.evaluate(() => window.__audit.waitIdle())
      assert.equal(await input.inputValue(), '')
    }
  )

  await run(
    'a returning user sees the character voice introduction once and can open speech settings',
    async (page) => {
      const intro = page.getByRole('dialog', { name: '让故事里的角色开口', exact: true })
      await intro.waitFor()
      await intro.getByRole('heading', { name: '小米 MiMo 语音合成限时免费' }).waitFor()
      assert.match(await intro.innerText(), /站台只剩一盏灯/)
      assert.equal(
        await intro.getByRole('link', { name: 'MiMo 官方定价' }).getAttribute('href'),
        'https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go'
      )
      assert.equal(
        await page.evaluate(() => localStorage.getItem('freeseek:role-voice-intro-seen')),
        '1'
      )
      await page.setViewportSize({ width: 320, height: 568 })
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
      await page.evaluate(() => window.__audit.settings.setLocale('en-US'))
      const english = page.getByRole('dialog', { name: 'Give your story a voice', exact: true })
      const settings = english.getByRole('button', { name: 'Open Settings', exact: true })
      const bounds = await settings.boundingBox()
      assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 568 && bounds.height >= 44)
      await page.evaluate(() => window.__audit.settings.setLocale('zh-CN'))
      await intro.getByRole('button', { name: '去设置', exact: true }).click()
      const speech = page.locator('[data-settings-page="chatSpeech"]')
      await speech.getByRole('button', { name: '如何配置角色配音', exact: true }).waitFor()
      await back(page)
      await page.locator('[data-settings-page="chat"]').waitFor()
      await page.reload()
      await page.locator('#fs-startup').waitFor({ state: 'hidden' })
      assert.equal(await intro.count(), 0)
    },
    (context) =>
      context.addInitScript(() => {
        localStorage.setItem('freeseek:notice-version', '1')
        localStorage.setItem('freeseek:onboarded', '1')
      })
  )

  await run(
    'a new installation never shows the update-only character voice introduction',
    async (page) => {
      await page.evaluate(() => localStorage.removeItem('freeseek:role-voice-intro-seen'))
      const clean = new URL(page.url())
      clean.search = ''
      await page.goto(clean.href)
      await page.getByRole('button', { name: '我已阅读，继续', exact: true }).click()
      await page.getByRole('button', { name: '先进去看看', exact: true }).click()
      const intro = page.getByRole('dialog', { name: '让故事里的角色开口', exact: true })
      assert.equal(await intro.count(), 0)
      await page.reload()
      await page.locator('#fs-startup').waitFor({ state: 'hidden' })
      assert.equal(await intro.count(), 0)
    }
  )

  await run(
    'onboarding, About and Settings share the same key-free import screen',
    async (page) => {
      const clean = new URL(page.url())
      clean.search = ''
      await page.goto(clean.href)
      const button = (name) => page.getByRole('button', { name, exact: true })
      const tutorial = button('如何从 DeepSeek 导出聊天记录')
      const data = page.locator('[data-settings-page="data"]')
      const importButton = data.getByRole('button', { name: '导入历史对话', exact: true })
      await button('我已阅读，继续').click()
      await page.getByRole('button', { name: /^把以前的聊天搬过来/ }).click()
      await data.waitFor()
      assert.equal(await tutorial.getAttribute('aria-expanded'), 'true')
      assert.equal(await importButton.count(), 1)
      assert.equal(await button('删除所有对话').count(), 0)
      const picker = page.waitForEvent('filechooser')
      await importButton.click()
      const chooser = await picker
      await chooser.setFiles({
        name: 'example.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from('fixture'),
      })
      const confirm = page.getByRole('dialog', { name: '准备导入聊天记录', exact: true })
      await confirm.getByRole('button', { name: '取消', exact: true }).click()
      await confirm.waitFor({ state: 'detached' })

      const rail = page.getByTestId('settings-rail')
      if (!(await rail.isVisible())) {
        await back(page)
      }
      await page.locator('[data-settings-target="about"]').click()
      await button('隐私与开源许可').click()
      const privacy = page.locator('[data-settings-page="aboutInfo"]')
      await privacy.getByRole('heading', { name: '哪些内容会发给外部服务' }).waitFor()
      assert.match(await privacy.innerText(), /你选定的 API 服务/)
      await back(page)
      await button('使用指南').click()
      await page.getByRole('button', { name: /^把以前的聊天搬过来/ }).click()
      await data.waitFor()
      assert.equal(await tutorial.getAttribute('aria-expanded'), 'true')
      if (await rail.isVisible()) {
        await rail.locator('[data-settings-target="about"]').click()
      } else {
        await back(page)
      }
      await page.locator('[data-settings-target="data"]').click()
      await data.waitFor()
      assert.equal(await tutorial.getAttribute('aria-expanded'), 'false')
      assert.equal(await importButton.count(), 1)
      assert.equal(
        await page.evaluate(() => window.__audit.settings.useSettings.getState().apiKey),
        null
      )
    }
  )

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
      const success = page.getByRole('dialog', { name: 'DeepSeek 已就绪', exact: true })
      await success.waitFor()
      assert.match(await success.textContent(), /接入其他模型服务或自建网关/)
      assert.doesNotMatch(await success.textContent(), /synthetic-ui-verified-key/)
      await success.getByRole('button', { name: '返回设置', exact: true }).click()
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
      await page.getByRole('button', { name: '添加连接', exact: true }).click()
      await page.getByRole('button', { name: '手动配置', exact: true }).click()
      await page.getByLabel('连接名称', { exact: true }).fill('未保存配置')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '继续编辑', exact: true }).click()
      assert.equal(await page.getByLabel('连接名称', { exact: true }).inputValue(), '未保存配置')
      await back(page)
      await page.getByRole('button', { name: '放弃修改', exact: true }).click()
      await page.locator('[data-settings-page="providerCatalog"]').waitFor()
      await back(page)
      await page.locator('[data-settings-page="providers"]').waitFor()
      await back(page)
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
      await dialog(page).getByRole('button', { name: '返回对话', exact: true }).click()
      await dialog(page).waitFor({ state: 'detached' })
      await page.evaluate(() => window.__audit.settingsDialog.openSettings())
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
      const keepEditing = page.getByRole('button', { name: '继续编辑', exact: true })
      await keepEditing.click()
      await keepEditing.waitFor({ state: 'detached' })
      assert.equal(await field.inputValue(), '写作伙伴')
      await page.locator('#persona-prompt').fill('将说明改成两段短文。')
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await page.locator('[data-settings-page="personas"]').waitFor()
      const custom = await page.evaluate(() =>
        window.__audit.personas.usePersonas
          .getState()
          .personas.filter(({ id }) => !id.startsWith('builtin-'))
          .map(({ name, prompt }) => ({ name, prompt }))
      )
      assert.deepEqual(custom, [{ name: '写作伙伴', prompt: '将说明改成两段短文。' }])
      const search = page.locator('[data-settings-page="personas"] input[type="search"]')
      await search.fill('写作伙伴')
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
      const first = await drawer.getByRole('searchbox').boundingBox(),
        last = await drawer.getByRole('button', { name: '感谢开发者' }).boundingBox()
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
      await page.getByRole('button', { name: '添加连接', exact: true }).click()
      await page.getByRole('button', { name: '手动配置', exact: true }).click()
      const field = page
        .locator('[data-settings-page=providerConnection]')
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
      assert.equal(await page.locator('[data-settings-page=providerConnection]').isVisible(), true)
    }
  )

  await run(
    'donation switches QR in place, waits for explicit action and reports only system handoff',
    async (page) => {
      await page.evaluate(() => {
        window.__payLaunches = []
        let visible = true
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => (visible ? 'visible' : 'hidden'),
        })
        window.__setDonationVisible = (state) => {
          visible = state
          document.dispatchEvent(new Event('visibilitychange'))
        }
        window.open = (url) => {
          window.__payLaunches.push(String(url))
          return null
        }
      })
      await page.getByRole('button', { name: '打开边栏', exact: true }).click()
      const trigger = page.getByRole('button', { name: '感谢开发者', exact: true })
      assert.match(await trigger.textContent(), /一块也是爱/)
      assert.equal(
        await trigger.evaluate(
          (el) =>
            el
              .getAnimations({ subtree: true })
              .filter((animation) => animation.effect.getTiming().iterations === Infinity).length
        ),
        5
      )
      await trigger.click()
      const donate = page.getByRole('dialog', { name: '感谢开发者', exact: true })
      const qr = donate.getByRole('img', { name: /收款码$/ })
      const settle = () =>
        donate.evaluate((el) =>
          Promise.all(
            el
              .getAnimations({ subtree: true })
              .filter((animation) => Number.isFinite(animation.effect.getTiming().iterations))
              .map((animation) => animation.finished)
          )
        )
      await settle()
      assert.ok(
        await donate
          .getByText('如果 FreeSeek 帮到了你，可以请我喝杯咖啡。', { exact: true })
          .isVisible()
      )
      assert.ok(
        await donate.getByText('扫码后金额由你填，一块也是爱。', { exact: true }).isVisible()
      )
      assert.ok(
        await donate.getByText('有建议的话，也欢迎写在付款备注里。', { exact: true }).isVisible()
      )
      const scanInstructions = (app) =>
        donate.getByText(`打开${app}，点「扫一扫」，再从相册选择收款码。`, { exact: true })
      assert.ok(await scanInstructions('微信').isVisible())
      assert.equal(
        await donate.getByRole('button', { name: '保存收款码并打开微信' }).locator('svg').count(),
        0
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
      await settle()
      assert.ok(await scanInstructions('支付宝').isVisible())
      assert.equal(await scanInstructions('微信').count(), 0)
      const [paleGreen, blue] = await channelColors()
      assert.ok(paleGreen[1] > paleGreen[0] && blue[2] > blue[1] && blue[2] > blue[0])
      assert.notEqual(await qr.getAttribute('src'), wechat)
      const next = await qr.boundingBox()
      for (const k of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(box[k] - next[k]) < 1)
      assert.deepEqual(await page.evaluate(() => window.__payLaunches), [])
      await donate.getByRole('button', { name: '保存收款码并打开支付宝', exact: true }).click()
      await donate.getByRole('status').getByText('已请求打开支付应用').waitFor()
      assert.equal(await page.evaluate(() => window.__payLaunches.length), 1)
      const thanks = page.getByRole('dialog', { name: '谢谢你的心意', exact: true })
      const foreground = (visible) =>
        page.evaluate((value) => window.__setDonationVisible(value), visible)
      await foreground(true)
      assert.equal(await thanks.count(), 0, 'an active event alone cannot trigger thanks')
      await foreground(false)
      assert.equal(await thanks.count(), 0, 'thanks waits for return')
      await page.setViewportSize({ width: 960, height: 640 })
      assert.ok(await donate.isVisible(), 'the handoff survives the change from drawer to sidebar')
      await foreground(true)
      await thanks.waitFor()
      const area = await thanks.boundingBox()
      assert.ok(area.x <= 1 && area.y <= 1 && area.width >= 959 && area.height >= 639)
      assert.equal(await page.evaluate(() => document.activeElement.textContent), '谢谢你的心意')
      await donate.waitFor({ state: 'detached' })
      await thanks.getByRole('button', { name: '返回 FreeSeek', exact: true }).click()
      await thanks.waitFor({ state: 'detached' })
      await foreground(false)
      await foreground(true)
      assert.equal(await thanks.count(), 0)
      assert.ok(await trigger.isVisible())
    }
  )

  await run(
    'donation failures keep recovery controls and reduced motion remains still',
    async (page) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.evaluate(() => {
        window.open = () => {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden',
          })
          document.dispatchEvent(new Event('visibilitychange'))
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'visible',
          })
          document.dispatchEvent(new Event('visibilitychange'))
          throw new Error('external launch unavailable')
        }
      })
      await page.getByRole('button', { name: '打开边栏', exact: true }).click()
      const trigger = page.getByRole('button', { name: '感谢开发者', exact: true })
      const looping = (el) =>
        el
          .getAnimations({ subtree: true })
          .some((animation) => animation.effect.getTiming().iterations === Infinity)
      assert.equal(await trigger.evaluate(looping), false)
      await trigger.click()
      const sheet = page.getByRole('dialog', { name: '感谢开发者', exact: true })
      assert.equal(await sheet.evaluate(looping), false)
      await sheet.getByRole('button', { name: '保存收款码并打开微信', exact: true }).click()
      await sheet.getByRole('status').getByText('未能自动打开微信').waitFor()
      assert.ok(await sheet.getByText('打开微信，点「扫一扫」，再从相册选择收款码。').isVisible())
      assert.equal(await page.getByRole('dialog', { name: '谢谢你的心意', exact: true }).count(), 0)
      await page.keyboard.press('Escape')
      await sheet.waitFor({ state: 'detached' })
    }
  )

  await run(
    'screen time splits at midnight, pauses in background and ranks chats after reopening',
    async (page) => {
      const advance = (ms) => page.evaluate((value) => window.__advanceScreenTime(value), ms)
      const foreground = (visible) =>
        page.evaluate((value) => window.__screenTimeVisible(value), visible)
      const current = () =>
        page.evaluate(async () => {
          const time = await window.__audit.screenTime.readScreenTime(true)
          return { ...time, chats: Object.fromEntries(time.chats) }
        })
      await page.evaluate(async () => {
        const { fixtures, seed } = window.__audit
        await seed([
          fixtures.session({ id: 'time-a', title: '写作笔记' }),
          fixtures.session({ id: 'time-b', title: '旅行清单' }),
        ])
      })
      await page.getByTestId('chat-header').getByText('写作笔记', { exact: true }).waitFor()
      await advance(18_000)
      await page.evaluate(() => window.__audit.store.selectSession('time-b'))
      await page.getByTestId('chat-header').getByText('旅行清单', { exact: true }).waitFor()
      await advance(5_000)
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('home'))
      await page
        .locator('[data-testid="settings-directory"], [data-testid="settings-rail"]')
        .waitFor()
      await advance(3_000)
      await page.getByRole('button', { name: '使用时长', exact: true }).click()
      await page.getByTestId('screen-time-today').waitFor()
      assert.equal(await page.getByTestId('screen-time-today').textContent(), '21 秒')
      assert.equal(await page.getByTestId('screen-time-total').textContent(), '26 秒')
      const ranking = page.getByTestId('screen-time-ranking')
      assert.match(await ranking.getByRole('button').nth(0).textContent(), /写作笔记.*18 秒/)
      assert.match(await ranking.getByRole('button').nth(1).textContent(), /旅行清单.*5 秒/)
      const first = await current()
      assert.equal(first.durable, true)
      assert.deepEqual(first.overall.days, { '2026-11-19': 5000, '2026-11-20': 21000 })
      assert.deepEqual(first.chats['time-a'].days, { '2026-11-19': 5000, '2026-11-20': 13000 })

      await foreground(false)
      await advance(120_000)
      assert.deepEqual(await current(), first)
      await foreground(true)
      await advance(2_000)
      const resumed = await current()
      assert.equal(resumed.overall.totalMs, 28000)
      assert.deepEqual(resumed.chats, first.chats, 'settings time belongs only to overall time')
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      assert.deepEqual(await current(), resumed)

      await foreground(false)
      await advance(8 * 86400 * 1000)
      await foreground(true)
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('screenTime'))
      await page
        .getByText('打开对话后，停留在对话页的时长会出现在这里。', { exact: true })
        .waitFor()
      await page.getByRole('button', { name: '累计', exact: true }).click()
      await ranking.getByRole('button', { name: /写作笔记/ }).click()
      await page
        .getByRole('dialog', { name: '使用时长', exact: true })
        .waitFor({ state: 'detached' })
      assert.equal(
        await page.evaluate(() => window.__audit.store.useChatStore.getState().activeId),
        'time-a'
      )
    },
    async (context) => {
      await context.addInitScript(() => {
        const RealDate = Date
        let wall =
          Number(sessionStorage.getItem('screen-time-clock')) ||
          new RealDate(2026, 10, 19, 23, 59, 55).getTime()
        let tick = 0,
          visible = true
        window.Date = new Proxy(RealDate, {
          construct: (target, args) => new target(...(args.length ? args : [wall])),
          apply: () => new RealDate(wall).toString(),
          get: (target, key) => (key === 'now' ? () => wall : Reflect.get(target, key)),
        })
        Object.defineProperty(performance, 'now', { configurable: true, value: () => tick })
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => (visible ? 'visible' : 'hidden'),
        })
        document.hasFocus = () => visible
        window.__screenTimeVisible = (value) => {
          visible = value
          document.dispatchEvent(new Event('visibilitychange'))
        }
        window.__advanceScreenTime = (ms) => {
          wall += ms
          tick += ms
          sessionStorage.setItem('screen-time-clock', String(wall))
        }
      })
    }
  )

  await run(
    'screen time milestones wait for idle home, loop, and replay only shown levels after restart',
    async (page) => {
      const about = page.getByRole('dialog', { name: '关于 FreeSeek', exact: true })
      const eggs = page.getByRole('dialog', { name: '彩蛋', exact: true })
      const entry = about.getByRole('button', { name: '彩蛋', exact: true })
      const reached = (hours) =>
        page.getByRole('dialog', { name: '你已使用 ' + hours + ' 小时', exact: true })
      const openAbout = async () => {
        await page.evaluate(() => window.__audit.settingsDialog.openSettings('about'))
        await about.waitFor()
      }
      const closeSettings = async () => {
        await page.evaluate(() => window.__audit.settingsDialog.closeSettings())
        await about.waitFor({ state: 'detached' })
      }

      await openAbout()
      assert.equal(await entry.count(), 0)
      await setScreenTimeHours(page, 100)
      assert.equal(await reached(100).count(), 0)
      assert.equal(await entry.count(), 0)
      await page.evaluate(() => window.__audit.drafts.setDraftText(null, '保留未发送草稿'))
      await closeSettings()
      assert.equal(await reached(100).count(), 0)
      assert.equal(await page.locator('textarea').inputValue(), '保留未发送草稿')

      await page.evaluate(() => {
        window.__audit.drafts.setDraftText(null, '')
        window.__milestoneForeground(false)
        window.__milestoneForeground(true)
      })
      const celebration = reached(100)
      await celebration.waitFor()
      assert.match(await celebration.getByRole('heading').textContent(), /^你已使用\s*100\s+小时/)
      const art = celebration.locator('[data-milestone-art]')
      const whales = art.locator('[data-milestone-swim]')
      const motion = await whales.evaluateAll((elements) =>
        elements.map((element) => {
          const [animation] = element.getAnimations()
          const frames = animation.effect.getKeyframes()
          return {
            iterations: String(animation.effect.getTiming().iterations),
            joins: frames[0].transform === frames.at(-1).transform,
          }
        })
      )
      assert.deepEqual(motion, [
        { iterations: 'Infinity', joins: true },
        { iterations: 'Infinity', joins: true },
      ])
      await celebration.getByRole('button', { name: '感谢开发者', exact: true }).click()
      const donation = page.getByRole('dialog', { name: '感谢开发者', exact: true })
      await donation.waitFor()
      const playback = () =>
        whales.first().evaluate((node) => getComputedStyle(node).animationPlayState)
      assert.equal(await playback(), 'paused')
      await page.keyboard.press('Escape')
      await donation.waitFor({ state: 'detached' })
      assert.equal(await playback(), 'running')
      await page.evaluate(() => window.__milestoneForeground(false))
      assert.equal(await playback(), 'paused')
      await page.evaluate(() => window.__milestoneForeground(true))
      assert.equal(await playback(), 'running')
      await celebration.getByRole('button', { name: '继续使用', exact: true }).click()
      await celebration.waitFor({ state: 'detached' })

      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      await openAbout()
      assert.equal(await celebration.count(), 0)
      await entry.click()
      await eggs.waitFor()
      const replay = eggs.getByRole('button', { name: '100 小时', exact: true })
      assert.equal(await replay.count(), 1)
      assert.equal(await eggs.getByRole('button', { name: /^(500|1,000) 小时$/ }).count(), 0)
      await replay.click()
      await celebration.waitFor()
      await page.keyboard.press('Escape')
      await celebration.waitFor({ state: 'detached' })
      assert.equal(await eggs.isVisible(), true)
      await back(page)
      await about.waitFor()
      await setScreenTimeHours(page, 500)
      await closeSettings()
      await reached(500).waitFor()
      await page.keyboard.press('Escape')
      await reached(500).waitFor({ state: 'detached' })
      await openAbout()
      await entry.click()
      assert.equal(await eggs.getByRole('button', { name: '500 小时', exact: true }).count(), 1)
      assert.equal(await replay.count(), 1)
    },
    mockMilestoneForeground
  )

  await run(
    'upgrading with 1000 hours only triggers the highest milestone and supports reduced motion',
    async (page) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.evaluate(() => {
        window.__audit.settingsDialog.openSettings('about')
        window.__milestoneForeground(false)
      })
      await setScreenTimeHours(page, 1000)
      await page.evaluate(() => window.__audit.settingsDialog.closeSettings())
      const reached = page.getByRole('dialog', { name: '你已使用 1,000 小时', exact: true })
      assert.equal(await reached.count(), 0)
      await page.evaluate(() => window.__milestoneForeground(true))
      await reached.waitFor()
      assert.equal(
        await reached
          .locator('[data-milestone-art]')
          .evaluate((el) => el.getAnimations({ subtree: true }).length),
        0
      )
      await reached.getByRole('button', { name: '继续使用', exact: true }).click()
      await reached.waitFor({ state: 'detached' })
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('about'))
      await page.getByRole('button', { name: '彩蛋', exact: true }).click()
      const eggs = page.getByRole('dialog', { name: '彩蛋', exact: true })
      assert.equal(await eggs.getByRole('button', { name: '1,000 小时', exact: true }).count(), 1)
      assert.equal(await eggs.getByRole('button', { name: /^(100|500) 小时$/ }).count(), 0)
    },
    mockMilestoneForeground
  )

  await run(
    'model usage groups recorded models and connections and keeps filters when returning from details',
    async (page) => {
      const totals = await page.evaluate(async () => {
        const a = window.__audit
        const usage = (input, output, cache = 0) => ({
          input_tokens: input,
          output_tokens: output,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: cache,
        })
        const connection = (name, host) =>
          a.providers.saveProvider({
            ...a.providers.emptyProfile(),
            name,
            url: `https://${host}.example.test/v1`,
            model: 'shared-model',
          })
        const left = connection('历史连接一', 'usage-one')
        const right = connection('历史连接二', 'usage-two')
        const today = Date.now()
        const day = new Date(today)
        day.setDate(day.getDate() - 1)
        const yesterday = day.getTime()
        day.setDate(day.getDate() - 39)
        const old = day.getTime()
        const continued = a.fixtures.assistant('continued', 'Complete', {
          responseModel: 'deepseek-v4-flash',
          usage: usage(13000, 1800, 2000),
          usageHistory: [
            { model: 'deepseek-v4-flash', createdAt: today, usage: usage(4000, 800, 2000) },
            { model: 'deepseek-v4-pro', createdAt: yesterday, usage: usage(9000, 1000) },
          ],
        })
        const session = a.fixtures.session({
          title: '用量记录',
          messages: [
            continued,
            a.fixtures.assistant('left', 'First vendor', {
              model: 'shared-model',
              connection: { providerId: left.id },
              usage: usage(3000, 500),
            }),
            a.fixtures.assistant('right', 'Second vendor', {
              model: 'shared-model',
              connection: { providerId: right.id },
              createdAt: old,
              usage: usage(1700, 300),
            }),
            a.fixtures.assistant('legacy', 'Older usage', {
              model: null,
              createdAt: old,
              usage: usage(1000, 100),
            }),
          ],
          compressionUsage: [
            {
              model: 'deepseek-v4-pro',
              connection: { providerId: 'deepseek' },
              createdAt: yesterday,
              usage: usage(2000, 500),
            },
          ],
        })
        await a.seed([
          session,
          a.fixtures.session({
            title: '继承用量记录',
            inherited: {
              fromId: session.id,
              fromTitle: session.title,
              messages: [continued],
            },
          }),
        ])
        const rows = await a.usage.collectModelUsage()
        return rows.map((row) => ({
          model: row.model,
          provider: row.providerId,
          tokens: row.days.reduce((sum, item) => sum + a.usage.usageTokenCount(item), 0),
          requests: row.days.reduce((sum, item) => sum + item.requests, 0),
          unpriced: row.days.reduce((sum, item) => sum + item.unpricedRequests, 0),
        }))
      })
      assert.equal(totals.length, 5)
      assert.deepEqual(
        totals.find((row) => row.model === 'deepseek-flash'),
        {
          model: 'deepseek-flash',
          provider: 'deepseek',
          tokens: 6800,
          requests: 1,
          unpriced: 0,
        }
      )
      assert.deepEqual(
        totals.find((row) => row.model === 'deepseek-v4-pro'),
        {
          model: 'deepseek-v4-pro',
          provider: 'deepseek',
          tokens: 12500,
          requests: 2,
          unpriced: 0,
        }
      )
      const custom = totals.filter((row) => row.model === 'shared-model')
      assert.deepEqual(
        custom.map((row) => row.tokens).sort((a, b) => a - b),
        [2000, 3500]
      )
      assert.notEqual(custom[0].provider, custom[1].provider)
      assert.equal(totals.find((row) => row.model === null).unpriced, 1)

      await page.evaluate(() => window.__audit.settingsDialog.openSettings('usage'))
      await page.getByRole('button', { name: '按模型统计', exact: true }).click()
      const ranking = page.getByTestId('model-usage-ranking')
      await ranking.waitFor()
      assert.equal(await ranking.getByRole('button').count(), 3)
      await page.getByRole('button', { name: '今天', exact: true }).click()
      assert.equal(await ranking.getByRole('button').count(), 2)
      await page.getByRole('button', { name: '服务商', exact: true }).click()
      await page.getByRole('option', { name: '历史连接一', exact: true }).click()
      await ranking.getByRole('button', { name: /shared-model.*历史连接一/ }).click()
      await page.getByRole('heading', { name: '模型用量', exact: true }).waitFor()
      assert.match(
        await page.getByTestId('model-usage-overview').textContent(),
        /3\.5k.*1.*暂无单价/
      )
      assert.match(await page.getByTestId('model-usage-trend-value').textContent(), /3,500 Tokens/)
      await page.getByRole('button', { name: '返回', exact: true }).click()
      assert.equal(
        await page.getByRole('button', { name: '今天', exact: true }).getAttribute('aria-pressed'),
        'true'
      )
      assert.match(
        await page.getByRole('button', { name: '服务商', exact: true }).textContent(),
        /历史连接一/
      )
      await page.getByRole('button', { name: '服务商', exact: true }).click()
      await page.getByRole('option', { name: '全部服务商', exact: true }).click()
      await page.getByRole('button', { name: '全部', exact: true }).click()
      assert.equal(await ranking.getByRole('button').count(), 5)
      assert.ok(await ranking.getByRole('button', { name: /未标注模型/ }).isVisible())
    }
  )

  await run(
    'pricing separates official and custom models and recalculates usage by connection',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        const sample = a.providers.saveProvider({
          ...a.providers.emptyProfile(),
          name: '报价测试服务',
          url: 'https://sample.example.test/v1',
          model: 'example-model',
        })
        const date = Date.UTC(2026, 10, 22, 1)
        const make = (id, model, providerId) =>
          a.fixtures.assistant(id, 'sample', {
            model,
            connection: { providerId },
            createdAt: date,
            usage: {
              input_tokens: 1_000_000,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          })
        await a.seed([
          a.fixtures.session({
            id: 'price-demo',
            title: '模型费用示例',
            messages: [
              make('flash', 'deepseek-flash', 'deepseek'),
              make('pro', 'deepseek-v4-pro', 'deepseek'),
              make('other', 'example-model', sample.id),
            ].flatMap((reply, index, replies) => [
              a.fixtures.user('question-' + index, '成本示例', {
                parentId: index > 0 ? replies[index - 1].id : null,
                selectedChildId: reply.id,
              }),
              { ...reply, parentId: 'question-' + index },
            ]),
            rootMessageId: 'question-0',
          }),
        ])
        a.settingsDialog.openSettings('usage')
      })
      const pricing = page.getByRole('button', { name: '价格设置', exact: true })
      await pricing.waitFor()
      if (process.env.FREESEEK_TASK_PREVIEWS) {
        await page.screenshot({
          path: 'tmp/regression/task/usage-' + page.viewportSize().width + '.png',
        })
      }
      await pricing.click()
      const model = page.getByRole('button', { name: '计价模型', exact: true })
      assert.match(await model.textContent(), /DeepSeek Flash/)
      const rates = page.getByRole('spinbutton')
      assert.equal(await rates.nth(1).inputValue(), '1')
      await model.click()
      await page.getByRole('option', { name: 'DeepSeek V4 Pro', exact: true }).click()
      assert.equal(await rates.nth(1).inputValue(), '4.5')
      assert.equal(await rates.nth(4).inputValue(), '9')
      if (process.env.FREESEEK_TASK_PREVIEWS) {
        await page.screenshot({
          path: 'tmp/regression/task/pricing-' + page.viewportSize().width + '.png',
        })
      }
      await rates.nth(1).fill('6')
      await page.getByRole('button', { name: '保存价格', exact: true }).click()
      await page.getByRole('status').filter({ hasText: '已保存' }).waitFor()
      await model.click()
      await page.getByRole('option', { name: /example-model.*报价测试服务/ }).click()
      assert.equal(await rates.count(), 3)
      assert.equal(await rates.nth(1).inputValue(), '')
      await rates.nth(0).fill('0')
      await rates.nth(1).fill('2')
      await rates.nth(2).fill('4')
      await page.getByRole('button', { name: '保存价格', exact: true }).click()
      await page.getByRole('status').filter({ hasText: '已保存' }).waitFor()
      const values = await page.evaluate(async () => {
        const a = window.__audit
        const pack = await a.backup.exportHistory()
        localStorage.removeItem('freeseek:model-prices')
        await a.backup.clearHistory()
        await a.backup.importHistory(new File([pack.blob], 'model-price-check.zip'))
        return Object.fromEntries(
          (await a.usage.collectModelUsage()).map(({ model, days }) => [model, days[0].costCny])
        )
      })
      assert.deepEqual(values, { 'deepseek-flash': 1, 'deepseek-v4-pro': 6, 'example-model': 2 })
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('usagePricing'))
      await model.click()
      await page.getByRole('option', { name: 'DeepSeek V4 Pro', exact: true }).click()
      assert.equal(await rates.nth(1).inputValue(), '6')
    }
  )

  await run(
    'welcome whales swim while responding and keep reduced-motion feedback',
    async (page) => {
      const whale = page.getByTestId('welcome-whale')
      await whale.waitFor()
      const greeting = page.getByRole('heading', { name: '你好，我能帮什么忙吗？', exact: true })
      await greeting.waitFor()
      const current = () =>
        whale
          .locator('[data-whale-ride]')
          .first()
          .evaluate((el) => el.style.transform)
      const before = await current()
      await whale.click()
      const waitForGreeting = async () => {
        for (const position of [0, 0.5, 1]) {
          await page.waitForFunction((portion) => {
            const offsets = Array.from(
              document.querySelectorAll('[data-greeting-part]'),
              (part) => new DOMMatrix(part.style.transform || 'none').m42
            )
            const part = Math.floor((offsets.length - 1) * portion)
            const otherEnd = portion === 0 ? offsets.at(-1) : offsets[0]
            return offsets[part] < -4 && otherEnd >= 0
          }, position)
        }
      }
      await waitForGreeting()
      assert.notEqual(await current(), before)

      await page.evaluate(() => window.__audit.settingsDialog.openSettings('home'))
      await page.getByTestId('settings-directory').waitFor()
      const paused = await current()
      await page.waitForTimeout(130)
      assert.equal(await current(), paused)
      await page.keyboard.press('Escape')
      await page.getByTestId('settings-directory').waitFor({ state: 'detached' })
      await page.waitForFunction(
        (value) => document.querySelector('[data-whale-ride]').style.transform !== value,
        paused
      )

      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('[data-greeting-part]')).every(
          (part) => part.style.transform === 'none'
        )
      )
      await whale.click()
      await waitForGreeting()

      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.waitForFunction(
        () => document.querySelector('[data-whale-ride]').style.transform === 'none'
      )
      await whale.focus()
      await page.keyboard.press('Enter')
      await page.locator('[data-startup-greeting][data-greeting-feedback]').waitFor()
      assert.equal(await current(), 'none')
      assert.ok(
        await greeting
          .locator('[data-greeting-part]')
          .evaluateAll((parts) => parts.every((part) => part.style.transform === 'none'))
      )
      assert.equal(
        await whale
          .locator('[data-whale-reply]')
          .first()
          .evaluate((el) => el.style.transform),
        'none'
      )
    }
  )

  await run(
    'release brand color reaches the packaged whale, the selected chat and markdown links in both themes',
    async (page) => {
      const heading = page.getByRole('heading', { name: '你好，我能帮什么忙吗？', exact: true })
      await heading.waitFor()
      const art = await page.evaluate(async () => {
        const img = document.querySelector('[data-whale-ride] img')
        await img.decode()
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const brush = canvas.getContext('2d')
        brush.drawImage(img, 0, 0)
        const { data } = brush.getImageData(0, 0, canvas.width, canvas.height)
        let brandPixels = 0
        for (let i = 0; i < data.length; i += 4) {
          brandPixels += Number(
            data[i] === 52 && data[i + 1] === 93 && data[i + 2] === 204 && data[i + 3] === 255
          )
        }
        return brandPixels
      })
      assert.ok(art > 200, 'visible whale pixels use the approved blue')
      assert.notEqual(
        await heading.evaluate((node) => getComputedStyle(node).color),
        'rgb(52, 93, 204)'
      )
      await page.evaluate(async () => {
        const a = window.__audit
        const f = a.fixtures
        a.settings.setThemePreference('light')
        await a.seed([
          f.session({
            id: 'brand-proof',
            title: '颜色验收',
            messages: [
              f.user('q', '查看正文链接'),
              f.assistant('answer', '[验收链接](https://example.test)'),
            ],
          }),
        ])
      })
      const link = page.locator('.ds-markdown a').filter({ hasText: '验收链接' })
      await link.waitFor()
      if (page.viewportSize().width < 768) {
        await page.getByRole('button', { name: '打开边栏' }).click()
      }
      const selected = page.locator('[data-session-id="brand-proof"] [aria-current="page"]')
      await selected.waitFor()
      const color = (element) => element.evaluate((node) => getComputedStyle(node).color)
      assert.equal(await color(link), 'rgb(52, 93, 204)')
      assert.equal(await color(selected), 'rgb(52, 93, 204)')
      await page.evaluate(() => window.__audit.settings.setThemePreference('dark'))
      await page.waitForFunction(() => {
        const link = document.querySelector('.ds-markdown a')
        return link && getComputedStyle(link).color === 'rgb(173, 196, 255)'
      })
      assert.equal(await color(selected), 'rgb(173, 196, 255)')
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
      await page.getByRole('button', { name: '添加连接', exact: true }).click()
      await page.getByRole('button', { name: '手动配置', exact: true }).click()
      const more = page.getByRole('button', { name: '连接高级参数', exact: true }),
        shelf = page.getByLabel('模型列表地址（可选）', { exact: true })
      await more.click()
      assert.equal(await page.getByRole('spinbutton').count(), 0)
      await shelf.fill('https://models.example.test/catalog')
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
      assert.equal(await shelf.inputValue(), 'https://models.example.test/catalog')
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await more.click()
      assert.ok(await page.evaluate((id) => document.getElementById(id).hidden, id))
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('data'))
      const official = page.getByRole('button', {
        name: '如何从 DeepSeek 导出聊天记录',
        exact: true,
      })
      assert.equal(await official.getAttribute('aria-expanded'), 'false')
      await official.focus()
      await page.keyboard.press('Enter')
      assert.equal(await official.getAttribute('aria-expanded'), 'true')
      assert.equal(await page.locator('[data-settings-page=data]').getByRole('listitem').count(), 4)
    }
  )

  await run(
    'custom model attachment controls and badges are independent within one connection',
    async (page) => {
      await page.evaluate(() => {
        const a = window.__audit
        a.providers.saveProvider({
          ...a.providers.emptyProfile(),
          url: 'https://models.example.test/v1',
          name: '混合能力连接',
          model: 'photo-model',
          models: ['photo-model', 'plain-model'],
        })
        a.settingsDialog.openSettings('providers')
      })
      await page.getByRole('button', { name: '混合能力连接', exact: true }).click()
      const models = page.locator('[data-settings-page="providerModels"]')
      const photo = models.getByRole('button', { name: 'photo-model', exact: true })
      const plain = models.getByRole('button', { name: 'plain-model', exact: true })
      await photo.click()
      const editor = page.locator('[data-settings-page="providerModel"]')
      const vision = editor.getByRole('switch', { name: '支持图片输入', exact: true })
      const pdf = editor.getByRole('switch', { name: '支持 PDF 输入', exact: true })
      await vision.click()
      await pdf.click()
      await editor.getByRole('button', { name: '模型高级参数', exact: true }).click()
      await editor.getByRole('spinbutton', { name: /采样温度/ }).fill('0.45')
      await editor.getByRole('button', { name: '保存', exact: true }).click()
      await photo.waitFor()
      assert.match(await photo.innerText(), /图片/)
      assert.match(await photo.innerText(), /PDF/)
      assert.doesNotMatch(await plain.innerText(), /图片|PDF/)
      await plain.click()
      assert.equal(await vision.getAttribute('aria-checked'), 'false')
      assert.equal(await pdf.getAttribute('aria-checked'), 'false')
      const saved = await page.evaluate(
        () => window.__audit.providers.useProviders.getState().profiles[0].modelSettings
      )
      assert.equal(saved['photo-model'].temperature, 0.45)
      assert.equal(saved['plain-model'], undefined)

      await page.evaluate(() => window.__audit.settingsDialog.openSettings('account'))
      const account = page.locator('[data-settings-page="account"]')
      await account.getByRole('radio', { name: /DeepSeek Flash.*文本 · 图片 · PDF/ }).waitFor()
      await account.getByRole('button', { name: '选择服务', exact: true }).click()
      const panel = page.getByTestId('option-panel')
      await panel.getByRole('option', { name: '混合能力连接', exact: true }).click()
      const selector = account.getByRole('button', { name: '模型名称 / ID', exact: true })
      await selector.getByText('文本 · 图片 · PDF', { exact: true }).waitFor()
      await selector.click()
      await panel.getByRole('option', { name: /photo-model.*文本 · 图片 · PDF/ }).waitFor()
      await panel.getByRole('option', { name: /plain-model.*纯文本/ }).click()
      await selector.getByText('纯文本', { exact: true }).waitFor()
    }
  )

  await run(
    'onboarding only announces a verified and persisted official key, then returns to the existing draft',
    async (page) => {
      const u = new URL(page.url())
      u.search = ''
      await page.goto(u.href)
      await page.getByRole('button', { name: '我已阅读，继续', exact: true }).click()
      await page.getByRole('button', { name: /^和 AI 聊天/ }).click()
      const ready = page.getByRole('dialog', { name: 'DeepSeek 已就绪', exact: true }),
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
      const official = guide.getByRole('button', { name: '返回官方 API 设置', exact: true })
      await official.click()
      await page.route('**/models', (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' })
      )
      const key = page.getByLabel('API Key', { exact: true }),
        ready = page.getByRole('dialog', { name: 'DeepSeek 已就绪', exact: true })
      await key.fill('replace-one')
      await page.getByRole('button', { name: '验证并保存', exact: true }).click()
      await ready.waitFor()
      assert.match(await ready.innerText(), /我的服务商/)
      await ready.getByRole('button', { name: '返回设置', exact: true }).click()
      assert.equal(
        await page.evaluate(() => window.__audit.providers.useProviders.getState().selection.model),
        'custom-choice'
      )
      await page.getByRole('button', { name: '高级自定义配置', exact: true }).click()
      assert.match(await guide.innerText(), /官方 Key 已配置/)
      await official.click()
      await page.getByRole('button', { name: 'API Key', exact: true }).click()
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
      assert.deepEqual([support.name, settings.name], ['感谢开发者', '设置'])
      assert.equal((await gear.innerText()).trim(), '')
      assert.equal(settings.top, support.top)
      assert.ok(
        settings.width >= 44 && support.right < settings.left,
        JSON.stringify({ support, settings })
      )
      await footer.getByRole('button', { name: '感谢开发者', exact: true }).focus()
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
    'Android predownloads updates without opening a dialog and still requires an install tap',
    async (page) => {
      const calls = () => page.evaluate(() => window.__updateCalls)
      const notice = page.getByTestId('sider-header').getByTestId('sidebar-update'),
        notes = page.getByRole('dialog', { name: '版本 v99.2.1 更新内容', exact: true })
      await page.waitForFunction(() => window.__updateCalls.download === 1)
      assert.equal(await notes.count(), 0)
      assert.deepEqual(await calls(), { download: 1, install: 0 })
      await page.evaluate(() => window.__audit.update.checkForUpdate({ force: true }))
      assert.deepEqual(await calls(), { download: 1, install: 0 })

      await page.getByRole('button', { name: '打开边栏', exact: true }).click()
      assert.match(await notice.innerText(), /下载中/)
      await notice.click()
      assert.equal(await notes.getByRole('listitem').count(), 2)
      assert.equal(await notes.getByRole('button', { name: '安装更新', exact: true }).count(), 0)
      await page.keyboard.press('Escape')
      await notes.waitFor({ state: 'detached' })
      await page.evaluate(() => window.__updateProgress({ received: 70, total: 123 }))
      assert.match(await notice.innerText(), /57%/)
      await notice.click()
      assert.equal(await notes.getByRole('progressbar').getAttribute('aria-valuenow'), '57')

      await page.evaluate(() => window.__failDownload())
      await notes.getByText('下载失败，可以重试', { exact: true }).waitFor()
      assert.deepEqual(await calls(), { download: 4, install: 0 })
      await page.evaluate(() => (window.__failSources = false))
      await notes.getByRole('button', { name: '下载更新', exact: true }).click()
      await page.waitForFunction(() => window.__updateCalls.download === 5)
      await page.evaluate(() => window.__finishDownload())
      await page.keyboard.press('Escape')
      await notes.waitFor({ state: 'detached' })
      await notice.click()
      assert.deepEqual(await calls(), { download: 5, install: 0 })
      await notes.getByRole('button', { name: '安装更新', exact: true }).click()
      await page.waitForFunction(() => window.__updateCalls.install === 1)
      assert.deepEqual(await calls(), { download: 5, install: 1 })
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
      assert.equal(await notes.getByRole('button', { name: '安装更新', exact: true }).count(), 1)
      assert.deepEqual(await calls(), { download: 5, install: 1 })
    },
    async (context) => {
      await context.addInitScript(() => {
        window.CapacitorCustomPlatform = { name: 'android' }
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
        let readyFile = false
        window.Capacitor = {
          PluginHeaders: [
            {
              name: 'App',
              methods: [
                { name: 'addListener', rtype: 'callback' },
                { name: 'removeListener', rtype: 'promise' },
                { name: 'getState', rtype: 'promise' },
              ],
            },
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
          nativeCallback: (plugin, method, options, callback) => {
            if (plugin === 'Update' && options.eventName === 'progress') {
              window.__updateProgress = callback
            }
            return 'fixture-listener'
          },
          nativePromise: async (plugin, method) => {
            if (plugin === 'App') return { isActive: true }
            if (plugin !== 'Update') throw new Error('Unsupported test plugin')
            if (method === 'get') return { status: 200, body: JSON.stringify(metadata) }
            if (method === 'hasFile') {
              return { exists: readyFile, path: readyFile ? '/verified.apk' : '', size: 123 }
            }
            if (method === 'download') {
              window.__updateCalls.download++
              if (window.__failSources) throw new Error('Fixture download error')
              return new Promise((resolve, reject) => {
                window.__finishDownload = () => {
                  readyFile = true
                  resolve({ path: '/verified.apk', size: 123 })
                }
                window.__failDownload = () => {
                  window.__failSources = true
                  reject(new Error('Fixture download error'))
                }
              })
            }
            if (method === 'install') {
              window.__updateCalls.install++
              return { installed: true }
            }
            if (method === 'removeListener') return {}
            throw new Error('Unsupported test method ' + method)
          },
        }
      })
    }
  )
}
