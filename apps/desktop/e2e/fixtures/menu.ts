import { expect, type Page } from '@playwright/test'
import { PORTAL_URL } from '../../src/portal'
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

async function settingsSurface(page: Page): Promise<Page | undefined> {
  for (const candidate of page.context().pages()) {
    if (candidate.isClosed() || (candidate !== page && candidate.url() !== PORTAL_URL)) continue
    if (await candidate.getByTestId('account-settings-shell').isVisible().catch(() => false))
      return candidate
  }
}

export async function openAccountSettings(page: Page): Promise<Page> {
  const existing = await settingsSurface(page)
  if (existing) return existing
  const menu = await openAccountMenu(page)
  await menu.getByTestId('account-menu-settings').click()
  let surface: Page | undefined
  await expect.poll(async () => {
    surface = await settingsSurface(page)
    return !!surface
  }).toBe(true)
  if (!surface) throw new Error('account settings surface unavailable')
  await expect(surface.getByRole('dialog', { name: /设置|Settings/, exact: true })).toBeVisible()
  return surface
}
