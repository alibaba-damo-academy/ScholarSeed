import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, expect, test, type Page } from '@playwright/test'
import { DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const HISTORY_URL = 'https://example.com/'
const HISTORY_TIMEOUT_MS = 30_000
const COOKIE_NAME = 'scholarseed_browser_clear_probe'

test('real Desktop persists and clears browser history through Browser settings', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo, { browserEnabled: true, nativeWindowLifecycle: true })
  const directory = resolve('../../tmp/test_snapshot/desktop/browser-history')
  await mkdir(directory, { recursive: true })
  try {
    const start = async () => {
      const launching = desktop.launch()
      await expect.poll(() => desktop.app?.windows().find(candidate => candidate.url().startsWith('http:'))?.url(), { timeout: 45_000 }).toBeTruthy()
      const startupPage = desktop.app!.windows().find(candidate => candidate.url().startsWith('http:'))!
      for (const name of ['先随便看看', '跳过']) {
        await startupPage.addLocatorHandler(startupPage.getByRole('button', { name, exact: true }), async button => { await button.click() })
      }
      const page = await launching
      await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
      return page
    }
    const settings = async (page: Awaited<ReturnType<typeof start>>) => {
      await page.getByTestId('activity-account').click()
      await page.getByTestId('account-menu-settings').click()
      await page.getByTestId('account-settings-nav-browser').click()
      const panel = page.getByTestId('account-settings-browser')
      await expect(panel).toBeVisible()
      return panel
    }
    const assertHistoryNavigation = async (page: Page) => {
      await expect.poll(async () => {
        const reply = await page.evaluate(() => window.scholarseed.browser.snapshot())
        if (!reply.ok) return null
        const active = reply.snapshot.tabs.find(tab => tab.tabId === reply.snapshot.activeTabId)
        return active && { url: active.url, loading: active.loading, error: active.navigationError }
      }, { timeout: HISTORY_TIMEOUT_MS }).toEqual({ url: HISTORY_URL, loading: false, error: null })
      const nativeWindow = await desktop.browserWindow(page)
      await expect.poll(() => nativeWindow.evaluate((window, url) => {
        const target = window.contentView.children.find(child =>
          'webContents' in child && (child as Electron.WebContentsView).webContents.getURL() === url
        ) as Electron.WebContentsView | undefined
        return target?.webContents.executeJavaScript('({ origin: location.origin, ready: document.readyState, body: document.body?.innerText?.trim() ?? "" })')
      }, HISTORY_URL).catch(() => null), { timeout: HISTORY_TIMEOUT_MS }).toMatchObject({
        origin: new URL(HISTORY_URL).origin,
        ready: expect.stringMatching(/^(interactive|complete)$/),
        body: expect.stringMatching(/This domain is for use in documentation examples|Example Domain/)
      })
      await expect.poll(async () => {
        const reply = await page.evaluate(url => window.scholarseed.browser.history({
          kind: 'query', query: { search: url, offset: 0, limit: 1 }
        }), HISTORY_URL)
        return reply.ok ? reply.page?.items[0]?.url : null
      }, { timeout: HISTORY_TIMEOUT_MS }).toBe(HISTORY_URL)
    }
    const page = await start()
    await page.getByTestId('activity-browser').click()
    const address = page.getByRole('textbox', { name: '网址', exact: true })
    await address.fill('example.com')
    await address.press('Enter')
    await assertHistoryNavigation(page)
    await page.getByRole('button', { name: '更多浏览器功能', exact: true }).click()
    await expect.poll(() => desktop.app!.windows().some(candidate => candidate.url().includes('/menu.html'))).toBe(true)
    const menuPage = desktop.app!.windows().find(candidate => candidate.url().includes('/menu.html'))!
    await menuPage.getByRole('menuitem', { name: '历史记录', exact: true }).click()
    const historySection = page.getByTestId('account-settings-browser-history')
    await expect(historySection).toBeVisible()
    await expect(historySection.getByRole('heading', { name: '历史记录', exact: true })).toBeVisible()
    await expect(historySection.getByTestId('browser-history-list')).toContainText(HISTORY_URL)
    await expect(page.getByTestId('browser-settings-cdp')).toHaveCount(0)
    await historySection.getByRole('button', { name: '返回浏览器设置' }).click()
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭', exact: true }).click()
    let panel = await settings(page)
    await expect(panel.getByTestId('browser-settings-agent-sites').getByRole('switch', { name: 'Agent Browser Use' })).toBeEnabled()
    await panel.getByRole('searchbox', { name: '搜索标题或网址' }).fill('example.com')
    await expect(panel.getByTestId('browser-history-list').getByRole('listitem').first()).toContainText(HISTORY_URL)
    await panel.getByTestId('browser-history-list').getByRole('listitem').first().scrollIntoViewIfNeeded()
    await writeFile(join(directory, 'history-before-restart.png'), await page.screenshot())
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭', exact: true }).click()
    await desktop.close()

    const restarted = await start()
    panel = await settings(restarted)
    await expect(panel.getByTestId('browser-settings-agent-sites').getByRole('switch', { name: 'Agent Browser Use' })).toBeEnabled()
    await panel.getByRole('searchbox', { name: '搜索标题或网址' }).fill('example.com')
    await expect(panel.getByTestId('browser-history-list').getByRole('listitem').first()).toContainText(HISTORY_URL)
    await panel.getByTestId('browser-history-list').getByRole('listitem').first().scrollIntoViewIfNeeded()
    await writeFile(join(directory, 'history-after-restart.png'), await restarted.screenshot())
    await panel.getByTestId('browser-history-list').getByRole('listitem').first().getByRole('button', { name: '重新打开' }).click()
    await expect(restarted.getByRole('dialog', { name: '设置' })).toHaveCount(0)
    await expect(restarted.getByTestId('browser-workspace')).toBeVisible()
    await assertHistoryNavigation(restarted)
    const nativeWindow = await desktop.browserWindow(restarted)
    const media = await nativeWindow.evaluate(native => ({ id: native.getMediaSourceId(), bounds: native.getBounds() }))
    const screenshot = await desktop.app!.evaluate(async ({ desktopCapturer }, source) => {
      const captures = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: source.bounds.width, height: source.bounds.height } })
      return captures.find(capture => capture.id === source.id)?.thumbnail.toPNG().toString('base64') ?? null
    }, media)
    expect(screenshot).toBeTruthy()
    await writeFile(join(directory, 'history-reopen-native.png'), Buffer.from(screenshot!, 'base64'))

    panel = await settings(restarted)
    await panel.getByRole('switch', { name: '启用浏览器自动化', exact: true }).click()
    await panel.getByRole('button', { name: '复制 CDP 地址', exact: true }).click()
    const endpoint = await desktop.app!.evaluate(({ clipboard }) => clipboard.readText())
    const beforeClear = await chromium.connectOverCDP(endpoint)
    try {
      const browserPage = beforeClear.contexts()[0].pages()[0]
      await browserPage.evaluate(name => { document.cookie = `${name}=present; Path=/; SameSite=Lax` }, COOKIE_NAME)
      expect(await browserPage.evaluate(name => document.cookie.includes(`${name}=present`), COOKIE_NAME)).toBe(true)
    } finally { await beforeClear.close() }
    await panel.getByRole('combobox', { name: '清除范围' }).click()
    await restarted.getByRole('option', { name: '按类型清除（全部时间）' }).click()
    await panel.getByRole('checkbox', { name: 'Cookie' }).click()
    await panel.getByRole('button', { name: '清除', exact: true }).click()
    await restarted.getByRole('alertdialog').getByRole('button', { name: '清除', exact: true }).click()
    await expect(panel.getByTestId('browser-history-list').getByRole('listitem').first()).toContainText(HISTORY_URL)
    await expect.poll(async () => {
      const reply = await restarted.evaluate(() => window.scholarseed.browser.snapshot())
      return reply.ok ? reply.snapshot.tabs.length : null
    }).toBe(0)
    const selectedDirectory = join(directory, `selected-types-${Date.now()}-${process.pid}`)
    await mkdir(selectedDirectory, { recursive: true })
    await writeFile(join(selectedDirectory, 'cookie-cleared-history-retained.png'), await restarted.screenshot())
    await panel.getByTestId('browser-history-list').getByRole('listitem').first().getByRole('button', { name: '重新打开' }).click()
    await expect(restarted.getByRole('dialog', { name: '设置' })).toHaveCount(0)
    await expect(restarted.getByTestId('browser-workspace')).toBeVisible()
    await assertHistoryNavigation(restarted)
    panel = await settings(restarted)
    await panel.getByRole('switch', { name: '启用浏览器自动化', exact: true }).click()
    await panel.getByRole('button', { name: '复制 CDP 地址', exact: true }).click()
    const selectedEndpoint = await desktop.app!.evaluate(({ clipboard }) => clipboard.readText())
    const selectedConnection = await chromium.connectOverCDP(selectedEndpoint)
    try {
      const browserPage = selectedConnection.contexts()[0].pages()[0]
      expect(await browserPage.evaluate(name => document.cookie.includes(`${name}=present`), COOKIE_NAME)).toBe(false)
    } finally { await selectedConnection.close() }
    await panel.getByRole('combobox', { name: '清除范围' }).click()
    await restarted.getByRole('option', { name: '全部历史和网站数据' }).click()
    await panel.getByRole('button', { name: '清除', exact: true }).click()
    await restarted.getByRole('alertdialog').getByRole('button', { name: '清除', exact: true }).click()
    await expect(panel.getByText('没有浏览记录。')).toBeVisible()
    await expect(panel.getByText('浏览数据已清除。', { exact: true })).toBeVisible()
    await expect.poll(async () => {
      const reply = await restarted.evaluate(() => window.scholarseed.browser.snapshot())
      return reply.ok ? reply.snapshot.tabs.length : null
    }).toBe(0)
    await writeFile(join(directory, 'history-cleared.png'), await restarted.screenshot())
    await restarted.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭', exact: true }).click()
    await restarted.getByTestId('activity-browser').click()
    await restarted.getByRole('button', { name: '新建网页标签', exact: true }).click()
    await expect.poll(async () => {
      const reply = await restarted.evaluate(() => window.scholarseed.browser.snapshot())
      return reply.ok ? reply.snapshot.tabs.length : null
    }).toBe(1)
    await desktop.app!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().startsWith('http:'))!
      const view = window.contentView.children.find(child => 'webContents' in child) as Electron.WebContentsView
      const contents = view.webContents
      const events: { kind: string; url: string; loading: boolean; at: number }[] = []
      for (const kind of ['did-start-loading', 'did-stop-loading', 'dom-ready', 'did-finish-load', 'did-fail-load']) {
        contents.on(kind as 'did-start-loading', () => events.push({ kind, url: contents.getURL(), loading: contents.isLoadingMainFrame(), at: Date.now() }))
      }
      ;(globalThis as typeof globalThis & { __browserHistoryNavigationEvents?: typeof events }).__browserHistoryNavigationEvents = events
    })
    const reopenedAddress = restarted.getByRole('textbox', { name: '网址', exact: true })
    await reopenedAddress.fill('example.com')
    await reopenedAddress.press('Enter')
    try {
      await assertHistoryNavigation(restarted)
    } catch (error) {
      const diagnostic = {
        snapshot: await restarted.evaluate(() => window.scholarseed.browser.snapshot()).catch(() => null),
        events: await desktop.app!.evaluate(() => (globalThis as typeof globalThis & { __browserHistoryNavigationEvents?: unknown[] }).__browserHistoryNavigationEvents).catch(() => null),
        views: await desktop.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => window.webContents.getURL().startsWith('http:')).flatMap(window => window.contentView.children.map(child => {
          const contents = (child as Electron.WebContentsView).webContents
          return { url: contents.getURL(), loading: contents.isLoadingMainFrame(), destroyed: contents.isDestroyed() }
        }))).catch(() => null)
      }
      await writeFile(testInfo.outputPath('history-navigation-failure.json'), JSON.stringify(diagnostic, null, 2))
      throw error
    }
    panel = await settings(restarted)
    await panel.getByRole('switch', { name: '启用浏览器自动化', exact: true }).click()
    await panel.getByRole('button', { name: '复制 CDP 地址', exact: true }).click()
    const afterClearEndpoint = await desktop.app!.evaluate(({ clipboard }) => clipboard.readText())
    const afterClear = await chromium.connectOverCDP(afterClearEndpoint)
    try {
      const browserPage = afterClear.contexts()[0].pages()[0]
      expect(await browserPage.evaluate(name => document.cookie.includes(`${name}=present`), COOKIE_NAME)).toBe(false)
    } finally { await afterClear.close() }
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('real Desktop shows Browser settings failures at the affected controls', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo, { browserEnabled: true, nativeWindowLifecycle: true })
  const directory = resolve('../../tmp/test_snapshot/desktop/browser-settings-error')
  await mkdir(directory, { recursive: true })
  try {
    const launching = desktop.launch()
    await expect.poll(() => desktop.app?.windows().find(candidate => candidate.url().startsWith('http:'))?.url(), { timeout: 45_000 }).toBeTruthy()
    const startupPage = desktop.app!.windows().find(candidate => candidate.url().startsWith('http:'))!
    for (const name of ['先随便看看', '跳过']) {
      await startupPage.addLocatorHandler(startupPage.getByRole('button', { name, exact: true }), async button => { await button.click() })
    }
    const page = await launching
    await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByTestId('activity-account').click()
    await page.getByTestId('account-menu-settings').click()
    await page.getByTestId('account-settings-nav-browser').click()
    const panel = page.getByTestId('account-settings-browser')
    const history = panel.getByTestId('browser-settings-history')
    const data = panel.getByTestId('browser-settings-data')
    await history.getByRole('searchbox', { name: '搜索标题或网址' }).fill('x'.repeat(257))
    await expect(history.getByRole('alert')).toHaveText('浏览器操作无效，请重试。')
    await history.scrollIntoViewIfNeeded()
    await writeFile(join(directory, 'history-error.png'), await page.screenshot())
    await data.getByRole('combobox', { name: '清除范围' }).click()
    await page.getByRole('option', { name: '指定网站的历史和手动浏览数据' }).click()
    await data.getByRole('textbox', { name: '网站来源地址' }).fill('https://example.com/path')
    await data.getByRole('button', { name: '清除' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '清除' }).click()
    await expect(data.getByRole('alert')).toHaveText('浏览器操作无效，请重试。')
    await data.getByRole('alert').scrollIntoViewIfNeeded()
    await writeFile(join(directory, 'clear-error.png'), await page.screenshot())
    await expect(panel.getByTestId('browser-settings-cdp').getByRole('alert')).toHaveCount(0)
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})
