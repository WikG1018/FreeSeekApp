import assert from 'node:assert/strict'

export const runFontCases = async (run) => {
  await run(
    'font setting covers app text, form controls, code, formula labels and Mermaid and persists',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        const f = a.fixtures
        const message = [
          '# 中文排版 Proof',
          '',
          '中英文链接 [字号表](https://example.test) 和 $\\text{中文说明}+x+\\frac{1}{2}$。',
          '',
          '| 标题 | 数值 |',
          '| --- | --- |',
          '| 正文 | 123 |',
          '',
          '```txt',
          'sample 中文',
          '```',
          '',
          '```mermaid',
          'flowchart TD',
          '  A[节点文字] --> B[Text label]',
          '```',
        ].join('\n')
        await a.seed([
          f.session({
            id: 'font-proof',
            title: '字体验收',
            messages: [f.user('q', '请核对字体'), f.assistant('r', message)],
          }),
        ])
      })
      const heading = page.getByRole('heading', { name: '中文排版 Proof', exact: true })
      const figure = page.locator('.md-mermaid-diagram svg')
      const formulaLabel = page.locator('.katex .text').filter({ hasText: '中文说明' }).first()
      const textSamples = [
        heading,
        page.locator('[data-testid="chat-header"]').getByText('字体验收'),
        page.locator('.ds-markdown a').filter({ hasText: '字号表' }),
        page.getByRole('cell', { name: '123' }),
        page.locator('.md-code-block pre').first(),
        formulaLabel,
        figure.getByText('节点文字', { exact: true }),
        page.locator('[data-testid="chat-composer"] textarea'),
      ]
      const face = (target) => target.evaluate((node) => getComputedStyle(node).fontFamily)
      const expectApp = async (target) => assert.match(await face(target), /MiSans/)
      const expectSystem = async (target) => assert.match(await face(target), /^system-ui\b/)
      await figure.waitFor()
      for (const item of textSamples) await expectApp(item)
      await page.evaluate(() => document.fonts.ready.then(() => {}))
      const devtools = await page.context().newCDPSession(page)
      await devtools.send('DOM.enable')
      await devtools.send('CSS.enable')
      const renderedFamilies = async () => {
        const { root } = await devtools.send('DOM.getDocument')
        const { nodeId } = await devtools.send('DOM.querySelector', {
          nodeId: root.nodeId,
          selector: '.ds-markdown h1',
        })
        const { fonts } = await devtools.send('CSS.getPlatformFontsForNode', { nodeId })
        return fonts.filter(({ glyphCount }) => glyphCount > 0)
      }
      const initialFonts = await renderedFamilies()
      assert.ok(
        initialFonts.length > 0 &&
          initialFonts.every(
            ({ familyName, isCustomFont }) => isCustomFont && familyName.includes('MiSans')
          )
      )

      const drawn = await figure.getAttribute('id')
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('appearance'))
      const choice = page.getByRole('button', { name: '字体选择', exact: true })
      await expectApp(choice)
      await choice.click()
      const defaultFont = page.getByRole('option', { name: '默认 MiSans', exact: true })
      const systemFont = page.getByRole('option', { name: '系统字体', exact: true })
      assert.equal(await defaultFont.getAttribute('aria-selected'), 'true')
      await systemFont.click()
      assert.match(await choice.textContent(), /系统字体/)
      await expectSystem(choice)
      await page.evaluate(() => window.__audit.settingsDialog.closeSettings())
      await page.waitForFunction((drawn) => {
        const svg = document.querySelector('.md-mermaid-diagram svg')
        return svg && svg.id !== drawn
      }, drawn)
      for (const item of textSamples) await expectSystem(item)
      assert.match(await face(page.locator('.katex .mathnormal').last()), /KaTeX/)
      assert.ok((await renderedFamilies()).every(({ isCustomFont }) => !isCustomFont))
      await devtools.detach()
      await page.reload()
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-fs-system-font'))
      await expectSystem(heading)
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('appearance'))
      await choice.click()
      assert.equal(await systemFont.getAttribute('aria-selected'), 'true')
      await defaultFont.click()
      assert.match(await choice.textContent(), /默认 MiSans/)
      await expectApp(choice)
    }
  )

  await run(
    'startup fallback reads the system font choice even if the main script cannot load',
    async (page) => {
      await page.locator('#fs-startup-failure').waitFor({ state: 'visible', timeout: 12000 })
      assert.equal(await page.locator('html').getAttribute('data-fs-system-font'), '')
      assert.match(
        await page
          .locator('#fs-startup-title')
          .evaluate((node) => getComputedStyle(node).fontFamily),
        /^system-ui\b/
      )
    },
    async (context) => {
      await context.addInitScript(() => localStorage.setItem('freeseek:use-system-font', 'true'))
      await context.route('**/static/js/main.*.js', (route) => route.abort())
    },
    false
  )
  await run(
    'iPhone uses the system font by default and skips the 14 MB webfont',
    async (page) => {
      const origin = new URL(page.url()).origin
      const browser = page.context().browser()
      const ua =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1'
      const ios = await browser.newContext({
        userAgent: ua,
        locale: 'zh-CN',
        viewport: { width: 390, height: 844 },
      })
      try {
        const phone = await ios.newPage()
        const fonts = []
        phone.on('request', (request) => {
          if (/MiSans.*\.woff2$/i.test(request.url())) {
            fonts.push(request.url())
          }
        })
        await phone.goto(`${origin}/?e2e=1`)
        await phone.waitForFunction(
          () => window.__audit?.store.useChatStore.getState().ready,
          null,
          { timeout: 30000 }
        )
        // 字体是懒加载的，给足时间发起请求再断言「一个都没下」
        await phone.waitForTimeout(2000)
        assert.equal(
          await phone.evaluate(() => document.documentElement.hasAttribute('data-fs-system-font')),
          true
        )
        assert.deepEqual(fonts, [], 'iPhone must not download the MiSans webfont by default')
      } finally {
        await ios.close()
      }
    }
  )
}
