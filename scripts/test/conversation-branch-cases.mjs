import assert from 'node:assert/strict'

const conversationIcon = (row) =>
  row.locator('[data-sider-swipe-row] svg').first().evaluate((icon) => icon.innerHTML)

export const runConversationBranchCases = async (run) => {
  await run(
    'conversation branching follows the selected reply, restores from ZIP, and keeps shared attachments',
    async (page) => {
      await page.setViewportSize({ width: 320, height: 740 })
      const sourceId = 'trip-planning'
      const original = '旅行日程附件原文。'
      await page.evaluate(
        async ({ sourceId, original }) => {
          const a = window.__audit
          const f = a.fixtures
          const blob = new Blob([original], { type: 'text/plain' })
          const file = {
            id: 'trip-plan-file',
            name: '旅行日程.txt',
            size: blob.size,
            mimeType: blob.type,
            serverId: 'file-api-trip-plan',
            isImage: false,
          }
          const usage = {
            input_tokens: 30,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 10,
            output_tokens: 20,
          }
          const source = a.branches.appendBranch(
            f.session({
              id: sourceId,
              title: '周末旅行路线规划',
              pinned: true,
              messages: [
                f.user('source-question', '先看这份旅行日程', { files: [file] }),
                f.assistant('original-version', '没有选中的自驾方案', { usage }),
              ],
            }),
            'source-question',
            [
              f.assistant('chosen-version', '坐火车去海边，住在车站附近。', { usage }),
              f.user('later-question', '再核对一下返程时间'),
              f.assistant('later-version', '只留在原对话的返程方案', { usage }),
            ]
          )
          await a.seed([source], [{ id: file.id, blob }])
          a.settings.setAutoCompress(false)
          const fetch = window.fetch
          window.__branchRequests = []
          window.fetch = async (input, init) => {
            if (!String(input).endsWith('/messages')) return fetch(input, init)
            window.__branchRequests.push(JSON.parse(init.body))
            return a.response('分支续聊：到站以后乘公交去酒店。', usage)
          }
        },
        { sourceId, original }
      )

      const header = page.getByTestId('chat-header')
      const source = page.getByRole('button', { name: '返回来源对话', exact: true })
      const branchButton = (replyId) =>
        page
          .locator('[data-message-id="' + replyId + '"]')
          .getByRole('button', { name: '从这条回复开分支', exact: true })
      const trigger = branchButton('chosen-version')
      const dialog = page.getByRole('dialog', { name: '从这条回复开分支？' })
      const cancel = dialog.getByRole('button', { name: '取消', exact: true })
      const create = dialog.getByRole('button', { name: '创建分支', exact: true })
      const assertSource = async () => {
        assert.deepEqual(await page.evaluate(async () => ({
          active: window.__audit.store.useChatStore.getState().activeId,
          saved: (await window.__audit.db.loadSessionSummaries()).map(({ id }) => id),
        })), { active: sourceId, saved: [sourceId] })
      }

      await trigger.focus()
      await page.keyboard.press('Enter')
      await dialog.waitFor()
      await assertSource()
      const beforeCancel = await page.getByTestId('message-scroll').evaluate((scroll) => scroll.scrollTop)
      await cancel.evaluate((button) => {
        button.click()
        button.nextElementSibling.click()
      })
      await dialog.waitFor({ state: 'hidden' })
      await assertSource()
      assert.equal(await page.getByTestId('message-scroll').evaluate((scroll) => scroll.scrollTop), beforeCancel)
      await page.waitForFunction(() =>
        document.activeElement?.getAttribute('aria-label') === '从这条回复开分支'
      )

      await trigger.click()
      await dialog.waitFor()
      await page.evaluate(() => window.history.back())
      await dialog.waitFor({ state: 'hidden' })
      await assertSource()

      await trigger.click()
      await dialog.waitFor()
      await create.evaluate((button) => {
        button.click()
        button.click()
      })
      await header.getByText('分支 · 先看这份旅行日程', { exact: true }).waitFor()
      await dialog.waitFor({ state: 'hidden' })
      await source.waitFor()
      const first = await page.evaluate(async () => {
        const a = window.__audit
        const id = a.store.useChatStore.getState().activeId
        const saved = await a.db.loadSession(id)
        return {
          ...saved,
          requests: a.usage.summarizeSessionUsage(saved).requests,
          sends: window.__branchRequests.length,
          count: (await a.db.loadSessionSummaries()).length,
        }
      })
      assert.deepEqual(first.branchFrom, { sessionId: sourceId, messageId: 'chosen-version' })
      assert.equal(first.messages.length, 2)
      assert.equal(first.messages[1].blocks[0].text, '坐火车去海边，住在车站附近。')
      assert.equal(first.messages[1].selectedChildId, undefined)
      assert.notEqual(first.messages[1].id, 'chosen-version')
      assert.equal(first.pinned, undefined)
      assert.equal(first.requests, 0)
      assert.equal(first.sends, 0)
      assert.equal(first.count, 2, 'a double confirmation creates one branch')
      assert.equal(await page.getByText('只留在原对话的返程方案', { exact: true }).count(), 0)

      if (process.env.FREESEEK_BRANCH_UI_PROOF) {
        await page.screenshot({
          path: process.env.FREESEEK_BRANCH_UI_PROOF + '/branch-chat-zh.png',
          animations: 'disabled',
        })
      }

      const continued = await page.evaluate(async (id) => {
        const a = window.__audit
        a.settings.setApiKey('synthetic-test-key')
        a.drafts.setDraftText(id, '到了车站如何去酒店？')
        if (!a.store.sendMessage(id)) throw new Error('Failed to send in branch')
        await a.waitIdle()
        const chat = a.store.useChatStore.getState().sessionCache[id]
        return {
          last: a.branches.getVisibleMessages(chat).at(-1).id,
          requests: window.__branchRequests,
        }
      }, first.id)
      assert.equal(continued.requests.length, 1)
      const sent = JSON.stringify(continued.requests[0].messages)
      assert.match(sent, /坐火车去海边/)
      assert.match(sent, /file-api-trip-plan/)
      assert.match(sent, /到了车站如何去酒店/)
      assert.doesNotMatch(sent, /没有选中的自驾方案|只留在原对话的返程方案/)
      await branchButton(continued.last).click()
      await create.click()
      await page.waitForFunction(
        (firstId) => window.__audit.store.useChatStore.getState().activeId !== firstId,
        first.id
      )
      await dialog.waitFor({ state: 'hidden' })
      const nested = await page.evaluate(async () => {
        const a = window.__audit,
          id = a.store.useChatStore.getState().activeId
        const chat = await a.db.loadSession(id)
        return {
          id,
          from: chat.branchFrom,
          replies: chat.messages
            .filter(({ role }) => role === 'assistant')
            .map(a.reply.getReplyText),
          usage: a.usage.summarizeSessionUsage(chat).requests,
        }
      })
      assert.deepEqual(nested.from, { sessionId: first.id, messageId: continued.last })
      assert.deepEqual(nested.replies, [
        '坐火车去海边，住在车站附近。',
        '分支续聊：到站以后乘公交去酒店。',
      ])
      assert.equal(nested.usage, 0)

      await source.click()
      await page.waitForFunction(
        (id) => window.__audit.store.useChatStore.getState().activeId === id,
        first.id
      )
      await source.click()
      await page.locator('[data-message-id="chosen-version"]').waitFor()
      await page.getByText('只留在原对话的返程方案', { exact: true }).waitFor()
      await page.getByRole('button', { name: '打开边栏', exact: true }).click()
      const row = page.locator('[data-session-id="' + nested.id + '"][data-session-branch]')
      await row.waitFor()
      assert.equal(
        await conversationIcon(row),
        await conversationIcon(page.locator('[data-session-id="' + sourceId + '"]')),
        'a branched chat uses the ordinary chat icon'
      )
      if (process.env.FREESEEK_BRANCH_UI_PROOF) {
        await page.screenshot({
          path: process.env.FREESEEK_BRANCH_UI_PROOF + '/branch-sidebar-zh.png',
          animations: 'disabled',
        })
      }
      await row.getByRole('button', { name: '分支 · 到了车站如何去酒店？', exact: true }).click()
      const result = await page.evaluate(
        async ({ sourceId, firstId, nestedId }) => {
          const a = window.__audit
          const { blob, name, skipped } = await a.backup.exportHistory()
          await a.backup.clearHistory()
          await a.backup.importHistory(new File([blob], name))
          const imported = await a.db.loadSession(nestedId)
          const removed = [
            await a.store.removeSession(sourceId),
            await a.store.removeSession(firstId),
          ]
          a.store.selectSession(nestedId)
          return {
            skipped,
            from: imported.branchFrom,
            removed,
            original: await (await a.db.loadFile('trip-plan-file')).text(),
            restoredTitle: imported.title,
            branchInList: a.store.useChatStore.getState().sessions.find(({ id }) => id === nestedId)
              .branchFrom,
          }
        },
        { sourceId, firstId: first.id, nestedId: nested.id }
      )
      assert.deepEqual(result, {
        skipped: 0,
        from: nested.from,
        removed: [true, true],
        original,
        restoredTitle: '分支 · 到了车站如何去酒店？',
        branchInList: nested.from,
      })
      await header.getByText('分支 · 到了车站如何去酒店？', { exact: true }).waitFor()
      assert.equal(await source.count(), 0)
      assert.equal(await page.getByText('旅行日程.txt', { exact: true }).count(), 1)
    }
  )

  await run(
    'conversation branching rebases only the summaries covered by the chosen reply',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        a.settings.setApiKey('synthetic-test-key')
        const history = []
        for (let round = 0; round < 7; round++) {
          history.push(f.user('q-' + round, '这是一段已经讨论过的历史。'.repeat(240)))
          history.push(f.assistant('a-' + round, '第 ' + round + ' 轮的正文。'))
        }
        const session = f.session({
          id: 'summary-source',
          title: '已有压缩的对话',
          messages: history,
          inherited: {
            fromId: 'earlier-source',
            fromTitle: '接续前的会话',
            messages: [
              f.user('inherited-question', '这是已接续的铺垫。'.repeat(300)),
              f.assistant('inherited-reply', '接续前的结论。'),
            ],
          },
        })
        await a.seed([session])
        const fetch = window.fetch
        let requests = 0
        window.fetch = (url, init) => {
          if (!String(url).endsWith('/messages')) return fetch(url, init)
          requests++
          return Promise.resolve(a.response('前几轮已经讨论过的要点。'))
        }
        const summary = await a.store.compressSession(session.id)
        if (!summary || summary.coveredRounds <= 2)
          throw new Error('The compression fixture needs at least 3 rounds')
        const sentBeforeBranch = requests
        await a.store.branchConversation(session.id, 'a-0')
        const early = await a.db.loadSession(a.store.useChatStore.getState().activeId)
        a.store.selectSession(session.id)
        await a.store.branchConversation(session.id, 'a-5')
        const later = await a.db.loadSession(a.store.useChatStore.getState().activeId)
        return {
          earlyRounds: early.messages.length / 2,
          earlySummary: early.contextSummary?.text ?? null,
          inherited: a.reply.getReplyText(early.inherited.messages.at(-1)),
          laterRounds: later.messages.length / 2,
          laterSummary: a.store.currentContextSummary(later)?.text ?? null,
          sourceSummary: summary.text,
          originalSignature: summary.signature,
          branchSignature: later.contextSummary?.signature ?? null,
          copiedCharges: a.usage.summarizeSessionUsage(later).requests,
          requestsForBranches: requests - sentBeforeBranch,
        }
      })
      assert.equal(result.earlyRounds, 1)
      assert.equal(result.earlySummary, null)
      assert.equal(result.inherited, '接续前的结论。')
      assert.equal(result.laterRounds, 6)
      assert.equal(result.laterSummary, result.sourceSummary)
      assert.ok(result.branchSignature && result.branchSignature !== result.originalSignature)
      assert.equal(result.copiedCharges, 0)
      assert.equal(result.requestsForBranches, 0)
    }
  )

  await run(
    'conversation branching keeps the confirmation and original records when saving fails and can retry',
    async (page) => {
      const originalId = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        const chat = f.session({
          messages: [
            f.user('branch-failure-user', '想保留原对话'),
            f.assistant('branch-failure-reply', '原对话里已保存的回答。'),
          ],
        })
        await a.seed([chat])
        const put = IDBObjectStore.prototype.put
        IDBObjectStore.prototype.put = function (record, ...keys) {
          if (record?.branchFrom && !window.__retryBranch) {
            throw new DOMException('synthetic failure', 'QuotaExceededError')
          }
          return put.call(this, record, ...keys)
        }
        return chat.id
      })
      await page.getByRole('button', { name: '从这条回复开分支', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '从这条回复开分支？' })
      const create = dialog.getByRole('button', { name: '创建分支', exact: true })
      await create.click()
      await dialog.getByRole('alert').getByText('没能创建分支，请重试。', { exact: true }).waitFor()
      const stored = await page.evaluate(async () => {
        const a = window.__audit
        return {
          index: (await a.db.loadSessionSummaries()).map(({ id }) => id),
          active: a.store.useChatStore.getState().activeId,
        }
      })
      assert.deepEqual(stored, { index: [originalId], active: originalId })
      await page.getByText('原对话里已保存的回答。', { exact: true }).waitFor()
      assert.equal(await create.isEnabled(), true)
      await page.evaluate(() => { window.__retryBranch = true })
      await create.click()
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(await page.evaluate(async () => (await window.__audit.db.loadSessionSummaries()).length), 2)
    }
  )

  await run(
    'conversation branching retains Agent artifacts with a separate execution state',
    async (page) => {
      await page.setViewportSize({ width: 320, height: 740 })
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        const blob = new Blob(['# 已完成的验收报告'], { type: 'text/markdown' })
        const artifact = {
          id: 'branch-report',
          name: '验收报告.md',
          serverId: null,
          isImage: false,
          size: blob.size,
          mimeType: blob.type,
        }
        const task = {
          plan: [{ label: '完成报告', status: 'done' }],
          steps: [{ id: 'report-step', kind: 'md', status: 'done', file: artifact.name }],
          artifacts: [artifact],
          workspaceId: 'source-workspace',
          run: {
            id: 'original-goal',
            mode: 'goal',
            status: 'completed',
            revision: 1,
            criteria: [],
            met: [],
            startedAt: Date.now(),
            elapsedMs: 4200,
            budgetMinutes: 5,
            budgetRequests: 20,
            totalRequests: 3,
            segmentRequests: 3,
            background: true,
          },
        }
        const source = f.session({
          id: 'branch-agent',
          title: '检查报告',
          mode: 'agent',
          agentRunMode: 'goal',
          workspaceId: 'source-workspace',
          messages: [
            f.user('agent-request', '检查报告格式'),
            f.assistant('agent-completed', '报告已生成。', { task }),
          ],
        })
        await a.seed([source], [{ id: artifact.id, blob }])
        a.store.useChatStore.setState({
          sessions: [
            {
              id: source.id,
              title: source.title,
              createdAt: source.createdAt,
              updatedAt: source.updatedAt,
              mode: source.mode,
            },
          ],
        })
        await a.store.branchConversation(source.id, 'agent-completed')
        const chat = await a.db.loadSession(a.store.useChatStore.getState().activeId)
        const before = await a.db.loadSession(source.id)
        return {
          mode: chat.mode,
          workspace: chat.workspaceId ?? null,
          historicalSteps: chat.messages.at(-1).task.steps.length,
          saved: await (await a.db.loadFile(chat.messages.at(-1).task.artifacts[0].id)).text(),
          oldRun: before.messages.at(-1).task.run.id,
          hasBranchRun: !!chat.messages.at(-1).task.run,
          hasTaskWorkspace: !!chat.messages.at(-1).task.workspaceId,
        }
      })
      assert.deepEqual(result, {
        mode: 'agent',
        workspace: null,
        historicalSteps: 1,
        saved: '# 已完成的验收报告',
        oldRun: 'original-goal',
        hasBranchRun: false,
        hasTaskWorkspace: false,
      })
      const header = page.getByTestId('chat-header')
      await header.getByRole('button', { name: '返回来源对话', exact: true }).waitFor()
      await header.getByRole('button', { name: /^成果/ }).waitFor()
      assert.ok(
        await header.evaluate((node) =>
          [...node.querySelectorAll('button')].every((button) => {
            const rect = button.getBoundingClientRect()
            return rect.left >= 0 && rect.right <= node.clientWidth + 1
          })
        ),
        'the origin action and artifacts fit in a 320px header'
      )
      await page.getByRole('button', { name: '打开边栏', exact: true }).click()
      const branchRow = page.locator('[data-session-branch][data-session-mode="agent"]')
      assert.equal(
        await conversationIcon(branchRow),
        await conversationIcon(page.locator('[data-session-id="branch-agent"]')),
        'a branched Agent conversation uses the Agent icon'
      )
    }
  )
}
