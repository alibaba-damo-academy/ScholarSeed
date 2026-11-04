import { restoreBrowser, setBrowserDevtools } from './fixtures/browser'
import { openProjectMenu } from './fixtures/projects'
import { openAccountSettings } from './fixtures/menu'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DesktopSession, apiBase } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const ARTIFACTS = resolve('../../tmp/test_snapshot/desktop/browser-task6')

test('embedded browser stays inside the workbench and hides for overlays without losing pages', async ({}, testInfo) => {
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo, { browserEnabled: true, nativeWindowLifecycle: true })
  mkdirSync(ARTIFACTS, { recursive: true })
  try {
    const launching = desktop.launch()
    await expect.poll(() => desktop.app?.windows().find(candidate => candidate.url().startsWith('http:'))?.url(), { timeout: 45_000 }).toBeTruthy()
    const startupPage = desktop.app!.windows().find(candidate => candidate.url().startsWith('http:'))!
    for (const name of ['先随便看看', '跳过']) {
      await startupPage.addLocatorHandler(startupPage.getByRole('button', { name, exact: true }), async button => { await button.click() })
    }
    const page = await launching
    const window = await desktop.browserWindow(page)
    await desktop.app!.evaluate(({ app }) => app.focus({ steal: true }))
    await window.evaluate(native => { native.show(); native.focus() })
    const nativeViews = () => window.evaluate(native => native.contentView.children.filter(child => {
      const url = (child as Electron.WebContentsView).webContents.getURL()
      return url.startsWith('http:') || url.startsWith('https:') || url === 'about:blank'
    }).map(child => ({ bounds: child.getBounds(), visible: child.getVisible() })))
    const capture = async (name: string) => {
      const png = await window.evaluate(async native => (await native.capturePage()).toPNG().toString('base64'))
      writeFileSync(join(ARTIFACTS, `${name}.png`), Buffer.from(png, 'base64'))
      const media = await window.evaluate(native => ({ id: native.getMediaSourceId(), bounds: native.getBounds() }))
      const composite = await desktop.app!.evaluate(async ({ desktopCapturer, systemPreferences }, media) => {
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: media.bounds.width, height: media.bounds.height } })
        return { png: sources.find(source => source.id === media.id)?.thumbnail.toPNG().toString('base64'), permission: systemPreferences.getMediaAccessStatus('screen'), requestedId: media.id, availableIds: sources.map(source => source.id) }
      }, media)
      if (composite.png) writeFileSync(join(ARTIFACTS, `${name}-native.png`), Buffer.from(composite.png, 'base64'))
      writeFileSync(join(ARTIFACTS, `${name}-capture.json`), JSON.stringify({ ...composite, png: Boolean(composite.png), window: await window.evaluate(native => ({ visible: native.isVisible(), focused: native.isFocused(), minimized: native.isMinimized() })) }, null, 2))
      const evidence = await window.evaluate(async native => Promise.all(native.contentView.children.map(async child => {
        const contents = (child as Electron.WebContentsView).webContents
        return { bounds: child.getBounds(), visible: child.getVisible(), url: contents.getURL(), loading: contents.isLoading(), text: await contents.executeJavaScript('document.body?.innerText'), screenshot: child.getVisible() ? (await contents.capturePage()).toPNG().toString('base64') : null }
      })))
      for (const [index, entry] of evidence.entries()) if (entry.screenshot) writeFileSync(join(ARTIFACTS, `${name}-page-${index}.png`), Buffer.from(entry.screenshot, 'base64'))
      writeFileSync(join(ARTIFACTS, `${name}.json`), JSON.stringify(evidence.map(({ screenshot: _, ...entry }) => entry), null, 2))
    }
    await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByTestId('activity-home').click()
    await restoreBrowser(page)
    await expect(page.getByTestId('browser-workspace')).toBeVisible()
    await expect(page.getByTestId('topbar-panel-toggle')).toHaveCount(0)
    await expect(page.getByRole('tab', { name: '浏览器', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '关闭 浏览器', exact: true })).toHaveCount(0)
    await page.getByRole('textbox', { name: '网址', exact: true }).fill(`${await apiBase(page)}/api/healthz`)
    await page.getByRole('textbox', { name: '网址', exact: true }).press('Enter')
    await page.mouse.move(500, 20)
    await capture('initial')
    writeFileSync(join(ARTIFACTS, 'initial.json'), JSON.stringify({ views: await nativeViews(), dom: await page.evaluate(() => ({ hidden: document.hidden, viewport: document.querySelector('[data-browser-viewport]')?.getBoundingClientRect().toJSON(), overlays: [...document.body.children, ...document.querySelectorAll('aside,[role="dialog"],[role="tooltip"]')].map(element => ({ tag: element.tagName, class: element.className, rect: element.getBoundingClientRect().toJSON() })) })), snapshot: await page.evaluate(() => globalThis.window.scholarseed.browser.snapshot()) }, null, 2))
    await expect.poll(async () => (await nativeViews()).filter(view => view.visible).length).toBe(1)
    await openAccountSettings(page)
    await page.getByTestId('account-settings-nav-browser').click()
    await expect(page.getByTestId('account-settings-browser')).toBeVisible()
    await expect.poll(async () => (await nativeViews()).every(view => !view.visible)).toBe(true)
    await capture('browser-settings')
    const downloads = page.getByTestId('browser-settings-downloads')
    await downloads.scrollIntoViewIfNeeded()
    await expect(downloads).toBeVisible()
    await expect(page.getByTestId('browser-download-directory')).not.toBeEmpty()
    await capture('browser-downloads-settings')
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭', exact: true }).click()
    await expect.poll(async () => (await nativeViews()).some(view => view.visible)).toBe(true)
    for (const zoom of [1, 1.25]) {
      await window.evaluate((native, factor) => native.webContents.setZoomFactor(factor), zoom)
      await expect.poll(async () => {
        const rect = await page.getByTestId('browser-viewport').boundingBox()
        const view = (await nativeViews()).find(item => item.visible)
        return Boolean(rect && view && Math.abs(view.bounds.x - rect.x * zoom) <= 1 && Math.abs(view.bounds.y - rect.y * zoom) <= 1 && view.bounds.width <= rect.width * zoom + 1 && view.bounds.height <= rect.height * zoom + 1 && view.bounds.width * view.bounds.height > rect.width * rect.height * zoom * zoom * 0.85)
      }).toBe(true)
      await capture(`normal-zoom-${zoom}`)
    }
    await window.evaluate(native => native.webContents.setZoomFactor(1))
    await openProjectMenu(page)
    await expect.poll(async () => {
      const overlay = await page.getByTestId('project-menu').boundingBox()
      return overlay && (await nativeViews()).every(view => !view.visible || view.bounds.x + view.bounds.width <= overlay.x || view.bounds.y >= overlay.y + overlay.height || view.bounds.y + view.bounds.height <= overlay.y || view.bounds.x >= overlay.x + overlay.width)
    }).toBe(true)
    await capture('project-popover')
    await page.getByTestId('project-menu-create').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect.poll(async () => (await nativeViews()).every(view => !view.visible)).toBe(true)
    await capture('project-dialog')
    await page.getByTestId('project-new-modal').getByTestId('project-create-name').fill('Browser geometry project')
    await page.getByTestId('project-create').click()
    await expect(page.getByTestId('project-new-modal')).toHaveCount(0)
    await expect.poll(async () => (await nativeViews()).every(view => !view.visible)).toBe(true)
    await restoreBrowser(page)
    await page.getByRole('button', { name: '打开新的标签页', exact: true }).hover()
    await expect(page.getByRole('tooltip', { name: '打开新的标签页', exact: true })).toBeVisible()
    await expect.poll(async () => (await nativeViews()).some(view => view.visible)).toBe(true)
    await page.mouse.move(500, 20)
    await expect(page.getByRole('tooltip', { name: '打开新的标签页', exact: true })).toHaveCount(0)
    await expect.poll(async () => (await nativeViews()).some(view => view.visible)).toBe(true)
    expect(await nativeViews()).toHaveLength(1)
    await capture('project-entry')
    await page.getByTestId('topbar-ai').click()
    await expect(page.getByTestId('ai-panel')).toBeVisible()
    await capture('ai-panel')
    await page.getByTestId('ai-toggle-dock').click()
    await expect.poll(async () => (await nativeViews()).every(view => !view.visible)).toBe(true)
    await capture('ai-floating')
    await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
    await expect.poll(async () => (await nativeViews()).some(view => view.visible)).toBe(true)
    await window.evaluate(native => native.setSize(800, 650))
    await capture('narrow')
    await page.getByTestId('activity-home').click()
    await expect.poll(async () => (await nativeViews()).every(view => !view.visible)).toBe(true)
    await restoreBrowser(page)
    await page.mouse.move(500, 20)
    await expect.poll(async () => (await nativeViews()).some(view => view.visible)).toBe(true)
    expect(await nativeViews()).toHaveLength(1)
    await page.getByRole('button', { name: '打开新的标签页', exact: true }).click()
    await expect.poll(async () => (await nativeViews()).length).toBe(2)
    await expect(page.getByRole('button', { name: '打开新的标签页', exact: true })).toBeEnabled()
    await page.getByTestId('browser-workspace').getByRole('tab', { selected: true }).getByRole('button', { name: /^关闭 / }).click()
    await expect.poll(async () => (await nativeViews()).length).toBe(1)
    await setBrowserDevtools(page, true)
    await capture('devtools-open')
    await setBrowserDevtools(page, false)
    await window.evaluate(native => native.minimize())
    await expect.poll(async () => (await nativeViews()).every(view => !view.visible)).toBe(true)
    await window.evaluate(native => native.restore())
    await expect.poll(async () => (await nativeViews()).some(view => view.visible)).toBe(true)
    await window.evaluate(native => native.setFullScreen(true))
    await expect.poll(() => window.evaluate(native => native.isFullScreen())).toBe(true)
    await capture('fullscreen')
    await window.evaluate(native => native.setFullScreen(false))
    await expect.poll(() => window.evaluate(native => native.isFullScreen())).toBe(false)
    writeFileSync(join(ARTIFACTS, 'geometry.json'), JSON.stringify({ native: await nativeViews(), viewport: await page.getByTestId('browser-viewport').boundingBox(), content: await window.evaluate(native => native.getContentBounds()) }, null, 2))
  } finally { await desktop.attachArtifacts() }
})

test('dark narrow Desktop keeps browser controls and settings usable', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const preferencesPath = join(runtime.userData, 'renderer-preferences.json')
  writeFileSync(preferencesPath, JSON.stringify({ ...JSON.parse(readFileSync(preferencesPath, 'utf8')), theme: 'dark' }))
  const desktop = new DesktopSession(runtime, testInfo, { browserEnabled: true, nativeWindowLifecycle: true })
  mkdirSync(ARTIFACTS, { recursive: true })
  try {
    const launching = desktop.launch()
    await expect.poll(() => desktop.app?.windows().find(candidate => candidate.url().startsWith('http:'))?.url(), { timeout: 45_000 }).toBeTruthy()
    const startupPage = desktop.app!.windows().find(candidate => candidate.url().startsWith('http:'))!
    for (const name of ['先随便看看', '跳过']) {
      await startupPage.addLocatorHandler(startupPage.getByRole('button', { name, exact: true }), async button => { await button.click() })
    }
    const page = await launching
    const nativeWindow = await desktop.browserWindow(page)
    await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
    await nativeWindow.evaluate(native => native.setSize(800, 650))
    await restoreBrowser(page)
    const destination = `${await apiBase(page)}/api/healthz`
    await page.getByRole('textbox', { name: '网址', exact: true }).fill(destination)
    await page.getByRole('textbox', { name: '网址', exact: true }).press('Enter')
    await expect.poll(async () => {
      const reply = await page.evaluate(() => window.scholarseed.browser.snapshot())
      const active = reply.ok ? reply.snapshot.tabs.find(tab => tab.tabId === reply.snapshot.activeTabId) : null
      return active && { url: active.url, loading: active.loading, error: active.navigationError }
    }).toEqual({ url: destination, loading: false, error: null })
    await expect(page.getByTestId('browser-workspace')).toBeVisible()
    await setBrowserDevtools(page, true)
    await setBrowserDevtools(page, false)
    const media = await nativeWindow.evaluate(native => ({ id: native.getMediaSourceId(), bounds: native.getBounds() }))
    const screenshot = await desktop.app!.evaluate(async ({ desktopCapturer }, source) => {
      const captures = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: source.bounds.width, height: source.bounds.height } })
      return captures.find(capture => capture.id === source.id)?.thumbnail.toPNG().toString('base64') ?? null
    }, media)
    expect(screenshot).toBeTruthy()
    writeFileSync(join(ARTIFACTS, 'browser-dark-narrow.png'), Buffer.from(screenshot!, 'base64'))
    await openAccountSettings(page)
    await page.getByTestId('account-settings-nav-browser').click()
    await expect(page.getByTestId('account-settings-browser')).toBeVisible()
    await expect(page.getByRole('switch', { name: '启用浏览器自动化', exact: true })).toBeVisible()
    writeFileSync(join(ARTIFACTS, 'browser-settings-dark-narrow.png'), await page.screenshot())
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('Browser settings retry recovers a repaired Agent policy file', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const browserHome = join(runtime.home, 'browser')
  mkdirSync(browserHome, { recursive: true })
  const policyPath = join(browserHome, 'agent-policy.json')
  writeFileSync(policyPath, '{bad json')
  const desktop = new DesktopSession(runtime, testInfo, { browserEnabled: true, nativeWindowLifecycle: true })
  mkdirSync(ARTIFACTS, { recursive: true })
  try {
    const launching = desktop.launch()
    await expect.poll(() => desktop.app?.windows().find(candidate => candidate.url().startsWith('http:'))?.url(), { timeout: 45_000 }).toBeTruthy()
    const startupPage = desktop.app!.windows().find(candidate => candidate.url().startsWith('http:'))!
    for (const name of ['先随便看看', '跳过']) {
      await startupPage.addLocatorHandler(startupPage.getByRole('button', { name, exact: true }), async button => { await button.click() })
    }
    const page = await launching
    await openAccountSettings(page)
    await page.getByTestId('account-settings-nav-browser').click()
    const sites = page.getByTestId('browser-settings-agent-sites')
    await expect(sites.getByRole('button', { name: '重新读取网站规则' })).toBeVisible()
    await expect(sites.getByRole('switch', { name: 'Agent Browser Use' })).toBeDisabled()
    rmSync(policyPath)
    await sites.getByRole('button', { name: '重新读取网站规则' }).click()
    await expect(sites.getByRole('switch', { name: 'Agent Browser Use' })).toBeEnabled()
    await expect(sites.getByRole('button', { name: '重新读取网站规则' })).toHaveCount(0)
    writeFileSync(join(ARTIFACTS, 'agent-policy-recovered.png'), await page.screenshot())
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})
