import { expect, test } from '@playwright/test'
import { apiBase, DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { HOME_PROJECT_PAGE_SIZE } from '../src/renderer/src/features/home/catalog'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectCenterAppearance } from './fixtures/appearance'

for (const theme of ['light', 'dark'] as const) for (const language of ['zh', 'en'] as const) {
  test(`normal project center appearance (${theme}, ${language})`, async ({}, testInfo) => {
    const runtime = createRuntime(testInfo)
    const preferences = join(runtime.userData, 'renderer-preferences.json')
    writeFileSync(preferences, JSON.stringify({ ...JSON.parse(readFileSync(preferences, 'utf8')), theme, language }))
    const desktop = new DesktopSession(runtime, testInfo, { preserveNavigation: true, nativeWindowLifecycle: true })
    try {
      const page = await desktop.launch()
      const skip = page.getByTestId('landing-skip')
      if (await skip.isVisible()) await skip.click()
      await expect(page.getByTestId('project-center')).toBeVisible()
      await expect(page.getByTestId('home-tasks-empty')).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      expect(await page.evaluate(() => Object.hasOwn(window, 'pdfe'))).toBe(false)
      const center = await projectCenterAppearance(page, 'center')
      await page.screenshot({ path: testInfo.outputPath('normal-center.png') })
      await page.getByTestId('home-project-create-top').click()
      await page.getByTestId('project-create-name').fill('PDFE交付核对')
      const form = await projectCenterAppearance(page, 'form')
      await page.screenshot({ path: testInfo.outputPath('normal-form.png') })
      writeFileSync(testInfo.outputPath('appearance.json'), JSON.stringify({ theme, language, data: 'real isolated Serve default project; no tasks', center, form }, null, 2))
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
    }
  })
}

test('normal project center uses real project mutations without the PDFE bridge', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, { preserveNavigation: true, nativeWindowLifecycle: true })
  try {
    const page = await desktop.launch()
    const skip = page.getByTestId('landing-skip')
    if (await skip.isVisible()) await skip.click()
    await expect(page.getByTestId('project-center')).toBeVisible()
    expect(await page.evaluate(() => Object.hasOwn(window, 'pdfe'))).toBe(false)
    const scrollbar = await page.getByTestId('project-center').evaluate(element => {
      const variables = getComputedStyle(element)
      const thumb = getComputedStyle(element, '::-webkit-scrollbar-thumb')
      const token = (name: string): string => variables.getPropertyValue(name).trim()
      const color = document.createElement('span').style
      color.color = token('--vds-scrollbar-thumb')
      return {
        actual: { color: thumb.backgroundColor.replaceAll(' ', ''), border: thumb.borderTopWidth, radius: thumb.borderTopLeftRadius, clip: thumb.backgroundClip, width: getComputedStyle(element, '::-webkit-scrollbar').width },
        expected: { color: color.color.replaceAll(' ', ''), border: token('--vds-border-width-2'), radius: token('--vds-radius-3'), clip: 'content-box', width: token('--vds-native-scrollbar-size') },
      }
    })
    expect(scrollbar.actual).toEqual(scrollbar.expected)
    const base = await apiBase(page)
    const projects = async (): Promise<Array<{ id: string; name: string; root: string; pinned?: boolean; archived_at?: number | null }>> => {
      const response = await page.request.get(base + '/api/content/projects?includeArchived=true')
      expect(response.ok()).toBe(true)
      return (await response.json()).projects
    }
    const original = await projects()
    await expect(page.getByTestId('home-tasks-empty')).toBeVisible()
    await page.getByTestId('home-project-create-top').click()
    const name = '项目中心正常产品回归'
    await page.getByTestId('project-create-name').fill(name)
    await page.getByTestId('project-create').click()
    await expect(page.getByTestId('project-new-modal')).toHaveCount(0)
    await expect(page.getByTestId('project-navigation-selector')).toContainText(name)
    await page.getByTestId('project-navigation-home').click()
    await expect(page.getByTestId('home-project-' + name)).toBeVisible()
    const created = (await projects()).find(project => project.name === name)
    expect(created).toBeDefined()
    expect(created!.root.startsWith(runtime.workspace)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('normal-project-created.png') })

    await page.getByTestId('home-project-' + name).hover()
    await page.getByTestId('home-project-menu-' + created!.id).click()
    await page.getByTestId('home-rename-' + created!.id).click()
    const renamed = '项目中心正常产品编辑结果'
    await page.getByTestId('project-edit-name').fill(renamed)
    await page.getByTestId('project-save').click()
    await expect(page.getByTestId('project-edit-modal')).toHaveCount(0)
    await expect(page.getByTestId('home-project-' + renamed)).toBeVisible()
    await page.getByTestId('home-project-' + renamed).hover()
    await page.getByTestId('home-project-menu-' + created!.id).click()
    await page.getByTestId('home-pin-' + created!.id).click()
    const rows = page.getByTestId('home-projects-grid').locator('button[data-testid^="home-project-"]:not([aria-haspopup])')
    await expect(rows.first()).toContainText(renamed)
    expect((await projects()).find(project => project.id === created!.id)).toMatchObject({ name: renamed, pinned: true })
    await page.screenshot({ path: testInfo.outputPath('normal-project-pinned.png') })

    await page.getByTestId('home-project-' + renamed).hover()
    await page.getByTestId('home-project-menu-' + created!.id).click()
    await page.getByTestId('home-archive-' + created!.id).click()
    await page.getByTestId('home-archive-confirm').click()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.getByTestId('home-project-' + renamed)).toHaveCount(0)
    const archived = await projects()
    expect(archived.find(project => project.id === created!.id)).toMatchObject({ archived_at: expect.any(Number) })
    expect(archived.filter(project => !project.archived_at).map(project => project.id).sort()).toEqual(original.filter(project => !project.archived_at).map(project => project.id).sort())
    await expect(page.getByTestId('home-tasks-empty')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('normal-project-archived.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('normal project center paginates, distinguishes search emptiness and clamps after archive', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, { preserveNavigation: true, nativeWindowLifecycle: true })
  try {
    const page = await desktop.launch()
    const skip = page.getByTestId('landing-skip')
    if (await skip.isVisible()) await skip.click()
    await expect(page.getByTestId('project-center')).toBeVisible()
    expect(await page.evaluate(() => Object.hasOwn(window, 'pdfe'))).toBe(false)
    const base = await apiBase(page)
    const projects = async (): Promise<Array<{ id: string; name: string; archived_at?: number | null }>> => {
      const response = await page.request.get(base + '/api/content/projects?includeArchived=true')
      expect(response.ok()).toBe(true)
      return (await response.json()).projects
    }
    const original = (await projects()).filter(project => !project.archived_at)
    expect(original).toHaveLength(1)
    const names = Array.from({ length: HOME_PROJECT_PAGE_SIZE }, (_, index) => `分页回归项目${index + 1}`)
    for (const name of names) {
      await page.getByTestId('home-project-create-top').click()
      await page.getByTestId('project-create-name').fill(name)
      await page.getByTestId('project-create').click()
      await expect(page.getByTestId('project-new-modal')).toHaveCount(0)
      await expect(page.getByTestId('project-navigation-selector')).toContainText(name)
      await page.getByTestId('project-navigation-home').click()
      await expect(page.getByTestId('home-project-' + name)).toBeVisible()
    }
    const rows = page.getByTestId('home-projects-grid').locator('button[data-testid^="home-project-"]:not([aria-haspopup])')
    const previous = page.getByTestId('home-projects-previous')
    const next = page.getByTestId('home-projects-next')
    await expect(rows).toHaveCount(HOME_PROJECT_PAGE_SIZE)
    await expect(previous).toBeDisabled()
    await expect(next).toBeEnabled()
    const firstPage = await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')))
    const search = page.getByRole('searchbox')
    await search.fill('不存在的分页回归项目')
    await expect(page.getByTestId('home-projects-no-results')).toBeVisible()
    await expect(page.getByTestId('home-projects-empty')).toHaveCount(0)
    await expect(rows).toHaveCount(0)
    await expect(page.getByTestId('home-tasks-empty')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('normal-project-search-no-results.png') })
    await search.fill('')
    await expect(rows).toHaveCount(HOME_PROJECT_PAGE_SIZE)
    await next.click()
    await expect(rows).toHaveCount(1)
    await expect(next).toBeDisabled()
    await expect(previous).toBeEnabled()
    const lastPage = await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')))
    expect(new Set([...firstPage, ...lastPage])).toEqual(new Set([
      ...names, original[0].name
    ].map(name => 'home-project-' + name)))
    await page.getByTestId('home-project-' + original[0].name).hover()
    await page.getByTestId('home-project-menu-' + original[0].id).click()
    await page.getByTestId('home-pin-' + original[0].id).click()
    await expect(page.getByTestId('home-project-' + names[0])).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('normal-project-last-page.png') })
    const archived = (await projects()).find(project => project.name === names[0])!
    await page.getByTestId('home-project-' + archived.name).hover()
    await page.getByTestId('home-project-menu-' + archived.id).click()
    await page.getByTestId('home-archive-' + archived.id).click()
    await page.getByTestId('home-archive-confirm').click()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(rows).toHaveCount(HOME_PROJECT_PAGE_SIZE)
    await expect(previous).toBeDisabled()
    await expect(next).toBeDisabled()
    await expect(page.getByTestId('home-project-' + archived.name)).toHaveCount(0)
    expect((await projects()).find(project => project.id === archived.id)).toMatchObject({ archived_at: expect.any(Number) })
    await page.screenshot({ path: testInfo.outputPath('normal-project-page-clamped.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
