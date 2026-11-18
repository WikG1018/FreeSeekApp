import assert from 'node:assert/strict'

export const runImmersiveCases = async ({ run }) => {
  await run(
    'immersive reading fills the viewport and follows the real composer height without moving reading position',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        a.settings.setApiKey('fixture')
        await a.seed([
          f.session({
            messages: [
              f.user('u', 'Question'),
              f.assistant(
                'a',
                Array.from({ length: 45 }, (_, i) =>
                  `第 ${i + 1} 段：一段用于验证滚动位置与完整内容的长文本。`.repeat(3)
                ).join('\n\n')
              ),
            ],
          }),
        ])
      })
      await page.waitForTimeout(400)
      const before = await page.evaluate(() => {
        const view = document.querySelector('[data-testid="chat-view"]'),
          scroll = document.querySelector('[data-testid="message-scroll"]'),
          composer = document.querySelector('[data-testid="chat-composer"]')
        scroll.scrollTop = 420
        return {
          view: view.getBoundingClientRect().toJSON(),
          scroll: scroll.getBoundingClientRect().toJSON(),
          composer: composer.getBoundingClientRect().height,
          inputRow: composer
            .querySelector('[data-testid="composer-input-row"]')
            .getBoundingClientRect().height,
          mask: getComputedStyle(scroll).webkitMaskImage,
        }
      })
      assert.equal(before.view.top, before.scroll.top)
      assert.equal(before.view.bottom, before.scroll.bottom)
      assert.match(before.mask, /linear-gradient/)
      assert.ok(before.inputRow <= 56 && before.composer <= 108)
      await page.waitForTimeout(100)
      await page.locator('textarea').fill('第一段\n第二段\n第三段\n第四段\n第五段')
      await page.waitForTimeout(400)
      const after = await page.evaluate(() => {
        const scroll = document.querySelector('[data-testid="message-scroll"]'),
          view = document.querySelector('[data-testid="chat-view"]'),
          dock = document.querySelector('[data-testid="chat-dock"]')
        return {
          top: scroll.scrollTop,
          dock: dock.getBoundingClientRect().height,
          inset: parseFloat(getComputedStyle(view).getPropertyValue('--composer-inset')),
          padding: parseFloat(getComputedStyle(scroll.firstElementChild).paddingBottom),
        }
      })
      assert.ok(Math.abs(after.top - 420) < 2, JSON.stringify(after))
      assert.ok(after.dock > before.composer + 40)
      assert.ok(after.inset >= after.dock + 30)
      assert.equal(after.padding, after.inset)
      await page.getByTestId('message-scroll').evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await page.waitForTimeout(100)
      const end = await page.evaluate(() => ({
        last: document
          .querySelector('[data-testid="message-scroll"]')
          .firstElementChild.lastElementChild.getBoundingClientRect().bottom,
        dock: document.querySelector('[data-testid="chat-dock"]').getBoundingClientRect().top,
      }))
      assert.ok(end.last <= end.dock - 20, JSON.stringify(end))
    }
  )
  await run(
    'attachment chooser preserves compact composer height and keeps every action usable with large text',
    async (page) => {
      await page.evaluate(() => window.__audit.settings.setApiKey('fixture'))
      const idleHeight = (await page.getByTestId('chat-composer').boundingBox()).height
      const trigger = page.getByRole('button', { name: '添加附件', exact: true })
      await trigger.click()
      const panel = page.getByTestId('option-panel')
      assert.equal(await panel.getByRole('button').count(), 3)
      assert.equal((await page.getByTestId('chat-composer').boundingBox()).height, idleHeight)
      const chooser = page.waitForEvent('filechooser')
      await panel.getByRole('button', { name: '拍照', exact: true }).click()
      assert.equal(await (await chooser).element().getAttribute('capture'), 'environment')
      await panel.waitFor({ state: 'hidden' })
      assert.ok(await trigger.evaluate((el) => document.activeElement === el))
      await page.setViewportSize({ width: 320, height: 720 })
      await page.evaluate(() => window.__audit.settings.setFontScale(1.25))
      await page.locator('textarea').fill('大字号输入测试')
      await page.waitForTimeout(350)
      const composer = await page.getByTestId('chat-composer').boundingBox()
      const rects = []
      for (const name of ['深度思考', '智能搜索', '添加附件', '发送']) {
        const rect = await page.getByRole('button', { name, exact: true }).boundingBox()
        assert.ok(
          rect &&
            rect.x >= composer.x - 1 &&
            rect.x + rect.width <= composer.x + composer.width + 1 &&
            rect.y + rect.height <= composer.y + composer.height + 1,
          JSON.stringify({ name, rect, composer })
        )
        rects.push(rect)
      }
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i],
            b = rects[j]
          assert.ok(
            Math.min(a.x + a.width, b.x + b.width) <= Math.max(a.x, b.x) + 1 ||
              Math.min(a.y + a.height, b.y + b.height) <= Math.max(a.y, b.y) + 1,
            'Action buttons overlap'
          )
        }
      await page.evaluate(() => {
        const original = window.fetch
        window.fetch = async (url, init) =>
          String(url).endsWith('/messages') ? window.__audit.response('Done') : original(url, init)
      })
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await page.evaluate(() => window.__audit.waitIdle())
      await page.waitForTimeout(350)
      assert.ok((await page.getByTestId('composer-input-row').boundingBox()).height <= 70)
      assert.ok(
        await page
          .getByTestId('composer-toolbar')
          .getByRole('button', { name: '深度思考' })
          .isVisible()
      )
    }
  )

  await run(
    'model, thinking and search stay visible together for long names, large type and both locales',
    async (page) => {
      const model = 'gateway/' + '很长的模型名称-'.repeat(22) + 'instruct'
      await page.evaluate((name) => {
        const a = window.__audit
        a.settings.setApiKey('fixture')
        a.settings.setShowModelSwitcher(true)
        a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: '私有服务',
            url: 'https://primary.example/v1',
            model: name,
          },
          true
        )
      }, model)
      const bar = page.getByTestId('composer-toolbar'),
        trigger = page.getByTestId('composer-model')
      const matrix = [
        [320, 680, 1.25, 'zh-CN'],
        [360, 740, 1, 'zh-CN'],
        [320, 568, 1.25, 'en-US'],
        [780, 360, 1.25, 'en-US'],
        [1024, 768, 1, 'zh-CN'],
      ]
      for (const [w, h, scale, locale] of matrix) {
        await page.setViewportSize({ width: w, height: h })
        await page.evaluate(
          ([size, language]) => {
            const settings = window.__audit.settings
            settings.setFontScale(size)
            settings.setLocale(language)
          },
          [scale, locale]
        )
        const labels = locale === 'zh-CN' ? ['深度思考', '智能搜索'] : ['DeepThink', 'Search']
        for (const name of labels) {
          const button = bar.getByRole('button', { name, exact: true })
          assert.equal(await button.getAttribute('aria-disabled'), 'true')
          assert.equal((await button.textContent()).trim(), name)
        }
        assert.equal(await trigger.getAttribute('title'), model)
        const geometry = await bar.evaluate((el) => {
          const buttons = [...el.querySelectorAll('button')]
          const boxes = buttons.map((b) => b.getBoundingClientRect())
          const measured = buttons[0].querySelector('span')
          return {
            within: boxes.every((r) => r.left >= -1 && r.right <= innerWidth + 1 && r.height >= 43),
            separated: boxes
              .slice(1)
              .every(
                (r, i) =>
                  r.left >= boxes[i].right - 1 &&
                  Math.abs(r.y + r.height / 2 - boxes[0].y - boxes[0].height / 2) < 1.5
              ),
            overflow: el.scrollWidth - el.clientWidth,
            clipped: measured.scrollWidth > measured.clientWidth,
            complete: buttons.slice(1).every((b) => {
              const text = b.querySelector('span > span')
              return text.scrollWidth <= text.clientWidth + 1
            }),
          }
        })
        assert.ok(
          geometry.within &&
            geometry.separated &&
            geometry.clipped &&
            geometry.complete &&
            geometry.overflow <= 1,
          JSON.stringify({ w, scale, ...geometry })
        )
      }
      await page.evaluate(() => {
        window.__audit.settings.setLocale('zh-CN')
        window.__audit.settings.setShowModelSwitcher(false)
      })
      await trigger.waitFor({ state: 'detached' })
      assert.equal(await bar.getByRole('button').count(), 2)
      await page.evaluate(() => {
        window.__audit.providers.selectModel({ providerId: 'deepseek', model: 'deepseek-flash' })
      })
      for (const name of ['深度思考', '智能搜索']) {
        const tool = bar.getByRole('button', { name, exact: true })
        await tool.click()
        assert.equal(await tool.getAttribute('aria-pressed'), 'true')
      }
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      for (const name of ['深度思考', '智能搜索'])
        assert.equal(
          await bar.getByRole('button', { name, exact: true }).getAttribute('aria-pressed'),
          'true'
        )
    }
  )

  await run(
    'one-tap model selection keeps the draft caret and supports bounded grouped catalogs while typing',
    async (page) => {
      await page.evaluate(() => {
        const a = window.__audit
        a.settings.setShowModelSwitcher(true)
        a.settings.setApiKey('fixture')
        a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: '工作室网关',
            url: 'https://review.example/v1',
            model: 'private-model',
            models: Array.from({ length: 5000 }, (_, i) => 'studio-model-' + i),
          },
          false
        )
      })
      const draft = page.getByTestId('chat-composer').locator('textarea'),
        trigger = page.getByTestId('composer-model'),
        panel = page.getByTestId('option-panel')
      await draft.fill('湖面倒映着傍晚的灯')
      await draft.evaluate((el) => el.setSelectionRange(2, 4))
      const caret = () =>
        draft.evaluate((el) => [
          document.activeElement === el,
          el.selectionStart,
          el.selectionEnd,
          el.value,
        ])
      const original = await caret()
      await trigger.click()
      assert.deepEqual(await caret(), original)
      assert.equal(await panel.getByRole('option').count(), 40)
      const sheet = await panel.boundingBox(),
        anchor = await trigger.boundingBox()
      assert.ok(sheet.y + sheet.height <= anchor.y + 1)
      await panel.getByRole('option', { name: /DeepSeek V4 Pro/ }).click()
      assert.deepEqual(await caret(), original)
      assert.equal((await trigger.textContent()).trim(), 'V4 Pro')
      const tool = page.getByTestId('composer-toolbar').getByRole('button', { name: '智能搜索' })
      await tool.click()
      assert.deepEqual(await caret(), original)
      await trigger.click()
      await panel.getByRole('button', { name: '显示更多模型' }).click()
      assert.equal(await panel.getByRole('option').count(), 80)
      const filter = panel.getByRole('searchbox')
      await filter.fill('studio-model-4999')
      assert.equal(await panel.getByRole('option').count(), 1)
      await panel.getByRole('option').click()
      await panel.waitFor({ state: 'detached' })
      assert.deepEqual(await caret(), original)
      assert.equal(await trigger.getAttribute('title'), 'studio-model-4999')
      // The same custom model name may be used by different configured providers.
      await page.evaluate(() => {
        const a = window.__audit
        a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: '第二服务',
            url: 'https://other.example/v1',
            model: 'studio-model-4999',
          },
          false
        )
      })
      await trigger.click()
      await panel.getByRole('searchbox').fill('第二服务')
      await panel.getByRole('option').click()
      assert.equal(
        await page.evaluate(() => {
          const { profiles, selection } = window.__audit.providers.useProviders.getState()
          return profiles.find((p) => p.id === selection.providerId).name
        }),
        '第二服务'
      )
      await trigger.click()
      await page.keyboard.press('Escape')
      assert.deepEqual(await caret(), original)
      await trigger.focus()
      await page.keyboard.press('Space')
      await panel.waitFor()
      await page.keyboard.press('Home')
      await page.keyboard.press('Enter')
      await panel.waitFor({ state: 'detached' })
      assert.equal(await trigger.getAttribute('title'), 'DeepSeek Flash')
      assert.ok(await trigger.evaluate((el) => el === document.activeElement))
    }
  )

  await run(
    'a draft image and inherited images explain model limits without losing attachments or branch selection',
    async (page) => {
      await page.evaluate(() => {
        const a = window.__audit
        a.settings.setApiKey('fixture')
        a.settings.setShowModelSwitcher(true)
      })
      const root = page.getByTestId('chat-composer'),
        trigger = page.getByTestId('composer-model'),
        panel = page.getByTestId('option-panel')
      await root
        .locator('input[type=file][accept="image/*"]:not([capture])')
        .setInputFiles({
          name: 'pixel.png',
          mimeType: 'image/png',
          buffer: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cqGQAAAAASUVORK5CYII=',
            'base64'
          ),
        })
      await trigger.click()
      const pro = panel.getByRole('option', { name: /DeepSeek V4 Pro/ })
      assert.ok(await pro.isDisabled())
      assert.match(await pro.textContent(), /不支持图片/)
      await page.keyboard.press('Escape')
      assert.ok(await root.getByRole('img', { name: 'pixel.png', exact: true }).isVisible())
      await root.getByRole('button', { name: '删除', exact: true }).click()
      await trigger.click()
      assert.ok(await pro.isEnabled())
      await page.keyboard.press('Escape')
      await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        await a.seed([
          f.session({
            id: 'image-history',
            inherited: {
              fromId: 'parent',
              fromTitle: 'Parent',
              messages: [
                f.user('u', 'Picture', {
                  files: [{ id: 'img', name: 'pic.jpg', isImage: true, mimeType: 'image/jpeg' }],
                }),
                f.assistant('a', 'Done'),
              ],
            },
          }),
        ])
      })
      await trigger.click()
      assert.ok(await pro.isDisabled())
      await page.evaluate(() =>
        window.__audit.store.useChatStore.setState({
          streaming: { 'image-history': new AbortController() },
        })
      )
      await panel.waitFor({ state: 'detached' })
      assert.ok(await trigger.isDisabled())
      for (const name of ['深度思考', '智能搜索'])
        assert.ok(await root.getByRole('button', { name, exact: true }).isVisible())
    }
  )
}
