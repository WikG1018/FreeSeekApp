import assert from 'node:assert/strict'

const PRO_EXTENSION_REJECTION =
  'The server-side tool calls (deepseek_web_search, deepseek_read_url) and the title generation feature are unavailable for model deepseek-v4-pro. Please use deepseek-flash instead. (request_id: test-pro-extensions)'
const PRO_REMINDER_REJECTION =
  'The latest_reminder message is unavailable for model deepseek-v4-pro. Please use deepseek-flash instead. (request_id: test-pro-reminder)'

export const runProviderCases = async ({ run }) => {
  await run(
    'continued custom chats send text and available files when old originals are missing',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const file = (id, name) => ({
          id,
          name,
          size: 22,
          mimeType: 'text/plain',
          isImage: false,
          serverId: null,
        })
        const missing = file('missing-old', 'old-file.txt')
        const available = file('available-old', 'available.txt')
        a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: '历史附件验收',
            url: 'https://history-fixture.invalid/v1',
            apiKey: 'history-test-key',
            model: 'test-model',
          },
          true
        )
        const parent = a.fixtures.session({
          id: 'old-source',
          messages: [
            a.fixtures.user('previous-1', '旧对话的第一条文字', { files: [missing, available] }),
            a.fixtures.assistant('previous-reply-1', '上一轮的回答'),
            a.fixtures.user('previous-2', '', { files: [missing] }),
            a.fixtures.assistant('previous-reply-2', '之前整理的文字结果'),
          ],
        })
        await a.seed([parent], [{ id: available.id, blob: new Blob(['可用附件的正文']) }])
        const requests = []
        const originalFetch = window.fetch
        window.fetch = async (url, init) => {
          if (new URL(url).hostname !== 'history-fixture.invalid') return originalFetch(url, init)
          requests.push(JSON.parse(init.body).messages)
          return new Response(
            'data: {"choices":[{"delta":{"content":"可继续聊天"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } }
          )
        }
        a.store.startInheritSession(parent.id)
        a.drafts.setDraftText(null, '继续说。')
        a.store.sendMessage(null)
        await a.waitIdle()
        const state = a.store.useChatStore.getState()
        const branched = state.sessionCache[state.activeId]
        const fromDisk = await a.db.loadSession(parent.id)
        let currentError
        try {
          await a.providerContent.prepareProviderMessages(
            { vision: false, pdf: false },
            {
              history: [],
              question: a.fixtures.user('fresh-file', '读这个文件', { files: [missing] }),
            },
            new AbortController().signal
          )
        } catch (error) {
          currentError = error.localMessage?.key
        }
        return {
          requests,
          reply: branched.messages.at(-1).status,
          inherited: branched.inherited.messages[0].files.length,
          originalFiles: fromDisk.messages[0].files.length,
          currentError,
        }
      })
      assert.equal(result.reply, 'done')
      assert.equal(result.requests.length, 1)
      const request = JSON.stringify(result.requests[0])
      assert.match(request, /旧对话的第一条文字/)
      assert.match(request, /可用附件的正文/)
      assert.match(request, /Earlier attachment unavailable on this device/)
      assert.match(request, /之前整理的文字结果/)
      assert.match(request, /继续说。/)
      assert.doesNotMatch(request, /old-file\.txt/)
      assert.equal(result.inherited, 2)
      assert.equal(result.originalFiles, 2)
      assert.equal(result.currentError, 'providerCurrentOriginalMissing')
    }
  )

  await run(
    'server model aliases and continuation usage retain their respective pricing',
    async (page) => {
      const result = await page.evaluate(() => {
        const a = window.__audit,
          usage = {
            input_tokens: 1000000,
            output_tokens: 1000000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          at = Date.UTC(2026, 10, 17, 12)
        const message = a.fixtures.assistant('alias', 'reply', {
          model: 'deepseek-v4-pro',
          responseModel: 'deepseek-flash',
          usage,
          createdAt: at,
        })
        const first = a.usage.computeReplyUsage(message).costCny
        const continued = a.usage.computeReplyUsage({
          ...message,
          usageHistory: [
            { createdAt: at, usage, model: 'deepseek-v4-pro' },
            { createdAt: at, usage, model: 'deepseek-flash' },
          ],
        }).costCny
        return { first, continued }
      })
      assert.deepEqual(result, { first: 5, continued: 23 })
    }
  )
  await run(
    'OpenCode Go legacy settings discover and chat through the subscription API',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const calls = []
        const original = window.fetch
        const signal = new AbortController().signal
        const profile = a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            url: 'opencode.ai/zen/go/v1/',
            apiKey: 'go-test-key',
            model: 'kimi-k3',
            preset: { id: 'opencode-go', access: 'tokenPlan' },
          },
          true
        )
        let status = 200
        window.fetch = async (url, init) => {
          if (new URL(url).hostname !== 'opencode.ai') return original(url, init)
          calls.push({
            url: String(url),
            method: init.method,
            headers: init.headers,
            body: init.body && JSON.parse(init.body),
          })
          if (status !== 200) return new Response('{}', { status })
          if (init.method === 'GET') {
            return Response.json({ data: [{ id: 'kimi-k3', limit: { context: 1000000 } }] })
          }
          return new Response(
            'data: {"choices":[{"delta":{"content":"Go 回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            {
              headers: { 'Content-Type': 'text/event-stream' },
            }
          )
        }
        const catalog = await a.providerClient.fetchProviderCatalog(profile, signal)
        const test = await a.providerClient.testProviderModel(profile, signal)
        const send = async (id, question) => {
          a.drafts.setDraftText(id, question)
          a.store.sendMessage(id)
          await a.waitIdle()
          const state = a.store.useChatStore.getState()
          const session = state.sessionCache[state.activeId]
          const reply = session.messages.at(-1)
          if (reply.status !== 'done' || a.reply.getReplyText(reply) !== 'Go 回复')
            throw Error(reply.status)
          return session.id
        }
        const chat = await send(null, 'First turn')
        await send(chat, 'Follow-up')
        await send(null, 'Separate conversation')
        await a.providerClient.testProviderModel(
          { ...profile, url: 'https://opencode.ai/zen/v1' },
          signal
        )
        status = 403
        let errorKey
        try {
          await a.providerClient.testProviderModel(profile, signal)
        } catch (error) {
          errorKey = error.localMessage?.key
        }
        return { catalog, test: test.text, calls, errorKey, preset: profile.preset }
      })
      assert.deepEqual(result.catalog, [{ id: 'kimi-k3', contextWindow: 1000000 }])
      assert.equal(result.test, 'Go 回复')
      assert.equal(result.errorKey, 'providerOpenCodeGoForbidden')
      assert.deepEqual(result.preset, { id: 'opencode', access: 'go' })
      const [list, test, first, next, other, zen, denied] = result.calls
      assert.equal(list.url, 'https://opencode.ai/inference/go/v1/models')
      for (const call of [test, first, next, other, denied]) {
        assert.equal(call.url, 'https://opencode.ai/inference/go/openai/v1/chat/completions')
        assert.equal(call.headers.authorization, 'Bearer go-test-key')
        assert.match(call.headers['user-agent'], /^FreeSeek(?:\/|$)/)
        assert.match(call.headers['x-opencode-session'], /^ses_[a-z\d-]+$/)
        assert.equal(call.body.model, 'kimi-k3')
      }
      assert.equal(first.headers['x-opencode-session'], next.headers['x-opencode-session'])
      assert.notEqual(first.headers['x-opencode-session'], other.headers['x-opencode-session'])
      assert.equal(zen.url, 'https://opencode.ai/zen/v1/chat/completions')
      assert.equal(zen.headers['x-opencode-session'], undefined)
    }
  )
  await run('OpenCode uses one access page and saves Go and Zen independently', async (page) => {
    await page.evaluate(() => window.__audit.settingsDialog.openSettings('account'))
    await page.getByRole('button', { name: '高级自定义配置', exact: true }).click()
    const add = async (query, access, url, keyLabel, key) => {
      await page.getByRole('button', { name: '添加连接', exact: true }).click()
      await page.getByRole('searchbox', { name: '搜索服务商', exact: true }).fill(query)
      await page.getByRole('button', { name: 'OpenCode', exact: true }).click()
      const choices = page.getByRole('radiogroup', { name: '选择接入方式' })
      await choices.waitFor()
      assert.equal(await choices.getByRole('radio').count(), 2)
      await choices.getByRole('radio', { name: new RegExp(access) }).check()
      await page.getByRole('button', { name: '继续', exact: true }).click()
      assert.equal(await page.getByLabel('服务地址', { exact: true }).inputValue(), url)
      const input = page.getByLabel(keyLabel, { exact: true })
      assert.equal(await input.inputValue(), '')
      await input.fill(key)
      await page.getByRole('button', { name: '保存并管理模型', exact: true }).click()
      await page.locator('[data-settings-page="providerModels"]').waitFor()
      await page.getByRole('button', { name: '返回', exact: true }).click()
    }
    await add(
      'OpenCode Zen',
      'Zen 按量 API',
      'https://opencode.ai/inference/openai/v1',
      'API 密钥',
      'test-zen-key'
    )
    await add(
      'OpenCode Go',
      'Go 订阅',
      'https://opencode.ai/inference/go/openai/v1',
      'OpenCode Go 密钥',
      'test-go-key'
    )
    const profiles = await page.evaluate(
      () => window.__audit.providers.useProviders.getState().profiles
    )
    assert.deepEqual(
      profiles.map(({ name, preset, apiKey }) => ({ name, preset, apiKey })),
      [
        { name: 'OpenCode Zen', preset: { id: 'opencode', access: 'api' }, apiKey: 'test-zen-key' },
        { name: 'OpenCode Go', preset: { id: 'opencode', access: 'go' }, apiKey: 'test-go-key' },
      ]
    )
    assert.equal(profiles[0].modelListUrl, 'https://opencode.ai/inference/v1/models')
  })
  await run(
    'Zhipu Coding Plan has a dedicated endpoint and subscription key field',
    async (page) => {
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('providers'))
      await page.getByRole('button', { name: '添加连接', exact: true }).click()
      await page.getByRole('button', { name: '智谱 GLM', exact: true }).click()
      const choices = page.getByRole('radiogroup', { name: '选择接入方式' })
      await choices.getByRole('radio', { name: /Coding Plan 订阅/ }).check()
      assert.equal(await choices.getByRole('radio', { name: /按量 API/ }).isChecked(), false)
      assert.equal(
        await page.getByRole('link', { name: '官方接入说明' }).getAttribute('href'),
        'https://docs.bigmodel.cn/cn/coding-plan/tool/others'
      )
      await page.getByRole('button', { name: '继续', exact: true }).click()
      assert.equal(
        await page.getByLabel('服务地址', { exact: true }).inputValue(),
        'https://open.bigmodel.cn/api/coding/paas/v4'
      )
      await page.getByLabel('套餐密钥', { exact: true }).fill('coding-plan-test-key')
      await page.getByRole('button', { name: '保存并管理模型', exact: true }).click()
      await page.locator('[data-settings-page="providerModels"]').waitFor()
      const saved = await page.evaluate(
        () => window.__audit.providers.useProviders.getState().profiles[0]
      )
      assert.deepEqual(saved.preset, { id: 'zhipu', access: 'codingPlan' })
      assert.equal(saved.apiKey, 'coding-plan-test-key')
    }
  )
  await run(
    'long press deletes a saved service connection only after confirmation',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        const active = a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: '已保存的 Go 连接',
            url: 'https://example.test/go/v1',
            model: 'test-go',
          },
          true
        )
        a.providers.saveProvider({
          ...a.providers.emptyProfile(),
          name: '另一个已保存连接',
          url: 'https://example.test/zen/v1',
          model: 'test-zen',
        })
        await a.seed([
          a.fixtures.session({
            id: 'provider-history-kept',
            title: '要保留的历史',
            messages: [
              a.fixtures.user('u', '已发送的问题'),
              a.fixtures.assistant('a', '已保存的回答', {
                connection: { providerId: active.id, revision: active.revision },
              }),
            ],
          }),
        ])
        a.settingsDialog.openSettings('providers')
      })
      const saved = page.getByRole('button', { name: '已保存的 Go 连接', exact: true })
      const confirmation = page.getByRole('dialog', { name: '删除配置', exact: true })
      await saved.waitFor()
      assert.equal(await page.getByText('长按已保存的连接可删除。', { exact: true }).count(), 0)
      await saved.click()
      await page.getByRole('heading', { name: '管理模型', exact: true }).waitFor()
      await page.getByRole('button', { name: '返回', exact: true }).click()
      const touch = await page.context().newCDPSession(page)
      await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
      const touchStart = async () => {
        await saved.scrollIntoViewIfNeeded()
        const box = await saved.boundingBox()
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
        return point
      }
      const touchEnd = () =>
        touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      const start = await touchStart()
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: start.x, y: start.y + 28 }],
      })
      await page.waitForTimeout(550)
      await touchEnd()
      assert.equal(await confirmation.count(), 0)

      await touchStart()
      await touchEnd()
      await page.getByRole('heading', { name: '管理模型', exact: true }).waitFor()
      await page.getByRole('button', { name: '返回', exact: true }).click()

      const hold = async () => {
        await touchStart()
        await confirmation
          .getByText('删除「已保存的 Go 连接」这个服务连接？', { exact: true })
          .waitFor()
        await touchEnd()
      }
      await hold()
      await confirmation.getByRole('button', { name: '取消', exact: true }).click()
      await confirmation.waitFor({ state: 'hidden' })
      assert.equal(await saved.count(), 1)
      await hold()
      await confirmation.getByRole('button', { name: '删除', exact: true }).click()
      await saved.waitFor({ state: 'hidden' })
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      const result = await page.evaluate(() => {
        const a = window.__audit
        const { profiles, selection } = a.providers.useProviders.getState()
        return {
          names: profiles.map(({ name }) => name),
          provider: selection.providerId,
          history: a.store.useChatStore
            .getState()
            .sessions.some(({ id }) => id === 'provider-history-kept'),
        }
      })
      assert.deepEqual(result, { names: ['另一个已保存连接'], provider: 'deepseek', history: true })
    }
  )
  await run(
    'output token parameter errors are not mislabeled as a full context window',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const messages = [
          'max_tokens must be less than or equal to 32768',
          'This model maximum context length is 1048576 tokens. You requested 1168000 tokens.',
          'maximum number of output tokens exceeded',
        ]
        const output = []
        for (const message of messages) {
          window.fetch = async () =>
            new Response(JSON.stringify({ error: { message } }), { status: 400 })
          try {
            await a.client.request('https://api.example.test/messages', {})
          } catch (error) {
            output.push({
              key: error.localMessage?.key,
              detail: a.diagnostics.diagnosticError(error),
            })
          }
        }
        return output
      })
      assert.deepEqual(
        result.map((item) => item.key),
        ['replyOutputLimitInvalid', 'replyContextTooLong', 'replyOutputLimitInvalid']
      )
      assert.equal(result[0].detail.reason, 'output-limit')
      assert.equal(result[1].detail.limits.contextLimitTokens, 1048576)
      assert.equal(result[1].detail.limits.requestedTokens, 1168000)
    }
  )
  await run(
    'third-party "user input too long, N tokens exceeds max M tokens" is treated as a context rejection',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        // 第三方网关的真实句式。识别不出来就不会触发压缩与中文提示，
        // 用户只会看到这段英文原文。
        const messages = [
          'user input too long, 159058 tokens exceeds max 32768 tokens (request_id: 7895ec52-4586-4e72-b7c2-84e3e0c4d8fb)',
          'user input too long, 1,590,580 tokens exceeds max 131,072 tokens',
          'you requested 500000 tokens, but the max is 128000',
        ]
        const output = []
        for (const message of messages) {
          window.fetch = async () =>
            new Response(JSON.stringify({ error: { message } }), { status: 400 })
          try {
            await a.client.request('https://api.example.test/messages', {})
          } catch (error) {
            output.push({
              key: error.localMessage?.key,
              detail: a.diagnostics.diagnosticError(error),
            })
          }
        }
        return output
      })
      assert.deepEqual(
        result.map((item) => item.key),
        ['replyContextTooLong', 'replyContextTooLong', 'replyContextTooLong']
      )
      assert.deepEqual(result[0].detail.limits, {
        contextLimitTokens: 32768,
        requestedTokens: 159058,
      })
      assert.deepEqual(result[1].detail.limits, {
        contextLimitTokens: 131072,
        requestedTokens: 1590580,
      })
      assert.deepEqual(result[2].detail.limits, {
        contextLimitTokens: 128000,
        requestedTokens: 500000,
      })
    }
  )
  await run(
    'official Pro sends a plain first turn with search off and no Flash extensions',
    async (page) => {
      const result = await page.evaluate(async (rejection) => {
        const a = window.__audit,
          original = window.fetch,
          calls = []
        a.settings.setApiKey('official-test-key')
        a.settings.setSearch(true)
        a.providers.selectModel({ providerId: 'deepseek', model: 'deepseek-v4-pro' })
        window.fetch = async (url, options) => {
          if (String(url).endsWith('/messages')) {
            const body = JSON.parse(options.body)
            calls.push(body)
            if (
              'tools' in body ||
              'title' in body ||
              body.messages.some((message) => message.role === 'latest_reminder')
            ) {
              return Response.json({ error: { message: rejection } }, { status: 400 })
            }
            return a.response('Pro reply')
          }
          return original(url, options)
        }
        a.drafts.setDraftText(null, '你好')
        a.store.sendMessage(null)
        await a.waitIdle()
        const session =
          a.store.useChatStore.getState().sessionCache[a.store.useChatStore.getState().activeId]
        const usage = {
          input_tokens: 1000000,
          output_tokens: 1000000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }
        const pro = a.usage.computeReplyUsage(
          a.fixtures.assistant('pro', '', {
            model: 'deepseek-v4-pro',
            createdAt: Date.UTC(2026, 10, 17, 12),
            usage,
          })
        )
        const rejected = a.drafts.addDraftFiles(
          null,
          [new File(['image'], 'x.png', { type: 'image/png' })],
          'key'
        )
        return {
          model: calls[0].model,
          saved: session.messages.at(-1).model,
          status: session.messages.at(-1).status,
          title: session.title,
          search: session.messages.at(-1).search,
          requests: calls.length,
          pro: pro.costCny,
          rejected: rejected.key,
        }
      }, PRO_REMINDER_REJECTION)
      assert.deepEqual(result, {
        model: 'deepseek-v4-pro',
        saved: 'deepseek-v4-pro',
        status: 'done',
        title: '你好',
        search: false,
        requests: 1,
        pro: 18,
        rejected: 'providerProNoImages',
      })
      const search = page.getByRole('button', { name: '智能搜索', exact: true })
      assert.equal(await search.getAttribute('aria-disabled'), 'true')
      assert.equal(await search.getAttribute('aria-pressed'), 'false')
      await page.evaluate(() =>
        window.__audit.providers.selectModel({ providerId: 'deepseek', model: 'deepseek-flash' })
      )
      assert.equal(await search.getAttribute('aria-disabled'), 'false')
      assert.equal(await search.getAttribute('aria-pressed'), 'true')
    }
  )
  await run(
    'saved V4 Pro tool errors get a Chinese notice and retry preserves the original Flash history',
    async (page) => {
      const id = await page.evaluate(async (rejection) => {
        const a = window.__audit
        const link = 'https://example.test/story'
        const session = a.fixtures.session({
          title: '原来的聊天',
          messages: [
            a.fixtures.user('flash-question', '请读这篇文章 ' + link),
            a.fixtures.assistant('flash-reply', '文章的主要内容', {
              latestReminder: '2026-11-19,星期四,上海,Web,中文',
              blocks: [
                {
                  type: 'server_tool_use',
                  id: 'link-call',
                  name: 'deepseek_read_url',
                  kind: 'read_link',
                  input: { action: 'read_link', url: link },
                },
                {
                  type: 'web_fetch_tool_result',
                  tool_use_id: 'link-call',
                  kind: 'read_link',
                  signature: 'read-link-signature',
                  content: {
                    type: 'web_fetch_result',
                    url: link,
                    published_at: null,
                    content: {
                      type: 'document',
                      title: '文章',
                      source: { type: 'text', media_type: 'text/plain', data: '' },
                    },
                  },
                },
                { type: 'text', text: '文章的主要内容' },
              ],
            }),
            a.fixtures.user('retry-question', '继续'),
            a.fixtures.assistant('pro-error', '', {
              model: 'deepseek-v4-pro',
              search: true,
              status: 'error',
              blocks: [],
              error: { kind: 'http', status: 400, message: rejection },
            }),
          ],
        })
        await a.seed([session])
        a.settings.setApiKey('official-test-key')
        a.settings.setSearch(true)
        a.settings.saveThirdPartySearch({
          enabled: true,
          keySource: 'separate',
          apiKey: 'independent-test-key',
        })
        a.settings.setThirdPartySearchOn(true)
        a.providers.selectModel({ providerId: 'deepseek', model: 'deepseek-v4-pro' })
        window.__proRequests = []
        window.__proStandaloneAttempts = 0
        const original = window.fetch
        window.fetch = async (url, init) => {
          if (String(url).endsWith('/v1/tools/search')) {
            window.__proStandaloneAttempts++
            return Response.json({ results: [] })
          }
          if (!String(url).endsWith('/messages')) return original(url, init)
          const body = JSON.parse(init.body)
          window.__proRequests.push({ body, key: new Headers(init.headers).get('x-api-key') })
          if (
            body.model === 'deepseek-v4-pro' &&
            ('tools' in body ||
              'title' in body ||
              body.messages.some((message) => message.role === 'latest_reminder') ||
              JSON.stringify(body.messages).includes('read-link-signature'))
          ) {
            return Response.json({ error: { message: rejection } }, { status: 400 })
          }
          if (
            body.model === 'deepseek-flash' &&
            body.tools?.some((tool) => tool.type === 'deepseek_web_search')
          ) {
            return a.response('Flash 使用官方搜索回答', {
              input_tokens: 12,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 4,
              server_tool_use: { web_search_requests: 2, tool_search: 2 },
            })
          }
          return a.response('可以继续聊了')
        }
        return session.id
      }, PRO_EXTENSION_REJECTION)
      await page.getByText(/^DeepSeek V4 Pro 当前接口不支持/).waitFor()
      await page.evaluate(async (id) => {
        const a = window.__audit
        a.store.regenerateReply(id, 'pro-error')
        await a.waitIdle()
      }, id)
      await page.getByText('可以继续聊了', { exact: true }).waitFor()
      const result = await page.evaluate(async (id) => {
        const a = window.__audit
        const session = a.store.useChatStore.getState().sessionCache[id]
        a.settings.setProSearchOn(true)
        a.providers.selectModel({ providerId: 'deepseek', model: 'deepseek-flash' })
        a.drafts.setDraftText(null, 'Flash 新对话')
        a.store.sendMessage(null)
        await a.waitIdle()
        const state = a.store.useChatStore.getState()
        const flashReply = state.sessionCache[state.activeId].messages.at(-1)
        a.settings.setSearch(false)
        a.store.newChat()
        a.drafts.setDraftText(null, 'Flash 关闭智能搜索')
        a.store.sendMessage(null)
        await a.waitIdle()
        return {
          requests: window.__proRequests,
          flashUsage: flashReply.usage,
          original: session.messages.find((m) => m.id === 'flash-reply').blocks,
          title: session.title,
          standaloneAttempts: window.__proStandaloneAttempts,
        }
      }, id)
      assert.equal(result.title, '原来的聊天')
      assert.equal(result.standaloneAttempts, 0)
      assert.equal(result.original[1].signature, 'read-link-signature')
      assert.equal(result.requests.length, 3)
      const [retry, flash, flashSearchOff] = result.requests.map(({ body }) => body)
      assert.equal(retry.model, 'deepseek-v4-pro')
      assert.ok(JSON.stringify(retry.messages).includes('文章的主要内容'))
      assert.equal('tools' in retry || 'title' in retry, false)
      assert.equal(flash.model, 'deepseek-flash')
      assert.deepEqual(flash.tools, [
        { type: 'deepseek_read_url', name: 'deepseek_read_url' },
        { type: 'deepseek_web_search', name: 'deepseek_web_search' },
      ])
      assert.equal(flash.tool_choice, undefined)
      assert.equal(result.requests[1].key, 'official-test-key')
      assert.equal(result.requests[2].key, 'official-test-key')
      assert.deepEqual(result.flashUsage.server_tool_use, {
        web_search_requests: 2,
        tool_search: 2,
      })
      assert.equal(result.flashUsage.standalone_search_requests, undefined)
      assert.equal(flashSearchOff.model, 'deepseek-flash')
      assert.deepEqual(flashSearchOff.tools, [
        { type: 'deepseek_read_url', name: 'deepseek_read_url' },
      ])
      assert.deepEqual(flash.title, { enabled: true })
      assert.ok(flash.messages.some((message) => message.role === 'latest_reminder'))
    }
  )
  await run(
    'V4 Pro can answer directly and stops standalone search after three requests',
    async (page) => {
      await page.evaluate((reminderError) => {
        const a = window.__audit
        const usage = {
          input_tokens: 17,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 5,
          output_tokens: 3,
        }
        a.settings.setApiKey('pro-chat-key')
        a.settings.saveThirdPartySearch({
          enabled: true,
          keySource: 'separate',
          apiKey: 'shared-search-key',
        })
        a.settings.setThirdPartySearchOn(true)
        a.providers.selectModel({ providerId: 'deepseek', model: 'deepseek-v4-pro' })
        window.__searchRound = []
        const original = window.fetch
        window.fetch = async (url, init) => {
          const path = new URL(url).pathname
          if (path.endsWith('/v1/tools/search')) {
            const body = JSON.parse(init.body)
            window.__searchRound.push({
              path,
              key: new Headers(init.headers).get('Authorization'),
              body,
            })
            const shared = {
              title: '独立搜索结果',
              url: 'https://example.test/search',
              summary: '联网参考内容',
            }
            return Response.json({
              results:
                body.query === 'DeepSeek 官方说明'
                  ? [
                      { ...shared, url: shared.url + '#intro' },
                      {
                        title: '官方说明',
                        url: 'https://example.test/details',
                        summary: '新的参考内容',
                      },
                    ]
                  : [shared],
            })
          }
          if (path.endsWith('/messages')) {
            const body = JSON.parse(init.body)
            window.__searchRound.push({
              path,
              key: new Headers(init.headers).get('x-api-key'),
              body,
            })
            if (body.messages.some((message) => message.role === 'latest_reminder')) {
              return Response.json({ error: { message: reminderError } }, { status: 400 })
            }
            if (body.messages.at(-1).content === '你好') {
              return a.response('你好！')
            }
            if (body.tool_choice?.type === 'auto') {
              const round = body.messages.filter((message) => message.role === 'assistant').length
              const queries = ['DeepSeek 更新公告', 'DeepSeek 官方说明', 'DeepSeek 版本说明']
              const events = [
                { type: 'message_start', message: { usage: { ...usage, output_tokens: 0 } } },
                {
                  type: 'content_block_start',
                  index: 0,
                  content_block: { type: 'thinking', thinking: '', signature: '' },
                },
                {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'thinking_delta', thinking: 'Find the official announcement.' },
                },
                {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'signature_delta', signature: 'test-signature-' + round },
                },
                { type: 'content_block_stop', index: 0 },
                {
                  type: 'content_block_start',
                  index: 1,
                  content_block: {
                    type: 'tool_use',
                    id: 'pro-search-call-' + round,
                    name: 'freeseek_web_search',
                    input: {},
                  },
                },
                {
                  type: 'content_block_delta',
                  index: 1,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: JSON.stringify({ query: queries[round], count: 12 }).slice(0, -1),
                  },
                },
                {
                  type: 'content_block_delta',
                  index: 1,
                  delta: { type: 'input_json_delta', partial_json: '}' },
                },
                { type: 'content_block_stop', index: 1 },
                { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage },
                { type: 'message_stop' },
              ]
              return new Response(
                events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''),
                { headers: { 'Content-Type': 'text/event-stream' } }
              )
            }
            return a.response('Pro 搜索回复')
          }
          return original(url, init)
        }
      }, PRO_REMINDER_REJECTION)
      const search = page.getByRole('button', { name: '智能搜索', exact: true })
      assert.equal(await search.getAttribute('aria-pressed'), 'false')
      await search.click()
      assert.equal(await search.getAttribute('aria-pressed'), 'true')
      const result = await page.evaluate(async () => {
        const a = window.__audit
        a.drafts.setDraftText(null, '你好')
        a.store.sendMessage(null)
        await a.waitIdle()
        const directState = a.store.useChatStore.getState()
        const direct = directState.sessionCache[directState.activeId].messages.at(-1)
        a.store.newChat()
        a.drafts.setDraftText(null, '请搜一下')
        a.store.sendMessage(null)
        await a.waitIdle()
        const state = a.store.useChatStore.getState()
        const session = state.sessionCache[state.activeId]
        const reply = session.messages.at(-1)
        return {
          requests: window.__searchRound,
          status: reply.status,
          usage: reply.usage,
          charges: reply.usageHistory.map((entry) => entry.usage),
          direct: { text: a.reply.getReplyText(direct), usage: direct.usage },
          sources: reply.blocks
            .filter((block) => block.type === 'web_search_tool_result')
            .flatMap((block) => block.content.map(({ url }) => url)),
          prompt: session.messages[0].content,
          flashSearch: a.settings.useSettings.getState().search,
        }
      })
      assert.equal(result.requests.length, 8)
      const [direct, select, lookup, supplement, second, verify, third, answer] = result.requests
      assert.match(direct.path, /\/messages$/)
      assert.equal(direct.body.tool_choice.type, 'auto')
      assert.deepEqual(
        select.body.tools.map((tool) => tool.name),
        ['freeseek_web_search']
      )
      assert.equal(select.body.tools[0].type, undefined)
      assert.equal(select.body.messages.at(-1).content, '请搜一下')
      assert.equal(result.direct.text, '你好！')
      assert.equal(result.direct.usage.standalone_search_requests, undefined)
      assert.equal(lookup.path, '/v1/tools/search')
      assert.equal(lookup.key, 'Bearer shared-search-key')
      assert.deepEqual(lookup.body, { query: 'DeepSeek 更新公告', count: 12, need_content: false })
      assert.equal(supplement.body.tool_choice.type, 'auto')
      assert.equal(verify.body.tool_choice.type, 'auto')
      assert.equal(second.body.query, 'DeepSeek 官方说明')
      assert.equal(third.body.query, 'DeepSeek 版本说明')
      assert.equal(answer.key, 'pro-chat-key')
      assert.equal(answer.body.model, 'deepseek-v4-pro')
      assert.equal(answer.body.safety_check.level, 'high')
      assert.equal(answer.body.tool_choice.type, 'none')
      assert.equal('title' in answer.body, false)
      const [question, ...exchanges] = answer.body.messages
      assert.deepEqual(question, { role: 'user', content: '请搜一下' })
      for (let i = 0; i < 3; i++) {
        assert.equal(exchanges[i * 2].content[0].signature, 'test-signature-' + i)
        assert.equal(exchanges[i * 2 + 1].content[0].tool_use_id, 'pro-search-call-' + i)
      }
      assert.match(exchanges[1].content[0].content, /联网参考内容/)
      assert.match(exchanges[3].content[0].content, /新的参考内容/)
      assert.doesNotMatch(exchanges[3].content[0].content, /\/search#intro/)
      assert.match(exchanges[5].content[0].content, /No more web searches/)
      assert.equal(result.status, 'done')
      assert.deepEqual(result.usage, {
        input_tokens: 53,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 15,
        output_tokens: 11,
        standalone_search_requests: 3,
      })
      assert.equal(result.charges.length, 7)
      assert.deepEqual(result.sources, [
        'https://example.test/search',
        'https://example.test/details',
      ])
      assert.equal(result.prompt, '请搜一下')
      assert.equal(result.flashSearch, false)
    }
  )
  await run('retrying a saved Pro error reuses results from all paid searches', async (page) => {
    const id = await page.evaluate(async (message) => {
      const a = window.__audit
      const savedSearch = (label, count) => {
        const id = 'search-saved-' + label
        return [
          {
            type: 'server_tool_use',
            id,
            name: 'deepseek_web_search',
            kind: 'search',
            input: { action: 'search', queries: [label] },
            caller: { type: 'direct' },
          },
          {
            type: 'web_search_tool_result',
            tool_use_id: id,
            kind: 'search',
            content: Array.from({ length: count }, (_, i) => ({
              type: 'web_search_result',
              title: `原网页 ${label} ${i + 1}`,
              url: `https://example.test/${label}/${i + 1}`,
              snippet: `已付费的搜索内容 ${label} ${i + 1}`,
              site_icon: null,
              site_name: null,
              encrypted_content: '',
              page_age: null,
            })),
          },
        ]
      }
      const session = a.fixtures.session({
        title: '',
        messages: [
          a.fixtures.user('old-question', '1'),
          a.fixtures.assistant('old-paid-reply', '', {
            model: 'deepseek-v4-pro',
            status: 'error',
            thinking: true,
            search: true,
            latestReminder: '2026-11-20,星期五,,Web,中文',
            error: { kind: 'http', status: 400, message },
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              standalone_search_requests: 2,
            },
            blocks: [...savedSearch('first', 5), ...savedSearch('second', 1)],
          }),
        ],
      })
      await a.seed([session])
      localStorage.setItem('freeseek:active-session', session.id)
      a.settings.setApiKey('pro-test-key')
      a.settings.saveThirdPartySearch({ enabled: true, keySource: 'official', apiKey: '' })
      a.settings.setProSearchOn(true)
      a.providers.selectModel({ providerId: 'deepseek', model: 'deepseek-v4-pro' })
      return session.id
    }, PRO_REMINDER_REJECTION)
    await page.reload()
    await page.getByText(/^这条消息附带了 V4 Pro 不支持的对话提醒/).waitFor()
    await page.evaluate((message) => {
      const a = window.__audit
      window.__retryLookups = 0
      window.__retryRequests = []
      const original = window.fetch
      window.fetch = async (url, init) => {
        if (String(url).endsWith('/v1/tools/search')) {
          window.__retryLookups++
          return Response.json({ results: [] })
        }
        if (!String(url).endsWith('/messages')) return original(url, init)
        const body = JSON.parse(init.body)
        window.__retryRequests.push(body)
        if (
          body.messages.some((m) => m.role === 'latest_reminder') ||
          'tools' in body ||
          'title' in body
        ) {
          return Response.json({ error: { message } }, { status: 400 })
        }
        return a.response('沿用原来的搜索结果继续作答')
      }
    }, PRO_REMINDER_REJECTION)
    await page.getByRole('button', { name: '重新生成', exact: true }).click()
    await page.getByText('沿用原来的搜索结果继续作答', { exact: true }).waitFor()
    const result = await page.evaluate(async (id) => {
      const a = window.__audit
      await a.waitIdle()
      const session = a.store.useChatStore.getState().sessionCache[id]
      const oldReply = session.messages.find((m) => m.id === 'old-paid-reply')
      const newReply = session.messages.at(-1)
      return {
        requests: window.__retryRequests,
        lookups: window.__retryLookups,
        oldCharge: oldReply.usage.standalone_search_requests,
        oldStatus: oldReply.status,
        newCharge: newReply.usage?.standalone_search_requests ?? 0,
        newSources: newReply.blocks
          .filter((b) => b.type === 'web_search_tool_result')
          .map((b) => b.content.length),
        title: session.title,
      }
    }, id)
    assert.equal(result.lookups, 0)
    assert.equal(result.requests.length, 1)
    assert.equal(result.requests[0].model, 'deepseek-v4-pro')
    const prompt = JSON.stringify(result.requests[0].messages)
    assert.match(prompt, /已付费的搜索内容 first 5/)
    assert.match(prompt, /已付费的搜索内容 second 1/)
    assert.equal(result.oldCharge, 2)
    assert.equal(result.oldStatus, 'error')
    assert.equal(result.newCharge, 0)
    assert.deepEqual(result.newSources, [5, 1])
    assert.equal(result.title, '1')
  })
  await run(
    'the official wire boundary strips Flash metadata from a prebuilt Pro request',
    async (page) => {
      const requests = await page.evaluate(async () => {
        const a = window.__audit
        const requests = []
        const original = window.fetch
        window.fetch = async (url, init) => {
          if (!String(url).endsWith('/messages')) return original(url, init)
          requests.push(JSON.parse(init.body))
          return a.response('OK')
        }
        const body = {
          system: '原人设',
          thinking: { type: 'enabled' },
          output_config: { effort: 'high' },
          safety_check: { level: 'high' },
          title: { enabled: true },
          tools: [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }],
          messages: [
            { role: 'user', content: '上个问题' },
            {
              role: 'assistant',
              content: [
                { type: 'text', text: '原回答' },
                { type: 'server_tool_use', id: 'flash-call', name: 'deepseek_read_url' },
              ],
            },
            { role: 'latest_reminder', content: '2026-11-20,星期五,,Web,中文' },
            { role: 'user', content: '接着聊' },
          ],
        }
        for (const model of ['deepseek-v4-pro', 'deepseek-v4-flash']) {
          for await (const _event of a.client.streamMessage(
            'test-key',
            { ...body, model },
            new AbortController().signal
          )) {
          }
        }
        return requests
      })
      const [pro, flash] = requests
      assert.deepEqual(
        pro.messages.map((m) => m.role),
        ['user', 'assistant', 'user']
      )
      assert.deepEqual(pro.messages[1].content, [{ type: 'text', text: '原回答' }])
      assert.equal('tools' in pro || 'title' in pro, false)
      assert.deepEqual(pro.safety_check, { level: 'high' })
      assert.deepEqual(pro.output_config, { effort: 'high' })
      assert.equal(pro.system, '原人设')
      assert.equal(flash.messages[2].role, 'latest_reminder')
      assert.equal(flash.messages[1].content[1].id, 'flash-call')
      assert.equal(flash.tools.length, 1)
      assert.deepEqual(flash.title, { enabled: true })
    }
  )
  for (const protocol of ['openai', 'responses', 'anthropic', 'gemini']) {
    await run(
      `${protocol} provider streams Unicode, maps usage and sends only to the configured endpoint`,
      async (page) => {
        const result = await page.evaluate(async (protocol) => {
          const a = window.__audit,
            calls = [],
            original = window.fetch
          const profile = a.providers.saveProvider(
            {
              ...a.providers.emptyProfile(),
              name: 'Mock service',
              protocol,
              url: 'https://custom.example.test/v1',
              apiKey: 'sk-CUSTOM_PRIVATE_CANARY_123',
              model: 'model-any',
              models: ['model-any'],
            },
            true
          )
          const payloads = {
            openai: [
              { choices: [{ delta: { reasoning_content: '思考' } }] },
              { choices: [{ delta: { content: '你好 🌏' } }] },
              {
                choices: [{ delta: {}, finish_reason: 'stop' }],
                usage: {
                  prompt_tokens: 100,
                  prompt_tokens_details: { cached_tokens: 20 },
                  completion_tokens: 5,
                },
              },
            ],
            responses: [
              { type: 'response.reasoning_summary_text.delta', delta: '思考' },
              { type: 'response.output_text.delta', delta: '你好 🌏' },
              {
                type: 'response.completed',
                response: {
                  status: 'completed',
                  usage: {
                    input_tokens: 100,
                    input_tokens_details: { cached_tokens: 20 },
                    output_tokens: 5,
                  },
                },
              },
            ],
            anthropic: [
              {
                type: 'message_start',
                message: {
                  usage: {
                    input_tokens: 80,
                    cache_read_input_tokens: 20,
                    cache_creation_input_tokens: 0,
                    output_tokens: 0,
                  },
                },
              },
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: '你好 🌏' },
              },
              {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 5 },
              },
              { type: 'message_stop' },
            ],
            gemini: [
              {
                candidates: [{ content: { parts: [{ text: '你好 🌏' }] }, finishReason: 'STOP' }],
                usageMetadata: {
                  promptTokenCount: 100,
                  cachedContentTokenCount: 20,
                  candidatesTokenCount: 5,
                },
              },
            ],
          }
          window.fetch = async (url, init) => {
            if (!String(url).includes('custom.example.test')) return original(url, init)
            calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) })
            const bytes = new TextEncoder().encode(
              payloads[protocol].map((data) => `data: ${JSON.stringify(data)}\n\n`).join('') +
                (protocol === 'openai' ? 'data: [DONE]\n\n' : '')
            )
            let offset = 0
            return new Response(
              new ReadableStream({
                pull(controller) {
                  if (offset >= bytes.length) return controller.close()
                  controller.enqueue(bytes.slice(offset, (offset += 7)))
                },
              }),
              { headers: { 'Content-Type': 'text/event-stream' } }
            )
          }
          a.drafts.setDraftText(null, 'hello')
          a.store.sendMessage(null)
          await a.waitIdle()
          const state = a.store.useChatStore.getState(),
            reply = state.sessionCache[state.activeId].messages.at(-1)
          const cost = a.usage.computeReplyUsage(reply),
            stats = await a.usage.collectUsage()
          return {
            status: reply.status,
            text: a.reply.getReplyText(reply),
            usage: reply.usage,
            provider: reply.connection.providerId === profile.id,
            calls,
            tokens: cost.tokens,
            priced: a.usage.hasKnownPricing(reply),
            unknown: stats.total.unpricedRequests,
          }
        }, protocol)
        assert.equal(result.status, 'done')
        assert.equal(result.text, '你好 🌏')
        assert.deepEqual(result.usage, {
          cache_counts: { hit: 20, input: 100 },
          input_tokens: 80,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 20,
          output_tokens: 5,
        })
        assert.equal(result.provider, true)
        assert.equal(result.calls.length, 1)
        assert.equal(result.tokens, 105)
        assert.equal(result.priced, false)
        assert.equal(result.unknown, 1)
        const call = result.calls[0]
        assert.match(
          call.url,
          protocol === 'gemini'
            ? /models\/model-any:streamGenerateContent\?alt=sse$/
            : protocol === 'anthropic'
              ? /\/messages$/
              : protocol === 'responses'
                ? /\/responses$/
                : /\/chat\/completions$/
        )
        assert.ok(
          !('safety_check' in call.body) && !('title' in call.body) && !('tools' in call.body)
        )
        assert.equal(
          call.headers[
            protocol === 'anthropic'
              ? 'x-api-key'
              : protocol === 'gemini'
                ? 'x-goog-api-key'
                : 'authorization'
          ],
          `${['anthropic', 'gemini'].includes(protocol) ? '' : 'Bearer '}sk-CUSTOM_PRIVATE_CANARY_123`
        )
      }
    )
  }
  await run(
    'legacy model parameters migrate without changing the connection and apply to outgoing attachments',
    async (page) => {
      await page.evaluate(() => {
        const a = window.__audit
        const previous = {
          ...a.providers.emptyProfile(),
          id: 'custom-legacy-scope',
          revision: 'previous-revision',
          url: 'https://model-scope.example.test/v1',
          model: 'legacy-image',
          models: ['legacy-image', 'legacy-pdf'],
          vision: true,
          pdf: true,
          maxOutputTokens: 2400,
          temperature: 0.65,
          tokenParameter: 'max_completion_tokens',
          stream: false,
          streamUsage: false,
          modelSettings: { 'legacy-pdf': { maxOutputTokens: 768 } },
        }
        localStorage.setItem(
          'freeseek:providers',
          JSON.stringify({
            profiles: [previous],
            selection: { providerId: previous.id, model: previous.model },
          })
        )
      })
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)

      const result = await page.evaluate(async () => {
        const a = window.__audit
        const [migrated] = a.providers.useProviders.getState().profiles
        const inherited = a.providers.providerModelParameters(migrated, 'legacy-image')
        const saved = a.providers.saveProvider({
          ...migrated,
          models: [...migrated.models, 'new-text'],
          modelSettings: {
            ...migrated.modelSettings,
            'legacy-pdf': {
              ...migrated.modelSettings['legacy-pdf'],
              vision: false,
              temperature: 0,
              tokenParameter: 'max_tokens',
              stream: true,
            },
          },
        })
        const requests = []
        const original = window.fetch
        window.fetch = async (url, init) => {
          if (new URL(url).hostname !== 'model-scope.example.test') return original(url, init)
          const request = JSON.parse(init.body)
          requests.push(request)
          return request.stream
            ? new Response(
                'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                { headers: { 'Content-Type': 'text/event-stream' } }
              )
            : Response.json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })
        }
        const image = Uint8Array.from(
          atob(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cqGQAAAAASUVORK5CYII='
          ),
          (byte) => byte.charCodeAt(0)
        )
        const pdf = new File(['%PDF-1.7\n%%EOF'], 'fixture.pdf', { type: 'application/pdf' })
        const send = async (model, attachment) => {
          a.providers.selectModel({ providerId: saved.id, model })
          a.drafts.addDraftFiles(null, [attachment], '')
          a.drafts.setDraftText(null, 'Review this attachment')
          a.store.sendMessage(null)
          await a.waitIdle()
          const chat = a.store.useChatStore.getState()
          return chat.sessionCache[chat.activeId].messages.at(-1).status
        }
        const imageStatus = await send(
          'legacy-image',
          new File([image], 'pixel.png', { type: 'image/png' })
        )
        const pdfStatus = await send('legacy-pdf', pdf)
        const unsupportedStatus = await send('new-text', pdf)
        await a.providerClient.testProviderModel(saved, new AbortController().signal)
        return {
          inherited,
          inheritedByNewModel: a.providers.providerModelParameters(saved, 'new-text'),
          revision: saved.revision,
          rootFields: Object.keys(saved),
          requests,
          imageStatus,
          pdfStatus,
          unsupportedStatus,
        }
      })
      assert.equal(result.revision, 'previous-revision')
      assert.equal(result.inherited.vision, true)
      assert.equal(result.inherited.pdf, true)
      assert.equal(result.inheritedByNewModel.vision, false)
      assert.equal(result.inheritedByNewModel.pdf, false)
      assert.equal(result.inheritedByNewModel.temperature, null)
      assert.ok(!result.rootFields.includes('maxOutputTokens'))
      assert.ok(!result.rootFields.includes('vision'))
      assert.deepEqual(
        [result.imageStatus, result.pdfStatus, result.unsupportedStatus],
        ['done', 'done', 'error']
      )
      const [image, pdf, testRequest] = result.requests
      assert.equal(result.requests.length, 3)
      assert.equal(image.max_completion_tokens, 2400)
      assert.equal(image.temperature, 0.65)
      assert.equal(image.stream, false)
      assert.ok(image.messages.at(-1).content.some((part) => part.type === 'image_url'))
      assert.equal(pdf.max_tokens, 768)
      assert.equal(pdf.temperature, 0)
      assert.equal(pdf.stream, true)
      assert.equal(pdf.stream_options, undefined)
      assert.ok(pdf.messages.at(-1).content.some((part) => part.type === 'file'))
      assert.equal(testRequest.max_completion_tokens, 1024)
    }
  )
  await run(
    'custom non-stream response, model discovery and real generation test reject unusable success responses',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          profile = {
            ...a.providers.emptyProfile(),
            name: 'Custom',
            url: 'https://api.example.test/v1/chat/completions?api-version=1',
            model: 'gpt-test',
            stream: false,
          }
        const urls = []
        let bad = false
        window.fetch = async (url, init) => {
          urls.push(String(url))
          return Response.json(
            init.method === 'GET'
              ? { data: [{ id: 'gpt-test' }, { id: 'gpt-other' }, { id: 'gpt-test' }] }
              : bad
                ? { choices: [] }
                : { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }
          )
        }
        const models = await a.providerClient.fetchProviderModels(
          profile,
          new AbortController().signal
        )
        const test = await a.providerClient.testProviderModel(profile, new AbortController().signal)
        bad = true
        let rejected = false
        try {
          await a.providerClient.testProviderModel(profile, new AbortController().signal)
        } catch {
          rejected = true
        }
        return { models, text: test.text, rejected, urls }
      })
      assert.deepEqual(result.models, ['gpt-other', 'gpt-test'])
      assert.equal(result.text, 'OK')
      assert.equal(result.rejected, true)
      assert.match(result.urls[0], /\/v1\/models\?api-version=1$/)
      assert.match(result.urls[1], /\/v1\/chat\/completions\?api-version=1$/)
    }
  )
  await run(
    'custom DOCX stays local until chat and never uploads to the DeepSeek file service',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          requests = []
        a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: 'Local DOCX',
            url: 'https://custom.example.test/v1',
            model: 'text-model',
          },
          true
        )
        const blob = await a.writeArchive([
          {
            name: 'word/document.xml',
            blob: new Blob([
              '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX 原始内容</w:t></w:r></w:p></w:body></w:document>',
            ]),
          },
        ])
        window.fetch = async (url, init) => {
          requests.push({ url: String(url), body: init?.body })
          return new Response(
            'data: {"choices":[{"delta":{"content":"read"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } }
          )
        }
        a.drafts.addDraftFiles(
          null,
          [new File([blob], 'story.docx')],
          'OFFICIAL_KEY_MUST_NOT_BE_USED'
        )
        const beforeSend = requests.length
        a.drafts.setDraftText(null, 'read')
        a.store.sendMessage(null)
        await a.waitIdle()
        const state = a.store.useChatStore.getState(),
          session = state.sessionCache[state.activeId]
        return {
          beforeSend,
          requests,
          status: session.messages.at(-1).status,
          serverId: session.messages[0].files[0].serverId,
          original: (await a.db.loadFile(session.messages[0].files[0].id)).size,
        }
      })
      assert.equal(result.beforeSend, 0)
      assert.equal(result.requests.length, 1)
      assert.match(result.requests[0].url, /^https:\/\/custom\.example\.test/)
      assert.ok(result.requests[0].body.includes('DOCX 原始内容'))
      assert.ok(!result.requests[0].body.includes('file_id'))
      assert.equal(result.serverId, null)
      assert.equal(result.status, 'done')
      assert.ok(result.original > 0)
    }
  )
  await run(
    'provider errors and cut streams retain partial output without auto-retrying another service',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        let calls = 0
        a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: 'Cut',
            url: 'https://cut.example.test/v1',
            model: 'cut-model',
          },
          true
        )
        window.fetch = async () => {
          calls++
          return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          })
        }
        a.drafts.setDraftText(null, 'test')
        a.store.sendMessage(null)
        await a.waitIdle()
        const state = a.store.useChatStore.getState(),
          reply = state.sessionCache[state.activeId].messages.at(-1)
        return {
          calls,
          text: a.reply.getReplyText(reply),
          status: reply.status,
          kind: reply.error.kind,
        }
      })
      assert.deepEqual(result, { calls: 1, text: 'partial', status: 'error', kind: 'interrupted' })
    }
  )
  await run(
    'request captures provider credentials and refuses continuation after configuration revision changes',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        let calls = 0,
          firstHeaders
        const profile = a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: 'Old',
            url: 'https://old.example.test/v1',
            apiKey: 'old-key',
            model: 'model-a',
          },
          true
        )
        let release
        window.fetch = async (_url, init) => {
          calls++
          firstHeaders = init.headers
          await new Promise((resolve) => {
            release = resolve
          })
          return new Response(
            'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"length"}]}\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } }
          )
        }
        a.drafts.setDraftText(null, 'question')
        a.store.sendMessage(null)
        while (!release) await new Promise((r) => setTimeout(r, 5))
        a.providers.saveProvider(
          { ...profile, apiKey: 'new-key', url: 'https://new.example.test/v1' },
          true
        )
        release()
        await a.waitIdle()
        const state = a.store.useChatStore.getState(),
          id = state.activeId,
          reply = state.sessionCache[id].messages.at(-1)
        a.store.continueReply(id, reply.id)
        await a.waitIdle()
        const final = a.store.useChatStore.getState().sessionCache[id].messages.at(-1)
        return {
          calls,
          key: firstHeaders.authorization,
          text: a.reply.getReplyText(final),
          status: final.status,
          error: final.error.localMessage.key,
        }
      })
      assert.deepEqual(result, {
        calls: 1,
        key: 'Bearer old-key',
        text: 'answer',
        status: 'error',
        error: 'providerConfigChanged',
      })
    }
  )
  await run(
    'custom chat backup preserves model and persona snapshots while excluding API configuration secrets',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        const profile = a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: 'Secret',
            url: 'https://private-host.example.test/v1?key=URL_CANARY',
            apiKey: 'KEY_CANARY_LONG',
            headers: { 'x-private': 'HEADER_CANARY_LONG' },
            model: 'arbitrary/model',
          },
          true
        )
        const session = f.session({
          persona: { name: 'role', prompt: 'SYSTEM' },
          messages: [
            f.user('u', 'hello'),
            f.assistant('r', 'reply', {
              model: profile.model,
              connection: { providerId: profile.id, revision: profile.revision },
              systemPrompt: 'ORIGINAL_SYSTEM',
            }),
          ],
        })
        await a.seed([session])
        const archive = await a.backup.exportHistory(),
          contents = []
        for await (const entry of a.readArchive(new File([archive.blob], archive.name)))
          contents.push(await (await a.readEntry(entry)).text())
        await a.backup.importHistory(new File([archive.blob], archive.name))
        const restored = await a.db.loadSession(session.id),
          bundle = await a.diagnosticBundle.createDiagnosticBundle(),
          diagnostics = []
        for await (const entry of a.readArchive(new File([bundle.blob], bundle.name)))
          diagnostics.push(await (await a.readEntry(entry)).text())
        return {
          model: restored.messages[1].model,
          revision: restored.messages[1].connection.revision === profile.revision,
          prompt: restored.messages[1].systemPrompt,
          clean: !/KEY_CANARY|HEADER_CANARY|URL_CANARY|private-host/.test(
            contents.join('') + diagnostics.join('')
          ),
        }
      })
      assert.deepEqual(result, {
        model: 'arbitrary/model',
        revision: true,
        prompt: 'ORIGINAL_SYSTEM',
        clean: true,
      })
    }
  )
  await run(
    'persona imports validate atomically, export custom entries and preserve continuation persona',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        const count = await a.personas.importPersonas(
          new File(
            [
              JSON.stringify([
                { name: '角色 A', prompt: 'PROMPT_A' },
                { act: '角色 B', prompt: 'PROMPT_B' },
              ]),
            ],
            'roles.json'
          )
        )
        const before = a.personas.usePersonas.getState().personas.length
        let bad = false
        try {
          await a.personas.importPersonas(
            new File(['[{"name":"valid","prompt":"ok"},{"name":"","prompt":"bad"}]'], 'bad.json')
          )
        } catch {
          bad = true
        }
        const exported = JSON.parse(await a.personas.exportPersonas().blob.text())
        const session = f.session({
          persona: { name: 'Old', prompt: 'OLD_PROMPT' },
          messages: [
            f.user('u', 'Q'),
            f.assistant('a', 'partial', { status: 'stopped', systemPrompt: 'OLD_PROMPT' }),
          ],
        })
        await a.seed([session])
        a.store.setSessionPersona(session.id, { name: 'New', prompt: 'NEW_PROMPT' })
        let body
        window.fetch = async (_url, init) => {
          body = JSON.parse(init.body)
          return a.response('rest')
        }
        a.store.continueReply(session.id, 'a')
        await a.waitIdle()
        return {
          count,
          bad,
          unchanged: before === a.personas.usePersonas.getState().personas.length,
          custom: exported.personas.map((p) => p.name),
          system: body.system,
          persona: a.store.useChatStore.getState().sessionCache[session.id].persona.prompt,
        }
      })
      assert.deepEqual(result, {
        count: 2,
        bad: true,
        unchanged: true,
        custom: ['角色 A', '角色 B'],
        system: 'OLD_PROMPT',
        persona: 'NEW_PROMPT',
      })
    }
  )
  await run(
    'settings exposes official Pro, advanced profile persistence and optional chat model switching',
    async (page) => {
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('account'))
      await page.getByRole('radio', { name: /DeepSeek V4 Pro/ }).check()
      await page.getByRole('button', { name: '高级自定义配置', exact: true }).click()
      await page.getByRole('button', { name: '添加连接', exact: true }).click()
      await page.getByRole('button', { name: '手动配置', exact: true }).click()
      await page.getByLabel('连接名称', { exact: true }).fill('My gateway')
      await page.getByLabel('服务地址', { exact: true }).fill('https://custom.example.test/v1')
      await page.getByLabel('API 密钥', { exact: true }).fill('KEY_UI_PRIVATE')
      await page.getByRole('button', { name: '保存并管理模型', exact: true }).click()
      await page.getByRole('button', { name: '手动添加', exact: true }).click()
      await page.getByLabel('模型名称 / ID', { exact: true }).fill('custom-model')
      await page.getByRole('button', { name: '更多保存方式', exact: true }).click()
      await page.getByRole('button', { name: '保存并启用', exact: true }).click()
      await page.evaluate(() => {
        window.__audit.settings.setShowModelSwitcher(true)
        window.__audit.settingsDialog.closeSettings()
      })
      await page.getByRole('button', { name: '切换模型', exact: true }).waitFor()
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      assert.match(
        await page.getByRole('button', { name: '切换模型', exact: true }).textContent(),
        /custom-model/
      )
      const state = await page.evaluate(() => ({
        model: window.__audit.providers.useProviders.getState().selection.model,
        show: window.__audit.settings.useSettings.getState().showModelSwitcher,
      }))
      assert.deepEqual(state, { model: 'custom-model', show: true })
    }
  )
  await run(
    'provider templates keep pay-as-you-go and subscription connections independent',
    async (page) => {
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('providers'))
      const add = async (route, expectedUrl, keyLabel, key) => {
        await page.getByRole('button', { name: '添加连接', exact: true }).click()
        await page.getByRole('button', { name: '小米 MiMo', exact: true }).click()
        await page.getByRole('radio', { name: new RegExp(route) }).check()
        const next = page.getByRole('button', { name: '继续', exact: true })
        const scroll = await page.getByTestId('settings-scroll').boundingBox()
        const action = await next.boundingBox()
        assert.ok(Math.abs(scroll.y + scroll.height - action.y - action.height) <= 32)
        await next.click()
        assert.equal(await page.getByLabel('服务地址', { exact: true }).inputValue(), expectedUrl)
        const keyInput = page.getByLabel(keyLabel, { exact: true })
        assert.equal(await keyInput.inputValue(), '')
        await keyInput.fill(key)
        await page.getByRole('button', { name: '保存并管理模型', exact: true }).click()
        await page.getByRole('heading', { name: '管理模型', exact: true }).waitFor()
        await page.getByRole('button', { name: '返回', exact: true }).click()
      }
      await add('按量 API', 'https://api.xiaomimimo.com/v1', 'API 密钥', 'fixture-usage')
      await add(
        'Token Plan 订阅',
        'https://token-plan-cn.xiaomimimo.com/v1',
        '套餐密钥',
        'fixture-plan'
      )
      const profiles = await page.evaluate(
        () => window.__audit.providers.useProviders.getState().profiles
      )
      assert.equal(profiles.length, 2)
      assert.notEqual(profiles[0].id, profiles[1].id)
      assert.notEqual(profiles[0].apiKey, profiles[1].apiKey)
      assert.deepEqual(
        profiles.map((profile) => profile.model),
        ['', '']
      )
    }
  )
  await run(
    'API settings keep model search, compact parameter editing and equal footer actions',
    async (page) => {
      const button = (name) => page.getByRole('button', { name, exact: true })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.evaluate(() => {
        const a = window.__audit
        a.providers.saveProvider({
          ...a.providers.emptyProfile(),
          name: 'Gemini fixture',
          url: 'https://gemini.example.test/v1beta',
          protocol: 'gemini',
          model: 'gemini-3.6-flash',
          models: ['gemini-3.6-flash', 'gemini-3.6-pro'],
        })
        a.settingsDialog.openSettings('providers')
      })
      await button('Gemini fixture').click()
      const search = page.getByRole('searchbox', { name: '搜索模型名称或 ID' })
      await search.fill('flash')
      assert.equal(await button('gemini-3.6-pro').count(), 0)
      await button('gemini-3.6-flash').click()
      await button('显示名称').click()
      const editor = page.getByRole('dialog', { name: '显示名称', exact: true })
      const input = editor.getByRole('textbox', { name: '显示名称' })
      await page.waitForFunction(() => document.activeElement.matches('[data-panel-input]'))
      await input.fill('Gemini 自定义显示名')
      await input.press('Enter')
      await editor.waitFor({ state: 'detached' })
      assert.match(await button('显示名称').textContent(), /Gemini 自定义显示名/)

      const effort = button('默认思考强度')
      const initialHeight = await page
        .getByTestId('settings-scroll')
        .evaluate((el) => el.scrollHeight)
      await effort.click()
      const options = page.getByRole('dialog', { name: '默认思考强度', exact: true })
      await options.waitFor()
      assert.ok(await options.getAttribute('data-pointer-side'))
      assert.equal(
        await page.getByTestId('settings-scroll').evaluate((el) => el.scrollHeight),
        initialHeight
      )
      await options.getByRole('option', { name: '高', exact: true }).click()
      await options.waitFor({ state: 'detached' })

      const testButton = await button('测试模型').boundingBox()
      const saveButton = await button('保存').boundingBox()
      const moreButton = await button('更多保存方式').boundingBox()
      assert.ok(Math.abs(testButton.width - saveButton.width - moreButton.width) <= 1)
      assert.ok(Math.abs(testButton.y - saveButton.y) <= 1)
      await button('保存').click()
      await button('Gemini 自定义显示名').waitFor()
    }
  )
  await run(
    'reasoning menus show supported levels and restore model defaults on every switch',
    async (page) => {
      await page.evaluate(() => {
        const a = window.__audit
        a.settings.setApiKey('official-fixture')
        a.settings.setShowModelSwitcher(true)
        a.settings.setShowReasoningPicker(true)
        a.providers.setOfficialReasoningDefault('deepseek-flash', 'high')
        a.providers.setOfficialReasoningDefault('deepseek-v4-pro', 'max')
        a.providers.saveProvider({
          ...a.providers.emptyProfile(),
          name: 'Gemini fixture',
          url: 'https://gemini.example.test/v1beta',
          protocol: 'gemini',
          model: 'gemini-3.6-flash',
        })
      })
      const effort = page.getByTestId('composer-reasoning')
      await effort.click()
      await page.getByRole('option', { name: '低', exact: true }).click()
      assert.match(await effort.getAttribute('aria-label'), /低$/)
      const switchTo = async (name) => {
        await page.getByTestId('composer-model').click()
        await page.getByRole('option', { name }).click()
      }
      await switchTo(/gemini-3\.6-flash/)
      assert.match(await effort.getAttribute('aria-label'), /中$/)
      await effort.click()
      const panel = page.getByRole('dialog', { name: '思考强度', exact: true })
      assert.equal(await panel.getByRole('option').count(), 4)
      assert.equal(await panel.getByText('关闭', { exact: true }).count(), 0)
      await page.keyboard.press('Escape')
      await switchTo(/DeepSeek Flash/)
      assert.match(await effort.getAttribute('aria-label'), /高$/)
      await switchTo(/DeepSeek V4 Pro/)
      assert.match(await effort.getAttribute('aria-label'), /最高$/)
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('account'))
      await page.getByRole('button', { name: '默认思考强度', exact: true }).click()
      const defaultMenu = page.getByRole('dialog', { name: '默认思考强度', exact: true })
      assert.equal(await defaultMenu.getAttribute('data-kind'), 'reasoning')
      await defaultMenu.getByRole('option', { name: '关闭', exact: true }).click()
      await page.evaluate(() => window.__audit.settingsDialog.closeSettings())
      assert.match(await effort.getAttribute('aria-label'), /关闭$/)
    }
  )
  await run(
    'Gemini can stop after one search and replays the signed function call',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        a.settings.setApiKey('official-fixture')
        a.settings.saveThirdPartySearch({
          enabled: true,
          keySource: 'separate',
          apiKey: 'search-fixture',
        })
        a.settings.setThirdPartySearchOn(true)
        a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            url: 'https://chat.example.test/v1beta',
            apiKey: 'model-fixture',
            name: 'Gemini',
            model: 'gemini-3.6-flash',
            protocol: 'gemini',
            stream: false,
          },
          true
        )
        a.providers.setReasoningOverride(null, 'low')
        const requests = []
        const ordinary = window.fetch
        window.fetch = async (url, init) => {
          const route = String(url)
          if (route.endsWith('/v1/tools/search')) {
            requests.push({
              service: 'search',
              header: new Headers(init.headers).get('authorization'),
              body: JSON.parse(init.body),
            })
            return Response.json({
              results: [
                {
                  title: 'Source',
                  url: 'https://source.example/article',
                  summary: 'Reference text',
                },
              ],
            })
          }
          if (route.includes('chat.example.test')) {
            const body = JSON.parse(init.body)
            requests.push({
              service: 'model',
              header: new Headers(init.headers).get('x-goog-api-key'),
              body,
            })
            if (
              body.toolConfig?.functionCallingConfig.mode === 'AUTO' &&
              body.contents.length === 1
            ) {
              return Response.json({
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            id: 'gemini-search-call',
                            name: 'freeseek_web_search',
                            args: { query: 'Source research', count: 9 },
                          },
                          thoughtSignature: 'gemini-signature',
                        },
                      ],
                    },
                    finishReason: 'STOP',
                  },
                ],
                usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 3 },
              })
            }
            return Response.json({
              candidates: [{ content: { parts: [{ text: 'Answer' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5 },
            })
          }
          return ordinary(url, init)
        }
        a.drafts.setDraftText(null, 'Query about the source')
        a.store.sendMessage(null)
        await a.waitIdle()
        const state = a.store.useChatStore.getState()
        const reply = state.sessionCache[state.activeId].messages.at(-1)
        return {
          requests,
          status: reply.status,
          searches: reply.usage.standalone_search_requests,
          input: reply.usage.input_tokens,
          cost: a.usage.computeReplyUsage(reply).costCny,
          hasSource: reply.blocks.some((part) => part.type === 'web_search_tool_result'),
        }
      })
      assert.equal(result.status, 'done')
      assert.equal(result.requests.length, 3)
      const [model, search, answer] = result.requests
      assert.equal(model.header, 'model-fixture')
      assert.equal(model.body.tools[0].functionDeclarations[0].name, 'freeseek_web_search')
      assert.equal(search.header, 'Bearer search-fixture')
      assert.deepEqual(search.body, { query: 'Source research', count: 9, need_content: false })
      assert.equal(answer.header, 'model-fixture')
      assert.equal(answer.body.toolConfig.functionCallingConfig.mode, 'AUTO')
      assert.equal(answer.body.contents.at(-2).parts[0].thoughtSignature, 'gemini-signature')
      const output = answer.body.contents.at(-1).parts[0].functionResponse
      assert.equal(output.id, 'gemini-search-call')
      assert.match(output.response.output, /Reference text/)
      assert.equal(answer.body.generationConfig.thinkingConfig.thinkingLevel, 'LOW')
      assert.equal(result.input, 140)
      assert.equal(result.searches, 1)
      assert.equal(result.cost, 0.005)
      assert.equal(result.hasSource, true)
    }
  )
  await run(
    'Chat Completions skips invalid and repeated searches while preserving streamed reasoning',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const profile = {
          ...a.providers.emptyProfile(),
          url: 'https://search-chat.example.test/v1',
          model: 'search-model',
          stream: true,
        }
        const bodies = []
        const searches = []
        const original = window.fetch
        window.fetch = async (url, init) => {
          if (!String(url).includes('search-chat.example.test')) {
            return original(url, init)
          }
          const body = JSON.parse(init.body)
          bodies.push(body)
          if (body.tool_choice === 'none') {
            return Response.json({
              choices: [{ message: { content: 'Answer with sources' }, finish_reason: 'stop' }],
            })
          }
          const chunk = (delta, finish_reason = null) => ({ choices: [{ delta, finish_reason }] })
          const call = (index, name, args) => ({
            index,
            id: 'call-' + index,
            type: 'function',
            function: { name, arguments: args },
          })
          const events =
            bodies.length === 1
              ? [
                  chunk({
                    reasoning_content: 'Need a source.',
                    reasoning_details: [{ type: 'reasoning.encrypted', data: 'signed-openrouter' }],
                    tool_calls: [
                      call(0, 'other_tool', '{"query":"Unknown","count":1}'),
                      call(1, 'freeseek_web_search', '{"query":"Invalid","count":51}'),
                      call(2, 'freeseek_web_search', '{"query":"official source",'),
                      call(3, 'freeseek_web_search', '{"query":"OFFICIAL  source","count":2}'),
                    ],
                  }),
                  chunk({ tool_calls: [{ index: 2, function: { arguments: '"count":18}' } }] }),
                  chunk({}, 'tool_calls'),
                ]
              : [
                  chunk({
                    tool_calls: [
                      call(4, 'freeseek_web_search', '{"query":"official source","count":3}'),
                    ],
                  }),
                  chunk({}, 'tool_calls'),
                ]
          return new Response(
            events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('') +
              'data: [DONE]\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } }
          )
        }
        const events = []
        for await (const event of a.providerClient.streamProviderMessage(
          profile,
          profile.model,
          [{ role: 'user', content: [{ type: 'text', text: 'Find a source' }] }],
          'Be concise',
          new AbortController().signal,
          undefined,
          {
            search: {
              execute: async (args) => {
                searches.push(args)
                return { text: 'Source result' }
              },
              unavailable: () => {
                throw new Error('Tool should be available')
              },
            },
          }
        )) {
          events.push(event)
        }
        return { bodies, searches, events }
      })
      assert.deepEqual(result.searches, [{ query: 'official source', count: 18 }])
      assert.equal(result.bodies.length, 3)
      const [first, followUp, answer] = result.bodies
      assert.equal(first.tool_choice, 'auto')
      assert.equal(followUp.tool_choice, 'auto')
      assert.equal(answer.tool_choice, 'none')
      assert.equal(first.tools[0].function.name, 'freeseek_web_search')
      assert.equal(followUp.messages.at(-5).reasoning_content, 'Need a source.')
      assert.deepEqual(followUp.messages.at(-5).reasoning_details, [
        { type: 'reasoning.encrypted', data: 'signed-openrouter' },
      ])
      const outputs = followUp.messages.slice(-4)
      assert.deepEqual(
        outputs.map((item) => item.tool_call_id),
        ['call-0', 'call-1', 'call-2', 'call-3']
      )
      assert.match(outputs[0].content, /could not run/)
      assert.match(outputs[1].content, /could not run/)
      assert.equal(outputs[2].content, 'Source result')
      assert.match(outputs[3].content, /already searched/)
      assert.equal(answer.messages.at(-1).tool_call_id, 'call-4')
      assert.match(answer.messages.at(-1).content, /already searched/)
      assert.equal(result.events.filter((item) => item.type === 'message_stop').length, 1)
    }
  )
  for (const protocol of ['responses', 'anthropic']) {
    await run(
      `${protocol} keeps earlier sources when a follow-up web search fails`,
      async (page) => {
        const result = await page.evaluate(async (protocol) => {
          const a = window.__audit
          a.settings.saveThirdPartySearch({
            enabled: true,
            keySource: 'separate',
            apiKey: 'fixture-search',
          })
          a.settings.setThirdPartySearchOn(true)
          a.providers.saveProvider(
            {
              ...a.providers.emptyProfile(),
              url: 'https://search-tool-failure.example.test/v1',
              model: 'tool-model',
              protocol,
              stream: protocol === 'responses',
            },
            true
          )
          const requests = []
          const original = window.fetch
          const thinking = {
            type: 'thinking',
            thinking: 'Look up details.',
            signature: 'opaque-signature',
          }
          window.fetch = async (url, init) => {
            const route = String(url)
            if (route.endsWith('/v1/tools/search')) {
              const body = JSON.parse(init.body)
              requests.push({ route, body })
              if (body.query === 'reference 1') {
                return Response.json({
                  results: [{ title: 'Verified source', url: 'https://example.test/verified' }],
                })
              }
              return Response.json({ error: { message: 'Search unavailable' } }, { status: 503 })
            }
            if (!route.includes('search-tool-failure.example.test')) {
              return original(url, init)
            }
            const body = JSON.parse(init.body)
            requests.push({ route, body })
            const step =
              (protocol === 'anthropic'
                ? body.messages.filter(({ role }) => role === 'assistant').length
                : body.input.filter(({ type }) => type === 'function_call_output').length) + 1
            const id = 'lookup-' + step
            const args = { query: 'reference ' + step, count: 11 }
            if (protocol === 'anthropic') {
              return body.tool_choice?.type === 'auto'
                ? Response.json({
                    type: 'message',
                    content: [
                      thinking,
                      { type: 'tool_use', id, name: 'freeseek_web_search', input: args },
                    ],
                    stop_reason: 'tool_use',
                  })
                : Response.json({
                    type: 'message',
                    content: [{ type: 'text', text: 'Answer with the first source' }],
                    stop_reason: 'end_turn',
                  })
            }
            const output =
              body.tool_choice === 'auto'
                ? [
                    {
                      type: 'reasoning',
                      id: 'rs-test-' + step,
                      encrypted_content: 'opaque-reasoning',
                      summary: [],
                    },
                    {
                      type: 'function_call',
                      id: 'fc-test-' + step,
                      call_id: id,
                      name: 'freeseek_web_search',
                      arguments: JSON.stringify(args),
                      status: 'completed',
                    },
                  ]
                : [
                    {
                      type: 'message',
                      content: [{ type: 'output_text', text: 'Answer with the first source' }],
                    },
                  ]
            return new Response(
              'data: ' +
                JSON.stringify({ type: 'response.completed', response: { output } }) +
                '\n\n',
              { headers: { 'Content-Type': 'text/event-stream' } }
            )
          }
          a.drafts.setDraftText(null, 'Check something')
          a.store.sendMessage(null)
          await a.waitIdle()
          const state = a.store.useChatStore.getState()
          const reply = state.sessionCache[state.activeId].messages.at(-1)
          return {
            requests,
            status: reply.status,
            text: a.reply.getReplyText(reply),
            searchCount: reply.usage?.standalone_search_requests ?? 0,
            searchBlocks: reply.blocks.filter((block) => block.type === 'web_search_tool_result'),
          }
        }, protocol)
        assert.equal(result.status, 'done')
        assert.equal(result.text, 'Answer with the first source')
        assert.equal(result.searchCount, 1)
        assert.equal(result.searchBlocks[0].content[0].url, 'https://example.test/verified')
        assert.equal(result.searchBlocks[1].content[0].error_code, 'unavailable')
        assert.equal(result.requests.length, 5)
        const [first, search, second, failed, final] = result.requests
        assert.match(search.route, /\/v1\/tools\/search$/)
        assert.deepEqual(search.body, {
          query: 'reference 1',
          count: 11,
          need_content: false,
        })
        assert.equal(failed.body.query, 'reference 2')
        if (protocol === 'anthropic') {
          assert.equal(first.body.tools[0].name, 'freeseek_web_search')
          assert.equal(second.body.tool_choice.type, 'auto')
          assert.equal(final.body.tool_choice.type, 'none')
          assert.equal(final.body.messages.at(-2).content[0].signature, 'opaque-signature')
          assert.match(final.body.messages.at(-3).content[0].content, /Verified source/)
          const output = final.body.messages.at(-1).content[0]
          assert.equal(output.tool_use_id, 'lookup-2')
          assert.equal(output.is_error, true)
        } else {
          assert.equal(first.body.tools[0].type, 'function')
          assert.ok(first.body.include.includes('reasoning.encrypted_content'))
          assert.equal(second.body.tool_choice, 'auto')
          assert.equal(final.body.tool_choice, 'none')
          assert.match(final.body.input.at(-4).output, /Verified source/)
          assert.equal(final.body.input.at(-3).encrypted_content, 'opaque-reasoning')
          assert.equal(final.body.input.at(-1).call_id, 'lookup-2')
          assert.match(final.body.input.at(-1).output, /Web search failed/)
        }
      }
    )
  }
  await run('standalone web search shares one timeout budget across requests', async (page) => {
    await page.clock.install()
    await page.evaluate(() => {
      const a = window.__audit
      a.settings.saveThirdPartySearch({
        enabled: true,
        keySource: 'separate',
        apiKey: 'search-key',
      })
      a.settings.setThirdPartySearchOn(true)
      a.providers.saveProvider(
        {
          ...a.providers.emptyProfile(),
          url: 'https://search-timeout.example.test/v1',
          model: 'tool-model',
          stream: false,
        },
        true
      )
      const calls = (window.__searchBudgetCalls = [])
      let searches = 0
      const original = window.fetch
      window.fetch = async (url, init) => {
        const route = String(url)
        if (route.endsWith('/v1/tools/search')) {
          calls.push(JSON.parse(init.body))
          searches++
          if (searches === 1) {
            await new Promise((resolve) => setTimeout(resolve, 20_000))
            return Response.json({
              results: [{ title: 'Available source', url: 'https://example.test/available' }],
            })
          }
          return new Promise((_, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
          })
        }
        if (!route.includes('search-timeout.example.test')) return original(url, init)
        const body = JSON.parse(init.body)
        calls.push(body)
        if (body.tool_choice === 'none') {
          return Response.json({
            choices: [
              { message: { content: 'Answer using available sources' }, finish_reason: 'stop' },
            ],
          })
        }
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    type: 'function',
                    id: 'budget-' + searches,
                    function: {
                      name: 'freeseek_web_search',
                      arguments: JSON.stringify({ query: 'reference ' + searches, count: 2 }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        })
      }
      a.drafts.setDraftText(null, 'Check two sources')
      a.store.sendMessage(null)
    })
    await page.waitForFunction(() => window.__searchBudgetCalls?.length === 2)
    await page.clock.fastForward(20_000)
    await page.waitForFunction(() => window.__searchBudgetCalls?.length === 4)
    await page.clock.fastForward(10_500)
    const result = await page.evaluate(async () => {
      const a = window.__audit
      await a.waitIdle()
      const state = a.store.useChatStore.getState()
      const reply = state.sessionCache[state.activeId].messages.at(-1)
      const { events } = await a.diagnostics.readDiagnosticLogs()
      const failed = events.find(({ event }) => event === 'standalone.failed')
      return {
        calls: window.__searchBudgetCalls,
        text: a.reply.getReplyText(reply),
        status: reply.status,
        charged: reply.usage?.standalone_search_requests,
        timedOut: failed?.details.timedOut,
      }
    })
    assert.equal(result.status, 'done')
    assert.equal(result.text, 'Answer using available sources')
    assert.equal(result.charged, 1)
    assert.equal(result.timedOut, true)
    assert.equal(result.calls.length, 5)
    assert.equal(result.calls[4].tool_choice, 'none')
    assert.match(result.calls[4].messages.at(-3).content, /Available source/)
    assert.match(result.calls[4].messages.at(-1).content, /Web search failed/)
  })
  await run(
    'a model endpoint that rejects tools still answers without sending a search request',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const profile = {
          ...a.providers.emptyProfile(),
          url: 'https://no-tools.example.test/v1',
          model: 'plain-model',
          stream: false,
        }
        const requests = []
        let unavailable = 0
        const original = window.fetch
        window.fetch = async (url, init) => {
          if (!String(url).includes('no-tools.example.test')) {
            return original(url, init)
          }
          const body = JSON.parse(init.body)
          requests.push(body)
          return body.tools
            ? Response.json(
                { error: { message: 'This model does not support tool calling.' } },
                { status: 400 }
              )
            : Response.json({
                choices: [{ message: { content: 'Plain answer' }, finish_reason: 'stop' }],
              })
        }
        let text = ''
        for await (const event of a.providerClient.streamProviderMessage(
          profile,
          profile.model,
          [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
          '',
          new AbortController().signal,
          undefined,
          {
            search: {
              execute: async () => {
                throw new Error('No search request expected')
              },
              unavailable: () => unavailable++,
            },
          }
        )) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            text += event.delta.text
          }
        }
        return { requests, unavailable, text }
      })
      assert.equal(result.requests.length, 2)
      assert.equal(result.requests[0].tool_choice, 'auto')
      assert.equal(result.requests[1].tools, undefined)
      assert.equal(result.unavailable, 1)
      assert.equal(result.text, 'Plain answer')
    }
  )
  await run(
    'diagnostic share button opens file sharing without claiming recipient delivery',
    async (page) => {
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true })
        Object.defineProperty(navigator, 'share', {
          configurable: true,
          value: async (value) => {
            window.__sharedDiagnostic = { name: value.files[0].name, size: value.files[0].size }
          },
        })
        window.__audit.settingsDialog.openSettings('about')
      })
      await page.getByRole('button', { name: '导出并分享诊断包', exact: true }).click()
      await page.waitForFunction(() => Boolean(window.__sharedDiagnostic))
      const result = await page.evaluate(() => window.__sharedDiagnostic)
      assert.match(result.name, /^freeseek-diagnostics-.*\.zip$/)
      assert.ok(result.size > 100)
      await page.getByRole('button', { name: '保存诊断包到文件', exact: true }).waitFor()
    }
  )
}
