import { DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { seedProject } from './fixtures/workbench'
import { expect, test } from '@playwright/test'
import { join } from 'node:path'

const ENDPOINT = process.env.SCHOLARSEED_PAGES_CDP
const RENDERER = process.env.SCHOLARSEED_PAGES_URL
const INTERACTION_TIMEOUT_MS = 10_000
const CASE_TIMEOUT_MS = 60_000

test('workbench navigation joins the header seam without a second border', async ({
  playwright,
}, testInfo) => {
  test.setTimeout(CASE_TIMEOUT_MS)
  test.skip(!ENDPOINT || !RENDERER, 'Requires an exact task-owned Desktop')
  const browser = await playwright.chromium.connectOverCDP(ENDPOINT!)
  const pages = browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((page) => page.url() === RENDERER)
  expect(pages).toHaveLength(1)
  const page = pages[0]
  page.setDefaultTimeout(INTERACTION_TIMEOUT_MS)
  const tabs = page
    .getByRole('tablist')
    .filter({ has: page.getByRole('tab', { selected: true }) })
    .first()
  const header = tabs.locator('xpath=ancestor::header[1]')
  await expect(header).toHaveCSS('border-bottom-width', '0px')
  const headerBounds = (await header.boundingBox())!
  const tabBounds = (await tabs.boundingBox())!
  expect(tabBounds.y + tabBounds.height).toBe(headerBounds.y + headerBounds.height)
  await page.screenshot({ path: join(testInfo.outputDir, 'workbench-header-seam.png') })
})

test('project pages and new tabs stay in their originating split pane', async ({
  playwright,
}, testInfo) => {
  test.setTimeout(CASE_TIMEOUT_MS)
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
  const page = await desktop.launch()
  await seedProject(page, runtime)
  page.setDefaultTimeout(INTERACTION_TIMEOUT_MS)
  await page.getByTestId('project-library').click()
  const leaves = page.locator('[data-dock-leaf]:visible')
  await expect(leaves).toHaveCount(1)
  const header = page.locator('[data-navigation-leaf]')
  await header.getByRole('tab', { selected: true }).click({ button: 'right' })
  await page.getByTestId('tab-split-right').click()
  await expect(leaves).toHaveCount(2)
  const rightId = await leaves.last().getAttribute('data-dock-leaf')
  const right = page.locator(`[data-dock-leaf="${rightId}"]`)
  const rightHeader = page.locator(`[data-navigation-leaf="${rightId}"]:visible`)
  await page.screenshot({ path: join(runtime.artifacts, 'before-right-new-tab.png') })
  await page.evaluate(() => [...document.querySelectorAll('[data-navigation-leaf]')].map(el => ({ id: el.getAttribute('data-navigation-leaf'), text: el.textContent, buttons: [...el.querySelectorAll('[data-testid]')].map(e => e.getAttribute('data-testid')) }))).then(value => console.log('Navigation panes', JSON.stringify(value)))
  await rightHeader.getByTestId('workspace-new-tab').click()
  await expect(right.getByTestId('project-new-tab')).toBeVisible()
  await right
    .getByTestId('project-new-tab')
    .getByRole('button', { name: '项目文件', exact: true })
    .click()
  await expect(right.locator('[data-testid="project-library-content"]:visible')).toBeVisible()
  await expect(
    leaves.first().locator('[data-testid="project-library-content"]:visible')
  ).toBeVisible()
  await page.screenshot({ path: join(testInfo.outputDir, 'pages-horizontal.png') })
  await rightHeader.getByRole('tab', { selected: true }).click({ button: 'right' })
  await page.getByTestId('tab-split-down').click()
  await expect(leaves).toHaveCount(3)
  const bottom = leaves.last()
  await bottom.getByTestId('workspace-new-tab').click()
  await expect(bottom.getByTestId('project-new-tab')).toBeVisible()
  await bottom
    .getByTestId('project-new-tab')
    .getByRole('button', { name: '项目资源管理器', exact: true })
    .click()
  await expect(bottom.getByTestId('project-new-tab')).toBeHidden()
  await expect(bottom.getByRole('tab', { selected: true })).toContainText('项目资源管理器')
  await expect(
    leaves.first().locator('[data-testid="project-library-content"]:visible')
  ).toBeVisible()
  await page.screenshot({ path: join(testInfo.outputDir, 'pages-nested.png') })
  await bottom.getByRole('tab', { selected: true }).click({ button: 'right' })
  await page.getByTestId('tab-close').click()
  await expect(leaves).toHaveCount(3)
  await expect(
    leaves.first().locator('[data-testid="project-library-content"]:visible')
  ).toBeVisible()
  } finally {
    await desktop.attachArtifacts()
    await desktop.close()
  }
})
