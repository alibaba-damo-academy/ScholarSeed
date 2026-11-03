import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewScenario, previewSurface, expect, test, type Page } from './testing'
import { WINDOW_CLOSE_ACTION } from '../src/window'
import type { ResourceCapability, ResourceReviewBatch, ResourceVersionPage } from '../src/renderer/src/features/resources/api'
import { PREVIEW_CATALOG } from './catalog'
import { PREVIEW_SEARCH } from './searches'
import { previewConsumption } from './coverage'
import { capturePreview } from './capture'

const SURFACES = [
  { id: 'viewer-library', surface: 'project-library-content', category: null, empty: null },
  { id: 'viewer-explorer', surface: 'project-explorer', category: null, empty: null },
  { id: 'viewer-outputs', surface: 'project-outputs', category: '任务产物', empty: '暂无任务产物' },
  { id: 'viewer-project-literature', surface: 'literature-overview', category: '文献', empty: '暂无文献' },
  { id: 'viewer-material-list', surface: 'material-list', category: '资料', empty: null },
] as const

interface FailedRequest {
  method: string
  path: string
  status: number
}

const CATALOG_FAILURES = new WeakMap<Page, FailedRequest[]>()
const EXPECTED_FAILURES = new WeakMap<Page, FailedRequest[]>()
const FEEDBACK_PATH = '/api/serve/feedback'

test.beforeEach(async ({ page }) => {
  const failures: FailedRequest[] = []
  CATALOG_FAILURES.set(page, failures)
  EXPECTED_FAILURES.set(page, [])
  page.on('response', response => {
    const path = new URL(response.url()).pathname
    if (path.startsWith('/api/') && response.status() >= 400) failures.push({ method: response.request().method(), path, status: response.status() })
  })
})

test.afterEach(async ({ page }, testInfo) => {
  const failures = CATALOG_FAILURES.get(page) ?? []
  const path = testInfo.outputPath('catalog-api-failures.json')
  await writeFile(path, JSON.stringify(failures, null, 2))
  await testInfo.attach('catalog-api-failures', { path, contentType: 'application/json' })
  expect(failures, 'Catalog UI consumption must only contain explicitly exercised error responses').toEqual(EXPECTED_FAILURES.get(page) ?? [])
})

async function openCatalogScene(page: Page, id: string, initialize = true, scenarioTitle?: string): Promise<void> {
  const entry = PREVIEW_CATALOG.find(candidate => candidate.id === id)
  expect(entry, `Catalog entry ${id} must exist`).toBeDefined()
  expect(entry?.entryInstructions?.length, `${id} must disclose its real UI entry steps`).toBeGreaterThan(0)
  if (initialize) await page.goto(`/?previewInstance=${randomUUID()}&scene=page-home`)
  await page.keyboard.press('F8')



  await openPreviewScenario(page, entry!.id, (entry!.scenarios.find(scene => scene.title === scenarioTitle) ?? entry!.scenarios[0]).id, true)
  await expect(page.getByRole('heading', { name: 'PDFE 工作台', exact: true })).toBeVisible()
}

async function selectSurface(page: Page, id: string): Promise<void> {
  await openCatalogScene(page, id)
  await previewSurface(page).getByTestId('project-library').click()
  await expect(previewSurface(page).getByTestId('project-library-content')).toBeVisible()
}

async function openReview(page: Page, scenarioId = 'viewer-review-states'): Promise<ResourceReviewBatch> {
  const scene = PREVIEW_CATALOG.find(entry => entry.id === 'viewer-review')!.scenarios.find(scene => scene.id === scenarioId)!
  await openCatalogScene(page, 'viewer-review', true, scene.title)
  await previewSurface(page).getByTestId('preview-panel-open').click()
  const panel = previewSurface(page).getByTestId('preview-panel-sheet')
  await expect(panel.getByTestId('resource-panel')).toBeVisible()
  const review = panel.getByTestId('tree-review-readme.md')
  const geometryFor = () => review.evaluate(button => {
    const bounds = (element: Element | null) => {
      if (!element) return null
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return { testid: element.getAttribute('data-testid'), className: element.className, x: rect.x, y: rect.y, width: rect.width, height: rect.height, position: style.position, padding: style.padding, display: style.display, overflow: style.overflow }
    }
    const rect = button.getBoundingClientRect()
    return { review: bounds(button), more: bounds(document.querySelector('[data-testid="tree-more-readme.md"]')), ancestors: [button.parentElement, button.parentElement?.parentElement ?? null].map(bounds), hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button')?.getAttribute('data-testid') }
  })
  const stationary = await geometryFor()
  await review.hover()
  const hovered = await geometryFor()
  const geometry = { stationary, hovered }
  const path = test.info().outputPath('review-target-geometry.json')
  await writeFile(path, JSON.stringify(geometry, null, 2))
  await test.info().attach('review-target-geometry', { path, contentType: 'application/json' })
  for (const phase of [stationary, hovered]) {
    expect(phase.hit, 'The actual review click target must not be covered by the adjacent more control').toBe('tree-review-readme.md')
    expect(phase.review).not.toBeNull()
    expect(phase.more).not.toBeNull()
    expect(phase.review!.x + phase.review!.width <= phase.more!.x || phase.more!.x + phase.more!.width <= phase.review!.x || phase.review!.y + phase.review!.height <= phase.more!.y || phase.more!.y + phase.more!.height <= phase.review!.y, 'Review and more hit targets must not intersect while stationary or hovered').toBe(true)
  }
  const loaded = page.waitForResponse(response => /\/api\/resource\/review-batches\/[^/]+$/.test(new URL(response.url()).pathname) && response.request().method() === 'GET')
  await review.click()
  const batch = await (await loaded).json() as ResourceReviewBatch
  expect(batch.members).toHaveLength(1)
  expect(batch.members[0].path).toBe('readme.md')
  await previewSurface(page).getByTestId('preview-panel-close').click()
  await expect(panel).not.toBeVisible()
  await previewSurface(page).getByTestId('workspace-full').click()
  await expect(previewSurface(page).getByTestId('review-batch')).toBeVisible()
  await expect(previewSurface(page).getByTestId('review-diff').contentFrame().locator('.original .view-lines')).toContainText('Minimal Project')
  return batch
}

for (const action of ['accept', 'reject', 'revise'] as const) {
  test(`review catalog ${action} consumes real tree entry, comparison and batch submission`, { annotation: previewConsumption('viewer-review', 'viewer-review-states', ['pending', action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'revised']) }, async ({ page }, testInfo) => {
    const batch = await openReview(page)
    const modified = previewSurface(page).getByTestId('review-diff').contentFrame().locator('.modified .view-lines')
    await expect(modified).toContainText('Revision notes')
    const marker = 'UI-reviewed revision text'
    if (action === 'revise') {
      await modified.click()
      await page.keyboard.press('ControlOrMeta+End')
      await page.keyboard.press('End')
      await page.keyboard.type(`\n${marker}`)
      await expect(modified).toContainText(marker)
    }
    await previewSurface(page).getByTestId(`review-file-${action}`).click()
    await expect(previewSurface(page).getByTestId(`review-file-${action}`)).toHaveAttribute('aria-pressed', 'true')
    if (action === 'reject') await expect(modified).not.toContainText('Revision notes')
    await page.screenshot({ path: testInfo.outputPath(`catalog-review-${action}-decision.png`), fullPage: true })
    const submitted = page.waitForResponse(response => new URL(response.url()).pathname === `/api/resource/review-batches/${batch.id}/commit` && response.request().method() === 'POST')
    await previewSurface(page).getByTestId('review-batch-actions').getByRole('button', { name: '提交', exact: true }).click()
    const response = await submitted
    expect(response.status()).toBe(200)
    const request = response.request().postDataJSON() as { decisions: { action: string; file_id: string; revised_content?: string }[] }
    expect(request.decisions[0].action).toBe(action)
    expect(request.decisions[0].file_id).toBe(batch.members[0].file_id)
    if (action === 'revise') expect(Buffer.from(request.decisions[0].revised_content!, 'base64').toString()).toContain(marker)
    const result = await response.json() as { batch: ResourceReviewBatch }
    expect(result.batch.state).toBe('completed')
    expect(result.batch.members[0].action).toBe(action)
    await expect(previewSurface(page).getByTestId('review-batch')).not.toBeVisible()
    await expect(previewSurface(page).getByTestId('project-workspace')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`catalog-review-${action}-completed.png`), fullPage: true })
  })
}

test('review catalog failed submission retains decision and retries through the original control', { annotation: previewConsumption('viewer-review', 'viewer-review-failed', ['pending', 'failed', 'retried']) }, async ({ page }, testInfo) => {
  const batch = await openReview(page, 'viewer-review-failed')
  await previewSurface(page).getByTestId('review-file-accept').click()
  const failed = page.waitForResponse(response => new URL(response.url()).pathname === `/api/resource/review-batches/${batch.id}/commit`)
  await previewSurface(page).getByTestId('review-batch-actions').getByRole('button', { name: '提交', exact: true }).click()
  const result = await (await failed).json() as { batch: ResourceReviewBatch; results: { error: string }[] }
  expect(result.batch.state).toBe('failed')
  expect(result.results[0].error).toBe('preview_review_apply_failed')
  await expect(previewSurface(page).getByText('部分文件未提交', { exact: true })).toBeVisible()
  await expect(previewSurface(page).getByTestId('review-file-accept')).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ path: testInfo.outputPath('catalog-review-failed.png'), fullPage: true })
  const retried = page.waitForResponse(response => new URL(response.url()).pathname === `/api/resource/review-batches/${batch.id}/commit`)
  await previewSurface(page).getByRole('button', { name: '重试失败文件', exact: true }).click()
  expect((await (await retried).json()).batch.state).toBe('completed')
  await expect(previewSurface(page).getByTestId('review-batch')).not.toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('catalog-review-retried.png'), fullPage: true })
})

test('review catalog exposes conflicting current bytes and preserves them through the real revise choice', { annotation: previewConsumption('viewer-review', 'viewer-review-conflict', ['pending', 'conflict']) }, async ({ page }, testInfo) => {
  const batch = await openReview(page, 'viewer-review-conflict')
  await expect(previewSurface(page).getByText('文件在 Agent 完成后又发生了变化', { exact: true })).toBeVisible()
  const modified = previewSurface(page).getByTestId('review-diff').contentFrame().locator('.modified .view-lines')
  await expect(modified).not.toContainText('Revision notes')
  await expect(previewSurface(page).getByTestId('review-file-revise')).toBeEnabled()
  await previewSurface(page).getByTestId('review-file-revise').click()
  await expect(previewSurface(page).getByTestId('review-preview-source')).toContainText('当前磁盘')
  await page.screenshot({ path: testInfo.outputPath('catalog-review-conflict.png'), fullPage: true })
  const submitted = page.waitForResponse(response => new URL(response.url()).pathname === `/api/resource/review-batches/${batch.id}/commit`)
  await previewSurface(page).getByTestId('review-batch-actions').getByRole('button', { name: '提交', exact: true }).click()
  const result = await (await submitted).json() as { batch: ResourceReviewBatch }
  expect(result.batch.state).toBe('completed')
  expect(result.batch.members[0].action).toBe('revise')
  await expect(previewSurface(page).getByTestId('review-batch')).not.toBeVisible()
  await expect(previewSurface(page).getByRole('heading', { name: 'Revision notes', exact: true })).not.toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('catalog-review-conflict-revised.png'), fullPage: true })
})

test('web search catalog submits the real discovery form and consumes selectable official mock candidates', { annotation: previewConsumption('viewer-web_search', 'viewer-web_search-states', ['loaded']) }, async ({ page }, testInfo) => {
  await openCatalogScene(page, 'viewer-web_search')
  await previewSurface(page).getByTestId('preview-panel-open').click()
  const panel = previewSurface(page).getByTestId('preview-panel-sheet')
  const input = panel.locator('textarea')
  if (!await input.isVisible()) await panel.locator('[data-ob="resource-discovery-toggle"]').click()
  const query = '受审模拟研究检索'
  await input.fill(query)
  const searched = page.waitForResponse(response => new URL(response.url()).pathname === '/api/resource/web-search' && response.request().method() === 'POST')
  await panel.getByTestId('resource-ai-search-go').click()
  const response = await searched
  expect(response.status()).toBe(200)
  expect(response.request().postDataJSON().query).toBe(query)
  const result = await response.json() as { query: string; search_id: string; candidates: { title: string; url: string }[] }
  expect(result.query).toBe(query)
  expect(result.search_id).toBeTruthy()
  expect(result.candidates).toHaveLength(2)
  await previewSurface(page).getByTestId('preview-panel-close').click()
  const search = previewSurface(page).getByTestId('web-search-tab')
  await expect(search).toBeVisible()
  await expect(search.getByTestId('web-search-result-title-0')).toHaveText(PREVIEW_SEARCH.webTitle)
  await expect(search.getByTestId('web-search-results').locator('article')).toHaveCount(2)
  const first = search.getByTestId('web-search-result-0').getByRole('checkbox')
  await first.click()
  await expect(first).toBeChecked()
  await expect(search.getByTestId('web-search-save')).toBeEnabled()
  await first.click()
  await expect(first).not.toBeChecked()
  await page.screenshot({ path: testInfo.outputPath('catalog-web-search.png'), fullPage: true })
})

test('literature search catalog restores a terminal task and consumes its actual result selection and details', { annotation: previewConsumption('viewer-literature_search', 'viewer-literature_search-states', ['loaded']) }, async ({ page }, testInfo) => {
  await openCatalogScene(page, 'viewer-literature_search')
  await previewSurface(page).getByRole('tab', { name: new RegExp(PREVIEW_SEARCH.literatureQuery) }).click()
  const search = previewSurface(page).getByTestId('literature-search-tab')
  await expect(search).toBeVisible()
  const rows = search.locator('[data-testid^="search-paper-"]')
  await expect(rows).toHaveCount(2)
  const first = rows.filter({ hasText: PREVIEW_SEARCH.literatureTitle })
  await expect(first).toContainText('Preview Research Team')
  const selection = first.getByRole('checkbox')
  await selection.click()
  await expect(selection).toBeChecked()
  await first.locator('p').click()
  await expect(first).toHaveAttribute('data-active', 'true')
  const details = search.locator('aside')
  await expect(details.getByText('作者：Preview Research Team', { exact: true })).toBeVisible()
  await expect(details.getByText('出版物：Mock Research Collection', { exact: true })).toBeVisible()
  await expect(details.getByText('年份：2026', { exact: true })).toBeVisible()
  await expect(details.getByText('模拟相关性说明：记录实验输入、方法与复现结果。', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('catalog-literature-search.png'), fullPage: true })
  await details.getByRole('button', { name: '收起详情', exact: true }).click()
  await expect(details).not.toBeVisible()
})

test('development components catalog entry returns to ordinary UI without a stale dev query', async ({ page }, testInfo) => {
  await openCatalogScene(page, 'development-components')
  await expect.poll(() => new URL(page.url()).searchParams.get('dev')).toBe('components')
  await expect(previewSurface(page).getByRole('heading', { name: 'Veda Design System', exact: true })).toBeVisible()
  await expect(previewSurface(page).locator('#theme-preview-mode')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('catalog-components.png'), fullPage: true })
  await openCatalogScene(page, 'viewer-projects', false)
  await expect.poll(() => new URL(page.url()).searchParams.has('dev')).toBe(false)
  await expect(previewSurface(page).getByTestId('projects-page')).toBeVisible()
  await expect(previewSurface(page).getByRole('heading', { name: 'Veda Design System', exact: true })).not.toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('catalog-components-returned.png'), fullPage: true })
})

test('project cards catalog entry consumes the real project listing', async ({ page }, testInfo) => {
  await openCatalogScene(page, 'viewer-projects')
  await expect(previewSurface(page).getByTestId('projects-page')).toBeVisible()
  await expect(previewSurface(page).getByTestId('project-card-设计协作项目')).toBeVisible()
  await expect(previewSurface(page).getByTestId('projects-search')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('catalog-projects.png'), fullPage: true })
})

test('literature catalog entry renders the real empty library', async ({ page }, testInfo) => {
  await openCatalogScene(page, 'viewer-literature')
  const literature = previewSurface(page).getByTestId('literature-overview')
  await expect(literature).toBeVisible()
  await expect(literature.getByText('暂无文献', { exact: true })).toBeVisible()
  await expect(literature.getByRole('alert')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('catalog-literature.png'), fullPage: true })
})

test('project form catalog entry opens the real validated form through its disclosed action', async ({ page }, testInfo) => {
  await openCatalogScene(page, 'surface-project-form')
  await previewSurface(page).getByTestId('home-project-create-top').click()
  const form = previewSurface(page).getByTestId('project-new-modal')
  await expect(form).toBeVisible()
  await previewSurface(page).getByTestId('project-create').click()
  await expect(form.getByText('请填写项目名', { exact: true }).first()).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('catalog-project-form.png'), fullPage: true })
  await form.getByRole('button', { name: '取消', exact: true }).click()
  await expect(form).not.toBeVisible()
})

test('menus catalog entry opens and dismisses the actual project menu', async ({ page }, testInfo) => {
  await openCatalogScene(page, 'surface-menus')
  await previewSurface(page).getByTestId('project-navigation-selector').click()
  await expect(previewSurface(page).getByTestId('project-menu')).toBeVisible()
  await expect(previewSurface(page).getByTestId('project-menu-option-设计协作项目')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('catalog-project-menu.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await expect(previewSurface(page).getByTestId('project-menu')).not.toBeVisible()
})

test('approval catalog entry drives the real composer and approval decision', async ({ page }, testInfo) => {
  await openCatalogScene(page, 'surface-approval')
  const message = `目录审批-${randomUUID()}`
  await previewSurface(page).getByTestId('composer-input').fill(message)
  await previewSurface(page).getByTestId('composer-send').click()
  await expect(previewSurface(page).getByTestId('user-bubble').getByText(message, { exact: true })).toBeVisible()
  const approval = previewSurface(page).locator('[data-hil-decision="allow-once"]')
  await expect(approval).toBeVisible()
  await capturePreview(page, testInfo.outputPath('catalog-approval-pending.png'))
  await approval.click()
  await expect(previewSurface(page).getByText('模拟审批已批准；没有执行真实命令。', { exact: true })).toBeVisible()
  await expect(approval).not.toBeVisible()
  await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('catalog-approval-completed.png'), fullPage: true })
})

test('login catalog entry displays the real unconfigured account notice and closes safely', async ({ page }, testInfo) => {
  await openCatalogScene(page, 'surface-login')
  await previewSurface(page).getByTestId('activity-account').click()
  await previewSurface(page).getByTestId('account-menu-anonymous-login').click()
  const login = previewSurface(page).getByTestId('account-login')
  await expect(login).toBeVisible()
  await expect(login.getByRole('heading', { name: '当前无需登录', exact: true })).toBeVisible()
  await expect(login.getByText('后端没有开启登录校验，应用已经可以直接使用。', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('catalog-login-unconfigured.png'), fullPage: true })
  await previewSurface(page).getByTestId('account-login-close').click()
  await expect(login).not.toBeVisible()
  await expect(previewSurface(page).getByTestId('project-center')).toBeVisible()
})

test('close catalog entry exercises only local typed actions and remembered preference', async ({ page }, testInfo) => {
  await openCatalogScene(page, 'surface-close')
  const host = previewSurface(page).getByTestId('preview-close-host')
  const dialog = previewSurface(page).getByTestId('window-close-dialog')
  await expect(host).toBeVisible()
  for (const [index, decision] of [
    { label: '取消', action: WINDOW_CLOSE_ACTION.cancel, remember: false },
    { label: '退出书深', action: WINDOW_CLOSE_ACTION.quit, remember: true },
    { label: '最小化到托盘', action: WINDOW_CLOSE_ACTION.minimize, remember: false },
  ].entries()) {
    await previewSurface(page).getByTestId('preview-close-open').click()
    await expect(dialog).toBeVisible()
    const remember = dialog.getByRole('checkbox', { name: '不再询问', exact: true })
    await expect(remember).not.toBeChecked()
    if (decision.remember) await remember.check()
    await page.screenshot({ path: testInfo.outputPath(`catalog-close-${decision.action}.png`), fullPage: true })
    await dialog.getByRole('button', { name: decision.label, exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect.poll(async () => JSON.parse(await previewSurface(page).getByTestId('preview-close-reply').innerText())).toEqual({ requestId: index + 1, action: decision.action, remember: decision.remember })
    await expect(host).toBeVisible()
  }
  await previewSurface(page).getByTestId('preview-close-open').click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect.poll(async () => JSON.parse(await previewSurface(page).getByTestId('preview-close-reply').innerText())).toEqual({ requestId: 4, action: WINDOW_CLOSE_ACTION.cancel, remember: false })
  await page.screenshot({ path: testInfo.outputPath('catalog-close-local-reply.png'), fullPage: true })
})

test('error catalog entry uses the real boundary and its explicit recovery owner', async ({ page }, testInfo) => {
  await openCatalogScene(page, 'surface-error')
  const trigger = previewSurface(page).getByTestId('preview-error-trigger')
  const recover = previewSurface(page).getByTestId('preview-error-recover')
  await expect(recover).toBeDisabled()
  await trigger.click()
  await expect(previewSurface(page).getByRole('heading', { name: '页面遇到了一些问题', exact: true })).toBeVisible()
  await expect(previewSurface(page).getByText('应用暂时无法继续显示', { exact: true })).toBeVisible()
  await expect(trigger).toBeDisabled()
  await expect(recover).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('catalog-error-caught.png'), fullPage: true })
  await recover.click()
  await expect(previewSurface(page).getByRole('heading', { name: '页面遇到了一些问题', exact: true })).not.toBeVisible()
  await expect(trigger).toBeEnabled()
  await expect(recover).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('catalog-error-recovered.png'), fullPage: true })
})

test('version comparison catalog entry preserves file identity and renders both real Monaco revisions', async ({ page }, testInfo) => {
  const opened = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/workbench/open' && url.searchParams.get('path') === 'readme.md'
  })
  await openCatalogScene(page, 'viewer-version_diff')
  const projection = await (await opened).json() as { asset_id: string; revision: string; versioning: ResourceCapability }
  await expect(previewSurface(page).getByRole('heading', { name: 'Revision notes', exact: true })).toBeVisible()
  const historyResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/versions') && response.request().method() === 'GET')
  await previewSurface(page).getByTestId('document-version-history').click()
  const history = await (await historyResponse).json() as ResourceVersionPage & { file_id: string }
  expect(history.total).toBe(2)
  expect(history.versions).toHaveLength(2)
  expect(history.file_id).toBe(projection.asset_id)
  expect(projection.versioning.file_id).toBe(history.file_id)
  const historical = history.versions.find(version => version.sequence === 1)!
  const current = history.versions.find(version => version.sequence === 2)!
  expect(historical).toBeDefined()
  expect(current).toBeDefined()
  expect(historical.file_id).toBe(history.file_id)
  expect(current.file_id).toBe(history.file_id)
  expect(current.id).toBe(projection.versioning.version_id)
  expect(current.object_id).toBe(projection.revision)
  expect(projection.versioning.working_revision).toBe(projection.revision)
  expect(projection.versioning.disk_revision).toBe(projection.revision)
  expect(historical.id).not.toBe(current.id)
  const rows = previewSurface(page).locator('.vds-version-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.filter({ has: previewSurface(page).getByText('v2', { exact: true }) })).toContainText('当前版本')
  await expect.poll(() => previewSurface(page).locator('body').evaluate(() => document.getAnimations().some(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity))).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('catalog-version-history.png'), fullPage: true })
  const historicalContent = page.waitForResponse(response => new URL(response.url()).pathname === `/api/resource/versions/${encodeURIComponent(historical.id)}/content`)
  const currentContent = page.waitForResponse(response => new URL(response.url()).pathname === `/api/resource/versions/${encodeURIComponent(current.id)}/content`)
  await rows.filter({ has: previewSurface(page).getByText('v1', { exact: true }) }).getByTestId('version-history-row-action').click()
  const baselineText = await (await historicalContent).text()
  const currentText = await (await currentContent).text()
  expect(baselineText).toContain('# Minimal Project')
  expect(baselineText).not.toContain('## Revision notes')
  expect(currentText).toContain('## Revision notes')
  expect(currentText).toContain('The reviewed preview revision adds a reproducible comparison example.')
  const comparison = previewSurface(page).getByTestId('version-text-diff')
  await expect(comparison).toBeVisible()
  const original = comparison.contentFrame().locator('.original .view-lines')
  const modified = comparison.contentFrame().locator('.modified .view-lines')
  await expect(original).toBeVisible()
  await expect(modified).toBeVisible()
  await expect(original).toContainText('Minimal Project')
  await expect(original).not.toContainText('Revision notes')
  await expect(modified).toContainText('Revision notes')
  await expect(modified).toContainText('The reviewed preview revision adds a reproducible comparison example.')
  const path = testInfo.outputPath('version-identity.json')
  await writeFile(path, JSON.stringify({ projection, history }, null, 2))
  await testInfo.attach('version-identity', { path, contentType: 'application/json' })
  await expect.poll(() => previewSurface(page).locator('body').evaluate(() => document.getAnimations().some(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity))).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('catalog-version-comparison.png'), fullPage: true })
})

for (const scenario of [
  { id: 'feedback-normal', title: '反馈正常提交', status: 200, error: null },
  { id: 'feedback-failed', title: '反馈提交失败', status: 502, error: 'feedback upstream unavailable' },
  { id: 'feedback-rate-limited', title: '反馈频率限制', status: 429, error: '提交过于频繁，请稍后再试。' },
] as const) {
  test(`feedback catalog entry ${scenario.id} consumes the real submission and preserves applicable state`, async ({ page }, testInfo) => {
    const focusEvidence: unknown[] = []
    const captureFocus = async (stage: string): Promise<void> => {
      focusEvidence.push(await previewSurface(page).locator('body').evaluate((_body, stage) => {
        const active = document.activeElement
        const dialog = document.querySelector('[data-testid="feedback-dialog"]')
        return { stage, tag: active?.tagName, testId: active?.getAttribute('data-testid'), id: active?.id, inDialog: Boolean(active && dialog?.contains(active)), disabled: active?.getAttribute('disabled') }
      }, stage))
      const path = testInfo.outputPath('feedback-focus.json')
      await writeFile(path, JSON.stringify(focusEvidence, null, 2))
      await testInfo.attach(`feedback-focus-${stage}`, { path, contentType: 'application/json' })
    }
    await openCatalogScene(page, 'surface-feedback', true, scenario.title)
    await previewSurface(page).getByTestId('activity-account').click()
    await previewSurface(page).getByTestId('account-menu-feedback').click()
    const dialog = previewSurface(page).getByTestId('feedback-dialog')
    const description = previewSurface(page).getByTestId('feedback-description')
    const submit = previewSurface(page).getByTestId('feedback-submit')
    await expect(dialog).toBeVisible()
    await expect(submit).toBeDisabled()
    await expect(previewSurface(page).getByTestId('feedback-auto-screenshot')).toHaveCount(0)
    await previewSurface(page).getByTestId('feedback-include-logs').uncheck()
    await expect(previewSurface(page).getByTestId('feedback-include-logs')).not.toBeChecked()
    await expect(previewSurface(page).getByTestId('feedback-include-trace')).not.toBeChecked()
    const message = `预览反馈-${randomUUID()}`
    await description.fill(message)
    const submitOnce = async (): Promise<void> => {
      await captureFocus('before-submit')
      if (scenario.status !== 200) EXPECTED_FAILURES.get(page)!.push({ method: 'POST', path: FEEDBACK_PATH, status: scenario.status })
      const submitted = page.waitForResponse(response => new URL(response.url()).pathname === FEEDBACK_PATH && response.request().method() === 'POST')
      await submit.click()
      const response = await submitted
      expect(response.status()).toBe(scenario.status)
      const multipart = response.request().postDataBuffer()!.toString('utf8')
      expect(multipart).toContain('name="include_logs"\r\n\r\nfalse')
      expect(multipart).toContain('name="include_trace"\r\n\r\nfalse')
      expect(multipart).not.toContain('filename=')
      expect(multipart).not.toContain('name="recording_report"')
      expect(multipart).not.toContain('name="renderer_diagnostics"')
      if (scenario.status !== 200) {
        await expect(submit).toBeEnabled()
        await captureFocus('response-enabled')
      }
    }
    await submitOnce()
    if (scenario.error === null) {
      await expect(previewSurface(page).getByTestId('feedback-done')).toContainText('已收到，谢谢你的反馈。')
      await expect(previewSurface(page).getByTestId('feedback-done')).toContainText('preview-feedback:')
      await expect(description).not.toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`${scenario.id}.png`), fullPage: true })
      await dialog.getByRole('button', { name: '完成', exact: true }).click()
    } else {
      await expect(dialog.getByText(scenario.error, { exact: true })).toBeVisible()
      await expect(description).toHaveValue(message)
      await expect(submit).toBeEnabled()
      await expect(previewSurface(page).getByTestId('feedback-done')).toHaveCount(0)
      await submitOnce()
      await expect(dialog.getByText(scenario.error, { exact: true })).toBeVisible()
      await expect(description).toHaveValue(message)
      await expect(submit).toBeEnabled()
      await page.screenshot({ path: testInfo.outputPath(`${scenario.id}.png`), fullPage: true })
      await captureFocus('before-escape')
      await page.keyboard.press('Escape')
      await captureFocus('after-escape')
    }
    await expect(dialog).not.toBeVisible()
  })
}

for (const surface of SURFACES) {
  test(`${surface.id} follows disclosed real project UI entry`, async ({ page }, testInfo) => {
    const failures: FailedRequest[] = []
    page.on('response', response => {
      const path = new URL(response.url()).pathname
      if (path.startsWith('/api/') && response.status() >= 400) {
        failures.push({ method: response.request().method(), path, status: response.status() })
      }
    })
    try {
      await selectSurface(page, surface.id)
      const library = previewSurface(page).getByTestId('project-library-content')
      if (surface.category) await library.getByRole('tab', { name: surface.category, exact: true }).click()
      if (surface.id === 'viewer-explorer') {
        await library.getByRole('button', { name: '项目资源管理器', exact: true }).click()
      }
      const content = previewSurface(page).getByTestId(surface.surface)
      await expect(content).toBeVisible()
      if (surface.empty) {
        await expect(content.getByText(surface.empty, { exact: true })).toBeVisible()
      } else if (surface.id === 'viewer-explorer') {
        await expect(content.getByTestId('explorer-node-readme.md')).toBeVisible()
      } else {
        await expect(content.getByTestId('material-readme.md')).toBeVisible()
      }
      await expect(content.getByRole('button', { name: '读取失败，点击重试', exact: true })).not.toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`${surface.id}-real-entry.png`), fullPage: true })
      expect(failures, 'Real surface consumption must not silently rely on rejected API requests').toEqual([])
    } finally {
      const path = testInfo.outputPath('surface-api-failures.json')
      await writeFile(path, JSON.stringify(failures, null, 2))
      await testInfo.attach('surface-api-failures', { path, contentType: 'application/json' })
    }
  })
}
