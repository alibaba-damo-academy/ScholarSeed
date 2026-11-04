import { openProjectMenu } from './fixtures/projects'
import { expect, test, type JSHandle, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { DesktopSession, apiBase } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

interface DropFile {
  bytes: string
  name: string
  type: string
}

function pdf(name: string, path: string): DropFile {
  return {
    bytes: readFileSync(path).toString('base64'),
    name,
    type: 'application/pdf'
  }
}

async function dataTransfer(
  page: Page,
  files: DropFile[]
): Promise<JSHandle<DataTransfer>> {
  return page.evaluateHandle((incoming) => {
    const transfer = new DataTransfer()
    for (const item of incoming) {
      const binary = atob(item.bytes)
      const bytes = Uint8Array.from(binary, (character) =>
        character.charCodeAt(0)
      )
      transfer.items.add(new File([bytes], item.name, { type: item.type }))
    }
    return transfer
  }, files)
}

test('literature list accepts copied PDF drops and stays open after parsing', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(
    resolve(runtime.userData, 'renderer-preferences.json'),
    JSON.stringify({
      language: 'zh',
      onboarding: {
        seen: { home: true, project: true, globalLib: true, pdf: true }
      }
    })
  )
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    page.setDefaultTimeout(20_000)
    const base = await apiBase(page)
    const first = pdf(
      'first.pdf',
      resolve('e2e/fixtures/data/minimal-project/sample.pdf')
    )
    const second = pdf(
      'second.pdf',
      resolve('e2e/fixtures/preview_pdf_1MB.pdf')
    )

    await page.getByTestId('activity-literature').click()
    const target = page.getByTestId('literature-drop-target')
    const initialTransfer = await dataTransfer(page, [first, second])
    await target.dispatchEvent('dragenter', { dataTransfer: initialTransfer })
    await expect(target).toHaveAttribute('data-drop-active', 'true')
    await expect(page.getByText('松开以导入 PDF', { exact: true })).toBeVisible()
    await page.screenshot({
      path: resolve(runtime.artifacts, 'drop-highlight.png'),
      fullPage: true
    })
    await target.dispatchEvent('dragleave', { dataTransfer: initialTransfer })
    await expect(target).toHaveAttribute('data-drop-active', 'false')

    await target.dispatchEvent('dragenter', { dataTransfer: initialTransfer })
    await target.dispatchEvent('dragover', { dataTransfer: initialTransfer })
    await target.dispatchEvent('drop', { dataTransfer: initialTransfer })
    const importDialog = page.getByRole('dialog')
    await expect(importDialog.getByRole('heading', { name: '导入 PDF' })).toBeVisible()
    await expect(importDialog.getByText('first.pdf', { exact: true })).toBeVisible()
    await expect(importDialog.getByText('second.pdf', { exact: true })).toBeVisible()
    await expect(importDialog.getByText('成功 2 / 2', { exact: true })).toBeVisible({
      timeout: 60_000
    })
    await page.screenshot({
      path: resolve(runtime.artifacts, 'multi-success.png'),
      fullPage: true
    })
    await importDialog.getByRole('button', { name: '完成', exact: true }).click()
    await expect(target).toBeVisible()
    await expect(page.getByTestId('activity-literature')).toHaveAttribute(
      'aria-current',
      'true'
    )
    await expect(page.getByTestId('workbench-home-space')).toHaveCount(0)
    await page.screenshot({
      path: resolve(runtime.artifacts, 'stayed-after-global-import.png'),
      fullPage: true
    })
    await expect.poll(async () => {
      const response = await page.request.get(`${base}/api/v1/literatures`)
      return (await response.json()).total
    }).toBe(2)

    const mixedTransfer = await dataTransfer(page, [
      first,
      { bytes: Buffer.from('not a pdf').toString('base64'), name: 'notes.txt', type: 'text/plain' }
    ])
    await target.dispatchEvent('dragenter', { dataTransfer: mixedTransfer })
    await target.dispatchEvent('dragover', { dataTransfer: mixedTransfer })
    await target.dispatchEvent('drop', { dataTransfer: mixedTransfer })
    await expect(importDialog.getByText('成功 1 / 2 · 失败 1', { exact: true })).toBeVisible({
      timeout: 60_000
    })
    await expect(importDialog.getByText('仅支持 PDF 文件', { exact: true })).toBeVisible()
    await page.screenshot({
      path: resolve(runtime.artifacts, 'mixed-results.png'),
      fullPage: true
    })
    await importDialog.getByRole('button', { name: '完成', exact: true }).click()
    await expect(target).toBeVisible()
    await expect(page.getByTestId('activity-literature')).toHaveAttribute(
      'aria-current',
      'true'
    )
    await expect(page.getByTestId('workbench-home-space')).toHaveCount(0)
    await expect.poll(async () => {
      const response = await page.request.get(`${base}/api/v1/literatures`)
      return (await response.json()).total
    }).toBe(3)

    await openProjectMenu(page)
    await page.getByTestId('project-menu-create').click()
    const projectDialog = page.getByTestId('project-new-modal')
    await projectDialog.getByTestId('project-create-name').fill('Drop-project')
    await projectDialog.getByTestId('project-create').click()
    await expect(projectDialog).toHaveCount(0)
    const projectsResponse = await page.request.get(`${base}/api/content/projects`)
    expect(projectsResponse.ok(), await projectsResponse.text()).toBe(true)
    const projects = await projectsResponse.json()
    const project = projects.projects.find(
      (item: { name: string }) => item.name === 'Drop-project'
    )
    expect(project).toBeTruthy()
    await page.getByTestId('project-library').click()
    await page.getByTestId('project-library-content').getByRole('tab', { name: '文献', exact: true }).click()

    const projectTarget = page.getByTestId('literature-drop-target')
    const projectTransfer = await dataTransfer(page, [second])
    await projectTarget.dispatchEvent('dragenter', { dataTransfer: projectTransfer })
    await projectTarget.dispatchEvent('dragover', { dataTransfer: projectTransfer })
    await projectTarget.dispatchEvent('drop', { dataTransfer: projectTransfer })
    await expect(importDialog.getByText('成功 1 / 1', { exact: true })).toBeVisible({
      timeout: 60_000
    })
    await page.screenshot({
      path: resolve(runtime.artifacts, 'project-success.png'),
      fullPage: true
    })
    await importDialog.getByRole('button', { name: '完成', exact: true }).click()
    await expect(projectTarget).toBeVisible()
    await expect(page.getByTestId('project-library-content').getByRole('tab', { name: '文献', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('workbench-home-space')).toHaveCount(0)
    await page.screenshot({
      path: resolve(runtime.artifacts, 'stayed-after-project-import.png'),
      fullPage: true
    })
    await expect.poll(async () => {
      const response = await page.request.get(
        `${base}/api/v1/literatures?project_id=${project.id}`
      )
      return (await response.json()).total
    }).toBe(1)

    await initialTransfer.dispose()
    await mixedTransfer.dispose()
    await projectTransfer.dispose()
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
