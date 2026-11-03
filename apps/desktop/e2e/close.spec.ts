import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { expect, test } from '@playwright/test'
import { DesktopSession, apiBase } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { PREFERENCE_DIAGNOSTIC_PREFIX } from '../src/preference-diagnostics'
import { ONBOARDING_GROUPS } from '../src/onboarding'
import zh from '../src/localization/locales/zh/native.json'
import en from '../src/localization/locales/en/native.json'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const PREFERENCES_FILE = 'renderer-preferences.json'
const ZOOM_FACTORS = [1, 1.5, 2] as const
function initializedRuntime(
  testInfo: Parameters<typeof createRuntime>[0],
  preferences: Record<string, unknown> = {}
) {
  const runtime = createRuntime(testInfo)
  // Window lifecycle tests start from an initialized profile; fresh-home tours
  // otherwise cover the controls before any native close assertion is reached.
  writeFileSync(
    join(runtime.userData, PREFERENCES_FILE),
    JSON.stringify({
      language: 'zh',
      ...preferences,
      onboarding: { seen: Object.fromEntries(ONBOARDING_GROUPS.map((group) => [group, true])) },
    })
  )
  return runtime
}

const VARIANTS = [
  { language: 'zh', theme: 'light', messages: zh.tray },
  { language: 'en', theme: 'dark', messages: en.tray },
] as const

test('settings drain before native quit and remain saved after restart', async ({}, testInfo) => {
  const runtime = initializedRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, { nativeWindowLifecycle: true })
  const openSettings = async (): Promise<void> => {
    const page = desktop.page!
    if (await page.getByTestId('account-settings-shell').isVisible()) {
      await page.getByTestId('account-settings-nav-notifications').click()
      return
    }
    await page.getByTestId('activity-account').evaluate((element: HTMLElement) => element.click())
    await expect
      .poll(async () => {
        for (const surface of desktop.app!.windows()) {
          if (
            await surface
              .getByTestId('account-menu-settings')
              .isVisible()
              .catch(() => false)
          )
            return true
        }
        return false
      })
      .toBe(true)
    for (const surface of desktop.app!.windows()) {
      const entry = surface.getByTestId('account-menu-settings')
      if (await entry.isVisible().catch(() => false)) {
        await entry.click()
        break
      }
    }
    await page.getByTestId('account-settings-nav-notifications').click()
  }
  try {
    let page = await desktop.launch()
    await openSettings()
    const notifications = page.getByTestId('notification-desktop')
    await expect(notifications).toHaveAttribute('aria-checked', 'true')
    await notifications.click()
    await page.getByTestId('notification-sound').click()
    await page.screenshot({ path: join(runtime.artifacts, 'preferences-before-quit.png') })
    const closed = desktop.app!.waitForEvent('close')
    await desktop.app!.evaluate(({ app }) => {
      app.quit()
    })
    await closed
    const lifecycle = readFileSync(join(runtime.home, 'logs/window.log'), 'utf8')
    const flushed = lifecycle.indexOf('"stage":"flush","result":"completed"')
    const stopped = lifecycle.indexOf('backend stop requested')
    expect(flushed).toBeGreaterThanOrEqual(0)
    expect(stopped).toBeGreaterThan(flushed)
    expect(lifecycle).not.toContain('ERR_WORKBENCH_NOT_READY')
    const diagnostics = lifecycle
      .split('\n')
      .filter((line) => line.includes(PREFERENCE_DIAGNOSTIC_PREFIX))
      .map((line) =>
        JSON.parse(
          line.slice(
            line.indexOf(PREFERENCE_DIAGNOSTIC_PREFIX) + PREFERENCE_DIAGNOSTIC_PREFIX.length
          )
        )
      )
    expect(
      diagnostics.some(
        (record) =>
          record.source === 'main' &&
          record.changedFields?.includes('desktopNotifications') &&
          record.submittedRevision === record.acknowledgedRevision &&
          record.submissionSources.includes('state-effect')
      )
    ).toBe(true)
    const saved = JSON.parse(readFileSync(join(runtime.userData, PREFERENCES_FILE), 'utf8'))
    expect(saved.desktopNotifications).toBe(false)
    expect(saved.soundAlerts).toBe(false)
    await desktop.close()
    page = await desktop.launch()
    await openSettings()
    await expect(page.getByTestId('notification-desktop')).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('notification-sound')).toHaveAttribute('aria-checked', 'false')
    await page.screenshot({ path: join(runtime.artifacts, 'preferences-after-restart.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('macOS 关闭仍隐藏主窗口，恢复后渲染器与后端保持可用', async ({}, testInfo) => {
  test.skip(process.platform !== 'darwin', '仅在 macOS 验证原生关闭行为')
  const desktop = new DesktopSession(initializedRuntime(testInfo), testInfo, {
    nativeWindowLifecycle: true,
  })
  try {
    const page = await desktop.launch()
    const window = await desktop.browserWindow(page)
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

test('macOS 全屏关闭先退出全屏再隐藏，恢复同一工作台', async ({}, testInfo) => {
  test.skip(process.platform !== 'darwin', '仅在 macOS 验证原生全屏关闭行为')
  const desktop = new DesktopSession(initializedRuntime(testInfo), testInfo, {
    nativeWindowLifecycle: true,
  })
  try {
    const page = await desktop.launch()
    const window = await desktop.browserWindow(page)
    const beforeId = await window.evaluate((nativeWindow) => nativeWindow.id)
    await window.evaluate(
      (nativeWindow) =>
        new Promise<void>((resolve) => {
          nativeWindow.once('enter-full-screen', resolve)
          nativeWindow.setFullScreen(true)
        })
    )
    await window.evaluate((nativeWindow) => nativeWindow.close())
    await expect
      .poll(() =>
        window.evaluate((nativeWindow) => ({
          visible: nativeWindow.isVisible(),
          fullscreen: nativeWindow.isFullScreen(),
        }))
      )
      .toEqual({ visible: false, fullscreen: false })
    expect(page.isClosed()).toBe(false)
    const response = await page.request.get(`${await apiBase(page)}/api/healthz/backend`)
    expect(response.ok()).toBe(true)
    await window.evaluate((nativeWindow) => nativeWindow.show())
    expect(await window.evaluate((nativeWindow) => nativeWindow.id)).toBe(beforeId)
    await expect(page.getByTestId('workbench-shell')).toBeVisible()
    await page.screenshot({
      path: join(desktop.runtime.artifacts, 'macos-fullscreen-restored.png'),
    })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

for (const variant of VARIANTS) {
  test(`Windows 关闭弹窗：${variant.language} ${variant.theme}、缩放、键盘与托盘`, async ({}, testInfo) => {
    test.skip(process.platform !== 'win32', '必须在真实 Windows 运行，不模拟平台')
    const runtime = initializedRuntime(testInfo, {
      language: variant.language,
      theme: variant.theme,
    })
    const desktop = new DesktopSession(runtime, testInfo, { nativeWindowLifecycle: true })
    try {
      let page = await desktop.launch()
      const window = await desktop.browserWindow(page)
      const dialog = page.getByTestId('window-close-dialog')
      for (const zoom of ZOOM_FACTORS) {
        await window.evaluate(
          (nativeWindow, factor) => nativeWindow.webContents.setZoomFactor(factor),
          zoom
        )
        await window.evaluate((nativeWindow) => {
          nativeWindow.close()
          nativeWindow.close()
        })
        await expect(dialog).toHaveCount(1)
        await expect(
          dialog.getByRole('button', { name: variant.messages.minimize, exact: true })
        ).toBeFocused()
        const geometry = await dialog.evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          return {
            horizontal: element.scrollWidth > element.clientWidth,
            vertical: element.scrollHeight > element.clientHeight,
            wraps: [...element.querySelectorAll('.vds-dialog__footer button')].some(
              (button) => getComputedStyle(button).whiteSpace !== 'nowrap'
            ),
            insideViewport:
              bounds.left >= 0 &&
              bounds.top >= 0 &&
              bounds.right <= innerWidth &&
              bounds.bottom <= innerHeight,
          }
        })
        expect(geometry).toEqual({
          horizontal: false,
          vertical: false,
          wraps: false,
          insideViewport: true,
        })
        // Playwright's page screenshot clips Electron's zoomed native surface to
        // CSS viewport pixels. Capture the actual window at its native scale.
        const capture = await window.evaluate(async (nativeWindow) =>
          (await nativeWindow.webContents.capturePage()).toPNG().toString('base64')
        )
        writeFileSync(
          join(runtime.artifacts, `windows-close-${variant.language}-${variant.theme}-${zoom}.png`),
          Buffer.from(capture, 'base64')
        )
        await page.keyboard.press('Tab')
        expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
          true
        )
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
      await expect
        .poll(() => window.evaluate((nativeWindow) => nativeWindow.isVisible()))
        .toBe(false)
      expect((await page.request.get(`${await apiBase(page)}/api/healthz`)).ok()).toBe(true)
      await desktop.close()
      page = await desktop.launch()
      const restartedWindow = await desktop.browserWindow(page)
      await restartedWindow.evaluate((nativeWindow) => nativeWindow.close())
      await expect
        .poll(() => restartedWindow.evaluate((nativeWindow) => nativeWindow.isVisible()))
        .toBe(false)
      await expect(page.getByTestId('window-close-dialog')).toHaveCount(0)
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
    }
  })
}

test('Windows 从统一弹窗退出应用', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', '必须在真实 Windows 运行')
  const desktop = new DesktopSession(initializedRuntime(testInfo), testInfo, {
    nativeWindowLifecycle: true,
  })
  try {
    const page = await desktop.launch()
    const window = await desktop.browserWindow(page)
    await window.evaluate((nativeWindow) => nativeWindow.close())
    const quit = page
      .getByTestId('window-close-dialog')
      .getByRole('button', { name: zh.tray.quit, exact: true })
    await expect(quit).toBeVisible()
    const closed = desktop.app!.waitForEvent('close')
    await quit.click()
    await closed
  } finally {
    await desktop.attachArtifacts()
  }
})
