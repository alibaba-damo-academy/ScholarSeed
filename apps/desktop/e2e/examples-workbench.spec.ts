import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, test } from '@playwright/test'
import { DesktopSession, enterWorkbenchShell } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { buildExample } from './fixtures/builders/project'

test('shared example prepares a real isolated project and opens its original Markdown through the product', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, { nativeWindowLifecycle: true, preserveNavigation: true })
  try {
    const page = await desktop.launch()
    const receipt = await buildExample(page, runtime)
    expect(receipt.status).toBe('ready')
    expect(receipt.projects).toHaveLength(1)
    const project = receipt.projects[0]
    expect(relative(runtime.workspace, project.root).startsWith('..')).toBe(false)
    const document = project.files.find(file => file.id === 'document')
    expect(document).toBeDefined()
    expect(readFileSync(join(project.root, ...document!.path.split('/')), 'utf8')).toContain('EDITOR-END-OMEGA')
    writeFileSync(testInfo.outputPath('example-preparation.json'), JSON.stringify(receipt, null, 2))
    await page.reload()
    await enterWorkbenchShell(page)
    await page.getByTestId('activity-home').click()
    await page.getByTestId(`home-project-${project.name}`).click()
    await page.getByTestId('workspace-open').click()
    await page.getByRole('button', { name: '项目资源管理器', exact: true }).click()
    const parts = document!.path.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      await page.getByTestId(`explorer-select-${parts.slice(0, depth).join('/')}`).click()
    }
    await page.getByTestId(`explorer-select-${document!.path}`).click()
    const preview = page.getByTestId('explorer-preview')
    await expect(preview.getByRole('heading', { name: 'Synthetic editor first target', exact: true })).toBeVisible()
    await expect(preview).toContainText('EDITOR-END-OMEGA')
    expect(await page.evaluate(() => Object.hasOwn(window, 'pdfe'))).toBe(false)
    await page.screenshot({ path: testInfo.outputPath('shared-example-real-markdown.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
