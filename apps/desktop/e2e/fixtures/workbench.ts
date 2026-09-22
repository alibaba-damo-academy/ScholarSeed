import { createHash } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, relative } from 'path'
import { expect, type Page } from '@playwright/test'
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { apiBase, enterWorkbenchShell } from './electron'
import type { RuntimePaths } from './runtime'

export const SOURCE_CASES = [
  ['py', 'python', 'def answer():\n    return 42\n'],
  ['R', 'r', 'answer <- function() {\n  return(42)\n}\n'],
  ['js', 'javascript', 'function answer() {\n  return 42;\n}\n'],
  ['ts', 'typescript', 'function answer(): number {\n  return 42;\n}\n'],
  ['java', 'java', 'class Answer {\n  int value = 42;\n}\n'],
  ['c', 'c', 'int answer() {\n  return 42;\n}\n'],
  ['cpp', 'cpp', 'int answer() {\n  return 42;\n}\n'],
  ['h', 'cpp', 'int answer();\n'],
  ['sh', 'shell', '#!/bin/sh\necho "answer"\n'],
  ['json', 'json', '{\n  "answer": 42\n}\n'],
  ['yaml', 'yaml', 'answer:\n  value: 42\n'],
  ['yml', 'yaml', 'answer:\n  value: 42\n'],
  ['toml', 'toml', '[answer]\nvalue = 42\n'],
  ['xml', 'xml', '<answer>\n  <value>42</value>\n</answer>\n'],
  ['txt', 'plaintext', 'plain answer 42\n'],
  ['log', 'plaintext', 'INFO answer 42\n']
] as const
export const MARKDOWN_SOURCE = '# Acceptance document\n\nOriginal needle paragraph.\n\n## Fold section\n\nA durable paragraph.\n'
export const PDF_NAME = 'acceptance.pdf'
export const SECOND_PDF_NAME = 'focus.pdf'
export const LONG_PDF_NAME = 'long-paper.pdf'
export const BROKEN_PDF_NAME = 'preview_pdf_1MB.pdf'
export const NOTE_TEXT = 'Persistent acceptance note'
export const PDF_LONG_OUTLINE_TITLE = 'Level 1 with a deliberately long title that must remain on one line'
export const PDF_LONG_UNAVAILABLE_OUTLINE_TITLE = 'Level 2 unavailable with a deliberately long title that still needs a tooltip'
const PROJECT_NAME = 'Library acceptance'
const ACTION_TIMEOUT_MS = 15_000
const PDF_PAGE_COUNT = 3
const LONG_PDF_PAGE_COUNT = 86
const PDF_PAGE_SIZE: [number, number] = [612, 792]

function addThreeLevelOutline(pdf: PDFDocument): void {
  const [firstPage, , thirdPage] = pdf.getPages()
  const rootRef = pdf.context.nextRef()
  const firstRef = pdf.context.nextRef()
  const secondRef = pdf.context.nextRef()
  const thirdRef = pdf.context.nextRef()
  pdf.context.assign(rootRef, pdf.context.obj({
    Type: PDFName.of('Outlines'), First: firstRef, Last: firstRef, Count: 3
  }))
  pdf.context.assign(firstRef, pdf.context.obj({
    Title: PDFString.of(PDF_LONG_OUTLINE_TITLE), Parent: rootRef,
    Dest: pdf.context.obj([firstPage.ref, PDFName.of('Fit')]),
    First: secondRef, Last: secondRef, Count: 2
  }))
  pdf.context.assign(secondRef, pdf.context.obj({
    Title: PDFString.of(PDF_LONG_UNAVAILABLE_OUTLINE_TITLE), Parent: firstRef,
    First: thirdRef, Last: thirdRef, Count: 1
  }))
  pdf.context.assign(thirdRef, pdf.context.obj({
    Title: PDFString.of('Level 3'), Parent: secondRef,
    Dest: pdf.context.obj([thirdPage.ref, PDFName.of('Fit')])
  }))
  pdf.catalog.set(PDFName.of('Outlines'), rootRef)
}

export async function seedProject(page: Page, runtime: RuntimePaths): Promise<string> {
  page.setDefaultTimeout(ACTION_TIMEOUT_MS)
  const response = await page.request.post(`${await apiBase(page)}/api/content/projects`, { data: { name: PROJECT_NAME } })
  expect(response.ok(), await response.text()).toBe(true)
  const project = await response.json() as { root: string }
  expect(relative(runtime.workspace, project.root).startsWith('..')).toBe(false)
  const resources = join(project.root, 'resources')
  mkdirSync(resources, { recursive: true })
  writeFileSync(join(resources, 'acceptance.md'), MARKDOWN_SOURCE)
  for (const [suffix, , source] of SOURCE_CASES) writeFileSync(join(resources, `source.${suffix}`), source)
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let index = 1; index <= PDF_PAGE_COUNT; index += 1) {
    const sheet = pdf.addPage(PDF_PAGE_SIZE)
    sheet.drawText(`Evidence page ${index}`, { x: 72, y: 720, size: 22, font })
    sheet.drawText(`Needle marker ${index} searchable selectable text.`, { x: 72, y: 660, size: 16, font })
    if (index === 1) {
      sheet.drawText("Repeated page occurrence", { x: 72, y: 570, size: 16, font })
      sheet.drawText("Repeated page occurrence", { x: 72, y: 110, size: 16, font })
    }
  }
  addThreeLevelOutline(pdf)
  const pdfBytes = await pdf.save()
  writeFileSync(join(resources, PDF_NAME), pdfBytes)
  writeFileSync(join(resources, SECOND_PDF_NAME), pdfBytes)
  writeFileSync(
    join(resources, BROKEN_PDF_NAME),
    readFileSync(join(__dirname, 'preview_pdf_1MB.pdf'))
  )
  const images = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1600
    canvas.height = 1200
    const context = canvas.getContext('2d')!
    context.fillStyle = '#126b82'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#fff'
    context.font = '80px sans-serif'
    context.fillText('Acceptance image', 120, 220)
    return Object.fromEntries(['image/png', 'image/jpeg', 'image/webp'].map(mime => [mime, canvas.toDataURL(mime).split(',')[1]]))
  })
  for (const [suffix, mime] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']]) {
    writeFileSync(join(resources, `acceptance.${suffix}`), Buffer.from(images[mime], 'base64'))
  }
  writeFileSync(join(resources, 'acceptance.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><rect width="1600" height="1200" fill="#126b82"/><text x="120" y="220" fill="white" font-size="80">Acceptance SVG</text></svg>')
  writeFileSync(join(resources, 'acceptance.gif'), Buffer.from('R0lGODlhAQABAIAAAAD/AP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7', 'base64'))
  await page.reload()
  await enterWorkbenchShell(page)
  await selectProject(page)
  await page.getByTestId('resource-refresh').click()
  return resources
}

export async function seedLongPdf(resources: string): Promise<void> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let index = 1; index <= LONG_PDF_PAGE_COUNT; index += 1) {
    const sheet = pdf.addPage(PDF_PAGE_SIZE)
    sheet.drawText(`Long paper page ${index}`, { x: 72, y: 720, size: 22, font })
    sheet.drawText(`Lifecycle evidence ${index}.`, { x: 72, y: 660, size: 16, font })
  }
  writeFileSync(join(resources, LONG_PDF_NAME), await pdf.save())
}

export async function selectProject(page: Page): Promise<void> {
  page.setDefaultTimeout(ACTION_TIMEOUT_MS)
  await page.getByTestId('topbar-project').click()
  await page.getByTestId(`project-menu-option-${PROJECT_NAME}`).click()
  await page.getByTestId('activity-resource').click()
}

export async function openFile(page: Page, name: string): Promise<void> {
  await page.getByTestId(`tree-resources/${name}`).click()
}

export function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Select rendered PDF text using the same pointer gesture a reader uses. */
export async function selectPdfText(page: Page, pageNumber = 1): Promise<string> {
  const text = page.getByTestId(`pdf-page-${pageNumber}`).locator('.textLayer span').filter({ hasText: 'Needle marker' }).first()
  await expect(text).toBeVisible()
  const box = await text.boundingBox()
  if (!box) throw new Error('PDF text layer has no visible bounds')
  await page.mouse.move(box.x + 1, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 15 })
  await page.mouse.up()
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  expect(selected).toContain('Needle')
  return selected
}
