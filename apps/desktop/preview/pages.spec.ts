import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewScenario, previewSurface, expect, test, type Page } from './testing'
import { PREVIEW_CATALOG } from './catalog'
import { capturePreview } from './capture'
import { PREVIEW_ORIGIN } from './constants'
import { previewConsumption } from './coverage'

const OBSERVATIONS = new WeakMap<Page, { failures: { path: string; method: string; status: number }[]; externalOrigins: string[] }>()

test.beforeEach(({ page }) => {
  const observations = { failures: [] as { path: string; method: string; status: number }[], externalOrigins: [] as string[] }
  OBSERVATIONS.set(page, observations)
  page.on('request', request => {
    const url = new URL(request.url())
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== PREVIEW_ORIGIN && !observations.externalOrigins.includes(url.origin)) observations.externalOrigins.push(url.origin)
  })
  page.on('response', response => {
    const path = new URL(response.url()).pathname
    if ((path.startsWith('/api/') || path === '/__preview/state') && response.status() >= 400) observations.failures.push({ path, method: response.request().method(), status: response.status() })
  })
})

test.afterEach(async ({ page }, testInfo) => {
  const observations = OBSERVATIONS.get(page)!
  const path = testInfo.outputPath('pages-http-summary.json')
  await writeFile(path, JSON.stringify(observations, null, 2))
  await testInfo.attach('pages-http-summary', { path, contentType: 'application/json' })
  expect(observations.externalOrigins).toEqual([])
  expect(observations.failures).toEqual([])
})

async function openPage(page: Page, pageId: string, sceneId: string): Promise<void> {
  const entry = PREVIEW_CATALOG.find(candidate => candidate.id === pageId)!
  const scene = entry.scenarios.find(candidate => candidate.id === sceneId)!
  await page.goto(`/?previewInstance=${randomUUID()}&scene=page-home`)
  await page.keyboard.press('F8')
  await openPreviewScenario(page, entry.id, scene.id)
  await expect(page.getByRole('heading', { name: 'PDFE 工作台', exact: true })).toBeVisible()
}

test('primary home lists the seeded project and task and opens its project', { annotation: previewConsumption('page-home', 'home-browse', ['populated', 'opened']) }, async ({ page }, testInfo) => {
  await openPage(page, 'page-home', 'home-browse')
  await expect(previewSurface(page).getByTestId('home-project-设计协作项目')).toBeVisible()
  await expect(previewSurface(page).getByTestId('home-tasks-list')).toContainText('设计协作演示')
  await capturePreview(page, testInfo.outputPath('primary-home.png'))
  await previewSurface(page).getByTestId('home-project-设计协作项目').click()
  await expect(previewSurface(page).getByTestId('project-navigation-selector')).toContainText('设计协作项目')
  await capturePreview(page, testInfo.outputPath('primary-home-project.png'))
})

test('primary projects filters its real cards and opens the selected project', { annotation: previewConsumption('page-projects', 'projects-browse', ['populated', 'filtered', 'no-match', 'opened']) }, async ({ page }, testInfo) => {
  await openPage(page, 'page-projects', 'projects-browse')
  const card = previewSurface(page).getByTestId('project-card-设计协作项目')
  const search = previewSurface(page).getByTestId('projects-search')
  await expect(card).toBeVisible()
  await capturePreview(page, testInfo.outputPath('primary-projects.png'))
  await search.fill('preview-no-matching-project')
  await expect(previewSurface(page).getByTestId('projects-empty')).toBeVisible()
  await expect(card).toHaveCount(0)
  await capturePreview(page, testInfo.outputPath('primary-projects-no-match.png'))
  await search.fill('设计协作')
  await expect(card).toBeVisible()
  await card.getByRole('button').first().click()
  await expect(previewSurface(page).getByTestId('project-navigation-selector')).toContainText('设计协作项目')
  await capturePreview(page, testInfo.outputPath('primary-projects-opened.png'))
})

test('primary resource entry exposes the real project-scoped registered panel and opens its document', { annotation: previewConsumption('page-resource', 'resource-browse', ['populated', 'opened']) }, async ({ page }, testInfo) => {
  await openPage(page, 'page-resource', 'resource-browse')
  await expect(previewSurface(page).getByTestId('preview-panel-open')).toBeVisible()
  await expect(previewSurface(page).getByTestId('project-navigation-selector')).toContainText('设计协作项目')
  await previewSurface(page).getByTestId('preview-panel-open').click()
  const panel = previewSurface(page).getByTestId('preview-panel-sheet')
  await expect(panel.getByTestId('resource-panel')).toBeVisible()
  const file = panel.getByTestId('tree-readme.md')
  await expect(file).toBeVisible()
  await capturePreview(page, testInfo.outputPath('primary-resource-tree.png'))
  await file.click()
  await previewSurface(page).getByTestId('preview-panel-close').click()
  await expect(panel).not.toBeVisible()
  await previewSurface(page).getByTestId('markdown-open-preview').click()
  await expect(previewSurface(page).getByTestId('markdown-preview')).toBeVisible()
  await expect(previewSurface(page).getByTestId('markdown-preview')).toContainText('Minimal Project')
  await capturePreview(page, testInfo.outputPath('primary-resource-document.png'))
})

test('primary literature exposes the actual empty catalogue and its search input', { annotation: previewConsumption('page-literature', 'literature-browse', ['empty', 'filtered']) }, async ({ page }, testInfo) => {
  await openPage(page, 'page-literature', 'literature-browse')
  const library = previewSurface(page).getByTestId('literature-overview')
  await expect(library).toBeVisible()
  await expect(library.getByText('暂无文献', { exact: true })).toBeVisible()
  await capturePreview(page, testInfo.outputPath('primary-literature-empty.png'))
  const search = library.getByPlaceholder('标题、作者、年份')
  await search.fill('preview-no-matching-paper')
  await expect(search).toHaveValue('preview-no-matching-paper')
  await expect(library.getByText('暂无搜索结果', { exact: true })).toBeVisible()
  await capturePreview(page, testInfo.outputPath('primary-literature-filtered.png'))
  await search.clear()
  await expect(search).toHaveValue('')
  await expect(library.getByText('暂无文献', { exact: true })).toBeVisible()
})

test('primary skills browses real cards, filters and opens its reviewed document', { annotation: previewConsumption('page-skills', 'skills-browse', ['populated', 'filtered', 'no-match', 'details']) }, async ({ page }, testInfo) => {
  await openPage(page, 'page-skills', 'skills-browse')
  await expect(previewSurface(page).getByTestId('skills-tab-marketplace')).toHaveAttribute('aria-selected', 'true')
  await expect(previewSurface(page).getByTestId('skills-empty')).toBeVisible()
  await expect(previewSurface(page).getByTestId('skill-card-preview-notes')).toHaveCount(0)
  await expect(previewSurface(page).getByTestId('skill-card-preview-required')).toHaveCount(0)
  await expect(previewSurface(page).getByTestId('skill-card-preview-unavailable')).toHaveCount(0)
  await previewSurface(page).getByTestId('skills-tab-scholarseed').click()
  await expect(previewSurface(page).getByTestId('skill-card-preview-required')).toBeVisible()
  await expect(previewSurface(page).getByTestId('skill-toggle-preview-required')).toBeDisabled()
  await expect(previewSurface(page).getByTestId('skill-toggle-preview-required')).toHaveAttribute('aria-checked', 'true')
  await expect(previewSurface(page).getByTestId('skill-more-preview-required')).not.toBeVisible()
  await previewSurface(page).getByTestId('skills-tab-user').click()
  await expect(previewSurface(page).getByTestId('skill-card-preview-notes')).toBeVisible()
  await expect(previewSurface(page).getByTestId('skill-card-preview-unavailable')).toBeVisible()
  await capturePreview(page, testInfo.outputPath('primary-skills.png'))
  const search = previewSurface(page).getByTestId('skills-search')
  await search.fill('preview-no-matching-skill')
  await expect(previewSurface(page).getByTestId('skills-empty')).toBeVisible()
  await capturePreview(page, testInfo.outputPath('primary-skills-no-match.png'))
  await search.clear()
  await previewSurface(page).getByTestId('skills-tab-user').click()
  await expect(previewSurface(page).getByTestId('skills-tab-user')).toHaveAttribute('aria-selected', 'true')
  await expect(previewSurface(page).getByTestId('skill-card-preview-required')).toHaveCount(0)
  await search.fill('preview-notes')
  await expect(previewSurface(page).getByTestId('skill-card-preview-notes')).toBeVisible()
  await expect(previewSurface(page).getByTestId('skill-card-preview-required')).toHaveCount(0)
  await previewSurface(page).getByTestId('skill-view-preview-notes').click()
  const detail = previewSurface(page).getByTestId('skill-detail')
  await expect(detail).toBeVisible()
  await expect(detail.getByTestId('skill-document')).toContainText('preview-notes')
  await expect(detail.getByTestId('skill-document')).toContainText('不会执行工具或读取用户文件。')
  await capturePreview(page, testInfo.outputPath('primary-skills-detail.png'))
  await detail.getByRole('button', { name: '返回技能', exact: true }).click()
  await expect(detail).not.toBeVisible()
})
