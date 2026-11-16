import path from 'node:path'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { renderFixture } from '../../../test-helpers/render.ts'

test(
  'native settings isolate portal destinations without moving main-window dialogs or state',
  {
    timeout: 60_000,
  },
  async () => {
    const fixture = await renderFixture(path.resolve(import.meta.dirname, '..'), {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    try {
      const page = await fixture.browser.newPage({ viewport: { width: 1280, height: 840 } })
      await page.addInitScript(() => {
        Object.defineProperty(window, 'scholarseed', {
          value: {
            settingsPortal: {
              reserve: async () => ({ ok: true, sessionId: 'settings-regression' }),
              paint: async () => ({ ok: true }),
              close: async () => ({ ok: true }),
              subscribeRevoked: () => () => undefined,
            },
          },
        })
      })
      await page.goto(new URL('/shell/settings.render.fixture.html', fixture.url).href)
      await page.getByRole('textbox', { name: 'Main draft', exact: true }).fill('preserve draft')
      const popupReady = page.waitForEvent('popup')
      await page.getByRole('button', { name: 'Open native settings', exact: true }).click()
      const popup = await popupReady
      await expect(
        popup.getByRole('dialog', { name: 'Native settings', exact: true })
      ).toBeVisible()
      await expect.poll(() => popup.evaluate(() => document.body.inert)).toBe(false)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await popup
        .getByRole('textbox', { name: 'Settings draft', exact: true })
        .fill('settings draft')
      await expect(popup.getByRole('textbox', { name: 'Settings draft', exact: true })).toHaveValue(
        'settings draft'
      )
      await popup.getByRole('button', { name: 'Open settings popover', exact: true }).click()
      await expect(
        popup.getByRole('textbox', { name: 'Settings popover draft', exact: true })
      ).toBeFocused()
      await expect(
        page.getByRole('textbox', { name: 'Settings popover draft', exact: true })
      ).toHaveCount(0)
      await popup.keyboard.press('Escape')
      await expect(
        popup.getByRole('textbox', { name: 'Settings popover draft', exact: true })
      ).toHaveCount(0)
      await expect(popup.getByRole('textbox', { name: 'Settings draft', exact: true })).toHaveValue(
        'settings draft'
      )
      await page.bringToFront()
      await page.getByRole('button', { name: 'Open directory', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Main directory', exact: true })).toBeVisible()
      await expect(popup.getByRole('dialog', { name: 'Main directory', exact: true })).toHaveCount(
        0
      )
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await popup.bringToFront()
      await expect(popup.getByRole('textbox', { name: 'Settings draft', exact: true })).toHaveValue(
        'settings draft'
      )
      await popup.keyboard.press('Escape')
      await expect(popup.getByRole('dialog')).toHaveCount(0)
      await page.bringToFront()
      await expect(page.getByRole('textbox', { name: 'Main draft', exact: true })).toHaveValue(
        'preserve draft'
      )
      await page.getByRole('button', { name: 'Open directory', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Main directory', exact: true })).toBeVisible()
    } finally {
      await fixture.close()
    }
  }
)
