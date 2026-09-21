import { createHash } from 'crypto'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { expect, test } from '@playwright/test'
import { strToU8, zipSync } from 'fflate'

import { apiBase, DesktopSession, waitForFinishedTurn } from './fixtures/electron'
import { createRuntime, seedLiveConfig } from './fixtures/runtime'
import { openFile, seedProject } from './fixtures/workbench'

const OFFICE_READY_TIMEOUT_MS = 180_000
const OFFICE_PAINT_SETTLE_MS = 2_000
const ONE_SHOT_E2E_ENABLED = process.env.SCHOLARSEED_ONE_SHOT_E2E === '1'
const OFFICE_CORPUS_ROOT = process.env.SCHOLARSEED_OFFICE_CORPUS
const SELECTION_MENU_BUDGET_MS = 500
const LEGACY_DOC_SELECTION_MENU_TIMEOUT_MS = 1_000
const CALC_SELECTION_MENU_TIMEOUT_MS = 2_000
const DOC_CROSS_PAGE_SCROLL_DELTA = 1_900
const DOC_CROSS_PAGE_SELECTION_X_RATIO = 0.5
const DOC_CROSS_PAGE_SELECTION_START_Y_RATIO = 0.18
const DOC_CROSS_PAGE_SELECTION_END_Y_RATIO = 0.58
const DOC_CROSS_PAGE_DRAG_HOLD_MS = 1_500
const SELECTION_AUTOSCROLL_OVERFLOW_PX = 48
const SELECTION_AUTOSCROLL_HOLD_MS = 2_500
const SELECTION_AUTOSCROLL_FRAME_SAMPLE_MS = 500
const SELECTION_AUTOSCROLL_FRAME_SAMPLES = 3
const WRITER_AUTOSCROLL_EDGE_OFFSET_PX = 1
const WRITER_AUTOSCROLL_SELECTION_X_RATIO = 0.15
const WRITER_AUTOSCROLL_SELECTION_START_Y_RATIO = 0.1
const WRITER_AUTOSCROLL_REVERSE_Y_RATIO = 0.45
const WRITER_AUTOSCROLL_REVERSE_HOLD_MS = 1_800
const WRITER_AUTOSCROLL_REVERSE_SETTLE_MS = 1_800
const LEGACY_DOC_AUTOSCROLL_SELECTION_START_Y_RATIO = 0.35
const CALC_AUTOSCROLL_SELECTION_X_RATIO = 0.15
const CALC_AUTOSCROLL_SELECTION_START_Y_RATIO = 0.25

interface OfficeDiagnostic {
  hostId: string
  tabId: string
  stage: string
  requiredFontCount?: number
  availableFontCount?: number
  selectedFontCount?: number
  loadedFontCount?: number
  unavailable?: number
  totalBytes?: number
  defaultFontCount?: number
  systemFontCount?: number
  editable?: boolean
  durationMs?: number
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
    'word/document.xml': '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:rFonts w:ascii="Helvetica" w:hAnsi="Helvetica"/></w:rPr><w:t>Document-private Helvetica runtime</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'
  }
  return archive(entries)
}

function multipageDocumentArchive(): Uint8Array {
  const entries = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>First page selection evidence.</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:t>Second page selection evidence.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'
  }
  return archive(entries)
}

function autoscrollDocumentArchive(): Uint8Array {
  const pages = Array.from({ length: 8 }, (_, index) => (
    `<w:p><w:r><w:t>Autoscroll page ${index + 1} evidence.</w:t>${index < 7 ? '<w:br w:type="page"/>' : ''}</w:r></w:p>`
  )).join('')
  return archive({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${pages}<w:sectPr/></w:body></w:document>`
  })
}

function bidirectionalAutoscrollDocumentArchive(): Uint8Array {
  const lines = Array.from({ length: 160 }, (_, index) => (
    `<w:p><w:r><w:t>Bidirectional line ${index + 1} evidence.</w:t></w:r></w:p>`
  )).join('')
  return archive({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines}<w:sectPr/></w:body></w:document>`
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

test('Office prewarms one runtime and replaces Office-family documents in place', async ({}, testInfo) => {
  test.setTimeout(OFFICE_READY_TIMEOUT_MS * 2)
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({ language: 'zh', theme: 'light' }))
  const desktop = new DesktopSession(runtime, testInfo)
  const diagnostics: OfficeDiagnostic[] = []
  try {
    const page = await desktop.launch()
    page.on('console', (message) => {
      const prefix = '[office-runtime] '
      if (!message.text().startsWith(prefix)) return
      diagnostics.push(JSON.parse(message.text().slice(prefix.length)) as OfficeDiagnostic)
    })
    const resources = await seedProject(page, runtime)
    const csvName = 'font-demand.csv'
    const docxName = 'font-demand.docx'
    const settlingDocxName = 'layout-demand.docx'
    const pptxName = 'readonly-content.pptx'
    const xlsxName = 'readonly-content.xlsx'
    writeFileSync(join(resources, csvName), 'name,result\n字体实验,通过\n')
    writeFileSync(join(resources, docxName), documentArchive())
    writeFileSync(join(resources, settlingDocxName), documentArchive())
    writeFileSync(join(resources, pptxName), presentationArchive())
    writeFileSync(join(resources, xlsxName), spreadsheetArchive())
    const readonlyHashes = Object.fromEntries([csvName, docxName, pptxName, xlsxName].map((name) => [name, sha256(join(resources, name))]))
    await page.getByTestId('resource-refresh').click()

    await expect(page.getByTestId(`tree-resources/${csvName}`)).toBeVisible({ timeout: OFFICE_READY_TIMEOUT_MS })
    await openFile(page, csvName)
    const csvFrame = page.locator(`iframe[data-testid="office-editor"][title="${csvName}"]`)
    await expect(csvFrame).toHaveAttribute('data-document-ready', 'true', { timeout: OFFICE_READY_TIMEOUT_MS })
    const csvHost = await csvFrame.getAttribute('data-runtime-slot')
    await expect.poll(() => diagnostics.some((item) => item.hostId === csvHost && item.stage === 'document-ready')).toBe(true)
    expect(diagnostics).toContainEqual(expect.objectContaining({ hostId: csvHost, stage: 'document-ready', editable: false }))
    await expect(page.getByTestId('document-save')).toHaveCount(0)
    const registeredFonts = diagnostics.find((item) => item.hostId === csvHost && item.stage === 'font-register')
    expect(registeredFonts).toEqual(expect.objectContaining({
      hostId: csvHost,
      stage: 'font-register',
      defaultFontCount: 1
    }))
    expect(registeredFonts?.loadedFontCount).toBe(
      (registeredFonts?.defaultFontCount ?? 0) + (registeredFonts?.systemFontCount ?? 0)
    )
    await page.waitForTimeout(OFFICE_PAINT_SETTLE_MS)
    await page.screenshot({ path: join(runtime.artifacts, 'office-csv-readonly-content.png') })
    await csvFrame.contentFrame().locator('#qtcanvas').click({ button: 'right', position: { x: 800, y: 500 } })
    await page.waitForTimeout(OFFICE_PAINT_SETTLE_MS)
    await page.screenshot({ path: join(runtime.artifacts, 'office-csv-readonly-context-menu-blocked.png') })

    await openFile(page, docxName)
    const docxFrame = page.locator(`iframe[data-testid="office-editor"][title="${docxName}"]`)
    await expect(docxFrame).toHaveAttribute('data-document-ready', 'true', { timeout: OFFICE_READY_TIMEOUT_MS })
    const docxHost = await docxFrame.getAttribute('data-runtime-slot')
    expect(docxHost).toBe(csvHost)
    await expect(csvFrame).toHaveCount(0)
    await expect.poll(() => diagnostics.some((item) => item.hostId === docxHost && item.stage === 'document-ready')).toBe(true)
    expect(diagnostics).toContainEqual(expect.objectContaining({ hostId: docxHost, stage: 'document-ready', editable: false }))
    expect(page.locator('iframe[data-testid="office-editor"]')).toHaveCount(1)
    const docxTab = page.getByRole('tab', { name: new RegExp(docxName) })
    await docxTab.click({ button: 'right' })
    const tabMenu = page.getByTestId('document-tab-menu')
    await expect(tabMenu).toBeVisible()
    await expect(tabMenu.locator('[data-testid^="tab-split-"]')).toHaveCount(0)
    await expect(tabMenu.locator('[data-testid^="tab-move-"]')).toHaveCount(0)
    await page.waitForTimeout(OFFICE_PAINT_SETTLE_MS)
    await page.screenshot({ path: join(runtime.artifacts, 'office-single-runtime-menu.png') })
    await page.keyboard.press('Escape')

    const readyBeforeLanguageChange = diagnostics.filter(
      (item) => item.hostId === docxHost && item.stage === 'document-ready'
    ).length
    await expect(docxFrame).toHaveAttribute('data-runtime-language', 'zh')
    await page.getByTestId('activity-account').click()
    await page.getByTestId('account-menu-language').click()
    await page.getByRole('button', { name: 'English', exact: true }).click()
    await expect(docxFrame).toHaveAttribute('data-runtime-language', 'en')
    await expect(docxFrame).toHaveAttribute('data-document-ready', 'true', { timeout: OFFICE_READY_TIMEOUT_MS })
    await expect.poll(() => diagnostics.filter(
      (item) => item.hostId === docxHost && item.stage === 'document-ready'
    ).length).toBeGreaterThan(readyBeforeLanguageChange)
    await page.waitForTimeout(OFFICE_PAINT_SETTLE_MS)
    await page.screenshot({ path: join(runtime.artifacts, 'office-language-auto-restart.png') })

    const readyBeforeChineseContent = diagnostics.filter(
      (item) => item.hostId === docxHost && item.stage === 'document-ready'
    ).length
    await page.getByTestId('account-menu-language').click()
    await page.getByRole('button', { name: '简体中文', exact: true }).click()
    await expect(docxFrame).toHaveAttribute('data-runtime-language', 'zh')
    await expect(docxFrame).toHaveAttribute('data-document-ready', 'true', { timeout: OFFICE_READY_TIMEOUT_MS })
    await expect.poll(() => diagnostics.filter(
      (item) => item.hostId === docxHost && item.stage === 'document-ready'
    ).length).toBeGreaterThan(readyBeforeChineseContent)
    await expect(page.getByTestId('document-save')).toHaveCount(0)
    await page.waitForTimeout(OFFICE_PAINT_SETTLE_MS)
    await page.screenshot({ path: join(runtime.artifacts, 'office-docx-readonly-content.png') })
    const externalOpenButton = page.getByTestId('office-open-external')
    await expect(externalOpenButton).toContainText('打开')
    await expect(externalOpenButton.locator('img')).toHaveCount(1)
    const documentToolbar = page.locator('.vds-document-toolbar')
    await expect(documentToolbar.getByTestId('office-open-external')).toHaveCount(1)
    await expect(page.locator('.vds-top-bar-actions').getByTestId('office-open-external')).toHaveCount(0)
    const externalOpenBounds = await externalOpenButton.boundingBox()
    const documentToolbarBounds = await documentToolbar.boundingBox()
    const versionHistoryBounds = await page.getByTestId('document-version-history').boundingBox()
    expect(externalOpenBounds?.height).toBe(28)
    expect(versionHistoryBounds?.height).toBe(28)
    expect((externalOpenBounds?.x ?? 0) + (externalOpenBounds?.width ?? 0)).toBeLessThanOrEqual(
      versionHistoryBounds?.x ?? 0
    )
    expect(externalOpenBounds?.y).toBeGreaterThanOrEqual(documentToolbarBounds?.y ?? 0)
    expect((externalOpenBounds?.y ?? 0) + (externalOpenBounds?.height ?? 0)).toBeLessThanOrEqual(
      (documentToolbarBounds?.y ?? 0) + (documentToolbarBounds?.height ?? 0)
    )
    await page.getByTestId('external-open-menu').click()
    const externalOpenMenu = page.getByRole('menu')
    await expect(externalOpenMenu).toBeVisible()
    await expect(externalOpenMenu.getByRole('menuitem', { name: '打开所在文件夹' })).toBeEnabled()
    await expect(externalOpenMenu.getByRole('menuitem', { name: '另存为...' })).toBeEnabled()
    await expect(externalOpenMenu.getByText('默认', { exact: true })).toHaveCount(0)
    await expect(externalOpenMenu.getByText('正在查找可用应用…')).toBeHidden()
    await page.screenshot({ path: join(runtime.artifacts, 'office-external-open-menu.png') })
    const externalOpenMenuBounds = await externalOpenMenu.boundingBox()
    const externalMenuTriggerBounds = await page.getByTestId('external-open-menu').boundingBox()
    expect(externalOpenMenuBounds?.width).toBe(224)
    expect(Math.abs((externalOpenMenuBounds?.x ?? 0) + (externalOpenMenuBounds?.width ?? 0) - ((externalMenuTriggerBounds?.x ?? 0) + (externalMenuTriggerBounds?.width ?? 0)))).toBeLessThanOrEqual(2)
    await page.keyboard.press('Escape')
    await expect(externalOpenMenu).toBeHidden()

    let releaseWriter: (() => void) | undefined
    let writerRequested: (() => void) | undefined
    const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve })
    const writerRequest = new Promise<void>((resolve) => { writerRequested = resolve })
    await page.route('**/api/workbench/content?**', async (route) => {
      const path = new URL(route.request().url()).searchParams.get('path')
      if (path === `resources/${settlingDocxName}`) {
        writerRequested?.()
        await writerGate
      }
      await route.continue()
    })
    await openFile(page, settlingDocxName)
    await writerRequest
    await expect(page.getByRole('tab', { name: new RegExp(docxName) })).toBeVisible()
    await expect(page.getByRole('tab', { name: new RegExp(settlingDocxName) })).toHaveCount(0)
    await expect(docxFrame).toHaveAttribute('data-document-ready', 'true')
    await expect(page.getByTestId('office-switch-mask')).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'office-switch-keeps-current-owner.png') })
    const settlingLayoutFinished = page.waitForEvent('console', {
      timeout: OFFICE_READY_TIMEOUT_MS,
      predicate(message) {
        const prefix = '[office-runtime] '
        if (!message.text().startsWith(prefix)) return false
        const item = JSON.parse(message.text().slice(prefix.length)) as OfficeDiagnostic
        return item.hostId === docxHost && item.stage === 'layout-finished'
      }
    })
    releaseWriter?.()
    const settlingFrame = page.locator(`iframe[data-testid="office-editor"][title="${settlingDocxName}"]`)
    await settlingLayoutFinished
    await expect(settlingFrame).toHaveAttribute('data-document-ready', 'true', { timeout: OFFICE_READY_TIMEOUT_MS })
    await expect(page.getByTestId('office-switch-mask')).toHaveCount(0)
    const settlingLayout = diagnostics.filter((item) => item.hostId === docxHost && item.stage === 'layout-finished').at(-1)
    const settlingPaint = diagnostics.filter((item) => item.hostId === docxHost && item.stage === 'layout-paint-ack').at(-1)
    const settlingReady = diagnostics.filter((item) => item.hostId === docxHost && item.stage === 'document-ready').at(-1)
    expect(settlingLayout).toBeTruthy()
    expect(settlingPaint).toBeTruthy()
    expect((settlingPaint?.durationMs ?? 0) - (settlingLayout?.durationMs ?? 0)).toBeGreaterThanOrEqual(0)
    expect((settlingReady?.durationMs ?? 0) - (settlingPaint?.durationMs ?? 0)).toBeLessThan(1_000)
    expect(settlingLayout?.quietDelayMs).toBeUndefined()
    await page.screenshot({ path: join(runtime.artifacts, 'office-switch-layout-stable.png') })

    for (const [name, screenshot] of [
      [pptxName, 'office-pptx-readonly-content.png'],
      [xlsxName, 'office-xlsx-readonly-content.png']
    ] as const) {
      await openFile(page, name)
      const officeFrame = page.locator(`iframe[data-testid="office-editor"][title="${name}"]`)
      await expect(officeFrame).toHaveAttribute('data-document-ready', 'true', { timeout: OFFICE_READY_TIMEOUT_MS })
      await expect(page.getByTestId('office-switch-mask')).toHaveCount(0)
      const host = await officeFrame.getAttribute('data-runtime-slot')
      expect(host).toBe(csvHost)
      await expect(page.locator('iframe[data-testid="office-editor"]')).toHaveCount(1)
      await expect.poll(() => diagnostics.some((item) => item.hostId === host && item.stage === 'document-ready')).toBe(true)
      expect(diagnostics).toContainEqual(expect.objectContaining({ hostId: host, stage: 'document-ready', editable: false }))
      await expect(page.getByTestId('document-save')).toHaveCount(0)
      if (name === pptxName) {
        const controls = page.getByTestId('office-presentation-controls')
        const previous = page.getByTestId('office-presentation-previous')
        const next = page.getByTestId('office-presentation-next')
        await expect(controls).toBeVisible()
        await expect(previous).toBeDisabled()
        await expect(next).toBeEnabled()
        const anchorBounds = await page.locator('.vds-office-document[data-office-presentation="true"] .vds-office-anchor').boundingBox()
        const controlsBounds = await controls.boundingBox()
        expect(anchorBounds).not.toBeNull()
        expect(controlsBounds).not.toBeNull()
        expect(anchorBounds!.y + anchorBounds!.height).toBeLessThanOrEqual(controlsBounds!.y)
        await expect(officeFrame).toHaveCSS('clip-path', /inset\(0px 20px 20px 0px\)/)
        await next.click()
        await expect(previous).toBeEnabled()
        await expect(next).toBeDisabled()
        await page.waitForTimeout(OFFICE_PAINT_SETTLE_MS)
        await page.screenshot({ path: join(runtime.artifacts, 'office-pptx-page-2.png') })
        await previous.click()
        await expect(previous).toBeDisabled()
        await expect(next).toBeEnabled()
      } else {
        await expect(page.getByTestId('office-presentation-controls')).toHaveCount(0)
      }
      await page.waitForTimeout(OFFICE_PAINT_SETTLE_MS)
      await page.screenshot({ path: join(runtime.artifacts, screenshot) })
    }
    await page.unroute('**/api/workbench/content?**')

    const xlsxFrame = page.locator(`iframe[data-testid="office-editor"][title="${xlsxName}"]`)
    const xlsxHost = await xlsxFrame.getAttribute('data-runtime-slot')
    const readyBeforeThemeChange = diagnostics.filter(
      (item) => item.hostId === xlsxHost && item.stage === 'document-ready'
    ).length
    const themesBeforeChange = diagnostics.filter(
      (item) => item.hostId === xlsxHost && item.stage === 'theme-applied'
    ).length
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect.poll(() => diagnostics.filter(
      (item) => item.hostId === xlsxHost && item.stage === 'theme-applied'
    ).length).toBeGreaterThan(themesBeforeChange)
    await expect(xlsxFrame).toHaveAttribute('data-runtime-slot', xlsxHost ?? '')
    expect(diagnostics.filter(
      (item) => item.hostId === xlsxHost && item.stage === 'document-ready'
    )).toHaveLength(readyBeforeThemeChange)
    await page.waitForTimeout(OFFICE_PAINT_SETTLE_MS)
    await page.screenshot({ path: join(runtime.artifacts, 'office-xlsx-readonly-content-dark.png') })

    for (const [name, before] of Object.entries(readonlyHashes)) {
      expect(sha256(join(resources, name))).toBe(before)
    }
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('readonly Office formats ignore keyboard text input', async ({}, testInfo) => {
  test.setTimeout(OFFICE_READY_TIMEOUT_MS * 2)
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  const files = [
    { name: 'readonly-input.csv', bytes: 'name,result\nScholarSeed,通过\n' },
    { name: 'readonly-input.docx', bytes: documentArchive() },
    { name: 'readonly-input.pptx', bytes: presentationArchive() },
    { name: 'readonly-input.xlsx', bytes: spreadsheetArchive() }
  ] as const
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    for (const file of files) writeFileSync(join(resources, file.name), file.bytes)
    const hashes = Object.fromEntries(files.map(file => [file.name, sha256(join(resources, file.name))]))
    await page.getByTestId('resource-refresh').click()

    for (const file of files) {
      await openFile(page, file.name)
      const frame = page.locator(`iframe[data-testid="office-editor"][title="${file.name}"]`)
      await expect(frame).toHaveAttribute('data-document-ready', 'true', { timeout: OFFICE_READY_TIMEOUT_MS })
      await expect(frame.contentFrame().locator('textarea, [contenteditable="true"]')).toHaveCount(0)
      await frame.contentFrame().locator('#qtcanvas').click()
      await page.keyboard.type('readonly input must be ignored')
      expect(sha256(join(resources, file.name))).toBe(hashes[file.name])
    }

    await page.waitForTimeout(OFFICE_PAINT_SETTLE_MS)
    await page.screenshot({ path: join(runtime.artifacts, 'office-readonly-keyboard-input.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('large Calc selections preserve a version-bound reference for AI', async ({}, testInfo) => {
  test.setTimeout(OFFICE_READY_TIMEOUT_MS)
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  const filename = 'large-selection.xlsx'
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    writeFileSync(join(resources, filename), largeSpreadsheetArchive())
    await page.getByTestId('resource-refresh').click()
    await openFile(page, filename)
    const frame = page.locator(`iframe[data-testid="office-editor"][title="${filename}"]`)
    await expect(frame).toHaveAttribute('data-document-ready', 'true', { timeout: OFFICE_READY_TIMEOUT_MS })
    const canvas = frame.contentFrame().locator('#qtcanvas')
    await canvas.click({ position: { x: 120, y: 20 } })

    const menu = page.getByTestId('selection-action-host')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('button', { name: 'AI 润色', exact: true })).toHaveCount(0)
    await menu.getByRole('button', { name: 'AI 解释', exact: true }).click()
    const explanation = page.getByTestId('resource-ai-suggestion')
    await expect(explanation).toBeVisible()
    await expect(explanation.getByRole('textbox')).toBeFocused()
    await page.screenshot({ path: join(runtime.artifacts, 'large-calc-explanation-input.png') })
    await explanation.getByRole('button', { name: '关闭', exact: true }).click()
    await canvas.click({ position: { x: 120, y: 20 } })
    await expect(menu).toBeVisible()
    await menu.getByRole('button', { name: '添加到对话', exact: true }).click()
    const pendingReference = page.getByTestId('ai-context-ref').filter({ hasText: `${filename} · 选区` })
    await pendingReference.hover()
    const quote = page.getByTestId('assistant-selection-quote')
    await expect(quote).toContainText(`${filename} · Results!B1:B151`)
    await expect(quote).not.toContainText('private-1')
    await page.screenshot({ path: join(runtime.artifacts, 'large-calc-selection-reference.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('Calc whole-column selections stop at the last content cell sent to AI', async ({}, testInfo) => {
  test.setTimeout(OFFICE_READY_TIMEOUT_MS)
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  const filename = 'bounded-selection.csv'
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    const rows = Array.from({ length: 11 }, (_, index) => `A${index + 1},B${index + 1},C${index + 1}`)
    writeFileSync(join(resources, filename), rows.join('\n') + '\n')
    await page.getByTestId('resource-refresh').click()
    await openFile(page, filename)
    const frame = page.locator(`iframe[data-testid="office-editor"][title="${filename}"]`)
    await expect(frame).toHaveAttribute('data-document-ready', 'true', { timeout: OFFICE_READY_TIMEOUT_MS })
    await frame.contentFrame().locator('#qtcanvas').click({ position: { x: 120, y: 20 } })
    const menu = page.getByTestId('selection-action-host')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('C1:C11')
    await expect(menu).not.toContainText('C1:C1048576')
    await page.screenshot({ path: join(runtime.artifacts, 'calc-column-selection-bounded.png') })
    await menu.getByRole('button', { name: '添加到对话', exact: true }).click()
    const pendingSelection = page.getByTestId('ai-context-ref').filter({ hasText: `${filename} · 选区` })
    await pendingSelection.hover()
    const quote = page.getByTestId('assistant-selection-quote')
    await expect(quote).toContainText('C1')
    await expect(quote).toContainText('C11')
    await expect(quote).not.toContainText('C12')
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('readonly Office formats expose selection actions without AI polish', async ({}, testInfo) => {
  test.setTimeout(OFFICE_READY_TIMEOUT_MS * 2)
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  const files = [
    { name: 'readonly.pptx', bytes: presentationArchive(), kind: 'impress' },
    { name: 'readonly.csv', bytes: 'name,result\nScholarSeed,通过\n', kind: 'calc' },
    { name: 'readonly.docx', bytes: documentArchive(), kind: 'writer' },
    { name: 'readonly.xlsx', bytes: spreadsheetArchive(), kind: 'calc' }
  ] as const
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    for (const file of files) writeFileSync(join(resources, file.name), file.bytes)
    await page.getByTestId('resource-refresh').click()

    for (const file of files) {
      await openFile(page, file.name)
      const frame = page.locator(`iframe[data-testid="office-editor"][title="${file.name}"]`)
      await expect(frame).toHaveAttribute('data-document-ready', 'true', { timeout: OFFICE_READY_TIMEOUT_MS })
      const canvas = frame.contentFrame().locator('#qtcanvas')
      if (file.kind === 'calc') await canvas.click({ position: { x: 120, y: 20 } })
      else if (file.kind === 'impress') {
        await canvas.dblclick({ position: { x: 210, y: 170 } })
      }
      else {
        await canvas.click({ position: { x: 520, y: 300 } })
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
      }
      const menu = page.getByTestId('selection-action-host')
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('button', { name: 'AI 润色', exact: true })).toHaveCount(0)
      await page.screenshot({ path: join(runtime.artifacts, `readonly-selection-${file.name}.png`) })
      if (file.kind === 'impress') {
        await menu.getByRole('button', { name: '添加到对话', exact: true }).click()
        const reference = page.getByTestId('ai-context-ref').filter({ hasText: file.name })
        await reference.hover()
        const quote = page.getByTestId('assistant-selection-quote')
        await expect(quote).toContainText('page')
        await expect(quote).not.toContainText('Presentation')
      }
    }
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('PPT selection remains usable after the window loses focus', async ({}, testInfo) => {
  test.setTimeout(OFFICE_READY_TIMEOUT_MS)
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  const filename = 'clipboard-focus.pptx'
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    writeFileSync(join(resources, filename), presentationArchive())
    await page.getByTestId('resource-refresh').click()
    await openFile(page, filename)
    const frame = page.locator(`iframe[data-testid="office-editor"][title="${filename}"]`)
    await expect(frame).toHaveAttribute('data-document-ready', 'true', { timeout: OFFICE_READY_TIMEOUT_MS })
    await frame.contentFrame().locator('#qtcanvas').dblclick({ position: { x: 210, y: 170 } })
    await desktop.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.blur())

    const menu = page.getByTestId('selection-action-host')
    await expect(menu).toBeVisible()
    await expect(page.getByTestId('office-font-warmup')).toHaveCount(0)
    await desktop.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus())
    await page.screenshot({ path: join(runtime.artifacts, 'ppt-selection-clipboard-focus.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('readonly Writer documents expose selection actions across pages', async ({}, testInfo) => {
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
    const filename = 'multipage.docx'
    writeFileSync(join(resources, filename), multipageDocumentArchive())
    await page.getByTestId('resource-refresh').click()
    await openFile(page, filename)
    const frame = page.locator(`iframe[data-testid="office-editor"][title="${filename}"]`)
    await expect(frame).toHaveAttribute('data-document-ready', 'true', { timeout: OFFICE_READY_TIMEOUT_MS })
    const canvas = frame.contentFrame().locator('#qtcanvas')
    await canvas.click({ position: { x: 520, y: 300 } })
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    const menu = page.getByTestId('selection-action-host')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('button', { name: 'AI 润色', exact: true })).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'readonly-writer-cross-page-selection.png') })
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
    await page.getByTestId('resource-refresh').click()
    await openFile(page, filename)
    const frame = page.locator(`iframe[data-testid="office-editor"][title="${filename}"]`)
    await expect(frame).toHaveAttribute('data-document-ready', 'true', { timeout: OFFICE_READY_TIMEOUT_MS })
    const canvas = frame.contentFrame().locator('#qtcanvas')
    const bounds = await canvas.boundingBox()
    if (!bounds) throw new Error('DOCX canvas bounds unavailable')
    const x = bounds.x + bounds.width * WRITER_AUTOSCROLL_SELECTION_X_RATIO
    await page.mouse.move(x, bounds.y + bounds.height * WRITER_AUTOSCROLL_SELECTION_START_Y_RATIO)
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
    await menu.getByRole('button', { name: '添加到对话', exact: true }).click()
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
    await page.getByTestId('resource-refresh').click()
    const selectedLastLines: number[] = []
    for (const file of files) {
      await openFile(page, file.filename)
      const frame = page.locator(`iframe[data-testid="office-editor"][title="${file.filename}"]`)
      await expect(frame).toHaveAttribute('data-document-ready', 'true', { timeout: OFFICE_READY_TIMEOUT_MS })
      const canvas = frame.contentFrame().locator('#qtcanvas')
      const bounds = await canvas.boundingBox()
      if (!bounds) throw new Error(`${file.filename} canvas bounds unavailable`)
      const x = bounds.x + bounds.width * WRITER_AUTOSCROLL_SELECTION_X_RATIO
      await page.mouse.move(x, bounds.y + bounds.height * WRITER_AUTOSCROLL_SELECTION_START_Y_RATIO)
      await page.mouse.down()
      await page.mouse.move(x, bounds.y + bounds.height - WRITER_AUTOSCROLL_EDGE_OFFSET_PX, { steps: 24 })
      await page.waitForTimeout(WRITER_AUTOSCROLL_REVERSE_HOLD_MS)
      if (file.reverse) {
        await page.mouse.move(x, bounds.y + bounds.height * WRITER_AUTOSCROLL_REVERSE_Y_RATIO, { steps: 24 })
        await page.waitForTimeout(WRITER_AUTOSCROLL_REVERSE_SETTLE_MS)
        await page.screenshot({ path: join(runtime.artifacts, 'office-docx-selection-autoscroll-reverse.png') })
      }
      await page.mouse.up()
      const menu = page.getByTestId('selection-action-host')
      await expect(menu).toBeVisible({ timeout: SELECTION_MENU_BUDGET_MS })
      await menu.getByRole('button', { name: '添加到对话', exact: true }).click()
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

test('real DOC selection autoscroll starts from the bottom line inside the workspace', async ({}, testInfo) => {
  test.skip(!OFFICE_CORPUS_ROOT, 'requires SCHOLARSEED_OFFICE_CORPUS with the real Office fixture corpus')
  const source = join(OFFICE_CORPUS_ROOT!, 'doc/poi-FloatingPictures.doc')
  test.skip(!existsSync(source), 'missing doc/poi-FloatingPictures.doc')
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
    const filename = 'selection-autoscroll.doc'
    copyFileSync(source, join(resources, filename))
    await page.getByTestId('resource-refresh').click()
    await openFile(page, filename)
    const frame = page.locator(`iframe[data-testid="office-editor"][title="${filename}"]`)
    await expect(frame).toHaveAttribute('data-document-ready', 'true', { timeout: OFFICE_READY_TIMEOUT_MS })
    const canvas = frame.contentFrame().locator('#qtcanvas')
    const bounds = await canvas.boundingBox()
    if (!bounds) throw new Error('DOC canvas bounds unavailable')
    const x = bounds.x + bounds.width * WRITER_AUTOSCROLL_SELECTION_X_RATIO
    await page.mouse.move(x, bounds.y + bounds.height * LEGACY_DOC_AUTOSCROLL_SELECTION_START_Y_RATIO)
    await page.mouse.down()
    await page.mouse.move(x, bounds.y + bounds.height - WRITER_AUTOSCROLL_EDGE_OFFSET_PX, { steps: 24 })
    const frameHashes: string[] = []
    for (let index = 0; index < SELECTION_AUTOSCROLL_FRAME_SAMPLES; index += 1) {
      await page.waitForTimeout(SELECTION_AUTOSCROLL_FRAME_SAMPLE_MS)
      const screenshot = await page.screenshot({
        path: join(runtime.artifacts, `office-doc-selection-autoscroll-frame-${index + 1}.png`)
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
    await expect(menu).toBeVisible({ timeout: LEGACY_DOC_SELECTION_MENU_TIMEOUT_MS })
    await menu.getByRole('button', { name: '添加到对话', exact: true }).click()
    await page.getByTestId('ai-context-ref').filter({ hasText: filename }).hover()
    const quote = page.getByTestId('assistant-selection-quote')
    await expect(quote).toContainText('Normal + Courier New, 12pt')
    await expect(quote).toContainText('This paragraph is indented.')
    await page.screenshot({ path: join(runtime.artifacts, 'office-doc-selection-autoscroll.png') })
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
    { name: 'selection-autoscroll.csv', bytes: csvRows.join('\n') + '\n', screenshot: 'office-csv-selection-autoscroll.png' },
    { name: 'selection-autoscroll.xlsx', bytes: largeSpreadsheetArchive(), screenshot: 'office-xlsx-selection-autoscroll.png' }
  ]
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    for (const file of files) {
      writeFileSync(join(resources, file.name), file.bytes)
      await page.getByTestId('resource-refresh').click()
      await openFile(page, file.name)
      const frame = page.locator(`iframe[data-testid="office-editor"][title="${file.name}"]`)
      await expect(frame).toHaveAttribute('data-document-ready', 'true', { timeout: OFFICE_READY_TIMEOUT_MS })
      const canvas = frame.contentFrame().locator('#qtcanvas')
      const bounds = await canvas.boundingBox()
      if (!bounds) throw new Error(`${file.name} canvas bounds unavailable`)
      const x = bounds.x + bounds.width * CALC_AUTOSCROLL_SELECTION_X_RATIO
      await page.mouse.move(x, bounds.y + bounds.height * CALC_AUTOSCROLL_SELECTION_START_Y_RATIO)
      await page.mouse.down()
      await page.mouse.move(x, bounds.y + bounds.height + SELECTION_AUTOSCROLL_OVERFLOW_PX, { steps: 24 })
      await page.waitForTimeout(SELECTION_AUTOSCROLL_HOLD_MS)
      await expect(page.getByTestId('selection-action-host')).toBeHidden()
      await page.mouse.up()

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

test('real XLS selection autoscroll follows the pointer beyond the workspace', async ({}, testInfo) => {
  test.skip(!OFFICE_CORPUS_ROOT, 'requires SCHOLARSEED_OFFICE_CORPUS with the real Office fixture corpus')
  const source = join(OFFICE_CORPUS_ROOT!, 'xls/sample-spreadsheet-100-rows.xls')
  test.skip(!existsSync(source), 'missing xls/sample-spreadsheet-100-rows.xls')
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
    const filename = 'selection-autoscroll.xls'
    copyFileSync(source, join(resources, filename))
    await page.getByTestId('resource-refresh').click()
    await openFile(page, filename)
    const frame = page.locator(`iframe[data-testid="office-editor"][title="${filename}"]`)
    await expect(frame).toHaveAttribute('data-document-ready', 'true', { timeout: OFFICE_READY_TIMEOUT_MS })
    const canvas = frame.contentFrame().locator('#qtcanvas')
    const bounds = await canvas.boundingBox()
    if (!bounds) throw new Error('XLS canvas bounds unavailable')
    const x = bounds.x + bounds.width * CALC_AUTOSCROLL_SELECTION_X_RATIO
    await page.mouse.move(x, bounds.y + bounds.height * CALC_AUTOSCROLL_SELECTION_START_Y_RATIO)
    await page.mouse.down()
    await page.mouse.move(x, bounds.y + bounds.height + SELECTION_AUTOSCROLL_OVERFLOW_PX, { steps: 24 })
    await page.waitForTimeout(SELECTION_AUTOSCROLL_HOLD_MS)
    await expect(page.getByTestId('selection-action-host')).toBeHidden()
    await page.mouse.up()

    const menu = page.getByTestId('selection-action-host')
    await expect(menu).toBeVisible({ timeout: CALC_SELECTION_MENU_TIMEOUT_MS })
    const range = /([A-Z]+)(\d+):([A-Z]+)(\d+)/.exec(await menu.innerText())
    expect(range, 'XLS selection range').not.toBeNull()
    expect(Number(range![4]), 'XLS selection end row').toBeGreaterThan(Number(range![2]))
    await page.screenshot({ path: join(runtime.artifacts, 'office-xls-selection-autoscroll.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('real DOC and DOCX selections present their action menu within budget', async ({}, testInfo) => {
  test.skip(!OFFICE_CORPUS_ROOT, 'requires SCHOLARSEED_OFFICE_CORPUS with the real Office fixture corpus')
  test.setTimeout(OFFICE_READY_TIMEOUT_MS * 2)
  const fixtures = [
    {
      relativePath: 'doc/poi-FloatingPictures.doc',
      screenshot: 'office-doc-cross-page-selection.png',
      crossPageDrag: true
    },
    {
      relativePath: 'docx/sample-document-large.docx',
      screenshot: 'office-docx-selection-performance.png',
      crossPageDrag: false
    }
  ] as const
  for (const fixture of fixtures) {
    test.skip(!existsSync(join(OFFICE_CORPUS_ROOT!, fixture.relativePath)), `missing ${fixture.relativePath}`)
  }
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  const diagnostics: OfficeDiagnostic[] = []
  try {
    const page = await desktop.launch()
    page.on('console', (message) => {
      const prefix = '[office-runtime] '
      if (!message.text().startsWith(prefix)) return
      diagnostics.push(JSON.parse(message.text().slice(prefix.length)) as OfficeDiagnostic)
    })
    const resources = await seedProject(page, runtime)
    for (const fixture of fixtures) {
      const filename = fixture.relativePath.split('/').pop()!
      copyFileSync(join(OFFICE_CORPUS_ROOT!, fixture.relativePath), join(resources, filename))
    }
    await page.getByTestId('resource-refresh').click()

    for (const fixture of fixtures) {
      const filename = fixture.relativePath.split('/').pop()!
      await openFile(page, filename)
      const frame = page.locator(`iframe[data-testid="office-editor"][title="${filename}"]`)
      await expect(frame).toHaveAttribute('data-document-ready', 'true', { timeout: OFFICE_READY_TIMEOUT_MS })
      const hostId = await frame.getAttribute('data-runtime-slot')
      const diagnosticsBeforeSelection = diagnostics.length
      const canvas = frame.contentFrame().locator('#qtcanvas')
      await canvas.click({ position: { x: 520, y: 300 } })
      if (fixture.crossPageDrag) {
        await canvas.hover()
        await page.mouse.wheel(0, DOC_CROSS_PAGE_SCROLL_DELTA)
        await page.waitForTimeout(OFFICE_PAINT_SETTLE_MS / 4)
      }
      let startedAt: number
      if (fixture.crossPageDrag) {
        const bounds = await canvas.boundingBox()
        if (!bounds) throw new Error('DOC canvas bounds unavailable')
        const x = bounds.x + bounds.width * DOC_CROSS_PAGE_SELECTION_X_RATIO
        await page.mouse.move(x, bounds.y + bounds.height * DOC_CROSS_PAGE_SELECTION_START_Y_RATIO)
        await page.mouse.down()
        await page.mouse.move(
          x,
          bounds.y + bounds.height * DOC_CROSS_PAGE_SELECTION_END_Y_RATIO,
          { steps: 24 }
        )
        await page.waitForTimeout(DOC_CROSS_PAGE_DRAG_HOLD_MS)
        await expect(page.getByTestId('selection-action-host')).toBeHidden()
        startedAt = Date.now()
        await page.mouse.up()
      }
      else {
        startedAt = Date.now()
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
      }
      const menu = page.getByTestId('selection-action-host')
      await expect(menu).toBeVisible({ timeout: SELECTION_MENU_BUDGET_MS })
      const elapsedMs = Date.now() - startedAt
      expect(elapsedMs).toBeLessThan(SELECTION_MENU_BUDGET_MS)
      await expect.poll(() => diagnostics.slice(diagnosticsBeforeSelection).find((item) => (
        item.hostId === hostId
        && item.stage === 'selection-extracted'
        && typeof item.extractionDurationMs === 'number'
      ))).toEqual(expect.objectContaining({ extractionDurationMs: expect.any(Number) }))
      if (!fixture.crossPageDrag) {
        await canvas.hover()
        await page.mouse.wheel(0, DOC_CROSS_PAGE_SCROLL_DELTA)
      }
      await page.waitForTimeout(OFFICE_PAINT_SETTLE_MS / 4)
      await page.screenshot({ path: join(runtime.artifacts, fixture.screenshot) })
      if (fixture.crossPageDrag) {
        await menu.getByRole('button', { name: '添加到对话', exact: true }).click()
        const reference = page.getByTestId('ai-context-ref').filter({ hasText: filename })
        await reference.hover()
        const quote = page.getByTestId('assistant-selection-quote')
        await expect(quote).toContainText('reader’s eye find the start of the next line.')
        await expect(quote).toContainText('Here is an example of')
      }
    }
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('large Calc AI actions use authoritative cell content', async ({}, testInfo) => {
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
    const filename = 'large-selection.xlsx'
    writeFileSync(join(resources, filename), largeSpreadsheetArchive())
    await page.getByTestId('resource-refresh').click()
    await openFile(page, filename)
    const frame = page.locator(`iframe[data-testid="office-editor"][title="${filename}"]`)
    await expect(frame).toHaveAttribute('data-document-ready', 'true', { timeout: OFFICE_READY_TIMEOUT_MS })
    await frame.contentFrame().locator('#qtcanvas').click({ position: { x: 120, y: 20 } })
    const menu = page.getByTestId('selection-action-host')
    await expect(menu).toBeVisible()
    const translationResponsePromise = page.waitForResponse(
      response => response.url().endsWith('/api/resource/ai/translate'),
      { timeout: OFFICE_READY_TIMEOUT_MS }
    )
    await menu.getByRole('button', { name: 'AI 翻译', exact: true }).click()
    const suggestion = page.getByTestId('resource-ai-suggestion')
    const translationResponse = await translationResponsePromise
    expect(translationResponse.status()).toBe(200)
    await expect.poll(async () => ({
      outputs: await suggestion.locator('.whitespace-pre-wrap').count(),
      alerts: await suggestion.getByRole('alert').count()
    }), { timeout: OFFICE_READY_TIMEOUT_MS }).not.toEqual({ outputs: 1, alerts: 0 })
    await expect(suggestion.getByRole('alert')).toHaveCount(0)
    await expect(suggestion.locator('.whitespace-pre-wrap')).toHaveCount(2, {
      timeout: OFFICE_READY_TIMEOUT_MS
    })
    await expect(suggestion.getByRole('button', { name: '复制', exact: true })).toBeEnabled({
      timeout: OFFICE_READY_TIMEOUT_MS
    })
    const output = suggestion.locator('.whitespace-pre-wrap').last()
    await expect(output).not.toHaveText(`${filename} · Results!B1:B1048576`)
    await expect(output).toContainText('private-1')
    await expect(output).toContainText('private-151')
    await expect(output).not.toContainText(filename)
    const translatedText = await output.innerText()
    await suggestion.getByRole('button', { name: '复制', exact: true }).click()
    await expect(suggestion).toBeVisible()
    await expect(suggestion.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
    await expect.poll(() => desktop.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(translatedText)
    await page.screenshot({ path: join(runtime.artifacts, 'large-calc-content-translation.png') })
    await suggestion.getByRole('button', { name: /关闭/ }).click()
    await frame.contentFrame().locator('#qtcanvas').click({ position: { x: 120, y: 20 } })
    await expect(menu).toBeVisible()
    await menu.getByRole('button', { name: 'AI 解释', exact: true }).click()
    const explanation = page.getByTestId('resource-ai-suggestion')
    const requirement = explanation.getByRole('textbox')
    await expect(requirement).toBeFocused()
    await requirement.fill('概括当前选区内容，并明确指出首个值和最后一个值')
    const responsePromise = page.waitForResponse(
      response => response.url().endsWith('/api/resource/ai/explain'),
      { timeout: OFFICE_READY_TIMEOUT_MS }
    )
    await explanation.getByRole('button', { name: '提交AI 解释', exact: true }).click()
    const response = await responsePromise
    expect(response.status()).toBe(200)
    await expect(explanation.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0, {
      timeout: OFFICE_READY_TIMEOUT_MS
    })
    await expect(explanation.getByRole('alert')).toHaveCount(0)
    await expect(explanation).toContainText('private-1', { timeout: OFFICE_READY_TIMEOUT_MS })
    await expect(explanation).toContainText('private-151', { timeout: OFFICE_READY_TIMEOUT_MS })
    const explanationOutput = explanation.locator('[data-radix-scroll-area-viewport]')
    const explainedText = await explanationOutput.innerText()
    await explanation.getByRole('button', { name: '复制', exact: true }).click()
    await expect(explanation).toBeVisible()
    await expect(explanation.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
    await expect.poll(() => desktop.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(explainedText)
    await page.screenshot({ path: join(runtime.artifacts, 'large-calc-content-explanation.png') })
    await explanation.getByRole('button', { name: /关闭/ }).click()
    await frame.contentFrame().locator('#qtcanvas').click({ position: { x: 120, y: 20 } })
    await expect(menu).toBeVisible()
    await menu.getByRole('button', { name: '添加到对话', exact: true }).click()
    await page.getByTestId('composer-input').fill('只根据已添加的表格选区，回复首个值和最后一个值，中间用逗号分隔。')
    await page.getByTestId('composer-send').click()
    await waitForFinishedTurn(page)
    const conversationAnswer = page.locator('.md-agent').last()
    await expect(conversationAnswer).toContainText('private-1', { timeout: OFFICE_READY_TIMEOUT_MS })
    await expect(conversationAnswer).toContainText('private-151', { timeout: OFFICE_READY_TIMEOUT_MS })
    await page.screenshot({ path: join(runtime.artifacts, 'large-calc-content-conversation.png') })
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
    await page.getByTestId('resource-refresh').click()
    await openFile(page, filename)
    const frame = page.locator(`iframe[data-testid="office-editor"][title="${filename}"]`)
    await expect(frame).toHaveAttribute('data-document-ready', 'true', { timeout: OFFICE_READY_TIMEOUT_MS })
    await frame.contentFrame().locator('#qtcanvas').click({ position: { x: 15, y: 92 } })
    const menu = page.getByTestId('selection-action-host')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('A5:J5')
    await menu.getByRole('button', { name: '添加到对话', exact: true }).click()
    const pendingSelection = page.getByTestId('ai-context-ref').filter({ hasText: `${filename} · 选区` })
    await pendingSelection.hover()
    const quote = page.getByTestId('assistant-selection-quote')
    await expect(quote).toContainText('PB-100004')
    await expect(quote).toContainText('792')
    await frame.contentFrame().locator('#qtcanvas').click({ position: { x: 15, y: 92 } })
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
