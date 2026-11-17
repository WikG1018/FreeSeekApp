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
      await page.getByPlaceholder('搜索对话标题…').fill('会话 1255')
      await page.waitForFunction(() => document.querySelectorAll('[data-session-id]').length === 1)
      assert.equal(
        await page.locator('[data-session-id]').first().getAttribute('data-session-id'),
        'batch-1255'
      )
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
