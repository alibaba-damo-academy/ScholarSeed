import { existsSync } from 'fs'
import { join } from 'path'
import { expect, test } from '@playwright/test'
import { apiBase, DesktopSession } from './fixtures/electron'
import { createReadyProject } from './fixtures/projects'
import { createRuntime } from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const UI_PROJECT_NAME = '后台准备创建验收'
const API_PROJECT_NAME = '终态查询创建验收'
const PROJECT_ROUTE = '/api/content/projects'
const OPERATION_ROUTE = '/api/content/operations/'
const CREATION_TIMEOUT_MS = 90_000

test('project creation waits for prepared storage and supports operation consumers', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const base = await apiBase(page)
    await page.getByTestId('topbar-project').click()
    await page.getByTestId('project-menu-create').click()
    const dialog = page.getByTestId('project-new-modal')
    await dialog.getByRole('textbox').fill(UI_PROJECT_NAME)
    const submitted = page.waitForResponse(
      (response) =>
        response.url() === `${base}${PROJECT_ROUTE}` && response.request().method() === 'POST'
    )
    const completed = page.waitForResponse(
      async (response) =>
        response.url().startsWith(`${base}${OPERATION_ROUTE}`) &&
        response.status() === 200 &&
        (await response.json()).state === 'succeeded',
      { timeout: CREATION_TIMEOUT_MS }
    )
    await dialog.getByTestId('project-create').click()
    const accepted = await submitted
    expect(accepted.status()).toBe(202)
    const operation = (await accepted.json()).operation
    const result = await (await completed).json()
    expect(result.operation).toBe(operation)
    expect(result.result.name).toBe(UI_PROJECT_NAME)
    await expect(dialog).toHaveCount(0)
    for (const relative of ['resources', 'literature', '.scholarseed/service/project.sqlite3']) {
      expect(existsSync(join(result.result.root, relative))).toBe(true)
    }
    const second = await createReadyProject(page, API_PROJECT_NAME)
    expect(second.id).not.toBe(result.result.id)
    await page.reload()
    await page.getByTestId('topbar-project').click()
    await expect(page.getByTestId(`project-menu-option-${UI_PROJECT_NAME}`)).toBeVisible()
    await expect(page.getByTestId(`project-menu-option-${API_PROJECT_NAME}`)).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'prepared-projects.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
