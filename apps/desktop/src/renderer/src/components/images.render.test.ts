import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { expect, type Page } from '@playwright/test'
import { renderFixture } from '../../../test-helpers/render.ts'

const failedName =
  '20261028141906-图片引用失效后完整名称仍应可以通过键盘及悬停查看-long-image-name.jpg'

let preparing: ReturnType<typeof renderFixture> | undefined
after(async () => {
  await (await preparing)?.close()
})

async function withFixture(run: (page: Page) => Promise<void>): Promise<void> {
  preparing ??= renderFixture(path.resolve(import.meta.dirname, '..'))
  const fixture = await preparing
  const context = await fixture.browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(`${fixture.url}components/images.render.fixture.html`)
    await expect(page.getByRole('button', { name: 'Resize', exact: true })).toBeVisible()
    await run(page)
  } finally {
    await context.close()
  }
}

test('ImageStrip labels explicit sources without tagging local uploads or intercepting image activation', async () => {
  await withFixture(async (page) => {
    const cards = page.getByTestId('strip-container').locator('[data-slot="image-strip-item"]')
    await expect(cards.nth(0).locator('[data-slot="image-source-label"]')).toHaveCount(0)
    await expect(cards.nth(1).locator('[data-slot="image-source-label"]')).toHaveText('资料')
    await expect(cards.nth(2).locator('[data-slot="image-source-label"]')).toHaveText('文献')
    await expect(cards.nth(1).locator('[data-slot="image-source-label"]')).toHaveCSS(
      'pointer-events',
      'none'
    )
    await cards.nth(1).click()
    await expect(page.getByTestId('selected')).toHaveText('1')
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    await expect(cards.nth(1).locator('[data-slot="image-source-label"]')).toBeVisible()
  })
})

test('ImageStrip keeps MasterGo 120px cards, hides scrollbars and shows only available navigation on hover', async () => {
  await withFixture(async (page) => {
    const strip = page.getByTestId('strip-container')
    const viewport = strip.locator('[data-slot="image-strip-viewport"]')
    const next = strip.getByRole('button', { name: '向右查看图片' })
    const previous = strip.getByRole('button', { name: '向左查看图片' })
    await expect(strip.getByRole('img')).toHaveCount(10)
    await expect(strip.locator('[data-slot="image-strip-item"]').first()).toHaveCSS(
      'width',
      '120px'
    )
    await expect(strip.locator('[data-slot="image-strip-item"]').first()).toHaveCSS(
      'height',
      '120px'
    )
    const firstCard = strip.locator('[data-slot="image-strip-item"]').first()
    await expect(firstCard).toHaveCSS('border-radius', '8px')
    await expect(firstCard).toHaveCSS('border-top-width', '1px')
    await expect(firstCard).toHaveCSS('border-top-color', 'rgb(223, 223, 223)')
    await expect(viewport).toHaveCSS('scrollbar-width', 'none')
    assert.equal(
      await viewport.evaluate(
        (element) => getComputedStyle(element, '::-webkit-scrollbar').display
      ),
      'none'
    )
    await expect(previous).toHaveCount(0)
    await expect(next).toHaveCSS('opacity', '0')
    await expect(next.locator('..')).toHaveClass(/from-\[var\(--vds-fill-2\)\]/)
    await strip.hover()
    await expect(next).toHaveCSS('opacity', '1')
    await expect(next).toHaveCSS('width', '24px')
    await expect(next).toHaveCSS('height', '24px')
    await expect(next).toHaveCSS('border-radius', '6px')
    const stripBounds = (await strip.boundingBox())!
    const nextBounds = (await next.boundingBox())!
    assert.ok(nextBounds.x + nextBounds.width <= stripBounds.x + stripBounds.width)
    await next.click()
    await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBe(520)
    await expect(previous).toHaveCount(1)
    await expect(previous).toHaveCSS('width', '24px')
    await expect(previous).toHaveCSS('height', '24px')
    await expect(previous).toHaveCSS('border-radius', '6px')
    await expect(previous.locator('..')).toHaveClass(/from-\[var\(--vds-fill-2\)\]/)
    assert.ok((await previous.boundingBox())!.x >= stripBounds.x)
    await next.click()
    await expect(next).toHaveCount(0)
    await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBe(690)
    await previous.click()
    await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBe(170)
    await previous.click()
    await expect(previous).toHaveCount(0)
    await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBe(0)
  })
})

test('ImageStrip updates boundaries for resize, reduced motion, single images and empty lists', async () => {
  await withFixture(async (page) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const strip = page.getByTestId('strip-container')
    const viewport = strip.locator('[data-slot="image-strip-viewport"]')
    await page.getByRole('button', { name: 'Resize', exact: true }).click()
    await strip.getByRole('button', { name: '向右查看图片' }).click()
    await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBe(130)
    await page.getByRole('button', { name: 'Resize', exact: true }).click()
    await page.getByRole('button', { name: 'Triple', exact: true }).click()
    await expect(strip.getByRole('button')).toHaveCount(3)
    await page.getByRole('button', { name: 'Single', exact: true }).click()
    await expect(strip.getByRole('button')).toHaveCount(1)
    await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBe(0)
    await page.getByRole('button', { name: 'Empty', exact: true }).click()
    await expect(strip.locator('[data-slot="image-strip"]')).toHaveCount(0)
  })
})

test('ImageStrip right-aligns short rows and keeps overflow reachable from the left', async () => {
  await withFixture(async (page) => {
    const strip = page.getByTestId('strip-container')
    const viewport = strip.locator('[data-slot="image-strip-viewport"]')
    for (const count of ['Triple', 'Single']) {
      await page.getByRole('button', { name: count, exact: true }).click()
      const viewportBounds = (await viewport.boundingBox())!
      const lastBounds = (await strip
        .locator('[data-slot="image-strip-item"]')
        .last()
        .boundingBox())!
      assert.equal(lastBounds.x + lastBounds.width, viewportBounds.x + viewportBounds.width)
    }
    await page.getByRole('button', { name: 'Triple', exact: true }).click()
    await page.getByRole('button', { name: 'Resize', exact: true }).click()
    const viewportBounds = (await viewport.boundingBox())!
    const firstBounds = (await strip
      .locator('[data-slot="image-strip-item"]')
      .first()
      .boundingBox())!
    assert.equal(firstBounds.x, viewportBounds.x)
    await expect(strip.getByRole('button', { name: '向右查看图片' })).toHaveCount(1)
    await expect(strip.getByRole('button', { name: '向左查看图片' })).toHaveCount(0)
  })
})

test('ImageStrip reports load failures, displays loading and error states, and consumes dark theme tokens', async () => {
  await withFixture(async (page) => {
    const strip = page.getByTestId('strip-container')
    const card = strip.locator('[data-slot="image-strip-item"]').first()
    const lightBackground = await card.evaluate(
      (element) => getComputedStyle(element).backgroundColor
    )
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    assert.notEqual(
      await card.evaluate((element) => getComputedStyle(element).backgroundColor),
      lightBackground
    )
    await page.getByRole('button', { name: 'Failures', exact: true }).click()
    await expect(card).toContainText('图片加载失败')
    await expect(card).toContainText(failedName)
    await card.focus()
    await expect(page.getByRole('tooltip')).toHaveText(failedName)
    await expect(strip.getByRole('status')).toHaveCount(1)
    await expect(page.getByTestId('image-errors')).toHaveText('1')
    await card.click()
    await expect(page.getByTestId('selected')).toHaveText('0')
  })
})

test('failed draft images explain failure and expose names on focus without losing open or remove actions', async () => {
  await withFixture(async (page) => {
    await page.getByRole('button', { name: 'Failures', exact: true }).click()
    const draft = page.getByTestId('draft')
    const failed = draft.getByRole('button', {
      name: `查看图片 ${failedName}（1 / 4）`,
      exact: true,
    })
    await expect(failed).toContainText('图片加载失败')
    await expect(failed).toContainText(failedName)
    await expect(failed).toHaveAttribute('aria-description', '图片加载失败')
    await expect(failed).toHaveCSS('height', '44px')
    await expect(failed).toHaveCSS('width', '148px')
    assert.ok(
      await failed
        .locator('.truncate')
        .evaluate((element) => element.scrollWidth > element.clientWidth)
    )
    await failed.focus()
    await expect(page.getByRole('tooltip')).toHaveText(failedName)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('selected')).toHaveText('0')
    await draft.getByRole('button', { name: `移除图片 ${failedName}`, exact: true }).click()
    await expect(page.getByTestId('removed')).toHaveText('0')
    await expect(draft.getByRole('status')).toHaveCount(1)
    const normal = draft.getByRole('img', { name: 'Image 4', exact: true })
    await expect(normal).toBeVisible()
    assert.ok(await normal.evaluate((image: HTMLImageElement) => image.naturalWidth > 0))
    await expect(normal.locator('..')).toHaveCSS('width', '44px')
    await page.getByRole('button', { name: 'English', exact: true }).click()
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    await expect(
      draft.getByRole('button', { name: `View image ${failedName} (1 / 4)`, exact: true })
    ).toContainText('Unable to load image')
  })
})

test('ImageStrip preserves image activation, keyboard navigation and translated labels without changing drafts', async () => {
  await withFixture(async (page) => {
    const strip = page.getByTestId('strip-container')
    const image = strip.getByRole('button', { name: '查看图片 Image 1（1 / 10）', exact: true })
    await image.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('selected')).toHaveText('0')
    await expect(strip.getByRole('button', { name: '向右查看图片' })).toHaveCSS('opacity', '1')
    await page.getByRole('button', { name: 'English', exact: true }).click()
    await expect(
      strip.getByRole('button', { name: 'Scroll images right', exact: true })
    ).toHaveCount(1)
    const draft = page.getByTestId('draft')
    await expect(
      draft.getByRole('button', { name: 'View image Image 1 (1 / 10)', exact: true })
    ).toHaveCSS('width', '44px')
    await expect(draft.getByRole('button', { name: /images$/ })).toHaveCount(0)
    await expect(draft.locator('[data-slot="image-strip"]')).toHaveCount(0)
    await expect(draft.getByRole('button', { name: /Remove/ })).toHaveCount(10)
  })
})
