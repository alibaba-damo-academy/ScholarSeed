import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { expect } from '@playwright/test'
import { renderFixture } from '../../../../test-helpers/render.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')
const FIXTURE = '/features/literature/preview.render.fixture.html'

test('literature preview fits five papers, scrolls to the last, and collapses independently', async (context) => {
  const fixture = await renderFixture(ROOT)
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  const preview = page.getByTestId('receipt-preview')
  const scrollbar = page.getByRole('scrollbar')
  const open = page.getByTestId('artifact-open-default')
  const more = page.getByTestId('artifact-more-actions')
  const toggle = page.getByTestId('receipt-toggle')

  await page.goto(new URL(`${FIXTURE}?papers=5`, fixture.url).href)
  await expect(page.locator('[data-artifact-receipt]').getByTestId('receipt-preview')).toHaveCount(
    1
  )
  await expect(preview.getByRole('listitem')).toHaveCount(5)
  const firstRow = preview.getByRole('listitem').first()
  await expect(firstRow).toHaveCSS('height', '24px')
  await expect(firstRow).toHaveCSS('column-gap', '4px')
  await expect(firstRow).toHaveCSS('border-top-left-radius', '4px')
  await expect(firstRow.getByText('Paper 1')).toHaveCSS('font-size', '10px')
  await expect(firstRow.getByText('Paper 1')).toHaveCSS('line-height', '16px')
  await expect(preview.getByText('Paper 5')).toBeInViewport()
  assert.equal(await preview.evaluate((element) => element.scrollHeight - element.clientHeight), 0)
  await expect(scrollbar).toHaveCount(0)

  await page.goto(new URL(`${FIXTURE}?papers=8`, fixture.url).href)
  await expect(scrollbar).toBeVisible()
  const geometry = await preview.evaluate(async (element) => {
    const animations = element.closest('[data-state="open"]')?.getAnimations() ?? []
    await Promise.all(animations.map((animation) => animation.finished))
    const bounds = element.getBoundingClientRect()
    const papers = Array.from(element.querySelectorAll('li'), (row) => row.getBoundingClientRect())
    return {
      height: bounds.height,
      full: papers.filter((row) => row.top >= bounds.top && row.bottom <= bounds.bottom).length,
      partial: papers.filter((row) => row.top < bounds.bottom && row.bottom > bounds.bottom).length,
    }
  })
  assert.ok(geometry.height <= 170)
  assert.equal(geometry.full, 5)
  assert.equal(geometry.partial, 0)
  await expect(preview.getByRole('listitem')).toHaveCount(8)
  await preview.hover()
  await page.mouse.wheel(0, 500)
  await expect(preview.getByText('Paper 8')).toBeInViewport()
  await expect(page.getByText('View all', { exact: true })).toHaveCount(0)

  await more.click()
  await expect(toggle).toHaveText('Collapse content preview')
  await toggle.click()
  await expect(preview).toHaveCount(0)
  await expect(open).toBeVisible()
  await more.click()
  await expect(toggle).toHaveText('Expand content preview')
  await toggle.click()
  await expect(preview.getByRole('listitem')).toHaveCount(8)
})
