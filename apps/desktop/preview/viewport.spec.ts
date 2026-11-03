import { randomUUID } from 'node:crypto'
import { expect, test } from './testing'
import { capturePreview } from './capture'
import { PREVIEW_VIEWPORT } from './viewport'
import zh from './locales/zh.json'

test('product dialogs stay inside the docked renderer viewport and remain operable beside the controls', async ({ page }, testInfo) => {
  await page.goto(`/?previewInstance=${randomUUID()}&page=settings-archives&scene=settings-archives-states`)
  const frameElement = page.locator(`#${PREVIEW_VIEWPORT.frameId}`)
  await expect(frameElement).toHaveCount(1)
  const surface = frameElement.contentFrame()
  const settings = surface.getByRole('dialog', { name: '设置', exact: true })
  const controls = page.getByRole('dialog', { name: zh.title, exact: true })
  await expect(settings).toBeVisible()
  await expect(controls).toBeVisible()
  const selection = surface.getByTestId('account-settings-archives').getByRole('checkbox').first()
  await selection.click()
  await expect(selection).toBeChecked()
  const original = await settings.elementHandle()
  const viewport = (await frameElement.boundingBox())!
  const close = settings.getByRole('button', { name: '关闭', exact: true })
  const closeBox = (await close.boundingBox())!
  expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(viewport.x + viewport.width)
  await capturePreview(page, testInfo.outputPath('viewport-settings-operable.png'))
  await controls.getByRole('button', { name: zh.close, exact: true }).click()
  await expect(controls).not.toBeVisible()
  await expect.poll(async () => (await frameElement.boundingBox())!.width).toBe(page.viewportSize()!.width)
  await page.evaluate(({ type }) => new Promise<void>(resolve => {
    const delivered = (event: MessageEvent): void => {
      if (event.source !== window || event.data?.type !== type) return
      window.removeEventListener('message', delivered)
      resolve()
    }
    window.addEventListener('message', delivered)
    window.postMessage({ type, instance: new URL(location.href).searchParams.get('previewInstance'), action: 'open-controls' }, location.origin)
  }), { type: PREVIEW_VIEWPORT.messageType })
  await expect(controls).not.toBeVisible()
  await selection.press('F8')
  await expect(controls).toBeVisible()
  await expect(selection).toBeChecked()
  expect(await settings.evaluate((node, prior) => node === prior, original)).toBe(true)
  await close.click()
  await expect(settings).not.toBeVisible()
  await expect(controls).toBeVisible()
  await capturePreview(page, testInfo.outputPath('viewport-settings-closed.png'))
  await original!.dispose()
})
