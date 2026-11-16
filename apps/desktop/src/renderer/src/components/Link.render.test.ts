import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { expect } from '@playwright/test'
import { renderFixture } from '../../../test-helpers/render.ts'

test('Link preserves anchor semantics, icon accessibility, focus refs and caller-controlled activation', async (context) => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '..'))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.goto(`${fixture.url}components/Link.render.fixture.html`)
  const link = page.getByTestId('normal')
  await expect(link).toHaveAttribute('href', '#destination')
  await expect(link).toHaveAccessibleName('Normal link')
  await expect(link.locator('svg')).toHaveCount(1)
  await page.getByTestId('focus').click()
  await expect(link).toBeFocused()
  await link.press('Enter')
  await expect(page.getByTestId('clicked')).toContainText('#destination')
  assert.equal(new URL(page.url()).hash, '')
  await expect(link).toHaveCSS('text-decoration-style', 'dotted')
  const colors = await link.evaluate((element) => ({
    link: getComputedStyle(element).color,
    parent: getComputedStyle(element.parentElement!).color,
  }))
  assert.equal(colors.link, colors.parent)
  const security = (await page.getByTestId('new-tab').getAttribute('rel'))!.split(/\s+/)
  assert.ok(['nofollow', 'noopener', 'noreferrer'].every((value) => security.includes(value)))
  assert.equal(security.includes('opener'), false)
  await expect(page.getByTestId('new-tab')).toHaveAttribute(
    'href',
    'https://example.com/?a=%20#original'
  )
  const disabled = page.getByTestId('disabled')
  await expect(disabled).toHaveAttribute('aria-disabled', 'true')
  await expect(disabled).not.toHaveAttribute('href')
  await disabled.dispatchEvent('click')
  await disabled.dispatchEvent('auxclick', { button: 1 })
  await expect(page.getByTestId('clicked')).not.toHaveText('disabled')
  await page.getByTestId('new-tab').focus()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('long')).toBeFocused()
  assert.equal(
    await page
      .getByTestId('link-container')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
    true
  )
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#destination$/)
})
