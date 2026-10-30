import { randomUUID } from 'node:crypto'
import { previewSurface, expect, test } from './testing'
import { PREVIEW_CATALOG } from './catalog'
import { previewConsumption } from './coverage'
import { WINDOW_CLOSE_ACTION } from '../src/window'

test('close pending scene preserves its dialog and disables repeat decisions until its local receipt', { annotation: previewConsumption('surface-close', 'surface-close-pending', ['open', 'pending', 'completed']) }, async ({ page }, testInfo) => {
  const scene = 'surface-close-pending'
  expect(PREVIEW_CATALOG.find(entry => entry.id === 'surface-close')?.scenarios.some(entry => entry.id === scene)).toBe(true)
  await page.goto(`/?previewInstance=${randomUUID()}&page=surface-close&scene=${scene}`)
  await previewSurface(page).getByTestId('preview-close-open').click()
  const dialog = previewSurface(page).getByTestId('window-close-dialog')
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: '最小化到托盘', exact: true }).click()
  for (const button of await dialog.getByRole('button').all()) await expect(button).toBeDisabled()
  await expect(dialog.getByRole('checkbox')).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(previewSurface(page).getByTestId('preview-close-reply')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('close-pending.png') })
  await expect(dialog).not.toBeVisible()
  await expect(previewSurface(page).getByTestId('preview-close-reply')).toHaveText(JSON.stringify({ requestId: 1, action: WINDOW_CLOSE_ACTION.minimize, remember: true }))
  await expect(previewSurface(page).getByTestId('preview-close-open')).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('close-pending-receipt.png') })
})

test('close failure scene preserves the request and remembered choice for a real UI retry', { annotation: previewConsumption('surface-close', 'surface-close-failed', ['open', 'failed', 'retried']) }, async ({ page }, testInfo) => {
  const scene = 'surface-close-failed'
  expect(PREVIEW_CATALOG.find(entry => entry.id === 'surface-close')?.scenarios.some(entry => entry.id === scene)).toBe(true)
  await page.goto(`/?previewInstance=${randomUUID()}&page=surface-close&scene=${scene}`)
  await previewSurface(page).getByTestId('preview-close-open').click()
  const dialog = previewSurface(page).getByTestId('window-close-dialog')
  await dialog.getByRole('checkbox').check()
  const quit = dialog.getByRole('button', { name: '退出书深', exact: true })
  await quit.click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await expect(dialog.getByRole('checkbox')).toBeChecked()
  await expect(quit).toBeEnabled()
  await expect(previewSurface(page).getByTestId('preview-close-reply')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('close-failed.png') })
  await quit.click()
  await expect(dialog).not.toBeVisible()
  await expect(previewSurface(page).getByTestId('preview-close-reply')).toHaveText(JSON.stringify({ requestId: 1, action: WINDOW_CLOSE_ACTION.quit, remember: true }))
  await expect(previewSurface(page).getByTestId('preview-close-open')).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('close-retried.png') })
})
