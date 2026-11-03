import { expect, test, chromium, type Page } from '@playwright/test'
import assert from 'node:assert/strict'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const ENDPOINT = process.env.SCHOLARSEED_DELIVERY_CDP
const DIALOG = 'literature-delivery-dialog'
const CARD = 'literature-delivery-card'
const BODY = 'literature-delivery-body'
const FOOTER = 'literature-delivery-footer'
const PROJECT_FOLDER = 'delivery-project-folder'
const PROJECT_TREE = 'delivery-project-tree'
const ROOT_FOLDER = 'destination-node-'
const HELP = 'delivery-help'
const HELP_CONTENT = 'delivery-help-content'
const PAPER = 'delivery-paper'
const REUSED = 'delivery-reused'
const VISIBLE_OPACITY = '1'
const LIBRARY_SCOPE = /全局“文献中心”也会汇总显示|global literature overview also lists/
const NO_OVERWRITE = /相同 PDF 自动复用|Identical PDFs are reused/
const OPEN_LABEL = /选择保存位置|Choose save location/
const CANCEL_LABEL = /稍后保存|Save later/
const OPEN_DIRECTORY_LABEL = /打开文件夹|Open folder/
const VIEWPORTS = [
  { width: 1280, height: 840 },
  { width: 900, height: 600 },
] as const

test('saved delivery choices remain editable without changing saved records', async ({}, testInfo) => {
  test.skip(!ENDPOINT, 'Requires a real Desktop with an existing saved delivery')
  const browser = await chromium.connectOverCDP(ENDPOINT!)
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith('http://127.0.0.1:'))
  expect(page).toBeDefined()
  const dialog = page!.getByTestId(DIALOG)
  const wasOpen = await dialog.isVisible()
  const card = page!
    .getByTestId(CARD)
    .filter({ has: page!.getByRole('button', { name: OPEN_DIRECTORY_LABEL }) })
    .last()
  const original = await card.textContent()
  try {
    if (!wasOpen) await card.getByRole('button', { name: OPEN_LABEL }).click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId(PROJECT_FOLDER)).toBeEnabled()
    const checkbox = dialog.getByRole('checkbox')
    await expect(checkbox).toBeEnabled()
    const checked = await checkbox.isChecked()
    await checkbox.click()
    await expect(checkbox).toBeChecked({ checked: !checked })
    await checkbox.click()
    await expect(checkbox).toBeChecked({ checked })
    if (checked) await expect(dialog.getByRole('combobox')).toBeEnabled()
    expect(await card.textContent()).toBe(original)
    await page!.screenshot({ path: testInfo.outputPath('delivery-editable-choices.png') })
  } finally {
    if (!wasOpen) await page!.keyboard.press('Escape')
    await browser.close()
  }
})

test('real duplicate delivery shows reuse without overflowing', async ({}, testInfo) => {
  test.skip(!ENDPOINT, 'Requires a real Desktop delivery saved through duplicate handling')
  const browser = await chromium.connectOverCDP(ENDPOINT!)
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('http://127.0.0.1:'))
  expect(page).toBeDefined()
  const original = await page!.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  try {
    const card = page!.getByTestId(CARD).filter({ has: page!.getByTestId(REUSED) }).last()
    await expect(card.getByTestId(REUSED)).toContainText(/已存在，已跳过重复处理|Already exists; duplicate processing skipped/)
    for (const viewport of VIEWPORTS) {
      await page!.setViewportSize(viewport)
      await card.scrollIntoViewIfNeeded()
      const geometry = await card.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }))
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.client)
      await page!.screenshot({ path: testInfo.outputPath(`delivery-reused-${viewport.width}.png`) })
    }
  } finally {
    await page!.setViewportSize(original)
    await browser.close()
  }
})

async function assertInsideViewport(page: Page, testId: string): Promise<void> {
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  const bounds = await page.getByTestId(testId).boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
}

test('real saved delivery keeps literature titles within its conversation card', async ({}, testInfo) => {
  test.skip(!ENDPOINT, 'Requires an existing real Desktop with a saved delivery batch')
  const browser = await chromium.connectOverCDP(ENDPOINT!)
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith('http://127.0.0.1:'))
  expect(page).toBeDefined()
  const originalViewport = await page!.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  try {
    await expect(page!.getByTestId(DIALOG)).toHaveCount(0)
    const card = page!
      .getByTestId(CARD)
      .filter({ has: page!.getByRole('button', { name: OPEN_DIRECTORY_LABEL }) })
      .filter({ has: page!.locator('[data-slot="ellipsis-text"]') })
      .last()
    const before = await card.textContent()
    const titles = card
      .locator('button')
      .filter({ has: page!.locator('[data-slot="ellipsis-text"]') })
    expect(await titles.count()).toBeGreaterThan(0)
    for (const viewport of VIEWPORTS) {
      await page!.setViewportSize(viewport)
      await card.scrollIntoViewIfNeeded()
      await page!.screenshot({ path: testInfo.outputPath(`delivery-saved-${viewport.width}.png`) })
      const geometry = await card.evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
      }))
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.client)
      for (const title of await titles.all()) {
        const dimensions = await title.evaluate((element) => ({
          client: element.clientWidth,
          scroll: element.scrollWidth,
          left: element.getBoundingClientRect().left,
          right: element.getBoundingClientRect().right,
        }))
        const bounds = await card.boundingBox()
        expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client)
        expect(dimensions.left).toBeGreaterThanOrEqual(bounds!.x)
        expect(dimensions.right).toBeLessThanOrEqual(bounds!.x + bounds!.width)
        await expect(title.locator('[data-slot="ellipsis-text"]')).toHaveCSS(
          'text-overflow',
          'ellipsis'
        )
      }
      const first = titles.first().locator('[data-slot="ellipsis-text"]')
      const fullTitle = await first.textContent()
      await first.hover()
      const tooltip = page!.getByRole('tooltip').filter({ hasText: fullTitle! })
      await expect(tooltip).toBeVisible()
      await expect(tooltip).toHaveCSS('opacity', VISIBLE_OPACITY)
      await page!.screenshot({
        path: testInfo.outputPath(`delivery-saved-tooltip-${viewport.width}.png`),
      })
      await card.getByRole('heading').hover()
      await expect(tooltip).toHaveCount(0)
    }
    expect(await card.textContent()).toBe(before)
  } finally {
    await page!.setViewportSize(originalViewport)
    await browser.close()
  }
})

test('real acquired delivery opens only on demand and can reopen after cancellation', async ({}, testInfo) => {
  test.skip(!ENDPOINT, 'Requires an existing real Desktop with a newly acquired delivery batch')
  const browser = await chromium.connectOverCDP(ENDPOINT!)
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith('http://127.0.0.1:'))
  expect(page).toBeDefined()
  try {
    const card = page!.getByTestId(CARD).last()
    const dialog = page!.getByTestId(DIALOG)
    await expect(card).toBeVisible()
    await card.scrollIntoViewIfNeeded()
    await expect(dialog).toHaveCount(0)
    await page!.screenshot({ path: testInfo.outputPath('delivery-card-only.png') })
    await card.getByRole('button', { name: OPEN_LABEL }).click()
    await expect(dialog).toBeVisible()
    await page!.screenshot({ path: testInfo.outputPath('delivery-open-on-demand.png') })
    await dialog.getByRole('button', { name: CANCEL_LABEL }).click()
    await expect(dialog).toHaveCount(0)
    await expect(card).toBeVisible()
    await card.getByRole('button', { name: OPEN_LABEL }).click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: CANCEL_LABEL }).click()
    await expect(dialog).toHaveCount(0)
  } finally {
    await browser.close()
  }
})

test('real acquired delivery escapes the long conversation and keeps its actions visible', async ({}, testInfo) => {
  test.skip(!ENDPOINT, 'Requires an existing real Desktop with an acquired delivery batch')
  const browser = await chromium.connectOverCDP(ENDPOINT!)
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith('http://127.0.0.1:'))
  expect(page).toBeDefined()
  const originalViewport = await page!.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  try {
    const dialog = page!.getByTestId(DIALOG)
    if (!(await dialog.isVisible())) {
      await page!.getByTestId(CARD).last().getByRole('button', { name: OPEN_LABEL }).click()
    }
    await expect(dialog).toBeVisible()
    for (const viewport of VIEWPORTS) {
      await page!.setViewportSize(viewport)
      await assertInsideViewport(page!, DIALOG)
      expect(
        await dialog.evaluate(
          (element) => element.closest('[data-testid="conversation-content"]') === null
        )
      ).toBe(true)
      await expect(page!.getByTestId(FOOTER)).toBeVisible()
      await assertInsideViewport(page!, FOOTER)
      const bodyWidth = await page!.getByTestId(BODY).evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
      }))
      expect(bodyWidth.scroll).toBeLessThanOrEqual(bodyWidth.client)
      await page!.getByTestId(BODY).evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      await assertInsideViewport(page!, FOOTER)
      await page!.screenshot({ path: testInfo.outputPath(`delivery-${viewport.width}.png`) })
      await expect(dialog.getByTestId(PAPER)).toHaveCount(0)
      await expect(dialog.getByRole('list')).toHaveCount(0)
      await expect(dialog.getByRole('checkbox')).toBeVisible()
      await expect(page!.getByTestId(FOOTER).getByRole('button')).toHaveCount(2)
      await expect(page!.getByTestId(HELP_CONTENT)).toHaveCount(0)
      await page!.getByTestId(HELP).hover()
      const helpContent = page!.getByTestId(HELP_CONTENT)
      await expect(helpContent).toBeVisible()
      await expect(helpContent).toHaveCSS('opacity', VISIBLE_OPACITY)
      await expect(helpContent).toContainText(LIBRARY_SCOPE)
      await expect(helpContent).toContainText(NO_OVERWRITE)
      await assertInsideViewport(page!, HELP_CONTENT)
      await page!.screenshot({ path: testInfo.outputPath(`delivery-help-${viewport.width}.png`) })
      await page!.getByTestId(PROJECT_FOLDER).hover()
      await expect(helpContent).toHaveCount(0)
      await page!.getByTestId(HELP).focus()
      await expect(helpContent).toBeVisible()
      const helpId = await helpContent.getAttribute('id')
      assert.ok(helpId !== null)
      await expect(page!.getByTestId(HELP)).toHaveAttribute(
        'aria-describedby',
        helpId
      )
      await page!.keyboard.press('Tab')
      await expect(helpContent).toHaveCount(0)
      await expect(dialog).toBeVisible()
    }
    await page!.getByTestId(PROJECT_FOLDER).click()
    await expect(page!.getByTestId(PROJECT_TREE)).toBeVisible()
    await expect(page!.getByTestId(ROOT_FOLDER)).toHaveAttribute('aria-pressed', 'true')
    await expect(page!.getByTestId(ROOT_FOLDER)).toContainText(
      /资料库根目录（\/）|Resource root \(\/\)/
    )
    await page!.getByTestId(ROOT_FOLDER).click()
    await expect(page!.getByTestId(PROJECT_FOLDER)).toHaveText(/资料库 \/|Resources \//)
    await page!.getByTestId(PROJECT_FOLDER).click()
    await page!.screenshot({ path: testInfo.outputPath('delivery-folders.png') })
    await page!.keyboard.press('Escape')
    await expect(page!.getByTestId(PROJECT_TREE)).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await page!.keyboard.press('Tab')
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  } finally {
    await page!.setViewportSize(originalViewport)
    await browser.close()
  }
})
