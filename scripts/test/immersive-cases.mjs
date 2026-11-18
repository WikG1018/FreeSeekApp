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
          mask: getComputedStyle(scroll).webkitMaskImage,
        }
      })
      assert.equal(before.view.top, before.scroll.top)
      assert.equal(before.view.bottom, before.scroll.bottom)
      assert.match(before.mask, /linear-gradient/)
      assert.ok(before.composer <= 72)
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
      assert.ok((await page.getByTestId('chat-composer').boundingBox()).height <= 90)
    }
  )
}
