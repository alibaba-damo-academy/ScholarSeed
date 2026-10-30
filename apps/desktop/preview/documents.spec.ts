import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewScenario, previewSurface, expect, test, type Page } from './testing'
import { PREVIEW_CATALOG } from './catalog'
import { previewConsumption } from './coverage'
import { PREVIEW_DOCUMENTS } from './documents'
import { PREVIEW_CONTENT } from './content'

const MODES = ['pending', 'failed', 'retry'] as const

async function selectDocument(page: Page, pageId: string, sceneId: string): Promise<void> {
  const entry = PREVIEW_CATALOG.find(candidate => candidate.id === pageId)!
  const scene = entry.scenarios.find(candidate => candidate.id === sceneId)!
  await page.keyboard.press('F8')

  await openPreviewScenario(page, entry.id, scene.id, true)
  await expect(page.getByRole('heading', { name: 'PDFE 工作台', exact: true })).toBeVisible()
}

async function expectDocument(page: Page, viewer: 'markdown' | 'pdf'): Promise<void> {
  if (viewer === 'markdown') await expect(previewSurface(page).getByRole('heading', { name: 'Minimal Project', exact: true })).toBeVisible()
  else await expect(previewSurface(page).getByTestId('pdf-page-1').locator('canvas')).toBeVisible()
  await expect(previewSurface(page).getByTestId('document-load-error')).toHaveCount(0)
}

for (const viewer of ['markdown', 'pdf'] as const) {
  for (const mode of MODES) {
    const pageId = `viewer-${viewer}`
    const sceneId = `${pageId}-${mode}`
    const states = mode === 'pending' ? ['loading', 'loaded'] : mode === 'failed' ? ['error', 'retry-failed', 'recovered'] : ['error', 'retried', 'loaded']
    test(`${sceneId} consumes content policy through the real Console and document retry`, { annotation: previewConsumption(pageId, sceneId, states) }, async ({ page }, testInfo) => {
      const sample = PREVIEW_DOCUMENTS.find(document => document.viewer === viewer)!
      const responses: { path: string; status: number }[] = []
      const failures: { path: string; status: number }[] = []
      page.on('response', response => {
        const url = new URL(response.url())
        if (response.request().method() === 'GET' && url.pathname === '/api/workbench/content' && url.searchParams.get('path') === sample.path) responses.push({ path: url.pathname, status: response.status() })
        if (url.pathname.startsWith('/api/') && response.status() >= 400) failures.push({ path: url.pathname, status: response.status() })
      })
      try {
        await page.goto(`/?previewInstance=${randomUUID()}&scene=page-home`)
        const pendingContent = mode === 'pending' ? page.waitForRequest(request => request.method() === 'GET' && new URL(request.url()).pathname === '/api/workbench/content' && new URL(request.url()).searchParams.get('path') === sample.path) : undefined
        await selectDocument(page, pageId, sceneId)
        if (mode === 'pending') {
          await pendingContent
          await expect(previewSurface(page).getByTestId('progress-screen')).toBeVisible()
          await expect(previewSurface(page).getByTestId('progress-screen')).toHaveAttribute('aria-busy', 'true')
          if (viewer === 'markdown') await expect(previewSurface(page).getByRole('heading', { name: 'Minimal Project', exact: true })).toHaveCount(0)
          else await expect(previewSurface(page).getByTestId('pdf-page-1').locator('canvas')).toHaveCount(0)
          expect(responses).toEqual([])
          await page.screenshot({ path: testInfo.outputPath('document-loading.png'), fullPage: true })
          expect(responses).toEqual([])
          await expectDocument(page, viewer)
          await expect(previewSurface(page).getByTestId('progress-screen')).toHaveCount(0)
          expect(responses.length).toBeGreaterThan(0)
          expect(responses.every(response => response.status === 200)).toBe(true)
          await page.screenshot({ path: testInfo.outputPath('document-loaded.png'), fullPage: true })
        } else {
          const error = previewSurface(page).getByTestId('document-load-error')
          await expect(error).toBeVisible()
          await expect(error).toContainText('preview_content_unavailable')
          const retry = previewSurface(page).getByTestId('document-load-retry')
          await expect(retry).toBeEnabled()
          expect(responses.map(response => response.status)).toEqual([503])
          await page.screenshot({ path: testInfo.outputPath('document-read-failed.png'), fullPage: true })
          expect(responses.map(response => response.status)).toEqual([503])
          const retried = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workbench/content' && new URL(response.url()).searchParams.get('path') === sample.path)
          await retry.click()
          await retried
          if (mode === 'retry') {
            await expectDocument(page, viewer)
            expect(responses.map(response => response.status)).toEqual([503, 200])
            await page.screenshot({ path: testInfo.outputPath('document-retry-recovered.png'), fullPage: true })
          } else {
            await expect(error).toBeVisible()
            await expect(retry).toBeEnabled()
            expect(responses.map(response => response.status)).toEqual([503, 503])
            await page.screenshot({ path: testInfo.outputPath('document-retry-failed.png'), fullPage: true })
            const currentUrl = page.url()
            await page.keyboard.press('F8')
            const recovery = page.waitForResponse(response => new URL(response.url()).pathname === PREVIEW_CONTENT.recoveryPath && response.request().method() === 'POST')
            await page.getByTestId('preview-content-recover').click()
            expect((await recovery).status()).toBe(200)
            expect(page.url()).toBe(currentUrl)
            await page.getByRole('button', { name: '关闭预览控制台', exact: true }).click()
            await retry.click()
            await expectDocument(page, viewer)
            expect(responses.map(response => response.status)).toEqual([503, 503, 200])
            await page.screenshot({ path: testInfo.outputPath('document-normal-scene-recovered.png'), fullPage: true })
          }
        }
        expect(failures.every(failure => failure.path === '/api/workbench/content' && failure.status === 503)).toBe(true)
        if (mode === 'pending') expect(failures).toEqual([])
      } finally {
        const path = testInfo.outputPath('document-http-summary.json')
        await writeFile(path, JSON.stringify({ responses, failures }, null, 2))
        await testInfo.attach('document-http-summary', { path, contentType: 'application/json' })
      }
    })
  }
}
