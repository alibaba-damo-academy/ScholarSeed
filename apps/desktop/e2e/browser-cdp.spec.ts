import { focusBrowserAddress, restoreBrowser, setBrowserDevtools } from './fixtures/browser'
import { openAccountSettings } from './fixtures/menu'
import { test, expect, chromium } from '@playwright/test'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import electron from 'electron'
import { WebSocket } from 'ws'
import { once } from 'node:events'
import { ONBOARDING_GROUPS } from '../src/onboarding'
import type { BrowserSnapshot } from '../src/browser.ts'
import { DesktopSession, apiBase } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const execFileAsync = promisify(execFile)
const PUBLIC_NAVIGATION_TIMEOUT_MS = 30_000
const START_PAGE_THEMES = ['light', 'dark'] as const
const START_PAGE_NARROW_SIZE = { width: 960, height: 640 }
const RENDERER_PREFERENCES_FILE = 'renderer-preferences.json'
const NATIVE_PIXEL_ALIGNMENT_TOLERANCE = 1

for (const theme of START_PAGE_THEMES) test(`native activity tooltips preserve the live webpage in ${theme} theme`, async ({}, testInfo) => {
  test.setTimeout(120_000)
  const runtime = createRuntime(testInfo)
  await writeFile(join(runtime.userData, RENDERER_PREFERENCES_FILE), JSON.stringify({
    language: 'zh', theme, onboarding: { seen: Object.fromEntries(ONBOARDING_GROUPS.map(group => [group, true])) }
  }))
  const desktop = new DesktopSession(runtime, testInfo, { browserEnabled: true, nativeWindowLifecycle: true })
  const directory = resolve('../../tmp/test_snapshot/desktop/browser-tooltip')
  await mkdir(directory, { recursive: true })
  try {
    const page = await desktop.launch()
    const nativeWindow = await desktop.browserWindow(page)
    await desktop.app!.evaluate(({ app }) => app.focus({ steal: true }))
    await nativeWindow.evaluate(native => { native.show(); native.focus() })
    await expect.poll(() => nativeWindow.evaluate(native => native.isFocused())).toBe(true)
    await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
    await restoreBrowser(page)
    const destination = 'https://example.com/'
    const address = page.getByRole('textbox', { name: '网址', exact: true })
    await address.fill(destination)
    await address.press('Enter')
    const observe = () => nativeWindow.evaluate(async native => Promise.all(native.contentView.children.map(async child => {
      const contents = (child as Electron.WebContentsView).webContents
      return { url: contents.getURL(), bounds: child.getBounds(), visible: child.getVisible(),
        page: await contents.executeJavaScript('(() => { const tooltip = document.querySelector("[role=tooltip]"); return { width: innerWidth, height: innerHeight, scrollX, scrollY, text: document.body?.innerText, theme: document.documentElement.dataset.theme, tooltip: tooltip?.textContent, tooltipRect: tooltip?.getBoundingClientRect().toJSON(), tooltipTranslate: tooltip ? getComputedStyle(tooltip).translate : undefined } })()') }
    })))
    const capture = async (name: string) => {
      await nativeWindow.evaluate(async native => Promise.all(native.contentView.children
        .filter(child => child.getVisible())
        .map(child => (child as Electron.WebContentsView).webContents.executeJavaScript(
          'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'))))
      const windowId = await nativeWindow.evaluate(native => native.id)
      const captured = await desktop.app!.evaluate(async ({ desktopCapturer, BrowserWindow }, identity) => {
        const native = BrowserWindow.fromId(identity)!
        let blurCount = 0
        const recordBlur = () => { blurCount += 1 }
        const state = async () => ({ focused: native.isFocused(), views: await Promise.all(native.contentView.children.map(async child => {
          const contents = (child as Electron.WebContentsView).webContents
          return { id: contents.id, bounds: child.getBounds(), visible: child.getVisible(),
            tooltip: await contents.executeJavaScript('document.querySelector("[role=tooltip]")?.textContent') }
        })) })
        native.on('blur', recordBlur)
        try {
          const before = await state()
          const sourceId = native.getMediaSourceId()
          const captures = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: native.getBounds() })
          const png = captures.find(source => source.id === sourceId)?.thumbnail.toPNG().toString('base64')
          const after = await state()
          return { png, before, after, blurCount, valid: Boolean(png) && before.focused && after.focused
            && blurCount === 0 && JSON.stringify(before.views) === JSON.stringify(after.views) }
        } finally { native.off('blur', recordBlur) }
      }, windowId)
      const { png, ...evidence } = captured
      await writeFile(join(directory, `${theme}-${name}-capture-state.json`), JSON.stringify(evidence, null, 2))
      if (png) await writeFile(join(directory, `${theme}-${name}-${captured.valid ? '' : 'invalid-'}native.png`), Buffer.from(png, 'base64'))
      expect(captured.valid, 'capture must retain focus and unchanged native owners; blurred captures are invalid visual evidence').toBe(true)
    }
    await expect.poll(async () => (await observe()).find(view => view.url === destination)?.page.text,
      { timeout: PUBLIC_NAVIGATION_TIMEOUT_MS }).toContain('This domain is for use in documentation examples')
    await page.mouse.move(500, 20)
    await expect.poll(async () => (await observe()).find(view => view.url === destination)?.visible).toBe(true)
    const baseline = (await observe()).find(view => view.url === destination)!
    const viewport = await page.getByTestId('browser-viewport').boundingBox()
    const unchanged = async () => {
      expect((await observe()).find(view => view.url === destination)).toEqual(baseline)
      expect(await page.getByTestId('browser-viewport').boundingBox()).toEqual(viewport)
    }
    const nativeTooltip = async () => (await observe()).find(view => view.visible && view.page.tooltip)
    const activity = page.getByRole('button', { name: '扩展', exact: true })
    for (const cycle of ['first', 'repeat']) {
      await desktop.app!.evaluate(({ app }) => app.focus({ steal: true }))
      await nativeWindow.evaluate(native => native.focus())
      await expect.poll(() => nativeWindow.evaluate(native => native.isFocused())).toBe(true)
      await page.mouse.move(500, 20)
      await expect.poll(async () => Boolean(await nativeTooltip())).toBe(false)
      await activity.hover()
      await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[role=tooltip]')]
        .some(element => element.textContent === '扩展' && element.getBoundingClientRect().height > 0))).toBe(true)
      const tooltipRect = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[role=tooltip]')]
        .find(element => element.textContent === '扩展')!.getBoundingClientRect().toJSON())
      expect(tooltipRect.bottom, 'exercise the original overlapping sidebar tooltip').toBeGreaterThan(baseline.bounds.y)
      const hovered = await observe()
      await writeFile(join(directory, `${theme}-${cycle}-hover-state.json`), JSON.stringify({ baseline, viewport, tooltipRect, views: hovered }, null, 2))
      if (!hovered.find(view => view.url === destination)?.visible) await capture(`${cycle}-hover`)
      expect(hovered.find(view => view.url === destination)?.visible, 'hover must not hide the live webpage').toBe(true)
      try {
        await expect.poll(async () => (await nativeTooltip())?.page.tooltip).toBe('扩展')
      } catch (error) {
        const windowState = await nativeWindow.evaluate(native => ({ focused: native.isFocused(), visible: native.isVisible(), productFocused: native.webContents.isFocused() }))
        const renderer = await page.evaluate(() => ({ hidden: document.hidden, focused: document.hasFocus(), tooltips: [...document.querySelectorAll<HTMLElement>('[role=tooltip]')]
          .map(element => ({ html: element.outerHTML, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, rect: element.getBoundingClientRect().toJSON(), opacity: getComputedStyle(element).opacity, visible: element.checkVisibility({ visibilityProperty: true }) })) }))
        await writeFile(join(directory, `${theme}-${cycle}-missing-tooltip.json`), JSON.stringify({ windowState, renderer, views: await observe() }, null, 2))
        throw error
      }
      const overlay = (await nativeTooltip())!
      await writeFile(join(directory, `${theme}-${cycle}-native-tooltip-state.json`), JSON.stringify(overlay, null, 2))
      expect(overlay.page.theme).toBe(theme)
      expect(overlay.page.tooltipRect.x, 'native tooltip content must not be translated outside its own view').toBeGreaterThanOrEqual(0)
      expect(overlay.page.tooltipRect.y).toBeGreaterThanOrEqual(0)
      expect(overlay.page.tooltipRect.right).toBeLessThanOrEqual(overlay.page.width)
      expect(overlay.page.tooltipRect.bottom).toBeLessThanOrEqual(overlay.page.height)
      expect(Math.abs(overlay.bounds.x + overlay.page.tooltipRect.x - tooltipRect.x)).toBeLessThanOrEqual(NATIVE_PIXEL_ALIGNMENT_TOLERANCE)
      expect(Math.abs(overlay.bounds.y + overlay.page.tooltipRect.y - tooltipRect.y)).toBeLessThanOrEqual(NATIVE_PIXEL_ALIGNMENT_TOLERANCE)
      expect(Math.abs(overlay.page.tooltipRect.width - tooltipRect.width)).toBeLessThanOrEqual(NATIVE_PIXEL_ALIGNMENT_TOLERANCE)
      expect(Math.abs(overlay.page.tooltipRect.height - tooltipRect.height)).toBeLessThanOrEqual(NATIVE_PIXEL_ALIGNMENT_TOLERANCE)
      await unchanged()
      await capture(`${cycle}-hover`)
      await desktop.app!.evaluate(({ app }) => app.focus({ steal: true }))
      await nativeWindow.evaluate(native => native.focus())
      await expect.poll(() => nativeWindow.evaluate(native => native.isFocused())).toBe(true)
      await page.mouse.move(500, 20)
      await expect.poll(async () => Boolean(await nativeTooltip())).toBe(false)
      await unchanged()
    }
    await activity.hover()
    await expect.poll(async () => (await nativeTooltip())?.page.tooltip).toBe('扩展')
    await page.getByTestId('activity-home').hover()
    await expect(page.getByRole('tooltip', { name: '项目中心', exact: true })).toBeVisible()
    await unchanged()
    await page.mouse.move(500, 20)
    await expect.poll(async () => Boolean(await nativeTooltip())).toBe(false)
    await unchanged()
    await capture('dismissed')
  } finally { await desktop.close() }
})

for (const theme of START_PAGE_THEMES) test(`native address suggestions preserve the live webpage in ${theme} theme`, async ({}, testInfo) => {
  test.setTimeout(120_000)
  const runtime = createRuntime(testInfo)
  await writeFile(join(runtime.userData, RENDERER_PREFERENCES_FILE), JSON.stringify({
    language: 'zh', theme, browserAutomationEnabled: false,
    onboarding: { seen: Object.fromEntries(ONBOARDING_GROUPS.map(group => [group, true])) }
  }))
  const desktop = new DesktopSession(runtime, testInfo, { browserEnabled: true, nativeWindowLifecycle: true })
  const directory = resolve('../../tmp/test_snapshot/desktop/browser-overlay')
  await mkdir(directory, { recursive: true })
  try {
    const page = await desktop.launch()
    const consoleErrors: string[] = []
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    const nativeWindow = await desktop.browserWindow(page)
    await desktop.app!.evaluate(({ app }) => app.focus({ steal: true }))
    await nativeWindow.evaluate(native => { native.show(); native.focus() })
    await expect.poll(() => nativeWindow.evaluate(native => native.isFocused())).toBe(true)
    await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
    await restoreBrowser(page)
    const address = page.getByRole('textbox', { name: '网址', exact: true })
    const destination = 'https://example.com/'
    await address.fill(destination)
    await address.press('Enter')
    const observe = () => nativeWindow.evaluate(async native => Promise.all(native.contentView.children.map(async child => {
      const contents = (child as Electron.WebContentsView).webContents
      return { url: contents.getURL(), bounds: child.getBounds(), visible: child.getVisible(),
        page: await contents.executeJavaScript('({ width: innerWidth, height: innerHeight, scrollX, scrollY, text: document.body?.innerText, theme: document.documentElement.dataset.theme })') }
    })))
    const diagnose = async (stage: string) => {
      const native = await nativeWindow.evaluate(async window => ({
        focused: window.isFocused(), visible: window.isVisible(), minimized: window.isMinimized(), bounds: window.getBounds(),
        productFocused: window.webContents.isFocused(), children: await Promise.all(window.contentView.children.map(async child => {
          const contents = (child as Electron.WebContentsView).webContents
          return { bounds: child.getBounds(), visible: child.getVisible(), focused: contents.isFocused(), url: contents.getURL(),
            dom: await contents.executeJavaScript('({ hidden: document.hidden, active: document.activeElement?.outerHTML, text: document.body?.innerText })') }
        }))
      }))
      const main = await page.evaluate(() => ({ hidden: document.hidden, active: document.activeElement?.outerHTML,
        address: document.querySelector<HTMLInputElement>('input[aria-label="网址"]')?.value,
        expanded: document.querySelector('input[aria-label="网址"]')?.getAttribute('aria-expanded'),
        surfaces: [...document.querySelectorAll<HTMLElement>('[role="dialog"],[role="menu"],[role="listbox"],[role="tooltip"]')]
          .map(element => ({ role: element.getAttribute('role'), visible: element.checkVisibility({ visibilityProperty: true }), text: element.innerText, bounds: element.getBoundingClientRect().toJSON() })) }))
      await writeFile(join(directory, `${theme}-failure-diagnostic.json`), JSON.stringify({ stage, native, main, consoleErrors }, null, 2))
    }
    const waitOptions = () => expect.poll(() => nativeWindow.evaluate(async native => {
      const overlay = native.contentView.children.find(child => child.getVisible() && (child as Electron.WebContentsView).webContents.getURL().includes('overlay.html')) as Electron.WebContentsView | undefined
      return overlay ? overlay.webContents.executeJavaScript('document.querySelectorAll("[role=option]").length') : 0
    }), { timeout: 15_000 }).toBeGreaterThan(0)
    await expect.poll(async () => (await observe()).find(view => view.url === destination)?.page.text, { timeout: PUBLIC_NAVIGATION_TIMEOUT_MS }).toContain('This domain is for use in documentation examples')
    await page.mouse.move(500, 20)
    await expect.poll(async () => (await observe()).find(view => view.url === destination)?.visible).toBe(true)
    const capture = async (name: string) => {
      await desktop.app!.evaluate(({ app }) => app.focus({ steal: true }))
      await nativeWindow.evaluate(native => native.focus())
      await expect.poll(() => nativeWindow.evaluate(native => native.isFocused())).toBe(true)
      if (name.includes('expanded')) {
        const views = await observe()
        expect(views.find(view => view.url === destination)?.visible).toBe(true)
        expect(views.find(view => view.url.includes('overlay.html'))?.visible).toBe(true)
      }
      const media = await nativeWindow.evaluate(native => ({ id: native.getMediaSourceId(), bounds: native.getBounds(), focused: native.isFocused() }))
      expect(media.focused).toBe(true)
      const png = await desktop.app!.evaluate(async ({ desktopCapturer }, source) => {
        const captures = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: source.bounds })
        return captures.find(capture => capture.id === source.id)?.thumbnail.toPNG().toString('base64')
      }, media)
      expect(png, 'native composite capture required').toBeTruthy()
      await writeFile(join(directory, `${theme}-${name}-native.png`), Buffer.from(png!, 'base64'))
    }
    for (const size of [null, START_PAGE_NARROW_SIZE]) {
      if (size) await nativeWindow.evaluate((native, dimensions) => native.setSize(dimensions.width, dimensions.height), size)
      await expect.poll(async () => {
        const bounds = (await observe()).find(view => view.url === destination)?.bounds
        const viewport = await page.getByTestId('browser-viewport').boundingBox()
        return Boolean(bounds && viewport && bounds.width === Math.round(viewport.width) && bounds.height === Math.round(viewport.height))
      }).toBe(true)
      await expect.poll(async () => (await observe()).find(view => view.url === destination)?.bounds.height).toBeGreaterThan(0)
      const closed = (await observe()).find(view => view.url === destination)!
      const rect = await page.getByTestId('browser-viewport').boundingBox()
      await capture(size ? 'narrow-closed' : 'closed')
      await focusBrowserAddress(page)
      await address.click()
      await address.fill('')
      await address.fill('example.com')
      await expect(address).toBeFocused()
      try { await expect.poll(async () => (await observe()).filter(view => view.visible && view.url !== destination).length).toBe(1) } catch (error) {
        await diagnose(size ? 'narrow-expanded-visible' : 'normal-expanded-visible')
        throw error
      }
      try { await waitOptions() } catch (error) {
        await writeFile(join(directory, `${theme}-missing-options.json`), JSON.stringify({ views: await observe(), history: await page.evaluate(() => window.scholarseed.browser.history({ kind: 'query', query: { search: 'example.com', offset: 0, limit: 20 } })) }, null, 2))
        await capture('missing-options')
        throw error
      }
      const expanded = await observe()
      const webpage = expanded.find(view => view.url === destination)!
      expect(webpage).toEqual(closed)
      expect(await page.getByTestId('browser-viewport').boundingBox()).toEqual(rect)
      expect(expanded.find(view => view.visible && view.url !== destination)?.page.theme).toBe(theme)
      const samples = await nativeWindow.evaluate(async (native, url) => {
        const contents = (native.contentView.children.find(child => (child as Electron.WebContentsView).webContents.getURL() === url) as Electron.WebContentsView).webContents
        return contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(first => requestAnimationFrame(second => resolve([first, second]))))')
      }, destination)
      expect(samples[1]).toBeGreaterThan(samples[0])
      await writeFile(join(directory, `${theme}-${size ? 'narrow' : 'normal'}-bounds.json`), JSON.stringify({ rect, closed, expanded, samples }, null, 2))
      await capture(size ? 'narrow-expanded' : 'expanded')
      await focusBrowserAddress(page)
      await address.click()
      await waitOptions()
      await address.press('ArrowDown')
      const focused = () => nativeWindow.evaluate(async native => {
        const overlay = native.contentView.children.find(child => (child as Electron.WebContentsView).webContents.getURL().includes('overlay.html')) as Electron.WebContentsView
        return { window: native.isFocused(), visible: overlay.getVisible(), focused: overlay.webContents.isFocused(),
          active: await overlay.webContents.executeJavaScript('({ role: document.activeElement?.getAttribute("role"), text: document.activeElement?.textContent, hidden: document.hidden })') }
      })
      try {
        await expect.poll(async () => (await focused()).focused).toBe(true)
        await expect.poll(async () => (await focused()).active.role).toBe('option')
      } catch (error) {
        await writeFile(join(directory, `${theme}-focus-failure.json`), JSON.stringify({ native: await focused(), views: await observe(), main: await page.evaluate(() => ({ hidden: document.hidden, active: document.activeElement?.outerHTML })) }, null, 2))
        throw error
      }
      await nativeWindow.evaluate(native => {
        const overlay = native.contentView.children.find(child => child.getVisible() && (child as Electron.WebContentsView).webContents.getURL().includes('overlay.html')) as Electron.WebContentsView
        overlay.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
        overlay.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      })
      await expect(address).toBeFocused()
      await expect.poll(async () => (await observe()).filter(view => view.visible && view.url !== destination).length).toBe(0)
    }
    const overlayKey = async (keyCode: string) => {
      await expect.poll(() => nativeWindow.evaluate(async native => {
        const overlay = native.contentView.children.find(child => child.getVisible() && (child as Electron.WebContentsView).webContents.getURL().includes('overlay.html')) as Electron.WebContentsView | undefined
        return Boolean(overlay?.webContents.isFocused() && await overlay.webContents.executeJavaScript('document.activeElement?.getAttribute("role") === "option"'))
      })).toBe(true)
      return nativeWindow.evaluate((native, key) => {
      const overlay = native.contentView.children.find(child => child.getVisible() && (child as Electron.WebContentsView).webContents.getURL().includes('overlay.html')) as Electron.WebContentsView
      overlay.webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
      if (key === 'Enter') overlay.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
      overlay.webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
      }, keyCode)
    }
    const expand = async () => {
      await expect.poll(async () => {
        const reply = await page.evaluate(() => window.scholarseed.browser.snapshot())
        return reply.ok && reply.snapshot.tabs.every(tab => !tab.loading)
      }, { timeout: PUBLIC_NAVIGATION_TIMEOUT_MS }).toBe(true)
      await focusBrowserAddress(page)
      await address.click()
      await address.fill('')
      await address.fill('example.com')
      await expect.poll(async () => (await observe()).some(view => view.visible && view.url.includes('overlay.html'))).toBe(true)
      await waitOptions()
    }
    const dismissed = () => expect.poll(async () => (await observe()).some(view => view.visible && view.url.includes('overlay.html'))).toBe(false)
    await address.click()
    await expect.poll(async () => (await observe()).some(view => view.visible && view.url.includes('overlay.html'))).toBe(true)
    await expand()
    await address.press('ArrowDown')
    await overlayKey('Tab')
    await dismissed()
    await expect(page.getByRole('button', { name: '浏览器提示与状态', exact: true })).toBeFocused()
    await expand()
    await address.press('ArrowDown')
    await overlayKey('Enter')
    await dismissed()
    await expect(address).toHaveValue(destination)
    await expand()
    await nativeWindow.evaluate(async native => {
      const overlay = native.contentView.children.find(child => child.getVisible() && (child as Electron.WebContentsView).webContents.getURL().includes('overlay.html')) as Electron.WebContentsView
      const point = await overlay.webContents.executeJavaScript('(() => { const rect = document.querySelector("[role=option]").getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } })()')
      overlay.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
      overlay.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    })
    await dismissed()
    await expect(address).toHaveValue(destination)
    await expect.poll(async () => {
      const reply = await page.evaluate(() => window.scholarseed.browser.snapshot())
      return reply.ok && reply.snapshot.tabs.every(tab => !tab.loading)
    }, { timeout: PUBLIC_NAVIGATION_TIMEOUT_MS }).toBe(true)
    await capture('mouse-selected')
    await expand()
    const beforeScroll = (await observe()).find(view => view.url === destination)!.page.scrollY
    await nativeWindow.evaluate((native, url) => {
      const webpage = native.contentView.children.find(child => (child as Electron.WebContentsView).webContents.getURL() === url) as Electron.WebContentsView
      webpage.webContents.focus()
    }, destination)
    await expect.poll(() => nativeWindow.evaluate((native, url) => {
      const webpage = native.contentView.children.find(child => (child as Electron.WebContentsView).webContents.getURL() === url) as Electron.WebContentsView
      return webpage.webContents.isFocused()
    }, destination)).toBe(true)
    await dismissed()
    await nativeWindow.evaluate((native, url) => {
      const webpage = native.contentView.children.find(child => (child as Electron.WebContentsView).webContents.getURL() === url) as Electron.WebContentsView
      webpage.webContents.sendInputEvent({ type: 'mouseWheel', x: 20, y: webpage.getBounds().height - 30, deltaY: -100, deltaX: 0 })
    }, destination)
    await expect.poll(async () => (await observe()).find(view => view.url === destination)?.page.scrollY).toBeGreaterThan(beforeScroll)
    await writeFile(join(directory, `${theme}-scroll.json`), JSON.stringify({ inputSurface: 'public-webcontents-focus-and-wheel', osClickVerified: false, beforeScroll, afterScroll: (await observe()).find(view => view.url === destination)!.page.scrollY }, null, 2))
    await expand()
    await page.getByRole('button', { name: '打开新的标签页', exact: true }).click()
    await dismissed()
    await page.getByRole('tablist', { name: '网页标签', exact: true }).getByRole('tab', { selected: true }).getByRole('button', { name: /^关闭 / }).click()
    await expect.poll(async () => (await observe()).find(view => view.url === destination)?.visible).toBe(true)
    await expect(address).toHaveValue(destination)
    await expand()
    await openAccountSettings(page)
    await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible()
    await dismissed()
    await page.getByTestId('account-settings-nav-browser').click()
    await page.getByRole('switch', { name: '启用浏览器自动化', exact: true }).click()
    await page.getByRole('button', { name: '复制 CDP 地址', exact: true }).click()
    const endpoint = await desktop.app!.evaluate(({ clipboard }) => clipboard.readText())
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭', exact: true }).click()
    await expand()
    const external = await chromium.connectOverCDP(endpoint)
    try {
      expect(external.contexts()[0].pages().map(candidate => candidate.url())).toEqual([destination])
    } finally { await external.close() }
    await address.press('Escape')
    await setBrowserDevtools(page, true)
    await setBrowserDevtools(page, false)
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

for (const theme of START_PAGE_THEMES) test(`browser start page ${theme} is replaced by a real webpage and restored after its last tab closes`, async ({}, testInfo) => {
  test.setTimeout(90_000)
  const runtime = createRuntime(testInfo)
  await writeFile(join(runtime.userData, RENDERER_PREFERENCES_FILE), JSON.stringify({
    language: 'zh', theme, onboarding: { seen: Object.fromEntries(ONBOARDING_GROUPS.map(group => [group, true])) }
  }))
  const desktop = new DesktopSession(runtime, testInfo, { browserEnabled: true, nativeWindowLifecycle: true })
  try {
    const page = await desktop.launch()
    await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
    await restoreBrowser(page)
    await expect(page.getByRole('tab', { name: '新标签页', exact: true, selected: true })).toBeVisible()
    await expect(page.getByTestId('browser-start-page')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await page.getByRole('button', { name: '输入网址开始浏览', exact: true }).click()
    const address = page.getByRole('textbox', { name: '网址', exact: true })
    await expect(address).toBeFocused()
    const initial = await page.evaluate(() => window.scholarseed.browser.snapshot())
    expect(initial.ok && initial.snapshot.tabs.length).toBe(0)
    await address.fill(`${await apiBase(page)}/api/healthz`)
    await address.press('Enter')
    const nativeWindow = await desktop.browserWindow(page)
    await expect.poll(() => nativeWindow.evaluate(native => {
      const active = native.contentView.children.find(child => child.getVisible()) as Electron.WebContentsView | undefined
      return active?.webContents.executeJavaScript('document.body?.innerText ?? ""') ?? ''
    }), { timeout: PUBLIC_NAVIGATION_TIMEOUT_MS }).toContain('"stack"')
    await expect(page.getByTestId('browser-start-page')).toHaveCount(0)
    await page.getByRole('tablist', { name: '网页标签', exact: true }).getByRole('button', { name: /^关闭 / }).click()
    await expect(page.getByRole('tab', { name: '新标签页', exact: true, selected: true })).toBeVisible()
    await expect(page.getByTestId('browser-start-page')).toBeVisible()
    const final = await page.evaluate(() => window.scholarseed.browser.snapshot())
    expect(final.ok && final.snapshot.tabs.length).toBe(0)
    const directory = resolve('../../tmp/test_snapshot/desktop/browser-start')
    await mkdir(directory, { recursive: true })
    await page.screenshot({ path: join(directory, `start-page-${theme}.png`) })
    await page.getByRole('tab', { name: '新标签页', exact: true }).focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+l' : 'Control+l')
    await expect(address).toBeFocused()
    await nativeWindow.evaluate((native, size) => native.setSize(size.width, size.height), START_PAGE_NARROW_SIZE)
    await page.getByText('CDP 自动化', { exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByText('CDP 自动化', { exact: true })).toBeVisible()
    expect(await page.getByTestId('browser-start-page').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: join(directory, `start-page-${theme}-narrow.png`) })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('first Desktop browser navigation retains the submitted address while the page loads', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const destination = 'https://httpbingo.org/delay/10'
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo, { browserEnabled: true, nativeWindowLifecycle: true })
  try {
    const launching = desktop.launch()
    await expect.poll(() => desktop.app?.windows().find(candidate => candidate.url().startsWith('http:'))?.url(), { timeout: 45_000 }).toBeTruthy()
    const startupPage = desktop.app!.windows().find(candidate => candidate.url().startsWith('http:'))!
    for (const name of ['先随便看看', '跳过']) {
      await startupPage.addLocatorHandler(startupPage.getByRole('button', { name, exact: true }), async button => { await button.click() })
    }
    const page = await launching
    await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
    await restoreBrowser(page)
    const address = page.getByRole('textbox', { name: '网址', exact: true })
    await address.fill(destination)
    await address.press('Enter')
    await expect.poll(async () => {
      const reply = await page.evaluate(() => window.scholarseed.browser.snapshot())
      if (!reply.ok) return null
      const active = reply.snapshot.tabs.find(tab => tab.tabId === reply.snapshot.activeTabId)
      return active?.loading && active.url === ''
    }, { timeout: 15_000 }).toBe(true)
    await expect(address).toHaveValue(destination)
    const nativeWindow = await desktop.browserWindow(page)
    const media = await nativeWindow.evaluate(native => ({ id: native.getMediaSourceId(), bounds: native.getBounds() }))
    const screenshot = await desktop.app!.evaluate(async ({ desktopCapturer }, source) => {
      const captures = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: source.bounds.width, height: source.bounds.height } })
      return captures.find(capture => capture.id === source.id)?.thumbnail.toPNG().toString('base64') ?? null
    }, media)
    expect(screenshot).toBeTruthy()
    const directory = resolve('../../tmp/test_snapshot/desktop/browser-current')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'pending-first-address-native.png'), Buffer.from(screenshot!, 'base64'))
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

for (const addressCase of [
  { name: 'complete HTTP URL', input: 'local', expectedUrl: 'local', body: /"stack"/, screenshot: 'http-local-native.png' },
  { name: 'public HTTP URL', input: 'http://httpbingo.org/html', expectedUrl: 'http://httpbingo.org/html', body: /Herman Melville - Moby-Dick/, screenshot: 'http-public-native.png' },
  { name: 'bare example.com domain', input: 'example.com', expectedUrl: 'https://example.com/', body: /This domain is for use in documentation examples|Example Domain/, screenshot: 'example-com-bare-native.png' },
  { name: 'complete HTTPS URL', input: 'https://example.com/?scholarseed=1', expectedUrl: 'https://example.com/?scholarseed=1', body: /This domain is for use in documentation examples|Example Domain/, screenshot: 'example-com-https-native.png' }
]) {
  test(`address bar opens ${addressCase.name} in the real Desktop browser`, async ({ browserName }, testInfo) => {
    expect(browserName).toBe('chromium')
    test.setTimeout(90_000)
    const desktop = new DesktopSession(createRuntime(testInfo), testInfo, { browserEnabled: true, nativeWindowLifecycle: true })
    try {
      const launching = desktop.launch()
      await expect.poll(() => desktop.app?.windows().find(candidate => candidate.url().startsWith('http:'))?.url(), { timeout: 45_000 }).toBeTruthy()
      const startupPage = desktop.app!.windows().find(candidate => candidate.url().startsWith('http:'))!
      for (const name of ['先随便看看', '跳过']) {
        await startupPage.addLocatorHandler(startupPage.getByRole('button', { name, exact: true }), async button => { await button.click() })
      }
      const page = await launching
      await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
      await restoreBrowser(page)
      await expect(page.getByTestId('browser-workspace')).toBeVisible()
      const address = page.getByRole('textbox', { name: '网址', exact: true })
      const nativeWindow = await desktop.browserWindow(page)
      const input = addressCase.input === 'local' ? `${await apiBase(page)}/api/healthz` : addressCase.input
      const expectedUrl = addressCase.expectedUrl === 'local' ? input : addressCase.expectedUrl
      await address.fill(input)
      await address.press('Enter')
      let navigationFailure: unknown
      try {
        await expect.poll(async () => {
          const reply = await page.evaluate(() => window.scholarseed.browser.snapshot())
          if (!reply.ok) return null
          const active = reply.snapshot.tabs.find(tab => tab.tabId === reply.snapshot.activeTabId)
          return active && { url: active.url, error: active.navigationError }
        }, { timeout: PUBLIC_NAVIGATION_TIMEOUT_MS }).toEqual({ url: expectedUrl, error: null })
        await expect.poll(() => nativeWindow.evaluate(native => {
          const active = native.contentView.children.find(child => child.getVisible()) as Electron.WebContentsView | undefined
          if (!active) return null
          return active.webContents.executeJavaScript('({ url: location.href, ready: document.readyState, body: document.body?.innerText?.trim() ?? "" })')
        }), { timeout: PUBLIC_NAVIGATION_TIMEOUT_MS }).toMatchObject({ url: expectedUrl, ready: 'complete', body: expect.stringMatching(addressCase.body) })
      } catch (error) { navigationFailure = error }
      const media = await nativeWindow.evaluate(native => ({ id: native.getMediaSourceId(), bounds: native.getBounds() }))
      const screenshot = await desktop.app!.evaluate(async ({ desktopCapturer }, source) => {
        const captures = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: source.bounds.width, height: source.bounds.height } })
        return captures.find(capture => capture.id === source.id)?.thumbnail.toPNG().toString('base64') ?? null
      }, media)
      if (screenshot) {
        const image = Buffer.from(screenshot, 'base64')
        const evidenceDirectory = resolve('../../tmp/test_snapshot/desktop/browser-current')
        await mkdir(evidenceDirectory, { recursive: true })
        await writeFile(testInfo.outputPath(addressCase.screenshot), image)
        await writeFile(join(evidenceDirectory, addressCase.screenshot), image)
      }
      if (navigationFailure) throw navigationFailure
      expect(screenshot, 'native Desktop composite screenshot is unavailable').not.toBeNull()
      desktop.assertNoPageErrors()
    } finally { await desktop.attachArtifacts() }
  })
}

test('external Playwright process controls only pages in the real Desktop browser', async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium')
  test.setTimeout(120_000)
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo, { browserEnabled: true, nativeWindowLifecycle: true })
  const privateFile = testInfo.outputPath('cdp-private-canary.html')
  await writeFile(privateFile, '<title>CDP_PRIVATE_CANARY</title>')
  let privateRequests = 0
  const privateServer = createServer((_request, response) => {
    privateRequests += 1
    response.end('CDP_PRIVATE_HTTP_CANARY')
  })
  privateServer.listen(0, '127.0.0.1')
  await once(privateServer, 'listening')
  const privateAddress = privateServer.address()
  if (!privateAddress || typeof privateAddress === 'string') throw new Error('private test server has no port')
  const privateHttpUrl = `http://127.0.0.1:${privateAddress.port}/private`
  try {
    const launching = desktop.launch()
    await expect.poll(() => desktop.app?.windows().find(candidate => candidate.url().startsWith('http:'))?.url(), { timeout: 45_000 }).toBeTruthy()
    const startupPage = desktop.app!.windows().find(candidate => candidate.url().startsWith('http:'))!
    for (const name of ['先随便看看', '跳过']) {
      await startupPage.addLocatorHandler(startupPage.getByRole('button', { name, exact: true }), async button => { await button.click() })
    }
    const page = await launching
    await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
    await restoreBrowser(page)
    await expect(page.getByTestId('browser-workspace')).toBeVisible()
    const address = page.getByRole('textbox', { name: '网址', exact: true })
    await address.fill(`${await apiBase(page)}/api/healthz`)
    await address.press('Enter')
    await expect.poll(async () => (await page.evaluate(() => window.scholarseed.browser.snapshot())).ok).toBe(true)
    await openAccountSettings(page)
    await page.getByTestId('account-settings-nav-browser').click()
    await expect(page.getByTestId('account-settings-browser')).toBeVisible()
    await page.getByRole('switch', { name: '启用浏览器自动化', exact: true }).click()
    await page.getByRole('button', { name: '复制 CDP 地址', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'CDP 地址已复制' })).toBeVisible()
    const directory = resolve('../../tmp/test_snapshot/desktop/browser-task7')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'product-browser-cdp-settings.png'), await page.screenshot())
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭', exact: true }).click()
    const endpoint = process.platform === 'darwin'
      ? (await execFileAsync('pbpaste', [], { timeout: 5000 })).stdout.trim()
      : process.platform === 'win32'
        ? (await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'], { timeout: 5000 })).stdout.trim()
        : await desktop.app!.evaluate(({ clipboard }) => clipboard.readText())
    expect(endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9]+$/)
    const nativeWindow = await desktop.browserWindow(page)
    const runExternal = async (screenshot: string) => {
      const script = `const { chromium } = require('@playwright/test'); (async () => {
        const browser = await chromium.connectOverCDP(process.argv[1]);
        try {
          const pages = browser.contexts()[0].pages();
          if (pages.length !== 1) throw new Error('unexpected target count: ' + pages.length);
          const page = pages[0];
          if (!page.url().endsWith('/api/healthz')) throw new Error('unexpected page: ' + page.url());
          const body = await page.locator('body').textContent();
          if (!body || !body.includes('stack')) throw new Error('health response missing');
          for (const [label, url] of [['file', process.argv[3]], ['localhost', process.argv[4]]]) {
            let failure = '';
            try { await page.goto(url); } catch (error) { failure = String(error); }
            const denial = label === 'file' ? 'invalid_url' : 'permission_denied';
            if (!failure.includes(denial)) throw new Error(label + ' navigation was not rejected by browser policy: ' + failure);
            if (!page.url().endsWith('/api/healthz')) throw new Error(label + ' navigation replaced the original page');
            if (!(await page.locator('body').textContent())?.includes('stack')) throw new Error(label + ' navigation damaged the original page');
          }
          await page.evaluate(() => {
            document.querySelector('#cdp-input')?.remove();
            document.querySelector('#cdp-button')?.remove();
            const input = document.createElement('input'); input.id = 'cdp-input'; document.body.append(input);
            const button = document.createElement('button'); button.id = 'cdp-button'; button.textContent = 'Apply';
            button.onclick = () => { document.body.dataset.cdpValue = input.value }; document.body.append(button);
          });
          await page.locator('#cdp-input').fill('ScholarSeed');
          await page.locator('#cdp-button').click();
          if (await page.locator('body').getAttribute('data-cdp-value') !== 'ScholarSeed') throw new Error('input/click failed');
          await page.screenshot({ path: process.argv[2] });
          process.stdout.write(JSON.stringify({ pages: pages.length, url: page.url(), body: body.slice(0, 200) }));
        } finally { await browser.close() }
      })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1 })`
      const { stdout } = await execFileAsync(process.execPath,
        ['-e', script, endpoint, screenshot, pathToFileURL(privateFile).href, privateHttpUrl],
        { cwd: resolve('.'), timeout: 30_000 })
      return JSON.parse(stdout) as { pages: number; url: string; body: string }
    }
    expect(await runExternal(join(directory, 'product-cdp-page.png'))).toMatchObject({ pages: 1 })
    expect(privateRequests).toBe(0)
    const invalid = new WebSocket(`${endpoint}invalid`)
    await expect(once(invalid, 'open')).rejects.toThrow()
    await setBrowserDevtools(page, true)
    const devtools = (body: string) => nativeWindow.evaluate(async (native, expression) => {
      const active = native.contentView.children.find(child => child.getVisible()) as Electron.WebContentsView | undefined
      const frontend = active?.webContents.devToolsWebContents
      if (!frontend) throw new Error('page DevTools unavailable')
      return frontend.executeJavaScript(expression)
    }, `(async () => {
      const SDK = await import('./core/sdk/sdk.js'); const UI = await import('./ui/legacy/legacy.js');
      const target = SDK.TargetManager.TargetManager.instance().primaryPageTarget(); ${body}
    })()`)
    await expect.poll(() => devtools('return target?.inspectedURL()').catch(() => null)).toBe(`${await apiBase(page)}/api/healthz`)
    expect(await nativeWindow.evaluate(native => native.webContents.isDevToolsOpened())).toBe(false)
    const elements = await devtools(`await UI.ViewManager.ViewManager.instance().showView('elements');
      const document = await target.domAgent().invoke_getDocument({ depth: -1 });
      return (await target.domAgent().invoke_getOuterHTML({ nodeId: document.root.nodeId })).outerHTML;`) as string
    expect(elements).toContain('cdp-input')
    const devtoolsScreenshot = async (name: string) => {
      const png = await nativeWindow.evaluate(async native => {
        const active = native.contentView.children.find(child => child.getVisible()) as Electron.WebContentsView
        return (await active.webContents.devToolsWebContents!.capturePage()).toPNG().toString('base64')
      })
      await writeFile(join(directory, name), Buffer.from(png, 'base64'))
    }
    await devtoolsScreenshot('product-devtools-elements.png')
    expect(await devtools(`await UI.ViewManager.ViewManager.instance().showView('console');
      return (await target.runtimeAgent().invoke_evaluate({ expression: 'console.log("PRODUCT-DEVTOOLS", location.href); document.querySelector("#cdp-input").value', returnByValue: true })).result.value;`)).toBe('ScholarSeed')
    await expect.poll(() => devtools('return document.body.innerText.includes("PRODUCT-DEVTOOLS")')).toBe(true)
    await devtoolsScreenshot('product-devtools-console.png')
    expect(await devtools(`await UI.ViewManager.ViewManager.instance().showView('network');
      const network = target.model(SDK.NetworkManager.NetworkManager);
      const completed = new Promise(resolve => network.addEventListener(SDK.NetworkManager.Events.RequestFinished, event => {
        if (event.data.url().includes('devtools-network=1')) resolve(event.data.url());
      }));
      await target.runtimeAgent().invoke_evaluate({ expression: 'fetch("/api/healthz?devtools-network=1")', awaitPromise: true });
      return completed;`)).toBe(`${await apiBase(page)}/api/healthz?devtools-network=1`)
    await devtoolsScreenshot('product-devtools-network.png')
    const conflict = new WebSocket(endpoint)
    await once(conflict, 'open')
    const targets = await cdpCommand(conflict, 'Target.getTargets')
    expect(targets.result.targetInfos).toHaveLength(1)
    expect((await cdpCommand(conflict, 'Target.attachToTarget', { targetId: targets.result.targetInfos[0].targetId, flatten: true })).error.message).toBe('devtools_conflict')
    conflict.close()
    await setBrowserDevtools(page, false)
    expect(await runExternal(join(directory, 'product-cdp-reconnected.png'))).toMatchObject({ pages: 1 })
    expect(privateRequests).toBe(0)
    await openAccountSettings(page)
    await page.getByTestId('account-settings-nav-browser').click()
    await page.getByRole('switch', { name: '停用浏览器自动化', exact: true }).click()
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭', exact: true }).click()
    const disabled = new WebSocket(endpoint)
    await expect(once(disabled, 'open')).rejects.toThrow()
    await address.fill(`${await apiBase(page)}/api/healthz?history=1`)
    await address.press('Enter')
    await expect(page.getByRole('button', { name: '后退', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '后退', exact: true }).click()
    await expect(page.getByRole('button', { name: '前进', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '前进', exact: true }).click()
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.getByRole('button', { name: '打开新的标签页', exact: true }).click()
    await expect.poll(async () => {
      const reply = await page.evaluate(() => window.scholarseed.browser.snapshot())
      return reply.ok ? reply.snapshot.tabs.length : 0
    }).toBe(2)
    await expect(page.getByTestId('browser-workspace').getByRole('tab')).toHaveCount(2)
    await expect(page.getByTestId('browser-workspace').getByRole('tab', { selected: true })).toContainText('新标签页')
    await expect(page.getByTestId('browser-workspace')).toHaveAttribute('aria-busy', 'false')
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
    await new Promise<void>(resolveClose => privateServer.close(() => resolveClose()))
  }
})

test('public navigation remains available after disabling browser automation', async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium')
  test.setTimeout(120_000)
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo, { browserEnabled: true, nativeWindowLifecycle: true })
  try {
    const launching = desktop.launch()
    await expect.poll(() => desktop.app?.windows().find(candidate => candidate.url().startsWith('http:'))?.url(), { timeout: 45_000 }).toBeTruthy()
    const startupPage = desktop.app!.windows().find(candidate => candidate.url().startsWith('http:'))!
    for (const name of ['先随便看看', '跳过']) {
      await startupPage.addLocatorHandler(startupPage.getByRole('button', { name, exact: true }), async button => { await button.click() })
    }
    const page = await launching
    await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
    await restoreBrowser(page)
    await expect(page.getByTestId('browser-workspace')).toBeVisible()
    const address = page.getByRole('textbox', { name: '网址', exact: true })
    const nativeWindow = await desktop.browserWindow(page)
    await openAccountSettings(page)
    await page.getByTestId('account-settings-nav-browser').click()
    await page.getByRole('switch', { name: '启用浏览器自动化', exact: true }).click()
    await page.getByRole('switch', { name: '停用浏览器自动化', exact: true }).click()
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭', exact: true }).click()
    const assertPublicNavigation = async (expectedUrl: string) => {
      await expect.poll(async () => {
        const reply = await page.evaluate(() => window.scholarseed.browser.snapshot())
        if (!reply.ok) return null
        const active = reply.snapshot.tabs.find(tab => tab.tabId === reply.snapshot.activeTabId)
        return active && { url: active.url, error: active.navigationError }
      }, { timeout: PUBLIC_NAVIGATION_TIMEOUT_MS }).toEqual({ url: expectedUrl, error: null })
      await expect.poll(() => nativeWindow.evaluate(async window => {
        const active = window.contentView.children.find(child => child.getVisible()) as Electron.WebContentsView | undefined
        if (!active) return null
        return active.webContents.executeJavaScript('({ origin: location.origin, ready: document.readyState, body: document.body?.innerText?.trim() ?? "" })')
      }), { timeout: PUBLIC_NAVIGATION_TIMEOUT_MS }).toMatchObject({ origin: new URL(expectedUrl).origin, ready: expect.stringMatching(/^(interactive|complete)$/), body: expect.stringMatching(/go-httpbin\(1\)/) })
    }
    await address.fill('httpbingo.org')
    await address.press('Enter')
    try { await assertPublicNavigation('https://httpbingo.org/') } catch (error) {
      console.error('[browser-product-cdp] public navigation snapshot', JSON.stringify(await page.evaluate(() => window.scholarseed.browser.snapshot())))
      throw error
    }
    await address.fill('https://httpbingo.org/?scholarseed=1')
    await address.press('Enter')
    await assertPublicNavigation('https://httpbingo.org/?scholarseed=1')
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('external Playwright controls a public form inside the product browser', async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium')
  test.setTimeout(120_000)
  const formUrl = 'https://httpbingo.org/forms/post'
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo, { browserEnabled: true, nativeWindowLifecycle: true })
  try {
    const launching = desktop.launch()
    await expect.poll(() => desktop.app?.windows().find(candidate => candidate.url().startsWith('http:'))?.url(), { timeout: 45_000 }).toBeTruthy()
    const startupPage = desktop.app!.windows().find(candidate => candidate.url().startsWith('http:'))!
    for (const name of ['先随便看看', '跳过']) {
      await startupPage.addLocatorHandler(startupPage.getByRole('button', { name, exact: true }), async button => { await button.click() })
    }
    const page = await launching
    await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
    await restoreBrowser(page)
    const address = page.getByRole('textbox', { name: '网址', exact: true })
    await address.fill(formUrl)
    await address.press('Enter')
    await expect.poll(async () => {
      const reply = await page.evaluate(() => window.scholarseed.browser.snapshot())
      if (!reply.ok) return null
      const active = reply.snapshot.tabs.find(tab => tab.tabId === reply.snapshot.activeTabId)
      return active && { url: active.url, loading: active.loading, error: active.navigationError }
    }, { timeout: 45_000 }).toEqual({ url: formUrl, loading: false, error: null })
    await openAccountSettings(page)
    await page.getByTestId('account-settings-nav-browser').click()
    await page.getByRole('switch', { name: '启用浏览器自动化', exact: true }).click()
    await page.getByRole('button', { name: '复制 CDP 地址', exact: true }).click()
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭', exact: true }).click()
    const endpoint = process.platform === 'darwin'
      ? (await execFileAsync('pbpaste', [], { timeout: 5000 })).stdout.trim()
      : process.platform === 'win32'
        ? (await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'], { timeout: 5000 })).stdout.trim()
        : await desktop.app!.evaluate(({ clipboard }) => clipboard.readText())
    expect(endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9]+$/)
    const directory = resolve('../../tmp/test_snapshot/desktop/browser-public-cdp')
    await mkdir(directory, { recursive: true })
    const script = `const { chromium } = require('@playwright/test'); (async () => {
      const browser = await chromium.connectOverCDP(process.argv[1]);
      try {
        const pages = browser.contexts()[0].pages();
        if (pages.length !== 1 || pages[0].url() !== process.argv[2]) throw new Error('public form target unavailable');
        const page = pages[0];
        const body = await page.locator('form').textContent();
        if (!body || !body.includes('Customer name:')) throw new Error('public form DOM unavailable');
        await page.getByLabel('Customer name:').fill('ScholarSeed CDP');
        await page.getByLabel('Medium', { exact: true }).check();
        await page.getByLabel('Extra Cheese').check();
        const values = await page.evaluate(() => ({
          name: document.querySelector('input[name="custname"]')?.value,
          medium: document.querySelector('input[value="medium"]')?.checked,
          cheese: document.querySelector('input[value="cheese"]')?.checked
        }));
        await page.screenshot({ path: process.argv[3] });
        process.stdout.write(JSON.stringify({ url: page.url(), values }));
      } finally { await browser.close() }
    })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1 })`
    const { stdout } = await execFileAsync(process.execPath, ['-e', script, endpoint, formUrl, join(directory, 'public-form-cdp.png')], { cwd: resolve('.'), timeout: 45_000 })
    expect(JSON.parse(stdout)).toEqual({ url: formUrl, values: { name: 'ScholarSeed CDP', medium: true, cheese: true } })
    const nativeWindow = await desktop.browserWindow(page)
    const nativeValues = await nativeWindow.evaluate(native => {
      const active = native.contentView.children.find(child => child.getVisible()) as Electron.WebContentsView | undefined
      if (!active) return null
      return active.webContents.executeJavaScript('({ name: document.querySelector("input[name=custname]")?.value, medium: document.querySelector("input[value=medium]")?.checked, cheese: document.querySelector("input[value=cheese]")?.checked })')
    })
    expect(nativeValues).toEqual({ name: 'ScholarSeed CDP', medium: true, cheese: true })
    const media = await nativeWindow.evaluate(native => ({ id: native.getMediaSourceId(), bounds: native.getBounds() }))
    const screenshot = await desktop.app!.evaluate(async ({ desktopCapturer }, source) => {
      const captures = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: source.bounds.width, height: source.bounds.height } })
      return captures.find(capture => capture.id === source.id)?.thumbnail.toPNG().toString('base64') ?? null
    }, media)
    expect(screenshot).toBeTruthy()
    await writeFile(join(directory, 'public-form-product.png'), Buffer.from(screenshot!, 'base64'))
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

interface ProbeResponse {
  error: { message: string }
  result: { targetInfos: { targetId: string }[]; sessionId: string; result: { value: unknown } }
}

function cdpCommand(client: WebSocket, method: string, params = {}, sessionId?: string): Promise<ProbeResponse> {
  return new Promise((resolveCommand, reject) => {
    const timer = setTimeout(() => { client.removeListener('message', receive); reject(new Error(`CDP command timed out: ${method}`)) }, 5000)
    const receive = (data: Buffer) => {
      const response = JSON.parse(String(data))
      if (response.id !== 1) return
      clearTimeout(timer)
      client.removeListener('message', receive)
      resolveCommand(response)
    }
    client.on('message', receive)
    client.send(JSON.stringify({ id: 1, method, params, sessionId }))
  })
}

async function hostileClients(endpoint: string) {
  for (const options of [{ headers: { Host: 'evil.example' } }, { origin: 'https://evil.example' }]) {
    const denied = new WebSocket(endpoint, options)
    await expect(once(denied, 'open')).rejects.toThrow()
  }
  const invalidToken = new WebSocket(`${endpoint}wrong`)
  await expect(once(invalidToken, 'open')).rejects.toThrow()
  const client = new WebSocket(endpoint)
  await once(client, 'open')
  const command = (method: string, params = {}, sessionId?: string) => cdpCommand(client, method, params, sessionId)
  const discovery = await command('Target.getTargets')
  expect(discovery.result.targetInfos).toHaveLength(1)
  for (const method of ['Target.createTarget', 'Target.attachToBrowserTarget', 'Browser.grantPermissions', 'Storage.getCookies']) {
    expect((await command(method)).error).toBeDefined()
  }
  expect((await command('Target.attachToTarget', { targetId: '1', flatten: true })).error).toBeDefined()
  expect((await command('Runtime.evaluate', { expression: 'process' }, '1')).error).toBeDefined()
  const attached = await command('Target.attachToTarget', { targetId: discovery.result.targetInfos[0].targetId, flatten: true })
  const sessionId = attached.result.sessionId
  for (const method of ['Target.createTarget', 'Browser.grantPermissions', 'Storage.getCookies', 'IO.read', 'DOM.setFileInputFiles', 'Security.setIgnoreCertificateErrors']) {
    expect((await command(method, {}, sessionId)).error.message).toBe('unsupported_cdp_method')
  }
  const competitor = new WebSocket(endpoint)
  await once(competitor, 'open')
  const competingTargets = await cdpCommand(competitor, 'Target.getTargets')
  expect((await cdpCommand(competitor, 'Target.attachToTarget', { targetId: competingTargets.result.targetInfos[0].targetId, flatten: true })).error.message).toBe('cdp_busy')
  const competitorClosed = once(competitor, 'close')
  competitor.close()
  await competitorClosed
  expect((await command('Runtime.evaluate', { expression: '1 + 1', returnByValue: true }, sessionId)).result.result.value).toBe(2)
  const malformedClosed = once(client, 'close')
  client.send('{')
  expect((await malformedClosed)[0]).toBe(1007)
  const oversized = new WebSocket(endpoint)
  await once(oversized, 'open')
  const oversizedClosed = once(oversized, 'close')
  oversized.send('x'.repeat(1024 * 1024 + 1))
  expect((await oversizedClosed)[0]).toBe(1009)
}

for (const remote of [false, true]) test(`restricted browser endpoint ${remote ? 'owns cross-origin iframe sessions' : 'supports real Playwright DOM, input and screenshot'}`, async ({}, testInfo) => {
  const temporary = await mkdtemp(join(tmpdir(), 'browser-cdp-'))
  const entry = join(temporary, 'probe.cjs')
  await build({ entryPoints: ['e2e/fixtures/browser-probe.ts'], outfile: entry, bundle: true, platform: 'node', external: ['electron', './lease.node'] })
  const environment: NodeJS.ProcessEnv = { ...process.env, SCHOLARSEED_HOME: join(temporary, 'home'), BROWSER_PROBE_PROFILE: join(temporary, 'profile'), BROWSER_PROBE_REMOTE: remote ? '1' : '' }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(electron as unknown as string, [entry], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
  let diagnostic = ''
  try {
    const endpoint = await new Promise<string>((resolveEndpoint, reject) => {
      const timer = setTimeout(() => reject(new Error(`probe startup timed out: ${diagnostic.slice(-4000)}`)), 15000)
      let output = ''
      child.stdout.on('data', chunk => {
        output += chunk
        const match = output.match(/BROWSER_PROBE_ENDPOINT (ws:\/\/\S+)/)
        if (match) { clearTimeout(timer); resolveEndpoint(match[1]) }
      })
      child.stderr.on('data', chunk => { diagnostic += chunk; process.stderr.write(chunk) })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`probe exited ${code}`)) })
    })
    await hostileClients(endpoint)
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 })
    const pages = browser.contexts()[0].pages()
    expect(pages).toHaveLength(1)
    if (remote) await pages[0].goto('https://www.rfc-editor.org/', { waitUntil: 'domcontentloaded' })
    else await pages[0].goto(pages[0].url())
    expect(diagnostic).not.toContain('target unavailable')
    if (remote) {
      await expect(pages[0].goto('http://127.0.0.1:1')).rejects.toThrow(/permission_denied/)
      pages[0].on('requestfailed', request => console.error('probe request failed', request.failure()?.errorText))
      pages[0].on('console', message => console.error('probe console', message.text()))
      await pages[0].evaluate(() => { const frame = document.createElement('iframe'); frame.src = 'https://httpbin.org/html'; document.body.append(frame) })
      await expect(pages[0].frameLocator('iframe').locator('body')).not.toBeEmpty()
      await pages[0].evaluate(() => document.querySelector('iframe')!.remove())
      await expect.poll(() => pages[0].frames().length).toBe(1)
      await browser.close()
      expect(diagnostic).not.toContain('target unavailable')
      return
    }
    expect(await pages[0].locator('h1').textContent()).toBe('Registered browser page')
    await pages[0].locator('#name').fill('ScholarSeed')
    await pages[0].locator('#submit').click()
    expect(await pages[0].locator('#result').textContent()).toBe('ScholarSeed')
    const directory = resolve('../../tmp/test_snapshot/desktop')
    await mkdir(directory, { recursive: true })
    await pages[0].screenshot({ path: join(directory, 'browser-cdp-probe.png') })
    const added = browser.contexts()[0].waitForEvent('page', { timeout: 5000 })
    child.stdin.write('open\n')
    expect(await (await added).locator('h1').textContent()).toBe('Registered browser page')
    await browser.close()
    const reconnected = await chromium.connectOverCDP(endpoint, { timeout: 15000 })
    expect(reconnected.contexts()[0].pages()).toHaveLength(2)
    await reconnected.close()
    expect(diagnostic).not.toContain('target unavailable')
  } finally {
    await writeFile(testInfo.outputPath('probe-stderr.log'), diagnostic)
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    await rm(temporary, { recursive: true, force: true })
  }
})

test('external CDP loses an Agent-isolated target while manual tabs remain controllable', async () => {
  test.setTimeout(60_000)
  const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-cdp-isolation-'))
  const entry = join(temporary, 'probe.cjs')
  await build({ entryPoints: ['e2e/fixtures/browser-probe.ts'], outfile: entry, bundle: true, platform: 'node', external: ['electron', './lease.node'] })
  const environment: NodeJS.ProcessEnv = { ...process.env, SCHOLARSEED_HOME: join(temporary, 'home'), BROWSER_PROBE_PROFILE: join(temporary, 'profile'), BROWSER_PROBE_REMOTE: '1' }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(electron as unknown as string, [entry], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  let diagnostic = ''
  let sequence = 0
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { diagnostic += chunk })
  const control = async (command: string) => {
    const id = ++sequence
    child.stdin.write(`${JSON.stringify({ id, command })}\n`)
    let response: { id: number; result?: unknown; error?: string } | undefined
    await expect.poll(() => {
      response = output.split('\n').filter(line => line.startsWith('BROWSER_PROBE_RESULT '))
        .map(line => JSON.parse(line.slice('BROWSER_PROBE_RESULT '.length)))
        .find(candidate => candidate.id === id)
      return response !== undefined
    }, { timeout: 15_000 }).toBe(true)
    expect(response!.error).toBeUndefined()
    return response!.result
  }
  try {
    await expect.poll(() => output.match(/BROWSER_PROBE_ENDPOINT (ws:\/\/\S+)/)?.[1], { timeout: 15_000 }).toBeTruthy()
    const endpoint = output.match(/BROWSER_PROBE_ENDPOINT (ws:\/\/\S+)/)![1]
    await control('open')
    const wire = new WebSocket(endpoint)
    await once(wire, 'open')
    const initial = (await cdpCommand(wire, 'Target.getTargets')).result.targetInfos as { targetId: string; url: string }[]
    expect(initial).toHaveLength(2)
    const original = initial.find(target => !target.url.endsWith('/second'))!
    const manual = initial.find(target => target.url.endsWith('/second'))!
    const sessionId = (await cdpCommand(wire, 'Target.attachToTarget', { targetId: original.targetId, flatten: true })).result.sessionId
    const events: { method: string; params: { targetId?: string; sessionId?: string } }[] = []
    wire.on('message', data => { const message = JSON.parse(String(data)); if (message.method) events.push(message) })
    expect(await control('agent')).toMatchObject({ agentUrl: 'https://example.org/agent-isolated' })
    await expect.poll(() => events.some(event => event.method === 'Target.detachedFromTarget' && event.params.sessionId === sessionId)).toBe(true)
    await expect.poll(() => events.some(event => event.method === 'Target.targetDestroyed' && event.params.targetId === original.targetId)).toBe(true)
    const remaining = (await cdpCommand(wire, 'Target.getTargets')).result.targetInfos as { targetId: string; url: string }[]
    expect(remaining).toEqual([expect.objectContaining({ targetId: manual.targetId })])
    expect((await cdpCommand(wire, 'Target.attachToTarget', { targetId: original.targetId, flatten: true })).error).toBeDefined()
    expect((await cdpCommand(wire, 'Runtime.evaluate', { expression: 'document.body.click()' }, sessionId)).error).toBeDefined()
    wire.close()
    const browser = await chromium.connectOverCDP(endpoint)
    try {
      const pages = browser.contexts()[0].pages()
      expect(pages).toHaveLength(1)
      expect(pages[0].url()).toContain('/second')
      await pages[0].locator('#name').fill('manual still works')
      await pages[0].locator('#submit').click()
      await expect(pages[0].locator('#result')).toHaveText('manual still works')
    } finally { await browser.close() }
    expect(diagnostic).not.toContain('target unavailable')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    await rm(temporary, { recursive: true, force: true })
  }
})

test('per-tab DevTools evicts only its external lease and restores fresh Playwright attachment', async () => {
  test.setTimeout(60_000)
  const temporary = await mkdtemp(join(tmpdir(), 'browser-devtools-'))
  const entry = join(temporary, 'probe.cjs')
  await build({ entryPoints: ['e2e/fixtures/browser-probe.ts'], outfile: entry, bundle: true, platform: 'node', external: ['electron', './lease.node'] })
  const environment: NodeJS.ProcessEnv = { ...process.env, SCHOLARSEED_HOME: join(temporary, 'home'), BROWSER_PROBE_PROFILE: join(temporary, 'profile'), BROWSER_PROBE_REMOTE: '' }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(electron as unknown as string, [entry], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  let diagnostic = ''
  let sequence = 0
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { diagnostic += chunk; process.stderr.write(chunk) })
  const control = async (command: string, params: Record<string, unknown> = {}) => {
    const id = ++sequence
    child.stdin.write(`${JSON.stringify({ id, command, ...params })}\n`)
    let response: { result?: unknown; error?: string } | undefined
    await expect.poll(() => {
      response = output.split('\n').filter(line => line.startsWith('BROWSER_PROBE_RESULT ')).map(line => JSON.parse(line.slice('BROWSER_PROBE_RESULT '.length))).find(value => value.id === id)
      return response !== undefined
    }, { timeout: 15000, message: `probe command ${command}` }).toBe(true)
    expect(response!.error).toBeUndefined()
    return response!.result
  }
  try {
    await expect.poll(() => output.match(/BROWSER_PROBE_ENDPOINT (ws:\/\/\S+)/)?.[1], { timeout: 15000 }).toBeTruthy()
    const endpoint = output.match(/BROWSER_PROBE_ENDPOINT (ws:\/\/\S+)/)![1]
    await control('open')
    const browser = await chromium.connectOverCDP(endpoint)
    const pages = browser.contexts()[0].pages()
    const first = pages.find(page => !page.url().endsWith('/second'))!
    const second = pages.find(page => page.url().endsWith('/second'))!
    await first.locator('#name').fill('page A')
    await expect(first.goto('devtools://devtools/bundled/devtools_app.html')).rejects.toThrow(/invalid_url/)
    await second.locator('#name').fill('page B')
    const firstClosed = first.waitForEvent('close')
    await control('devtools', { open: true })
    await firstClosed
    const state = await control('snapshot') as { snapshot: BrowserSnapshot; detached: { tabId: string; reason: string }[]; firstTab: string; mainDevtoolsOpen: boolean }
    expect(state.mainDevtoolsOpen).toBe(false)
    expect(state.detached).toContainEqual({ tabId: state.firstTab, reason: 'devtools_conflict' })
    expect(state.snapshot.tabs.find(tab => tab.tabId === state.firstTab)).toMatchObject({ devtoolsOpen: true, cdpStatus: 'devtools_conflict' })
    expect(state.snapshot.tabs.find(tab => tab.tabId !== state.firstTab)).toMatchObject({ devtoolsOpen: false, cdpStatus: 'connected' })
    await second.locator('#submit').click()
    await expect(second.locator('#result')).toHaveText('page B')
    const observer = new WebSocket(endpoint)
    await once(observer, 'open')
    const discovered = await cdpCommand(observer, 'Target.getTargets')
    expect(discovered.result.targetInfos).toHaveLength(2)
    const target = (discovered.result.targetInfos as { targetId: string; url: string }[]).find(info => !info.url.endsWith('/second'))!
    expect((await cdpCommand(observer, 'Target.attachToTarget', { targetId: target.targetId, flatten: true })).error.message).toBe('devtools_conflict')
    observer.close()
    await browser.close()
    const freshDuringConflict = await chromium.connectOverCDP(endpoint)
    const availablePages = freshDuringConflict.contexts()[0].pages()
    expect(availablePages).toHaveLength(1)
    expect(availablePages[0].url()).toContain('/second')
    await availablePages[0].locator('#name').fill('fresh page B')
    await availablePages[0].locator('#submit').click()
    await expect(availablePages[0].locator('#result')).toHaveText('fresh page B')
    await freshDuringConflict.close()
    const directory = resolve('../../tmp/test_snapshot/desktop')
    await mkdir(directory, { recursive: true })
    const inspectedUrl = await control('frontend', { expression: `(async () => { const SDK = await import('./core/sdk/sdk.js'); return SDK.TargetManager.TargetManager.instance().primaryPageTarget().inspectedURL() })()` })
    expect(inspectedUrl).not.toContain('/second')
    expect(inspectedUrl).toBe(first.url())
    const frontend = (body: string) => control('frontend', { expression: `(async () => {
      const SDK = await import('./core/sdk/sdk.js'); const UI = await import('./ui/legacy/legacy.js');
      const target = SDK.TargetManager.TargetManager.instance().primaryPageTarget(); ${body}
    })()` })
    const elements = await frontend(`await UI.ViewManager.ViewManager.instance().showView('elements');
      const document = await target.domAgent().invoke_getDocument({ depth: -1 });
      return (await target.domAgent().invoke_getOuterHTML({ nodeId: document.root.nodeId })).outerHTML;`)
    expect(elements).toContain('Registered browser page')
    expect(elements).toContain('data-page="A"')
    await control('screenshot', { path: join(directory, 'browser-devtools-A-elements.png') })
    const consoleResult = await frontend(`await UI.ViewManager.ViewManager.instance().showView('console');
      return (await target.runtimeAgent().invoke_evaluate({ expression: 'console.log("DEVTOOLS-PAGE-A", location.href); document.querySelector("#name").value', returnByValue: true })).result.value;`)
    expect(consoleResult).toBe('page A')
    await control('screenshot', { path: join(directory, 'browser-devtools-A-console.png') })
    const networkUrl = await frontend(`await UI.ViewManager.ViewManager.instance().showView('network');
      const network = target.model(SDK.NetworkManager.NetworkManager);
      const completed = new Promise(resolve => network.addEventListener(SDK.NetworkManager.Events.RequestFinished, event => {
        if (event.data.url().endsWith('/devtools-network-A')) resolve(event.data.url());
      }));
      await target.runtimeAgent().invoke_evaluate({ expression: 'fetch("/devtools-network-A")', awaitPromise: true }); return completed;`)
    expect(networkUrl).toBe(`${first.url()}devtools-network-A`)
    await control('screenshot', { path: join(directory, 'browser-devtools-A-network.png') })
    expect(await control('frontend', { expression: `fetch(${JSON.stringify(first.url())}).then(() => 'allowed', () => 'denied')` })).toBe('denied')
    await control('devtools', { open: false })
    expect(await control('snapshot')).toMatchObject({ windowCount: 1, debuggerAttached: false })
    await control('select')
    const reconnected = await chromium.connectOverCDP(endpoint)
    const restored = reconnected.contexts()[0].pages().find(page => !page.url().endsWith('/second'))!
    await restored.locator('#name').fill('A reconnected')
    await restored.locator('#submit').click()
    await expect(restored.locator('#result')).toHaveText('A reconnected')
    await restored.screenshot({ path: join(directory, 'browser-devtools-reconnected.png') })
    const lost = restored.waitForEvent('close')
    await control('detach')
    await lost
    await expect(reconnected.contexts()[0].pages()[0].locator('#name')).toHaveValue('fresh page B')
    expect(await control('snapshot')).toMatchObject({ debuggerAttached: false })
    await reconnected.close()
    const fresh = await chromium.connectOverCDP(endpoint)
    expect(fresh.contexts()[0].pages()).toHaveLength(2)
    await fresh.close()
    const wire = new WebSocket(endpoint)
    await once(wire, 'open')
    const wireTargets = (await cdpCommand(wire, 'Target.getTargets')).result.targetInfos as { targetId: string; url: string }[]
    const firstSession = (await cdpCommand(wire, 'Target.attachToTarget', { targetId: wireTargets.find(target => !target.url.endsWith('/second'))!.targetId, flatten: true })).result.sessionId
    const secondSession = (await cdpCommand(wire, 'Target.attachToTarget', { targetId: wireTargets.find(target => target.url.endsWith('/second'))!.targetId, flatten: true })).result.sessionId
    const wireEvents: { method: string; params: { sessionId: string; reason: string } }[] = []
    wire.on('message', data => { const event = JSON.parse(String(data)); if (event.method) wireEvents.push(event) })
    await control('devtools', { open: true })
    expect(wireEvents.filter(event => event.method === 'Target.detachedFromTarget').map(event => event.params)).toEqual([
      expect.objectContaining({ sessionId: firstSession, reason: 'devtools_conflict' })
    ])
    expect((await cdpCommand(wire, 'Runtime.evaluate', { expression: 'document.body.dataset.page', returnByValue: true }, secondSession)).result.result.value).toBe('B')
    await control('devtools', { open: false })
    expect(await control('snapshot')).toMatchObject({ windowCount: 1 })
    wire.close()
    expect(diagnostic).not.toContain('target unavailable')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    await rm(temporary, { recursive: true, force: true })
  }
})
