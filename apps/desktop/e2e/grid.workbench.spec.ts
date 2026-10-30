import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'

import { WORKSPACE_WINDOW_MINIMUM } from '../src/window'
import { apiBase, DesktopSession, waitForFinishedTurn } from './fixtures/electron'
import { createRuntime, seedLiveConfig } from './fixtures/runtime'
import { openFile, seedProject } from './fixtures/workbench'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const CORPUS = process.env.SCHOLARSEED_OFFICE_CORPUS
const READY_TIMEOUT_MS = 180_000
const COLUMN_DELTA = 80
const ROW_DELTA = 24
const SHORTCUT = process.platform === 'darwin' ? 'Meta' : 'Control'
const SAVED_VALUE = 'CSV view resize saved'
const hash = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

async function drag(
  page: Page,
  handle: Locator,
  delta: number,
  axis: 'row' | 'column',
  cancel = false
): Promise<void> {
  const box = await handle.boundingBox()
  expect(box).not.toBeNull()
  const x = box!.x + box!.width / 2,
    y = box!.y + box!.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + (axis === 'column' ? delta : 0), y + (axis === 'row' ? delta : 0), {
    steps: 6,
  })
  await expect(page.getByTestId('grid-resize-guide')).toBeVisible()
  if (cancel) await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(page.getByTestId('grid-resize-guide')).toHaveCount(0)
}

async function range(page: Page, grid: Locator, first: string, last: string): Promise<void> {
  const a = await grid.locator(`[data-cell="${first}"]`).boundingBox()
  const b = await grid.locator(`[data-cell="${last}"]`).boundingBox()
  expect(a).not.toBeNull()
  expect(b).not.toBeNull()
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2)
  await page.mouse.down()
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect(page.getByTestId('selection-action-host')).toBeVisible()
}

for (const format of ['csv', 'xlsx'] as const)
  for (const theme of ['light', 'dark'] as const) {
    test(`original ${format} grid view resizing and XLS selection style in ${theme} Desktop`, async ({}, testInfo) => {
      test.skip(!CORPUS, 'requires original Office corpus')
      test.setTimeout(READY_TIMEOUT_MS * 3)
      const name =
        format === 'csv' ? 'sample-data-1000-rows.csv' : 'poi-ConditionalFormattingSamples.xlsx'
      const source = join(CORPUS!, format, name)
      expect(existsSync(source)).toBe(true)
      const before = hash(source)
      const runtime = createRuntime(testInfo)
      if (theme === 'light') {
        const blocker = seedLiveConfig(runtime)
        if (blocker) throw new Error(blocker)
      }
      const preferences = join(runtime.userData, 'renderer-preferences.json')
      writeFileSync(
        preferences,
        JSON.stringify({ ...JSON.parse(readFileSync(preferences, 'utf8')), theme })
      )
      const desktop = new DesktopSession(runtime, testInfo, {
        nativeWindowLifecycle: true,
        recordTrace: false,
      })
      try {
        const page = await desktop.launch()
        const native = await desktop.browserWindow(page)
        await desktop.app!.evaluate(({ app }) => app.focus({ steal: true }))
        await native.evaluate(
          (window, size) => {
            window.show()
            window.focus()
            window.setSize(size.width, size.height)
          },
          theme === 'dark' ? WORKSPACE_WINDOW_MINIMUM : { width: 1280, height: 840 }
        )
        await expect
          .poll(() =>
            native.evaluate((window) => ({
              focused: window.isFocused(),
              visible: window.isVisible(),
              minimized: window.isMinimized(),
            }))
          )
          .toEqual({ focused: true, visible: true, minimized: false })
        const resources = await seedProject(page, runtime)
        const saved = join(resources, name)
        copyFileSync(source, saved)
        await page.getByTestId('resource-refresh').click()
        await openFile(page, name)
        if (await page.getByTestId('ai-panel').isVisible())
          await page
            .getByTestId('ai-panel')
            .getByRole('button', { name: '关闭', exact: true })
            .click()
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        const document = page.getByTestId(format === 'csv' ? 'csv-document' : 'office-preview')
        await expect(document.getByRole('toolbar')).toHaveCount(0)
        await expect(document.getByRole('textbox', { name: '查找文档内容', exact: true })).toHaveCount(0)
        await expect(document.getByRole('button', { name: '放大', exact: true })).toHaveCount(0)
        if (format === 'xlsx') {
          await expect(document.getByTestId('office-workbook-drawing')).toHaveCount(17, {
            timeout: READY_TIMEOUT_MS,
          })
          await page.screenshot({ path: join(runtime.artifacts, 'xlsx-home-before.png') })
          const title = document
            .getByTestId('office-workbook-drawing')
            .filter({ hasText: 'Conditionally Formatting' })
          const box = await title.boundingBox()
          const navigation = document.getByRole('link', { name: 'Products1', exact: true })
          const navigationBox = await navigation.boundingBox()
          await drag(
            page,
            document.locator('[data-resize-axis="column"][data-resize-index="2"]'),
            COLUMN_DELTA,
            'column'
          )
          await expect
            .poll(async () => (await title.boundingBox())!.width)
            .toBeCloseTo(box!.width, 0)
          await expect
            .poll(async () => (await navigation.boundingBox())!.width)
            .toBeCloseTo(navigationBox!.width + COLUMN_DELTA, 0)
          await page.screenshot({ path: join(runtime.artifacts, 'xlsx-home-resized.png') })
          await document.getByRole('tab', { name: 'Products1', exact: true }).click()
        }
        const grid = document.getByTestId(format === 'csv' ? 'csv-grid' : 'office-workbook-grid')
        const first = grid.locator('[data-cell="A2"]')
        await expect(first).toBeVisible({ timeout: READY_TIMEOUT_MS })
        const initial = (await first.boundingBox())!
        await grid.locator('[data-resize-axis="column"][data-resize-index="1"]').focus()
        await page.keyboard.press('Space')
        await expect(page.getByTestId('csv-cell-editor')).toHaveCount(0)
        await drag(
          page,
          grid.locator('[data-resize-axis="column"][data-resize-index="1"]'),
          COLUMN_DELTA,
          'column'
        )
        await drag(
          page,
          grid.locator('[data-resize-axis="row"][data-resize-index="2"]'),
          ROW_DELTA,
          'row'
        )
        await expect
          .poll(async () => (await first.boundingBox())!.width)
          .toBeCloseTo(initial.width + COLUMN_DELTA, 0)
        await expect
          .poll(async () => (await first.boundingBox())!.height)
          .toBeCloseTo(initial.height + ROW_DELTA, 0)
        await drag(
          page,
          grid.locator('[data-resize-axis="column"][data-resize-index="1"]'),
          COLUMN_DELTA,
          'column',
          true
        )
        await expect
          .poll(async () => (await first.boundingBox())!.width)
          .toBeCloseTo(initial.width + COLUMN_DELTA, 0)
        await range(page, grid, 'A2', 'B3')
        await expect(grid.getByTestId('grid-selection-outline')).toHaveCount(1)
        await expect(grid.getByTestId('grid-active-cell')).toHaveCount(1)
        await expect(grid.locator('[role="columnheader"][data-highlighted="true"]')).toHaveCount(2)
        await expect(grid.locator('[role="rowheader"][data-highlighted="true"]')).toHaveCount(2)
        await expect(grid.getByTestId('grid-selection-outline')).toHaveCSS(
          'border-top-color',
          theme === 'light' ? 'rgb(51, 153, 204)' : 'rgb(97, 181, 224)'
        )
        await expect(page.getByTestId('selection-action-host')).toContainText('A2:B3')
        await expect(grid.getByRole('columnheader', { name: 'A', exact: true })).toBeVisible()
        await expect(grid.getByRole('rowheader', { name: '2', exact: true })).toBeVisible()
        await drag(page, grid.locator('[data-resize-axis="column"][data-resize-index="1"]'), COLUMN_DELTA, 'column', true)
        await expect(page.getByTestId('selection-action-host')).toBeVisible()
        await expect(page.getByTestId('selection-action-host')).toContainText('A2:B3')
        expect(hash(saved)).toBe(before)
        await page.screenshot({
          path: join(runtime.artifacts, `${format}-${theme}-resized-selection.png`),
        })
        if (format === 'xlsx') {
          await document.getByRole('tab', { name: 'Home', exact: true }).click()
          const home = document.getByTestId('office-workbook-grid')
          await expect(home.locator('[data-cell="B8"]')).toBeVisible()
          const resizedB = (await home.locator('[data-cell="B8"]').boundingBox())!.width
          await expect(
            home.locator('[data-resize-axis="column"][data-resize-index="2"]')
          ).toHaveAttribute('aria-valuenow', String(Math.round(resizedB)))
          await document.getByRole('tab', { name: 'Products1', exact: true }).click()
          await expect
            .poll(async () => (await first.boundingBox())!.width)
            .toBeCloseTo(initial.width + COLUMN_DELTA, 0)
        } else {
          await expect(
            document.getByRole('tab', { name: 'sample-data-1000-rows', exact: true })
          ).toBeVisible()
          await expect(page.getByTestId('document-save')).toBeDisabled()
          await first.dblclick()
          const editor = page.getByTestId('csv-cell-editor')
          const editorBox = (await editor.boundingBox())!
          const cellBox = (await first.boundingBox())!
          expect(editorBox.x).toBeCloseTo(cellBox.x, 0)
          expect(editorBox.width).toBeCloseTo(cellBox.width, 0)
          await editor.fill(SAVED_VALUE)
          await editor.press('Enter')
          await expect(first).toHaveText(SAVED_VALUE)
          await grid.focus()
          await page.keyboard.press(`${SHORTCUT}+z`)
          await expect(first).not.toHaveText(SAVED_VALUE)
          await page.keyboard.press(`${SHORTCUT}+Shift+z`)
          await expect(first).toHaveText(SAVED_VALUE)
          const persisted = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes('/api/workbench/content'), { timeout: READY_TIMEOUT_MS })
          await page.getByTestId('document-save').click()
          expect((await persisted).status()).toBe(204)
          await expect.poll(() => hash(saved)).not.toBe(before)
          await expect(page.getByTestId('document-save')).toBeDisabled()
          await page
            .getByRole('tab', { name: new RegExp(name.replaceAll('.', '\\.')) })
            .click({ button: 'right' })
          await page.getByTestId('tab-close-all').click()
          await page.getByTestId(`tree-resources/${name}`).click()
          await expect(first).toHaveText(SAVED_VALUE, { timeout: READY_TIMEOUT_MS })
          await page.screenshot({
            path: join(runtime.artifacts, `csv-${theme}-saved-reopened.png`),
          })
        }
        if (theme === 'light') {
          const target = grid.locator(format === 'csv' ? '[data-cell="A2"]' : '[data-cell="B3"]')
          const selectedText = await target.innerText()
          await target.click()
          const menu = page.getByTestId('selection-action-host')
          await menu.getByRole('button', { name: '添加到对话', exact: true }).click()
          await expect(page.getByTestId('ai-context-ref').filter({ hasText: name })).toBeVisible()
          await target.click()
          const modelKey = process.env.SCHOLARSEED_ACTION_MODEL
          if (!modelKey)
            throw new Error('SCHOLARSEED_ACTION_MODEL must name a real configured model')
          expect(
            (
              await page.request.post(`${await apiBase(page)}/api/serve/models/default`, {
                data: { model_key: modelKey, persist: true },
              })
            ).status()
          ).toBe(200)
          await menu.getByRole('button', { name: 'AI 解释', exact: true }).click()
          const explanation = page.getByTestId('resource-ai-suggestion')
          await explanation.getByRole('textbox').fill('请仅逐字复述当前选区原文，不添加其他内容。')
          await explanation.getByRole('button', { name: '提交AI 解释', exact: true }).click()
          await explanation.getByRole('button', { name: '固定浮窗', exact: true }).click()
          await expect(
            explanation.getByRole('button', { name: '停止生成', exact: true })
          ).toHaveCount(0, { timeout: READY_TIMEOUT_MS })
          await expect(explanation.getByRole('alert')).toHaveCount(0)
          await expect(explanation.getByTestId('resource-translation-result')).toContainText(
            selectedText
          )
          await page.screenshot({ path: join(runtime.artifacts, `${format}-resized-agent.png`) })
          await explanation.getByRole('button', { name: /关闭/ }).click()
          await page
            .getByTestId('composer-input')
            .fill('只逐字回复已加入对话的选区原文，不加解释。')
          await page.getByTestId('composer-send').click()
          await waitForFinishedTurn(page)
          await expect(page.locator('.answer-annotation-root').last()).toContainText(selectedText, {
            timeout: READY_TIMEOUT_MS,
          })
        }
        expect(hash(source)).toBe(before)
        if (format === 'xlsx') expect(hash(saved)).toBe(before)
        desktop.assertNoPageErrors()
      } finally {
        await desktop.attachArtifacts()
      }
    })
  }
