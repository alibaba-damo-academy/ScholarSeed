import { restoreBrowser } from './fixtures/browser'
import { openAccountSettings } from './fixtures/menu'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { BROWSER_COMMAND_CHANNEL, BROWSER_DATA_CHANNEL, BROWSER_DOWNLOAD_CHANNEL, BROWSER_HISTORY_CHANNEL, BROWSER_POLICY_CHANNEL, BROWSER_SNAPSHOT_CHANNEL } from '../src/browser'
import { DesktopSession, apiBase } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { ONBOARDING_GROUPS } from '../src/onboarding'
import type { Page } from '@playwright/test'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const ARTIFACTS = resolve('../../tmp/test_snapshot/desktop/browser-policy-feature-round1')
const RENDERER_PREFERENCES_FILE = 'renderer-preferences.json'
const SEEN_ONBOARDING = { seen: Object.fromEntries(ONBOARDING_GROUPS.map(group => [group, true])) }

async function captureProduct(desktop: DesktopSession, page: Page, name: string): Promise<void> {
  const window = await desktop.browserWindow(page)
  await desktop.app!.evaluate(({ app }) => app.focus({ steal: true }))
  await window.evaluate(native => { native.show(); native.focus() })
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`) })
  const media = await window.evaluate(native => ({ id: native.getMediaSourceId(), bounds: native.getBounds() }))
  const composite = await desktop.app!.evaluate(async ({ desktopCapturer }, target) => {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: target.bounds.width, height: target.bounds.height } })
    return sources.find(source => source.id === target.id)?.thumbnail.toPNG().toString('base64')
  }, media)
  if (composite) writeFileSync(join(ARTIFACTS, `${name}-native.png`), Buffer.from(composite, 'base64'))
  const pages = await window.evaluate(async native => Promise.all(native.contentView.children.filter(child => child.getVisible()).map(async child => {
    const contents = (child as Electron.WebContentsView).webContents
    return { url: contents.getURL(), png: (await contents.capturePage()).toPNG().toString('base64') }
  })))
  for (const [index, entry] of pages.entries()) writeFileSync(join(ARTIFACTS, `${name}-page-${index}.png`), Buffer.from(entry.png, 'base64'))
}

test('disabled browser cannot be restored, rendered, approved or reopened through native bridges', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const preferences = join(runtime.userData, RENDERER_PREFERENCES_FILE)
  writeFileSync(preferences, JSON.stringify({ language: 'zh', onboarding: SEEN_ONBOARDING, lastLocation: {
    view: 'browser', projectId: null, sessionId: null, sessionProjectId: null,
    settingsPage: 'browser', aiPanelOpen: false, aiPanelCover: false,
    target: { kind: 'tab', id: 'browser' }
  } }))
  const desktop = new DesktopSession(runtime, testInfo, { browserEnabled: false, nativeWindowLifecycle: true, preserveRuntime: true })
  mkdirSync(ARTIFACTS, { recursive: true })
  try {
    const page = await desktop.launch()
    await expect(page.getByTestId('activity-browser')).toHaveCount(0)
    await expect(page.getByRole('tab', { name: '浏览器', exact: true })).toHaveCount(0)
    await expect(page.getByTestId('browser-workspace')).toHaveCount(0)
    await expect(page.getByTestId('account-settings-browser')).toHaveCount(0)
    const rejection = await page.evaluate(async () => {
      const bridge = window.scholarseed
      return {
        browserEnabled: bridge.browserEnabled,
        replies: await Promise.all([
          bridge.browser.snapshot(), bridge.browser.dispatch({ kind: 'automation', enabled: true }),
          bridge.browser.history({ kind: 'query', query: { offset: 0, limit: 10 } }),
          bridge.browser.clearData({ kind: 'clear-all' }), bridge.browser.downloads({ kind: 'choose-directory' }),
          bridge.browser.policy({ kind: 'read' })
        ]),
        overlays: [Boolean(bridge.browserOverlay), Boolean(bridge.browserTooltip)],
        menu: await bridge.menu!.seed({ surface: 'browser-menu', tabId: null }),
        allow: await bridge.respondBrowserApproval!({} as never),
        deny: await bridge.respondBrowserHistoryApproval!({ decision: 'deny' } as never)
      }
    })
    expect(rejection.browserEnabled).toBe(false)
    expect(rejection.replies).toEqual(Array.from({ length: 6 }, () => ({ ok: false, error: 'desktop_bridge_unavailable' })))
    expect(rejection.overlays).toEqual([false, false])
    expect(rejection.menu.ok).toBe(false)
    expect(rejection.allow).toEqual({ ok: false, outcome: 'unknown' })
    expect(rejection.deny).toEqual({ ok: false, outcome: 'unknown' })
    const base = await apiBase(page)
    const health = await (await fetch(`${base}/api/healthz`)).json()
    expect(health.features.browser).toBe(false)
    await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByTestId('activity-home').click()
    await captureProduct(desktop, page, 'off-workbench')
    await openAccountSettings(page)
    await expect(page.getByTestId('account-settings-nav-browser')).toHaveCount(0)
    await expect(page.getByTestId('account-settings-nav-notifications')).toBeVisible()
    await captureProduct(desktop, page, 'off-settings')
    expect(existsSync(join(runtime.home, 'browser'))).toBe(false)
    writeFileSync(join(ARTIFACTS, 'off-evidence.json'), JSON.stringify({
      rejection, health, runtime,
      channels: [BROWSER_SNAPSHOT_CHANNEL, BROWSER_COMMAND_CHANNEL, BROWSER_HISTORY_CHANNEL, BROWSER_DATA_CHANNEL, BROWSER_DOWNLOAD_CHANNEL, BROWSER_POLICY_CHANNEL],
      windows: await desktop.app!.evaluate(({ webContents }) => webContents.getAllWebContents().map(contents => ({ type: contents.getType(), url: contents.getURL() })))
    }, null, 2))
    desktop.assertNoPageErrors()
  } finally { await desktop.close() }
})

test('explicit browser on retains current pages, settings and CDP; full restart off closes the old endpoint', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, RENDERER_PREFERENCES_FILE), JSON.stringify({ language: 'zh', browserAutomationEnabled: false, onboarding: SEEN_ONBOARDING }))
  const enabled = new DesktopSession(runtime, testInfo, { browserEnabled: true, nativeWindowLifecycle: true, preserveRuntime: true })
  const disabled = new DesktopSession(runtime, testInfo, { browserEnabled: false, nativeWindowLifecycle: true, preserveRuntime: true })
  mkdirSync(ARTIFACTS, { recursive: true })
  let oldPort: number | null = null
  try {
    const page = await enabled.launch()
    const base = await apiBase(page)
    expect((await (await fetch(`${base}/api/healthz`)).json()).features.browser).toBe(true)
    await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
    await restoreBrowser(page)
    await expect(page.getByTestId('browser-workspace')).toBeVisible()
    await page.getByRole('textbox', { name: '网址', exact: true }).fill(`${base}/api/healthz`)
    await page.getByRole('textbox', { name: '网址', exact: true }).press('Enter')
    await expect.poll(async () => {
      const reply = await page.evaluate(() => window.scholarseed.browser.snapshot())
      return reply.ok ? reply.snapshot.tabs.some(tab => tab.url.endsWith('/api/healthz') && !tab.loading) : false
    }).toBe(true)
    await captureProduct(enabled, page, 'on-workbench')
    await page.getByRole('button', { name: '更多浏览器功能', exact: true }).click()
    await expect.poll(() => enabled.app!.windows().some(candidate => candidate.url().includes('menu.html'))).toBe(true)
    const menuPage = enabled.app!.windows().find(candidate => candidate.url().includes('menu.html'))!
    await expect(menuPage.getByRole('menu')).toBeVisible()
    await expect(menuPage.getByRole('menuitem').first()).toBeVisible()
    const menuWindow = await enabled.browserWindow(menuPage)
    await expect.poll(() => menuWindow.evaluate(native => native.isVisible())).toBe(true)
    await menuPage.keyboard.press('Escape').catch(error => { if (!menuPage.isClosed()) throw error })
    await expect(page.getByRole('button', { name: '更多浏览器功能', exact: true })).toHaveAttribute('aria-expanded', 'false')
    await openAccountSettings(page)
    await page.getByTestId('account-settings-nav-browser').click()
    await expect(page.getByTestId('account-settings-browser')).toBeVisible()
    await page.getByTestId('browser-settings-cdp').getByRole('switch').click()
    await expect.poll(async () => {
      const reply = await page.evaluate(() => window.scholarseed.browser.snapshot())
      return reply.ok && reply.snapshot.automation.enabled
    }).toBe(true)
    const reply = await page.evaluate(() => window.scholarseed.browser.snapshot())
    oldPort = reply.ok ? reply.snapshot.automation.port : null
    expect(oldPort).not.toBeNull()
    await captureProduct(enabled, page, 'on-settings-cdp')
    await enabled.close()
    const browserAssets = readFileSync(join(runtime.home, 'browser', 'history.sqlite3'))
    const offPage = await disabled.launch()
    await expect(offPage.getByTestId('activity-browser')).toHaveCount(0)
    await expect(offPage.getByTestId('account-settings-nav-browser')).toHaveCount(0)
    expect(await offPage.evaluate(() => window.scholarseed.browser.dispatch({ kind: 'automation', enabled: true }))).toEqual({ ok: false, error: 'desktop_bridge_unavailable' })
    await expect(fetch(`http://127.0.0.1:${oldPort}/json/version`)).rejects.toThrow()
    expect(readFileSync(join(runtime.home, 'browser', 'history.sqlite3'))).toEqual(browserAssets)
    await captureProduct(disabled, offPage, 'off-restart')
    writeFileSync(join(ARTIFACTS, 'restart-evidence.json'), JSON.stringify({ oldPort, runtime, offHealth: await (await fetch(`${await apiBase(offPage)}/api/healthz`)).json() }, null, 2))
    disabled.assertNoPageErrors()
  } finally { await enabled.close(); await disabled.close() }
})
