import { documentSurface, openProjectExplorer } from './fixtures/projects'
import { createHash } from 'crypto'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { performance } from 'node:perf_hooks'
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { ONBOARDING_GROUPS } from '../src/onboarding'

import { apiBase, DesktopSession, showProductWindow, waitForFinishedTurn } from './fixtures/electron'
import { createRuntime, seedLiveConfig } from './fixtures/runtime'
import { openFile, seedProject, selectProject } from './fixtures/workbench'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const OFFICE_READY_TIMEOUT_MS = 180_000
const PREVIEW_SELECTION_PREPARE_TIMEOUT_MS = 10_000
const OFFICE_PAINT_SETTLE_MS = 2_000
const ONE_SHOT_E2E_ENABLED = process.env.SCHOLARSEED_ONE_SHOT_E2E === '1'
const OFFICE_CORPUS_ROOT = process.env.SCHOLARSEED_OFFICE_CORPUS || join(__dirname, 'fixtures/office-corpus')
const OFFICE_REGRESSION_DOCUMENT = process.env.SCHOLARSEED_OFFICE_DOCUMENT
const OFFICE_RETRY_TEST_TIMEOUT_MS = 600_000
const OFFICE_RETRY_EXHAUSTION_TIMEOUT_MS = 240_000
const OFFICE_RETRY_PROGRESS_POLL_MS = 50
const OFFICE_IMMEDIATE_RETRY_TIMEOUT_MS = 5_000
const OFFICE_CANCELLED_RETRY_OBSERVATION_MS = 20_000
const OFFICE_NARROW_VIEWPORT = { width: 900, height: 720 }
const SELECTION_MENU_BUDGET_MS = 500
const LEGACY_DOC_SELECTION_MENU_TIMEOUT_MS = 1_000
const CALC_SELECTION_MENU_TIMEOUT_MS = 2_000
const DOC_CROSS_PAGE_SCROLL_DELTA = 1_900
const PPTX_PAGE_SCROLL_DELTA = 800
const DOC_CROSS_PAGE_SELECTION_X_RATIO = 0.5
const DOC_CROSS_PAGE_SELECTION_START_Y_RATIO = 0.18
const DOC_CROSS_PAGE_SELECTION_END_Y_RATIO = 0.58
const DOC_CROSS_PAGE_DRAG_HOLD_MS = 1_500
const SELECTION_AUTOSCROLL_OVERFLOW_PX = 48
const SELECTION_AUTOSCROLL_HOLD_MS = 2_500
const SELECTION_AUTOSCROLL_FRAME_SAMPLE_MS = 500
const SELECTION_AUTOSCROLL_FRAME_SAMPLES = 3
const AUTOSCROLL_DOCUMENT_PAGE_COUNT = 24
const WRITER_AUTOSCROLL_EDGE_OFFSET_PX = 1
const WRITER_AUTOSCROLL_SELECTION_X_RATIO = 0.15
const WRITER_AUTOSCROLL_REVERSE_Y_RATIO = 0.45
const WRITER_AUTOSCROLL_REVERSE_HOLD_MS = 1_800
const WRITER_AUTOSCROLL_REVERSE_SETTLE_MS = 1_800
const LEGACY_DOC_AUTOSCROLL_SELECTION_START_Y_RATIO = 0.35
const CALC_AUTOSCROLL_SELECTION_X_RATIO = 0.15
const CALC_XLSX_AUTOSCROLL_SELECTION_X_RATIO = 0.2
const CALC_AUTOSCROLL_SELECTION_START_Y_RATIO = 0.25
const REVEAL_MENU_LABEL = process.platform === 'darwin' ? '在访达中打开' : '在文件夹中打开'
const COMPATIBILITY_CASES = [
  { format: 'docx', name: 'poi-VariousPictures.docx', text: 'Sheet with various pictures', selector: '.scholarseed-paragraph-1 span' },
  { format: 'pptx', name: 'poi-ArtisticEffectSample.pptx', text: 'Text here', selector: '[data-preview-shape] span' },
  { format: 'pptx', name: 'poi-smartart-simple.pptx', text: 'This file contains a SmartArt diagram', selector: '[data-preview-shape] span' },
  { format: 'xlsx', name: 'poi-ConditionalFormattingSamples.xlsx', text: 'Dairy', selector: '[data-cell="B3"]' },
] as const

for (const item of COMPATIBILITY_CASES) {
  test(`original OOXML compatibility corpus renders ${item.format} ${item.name} with source selections and Agent actions`, async ({}, testInfo) => {
    const source = join(OFFICE_CORPUS_ROOT, item.format, item.name)
    test.skip(!existsSync(source), 'requires SCHOLARSEED_OFFICE_CORPUS with the original compatibility samples')
    test.setTimeout(OFFICE_READY_TIMEOUT_MS * 2)
    const runtime = createRuntime(testInfo)
    // Product storage must stay outside a checkout protected by the user's live Desktop.
    if (ONE_SHOT_E2E_ENABLED) {
      const blocker = seedLiveConfig(runtime)
      if (blocker) throw new Error(blocker)
    }
    const desktop = new DesktopSession(runtime, testInfo, { nativeWindowLifecycle: true, recordTrace: false })
    try {
      const page = await desktop.launch()
      const native = await desktop.browserWindow(page)
      await native.evaluate(window => { window.show(); window.focus() })
      await expect.poll(() => native.evaluate(window => ({ focused: window.isFocused(), visible: window.isVisible(), minimized: window.isMinimized() }))).toEqual({ focused: true, visible: true, minimized: false })
      const resources = await seedProject(page, runtime)
      copyFileSync(source, join(resources, item.name))
      const originalHash = sha256(source)
      await openProjectExplorer(page)
      await page.getByTestId('explorer-refresh').click()
      await openFile(page, item.name)
      const preview = documentSurface(page).getByTestId('office-preview')
      await expect(preview).toHaveAttribute('data-office-title', item.name, { timeout: OFFICE_READY_TIMEOUT_MS })
      await expect(preview.getByRole('toolbar')).toHaveCount(0)
      if (await page.getByTestId('ai-panel').isVisible()) await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
      await page.screenshot({ path: join(runtime.artifacts, `original-${item.format}-opened.png`) })
      await expect(preview.getByRole('alert')).toHaveCount(0)
      if (item.format === 'xlsx') {
        await expect(preview.getByRole('tab')).toHaveCount(18)
        // Authored DrawingML objects and styles are part of the original Home page.
        await expect(preview.getByTestId('office-workbook-drawing')).toHaveCount(17)
        await expect(preview).toContainText('Conditionally Formatting')
        const grid = preview.getByTestId('office-workbook-grid')
        await expect(grid.locator('[data-cell="B8"]')).toHaveCSS('background-color', 'rgb(75, 172, 198)')
        await expect(grid.locator('[data-cell="B8"]')).toHaveCSS('border-top-color', 'rgb(0, 0, 0)')
        await expect(grid.locator('[data-cell="A1"]')).toHaveCSS('border-right-style', 'none')
        const comparisonLabel = preview.locator('foreignObject span').filter({ hasText: /^Compare to totals$/ })
        await expect(comparisonLabel).toBeVisible()
        expect(await comparisonLabel.evaluate(element => element.getClientRects().length)).toBe(1)
        expect(await grid.locator('[data-cell="D21"]').evaluate(element => {
          const text = element.querySelector('span')!
          return text.getBoundingClientRect().height <= element.clientHeight
        })).toBe(true)
        await page.screenshot({ path: join(runtime.artifacts, 'original-xlsx-home.png') })
        await preview.getByRole('link', { name: 'Products1', exact: true }).click()
        await expect(preview.getByTestId('office-workbook-grid')).toHaveAttribute('aria-label', 'Products1')
        await preview.getByRole('link', { name: 'Home', exact: true }).click()
        await expect(preview.getByTestId('office-workbook-drawing')).toHaveCount(17)
        await preview.getByRole('tab', { name: 'Products1', exact: true }).click()
        await expect(preview.locator(item.selector)).toHaveText(item.text)
      } else {
        await expect(preview).toContainText(item.text)
        if (item.name === 'poi-smartart-simple.pptx') {
          const image = preview.locator('svg image').first()
          await expect(image).toBeAttached()
          const decoded = await image.evaluate(async element => {
            const loaded = new Image()
            loaded.src = element.getAttribute('href') || element.getAttributeNS('http://www.w3.org/1999/xlink', 'href')!
            await loaded.decode()
            return { width: loaded.naturalWidth, height: loaded.naturalHeight }
          })
          expect(decoded).toEqual({ width: 300, height: 200 })
          await page.screenshot({ path: join(runtime.artifacts, 'original-smartart-preview.png') })
        } else {
          await expect.poll(() => preview.locator('img').evaluateAll(images => images.map(image => ({ complete: (image as HTMLImageElement).complete, width: (image as HTMLImageElement).naturalWidth })).filter(image => !image.complete || !image.width).length)).toBe(0)
          expect(await preview.locator('img').count()).toBeGreaterThan(0)
        }
        if (item.format === 'docx') await expect(preview.locator('img')).toHaveCount(5)
        if (item.name === 'poi-ArtisticEffectSample.pptx') {
          await preview.getByTestId('office-preview-content').hover()
          await page.mouse.wheel(0, PPTX_PAGE_SCROLL_DELTA)
          await expect(preview).toContainText('Welcome Page')
          await expect.poll(() => preview.locator('img').evaluateAll(images => images.filter(image => !(image as HTMLImageElement).complete || !(image as HTMLImageElement).naturalWidth).length)).toBe(0)
          await page.screenshot({ path: join(runtime.artifacts, 'original-pptx-second-page.png') })
          await page.mouse.wheel(0, -PPTX_PAGE_SCROLL_DELTA)
          await expect(preview).toContainText(item.text)
        }
      }
      await expect(page.locator('[data-testid="office-editor"][data-runtime-view]:not([data-runtime-view=""])')).toHaveCount(0)
      await page.screenshot({ path: join(runtime.artifacts, `original-${item.format}-preview.png`) })
      const target = preview.locator(item.selector).filter({ hasText: item.text }).first()
      if (item.format === 'xlsx') await target.click()
      else await dragPreviewText(page, target)
      const menu = page.getByTestId('selection-action-host')
      await expect(menu).toBeVisible()
      await menu.getByRole('button', { name: '添加到任务', exact: true }).click()
      await expect(page.getByTestId('ai-context-ref').filter({ hasText: item.name })).toBeVisible()
      if (item.format === 'xlsx') await target.click()
      else await dragPreviewText(page, target)
      if (ONE_SHOT_E2E_ENABLED) {
        const modelKey = process.env.SCHOLARSEED_ACTION_MODEL
        if (!modelKey) throw new Error('SCHOLARSEED_ACTION_MODEL must name a configured model connection')
        const selected = await page.request.post(`${await apiBase(page)}/api/serve/models/default`, { data: { model_key: modelKey, persist: true } })
        expect(selected.status()).toBe(200)
        await menu.getByRole('button', { name: 'AI 解释', exact: true }).click()
        const explanation = page.getByTestId('resource-ai-suggestion')
        await explanation.getByRole('textbox').fill('请仅逐字复述当前选区原文，不添加其他内容。')
        const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/resource/ai/explain'), { timeout: OFFICE_READY_TIMEOUT_MS })
        await explanation.getByRole('button', { name: '提交AI 解释', exact: true }).click()
        await explanation.getByRole('button', { name: '固定浮窗', exact: true }).click()
        expect((await responsePromise).status()).toBe(200)
        await expect(explanation.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0, { timeout: OFFICE_READY_TIMEOUT_MS })
        await expect(explanation.getByRole('alert')).toHaveCount(0)
        await expect(explanation.getByTestId('resource-translation-result')).toContainText(item.text)
        await page.screenshot({ path: join(runtime.artifacts, `original-${item.format}-agent.png`) })
      }
      expect(sha256(join(resources, item.name))).toBe(originalHash)
      expect(sha256(source)).toBe(originalHash)
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
    }
  })
}
const OFFICE_FONT_RECORD_TRACE = process.env.SCHOLARSEED_OFFICE_RECORD_TRACE !== '0'
const OFFICE_FONT_BASELINE = process.env.SCHOLARSEED_OFFICE_FONT_BASELINE
// The checked-in legacy DOC requests this family on both hosts; availability/fallback is recorded.
const OFFICE_FONT_FAMILY = 'PingFang SC'
const OFFICE_BUNDLED_FONT_FAMILY = 'Noto Sans CJK SC'
const OFFICE_FONT_VIEWPORT = { width: 1280, height: 900 }
const OFFICE_FONT_REPAINT_TIMEOUT_MS = 10_000

interface OfficeDiagnostic {
  hostId: string
  tabId: string
  stage: string
  requiredFontCount?: number
  availableFontCount?: number
  selectedFontCount?: number
  loadedFontCount?: number
  unavailable?: number
  duplicateFontCount?: number
  readBytes?: number
  uniqueBytes?: number
  totalBytes?: number
  defaultFontCount?: number
  systemFontCount?: number
  editable?: boolean
  eventName?: string
  durationMs?: number
  totalDurationMs?: number
  quietDelayMs?: number
  extractionDurationMs?: number
  presentationDelayMs?: number
}

function archive(entries: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(entries).map(([name, source]) => [name, strToU8(source)])))
}

function documentArchive(): Uint8Array {
  const entries = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:rFonts w:ascii="Helvetica" w:hAnsi="Helvetica"/><w:sz w:val="24"/></w:rPr><w:t>Document-private Helvetica runtime</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>'
  }
  return archive(entries)
}

function multipageDocumentArchive(): Uint8Array {
  const entries = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t>First page selection evidence.</w:t></w:r><w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t>Second page selection evidence.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>'
  }
  return archive(entries)
}

function autoscrollDocumentArchive(): Uint8Array {
  const pages = Array.from({ length: AUTOSCROLL_DOCUMENT_PAGE_COUNT }, (_, index) => (
    `<w:p><w:r><w:t>Autoscroll page ${index + 1} evidence.</w:t>${index < AUTOSCROLL_DOCUMENT_PAGE_COUNT - 1 ? '<w:br w:type="page"/>' : ''}</w:r></w:p>`
  )).join('')
  return archive({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${pages}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`
  })
}

function bidirectionalAutoscrollDocumentArchive(): Uint8Array {
  const lines = Array.from({ length: 160 }, (_, index) => (
    `<w:p><w:r><w:t>Bidirectional line ${index + 1} evidence.</w:t></w:r></w:p>`
  )).join('')
  return archive({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`
  })
}

function spreadsheetArchive(): Uint8Array {
  return archive({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Results" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Readonly spreadsheet</t></is></c></row><row r="2"><c r="A2"><v>42</v></c></row></sheetData></worksheet>'
  })
}

function largeSpreadsheetArchive(): Uint8Array {
  const rows = Array.from({ length: 151 }, (_, index) => (
    `<row r="${index + 1}"><c r="B${index + 1}" t="inlineStr"><is><t>private-${index + 1}</t></is></c></row>`
  )).join('')
  return archive({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Results" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`
  })
}

function richSpreadsheetArchive(): Uint8Array {
  const entries = Object.fromEntries(Object.entries(unzipSync(spreadsheetArchive())).map(([name, bytes]) => [name, strFromU8(bytes)]))
  entries['[Content_Types].xml'] = entries['[Content_Types].xml'].replace('</Types>', '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
  entries['xl/workbook.xml'] = entries['xl/workbook.xml'].replace('</sheets>', '<sheet name="Second" sheetId="2" r:id="rId2"/></sheets>')
  entries['xl/_rels/workbook.xml.rels'] = entries['xl/_rels/workbook.xml.rels'].replace('</Relationships>', '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>')
  const rows = Array.from({ length: 151 }, (_, index) => `<row r="${index + 1}"><c r="A${index + 1}" t="inlineStr"><is><t>rich-${index + 1}</t></is></c>${index === 1 ? '<c r="B2" t="inlineStr"><is><t>Merged evidence</t></is></c><c r="C2"/><c r="D2" t="inlineStr"><is><t>Right neighbor</t></is></c>' : ''}</row>`).join('')
  entries['xl/worksheets/sheet1.xml'] = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData><mergeCells count="1"><mergeCell ref="B2:C2"/></mergeCells></worksheet>`
  entries['xl/worksheets/sheet2.xml'] = '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Second sheet evidence</t></is></c></row></sheetData></worksheet>'
  return archive(entries)
}

function presentationArchive(): Uint8Array {
  return archive({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    'ppt/presentation.xml': '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm/></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Readonly title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="10058400" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Presentation page 1</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
    'ppt/slides/slide2.xml': '<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm/></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Readonly title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="10058400" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Presentation page 2</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  })
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function dragPreviewText(page: Page, start: Locator, end: Locator = start, word?: string): Promise<number> {
  const endpoint = async (target: Locator, last: boolean) => {
    let point: { x: number; y: number } | undefined
    // Windowed slide rendering can replace a node while scrolling it into view.
    // Resolve the locator again until preparation succeeds, before moving the pointer.
    await expect(async () => {
      await target.scrollIntoViewIfNeeded()
      point = await target.evaluate((element, { last, word }) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        const nodes: Text[] = []
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.textContent?.trim()) nodes.push(node as Text)
        }
        const node = last ? nodes.at(-1) : nodes[0]
        if (!node) throw new Error('Preview text is missing')
        const range = document.createRange()
        const wordStart = word ? node.textContent!.indexOf(word) : 0
        if (wordStart < 0) throw new Error('Requested selection word is missing')
        const offset = word ? wordStart + (last ? word.length - 1 : 0) : last ? node.length - 1 : 0
        range.setStart(node, offset); range.setEnd(node, offset + 1)
        const rect = range.getBoundingClientRect()
        return { x: last ? rect.right - 1 : rect.left + 1, y: rect.top + rect.height / 2 }
      }, { last, word })
    }).toPass({ timeout: PREVIEW_SELECTION_PREPARE_TIMEOUT_MS })
    if (!point) throw new Error('Preview selection endpoint is missing')
    return point
  }
  const startPoint = await endpoint(start, false)
  await page.mouse.move(startPoint.x, startPoint.y)
  await page.mouse.down()
  const endPoint = await endpoint(end, true)
  await page.mouse.move(endPoint.x, endPoint.y, { steps: 24 })
  const releasedAt = Date.now()
  await page.mouse.up()
  return releasedAt
}

async function nativePreview(page: Page, format: string, title?: string): Promise<Locator> {
  const preview = documentSurface(page).getByTestId('office-preview')
  if (title) await expect(preview).toHaveAttribute('data-office-title', title)
  await expect(preview).toHaveAttribute('data-office-format', format)
  await expect(preview.getByRole('alert')).toHaveCount(0)
  if (format === 'xlsx') await expect(preview.getByTestId('office-workbook-grid')).toBeVisible()
  else await expect(preview.locator(format === 'docx' ? '.scholarseed-paragraph-1' : '[data-preview-shape]')).not.toHaveCount(0)
  return preview
}

async function changeDesktopLanguage(desktop: DesktopSession, page: Page, language: string, testInfo: TestInfo): Promise<void> {
  await desktop.app!.evaluate(({ app, BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('menu.html'))
    main?.show(); main?.focus(); app.focus({ steal: true })
  })
  await page.bringToFront()
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
  const qualify = async () => ({
    renderer: await page.evaluate(async () => ({ focus: document.hasFocus(), presentation: await window.scholarseed.menu?.presentation(), trigger: document.querySelector('[data-testid="activity-account"]')?.getAttribute('aria-expanded'), status: Array.from(document.querySelectorAll('[role="status"]')).map(element => element.textContent) })),
    native: await desktop.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), minimized: window.isMinimized(), contentsFocused: window.webContents.isFocused() }))),
    pages: desktop.app!.context().pages().map(window => window.url())
  })
  await testInfo.attach(`language-before-${language}`, { body: JSON.stringify(await qualify(), null, 2), contentType: 'application/json' })
  const trigger = page.getByTestId('activity-account')
  await trigger.click()
  await testInfo.attach(`language-after-${language}`, { body: JSON.stringify(await qualify(), null, 2), contentType: 'application/json' })
  let menuPage: Page | undefined
  await expect.poll(async () => {
    for (const window of desktop.app!.context().pages()) {
      if (await window.getByTestId('account-menu-language').isVisible().catch(() => false)) {
        menuPage = window
        return true
      }
    }
    return false
  }).toBe(true)
  await menuPage!.getByTestId('account-menu-language').click()
  await menuPage!.getByRole('menuitemradio', { name: language, exact: true }).click()
}

async function attachSelectionDiagnostics(testInfo: TestInfo, target: Locator, filename: string): Promise<void> {
  const state = await target.evaluate(element => {
    const selection = element.ownerDocument.defaultView?.getSelection()
    const describeNode = (node: Node | null | undefined) => node ? {
      text: node.textContent?.slice(0, 2_000),
      parent: node.parentElement?.outerHTML.slice(0, 2_000)
    } : null
    return {
      selection: selection ? {
        text: selection.toString(), collapsed: selection.isCollapsed,
        anchor: describeNode(selection.anchorNode), anchorOffset: selection.anchorOffset,
        focus: describeNode(selection.focusNode), focusOffset: selection.focusOffset,
        rect: selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect().toJSON() : null
      } : null,
      viewport: { bounds: element.getBoundingClientRect().toJSON(), scrollTop: element.scrollTop, scrollLeft: element.scrollLeft, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight },
      active: element.ownerDocument.activeElement?.outerHTML.slice(0, 2_000),
      selectedCells: Array.from(element.querySelectorAll('[data-cell][aria-selected="true"]')).map(cell => ({ address: cell.getAttribute('data-cell'), text: cell.textContent })),
      menuVisible: Boolean(element.ownerDocument.querySelector('[data-testid="selection-action-host"]'))
    }
  })
  await testInfo.attach(`mouseup-selection-${filename}`, { body: JSON.stringify(state, null, 2), contentType: 'application/json' })
}

test('OOXML previews retain real source selections and conversation actions without WASM', async ({}, testInfo) => {
  test.setTimeout(OFFICE_READY_TIMEOUT_MS * 2)
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  const files = [
    { name: 'native.docx', bytes: documentArchive(), text: 'Document-private Helvetica runtime', selector: '.scholarseed-paragraph-1 span' },
    { name: 'native.pptx', bytes: presentationArchive(), text: 'Presentation page 1', selector: '[data-preview-shape] span' },
    { name: 'native.xlsx', bytes: spreadsheetArchive(), text: 'Readonly spreadsheet', selector: '[data-cell="A1"]' }
  ]
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    for (const file of files) writeFileSync(join(resources, file.name), file.bytes)
    await openProjectExplorer(page)
      await page.getByTestId('explorer-refresh').click()
    for (const file of files) {
      const before = sha256(join(resources, file.name))
      await openFile(page, file.name)
      const preview = documentSurface(page).getByTestId('office-preview')
      await expect(preview).toContainText(file.text)
      await expect(page.locator('[data-testid="office-editor"][data-runtime-view]:not([data-runtime-view=""])')).toHaveCount(0)
      const target = preview.locator(file.selector).filter({ hasText: file.text }).first()
      if (file.name.endsWith('.xlsx')) await target.click()
      else await dragPreviewText(page, target)
      await page.screenshot({ path: join(runtime.artifacts, `native-click-${file.name}.png`) })
      const menu = page.getByTestId('selection-action-host')
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('button', { name: 'AI 润色', exact: true })).toHaveCount(0)
      await page.screenshot({ path: join(runtime.artifacts, `native-selection-${file.name}.png`) })
      await menu.getByRole('button', { name: '添加到任务', exact: true }).click()
      await expect(page.getByTestId('ai-context-ref').filter({ hasText: file.name })).toBeVisible()
      await expect(preview.getByRole('toolbar')).toHaveCount(0)
      expect(sha256(join(resources, file.name))).toBe(before)
    }
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('OOXML page layout and merged workbook selections preserve source bytes', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  const workbookName = 'rich-preview.xlsx'
  const documentName = 'paged-preview.docx'
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    writeFileSync(join(resources, documentName), multipageDocumentArchive())
    writeFileSync(join(resources, workbookName), richSpreadsheetArchive())
    const hashes = [documentName, workbookName].map(name => sha256(join(resources, name)))
    await openProjectExplorer(page)
      await page.getByTestId('explorer-refresh').click()
    await openFile(page, documentName)
    const document = await nativePreview(page, 'docx')
    const pages = document.locator('section[class^="scholarseed-docx-"]')
    await expect(pages).toHaveCount(2)
    const pageBounds = await pages.first().boundingBox()
    expect(pageBounds!.width).toBeGreaterThan(700)
    expect(pageBounds!.height).toBeGreaterThan(1_000)
    await page.screenshot({ path: join(runtime.artifacts, 'ooxml-a4-document-layout.png') })

    await openFile(page, workbookName)
    const workbook = await nativePreview(page, 'xlsx')
    const grid = workbook.getByTestId('office-workbook-grid')
    await grid.locator('[data-cell="B2"]').click()
    await expect(grid.locator('[data-cell="B2"]')).toHaveAttribute('aria-selected', 'true')
    const menu = page.getByTestId('selection-action-host')
    await expect(menu).toContainText('B2:C2')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await expect(menu).toContainText('B2:D2')
    await page.keyboard.press('Shift+ArrowLeft')
    await expect(menu).toContainText('B2:C2')
    await expect(grid.locator('[data-cell="D2"]')).toHaveAttribute('aria-selected', 'false')
    await page.screenshot({ path: join(runtime.artifacts, 'ooxml-merged-selection-retract.png') })
    await grid.getByRole('columnheader', { name: 'A', exact: true }).click()
    await expect(menu).toContainText('A1:A151')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C')
    await expect.poll(() => desktop.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      Array.from({ length: 151 }, (_, index) => `rich-${index + 1}`).join('\n')
    )
    await workbook.getByRole('tab', { name: 'Second', exact: true }).click()
    await expect(grid).toHaveAttribute('aria-label', 'Second')
    await expect(menu).toBeHidden()
    await grid.locator('[data-cell="A1"]').click()
    await expect(menu).toContainText('Second · A1:A1')
    await menu.getByRole('button', { name: '添加到任务', exact: true }).click()
    await page.getByTestId('ai-context-ref').filter({ hasText: workbookName }).hover()
    await expect(page.getByTestId('assistant-selection-quote')).toContainText('Second sheet evidence')
    await page.screenshot({ path: join(runtime.artifacts, 'ooxml-second-sheet-selection.png') })
    expect([documentName, workbookName].map(name => sha256(join(resources, name)))).toEqual(hashes)
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('DOCX selection autoscroll starts from the bottom line inside the workspace', async ({}, testInfo) => {
  test.setTimeout(OFFICE_READY_TIMEOUT_MS)
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    const filename = 'selection-autoscroll.docx'
    writeFileSync(join(resources, filename), autoscrollDocumentArchive())
    await openProjectExplorer(page)
      await page.getByTestId('explorer-refresh').click()
    await openFile(page, filename)
    const preview = await nativePreview(page, 'docx')
    const canvas = preview.getByTestId('office-preview-content')
    const bounds = await canvas.boundingBox()
    if (!bounds) throw new Error('DOCX canvas bounds unavailable')
    const firstLine = await preview.locator('.scholarseed-paragraph-1 span').first().boundingBox()
    if (!firstLine) throw new Error('DOCX first source line unavailable')
    const x = firstLine.x + 1
    await page.mouse.move(x, firstLine.y + firstLine.height / 2)
    await page.mouse.down()
    await page.mouse.move(x, bounds.y + bounds.height - WRITER_AUTOSCROLL_EDGE_OFFSET_PX, { steps: 24 })
    const frameHashes: string[] = []
    for (let index = 0; index < SELECTION_AUTOSCROLL_FRAME_SAMPLES; index += 1) {
      await page.waitForTimeout(SELECTION_AUTOSCROLL_FRAME_SAMPLE_MS)
      const screenshot = await page.screenshot({
        path: join(runtime.artifacts, `office-docx-selection-autoscroll-frame-${index + 1}.png`)
      })
      frameHashes.push(createHash('sha256').update(screenshot).digest('hex'))
    }
    expect(new Set(frameHashes).size).toBe(SELECTION_AUTOSCROLL_FRAME_SAMPLES)
    await page.waitForTimeout(
      SELECTION_AUTOSCROLL_HOLD_MS
        - SELECTION_AUTOSCROLL_FRAME_SAMPLE_MS * SELECTION_AUTOSCROLL_FRAME_SAMPLES
    )
    await expect(page.getByTestId('selection-action-host')).toBeHidden()
    await page.mouse.up()

    const menu = page.getByTestId('selection-action-host')
    await expect(menu).toBeVisible({ timeout: SELECTION_MENU_BUDGET_MS })
    await menu.getByRole('button', { name: '添加到任务', exact: true }).click()
    await page.getByTestId('ai-context-ref').filter({ hasText: filename }).hover()
    const quote = page.getByTestId('assistant-selection-quote')
    await expect(quote).toContainText('Autoscroll page 1 evidence.')
    await expect(quote).toContainText('Autoscroll page 2 evidence.')
    await page.screenshot({ path: join(runtime.artifacts, 'office-docx-selection-autoscroll.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('DOCX selection autoscroll retracts when the pointer moves upward', async ({}, testInfo) => {
  test.setTimeout(OFFICE_READY_TIMEOUT_MS * 2)
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  const files = [
    { filename: 'selection-autoscroll-down.docx', reverse: false },
    { filename: 'selection-autoscroll-reverse.docx', reverse: true }
  ] as const
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    for (const file of files) writeFileSync(join(resources, file.filename), bidirectionalAutoscrollDocumentArchive())
    await openProjectExplorer(page)
      await page.getByTestId('explorer-refresh').click()
    const selectedLastLines: number[] = []
    for (const file of files) {
      await openFile(page, file.filename)
      const preview = await nativePreview(page, 'docx', file.filename)
      const canvas = preview.getByTestId('office-preview-content')
      const bounds = await canvas.boundingBox()
      if (!bounds) throw new Error(`${file.filename} canvas bounds unavailable`)
      const firstLine = await preview.locator('.scholarseed-paragraph-1 span').first().boundingBox()
      if (!firstLine) throw new Error('DOCX first source line unavailable')
      await testInfo.attach(`before-drag-${file.filename}`, {
        body: JSON.stringify({ canvasBounds: bounds, firstLineBounds: firstLine, scroll: await canvas.evaluate(element => ({ scrollTop: element.scrollTop, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight })) }, null, 2),
        contentType: 'application/json'
      })
      const x = firstLine.x + 1
      await page.mouse.move(x, firstLine.y + firstLine.height / 2)
      await page.mouse.down()
      await page.mouse.move(x, bounds.y + bounds.height - WRITER_AUTOSCROLL_EDGE_OFFSET_PX, { steps: 24 })
      await page.waitForTimeout(WRITER_AUTOSCROLL_REVERSE_HOLD_MS)
      if (file.reverse) {
        await page.mouse.move(x, bounds.y + bounds.height * WRITER_AUTOSCROLL_REVERSE_Y_RATIO, { steps: 24 })
        await page.waitForTimeout(WRITER_AUTOSCROLL_REVERSE_SETTLE_MS)
        await page.screenshot({ path: join(runtime.artifacts, 'office-docx-selection-autoscroll-reverse.png') })
      }
      await page.mouse.up()
      await attachSelectionDiagnostics(testInfo, canvas, file.filename)
      const menu = page.getByTestId('selection-action-host')
      await expect(menu).toBeVisible({ timeout: SELECTION_MENU_BUDGET_MS })
      await menu.getByRole('button', { name: '添加到任务', exact: true }).click()
      await page.getByTitle(`${file.filename} · 选区`, { exact: true }).hover()
      const quoteText = await page.getByTestId('assistant-selection-quote').innerText()
      const selectedLines = [...quoteText.matchAll(/Bidirectional line (\d+) evidence\./g)]
        .map(match => Number(match[1]))
      expect(selectedLines.length).toBeGreaterThan(1)
      selectedLastLines.push(Math.max(...selectedLines))
    }
    expect(selectedLastLines[1]).toBeLessThan(selectedLastLines[0])
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('CSV and XLSX selection autoscroll follows the pointer beyond the workspace', async ({}, testInfo) => {
  test.setTimeout(OFFICE_READY_TIMEOUT_MS * 2)
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  const csvRows = Array.from({ length: 120 }, (_, index) => `Autoscroll CSV row ${index + 1},${index + 1}`)
  const files = [
    { name: 'selection-autoscroll.csv', bytes: csvRows.join('\n') + '\n', screenshot: 'office-csv-selection-autoscroll.png', xRatio: CALC_AUTOSCROLL_SELECTION_X_RATIO },
    { name: 'selection-autoscroll.xlsx', bytes: largeSpreadsheetArchive(), screenshot: 'office-xlsx-selection-autoscroll.png', xRatio: CALC_XLSX_AUTOSCROLL_SELECTION_X_RATIO }
  ]
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    for (const file of files) {
      writeFileSync(join(resources, file.name), file.bytes)
      await openProjectExplorer(page)
      await page.getByTestId('explorer-refresh').click()
      await openFile(page, file.name)
      let canvas: Locator
      if (file.name.endsWith('.xlsx')) {
        const preview = await nativePreview(page, 'xlsx')
        canvas = preview.getByTestId('office-workbook-grid')
      } else {
        canvas = documentSurface(page).getByTestId('csv-grid')
        await expect(canvas).toBeVisible({ timeout: OFFICE_READY_TIMEOUT_MS })
        await expect(canvas.locator('[data-cell="A5"]')).toContainText('Autoscroll CSV row 5')
        await expect(page.locator('[data-testid="office-editor"][data-runtime-view]:not([data-runtime-view=""])')).toHaveCount(0)
      }
      const bounds = await canvas.boundingBox()
      if (!bounds) throw new Error(`${file.name} canvas bounds unavailable`)
      const startCell = await canvas.locator(file.name.endsWith('.xlsx') ? '[data-cell="B5"]' : '[data-cell="A5"]').boundingBox()
      if (!startCell) throw new Error(`${file.name} native cell bounds unavailable`)
      const x = startCell ? startCell.x + startCell.width / 2 : bounds.x + bounds.width * file.xRatio
      const startY = startCell ? startCell.y + startCell.height / 2 : bounds.y + bounds.height * CALC_AUTOSCROLL_SELECTION_START_Y_RATIO
      await page.mouse.move(x, startY)
      await page.mouse.down()
      await page.mouse.move(x, bounds.y + bounds.height + SELECTION_AUTOSCROLL_OVERFLOW_PX, { steps: 24 })
      await page.waitForTimeout(SELECTION_AUTOSCROLL_HOLD_MS)
      await expect(page.getByTestId('selection-action-host')).toBeHidden()
      await page.mouse.up()
      await attachSelectionDiagnostics(testInfo, canvas, file.name)

      const menu = page.getByTestId('selection-action-host')
      await expect(menu).toBeVisible({ timeout: CALC_SELECTION_MENU_TIMEOUT_MS })
      const range = /([A-Z]+)(\d+):([A-Z]+)(\d+)/.exec(await menu.innerText())
      expect(range, `${file.name} selection range`).not.toBeNull()
      expect(Number(range![4]), `${file.name} selection end row`).toBeGreaterThan(Number(range![2]))
      await page.screenshot({ path: join(runtime.artifacts, file.screenshot) })
    }
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('OOXML history switches immutable native previews without editor or Agent selections', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  const cases = [
    { format: 'docx', bytes: documentArchive(), original: 'Document-private Helvetica runtime', selector: '.scholarseed-paragraph-1 span' },
    { format: 'pptx', bytes: presentationArchive(), original: 'Presentation page 1', selector: '[data-preview-shape] span' },
    { format: 'xlsx', bytes: spreadsheetArchive(), original: 'Readonly spreadsheet', selector: '[data-cell="A1"]' }
  ] as const
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    const base = await apiBase(page)
    const projectsResponse = await page.request.get(`${base}/api/content/projects`)
    expect(projectsResponse.ok()).toBe(true)
    const projects = (await projectsResponse.json()).projects as Array<{ id: string; root: string }>
    const project = projects.find(item => join(item.root, 'resources') === resources)
    expect(project).toBeTruthy()
    const projectQuery = `project=${encodeURIComponent(project!.id)}`
    for (const item of cases) {
      const name = `history-preview.${item.format}`
      const path = `resources/${name}`
      const capabilityUrl = `${base}/api/resource/capability?${projectQuery}&path=${encodeURIComponent(path)}`
      writeFileSync(join(resources, name), item.bytes)
      await openProjectExplorer(page)
      await page.getByTestId('explorer-refresh').click()
      await openFile(page, name)
      await expect(await nativePreview(page, item.format)).toContainText(item.original)
      const seal = async (key: string) => {
        const expectedDiskRevision = `sha256:${sha256(join(resources, name))}`
        let capability: { managed: boolean; can_version: boolean; file_id: string; disk_revision: string; working_revision: string; version_id: string; pending: { revision: number } | null } | undefined
        // Resource refresh schedules background discovery; eligibility alone does
        // not mean the initial version and stable file identity already exist.
        await expect.poll(async () => {
          const capabilityResponse = await page.request.get(capabilityUrl)
          expect(capabilityResponse.ok(), await capabilityResponse.text()).toBe(true)
          capability = await capabilityResponse.json()
          return Boolean(capability?.managed && capability.can_version && capability.file_id && capability.version_id && capability.disk_revision === expectedDiskRevision)
        }, { timeout: OFFICE_READY_TIMEOUT_MS }).toBe(true)
        if (!capability) throw new Error('Managed version capability is missing')
        const response = await page.request.post(`${base}/api/resource/files/${capability.file_id}/versions?${projectQuery}`, {
          headers: { 'Idempotency-Key': key },
          data: {
            path,
            origin: capability.pending ? 'external_confirmed' : 'user',
            expected_disk_revision: capability.disk_revision ?? capability.working_revision,
            expected_version_id: capability.version_id,
            expected_pending_revision: capability.pending?.revision ?? null
          }
        })
        expect(response.ok(), await response.text()).toBe(true)
        return (await response.json()).version as { id: string; sequence: number }
      }
      const historical = await seal(`history-${item.format}-original`)
      const entries = Object.fromEntries(Object.entries(unzipSync(item.bytes)).map(([entry, bytes]) => [entry, strFromU8(bytes).replace(item.original, `Current ${item.original}`)]))
      const currentBytes = archive(entries)
      writeFileSync(join(resources, name), currentBytes)
      const current = await seal(`history-${item.format}-current`)
      expect(current.id).not.toBe(historical.id)
      for (const [version, bytes] of [[historical, item.bytes], [current, currentBytes]] as const) {
        const response = await page.request.get(`${base}/api/resource/versions/${version.id}/content?${projectQuery}`)
        expect(response.ok(), await response.text()).toBe(true)
        expect(await response.body()).toEqual(Buffer.from(bytes))
      }
      await openProjectExplorer(page)
      await page.getByTestId('explorer-refresh').click()
      await openFile(page, name)
      await documentSurface(page).getByTestId('document-version-history').click()
      const row = page.getByTestId('version-history-row-action').filter({ has: page.locator('strong', { hasText: new RegExp(`^v${historical.sequence}$`) }) })
      await expect(row).toBeEnabled()
      await row.click()
      const comparison = page.getByTestId('version-office-diff')
      const preview = comparison.getByTestId('office-preview')
      await expect(preview).toHaveAttribute('data-office-revision', historical.id)
      await expect(preview).toContainText(item.original)
      await expect(preview).not.toContainText(`Current ${item.original}`)
      await expect(preview.getByRole('status')).toHaveCount(0)
      await expect(page.locator('[data-testid="office-editor"][data-runtime-view]:not([data-runtime-view=""])')).toHaveCount(0)
      const text = preview.locator(item.selector).first()
      if (item.format === 'xlsx') await text.click()
      else await dragPreviewText(page, text)
      await expect(page.getByTestId('selection-action-host')).toHaveCount(0)
      await expect(documentSurface(page).getByTestId('document-save')).toHaveCount(0)
      await expect(preview.locator('[contenteditable="true"], textarea')).toHaveCount(0)
      await page.screenshot({ path: join(runtime.artifacts, `ooxml-historical-${item.format}.png`) })
      await comparison.getByRole('button', { name: '当前版本', exact: true }).click()
      await expect(preview).toHaveAttribute('data-office-revision', current.id)
      await expect(preview).toContainText(`Current ${item.original}`)
      await comparison.getByRole('button', { name: `历史版本 v${historical.sequence}`, exact: true }).click()
      await expect(preview).toHaveAttribute('data-office-revision', historical.id)
      await expect(preview).not.toContainText(`Current ${item.original}`)
      expect(readFileSync(join(resources, name))).toEqual(Buffer.from(currentBytes))
    }
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('original CSV bounded reference saves dirty content before real Agent explanation and followup', async ({}, testInfo) => {
  test.skip(!ONE_SHOT_E2E_ENABLED, 'requires explicitly enabled real model acceptance')
  const name = 'sample-data-1000-rows.csv'
  const source = join(OFFICE_CORPUS_ROOT, 'csv', name)
  test.skip(!existsSync(source), 'requires the original 1000-row CSV sample')
  test.setTimeout(OFFICE_READY_TIMEOUT_MS * 2)
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  if (blocker) throw new Error(blocker)
  const desktop = new DesktopSession(runtime, testInfo)
  const changed = 'CSV reference saved new evidence'
  const selectedLastRow = 101
  const originalHash = sha256(source)
  const lastDate = readFileSync(source, 'utf8').split(/\r?\n/)[selectedLastRow - 1].split(',')[1]
  try {
    const page = await desktop.launch()
    const modelKey = process.env.SCHOLARSEED_ACTION_MODEL
    if (!modelKey) throw new Error('SCHOLARSEED_ACTION_MODEL must name a configured real model connection')
    const selectedModel = await page.request.post(`${await apiBase(page)}/api/serve/models/default`, {
      data: { model_key: modelKey, persist: true }
    })
    expect(selectedModel.status()).toBe(200)
    const resources = await seedProject(page, runtime)
    const target = join(resources, name)
    copyFileSync(source, target)
    await openProjectExplorer(page)
      await page.getByTestId('explorer-refresh').click()
    await openFile(page, name)
    const document = page.getByTestId('csv-document')
    const grid = document.getByTestId('csv-grid')
    await expect(grid.locator('[data-cell="A2"]')).toHaveText('PB-100001')
    await expect(page.locator('[data-testid="office-editor"][data-runtime-view]:not([data-runtime-view=""])')).toHaveCount(0)
    await grid.locator('[data-cell="A2"]').dblclick()
    const editor = page.getByTestId('csv-cell-editor')
    await editor.fill(changed)
    await editor.press('Enter')
    await expect(grid.locator('[data-cell="A2"]')).toHaveText(changed)
    expect(sha256(target)).toBe(originalHash)
    await expect(documentSurface(page).getByTestId('document-save')).toBeEnabled()
    const selectReference = async (): Promise<void> => {
      await grid.evaluate(element => { element.scrollTop = 0; element.scrollLeft = 0 })
      await grid.locator('[data-cell="A1"]').click()
      await grid.focus()
      await page.keyboard.press('Shift+ArrowRight')
      for (let row = 1; row < selectedLastRow; row += 1) await page.keyboard.press('Shift+ArrowDown')
      const menu = page.getByTestId('selection-action-host')
      await expect(menu).toBeVisible()
      await expect(menu).toContainText(`A1:B${selectedLastRow}`)
      await expect(menu.getByRole('button', { name: 'AI 润色', exact: true })).toHaveCount(0)
    }
    await selectReference()
    const save = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes('/api/workbench/content?'))
    await page.getByTestId('selection-action-host').getByRole('button', { name: '添加到任务', exact: true }).click()
    expect((await save).status()).toBe(204)
    await expect(documentSurface(page).getByTestId('document-save')).toBeDisabled()
    expect(readFileSync(target, 'utf8')).toContain(changed)
    const committedRevision = await document.getAttribute('data-document-revision')
    expect(committedRevision).toBeTruthy()
    const pending = page.getByTestId('ai-context-ref').filter({ hasText: name })
    await expect(pending).toBeVisible()
    await pending.hover()
    const quote = page.getByTestId('assistant-selection-quote')
    await expect(quote).toContainText(`sample-data-1000-rows!A1:B${selectedLastRow}`)
    await expect(quote).not.toContainText(changed)
    await page.screenshot({ path: join(runtime.artifacts, 'original-csv-reference-saved-revision.png') })

    await selectReference()
    await page.getByTestId('selection-action-host').getByRole('button', { name: 'AI 解释', exact: true }).click()
    const explanation = page.getByTestId('resource-ai-suggestion')
    await explanation.getByRole('textbox').fill(`仅根据当前选区，逐字回复 A2 的完整值和 B${selectedLastRow} 的日期，中间用逗号分隔。`)
    const response = page.waitForResponse(result => result.url().endsWith('/api/resource/ai/explain'), { timeout: OFFICE_READY_TIMEOUT_MS })
    await explanation.getByRole('button', { name: '提交AI 解释', exact: true }).click()
    await explanation.getByRole('button', { name: '固定浮窗', exact: true }).click()
    const result = await response
    expect(result.status()).toBe(200)
    const input = result.request().postDataJSON()
    expect(input.source.source_revision).toBe(committedRevision)
    expect(input.source.source_id).toBe(`resources/${name}`)
    expect(input.selection.locator).toMatchObject({ kind: 'calc', range: `A1:B${selectedLastRow}`, sheet: 'sample-data-1000-rows', content_mode: 'reference' })
    expect(input.draft).toBeUndefined()
    await expect(explanation.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0, { timeout: OFFICE_READY_TIMEOUT_MS })
    await expect(explanation.getByRole('alert')).toHaveCount(0)
    await expect(explanation.getByTestId('resource-translation-result')).toContainText(changed)
    await expect(explanation.getByTestId('resource-translation-result')).toContainText(lastDate)
    await page.screenshot({ path: join(runtime.artifacts, 'original-csv-reference-agent-explain.png') })
    await explanation.getByRole('button', { name: /关闭/ }).click()
    await page.getByTestId('composer-input').fill(`仅根据已添加的 CSV 选区，逐字回复 A2 的完整值和 B${selectedLastRow} 的日期，中间用逗号分隔。`)
    await page.getByTestId('composer-send').click()
    await waitForFinishedTurn(page)
    const answer = page.locator('.answer-annotation-root').last()
    await expect(answer).toContainText(changed, { timeout: OFFICE_READY_TIMEOUT_MS })
    await expect(answer).toContainText(lastDate)
    await page.screenshot({ path: join(runtime.artifacts, 'original-csv-reference-agent-followup.png') })
    expect(sha256(source)).toBe(originalHash)
    expect(readFileSync(target, 'utf8')).toContain(changed)
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('original CSV edit and save produce immutable native history without editor or Agent selections', async () => {
  const testInfo = test.info()
  const name = 'sample-data-10-rows.csv'
  const source = join(OFFICE_CORPUS_ROOT, 'csv', name)
  test.skip(!existsSync(source), 'requires the original CSV sample corpus')
  test.setTimeout(OFFICE_READY_TIMEOUT_MS * 2)
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  const changed = 'CSV saved historical cell'
  const csvWarnings: string[] = []
  try {
    const page = await desktop.launch()
    page.on('console', message => {
      if (message.text().startsWith('CSV document operation failed')) csvWarnings.push(message.text())
    })
    const resources = await seedProject(page, runtime)
    const target = join(resources, name)
    copyFileSync(source, target)
    const originalHash = sha256(source)
    const originalBytes = readFileSync(source)
    await openProjectExplorer(page)
      await page.getByTestId('explorer-refresh').click()
    await openFile(page, name)
    const liveDocument = page.getByTestId('csv-document')
    const grid = liveDocument.getByTestId('csv-grid')
    await expect(grid.locator('[data-cell="A1"]')).toHaveText('order_id')
    await expect(grid.locator('[data-cell="A2"]')).toHaveText('PB-100001')
    await expect(page.locator('[data-testid="office-editor"][data-runtime-view]:not([data-runtime-view=""])')).toHaveCount(0)

    const base = await apiBase(page)
    const projectsResponse = await page.request.get(`${base}/api/content/projects`)
    expect(projectsResponse.ok()).toBe(true)
    const projects = (await projectsResponse.json()).projects as Array<{ id: string; root: string }>
    const project = projects.find(item => join(item.root, 'resources') === resources)
    expect(project).toBeTruthy()
    const projectQuery = `project=${encodeURIComponent(project!.id)}`
    const path = `resources/${name}`
    const seal = async (key: string): Promise<{ id: string; sequence: number }> => {
      const expectedDiskRevision = `sha256:${sha256(target)}`
      let capability: { managed: boolean; can_version: boolean; file_id: string; disk_revision: string; working_revision: string; version_id: string; pending: { revision: number } | null } | undefined
      await expect.poll(async () => {
        const response = await page.request.get(`${base}/api/resource/capability?${projectQuery}&path=${encodeURIComponent(path)}`)
        expect(response.ok(), await response.text()).toBe(true)
        capability = await response.json()
        return Boolean(capability?.managed && capability.can_version && capability.file_id && capability.version_id && capability.disk_revision === expectedDiskRevision)
      }, { timeout: OFFICE_READY_TIMEOUT_MS }).toBe(true)
      if (!capability) throw new Error('Managed CSV version capability is missing')
      const response = await page.request.post(`${base}/api/resource/files/${capability.file_id}/versions?${projectQuery}`, {
        headers: { 'Idempotency-Key': key },
        data: { path, origin: capability.pending ? 'external_confirmed' : 'user', expected_disk_revision: capability.disk_revision ?? capability.working_revision, expected_version_id: capability.version_id, expected_pending_revision: capability.pending?.revision ?? null },
      })
      expect(response.ok(), await response.text()).toBe(true)
      return (await response.json()).version
    }
    const historical = await seal('csv-native-original')
    await grid.locator('[data-cell="A2"]').dblclick()
    const editor = page.getByTestId('csv-cell-editor')
    await expect(editor).toBeVisible()
    await editor.fill(changed)
    await editor.press('Enter')
    await expect(grid.locator('[data-cell="A2"]')).toHaveText(changed)
    expect(sha256(target)).toBe(originalHash)
    await expect(documentSurface(page).getByTestId('document-save')).toBeEnabled()
    await documentSurface(page).getByTestId('document-save').click()
    await expect(documentSurface(page).getByTestId('document-save')).toBeDisabled()
    await expect.poll(() => sha256(target)).not.toBe(originalHash)
    const currentBytes = readFileSync(target)
    const current = await seal('csv-native-saved')
    expect(current.id).not.toBe(historical.id)
    for (const [version, bytes] of [[historical, originalBytes], [current, currentBytes]] as const) {
      const response = await page.request.get(`${base}/api/resource/versions/${version.id}/content?${projectQuery}`)
      expect(response.ok(), await response.text()).toBe(true)
      expect(await response.body()).toEqual(bytes)
    }

    await documentSurface(page).getByTestId('document-version-history').click()
    const row = page.getByTestId('version-history-row-action').filter({ has: page.locator('strong', { hasText: new RegExp(`^v${historical.sequence}$`) }) })
    await expect(row).toBeEnabled()
    await row.click()
    const comparison = page.getByTestId('version-office-diff')
    const snapshot = comparison.getByTestId('csv-document')
    await expect(snapshot).toHaveAttribute('data-document-revision', historical.id)
    await expect(snapshot.locator('[data-cell="A2"]')).toHaveText('PB-100001')
    await expect(snapshot.getByRole('alert')).toHaveCount(0)
    await expect(snapshot.locator('[data-cell="A2"]')).not.toHaveText(changed)
    await snapshot.locator('[data-cell="A2"]').dblclick()
    await page.keyboard.type('history must remain immutable')
    await expect(snapshot.locator('[data-cell="A2"]')).toHaveText('PB-100001')
    await expect(page.getByTestId('selection-action-host')).toHaveCount(0)
    await expect(page.getByTestId('csv-cell-editor')).toHaveCount(0)
    await expect(documentSurface(page).getByTestId('document-save')).toHaveCount(0)
    await expect(page.locator('[data-testid="office-editor"][data-runtime-view]:not([data-runtime-view=""])')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'original-csv-historical-native.png') })
    await comparison.getByRole('button', { name: '当前版本', exact: true }).click()
    await expect(snapshot).toHaveAttribute('data-document-revision', current.id)
    await expect(snapshot.locator('[data-cell="A2"]')).toHaveText(changed)
    await expect(snapshot.getByRole('alert')).toHaveCount(0)
    await expect(snapshot.locator('textarea, [contenteditable="true"]')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'original-csv-current-native.png') })
    await comparison.getByRole('button', { name: `历史版本 v${historical.sequence}`, exact: true }).click()
    await expect(snapshot).toHaveAttribute('data-document-revision', historical.id)
    await expect(snapshot.locator('[data-cell="A2"]')).toHaveText('PB-100001')
    expect(readFileSync(target)).toEqual(currentBytes)
    expect(sha256(source)).toBe(originalHash)
    expect(csvWarnings).toEqual([])
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('native DOCX and PPTX selections reach the real explanation model with source evidence', async ({}, testInfo) => {
  test.skip(!ONE_SHOT_E2E_ENABLED, 'requires explicitly enabled real model acceptance')
  test.setTimeout(OFFICE_READY_TIMEOUT_MS * 2)
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  if (blocker) throw new Error(blocker)
  const modelKey = process.env.SCHOLARSEED_ACTION_MODEL
  if (!modelKey) throw new Error('SCHOLARSEED_ACTION_MODEL must name a configured model connection')
  const desktop = new DesktopSession(runtime, testInfo)
  const cases = [
    { format: 'docx', bytes: documentArchive(), selector: '.scholarseed-paragraph-1 span', expected: 'Document-private Helvetica' },
    { format: 'pptx', bytes: presentationArchive(), selector: '[data-preview-shape] span', expected: 'Presentation page' }
  ] as const
  try {
    const page = await desktop.launch()
    const base = await apiBase(page)
    const selected = await page.request.post(`${base}/api/serve/models/default`, {
      data: { model_key: modelKey, persist: true }
    })
    expect(selected.status()).toBe(200)
    const resources = await seedProject(page, runtime)
    for (const item of cases) {
      const name = `source-explanation.${item.format}`
      writeFileSync(join(resources, name), item.bytes)
      await openProjectExplorer(page)
      await page.getByTestId('explorer-refresh').click()
      await openFile(page, name)
      const preview = await nativePreview(page, item.format)
      await dragPreviewText(page, preview.locator(item.selector).first())
      const menu = page.getByTestId('selection-action-host')
      await expect(menu).toBeVisible()
      await menu.getByRole('button', { name: 'AI 解释', exact: true }).click()
      const explanation = page.getByTestId('resource-ai-suggestion')
      await expect(explanation.getByRole('textbox')).toBeFocused()
      await explanation.getByRole('textbox').fill('请仅逐字复述当前选区原文，不添加其他内容。')
      const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/resource/ai/explain'), { timeout: OFFICE_READY_TIMEOUT_MS })
      await explanation.getByRole('button', { name: '提交AI 解释', exact: true }).click()
      await explanation.getByRole('button', { name: '固定浮窗', exact: true }).click()
      await expect(explanation.getByRole('button', { name: '取消固定浮窗', exact: true })).toHaveAttribute('aria-pressed', 'true')
      expect((await responsePromise).status()).toBe(200)
      await expect(explanation.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0, { timeout: OFFICE_READY_TIMEOUT_MS })
      await expect(explanation.getByRole('alert')).toHaveCount(0)
      await expect(explanation.getByTestId('resource-translation-result')).toContainText(item.expected)
      await page.screenshot({ path: join(runtime.artifacts, `native-source-explanation-${item.format}.png`) })
      await explanation.getByRole('button', { name: /关闭/ }).click()
      expect(readFileSync(join(resources, name))).toEqual(Buffer.from(item.bytes))
    }
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('native PPTX bullet and numbered paragraphs retain source text in conversation references', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  const name = 'bullet-evidence.pptx'
  const firstText = 'Bullet evidence one'
  const secondText = 'Numbered evidence two'
  const entries = Object.fromEntries(Object.entries(unzipSync(presentationArchive())).map(([entry, bytes]) => [entry, strFromU8(bytes)]))
  entries['ppt/slides/slide1.xml'] = entries['ppt/slides/slide1.xml'].replace(
    '<a:p><a:r><a:rPr lang="en-US"/><a:t>Presentation page 1</a:t></a:r></a:p>',
    `<a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>${firstText}</a:t></a:r></a:p><a:p><a:pPr><a:buAutoNum type="arabicPeriod" startAt="1"/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>${secondText}</a:t></a:r></a:p>`
  )
  const bytes = archive(entries)
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    writeFileSync(join(resources, name), bytes)
    await openProjectExplorer(page)
      await page.getByTestId('explorer-refresh').click()
    await openFile(page, name)
    const preview = await nativePreview(page, 'pptx')
    await expect(preview).toContainText(firstText)
    await expect(preview).toContainText(secondText)
    const shape = preview.locator('[data-preview-shape]').filter({ hasText: firstText }).first()
    const first = shape.locator('span').filter({ hasText: new RegExp(`^${firstText}$`) }).last()
    const second = shape.locator('span').filter({ hasText: new RegExp(`^${secondText}$`) }).last()
    await dragPreviewText(page, first, second)
    const menu = page.getByTestId('selection-action-host')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('button', { name: 'AI 润色', exact: true })).toHaveCount(0)
    await menu.getByRole('button', { name: '添加到任务', exact: true }).click()
    await page.getByTestId('ai-context-ref').filter({ hasText: name }).hover()
    const quote = page.getByTestId('assistant-selection-quote')
    await expect(quote).toContainText(firstText)
    await expect(quote).toContainText(secondText)
    await expect(quote).not.toContainText('•')
    await expect(quote).not.toContainText('1.')
    expect(readFileSync(join(resources, name))).toEqual(Buffer.from(bytes))
    await page.screenshot({ path: join(runtime.artifacts, 'native-pptx-bullet-source-reference.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('Calc whole-row translation keeps authoritative CSV selection evidence', async ({}, testInfo) => {
  test.skip(!ONE_SHOT_E2E_ENABLED, 'requires explicitly enabled real model acceptance')
  test.setTimeout(OFFICE_READY_TIMEOUT_MS * 2)
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const blocker = seedLiveConfig(runtime)
  if (blocker) throw new Error(blocker)
  const desktop = new DesktopSession(runtime, testInfo)
  const filename = 'whole-row-selection.csv'
  try {
    const page = await desktop.launch()
    const modelKey = process.env.SCHOLARSEED_ACTION_MODEL
    if (!modelKey) throw new Error('SCHOLARSEED_ACTION_MODEL must name a configured model connection')
    const selectedModel = await page.evaluate(async ({ base, modelKey }) => {
      const response = await fetch(`${base}/api/serve/models/default`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_key: modelKey, persist: true })
      })
      return response.status
    }, { base: await apiBase(page), modelKey })
    expect(selectedModel).toBe(200)
    const resources = await seedProject(page, runtime)
    writeFileSync(join(resources, filename), [
      'order_id,date,customer,region,product,category,quantity,unit_price,total,status',
      'PB-100001,2025-08-27,Prairie Wind Farms,Alberta,Data Migration,Services,9,2400.0,21600.0,Paid',
      'PB-100002,2025-11-11,Harbourfront Textiles,Quebec,Data Migration,Services,11,2400.0,26400.0,Pending',
      'PB-100003,2025-02-16,Silverline Freight,Ontario,Label Printer,Hardware,3,185.5,556.5,Refunded',
      'PB-100004,2025-12-01,Birchwood Interiors,British Columbia,API Add-on,Software,8,99.0,792.0,Refunded',
      'PB-100005,2025-02-02,Northwind Logistics,Ontario,Workflow Platform License,Software,9,1200.0,10800.0,Paid'
    ].join('\n') + '\n')
    await openProjectExplorer(page)
      await page.getByTestId('explorer-refresh').click()
    await openFile(page, filename)
    const frame = documentSurface(page).getByTestId('csv-grid')
    await expect(frame.locator('[data-cell="A5"]')).toHaveText('PB-100004')
    await expect(page.locator('[data-testid="office-editor"][data-runtime-view]:not([data-runtime-view=""])')).toHaveCount(0)
    await frame.getByRole('rowheader', { name: '5', exact: true }).click()
    const menu = page.getByTestId('selection-action-host')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('A5:J5')
    await menu.getByRole('button', { name: '添加到任务', exact: true }).click()
    const pendingSelection = page.getByTestId('ai-context-ref').filter({ hasText: `${filename} · 选区` })
    await pendingSelection.hover()
    const quote = page.getByTestId('assistant-selection-quote')
    await expect(quote).toContainText('PB-100004')
    await expect(quote).toContainText('792')
    await frame.getByRole('rowheader', { name: '5', exact: true }).click()
    await expect(menu).toBeVisible()
    const responsePromise = page.waitForResponse(
      response => response.url().endsWith('/api/resource/ai/translate'),
      { timeout: OFFICE_READY_TIMEOUT_MS }
    )
    await menu.getByRole('button', { name: 'AI 翻译', exact: true }).click()
    const response = await responsePromise
    expect(response.status()).toBe(200)
    const suggestion = page.getByTestId('resource-ai-suggestion')
    await expect(suggestion.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0, {
      timeout: OFFICE_READY_TIMEOUT_MS
    })
    await expect(suggestion.getByRole('alert')).toHaveCount(0)
    await expect(suggestion.locator('.whitespace-pre-wrap').last()).not.toHaveText('正在生成…')
    await page.screenshot({ path: join(runtime.artifacts, 'calc-whole-row-translation.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
