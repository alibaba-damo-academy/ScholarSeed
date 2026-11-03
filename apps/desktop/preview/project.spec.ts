import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { previewSurface, expect, test, type Page } from './testing'
import { capturePreview } from './capture'
import { PREVIEW_ORIGIN, PREVIEW_PROJECT_ID } from './constants'
import { previewConsumption } from './coverage'
import { WORKSPACE_WINDOW_MINIMUM } from '../src/window'

const OBSERVATIONS = new WeakMap<
  Page,
  {
    failures: { path: string; method: string; status: number }[]
    externalOrigins: string[]
    pageErrors: string[]
  }
>()

test.beforeEach(({ page }) => {
  const observations = {
    failures: [] as { path: string; method: string; status: number }[],
    externalOrigins: [] as string[],
    pageErrors: [] as string[],
  }
  OBSERVATIONS.set(page, observations)
  page.on('pageerror', (error) => observations.pageErrors.push(error.message))
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (
      ['http:', 'https:'].includes(url.protocol) &&
      url.origin !== PREVIEW_ORIGIN &&
      !observations.externalOrigins.includes(url.origin)
    )
      observations.externalOrigins.push(url.origin)
  })
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if ((path.startsWith('/api/') || path.startsWith('/__preview/')) && response.status() >= 400)
      observations.failures.push({
        path,
        method: response.request().method(),
        status: response.status(),
      })
  })
})

test.afterEach(async ({ page }, testInfo) => {
  const observations = OBSERVATIONS.get(page)!
  const path = testInfo.outputPath('project-http-summary.json')
  await writeFile(path, JSON.stringify(observations, null, 2))
  await testInfo.attach('project-http-summary', { path, contentType: 'application/json' })
  expect(observations.pageErrors).toEqual([])
  expect(observations.externalOrigins).toEqual([])
  expect(observations.failures).toEqual([])
})

for (const target of [
  { kind: 'library', label: '项目文件', surface: 'project-library-content' },
  { kind: 'explorer', label: '项目资源管理器', surface: 'project-explorer' },
] as const) {
  test(
    `project new tab chooses ${target.kind} in the same tab and reenters after closing`,
    {
      annotation: previewConsumption('viewer-new_tab', 'viewer-new_tab-states', [
        'opened',
        target.kind,
        'closed',
        'reentered',
      ]),
    },
    async ({ page }, testInfo) => {
      await page.goto(
        `/?previewInstance=${randomUUID()}&page=viewer-new_tab&scene=viewer-new_tab-states`
      )
      const plus = previewSurface(page).getByTestId('workspace-new-tab')
      await previewSurface(page).getByTestId('project-library').click()
      const initialLibrary = previewSurface(page)
        .getByRole('tab', { name: '项目文件', exact: false })
        .filter({ has: previewSurface(page).getByRole('button', { name: /项目文件/ }) })
      const originalLibrary = await initialLibrary.elementHandle()
      expect(originalLibrary).not.toBeNull()
      await expect(plus).toBeVisible()
      await plus.click()
      const chooser = previewSurface(page).getByTestId('project-new-tab')
      await expect(chooser).toBeVisible()
      const newTab = previewSurface(page)
        .getByRole('tab', { name: '新标签页', exact: false })
        .filter({ has: previewSurface(page).getByRole('button', { name: /新标签页/ }) })
      await expect(newTab).toHaveCount(1)
      const original = await newTab.elementHandle()
      expect(original).not.toBeNull()
      await initialLibrary.getByRole('button').click()
      expect(await originalLibrary!.evaluate((node) => node.isConnected)).toBe(false)
      await expect(chooser).toBeVisible()
      expect(await newTab.evaluate((node, previous) => node === previous, original)).toBe(true)
      await capturePreview(page, testInfo.outputPath(`${target.kind}-new-tab.png`))
      await chooser.getByRole('button', { name: target.label, exact: true }).click()
      await expect(previewSurface(page).getByTestId(target.surface)).toBeVisible()
      await expect(chooser).not.toBeVisible()
      const selected = previewSurface(page)
        .getByRole('tab', { name: target.label, exact: false })
        .filter({ has: previewSurface(page).getByRole('button', { name: new RegExp(target.label) }) })
        .and(previewSurface(page).locator('[aria-selected="true"]'))
      await expect(selected).toHaveCount(1)
      expect(await selected.evaluate((node, previous) => node === previous, original)).toBe(true)
      await expect(selected).toHaveAttribute('aria-selected', 'true')
      await capturePreview(page, testInfo.outputPath(`${target.kind}-selected.png`))
      await selected.getByRole('button').click()
      expect(await original!.evaluate((node) => node.isConnected)).toBe(false)
      await expect(previewSurface(page).getByTestId('workspace-content')).not.toBeVisible()
      const reopen = previewSurface(page).getByTestId('workspace-open')
      await expect(reopen).toHaveAttribute('aria-expanded', 'false')
      await capturePreview(page, testInfo.outputPath(`${target.kind}-closed.png`))
      await reopen.click()
      await expect(chooser).toBeVisible()
      await expect(newTab).toHaveCount(1)
      expect(await newTab.evaluate((node, previous) => node === previous, original)).toBe(false)
      await capturePreview(page, testInfo.outputPath(`${target.kind}-reentered.png`))
      await originalLibrary!.dispose()
      await original!.dispose()
    }
  )
}

test(
  'project layout preserves original controls while moving and retains the panel side after reload',
  {
    annotation: previewConsumption('page-resource', 'project-layout-states', [
      'split',
      'moved-right',
      'moved-left',
      'reloaded',
      'narrow',
    ]),
  },
  async ({ page }, testInfo) => {
    const submissions: string[] = []
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        /\/sessions\/[^/]+\/turns$/.test(new URL(request.url()).pathname)
      )
        submissions.push(request.url())
    })
    await page.goto(
      `/?previewInstance=${randomUUID()}&page=page-resource&scene=project-layout-states`
    )
    await previewSurface(page).getByTestId('project-library').click()
    const conversation = previewSurface(page).getByTestId('workspace-conversation')
    const content = previewSurface(page).getByTestId('workspace-content')
    const input = previewSurface(page).getByTestId('composer-input')
    await expect(conversation).toHaveAttribute('data-mode', 'split')
    await input.fill('模拟布局草稿，不发送')
    const originalInput = await input.elementHandle()
    const tab = previewSurface(page)
      .getByRole('tab', { name: '项目文件', exact: false })
      .filter({ has: previewSurface(page).getByRole('button', { name: /项目文件/ }) })
    const originalTab = await tab.elementHandle()
    const move = async (right: boolean) => {
      await previewSurface(page).getByTestId('workspace-conversation-menu').click()
      const saved = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/__preview/state' &&
          response.request().postDataJSON()?.preferences?.projectLayouts?.[PREVIEW_PROJECT_ID]
            ?.swapped === right
      )
      await previewSurface(page)
        .getByRole('menuitem', { name: right ? '移至右侧面板' : '移至左侧面板', exact: true })
        .click()
      expect((await saved).status()).toBe(200)
      await expect
        .poll(async () => {
          const conversationBox = await conversation.boundingBox()
          const contentBox = await content.boundingBox()
          return Boolean(
            conversationBox &&
            contentBox &&
            (right ? conversationBox.x > contentBox.x : conversationBox.x < contentBox.x)
          )
        })
        .toBe(true)
      await expect(input).toHaveValue('模拟布局草稿，不发送')
      expect(await input.evaluate((node, previous) => node === previous, originalInput)).toBe(true)
      expect(await tab.evaluate((node, previous) => node === previous, originalTab)).toBe(true)
    }
    await move(true)
    await capturePreview(page, testInfo.outputPath('layout-conversation-right.png'))
    await move(false)
    await capturePreview(page, testInfo.outputPath('layout-conversation-left.png'))
    await move(true)
    await page.reload()
    await expect(conversation).toHaveAttribute('data-mode', 'split')
    await expect
      .poll(async () => (await conversation.boundingBox())!.x > (await content.boundingBox())!.x)
      .toBe(true)
    await capturePreview(page, testInfo.outputPath('layout-reloaded-project.png'))
    await previewSurface(page).getByTestId('project-library').click()
    await expect(previewSurface(page).getByTestId('project-library-content')).toBeVisible()
    await page.setViewportSize(WORKSPACE_WINDOW_MINIMUM)
    const tabs = ['资料', '文献', '任务产物'].map((name) =>
      previewSurface(page).getByRole('tab', { name, exact: true })
    )
    for (const trigger of tabs) await expect(trigger).toBeVisible()
    const positions = await Promise.all(tabs.map((trigger) => trigger.boundingBox()))
    expect(new Set(positions.map((position) => Math.round(position!.y))).size).toBe(1)
    await capturePreview(page, testInfo.outputPath('layout-reloaded-narrow-toolbar.png'))
    expect(submissions).toEqual([])
    await originalInput!.dispose()
    await originalTab!.dispose()
  }
)
