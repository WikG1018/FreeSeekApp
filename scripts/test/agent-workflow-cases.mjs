import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'

const capture = async (page, view) => {
  if (process.env.FREESEEK_TASK_PREVIEWS) {
    const { width } = page.viewportSize()
    await mkdir('tmp/agent-polish', { recursive: true })
    await page.locator('#fs-startup').waitFor({ state: 'hidden' })
    await page.screenshot({ path: `tmp/agent-polish/${view}-${width}.png`, animations: 'disabled' })
  }
}

const configure = async (page, id, agentRunMode) => {
  await page.evaluate(
    async ({ id, agentRunMode }) => {
      const a = window.__audit
      a.settings.setApiKey('agent-fixture-only')
      a.settings.setSearch(false)
      await a.seed([a.fixtures.session({ id, mode: 'agent', agentRunMode, title: 'Agent 验收' })])
      const usage = {
        input_tokens: 7,
        output_tokens: 3,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }
      window.__workflowTools = (calls, suffix) =>
        new Response(
          [
            { type: 'message_start', message: { usage } },
            ...calls.flatMap(([name, input], index) => [
              {
                type: 'content_block_start',
                index,
                content_block: {
                  type: 'tool_use',
                  id: 'workflow-' + suffix + '-' + index,
                  name,
                  input,
                },
              },
              { type: 'content_block_stop', index },
            ]),
            { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage },
            { type: 'message_stop' },
          ]
            .map((event) => 'data: ' + JSON.stringify(event) + '\n\n')
            .join(''),
          {
            headers: { 'content-type': 'text/event-stream' },
          }
        )
    },
    { id, agentRunMode }
  )
}

export const runAgentWorkflowCases = async (run) => {
  await run(
    'Agent history backup restores the linked workspace and revisions without replacing local projects',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const project = await a.workspaces.createWorkspace('工程恢复验收', [
          { path: 'run.js', text: 'console.log(1);\n' },
        ])
        await a.workspaces.applyWorkspacePatch(
          project.id,
          project.revision,
          '*** Begin Patch\n*** Update File: run.js\n@@\n-console.log(1);\n+console.log(2);\n*** End Patch',
          new AbortController().signal
        )
        await a.seed([
          a.fixtures.session({
            id: 'workspace-roundtrip',
            mode: 'agent',
            workspaceId: project.id,
            messages: [
              a.fixtures.user('prompt', '运行工程里的脚本。'),
              a.fixtures.assistant('reply', '工程已修改。', {
                task: { plan: [], steps: [], artifacts: [], workspaceId: project.id },
              }),
            ],
          }),
        ])
        const backup = await a.backup.exportHistory()
        await a.backup.importHistory(
          new File([backup.blob], backup.name, { type: 'application/zip' }),
          undefined,
          async () => new Set(['workspace-roundtrip'])
        )
        const restored = await a.db.loadSession('workspace-roundtrip')
        const files = (await a.workspaces.readWorkspace(restored.workspaceId)).files
        const projectRevisions = await a.workspaces.workspaceRevisions(restored.workspaceId)
        const original = await a.workspaces.readWorkspace(project.id)
        return {
          id: restored.workspaceId,
          related: restored.messages[1].task.workspaceId,
          original: project.id,
          files,
          originalFiles: original.files,
          versions: projectRevisions.map(({ revision }) => revision),
        }
      })
      assert.notEqual(result.id, result.original)
      assert.equal(result.related, result.id)
      assert.deepEqual(result.files, [{ path: 'run.js', text: 'console.log(2);\n' }])
      assert.deepEqual(result.originalFiles, result.files)
      assert.deepEqual(result.versions, [1])
    }
  )
  await run(
    'sidebar and the current Agent transcript expose live phases and inline tools',
    async (page) => {
      await page.setViewportSize({ width: 320, height: 750 })
      await page.clock.install()
      await page.evaluate(async () => {
        const a = window.__audit
        const run = {
          id: 'flow',
          mode: 'task',
          status: 'running',
          revision: 0,
          criteria: [],
          met: [],
          budgetMinutes: 5,
          budgetRequests: 12,
          totalRequests: 0,
          segmentRequests: 0,
          startedAt: Date.now(),
          elapsedMs: 0,
        }
        const assistant = a.fixtures.assistant('work', '', {
          status: 'pending',
          blocks: [],
          task: { steps: [], plan: [], artifacts: [], run },
        })
        await a.seed([
          a.fixtures.session({
            id: 'live-agent',
            title: 'Agent 现场',
            mode: 'agent',
            messages: [a.fixtures.user('q', '测试工作过程'), assistant],
          }),
          a.fixtures.session({
            id: 'live-chat',
            title: '长标题也能看到这条普通聊天的回复状态',
            pinned: true,
          }),
        ])
        const get = a.store.useChatStore.getState
        const update = a.store.useChatStore.setState
        update({
          sessions: get().sessions.map((item) =>
            item.id === 'live-agent' ? { ...item, mode: 'agent' } : { ...item, pinned: true }
          ),
          streaming: { 'live-agent': new AbortController(), 'live-chat': new AbortController() },
        })
        window.applyLiveAgentFixture = (done) => {
          const session = get().sessionCache['live-agent']
          const message = {
            ...assistant,
            status: 'streaming',
            blocks: [
              { type: 'text', text: '先检查项目文件。' },
              ...(done ? [{ type: 'text', text: '这里是最新生成的说明。' }] : []),
            ],
            task: {
              ...assistant.task,
              steps: [
                {
                  id: 'tool-fixture',
                  kind: 'script',
                  file: 'assembly.mjs',
                  status: done ? 'done' : 'working',
                  blockIndex: 1,
                },
              ],
            },
          }
          update({
            sessionCache: {
              ...get().sessionCache,
              [session.id]: { ...session, messages: [session.messages[0], message] },
            },
          })
        }
      })
      await page.getByRole('button', { name: '打开边栏', exact: true }).click()
      await page
        .locator('[data-session-id="live-agent"]')
        .getByText('执行中', { exact: true })
        .waitFor()
      await page
        .locator('[data-session-id="live-chat"]')
        .getByText('回复中', { exact: true })
        .waitFor()
      await page.locator('[data-session-id="live-agent"] [data-sider-swipe-row]').click()
      await page.getByTestId('agent-progress-dock').click()
      await page.getByTestId('agent-live-step').getByText('正在连接模型', { exact: true }).waitFor()
      await page
        .getByTestId('agent-run-budget')
        .getByText(/已运行 0 分钟.*0\/12 次请求/)
        .waitFor()
      await page.evaluate(() => window.applyLiveAgentFixture(false))
      await page.getByTestId('agent-live-step').getByText('assembly.mjs', { exact: true }).waitFor()
      assert.equal(
        await page
          .getByTestId('agent-run-summary')
          .getByText('assembly.mjs', { exact: true })
          .count(),
        1
      )
      await page.getByTestId('agent-inline-tools').locator('[data-status="working"]').waitFor()
      await capture(page, 'agent-live-tool')
      await page.keyboard.press('Escape')
      await page.getByTestId('agent-live-step').waitFor({ state: 'hidden' })
      await page.clock.fastForward(16_000)
      const activity = page.getByTestId('reply-activity')
      await activity.getByText(/未收到新进度/).waitFor()
      assert.ok(
        await activity.evaluate((node) =>
          Boolean(
            node.compareDocumentPosition(
              document.querySelector('[data-agent-step="tool-fixture"]')
            ) & Node.DOCUMENT_POSITION_PRECEDING
          )
        )
      )
      await page.evaluate(() => window.applyLiveAgentFixture(true))
      await page.getByText('这里是最新生成的说明。', { exact: true }).waitFor()
      await activity.getByText('正在生成回答', { exact: true }).waitFor()
      assert.equal(await activity.getByText(/未收到新进度/).count(), 0)
      await page.getByTestId('agent-inline-tools').locator('[data-status="done"]').waitFor()
    }
  )
  await run(
    'Agent separates tool input from thinking and keeps progressing beyond the old deadline',
    async (page) => {
      await page.clock.install()
      await configure(page, 'long-tool-input', 'task')
      await page.evaluate(() => {
        const a = window.__audit
        a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: '流式工具验收',
            url: 'https://tool-input-fixture.invalid/v1',
            apiKey: 'tool-input-fixture',
            model: 'fixture-reasoner',
          },
          true
        )
        const encode = new TextEncoder()
        const original = window.fetch
        let controller
        let requests = 0
        window.pushTaskDelta = (delta) =>
          controller.enqueue(
            encode.encode('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n')
          )
        window.finishTaskRound = () => {
          window.pushTaskDelta({
            tool_calls: [
              {
                index: 0,
                function: { arguments: '"calculations":[{"operation":"add","values":[1,1]}]}' },
              },
            ],
          })
          controller.enqueue(
            encode.encode('data: {"choices":[{"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n')
          )
          controller.close()
        }
        window.fetch = async (url, init) => {
          if (new URL(url).hostname !== 'tool-input-fixture.invalid') return original(url, init)
          ++requests
          return new Response(
            new ReadableStream({
              start(stream) {
                controller = stream
                if (requests === 1) {
                  window.pushTaskDelta({ reasoning_content: '先核对现有工程。' })
                } else {
                  stream.enqueue(
                    encode.encode(
                      'data: {"choices":[{"delta":{"content":"工具执行后继续完成。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
                    )
                  )
                  stream.close()
                }
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } }
          )
        }
        a.drafts.setDraftText('long-tool-input', '请核对工程并保存结果。')
        a.store.sendMessage('long-tool-input')
      })
      await page.getByTestId('agent-thinking').getByText('正在思考', { exact: true }).waitFor()
      await page.clock.fastForward(2_000)
      await page.evaluate(() => window.pushTaskDelta({ reasoning_content: '准备一段工具参数。' }))
      await page.waitForFunction(() =>
        window.__audit.store.useChatStore
          .getState()
          .sessionCache['long-tool-input'].messages.at(-1)
          .blocks.some(
            (block) => block.type === 'thinking' && block.thinking.includes('准备一段工具参数。')
          )
      )
      await page.clock.runFor(40)
      await page.clock.fastForward(50_000)
      const activity = page.getByTestId('reply-activity')
      await activity.getByText(/未收到新进度/).waitFor()
      await page.evaluate(() =>
        window.pushTaskDelta({
          tool_calls: [
            {
              index: 0,
              id: 'args',
              type: 'function',
              function: { name: 'calculate', arguments: '{' },
            },
          ],
        })
      )
      await activity.getByText('正在准备工具调用', { exact: true }).waitFor()
      assert.equal(await activity.getByText(/未收到新进度/).count(), 0)
      await page.getByTestId('agent-thinking').getByText('思考 · 2 秒', { exact: true }).waitFor()
      await page.getByTestId('agent-progress-dock').click()
      await page
        .getByTestId('agent-live-step')
        .getByText('正在准备工具调用', { exact: true })
        .waitFor()
      await page
        .getByTestId('agent-run-budget')
        .getByText(/1\/40 次请求/)
        .waitFor()
      await page.keyboard.press('Escape')
      for (let index = 0; index < 17; index++) {
        await page.clock.fastForward(48_000)
        await page.evaluate(() =>
          window.pushTaskDelta({
            tool_calls: [{ index: 0, function: { arguments: ' ' } }],
          })
        )
      }
      await page.clock.fastForward(60_000)
      assert.equal(await page.getByTestId('agent-run-recovery').count(), 0)
      await activity.getByText('正在准备工具调用', { exact: true }).waitFor()
      await page.evaluate(() => window.finishTaskRound())
      await page.getByText('工具执行后继续完成。', { exact: true }).waitFor()
      assert.equal(await page.getByTestId('agent-thinking').count(), 1)
    }
  )
  await run('Agent and automatic memory are off on a clean profile', async (page) => {
    const defaults = await page.evaluate(async () => {
      const a = window.__audit
      const memory = await a.assistantLibrary.readAssistantLibrary()
      a.settingsDialog.openSettings('assistantSettings')
      return {
        agent: a.settings.useSettings.getState().askChatMode,
        memory: memory.enabled,
        automatic: memory.automatic,
      }
    })
    assert.deepEqual(defaults, { agent: false, memory: false, automatic: false })
    assert.equal(
      await page
        .getByRole('switch', { name: '新建对话时选择模式', exact: true })
        .getAttribute('aria-checked'),
      'false'
    )
    assert.equal(
      await page
        .getByRole('switch', { name: '自动记忆', exact: true })
        .getAttribute('aria-checked'),
      'false'
    )
  })

  await run('English catalogs and mobile workbench stay usable at 320 px', async (page) => {
    const locale = await page.evaluate(async () => {
      const a = window.__audit
      const { en, zh } = a.messages
      a.settings.setLocale('en-US')
      const workspace = await a.workspaces.createWorkspace('Source project', [
        { path: 'size.js', text: 'export const width = 980;\n' },
      ])
      await a.seed([
        a.fixtures.session({ id: 'english-workbench', mode: 'agent', workspaceId: workspace.id }),
      ])
      const names = (text) =>
        [...text.matchAll(/\{(\w+)\}/g)]
          .map((match) => match[1])
          .sort()
          .join(',')
      return {
        total: Object.keys(zh).length,
        missing: Object.keys(zh).filter((key) => !en[key]),
        unexpected: Object.keys(en).filter((key) => !(key in zh)),
        placeholders: Object.keys(zh).filter((key) => en[key] && names(en[key]) !== names(zh[key])),
        untranslated: Object.keys(en).filter((key) => /\p{Script=Han}/u.test(en[key])),
      }
    })
    assert.ok(locale.total >= 1000)
    assert.deepEqual(locale.missing, [])
    assert.deepEqual(locale.unexpected, [])
    assert.deepEqual(locale.placeholders, [])
    assert.deepEqual(locale.untranslated, [])
    await page.setViewportSize({ width: 320, height: 720 })
    await page.getByRole('button', { name: 'Using Source project', exact: true }).click()
    await page.getByRole('button', { name: 'View project Source project', exact: true }).click()
    const project = page.getByRole('dialog', { name: 'Source project', exact: true })
    await project.getByText('1 file · Revision 0', { exact: true }).waitFor()
    await project.getByRole('button', { name: 'size.js', exact: true }).click()
    await project.getByRole('button', { name: 'Run test', exact: true }).waitFor()
    const download = page.waitForEvent('download')
    await project.getByRole('button', { name: 'Project backup', exact: true }).click()
    assert.equal((await download).suggestedFilename(), 'Source project-project-backup.json')
    await project.getByRole('button', { name: 'Changes', exact: true }).click()
    await project.getByText('Project changes and undo actions will appear here.').waitFor()
    assert.doesNotMatch(await project.innerText(), /\p{Script=Han}/u)
    await capture(page, 'workspace-english')
    await page.keyboard.press('Escape')
    await project.waitFor({ state: 'hidden' })
    await page.evaluate(() => window.__audit.settingsDialog.openSettings('agentExtensions'))
    await page.getByText('Task skills', { exact: true }).waitFor()
    await page.getByRole('textbox', { name: 'HTTPS service address' }).waitFor()
    await page.getByRole('button', { name: 'Connect and list tools', exact: true }).waitFor()
    const layout = await page.evaluate(() => ({
      inner: window.innerWidth,
      root: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }))
    assert.ok(layout.root <= layout.inner + 1 && layout.body <= layout.inner + 1)
    await capture(page, 'agent-extensions-english')
    await page.evaluate(() => window.__audit.settingsDialog.openSettings('personas'))
    await page.getByText('Default assistant', { exact: true }).waitFor()
    await page.getByText('Writing assistant', { exact: true }).waitFor()
    await page.getByText('Translation expert', { exact: true }).waitFor()
    await page.evaluate(() => window.__audit.settingsDialog.openSettings('providerCatalog'))
    await page.getByRole('searchbox', { name: 'Search providers' }).fill('SiliconFlow')
    await page.getByText('SiliconFlow', { exact: true }).waitFor()
    await page.getByRole('searchbox', { name: 'Search providers' }).fill('Xiaomi')
    await page.getByRole('button', { name: /Xiaomi MiMo/ }).click()
    await page.getByRole('radio', { name: /Token Plan/ }).waitFor()
    await page.evaluate(() => window.__audit.settingsDialog.openSettings('data'))
    await page.getByText('Data management', { exact: true }).first().waitFor()
    await page.evaluate(() => window.__audit.settingsDialog.openSettings('about'))
    await page.getByRole('button', { name: 'Save diagnostics to a file', exact: true }).waitFor()
    await page.locator('[data-settings-target="installed-release-notes"]').click()
    // 不锁定具体文案：版本更新内容会随版本变化，这里只校验英文目录下显示的是英文
    const notes = page.getByTestId('release-notes')
    await notes.waitFor()
    assert.ok((await notes.locator('li').count()) > 0)
    assert.doesNotMatch(await notes.innerText(), /\p{Script=Han}/u)
  })

  await run(
    'Agent workspaces persist across conversations and keep reversible edits',
    async (page) => {
      await page.setViewportSize({ width: 320, height: 720 })
      await configure(page, 'workbench-first', 'task')
      await page.getByTestId('workspace-trigger').click()
      await page.getByRole('button', { name: '新建工程', exact: true }).click()
      await page.getByRole('textbox', { name: '工程名称' }).fill('外机尺寸工程')
      await page.getByRole('button', { name: '建立并使用', exact: true }).click()
      await page.getByRole('dialog', { name: '外机尺寸工程', exact: true }).waitFor()
      await capture(page, 'workspace-start')
      await page.getByRole('button', { name: '返回对话', exact: true }).click()
      await page
        .getByRole('dialog', { name: '外机尺寸工程', exact: true })
        .waitFor({ state: 'hidden' })
      const saved = await page.evaluate(async () => {
        const a = window.__audit
        const fetchOriginal = window.fetch
        let round = 0
        window.fetch = async (url, init) => {
          if (!new URL(url).pathname.endsWith('/anthropic/v1/messages'))
            return fetchOriginal(url, init)
          if (++round !== 1) return a.response('尺寸文件已保存。')
          return window.__workflowTools(
            [
              [
                'apply_project_patch',
                {
                  patch:
                    '*** Begin Patch\n*** Add File: lib/size.mjs\n+export const width = 980;\n*** Add File: empty.txt\n*** End Patch',
                },
              ],
            ],
            'workspace-first'
          )
        }
        a.drafts.setDraftText('workbench-first', '建立外机尺寸文件。')
        a.store.sendMessage('workbench-first')
        await a.waitIdle()
        const conversation = await a.db.loadSession('workbench-first')
        await a.seed([
          a.fixtures.session({ id: 'workbench-next', mode: 'agent', title: '接手工程' }),
          conversation,
        ])
        return conversation.workspaceId
      })
      assert.ok(saved)
      await page.getByTestId('workspace-trigger').click()
      await page.getByRole('button', { name: '外机尺寸工程', exact: true }).click()
      await page.getByTestId('workspace-trigger').getByText('外机尺寸工程').waitFor()
      await page.getByTestId('workspace-trigger').click()
      await page.getByRole('button', { name: '查看工程 外机尺寸工程', exact: true }).click()
      await page.getByRole('button', { name: '改动', exact: true }).click()
      await page.getByRole('button', { name: /代码补丁/ }).click()
      await page.getByRole('button', { name: /lib\/size.mjs/ }).click()
      await page.getByText('+export const width = 980;', { exact: true }).waitFor()
      await capture(page, 'workspace-diff')
      const patchDownload = page.waitForEvent('download')
      await page.getByRole('button', { name: '导出补丁', exact: true }).click()
      const patchFile = await (await patchDownload).path()
      const stats = execFileSync('git', ['apply', '--numstat', patchFile], { encoding: 'utf8' })
      assert.match(stats, /0\t0\tempty\.txt/)
      assert.match(stats, /1\t0\tlib\/size\.mjs/)
      await page.getByRole('button', { name: '撤销这次改动', exact: true }).click()
      await page.getByRole('button', { name: '确定', exact: true }).click()
      await page.getByText('已恢复文件', { exact: true }).waitFor()
      const state = await page.evaluate(async (id) => {
        const a = window.__audit
        const current = await a.workspaces.readWorkspace(id)
        const backup = await a.workspaces.exportWorkspaceBackup(id)
        const restored = await a.workspaces.importWorkspaceBackup(
          backup,
          new AbortController().signal
        )
        const edits = await Promise.allSettled([
          a.workspaces.applyWorkspacePatch(
            id,
            2,
            '*** Begin Patch\n*** Add File: first.js\n+export const first = true;\n*** End Patch',
            new AbortController().signal
          ),
          a.workspaces.applyWorkspacePatch(
            id,
            2,
            '*** Begin Patch\n*** Add File: second.js\n+export const second = true;\n*** End Patch',
            new AbortController().signal
          ),
        ])
        const attached = await a.db.loadSession('workbench-next')
        return {
          current,
          restored,
          editStatus: edits.map(({ status }) => status),
          attached: attached.workspaceId,
          revisions: await a.workspaces.workspaceRevisions(restored.id),
          patch: await a.workspaces.getWorkspaceRevision(restored.id, 1),
        }
      }, saved)
      assert.equal(state.attached, saved)
      assert.deepEqual(state.current.files, [])
      assert.deepEqual(
        state.revisions.map(({ kind }) => kind),
        ['restore', 'patch']
      )
      assert.ok(state.revisions.every((revision) => !('changes' in revision)))
      assert.deepEqual(state.patch.changes, [
        { path: 'empty.txt', before: null, after: '' },
        { path: 'lib/size.mjs', before: null, after: 'export const width = 980;\n' },
      ])
      assert.notEqual(state.restored.id, saved)
      assert.deepEqual(state.editStatus.sort(), ['fulfilled', 'rejected'])
    }
  )

  await run(
    'Agent uses a selected skill, approves an MCP call and records child review',
    async (page) => {
      await configure(page, 'extension-workflow', 'task')
      await page.evaluate(() => {
        const a = window.__audit
        const original = window.fetch
        window.__extensionFixture = { methods: [], requests: [], reviews: 0, hasSkill: false }
        let round = 0
        window.fetch = async (url, init) => {
          const address = new URL(url)
          if (address.hostname === 'mcp.fixture.invalid') {
            const request = JSON.parse(init.body)
            const session = new Headers(init.headers).get('Mcp-Session-Id')
            window.__extensionFixture.methods.push({ name: request.method, session })
            if (request.method === 'notifications/initialized') {
              return new Response(null, { status: 202 })
            }
            const result =
              request.method === 'initialize'
                ? { protocolVersion: '2025-11-25', capabilities: { tools: {} } }
                : request.method === 'tools/list'
                  ? {
                      tools: [
                        {
                          name: 'record_note',
                          description: '记下本次的检查结论。',
                          annotations: { readOnlyHint: true },
                          inputSchema: { type: 'object' },
                        },
                      ],
                    }
                  : { content: [{ type: 'text', text: '检查记录已写入合成服务。' }] }
            const message = JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
            const sse = request.method === 'tools/call'
            return new Response(
              sse ? 'id: tool-result\ndata:\n\ndata: ' + message + '\n\n' : message,
              {
                headers: {
                  'Content-Type': sse ? 'text/event-stream' : 'application/json',
                  'Mcp-Session-Id': 'qa-session',
                },
              }
            )
          }
          if (!address.pathname.endsWith('/anthropic/v1/messages')) {
            return original(url, init)
          }
          const payload = JSON.parse(init.body)
          if (payload.system?.includes('independent research or review worker')) {
            window.__extensionFixture.reviews++
            return a.response('子代理核对了尺寸说明。')
          }
          window.__extensionFixture.hasSkill ||=
            JSON.stringify(payload).includes('优先核对尺寸字段')
          if (++round === 1) {
            return window.__workflowTools(
              [
                ['call_mcp_tool', { name: 'record_note', arguments: { verified: true } }],
                ['run_task_review', { role: 'verification', question: '核对准备交付的尺寸说明。' }],
              ],
              'extensions'
            )
          }
          return a.response('外部工具和复核已完成。')
        }
        a.settingsDialog.openSettings('agentExtensions')
      })
      await page.getByTestId('skill-file-import').setInputFiles({
        name: 'SKILL.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from('---\nname: 外机复核\n---\n优先核对尺寸字段。'),
      })
      await page.getByText('外机复核', { exact: true }).click()
      await page.locator('details').filter({ hasText: '外机复核' }).getByRole('switch').click()
      await page
        .getByRole('textbox', { name: 'HTTPS 服务地址' })
        .fill('https://mcp.fixture.invalid/tools')
      await page.getByRole('button', { name: '连接并读取工具', exact: true }).click()
      const toggle = page.getByRole('switch', { name: 'record_note', exact: true })
      await toggle.waitFor()
      assert.equal(await toggle.getAttribute('aria-checked'), 'false')
      await toggle.click()
      await page.evaluate(() => {
        const a = window.__audit
        a.settingsDialog.closeSettings()
        a.drafts.setDraftText('extension-workflow', '把检查结果记下来，再派人复核。')
        a.store.sendMessage('extension-workflow')
      })
      await page.getByText('Agent 请求调用 record_note', { exact: true }).waitFor()
      assert.equal(
        await page.evaluate(
          () => window.__extensionFixture.methods.filter(({ name }) => name === 'tools/call').length
        ),
        0
      )
      await capture(page, 'workspace-mcp-approval')
      await page.getByRole('button', { name: '允许这次调用', exact: true }).click()
      const result = await page.evaluate(async () => {
        const a = window.__audit
        await a.waitIdle()
        const { messages } = await a.db.loadSession('extension-workflow')
        return { ...window.__extensionFixture, steps: messages.at(-1).task.steps }
      })
      assert.equal(result.reviews, 1)
      assert.equal(result.hasSkill, true)
      assert.equal(result.methods.filter(({ name }) => name === 'tools/call').length, 1)
      assert.ok(
        result.methods.every(
          ({ name, session }) => name === 'initialize' || session === 'qa-session'
        )
      )
      assert.deepEqual(
        result.steps.map(({ kind, status }) => [kind, status]),
        [
          ['integration', 'done'],
          ['delegate', 'done'],
        ]
      )
    }
  )

  await run(
    'Agent edits and tests a local source project and previews a generated GLB',
    async (page) => {
      await page.setViewportSize({ width: 360, height: 800 })
      await configure(page, 'agent-maker', 'task')
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const id = 'agent-maker'
        const patch = [
          '*** Begin Patch',
          '*** Add File: lib/dimensions.mjs',
          '+export const width = 980;',
          '*** Add File: src/assembly.mjs',
          '+import { width } from "../lib/dimensions.mjs";',
          '+console.assert(width === 980, "尺寸有误");',
          '+console.log("本地测试通过，外机宽 " + width + " mm");',
          '+emitModel({units:"mm", parts:[',
          '+{name:"外壳",shape:"box",dimensions:[width,610,370],color:"#bcc6d7"},',
          '+{name:"风扇",shape:"cylinder",dimensions:[420,45,420],center:[210,20,198],rotation:[90,0,0],color:"#345dcc"}',
          '+]});',
          '*** End Patch',
        ].join('\n')
        const invalid = [
          '*** Begin Patch',
          '*** Add File: should-not-exist.js',
          '+1;',
          '*** Update File: lib/dimensions.mjs',
          '@@',
          '-missing context',
          '+broken',
          '*** End Patch',
        ].join('\n')
        const requests = []
        const fetchOriginal = window.fetch
        window.fetch = async (url, init) => {
          if (!new URL(url).pathname.endsWith('/anthropic/v1/messages'))
            return fetchOriginal(url, init)
          const round = requests.push(JSON.parse(init.body))
          if (round === 1) {
            return window.__workflowTools(
              [
                ['apply_project_patch', { patch }],
                ['apply_project_patch', { patch: invalid }],
                ['run_project_script', { path: 'src/assembly.mjs' }],
              ],
              round
            )
          }
          if (round === 2) {
            return window.__workflowTools(
              [
                [
                  'apply_project_patch',
                  {
                    patch:
                      '*** Begin Patch\n*** Add File: README.md\n+# 外机 3D 项目\n*** End Patch',
                  },
                ],
                ['export_project', { file_name: '外机源码' }],
                ['create_3d_model', { file_name: '外机模型', from_script: 'src/assembly.mjs' }],
              ],
              round
            )
          }
          return a.response('本地测试通过。源码和 3D 模型已生成。')
        }
        a.drafts.setDraftText(id, '生成一个外机示例，测试代码并交付 3D。')
        if (!a.store.sendMessage(id)) throw new Error('Agent did not start')
        await a.waitIdle()
        const saved = (await a.db.loadSession(id)).messages.at(-1)
        const model = saved.task.artifacts.find(({ name }) => name.endsWith('.glb'))
        const blob = model && (await a.store.loadBackupFile(model.id))
        const view = blob && new DataView(await blob.arrayBuffer())
        return {
          state: saved.task.run.status,
          test: saved.task.steps.find((step) => step.kind === 'script'),
          rejected: saved.task.steps.some((step) => step.detail === 'project-patch-rejected'),
          paths: saved.task.project.map(({ path }) => path),
          artifacts: saved.task.artifacts.map(({ name }) => name),
          magic: view?.getUint32(0, true),
          gltfVersion: view?.getUint32(4, true),
        }
      })
      assert.equal(result.state, 'completed', JSON.stringify(result))
      assert.equal(result.rejected, true)
      assert.deepEqual(result.paths.sort(), ['README.md', 'lib/dimensions.mjs', 'src/assembly.mjs'])
      assert.equal(result.test.status, 'done')
      assert.match(result.test.output, /本地测试通过，外机宽 980 mm/)
      assert.deepEqual(result.artifacts, ['外机源码.zip', '外机模型.glb'])
      assert.equal(result.magic, 0x46546c67)
      assert.equal(result.gltfVersion, 2)

      await page.getByTestId('task-output').filter({ hasText: '外机模型.glb' }).click()
      await page.locator('[data-preview-state="ready"]').waitFor()
      await page.getByRole('button', { name: '复位视角', exact: true }).click()
      await capture(page, 'creator-model')
      await page.getByRole('button', { name: '部件与尺寸', exact: true }).click()
      await page.getByLabel('X mm', { exact: true }).fill('1050')
      await page.getByRole('button', { name: '应用尺寸', exact: true }).click()
      await page.getByText(/1050 ×/).waitFor()
      await page.getByRole('button', { name: '检查网格', exact: true }).click()
      await page.getByText(/开放边/).waitFor()
      const download = page.waitForEvent('download')
      await page.getByRole('button', { name: '导出 STL', exact: true }).click()
      const stl = await readFile(await (await download).path())
      assert.equal(stl.length, 84 + 50 * stl.readUInt32LE(80))
      const vertices = []
      for (let offset = 84; offset < stl.length; offset += 50) {
        vertices.push(
          stl.readFloatLE(offset + 12),
          stl.readFloatLE(offset + 24),
          stl.readFloatLE(offset + 36)
        )
      }
      assert.ok(Math.abs(Math.max(...vertices) - Math.min(...vertices) - 1050) < 0.1)
      await capture(page, 'workspace-model-dimensions')
      await page.keyboard.press('Escape')
      await page.getByTestId('task-output').filter({ hasText: '外机源码.zip' }).click()
      await page.getByRole('button', { name: /项目文件/ }).waitFor()
      await page.getByText('export const width = 980;', { exact: true }).waitFor()
      await capture(page, 'creator-source')
      await page.keyboard.press('Escape')

      const followup = await page.evaluate(async () => {
        const a = window.__audit
        const id = 'agent-maker'
        const original = window.fetch
        let round = 0
        window.fetch = async (url, init) => {
          if (!new URL(url).pathname.endsWith('/anthropic/v1/messages')) return original(url, init)
          return ++round === 1
            ? window.__workflowTools(
                [
                  [
                    'apply_project_patch',
                    {
                      patch:
                        '*** Begin Patch\n*** Update File: lib/dimensions.mjs\n@@\n-export const width = 980;\n+export const width = 1000;\n*** End Patch',
                    },
                  ],
                ],
                'follow-up'
              )
            : a.response('宽度已改为 1000 mm。')
        }
        a.drafts.setDraftText(id, '刚才的外机改成 1000 毫米宽。')
        a.store.sendMessage(id)
        await a.waitIdle()
        const saved = await a.db.loadSession(id)
        return {
          next: saved.messages.at(-1).task.project.find(({ path }) => path === 'lib/dimensions.mjs')
            .text,
          previous: saved.messages
            .at(-3)
            .task.project.find(({ path }) => path === 'lib/dimensions.mjs').text,
        }
      })
      assert.match(followup.next, /1000/)
      assert.match(followup.previous, /980/)
    }
  )

  await run(
    'Agent keeps available outputs and resumes a long job in the foreground',
    async (page) => {
      await configure(page, 'agent-recovery', 'goal')
      await page.evaluate(() => {
        const a = window.__audit
        const artifact = (id, name) => ({
          id,
          name,
          mimeType: 'text/plain',
          size: 3,
          serverId: null,
          isImage: false,
        })
        const artifacts = [
          artifact('synced-file', '已完成.txt'),
          artifact('delayed-file', '补同步.txt'),
        ]
        window.__agentRecovery = { starts: 0, canRead: false, rounds: 0, toolReads: 0 }
        const savedStep = { id: 'saved-project-step', name: 'apply_project_patch' }
        let snapshot
        window.freeseekAgentGoals = {
          permission: async () => ({ granted: true }),
          start: async ({ input }) => {
            window.__agentRecovery.starts++
            snapshot = {
              run: {
                ...input.run,
                background: true,
                status: 'paused',
                reason: 'waiting-foreground',
                foregroundTool: savedStep,
              },
              plan: [],
              steps: Array.from({ length: 240 }, (_, index) => ({
                id: 'long-step-' + index,
                kind: 'calculate',
                status: 'done',
              })),
              artifacts,
              answer: '初步结果已保留，接下来需要前台处理代码。',
            }
            return { started: true }
          },
          snapshot: async () => ({ snapshot }),
          pendingTool: async () => {
            window.__agentRecovery.toolReads++
            return {
              tool: {
                ...savedStep,
                args: {
                  patch:
                    '*** Begin Patch\n*** Add File: run.js\n+console.log("继续任务");\n*** End Patch',
                },
              },
            }
          },
          file: async ({ fileId }) => {
            if (fileId === 'delayed-file' && !window.__agentRecovery.canRead)
              throw new Error('Fixture file unavailable')
            return { base64: btoa('abc'), nextOffset: 3 }
          },
        }
        const original = window.fetch
        window.fetch = async (url, init) => {
          if (!new URL(url).pathname.endsWith('/anthropic/v1/messages')) return original(url, init)
          if (++window.__agentRecovery.rounds === 1) {
            const request = JSON.parse(init.body)
            window.__agentRecovery.usedSavedResult = request.system.includes(
              'Saved outcome of the exact step'
            )
            const task = a.store.useChatStore
              .getState()
              .sessionCache['agent-recovery'].messages.at(-1).task
            const project = task.steps.find(({ kind }) => kind === 'project')
            return window.__workflowTools(
              [['verify_goal_criteria', { checks: [{ criterion: 1, evidence: [project.id] }] }]],
              'recovery'
            )
          }
          return a.response('已保存代码。')
        }
        a.drafts.setDraftText('agent-recovery', '先汇总，再继续生成代码。')
        a.store.sendMessage('agent-recovery', { criteria: ['保存代码'], minutes: 5 })
      })
      const recovery = page.getByTestId('agent-run-recovery')
      await recovery.getByText(/下一步需要在手机前台/).waitFor()
      await page.getByTestId('task-output').filter({ hasText: '已完成.txt' }).waitFor()
      assert.equal(
        await page.getByTestId('task-output').filter({ hasText: '补同步.txt' }).count(),
        0
      )
      await page.getByTestId('agent-progress-dock').click()
      await page.getByText('有 1 个后台成果等待同步。', { exact: true }).waitFor()
      await page.evaluate(() => {
        window.__agentRecovery.canRead = true
      })
      await page.getByRole('button', { name: '重试同步', exact: true }).click()
      await page.getByRole('button', { name: '重试同步', exact: true }).waitFor({ state: 'hidden' })
      await page.keyboard.press('Escape')
      await page.getByTestId('task-output').filter({ hasText: '补同步.txt' }).waitFor()
      await recovery.getByRole('button', { name: '在前台继续', exact: true }).click()
      const result = await page.evaluate(async () => {
        const a = window.__audit
        await a.waitIdle()
        const reply = (await a.db.loadSession('agent-recovery')).messages.at(-1)
        return { ...window.__agentRecovery, task: reply.task }
      })
      assert.equal(result.starts, 1)
      assert.equal(result.rounds, 2)
      assert.equal(result.toolReads, 1)
      assert.equal(result.usedSavedResult, true)
      assert.equal(result.task.steps.length, 240)
      assert.equal(result.task.steps.filter(({ kind }) => kind === 'project').length, 1)
      assert.equal(result.task.project[0].path, 'run.js')
      assert.equal(result.task.artifacts.length, 2)
      assert.equal(result.task.run.status, 'completed')
    }
  )

  await run('only the latest actual Agent thinking block animates', async (page) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await configure(page, 'workflow-thinking', 'plan')
    await page.evaluate(() => {
      const a = window.__audit
      const original = window.fetch
      const encoder = new TextEncoder()
      window.fetch = async (url, init) => {
        if (!new URL(url).pathname.endsWith('/anthropic/v1/messages')) return original(url, init)
        return new Response(
          new ReadableStream({
            start(controller) {
              window.__agentThinkingFeed = (events, finish = false) => {
                for (const event of events) {
                  controller.enqueue(encoder.encode('data: ' + JSON.stringify(event) + '\n\n'))
                }
                if (finish) controller.close()
              }
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
      }
      a.drafts.setDraftText('workflow-thinking', '我想做一个多联机外机的 3D 模型。')
      a.store.sendMessage('workflow-thinking')
    })
    await page.getByTestId('reply-activity').getByText('正在连接模型', { exact: true }).waitFor()
    await page.waitForFunction(() => typeof window.__agentThinkingFeed === 'function')
    await page.evaluate(() =>
      window.__agentThinkingFeed([
        { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '先核对目标。' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '先看外机的基本结构。' },
        },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'thinking', thinking: '再判断导出格式。' },
        },
      ])
    )
    const thoughts = page.getByTestId('agent-thinking')
    const active = thoughts.filter({ hasText: '正在思考' })
    await active.waitFor()
    assert.equal(await thoughts.count(), 2)
    assert.equal(await page.getByTestId('reply-activity').count(), 0)
    const animation = (row) =>
      row
        .locator('button > span')
        .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).animationName))
    const animations = await animation(active)
    assert.equal(animations.length, 2)
    assert.ok(animations.every((name) => name !== 'none'))
    assert.deepEqual(await animation(thoughts.first()), ['none', 'none'])
    assert.equal(await active.getByRole('button').getAttribute('aria-expanded'), 'false')
    await capture(page, 'latest-thinking')
    if (process.env.FREESEEK_THINKING_FRAMES) {
      const folder = 'tmp/agent-polish/thinking-frames'
      await mkdir(folder, { recursive: true })
      for (let frame = 0; frame < 18; frame++) {
        await page.screenshot({ path: `${folder}/${String(frame).padStart(2, '0')}.png` })
        await new Promise((resolve) => setTimeout(resolve, 75))
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    assert.deepEqual(await animation(active), ['none', 'none'])
    await page.evaluate(() =>
      window.__agentThinkingFeed(
        [
          { type: 'content_block_stop', index: 2 },
          {
            type: 'content_block_start',
            index: 3,
            content_block: { type: 'text', text: '方案还需要你确认。' },
          },
          { type: 'content_block_stop', index: 3 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 4 },
          },
          { type: 'message_stop' },
        ],
        true
      )
    )
    await active.waitFor({ state: 'hidden' })
    await page.getByText('方案还需要你确认。', { exact: true }).waitFor()
  })

  await run(
    'agent tool settings persist and disabled tools are absent and rejected in later requests',
    async (page) => {
      await configure(page, 'workflow-tool-policy', 'task')
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('assistantSettings'))
      await page.getByRole('button', { name: /工具设置/ }).click()
      const files = page.getByRole('switch', { name: '生成成果文件' })
      await files.click()
      assert.equal(await files.getAttribute('aria-checked'), 'false')
      await page.evaluate(() => {
        const a = window.__audit
        for (const tool of [
          'search',
          'web',
          'github',
          'attachment',
          'table',
          'code',
          'model3d',
          'review',
        ]) {
          a.settings.setAgentTool(tool, false)
        }
      })
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      await configure(page, 'workflow-tool-policy', 'task')
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const id = 'workflow-tool-policy'
        await a.store.selectSession(id)
        const responses = []
        const original = window.fetch
        window.fetch = async (url, init) => {
          if (!new URL(url).pathname.endsWith('/anthropic/v1/messages')) return original(url, init)
          responses.push(JSON.parse(init.body))
          if (responses.length === 1) {
            return window.__workflowTools(
              [['create_markdown', { file_name: '禁止生成', content: 'disabled output' }]],
              'disabled'
            )
          }
          return a.response('文件工具已关闭。')
        }
        a.drafts.setDraftText(id, '打开 https://example.org/report 并保存 Markdown。')
        a.store.sendMessage(id)
        await a.waitIdle()
        const reply = (await a.db.loadSession(id)).messages.at(-1)
        return {
          settings: a.settings.useSettings.getState().agentTools,
          tools: responses[0].tools.map(({ name }) => name),
          artifacts: reply.task.artifacts,
          toolMask: reply.task.run.toolMask,
        }
      })
      assert.ok(Object.values(result.settings).every((enabled) => enabled === false))
      assert.deepEqual(result.tools, ['update_task_plan'])
      assert.deepEqual(result.artifacts, [])
      assert.equal(result.toolMask, 0)
      await page.getByTestId('agent-progress-dock').click()
      await page.getByTestId('agent-run-summary').waitFor()
    }
  )

  await run(
    'agent plan asks, takes conversational feedback and executes only the approved revision',
    async (page) => {
      await page.setViewportSize({ width: 360, height: 800 })
      await configure(page, 'workflow-plan', 'plan')
      await page.evaluate(async () => {
        const a = window.__audit
        const original = window.fetch
        window.__planRequests = []
        window.fetch = async (url, init) => {
          if (!new URL(url).pathname.endsWith('/anthropic/v1/messages')) return original(url, init)
          const request = JSON.parse(init.body)
          const index = window.__planRequests.push(request)
          if (index === 1) {
            return window.__workflowTools(
              [['ask_plan_question', { question: '最后希望拿到哪种 3D 文件？例如 GLB 或 STEP。' }]],
              index
            )
          }
          if (index === 2) {
            return window.__workflowTools(
              [
                [
                  'create_document',
                  { file_name: '不应生成', title: '不应生成', sections: [{ text: '未确认' }] },
                ],
                [
                  'update_task_plan',
                  {
                    steps: [
                      { label: '核对外机尺寸与结构', status: 'todo' },
                      { label: '按 GLB 格式生成整体外观', status: 'todo' },
                    ],
                  },
                ],
              ],
              index
            )
          }
          if (index === 3) {
            return window.__workflowTools(
              [
                [
                  'update_task_plan',
                  {
                    steps: [
                      { label: '核对外机尺寸与结构', status: 'todo' },
                      { label: '设计可独立拆卸的外壳并导出 GLB', status: 'todo' },
                    ],
                  },
                ],
              ],
              index
            )
          }
          if (index === 4) {
            return window.__workflowTools(
              [['create_markdown', { file_name: '执行记录', content: '# 已审批\n按第二版执行。' }]],
              index
            )
          }
          return a.response('已完成确认的方案。')
        }
        const id = 'workflow-plan'
        a.drafts.setDraftText(id, '做一个多联机外机的 3D 模型。')
        const selection = a.providers.useProviders.getState().selection
        a.drafts.addDraftFiles(
          id,
          [new File(['外机宽 980 mm'], '尺寸.txt', { type: 'text/plain' })],
          '',
          { selection, deferUpload: true }
        )
        if (!(await a.store.sendMessage(id))) throw new Error('Plan did not start')
      })
      const input = page.getByTestId('chat-composer').locator('textarea')
      const question = page.getByTestId('agent-plan-question')
      await question
        .getByText('最后希望拿到哪种 3D 文件？例如 GLB 或 STEP。', { exact: true })
        .waitFor()
      await question.getByRole('button', { name: '回复问题', exact: true }).click()
      assert.equal(await input.evaluate((element) => document.activeElement === element), true)
      assert.equal(await input.getAttribute('placeholder'), '回复 Agent 的问题')
      await input.fill('请用 GLB 格式。')
      await input.press('Enter')
      const review = page.getByTestId('agent-plan-review')
      await review.getByText('计划第 1 版 · 2 步', { exact: true }).waitFor()
      await review.getByText('按这版计划执行，还是先调整？', { exact: true }).waitFor()
      const firstDraft = await page.evaluate(async () => {
        const a = window.__audit
        await a.waitIdle()
        return (await a.db.loadSession('workflow-plan')).messages.at(-1)
      })
      await page.getByTestId('agent-progress-dock').click()
      const detail = page.getByTestId('agent-run-summary')
      await detail.getByText('按 GLB 格式生成整体外观', { exact: true }).waitFor()
      assert.equal(await detail.locator('textarea').count(), 0)
      await page.keyboard.press('Escape')
      await detail.waitFor({ state: 'hidden' })
      await review.getByRole('button', { name: '让 Agent 修改', exact: true }).click()
      assert.equal(await input.evaluate((element) => document.activeElement === element), true)
      assert.equal(await input.getAttribute('placeholder'), '告诉 Agent 你想怎么改')
      await input.fill('把外壳做成可拆卸结构，保持 GLB。')
      await input.press('Enter')
      await review.getByText('计划第 2 版 · 2 步', { exact: true }).waitFor()
      await capture(page, 'plan-review')
      const snapshot = await page.evaluate(async (oldReplyId) => {
        const a = window.__audit
        await a.waitIdle()
        const id = 'workflow-plan'
        const session = await a.db.loadSession(id)
        const revised = session.messages.at(-1)
        const stale = a.store.approveAgentPlan(id, oldReplyId, 1)
        const wrongRevision = a.store.approveAgentPlan(id, revised.id, 1)
        const zip = await a.backup.exportHistory()
        return {
          bytes: Array.from(new Uint8Array(await zip.blob.arrayBuffer())),
          revised,
          stale,
          wrongRevision,
          requests: window.__planRequests,
        }
      }, firstDraft.id)
      assert.notEqual(snapshot.revised.id, firstDraft.id)
      assert.equal(snapshot.revised.task.run.status, 'awaiting-review')
      assert.deepEqual(snapshot.revised.task.artifacts, [])
      assert.equal(snapshot.stale, false)
      assert.equal(snapshot.wrongRevision, false)
      assert.equal(snapshot.requests.length, 3)
      for (const request of snapshot.requests) {
        assert.ok(request.tools.some(({ name }) => name === 'ask_plan_question'))
        assert.equal(
          request.tools.some(({ name }) => name.startsWith('create_')),
          false
        )
      }
      assert.match(JSON.stringify(snapshot.requests[1]), /最后希望拿到哪种 3D 文件/)
      assert.match(JSON.stringify(snapshot.requests[2].system), /按 GLB 格式生成整体外观/)
      assert.match(JSON.stringify(snapshot.requests[2].system), /尺寸\.txt/)
      if (process.env.FREESEEK_TASK_PREVIEWS) {
        const { writeFile } = await import('node:fs/promises')
        await writeFile('tmp/agent-polish/review-native.zip', Uint8Array.from(snapshot.bytes))
      }
      await page.getByTestId('agent-progress-dock').click()
      await detail.getByText('设计可独立拆卸的外壳并导出 GLB', { exact: true }).waitFor()
      await detail.getByRole('button', { name: '按计划执行', exact: true }).click()
      await page.waitForFunction(() => window.__planRequests.length === 5)
      const result = await page.evaluate(async () => {
        const a = window.__audit
        await a.waitIdle()
        const session = await a.db.loadSession('workflow-plan')
        const reply = session.messages.at(-1)
        return { reply, count: session.messages.length, requests: window.__planRequests }
      })
      assert.equal(result.count, 6)
      assert.equal(result.reply.id, snapshot.revised.id)
      assert.equal(result.reply.task.run.approvedRevision, 2)
      assert.equal(result.reply.task.run.status, 'completed')
      assert.equal(result.reply.task.artifacts[0].name, '执行记录.md')
      assert.match(JSON.stringify(result.requests[3].system), /设计可独立拆卸的外壳/)
      assert.match(JSON.stringify(result.requests[3].system), /尺寸\.txt/)
      assert.ok(result.requests[3].tools.some(({ name }) => name === 'create_markdown'))
      assert.equal(
        result.requests[3].tools.some(({ name }) => name === 'ask_plan_question'),
        false
      )
      await review.waitFor({ state: 'hidden' })
    }
  )
  await run(
    'OpenAI-compatible Agent responds to planning questions without granting execution',
    async (page) => {
      await configure(page, 'workflow-custom-plan', 'plan')
      await page.evaluate(() => {
        const a = window.__audit
        a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: '模型验收服务',
            url: 'https://review-fixture.invalid/v1',
            apiKey: 'review-fixture-key',
            model: 'glm-5.3-flash',
          },
          true
        )
        const original = window.fetch
        window.__reviewRequests = []
        window.fetch = async (url, init) => {
          if (new URL(url).hostname !== 'review-fixture.invalid') return original(url, init)
          const request = JSON.parse(init.body)
          const count = window.__reviewRequests.push(request)
          const tool = count === 1 ? 'ask_plan_question' : 'update_task_plan'
          const args =
            count === 1
              ? { question: '预览需要做成哪种文件？' }
              : { steps: [{ label: '制作可在浏览器预览的 GLB 模型', status: 'todo' }] }
          const packets = [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'review-' + count,
                        type: 'function',
                        function: { name: tool, arguments: JSON.stringify(args) },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ]
          return new Response(
            packets.map((packet) => 'data: ' + JSON.stringify(packet) + '\n\n').join('') +
              'data: [DONE]\n\n',
            {
              headers: { 'Content-Type': 'text/event-stream' },
            }
          )
        }
        a.drafts.setDraftText('workflow-custom-plan', '帮我拟一个外机模型方案。')
        a.store.sendMessage('workflow-custom-plan')
      })
      const question = page.getByTestId('agent-plan-question')
      await question.getByText('预览需要做成哪种文件？', { exact: true }).waitFor()
      const input = page.getByTestId('chat-composer').locator('textarea')
      await input.fill('用 GLB 格式。')
      await input.press('Enter')
      const review = page.getByTestId('agent-plan-review')
      await review.getByText('计划已拟好', { exact: true }).waitFor()
      const result = await page.evaluate(async () => {
        const a = window.__audit
        await a.waitIdle()
        const chat = await a.db.loadSession('workflow-custom-plan')
        return { requests: window.__reviewRequests, task: chat.messages.at(-1).task }
      })
      assert.equal(result.requests.length, 2)
      assert.equal(result.requests[0].model, 'glm-5.3-flash')
      assert.match(JSON.stringify(result.requests[1].messages), /预览需要做成哪种文件/)
      assert.ok(
        result.requests.every(
          ({ tools }) => !tools.some(({ function: tool }) => tool.name.startsWith('create_'))
        )
      )
      assert.equal(result.task.run.status, 'awaiting-review')
      assert.equal(result.task.run.approvedRevision, undefined)
    }
  )

  await run(
    'agent workflow exceeds ten successful model rounds and accounts for each round without search',
    async (page) => {
      await configure(page, 'workflow-rounds', 'task')
      const workflow = await page.evaluate(async () => {
        const a = window.__audit
        let requests = 0
        const original = window.fetch
        window.fetch = async (url, init) => {
          if (!new URL(url).pathname.endsWith('/anthropic/v1/messages')) return original(url, init)
          requests++
          if (requests <= 12) {
            return window.__workflowTools(
              [['calculate', { calculations: [{ operation: 'add', values: [requests, 2] }] }]],
              requests
            )
          }
          return a.response('已核对十二组数据。', {
            input_tokens: 7,
            output_tokens: 3,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          })
        }
        const id = 'workflow-rounds'
        a.drafts.setDraftText(id, '逐项核对十二组数据')
        a.store.sendMessage(id)
        await a.waitIdle()
        const item = (await a.db.loadSession(id)).messages.at(-1)
        return {
          requests,
          run: item.task.run,
          executed: item.task.steps.length,
          usage: item.usage,
          usageHistory: item.usageHistory.length,
        }
      })
      assert.equal(workflow.requests, 13)
      assert.equal(workflow.executed, 12)
      assert.equal(workflow.run.status, 'completed')
      assert.equal(workflow.run.totalRequests, 13)
      assert.equal(workflow.usageHistory, 13)
      assert.equal(workflow.usage.input_tokens, 91)
    }
  )

  await run(
    'agent workflow validates a compatible OpenAI tool and accepts a confirmed generic stop marker',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const profile = {
          ...a.providers.emptyProfile(),
          id: 'tool-check',
          name: '测试服务',
          model: 'glm-5.3',
          url: 'https://agent-probe.example.test/v1',
          apiKey: 'fixture-only',
          protocol: 'openai',
          stream: false,
          modelSettings: { 'glm-5.3': { stream: false } },
        }
        const original = window.fetch
        const bodies = []
        window.fetch = async (url, init) => {
          if (new URL(url).hostname !== 'agent-probe.example.test') return original(url, init)
          bodies.push(JSON.parse(init.body))
          return Response.json({
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message:
                  bodies.length === 1
                    ? {
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                          {
                            id: 'tc-1',
                            type: 'function',
                            function: { name: 'freeseek_tool_probe', arguments: { value: 42 } },
                          },
                        ],
                      }
                    : { role: 'assistant', content: 'FREESK42' },
              },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 2 },
          })
        }
        const result = await a.providerClient.testProviderTools(
          profile,
          new AbortController().signal
        )
        return { result, bodies }
      })
      assert.equal(result.result.requests, 2)
      assert.equal(result.bodies[1].messages.at(-1).tool_call_id, 'tc-1')
      assert.equal(result.bodies[1].messages.at(-1).content, 'FREESK42')
    }
  )

  await run(
    'agent workflow hands an explicitly approved goal to the native runner and imports its verified artifact',
    async (page) => {
      await configure(page, 'workflow-goal', 'goal')
      const opened = await page.evaluate(async () => {
        const a = window.__audit
        let accepted
        let calls = 0
        let polls = 0
        const text = '后台成果完整。\n'
        const bytes = new TextEncoder().encode(text)
        const key = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
          b.toString(16).padStart(2, '0')
        ).join('')
        window.freeseekAgentGoals = {
          permission: async () => ({ granted: true }),
          async start(job) {
            accepted = job
            return { started: true }
          },
          async snapshot() {
            if (polls++ === 0)
              return {
                snapshot: {
                  run: { ...accepted.input.run, background: true, status: 'running' },
                  steps: [],
                  plan: [],
                  artifacts: [],
                  answer: '正在交付。',
                },
              }
            return {
              snapshot: {
                run: {
                  ...accepted.input.run,
                  background: true,
                  status: 'completed',
                  met: [1],
                  totalRequests: 2,
                  segmentRequests: 2,
                },
                steps: [{ id: 'proof-md', kind: 'md', status: 'done', file: '后台成果.md' }],
                plan: [],
                artifacts: [
                  {
                    id: 'goal-generated-proof',
                    sha256: key,
                    name: '后台成果.md',
                    mimeType: 'text/markdown',
                    size: bytes.length,
                    isImage: false,
                    serverId: null,
                  },
                ],
                answer: '已交付。',
                usage: { input: 20, output: 17, cacheRead: 3, cacheWrite: 0 },
              },
            }
          },
          async file() {
            return { base64: btoa(String.fromCharCode(...bytes)), nextOffset: bytes.length }
          },
          async control() {
            return { changed: true }
          },
        }
        const original = window.fetch
        window.fetch = async (url, init) => {
          if (new URL(url).pathname.endsWith('/anthropic/v1/messages')) {
            calls++
            return a.response('不应降级')
          }
          return original(url, init)
        }
        const id = 'workflow-goal'
        window.__readGoalFixture = async () => {
          await a.waitIdle()
          const session = await a.db.loadSession(id)
          const reply = session.messages.at(-1)
          const saved = await a.db.loadFile('goal-generated-proof')
          return {
            calls,
            run: reply.task.run,
            usage: reply.usage,
            saved: await saved?.text(),
            budget: accepted.input.run.budgetRequests,
            original: accepted.input.run.criteria,
          }
        }
        a.drafts.setDraftText(id, '生成任务报告')
        const before = a.store.sendMessage(id)
        const requested = a.store.useChatStore.getState().agentGoalPrompt
        return { before, requested }
      })
      assert.equal(opened.before, false)
      assert.equal(opened.requested.sessionId, 'workflow-goal')
      const setup = page.getByRole('dialog', { name: '设定目标', exact: true })
      const budget = setup.getByRole('button', { name: '本次任务预算', exact: true })
      await setup.getByRole('textbox', { name: '完成标准', exact: true }).fill('保存审阅报告')
      await budget.press('ArrowDown')
      const choices = page.getByRole('listbox', { name: '本次任务预算', exact: true })
      await choices.getByRole('option', { name: /^最多 40 次/ }).waitFor()
      await capture(page, 'goal-budget')
      await page.keyboard.press('ArrowUp')
      await page.keyboard.press('Enter')
      await choices.waitFor({ state: 'hidden' })
      assert.match(await budget.textContent(), /最多 12 次模型请求/)
      assert.equal(await budget.evaluate((button) => document.activeElement === button), true)
      await setup.getByRole('button', { name: '开始执行', exact: true }).click()
      const result = await page.evaluate(() => window.__readGoalFixture())
      assert.equal(result.calls, 0)
      assert.equal(result.run.status, 'completed')
      assert.equal(result.run.background, true)
      assert.equal(result.saved, '后台成果完整。\n')
      assert.equal(result.usage.output_tokens, 17)
      assert.equal(result.budget, 12)
      assert.deepEqual(result.original, ['保存审阅报告'])
    }
  )

  await run(
    'agent workflow resumes in the app when the native checkpoint used revoked memory',
    async (page) => {
      const sessionId = 'goal-with-old-memory'
      const replyId = 'goal-old-reply'
      await configure(page, sessionId, 'goal')
      await page.evaluate(
        async ({ sessionId, replyId }) => {
          const a = window.__audit
          const was = Date.now() - 1000
          const question = a.fixtures.user('goal-old-question', '继续整理报告')
          const answer = a.fixtures.assistant(replyId, '第一部分已整理。', {
            status: 'stopped',
            memoryUse: { references: [{ id: 'revoked-note', revision: 'previous' }], tokens: 20 },
            task: {
              plan: [{ label: '初步分析', status: 'done' }],
              artifacts: [],
              steps: [{ id: 'already-done', kind: 'calculate', status: 'done' }],
              run: {
                id: replyId,
                mode: 'goal',
                status: 'paused',
                reason: 'user',
                background: true,
                revision: 0,
                criteria: ['完成报告'],
                met: [],
                budgetMinutes: 5,
                budgetRequests: 12,
                totalRequests: 2,
                segmentRequests: 2,
                startedAt: was,
                elapsedMs: 1000,
              },
            },
          })
          await a.seed([
            a.fixtures.session({
              id: sessionId,
              title: '撤销记忆验收',
              mode: 'agent',
              agentRunMode: 'goal',
              messages: [question, answer],
            }),
          ])
          window.__memoryResume = { nativeStarts: 0, requests: [] }
          window.freeseekAgentGoals = {
            permission: async () => ({ granted: true }),
            start: async () => {
              window.__memoryResume.nativeStarts++
              return { started: false, reason: 'invalid' }
            },
          }
          const original = window.fetch
          window.fetch = async (url, init) => {
            if (new URL(url).pathname.endsWith('/anthropic/v1/messages')) {
              window.__memoryResume.requests.push(JSON.parse(init.body))
              return a.response('已按当前设置继续。')
            }
            return original(url, init)
          }
        },
        { sessionId, replyId }
      )
      await page.getByTestId('agent-progress-dock').click()
      await page.getByRole('button', { name: '继续任务', exact: true }).click()
      await page.waitForFunction(() => window.__memoryResume.requests.length > 0)
      const result = await page.evaluate(async (sessionId) => {
        await window.__audit.waitIdle()
        const session = await window.__audit.db.loadSession(sessionId)
        return { ...window.__memoryResume, reply: session.messages.at(-1) }
      }, sessionId)
      assert.equal(result.nativeStarts, 0)
      assert.equal(result.requests.length, 3)
      assert.doesNotMatch(
        JSON.stringify(result.requests[0]),
        /User-confirmed notes from this device/
      )
      assert.equal(result.reply.memoryUse, undefined)
      assert.equal(result.reply.task.run.background, false)
      assert.ok(result.reply.task.steps.some(({ id }) => id === 'already-done'))
    }
  )
}
