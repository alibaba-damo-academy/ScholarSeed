import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import { DesktopSession, apiBase } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const PDF_FIXTURE = resolve(__dirname, 'fixtures/data/minimal-project/sample.pdf')
const PAGE_SIZE = 50

test('home opens a recent PDF beyond the first literature page and reports a missing item', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { home: true, project: true, globalLib: true, pdf: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const base = await apiBase(page)
    const pdf = readFileSync(PDF_FIXTURE)
    const importPdf = async (name: string): Promise<string> => {
      const response = await page.request.post(`${base}/api/v1/imports/pdf`, {
        multipart: { file: { name, mimeType: 'application/pdf', buffer: pdf } }
      })
      expect(response.ok(), await response.text()).toBe(true)
      return (await response.json()).id as string
    }
    const oldestId = await importPdf('oldest-acceptance.pdf')
    await page.reload()
    await page.getByTestId('activity-literature').click()
    const oldest = page.locator('.lit-row').filter({ hasText: 'oldest-acceptance' }).first()
    await expect(oldest).toBeVisible()
    await oldest.click()
    await page.getByRole('button', { name: '打开', exact: true }).click()
    await expect(page.getByTestId('pdf-document')).toBeVisible()

    for (let index = 0; index < PAGE_SIZE; index += 1) {
      await importPdf(`new-${String(index).padStart(2, '0')}.pdf`)
    }
    const firstPage = await page.request.get(`${base}/api/v1/literatures?page_size=${PAGE_SIZE}`)
    expect(firstPage.ok(), await firstPage.text()).toBe(true)
    const listing = await firstPage.json() as { items: Array<{ id: string }> }
    expect(listing.items).toHaveLength(PAGE_SIZE)
    expect(listing.items.some((item) => item.id === oldestId)).toBe(false)

    await page.reload()
    await page.getByTestId('activity-home').click()
    const recent = page.getByTestId(`home-recent-literature-${oldestId}`)
    await expect(recent).toBeVisible()
    await recent.click()
    await expect(page.getByTestId('pdf-document')).toBeVisible()
    await expect(page.getByTestId('pdf-page-1')).toBeVisible()
    await expect(page.getByText('正在载入 PDF...')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('recent-older-pdf-open.png') })

    await page.getByTestId('activity-home').click()
    await expect(recent).toBeVisible()
    const deleted = await page.request.post(`${base}/api/v1/literatures/bulk-delete`, {
      data: { literature_ids: [oldestId] }
    })
    expect(deleted.ok(), await deleted.text()).toBe(true)
    await recent.click()
    await expect(page.getByText('文献或附件暂不可打开，请在文献库中检查。')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('recent-missing-pdf-error.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
