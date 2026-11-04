import { expect, type Page } from '@playwright/test'
import { showProductWindow } from './electron'

/** Locate the actual menu surface, including the native WebContentsView. */
export async function openAccountMenu(page: Page): Promise<Page> {
  await showProductWindow(page)
  await page.getByTestId('activity-account').click()
  let surface: Page | undefined
  await expect.poll(async () => {
    for (const candidate of page.context().pages()) {
      if (candidate.isClosed()) continue
      if (candidate !== page && !candidate.url().endsWith('/menu.html')) continue
      if (await candidate.getByTestId('account-menu').isVisible().catch(() => false)) {
        surface = candidate
        return true
      }
    }
    return false
  }, { message: 'account menu must appear on its inline or native surface' }).toBe(true)
  if (!surface) throw new Error('account menu surface unavailable')
  return surface
}

export async function openAccountSettings(page: Page): Promise<void> {
  if (await page.getByTestId('account-settings-shell').isVisible()) return
  const menu = await openAccountMenu(page)
  await menu.getByTestId('account-menu-settings').click()
  await expect(page.getByRole('dialog', { name: /设置|Settings/, exact: true })).toBeVisible()
}
