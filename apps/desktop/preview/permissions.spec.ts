import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewScenario, previewSurface, expect, test, type Page } from './testing'
import { PREVIEW_CATALOG } from './catalog'
import { previewConsumption } from './coverage'

const PAGE_ID = 'settings-permissions'
const SCENES = ['settings-permissions-states', 'settings-permissions-pending', 'settings-permissions-failed'] as const
const UNAVAILABLE_ROWS = ['screen', 'accessibility', 'microphone', 'automation', 'location'] as const

async function openPermissions(page: Page, sceneId: string): Promise<void> {
  const entry = PREVIEW_CATALOG.find(candidate => candidate.id === PAGE_ID)!
  const scene = entry.scenarios.find(candidate => candidate.id === sceneId)!
  expect(scene).toBeDefined()
  await page.goto(`/?previewInstance=${randomUUID()}&scene=page-home`)
  await page.keyboard.press('F8')

  await openPreviewScenario(page, entry.id, scene.id, true)
  await expect(page.getByRole('heading', { name: 'PDFE 工作台', exact: true })).toBeVisible()
  await expect(previewSurface(page).getByTestId('account-settings-permissions')).toBeVisible()
}

async function expectUnavailable(page: Page): Promise<void> {
  for (const permission of UNAVAILABLE_ROWS) {
    const row = previewSurface(page).getByTestId(`permission-${permission}`)
    await expect(row.locator('[data-status]')).toHaveAttribute('data-status', 'unavailable')
    await expect(row).toBeDisabled()
  }
  for (const permission of ['full-disk', 'notifications']) {
    await expect(previewSurface(page).getByTestId(`permission-${permission}`).locator('[data-status]')).toHaveAttribute('data-status', 'query-error')
  }
  await expect(previewSurface(page).getByTestId('account-settings-permissions').locator('[data-status="granted"]')).toHaveCount(0)
  await expect(previewSurface(page).getByRole('alert')).toHaveCount(0)
}

async function permissionFailures(page: Page): Promise<number> {
  await page.keyboard.press('F8')
  const records = previewSurface(page).locator('pre').filter({ hasText: '"kind": "permissions-failed"' })
  await expect(records).toHaveCount(1)
  const entries = JSON.parse(await records.innerText()) as { kind?: string }[]
  await page.getByRole('button', { name: '关闭预览控制台', exact: true }).click()
  return entries.filter(entry => entry.kind === 'permissions-failed').length
}

for (const sceneId of SCENES) {
  const states = sceneId === 'settings-permissions-failed' ? ['failed', 'retry-failed'] : sceneId === 'settings-permissions-pending' ? ['loading', 'unavailable', 'query-error'] : ['loaded', 'unavailable', 'query-error']
  test(`${sceneId} is selectable in the real Console and preserves the simulated permission boundary`, { annotation: previewConsumption(PAGE_ID, sceneId, states) }, async ({ page }, testInfo) => {
    const failures: { path: string; method: string; status: number }[] = []
    page.on('response', response => {
      const path = new URL(response.url()).pathname
      if (path.startsWith('/api/') && response.status() >= 400) failures.push({ path, method: response.request().method(), status: response.status() })
    })
    try {
      await openPermissions(page, sceneId)
      const refresh = previewSurface(page).getByTestId('permissions-refresh')
      if (sceneId === 'settings-permissions-pending') {
        await expect(refresh).toBeDisabled()
        await expect(refresh).toHaveText('正在检查…')
        await page.screenshot({ path: testInfo.outputPath('permissions-loading.png'), fullPage: true })
      }
      await expect(refresh).toBeEnabled()
      if (sceneId === 'settings-permissions-failed') {
        await expect(previewSurface(page).getByRole('alert')).toContainText('无法读取系统能力状态')
        await page.screenshot({ path: testInfo.outputPath('permissions-failed.png'), fullPage: true })
        const before = await permissionFailures(page)
        await refresh.click()
        await expect(refresh).toBeEnabled()
        await expect(previewSurface(page).getByRole('alert')).toContainText('无法读取系统能力状态')
        expect(await permissionFailures(page)).toBeGreaterThan(before)
        await expect(previewSurface(page).getByTestId('permission-screen').locator('[data-status]')).toHaveAttribute('data-status', 'query-error')
        await page.screenshot({ path: testInfo.outputPath('permissions-refresh-failed.png'), fullPage: true })
      } else {
        await expectUnavailable(page)
        await page.screenshot({ path: testInfo.outputPath('permissions-unavailable.png'), fullPage: true })
      }
      expect(failures).toEqual([])
    } finally {
      const path = testInfo.outputPath('permission-api-failures.json')
      await writeFile(path, JSON.stringify(failures, null, 2))
      await testInfo.attach('permission-api-failures', { path, contentType: 'application/json' })
    }
  })
}
