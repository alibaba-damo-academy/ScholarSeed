import { expect, type JSHandle, type Page } from '@playwright/test'
import { productWindow, showProductWindow } from './electron'

export async function focusBrowserAddress(page: Page): Promise<void> {
  await showProductWindow(page)
  await page.getByRole('button', { name: '浏览器提示与状态', exact: true }).focus()
  await page.getByRole('textbox', { name: '网址', exact: true }).focus()
}

export async function pressNativeKey(view: JSHandle<Electron.WebContentsView>, key: string): Promise<void> {
  await view.evaluate((target, keyCode) => {
    target.webContents.focus()
    target.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode === 'Enter') target.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    target.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  }, key)
}

export async function selectBrowserMenuItem(page: Page, label: string): Promise<void> {
  await showProductWindow(page)
  const window = await productWindow(page)
  await window.evaluate(native => native.webContents.focus())
  await expect.poll(() => window.evaluate(native => native.isFocused() && native.webContents.isFocused())).toBe(true)
  await page.getByRole('button', { name: '更多浏览器功能', exact: true }).click()
  await expect.poll(() => window.evaluate(native => native.contentView.children.some(child =>
    child.getVisible() && (child as Electron.WebContentsView).webContents.getURL().includes('/menu.html')
  ))).toBe(true)
  const menu = await window.evaluateHandle(native => native.contentView.children.find(child =>
    child.getVisible() && (child as Electron.WebContentsView).webContents.getURL().includes('/menu.html')
  ) as Electron.WebContentsView)
  const items = await menu.evaluate(view => view.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('[role=menuitem], [role=menuitemcheckbox], [role=menuitemradio]'))
      .filter(item => item.getClientRects().length && item.getAttribute('aria-disabled') !== 'true')
      .map(item => {
        const rect = item.getBoundingClientRect()
        return {
          label: item.textContent.trim(),
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2)
        }
      })
  `)) as { label: string; x: number; y: number }[]
  const item = items.find(candidate => candidate.label.replace(/^✓\s*/, '').startsWith(label))
  if (!item) throw new Error(`browser menu item unavailable: ${label}; visible ${items.map(row => row.label).join(', ')}`)
  await menu.evaluate((view, point) => {
    view.webContents.focus()
    view.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
    view.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    view.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }, item)
  await expect(page.getByRole('button', { name: '更多浏览器功能', exact: true })).toHaveAttribute('aria-expanded', 'false')
}

export async function setBrowserDevtools(page: Page, open: boolean): Promise<void> {
  await selectBrowserMenuItem(page, open ? '打开开发者工具' : '关闭开发者工具')
  await expect.poll(async () => {
    const reply = await page.evaluate(() => window.scholarseed.browser.snapshot())
    return reply.ok
      ? reply.snapshot.tabs.find(tab => tab.tabId === reply.snapshot.activeTabId)?.devtoolsOpen
      : undefined
  }).toBe(open)
  if (open) {
    const window = await productWindow(page)
    // Wait for the frontend before restoring focus for another native menu action.
    await expect.poll(() => window.evaluate(native => native.contentView.children.some(child => {
      const contents = (child as Electron.WebContentsView).webContents
      return Boolean(contents.devToolsWebContents)
    }))).toBe(true)
    await showProductWindow(page)
    await expect.poll(() => window.evaluate(native => native.isFocused() && native.webContents.isFocused())).toBe(true)
  }
}

export async function browserSuggestions(page: Page): Promise<JSHandle<Electron.WebContentsView>> {
  const window = await productWindow(page)
  await expect.poll(() => window.evaluate(native => native.contentView.children.some(child =>
    child.getVisible() && (child as Electron.WebContentsView).webContents.getURL().includes('/overlay.html')
  ))).toBe(true)
  return window.evaluateHandle(native => native.contentView.children.find(child =>
    child.getVisible() && (child as Electron.WebContentsView).webContents.getURL().includes('/overlay.html')
  ) as Electron.WebContentsView)
}

/**
 * Browser has no activity-rail entry. These isolated integration fixtures use
 * the public persisted-navigation startup path; this is not user-flow acceptance.
 */
export async function restoreBrowser(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const current = await window.scholarseed.reconcilePreferences()
    await window.scholarseed.savePreferences({
      ...current,
      lastLocation: {
        view: 'browser', projectId: null, sessionId: null, sessionProjectId: null,
        settingsPage: null, browserSettingsSection: null,
        aiPanelOpen: false, aiPanelCover: false,
        target: { kind: 'tab', id: 'browser' },
      },
    })
  })
  await page.reload()
  await expect(page.getByTestId('browser-workspace')).toBeVisible()
}
