import { randomUUID } from 'node:crypto'
import { expect, test, previewSurface, openPreviewTools } from './testing'
import { capturePreview } from './capture'
import { WORKSPACE_WINDOW_MINIMUM } from '../src/window'

test('all participants share the same functional controls without role or layout-size modes', async ({ page }) => {
  await page.goto('/?previewInstance=' + randomUUID() + '&page=page-conversation&scene=conversation-stream')
  await expect(page.getByRole('navigation', { name: '功能导航', exact: true })).toBeVisible()
  await expect(page.locator('#pdfe-role')).toHaveCount(0)
  await expect(page.locator('#preview-viewport-size')).toHaveCount(0)
  await expect(page.getByTestId('preview-scene-page-conversation-conversation-stream')).toHaveAttribute('aria-current', 'page')
  await expect(previewSurface(page).getByTestId('composer-input')).toBeVisible()
})

test('PDFE search expands matching page and scene buttons without navigating the product', async ({ page }, testInfo) => {
  await page.goto('/?previewInstance=' + randomUUID() + '&page=page-home&scene=home-browse')
  await expect(previewSurface(page).getByTestId('home-task-preview-session')).toBeVisible()
  const address = page.url()
  const search = page.getByRole('searchbox', { name: '查找页面、场景或状态', exact: true })
  await search.fill('conversation-stream')
  await expect(page.getByTestId('preview-scene-page-conversation-conversation-stream')).toBeVisible()
  expect(page.url()).toBe(address)
  await search.fill('no-matching-pdfe-page-or-state')
  await expect(page.getByRole('status')).toHaveText('没有匹配的页面或状态')
  await search.fill('components')
  await expect(page.getByTestId('preview-page-development-components')).toBeVisible()
  expect(page.url()).toBe(address)
  await capturePreview(page, testInfo.outputPath('pdfe-navigation-search.png'))
})

test('shared PDFE navigation and instructions support dark English at the minimum outer window', async ({ page }, testInfo) => {
  await page.setViewportSize(WORKSPACE_WINDOW_MINIMUM)
  await page.goto('/?previewInstance=' + randomUUID() + '&page=page-conversation&scene=conversation-stream')
  await openPreviewTools(page)
  await page.locator('#preview-theme').click()
  await page.getByRole('option', { name: '深色', exact: true }).click()
  await page.locator('#preview-language').click()
  await page.getByRole('option', { name: 'English', exact: true }).click()
  await page.getByRole('button', { name: '保存外观并重新加载', exact: true }).click()
  const controls = page.getByRole('dialog', { name: 'PDFE Workbench', exact: true })
  await expect(controls).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(controls.getByRole('navigation', { name: 'Feature navigation', exact: true })).toBeVisible()
  await expect(controls.getByRole('button', { name: 'UI component examples', exact: true })).toBeInViewport()
  expect(await controls.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await capturePreview(page, testInfo.outputPath('pdfe-navigation-dark-english.png'))
  await controls.getByRole('button', { name: 'Usage guide', exact: true }).click()
  const guide = page.getByRole('dialog', { name: 'Usage guide', exact: true })
  await expect(guide).toBeVisible()
  await expect(guide).toContainText('Product managers, designers and frontend engineers see the same features')
  await page.keyboard.press('Escape')
  await expect(guide).not.toBeVisible()
  await expect(controls).toBeVisible()
})
