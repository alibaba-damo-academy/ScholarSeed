import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test, type Locator } from '@playwright/test'

import { DesktopSession, apiBase, enterWorkbenchShell } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { createReadyProject, openLiteratureScope } from './fixtures/projects'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const ENTRY_COUNT = 362
const SMALL_ENTRY_COUNT = 2
const PROJECT_NAME = 'Metadata batch acceptance'

const WINDOW_SIZES = [
  [1400, 900],
  [1040, 660],
] as const
const GEOMETRY_TOLERANCE = 1
const RESULT_TIMEOUT_MS = 30_000

async function assertScrollBoundary(dialog: Locator): Promise<void> {
  const viewport = dialog.locator('.vds-scroll-area__viewport')
  const geometry = await viewport.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const root = element.parentElement!.getBoundingClientRect()
    return {
      top: bounds.top,
      bottom: bounds.bottom,
      rootBottom: root.bottom,
      height: element.clientHeight,
      content: element.scrollHeight,
    }
  })
  expect(geometry.height).toBeGreaterThan(0)
  expect(geometry.content).toBeGreaterThan(geometry.height)
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.rootBottom + GEOMETRY_TOLERANCE)
  for (const button of await dialog.getByRole('button').all()) {
    if (!(await button.isVisible())) continue
    const hit = await button.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const target = document.elementFromPoint(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2
      )
      return {
        top: bounds.top,
        bottom: bounds.bottom,
        reachable: target !== null && element.contains(target),
      }
    })
    expect(hit.reachable).toBe(true)
    expect(hit.bottom <= geometry.top || hit.top >= geometry.bottom - GEOMETRY_TOLERANCE).toBe(true)
  }
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  expect(await viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
}

for (const scope of ['global', 'project'] as const) {
  test(`metadata batch ${scope} keeps long lists bounded and footer actions reachable`, async ({}, testInfo) => {
    const runtime = createRuntime(testInfo)
    const preferencesPath = join(runtime.userData, 'renderer-preferences.json')
    const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'))
    writeFileSync(
      preferencesPath,
      JSON.stringify({ ...preferences, theme: scope === 'global' ? 'light' : 'dark' })
    )
    const desktop = new DesktopSession(runtime, testInfo)
    const EVIDENCE_ROOT = runtime.artifacts
    try {
      const page = await desktop.launch()
      const base = await apiBase(page)
      const project = await createReadyProject(page, PROJECT_NAME)
      const bibliography = Array.from(
        { length: ENTRY_COUNT },
        (_, index) =>
          `@article{batch${index},title={Batch paper ${String(index + 1).padStart(3, '0')}},author={Researcher},year={2026}}`
      ).join('\n')
      const query = scope === 'project' ? `?project_id=${encodeURIComponent(project.id)}` : ''
      const imported = await page.request.post(`${base}/api/v1/imports/bibliography${query}`, {
        multipart: {
          files: {
            name: 'batch.bib',
            mimeType: 'application/x-bibtex',
            buffer: Buffer.from(bibliography),
          },
        },
      })
      expect(imported.ok(), await imported.text()).toBe(true)
      expect((await imported.json()).count).toBe(ENTRY_COUNT)
      await page.reload()
      await enterWorkbenchShell(page)
      await openLiteratureScope(page, scope === 'project' ? PROJECT_NAME : undefined)
      const rows = page.locator('.lit-row:visible')
      const selectAll = page.locator('.lit-table-head:visible').getByRole('checkbox')
      await expect(rows.first()).toBeVisible()
      await selectAll.check()
      await expect(page.getByText(`已选 ${ENTRY_COUNT} 篇`, { exact: true })).toBeVisible()
      await page.getByRole('button', { name: '同步元数据', exact: true }).click()
      const dialog = page
        .getByRole('dialog')
        .filter({ has: page.getByRole('heading', { name: '同步元数据', exact: true }) })
      const close = dialog
        .locator('.vds-dialog__footer')
        .getByRole('button', { name: '关闭', exact: true })
      await expect(dialog).toBeVisible()
      for (const [width, height] of WINDOW_SIZES) {
        const contentSize = await desktop.app!.evaluate(
          ({ BrowserWindow }, size) => {
            const window = BrowserWindow.getAllWindows().find(
              (candidate) => candidate.webContents.getURL() === size.url
            )
            if (!window) throw new Error('Metadata acceptance window not found')
            window.setContentSize(size.width, size.height)
            const [width, height] = window.getContentSize()
            return { width, height }
          },
          { width, height, url: page.url() }
        )
        await expect
          .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
          .toEqual(contentSize)
        await assertScrollBoundary(dialog)
        await page.screenshot({
          path: join(EVIDENCE_ROOT, `${scope}-running-${width}x${height}.png`),
        })
      }
      await close.focus()
      await page.keyboard.press('Enter')
      await expect(dialog).toHaveCount(0)
      await page.screenshot({ path: join(EVIDENCE_ROOT, `${scope}-toolbar-narrow.png`) })
      await page.getByRole('button', { name: '同步进度', exact: true }).click()
      await expect(dialog.getByRole('button', { name: '停止同步', exact: true })).toBeEnabled()
      await assertScrollBoundary(dialog)
      await dialog.getByRole('button', { name: '停止同步', exact: true }).click()
      await expect(dialog.getByRole('button', { name: '停止同步', exact: true })).toHaveCount(0, {
        timeout: RESULT_TIMEOUT_MS,
      })
      await expect(dialog).toContainText(/已取消: [1-9]/)
      await expect(
        dialog.getByRole('button', { name: '重试失败和未完成项', exact: true })
      ).toBeEnabled()
      await assertScrollBoundary(dialog)
      await page.screenshot({ path: join(EVIDENCE_ROOT, `${scope}-cancelled.png`) })
      await close.click()
      await selectAll.uncheck()
      for (const row of await rows.all().then((items) => items.slice(0, SMALL_ENTRY_COUNT))) {
        await row.getByRole('checkbox').check()
      }
      await page.getByRole('button', { name: '同步结果', exact: true }).click()
      await dialog
        .getByRole('button', { name: `同步所选 ${SMALL_ENTRY_COUNT} 篇`, exact: true })
        .click()
      await expect(dialog.getByRole('button', { name: '停止同步', exact: true })).toHaveCount(0, {
        timeout: RESULT_TIMEOUT_MS,
      })
      await expect(dialog).toContainText(`已处理 ${SMALL_ENTRY_COUNT} / ${SMALL_ENTRY_COUNT} 篇`)
      await expect(close).toBeVisible()
      await page.screenshot({ path: join(EVIDENCE_ROOT, `${scope}-small-completed.png`) })
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
    }
  })
}
