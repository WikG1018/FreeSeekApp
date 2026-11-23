import assert from 'node:assert/strict'

export const runAssistantCases = async (run) => {
  await run(
    'automatic memory uses one switch for all configured models and counts its own usage',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        a.settings.setApiKey('memory-maintenance-fixture')
        a.settings.setSearch(false)
        await a.assistantLibrary.saveMemory({ text: '偏好工程报告有目录', pinned: true })
        await a.seed([a.fixtures.session({ id: 'automatic-evidence', title: '工程报告' })])
        const original = window.fetch
        window.__memoryRequests = { regular: 0, background: 0 }
        window.__memorySystems = []
        window.fetch = async (url, init) => {
          if (new URL(url).hostname === 'memory-fixture.invalid') {
            window.__memorySystems.push(JSON.parse(init.body).messages[0].content)
            return new Response(
              'data: {"choices":[{"delta":{"content":"收到偏好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { headers: { 'Content-Type': 'text/event-stream' } }
            )
          }
          if (!new URL(url).pathname.endsWith('/anthropic/v1/messages')) return original(url, init)
          const request = JSON.parse(init.body)
          if (String(request.system).startsWith('Extract only stable preferences')) {
            window.__memoryRequests.background++
            return a.response(
              JSON.stringify({
                items: [
                  {
                    preference: '喜欢目录简洁的工程报告',
                    evidence: [
                      { message: 0, quote: '目录写得清楚一点' },
                      { message: 1, quote: '简洁的目录' },
                    ],
                  },
                ],
              }),
              {
                input_tokens: 18,
                output_tokens: 9,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              }
            )
          }
          window.__memoryRequests.regular++
          window.__memorySystems.push(request.system)
          return a.response('知道了。')
        }
        window.__sendMemoryEvidence = async (text) => {
          a.drafts.setDraftText('automatic-evidence', text)
          a.store.sendMessage('automatic-evidence')
          await a.waitIdle()
        }
        a.settingsDialog.openSettings('assistantSettings')
      })
      const toggle = page.getByRole('switch', { name: '自动记忆', exact: true })
      await toggle.click()
      await page.waitForFunction(
        () =>
          window.__audit.assistantLibrary.useAssistantLibrary.getState().data.automaticVersion === 2
      )
      await page.evaluate(async () => {
        window.__audit.settingsDialog.closeSettings()
        await window.__sendMemoryEvidence('看工程报告时我更想让目录写得清楚一点。')
        await window.__sendMemoryEvidence('读工程报告时，我喜欢先找到简洁的目录。')
      })
      await page.waitForFunction(
        () =>
          window.__audit.assistantLibrary.useAssistantLibrary.getState().data.activity.length === 1
      )
      const saved = await page.evaluate(() => ({
        requests: window.__memoryRequests,
        maintenance:
          window.__audit.assistantLibrary.useAssistantLibrary.getState().data.maintenance,
        last: window.__audit.assistantLibrary.useAssistantLibrary.getState().data.activity[0]
          ?.current.text,
      }))
      assert.equal(saved.last, '喜欢目录简洁的工程报告')
      assert.deepEqual(saved.requests, { regular: 2, background: 1 })
      assert.equal(saved.maintenance.requests, 1)
      assert.equal(saved.maintenance.input, 18)
      assert.equal(saved.maintenance.output, 9)
      await page.evaluate(async () => {
        const a = window.__audit
        a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: '记忆验收连接',
            url: 'https://memory-fixture.invalid/v1',
            apiKey: 'memory-fixture-key',
            model: 'fixture-model',
          },
          true
        )
        await window.__sendMemoryEvidence('整理工程报告。')
        a.settingsDialog.openSettings('assistantSettings')
      })
      const memoryBeforeOff = await page.evaluate(() => window.__memorySystems.slice())
      assert.equal(memoryBeforeOff.length, 3)
      for (const request of memoryBeforeOff) assert.match(request, /偏好工程报告有目录/)
      await page.getByRole('button', { name: '记忆详情', exact: true }).click()
      await page.getByText('自动整理用量', { exact: true }).waitFor()
      assert.equal(await page.getByRole('switch').count(), 0)
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('assistantSettings'))
      await toggle.click()
      await page.waitForFunction(
        () => !window.__audit.assistantLibrary.useAssistantLibrary.getState().data.enabled
      )
      await page.evaluate(async () => {
        window.__audit.settingsDialog.closeSettings()
        await window.__sendMemoryEvidence('再核对工程报告。')
      })
      const afterOff = await page.evaluate(() => ({
        system: window.__memorySystems.at(-1),
        data: window.__audit.assistantLibrary.useAssistantLibrary.getState().data,
      }))
      assert.doesNotMatch(afterOff.system, /偏好工程报告有目录/)
      assert.equal(afterOff.data.grants.length, 0)
      assert.equal(afterOff.data.memories.length, 2)
      assert.equal(await page.getByRole('dialog', { name: '允许使用这些记忆？' }).count(), 0)
    }
  )

  await run(
    'assistant automatic memory saves, revises and undoes durable preferences without confirmation',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        a.settings.setApiKey('memory-review-fixture')
        a.settings.setSearch(false)
        await a.seed([a.fixtures.session({ id: 'memory-auto-review', title: '验收报告' })])
        let requests = 0
        const original = window.fetch
        window.fetch = async (url, init) => {
          if (!new URL(url).pathname.endsWith('/anthropic/v1/messages')) return original(url, init)
          requests++
          return a.response('收到。')
        }
        window.__autoMemoryRequestCount = () => requests
        window.__sendPreference = async (text) => {
          a.drafts.setDraftText('memory-auto-review', text)
          a.store.sendMessage('memory-auto-review')
          await a.waitIdle()
        }
        await window.__sendPreference('以后验收报告用 Word')
        a.settingsDialog.openSettings('assistantSettings')
      })
      const automatic = page.getByRole('switch', { name: '自动记忆' })
      assert.equal(await automatic.getAttribute('aria-checked'), 'false')
      assert.equal(
        await page.evaluate(
          () => window.__audit.assistantLibrary.useAssistantLibrary.getState().data.memories.length
        ),
        0
      )
      await automatic.click()
      await page.waitForFunction(
        () => window.__audit.assistantLibrary.useAssistantLibrary.getState().data.automatic
      )
      await page.evaluate(async () => {
        window.__audit.settingsDialog.closeSettings()
        await window.__sendPreference('以后验收报告用 Word')
      })
      await page.waitForFunction(
        () =>
          window.__audit.assistantLibrary.useAssistantLibrary.getState().data.memories[0]?.text ===
          '验收报告用 Word'
      )
      const prior = await page.evaluate(
        () => window.__audit.assistantLibrary.useAssistantLibrary.getState().data.memories[0]
      )
      await page.evaluate(async () => {
        await window.__sendPreference('以后改用 Markdown')
        await window.__sendPreference('这次发 PDF')
        window.__audit.settingsDialog.openSettings('assistantSettings')
      })
      await page.waitForFunction(
        () =>
          window.__audit.assistantLibrary.useAssistantLibrary.getState().data.activity.length === 2
      )
      const after = await page.evaluate(
        () => window.__audit.assistantLibrary.useAssistantLibrary.getState().data
      )
      assert.equal(after.memories.length, 1)
      assert.equal(after.memories[0].id, prior.id)
      assert.equal(after.memories[0].text, '验收报告用 Markdown')
      assert.equal(after.activity[0].round, 3)
      assert.equal(await page.evaluate(() => window.__autoMemoryRequestCount()), 4)
      await page.getByRole('button', { name: /最近记住了什么/ }).click()
      await page.getByRole('button', { name: /验收报告用 Markdown/ }).click()
      await page.getByRole('button', { name: '查看来源', exact: true }).click()
      await page.getByText('以后改用 Markdown', { exact: true }).waitFor()
      await page.getByRole('button', { name: '撤销这次记忆', exact: true }).click()
      await page.waitForFunction(
        () =>
          window.__audit.assistantLibrary.useAssistantLibrary.getState().data.memories[0]?.text ===
          '验收报告用 Word'
      )
      assert.equal((await page.getByText(/已撤销/).count()) > 0, true)
    }
  )

  await run(
    'assistant settings creates local memory and selects a saved Agent from the welcome page',
    async (page) => {
      await page.evaluate(() => window.__audit.settingsDialog.openSettings())
      await page.getByRole('button', { name: /记忆与 Agent/, exact: true }).click()
      const enabled = page.getByRole('switch', { name: '自动记忆' })
      await enabled.waitFor()
      assert.equal(await enabled.getAttribute('aria-checked'), 'false')
      await enabled.click()
      await page.waitForFunction(
        () => window.__audit.assistantLibrary.useAssistantLibrary.getState().data.enabled
      )
      await page.getByRole('button', { name: /管理记忆/ }).click()
      await page.getByRole('button', { name: '添加记忆', exact: true }).click()
      const editor = page.getByRole('dialog', { name: '添加记忆', exact: true })
      await editor
        .getByRole('textbox', { name: /记忆内容/ })
        .fill('整理公开资料时先给结论，再列出处。')
      await editor.getByRole('button', { name: '保存', exact: true }).click()
      await page.getByRole('button', { name: /整理公开资料时先给结论/ }).waitFor()
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('agents'))
      await page.getByRole('button', { name: /资料查证/ }).click()
      assert.equal(
        await page.getByRole('textbox', { name: '名称', exact: true }).inputValue(),
        '资料查证'
      )
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await page
        .locator('[data-settings-page="agents"] [data-settings-target="agentEdit"]')
        .getByText('资料查证', { exact: true })
        .waitFor()
      if (process.env.FREESEEK_ASSISTANT_PREVIEWS) {
        await page.screenshot({
          path: 'tmp/regression/assistant-agents-' + page.viewportSize().width + '.png',
        })
      }
      await page.evaluate(() => window.__audit.settingsDialog.closeSettings())
      await page.getByRole('button', { name: /选择助手/ }).click()
      await page.getByRole('option', { name: /资料查证/ }).click()
      assert.equal(
        await page.evaluate(() => window.__audit.store.useChatStore.getState().draftAgent.name),
        '资料查证'
      )
    }
  )

  await run(
    'assistant saves a selected message as local memory with its conversation reference',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        await a.assistantLibrary.setMemoryEnabled(true)
        await a.seed([
          a.fixtures.session({
            id: 'memory-source',
            messages: [a.fixtures.user('source-message', '验收偏好：先给结论，再说明核对依据。')],
          }),
        ])
      })
      await page.getByRole('button', { name: '保存为记忆', exact: true }).click()
      const editor = page.getByRole('dialog', { name: '添加记忆', exact: true })
      assert.equal(
        await editor.getByRole('textbox', { name: '记忆内容' }).inputValue(),
        '验收偏好：先给结论，再说明核对依据。'
      )
      await editor.getByRole('button', { name: '保存', exact: true }).click()
      await editor.waitFor({ state: 'hidden' })
      const note = await page.evaluate(
        async () => (await window.__audit.assistantLibrary.readAssistantLibrary()).memories[0]
      )
      assert.deepEqual(note.source, { sessionId: 'memory-source', messageId: 'source-message' })
    }
  )

  await run(
    'assistant memory confirms the destination and keeps Agent and conversation scopes isolated',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        a.settings.setApiKey('fixture-key')
        a.settings.setSearch(true)
        const spec = {
          prompt: 'Review the request from the current user.',
          model: null,
          search: false,
          attachments: true,
          memory: 'private',
        }
        const agent = await a.assistantLibrary.saveAgent({ ...spec, name: '查证甲' })
        const other = await a.assistantLibrary.saveAgent({ ...spec, name: '查证乙' })
        await a.assistantLibrary.saveMemory({
          text: '独立范围：公开资料统一用表格。',
          pinned: true,
        })
        await a.assistantLibrary.saveMemory({
          text: '华南工程验收分三项核对。',
          agentId: agent.id,
          pinned: false,
        })
        await a.assistantLibrary.saveMemory({
          text: '华南工程的另一份专属内容。',
          agentId: other.id,
          pinned: true,
        })
        await a.assistantLibrary.setMemoryEnabled(true)
        const fetcher = window.fetch
        const calls = []
        window.fetch = async (input, init) => {
          if (String(input).endsWith('/anthropic/v1/messages')) {
            calls.push(JSON.parse(init.body))
            return a.response('已整理。')
          }
          return fetcher(input, init)
        }
        window.__assistantFixture = { calls, agent }
        a.store.setSessionAgent(null, agent)
        a.drafts.setDraftText(null, '请核对华南工程验收。')
        a.store.sendMessage(null)
      })
      const prompt = page.getByRole('dialog', { name: '允许使用这些记忆？' })
      await prompt.getByText('华南工程验收分三项核对。', { exact: true }).waitFor()
      assert.equal(await prompt.getByText(/公开资料统一/).count(), 0)
      assert.equal(await prompt.getByText(/另一份专属/).count(), 0)
      assert.equal(await page.evaluate(() => window.__assistantFixture.calls.length), 0)
      if (process.env.FREESEEK_ASSISTANT_PREVIEWS) {
        await page.screenshot({
          path: 'tmp/regression/assistant-consent-' + page.viewportSize().width + '.png',
        })
      }
      await prompt.getByRole('button', { name: '仅本对话', exact: true }).click()
      const first = await page.evaluate(async () => {
        const a = window.__audit
        await a.waitIdle()
        const { calls } = window.__assistantFixture
        const state = a.store.useChatStore.getState()
        const session = state.sessionCache[state.activeId]
        return { request: calls[0], memory: session.messages.at(-1).memoryUse }
      })
      assert.match(first.request.system, /华南工程验收分三项/)
      assert.doesNotMatch(first.request.system, /另一份专属|公开资料统一/)
      assert.equal(first.request.tools, undefined)
      assert.equal(first.memory.references.length, 1)
      assert.ok(first.memory.tokens <= 800)
      await page.evaluate(() => {
        const a = window.__audit
        a.store.newChat()
        a.store.setSessionAgent(null, window.__assistantFixture.agent)
        a.drafts.setDraftText(null, '继续核对华南工程。')
        a.store.sendMessage(null)
      })
      await prompt.waitFor()
      await prompt.getByRole('button', { name: '本次跳过', exact: true }).click()
      await page.evaluate(() => window.__audit.waitIdle())
      assert.doesNotMatch(
        await page.evaluate(() => window.__assistantFixture.calls.at(-1).system),
        /验收分三项/
      )
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('assistantSettings'))
      await page.getByRole('button', { name: '记忆详情', exact: true }).click()
      await page.getByText('自动整理用量', { exact: true }).waitFor()
      assert.equal(await page.getByRole('switch').count(), 0)
      assert.equal(await page.getByText('已授权的模型连接', { exact: true }).count(), 0)
      assert.ok(
        await page.evaluate(() => {
          const a = window.__audit
          const { sessionId } = a.assistantLibrary.useAssistantLibrary.getState().data.grants[0]
          return a.store.useChatStore.getState().sessions.some(({ id }) => id === sessionId)
        })
      )
    }
  )

  await run(
    'assistant memory suggestions stay local until saved and replacing a note keeps its pin',
    async (page) => {
      await page.setViewportSize({ width: 320, height: 680 })
      await page.evaluate(async () => {
        const a = window.__audit
        window.__memoryPrior = await a.assistantLibrary.saveMemory({
          text: '报告模板固定采用蓝色分栏。',
          pinned: true,
        })
        await a.assistantLibrary.setMemoryEnabled(true)
        await a.seed([
          a.fixtures.session({
            id: 'memory-suggestion-source',
            title: '报告排版讨论',
            messages: [
              a.fixtures.user(
                'memory-suggestion-message',
                '我们今天先完成样例。请记住：报告模板固定采用蓝色分栏，标题居中。'
              ),
            ],
          }),
        ])
      })
      await page.getByRole('button', { name: '保存为记忆', exact: true }).click()
      const dialog = page.getByRole('dialog')
      const suggestion = dialog.getByRole('button', {
        name: '报告模板固定采用蓝色分栏，标题居中',
        exact: true,
      })
      await suggestion.click()
      assert.equal(
        await dialog.getByRole('textbox', { name: '记忆内容' }).inputValue(),
        '报告模板固定采用蓝色分栏，标题居中'
      )
      assert.equal(await suggestion.getAttribute('aria-pressed'), 'true')
      assert.deepEqual(
        await page.evaluate(async () =>
          (await window.__audit.assistantLibrary.readAssistantLibrary()).memories.map(
            ({ text }) => text
          )
        ),
        ['报告模板固定采用蓝色分栏。']
      )
      if (process.env.FREESEEK_ASSISTANT_PREVIEWS) {
        await page.screenshot({ path: 'tmp/regression/assistant-memory-suggestion-320.png' })
      }
      await dialog.getByRole('button', { name: '用当前内容更新这条', exact: true }).click()
      await dialog.getByText('将更新这条记忆', { exact: true }).waitFor()
      assert.equal(
        await dialog.getByRole('switch', { name: '在每轮优先引用' }).getAttribute('aria-checked'),
        'true'
      )
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      const saved = await page.evaluate(async () => {
        const snapshot = await window.__audit.assistantLibrary.readAssistantLibrary()
        const prior = window.__memoryPrior
        return { memories: snapshot.memories, prior }
      })
      assert.equal(saved.memories.length, 1)
      assert.equal(saved.memories[0].id, saved.prior.id)
      assert.notEqual(saved.memories[0].revision, saved.prior.revision)
      assert.equal(saved.memories[0].pinned, true)
      assert.deepEqual(saved.memories[0].source, {
        sessionId: 'memory-suggestion-source',
        messageId: 'memory-suggestion-message',
      })
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('memories'))
      const pinned = page.getByText('置顶记忆', { exact: true })
      await pinned.waitFor()
      await page.getByRole('button', { name: /报告模板固定采用.*报告排版讨论/ }).waitFor()
      if (process.env.FREESEEK_ASSISTANT_PREVIEWS) {
        await page.getByText('已更新记忆', { exact: true }).waitFor({ state: 'hidden' })
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.evaluate(async () => {
          const lib = window.__audit.assistantLibrary
          await lib.saveMemory({ text: '设备验收清单应包含原始数据和核对依据。', pinned: false })
          await lib.saveMemory({ text: '预算讨论统一使用月度汇总表。', pinned: false })
        })
        for (const theme of ['light', 'dark']) {
          await page.evaluate((theme) => window.__audit.settings.setThemePreference(theme), theme)
          await page.waitForFunction(
            (theme) => document.body.classList.contains('dark') === (theme === 'dark'),
            theme
          )
          for (const [width, height] of [
            [320, 680],
            [390, 844],
            [1366, 900],
          ]) {
            await page.setViewportSize({ width, height })
            await page.screenshot({
              path: 'tmp/regression/assistant-memory-list-' + theme + '-' + width + '.png',
            })
          }
        }
      }
      await page.getByRole('button', { name: '记忆与 Agent 备份', exact: true }).click()
      await page.getByRole('button', { name: '导出配置', exact: true }).waitFor()
    }
  )

  await run(
    'assistant memory ranks durable context and reads the latest text only for a clear follow-up',
    async (page) => {
      const result = await page.evaluate(async () => {
        const { assistantLibrary: library, assistantMemory: memory } = window.__audit
        const shared = await library.saveMemory({
          text: '设备验收规范引用原始数据。',
          pinned: false,
        })
        const pinned = await library.saveMemory({
          text: '先给结论，再写依据。',
          pinned: true,
        })
        const privateNote = await library.saveMemory({
          text: '设备验收规范要求保留序列号。',
          agentId: 'test-agent',
          pinned: false,
        })
        const all = (await library.readAssistantLibrary()).memories
        const recall = (query, history = [], scope, maxTokens = 800) =>
          memory.selectMemories(all, query, scope, maxTokens, history).map(({ id }) => id)
        return {
          pinned: pinned.id,
          shared: shared.id,
          privateNote: privateNote.id,
          direct: recall('请整理设备验收规范。'),
          oneOverlap: recall('验收视频怎么搭配音乐？'),
          followUp: recall('接着写。', ['请整理设备验收规范。']),
          newTopic: recall('今天有什么新闻？', ['请整理设备验收规范。']),
          lateTopic: recall('无关文字。'.repeat(900) + '最后请整理设备验收规范。'),
          isolated: recall('请整理设备验收规范。', [], {
            agentId: 'test-agent',
            memory: 'private',
          }),
          overflow: recall('请整理设备验收规范。', [], undefined, 8),
        }
      })
      assert.deepEqual(result.direct, [result.pinned, result.shared])
      assert.deepEqual(result.oneOverlap, [result.pinned])
      assert.deepEqual(result.followUp, [result.pinned, result.shared])
      assert.deepEqual(result.newTopic, [result.pinned])
      assert.deepEqual(result.lateTopic, [result.pinned, result.shared])
      assert.deepEqual(result.isolated, [result.privateNote])
      assert.deepEqual(result.overflow, [])
    }
  )

  await run(
    'assistant memory history restore keeps reference snapshots and removes stale chat grants',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const library = a.assistantLibrary
        const note = await library.saveMemory({
          text: '合成记忆正文',
          source: { sessionId: 'restore-memory', messageId: 'restore-question' },
          pinned: true,
        })
        const scope = { id: 'restore-agent', name: '合成 Agent' }
        const agent = { ...scope, search: false, attachments: true, memory: 'private' }
        const memoryUse = { references: [{ id: note.id, revision: note.revision }], tokens: 110 }
        const session = a.fixtures.session({
          id: 'restore-memory',
          mode: 'agent',
          agent: scope,
          memoryPaused: true,
          messages: [
            a.fixtures.user('restore-question', '合成问句'),
            a.fixtures.assistant('restore-reply', '合成回答', {
              agent,
              memoryUse,
              memoryReadFailed: true,
            }),
          ],
        })
        await a.seed([session])
        await library.setMemoryEnabled(true)
        await library.allowMemory({
          connection: 'fixture-a',
          name: '仅此会话',
          sessionId: session.id,
        })
        await library.allowMemory({ connection: 'fixture-b', name: '已授权连接' })
        const { name, blob } = await a.backup.exportHistory()
        await a.backup.importHistory(new File([blob], name, { type: 'application/zip' }))
        const restored = await a.db.loadSession(session.id)
        const memory = await library.readAssistantLibrary()
        return {
          sessionPaused: restored.memoryPaused,
          scope: restored.agent,
          agent: restored.messages[1].agent,
          use: restored.messages[1].memoryUse,
          failed: restored.messages[1].memoryReadFailed,
          expected: { scope, agent, memoryUse, source: note.source },
          source: memory.memories[0].source,
          grants: memory.grants.map(({ name }) => name),
        }
      })
      assert.equal(result.sessionPaused, true)
      assert.equal(result.failed, true)
      assert.deepEqual(result.scope, result.expected.scope)
      assert.deepEqual(result.agent, result.expected.agent)
      assert.deepEqual(result.use, result.expected.memoryUse)
      assert.deepEqual(result.source, result.expected.source)
      assert.deepEqual(result.grants, ['已授权连接'])
    }
  )

  await run(
    'assistant memory removes chat links and permissions without discarding retained notes or duplicating imports',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const library = a.assistantLibrary
        const keepSession = a.fixtures.session({ id: 'retain-memory' })
        const removeSession = a.fixtures.session({ id: 'discard-memory' })
        await a.seed([keepSession, removeSession])
        await library.setMemoryEnabled(true)
        await library.allowMemory({
          connection: 'fixture',
          name: '样例连接',
          sessionId: keepSession.id,
        })
        await library.allowMemory({
          connection: 'fixture',
          name: '样例连接',
          sessionId: removeSession.id,
        })
        const keep = await library.saveMemory({
          text: '技术文件使用 UTF-8。',
          pinned: true,
          source: { sessionId: keepSession.id, messageId: 'retain-source' },
        })
        await library.saveMemory({
          text: '临时记忆',
          pinned: false,
          source: { sessionId: removeSession.id, messageId: 'discard-source' },
        })
        const first = await a.store.removeSession(keepSession.id)
        const intermediate = await library.readAssistantLibrary()
        const second = await a.store.removeSession(removeSession.id, { deleteLinkedMemory: true })
        const revised = await library.readAssistantLibrary()
        const imported = {
          format: 'freeseek-assistants',
          version: 1,
          agents: [],
          memories: [
            { ...keep, id: 'same-content', text: ' 技术文件使用  ＵＴＦ-８。 ' },
            {
              ...keep,
              id: 'new-memory',
              revision: 'new-revision',
              text: '新条目',
              source: undefined,
            },
          ],
        }
        const backup = await library.readAssistantBackup(
          new File([JSON.stringify(imported)], 'synthetic.json')
        )
        await library.importAssistantBackup(backup, false)
        const final = await library.readAssistantLibrary()
        return {
          first,
          second,
          keepId: keep.id,
          grantsAfterFirst: intermediate.grants.map(({ sessionId }) => sessionId),
          retained: revised.memories,
          grants: final.grants,
          notes: final.memories.map(({ id, revision }) => ({ id, revision })),
        }
      })
      assert.equal(result.first, true)
      assert.equal(result.second, true)
      assert.deepEqual(result.grantsAfterFirst, ['discard-memory'])
      assert.equal(result.retained.length, 1)
      assert.equal(result.retained[0].source, undefined)
      assert.equal(result.retained[0].id, result.keepId)
      assert.equal(result.retained[0].pinned, true)
      assert.deepEqual(result.grants, [])
      assert.deepEqual(
        result.notes.map(({ id }) => id),
        [result.keepId, 'new-memory']
      )
      assert.equal(result.notes[1].revision, 'new-revision')
    }
  )

  await run(
    'assistant model stays pinned and provider tools and historical attachments obey the Agent policy',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        a.settings.setApiKey('fixture-key')
        const provider = a.providers.saveProvider({
          ...a.providers.emptyProfile(),
          name: '模拟连接',
          protocol: 'openai',
          url: 'https://assistant.example.test/v1',
          apiKey: 'provider-fixture',
          model: 'fixture-model',
          extraBody: { tools: [{ type: 'web_search' }], tool_choice: 'required' },
        })
        const agent = await a.assistantLibrary.saveAgent({
          name: '仅文本 Agent',
          prompt: 'Run the requested task.',
          search: false,
          attachments: false,
          model: { providerId: provider.id, model: provider.model },
          memory: 'off',
        })
        const session = a.fixtures.session({
          agent,
          messages: [
            a.fixtures.user('old-question', 'Previous question', {
              files: [
                {
                  id: 'old-file',
                  name: 'historical-private-file.txt',
                  serverId: 'file-api-old',
                  size: 19,
                  mimeType: 'text/plain',
                  isImage: false,
                },
              ],
            }),
            a.fixtures.assistant('old-reply', 'Previous answer'),
          ],
        })
        await a.seed(
          [session],
          [{ id: 'old-file', blob: new Blob(['historical sentinel'], { type: 'text/plain' }) }]
        )
        const requests = []
        window.__pinnedAgentRequests = requests
        const fetcher = window.fetch
        window.fetch = async (input, init) => {
          if (String(input).includes('assistant.example.test')) {
            requests.push(JSON.parse(init.body))
            return new Response(
              'data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { headers: { 'content-type': 'text/event-stream' } }
            )
          }
          return fetcher(input, init)
        }
        a.drafts.addDraftFiles(session.id, [new File(['CURRENT'], 'current.txt')], '', {
          selection: agent.model,
          deferUpload: true,
        })
        a.drafts.setDraftText(session.id, 'Check this.')
        const blocked = a.store.sendMessage(session.id)
        for (const attachment of a.drafts.getDraft(session.id).attachments) {
          a.drafts.removeDraftAttachment(session.id, attachment.id)
        }
        const sent = a.store.sendMessage(session.id)
        await a.waitIdle()
        await a.assistantLibrary.saveAgent({ ...agent, attachments: true }, agent)
        a.drafts.addDraftFiles(
          session.id,
          [new File(['CURRENT FILE SENTINEL'], 'current.txt')],
          '',
          {
            selection: agent.model,
            deferUpload: true,
          }
        )
        a.drafts.setDraftText(session.id, 'Check the current file.')
        const sentFile = a.store.sendMessage(session.id)
        await a.waitIdle()
        const state = a.store.useChatStore.getState()
        return {
          blocked,
          sent,
          sentFile,
          requests,
          active: a.providers.useProviders.getState().selection,
          preserved: state.sessionCache[session.id].messages[0].files[0].name,
          reply: state.sessionCache[session.id].messages.at(-1).status,
        }
      })
      assert.equal(result.blocked, false)
      assert.equal(result.sent, true)
      assert.equal(result.sentFile, true)
      assert.equal(result.active.providerId, 'deepseek')
      assert.equal(result.reply, 'done')
      assert.equal(result.requests.length, 2)
      assert.equal(result.requests[0].model, 'fixture-model')
      assert.equal(result.requests[0].tools, undefined)
      assert.equal(result.requests[0].tool_choice, undefined)
      assert.doesNotMatch(
        JSON.stringify(result.requests),
        /historical-private|historical sentinel|file-api-old/
      )
      assert.match(JSON.stringify(result.requests[1]), /CURRENT FILE SENTINEL/)
      assert.equal(result.preserved, 'historical-private-file.txt')
      await page.getByRole('button', { name: '编辑消息', exact: true }).last().click()
      await page
        .getByRole('textbox', { name: '编辑消息', exact: true })
        .fill('Edited using the pinned model.')
      await page
        .getByRole('button', { name: '发送', exact: true })
        .filter({ hasText: '发送' })
        .click()
      await page.waitForFunction(() => window.__pinnedAgentRequests.length === 3)
      assert.equal(
        await page.evaluate(() => window.__pinnedAgentRequests[2].model),
        'fixture-model'
      )
    }
  )

  await run(
    'assistant memory yields to a rejected context budget and keeps history retry metadata clean',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        a.settings.setApiKey('fixture-key')
        await a.assistantLibrary.saveMemory({ text: '对账日期以样例约定为准。', pinned: true })
        await a.assistantLibrary.setMemoryEnabled(true)
        await a.assistantLibrary.allowMemory({
          connection: 'deepseek:' + a.client.API_ORIGIN,
          name: 'DeepSeek',
        })
        const requests = []
        const fetcher = window.fetch
        window.fetch = async (input, init) => {
          if (String(input).endsWith('/anthropic/v1/messages')) {
            requests.push(JSON.parse(init.body))
            if (requests.length === 1) {
              return new Response(
                JSON.stringify({ error: { message: 'Maximum context length exceeded' } }),
                { status: 400 }
              )
            }
            return a.response('没有附加记忆也可以继续。')
          }
          return fetcher(input, init)
        }
        a.drafts.setDraftText(null, '请对账。')
        a.store.sendMessage(null)
        await a.waitIdle()
        const state = a.store.useChatStore.getState()
        const session = state.sessionCache[state.activeId]
        a.store.newChat()
        a.store.setSessionMemoryPaused(null, true)
        a.drafts.setDraftText(null, '私密的首次对话。')
        a.store.sendMessage(null)
        await a.waitIdle()
        const updated = a.store.useChatStore.getState()
        return {
          requests,
          status: session.messages.at(-1).status,
          memory: session.messages.at(-1).memoryUse,
          paused: updated.sessionCache[updated.activeId].memoryPaused,
        }
      })
      assert.equal(result.requests.length, 3)
      assert.match(result.requests[0].system, /对账日期以样例/)
      assert.doesNotMatch(result.requests[1].system, /对账日期以样例/)
      assert.doesNotMatch(result.requests[2].system, /对账日期以样例/)
      assert.equal(result.paused, true)
      assert.equal(result.status, 'done')
      assert.equal(result.memory, undefined)
    }
  )

  await run(
    'assistant memory asks again after endpoint changes and dismisses a stopped request',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        const provider = a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: '测试连接',
            url: 'https://first.example.test/v1',
            protocol: 'openai',
            model: 'test-model',
            apiKey: 'provider-fixture',
          },
          true
        )
        await a.assistantLibrary.saveMemory({ text: '项目纪要使用甲类格式。', pinned: true })
        await a.assistantLibrary.setMemoryEnabled(true)
        await a.assistantLibrary.allowMemory({
          connection: provider.id + ':' + provider.revision,
          name: provider.name,
        })
        const calls = []
        const fetcher = window.fetch
        window.fetch = async (input, init) => {
          if (String(input).includes('.example.test/v1/chat/completions')) {
            calls.push(JSON.parse(init.body))
            return new Response(
              'data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { headers: { 'content-type': 'text/event-stream' } }
            )
          }
          return fetcher(input, init)
        }
        window.__assistantRequests = calls
        a.drafts.setDraftText(null, '请准备项目纪要。')
        a.store.sendMessage(null)
        await a.waitIdle()
        a.providers.saveProvider({ ...provider, url: 'https://second.example.test/v1' }, true)
        a.store.newChat()
        a.drafts.setDraftText(null, '请准备另一份项目纪要。')
        a.store.sendMessage(null)
      })
      const dialog = page.getByRole('dialog', { name: '允许使用这些记忆？' })
      await dialog.getByText(/second\.example\.test/).waitFor()
      const count = await page.evaluate(() => {
        const a = window.__audit
        a.store.stopReply(a.store.useChatStore.getState().activeId)
        return window.__assistantRequests.length
      })
      await dialog.waitFor({ state: 'hidden' })
      await page.evaluate(() => window.__audit.waitIdle())
      assert.equal(count, 1)
      assert.equal(await page.evaluate(() => window.__assistantRequests.length), 1)
    }
  )

  await run(
    'assistant memory backup excludes grants and a revoked note comes out of Chinese retrieval',
    async (page) => {
      const result = await page.evaluate(async () => {
        const { assistantLibrary: library, assistantMemory: memory, client } = window.__audit
        const note = await library.saveMemory({
          text: '项目清单的清洁验收使用甲号规范。',
          pinned: false,
        })
        await library.setMemoryEnabled(true)
        await library.allowMemory({ connection: 'deepseek:' + client.API_ORIGIN, name: 'DeepSeek' })
        const before = await library.readAssistantLibrary()
        const backup = await library.exportAssistantLibrary()
        const data = JSON.parse(await backup.text())
        const roundtrip = await library.readAssistantBackup(new File([backup], 'memories.json'))
        const recall = memory.selectMemories(before.memories, '如何验收项目清单？', undefined, 800)
        await library.removeMemory(note)
        await library.revokeMemory('deepseek:' + client.API_ORIGIN)
        const after = await library.readAssistantLibrary()
        await library.importAssistantBackup(roundtrip, false)
        const restored = await library.readAssistantLibrary()
        return {
          before: recall.length,
          after: memory.selectMemories(after.memories, '如何验收项目清单？', undefined, 800).length,
          grantFields: Object.keys(data),
          restored: restored.memories.length,
          grants: restored.grants.length,
          unrelated: memory.selectMemories(restored.memories, '今天吃什么？', undefined, 800)
            .length,
          safeQuery: !memory.searchUsesPrivateMemory('公开验收清单', restored.memories),
          privateQuery: memory.searchUsesPrivateMemory(
            '项目清单的清洁验收使用甲号规范',
            restored.memories
          ),
        }
      })
      assert.deepEqual(result, {
        before: 1,
        after: 0,
        grantFields: ['format', 'version', 'memories', 'agents'],
        restored: 1,
        grants: 0,
        unrelated: 0,
        safeQuery: true,
        privateQuery: true,
      })
    }
  )
}
