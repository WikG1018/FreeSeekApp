import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { unzipSync } from 'fflate'

const desktop = (page) => page.setViewportSize({ width: 1366, height: 900 })

export async function runDesktopCases(run) {
  await run('desktop large backup staging survives opening a second tab', async (page) => {
    await desktop(page)
    await page.evaluate(async () => {
      const a = window.__audit
      await a.seed([a.fixtures.session({ id: 'original-history', title: '原有历史' })])
      window.__desktopHistoryReplacement = a.store.replaceHistory(async () => {
        const useDisk = await a.useDiskForArchive(2 * 1024 ** 3)
        if (!useDisk) throw new Error('Browser file storage is unavailable')
        const archive = new File(
          [
            await a.writeArchive([
              { name: 'sample.txt', blob: new Blob(['desktop backup bytes']) },
            ]),
          ],
          'desktop-fixture.zip'
        )
        for await (const entry of a.readArchive(archive)) {
          await a.stageArchiveFile(entry, 'import-original', 'text/plain', () => {}, useDisk)
        }
        await a.db.addStagingSession(
          a.fixtures.session({
            id: 'staged-history',
            title: '新导入历史',
            messages: [
              a.fixtures.user('u', '附件', {
                files: [
                  {
                    id: 'import-original',
                    name: 'sample.txt',
                    size: 20,
                    mimeType: 'text/plain',
                    isImage: false,
                  },
                ],
              }),
            ],
          })
        )
        await new Promise((resolve) => {
          window.__finishDesktopImport = resolve
        })
      })
    })
    await page.waitForFunction(() => window.__finishDesktopImport)
    const secondTab = await page.context().newPage()
    try {
      await desktop(secondTab)
      await secondTab.goto(page.url())
      await secondTab.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      assert.deepEqual(
        await secondTab.evaluate(async () =>
          (await window.__audit.db.loadSessionSummaries()).map((chat) => chat.id)
        ),
        ['original-history']
      )
      assert.equal(
        await secondTab.evaluate(async () => {
          try {
            await window.__audit.store.replaceHistory(async () => {})
          } catch (error) {
            return error.key
          }
        }),
        'backupOtherTabBusy'
      )
      const committed = await page.evaluate(async () => {
        const a = window.__audit
        window.__finishDesktopImport()
        const count = await window.__desktopHistoryReplacement
        const file = await a.db.loadFile('import-original')
        return { count, bytes: await file.text(), type: file.type }
      })
      assert.deepEqual(committed, { count: 1, bytes: 'desktop backup bytes', type: 'text/plain' })
      await secondTab.reload()
      await secondTab.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      await secondTab.getByText('新导入历史', { exact: true }).waitFor()
    } finally {
      await secondTab.close()
      await page.evaluate(() => window.__finishDesktopImport?.())
    }
  })

  await run('desktop camera captures a JPEG and releases the camera on exit', async (page) => {
    await desktop(page)
    await page.evaluate(() => {
      const a = window.__audit
      a.providers.saveProvider(
        {
          ...a.providers.emptyProfile(),
          name: '桌面测试服务',
          url: 'https://desktop.example.test/v1',
          model: 'vision-model',
          modelSettings: { 'vision-model': { vision: true } },
        },
        true
      )
      navigator.mediaDevices.getUserMedia = async (options) => {
        if (!options.video || options.audio) throw new Error('unexpected media options')
        const canvas = document.createElement('canvas')
        canvas.width = 160
        canvas.height = 120
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#506bc2'
        ctx.fillRect(0, 0, 160, 120)
        const stream = canvas.captureStream(24)
        window.__cameraTrack = stream.getVideoTracks()[0]
        setTimeout(() => ctx.fillRect(20, 20, 40, 40), 80)
        return stream
      }
    })
    const composer = page.getByTestId('chat-composer')
    const menu = page.getByTestId('option-panel')
    const camera = page.getByRole('dialog', { name: '拍照', exact: true })
    const open = async () => {
      await composer.getByRole('button', { name: '添加附件', exact: true }).click()
      await menu.getByRole('button', { name: '拍照', exact: true }).click()
      await camera.waitFor()
    }
    await open()
    const shot = camera.getByRole('button', { name: '拍下照片', exact: true })
    await shot.click()
    await composer.getByRole('img', { name: /^照片-\d+\.jpg$/ }).waitFor()
    await camera.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => window.__cameraTrack.readyState), 'ended')

    await open()
    await camera.getByLabel('相机预览', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await camera.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => window.__cameraTrack.readyState), 'ended')
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException('denied', 'NotAllowedError')
      }
    })
    await open()
    assert.match(await camera.getByRole('alert').innerText(), /站点设置/)
    assert.ok(await camera.getByRole('button', { name: '相册', exact: true }).isEnabled())
  })

  await run(
    'desktop diagnostics fall back to a readable ZIP when file sharing fails',
    async (page) => {
      await desktop(page)
      await page.evaluate(() => {
        navigator.canShare = () => true
        navigator.share = async () => {
          throw new DOMException('activation expired', 'NotAllowedError')
        }
        window.__audit.settingsDialog.openSettings('about')
      })
      const about = page.locator('[data-settings-page="about"]')
      const downloadEvent = page.waitForEvent('download')
      await about.getByRole('button', { name: '导出并分享诊断包', exact: true }).click()
      const download = await downloadEvent
      assert.match(download.suggestedFilename(), /^freeseek-diagnostics-.*\.zip$/)
      const entries = unzipSync(await readFile(await download.path()))
      assert.ok(Object.keys(entries).some((name) => name.endsWith('.json')))
      await page.getByText('诊断包已交给浏览器下载。', { exact: true }).waitFor()

      await page.evaluate(() => {
        navigator.share = async () => {
          throw new DOMException('cancelled', 'AbortError')
        }
      })
      const [result, downloads] = await Promise.all([
        page.evaluate(async () => {
          const blob = new Blob(['fixture'], { type: 'application/zip' })
          return window.__audit.diagnosticShare.shareDiagnostics('diagnostics.zip', blob)
        }),
        page.waitForEvent('download', { timeout: 350 }).then(
          () => 1,
          () => 0
        ),
      ])
      assert.equal(result, false)
      assert.equal(downloads, 0)
    }
  )

  await run('desktop support dialog downloads the selected QR image', async (page) => {
    await desktop(page)
    await page.getByRole('button', { name: '感谢开发者', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '感谢开发者', exact: true })
    await dialog.getByRole('radio', { name: '支付宝', exact: true }).check()
    await dialog
      .getByText('打开手机上的支付宝，用「扫一扫」扫描屏幕上的收款码。', { exact: true })
      .waitFor()
    const downloadEvent = page.waitForEvent('download')
    await dialog.getByRole('link', { name: '下载收款码', exact: true }).click()
    const download = await downloadEvent
    assert.equal(download.suggestedFilename(), 'freeseek-donate-alipay.png')
    const image = await readFile(await download.path())
    assert.equal(image.subarray(1, 4).toString(), 'PNG')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
  })

  await run(
    'update notes combine skipped public versions and keep the update available offline',
    async (page) => {
      await page.setViewportSize({ width: 340, height: 640 })
      const makeRelease = (version, body, fields = {}) => ({
        tag_name: 'v' + version,
        body,
        draft: false,
        prerelease: false,
        ...fields,
      })
      const requests = []
      let historyOffline = false
      await page.route('https://api.github.com/repos/WikG1018/FreeSeekApp/releases?*', (route) => {
        const pageNumber = new URL(route.request().url()).searchParams.get('page')
        requests.push(pageNumber)
        if (historyOffline) return route.abort()
        const json = pageNumber === '1'
          ? [
              makeRelease('3.1.9', '- 九版说明\n- 打赏说明'),
              makeRelease('3.1.13', '未提供的更新'),
              makeRelease('3.1.12', '目标版本说明'),
              makeRelease('3.1.10', '十版说明'),
              makeRelease('3.1.8', '已安装的旧版'),
              makeRelease('3.1.11', '草稿说明', { draft: true }),
              makeRelease('3.1.11-rc.1', '测试版说明', { prerelease: true }),
              ...Array.from({ length: 23 }, (_, index) => makeRelease(`2.0.${index}`, '旧版说明')),
            ]
          : [makeRelease('3.1.11', '十一版说明'), makeRelease('3.1.10', '重复十版说明')]
        return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json })
      })
      await page.route('**/web-version.json', (route) => route.fulfill({
        json: {
          version: '3.1.12',
          notes: '目标版本说明',
          files: ['static/js/main.0123abcd.js'],
        },
      }))
      await page.route('**/main.0123abcd.js', (route) => route.fulfill({ body: '/* test asset */' }))
      await page.evaluate(async () => {
        document.querySelector('meta[name="application-version"]').setAttribute('content', '3.1.8')
        await window.__audit.update.checkForUpdate({ force: true })
      })
      const menu = page.getByRole('button', { name: '打开边栏', exact: true })
      await menu.click()
      const open = page.getByTestId('sidebar-update')
      const notes = page.getByTestId('release-notes')
      const dialog = page.getByRole('dialog').filter({ has: notes })
      const ready = dialog.getByRole('button', { name: '刷新到新版', exact: true })
      await open.click()
      await notes.getByText('九版说明', { exact: true }).waitFor()
      assert.deepEqual(await notes.getByRole('heading', { level: 3 }).allTextContents(), [
        'v3.1.12', 'v3.1.11', 'v3.1.10', 'v3.1.9',
      ])
      assert.doesNotMatch(await notes.innerText(), /未提供的更新|已安装的旧版|草稿说明|测试版说明|打赏说明|重复十版说明/)
      assert.equal(await notes.getByText('目标版本说明', { exact: true }).count(), 1)
      assert.deepEqual(requests, ['1', '2'])
      await ready.waitFor()

      const close = dialog.getByRole('button', { name: '关闭', exact: true })
      await close.click()
      await dialog.waitFor({ state: 'hidden' })
      historyOffline = true
      await open.click()
      await notes.getByText('十一版说明', { exact: true }).waitFor()
      assert.deepEqual(requests, ['1', '2'])
      await close.click()
      await dialog.waitFor({ state: 'hidden' })

      await page.evaluate(() => {
        localStorage.removeItem('freeseek:upgrade-notes')
        window.__audit.settingsDialog.openSettings('about')
      })
      await page.getByRole('button', { name: /^检查更新/ }).click()
      await notes.getByText('部分历史更新说明暂时无法获取。', { exact: true }).waitFor()
      await notes.getByText('目标版本说明', { exact: true }).waitFor()
      assert.equal(await ready.isEnabled(), true)
      assert.deepEqual(requests, ['1', '2', '1'])
    }
  )

  await run(
    'desktop updates prefetch resources and reload while preserving the current chat',
    async (page) => {
      await desktop(page)
      let failPrefetch = true
      let resourceRequests = 0
      const files = ['static/js/main.0123abcd.js', 'static/css/app.0123abcd.css']
      await page.route('**/web-version.json', (route) =>
        route.fulfill({ json: { version: '99.0.0', notes: '新版网页版测试说明', files } })
      )
      await page.route('**/*.0123abcd.*', (route) => {
        resourceRequests++
        return failPrefetch
          ? route.fulfill({ status: 503 })
          : route.fulfill({ status: 200, body: '/* test asset */' })
      })
      await page.evaluate(async () => {
        const a = window.__audit
        await a.settings.setStartupPage('last-chat')
        await a.seed([
          a.fixtures.session({
            id: 'reload-history',
            messages: [a.fixtures.user('u', '刷新后保留')],
          }),
        ])
        a.drafts.setDraftText('reload-history', '未发送的文字')
        await a.update.checkForUpdate({ force: true })
      })
      await page.getByTestId('sidebar-update').click()
      const notes = page.getByRole('dialog').filter({ has: page.getByTestId('release-notes') })
      await notes.getByText('新版网页版测试说明', { exact: true }).waitFor()
      await notes.getByRole('alert').waitFor()
      assert.ok(resourceRequests >= 1)
      failPrefetch = false
      await notes.getByRole('button', { name: '下载更新', exact: true }).click()
      const reload = notes.getByRole('button', { name: '刷新到新版', exact: true })
      await reload.waitFor()
      assert.ok(resourceRequests >= 3)
      await page.evaluate(() =>
        window.__audit.store.useChatStore.setState({
          streaming: { 'reload-history': new AbortController() },
        })
      )
      await reload.click()
      await page.getByText(/请先等回复生成完成/).waitFor()
      await page.evaluate(() => window.__audit.store.useChatStore.setState({ streaming: {} }))
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
      })
      await reload.click()
      await page.getByText('请连接网络后再刷新到新版。', { exact: true }).waitFor()
      await page.evaluate(() => delete navigator.onLine)

      await page.route(page.url(), async (route) => {
        const response = await route.fetch()
        const html = (await response.text()).replace(
          /<meta\b[^>]*\bname="application-version"[^>]*>/,
          '<meta name="application-version" content="99.0.0">'
        )
        await route.fulfill({ response, body: html })
      })
      const navigated = page.waitForEvent('domcontentloaded')
      await reload.click()
      await navigated
      await page.waitForFunction(() => window.__audit?.store.useChatStore.getState().ready)
      await page.getByText('刷新后保留', { exact: true }).waitFor()
      assert.equal(
        await page.getByTestId('chat-composer').locator('textarea').inputValue(),
        '未发送的文字'
      )
      assert.equal(
        await page.locator('meta[name="application-version"]').getAttribute('content'),
        '99.0.0'
      )
    }
  )
}
