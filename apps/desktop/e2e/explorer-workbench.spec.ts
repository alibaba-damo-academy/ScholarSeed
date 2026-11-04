import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DesktopSession, enterWorkbenchShell } from './fixtures/electron'
import { createReadyProject } from './fixtures/projects'
import { createRuntime } from './fixtures/runtime'

async function selectProject(page: Page, name: string): Promise<void> {
  await page.getByTestId('project-navigation-selector').click()
  await page.getByTestId(`project-menu-option-${name}`).click()
}

test('explorer retains its tree, breadcrumb and preview across menu and project switches', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, { nativeWindowLifecycle: true })
  try {
    const page = await desktop.launch()
    await enterWorkbenchShell(page)
    const first = await createReadyProject(page, 'Explorer first')
    const second = await createReadyProject(page, 'Explorer second')
    mkdirSync(join(first.root, 'notes'), { recursive: true })
    writeFileSync(join(first.root, 'notes', 'retained.md'), '# Retained explorer preview\n')
    await page.reload()
    await enterWorkbenchShell(page)
    await page.getByTestId('activity-home').click()
    await page.getByTestId(`home-project-${first.name}`).click()
    await page.getByTestId('workspace-open').click()
    await page.getByRole('button', { name: '项目资源管理器', exact: true }).click()
    await page.getByTestId('explorer-node-notes').getByRole('button').first().click()
    await page.getByTestId('explorer-node-notes/retained.md').getByRole('button').first().click()
    const explorer = page.getByTestId('project-explorer')
    const verify = async (): Promise<void> => {
      await expect(explorer).toBeVisible()
      await expect(page.getByTestId('explorer-tree')).toBeVisible()
      await expect(page.getByTestId('explorer-node-notes/retained.md')).toBeVisible()
      await expect(explorer.locator('header').first()).toContainText('retained.md')
      await expect(page.getByTestId('explorer-preview')).toContainText('Retained explorer preview')
    }
    await verify()
    await page.getByTestId('activity-literature').click()
    await page.getByTestId('activity-home').click()
    await verify()
    await page.screenshot({ path: join(runtime.artifacts, 'menu-return.png') })
    await selectProject(page, second.name)
    await expect(explorer).toHaveCount(0)
    await selectProject(page, first.name)
    await verify()
    await page.screenshot({ path: join(runtime.artifacts, 'project-return.png') })
  } finally {
    await desktop.attachArtifacts()
  }
})
