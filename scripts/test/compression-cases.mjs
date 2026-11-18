import assert from 'node:assert/strict'

export const runCompressionCases = async (run) => {
  await run(
    'compression asks before charging, sends unchanged on request and archives edited summaries',
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
        a.drafts.setDraftText('long', 'second question')
        a.store.sendMessage('long')
        await a.waitIdle()
        const second = state().messages.at(-1)
        a.store.retryContextReply('long', second.id, 'compress')
        await a.waitIdle()
        const summarized = a.store.currentContextSummary(state())
        if (!summarized)
          throw Error('Missing summary: ' + JSON.stringify(state().messages.at(-1).error))
        const edited = a.store.editContextSummary('long', summarized, 'User edited facts')
        const blob = (await a.backup.exportHistory()).blob
        await a.backup.importHistory(new File([blob], 'test.zip'))
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
          oldIntact: restored.messages[0].content === old,
          oldSent: JSON.stringify(sent[0]).includes('🌊末尾'),
          edited,
          editedNote: restored.contextSummary.text,
          originalFile: await (await a.db.loadFile(file.id)).text(),
          compactReply:
            restored.messages.at(-1).id === second.id && restored.messages.at(-1).status === 'done',
          inputs: chunks.join(''),
          summaries,
          models: [...new Set(modelIds)],
          activePersona: sent[1]?.messages[0]?.content,
          compactPayload: JSON.stringify(sent[1]),
          restoredPayload: JSON.stringify(sent[2]),
          charges: restored.compressionUsage.length,
          chunkCount: chunks.length,
          unpriced: stats.total.unpricedRequests,
        }
      })
      assert.deepEqual(result.asked, ['compressionSuggested', 0, 0])
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
      await page.getByText(/未能生成完整摘要/).waitFor()
      assert.deepEqual(await page.evaluate(() => window.__contextRecoveryOrder), [
        'summary',
        'summary-interrupted',
      ])
      await page.getByRole('button', { name: '整理并压缩上下文', exact: true }).click()
      await page.waitForFunction(() => typeof window.__finishContextSummary === 'function')
      assert.deepEqual(await page.evaluate(() => window.__contextRecoveryOrder), [
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
          summaryRequests: requests.slice(0, 2).map((request) => JSON.stringify(request.messages)),
          retry: JSON.stringify(requests[2].messages),
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
        mode = 'refuse'
        const refused = await a.store.compressSession('branches').then(
          () => false,
          () => true
        )
        mode = 'wait'
        const started = new Promise((resolve) => (notify = resolve))
        const pending = a.store.compressSession('branches').then(
          () => false,
          () => true
        )
        await started
        a.store.stopReply('branches')
        const cancelled = await pending
        const intact =
          a.store.currentContextSummary(current())?.text === first.text &&
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
          intact,
          inherited: inherited.contextSummary?.text,
          changed: !!changed,
          mixed: raw.includes('initial verified summary'),
          restored: a.store.currentContextSummary(current())?.text,
        }
      })
      assert.deepEqual(result, {
        refused: true,
        cancelled: true,
        intact: true,
        inherited: 'initial verified summary',
        changed: false,
        mixed: false,
        restored: 'initial verified summary',
      })
    }
  )
}
