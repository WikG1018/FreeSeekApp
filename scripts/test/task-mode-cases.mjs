import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

export const runTaskModeCases = async (run) => {
  await run(
    'agent panels keep narrow controls aligned and restore positions in long plans and result lists',
    async (page) => {
      await page.setViewportSize({ width: 320, height: 680 })
      await page.evaluate(async () => {
        const a = window.__audit
        a.settings.setShowModelSwitcher(true)
        a.settings.setShowReasoningPicker(true)
        a.settings.setFontScale(1.25)
        const now = Date.now()
        const files = []
        const messages = []
        for (let round = 1; round <= 10; round++) {
          const name = '核对记录 ' + round + '.md'
          const blob = new Blob(['# 核对记录 ' + round + '\n\n验收正文。'], {
            type: 'text/markdown',
          })
          const id = 'result-' + round
          files.push({ id, blob })
          messages.push(
            a.fixtures.user('request-' + round, '核对第 ' + round + ' 项'),
            a.fixtures.assistant('result-reply-' + round, '核对说明', {
              task: {
                artifacts: [
                  {
                    id,
                    name,
                    size: blob.size,
                    mimeType: blob.type,
                    isImage: false,
                    serverId: null,
                    createdAt: now + round,
                  },
                ],
                steps: [],
                plan:
                  round !== 10
                    ? []
                    : Array.from({ length: 8 }, (_, step) => ({
                        label: '核对第 ' + (step + 1) + ' 步的资料并整理相关的验收结果',
                        status: step < 6 ? 'done' : step === 6 ? 'working' : 'todo',
                      })),
                ...(round === 10 && {
                  run: {
                    id: 'workflow-narrow-run',
                    mode: 'task',
                    status: 'running',
                    criteria: [],
                    met: [],
                    revision: 1,
                    budgetMinutes: 15,
                    budgetRequests: 40,
                    totalRequests: 1,
                    segmentRequests: 1,
                    startedAt: now,
                    elapsedMs: 1000,
                  },
                }),
              },
            })
          )
        }
        await a.seed(
          [a.fixtures.session({ id: 'many-result-fixture', mode: 'agent', messages })],
          files
        )
      })
      const toolbar = page.getByTestId('composer-toolbar')
      const inspect = () =>
        toolbar.evaluate(async (row) => {
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          )
          const bounds = row.parentElement
            .querySelector('[data-testid="composer-input-surface"]')
            .getBoundingClientRect()
          const buttons = Array.from(row.querySelectorAll('[data-toolbar-control]'))
          return {
            order: buttons.map((button) => button.dataset.toolbarControl),
            layout: row.dataset.compact,
            widths: buttons.map((button) => button.getBoundingClientRect().width),
            top: buttons.map((button) => button.getBoundingClientRect().top),
            available: bounds.width,
            lineCount: new Set(
              buttons.map((button) => Math.round(button.getBoundingClientRect().top))
            ).size,
            inside: buttons.every((button) => {
              const rect = button.getBoundingClientRect()
              return (
                rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.width > 0
              )
            }),
          }
        })
      await toolbar.locator('[data-toolbar-control="mode"]').waitFor()
      const narrow = await inspect()
      assert.deepEqual(narrow.order, ['mode', 'model', 'effort', 'search', 'context'])
      assert.equal(narrow.lineCount, 1, JSON.stringify(narrow))
      assert.equal(narrow.inside, true)
      await page.setViewportSize({ width: 250, height: 680 })
      await page.waitForFunction(() => window.innerWidth === 250)
      const smallest = await inspect()
      assert.ok(smallest.inside, JSON.stringify(smallest))
      await page.setViewportSize({ width: 320, height: 680 })
      const dock = page.getByTestId('agent-progress-dock')
      await dock.getByText(/执行中 7\/8/).waitFor()
      await dock.click()
      const progress = page.getByTestId('agent-run-summary')
      const scroll = page.getByTestId('agent-progress-scroll')
      await progress.getByText('执行计划', { exact: true }).waitFor()
      assert.equal(await progress.getByRole('listitem').count(), 8)
      assert.equal(
        await scroll.evaluate(
          (list) => list.scrollHeight > list.clientHeight && list.scrollTop > 0
        ),
        true
      )
      await scroll.evaluate((list) => {
        list.scrollTop = 0
      })
      await progress.getByRole('button', { name: '定位当前' }).click()
      assert.ok(await scroll.evaluate((list) => list.scrollTop > 0))
      if (process.env.FREESEEK_TASK_PREVIEWS) {
        await mkdir('tmp/regression/task', { recursive: true })
        await page.screenshot({
          path: 'tmp/regression/task/review-progress-320.png',
          animations: 'disabled',
        })
      }
      await page.keyboard.press('Escape')
      await progress.waitFor({ state: 'hidden' })
      await page.evaluate(() => window.__audit.settings.setThemePreference('dark'))
      await page.getByTestId('session-artifacts-button').click()
      const artifacts = page.getByRole('dialog', { name: '对话成果' })
      assert.equal(await artifacts.getByRole('listitem').count(), 10)
      assert.equal(
        await artifacts.getByRole('listitem').first().locator('strong').textContent(),
        '核对记录 10.md'
      )
      if (process.env.FREESEEK_TASK_PREVIEWS) {
        await page.screenshot({
          path: 'tmp/regression/task/review-results-320.png',
          animations: 'disabled',
        })
      }
      const search = artifacts.getByRole('searchbox')
      await search.fill('第 2 轮')
      const result = artifacts.getByRole('button', { name: '预览 核对记录 2.md', exact: true })
      assert.equal(await artifacts.getByRole('listitem').count(), 1)
      await result.click()
      const reader = page.getByRole('dialog', { name: '预览 核对记录 2.md', exact: true })
      await reader.getByText('验收正文。', { exact: true }).waitFor()
      await reader.getByRole('button', { name: '返回成果列表' }).click()
      await search.waitFor()
      assert.equal(await search.inputValue(), '第 2 轮')
      assert.equal(await result.evaluate((button) => document.activeElement === button), true)
      await search.clear()
      const list = page.getByTestId('agent-artifact-list')
      await list.evaluate((target) => {
        target.scrollTop = target.scrollHeight
      })
      const last = artifacts.getByRole('button', { name: '预览 核对记录 1.md', exact: true })
      await last.click()
      await page.keyboard.press('Escape')
      await last.waitFor()
      assert.ok(await list.evaluate((target) => target.scrollTop > 0))
    }
  )

  await run(
    'task mode lists all conversation results by creation time and previews, saves and shares them',
    async (page) => {
      const wordName = 'FreeSeekApp_导入与文件版式兼容验收记录_2026_v3.docx'
      const fixture = await page.evaluate(async (wordName) => {
        const { fixtures: f, taskArtifacts, seed, backup } = window.__audit
        const now = Date.now()
        const word = taskArtifacts.makeTaskFile('docx', {
          file_name: wordName.slice(0, -5),
          title: '文件验收',
          sections: [{ heading: '结论', text: '原件已正确保存。' }],
        })
        const workbook = taskArtifacts.makeTaskFile('xlsx', {
          file_name: '报价对比',
          sheets: [
            {
              name: '明细',
              rows: [
                ['供应商', '金额', '备注'],
                ['样例甲', 1200, '=1+2'],
                ...Array.from({ length: 55 }, (_, index) => ['记录' + (index + 1), index, '']),
              ],
            },
            { name: '汇总', rows: [['合计'], [1200]] },
          ],
        })
        const output = (id, { name, blob }, createdAt) => ({
          id,
          name,
          size: blob.size,
          isImage: false,
          serverId: null,
          mimeType: blob.type,
          createdAt,
        })
        await seed(
          [
            f.session({
              id: 'results-fixture',
              mode: 'agent',
              rootMessageId: 'request',
              title: '验收对话 · 一个特别长的标题需要在窄屏优先收起',
              messages: [
                f.user('request', '生成核对说明和工作表', {
                  parentId: null,
                  selectedChildId: 'chosen',
                }),
                f.assistant('unselected', '这是没有选中的旧回复版本。', {
                  parentId: 'request',
                  createdAt: now - 5000,
                  task: { plan: [], steps: [], artifacts: [output('proof-sheet', workbook, now)] },
                }),
                f.assistant('chosen', '这是当前回复。', {
                  parentId: 'request',
                  createdAt: now - 1000,
                  task: { plan: [], steps: [], artifacts: [output('proof-doc', word)] },
                }),
              ],
            }),
            f.session({ id: 'no-results-fixture', title: '无成果的普通对话' }),
          ],
          [
            { id: 'proof-sheet', blob: workbook.blob },
            { id: 'proof-doc', blob: word.blob },
          ]
        )
        const pack = await backup.exportHistory()
        const bytes = Array.from(new Uint8Array(await pack.blob.arrayBuffer()))
        return bytes
      }, wordName)
      const viewport = page.viewportSize()
      const previewDir = 'tmp/regression/task'
      if (process.env.FREESEEK_TASK_PREVIEWS) {
        await mkdir(previewDir, { recursive: true })
        await writeFile(previewDir + '/release-fixture.zip', Buffer.from(fixture))
      }
      const entry = page.getByTestId('session-artifacts-button')
      await entry.click()
      const list = page.getByRole('dialog', { name: '对话成果', exact: true })
      assert.deepEqual(await list.getByRole('listitem').locator('strong').allTextContents(), [
        '报价对比.xlsx',
        wordName,
      ])
      assert.equal(await list.getByText('第 1 轮', { exact: true }).count(), 2)
      if (process.env.FREESEEK_TASK_PREVIEWS) {
        await page.screenshot({
          path: previewDir + '/collection-' + viewport.width + '.png',
          animations: 'disabled',
        })
      }
      await list.getByRole('button', { name: '预览 报价对比.xlsx', exact: true }).click()
      const detail = page.getByRole('dialog', { name: '预览 报价对比.xlsx', exact: true })
      await detail.getByRole('cell', { name: '样例甲', exact: true }).waitFor()
      const more = detail.getByRole('button', { name: '更多', exact: true })
      const header = await more.evaluate((button) => ({
        right: button.getBoundingClientRect().right,
        dialogRight: button.closest('[aria-modal="true"]').getBoundingClientRect().right,
      }))
      assert.ok(header.dialogRight - header.right < 32)
      assert.equal(
        await detail.getByRole('cell', { name: '=1+2', exact: true }).textContent(),
        '=1+2'
      )
      await detail.getByRole('button', { name: '下一页', exact: true }).click()
      await detail.getByRole('cell', { name: '记录55', exact: true }).waitFor()
      await detail.getByRole('button', { name: '在文件中查找', exact: true }).click()
      const find = detail.getByRole('searchbox', { name: '在文件中查找' })
      await find.fill('样例甲')
      await detail.getByRole('cell', { name: '样例甲', exact: true }).waitFor()
      assert.equal(await detail.locator('mark').first().textContent(), '样例甲')
      await find.clear()
      const sheetChoice = detail.getByRole('button', { name: '工作表', exact: true })
      await sheetChoice.click()
      const sheets = page.getByRole('dialog', { name: '工作表', exact: true })
      await sheets.getByRole('option', { name: '明细', exact: true }).waitFor()
      await page.keyboard.press('Escape')
      await sheets.waitFor({ state: 'hidden' })
      assert.equal(await sheetChoice.evaluate((button) => document.activeElement === button), true)
      await sheetChoice.click()
      await sheets.getByRole('option', { name: '汇总', exact: true }).click()
      await detail.getByRole('columnheader', { name: '合计', exact: true }).waitFor()
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true })
        Object.defineProperty(navigator, 'share', {
          configurable: true,
          value: async ({ files }) => {
            const [file] = files
            window.__sharedResult = { name: file.name, size: file.size, type: file.type }
          },
        })
      })
      await detail.getByRole('button', { name: '分享', exact: true }).click()
      await detail.getByText('已打开系统分享面板。', { exact: true }).waitFor()
      const shared = await page.evaluate(() => window.__sharedResult)
      assert.equal(shared.name, '报价对比.xlsx')
      assert.match(shared.type, /spreadsheetml/)
      assert.ok(shared.size > 1000)
      if (process.env.FREESEEK_TASK_PREVIEWS) {
        await sheetChoice.click()
        await sheets.getByRole('option', { name: '明细', exact: true }).click()
        await page.screenshot({
          path: previewDir + '/workbook-' + viewport.width + '.png',
          animations: 'disabled',
        })
      }
      await detail.getByRole('button', { name: '返回成果列表', exact: true }).click()
      await list.getByRole('button', { name: '预览 ' + wordName, exact: true }).click()
      const document = page.getByRole('dialog', { name: '预览 ' + wordName, exact: true })
      await document
        .frameLocator('iframe[title="Word 版式"]')
        .getByText('原件已正确保存。', { exact: true })
        .waitFor()
      await page.setViewportSize({ width: 320, height: 740 })
      const toolbar = document.getByTestId('file-reader-toolbar')
      const title = await document.locator('[data-modal-initial-focus]').evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(element).lineHeight),
        suffix: element.lastElementChild.textContent,
      }))
      assert.ok(title.height <= title.lineHeight + 1)
      assert.equal(title.suffix, '_v3.docx')
      const [outline, zoomIn, searchIcon] = await Promise.all([
        toolbar.getByRole('button', { name: '目录', exact: true }).boundingBox(),
        toolbar.getByRole('button', { name: '放大', exact: true }).boundingBox(),
        toolbar.getByRole('button', { name: '在文件中查找', exact: true }).boundingBox(),
      ])
      assert.ok(Math.abs(outline.y - zoomIn.y) <= 2 && Math.abs(outline.y - searchIcon.y) <= 2)
      assert.ok(searchIcon.x + searchIcon.width <= 320 && outline.x + outline.width <= zoomIn.x)
      assert.equal(await document.getByRole('searchbox', { name: '在文件中查找' }).count(), 0)
      if (process.env.FREESEEK_TASK_PREVIEWS) {
        await page.screenshot({ path: previewDir + '/word-compact.png', animations: 'disabled' })
      }
      await toolbar.getByRole('button', { name: '在文件中查找', exact: true }).click()
      const wordSearch = document.getByRole('searchbox', { name: '在文件中查找' })
      await wordSearch.fill('原件')
      await wordSearch.press('Enter')
      await document
        .frameLocator('iframe[title="Word 版式"]')
        .locator('[data-word-match]')
        .waitFor()
      await page.keyboard.press('Escape')
      await wordSearch.waitFor({ state: 'hidden' })
      await page.setViewportSize(viewport)
      await document.getByRole('button', { name: '更多', exact: true }).click()
      await page
        .getByRole('dialog', { name: '更多', exact: true })
        .getByRole('button', { name: '文字阅读', exact: true })
        .click()
      assert.match(
        await document.getByTestId('task-document-preview').textContent(),
        /原件已正确保存/
      )
      assert.equal(await document.getByRole('button', { name: '关闭', exact: true }).count(), 0)
      await document.getByRole('button', { name: '目录', exact: true }).click()
      await page
        .getByRole('listbox', { name: '目录', exact: true })
        .getByRole('option', { name: '结论', exact: true })
        .click()
      assert.equal(
        await document
          .getByRole('heading', { name: '结论', exact: true })
          .getAttribute('data-reader-hit'),
        'true'
      )
      const download = page.waitForEvent('download')
      await document.getByRole('button', { name: '保存原件', exact: true }).click()
      assert.equal((await download).suggestedFilename(), wordName)
      await page.keyboard.press('Escape')
      await document.waitFor({ state: 'hidden' })
      const originallyOpened = list.getByRole('button', { name: '预览 ' + wordName, exact: true })
      await page.waitForFunction(
        (name) => document.activeElement?.getAttribute('aria-label') === '预览 ' + name,
        wordName
      )
      await originallyOpened.waitFor()
      await page.keyboard.press('Escape')
      await list.waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: '查看成果 ' + wordName, exact: true }).click()
      await document
        .frameLocator('iframe[title="Word 版式"]')
        .getByText('文件验收', { exact: true })
        .waitFor()
      await document
        .frameLocator('iframe[title="Word 版式"]')
        .getByText('结论', { exact: true })
        .waitFor()
      await document.getByRole('button', { name: '更多', exact: true }).click()
      await page
        .getByRole('dialog', { name: '更多', exact: true })
        .getByRole('button', { name: '用于下一轮', exact: true })
        .click()
      await document.waitFor({ state: 'hidden' })
      assert.equal(
        await page.evaluate(
          () => window.__audit.drafts.getDraft('results-fixture').attachments[0]?.file.name
        ),
        wordName
      )
      await page.evaluate(() => window.__audit.store.selectSession('no-results-fixture'))
      await page.getByTestId('chat-view').waitFor()
      await entry.waitFor({ state: 'hidden' })
    }
  )

  await run(
    'task mode switch asks each time and cancellation keeps the open conversation',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([a.fixtures.session({ id: 'mode-existing', title: '现有对话' })])
        a.settingsDialog.openSettings('assistantSettings')
      })
      const gate = page.getByRole('switch', { name: '新建对话时选择模式' })
      await gate.waitFor()
      assert.equal(await gate.getAttribute('aria-checked'), 'false')
      await gate.click()
      assert.equal(await gate.getAttribute('aria-checked'), 'true')
      await page.evaluate(() => window.__audit.settingsDialog.closeSettings())
      const enter = page
        .getByTestId('chat-header')
        .getByRole('button', { name: '开启新对话', exact: true })
      await enter.click()
      const dialog = page.getByRole('dialog', { name: '选择对话模式', exact: true })
      await dialog.waitFor()
      if (process.env.FREESEEK_TASK_PREVIEWS) {
        await mkdir('tmp/regression/task', { recursive: true })
        await page.screenshot({
          path: 'tmp/regression/task/mode-' + page.viewportSize().width + '.png',
        })
      }
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(
        await page.evaluate(() => window.__audit.store.useChatStore.getState().activeId),
        'mode-existing'
      )
      await enter.click()
      await dialog.getByRole('button', { name: /^Agent 模式/ }).click()
      await page.getByRole('button', { name: /Agent 模式.*通用任务助手/ }).waitFor()
      await page.evaluate(() => window.__audit.store.newChat())
      await dialog.getByRole('button', { name: /^聊天模式/ }).click()
      assert.equal(
        await page.evaluate(() => window.__audit.store.useChatStore.getState().draftMode),
        'chat'
      )
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      assert.equal(
        await page.evaluate(() => window.__audit.settings.useSettings.getState().askChatMode),
        true
      )
    }
  )

  await run(
    'task mode reads the selected Excel, searches and saves both real Office files through one model loop',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        a.settings.setApiKey('task-chat-fixture')
        a.settings.setSearch(true)
        a.settings.saveThirdPartySearch({
          enabled: true,
          keySource: 'separate',
          apiKey: 'task-search-fixture',
        })
        const session = a.fixtures.session({
          id: 'task-session',
          mode: 'agent',
          title: '核对报价',
          messages: [
            a.fixtures.user('task-old-user', '之前的对话', {
              files: [
                {
                  id: 'task-old-file',
                  name: 'old.txt',
                  mimeType: 'text/plain',
                  size: 6,
                  isImage: false,
                  serverId: 'old-secret-file-id',
                },
              ],
            }),
            a.fixtures.assistant('task-old-answer', '历史回答'),
          ],
        })
        await a.seed(
          [session],
          [{ id: 'task-old-file', blob: new Blob(['PRIVATE HISTORICAL FILE']) }]
        )
        const input = a.taskArtifacts.makeTaskFile('xlsx', {
          file_name: '两家报价',
          sheets: [
            {
              name: '报价',
              rows: [
                ['供应商', '报价'],
                ['甲方', 1200],
                ['乙方', 1400],
              ],
            },
          ],
        })
        const requests = []
        const searches = []
        let uploads = 0
        const usage = {
          input_tokens: 19,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 3,
        }
        const tools = (calls) =>
          new Response(
            [
              { type: 'message_start', message: { usage: { ...usage, output_tokens: 0 } } },
              ...calls.flatMap(([name, input], index) => [
                {
                  type: 'content_block_start',
                  index,
                  content_block: {
                    type: 'tool_use',
                    id: 'call-' + requests.length + '-' + index,
                    name,
                    input: {},
                  },
                },
                {
                  type: 'content_block_delta',
                  index,
                  delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
                },
                { type: 'content_block_stop', index },
              ]),
              { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage },
              { type: 'message_stop' },
            ]
              .map((event) => 'data: ' + JSON.stringify(event) + '\n\n')
              .join(''),
            { headers: { 'content-type': 'text/event-stream' } }
          )
        const original = window.fetch
        window.fetch = async (url, init) => {
          const path = new URL(url).pathname
          if (path.endsWith('/v1/tools/search')) {
            searches.push(JSON.parse(init.body))
            return Response.json({
              results: [
                {
                  title: '报价说明',
                  url: 'https://sources.example.test/pricing',
                  summary: '按相同含税口径比较。',
                },
              ],
            })
          }
          if (path.endsWith('/anthropic/v1/files')) {
            uploads++
            return Response.json(
              { error: { message: 'Unexpected fixture upload' } },
              { status: 400 }
            )
          }
          if (path.endsWith('/anthropic/v1/messages')) {
            const body = JSON.parse(init.body)
            requests.push(body)
            if (requests.length === 1) {
              return tools([
                [
                  'update_task_plan',
                  {
                    steps: [
                      { label: '核对报价表和公开资料', status: 'working' },
                      { label: '整理成果', status: 'todo' },
                    ],
                  },
                ],
                ['read_selected_attachment', { file: 1 }],
                ['freeseek_web_search', { query: '含税报价比较', count: 3 }],
              ])
            }
            if (requests.length === 2) {
              return tools([
                [
                  'create_spreadsheet',
                  {
                    file_name: '报价对比',
                    sheets: [
                      {
                        name: '对比',
                        rows: [
                          ['供应商', '报价', '备注'],
                          ['甲方', 1200, '=1+2'],
                          ['乙方', 1400, '含税'],
                        ],
                      },
                    ],
                  },
                ],
                [
                  'create_document',
                  {
                    file_name: '核对说明',
                    title: '报价核对说明',
                    sections: [{ heading: '结论', text: '甲方低 200 元，来源 A&B。' }],
                  },
                ],
              ])
            }
            return a.response('报价表和核对说明已生成。')
          }
          return original(url, init)
        }
        const added = a.drafts.addDraftFiles(
          session.id,
          [new File([input.blob], input.name, { type: input.blob.type })],
          '',
          {
            selection: { providerId: 'deepseek', model: 'deepseek-flash' },
            deferUpload: true,
          }
        )
        a.drafts.setDraftText(session.id, '核对本轮 Excel，查资料，生成 Excel 和 Word。')
        const sent = a.store.sendMessage(session.id)
        await a.waitIdle()
        const saved = await a.db.loadSession(session.id)
        const reply = saved.messages.at(-1)
        const files = reply.task?.artifacts ?? []
        const output = await Promise.all(
          files.map(async (file) => {
            const blob = await a.db.loadFile(file.id)
            return {
              name: file.name,
              text: await a.taskAttachments.taskAttachmentText(
                file,
                blob,
                new AbortController().signal
              ),
            }
          })
        )
        return {
          requests,
          searches,
          uploads,
          sent,
          added,
          output,
          status: reply.status,
          mode: saved.mode,
          used: reply.usage?.standalone_search_requests,
        }
      })
      assert.equal(result.sent, true)
      assert.equal(result.added, null)
      assert.equal(result.uploads, 0)
      assert.equal(result.requests.length, 3)
      const declaration = result.requests[0].tools.map(({ name }) => name)
      assert.deepEqual(declaration, [
        'update_task_plan',
        'calculate',
        'list_task_files',
        'analyze_table',
        'read_selected_attachment',
        'freeseek_web_search',
        'read_web_page',
        'browse_github_repository',
        'browser_open',
        'browser_snapshot',
        'browser_follow_link',
        'browser_scroll',
        'browser_history',
        'run_task_review',
        'inspect_project',
        'import_project',
        'apply_project_patch',
        'run_project_script',
        'export_project',
        'create_3d_model',
        'create_spreadsheet',
        'create_document',
        'create_markdown',
        'create_data_file',
      ])
      assert.equal(result.requests[0].safety_check, undefined)
      assert.equal(result.requests[0].title, undefined)
      assert.doesNotMatch(
        JSON.stringify(result.requests),
        /old-secret-file-id|PRIVATE HISTORICAL FILE/
      )
      assert.match(JSON.stringify(result.requests[1].messages), /供应商|甲方/)
      assert.match(JSON.stringify(result.requests[1].messages), /sources\.example\.test/)
      assert.equal(result.searches.length, 1)
      assert.equal(result.used, 1)
      assert.equal(result.status, 'done')
      assert.equal(result.mode, 'agent')
      assert.deepEqual(
        result.output.map(({ name }) => name),
        ['报价对比.xlsx', '核对说明.docx']
      )
      assert.match(result.output[0].text, /甲方.*1200.*=1\+2/)
      assert.match(result.output[1].text, /甲方低 200 元，来源 A&B。/)
      await page.getByTestId('task-output').first().waitFor()
      if (process.env.FREESEEK_TASK_PREVIEWS) {
        await mkdir('tmp/regression/task', { recursive: true })
        await page.getByTestId('task-output').last().scrollIntoViewIfNeeded()
        await page.screenshot({
          path: 'tmp/regression/task/results-' + page.viewportSize().width + '.png',
        })
      }
      for (const name of ['报价对比.xlsx', '核对说明.docx']) {
        const downloaded = page.waitForEvent('download')
        await page.getByRole('button', { name: '保存 ' + name, exact: true }).click()
        const file = await downloaded
        assert.equal(file.suggestedFilename(), name)
        if (process.env.FREESEEK_TASK_PREVIEWS) {
          await file.saveAs('tmp/regression/task/' + name)
        }
      }
      const restored = await page.evaluate(async () => {
        const a = window.__audit
        const { blob } = await a.backup.exportHistory()
        await a.backup.importHistory(new File([blob], 'task-roundtrip.zip'))
        const session = await a.db.loadSession('task-session')
        const files = session.messages.at(-1).task.artifacts
        return {
          mode: session.mode,
          artifactTypes: await Promise.all(
            files.map(async (file) => (await a.db.loadFile(file.id)).type)
          ),
        }
      })
      assert.equal(restored.mode, 'agent')
      assert.deepEqual(restored.artifactTypes, [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ])
    }
  )

  await run(
    'task mode reads an exact GitHub link without search and reuses its Markdown result',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        a.settings.setApiKey('direct-link-fixture')
        a.settings.setSearch(false)
        const session = a.fixtures.session({ id: 'task-link', mode: 'agent', title: '阅读仓库' })
        await a.seed([session])

        const link = 'https://github.com/sample-org/example'
        const requests = []
        const webRequests = []
        const usage = { input_tokens: 20, output_tokens: 3 }
        const rounds = [
          [
            ['read_web_page', { url: link, find: 'README' }],
            ['read_web_page', { url: 'https://unlisted.example.org/data' }],
          ],
          [
            [
              'browse_github_repository',
              { repository_url: link, action: 'directory', path: 'src' },
            ],
            [
              'browse_github_repository',
              { repository_url: link, action: 'file', path: 'src/index.ts' },
            ],
          ],
          [
            [
              'create_markdown',
              { file_name: '阅读笔记', content: '# 核对结果\n确认 alpha 逻辑。' },
            ],
          ],
          undefined,
          [['read_selected_attachment', { file: 1, find: 'alpha' }]],
        ]
        const original = window.fetch
        window.fetch = async (url, init) => {
          const target = new URL(url)
          if (
            target.hostname === 'raw.githubusercontent.com' ||
            target.hostname === 'api.github.com'
          ) {
            const { pathname } = target
            webRequests.push({ host: target.hostname, pathname, credentials: init.credentials })
            if (pathname.endsWith('/commits')) {
              return Response.json([{ sha: '4'.repeat(40) }])
            }
            if (pathname.endsWith('/README.md')) {
              return new Response('# README\n此仓库拥有公开文档。')
            }
            if (pathname.endsWith('/src')) {
              return Response.json([{ type: 'file', path: 'src/index.ts', size: 18 }])
            }
            if (pathname.endsWith('/src/index.ts')) {
              return new Response('export const alpha = 1')
            }
          }
          if (target.pathname.endsWith('/anthropic/v1/messages')) {
            const calls = rounds[requests.length]
            requests.push(JSON.parse(init.body))
            if (!calls) return a.response('核对完毕。')
            const events = [
              { type: 'message_start', message: { usage } },
              ...calls.flatMap(([name, input], index) => [
                {
                  type: 'content_block_start',
                  index,
                  content_block: {
                    type: 'tool_use',
                    id: 'direct-' + requests.length + '-' + index,
                    name,
                    input,
                  },
                },
                { type: 'content_block_stop', index },
              ]),
              { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage },
              { type: 'message_stop' },
            ]
            return new Response(
              events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''),
              {
                headers: { 'content-type': 'text/event-stream' },
              }
            )
          }
          return original(url, init)
        }
        a.drafts.setDraftText(session.id, '打开并整理这个链接 ' + link)
        a.store.sendMessage(session.id)
        await a.waitIdle()
        const first = (await a.db.loadSession(session.id)).messages.at(-1)
        a.drafts.setDraftText(session.id, '在刚生成的文件中定位 alpha。')
        a.store.sendMessage(session.id)
        await a.waitIdle()
        const second = (await a.db.loadSession(session.id)).messages.at(-1)
        const output = first.task.artifacts[0]
        const blob = await a.db.loadFile(output.id)
        const pack = await a.backup.exportHistory()
        await a.backup.importHistory(new File([pack.blob], 'agent-link-roundtrip.zip'))
        const restored = (await a.db.loadSession(session.id)).messages.find(
          (message) => message.id === first.id
        )
        return {
          declarations: requests[0].tools.map(({ name }) => name),
          readme: JSON.stringify(requests[1].messages),
          files: JSON.stringify(requests[2].messages),
          reuse: JSON.stringify(requests[5].messages),
          webRequests,
          text: await blob.text(),
          output: output.name,
          steps: restored.task.steps.map(({ kind, status }) => [kind, status]),
          status: second.status,
        }
      })
      assert.ok(result.declarations.includes('read_web_page'))
      assert.ok(result.declarations.includes('browse_github_repository'))
      assert.ok(!result.declarations.includes('freeseek_web_search'))
      assert.match(result.readme, /此仓库拥有公开文档/)
      assert.match(result.readme, /outside the public web scope/)
      assert.match(result.files, /src\/index\.ts/)
      assert.match(result.files, /export const alpha = 1/)
      assert.match(result.reuse, /确认 alpha 逻辑/)
      assert.deepEqual(
        result.webRequests.map(({ pathname }) => pathname),
        [
          '/repos/sample-org/example/commits',
          '/sample-org/example/' + '4'.repeat(40) + '/README.md',
          '/repos/sample-org/example/contents/src',
          '/sample-org/example/' + '4'.repeat(40) + '/src/index.ts',
        ]
      )
      assert.ok(result.webRequests.every(({ credentials }) => credentials === 'omit'))
      assert.equal(result.output, '阅读笔记.md')
      assert.match(result.text, /# 核对结果/)
      assert.deepEqual(result.steps, [
        ['github', 'done'],
        ['github', 'done'],
        ['github', 'done'],
        ['md', 'done'],
      ])
      assert.equal(result.status, 'done')
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      await page.evaluate(() => window.__audit.store.selectSession('task-link'))
      await page.getByTestId('session-artifacts-button').click()
      await page.getByRole('button', { name: '预览 阅读笔记.md', exact: true }).click()
      const preview = page.getByRole('dialog', { name: '预览 阅读笔记.md' })
      await preview
        .getByTestId('task-document-preview')
        .getByText(/确认 alpha 逻辑/)
        .waitFor()
      const saved = page.waitForEvent('download')
      await preview.getByRole('button', { name: '保存原件', exact: true }).click()
      assert.equal((await saved).suggestedFilename(), '阅读笔记.md')
    }
  )

  await run(
    'task link reader extracts inert page text, shows errors and cancels an active read',
    async (page) => {
      const draft =
        '打开 https://example.org/unindexed 、https://example.org/missing 和 https://example.org/slow'
      await page.evaluate(async (question) => {
        const a = window.__audit
        await a.seed([a.fixtures.session({ id: 'task-web', mode: 'agent', title: '打开网页' })])
        a.settings.setApiKey('direct-web-fixture')
        a.settings.setSearch(false)
        const target = 'https://example.org'
        let request = 0
        window.__webFixture = { calls: [], stopped: false, passed: false }
        window.freeseekPublicWeb = {
          read: async ({ url }) => {
            window.__webFixture.calls.push(url)
            if (url.endsWith('/slow')) return new Promise(() => {})
            if (url.endsWith('/missing')) return { url, status: 404 }
            return {
              url,
              status: 200,
              contentType: 'text/html',
              bytes: new TextEncoder().encode(
                '<title>Example</title><script>HIDDEN_PAYLOAD</script><main><p>UNINDEXED_CONTENT</p>' +
                  '<img src="https://example.org/should-not-load.png"><a href="/missing">missing</a></main>'
              ),
            }
          },
          cancel: async () => {
            window.__webFixture.stopped = true
          },
        }
        const original = window.fetch
        window.fetch = async (url, init) => {
          if (!new URL(url).pathname.endsWith('/anthropic/v1/messages')) return original(url, init)
          request++
          if (request === 2) {
            const body = JSON.stringify(JSON.parse(init.body).messages)
            window.__webFixture.passed =
              body.includes('UNINDEXED_CONTENT') &&
              !body.includes('HIDDEN_PAYLOAD') &&
              body.includes('HTTP 404')
          }
          const inputs =
            request === 1 ? [target + '/unindexed', target + '/missing'] : [target + '/slow']
          const usage = { input_tokens: 4, output_tokens: 2 }
          const events = [
            { type: 'message_start', message: { usage } },
            ...inputs.flatMap((url, index) => [
              {
                type: 'content_block_start',
                index,
                content_block: {
                  type: 'tool_use',
                  id: 'task-web-' + request + '-' + index,
                  name: 'read_web_page',
                  input: { url },
                },
              },
              { type: 'content_block_stop', index },
            ]),
            { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage },
            { type: 'message_stop' },
          ]
          return new Response(
            events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''),
            {
              headers: { 'content-type': 'text/event-stream' },
            }
          )
        }
        a.drafts.setDraftText('task-web', question)
        a.store.sendMessage('task-web')
      }, draft)
      await page.waitForFunction(() => window.__webFixture?.calls.length === 3)
      await page.getByTestId('agent-progress-dock').click()
      await page
        .getByTestId('agent-run-summary')
        .getByText('网页可能已移除，或需要登录后查看。')
        .waitFor()
      await page.getByRole('button', { name: '停止生成', exact: true }).click()
      await page.evaluate(() => window.__audit.waitIdle())
      const result = await page.evaluate(async () => ({
        ...window.__webFixture,
        steps: (await window.__audit.db.loadSession('task-web')).messages.at(-1).task.steps,
      }))
      assert.equal(result.stopped, true)
      assert.equal(result.passed, true)
      assert.deepEqual(
        result.steps.map(({ status }) => status),
        ['done', 'failed', 'stopped']
      )
      assert.equal(result.steps[1].failure, 'http')
    }
  )

  await run(
    'task browser opens general websites, follows links, revisits pages and previews them',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        a.settings.setApiKey('browser-fixture-key')
        a.settings.setSearch(false)
        const id = 'browser-tools'
        const address = 'https://example.org/docs'
        await a.seed([a.fixtures.session({ id, mode: 'agent', title: '浏览文档' })])
        const usage = { input_tokens: 12, output_tokens: 2 }
        const rounds = [
          ['browser_open', { url: address }],
          ['browser_snapshot', {}],
          ['browser_follow_link', { link: 1 }],
          ['browser_snapshot', {}],
          ['browser_history', { action: 'back' }],
          ['browser_snapshot', {}],
          ['browser_history', { action: 'forward' }],
          ['browser_scroll', { direction: 'bottom' }],
        ]
        const calls = []
        window.__readEvidenceCalls = calls
        const requests = []
        const original = fetch
        window.freeseekPublicWeb = {
          read: async ({ url }) => {
            calls.push(url)
            const start = url === address
            const content = start
              ? '<title>示例文档</title><main><h1>产品文档</h1><a href="/guide">安装指南</a>' +
                '<script>DO_NOT_EXECUTE</script></main>'
              : '<title>安装指南</title><main><h1>从零配置</h1><p>' +
                '注册流程文档 '.repeat(3000) +
                ' END_OF_PAGE</p></main>'
            return {
              url,
              status: 200,
              contentType: 'text/html',
              bytes: new TextEncoder().encode(content),
            }
          },
          cancel: async () => {},
        }
        window.fetch = async (url, init) => {
          if (!new URL(url).pathname.endsWith('/anthropic/v1/messages')) {
            return original(url, init)
          }
          const tool = rounds[requests.length]
          requests.push(JSON.parse(init.body))
          if (!tool) return a.response('网页导航核对完成。')
          const [name, input] = tool
          const events = [
            { type: 'message_start', message: { usage } },
            {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'browser-step-' + requests.length,
                name,
                input,
              },
            },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage },
            { type: 'message_stop' },
          ]
          return new Response(
            events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''),
            {
              headers: { 'content-type': 'text/event-stream' },
            }
          )
        }
        a.drafts.setDraftText(id, '打开 ' + address + '，阅读安装指南。')
        a.store.sendMessage(id)
        await a.waitIdle()
        const reply = (await a.db.loadSession(id)).messages.at(-1)
        const lastTool = (request) =>
          request.messages
            .at(-1)
            .content.filter((part) => part.type === 'tool_result')
            .at(-1).content
        return {
          calls,
          outputs: requests.slice(1).map((r) => JSON.stringify(lastTool(r))),
          task: reply.task,
        }
      })
      assert.deepEqual(result.calls, ['https://example.org/docs', 'https://example.org/guide'])
      assert.match(result.outputs[1], /产品文档/)
      assert.match(result.outputs[3], /从零配置/)
      assert.match(result.outputs[5], /产品文档/)
      assert.match(result.outputs[7], /END_OF_PAGE/)
      assert.ok(!result.outputs.join('').includes('DO_NOT_EXECUTE'))
      assert.deepEqual(
        result.task.steps.filter(({ kind }) => kind === 'browser').map(({ source }) => source),
        [
          'https://example.org/docs',
          'https://example.org/docs',
          'https://example.org/guide',
          'https://example.org/guide',
          'https://example.org/docs',
          'https://example.org/docs',
          'https://example.org/guide',
          'https://example.org/guide',
        ]
      )
      await page.getByTestId('agent-progress-dock').click()
      const activity = page.getByTestId('agent-run-summary')
      const read = activity.getByRole('button', { name: '读取记录', exact: true }).first()
      await read.click()
      await activity.getByRole('link', { name: '打开原网页', exact: true }).first().waitFor()
      assert.match(await activity.locator('pre').first().textContent(), /产品文档/)
      assert.deepEqual(await page.evaluate(() => window.__readEvidenceCalls), result.calls)
      if (process.env.FREESEEK_TASK_PREVIEWS) {
        await mkdir('tmp/regression/task', { recursive: true })
        await page.screenshot({
          path: 'tmp/regression/task/browser-' + page.viewportSize().width + '.png',
          animations: 'disabled',
        })
      }
    }
  )

  await run(
    'task data tools calculate, analyze grouped CSV and save literal spreadsheet-safe values',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        a.settings.setApiKey('local-data-fixture')
        const id = 'data-tools'
        await a.seed([a.fixtures.session({ id, mode: 'agent', title: '汇总报价' })])
        const rows = new File(
          [
            '部门,金额,状态\r\n"销售,北区",10,已付\r\n"销售,北区",20,已付\r\n财务,5,已付\r\n财务,80,未付',
          ],
          '数据.csv',
          { type: 'text/csv' }
        )
        a.drafts.addDraftFiles(id, [rows], '', {
          selection: { providerId: 'deepseek', model: 'deepseek-flash' },
          deferUpload: true,
        })
        const usage = { input_tokens: 10, output_tokens: 2 }
        const requests = []
        const original = fetch
        window.fetch = async (url, init) => {
          if (!new URL(url).pathname.endsWith('/anthropic/v1/messages')) return original(url, init)
          requests.push(JSON.parse(init.body))
          const tools =
            requests.length === 1
              ? [
                  ['list_task_files', {}],
                  ['calculate', { calculations: [{ operation: 'percent', values: [5, 25] }] }],
                  [
                    'analyze_table',
                    {
                      file: 1,
                      filter: { column: '状态', equals: '已付' },
                      group_by: '部门',
                      measures: [{ operation: 'count' }, { operation: 'sum', column: '金额' }],
                    },
                  ],
                ]
              : requests.length === 2
                ? [
                    [
                      'create_data_file',
                      {
                        file_name: '已付汇总',
                        format: 'csv',
                        rows: [
                          ['部门', '实付金额', '备注'],
                          ['销售,北区', 30, '=1+2'],
                          ['财务', 5, ''],
                        ],
                      },
                    ],
                    [
                      'create_data_file',
                      {
                        file_name: '统计数据',
                        format: 'json',
                        content: '{"groupedTotal":35,"paid":3}',
                      },
                    ],
                  ]
                : undefined
          if (!tools) return a.response('汇总完成。')
          const events = [
            { type: 'message_start', message: { usage } },
            ...tools.flatMap(([name, input], index) => [
              {
                type: 'content_block_start',
                index,
                content_block: {
                  type: 'tool_use',
                  id: 'data-' + requests.length + '-' + index,
                  name,
                  input,
                },
              },
              { type: 'content_block_stop', index },
            ]),
            { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage },
            { type: 'message_stop' },
          ]
          return new Response(
            events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''),
            {
              headers: { 'content-type': 'text/event-stream' },
            }
          )
        }
        a.drafts.setDraftText(id, '请按部门汇总已付金额并导出 CSV 和 JSON。')
        a.store.sendMessage(id)
        await a.waitIdle()
        const pack = await a.backup.exportHistory()
        await a.backup.importHistory(new File([pack.blob], 'export.zip'))
        const reply = (await a.db.loadSession(id)).messages.at(-1)
        const output = await Promise.all(
          reply.task.artifacts.map(async ({ id, name }) => ({
            name,
            text: await (await a.db.loadFile(id)).text(),
          }))
        )
        return {
          analysis: requests[1].messages
            .at(-1)
            .content.filter((part) => part.type === 'tool_result')
            .map((part) =>
              typeof part.content === 'string'
                ? JSON.parse(part.content)
                : JSON.parse(part.content[0].text)
            ),
          output,
          status: reply.status,
        }
      })
      assert.equal(result.status, 'done')
      assert.equal(result.analysis[0][0].name, '数据.csv')
      assert.equal(result.analysis[1].results[0].result, 20)
      assert.equal(result.analysis[2].matched_rows, 3)
      assert.equal(result.analysis[2].totals[1].value, 35)
      assert.equal(result.analysis[2].groups[0].group, '销售,北区')
      assert.equal(result.analysis[2].groups[0].measures[1].value, 30)
      assert.deepEqual(
        result.output.map(({ name }) => name),
        ['已付汇总.csv', '统计数据.json']
      )
      assert.match(result.output[0].text, /"销售,北区",30,"'=1\+2"/)
      assert.deepEqual(JSON.parse(result.output[1].text), { groupedTotal: 35, paid: 3 })
    }
  )

  await run(
    'task mode asks before the first send and can stop an active search without further requests',
    async (page) => {
      await page.evaluate(() => {
        const a = window.__audit
        a.settings.setAskChatMode(true)
        a.settings.setApiKey('task-chat-fixture')
        a.settings.setSearch(true)
        a.settings.saveThirdPartySearch({
          enabled: true,
          keySource: 'separate',
          apiKey: 'task-search-fixture',
        })
        let rounds = 0
        window.__taskActivity = () => rounds
        const original = window.fetch
        window.fetch = async (url, init) => {
          const path = new URL(url).pathname
          if (path.endsWith('/v1/tools/search')) {
            return new Promise((resolve, reject) => {
              init.signal.addEventListener('abort', () => reject(init.signal.reason), {
                once: true,
              })
            })
          }
          if (path.endsWith('/anthropic/v1/messages')) {
            rounds++
            const usage = {
              input_tokens: 5,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 2,
            }
            return new Response(
              [
                { type: 'message_start', message: { usage } },
                {
                  type: 'content_block_start',
                  index: 0,
                  content_block: {
                    type: 'tool_use',
                    id: 'task-stop-tool',
                    name: 'freeseek_web_search',
                    input: { query: '公开资料', count: 1 },
                  },
                },
                { type: 'content_block_stop', index: 0 },
                { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage },
                { type: 'message_stop' },
              ]
                .map((event) => 'data: ' + JSON.stringify(event) + '\n\n')
                .join(''),
              { headers: { 'content-type': 'text/event-stream' } }
            )
          }
          return original(url, init)
        }
        a.drafts.setDraftText(null, '请查这份资料。')
        a.store.sendMessage(null)
      })
      const dialog = page.getByRole('dialog', { name: '选择对话模式' })
      await dialog.waitFor()
      assert.equal(await page.evaluate(() => window.__taskActivity()), 0)
      await dialog.getByRole('button', { name: /^Agent 模式/ }).click()
      await page
        .getByTestId('agent-progress-dock')
        .getByText(/查找公开资料/)
        .waitFor()
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const id = a.store.useChatStore.getState().activeId
        a.store.stopReply(id)
        await a.waitIdle()
        const reply = a.store.useChatStore.getState().sessionCache[id].messages.at(-1)
        return {
          rounds: window.__taskActivity(),
          status: reply.status,
          step: reply.task.steps[0].status,
        }
      })
      assert.deepEqual(result, { rounds: 1, status: 'stopped', step: 'stopped' })
    }
  )

  await run(
    'agent presentation keeps thinking collapsed and opens execution details from the dock',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        const f = a.fixtures
        const now = Date.now()
        await a.seed([
          f.session({
            id: 'agent-visible',
            mode: 'agent',
            agentRunMode: 'goal',
            title: '核对发布说明',
            rootMessageId: 'task',
            messages: [
              f.user('task', '核对更新记录，输出报告。', {
                parentId: null,
                selectedChildId: 'response',
              }),
              f.assistant('response', '已核对更新记录，问题列表待补。', {
                parentId: 'task',
                thinking: true,
                blocks: [
                  {
                    type: 'thinking',
                    thinking: '单独展开这段思考。',
                    startedAt: now - 8000,
                    endedAt: now,
                  },
                  { type: 'text', text: '我先核对更新记录。' },
                  { type: 'text', text: '已核对更新记录，问题列表待补。' },
                ],
                task: {
                  plan: [],
                  artifacts: [],
                  run: {
                    id: 'visiblerun',
                    mode: 'goal',
                    status: 'partial',
                    reason: 'source-failed',
                    revision: 0,
                    criteria: ['核对更新记录', '检查问题列表'],
                    met: [2],
                    budgetMinutes: 15,
                    budgetRequests: 40,
                    segmentRequests: 5,
                    totalRequests: 5,
                    startedAt: now - 130000,
                    elapsedMs: 130000,
                  },
                  steps: [
                    {
                      id: 'read-changes',
                      kind: 'github',
                      status: 'done',
                      file: 'CHANGELOG.md',
                      blockIndex: 2,
                      evidence: [
                        {
                          sourceId: 'changelog',
                          kind: 'github',
                          title: 'CHANGELOG.md',
                          url: 'https://example.org/changes',
                          range: { start: 1, end: 20, unit: 'lines' },
                          partial: true,
                          excerpt: '这是本次读取保存的文字。',
                        },
                      ],
                    },
                    {
                      id: 'read-issues',
                      kind: 'github',
                      file: 'Issues',
                      status: 'failed',
                      failure: 'rate-limit',
                      blockIndex: 2,
                    },
                  ],
                },
              }),
            ],
          }),
        ])
      })
      const reply = page.locator('[data-message-id="response"]')
      const thinking = reply.getByTestId('agent-thinking').getByRole('button')
      await thinking.waitFor()
      assert.equal(await thinking.getAttribute('aria-expanded'), 'false')
      assert.equal(await reply.getByText('单独展开这段思考。', { exact: true }).count(), 0)
      const order = await reply.innerText()
      assert.ok(order.includes('我先核对更新记录。'))
      const tools = reply.getByTestId('agent-inline-tools')
      await tools.getByText('CHANGELOG.md', { exact: false }).waitFor()
      assert.deepEqual(
        await tools
          .locator('[data-status]')
          .evaluateAll((rows) => rows.map((row) => row.dataset.status)),
        ['done', 'failed']
      )
      assert.ok(order.indexOf('我先核对更新记录。') < order.indexOf('CHANGELOG.md'))
      assert.ok(order.indexOf('CHANGELOG.md') < order.indexOf('已核对更新记录，问题列表待补。'))
      const dock = page.getByTestId('agent-progress-dock')
      await dock.getByText('部分完成', { exact: true }).click()
      const progress = page.getByTestId('agent-run-summary')
      await progress.getByRole('button', { name: '继续未完成项', exact: true }).waitFor()
      const criteria = progress.locator('ol').first().getByRole('listitem')
      assert.deepEqual(
        await criteria.evaluateAll((rows) => rows.map((row) => row.dataset.status)),
        ['todo', 'done']
      )
      await progress.getByRole('button', { name: '读取记录', exact: true }).click()
      await progress.getByText('第 1–20 行', { exact: false }).waitFor()
      await progress.getByText('这是本次读取保存的文字。', { exact: true }).waitFor()
      await page.keyboard.press('Escape')
      await progress.waitFor({ state: 'hidden' })
      await thinking.click()
      await reply.getByText('单独展开这段思考。', { exact: true }).waitFor()
      await thinking.click()
      const choose = page.getByTestId('agent-run-mode')
      await choose.click()
      await page
        .getByRole('dialog', { name: 'Agent 执行方式' })
        .getByRole('button', { name: '计划', exact: true })
        .click()
      assert.equal(
        await page.evaluate(
          () =>
            window.__audit.store.useChatStore.getState().sessionCache['agent-visible'].agentRunMode
        ),
        'plan'
      )
      await page.evaluate(() => window.__audit.settings.setThemePreference('dark'))
      await page.locator('[data-ds-dark-theme]').waitFor({ state: 'attached' })
      if (process.env.FREESEEK_TASK_PREVIEWS) {
        await mkdir('tmp/regression/task', { recursive: true })
        await page.screenshot({
          path: 'tmp/regression/task/workflow-' + page.viewportSize().width + '.png',
          animations: 'disabled',
        })
      }
    }
  )
}
