import { writeFileSync } from 'fs'
import { join } from 'path'
import { expect, test } from '@playwright/test'
import { DesktopSession, apiBase } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import zh from '../src/localization/locales/zh/native.json'
import en from '../src/localization/locales/en/native.json'

const PREFERENCES_FILE = 'renderer-preferences.json'
const ZOOM_FACTORS = [1, 1.5, 2] as const
const VARIANTS = [
  { language: 'zh', theme: 'light', messages: zh.tray },
  { language: 'en', theme: 'dark', messages: en.tray }
] as const

test('macOS 关闭仍隐藏主窗口，恢复后渲染器与后端保持可用', async ({}, testInfo) => {
  test.skip(process.platform !== 'darwin', '仅在 macOS 验证原生关闭行为')
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo, { nativeWindowLifecycle: true })
  try {
    const page = await desktop.launch()
    const window = await desktop.app!.browserWindow(page)
    const beforeId = await window.evaluate((nativeWindow) => nativeWindow.id)
    await window.evaluate((nativeWindow) => nativeWindow.close())
    await expect.poll(() => window.evaluate((nativeWindow) => nativeWindow.isVisible())).toBe(false)
    expect(page.isClosed()).toBe(false)
    await expect(page.getByTestId('window-close-dialog')).toHaveCount(0)
    const response = await page.request.get(`${await apiBase(page)}/api/healthz`)
    expect(response.ok()).toBe(true)
    await window.evaluate((nativeWindow) => nativeWindow.show())
    expect(await window.evaluate((nativeWindow) => nativeWindow.id)).toBe(beforeId)
    await expect(page.getByTestId('workbench-shell')).toBeVisible()
    await page.screenshot({ path: join(desktop.runtime.artifacts, 'macos-restored.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

for (const variant of VARIANTS) {
  test(`Windows 关闭弹窗：${variant.language} ${variant.theme}、缩放、键盘与托盘`, async ({}, testInfo) => {
    test.skip(process.platform !== 'win32', '必须在真实 Windows 运行，不模拟平台')
    const runtime = createRuntime(testInfo)
    writeFileSync(join(runtime.userData, PREFERENCES_FILE), JSON.stringify({ language: variant.language, theme: variant.theme }))
    const desktop = new DesktopSession(runtime, testInfo, { nativeWindowLifecycle: true })
    try {
      let page = await desktop.launch()
      const window = await desktop.app!.browserWindow(page)
      const dialog = page.getByTestId('window-close-dialog')
      for (const zoom of ZOOM_FACTORS) {
        await window.evaluate((nativeWindow, factor) => nativeWindow.webContents.setZoomFactor(factor), zoom)
        await window.evaluate((nativeWindow) => { nativeWindow.close(); nativeWindow.close() })
        await expect(dialog).toHaveCount(1)
        await expect(dialog.getByRole('button', { name: variant.messages.minimize, exact: true })).toBeFocused()
        const geometry = await dialog.evaluate((element) => ({
          horizontal: element.scrollWidth > element.clientWidth,
          vertical: element.scrollHeight > element.clientHeight,
          wraps: [...element.querySelectorAll('.vds-dialog__footer button')].some((button) => getComputedStyle(button).whiteSpace !== 'nowrap')
        }))
        expect(geometry).toEqual({ horizontal: false, vertical: false, wraps: false })
        await page.screenshot({ path: join(runtime.artifacts, `windows-close-${variant.language}-${variant.theme}-${zoom}.png`) })
        await page.keyboard.press('Tab')
        expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        expect(await window.evaluate((nativeWindow) => nativeWindow.isVisible())).toBe(true)
      }
      await window.evaluate((nativeWindow) => nativeWindow.webContents.setZoomFactor(1))
      await window.evaluate((nativeWindow) => nativeWindow.close())
      await dialog.getByRole('button', { name: variant.messages.cancel, exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await window.evaluate((nativeWindow) => nativeWindow.close())
      await dialog.getByRole('checkbox', { name: variant.messages.doNotAskAgain }).click()
      await dialog.getByRole('button', { name: variant.messages.minimize, exact: true }).click()
      await expect.poll(() => window.evaluate((nativeWindow) => nativeWindow.isVisible())).toBe(false)
      expect((await page.request.get(`${await apiBase(page)}/api/healthz`)).ok()).toBe(true)
      await desktop.close()
      page = await desktop.launch()
      const restartedWindow = await desktop.app!.browserWindow(page)
      await restartedWindow.evaluate((nativeWindow) => nativeWindow.close())
      await expect.poll(() => restartedWindow.evaluate((nativeWindow) => nativeWindow.isVisible())).toBe(false)
      await expect(page.getByTestId('window-close-dialog')).toHaveCount(0)
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
    }
  })
}

test('Windows 从统一弹窗退出应用', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', '必须在真实 Windows 运行')
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo, { nativeWindowLifecycle: true })
  try {
    const page = await desktop.launch()
    const window = await desktop.app!.browserWindow(page)
    await window.evaluate((nativeWindow) => nativeWindow.close())
    const quit = page.getByTestId('window-close-dialog').getByRole('button', { name: zh.tray.quit, exact: true })
    await expect(quit).toBeVisible()
    const closed = desktop.app!.waitForEvent('close')
    await quit.click()
    await closed
  } finally {
    await desktop.attachArtifacts()
  }
})
