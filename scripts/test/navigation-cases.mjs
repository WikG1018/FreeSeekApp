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
      const body = drawer.locator('[data-session-search-results="long-body"]')
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
      await body.locator('[data-search-message-id="message-5"]').click()
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
      if (!mobile) {
        await page.evaluate(() => window.__audit.settings.setLocale('en-US'))
        await drawer.getByRole('button', { name: 'Cancel search', exact: true }).click()
        assert.equal(await field.inputValue(), '')
        await body.waitFor({ state: 'detached' })
        assert.equal(await drawer.locator('[data-session-id]').count(), 3)
      }
    }
  )

  await run(
    'sidebar shows every matching message in pages and keeps the search after opening an older hit',
    async (page) => {
      await page.setViewportSize({ width: 360, height: 720 })
      await page.evaluate(async () => {
        const a = window.__audit
        const f = a.fixtures
        const history = Array.from({ length: 260 }, (_, index) => {
          const keyword = index >= 4 && index < 245 && (index - 4) % 17 === 0
          const text = keyword
            ? '岸线巡查，第 ' + index + ' 条。岸线巡查。'
            : '查阅资料第 ' + index + ' 条。'
          return index % 2 === 0
            ? f.user('search-many-' + index, text)
            : f.assistant('search-many-' + index, text)
        })
        await a.seed([f.session({ id: 'many-matches', title: '档案整理', messages: history })])
        a.store.newChat()
        a.store.useChatStore.setState({ sessionCache: {} })
      })
      await openDrawerIfMobile(page)
      const drawer = page.getByRole('dialog', { name: '历史对话' })
      const field = drawer.getByRole('searchbox')
      const results = drawer.locator('[data-session-search-results="many-matches"]')
      const items = results.locator('[data-search-message-id]')
      await field.fill('岸线巡查')
      const expand = results.getByRole('button', { name: '查看全部 15 条', exact: true })
      await expand.waitFor()
      assert.equal(await items.count(), 2)
      assert.deepEqual(await items.evaluateAll((nodes) => nodes.map((node) => node.dataset.searchMessageId)),
        ['search-many-242', 'search-many-225'])
      await expand.click()
      await results.getByText('第 1 / 2 页', { exact: true }).waitFor()
      assert.equal(await items.count(), 12)
      if (process.env.FREESEEK_SEARCH_PREVIEWS) {
        await page.screenshot({ path: 'tmp/search-history-qa/search-matches-zh.png', animations: 'disabled' })
      }
      const nextPage = results.getByRole('button', { name: '下一页匹配结果' })
      const previousPage = results.getByRole('button', { name: '上一页匹配结果' })
      await nextPage.click()
      await results.getByText('第 2 / 2 页', { exact: true }).waitFor()
      assert.equal(await items.count(), 3)
      assert.equal(await nextPage.isDisabled(), true)
      await previousPage.click()
      await results.getByText('第 1 / 2 页', { exact: true }).waitFor()
      await nextPage.click()
      await results.getByText('第 2 / 2 页', { exact: true }).waitFor()
      assert.equal(await page.evaluate(
        () => Object.keys(window.__audit.store.useChatStore.getState().sessionCache).length
      ), 0, 'paging search results does not hydrate entire chats')

      await results.locator('[data-search-message-id="search-many-4"]').click()
      await drawer.waitFor({ state: 'hidden' })
      const target = page.locator('[data-message-id="search-many-4"]')
      await target.waitFor()
      assert.ok(await target.evaluate((node) => node.getBoundingClientRect().top < innerHeight / 2))
      // The drawer normally unmounts its contents after the closing transition.
      await page.waitForTimeout(320)
      await openDrawerIfMobile(page)
      assert.equal(await field.inputValue(), '岸线巡查')
      await results.getByText('第 2 / 2 页', { exact: true }).waitFor()
      await results.locator('[data-search-message-id="search-many-21"]').click()
      await drawer.waitFor({ state: 'hidden' })
      await page.waitForFunction(() => {
        const node = document.querySelector('[data-message-id="search-many-21"]')
        const top = node?.getBoundingClientRect().top
        return top !== undefined && top >= 0 && top < innerHeight / 2
      })
      await openDrawerIfMobile(page)
      await field.fill('第 151 条')
      await results.locator('[data-search-message-id="search-many-151"]').waitFor()
      assert.equal(await items.count(), 1, 'replacing the query clears old previews and page state')
    }
  )

  await run(
    'sidebar search refreshes when the selected reply version changes',
    async (page) => {
      await page.setViewportSize({ width: 360, height: 720 })
      await page.evaluate(async () => {
        const a = window.__audit
        const f = a.fixtures
        const original = f.session({
          id: 'version-search',
          title: '版本切换',
          messages: [f.user('version-q', '请分两种方法说明。'), f.assistant('version-one', '第一种是回流测试。')],
        })
        const withVersions = a.branches.appendBranch(original, 'version-q', [
          f.assistant('version-two', '第二种是静压测试。'),
        ])
        await a.seed([a.branches.selectVersion(withVersions, 'version-one')])
        a.store.newChat()
      })
      await openDrawerIfMobile(page)
      const drawer = page.getByRole('dialog', { name: '历史对话' })
      const field = drawer.getByRole('searchbox')
      await field.fill('回流测试')
      await drawer.locator('[data-search-message-id="version-one"]').click()
      await page.getByTestId('mobile-sider').waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: '下一个版本', exact: true }).click()
      await page.locator('[data-message-id="version-two"]').waitFor()
      await openDrawerIfMobile(page)
      assert.equal(await field.inputValue(), '回流测试')
      await drawer.getByText('没有匹配的对话', { exact: true }).waitFor()
      await field.fill('静压测试')
      await drawer.locator('[data-search-message-id="version-two"]').click()
      await page.locator('[data-message-id="version-two"]').waitFor()
    }
  )

  await run(
    'reading after a history search automatically joins adjacent pages and preserves the visible message',
    async (page) => {
      await page.setViewportSize({ width: 360, height: 720 })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.evaluate(async () => {
        const a = window.__audit
        const f = a.fixtures
        const messages = Array.from({ length: 245 }, (_, index) => {
          const text = index === 4 ? '旧消息的唯一词：临水书屋。' : '继续阅读第 ' + index + ' 条消息。'
          return index % 2 === 0 ? f.user('scroll-history-' + index, text) : f.assistant('scroll-history-' + index, text)
        })
        await a.seed([f.session({ id: 'scroll-history', title: '长对话翻页', messages })])
        a.store.newChat()
        a.store.useChatStore.setState({ sessionCache: {} })
      })
      await openDrawerIfMobile(page)
      const drawer = page.getByRole('dialog', { name: '历史对话' })
      await drawer.getByRole('searchbox').fill('临水书屋')
      await drawer.locator('[data-search-message-id="scroll-history-4"]').click()
      await page.getByTestId('mobile-sider').waitFor({ state: 'hidden' })
      const scroll = page.getByTestId('message-scroll')
      const message = (index) => scroll.locator('[data-message-id="scroll-history-' + index + '"]')
      await message(4).waitFor()
      await page.evaluate(async () => {
        await document.fonts.ready
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
      })
      const loadLater = scroll.getByRole('button', { name: /^加载后续消息/ })
      assert.equal(await loadLater.count(), 1, 'the next page has a manual fallback')
      assert.equal(await message(40).count(), 0)
      for (const end of [79, 119, 159, 199, 239, 244]) {
        const anchor = await scroll.evaluate((element, hold) => {
          if (hold) {
            const finger = new Touch({ identifier: 7, target: element, clientX: 96, clientY: 300 })
            element.dispatchEvent(new TouchEvent('touchstart', { touches: [finger] }))
          }
          element.scrollTop = element.scrollHeight
          const viewportTop = element.getBoundingClientRect().top
          const inset = parseFloat(getComputedStyle(element).scrollPaddingTop)
          const first = Array.from(element.querySelectorAll('[data-message-id]'))
            .find((node) => node.getBoundingClientRect().bottom > viewportTop + inset)
          return { id: first.dataset.messageId, top: first.getBoundingClientRect().top }
        }, end === 79)
        if (end === 79) {
          await page.waitForTimeout(200)
          assert.equal(await message(40).count(), 0, 'hold the current range while the touch is active')
          await scroll.evaluate((element) => element.dispatchEvent(new TouchEvent('touchend')))
        }
        await message(end).waitFor()
        const newPosition = await scroll.locator('[data-message-id="' + anchor.id + '"]')
          .evaluate((node) => node.getBoundingClientRect().top)
        assert.ok(Math.abs(newPosition - anchor.top) < 3, JSON.stringify({ end, anchor, newPosition }))
        assert.ok((await scroll.locator('[data-message-id]').count()) <= 120)
        if (end !== 244) assert.equal(await message(244).count(), 0)
      }
      assert.equal(await loadLater.count(), 0)
      // Once the older page has been released, swiping back restores earlier messages in place.
      assert.equal(await message(124).count(), 0)
      await scroll.evaluate((element) => { element.scrollTop = 0 })
      await message(124).waitFor()
      await page.getByRole('button', { name: '回到最新消息', exact: true }).click()
      await message(244).waitFor()
      assert.ok((await scroll.locator('[data-message-id]').count()) <= 40)
    }
  )

  await run(
    'chat title tap reaches the first page and long press opens the assistant without moving the chat',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        document.documentElement.style.setProperty('--fs-safe-top', '24px')
        const messages = Array.from({ length: 52 }, (_, index) =>
          index % 2 === 0
            ? f.user('memory-history-' + index, '历史消息 ' + index)
            : f.assistant('memory-history-' + index, '历史回复 ' + index)
        )
        await a.seed([f.session({ id: 'memory-title', title: '长篇故事', messages })])
      })
      const header = page.getByTestId('chat-header')
      const scroll = page.getByTestId('message-scroll')
      const first = scroll.locator('[data-message-id="memory-history-0"]')
      const title = header.getByRole('button', { name: '长篇故事，回到对话顶部', exact: true })
      const dialog = page.getByRole('dialog', { name: '对话助手', exact: true })
      await page.waitForFunction(() =>
        document.querySelector('[data-testid="message-scroll"]')?.scrollTop > 100
      )
      const previousPosition = await scroll.evaluate((element) => element.scrollTop)
      assert.equal(await first.count(), 0)

      // Use real touch events, including the release after the dialog has appeared.
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
      const bounds = await title.boundingBox()
      assert.ok(bounds)
      const point = [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }]
      const touch = (type) =>
        cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchStart' ? point : [] })
      await touch('touchStart')
      await dialog.waitFor()
      await touch('touchEnd')
      await dialog.waitFor()
      assert.equal(await scroll.evaluate((element) => element.scrollTop), previousPosition)
      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })

      await page.evaluate(() => window.__audit.assistantLibrary.setMemoryEnabled(true))
      await title.press('Shift+F10')
      const pause = dialog.getByRole('switch', { name: /暂停使用记忆/ })
      assert.equal(await pause.getAttribute('aria-checked'), 'false')
      await pause.click()
      assert.equal(
        await page.evaluate(() =>
          window.__audit.store.useChatStore.getState().sessionCache['memory-title'].memoryPaused
        ),
        true
      )
      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })

      await touch('touchStart')
      await touch('touchEnd')
      await first.waitFor()
      await page.waitForFunction(() =>
        document.querySelector('[data-testid="message-scroll"]')?.scrollTop === 0
      )
      assert.equal(await dialog.count(), 0)
      assert.ok((await scroll.locator('[data-message-id]').count()) <= 40)
      await scroll.getByRole('button', { name: /加载后/ }).click()
      await scroll.locator('[data-message-id="memory-history-51"]').waitFor()
    }
  )

  await run(
    'opening a sidebar search result leaves the mobile keyboard closed when the drawer reopens',
    async (page) => {
      await page.setViewportSize({ width: 360, height: 720 })
      await page.evaluate(async () => {
        const a = window.__audit
        const f = a.fixtures
        await a.seed([
          f.session({
            id: 'search-return',
            title: '验收笔记',
            messages: [f.user('search-return-hit', '从岸边出发')],
          }),
        ])
        a.store.selectSession('search-return')
        const viewport = window.visualViewport
        const height = viewport.height
        const editingHeight = () => {
          if (document.activeElement?.matches('textarea')) return 300
          if (document.activeElement?.matches('input[type="search"]')) return 210
          return height
        }
        Object.defineProperties(viewport, {
          height: { configurable: true, get: editingHeight },
          offsetTop: { configurable: true, get: () => (editingHeight() < height ? 20 : 0) },
        })
      })
      const frame = page.locator('[data-fs-app-frame]')
      const editor = page.getByTestId('chat-composer').locator('textarea')
      await editor.focus()
      await page.waitForFunction(() => document.querySelector('[data-fs-app-frame]').hasAttribute('data-ime-open'))
      const opener = page.getByRole('button', { name: '打开边栏', exact: true })
      // Some touch WebViews activate the button without moving focus away from the composer.
      await opener.evaluate((button) => button.click())
      const drawer = page.getByTestId('mobile-sider')
      const field = drawer.getByRole('searchbox')
      await field.fill('岸边')
      await drawer.locator('[data-search-message-id="search-return-hit"]').click()
      await drawer.waitFor({ state: 'hidden' })
      await page.locator('[data-message-id="search-return-hit"]').waitFor()
      assert.equal(await editor.evaluate((node) => document.activeElement === node), false)
      await page.waitForFunction(() => !document.querySelector('[data-fs-app-frame]').hasAttribute('data-ime-open'))

      const motion = await opener.evaluate(async (button) => {
        const header = document.querySelector('[data-testid="sider-header"]')
        button.click()
        const positions = []
        for (let frame = 0; frame < 12; frame++) {
          await new Promise((resolve) => requestAnimationFrame(resolve))
          positions.push(header.getBoundingClientRect().top)
        }
        return positions
      })
      assert.ok(Math.max(...motion) - Math.min(...motion) <= 1, JSON.stringify(motion))
      assert.equal(await frame.getAttribute('data-ime-compact'), null)
      assert.equal(await field.inputValue(), '岸边')
      assert.equal(await drawer.locator('[data-search-message-id="search-return-hit"]').count(), 1)

      const cancel = drawer.getByRole('button', { name: '取消搜索', exact: true })
      await page.setViewportSize({ width: 320, height: 720 })
      const controls = drawer.getByTestId('sider-quick-actions')
      const [inputBox, cancelBox, newChatBox] = await Promise.all([
        field.boundingBox(),
        cancel.boundingBox(),
        controls.locator('button[data-chat-mode-anchor]').boundingBox(),
      ])
      assert.ok(
        inputBox && cancelBox && newChatBox &&
          inputBox.x + inputBox.width <= cancelBox.x + 1 &&
          cancelBox.x + cancelBox.width < newChatBox.x,
        'search and its cancel control fit beside New Chat at 320px'
      )
      if (process.env.FREESEEK_SEARCH_PREVIEWS) {
        await page.screenshot({ path: 'tmp/search-history-qa/sidebar-search-cancel-zh.png', animations: 'disabled' })
      }
      await field.focus()
      await page.waitForFunction(() => document.querySelector('[data-fs-app-frame]').hasAttribute('data-ime-open'))
      await cancel.click()
      assert.equal(await field.inputValue(), '')
      await cancel.waitFor({ state: 'detached' })
      await page.waitForFunction(() => !document.querySelector('[data-fs-app-frame]').hasAttribute('data-ime-open'))
      assert.equal(await drawer.locator('[data-search-message-id]').count(), 0)
      await drawer.locator('[data-session-id="search-return"]').waitFor()

      await field.fill('岸边')
      await drawer.locator('[data-search-message-id="search-return-hit"]').waitFor()
      await field.press('Escape')
      assert.equal(await field.inputValue(), '')
      assert.ok(await drawer.isVisible(), 'Escape cancels the search before closing the drawer')
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
  await run(
    'web back closes a modal dialog before the drawer and the conversation',
    async (page) => {
      await page.evaluate(() => window.__audit.mobileSider.openMobileSider())
      await page.getByRole('button', { name: '感谢开发者', exact: true }).click()
      const donate = page.getByRole('dialog', { name: '感谢开发者' })
      await donate.waitFor()
      await page.evaluate(() => window.history.back())
      await donate.waitFor({ state: 'hidden' })
      assert.equal(await page.evaluate(() => window.__audit.mobileSider.useMobileSider.getState().open), true)
      await page.evaluate(() => window.history.back())
      await page.waitForFunction(() => !window.__audit.mobileSider.useMobileSider.getState().open)
      assert.equal(await page.evaluate(() => window.__audit.mobileSider.useMobileSider.getState().open), false)
    }
  )
  await run(
    'web back at the welcome screen prompts instead of leaving the app',
    async (page) => {
      await page.evaluate(() => window.__audit.mobileSider.closeMobileSider())
      await page.evaluate(() => window.__audit.store.returnToWelcome())
      await page.waitForTimeout(200)
      await page.evaluate(() => window.history.back())
      await page.getByText('再按一次返回退出', { exact: false }).waitFor({ timeout: 3000 })
      assert.equal(await page.evaluate(() => Boolean(window.__audit)), true)
      await page.evaluate(() => window.history.back())
      await page.waitForTimeout(600)
      assert.equal(await page.evaluate(() => Boolean(window.__audit)).catch(() => false), false)
    }
  )
  await run(
    'web back keeps two guard entries so a second press during the popstate gap cannot leave the app',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const wait = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms))
        const guard = () => (history.state?.freeseekBackGuard ? history.state.depth : 0)
        const steps = { guards: [] }
        await a.seed([a.fixtures.session({ id: 'gap-chat', messages: [] })])
        // 安装后应立刻有两条守卫（当前这条 + 前面一条），历史长度固定。
        steps.guards.push({ at: 'installed', depth: guard(), length: history.length })
        // 每轮：开一层，再在 popstate 之前的空档里连按两下（实测空档 22–650ms）。
        // 单守卫时空档里那一下会让浏览器认为「前面没有记录」直接退出；双守卫时仍落在文档内。
        const rounds = [
          { name: 'settings', open: () => a.settingsDialog.openSettings('personas'), gap: 0 },
          { name: 'drawer', open: () => a.mobileSider.openMobileSider(), gap: 20 },
          { name: 'chat', open: () => a.store.selectSession('gap-chat'), gap: 60 },
        ]
        for (const round of rounds) {
          round.open()
          await wait()
          window.history.back()
          await new Promise((resolve) => setTimeout(resolve, round.gap))
          window.history.back()
          await wait(900)
          steps.guards.push({ at: `rapid x2 on ${round.name} gap ${round.gap}`, depth: guard(), length: history.length })
        }
        await wait()
        steps.alive = Boolean(window.__audit)
        steps.settings = a.settingsDialog.useSettingsDialog.getState().open
        steps.sider = a.mobileSider.useMobileSider.getState().open
        steps.active = a.store.useChatStore.getState().activeId
        return steps
      })
      assert.equal(result.alive, true, 'app must survive rapid double presses')
      // 每轮的第二下要么关掉下一层，要么落在外层提示上；三轮下来不该退出，层级全部收起。
      assert.equal(result.settings, false)
      assert.equal(result.sider, false)
      assert.equal(result.active, null)
      for (const entry of result.guards) {
        assert.equal(entry.depth, 2, `guard depth at ${entry.at}`)
      }
      const lengths = new Set(result.guards.map((entry) => entry.length))
      assert.equal(lengths.size, 1, `history length must stay constant, saw ${[...lengths]}`)
    }
  )
  await run(
    'iOS home-screen PWA: no history entries are pushed, so the edge swipe cannot flash a blank page',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const wait = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms))
        const before = { length: history.length, state: JSON.stringify(history.state) }
        a.settingsDialog.openSettings('personas')
        await wait()
        const opened = a.settingsDialog.useSettingsDialog.getState()
        await wait(600)
        return {
          before,
          length: history.length,
          guard: history.state?.freeseekBackGuard ?? null,
          depth: history.state?.depth ?? null,
          state: JSON.stringify(history.state),
          settingsOpen: a.settingsDialog.useSettingsDialog.getState().open,
          page: a.settingsDialog.useSettingsDialog.getState().page,
          openedPage: opened.page,
          alive: Boolean(window.__audit),
        }
      })
      // iOS 主屏幕版不压任何历史记录：手势没有可切换的记录，也就不会画白屏快照。
      assert.equal(result.guard, null, 'iOS must not push guard entries')
      assert.equal(result.length, result.before.length, 'history length must not grow')
      assert.equal(result.alive, true)
      assert.equal(result.openedPage, 'personas')
      assert.equal(result.settingsOpen, true, 'settings stay open; layers close via the UI buttons')
      assert.equal(result.page, 'personas')
    },
    // navigator.standalone 仅 iOS Safari 提供，主屏幕 PWA 模式下为 true。
    async (context) => {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })
      })
    }
  )
  await run(
    'iOS home-screen PWA: settings can be closed from the home page',
    async (page) => {
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('home'))
      const close = page.locator('[data-settings-close]')
      await close.waitFor({ timeout: 5000 })
      await close.click()
      await page.waitForFunction(
        () => !window.__audit.settingsDialog.useSettingsDialog.getState().open,
        null,
        { timeout: 5000 }
      )
      // 关掉后应用仍然可用，不会因为「进得去出不来」卡在设置页
      assert.equal(
        await page.evaluate(() => Boolean(window.__audit)),
        true
      )
    },
    async (context) => {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })
      })
    }
  )
}