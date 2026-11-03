import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const HISTORY_URL = 'http://httpbingo.org/html'
const OTHER_URL = 'http://httpbingo.org/get'
const PAGE_TEXT = /Herman Melville - Moby-Dick/

test('real Desktop address bar offers local history and never searches the web without explicit selection', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo, { browserEnabled: true, nativeWindowLifecycle: true })
  const directory = resolve('../../tmp/test_snapshot/desktop/browser-address-history', `run-${Date.now()}-${process.pid}`)
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
    await page.getByTestId('activity-browser').click()
    const address = page.getByRole('textbox', { name: '网址', exact: true })
    const nativeWindow = await desktop.browserWindow(page)
    const captureNative = async (name: string) => {
      const media = await nativeWindow.evaluate(window => ({ id: window.getMediaSourceId(), bounds: window.getBounds() }))
      const native = await desktop.app!.evaluate(async ({ desktopCapturer }, target) => {
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: target.bounds.width, height: target.bounds.height } })
        return sources.find(source => source.id === target.id)?.thumbnail.toPNG().toString('base64')
      }, media)
      expect(native).toBeTruthy()
      const screenshot = join(directory, `${name}.png`)
      await writeFile(screenshot, Buffer.from(native!, 'base64'))
      await testInfo.attach(name, { path: screenshot, contentType: 'image/png' })
      console.log(`Browser address screenshot: ${screenshot}`)
    }
    const assertLoaded = async (url: string, body: RegExp) => {
      await expect.poll(async () => {
        const reply = await page.evaluate(() => window.scholarseed.browser.snapshot())
        if (!reply.ok) return null
        const active = reply.snapshot.tabs.find(tab => tab.tabId === reply.snapshot.activeTabId)
        return active && { url: active.url, loading: active.loading, error: active.navigationError }
      }, { timeout: 45_000 }).toEqual({ url, loading: false, error: null })
      await expect.poll(() => nativeWindow.evaluate((window, targetUrl) => {
        const view = window.contentView.children.find(child => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL() === targetUrl) as Electron.WebContentsView | undefined
        return view?.webContents.executeJavaScript('document.body?.innerText ?? ""')
      }, url).catch(() => ''), { timeout: 45_000 }).toMatch(body)
    }
    await address.fill(HISTORY_URL)
    await address.press('Enter')
    await assertLoaded(HISTORY_URL, PAGE_TEXT)
    await address.fill(OTHER_URL)
    await address.press('Enter')
    await assertLoaded(OTHER_URL, /httpbingo\.org/)
    await address.fill('/html')
    const suggestion = page.getByRole('option', { name: /httpbingo\.org\/html/ })
    await expect(suggestion).toBeVisible()
    await address.press('ArrowDown')
    await expect(suggestion).toBeFocused()
    await suggestion.press('Enter')
    await assertLoaded(HISTORY_URL, PAGE_TEXT)
    await address.fill('private research phrase')
    const search = page.getByRole('button', { name: /在 Google 搜索“private research phrase”/ })
    await expect(search).toBeVisible()
    await expect(search).toContainText('会将搜索词发送给 Google')
    const before = await page.evaluate(() => window.scholarseed.browser.snapshot())
    expect(before.ok && before.snapshot.tabs.find(tab => tab.tabId === before.snapshot.activeTabId)?.url).toBe(HISTORY_URL)
    await captureNative('address-history-native')
    await nativeWindow.evaluate(window => {
      const view = window.contentView.children.find(child => 'webContents' in child
        && (child as Electron.WebContentsView).webContents.getURL() === 'http://httpbingo.org/html') as Electron.WebContentsView
      ;(globalThis as typeof globalThis & { __browserSearchNavigation?: string }).__browserSearchNavigation = ''
      view.webContents.once('did-start-navigation', details => {
        ;(globalThis as typeof globalThis & { __browserSearchNavigation?: string }).__browserSearchNavigation = details.url
      })
    })
    await search.click()
    const searchUrl = 'https://www.google.com/search?q=private%20research%20phrase'
    await expect.poll(() => desktop.app!.evaluate(() =>
      (globalThis as typeof globalThis & { __browserSearchNavigation?: string }).__browserSearchNavigation
    )).toBe(searchUrl)
    await expect.poll(async () => {
      const reply = await page.evaluate(() => window.scholarseed.browser.snapshot())
      if (!reply.ok) return null
      const active = reply.snapshot.tabs.find(tab => tab.tabId === reply.snapshot.activeTabId)
      return active && { origin: new URL(active.url).origin, loading: active.loading, error: active.navigationError }
    }, { timeout: 45_000 }).toEqual({ origin: 'https://www.google.com', loading: false, error: null })
    await captureNative('google-after-search-native')
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})
