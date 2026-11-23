import assert from 'node:assert/strict'

const openDrawerIfMobile = async (page) => {
  const wide = await page.evaluate(() => window.matchMedia('(min-width: 768px)').matches)
  if (!wide) {
    await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  }
  return !wide
}

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
    'sidebar groups saved chat types without moving pinned rows out of the top group',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        const { session } = a.fixtures
        const now = Date.now()
        await a.seed([
          session({ id: 'new-agent', title: '网页分析 Agent', mode: 'agent', updatedAt: now }),
          session({ id: 'recent-chat', title: '今天的普通对话', updatedAt: now - 1000 }),
          session({
            id: 'pinned-agent',
            title: '置顶 Agent',
            mode: 'agent',
            pinned: true,
            updatedAt: now - 2000,
          }),
          session({
            id: 'older-agent',
            title: '旧格式 Agent',
            mode: 'agent',
            updatedAt: now - 3000,
          }),
          session({ id: 'older-chat', title: '普通对话归档', updatedAt: now - 4000 }),
          session({
            id: 'pinned-chat',
            title: '置顶普通对话',
            pinned: true,
            updatedAt: now - 5000,
          }),
        ])
        // Simulate the summaries written by earlier builds, including a packed conversation.
        const database = await new Promise((resolve, reject) => {
          const open = indexedDB.open('freeseek')
          open.onsuccess = () => resolve(open.result)
          open.onerror = () => reject(open.error)
        })
        try {
          const transaction = database.transaction(['sessions', 'sessionSummaries'], 'readwrite')
          const index = transaction.objectStore('sessionSummaries')
          const chats = transaction.objectStore('sessions')
          const rows = index.openCursor()
          rows.onsuccess = () => {
            const cursor = rows.result
            if (!cursor) return
            const { mode, ...oldSummary } = cursor.value
            cursor.update(oldSummary)
            if (oldSummary.id === 'older-agent') {
              const read = chats.get(oldSummary.id)
              read.onsuccess = () =>
                chats.put({
                  id: oldSummary.id,
                  payload: new Blob([JSON.stringify(read.result)]),
                  summary: oldSummary,
                })
            }
            cursor.continue()
          }
          await new Promise((resolve, reject) => {
            transaction.oncomplete = resolve
            transaction.onerror = () => reject(transaction.error)
          })
        } finally {
          database.close()
        }
        a.settings.setFontScale(1.25)
        a.store.newChat()
      })
      await page.setViewportSize({ width: 320, height: 670 })
      await page.reload()
      await openDrawerIfMobile(page)
      const drawer = page.getByTestId('mobile-sider')
      const row = drawer.getByTestId('sider-quick-actions')
      await page.waitForFunction(() => {
        const drawer = document.querySelector('[data-testid="mobile-sider"]')
        return drawer && drawer.getBoundingClientRect().left >= -0.5
      })
      const field = row.getByRole('searchbox', { name: '搜索标题和聊天正文' })
      const create = row.getByRole('button', { name: '开启新对话' })
      const [searchBox, createBox] = await Promise.all([field.boundingBox(), create.boundingBox()])
      assert.ok(
        Math.abs(searchBox.y + searchBox.height / 2 - createBox.y - createBox.height / 2) < 4
      )
      assert.ok(searchBox.x + searchBox.width <= createBox.x)

      const sort = drawer.getByRole('button', { name: '排序方式' })
      const listIds = (scope = drawer) =>
        scope
          .locator('[data-session-id]')
          .evaluateAll((nodes) => nodes.map((row) => row.dataset.sessionId))
      await drawer.locator('[data-session-id="older-agent"][data-session-mode="agent"]').waitFor()
      const initial = [
        'pinned-agent',
        'pinned-chat',
        'new-agent',
        'recent-chat',
        'older-agent',
        'older-chat',
      ]
      assert.deepEqual(await listIds(), initial)
      assert.equal(await drawer.locator('[data-session-id="new-agent"] button svg rect').count(), 1)
      assert.equal(
        await drawer.locator('[data-session-id="recent-chat"] button svg rect').count(),
        0
      )
      await sort.focus()
      await page.keyboard.press('ArrowDown')
      const options = page.getByRole('listbox', { name: '排序方式' })
      await options.getByRole('option', { name: '按时间', selected: true }).waitFor()
      const [panelBox, drawerBox] = await Promise.all([options.boundingBox(), drawer.boundingBox()])
      assert.ok(
        panelBox.x >= drawerBox.x && panelBox.x + panelBox.width <= drawerBox.x + drawerBox.width
      )
      if (process.env.FREESEEK_TASK_PREVIEWS) {
        await page.screenshot({
          path: 'tmp/regression/sider-order-narrow.png',
          animations: 'disabled',
        })
      }
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      await options.waitFor({ state: 'hidden' })
      assert.equal(await sort.evaluate((button) => document.activeElement === button), true)
      assert.deepEqual(await listIds(drawer.locator('[data-session-group="pinned"]')), [
        'pinned-agent',
        'pinned-chat',
      ])
      assert.deepEqual(await listIds(drawer.locator('[data-session-group="chat"]')), [
        'recent-chat',
        'older-chat',
      ])
      assert.deepEqual(await listIds(drawer.locator('[data-session-group="agent"]')), [
        'new-agent',
        'older-agent',
      ])
      if (process.env.FREESEEK_TASK_PREVIEWS) {
        await sort.blur()
        await page.screenshot({
          path: 'tmp/regression/sider-type-narrow.png',
          animations: 'disabled',
        })
      }

      // Renaming an unopened legacy record must keep its repaired type in the index.
      await page.evaluate(() => window.__audit.db.renameSession('older-agent', '旧格式 Agent 改名'))
      await page.reload()
      await openDrawerIfMobile(page)
      await drawer.locator('[data-session-group="agent"]').waitFor()
      await drawer.getByText('旧格式 Agent 改名', { exact: true }).waitFor()
      await sort.click()
      await options.getByRole('option', { name: '按对话类型', selected: true }).waitFor()
      await options.getByRole('option', { name: '按时间' }).click()
      assert.deepEqual(await listIds(), initial)
      await create.click()
      await drawer.waitFor({ state: 'hidden' })
      if (process.env.FREESEEK_TASK_PREVIEWS) {
        await page.evaluate(() => window.__audit.settings.setThemePreference('dark'))
        await page.setViewportSize({ width: 390, height: 844 })
        await openDrawerIfMobile(page)
        await sort.click()
        await options.getByRole('option', { name: '按对话类型' }).click()
        await sort.blur()
        await page.screenshot({
          path: 'tmp/regression/sider-type-dark.png',
          animations: 'disabled',
        })
        await page.setViewportSize({ width: 1366, height: 900 })
        const desktop = page.getByTestId('sider-quick-actions').filter({ visible: true })
        await desktop.getByRole('searchbox').waitFor()
        await page.screenshot({
          path: 'tmp/regression/sider-type-desktop.png',
          animations: 'disabled',
        })
      }
    }
  )
  await run(
    'sidebar requires a separate choice to delete memories linked to a deleted chat',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([
          a.fixtures.session({
            id: 'linked-memory-chat',
            title: '带记忆的测试对话',
            messages: [a.fixtures.user('linked-message', '以后使用说明包含目录。')],
          }),
        ])
        await a.assistantLibrary.saveMemory({
          text: '使用说明包含目录。',
          pinned: false,
          source: { sessionId: 'linked-memory-chat', messageId: 'linked-message' },
        })
        a.store.newChat()
      })
      const mobile = await openDrawerIfMobile(page)
      const history = mobile ? page.getByTestId('mobile-sider') : page
      const row = history.locator('[data-session-id="linked-memory-chat"]')
      await row.hover()
      await row.getByRole('button', { name: '更多' }).click()
      await page.getByRole('menuitem', { name: '删除', exact: true }).click()
      const confirm = page.getByRole('dialog', { name: '永久删除对话' })
      const includeMemory = confirm.getByRole('checkbox', {
        name: '同时删除来自这段对话的记忆',
      })
      assert.equal(await includeMemory.isChecked(), false)
      await includeMemory.check()
      await confirm.getByRole('button', { name: '删除', exact: true }).click()
      await confirm.waitFor({ state: 'hidden' })
      await row.waitFor({ state: 'hidden' })
      assert.equal(
        await page.evaluate(
          async () => (await window.__audit.assistantLibrary.readAssistantLibrary()).memories.length
        ),
        0
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
      const mobile = await openDrawerIfMobile(page)
      const drawer = mobile ? page.getByRole('dialog', { name: '历史对话', exact: true }) : page
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
      if (mobile) {
        await drawer.waitFor({ state: 'hidden' })
      }
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
      await openDrawerIfMobile(page)
      const row = page.locator('[data-session-id="older"]')
      await row.hover()
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
      await openDrawerIfMobile(page)
      await row.hover()
      await row.getByRole('button', { name: '更多', exact: true }).click()
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
  await run(
    'web back gesture closes settings pages, the drawer and the open chat before leaving',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const wait = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms))
        const settings = () => a.settingsDialog.useSettingsDialog.getState()
        await a.seed([a.fixtures.session({ id: 'back-chat', messages: [] })])
        const steps = {}
        // 设置二级页 → 后退回到一级页，再后退才关闭设置
        a.settingsDialog.openSettings('personas')
        await wait()
        steps.opened = { open: settings().open, page: settings().page }
        window.history.back()
        await wait()
        steps.afterFirstBack = { open: settings().open, page: settings().page }
        window.history.back()
        await wait()
        steps.afterSecondBack = settings().open
        // 侧边栏抽屉
        a.mobileSider.openMobileSider()
        await wait(200)
        steps.siderOpened = a.mobileSider.useMobileSider.getState().open
        window.history.back()
        await wait(300)
        steps.siderClosed = !a.mobileSider.useMobileSider.getState().open
        // 会话页 → 后退回到欢迎页，而不是退出应用
        a.store.selectSession('back-chat')
        await wait(200)
        steps.chatOpened = a.store.useChatStore.getState().activeId
        window.history.back()
        await wait(300)
        steps.activeAfterBack = a.store.useChatStore.getState().activeId
        return steps
      })
      assert.deepEqual(result.opened, { open: true, page: 'personas' })
      assert.deepEqual(result.afterFirstBack, { open: true, page: 'home' })
      assert.equal(result.afterSecondBack, false)
      assert.equal(result.siderOpened, true)
      assert.equal(result.siderClosed, true)
      assert.equal(result.chatOpened, 'back-chat')
      assert.equal(result.activeAfterBack, null)
    }
  )
  await run(
    'web back from settings opened in the drawer closes the drawer before anything else',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        a.mobileSider.openMobileSider()
        return true
      })
      assert.equal(result, true)
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.waitForFunction(() => window.__audit.settingsDialog.useSettingsDialog.getState().open)
      const steps = []
      const snapshot = async () => {
        const state = await page.evaluate(() => ({
          settings: window.__audit.settingsDialog.useSettingsDialog.getState().open,
          sider: window.__audit.mobileSider.useMobileSider.getState().open,
          activeId: window.__audit.store.useChatStore.getState().activeId,
        }))
        steps.push(state)
      }
      await snapshot()
      await page.evaluate(() => window.history.back())
      await page.waitForTimeout(500)
      await snapshot()
      await page.evaluate(() => window.history.back())
      await page.waitForTimeout(500)
      await snapshot()
      assert.equal(steps[1].settings, false)
      assert.equal(steps[2].sider, false)
    }
  )
}