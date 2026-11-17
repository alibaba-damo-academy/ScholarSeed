import { createHash } from 'node:crypto'
import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import { renderFixture } from '../../../../test-helpers/render.ts'
import type { OpenDocumentResult } from '../../contracts/workbench.ts'
import { IMAGE_PERCENT } from '../../components/primitive/geometry.ts'
import { createLocalization } from '../../../../localization/engine.ts'
import uiZh from '../../../../localization/locales/zh/ui.json' with { type: 'json' }

const translate = createLocalization(
  'zh',
  { zh: { ui: uiZh } },
  { report: () => undefined }
).getFixedT('zh', 'ui')

const IMAGE_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8XkAAAAASUVORK5CYII=',
  'base64'
)

function previewProjection(
  bytes: Uint8Array,
  viewer: 'image' | 'pdf'
): Pick<
  OpenDocumentResult,
  'viewer' | 'processor' | 'content_kind' | 'capabilities' | 'media_type' | 'size' | 'revision'
> {
  return {
    viewer,
    processor: null,
    content_kind: 'binary',
    capabilities: {
      can_preview: true,
      can_edit: false,
      can_select: false,
      can_annotate: false,
      can_save: false,
      can_version: false,
      can_diff: false,
      pending: [],
    },
    media_type: viewer === 'pdf' ? 'application/pdf' : 'image/png',
    size: bytes.byteLength,
    revision: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  }
}

test('PDF card renders the authorized first page and delegates opening', async (context) => {
  const document = await PDFDocument.create()
  document.addPage([400, 600])
  document.addPage([800, 400])
  const bytes = await document.save()
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'), {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.route('**/api/serve/sessions/fixture/artifacts/document/open', (route) =>
    route.fulfill({ json: previewProjection(bytes, 'pdf') })
  )
  await page.route('**/api/serve/sessions/fixture/artifacts/document/raw', (route) =>
    route.fulfill({ contentType: 'application/pdf', body: Buffer.from(bytes) })
  )
  await page.goto(`${fixture.url}features/assistant/PdfPreview.render.fixture.html`)
  const preview = page.getByRole('button', { name: '打开 document.pdf' })
  const canvas = preview.locator('canvas')
  await expect(canvas).toBeVisible()
  await expect(canvas).toHaveAttribute('width', '200')
  await expect(canvas).toHaveAttribute('height', '300')
  await preview.click()
  await expect(page.getByTestId('opened')).toHaveText('true')
  await page.goto(`${fixture.url}features/assistant/PdfPreview.render.fixture.html?sha256=wrong`)
  await expect(preview.getByRole('status')).toContainText('无法读取')
  await expect(page.locator('canvas')).toBeHidden()
})

for (const misnamed of [false, true]) {
  test(`PDF and images share thumbnail layout while opening through different viewers: conflicting suffixes ${misnamed}`, async (context) => {
    const document = await PDFDocument.create()
    document.addPage([400, 600])
    const bytes = await document.save()
    const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'), {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    await page.route('**/api/serve/sessions/fixture/artifacts/*/open', (route) =>
      route.fulfill({
        json: route.request().url().includes('/document/')
          ? previewProjection(bytes, 'pdf')
          : previewProjection(IMAGE_BYTES, 'image'),
      })
    )
    await page.route('**/api/serve/sessions/fixture/artifacts/*/raw', (route) =>
      route.request().url().includes('/document/')
        ? route.fulfill({ contentType: 'application/pdf', body: Buffer.from(bytes) })
        : route.fulfill({
            contentType: 'image/png',
            body: IMAGE_BYTES,
          })
    )
    await page.goto(
      `${fixture.url}features/assistant/PdfPreview.render.fixture.html?mixed${misnamed ? '&misnamed' : ''}`
    )
    const group = page.locator('[data-slot="conversation-images-viewport"]')
    const first = group.getByRole('button', {
      name: misnamed ? 'plot.pdf' : 'first.png',
      exact: true,
    })
    const pdf = group.getByRole('button', {
      name: misnamed ? '打开 report.png' : '打开 document.pdf',
      exact: true,
    })
    const last = group.getByRole('button', { name: 'last.png', exact: true })
    await expect(pdf.locator('canvas')).toBeVisible()
    await expect(pdf.locator('canvas')).toHaveCSS('object-fit', 'contain')
    const bounds = await Promise.all([first, pdf, last].map((item) => item.boundingBox()))
    assert.ok(bounds.every(Boolean))
    assert.equal(bounds[0]!.y, bounds[1]!.y)
    assert.equal(bounds[1]!.y, bounds[2]!.y)
    assert.ok(bounds[0]!.x < bounds[1]!.x && bounds[1]!.x < bounds[2]!.x)
    await pdf.click()
    await expect(page.getByTestId('opened')).toHaveText('true')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await first.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const assertPosition = async (index: number, name: string): Promise<void> => {
      const image = dialog.getByRole('img', { name, exact: true })
      await expect(image).toBeVisible()
      const zoom = await image.evaluate((element, percent) => {
        const transform = new DOMMatrixReadOnly(getComputedStyle(element).transform)
        return Math.round(Math.hypot(transform.a, transform.b) * percent)
      }, IMAGE_PERCENT)
      await expect(dialog.locator('output')).toHaveText(
        translate('imagePreview.position', {
          index,
          count: 2,
          zoom,
        })
      )
    }
    await assertPosition(1, misnamed ? 'plot.pdf' : 'first.png')
    await dialog.getByRole('button', { name: translate('imagePreview.next'), exact: true }).click()
    await expect(dialog.getByRole('heading', { name: 'last.png', exact: true })).toBeVisible()
    await assertPosition(2, 'last.png')
  })
}
