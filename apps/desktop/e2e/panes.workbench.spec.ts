import { DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { seedProject, openFile } from './fixtures/workbench'
import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'

const RATIOS = [0.2, 0.37, 0.65, 0.8]
const TOLERANCE_PX = 1

async function expectAligned(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      const headers = await page.getByTestId('navigation-split-divider').boundingBox()
      const dividers = await page.locator('.vds-dock-split.is-horizontal > .vds-dock-divider').all()
      if (!headers || !dividers.length) return Number.POSITIVE_INFINITY
      const differences = await Promise.all(
        dividers.map(async (divider) => {
          const bounds = await divider.boundingBox()
          return bounds
            ? Math.max(Math.abs(headers.x - bounds.x), Math.abs(headers.width - bounds.width))
            : Number.POSITIVE_INFINITY
        })
      )
      return Math.max(...differences)
    })
    .toBeLessThanOrEqual(TOLERANCE_PX)
}

test('document tabs stay with their pane through split resizing and workspace width changes', async ({
  playwright,
}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
  const page = await desktop.launch()
  await seedProject(page, runtime)
  await openFile(page, 'acceptance.md')
  const tabs = page.getByRole('tab', { name: 'acceptance.md', exact: true })
  await expect(tabs).toHaveCount(1)
  await tabs.first().click({ button: 'right' })
  await page.getByTestId('tab-split-right').click()
  await expect(tabs).toHaveCount(2)
  await expectAligned(page)

  for (const full of [false, true]) {
    if (full) await page.getByTestId('workspace-full').click()
    for (const width of [1600, 1280]) {
      await page.setViewportSize({ width, height: 1050 })
      for (const ratio of RATIOS) {
        const split = page.locator('.vds-dock-split.is-horizontal').first()
        const divider = split.locator(':scope > .vds-dock-divider')
        const host = await split.boundingBox()
        const handle = await divider.boundingBox()
        expect(host).not.toBeNull()
        expect(handle).not.toBeNull()
        const centerY = handle!.y + handle!.height / 2
        await page.mouse.move(handle!.x + handle!.width / 2, centerY)
        await page.mouse.down()
        await page.mouse.move(host!.x + host!.width * ratio, centerY, { steps: 8 })
        await expectAligned(page)
        await page.mouse.up()
        await expectAligned(page)
      }
      await page.screenshot({
        path: join(testInfo.outputDir, `aligned-${full ? 'full' : 'normal'}-${width}.png`),
      })
    }
  }

  await tabs.last().click({ button: 'right' })
  await page.getByTestId('tab-split-down').click()
  await expect(tabs).toHaveCount(3)
  await expectAligned(page)
  const horizontal = page.locator('.vds-dock-split.is-horizontal').first()
  const verticalDivider = page.locator('.vds-dock-split.is-vertical > .vds-dock-divider').first()
  const row = await verticalDivider.boundingBox()
  expect(row).not.toBeNull()
  await page.mouse.move(row!.x + row!.width / 2, row!.y + row!.height / 2)
  await page.mouse.down()
  await page.mouse.move(row!.x + row!.width / 2, row!.y + row!.height / 2 - 100, { steps: 8 })
  await page.mouse.up()
  const nestedTabs = page.locator('[data-dock-leaf]:visible > .vds-navigation-tabs__bar')
  await expect(nestedTabs).toHaveCount(1)
  const [tabBounds, paneBounds] = await Promise.all([
    nestedTabs.boundingBox(),
    nestedTabs.locator('..').boundingBox(),
  ])
  expect(Math.abs(tabBounds!.x - paneBounds!.x)).toBeLessThanOrEqual(TOLERANCE_PX)
  expect(Math.abs(tabBounds!.width - paneBounds!.width)).toBeLessThanOrEqual(TOLERANCE_PX)
  await expect(horizontal).toBeVisible()
  await expectAligned(page)
  await page.screenshot({ path: join(testInfo.outputDir, 'aligned-nested.png') })

  await tabs.first().click({ button: 'right' })
  await page.getByTestId('tab-split-down').click()
  await expect(tabs).toHaveCount(4)
  await expectAligned(page)
  await expect
    .poll(async () =>
      page.locator('[data-navigation-leaf]').evaluateAll((headers) => {
        return Math.max(
          ...headers.map((header) => {
            const pane = document.querySelector(
              `[data-dock-leaf="${header.getAttribute('data-navigation-leaf')}"]`
            )
            if (!pane) return Number.POSITIVE_INFINITY
            const navigation = header.getBoundingClientRect()
            const content = pane.getBoundingClientRect()
            return Math.max(
              Math.abs(navigation.x - content.x),
              Math.abs(navigation.width - content.width)
            )
          })
        )
      })
    )
    .toBeLessThanOrEqual(TOLERANCE_PX)
  await page.screenshot({ path: join(testInfo.outputDir, 'aligned-four-panes.png') })
  } finally {
    await desktop.attachArtifacts()
    await desktop.close()
  }
})
