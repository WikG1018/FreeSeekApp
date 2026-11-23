import assert from 'node:assert/strict'

export const runTaskReaderCases = async (run) => {
  await run(
    'Agent reader pins GitHub, seeks long documents and resumes issue pagination',
    async (page) => {
      const result = await page.evaluate(async () => {
        const { createTaskWeb } = window.__audit.taskReaderWeb
        const repo = 'https://github.com/sample-org/engineering-demo'
        const sha = '4'.repeat(40)
        const newer = '5'.repeat(40)
        const requests = []
        const prior = window.fetch
        const docs = {
          'CHANGELOG.md':
            'Changelog record with detailed evidence.\n'.repeat(1200) +
            'Release verification marker',
          'PROJECT_NOTES.md':
            'Project note with requirements.\n'.repeat(1050) + 'Coordinator signoff marker',
        }
        let commitQueries = 0
        window.fetch = async (address, init) => {
          const url = new URL(address)
          if (url.hostname !== 'api.github.com' && url.hostname !== 'raw.githubusercontent.com') {
            return prior(address, init)
          }
          requests.push([url.href, init.credentials])
          if (url.pathname.endsWith('/commits')) {
            return Response.json([{ sha: ++commitQueries === 1 ? sha : newer }])
          }
          if (url.pathname.endsWith('/pulls')) {
            return new Response('', {
              status: 403,
              headers: { 'x-ratelimit-remaining': '0', 'retry-after': '30' },
            })
          }
          if (url.pathname.endsWith('/issues')) {
            const first = url.searchParams.get('page') === '1'
            return Response.json(
              first
                ? [
                    { number: 13, title: 'Open an issue', state: 'open', body: 'Read me' },
                    { number: 17, title: 'Exclude pull in issue list', pull_request: {} },
                  ]
                : [{ number: 19, title: 'Second page', state: 'closed' }],
              {
                headers: first
                  ? { link: '<https://api.github.com/repositories/17/issues?page=2>; rel="next"' }
                  : {},
              }
            )
          }
          const name = url.pathname.split('/').at(-1)
          if (url.pathname.includes('/' + sha + '/') && Object.hasOwn(docs, name)) {
            return new Response(docs[name], {
              headers: { 'content-type': 'text/plain; charset=utf-8' },
            })
          }
          return new Response('', { status: 404 })
        }
        try {
          const signal = new AbortController().signal
          const read = (session, input) =>
            session
              .prepare('browse_github_repository', {
                repository_url: repo,
                ...input,
              })
              .read(5000)
          const session = createTaskWeb([repo], signal)
          const changelog = await read(session, {
            action: 'file',
            path: 'CHANGELOG.md',
            find: 'Release verification marker',
          })
          const ranged = await read(session, {
            action: 'file',
            path: 'CHANGELOG.md',
            start_line: 1201,
            end_line: 1201,
          })
          const notes = await read(session, {
            action: 'file',
            path: 'PROJECT_NOTES.md',
            find: 'Coordinator signoff marker',
          })
          const first = await read(session, { action: 'issues', state: 'all' })
          const firstCheckpoint = session.checkpoint()
          const resumed = createTaskWeb([repo], signal, firstCheckpoint)
          const reread = await read(resumed, {
            action: 'file',
            path: 'CHANGELOG.md',
            start_line: 1201,
            end_line: 1201,
          })
          const second = await read(resumed, {
            action: 'issues',
            state: 'all',
            cursor: first.evidence.nextCursor,
          })
          const limited = await read(resumed, { action: 'pulls' })
          const blockedRetry = await read(resumed, { action: 'pulls', state: 'closed' })
          const restoredRetry = await read(createTaskWeb([repo], signal, resumed.checkpoint()), {
            action: 'pulls',
          })
          return {
            sha,
            requests,
            changelog,
            ranged,
            notes,
            first,
            second,
            reread,
            limited,
            blockedRetry,
            restoredRetry,
            checkpointBytes: new TextEncoder().encode(JSON.stringify(firstCheckpoint)).byteLength,
          }
        } finally {
          window.fetch = prior
        }
      })
      assert.notEqual(result.changelog.isError, true)
      assert.match(result.changelog.text, /Release verification marker/)
      assert.match(result.notes.text, /Coordinator signoff marker/)
      assert.equal(result.changelog.evidence.revision, result.sha)
      assert.ok(result.changelog.evidence.downloadedBytes >= 46 * 1024)
      assert.ok(result.notes.evidence.downloadedBytes >= 31 * 1024)
      assert.ok(result.changelog.evidence.deliveredChars < 1200)
      assert.equal(result.changelog.evidence.partial, true)
      assert.equal(result.changelog.evidence.sourceTruncated, false)
      assert.deepEqual(result.ranged.evidence.range, { start: 1201, end: 1201, unit: 'lines' })
      assert.equal(result.reread.evidence.sourceId, result.ranged.evidence.sourceId)
      assert.equal(result.reread.evidence.retrievedAt, result.ranged.evidence.retrievedAt)
      assert.equal(result.first.evidence.nextCursor, 'p2')
      assert.doesNotMatch(result.first.text, /Exclude pull in issue list/)
      assert.match(result.second.text, /Second page/)
      assert.equal(result.second.evidence.nextCursor, undefined)
      assert.equal(result.limited.failure, 'rate-limit')
      assert.equal(result.limited.retryAt, result.blockedRetry.retryAt)
      assert.equal(result.limited.retryAt, result.restoredRetry.retryAt)
      assert.ok(result.checkpointBytes <= 512 * 1024)
      assert.equal(result.requests.filter(([url]) => url.includes('/commits')).length, 1)
      assert.equal(result.requests.filter(([url]) => url.endsWith('/CHANGELOG.md')).length, 1)
      assert.equal(result.requests.filter(([url]) => url.includes('/pulls')).length, 1)
      assert.ok(result.requests.every(([, credentials]) => credentials === 'omit'))
    }
  )

  await run(
    'Agent reader distinguishes exhausted local fetch slots from ordinary HTTP denial',
    async (page) => {
      const result = await page.evaluate(async () => {
        const prefix = 'https://api.github.com/repos/sample-org/demo/read/'
        const urls = Array.from({ length: 25 }, (_, index) => prefix + index)
        const previous = window.fetch
        let requests = 0
        window.fetch = async (address, init) => {
          if (String(address).startsWith(prefix)) {
            requests++
            return new Response('', { status: 403 })
          }
          return previous(address, init)
        }
        try {
          const reader = window.__audit.taskReaderWeb.createTaskWeb(
            urls,
            new AbortController().signal
          )
          const results = []
          for (const url of urls) {
            results.push(await reader.prepare('read_web_page', { url }).read(1000))
          }
          return { requests, first: results[0], last: results.at(-1) }
        } finally {
          window.fetch = previous
        }
      })
      assert.equal(result.requests, 24)
      assert.equal(result.first.reason, 'http')
      assert.equal(result.last.reason, 'read-budget')
      assert.equal(result.last.retryAt, undefined)
    }
  )

  await run(
    'Agent browser retains a rendered source and its exact selection across resume',
    async (page) => {
      const result = await page.evaluate(async () => {
        const { createTaskBrowser } = window.__audit.taskReaderBrowser
        const home = 'https://example.org/app'
        const child = 'https://example.org/guide'
        const urls = new Set([home])
        const approve = (url) => urls.has(url.href)
        const learn = (links) => links.forEach((url) => urls.add(url))
        const calls = []
        const nativeReader = async (url) => {
          calls.push(url.href)
          return {
            snapshot: {
              url: url.href,
              title: url.href === home ? 'Rendered application' : 'Guide',
              text:
                url.href === home
                  ? 'Rendered docs and links'
                  : 'Setup instructions\nRemaining steps',
              headings: [],
              links: url.href === home ? [{ url: child, label: 'Guide' }] : [],
              truncated: false,
            },
          }
        }
        const signal = new AbortController().signal
        const first = createTaskBrowser(signal, approve, learn, { nativeReader })
        const opened = await first.prepare('browser_open', { url: home }).run(5000)
        await first.prepare('browser_follow_link', { link: 1 }).run(5000)
        const checkpoint = first.checkpoint()
        // Reset the authorization registry to the original user-provided address.
        urls.delete(child)
        const resumed = createTaskBrowser(signal, approve, learn, { checkpoint, nativeReader })
        const view = await resumed
          .prepare('browser_snapshot', { start_line: 2, end_line: 2 })
          .run(5000)
        const back = await resumed.prepare('browser_history', { action: 'back' }).run(5000)
        return {
          opened,
          view,
          back,
          calls,
          checkpointBytes: new TextEncoder().encode(JSON.stringify(checkpoint)).byteLength,
        }
      })
      assert.match(result.opened.text, /"reader_mode":"rendered"/)
      assert.match(result.view.text, /Remaining steps/)
      assert.match(result.back.text, /Rendered docs and links/)
      assert.equal(result.view.evidence.url, 'https://example.org/guide')
      assert.deepEqual(result.view.evidence.range, { start: 2, end: 2, unit: 'lines' })
      assert.equal(result.calls.length, 2)
      assert.ok(result.checkpointBytes <= 256 * 1024)
    }
  )

  await run(
    'Agent incremental attachment reading reports exact ranges and partial coverage',
    async (page) => {
      const result = await page.evaluate(async () => {
        const { loadTaskAttachmentSource, readTaskAttachment, readTaskPreview, workbookSheets } =
          window.__audit.taskAttachments
        const line = '离线审核记录，保留文件原件。\r\n'
        const blob = new Blob([line.repeat(15_000), '查找本行结尾'])
        const file = {
          id: 'long-attachment',
          name: '审查记录.txt',
          mimeType: 'text/plain',
          size: blob.size,
        }
        const signal = new AbortController().signal
        const source = await loadTaskAttachmentSource(file, blob, signal)
        const read = readTaskAttachment(file, source, {
          offset: 0,
          startLine: 15_001,
          endLine: 15_001,
        })
        const find = readTaskAttachment(file, source, { offset: 0, find: '查找本行结尾' })
        const preview = await readTaskPreview(file, blob, signal)
        const xlsx = await window.__audit.writeArchive(
          Object.entries({
            'xl/workbook.xml':
              '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="明细" r:id="rId1"/></sheets></workbook>',
            'xl/_rels/workbook.xml.rels':
              '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
            'xl/worksheets/sheet1.xml':
              '<worksheet><sheetData><row r="7"><c r="A7" t="inlineStr"><is><t>余额</t></is></c><c r="C7"><v>5</v></c></row><row r="17"><c r="C17"><f>9+1</f></c></row></sheetData></worksheet>',
          }).map(([name, text]) => ({ name, blob: new Blob([text]) }))
        )
        return {
          read,
          find,
          previewKind: preview.kind,
          previewTruncated: preview.truncated,
          sheets: await workbookSheets(xlsx, signal),
        }
      })
      assert.equal(result.previewKind, 'text')
      assert.equal(result.previewTruncated, true)
      assert.equal(result.read.evidence.excerpt, '查找本行结尾')
      assert.equal(result.read.evidence.sourceTruncated, false)
      assert.deepEqual(result.read.evidence.range, { start: 15_001, end: 15_001, unit: 'lines' })
      assert.match(result.find.text, /"line":15001/)
      assert.deepEqual(result.sheets[0].rowNumbers, [7, 17])
      assert.deepEqual(result.sheets[0].rows, [
        ['余额', '', '5'],
        ['', '', '=9+1'],
      ])
    }
  )
}
