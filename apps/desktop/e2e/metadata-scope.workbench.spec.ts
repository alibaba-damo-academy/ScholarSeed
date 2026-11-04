import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import { DesktopSession, apiBase, enterWorkbenchShell } from './fixtures/electron'
import { createReadyProject, openLiteratureScope } from './fixtures/projects'
import { createRuntime } from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const QUEUE_SIZE = 40
const RESULT_TIMEOUT_MS = 120_000
const SOURCE_PROJECT = 'Metadata source'
const OTHER_PROJECT = 'Metadata other'
const EMPTY_PROJECT = 'Metadata empty'

const CONFLICT_MESSAGE = '其他项目或文献中心正在同步元数据，请返回发起位置查看进度，完成后再试。'

async function selectLibrary(page: Page, project?: string): Promise<void> {
  await openLiteratureScope(page, project)
}

for (const scope of ['project', 'global'] as const) {
  test(`metadata ${scope} batch remains owned while switching projects`, async ({}, testInfo) => {
    const runtime = createRuntime(testInfo)
    const preferencesPath = join(runtime.userData, 'renderer-preferences.json')
    const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'))
    writeFileSync(
      preferencesPath,
      JSON.stringify({ ...preferences, theme: scope === 'global' ? 'dark' : 'light' })
    )
    const desktop = new DesktopSession(runtime, testInfo)
    const EVIDENCE_ROOT = runtime.artifacts
    try {
      const page = await desktop.launch()
      if (scope === 'global') {
        await desktop.app!.evaluate(({ BrowserWindow }, url) => {
          const window = BrowserWindow.getAllWindows().find(
            (candidate) => candidate.webContents.getURL() === url
          )
          if (!window) throw new Error('Metadata acceptance window not found')
          window.setContentSize(1040, 660)
        }, page.url())
      }
      const base = await apiBase(page)
      const source = await createReadyProject(page, SOURCE_PROJECT)
      const other = await createReadyProject(page, OTHER_PROJECT)
      await createReadyProject(page, EMPTY_PROJECT)
      const bibliography = Array.from(
        { length: QUEUE_SIZE },
        (_, index) =>
          `@article{queued${index},title={Metadata queue ${String(index).padStart(3, '0')}},author={Researcher}}`
      ).join('\n')
      const importUrl = `${base}/api/v1/imports/bibliography${scope === 'project' ? `?project_id=${source.id}` : ''}`
      const imported = await page.request.post(importUrl, {
        multipart: {
          files: {
            name: 'scope.bib',
            mimeType: 'application/x-bibtex',
            buffer: Buffer.from(bibliography),
          },
        },
      })
      expect(imported.ok(), await imported.text()).toBe(true)
      const identifiedImport = await page.request.post(importUrl, {
        multipart: {
          files: {
            name: 'identified.bib',
            mimeType: 'application/x-bibtex',
            buffer: Buffer.from(
              '@misc{identified,title={Metadata identified paper},eprint={1706.03762}}'
            ),
          },
        },
      })
      expect(identifiedImport.ok(), await identifiedImport.text()).toBe(true)
      const identified = (await identifiedImport.json()).items[0]
      expect(identified).toBeTruthy()
      const otherImport = await page.request.post(
        `${base}/api/v1/imports/bibliography?project_id=${other.id}`,
        {
          multipart: {
            files: {
              name: 'other.bib',
              mimeType: 'application/x-bibtex',
              buffer: Buffer.from(
                '@article{other,title={Other project paper},author={Researcher}}'
              ),
            },
          },
        }
      )
      expect(otherImport.ok(), await otherImport.text()).toBe(true)
      await page.reload()
      await enterWorkbenchShell(page)
      await selectLibrary(page, scope === 'project' ? SOURCE_PROJECT : undefined)
      await expect(page.locator('.lit-row:visible').first()).toBeVisible()
      await page.locator('.lit-table-head:visible').getByRole('button', { name: '标题', exact: true }).click()
      await expect(page.locator('.lit-row:visible').first()).toContainText('Metadata identified paper')
      await page.locator('.lit-table-head:visible').getByRole('checkbox').check()
      await expect(page.getByText(`已选 ${QUEUE_SIZE + (scope === 'global' ? 2 : 1)} 篇`, { exact: true })).toBeVisible()
      await page.locator('.lit-table-head:visible').getByRole('checkbox').check()
      const metadataResponse = page.waitForResponse((response) =>
        response.url().endsWith('/api/literature/papermeta')
      )
      await page.getByRole('button', { name: '同步元数据', exact: true }).click()
      const dialog = page
        .getByRole('dialog')
        .filter({ has: page.getByRole('heading', { name: '同步元数据', exact: true }) })
      await expect(dialog).toBeVisible()
      expect((await metadataResponse).ok()).toBe(true)
      const detailQuery = scope === 'project' ? `?project_id=${source.id}` : ''
      await expect
        .poll(
          async () => {
            const detail = await page.request.get(
              `${base}/api/v1/literatures/${identified.id}${detailQuery}`
            )
            return (await detail.json()).title
          },
          { timeout: RESULT_TIMEOUT_MS }
        )
        .toBe('Attention Is All You Need')
      await dialog
        .locator('.vds-dialog__footer')
        .getByRole('button', { name: '关闭', exact: true })
        .click()

      await selectLibrary(page, EMPTY_PROJECT)
      await expect(page.locator('.lit-row:visible')).toHaveCount(0)
      await expect(page.getByText('暂无文献', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '同步进度', exact: true })).toHaveCount(0)
      await expect(dialog).toHaveCount(0)
      await page.screenshot({ path: join(EVIDENCE_ROOT, `${scope}-empty-other.png`) })

      await selectLibrary(page, OTHER_PROJECT)
      await expect(page.locator('.lit-row:visible')).toHaveCount(1)
      await page.locator('.lit-table-head:visible').getByRole('checkbox').check()
      await page.getByRole('button', { name: '同步元数据', exact: true }).click()
      await expect(page.getByText(CONFLICT_MESSAGE)).toBeVisible()
      await expect(dialog).toHaveCount(0)
      await page.screenshot({ path: join(EVIDENCE_ROOT, `${scope}-conflict.png`) })

      if (scope === 'project') {
        await selectLibrary(page)
        await expect(page.getByRole('button', { name: '同步进度', exact: true })).toHaveCount(0)
      }
      await selectLibrary(page, scope === 'project' ? SOURCE_PROJECT : undefined)
      await expect(dialog).toHaveCount(0)
      await page.getByRole('button', { name: '同步进度', exact: true }).click()
      await expect(dialog).toContainText('Metadata identified paper')
      await dialog.getByRole('button', { name: '停止同步', exact: true }).click()
      await expect(dialog.getByRole('button', { name: '停止同步', exact: true })).toHaveCount(0, {
        timeout: RESULT_TIMEOUT_MS,
      })
      await expect(dialog).toContainText(/已取消: [1-9]/)
      await page.screenshot({ path: join(EVIDENCE_ROOT, `${scope}-source-cancelled.png`) })
      await dialog.getByRole('button', { name: '重试失败和未完成项', exact: true }).click()
      await expect(dialog.getByRole('button', { name: '停止同步', exact: true })).toHaveCount(0, {
        timeout: RESULT_TIMEOUT_MS,
      })
      await expect(dialog).toContainText('已取消: 0')
      await expect(dialog).toContainText('成功: 1')
      await page.screenshot({ path: join(EVIDENCE_ROOT, `${scope}-source-completed.png`) })
      await dialog
        .locator('.vds-dialog__footer')
        .getByRole('button', { name: '关闭', exact: true })
        .click()
      await selectLibrary(page, EMPTY_PROJECT)
      await expect(page.getByRole('button', { name: '同步结果', exact: true })).toHaveCount(0)
      await selectLibrary(page, OTHER_PROJECT)
      await page.locator('.lit-table-head:visible').getByRole('checkbox').check()
      await page.getByRole('button', { name: '同步元数据', exact: true }).click()
      await expect(dialog).toContainText('Other project paper')
      await expect(dialog.getByRole('button', { name: '停止同步', exact: true })).toHaveCount(0, {
        timeout: RESULT_TIMEOUT_MS,
      })
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
    }
  })
}
