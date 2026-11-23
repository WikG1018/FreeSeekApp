import assert from 'node:assert/strict'
import { strToU8, zipSync } from 'fflate'
import { mkdir, writeFile } from 'node:fs/promises'

const media = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const rels = 'http://schemas.openxmlformats.org/package/2006/relationships'
const packageOf = (parts) =>
  zipSync(Object.fromEntries(Object.entries(parts).map(([name, xml]) => [name, strToU8(xml)])))
const samplePDF = () => {
  const draw = (text, fill) => {
    const content =
      fill + ' rg 12 20 76 48 re f BT /F1 10 Tf 0 0 0 rg 12 85 Td (' + text + ') Tj ET'
    return '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream'
  }
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    draw('FreeSeek first page', '0.2 0.5 0.8'),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    draw('Landscape page', '0.7 0.3 0.3'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let file = '%PDF-1.4\n'
  const offsets = ['0000000000 65535 f \n']
  for (const [index, object] of objects.entries()) {
    offsets.push(String(file.length).padStart(10, '0') + ' 00000 n \n')
    file += index + 1 + ' 0 obj\n' + object + '\nendobj\n'
  }
  return strToU8(
    file +
      'xref\n0 ' +
      offsets.length +
      '\n' +
      offsets.join('') +
      'trailer\n<< /Root 1 0 R /Size ' +
      offsets.length +
      ' >>\nstartxref\n' +
      file.length +
      '\n%%EOF\n'
  )
}

const sampleDeck = () => {
  const d = 'http://schemas.openxmlformats.org/drawingml/2006/main'
  const p = 'http://schemas.openxmlformats.org/presentationml/2006/main'
  const slide = (label) =>
    '<p:sld xmlns:p="' +
    p +
    '" xmlns:a="' +
    d +
    '"><p:cSld><p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name="root"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="914400" y="571500"/><a:ext cx="4600000" cy="870000"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="244A6C"/></a:solidFill></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="2800"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr>' +
    '<a:t>' +
    label +
    '</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
  return packageOf({
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
      '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
    '_rels/.rels':
      '<Relationships xmlns="' +
      rels +
      '"><Relationship Id="rId1" Type="' +
      media +
      '/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    'ppt/presentation.xml':
      '<p:presentation xmlns:p="' +
      p +
      '" xmlns:r="' +
      media +
      '"><p:sldIdLst>' +
      '<p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="8000000" cy="6000000"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels':
      '<Relationships xmlns="' +
      rels +
      '">' +
      '<Relationship Id="rId1" Type="' +
      media +
      '/slide" Target="slides/slide1.xml"/>' +
      '<Relationship Id="rId2" Type="' +
      media +
      '/slide" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': slide('先看这一页'),
    'ppt/slides/slide2.xml': slide('最终核对事项'),
  })
}

const sampleSheet = () => {
  const s = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  return packageOf({
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels':
      '<Relationships xmlns="' +
      rels +
      '"><Relationship Id="rId1" Type="' +
      media +
      '/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':
      '<workbook xmlns="' +
      s +
      '" xmlns:r="' +
      media +
      '"><sheets><sheet name="核对表" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships xmlns="' +
      rels +
      '">' +
      '<Relationship Id="rId1" Type="' +
      media +
      '/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="' +
      media +
      '/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml':
      '<styleSheet xmlns="' +
      s +
      '"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font>' +
      '<font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="Arial"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF244A6C"/></patternFill></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf>' +
      '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml':
      '<worksheet xmlns="' +
      s +
      '"><sheetViews><sheetView workbookViewId="0">' +
      '<pane xSplit="1" ySplit="1" topLeftCell="B2" state="frozen"/></sheetView></sheetViews>' +
      '<cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="2" width="14" customWidth="1"/></cols>' +
      '<sheetData><row r="1" ht="34" customHeight="1"><c r="A1" t="inlineStr" s="1"><is><t>费用汇总</t></is></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>合计</t></is></c><c r="B2" s="2"><f>40+2</f><v>42</v></c></row></sheetData>' +
      '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>',
  })
}

export const runDocumentLayoutCases = async (run) => {
  await run(
    'reply activity follows real stream phases and stops when the reply settles',
    async (page) => {
      await page.evaluate(() => {
        const a = window.__audit
        a.settings.setApiKey('activity-fixture')
        const fetcher = window.fetch
        const encoder = new TextEncoder()
        window.fetch = (url, init) => {
          if (!new URL(url).pathname.endsWith('/anthropic/v1/messages')) return fetcher(url, init)
          const readable = new ReadableStream({
            start(controller) {
              window.__replyActivityFeed = (events, end = false) => {
                for (const event of events)
                  controller.enqueue(encoder.encode('data: ' + JSON.stringify(event) + '\n\n'))
                if (end) controller.close()
              }
            },
          })
          return Promise.resolve(
            new Response(readable, { headers: { 'content-type': 'text/event-stream' } })
          )
        }
        a.drafts.setDraftText(null, '核对一下结果')
        a.store.sendMessage(null)
      })
      const status = page.getByTestId('reply-activity')
      await status.getByText('等待模型响应', { exact: true }).waitFor()
      await page.waitForFunction(() => Boolean(window.__replyActivityFeed))
      await page.evaluate(() =>
        window.__replyActivityFeed([
          { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '正在核对' },
          },
        ])
      )
      await status.getByText('正在思考', { exact: true }).waitFor()
      assert.equal(await status.locator('i').count(), 3)
      await page.evaluate(() =>
        window.__replyActivityFeed([
          { type: 'content_block_stop', index: 0 },
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'text', text: '已经核对。' },
          },
        ])
      )
      await status.getByText('正在生成回答', { exact: true }).waitFor()
      await page.evaluate(() =>
        window.__replyActivityFeed(
          [
            { type: 'content_block_stop', index: 1 },
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
      await status.waitFor({ state: 'detached' })
      await page.getByText('已经核对。', { exact: true }).waitFor()
    }
  )

  await run(
    'scroll edge feedback settles on the active scroll surface and respects reduced motion',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        await a.seed([
          a.fixtures.session({
            title: '回弹验收',
            messages: Array.from({ length: 20 }, (_, i) => [
              a.fixtures.user('edge-q-' + i, '问题 ' + i),
              a.fixtures.assistant('edge-a-' + i, '内容。'.repeat(100)),
            ]).flat(),
          }),
        ])
      })
      // 会话正文已按需求移除边缘回弹，这里改用设置页验证同一套回弹机制。
      // 设置页内容可能不足一屏，先插入一块撑高的占位，确保容器可滚动。
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('about'))
      await page.evaluate(() => {
        const scroller = document.querySelector('[data-testid="settings-scroll"]')
        const content = scroller?.querySelector('[data-scroll-edge-content]')
        if (!content) return
        const spacer = document.createElement('div')
        spacer.style.height = '2400px'
        spacer.dataset.edgeTestSpacer = ''
        content.appendChild(spacer)
        scroller.scrollTop = 0
      })
      const scroll = page.locator('[data-testid="settings-scroll"]')
      await page.waitForFunction(() => {
        const node = document.querySelector('[data-testid="settings-scroll"]')
        return node && node.scrollHeight > node.clientHeight + 4
      })
      const gesture = async (end = false, bottom = false) =>
        scroll.evaluate(
          (node, { finish, bottom }) => {
            // 事件从内容层派发（冒泡到可滚动容器），滚动位置设在外层容器上
            const target = node.querySelector('[data-scroll-edge-content]') || node
            const emit = (type, distance) => {
              const event = new Event(type, { bubbles: true, cancelable: true })
              Object.defineProperty(event, 'touches', {
                value:
                  type === 'touchend' ? [] : [{ identifier: 17, clientX: 120, clientY: distance }],
              })
              target.dispatchEvent(event)
            }
            if (finish) {
              emit('touchend', 250)
            } else {
              node.scrollTop = bottom ? node.scrollHeight : 0
              emit('touchstart', 180)
              emit('touchmove', bottom ? 110 : 250)
            }
          },
          { finish: end, bottom }
        )
      await scroll.waitFor()
      for (const bottom of [false, true]) {
        await gesture(false, bottom)
        await page.waitForFunction(() => !!document.querySelector('[data-edge-motion="drag"]'))
        const state = await scroll.evaluate((node) => {
          const style = getComputedStyle(node)
          return {
            offset: Number.parseFloat(node.style.getPropertyValue('--fs-edge-shift')),
            shadow: style.boxShadow,
            overscroll: style.overscrollBehaviorY,
          }
        })
        // 橡皮筋上限约 56px（原 16px 几乎看不出回弹）
        assert.ok((bottom ? state.offset < 0 : state.offset > 0) && Math.abs(state.offset) < 60)
        assert.equal(state.shadow, 'none')
        assert.equal(state.overscroll, 'none')
        await gesture(true)
        await page.waitForFunction(() => !document.querySelector('[data-edge-motion]'))
      }
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await gesture()
      await scroll.evaluate(() => new Promise((done) => requestAnimationFrame(done)))
      assert.equal(await scroll.getAttribute('data-edge-motion'), null)
      assert.equal(
        await scroll.evaluate((node) => node.style.getPropertyValue('--fs-edge-shift')),
        ''
      )
      await gesture(true)
    }
  )

  await run(
    'offline document viewers retain PDF and PPT geometry and styled XLSX cells',
    async (page) => {
      const files = [
        ['版式.pdf', 'application/pdf', samplePDF()],
        [
          '演示.pptx',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          sampleDeck(),
        ],
        [
          '汇总.xlsx',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          sampleSheet(),
        ],
      ].map(([name, mimeType, data], index) => ({
        name,
        mimeType,
        id: 'layout-' + index,
        bytes: Array.from(data),
      }))
      const external = []
      page.on('request', (request) => {
        if (/^https?:\/\/(?!127\.0\.0\.1)/.test(request.url())) external.push(request.url())
      })
      await page.evaluate(async (fixtures) => {
        const a = window.__audit
        const artifacts = fixtures.map(({ name, mimeType, id, bytes }) => ({
          name,
          mimeType,
          id,
          serverId: null,
          size: bytes.length,
          isImage: false,
        }))
        await a.seed(
          [
            a.fixtures.session({
              id: 'layout-fixture',
              mode: 'agent',
              messages: [
                a.fixtures.user('layout-q', '核对三种文件的版式'),
                a.fixtures.assistant('layout-r', '文件已准备。', {
                  task: { plan: [], steps: [], artifacts },
                }),
              ],
            }),
          ],
          fixtures.map(({ id, bytes, mimeType }) => ({
            id,
            blob: new Blob([new Uint8Array(bytes)], { type: mimeType }),
          }))
        )
      }, files)
      if (process.env.FREESEEK_TASK_PREVIEWS) {
        const backup = await page.evaluate(async () => {
          const exported = await window.__audit.backup.exportHistory()
          return Array.from(new Uint8Array(await exported.blob.arrayBuffer()))
        })
        await mkdir('tmp/regression/task', { recursive: true })
        await writeFile('tmp/regression/task/layout-native-fixture.zip', Uint8Array.from(backup))
      }
      const open = async (name) => {
        await page.getByTestId('session-artifacts-button').click()
        await page.getByRole('button', { name: '预览 ' + name, exact: true }).click()
        return page.getByRole('dialog', { name: '预览 ' + name, exact: true })
      }
      const ratio = async (dialog, expected) => {
        const image = dialog.getByTestId('rendered-artifact-page')
        await image.waitFor()
        await page.waitForFunction(
          ({ expected: value }) => {
            const image = document.querySelector('[data-testid="rendered-artifact-page"]')
            return (
              !!image?.naturalHeight &&
              Math.abs(image.naturalWidth / image.naturalHeight - value) < 0.02
            )
          },
          { expected }
        )
      }
      const close = async (dialog) => {
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden' })
        await page.keyboard.press('Escape')
        await page
          .getByRole('dialog', { name: '对话成果', exact: true })
          .waitFor({ state: 'hidden' })
      }
      const pdf = await open('版式.pdf')
      await ratio(pdf, 0.5)
      await pdf.getByRole('button', { name: '下一页', exact: true }).click()
      await ratio(pdf, 2)
      await pdf.getByRole('button', { name: '放大', exact: true }).click()
      await pdf.getByText('120%', { exact: true }).waitFor()
      await close(pdf)
      const reopened = await open('版式.pdf')
      await ratio(reopened, 2)
      await reopened.getByText('120%', { exact: true }).waitFor()
      await close(reopened)
      const slides = await open('演示.pptx')
      await ratio(slides, 4 / 3)
      await slides.getByRole('button', { name: '下一页', exact: true }).click()
      await slides.getByText('2/2 页', { exact: true }).waitFor()
      await ratio(slides, 4 / 3)
      await close(slides)
      const sheet = await open('汇总.xlsx')
      const merged = sheet.getByRole('columnheader', { name: '费用汇总' })
      await merged.waitFor()
      assert.equal(await merged.getAttribute('colspan'), '2')
      assert.equal(
        await merged.evaluate((node) => getComputedStyle(node).backgroundColor),
        'rgb(36, 74, 108)'
      )
      const result = sheet.getByRole('cell', { name: '42.00', exact: true })
      await result.click()
      await sheet.getByText('单元格公式 · =40+2', { exact: true }).waitFor()
      assert.deepEqual(
        external.filter((url) => /googleapis|fonts\.gstatic|unpkg|cdn/i.test(url)),
        []
      )
    }
  )
}
