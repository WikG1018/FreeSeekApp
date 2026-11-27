import assert from 'node:assert/strict'

export const runCompressionCases = async (run) => {
  await run(
    '1M context usage counts inherited history and drops the portion covered by a summary',
    async (page) => {
      const id = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        a.settings.setApiKey('fixture')
        const session = f.session({
          title: 'Long inherited history',
          inherited: {
            fromId: 'source',
            fromTitle: 'Source',
            messages: [f.user('old-q', 'history '.repeat(315000)), f.assistant('old-a', 'Notes')],
          },
          messages: [f.user('new-q', 'Next'), f.assistant('new-a', 'Draft')],
        })
        await a.seed([session])
        const fetch = window.fetch
        window.fetch = (url, init) =>
          String(url).endsWith('/messages')
            ? Promise.resolve(a.response('Short summary'))
            : fetch(url, init)
        return session.id
      })
      const ring = page.getByTestId('context-usage')
      await ring.click()
      const panel = page.getByRole('dialog', { name: '上下文使用', exact: true })
      const pre = panel.getByText(/^720\.\dk \/ 1M tokens$/)
      await pre.waitFor()
      assert.equal(await pre.getAttribute('title'), '1,048,576')
      assert.equal(await ring.getAttribute('aria-label'), '本会话上下文，估算已用 69%')
      const result = await page.evaluate(async (id) => {
        const a = window.__audit
        const summary = await a.store.compressSession(id)
        const session = a.store.useChatStore.getState().sessionCache[id]
        return {
          covered: summary.coveredRounds,
          oldText: session.inherited.messages[0].content.length,
          recentText: session.messages[0].content,
        }
      }, id)
      await panel.getByText(/^\d{2,3} \/ 1M tokens$/).waitFor()
      assert.equal(await ring.getAttribute('aria-label'), '本会话上下文，估算已用 0%')
      assert.deepEqual(result, { covered: 1, oldText: 2520000, recentText: 'Next' })
    }
  )

  await run(
    'a 56 KB document continues a 32k-token chat and excess historical references recover in place',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        const document = (id) => ({
          id,
          serverId: 'file-api-' + id,
          name: id + '.docx',
          size: 56 * 1024,
          isImage: false,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        })
        const current = document('current')
        const earlier = ['single', 'duplicate', 'accepted', 'quota'].map((id) =>
          f.session({
            id,
            title: id,
            messages: [
              f.user(id + '-u', '文'.repeat(27000), {
                files:
                  id === 'single'
                    ? []
                    : id === 'duplicate'
                      ? Array.from({ length: 22 }, () => current)
                      : Array.from({ length: 20 }, (_, index) => document('history-' + index)),
              }),
              f.assistant(id + '-a', 'Part one'),
              f.user(id + '-pending', 'Continue with part two ' + id, { files: [current] }),
              f.assistant(id + '-failed', '', { status: 'error' }),
            ],
          })
        )
        a.settings.setApiKey('fixture')
        a.settings.setAutoCompress(false)
        await a.seed(earlier)
        const original = window.fetch
        const sent = []
        window.fetch = async (url, init) => {
          if (!String(url).endsWith('/messages')) return original(url, init)
          const body = JSON.parse(init.body)
          const documents = body.messages.flatMap((message) =>
            Array.isArray(message.content)
              ? message.content
                  .filter((part) => part.type === 'document')
                  .map((part) => part.source.file_id)
              : []
          )
          const summary = String(body.system).includes('summar')
          sent.push({
            documents: documents.length,
            current: documents.includes('file-api-current'),
            summary,
          })
          if (documents.length > 20 && JSON.stringify(body.messages).includes('part two quota')) {
            return Response.json(
              { error: { message: 'Maximum number of documents allowed is 20.' } },
              { status: 400 }
            )
          }
          return a.response(summary ? 'Summary of part one' : 'Part two')
        }
        const results = []
        for (const id of ['single', 'duplicate', 'accepted', 'quota']) {
          a.store.selectSession(id)
          a.store.regenerateReply(id, id + '-failed')
          await a.waitIdle()
          let reply = a.store.useChatStore.getState().sessionCache[id].messages.at(-1)
          const firstError = reply.error?.localMessage?.key ?? null
          const rejectedCount = reply.error?.localMessage?.params?.requestDocumentCount ?? null
          if (firstError) {
            a.store.retryContextReply(id, reply.id, 'compress')
            await a.waitIdle()
            reply = a.store.useChatStore.getState().sessionCache[id].messages.at(-1)
          }
          results.push({ firstError, rejectedCount, final: reply.status })
        }
        return { sent, results }
      })
      assert.deepEqual(result.results, [
        { firstError: null, rejectedCount: null, final: 'done' },
        { firstError: null, rejectedCount: null, final: 'done' },
        { firstError: null, rejectedCount: null, final: 'done' },
        { firstError: 'replyDocumentCountLimit', rejectedCount: 21, final: 'done' },
      ])
      assert.deepEqual(result.sent, [
        { documents: 1, current: true, summary: false },
        { documents: 1, current: true, summary: false },
        { documents: 21, current: true, summary: false },
        { documents: 21, current: true, summary: false },
        { documents: 0, current: false, summary: true },
        { documents: 1, current: true, summary: false },
      ])
    }
  )

  await run(
    'DeepSeek rejects a DOCX reference then answers with local text while preserving the original file',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        const xml =
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<w:body><w:p><w:r><w:t>正文第一行</w:t><w:tab/><w:t>对齐</w:t><w:br/><w:t>正文第二行</w:t></w:r>' +
          '<w:del><w:r><w:delText>已删除段落</w:delText></w:r></w:del></w:p>' +
          '<w:p><w:r><w:t>第二段 &amp; 说明</w:t></w:r></w:p></w:body></w:document>'
        const source = [{ name: 'word/document.xml', blob: new Blob([xml]) }]
        const plain = await a.writeArchive(source)
        const rich = await a.writeArchive([
          ...source,
          { name: 'word/media/image1.png', blob: new Blob(['image']) },
        ])
        const file = (id, blob) => ({
          id,
          serverId: 'file-api-' + id,
          name: id + '.docx',
          size: blob.size,
          isImage: false,
          mimeType: mime,
        })
        a.settings.setApiKey('fixture')
        await a.seed(
          [
            ['plain', plain],
            ['rich', rich],
          ].map(([id, blob]) =>
            f.session({
              id,
              title: id,
              messages: [
                f.user(id + '-history', '文'.repeat(27000)),
                f.assistant(id + '-answer', 'Part one'),
                f.user(id + '-question', 'Part two ' + id, { files: [file(id, blob)] }),
                f.assistant(id + '-failed', '', { status: 'error' }),
              ],
            })
          ),
          [
            { id: 'plain', blob: plain },
            { id: 'rich', blob: rich },
          ]
        )
        const calls = []
        const ordinary = window.fetch
        window.fetch = async (url, init) => {
          if (!String(url).endsWith('/messages')) return ordinary(url, init)
          const blocks = JSON.parse(init.body).messages.flatMap((message) =>
            Array.isArray(message.content) ? message.content : []
          )
          const file = blocks.find((part) => part.type === 'document')
          calls.push(
            file
              ? file.source.file_id
              : blocks.find((part) => part.text?.startsWith('[Document:'))?.text
          )
          return file
            ? Response.json(
                { error: { code: 'context_length_exceeded', message: 'Context length exceeded.' } },
                { status: 400 }
              )
            : a.response('Part two continued')
        }
        const statuses = []
        for (const id of ['plain', 'rich']) {
          a.store.selectSession(id)
          a.store.regenerateReply(id, id + '-failed')
          await a.waitIdle()
          const state = a.store.useChatStore.getState().sessionCache[id]
          const answer = state.messages.at(-1)
          const saved = state.messages.find((message) => message.id === id + '-question')
          statuses.push({
            status: answer.status,
            error: answer.error?.localMessage?.key,
            serverId: saved.files[0].serverId,
            original: (await a.db.loadFile(id)).size,
          })
        }
        return { calls, statuses }
      })
      assert.deepEqual(result.calls, [
        'file-api-plain',
        '[Document: plain.docx]\n正文第一行\t对齐\n正文第二行\n\n第二段 & 说明',
        'file-api-rich',
      ])
      assert.equal(result.statuses[0].status, 'done')
      assert.equal(result.statuses[0].serverId, 'file-api-plain')
      assert.equal(result.statuses[1].error, 'replyContextTooLong')
      assert.ok(result.statuses.every((item) => item.original > 0))
      await page.getByTestId('context-usage').click()
      await page.getByRole('dialog', { name: '上下文使用' }).getByText('上次发送被拒绝').waitFor()
    }
  )
  await run(
    'official document parsing caps input at 32k while the chat window still carries the local text',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        const body = '文档正文内容'.repeat(4000)
        const docx = await a.writeArchive([
          {
            name: 'word/document.xml',
            blob: new Blob([
              '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
                '<w:body><w:p><w:r><w:t>' +
                body +
                '</w:t></w:r></w:p></w:body></w:document>',
            ]),
          },
        ])
        const file = {
          id: 'official-large-doc',
          serverId: null,
          name: '长文档.docx',
          size: docx.size,
          isImage: false,
          mimeType: mime,
        }
        a.settings.setApiKey('fixture')
        await a.seed(
          [
            f.session({
              id: 'official-large-doc',
              messages: [
                f.user('official-question', '总结这份文档', { files: [file] }),
                f.assistant('official-failed', '', { status: 'error' }),
              ],
            }),
          ],
          [{ id: file.id, blob: docx }]
        )
        const calls = []
        const ordinary = window.fetch
        window.fetch = async (url, init) => {
          if (!String(url).endsWith('/messages')) return ordinary(url, init)
          const blocks = JSON.parse(init.body).messages.flatMap((message) =>
            Array.isArray(message.content) ? message.content : []
          )
          const document = blocks.find((part) => part.type === 'document')
          const inlined = blocks.find((part) => part.text?.startsWith('[Document:'))
          calls.push(document ? 'document' : inlined ? 'text' : 'none')
          // 官方把文档解析成正文的那一步只要 32k，聊天窗口是 1M：报错不该让整轮失败。
          if (document) {
            return Response.json(
              {
                error: {
                  message:
                    'user input too long, 159058 tokens exceeds max 32768 tokens (request_id: 7895ec52)',
                },
              },
              { status: 400 }
            )
          }
          return a.response('已根据本地文字总结完毕')
        }
        a.store.selectSession('official-large-doc')
        a.store.regenerateReply('official-large-doc', 'official-failed')
        await a.waitIdle()
        window.fetch = ordinary
        const session = a.store.useChatStore.getState().sessionCache['official-large-doc']
        const reply = session.messages.at(-1)
        return {
          calls,
          status: reply.status,
          text: reply.blocks.map((block) => (block.type === 'text' ? block.text : '')).join(''),
          serverId: session.messages[0].files[0].serverId,
          original: (await a.db.loadFile(file.id)).size,
        }
      })
      assert.deepEqual(result.calls, ['document', 'text'])
      assert.equal(result.status, 'done')
      assert.match(result.text, /已根据本地文字总结完毕/)
      assert.equal(result.serverId, 'file-api-new')
      assert.ok(result.original > 0)
    }
  )
  await run(
    'compression prompts once, estimates savings, and retains the result and consent across backup restore',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        const model = 'small-context'
        a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: 'Fixture',
            model,
            models: [model],
            url: 'https://model.example/v1',
            contextWindows: { [model]: 4096 },
            maxOutputTokens: 256,
            stream: false,
          },
          true
        )
        const file = {
          id: 'original',
          serverId: null,
          name: 'reference.txt',
          mimeType: 'text/plain',
          size: 4,
          isImage: false,
        }
        const old = '早期记录'.repeat(1250) + '🌊末尾'
        const original = f.session({
          id: 'long',
          persona: { name: 'Guide', prompt: 'Keep the persona' },
          messages: [
            f.user('u0', old, { files: [file] }),
            f.assistant('a0', 'old-answer'),
            ...Array.from({ length: 4 }, (_, i) => [
              f.user('u' + (i + 1), 'recent-' + i),
              f.assistant('a' + (i + 1), 'answer-' + i),
            ]).flat(),
          ],
        })
        await a.seed([original], [{ id: file.id, blob: new Blob(['FILE']) }])
        const sent = [],
          chunks = [],
          modelIds = [],
          summaries = []
        const ordinaryFetch = window.fetch
        window.fetch = async (url, init) => {
          if (!String(url).includes('model.example/')) return ordinaryFetch(url, init)
          const body = JSON.parse(init.body),
            user = body.messages.find((m) => m.role === 'user')
          const content = Array.isArray(user.content) ? user.content[0].text : user.content
          modelIds.push(body.model)
          let answer = 'fixture-answer'
          if (body.messages[0].content.includes('Summarize the conversation')) {
            const chunk = JSON.parse(content)
            chunks.push(chunk.conversation_excerpt)
            summaries.push(chunk.previous_summary)
            answer = 'Earlier notes ' + chunks.length
          } else sent.push(body)
          return new Response(
            JSON.stringify({
              model,
              choices: [{ message: { content: answer }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 5, completion_tokens: 3 },
            }),
            { headers: { 'Content-Type': 'application/json' } }
          )
        }
        const state = () => a.store.useChatStore.getState().sessionCache.long
        a.drafts.setDraftText('long', 'first question')
        a.store.sendMessage('long')
        await a.waitIdle()
        const first = state().messages.at(-1),
          asked = [first.error?.localMessage?.key, sent.length, chunks.length]
        a.store.retryContextReply('long', first.id, 'send')
        await a.waitIdle()
        a.drafts.setDraftText('long', 'continue without compression')
        a.store.sendMessage('long')
        await a.waitIdle()
        const sentAgain = state().messages.at(-1).status
        await a.store.compressSession('long')
        a.drafts.setDraftText('long', 'second question')
        a.store.sendMessage('long')
        await a.waitIdle()
        const second = state().messages.at(-1)
        const summarized = a.store.currentContextSummary(state())
        if (!summarized)
          throw Error('Missing summary: ' + JSON.stringify(state().messages.at(-1).error))
        const edited = a.store.editContextSummary('long', summarized, 'User edited facts')
        const blob = (await a.backup.exportHistory()).blob
        await a.backup.importHistory(new File([blob], 'test.zip'), undefined, async () =>
          new Set(['long'])
        )
        const restored = await a.db.loadSession('long')
        a.store.selectSession('long')
        await new Promise((resolve) => {
          if (a.store.useChatStore.getState().sessionCache.long) return resolve()
          const stop = a.store.useChatStore.subscribe((s) => {
            if (s.sessionCache.long) {
              stop()
              resolve()
            }
          })
        })
        a.drafts.setDraftText('long', 'after restore')
        a.store.sendMessage('long')
        await a.waitIdle()
        const stats = await a.usage.collectUsage()
        return {
          asked,
          projection: first.error?.localMessage?.params,
          sentAgain,
          promptRestored: restored.compressionPromptShown,
          estimate: restored.contextSummary.historyEstimate,
          oldIntact: restored.messages[0].content === old,
          oldSent: JSON.stringify(sent[0]).includes('🌊末尾'),
          edited,
          editedNote: restored.contextSummary.text,
          originalFile: await (await a.db.loadFile(
            restored.messages.find(({ files }) => files?.length).files[0].id
          )).text(),
          compactReply:
            restored.messages.at(-1).id === second.id && restored.messages.at(-1).status === 'done',
          inputs: chunks.join(''),
          summaries,
          models: [...new Set(modelIds)],
          activePersona: sent[2]?.messages[0]?.content,
          compactPayload: JSON.stringify(sent[2]),
          restoredPayload: JSON.stringify(sent[3]),
          charges: restored.compressionUsage.length,
          chunkCount: chunks.length,
          unpriced: stats.total.unpricedRequests,
        }
      })
      assert.deepEqual(result.asked, ['compressionSuggested', 0, 0])
      assert.match(result.projection.before, /^6\.\dk$/)
      assert.ok(result.projection.after)
      assert.equal(result.sentAgain, 'done')
      assert.equal(result.promptRestored, true)
      assert.ok(result.estimate.before > result.estimate.after)
      assert.ok(result.oldIntact && result.oldSent && result.edited && result.compactReply)
      assert.equal(result.editedNote, 'User edited facts')
      assert.equal(result.originalFile, 'FILE')
      assert.deepEqual(result.models, ['small-context'])
      assert.equal(result.activePersona, 'Keep the persona')
      assert.ok(result.chunkCount > 1 && result.charges === result.chunkCount)
      assert.equal(result.summaries[0], '')
      assert.equal(result.summaries.at(-1), 'Earlier notes ' + (result.chunkCount - 1))
      assert.ok(
        result.inputs.includes('🌊末尾') &&
          result.inputs.includes('reference.txt') &&
          !result.inputs.includes('FILE')
      )
      assert.match(result.compactPayload, /Earlier notes/)
      assert.match(result.compactPayload, /recent-3/)
      assert.doesNotMatch(result.compactPayload, /🌊末尾|reference.txt/)
      assert.match(result.restoredPayload, /User edited facts/)
      assert.ok(result.unpriced >= result.charges)
    }
  )

  await run(
    'compression retries a genuine service limit once, never on output errors or an oversized first question',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        a.settings.setAutoCompress(true)
        a.settings.setApiKey('fixture')
        const results = []
        for (const mode of ['recover', 'exhaust', 'output', 'single']) {
          const existing = f.session({
            id: mode,
            messages:
              mode === 'single'
                ? []
                : [f.user('old', 'early fact'), f.assistant('reply', 'remembered')],
          })
          await a.seed([existing])
          let summaries = 0,
            attempts = 0
          const ordinary = window.fetch
          window.fetch = async (url, init) => {
            if (!String(url).endsWith('/messages')) return ordinary(url, init)
            const body = JSON.parse(init.body)
            if (body.max_tokens) {
              summaries++
              return a.response('concise summary')
            }
            attempts++
            if (
              mode === 'recover' &&
              attempts === 2 &&
              JSON.stringify(body.messages).includes('concise summary')
            )
              return a.response('resumed')
            const message =
              mode === 'output'
                ? 'max_tokens must be less than or equal to 8192'
                : 'maximum context length is 1048576 tokens'
            return new Response(
              JSON.stringify({ error: { type: 'invalid_request_error', message } }),
              { status: 400 }
            )
          }
          a.drafts.setDraftText(mode, 'current question')
          a.store.sendMessage(mode)
          await a.waitIdle()
          const stored = a.store.useChatStore.getState().sessionCache[mode]
          results.push({
            attempts,
            summaries,
            status: stored.messages.at(-1).status,
            error: stored.messages.at(-1).error?.localMessage?.key ?? null,
            userCount: stored.messages.filter((m) => m.role === 'user').length,
          })
          window.fetch = ordinary
        }
        return results
      })
      assert.deepEqual(result, [
        { attempts: 2, summaries: 1, status: 'done', error: null, userCount: 2 },
        {
          attempts: 2,
          summaries: 1,
          status: 'error',
          error: 'compressionStillTooLong',
          userCount: 2,
        },
        {
          attempts: 1,
          summaries: 0,
          status: 'error',
          error: 'replyOutputLimitInvalid',
          userCount: 2,
        },
        {
          attempts: 1,
          summaries: 0,
          status: 'error',
          error: 'compressionInputLarge',
          userCount: 1,
        },
      ])
    }
  )

  await run(
    'a gateway that caps input at 32k warns before sending and explains the rejection with real counts',
    async (page) => {
      const model = await page.evaluate(async () => {
        const a = window.__audit
        const model = 'relay-model'
        a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: 'Relay',
            model,
            models: [model],
            url: 'https://relay.example/v1',
            contextWindows: { [model]: 32768 },
            maxOutputTokens: 4096,
            stream: false,
          },
          true
        )
        // 337 KB 的 docx 在网关侧被转成十几万 token 的文字：单条消息本身已经超限，
        // 压缩历史帮不上忙，所以要在面板里先说清楚，而不是等发出去被拒。
        await a.seed([a.fixtures.session({ id: 'relay-chat', messages: [] })])
        a.store.selectSession('relay-chat')
        a.drafts.setDraftText('relay-chat', '文'.repeat(60000))
        return a.providers.useProviders.getState().selection.model
      })
      assert.equal(model, 'relay-model')
      const ring = page.getByTestId('context-usage')
      await ring.click()
      const panel = page.getByRole('dialog', { name: '上下文使用', exact: true })
      await panel
        .getByText(
          /这次发送的文字、附件与预留回复合计约 [\d.]+k tokens，已超过模型上限 32\.8k tokens/
        )
        .waitFor()
      await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'hidden' })
      const reply = await page.evaluate(async () => {
        const a = window.__audit
        const ordinary = window.fetch
        const hits = []
        window.fetch = async (url, init) => {
          const href = typeof url === 'string' ? url : (url?.url ?? String(url))
          if (!href.includes('relay.example')) return ordinary(url, init)
          hits.push(href)
          return new Response(
            JSON.stringify({
              error: {
                message:
                  'user input too long, 159058 tokens exceeds max 32768 tokens (request_id: 7895ec52)',
              },
            }),
            { status: 400 }
          )
        }
        a.store.sendMessage('relay-chat')
        await a.waitIdle()
        window.fetch = ordinary
        const message = a.store.useChatStore.getState().sessionCache['relay-chat'].messages.at(-1)
        return {
          hits,
          status: message.status,
          key: message.error?.localMessage?.key,
          params: message.error?.localMessage?.params,
        }
      })
      assert.deepEqual(
        { hits: reply.hits.length, status: reply.status, key: reply.key },
        { hits: 1, status: 'error', key: 'compressionInputLarge' }
      )
      assert.equal(reply.params.requestedTokens, 159058)
      assert.equal(reply.params.contextLimitTokens, 32768)
      await page.getByText('服务端计数 159,058 / 32,768 tokens', { exact: false }).waitFor()
    }
  )

  await run(
    'compression recovery finishes the summary before uploading or sending the pending turn',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        const f = a.fixtures
        const mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        const document = (name, id, serverId) => ({
          id,
          serverId,
          name,
          mimeType,
          size: 56 * 1024,
          isImage: false,
        })
        const earlier = document('earlier-document.docx', 'earlier-doc', 'file-api-earlier-doc')
        const current = document('current-document.docx', 'current-doc', null)
        const messages = [
          ...Array.from({ length: 6 }, (_, index) => [
            f.user('q' + index, 'earlier passage ' + index, {
              files: index === 5 ? [earlier] : [],
            }),
            f.assistant('a' + index, 'earlier answer ' + index),
          ]).flat(),
          f.user('current-question', 'CURRENT_QUESTION_MARKER', { files: [current] }),
          f.assistant('failed-reply', '', {
            status: 'error',
            error: {
              kind: 'http',
              message: '',
              status: 400,
              localMessage: { key: 'replyContextTooLong' },
            },
          }),
        ]
        await a.seed(
          [f.session({ id: 'documents', messages })],
          [{ id: current.id, blob: new Blob(['current document fixture'], { type: mimeType }) }]
        )
        a.settings.setApiKey('fixture')
        const requests = []
        window.__contextRecoveryRequests = requests
        const order = (window.__contextRecoveryOrder = [])
        const open = XMLHttpRequest.prototype.open
        XMLHttpRequest.prototype.open = function (method, url, ...args) {
          if (method === 'POST' && String(url).endsWith('/files')) order.push('upload-current')
          return open.call(this, method, url, ...args)
        }
        const ordinary = window.fetch
        window.fetch = async (url, init) => {
          if (!String(url).endsWith('/messages')) return ordinary(url, init)
          const body = JSON.parse(init.body)
          requests.push(body)
          if (body.max_tokens) {
            order.push('summary')
            const stream = await a.response('Compact earlier context').text()
            const end = stream.lastIndexOf('data:')
            const encoder = new TextEncoder()
            return new Response(
              new ReadableStream({
                start(controller) {
                  // Deliver the summary text first. Withhold message_stop until the test releases it.
                  controller.enqueue(encoder.encode(stream.slice(0, end)))
                  window.__finishContextSummary = (complete) => {
                    order.push(complete ? 'summary-complete' : 'summary-interrupted')
                    if (complete) controller.enqueue(encoder.encode(stream.slice(end)))
                    controller.close()
                    window.__finishContextSummary = undefined
                  }
                },
              }),
              { headers: { 'Content-Type': 'text/event-stream' } }
            )
          }
          order.push('retry-answer')
          if (JSON.stringify(body.messages).includes('file-api-earlier-doc')) {
            return new Response(
              JSON.stringify({ error: { message: 'maximum context length is 1048576 tokens' } }),
              { status: 400 }
            )
          }
          return a.response('Reply after compression')
        }
      })
      await page.getByRole('button', { name: '压缩历史并重试', exact: true }).click()
      await page.waitForFunction(() => typeof window.__finishContextSummary === 'function')
      assert.deepEqual(await page.evaluate(() => window.__contextRecoveryOrder), ['summary'])
      await page.evaluate(() => window.__finishContextSummary(false))
      await page.waitForFunction(() => typeof window.__finishContextSummary === 'function')
      await page.evaluate(() => window.__finishContextSummary(false))
      await page.getByText(/摘要只收到一部分/).waitFor()
      assert.deepEqual(await page.evaluate(() => window.__contextRecoveryOrder), [
        'summary',
        'summary-interrupted',
        'summary',
        'summary-interrupted',
      ])
      await page.getByRole('button', { name: '继续压缩', exact: true }).click()
      await page.waitForFunction(() => typeof window.__finishContextSummary === 'function')
      assert.deepEqual(await page.evaluate(() => window.__contextRecoveryOrder), [
        'summary',
        'summary-interrupted',
        'summary',
        'summary-interrupted',
        'summary',
      ])
      await page.evaluate(() => window.__finishContextSummary(true))
      const result = await page.evaluate(async () => {
        const a = window.__audit
        await a.waitIdle()
        const saved = a.store.useChatStore.getState().sessionCache.documents
        const requests = window.__contextRecoveryRequests
        return {
          summaryRequests: requests.slice(0, 3).map((request) => JSON.stringify(request.messages)),
          retry: JSON.stringify(requests[3].messages),
          order: window.__contextRecoveryOrder,
          status: saved.messages.at(-1).status,
          questions: saved.messages.filter((message) => message.role === 'user').length,
          originalFiles: saved.messages
            .filter((message) => message.role === 'user')
            .flatMap((message) => message.files.map((file) => file.id)),
        }
      })
      for (const summaryRequest of result.summaryRequests) {
        assert.match(summaryRequest, /earlier-document\.docx/)
        assert.doesNotMatch(
          summaryRequest,
          /CURRENT_QUESTION_MARKER|current-document\.docx|file-api-/
        )
      }
      assert.match(result.retry, /Compact earlier context/)
      assert.match(result.retry, /CURRENT_QUESTION_MARKER/)
      assert.match(result.retry, /file-api-new/)
      assert.doesNotMatch(result.retry, /file-api-earlier-doc/)
      assert.deepEqual(result.order, [
        'summary',
        'summary-interrupted',
        'summary',
        'summary-interrupted',
        'summary',
        'summary-complete',
        'upload-current',
        'retry-answer',
      ])
      assert.equal(result.status, 'done')
      assert.equal(result.questions, 7)
      assert.deepEqual(result.originalFiles, ['earlier-doc', 'current-doc'])
    }
  )

  await run(
    'a 1M rejection resumes a 2.9.0 progress record and recovers an interrupted response body',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures,
          id = 'very-long'
        const messages = Array.from({ length: 8490 }, (_, i) => [
          f.user(
            'q' + i,
            (i === 0 ? 'EARLIEST_PRIVATE_FIXTURE ' : i === 8489 ? 'LAST_HISTORICAL_TURN ' : '') +
              '较早的聊天记录'.repeat(17)
          ),
          f.assistant('a' + i, '较早的回答'.repeat(10)),
        ]).flat()
        // The persisted scope from 2.9.0 identifies the full earlier history, while the new plan
        // only needs a targeted prefix. Keep the exact legacy digest for that compatibility check.
        const signature = (parts) => {
          let first = 2166136261,
            second = 5381
          for (const part of parts) {
            first = Math.imul(first ^ part.length, 16777619)
            for (let i = 0; i < part.length; i++) {
              first = Math.imul(first ^ part.charCodeAt(i), 16777619)
              second = Math.imul(second, 33) ^ part.charCodeAt(i)
            }
          }
          return (first >>> 0).toString(36) + '-' + (second >>> 0).toString(36)
        }
        const history = []
        for (let i = 0; i < messages.length; i += 2) {
          const user = messages[i],
            answer = messages[i + 1]
          history.push(
            user.id,
            user.content,
            String(user.createdAt),
            answer.id,
            a.reply.getReplyText(answer)
          )
        }
        const checkpoint = {
          scope: signature([
            'compression-1',
            'deepseek',
            'deepseek-flash',
            '',
            '',
            '0',
            '8490',
            signature(history),
            '',
          ]),
          text: 'Legacy completed summary',
          offset: 32768,
          segmentLimit: 32768,
          outputTokens: 4096,
          windowTokens: 65536,
        }
        messages.push(
          f.user('waiting', 'CURRENT_QUESTION', {
            files: [
              {
                id: 'current',
                serverId: 'file-api-current',
                name: 'current.docx',
                size: 56 * 1024,
                mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                isImage: false,
              },
            ],
          }),
          f.assistant('failed', '', {
            status: 'error',
            error: {
              kind: 'http',
              status: 400,
              message: '',
              localMessage: {
                key: 'replyContextTooLong',
                params: { contextLimitTokens: 1048576, requestedTokens: 1052639 },
              },
            },
          })
        )
        a.settings.setApiKey('test-key')
        a.settings.setAutoCompress(false)
        await a.seed([f.session({ id, messages, compressionCheckpoint: checkpoint })])
        const ordinary = window.fetch,
          summaries = []
        let answer = null
        window.fetch = async (url, init) => {
          if (!String(url).endsWith('/messages')) return ordinary(url, init)
          const body = JSON.parse(init.body)
          if (!body.max_tokens) {
            const serialized = JSON.stringify(body.messages)
            answer = {
              current:
                serialized.includes('CURRENT_QUESTION') && serialized.includes('file-api-current'),
              recent: serialized.includes('LAST_HISTORICAL_TURN'),
              durable: Boolean((await a.db.loadSession(id)).contextSummary),
            }
            return a.response('Continued the same chat')
          }
          const input = JSON.parse(body.messages[0].content)
          summaries.push({
            previous: input.previous_summary,
            size: input.conversation_excerpt.length,
            includedCurrent: /CURRENT_QUESTION|current\.docx|EARLIEST_PRIVATE_FIXTURE/.test(
              input.conversation_excerpt
            ),
          })
          if (summaries.length === 1) {
            return new Response(
              new ReadableStream({
                start(controller) {
                  const data =
                    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Partial summary"}}\n\n'
                  controller.enqueue(new TextEncoder().encode(data))
                  setTimeout(() => controller.error(new TypeError('network disconnected')), 10)
                },
              }),
              { headers: { 'Content-Type': 'text/event-stream' } }
            )
          }
          return a.response('Completed earlier summary')
        }
        a.store.retryContextReply(id, 'failed', 'compress')
        await a.waitIdle()
        const { events } = await a.diagnostics.readDiagnosticLogs()
        const failure = events.find(({ event }) => event === 'compression.segment.failed')
        const bodyFailure = events.find(({ event }) => event === 'response.body.failed')
        const stored = await a.db.loadSession(id)
        return {
          summaries,
          answer,
          done: stored.messages.at(-1).status,
          covered: stored.contextSummary?.coveredRounds,
          original: stored.messages.length,
          detail: failure?.details.failureKey,
          linked: Boolean(
            bodyFailure &&
            failure?.details.requestId === bodyFailure.details.requestId &&
            bodyFailure.details.receivedBytes > 0
          ),
          resumed: events.some(
            ({ event, details }) =>
              event === 'compression.resumed' && details.processedChars === checkpoint.offset
          ),
        }
      })
      assert.ok(result.resumed && result.linked && result.covered > 0 && result.covered < 8490)
      assert.ok(result.summaries.length >= 2 && result.summaries.length <= 5)
      assert.equal(result.summaries[0].previous, 'Legacy completed summary')
      assert.deepEqual(result.summaries[1], result.summaries[0])
      assert.ok(result.summaries.every(({ includedCurrent }) => !includedCurrent))
      assert.deepEqual(result.answer, { current: true, recent: true, durable: true })
      assert.equal(result.done, 'done')
      assert.equal(result.detail, 'compressionFailedNetwork')
      assert.equal(result.original, 16982)
    }
  )

  await run(
    'summary save failures block the answer and preserve the service rejection',
    async (page) => {
      const before = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures,
          id = 'full-storage'
        a.settings.setApiKey('test-key')
        await a.seed([
          f.session({
            id,
            messages: [
              f.user('old', 'History before the waiting message. '.repeat(200)),
              f.assistant('answer', 'Earlier note'),
              f.user('pending', 'Waiting question'),
              f.assistant('last', '', {
                status: 'error',
                error: {
                  kind: 'http',
                  status: 400,
                  message: '',
                  localMessage: {
                    key: 'replyContextTooLong',
                    params: { requestedTokens: 1052639, contextLimitTokens: 1048576 },
                  },
                },
              }),
            ],
          }),
        ])
        const counts = (window.__counts = { summaries: 0, answers: 0, durable: false })
        const ordinary = window.fetch
        window.fetch = async (url, init) => {
          if (!String(url).endsWith('/messages')) return ordinary(url, init)
          if (JSON.parse(init.body).max_tokens) {
            counts.summaries++
            return a.response('Summary of the earlier turns')
          }
          counts.answers++
          counts.durable = Boolean((await a.db.loadSession(id)).contextSummary)
          return a.response('Answered after saving')
        }
        const put = IDBObjectStore.prototype.put
        try {
          IDBObjectStore.prototype.put = function (value, ...args) {
            if (this.name === 'sessions' && value?.contextSummary)
              throw new DOMException('Fixture quota', 'QuotaExceededError')
            return put.call(this, value, ...args)
          }
          a.store.retryContextReply(id, 'last', 'compress')
          await a.waitIdle()
          const stored = await a.db.loadSession(id)
          a.store.retryContextReply(id, 'last', 'send')
          await a.waitIdle()
          return {
            counts,
            checkpoint: Boolean(stored.compressionCheckpoint),
            error: stored.messages.at(-1).error?.localMessage,
            stillPending: !stored.contextSummary,
          }
        } finally {
          IDBObjectStore.prototype.put = put
        }
      })
      assert.deepEqual(before.counts, { summaries: 1, answers: 0, durable: false })
      assert.ok(before.checkpoint && before.stillPending)
      assert.equal(before.error.key, 'compressionFailedSave')
      assert.equal(before.error.params.requestedTokens, 1052639)
      await page.getByRole('button', { name: '继续压缩', exact: true }).click()
      const after = await page.evaluate(async () => {
        const a = window.__audit
        await a.waitIdle()
        return {
          counts: window.__counts,
          status: (await a.db.loadSession('full-storage')).messages.at(-1).status,
        }
      })
      assert.deepEqual(after, {
        counts: { summaries: 1, answers: 1, durable: true },
        status: 'done',
      })
    }
  )

  await run(
    'recent context keeps pending files and lets the same conversation carry on',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures,
          id = 'recent-context'
        const messages = Array.from({ length: 6 }, (_, i) => [
          f.user('q' + i, 'OLD_TURN_' + i),
          f.assistant('a' + i, 'Earlier answer ' + i),
        ]).flat()
        const attachment = {
          id: 'document',
          serverId: 'file-api-document',
          name: 'document.pdf',
          size: 4,
          mimeType: 'application/pdf',
          isImage: false,
        }
        messages.push(
          f.user('pending', 'WAITING_MESSAGE', { files: [attachment] }),
          f.assistant('failed', '', {
            status: 'error',
            error: {
              kind: 'protocol',
              message: '',
              localMessage: { key: 'compressionFailedNetwork', params: { recoverContext: 1 } },
            },
          })
        )
        a.settings.setApiKey('test-key')
        await a.seed([f.session({ id, messages })], [{ id: 'document', blob: new Blob(['file']) }])
        const fetch = window.fetch,
          calls = (window.__recentCalls = [])
        window.fetch = async (url, init) => {
          if (!String(url).endsWith('/messages')) return fetch(url, init)
          const messages = JSON.stringify(JSON.parse(init.body).messages)
          calls.push(messages)
          if (messages.includes('OLD_TURN_')) {
            return Response.json(
              { error: { message: 'maximum context length is 1048576 tokens' } },
              { status: 400 }
            )
          }
          return a.response('Continued answer')
        }
      })
      await page.getByRole('button', { name: '用最近的聊天继续', exact: true }).click()
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          id = 'recent-context'
        await a.waitIdle()
        a.drafts.setDraftText(id, 'NEXT_MESSAGE')
        a.store.sendMessage(id)
        await a.waitIdle()
        const backup = (await a.backup.exportHistory()).blob
        await a.backup.importHistory(new File([backup], 'recent-context.zip'), undefined, async () =>
          new Set([id])
        )
        const stored = await a.db.loadSession(id)
        return {
          original: stored.messages[0].content,
          status: stored.messages.at(-1).status,
          retained: stored.contextSummary.recentOnly,
          cut: stored.contextSummary.coveredRounds,
          attachment: await (await a.db.loadFile(
            stored.messages.find(({ files }) => files?.length).files[0].id
          )).text(),
          calls: window.__recentCalls,
        }
      })
      assert.equal(result.original, 'OLD_TURN_0')
      assert.equal(result.attachment, 'file')
      assert.ok(result.retained)
      assert.equal(result.cut, 6)
      assert.equal(result.status, 'done')
      assert.equal(result.calls.length, 3)
      assert.match(result.calls[0], /OLD_TURN_5/)
      assert.doesNotMatch(result.calls[0], /OLD_TURN_0/)
      assert.match(result.calls[1], /WAITING_MESSAGE/)
      assert.match(result.calls[1], /file-api-document/)
      assert.doesNotMatch(result.calls[1], /OLD_TURN_/)
      assert.match(result.calls[2], /NEXT_MESSAGE/)
      assert.doesNotMatch(result.calls[2], /OLD_TURN_/)

      const active = page.locator('[data-session-id="recent-context"]')
      if (!(await active.isVisible())) {
        await page.getByRole('button', { name: '打开边栏', exact: true }).click()
      }
      await active.getByRole('button', { name: '更多', exact: true }).click()
      await page.getByRole('menuitem', { name: '整理并压缩上下文', exact: true }).click()
      await page.getByRole('button', { name: '恢复完整上下文', exact: true }).click()
      await page.getByText('已恢复完整上下文', { exact: true }).waitFor()
      const reset = await page.evaluate(async () => {
        const a = window.__audit
        const id = 'recent-context'
        const ordinary = window.fetch
        const sent = []
        window.fetch = async (url, init) => {
          if (!String(url).endsWith('/messages')) return ordinary(url, init)
          sent.push(JSON.stringify(JSON.parse(init.body).messages))
          return a.response('Restored answer')
        }
        a.drafts.setDraftText(id, 'AFTER_RESTORE')
        a.store.sendMessage(id)
        await a.waitIdle()
        const session = await a.db.loadSession(id)
        return { sent, hasCut: Boolean(session.contextSummary), storedMessages: session.messages.length }
      })
      assert.equal(reset.hasCut, false)
      assert.equal(reset.sent.length, 1)
      assert.match(reset.sent[0], /AFTER_RESTORE/)
      assert.match(reset.sent[0], /OLD_TURN_0/)
      assert.match(reset.sent[0], /OLD_TURN_5/)
      assert.match(reset.sent[0], /file-api-document/)
      assert.equal(reset.storedMessages, 18)
    }
  )

  await run(
    'compression adapts to rejected and truncated segments, then explains a refusal without sending the pending turn',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        a.settings.setApiKey('fixture')
        const id = 'compress-checked'
        const older = f.user('old-user', 'early-notes '.repeat(26000))
        const session = f.session({
          id,
          title: 'Segmented compression',
          inherited: {
            fromId: 'source',
            fromTitle: 'Earlier history',
            messages: [older, f.assistant('old-answer', 'Long history')],
          },
          messages: [
            f.user('recent', 'Recent question'),
            f.assistant('recent-answer', 'Recent answer'),
          ],
        })
        await a.seed([session])
        const fetch = window.fetch
        let truncated = false,
          mode = 'compress',
          declinedCalls = 0,
          answerCalls = 0
        const segments = []
        const outputBudgets = []
        window.fetch = async (url, init) => {
          if (!String(url).endsWith('/messages')) return fetch(url, init)
          const body = JSON.parse(init.body)
          if (!body.max_tokens) {
            answerCalls++
            return new Response(
              JSON.stringify({ error: { message: 'Maximum context length exceeded' } }),
              {
                status: 400,
              }
            )
          }
          const { conversation_excerpt: excerpt } = JSON.parse(body.messages[0].content)
          if (mode === 'refuse') {
            declinedCalls++
            return a.response('Declined', undefined, 'refusal')
          }
          segments.push(excerpt.length)
          outputBudgets.push(body.max_tokens)
          if (excerpt.length > 40000) {
            return new Response(
              JSON.stringify({ error: { message: 'Maximum context length exceeded' } }),
              {
                status: 400,
              }
            )
          }
          if (!truncated) {
            truncated = true
            return a.response('Partial summary', undefined, 'max_tokens')
          }
          return a.response('Completed summary')
        }
        const summary = await a.store.compressSession(id)
        mode = 'refuse'
        a.drafts.setDraftText(id, 'Pending question')
        a.store.sendMessage(id)
        await a.waitIdle()
        const current = () => a.store.useChatStore.getState().sessionCache[id]
        const failed = current().messages.at(-1)
        a.store.retryContextReply(id, failed.id, 'compress')
        await a.waitIdle()
        const reply = current().messages.at(-1)
        a.store.retryContextReply(id, reply.id, 'compress')
        await a.waitIdle()
        const { events } = await a.diagnostics.readDiagnosticLogs()
        return {
          summary: summary.text,
          estimate: summary.historyEstimate,
          adaptive: segments[0] > 40000 && segments.slice(-5).every((length) => length <= 32768),
          budgetRaised: Math.max(...outputBudgets) > 2048,
          explanation: reply.error?.localMessage?.key,
          recover: reply.error?.localMessage?.params?.recoverContext,
          preserved: current().contextSummary?.text === summary.text,
          checkpoint: current().compressionCheckpoint,
          declinedCalls,
          answerCalls,
          failures: events
            .filter((entry) => entry.event === 'compression.segment.failed')
            .map((entry) => [entry.details.failureKey, entry.details.stopReason]),
        }
      })
      assert.equal(result.summary, 'Completed summary')
      assert.ok(
        result.adaptive &&
          result.budgetRaised &&
          result.preserved &&
          result.estimate.before > result.estimate.after
      )
      assert.equal(result.explanation, 'compressionFailedRefused')
      assert.equal(result.recover, 1)
      assert.equal(result.answerCalls, 1)
      assert.equal(result.declinedCalls, 1)
      assert.deepEqual(result.checkpoint?.retainedRanges, [{ start: 1, end: 2 }])
      assert.equal(result.checkpoint?.text, result.summary)
      assert.ok(result.failures.some(([cause]) => cause === 'compressionFailedContext'))
      assert.ok(
        result.failures.some(
          ([cause, stop]) => cause === 'compressionFailedOutput' && stop === 'max_tokens'
        )
      )
      assert.ok(
        result.failures.some(
          ([cause, stop]) => cause === 'compressionFailedRefused' && stop === 'refusal'
        )
      )
      await page.getByText(/模型拒绝生成这段聊天的摘要。原聊天记录已保留。/).waitFor()
      await page.getByRole('button', { name: '保留上下文重试', exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: '继续压缩', exact: true }).count(), 0)
      assert.equal(await page.getByRole('button', { name: '用最近的聊天继续', exact: true }).count(), 0)
    }
  )

  await run(
    'refused compression stays stopped after reload and retry retains all uncompressed history',
    async (page) => {
      const before = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures,
          id = 'declined-history'
        const messages = Array.from({ length: 6 }, (_, i) => [
          f.user('old-' + i, 'OLDER_TURN_' + i + (i === 4 ? '旧记录'.repeat(16000) : '')),
          f.assistant('reply-' + i, 'Earlier reply ' + i),
        ]).flat()
        const attachment = {
          id: 'pending-document',
          serverId: 'file-api-pending-document',
          name: 'pending.docx',
          size: 13,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          isImage: false,
        }
        messages.push(
          f.user('waiting', 'PENDING_QUESTION', { files: [attachment] }),
          f.assistant('failed', '', {
            status: 'error',
            error: {
              kind: 'http', status: 400, message: '', localMessage: { key: 'replyContextTooLong' },
            },
          })
        )
        a.settings.setApiKey('fixture')
        await a.seed([f.session({ id, messages })], [
          { id: attachment.id, blob: new Blob(['file-original']) },
        ])
        const ordinary = window.fetch
        const calls = []
        window.fetch = async (url, init) => {
          if (!String(url).endsWith('/messages')) return ordinary(url, init)
          const body = JSON.parse(init.body)
          calls.push(JSON.stringify(body.messages))
          return a.response('Service declined this excerpt', undefined, 'refusal')
        }
        a.store.retryContextReply(id, 'failed', 'compress')
        await a.waitIdle()
        const session = await a.db.loadSession(id)
        return { calls, checkpoint: session.compressionCheckpoint }
      })
      assert.ok(before.calls.length > 0)
      assert.ok(before.calls.every((call) => !/PENDING_QUESTION|pending\.docx/.test(call)))
      assert.equal(before.calls.filter((call) => call.includes('OLDER_TURN_4')).length, 1)
      assert.deepEqual(before.checkpoint.retainedRanges, [{ start: 0, end: 6 }])
      assert.equal(before.checkpoint.targetRounds, 6)

      await page.setViewportSize({ width: 320, height: 740 })
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      await page.evaluate(async () => {
        const a = window.__audit
        const ordinary = window.fetch
        window.__declinedCalls = []
        window.fetch = async (url, init) => {
          if (!String(url).endsWith('/messages')) return ordinary(url, init)
          const body = JSON.parse(init.body)
          window.__declinedCalls.push({
            messages: JSON.stringify(body.messages),
            safety: body.safety_check?.level,
            summary: Boolean(body.max_tokens),
          })
          return a.response('Continued in the same conversation')
        }
        await a.store.selectSession('declined-history')
      })
      const blocked = await page.evaluate(async () => {
        const a = window.__audit,
          id = 'declined-history'
        const preflight = a.store.compressionPreflight(id)
        const error = await a.store.compressSession(id).then(
          () => null,
          (error) => error.localMessage?.key
        )
        return { preflight, error, calls: window.__declinedCalls.length }
      })
      assert.equal(blocked.preflight.refused, true)
      assert.equal(blocked.preflight.available, false)
      assert.equal(blocked.error, 'compressionFailedRefused')
      assert.equal(blocked.calls, 0)
      await page.getByRole('button', { name: '保留上下文重试', exact: true }).click()
      const after = await page.evaluate(async () => {
        const a = window.__audit
        await a.waitIdle()
        const session = await a.db.loadSession('declined-history')
        return {
          calls: window.__declinedCalls,
          hasSummary: Boolean(session.contextSummary),
          retainedRounds: session.compressionCheckpoint?.retainedRanges,
          oldTurnPreserved: session.messages.find(({ id }) => id === 'old-4')?.content.endsWith('旧记录'),
          status: session.messages.at(-1).status,
          attachment: await (await a.db.loadFile('pending-document')).text(),
        }
      })
      assert.equal(after.calls.length, 1)
      for (let i = 0; i < 6; i++) {
        assert.ok(after.calls[0].messages.includes(`OLDER_TURN_${i}`))
      }
      assert.match(after.calls[0].messages, /PENDING_QUESTION/)
      assert.match(after.calls[0].messages, /file-api-pending-document/)
      assert.equal(after.calls[0].safety, 'high')
      assert.equal(after.calls[0].summary, false)
      assert.equal(after.hasSummary, false)
      assert.deepEqual(after.retainedRounds, [{ start: 0, end: 6 }])
      assert.equal(after.oldTurnPreserved, true)
      assert.equal(after.status, 'done')
      assert.equal(after.attachment, 'file-original')

      await page.evaluate(async () => {
        const a = window.__audit, id = 'declined-history'
        a.settings.setAutoCompress(true)
        const fetch = window.fetch
        window.fetch = async (url, init) => {
          if (String(url).endsWith('/messages')) {
            const body = JSON.parse(init.body)
            const messages = JSON.stringify(body.messages)
            if (body.max_tokens) {
              window.__declinedCalls.push({ messages, summary: true })
              return a.response('New excerpt refused', undefined, 'refusal')
            }
            if (!messages.includes('DOES_NOT_FIT')) return fetch(url, init)
            window.__declinedCalls.push({ messages, summary: false })
            return Response.json({
              error: { message: 'user input too long, 1100000 tokens exceeds max 1048576 tokens' },
            }, { status: 400 })
          }
          return fetch(url, init)
        }
        a.drafts.setDraftText(id, 'DOES_NOT_FIT')
        a.store.sendMessage(id)
        await a.waitIdle()
      })
      await page.getByText(/保留历史后，请求仍超出当前模型可处理的范围/).waitFor()
      await page.getByText(/服务端计数 1,100,000 \/ 1,048,576 tokens/).waitFor()
      assert.equal(await page.getByRole('button', { name: '压缩历史并重试', exact: true }).count(), 0)
      const attempts = await page.evaluate(() => window.__declinedCalls.slice(1))
      const sent = attempts.filter(({ summary }) => !summary)
      assert.equal(sent.length, 1)
      assert.match(sent[0].messages, /OLDER_TURN_4/)
      assert.match(sent[0].messages, /file-api-pending-document/)
      assert.ok(attempts.filter(({ summary }) => summary).every(({ messages }) => !messages.includes('OLDER_TURN_4')))
    }
  )

  await run(
    'automatic compression refusal sends the current turn and stays quiet across later turns and reload',
    async (page) => {
      const requests = []
      await page.route('https://refusing-summary.example/v1/chat/completions', async (route) => {
        const body = route.request().postDataJSON()
        const summary = body.messages[0]?.content.includes('Summarize the conversation')
        const messages = JSON.stringify(body.messages)
        const refused = summary && messages.includes('EARLIEST_FACT')
        requests.push({ summary, messages })
        await route.fulfill({
          json: {
            choices: [{
              message: { content: refused ? 'DECLINED_SUMMARY_OUTPUT' : summary ? 'LATER_SUMMARY' : '照常生成的回答。' },
              finish_reason: refused ? 'content_filter' : 'stop',
            }],
          },
        })
      })
      const id = 'long-auto-refusal'
      await page.evaluate(async (id) => {
        const a = window.__audit,
          f = a.fixtures
        const model = 'summary-fixture'
        a.providers.saveProvider({
          ...a.providers.emptyProfile(),
          name: '拒绝摘要的测试服务',
          model,
          models: [model],
          url: 'https://refusing-summary.example/v1',
          contextWindows: { [model]: 8192 },
          maxOutputTokens: 512,
          stream: false,
        }, true)
        a.settings.setAutoCompress(true)
        await a.seed([f.session({ id, messages: [
          f.user('origin', 'EARLIEST_FACT ' + '旧资料'.repeat(1950) + ' END_OF_HISTORY'),
          f.assistant('origin-reply', 'EARLIEST_ANSWER'),
          f.user('other', 'LATER_FACT'),
          f.assistant('other-reply', 'LATER_ANSWER'),
        ] })])
      }, id)
      const send = (question) => page.evaluate(async ({ id, question }) => {
        const a = window.__audit
        await a.store.selectSession(id)
        a.drafts.setDraftText(id, question)
        a.store.sendMessage(id)
        await a.waitIdle()
        const stored = await a.db.loadSession(id)
        const reply = stored.messages.at(-1)
        return {
          status: reply.status,
          error: reply.error?.localMessage?.key,
          keptRanges: stored.contextSummary?.retainedRanges,
        }
      }, { id, question })
      const first = await send('QUESTION_ONE')
      const second = await send('QUESTION_TWO')
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      const third = await send('QUESTION_AFTER_RELOAD')
      for (const reply of [first, second, third]) {
        assert.deepEqual(reply, { status: 'done', error: undefined, keptRanges: [{ start: 0, end: 1 }] })
      }
      assert.equal(requests.filter(({ summary, messages }) => summary && messages.includes('EARLIEST_FACT')).length, 1)
      assert.equal(requests.filter(({ summary }) => !summary).length, 3)
      assert.doesNotMatch(requests[0].messages, /QUESTION_ONE/)
      for (const { messages } of requests.filter(({ summary }) => !summary)) {
        assert.match(messages, /EARLIEST_FACT.*END_OF_HISTORY.*EARLIEST_ANSWER/)
        assert.match(messages, /LATER_SUMMARY/)
        assert.doesNotMatch(messages, /DECLINED_SUMMARY_OUTPUT/)
      }
      assert.match(requests.at(-1).messages, /QUESTION_AFTER_RELOAD/)
      assert.equal(await page.getByText(/模型拒绝生成这段聊天的摘要/).count(), 0)
    }
  )

  await run(
    'automatic recovery after a real context rejection only resends if it completed new summary coverage',
    async (page) => {
      const results = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        a.settings.setApiKey('fixture')
        a.settings.setAutoCompress(true)
        const fetch = window.fetch
        const earlier = 'COVERABLE_PREFIX ' + '早期记录'.repeat(550)
        const unfinished = 'UNFINISHED_START ' + '保留这段原文。'.repeat(12000) + ' UNFINISHED_END'
        const results = []
        for (const savesPrefix of [false, true]) {
          const id = 'server-context-' + savesPrefix
          await a.seed([f.session({ id, messages: [
            f.user('early', earlier),
            f.assistant('early-reply', 'EARLY_REPLY'),
            f.user('long', unfinished),
            f.assistant('long-reply', 'UNFINISHED_REPLY'),
          ] })])
          const summaryRequests = [], replyRequests = []
          window.fetch = async (url, init) => {
            if (!String(url).endsWith('/messages')) return fetch(url, init)
            const body = JSON.parse(init.body)
            if (body.max_tokens) {
              summaryRequests.push(JSON.stringify(body.messages))
              return savesPrefix && summaryRequests.length === 1
                ? a.response('APPROVED_PREFIX_SUMMARY')
                : a.response('DISCARDED_SUMMARY', undefined, 'refusal')
            }
            replyRequests.push(JSON.stringify(body.messages))
            return replyRequests.length === 1 || !savesPrefix
              ? Response.json({ error: { message: 'maximum context length is 1048576 tokens' } }, { status: 400 })
              : a.response('Resumed using the saved prefix.')
          }
          a.drafts.setDraftText(id, 'CURRENT_QUESTION')
          a.store.sendMessage(id)
          await a.waitIdle()
          const session = await a.db.loadSession(id), reply = session.messages.at(-1)
          results.push({
            summaries: summaryRequests.length,
            questionExcludedFromSummaries: summaryRequests.every((request) => !request.includes('CURRENT_QUESTION')),
            replies: replyRequests.map((request) => ({
              prefix: request.includes('COVERABLE_PREFIX'),
              summary: request.includes('APPROVED_PREFIX_SUMMARY'),
              unfinished: request.includes(unfinished) && request.includes('UNFINISHED_REPLY'),
              current: request.includes('CURRENT_QUESTION'),
              discarded: request.includes('DISCARDED_SUMMARY'),
            })),
            originalPreserved: session.messages[0].content === earlier && session.messages[2].content === unfinished,
            covered: session.contextSummary?.coveredRounds,
            retained: session.contextSummary?.retainedRanges ?? session.compressionCheckpoint?.retainedRanges,
            status: reply.status,
            error: reply.error?.localMessage?.key,
            reportedLimit: reply.error?.localMessage?.params?.contextLimitTokens,
          })
        }
        return results
      })
      const originalRequest = { prefix: true, summary: false, unfinished: true, current: true, discarded: false }
      assert.deepEqual(results, [
        {
          summaries: 2, questionExcludedFromSummaries: true, replies: [originalRequest],
          originalPreserved: true, covered: undefined, retained: [{ start: 0, end: 2 }],
          status: 'error', error: 'compressionRefusalTooLong', reportedLimit: 1048576,
        },
        {
          summaries: 2, questionExcludedFromSummaries: true,
          replies: [originalRequest, { ...originalRequest, prefix: false, summary: true }],
          originalPreserved: true, covered: 2, retained: [{ start: 1, end: 2 }],
          status: 'done', error: undefined, reportedLimit: undefined,
        },
      ])
    }
  )

  await run(
    'a saved refusal with no known boundary retains history even when the reply still exceeds the limit',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        a.settings.setApiKey('fixture')
        await a.seed([f.session({
          id: 'legacy-refusal',
          messages: [
            f.user('old', 'PREVIOUS_HISTORY'),
            f.assistant('old-reply', 'Earlier reply'),
            f.user('waiting', 'WAITING_WITHOUT_HISTORY'),
            f.assistant('failed', '', {
              status: 'error',
              error: {
                kind: 'protocol', message: '', localMessage: { key: 'compressionFailedRefused' },
              },
            }),
          ],
        })])
        const ordinary = window.fetch
        window.__legacyRefusalCalls = []
        window.fetch = async (url, init) => {
          if (!String(url).endsWith('/messages')) return ordinary(url, init)
          window.__legacyRefusalCalls.push(JSON.stringify(JSON.parse(init.body).messages))
          return Response.json({ error: { message: 'Maximum context length exceeded' } }, { status: 400 })
        }
      })
      assert.equal(await page.getByRole('button', { name: '用最近的聊天继续', exact: true }).count(), 0)
      await page.getByRole('button', { name: '保留上下文重试', exact: true }).click()
      const result = await page.evaluate(async () => {
        const a = window.__audit
        await a.waitIdle()
        const session = await a.db.loadSession('legacy-refusal')
        return {
          calls: window.__legacyRefusalCalls,
          old: session.messages[0].content,
          hasCut: Boolean(session.contextSummary),
          error: session.messages.at(-1).error?.localMessage?.key,
        }
      })
      assert.equal(result.calls.length, 1)
      assert.match(result.calls[0], /WAITING_WITHOUT_HISTORY/)
      assert.match(result.calls[0], /PREVIOUS_HISTORY/)
      assert.equal(result.old, 'PREVIOUS_HISTORY')
      assert.equal(result.hasCut, false)
      assert.equal(result.error, 'compressionRefusalTooLong')
      assert.equal(await page.getByRole('button', { name: '用最近的聊天继续', exact: true }).count(), 0)
    }
  )

  await run(
    'compression continues after a refusal, retaining the whole affected turn and its attachment across backup restore',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures,
          id = 'partial-compression'
        const initialMessages = [
          f.user('base', 'BASE_TURN ' + '原始记录'.repeat(1000)),
          f.assistant('base-reply', 'Earlier answer'),
        ]
        a.settings.setApiKey('fixture')
        await a.seed([f.session({ id, messages: initialMessages })])
        const ordinary = window.fetch
        const summaryRequests = [], answerRequests = []
        let longSegments = 0
        window.fetch = async (url, init) => {
          if (!String(url).endsWith('/messages')) return ordinary(url, init)
          const body = JSON.parse(init.body)
          if (!body.max_tokens) {
            answerRequests.push(JSON.stringify(body.messages))
            return a.response('Reply with kept context')
          }
          const input = JSON.parse(body.messages[0].content)
          summaryRequests.push(input)
          if (input.conversation_excerpt.includes('BASE_TURN')) {
            return a.response('BASE_APPROVED_SUMMARY')
          }
          if (input.conversation_excerpt.includes('NEVER_DROP_THE_ORIGINAL')) {
            return ++longSegments === 1
              ? a.response(input.previous_summary + ' PARTIAL_AFFECTED_TURN')
              : a.response('REJECTED_OUTPUT', undefined, 'refusal')
          }
          return a.response(input.previous_summary + (
            input.conversation_excerpt.includes('COVERED_AFTER_REFUSAL')
              ? ' and LATER_APPROVED_SUMMARY'
              : ' and NEW_APPROVED_SUMMARY'
          ))
        }
        await a.store.compressSession(id)
        const original = await a.db.loadSession(id)
        const unfinished = 'KEEP_THE_START ' + '这是一段较长的内容。NEVER_DROP_THE_ORIGINAL '.repeat(4500) + ' KEEP_THE_END'
        const file = {
          id: 'refused-original', serverId: 'file-api-refused-original', name: 'refused.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: 13, isImage: false,
        }
        await a.seed([{ ...original, messages: [
          ...initialMessages,
          f.user('one', 'COVERED_1 ' + '早期资料'.repeat(1400)),
          f.assistant('one-reply', 'Next reply'),
          f.user('two', 'COVERED_2'),
          f.assistant('two-reply', 'Next reply'),
          f.user('long', unfinished, { files: [file] }),
          f.assistant('long-reply', 'Retain this reply in full'),
          f.user('following', 'COVERED_AFTER_REFUSAL ' + '后续需要压缩的历史。'.repeat(1700)),
          f.assistant('following-reply', 'Latest reply'),
          f.user('pending', 'WAITING_QUESTION'),
          f.assistant('failed', '', {
            status: 'error',
            error: {
              kind: 'http', status: 400, message: '', localMessage: { key: 'replyContextTooLong' },
            },
          }),
        ] }], [{ id: file.id, blob: new Blob(['file-original']) }])
        a.store.retryContextReply(id, 'failed', 'compress')
        await a.waitIdle()
        const afterCompression = await a.db.loadSession(id)
        const exported = (await a.backup.exportHistory()).blob
        await a.backup.importHistory(new File([exported], 'refusal.zip'), undefined, async () => new Set([id]))
        a.store.selectSession(id)
        const chatStore = a.store.useChatStore
        if (!chatStore.getState().sessionCache[id]) {
          await new Promise((resolve) => {
            const unsubscribe = chatStore.subscribe((state) => {
              if (state.sessionCache[id]) {
                unsubscribe()
                resolve()
              }
            })
          })
        }
        // The restored file can have a new local ID. Keep the responder deterministic for its upload.
        a.settings.setAutoCompress(false)
        a.drafts.setDraftText(id, 'NEXT_QUESTION')
        if (!a.store.sendMessage(id)) throw new Error('Could not send in the restored chat')
        await a.waitIdle()
        const stored = await a.db.loadSession(id)
        const longTurn = stored.messages.find(({ id }) => id === 'long')
        const importedOriginal = await (await a.db.loadFile(longTurn.files[0].id)).text()
        const current = a.store.currentContextSummary(stored)
        const { retainedRanges, ...legacySummary } = stored.contextSummary
        return {
          longSegments,
          includedPending: summaryRequests.some(({ conversation_excerpt }) => conversation_excerpt.includes('WAITING_QUESTION')),
          laterPrevious: summaryRequests.find(({ conversation_excerpt }) =>
            conversation_excerpt.includes('COVERED_AFTER_REFUSAL')
          )?.previous_summary,
          retainedRanges,
          covered: current?.coveredRounds,
          legacyWouldUseSummary: Boolean(a.store.currentContextSummary({ ...stored, contextSummary: legacySummary })),
          appliedText: stored.contextSummary?.text,
          savings: current.historyEstimate.before - current.historyEstimate.after,
          keptHistorySize: current.historyEstimate.after,
          untouched: longTurn.content === unfinished,
          importedOriginal,
          firstDone: afterCompression.messages.at(-1).status,
          history: answerRequests.map((raw) => ({
            unfinished: raw.includes(unfinished) && raw.includes('Retain this reply in full'),
            approved: raw.includes('LATER_APPROVED_SUMMARY'),
            duplicates: /COVERED_1|COVERED_2|BASE_TURN|COVERED_AFTER_REFUSAL/.test(raw),
            rejected: /REJECTED_OUTPUT|PARTIAL_AFFECTED_TURN/.test(raw),
          })),
          done: stored.messages.at(-1).status,
        }
      })
      assert.equal(result.longSegments, 2)
      assert.equal(result.includedPending, false)
      assert.equal(result.laterPrevious, 'BASE_APPROVED_SUMMARY and NEW_APPROVED_SUMMARY')
      assert.equal(result.appliedText, 'BASE_APPROVED_SUMMARY and NEW_APPROVED_SUMMARY and LATER_APPROVED_SUMMARY')
      assert.equal(result.covered, 5)
      assert.deepEqual(result.retainedRanges, [{ start: 3, end: 4 }])
      assert.equal(result.legacyWouldUseSummary, false)
      assert.equal(result.untouched, true)
      assert.equal(result.importedOriginal, 'file-original')
      assert.ok(result.savings > 10000)
      assert.ok(result.keptHistorySize > 50000)
      assert.equal(result.firstDone, 'done')
      const kept = { unfinished: true, approved: true, duplicates: false, rejected: false }
      assert.deepEqual(result.history, [kept, kept])
      assert.equal(result.done, 'done')
    }
  )

  await run(
    'compression resumes after a skipped segment without resending it when a later segment fails',
    async (page) => {
      let serverDown = true
      const events = []
      await page.route('https://resume-after-refusal.example/v1/chat/completions', async (route) => {
        const { messages } = route.request().postDataJSON()
        const summary = messages[0]?.content.includes('Summarize the conversation')
        const text = JSON.stringify(messages)
        const refused = summary && text.includes('KEEP_VERBATIM')
        events.push(summary ? refused ? 'refused' : 'later-summary' : 'reply')
        if (summary && !refused && serverDown) {
          await route.fulfill({ status: 503, json: { error: { message: 'Service is unavailable' } } })
        } else {
          await route.fulfill({
            json: {
              choices: [{
                message: { content: summary ? 'SUMMARY_OF_LATER_HISTORY' : '收到这次提问。' },
                finish_reason: refused ? 'content_filter' : 'stop',
              }],
            },
          })
        }
        if (!summary) {
          assert.match(text, /KEEP_VERBATIM/)
          assert.match(text, /SUMMARY_OF_LATER_HISTORY/)
          assert.match(text, /WAITING_AFTER_REFUSAL/)
          assert.doesNotMatch(text, /LATER_HISTORY_BODY/)
        }
      })
      const checkpoint = await page.evaluate(async () => {
        const a = window.__audit, f = a.fixtures
        const id = 'resume-after-refusal', model = 'small-window'
        a.providers.saveProvider({
          ...a.providers.emptyProfile(), model, models: [model], name: '恢复压缩测试',
          url: 'https://resume-after-refusal.example/v1',
          contextWindows: { [model]: 8192 }, maxOutputTokens: 512, stream: false,
        }, true)
        a.settings.setAutoCompress(true)
        await a.seed([f.session({ id, messages: [
          f.user('old', 'KEEP_VERBATIM '.repeat(2000)),
          f.assistant('old-reply', '保留原文。'),
          f.user('later', 'LATER_HISTORY_BODY ' + '后续历史。'.repeat(320)),
          f.assistant('later-reply', '整理这一轮。'),
        ] })])
        a.drafts.setDraftText(id, 'WAITING_AFTER_REFUSAL')
        a.store.sendMessage(id)
        await a.waitIdle()
        const stored = await a.db.loadSession(id)
        return stored.compressionCheckpoint
      })
      assert.deepEqual(checkpoint.retainedRanges, [{ start: 0, end: 1 }])
      assert.ok(checkpoint.offset > 0)
      assert.deepEqual(events, ['refused', 'later-summary'])
      serverDown = false
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      await page.evaluate(() => window.__audit.store.selectSession('resume-after-refusal'))
      await page.getByRole('button', { name: '继续压缩', exact: true }).click()
      await page.getByText('收到这次提问。', { exact: true }).waitFor()
      assert.deepEqual(events, ['refused', 'later-summary', 'later-summary', 'reply'])
    }
  )

  await run(
    'compression resumes completed segments after reload and sends the waiting question only after saving the summary',
    async (page) => {
      const before = await page.evaluate(async () => {
        const a = window.__audit
        const f = a.fixtures
        a.settings.setApiKey('fixture')
        const file = {
          id: 'waiting-file',
          serverId: 'file-api-waiting',
          name: 'waiting.docx',
          size: 64,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          isImage: false,
        }
        const messages = [
          f.user('old', 'START_MARKER ' + '早期资料'.repeat(35000) + ' END_MARKER'),
          f.assistant('old-answer', 'Earlier answer'),
          f.user('waiting-question', 'WAITING_QUESTION_MARKER', { files: [file] }),
          f.assistant('waiting-reply', '', {
            status: 'error',
            error: {
              kind: 'http',
              status: 400,
              message: '',
              localMessage: { key: 'replyContextTooLong' },
            },
          }),
        ]
        await a.seed([
          f.session({ id: 'resume-compression', title: 'Resume compression', messages }),
        ])
        const fetch = window.fetch
        const excerpts = []
        let answerCalls = 0
        window.fetch = async (url, init) => {
          if (!String(url).endsWith('/messages')) return fetch(url, init)
          const body = JSON.parse(init.body)
          if (!body.max_tokens) {
            answerCalls++
            return a.response('Premature answer')
          }
          const { conversation_excerpt: excerpt, previous_summary: previous } = JSON.parse(
            body.messages[0].content
          )
          excerpts.push({
            size: excerpt.length,
            starts: excerpt.includes('START_MARKER'),
            previous,
          })
          if (excerpts.length === 1) return a.response('Verified first segment')
          return new Response('data: {"error":{"message":"Generation start timed out"}}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          })
        }
        a.store.retryContextReply('resume-compression', 'waiting-reply', 'compress')
        await a.waitIdle()
        const stored = await a.db.loadSession('resume-compression')
        return {
          excerpts,
          answerCalls,
          checkpoint: stored.compressionCheckpoint,
          error: stored.messages.at(-1).error?.localMessage?.key,
          activeSummary: stored.contextSummary?.text ?? null,
        }
      })
      assert.equal(before.answerCalls, 0)
      assert.equal(before.error, 'compressionFailedNetwork')
      assert.equal(before.activeSummary, null)
      assert.equal(before.excerpts.length, 2)
      assert.equal(before.excerpts[0].starts, true)
      assert.equal(before.checkpoint.offset, before.excerpts[0].size)
      assert.equal(before.checkpoint.text, 'Verified first segment')
      assert.ok(before.excerpts.every(({ size }) => size <= 32768))
      await page.reload()
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      await page.evaluate(() => window.__audit.store.selectSession('resume-compression'))
      await page.waitForFunction(() =>
        Boolean(window.__audit.store.useChatStore.getState().sessionCache['resume-compression'])
      )
      const resumed = await page.evaluate(async () => {
        const a = window.__audit
        const fetch = window.fetch
        const calls = []
        window.fetch = async (url, init) => {
          if (!String(url).endsWith('/messages')) return fetch(url, init)
          const body = JSON.parse(init.body)
          if (body.max_tokens) {
            const { conversation_excerpt: excerpt, previous_summary: previous } = JSON.parse(
              body.messages[0].content
            )
            calls.push({ kind: 'summary', excerpt, previous })
            return a.response('Completed history summary')
          }
          const session = a.store.useChatStore.getState().sessionCache['resume-compression']
          calls.push({
            kind: 'answer',
            body: JSON.stringify(body.messages),
            summaryAtSend: session.contextSummary?.text,
            checkpointAtSend: Boolean(session.compressionCheckpoint),
          })
          return a.response('Answer after resume')
        }
        a.store.retryContextReply('resume-compression', 'waiting-reply', 'compress')
        await a.waitIdle()
        const session = await a.db.loadSession('resume-compression')
        return {
          calls,
          status: session.messages.at(-1).status,
          originalStart: session.messages[0].content.startsWith('START_MARKER'),
          originalFile: session.messages[2].files[0].id,
        }
      })
      assert.equal(resumed.status, 'done')
      assert.ok(resumed.originalStart)
      assert.equal(resumed.originalFile, 'waiting-file')
      const summaries = resumed.calls.slice(0, -1)
      assert.ok(summaries.length > 0 && summaries.every(({ kind }) => kind === 'summary'))
      assert.equal(summaries[0].previous, 'Verified first segment')
      const calledHistory = summaries.map(({ excerpt }) => excerpt).join('')
      assert.doesNotMatch(calledHistory, /START_MARKER|WAITING_QUESTION_MARKER|waiting\.docx/)
      assert.match(calledHistory, /END_MARKER/)
      const answer = resumed.calls.at(-1)
      assert.equal(answer.kind, 'answer')
      assert.equal(answer.summaryAtSend, 'Completed history summary')
      assert.equal(answer.checkpointAtSend, false)
      assert.match(answer.body, /WAITING_QUESTION_MARKER/)
      assert.match(answer.body, /file-api-waiting/)
    }
  )

  await run(
    'compression cancels a stalled summary even when the service keeps sending heartbeats',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit
        const f = a.fixtures
        a.settings.setApiKey('fixture')
        await a.seed([
          f.session({
            id: 'stalled-summary',
            messages: [
              f.user('old-question', 'Earlier history'),
              f.assistant('old-reply', 'Earlier reply'),
            ],
          }),
        ])
        const schedule = window.setTimeout
        const fetch = window.fetch
        let cancelled = false
        window.setTimeout = (callback, delay, ...args) =>
          schedule(callback, delay === 180000 ? 60 : delay, ...args)
        window.fetch = (url, init) => {
          if (!String(url).endsWith('/messages')) return fetch(url, init)
          const heartbeat = new TextEncoder().encode(': keep-alive\n\n')
          let interval
          return Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(heartbeat)
                  interval = setInterval(() => controller.enqueue(heartbeat), 5)
                },
                cancel() {
                  cancelled = true
                  clearInterval(interval)
                },
              }),
              { headers: { 'Content-Type': 'text/event-stream' } }
            )
          )
        }
        try {
          await a.store.compressSession('stalled-summary')
          return null
        } catch (error) {
          return {
            key: error.localMessage?.key,
            cancelled,
            settled: !a.store.useChatStore.getState().compressing['stalled-summary'],
          }
        } finally {
          window.setTimeout = schedule
          window.fetch = fetch
        }
      })
      assert.deepEqual(result, { key: 'compressionFailedNetwork', cancelled: true, settled: true })
    }
  )

  await run(
    'compression preserves the last good summary after refusal or cancellation and isolates history branches',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        const session = f.session({
          id: 'branches',
          messages: Array.from({ length: 7 }, (_, i) => [
            f.user('u' + i, 'fact ' + i),
            f.assistant('a' + i, 'reply ' + i),
          ]).flat(),
        })
        await a.seed([session])
        a.settings.setApiKey('fixture')
        let mode = 'ok',
          notify,
          raw,
          ordinary = window.fetch
        window.fetch = async (url, init) => {
          if (!String(url).endsWith('/messages')) return ordinary(url, init)
          const body = JSON.parse(init.body)
          if (!body.max_tokens) {
            raw = JSON.stringify(body.messages)
            return a.response('answer')
          }
          if (mode === 'refuse') return a.response('refused', undefined, 'refusal')
          if (mode === 'bloat') return a.response('too long to save space '.repeat(100))
          if (mode === 'wait') {
            notify()
            return new Promise((_, reject) =>
              init.signal.addEventListener(
                'abort',
                () => reject(new DOMException('Stopped', 'AbortError')),
                { once: true }
              )
            )
          }
          return a.response('initial verified summary')
        }
        const current = () => a.store.useChatStore.getState().sessionCache.branches
        const first = await a.store.compressSession('branches')
        mode = 'wait'
        const started = new Promise((resolve) => (notify = resolve))
        const pending = a.store.compressSession('branches').then(
          () => false,
          () => true
        )
        await started
        a.store.stopReply('branches')
        const cancelled = await pending
        mode = 'refuse'
        const refused = await a.store.compressSession('branches').then(
          () => false,
          (error) => error.localMessage?.key === 'compressionFailedRefused'
        )
        const preserved = a.store.currentContextSummary(current())?.text === first.text
        const edited = a.store.editContextSummary(
          'branches', a.store.currentContextSummary(current()), 'verified edited summary'
        )
        mode = 'bloat'
        const noSavings = await a.store.compressSession('branches').then(
          () => null,
          (error) => error.localMessage?.key
        )
        const intact =
          a.store.currentContextSummary(current())?.text === 'verified edited summary' &&
          current().messages.length === 14
        a.store.startInheritSession('branches')
        const inherited = a.store.useChatStore.getState().inheritFrom
        a.store.cancelInherit()
        mode = 'ok'
        a.store.editMessage('branches', 'u0', 'edited first turn')
        await a.waitIdle()
        const changed = a.store.currentContextSummary(current())
        a.store.selectMessageVersion('branches', 'u0')
        return {
          refused,
          cancelled,
          preserved,
          edited,
          noSavings,
          intact,
          inherited: inherited.contextSummary?.text,
          changed: !!changed,
          mixed: raw.includes('verified edited summary'),
          restored: a.store.currentContextSummary(current())?.text,
        }
      })
      assert.deepEqual(result, {
        refused: true,
        cancelled: true,
        preserved: true,
        edited: true,
        noSavings: 'compressionFailedNoSavings',
        intact: true,
        inherited: 'verified edited summary',
        changed: false,
        mixed: false,
        restored: 'verified edited summary',
      })
    }
  )

  await run(
    'compression accepts a compatible stream that finishes with [DONE] and no finish_reason',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        const model = 'compat-stream'
        a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: 'Compat',
            model,
            models: [model],
            url: 'https://compat.example/v1',
            stream: true,
            maxOutputTokens: 512,
          },
          true
        )
        await a.seed([
          f.session({
            id: 'compat',
            messages: [
              f.user('u0', '旧记录'.repeat(3000)),
              f.assistant('a0', '答案'),
              ...Array.from({ length: 4 }, (_, i) => [
                f.user('u' + (i + 1), 'recent-' + i),
                f.assistant('a' + (i + 1), 'reply-' + i),
              ]).flat(),
            ],
          }),
        ])
        const ordinary = window.fetch
        let summaries = 0
        window.fetch = async (url, init) => {
          if (!String(url).includes('compat.example/')) return ordinary(url, init)
          const body = JSON.parse(init.body)
          if (String(body.messages[0].content).includes('Summarize the conversation')) {
            summaries += 1
            // 兼容接口的常见写法：只有正文和 [DONE]，没有 finish_reason，也没有 message_stop
            const sse =
              'data: ' +
              JSON.stringify({ choices: [{ delta: { content: 'Compact notes ' + summaries } }] }) +
              '\n\ndata: [DONE]\n\n'
            return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } })
          }
          return a.response('ok')
        }
        const summary = await a.store.compressSession('compat')
        return { summaries, text: summary.text }
      })
      assert.equal(result.summaries, 1)
      assert.equal(result.text, 'Compact notes 1', 'the summary is used instead of being rejected')
    }
  )

  await run(
    'compatible providers distinguish explicit refusals from completed summaries',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        const cases = [
          {
            protocol: 'openai',
            events: [
              { choices: [{ delta: { content: 'Discard this partial summary' } }] },
              { choices: [{ delta: {}, finish_reason: 'content_filter' }] },
            ],
          },
          {
            protocol: 'responses',
            events: [
              { type: 'response.refusal.delta', delta: 'Provider refusal' },
              { type: 'response.completed', response: { output: [] } },
            ],
          },
          {
            protocol: 'gemini',
            events: [{ promptFeedback: { blockReason: 'SAFETY' } }],
          },
          {
            protocol: 'anthropic',
            events: [{ type: 'message_delta', delta: { stop_reason: 'refusal' } }],
          },
          { protocol: 'openai', events: null },
        ]
        const ordinary = window.fetch
        const results = []
        for (const [i, { protocol, events }] of cases.entries()) {
          const id = 'refusal-' + i,
            model = 'compatible-model'
          a.providers.saveProvider(
            {
              ...a.providers.emptyProfile(),
              name: 'Compatibility fixture',
              protocol,
              model,
              models: [model],
              url: 'https://compat.example/v1',
              stream: true,
              maxOutputTokens: 512,
            },
            true
          )
          await a.seed([f.session({ id, messages: [
            f.user('old', '历史记录'.repeat(400)),
            f.assistant('old-reply', 'Earlier reply'),
          ] })])
          let calls = 0
          window.fetch = async (url, init) => {
            if (!String(url).includes('compat.example/')) return ordinary(url, init)
            calls++
            return events
              ? new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
                  headers: { 'Content-Type': 'text/event-stream' },
                })
              : Response.json({ error: { code: 'content_policy_violation' } }, { status: 400 })
          }
          const attempt = () => a.store.compressSession(id).then(
            () => null,
            (error) => error.localMessage?.key
          )
          const first = await attempt()
          const repeat = await attempt()
          const stored = await a.db.loadSession(id)
          results.push({
            first, repeat, calls,
            retained: stored.compressionCheckpoint?.retainedRanges,
            text: stored.compressionCheckpoint?.text,
            hasSummary: Boolean(stored.contextSummary),
          })
        }
        return results
      })
      for (const outcome of result) {
        assert.deepEqual(outcome, {
          first: 'compressionFailedRefused',
          repeat: 'compressionFailedRefused',
          calls: 1,
          retained: [{ start: 0, end: 1 }],
          text: '',
          hasSummary: false,
        })
      }
    }
  )

  await run(
    'a custom model without a configured window compresses a long history in one pass and is honest about short ones',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        const model = 'no-window'
        a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: 'NoWindow',
            model,
            models: [model],
            url: 'https://nowindow.example/v1',
            stream: false,
            maxOutputTokens: 512,
          },
          true
        )
        // 约 15000 字 ≈ 18000 估算 token：按旧的 8192 窗口要切三块，按新的 32768 一块就够
        await a.seed([
          f.session({
            id: 'no-window-long',
            messages: [
              f.user('u0', '中'.repeat(15000)),
              f.assistant('a0', '答案'),
              ...Array.from({ length: 4 }, (_, i) => [
                f.user('u' + (i + 1), 'recent-' + i),
                f.assistant('a' + (i + 1), 'reply-' + i),
              ]).flat(),
            ],
          }),
          f.session({
            id: 'no-window-short',
            messages: [
              f.user('s0', '很短的一句'),
              f.assistant('s1', '好'),
              f.user('s2', '再来一句'),
              f.assistant('s3', '嗯'),
            ],
          }),
        ])
        const ordinary = window.fetch
        let summaryRequests = 0
        window.fetch = async (url, init) => {
          if (!String(url).includes('nowindow.example/')) return ordinary(url, init)
          const body = JSON.parse(init.body)
          if (String(body.messages[0].content).includes('Summarize the conversation')) {
            summaryRequests += 1
            return new Response(
              JSON.stringify({
                model,
                choices: [{ message: { content: 'Compact notes' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 5, completion_tokens: 3 },
              }),
              { headers: { 'Content-Type': 'application/json' } }
            )
          }
          return a.response('ok')
        }
        const longPreflight = a.store.compressionPreflight('no-window-long')
        const long = await a.store.compressSession('no-window-long')
        const summary = a.store.currentContextSummary(
          a.store.useChatStore.getState().sessionCache['no-window-long']
        )
        const shortPreflight = a.store.compressionPreflight('no-window-short')
        return {
          summaryRequests,
          covered: long.coveredRounds,
          text: summary?.text,
          shortPreflight,
          longPreflight,
        }
      })
      assert.equal(result.summaryRequests, 1, 'a 32k default window fits this history in one chunk')
      assert.equal(result.covered, 1)
      assert.equal(result.text, 'Compact notes')
      assert.equal(result.shortPreflight.saves, false, 'a short history is reported as not worth compressing')
      assert.equal(result.longPreflight.saves, true)
    }
  )

  await run(
    'compression retries without reasoning parameters when a proxy rejects them',
    async (page) => {
      const result = await page.evaluate(async () => {
        const a = window.__audit,
          f = a.fixtures
        const model = 'strict-proxy'
        a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: 'Strict',
            model,
            models: [model],
            url: 'https://strict.example/v1',
            stream: false,
            maxOutputTokens: 512,
            // 让这个模型带上 reasoning 控制（thinking: disabled），模拟认识/不认识该参数的代理
            modelSettings: { [model]: { reasoningAdapter: 'deepseek' } },
          },
          true
        )
        await a.seed([
          f.session({
            id: 'strict',
            messages: [
              f.user('u0', '旧记录'.repeat(3000)),
              f.assistant('a0', '答案'),
              ...Array.from({ length: 4 }, (_, i) => [
                f.user('u' + (i + 1), 'recent-' + i),
                f.assistant('a' + (i + 1), 'reply-' + i),
              ]).flat(),
            ],
          }),
        ])
        const ordinary = window.fetch
        let rejected = 0,
          accepted = 0
        window.fetch = async (url, init) => {
          if (!String(url).includes('strict.example/')) return ordinary(url, init)
          const body = JSON.parse(init.body)
          if (!String(body.messages[0].content).includes('Summarize the conversation')) {
            return a.response('ok')
          }
          if (
            body.thinking ||
            body.enable_thinking !== undefined ||
            body.reasoning_effort !== undefined ||
            body.reasoning !== undefined
          ) {
            rejected += 1
            return new Response(
              JSON.stringify({ error: { message: 'unknown parameter: thinking' } }),
              { status: 400 }
            )
          }
          accepted += 1
          return new Response(
            JSON.stringify({
              model,
              choices: [{ message: { content: 'Compact notes' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 5, completion_tokens: 3 },
            }),
            { headers: { 'Content-Type': 'application/json' } }
          )
        }
        const summary = await a.store.compressSession('strict')
        const logs = (await a.diagnostics.readDiagnosticLogs()).events.some(
          (event) => event.event === 'compression.reasoning-params-rejected'
        )
        return { rejected, accepted, text: summary.text, logs }
      })
      assert.equal(result.rejected, 1, 'the first request carries the reasoning controls')
      assert.equal(result.accepted, 1, 'the retry drops them instead of failing')
      assert.equal(result.text, 'Compact notes')
      assert.equal(result.logs, true)
    }
  )
}
