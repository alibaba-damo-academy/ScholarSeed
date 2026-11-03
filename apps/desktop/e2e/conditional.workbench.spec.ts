import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'

import { apiBase, DesktopSession, liveStatus, waitForFinishedTurn } from './fixtures/electron'
import { createRuntime, seedLiveConfig } from './fixtures/runtime'
import { openFile, seedProject } from './fixtures/workbench'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const SOURCE_NAME = 'poi-ConditionalFormattingSamples.xlsx'
const CORPUS_ROOT = process.env.SCHOLARSEED_OFFICE_CORPUS || join(__dirname, 'fixtures/office-corpus')
const READY_TIMEOUT_MS = 180_000
const TEST_TIMEOUT_MS = 600_000
const WHEEL_STEP = 220
const REVEAL_ATTEMPTS = 20
const VISUAL_TOLERANCE = 0.015
const NUMERIC_SELECTION = ['8078.4192', '5121.8592'] as const
const EXPLAIN_PROMPT = '请仅逐字复述当前选区的两个数值，不添加说明。'
const FOLLOWUP_PROMPT = '请读取已加入对话的 Mountains!G4:G5 选区，依原顺序复述两个数值。不要根据屏幕是否显示文字推断为空，也不要修改文件。'

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function worksheet(preview: Locator, name: string): Promise<Locator> {
  await preview.getByRole('tab', { name, exact: true }).click()
  const grid = preview.getByTestId('office-workbook-grid')
  await expect(grid).toHaveAttribute('aria-label', name)
  return grid
}

/** Real wheel events reveal cells removed by virtualization; no synthetic model dispatch. */
async function cell(page: Page, grid: Locator, address: string): Promise<Locator> {
  const target = grid.locator(`[data-cell="${address}"]`)
  const match = /^([A-Z]+)(\d+)$/.exec(address)!
  const column = Array.from(match[1]).reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0)
  const row = Number(match[2])
  for (let attempt = 0; attempt < REVEAL_ATTEMPTS; attempt++) {
    if (await target.count()) {
      await target.scrollIntoViewIfNeeded()
      await expect(target).toBeVisible()
      return target
    }
    const bounds = await grid.getByRole('gridcell').evaluateAll((nodes) => {
      const points = nodes.map((node) => ({
        column: Number(node.getAttribute('aria-colindex')),
        row: Number(node.parentElement?.getAttribute('aria-rowindex')),
      }))
      return { left: Math.min(...points.map((point) => point.column)), right: Math.max(...points.map((point) => point.column)), top: Math.min(...points.map((point) => point.row)), bottom: Math.max(...points.map((point) => point.row)) }
    })
    await grid.hover()
    await page.mouse.wheel(column < bounds.left ? -WHEEL_STEP : column > bounds.right ? WHEEL_STEP : 0, row < bounds.top ? -WHEEL_STEP : row > bounds.bottom ? WHEEL_STEP : 0)
  }
  await expect(target).toBeVisible()
  return target
}

async function icon(page: Page, grid: Locator, address: string, id: string): Promise<void> {
  const selected = await cell(page, grid, address)
  const glyph = selected.locator('[data-conditional-icon]')
  await expect(glyph).toHaveAttribute('data-conditional-icon', id)
  await expect(glyph).toBeVisible()
  await expect.poll(() => glyph.evaluate((node) => {
    const image = node as HTMLImageElement
    return image.complete && image.naturalWidth > 0
  })).toBe(true)
}

async function bar(page: Page, grid: Locator, address: string, expected: number, color: string, hidden = false): Promise<void> {
  const selected = await cell(page, grid, address)
  const decoration = selected.locator('[data-conditional-bar]')
  await expect(decoration).toBeVisible()
  expect(Number(await decoration.getAttribute('data-conditional-bar'))).toBeCloseTo(expected, 7)
  const measured = await decoration.evaluate((node) => {
    const parent = node.parentElement!
    return node.getBoundingClientRect().width / parent.clientWidth
  })
  expect(Math.abs(measured - expected)).toBeLessThan(VISUAL_TOLERANCE)
  await expect(decoration).toHaveCSS('background-color', color)
  expect(await selected.innerText()).toMatch(hidden ? /^\s*$/ : /\d/)
}

async function drag(page: Page, start: Locator, end: Locator): Promise<void> {
  const first = await start.boundingBox(); const last = await end.boundingBox()
  expect(first).toBeTruthy(); expect(last).toBeTruthy()
  await page.mouse.move(first!.x + first!.width / 2, first!.y + first!.height / 2)
  await page.mouse.down()
  await page.mouse.move(last!.x + last!.width / 2, last!.y + last!.height / 2, { steps: 10 })
  await page.mouse.up()
  await expect(start).toHaveAttribute('aria-selected', 'true')
  await expect(end).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('selection-action-host')).toBeVisible()
}

test('original ConditionalFormattingSamples visual rules preserve hidden numeric selections and real Agent continuation', async () => {
  const testInfo = test.info()
  skipQuarantined(testInfo)
  const source = join(CORPUS_ROOT, 'xlsx', SOURCE_NAME)
  test.skip(!existsSync(source), 'requires the original ConditionalFormattingSamples.xlsx corpus file')
  test.setTimeout(TEST_TIMEOUT_MS)
  const runtime = createRuntime(testInfo)
  const live = process.env.SCHOLARSEED_ONE_SHOT_E2E === '1'
  if (live) {
    const blocker = seedLiveConfig(runtime)
    if (blocker) throw new Error(blocker)
  }
  const desktop = new DesktopSession(runtime, testInfo, { nativeWindowLifecycle: true, recordTrace: false })
  try {
    const page = await desktop.launch()
    const window = await desktop.browserWindow(page)
    await desktop.app!.evaluate(({ app }) => app.focus({ steal: true }))
    await window.evaluate((native) => { native.show(); native.focus() })
    await expect.poll(() => window.evaluate((native) => native.isVisible() && native.isFocused() && !native.isMinimized())).toBe(true)
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible')
    const resources = await seedProject(page, runtime)
    const copy = join(resources, SOURCE_NAME)
    copyFileSync(source, copy)
    const originalHash = hash(source)
    await page.getByTestId('resource-refresh').click()
    await openFile(page, SOURCE_NAME)
    const preview = page.getByTestId('office-preview')
    await expect(preview).toHaveAttribute('data-office-title', SOURCE_NAME, { timeout: READY_TIMEOUT_MS })
    await expect(preview.getByRole('tab')).toHaveCount(18)
    await expect(preview.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('[data-testid="office-editor"][data-runtime-view]:not([data-runtime-view=""])')).toHaveCount(0)
    if (await page.getByTestId('ai-panel').isVisible()) await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
    await expect(preview.getByTestId('office-workbook-drawing')).toHaveCount(17)
    await expect(preview).toContainText('Conditionally Formatting')
    await page.screenshot({ path: join(runtime.artifacts, 'original-conditional-home.png') })

    // Expected cells, extrema and percentages were independently read from source XML.
    let grid = await worksheet(preview, 'Category sales')
    for (const [address, color] of [['C13', 'rgb(255, 239, 156)'], ['D5', 'rgb(255, 113, 40)'], ['G10', 'rgb(192, 0, 0)'], ['G11', 'rgb(0, 112, 192)']] as const) await expect(await cell(page, grid, address)).toHaveCSS('background-color', color)
    await page.screenshot({ path: join(runtime.artifacts, 'original-conditional-color-scales.png') })
    await grid.hover(); await page.mouse.wheel(0, WHEEL_STEP)
    await expect(await cell(page, grid, 'C13')).toHaveCSS('background-color', 'rgb(255, 239, 156)')

    grid = await worksheet(preview, 'Mountains')
    await bar(page, grid, 'D7', .1, 'rgb(99, 195, 132)')
    await bar(page, grid, 'D8', .9, 'rgb(99, 195, 132)')
    await bar(page, grid, 'E4', .7789375861862223, 'rgb(255, 255, 0)')
    await bar(page, grid, 'F7', .1, 'rgb(0, 176, 240)')
    await bar(page, grid, 'F8', .9, 'rgb(0, 176, 240)')
    await bar(page, grid, 'G4', .814598951698791, 'rgb(85, 142, 213)', true)
    await bar(page, grid, 'I4', .8304395755821966, 'rgb(192, 0, 0)', true)
    await page.screenshot({ path: join(runtime.artifacts, 'original-conditional-data-bars.png') })

    grid = await worksheet(preview, 'Quarters')
    for (const [address, id] of [['D4', '3Symbols2:0'], ['E4', '3Arrows:1'], ['G4', '3Symbols2:2'], ['H4', '3Arrows:2'], ['J4', '3Symbols2:2'], ['K4', '3Arrows:0'], ['M7', '3Symbols2:1'], ['N4', '3Arrows:0']] as const) {
      await icon(page, grid, address, id)
      expect(await (await cell(page, grid, address)).innerText()).toMatch(/^\s*$/)
    }
    await page.screenshot({ path: join(runtime.artifacts, 'original-conditional-quarter-icons.png') })

    grid = await worksheet(preview, 'Bike rating')
    for (const [address, id] of [['B2', '5Quarters:4'], ['C2', '5Quarters:3'], ['D2', '5Quarters:2'], ['E2', '5Quarters:1'], ['F2', '5Quarters:0']] as const) {
      await icon(page, grid, address, id)
      expect(await (await cell(page, grid, address)).innerText()).toMatch(/\d/)
    }
    await icon(page, grid, 'B4', '5Quarters:4')
    expect(await (await cell(page, grid, 'B4')).innerText()).toMatch(/^\s*$/)
    await page.screenshot({ path: join(runtime.artifacts, 'original-conditional-five-quarter-icons.png') })

    grid = await worksheet(preview, 'FY months')
    await icon(page, grid, 'C4', '3Arrows:2')
    await icon(page, grid, 'C6', '3Arrows:0')
    await expect(await cell(page, grid, 'C4')).toContainText('2000')
    await expect(await cell(page, grid, 'C6')).toContainText('-7500')
    await page.screenshot({ path: join(runtime.artifacts, 'original-conditional-negative-arrow.png') })

    for (const variant of [
      { name: 'Regional sales', lowCell: 'B7', lowValue: '899999', cutoffVisible: true, hidden: [] },
      { name: 'Regional sales2', lowCell: 'B7', lowValue: '899999', cutoffVisible: false, hidden: ['B4', 'B9'] },
      { name: 'Regional sales3', lowCell: 'B5', lowValue: '534389', cutoffVisible: true, hidden: ['B7'] },
    ]) {
      grid = await worksheet(preview, variant.name)
      await icon(page, grid, variant.lowCell, '3TrafficLights1:1')
      await expect(await cell(page, grid, variant.lowCell)).toContainText(variant.lowValue)
      if (variant.cutoffVisible) {
        await expect((await cell(page, grid, 'B9')).locator('[data-conditional-icon]')).toHaveCount(0)
        await expect(await cell(page, grid, 'B9')).toContainText('900000')
        await expect((await cell(page, grid, 'B4')).locator('[data-conditional-icon]')).toHaveCount(0)
      }
      // The two filter examples contain authored hidden rows; do not unhide them for a test.
      for (const address of variant.hidden) await expect(grid.locator(`[data-cell="${address}"]`)).toHaveCount(0)
      await page.screenshot({ path: join(runtime.artifacts, `original-conditional-${variant.name.replaceAll(' ', '-')}.png`) })
    }
    await worksheet(preview, 'Home')
    await expect(preview.getByTestId('office-workbook-drawing')).toHaveCount(17)

    grid = await worksheet(preview, 'Mountains')
    const first = await cell(page, grid, 'G4'); const second = await cell(page, grid, 'G5')
    expect(await first.innerText()).toMatch(/^\s*$/)
    expect(await second.innerText()).toMatch(/^\s*$/)
    await drag(page, first, second)
    const menu = page.getByTestId('selection-action-host')
    await menu.getByRole('button', { name: '添加到对话', exact: true }).click()
    const panel = page.getByTestId('ai-panel')
    await expect(panel.getByTestId('ai-context-ref').filter({ hasText: SOURCE_NAME })).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'original-conditional-hidden-selection.png') })

    if (live) {
      const modelKey = process.env.SCHOLARSEED_ACTION_MODEL
      if (!modelKey) throw new Error('SCHOLARSEED_ACTION_MODEL must name a configured model connection')
      const model = await page.request.post(`${await apiBase(page)}/api/serve/models/default`, { data: { model_key: modelKey, persist: true } })
      expect(model.status()).toBe(200)
      // Adding context opens the AI pane and narrows the real grid viewport.
      await cell(page, grid, 'G4')
      await cell(page, grid, 'G5')
      await drag(page, first, second)
      await menu.getByRole('button', { name: 'AI 解释', exact: true }).click()
      const explanation = page.getByTestId('resource-ai-suggestion')
      await explanation.getByRole('textbox').fill(EXPLAIN_PROMPT)
      const response = page.waitForResponse((item) => item.url().endsWith('/api/resource/ai/explain'), { timeout: READY_TIMEOUT_MS })
      await explanation.getByRole('button', { name: '提交AI 解释', exact: true }).click()
      await explanation.getByRole('button', { name: '固定浮窗', exact: true }).click()
      expect((await response).status()).toBe(200)
      await expect(explanation.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0, { timeout: READY_TIMEOUT_MS })
      await expect(explanation.getByRole('alert')).toHaveCount(0)
      for (const value of NUMERIC_SELECTION) await expect(explanation.getByTestId('resource-translation-result')).toContainText(value)
      await page.screenshot({ path: join(runtime.artifacts, 'original-conditional-hidden-agent-explain.png') })

      await expect.poll(async () => (await liveStatus(page))?.runtimeReady, { timeout: READY_TIMEOUT_MS }).toBe(true)
      const previousSequence = (await liveStatus(page))?.lastSeq ?? -1
      await panel.getByTestId('composer-input').fill(FOLLOWUP_PROMPT)
      await panel.getByTestId('composer-send').click()
      await waitForFinishedTurn(page, previousSequence)
      const answer = panel.locator('.answer-annotation-root').last()
      for (const value of NUMERIC_SELECTION) await expect(answer).toContainText(value)
      await expect(panel.getByTestId('ai-context-ref')).toHaveCount(0)
      await page.screenshot({ path: join(runtime.artifacts, 'original-conditional-hidden-agent-followup.png') })
    }
    expect(hash(copy)).toBe(originalHash)
    expect(hash(source)).toBe(originalHash)
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
