import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'

import { DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { openProjectExplorer } from './fixtures/projects'
import { openFile, seedProject } from './fixtures/workbench'

const REPO = resolve(__dirname, '../../..')
const MARKER = 'Office removal acceptance'
const SAVED_CELL = 'Saved without Office WASM'

test('Office removal preserves modern previews, legacy fallback and CSV save through Desktop', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, { nativeWindowLifecycle: true })
  const officeRequests: string[] = []
  try {
    const page = await desktop.launch()
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/office/')) officeRequests.push(request.url())
    })
    const resources = await seedProject(page, runtime)
    const python = join(REPO, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    execFileSync(python, ['-c', [
      'import sys',
      'from pathlib import Path',
      'from docx import Document',
      'from pptx import Presentation',
      'from openpyxl import Workbook',
      'from reportlab.pdfgen import canvas',
      'from reportlab.pdfbase import pdfmetrics',
      'from reportlab.pdfbase.cidfonts import UnicodeCIDFont',
      'root=Path(sys.argv[1])',
      'marker=sys.argv[2]',
      'doc=Document()',
      'doc.add_paragraph(marker)',
      'doc.save(root / "removal.docx")',
      'slides=Presentation()',
      'slide=slides.slides.add_slide(slides.slide_layouts[0])',
      'slide.shapes.title.text=marker',
      'slides.save(root / "removal.pptx")',
      'book=Workbook()',
      'book.active.append([marker, 42])',
      'book.save(root / "removal.xlsx")',
      'pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))',
      'pdf=canvas.Canvas(str(root / "retained-cjk.pdf"))',
      'pdf.setFont("STSong-Light", 24)',
      'pdf.drawString(72, 720, "中文预览保留")',
      'pdf.save()',
    ].join('\n'), resources, MARKER])
    const modern = ['removal.docx', 'removal.pptx', 'removal.xlsx']
    const originals = modern.map(name => readFileSync(join(resources, name)))
    copyFileSync(join(__dirname, 'fixtures/office-corpus/doc/selection-multipage.doc'), join(resources, 'legacy.doc'))
    copyFileSync(join(__dirname, 'fixtures/office-corpus/xls/selection-100-rows.xls'), join(resources, 'legacy.xls'))
    writeFileSync(join(resources, 'removal.csv'), 'Name,Value\nOriginal,42\n')
    await openProjectExplorer(page)
    await page.getByTestId('explorer-refresh').click()
    for (const name of modern) {
      await openFile(page, name)
      const preview = page.getByTestId('office-preview')
      await expect(preview).toBeVisible()
      await expect(preview).toContainText(MARKER)
      await expect(page.getByTestId('document-save')).toHaveCount(0)
      await expect(page.locator('iframe[data-testid="office-editor"]')).toHaveCount(0)
      await page.screenshot({ path: join(runtime.artifacts, `${name}.png`) })
    }
    modern.forEach((name, index) => expect(readFileSync(join(resources, name))).toEqual(originals[index]))
    for (const name of ['legacy.doc', 'legacy.xls']) {
      await openFile(page, name)
      const fallback = page.getByTestId('office-unavailable')
      await expect(fallback).toBeVisible()
      await expect(fallback.getByRole('button')).toHaveCount(2)
      await page.screenshot({ path: join(runtime.artifacts, `${name}-fallback.png`) })
    }
    await openFile(page, 'removal.csv')
    const grid = page.getByTestId('csv-grid')
    const cell = grid.locator('[data-cell="A2"]')
    await expect(cell).toHaveText('Original')
    await cell.dblclick()
    const editor = page.getByTestId('csv-cell-editor')
    await editor.fill(SAVED_CELL)
    await editor.press('Enter')
    await expect(cell).toHaveText(SAVED_CELL)
    await page.getByTestId('document-save').click()
    await expect.poll(() => readFileSync(join(resources, 'removal.csv'), 'utf8')).toContain(SAVED_CELL)
    await expect(page.getByTestId('document-save')).toBeDisabled()
    await page.screenshot({ path: join(runtime.artifacts, 'csv-saved.png') })
    await openFile(page, 'retained-cjk.pdf')
    await expect(page.getByTestId('pdf-document')).toBeVisible()
    await expect(page.locator('.textLayer')).toContainText('中文预览保留')
    // Exercise the retained PDF font with Chromium's real loader, not a mocked FontFace.
    expect(await page.evaluate(async () => {
      const url = new URL('fonts/NotoSansCJKsc-Regular.otf', document.baseURI).href
      const face = await new FontFace('RetainedPdfCjkAcceptance', `url(${JSON.stringify(url)})`).load()
      return face.status
    })).toBe('loaded')
    await page.screenshot({ path: join(runtime.artifacts, 'retained-cjk-pdf.png') })
    expect(officeRequests).toEqual([])
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
    await desktop.close()
  }
})
