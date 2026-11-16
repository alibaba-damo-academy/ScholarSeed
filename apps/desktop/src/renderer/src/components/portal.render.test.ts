import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { renderFixture } from '../../../test-helpers/render.ts'

test(
  'settings portals share their original React state and keep nested controls and focus inside the destination document',
  { timeout: 60_000 },
  async () => {
    const fixture = await renderFixture(path.resolve(import.meta.dirname, '..'), {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    try {
      const page = await fixture.browser.newPage({ viewport: { width: 1280, height: 840 } })
      await page.goto(new URL('/components/portal.render.fixture.html', fixture.url).href)
      const native = page.frameLocator('iframe')
      await expect(native.getByRole('dialog', { name: 'Shared settings' })).toBeVisible()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await native
        .getByRole('textbox', { name: 'Settings draft', exact: true })
        .fill('keep my draft')
      await native.getByRole('button', { name: 'Increment', exact: true }).click()
      await expect(page.getByTestId('shared-count')).toHaveText('1')
      const frame = page.frames().find((candidate) => candidate.parentFrame())!
      await frame.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (text: string) => {
              document.body.dataset.copied = text
            },
          },
        })
      })
      await native.getByRole('button', { name: 'Copy from settings', exact: true }).click()
      await expect(
        native.getByRole('button', { name: 'Copied from settings', exact: true })
      ).toBeVisible()
      assert.equal(await frame.evaluate(() => document.body.dataset.copied), 'settings-copy')
      await native.getByRole('button', { name: 'Open popover', exact: true }).click()
      await expect(
        native.getByRole('textbox', { name: 'Popover draft', exact: true })
      ).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(native.getByRole('textbox', { name: 'Popover draft', exact: true })).toHaveCount(
        0
      )
      await native.getByRole('combobox', { name: 'Choose value', exact: true }).click()
      await native.getByRole('option', { name: 'Second value', exact: true }).click()
      await expect(native.getByRole('combobox', { name: 'Choose value', exact: true })).toHaveText(
        'Second value'
      )
      await native.getByRole('button', { name: 'Nested confirmation', exact: true }).click()
      await expect(native.getByRole('alertdialog', { name: 'Confirm changes' })).toBeVisible()
      await expect(page.getByRole('alertdialog')).toHaveCount(0)
      await native.getByRole('button', { name: 'Cancel changes', exact: true }).click()
      await expect(
        native.getByRole('textbox', { name: 'Settings draft', exact: true })
      ).toHaveValue('keep my draft')
      assert.equal(
        await page.getByRole('button', { name: 'Outside unchanged', exact: true }).count(),
        1
      )
    } finally {
      await fixture.close()
    }
  }
)
