import assert from 'node:assert/strict'

const PRO_EXTENSION_REJECTION =
  'The server-side tool calls (deepseek_web_search, deepseek_read_url) and the title generation feature are unavailable for model deepseek-v4-pro. Please use deepseek-flash instead. (request_id: test-pro-extensions)'
const PRO_REMINDER_REJECTION =
  'The latest_reminder message is unavailable for model deepseek-v4-pro. Please use deepseek-flash instead. (request_id: test-pro-reminder)'

export const runProviderCases = async ({ run }) => {
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
        return { catalog, test: test.text, calls, errorKey }
      })
      assert.deepEqual(result.catalog, [{ id: 'kimi-k3', contextWindow: 1000000 }])
      assert.equal(result.test, 'Go 回复')
      assert.equal(result.errorKey, 'providerOpenCodeGoForbidden')
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
  await run('provider setup offers separate OpenCode Go and Zen connections', async (page) => {
    await page.evaluate(() => window.__audit.settingsDialog.openSettings('account'))
    await page.getByRole('button', { name: '高级自定义配置', exact: true }).click()
    await page.getByRole('button', { name: '添加连接', exact: true }).click()
    await page.getByRole('searchbox', { name: '搜索服务商', exact: true }).fill('opencode')
    await page.getByText('OpenCode Zen', { exact: true }).waitFor()
    await page.getByText('OpenCode Go', { exact: true }).click()
    assert.equal(
      await page.getByLabel('服务地址', { exact: true }).inputValue(),
      'https://opencode.ai/inference/go/openai/v1'
    )
    await page.getByLabel('OpenCode Go 密钥', { exact: true }).fill('go-ui-test-key')
    await page.getByRole('button', { name: '保存并管理模型', exact: true }).click()
    await page.locator('[data-settings-page="providerModels"]').waitFor()
    const saved = await page.evaluate(
      () => window.__audit.providers.useProviders.getState().profiles[0]
    )
    assert.equal(saved.preset.id, 'opencode-go')
    assert.equal(saved.url, 'https://opencode.ai/inference/go/openai/v1')
  })
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
        a.settings.saveThirdPartySearch({ enabled: true, keySource: 'official', apiKey: '' })
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
          window.__proRequests.push(body)
          if (
            body.model === 'deepseek-v4-pro' &&
            ('tools' in body ||
              'title' in body ||
              body.messages.some((message) => message.role === 'latest_reminder') ||
              JSON.stringify(body.messages).includes('read-link-signature'))
          ) {
            return Response.json({ error: { message: rejection } }, { status: 400 })
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
        a.providers.selectModel({ providerId: 'deepseek', model: 'deepseek-flash' })
        a.drafts.setDraftText(null, 'Flash 新对话')
        a.store.sendMessage(null)
        await a.waitIdle()
        return {
          requests: window.__proRequests,
          original: session.messages.find((m) => m.id === 'flash-reply').blocks,
          title: session.title,
          standaloneAttempts: window.__proStandaloneAttempts,
        }
      }, id)
      assert.equal(result.title, '原来的聊天')
      assert.equal(result.standaloneAttempts, 0)
      assert.equal(result.original[1].signature, 'read-link-signature')
      assert.equal(result.requests.length, 2)
      const [retry, flash] = result.requests
      assert.equal(retry.model, 'deepseek-v4-pro')
      assert.ok(JSON.stringify(retry.messages).includes('文章的主要内容'))
      assert.equal('tools' in retry || 'title' in retry, false)
      assert.deepEqual(
        flash.tools.map((tool) => tool.type),
        ['deepseek_read_url', 'deepseek_web_search']
      )
      assert.deepEqual(flash.title, { enabled: true })
      assert.ok(flash.messages.some((message) => message.role === 'latest_reminder'))
    }
  )
  await run(
    'V4 Pro uses standalone search only after enabling its independent toggle',
    async (page) => {
      await page.evaluate((reminderError) => {
        const a = window.__audit
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
            window.__searchRound.push({
              path,
              key: new Headers(init.headers).get('Authorization'),
              body: JSON.parse(init.body),
            })
            return Response.json({
              results: [
                {
                  title: '独立搜索结果',
                  url: 'https://example.test/search',
                  summary: '联网参考内容',
                },
              ],
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
        a.drafts.setDraftText(null, '请搜一下')
        a.store.sendMessage(null)
        await a.waitIdle()
        const state = a.store.useChatStore.getState()
        const session = state.sessionCache[state.activeId]
        const reply = session.messages.at(-1)
        return {
          requests: window.__searchRound,
          status: reply.status,
          billedSearches: reply.usage?.standalone_search_requests,
          searchResult: reply.blocks.some((block) => block.type === 'web_search_tool_result'),
          prompt: session.messages[0].content,
          flashSearch: a.settings.useSettings.getState().search,
        }
      })
      assert.equal(result.requests.length, 2)
      const [lookup, answer] = result.requests
      assert.equal(lookup.path, '/v1/tools/search')
      assert.equal(lookup.key, 'Bearer shared-search-key')
      assert.equal(lookup.body.query, '请搜一下')
      assert.equal(answer.key, 'pro-chat-key')
      assert.equal(answer.body.model, 'deepseek-v4-pro')
      assert.ok(JSON.stringify(answer.body.messages).includes('联网参考内容'))
      assert.equal('tools' in answer.body || 'title' in answer.body, false)
      assert.equal(result.status, 'done')
      assert.equal(result.billedSearches, 1)
      assert.equal(result.searchResult, true)
      assert.equal(result.prompt, '请搜一下')
      assert.equal(result.flashSearch, false)
    }
  )
  await run('retrying a saved Pro reminder error reuses five paid search results', async (page) => {
    const id = await page.evaluate(async (message) => {
      const a = window.__audit
      const searched = 'search-saved-paid-result'
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
              standalone_search_requests: 1,
            },
            blocks: [
              {
                type: 'server_tool_use',
                id: searched,
                name: 'deepseek_web_search',
                kind: 'search',
                input: { action: 'search', queries: ['1'] },
                caller: { type: 'direct' },
              },
              {
                type: 'web_search_tool_result',
                tool_use_id: searched,
                kind: 'search',
                content: Array.from({ length: 5 }, (_, i) => ({
                  type: 'web_search_result',
                  title: `原网页 ${i + 1}`,
                  url: `https://example.test/source/${i + 1}`,
                  snippet: `已付费的搜索内容 ${i + 1}`,
                  site_icon: null,
                  site_name: null,
                  encrypted_content: '',
                  page_age: null,
                })),
              },
            ],
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
        newSources: newReply.blocks.find((b) => b.type === 'web_search_tool_result')?.content
          .length,
        title: session.title,
      }
    }, id)
    assert.equal(result.lookups, 0)
    assert.equal(result.requests.length, 1)
    assert.equal(result.requests[0].model, 'deepseek-v4-pro')
    assert.ok(JSON.stringify(result.requests[0].messages).includes('已付费的搜索内容 5'))
    assert.equal(result.oldCharge, 1)
    assert.equal(result.oldStatus, 'error')
    assert.equal(result.newCharge, 0)
    assert.equal(result.newSources, 5)
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
    'third-party search sends separate credentials, adds sources and counts the standalone fee',
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
            requests.push({
              service: 'model',
              header: new Headers(init.headers).get('x-goog-api-key'),
              body: JSON.parse(init.body),
            })
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
          cost: a.usage.computeReplyUsage(reply).costCny,
          hasSource: reply.blocks.some((part) => part.type === 'web_search_tool_result'),
        }
      })
      assert.equal(result.status, 'done')
      assert.equal(result.requests.length, 2)
      assert.equal(result.requests[0].header, 'Bearer search-fixture')
      assert.equal(result.requests[0].body.query, 'Query about the source')
      assert.equal(result.requests[1].header, 'model-fixture')
      assert.match(JSON.stringify(result.requests[1].body.contents), /Reference text/)
      assert.equal(result.requests[1].body.generationConfig.thinkingConfig.thinkingLevel, 'LOW')
      assert.equal(result.searches, 1)
      assert.equal(result.cost, 0.005)
      assert.equal(result.hasSource, true)
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
