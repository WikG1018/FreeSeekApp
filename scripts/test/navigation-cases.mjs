import assert from 'node:assert/strict'

const swipe = async (page, start, end, cancel = false) => {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  const touch = ([x, y]) => [{ x, y, id: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch(start) })
  for (let step = 1; step <= 8; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: touch(start.map((v, i) => v + ((end[i] - v) * step) / 8)),
    })
    await page.waitForTimeout(18)
  }
  await cdp.send('Input.dispatchTouchEvent', {
    type: cancel ? 'touchCancel' : 'touchEnd',
    touchPoints: [],
  })
  await cdp.detach()
  await page.waitForTimeout(350)
}

export const runNavigationCases = async ({ run }) => {
  await run(
    'drawer commits the physical release point when Android coalesces the last move',
    async (page) => {
      await page.evaluate(() => {
        const target = document.querySelector('main')
        const send = (name, x) => {
          const point = new Touch({ identifier: 4, target, clientX: x, clientY: 270 })
          target.dispatchEvent(
            new TouchEvent(name, {
              bubbles: true,
              cancelable: true,
              touches: name === 'touchend' ? [] : [point],
              changedTouches: [point],
            })
          )
        }
        send('touchstart', 85)
        send('touchmove', 100)
        send('touchend', 280)
      })
      await page.getByRole('dialog', { name: '历史对话', exact: true }).waitFor()
    }
  )
  await run(
    'large sidebar lists render in batches while search includes the complete history',
    async (page) => {
      await page.evaluate(() => {
        const a = window.__audit,
          now = Date.now()
        a.store.newChat()
        a.store.useChatStore.setState({
          sessions: Array.from({ length: 1300 }, (_, index) => ({
            id: 'batch-' + index,
            title: '会话 ' + index,
            createdAt: now,
            updatedAt: now - index,
            pinned: index === 1299,
          })),
        })
      })
      await page.getByRole('button', { name: '打开边栏', exact: true }).click()
      await page.getByRole('dialog', { name: '历史对话', exact: true }).waitFor()
      assert.equal(await page.locator('[data-session-id]').count(), 80)
      assert.equal(
        await page.locator('[data-session-id]').first().getAttribute('data-session-id'),
        'batch-1299'
      )
      await page.getByTestId('sider-list').evaluate((node) => {
        node.scrollTop = node.scrollHeight
      })
      await page.waitForFunction(
        () => document.querySelectorAll('[data-session-id]').length === 160
      )
      await page.getByRole('searchbox', { name: '搜索标题和聊天正文' }).fill('会话 1255')
      await page.waitForFunction(() => document.querySelectorAll('[data-session-id]').length === 1)
      assert.equal(
        await page.locator('[data-session-id]').first().getAttribute('data-session-id'),
        'batch-1255'
      )
    }
  )
  await run(
    'sidebar searches uncached message text and opens the result without mounting a long conversation',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        const f = a.fixtures
        const history = Array.from({ length: 160 }, (_, index) =>
          index % 2 === 0
            ? f.user('message-' + index, index === 4 ? '书单关键字 海边书店' : '旧问题 ' + index)
            : f.assistant(
                'message-' + index,
                index === 5 ? '原文里有 A+B 这个记号。' : '旧回复 ' + index,
                index === 39 ? { status: 'stopped' } : {}
              )
        )
        await a.seed([
          f.session({ id: 'long-body', title: '已存档的长对话', messages: history }),
          f.session({ id: 'title-only', title: 'A+B 的标题', messages: [] }),
          f.session({
            id: 'irrelevant',
            title: '没有匹配',
            messages: [f.user('different', '这里是 abb 而不是带加号的短语')],
          }),
        ])
        a.store.newChat()
        a.store.useChatStore.setState({ sessionCache: {} })
      })
      await page.getByRole('button', { name: '打开边栏', exact: true }).click()
      const drawer = page.getByRole('dialog', { name: '历史对话', exact: true })
      const field = drawer.getByRole('searchbox')
      const body = drawer.locator('[data-session-id="long-body"]')
      await field.fill('海边书店')
      await body.locator('mark').getByText('海边书店', { exact: true }).waitFor()
      assert.equal(await drawer.locator('[data-session-id]').count(), 1)
      // Legacy Android input methods can keep Latin text in composition until the user accepts it.
      await field.evaluate((input) => {
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        const value = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
        value.set.call(input, 'a+b')
        input.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            isComposing: true,
            inputType: 'insertCompositionText',
          })
        )
      })
      await body.locator('mark').getByText('A+B', { exact: true }).waitFor()
      assert.equal(await drawer.locator('[data-session-id]').count(), 2)
      assert.equal(
        await page.evaluate(
          () => Object.keys(window.__audit.store.useChatStore.getState().sessionCache).length
        ),
        0
      )
      await body.getByRole('button', { name: /已存档的长对话/ }).click()
      await drawer.waitFor({ state: 'hidden' })
      const reply = page.locator('[data-message-id="message-5"]')
      await reply.waitFor()
      assert.ok(
        await reply.evaluate((element) => {
          const top = element.getBoundingClientRect().top
          return top >= 0 && top < innerHeight / 2
        })
      )
      assert.ok((await page.locator('[data-message-id]').count()) <= 40)
      assert.equal(await page.getByRole('button', { name: '继续生成', exact: true }).count(), 0)
      await page.getByRole('button', { name: '回到最新消息', exact: true }).click()
      await page.locator('[data-message-id="message-159"]').waitFor()
      assert.ok((await page.locator('[data-message-id]').count()) <= 40)
    }
  )

  await run(
    'sidebar search gives the keyboard space and restores footer controls after dismissal',
    async (page) => {
      await page.getByRole('button', { name: '打开边栏', exact: true }).click()
      const drawer = page.getByRole('dialog', { name: '历史对话', exact: true })
      const footer = drawer.getByTestId('sider-footer')
      const field = drawer.getByRole('searchbox')
      await footer.waitFor()
      assert.equal(await drawer.getByRole('button', { name: '收起边栏', exact: true }).count(), 0)
      assert.equal(await drawer.getByTestId('sidebar-update').count(), 0)
      await field.fill('仍在搜索')
      await page.evaluate(() => {
        const viewport = window.visualViewport
        const fullHeight = viewport.height
        Object.defineProperty(viewport, 'height', {
          configurable: true,
          get: () => (window.__imeOpen ? 210 : fullHeight),
        })
        window.__imeOpen = true
        viewport.dispatchEvent(new Event('resize'))
      })
      await footer.waitFor({ state: 'hidden' })
      const metrics = await drawer.getByTestId('sider-list').evaluate((node) => ({
        height: node.clientHeight,
        bottom: node.getBoundingClientRect().bottom,
        visible: window.visualViewport.height,
      }))
      assert.ok(metrics.height >= 75, JSON.stringify(metrics))
      assert.ok(metrics.bottom <= metrics.visible + 1)
      await page.evaluate(() => {
        window.__imeOpen = false
        visualViewport.dispatchEvent(new Event('resize'))
      })
      await footer.waitFor()
      assert.equal(await field.inputValue(), '仍在搜索')
      assert.ok(await field.evaluate((element) => element === document.activeElement))
    }
  )
  await run(
    'center swipe opens the drawer, reverses and cancels cleanly without stealing vertical or input gestures',
    async (page) => {
      await page.evaluate(() => {
        window.__audit.settings.setApiKey('fixture')
        window.__audit.store.newChat()
      })
      await swipe(page, [140, 220], [340, 224])
      const drawer = page.getByRole('dialog', { name: '历史对话', exact: true })
      await drawer.waitFor()
      assert.equal(await drawer.getByTestId('sider-footer').getByRole('button').count(), 2)
      assert.doesNotMatch(await drawer.getByTestId('sider-footer').innerText(), /FreeSeek|用量/)
      assert.ok((await drawer.boundingBox()).x >= -1)
      await page.screenshot({ path: 'tmp/regression/sidebar-light.png' })
      await swipe(page, [260, 300], [70, 302])
      await drawer.waitFor({ state: 'hidden' })
      await swipe(page, [140, 220], [290, 224], true)
      await drawer.waitFor({ state: 'hidden' })
      await swipe(page, [140, 250], [148, 430])
      assert.equal(await drawer.isVisible(), false)
      await page.getByRole('button', { name: '打开边栏', exact: true }).click()
      await drawer.waitFor()
      await page.keyboard.press('Escape')
      await drawer.waitFor({ state: 'hidden' })
      const input = page.locator('textarea').first()
      await input.fill('输入中保持光标')
      const box = await input.boundingBox()
      await swipe(page, [box.x + 20, box.y + 15], [box.x + 160, box.y + 15])
      assert.equal(await drawer.isVisible(), false)
      assert.equal(await input.inputValue(), '输入中保持光标')
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await input.blur()
      await page.getByRole('button', { name: '打开边栏', exact: true }).click()
      await drawer.waitFor()
      await page.getByTestId('sider-mask').click({ position: { x: 382, y: 400 } })
      await drawer.waitFor({ state: 'hidden' })
    }
  )

  await run(
    'pinning an unloaded chat persists, sorts into pinned group, survives backup and can be undone',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        await a.seed([
          f.session({
            id: 'newer',
            title: '较新对话',
            updatedAt: Date.now(),
            messages: [f.user('n', 'new')],
          }),
          f.session({
            id: 'older',
            title: '置顶测试',
            updatedAt: Date.now() - 86_400_000 * 60,
            messages: [f.user('o', 'original')],
          }),
        ])
        a.store.newChat()
        a.store.useChatStore.setState({ sessionCache: {} })
      })
      await page.getByRole('button', { name: '打开边栏', exact: true }).click()
      const row = page.locator('[data-session-id="older"]')
      await row.getByRole('button', { name: '更多', exact: true }).click()
      await page.getByRole('menuitem', { name: '置顶对话', exact: true }).click()
      await page.waitForFunction(
        () =>
          window.__audit.store.useChatStore.getState().sessions.find((s) => s.id === 'older').pinned
      )
      assert.equal(
        await page.locator('[data-session-id]').first().getAttribute('data-session-id'),
        'older'
      )
      await page.waitForFunction(
        async () => (await window.__audit.db.loadSession('older')).pinned === true
      )
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      const imported = await page.evaluate(async () => {
        const a = window.__audit,
          pack = await a.backup.exportHistory()
        await a.backup.importHistory(new File([pack.blob], pack.name))
        return (await a.db.loadSession('older')).pinned
      })
      assert.equal(imported, true)
      await page.getByRole('button', { name: '打开边栏', exact: true }).click()
      await page
        .locator('[data-session-id="older"]')
        .getByRole('button', { name: '更多', exact: true })
        .click()
      await page.getByRole('menuitem', { name: '取消置顶', exact: true }).click()
      await page.waitForFunction(
        async () => (await window.__audit.db.loadSession('older')).pinned === false
      )
      assert.equal(
        await page.locator('[data-session-id]').first().getAttribute('data-session-id'),
        'newer'
      )
    }
  )
}
