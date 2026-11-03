import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import { WORKSPACE_WINDOW_SIZE } from '../src/window'
import { apiBase, DesktopSession, waitForFinishedTurn } from './fixtures/electron'
import { armOfficeOpen, measuredOfficeOpen } from './fixtures/fonts'
import { createRuntime, seedLiveConfig } from './fixtures/runtime'
import { openFile } from './fixtures/workbench'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const CORPUS = process.env.SCHOLARSEED_OFFICE_CORPUS
const READY_TIMEOUT_MS = 180_000
const PROJECT_NAME = 'Office background warmup acceptance'
const PROJECT_ROUTE = '/api/content/projects'
const OPERATION_ROUTE = '/api/content/operations/'
const FRAME_SELECTOR = 'iframe[data-testid="office-editor"]'
const LEGACY_FILES = [
  ['doc', 'sample-document-medium.doc'],
  ['ppt', 'poi-basic_test_ppt_file.ppt'],
  ['xls', 'sample-spreadsheet-100-rows.xls'],
] as const
const NATIVE_FILES = [
  ['csv', 'sample-data-10-rows.csv'],
  ['xlsx', 'sample-spreadsheet-100-rows.xlsx'],
  ['docx', 'sample-document-small.docx'],
  ['pptx', 'sample-presentation-3-slides.pptx'],
] as const
const SOURCE_FILES = [...LEGACY_FILES, ...NATIVE_FILES]
const digest = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

interface Diagnostic {
  hostId: string
  stage: string
  durationMs?: number
  [key: string]: unknown
}

function diagnostics(path: string): Diagnostic[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.includes('[office-runtime] {'))
    .map((line) => JSON.parse(line.slice(line.indexOf('{'))) as Diagnostic)
}

async function closeFiles(page: Page, name: string): Promise<void> {
  await page
    .getByRole('tab', { name: new RegExp(name.replaceAll('.', '\\.')) })
    .click({ button: 'right' })
  await page.getByTestId('tab-close-all').click()
}

test('background Office warmup precedes every file open and reuses one foreground Desktop host', async ({}, testInfo) => {
  test.skip(!CORPUS, 'requires the original Office corpus')
  test.skip(
    process.env.SCHOLARSEED_ONE_SHOT_E2E !== '1',
    'requires explicitly enabled real model acceptance'
  )
  test.setTimeout(READY_TIMEOUT_MS * 4)
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  if (blocker) throw new Error(blocker)
  const modelKey = process.env.SCHOLARSEED_ACTION_MODEL
  if (!modelKey) throw new Error('SCHOLARSEED_ACTION_MODEL must name a real configured model')
  const originals = SOURCE_FILES.map(([format, name]) => {
    const path = join(CORPUS!, format, name)
    expect(existsSync(path), path).toBe(true)
    return { format, name, path, sha256: digest(path) }
  })
  const desktop = new DesktopSession(runtime, testInfo, {
    nativeWindowLifecycle: true,
    recordTrace: false,
  })
  const timing: Record<string, unknown> = { originals, recordTrace: false }
  const rendererLog = join(runtime.artifacts, 'renderer.log')
  const startedAt = Date.now()
  try {
    const page = await desktop.launch()
    await expect(page.getByTestId('workbench-shell')).toBeVisible()
    timing.startupToWorkspaceMs = Date.now() - startedAt
    const native = await desktop.browserWindow(page)
    await desktop.app!.evaluate(({ app }) => app.focus({ steal: true }))
    await native.evaluate((window, size) => {
      window.show()
      window.setSize(size.width, size.height)
      window.focus()
    }, WORKSPACE_WINDOW_SIZE)
    const assertForeground = async (): Promise<void> => {
      await desktop.app!.evaluate(({ app }) => app.focus({ steal: true }))
      await native.evaluate((window) => {
        window.show()
        window.focus()
      })
      await expect
        .poll(() =>
          native.evaluate((window) => ({
            visible: window.isVisible(),
            focused: window.isFocused(),
            minimized: window.isMinimized(),
          }))
        )
        .toEqual({ visible: true, focused: true, minimized: false })
      expect(await page.evaluate(() => document.visibilityState)).toBe('visible')
    }
    await assertForeground()
    // Observe product-owned readiness without opening a document or sending bridge commands.
    const host = page.locator(FRAME_SELECTOR)
    await expect(host).toHaveCount(1, { timeout: READY_TIMEOUT_MS })
    await expect(host).toHaveAttribute('data-document-ready', 'false')
    await expect(host).toHaveAttribute('data-runtime-view', '')
    await expect(page.getByTestId('office-loading')).toHaveCount(0)
    await expect(page.getByTestId('office-switch-mask')).toHaveCount(0)
    await expect(host).toBeHidden()
    await page.screenshot({ path: join(runtime.artifacts, 'warmup-workspace-before-ready.png') })
    await expect(host).toHaveAttribute('data-runtime-ready', 'true', { timeout: READY_TIMEOUT_MS })
    await expect(host).toHaveAttribute('data-document-ready', 'false')
    timing.startupToRuntimeReadyMs = Date.now() - startedAt
    const slot = await host.getAttribute('data-runtime-slot')
    expect(slot).toBeTruthy()
    timing.hostId = slot
    await expect
      .poll(() => diagnostics(rendererLog).filter((item) => item.stage === 'runtime-ready').length)
      .toBe(1)
    const warmed = diagnostics(rendererLog)
    timing.warmupDurationMs = warmed.find((item) => item.stage === 'runtime-ready')!.durationMs
    expect(warmed.filter((item) => item.stage === 'font-read')).toHaveLength(1)
    expect(warmed.filter((item) => item.stage === 'document-ready')).toHaveLength(0)
    await page.screenshot({
      path: join(runtime.artifacts, 'warmup-workspace-ready-no-document.png'),
    })

    // seedProject reloads the page. Use the actual project creation UI without a reload,
    // so all measurements and host identities belong to this one app initialization.
    const base = await apiBase(page)
    await page.getByTestId('topbar-project').click()
    await page.getByTestId('project-menu-create').click()
    const dialog = page.getByTestId('project-new-modal')
    await dialog.getByRole('textbox').fill(PROJECT_NAME)
    const submitted = page.waitForResponse(
      (response) =>
        response.url() === `${base}${PROJECT_ROUTE}` && response.request().method() === 'POST'
    )
    const completed = page.waitForResponse(
      async (response) =>
        response.url().startsWith(`${base}${OPERATION_ROUTE}`) &&
        response.status() === 200 &&
        (await response.json()).state === 'succeeded',
      { timeout: READY_TIMEOUT_MS }
    )
    await dialog.getByTestId('project-create').click()
    const accepted = await submitted
    expect(accepted.status()).toBe(202)
    const operation = (await accepted.json()).operation
    const result = await (await completed).json()
    expect(result.operation).toBe(operation)
    expect(result.result.name).toBe(PROJECT_NAME)
    await expect(dialog).toHaveCount(0)
    const resources = join(result.result.root, 'resources')
    mkdirSync(resources, { recursive: true })
    for (const file of originals) copyFileSync(file.path, join(resources, file.name))
    await page.getByTestId('activity-resource').click()
    await page.getByTestId('resource-refresh').click()
    if (await page.getByTestId('ai-panel').isVisible())
      await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()

    for (const [format, name] of NATIVE_FILES) {
      await openFile(page, name)
      const document = page.getByTestId(format === 'csv' ? 'csv-document' : 'office-preview')
      await expect(document).toBeVisible()
      if (format === 'csv')
        await expect(document.getByTestId('csv-grid').locator('[data-cell="A1"]')).toBeVisible()
      else {
        await expect(document).toHaveAttribute('data-office-title', name)
        if (format === 'xlsx')
          await expect(
            document.getByTestId('office-workbook-grid').locator('[data-cell="A1"]')
          ).toBeVisible({ timeout: READY_TIMEOUT_MS })
        else
          await expect(
            document
              .locator(
                format === 'docx' ? '.scholarseed-paragraph-1 span' : '[data-preview-shape] span'
              )
              .first()
          ).toBeVisible({ timeout: READY_TIMEOUT_MS })
        await expect(document.getByRole('alert')).toHaveCount(0)
      }
      await expect(host).toHaveCount(1)
      await expect(host).toHaveAttribute('data-runtime-slot', slot!)
      await expect(host).toHaveAttribute('data-document-ready', 'false')
      await expect(host).toHaveAttribute('data-runtime-view', '')
      await expect(host).toBeHidden()
      await expect(page.getByTestId('office-loading')).toHaveCount(0)
      await page.screenshot({ path: join(runtime.artifacts, `warmup-native-${format}.png`) })
      await closeFiles(page, name)
    }
    expect(diagnostics(rendererLog).filter((item) => item.stage === 'document-ready')).toHaveLength(
      0
    )
    const firstOpenMs: Record<string, number> = {}
    for (const [format, name] of LEGACY_FILES) {
      await assertForeground()
      await armOfficeOpen(page, name)
      await openFile(page, name)
      await expect(host).toHaveAttribute('title', name)
      await expect(host).toHaveAttribute('data-document-ready', 'true', {
        timeout: READY_TIMEOUT_MS,
      })
      firstOpenMs[format] = await measuredOfficeOpen(page)
      await expect(host).toHaveAttribute('data-runtime-slot', slot!)
      await expect(host).toHaveCount(1)
      await expect(host).toBeVisible()
      await page.screenshot({ path: join(runtime.artifacts, `warmup-first-${format}.png`) })
      if (format === 'xls') {
        const canvas = host.contentFrame().locator('#qtcanvas')
        // Real pointer selection in the first data rows of the original Orders sheet.
        await canvas.click({ position: { x: 90, y: 65 } })
        const menu = page.getByTestId('selection-action-host')
        await expect(menu).toBeVisible({ timeout: READY_TIMEOUT_MS })
        await menu.getByRole('button', { name: '添加到对话', exact: true }).click()
        const reference = page.getByTestId('ai-context-ref').filter({ hasText: name })
        await expect(reference).toBeVisible()
        await reference.hover()
        const quote = page.getByTestId('assistant-selection-quote')
        await expect(quote).toBeVisible()
        const text = await quote.innerText()
        const selectedId = text.match(/PB-\d+/)?.[0]
        expect(selectedId, 'original Orders selection contains a source order ID').toBeTruthy()
        await canvas.click({ position: { x: 90, y: 65 } })
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
          selectedId!
        )
        await page.screenshot({ path: join(runtime.artifacts, 'warmup-xls-real-explain.png') })
        await explanation.getByRole('button', { name: /关闭/ }).click()
        await page.getByTestId('composer-input').fill('只逐字回复已加入对话的选区原文，不加解释。')
        await page.getByTestId('composer-send').click()
        await waitForFinishedTurn(page)
        await expect(page.locator('.answer-annotation-root').last()).toContainText(selectedId!, {
          timeout: READY_TIMEOUT_MS,
        })
        await page.screenshot({
          path: join(runtime.artifacts, 'warmup-xls-agent-continuation.png'),
        })
      }
      await closeFiles(page, name)
      await expect(host).toHaveCount(1)
      await expect(host).toHaveAttribute('data-runtime-slot', slot!)
      await expect(host).toHaveAttribute('data-runtime-ready', 'true')
      await expect(host).toBeHidden()
    }
    timing.firstOpenMs = firstOpenMs
    const finalDiagnostics = diagnostics(rendererLog)
    expect(finalDiagnostics.filter((item) => item.stage === 'runtime-ready')).toHaveLength(1)
    expect(finalDiagnostics.filter((item) => item.stage === 'font-read')).toHaveLength(1)
    expect(finalDiagnostics.filter((item) => item.stage === 'document-ready')).toHaveLength(
      LEGACY_FILES.length
    )
    expect(new Set(finalDiagnostics.map((item) => item.hostId))).toEqual(new Set([slot]))
    timing.diagnostics = finalDiagnostics
    for (const file of originals) {
      expect(digest(file.path)).toBe(file.sha256)
      expect(digest(join(resources, file.name))).toBe(file.sha256)
    }
    await assertForeground()
    await page.screenshot({ path: join(runtime.artifacts, 'warmup-host-retained-after-close.png') })
    desktop.assertNoPageErrors()
  } finally {
    writeFileSync(join(runtime.artifacts, 'warmup-timing.json'), JSON.stringify(timing, null, 2))
    await desktop.attachArtifacts()
  }
})
