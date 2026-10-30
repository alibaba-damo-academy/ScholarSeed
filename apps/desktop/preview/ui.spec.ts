import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewScenario, openPreviewTools, previewSurface, test, expect, type Frame, type Page } from './testing'
import { PREVIEW_CATALOG } from './catalog'
import type { PreviewDiagnosticSnapshot } from './diagnostics'
import { PREVIEW_OFFICE_FRAME_PATH } from './frames'
import { previewConsumption } from './coverage'
import { capturePreview } from './capture'

const MOCK_TITLE = 'PDFE 工作台'
const STREAM_SCENARIO = '模拟对话与流式回复'
const APPROVAL_SCENARIO = '审批允许、拒绝与继续'
const FAILURE_SCENARIO = '断线、失败与恢复'
const GEOMETRY_ROUNDING_PX = 1
const CSP_CODE_GENERATION_SCRIPT = "try { document.documentElement.dataset.previewEvalProbe = String(Function('return 7')()) } catch (error) { document.documentElement.dataset.previewEvalProbe = error.name }"
const SESSION_RESPONSES = new WeakMap<Page, Promise<unknown>[]>()
const RUNTIME_DIAGNOSTICS = new WeakMap<Page, unknown[]>()

async function probeCodeGeneration(target: Page | Frame, trigger: () => Promise<void>): Promise<unknown> {
  await target.evaluate((source) => {
    delete document.documentElement.dataset.previewCspOutcome
    const finish = (violation: { directive: string; blockedURI: string; policy: string } | null): void => {
      document.removeEventListener('securitypolicyviolation', onViolation)
      const result = document.documentElement.dataset.previewEvalProbe
      delete document.documentElement.dataset.previewEvalProbe
      document.documentElement.dataset.previewCspOutcome = JSON.stringify({ result, violation })
    }
    const onViolation = (event: SecurityPolicyViolationEvent): void => finish({ directive: event.effectiveDirective, blockedURI: event.blockedURI, policy: event.originalPolicy })
    document.addEventListener('securitypolicyviolation', onViolation)
    document.addEventListener('click', () => {
      const script = document.createElement('script')
      script.textContent = source
      document.body.appendChild(script)
      script.remove()
      if (document.documentElement.dataset.previewEvalProbe === '7') finish(null)
    }, { once: true, capture: true })
  }, CSP_CODE_GENERATION_SCRIPT)
  await trigger()
  await expect.poll(() => target.evaluate(() => document.documentElement.dataset.previewCspOutcome ?? null)).not.toBeNull()
  return target.evaluate(() => {
    const outcome = JSON.parse(document.documentElement.dataset.previewCspOutcome!)
    delete document.documentElement.dataset.previewCspOutcome
    return outcome
  })
}

test.beforeEach(async ({ page }) => {
  const responses: Promise<unknown>[] = []
  const diagnostics: unknown[] = []
  SESSION_RESPONSES.set(page, responses)
  RUNTIME_DIAGNOSTICS.set(page, diagnostics)
  page.on('pageerror', (error) => diagnostics.push({ type: 'pageerror', message: error.message, stack: error.stack }))
  page.on('console', (message) => {
    if (message.type() === 'error' || message.text().startsWith('[office')) diagnostics.push({ type: 'console', message: message.text(), location: message.location() })
  })
  page.on('requestfailed', (request) => diagnostics.push({ type: 'requestfailed', url: request.url(), method: request.method(), error: request.failure()?.errorText }))
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (path.startsWith('/office/') || path.startsWith('/fonts/')) diagnostics.push({ type: 'office-resource', path, status: response.status() })
    if (response.status() >= 400) diagnostics.push({ type: 'response', path, method: response.request().method(), status: response.status() })
    if (!path.startsWith('/api/serve/') || path.endsWith('/events')) return
    responses.push(response.json().then((body) => ({ path, method: response.request().method(), request: response.request().postDataJSON(), status: response.status(), body })).catch(() => ({ path, status: response.status(), unreadable: true })))
  })
})

test.afterEach(async ({ page }, testInfo) => {
  const evidence = await Promise.all(SESSION_RESPONSES.get(page) ?? [])
  const path = testInfo.outputPath('session-responses.json')
  await writeFile(path, JSON.stringify(evidence, null, 2))
  await testInfo.attach('preview-session-responses', { path, contentType: 'application/json' })
  const diagnosticsPath = testInfo.outputPath('runtime-diagnostics.json')
  await writeFile(diagnosticsPath, JSON.stringify(RUNTIME_DIAGNOSTICS.get(page) ?? [], null, 2))
  await testInfo.attach('preview-runtime-diagnostics', { path: diagnosticsPath, contentType: 'application/json' })
})

async function openPreview(page: Page): Promise<void> {
  await page.goto(`/?previewInstance=${randomUUID()}&scene=page-home`)
  await expect(page.getByRole('heading', { name: MOCK_TITLE, exact: true })).toBeVisible()
}

async function choose(page: Page, id: string, title: string): Promise<void> {
  await openPreviewTools(page)
  await page.locator(`#${id}`).click()
  await page.getByRole('option', { name: title, exact: true }).click()
}

async function openConversation(page: Page, scenario: string): Promise<void> {
  await page.keyboard.press('F8')
  const entry = PREVIEW_CATALOG.find(page => page.id === 'page-conversation')!
  await openPreviewScenario(page, entry.id, entry.scenarios.find(candidate => candidate.title === scenario)!.id)
  await expect(previewSurface(page).getByTestId('composer-input')).toBeVisible()
  await expect(page.getByRole('heading', { name: MOCK_TITLE, exact: true })).toBeVisible()
}

async function send(page: Page, text: string): Promise<void> {
  await previewSurface(page).getByTestId('composer-input').fill(text)
  await expect(previewSurface(page).getByTestId('composer-send')).toBeEnabled()
  await previewSurface(page).getByTestId('composer-send').click()
  await expect(previewSurface(page).getByTestId('user-bubble').getByText(text, { exact: true })).toBeVisible()
}

async function expectHealthyConversation(page: Page): Promise<void> {
  await expect(previewSurface(page).getByText('消息入队结果暂时无法确认，请在待处理消息中检查发送结果。', { exact: true })).not.toBeVisible()
  await expect(previewSurface(page).getByText('对话执行被中断，发送结果未能确认。', { exact: true })).not.toBeVisible()
  await expect(previewSurface(page).getByText('无法读取审阅快照状态，请稍后重试。', { exact: true })).not.toBeVisible()
}

async function leaveAndReenterConversation(page: Page): Promise<void> {
  const standaloneHome = previewSurface(page).getByRole('button', { name: '返回首页', exact: true })
  if (await standaloneHome.isVisible()) await standaloneHome.click()
  else await previewSurface(page).getByRole('button', { name: '返回项目中心', exact: true }).click()
  await expect(previewSurface(page).getByTestId('project-center')).toBeVisible()
  await previewSurface(page).getByTestId('home-task-preview-session').click()
  await expect(previewSurface(page).getByTestId('composer-input')).toBeVisible()
}

test('home and console use real renderer with explicit mock boundary', async ({ page }, testInfo) => {
  await openPreview(page)
  await page.keyboard.press('F8')
  await expect(page.getByRole('heading', { name: MOCK_TITLE, exact: true })).toBeVisible()
  await expect(page.getByText('同一套产品 UI，隔离的模拟数据；不代表真实功能已验收。', { exact: true })).toBeVisible()
  await expect(page.getByTestId('preview-page-page-home')).toHaveAttribute('aria-expanded', 'true')
  const panel = page.getByRole('dialog', { name: MOCK_TITLE, exact: true })
  await expect.poll(() => panel.evaluate((element) => element.getAnimations().some((animation) => animation.playState === 'running' || animation.pending))).toBe(false)
  const geometry = await panel.evaluate((element) => ({
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
    viewport: window.innerWidth,
    content: element.scrollWidth,
    width: element.clientWidth,
  }))
  expect(geometry.left).toBeGreaterThanOrEqual(-GEOMETRY_ROUNDING_PX)
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + GEOMETRY_ROUNDING_PX)
  expect(geometry.content).toBeLessThanOrEqual(geometry.width + GEOMETRY_ROUNDING_PX)
  await page.screenshot({ path: testInfo.outputPath('home-console.png'), fullPage: true })
  await page.getByRole('button', { name: '关闭预览控制台', exact: true }).click()
  await expect(page.getByRole('heading', { name: MOCK_TITLE, exact: true })).not.toBeVisible()
})

test('theme and language persist through console save and reload', async ({ page }, testInfo) => {
  await openPreview(page)
  await page.keyboard.press('F8')
  await choose(page, 'preview-theme', '深色')
  await choose(page, 'preview-language', 'English')
  await page.getByRole('button', { name: '保存外观并重新加载', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'PDFE Workbench', exact: true })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('html')).toHaveAttribute('lang', /^en/)
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByRole('heading', { name: 'PDFE Workbench', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('dark-english.png'), fullPage: true })
})

test('real composer consumes simulated stream and completes', { annotation: previewConsumption('page-conversation', 'conversation-stream', ['idle', 'completed']) }, async ({ page }, testInfo) => {
  await openPreview(page)
  await openConversation(page, STREAM_SCENARIO)
  await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible()
  await send(page, '检查模拟流式回复')
  await expect(previewSurface(page).getByText('这是模拟流式回答。', { exact: true })).toBeVisible()
  await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible()
  await expectHealthyConversation(page)
  await page.screenshot({ path: testInfo.outputPath('stream-completed.png'), fullPage: true })
  const secondQuestion = '继续第二轮并检查历史一致性'
  await send(page, secondQuestion)
  await expect(previewSurface(page).getByText('这是模拟流式回答。', { exact: true })).toHaveCount(2)
  await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible()
  await leaveAndReenterConversation(page)
  await page.reload()
  await expect(previewSurface(page).getByTestId('user-bubble').getByText('检查模拟流式回复', { exact: true })).toHaveCount(1)
  await expect(previewSurface(page).getByTestId('user-bubble').getByText(secondQuestion, { exact: true })).toHaveCount(1)
  await expect(previewSurface(page).getByText('这是模拟流式回答。', { exact: true })).toHaveCount(2)
  await expect.poll(async () => {
    const responses = await Promise.all(SESSION_RESPONSES.get(page) ?? []) as { path: string; body?: { turns?: { kind: string }[] } }[]
    return responses.filter(response => response.path.startsWith('/api/serve/history/')).at(-1)?.body?.turns?.filter(turn => turn.kind === 'user').length
  }).toBe(2)
  await expectHealthyConversation(page)
  await page.screenshot({ path: testInfo.outputPath('stream-multiple-turns-reloaded.png'), fullPage: true })
})

test('real tool activity expands its simulated input and output and restores the same tool history', { annotation: previewConsumption('page-conversation', 'conversation-tool', ['completed']) }, async ({ page }, testInfo) => {
  await openPreview(page)
  await openConversation(page, '模拟工具调用')
  await send(page, '检查模拟工具卡输入与输出')
  await expect(previewSurface(page).getByText('已完成模拟工具调用，可检查工具展开与结果布局。', { exact: true })).toBeVisible()
  await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible()
  const activity = previewSurface(page).getByTestId('turn-activity-trigger')
  if (await activity.getAttribute('aria-expanded') !== 'true') await activity.click()
  const tool = previewSurface(page).getByTestId('tool-run-step')
  await expect(tool).toBeVisible()
  const trigger = tool.getByRole('button').first()
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(tool).toContainText('readme.md')
  await expect(tool).toContainText('模拟文件内容')
  await capturePreview(page, testInfo.outputPath('tool-expanded.png'))
  await page.reload()
  await expect(previewSurface(page).getByText('已完成模拟工具调用，可检查工具展开与结果布局。', { exact: true })).toBeVisible()
  if (await activity.getAttribute('aria-expanded') !== 'true') await activity.click()
  await expect(previewSurface(page).getByTestId('tool-run-step')).toHaveCount(1)
  await expect(previewSurface(page).getByTestId('tool-run-step')).toContainText('readme.md')
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
  await expect(tool.locator('[aria-hidden="false"]')).toContainText('模拟文件内容')
  await expectHealthyConversation(page)
  await capturePreview(page, testInfo.outputPath('tool-history-reloaded.png'))
})

for (const decision of [
  { name: 'allow', selector: '[data-hil-decision="allow-once"]', result: '模拟审批已批准；没有执行真实命令。' },
  { name: 'deny', selector: '[data-hil-decision="deny"]', result: '已拒绝模拟审批；没有执行任何操作。' },
] as const) {
  test(`real approval ${decision.name} resolves the waiting turn without real tools`, { annotation: [previewConsumption('page-conversation', 'conversation-approval', ['waiting', decision.name === 'allow' ? 'approved' : 'rejected']), previewConsumption('surface-approval', 'conversation-approval', ['waiting', decision.name === 'allow' ? 'approved' : 'rejected'])] }, async ({ page }, testInfo) => {
    await openPreview(page)
    await openConversation(page, APPROVAL_SCENARIO)
    await send(page, `验证审批 ${decision.name}`)
    await expect(previewSurface(page).locator(decision.selector)).toBeVisible()
    await expect(previewSurface(page).getByText(decision.result, { exact: true })).not.toBeVisible()
    await capturePreview(page, testInfo.outputPath(`approval-${decision.name}-waiting.png`))
    await previewSurface(page).locator(decision.selector).click()
    await expect(previewSurface(page).getByText(decision.result, { exact: true })).toBeVisible()
    await expect(previewSurface(page).locator(decision.selector)).not.toBeVisible()
    await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible()
    await expectHealthyConversation(page)
    await page.screenshot({ path: testInfo.outputPath(`approval-${decision.name}-resolved.png`), fullPage: true })
  })
}

test('cancel interrupts a waiting approval through the real stop action', async ({ page }, testInfo) => {
  await openPreview(page)
  await openConversation(page, APPROVAL_SCENARIO)
  await send(page, '取消模拟审批回合')
  await expect(previewSurface(page).locator('[data-hil-decision="allow-once"]')).toBeVisible()
  await previewSurface(page).getByTestId('composer-stop').click()
  await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible()
  await expect(previewSurface(page).locator('[data-hil-decision="allow-once"]')).not.toBeVisible()
  await expect(previewSurface(page).getByText('模拟审批已批准；没有执行真实命令。', { exact: true })).not.toBeVisible()
  await expect(previewSurface(page).getByTestId('composer-input')).toBeVisible()
  await expectHealthyConversation(page)
  await page.screenshot({ path: testInfo.outputPath('approval-cancelled.png'), fullPage: true })
})

test('project files open real Markdown and PDF viewers and retain saved edits after reload', async ({ page }, testInfo) => {
  const failedResponses: { path: string; status: number }[] = []
  page.on('response', (response) => {
    if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() })
  })
  await openPreview(page)
  await page.keyboard.press('F8')
  const entry = PREVIEW_CATALOG.find(page => page.id === 'page-resource')!
  await openPreviewScenario(page, entry.id, entry.scenarios[0].id)
  await previewSurface(page).getByTestId('project-library').click()
  const files = previewSurface(page).getByTestId('material-list')
  await expect(files).toBeVisible()
  await files.getByRole('button', { name: 'readme.md', exact: true }).click()
  const editor = previewSurface(page).getByTestId('markdown-visual-editor').locator('.ProseMirror')
  await expect(editor).toContainText('Minimal Project')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText(' Saved in preview VFS.')
  await expect(editor).toContainText('Saved in preview VFS.')
  const saved = page.waitForResponse((response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/workbench/content' && response.ok())
  await previewSurface(page).getByTestId('markdown-save').click()
  await saved
  await page.reload()
  await expect(previewSurface(page).getByTestId('markdown-visual-editor').locator('.ProseMirror')).toContainText('Saved in preview VFS.')
  await page.screenshot({ path: testInfo.outputPath('markdown-saved-reopened.png'), fullPage: true })
  await previewSurface(page).getByTestId('project-library').click()
  const regions = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workbench/pdf/regions')
  await previewSurface(page).getByTestId('material-list').getByRole('button', { name: 'sample.pdf', exact: true }).click()
  await expect(previewSurface(page).getByTestId('pdf-page-1').locator('canvas')).toBeVisible()
  const regionResponse = await regions
  expect(regionResponse.status()).toBe(200)
  expect(await regionResponse.json()).toMatchObject({ detector_version: 'preview-unavailable', page_count: 1, unavailable_pages: [1], pages: [{ page: 1, unavailable: true, regions: [] }] })
  await testInfo.attach('preview-failed-responses', { body: JSON.stringify(failedResponses, null, 2), contentType: 'application/json' })
  expect(failedResponses).toEqual([])
  await expect(previewSurface(page).getByText('批注读取失败，请重新打开文件后重试。', { exact: true })).not.toBeVisible()
  await expect(previewSurface(page).getByText('没读到项目目录。本地服务可能还没就绪，稍后点刷新重试。', { exact: true })).not.toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('pdf-sample.png'), fullPage: true })
})

test('failed simulated turn exposes real retry action and retry completes', { annotation: previewConsumption('page-conversation', 'conversation-recovery', ['failed', 'recovered']) }, async ({ page }, testInfo) => {
  await openPreview(page)
  await openConversation(page, FAILURE_SCENARIO)
  await send(page, '验证失败后的原生重试入口')
  await expect(previewSurface(page).getByTestId('turn-recoverable-notice')).toContainText('本轮未能完成。')
  await expect(previewSurface(page).getByTestId('turn-continue')).toBeEnabled()
  await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('failure-before-retry.png'), fullPage: true })
  await previewSurface(page).getByTestId('turn-continue').click()
  await expect(previewSurface(page).getByText('这里复用真实产品组件与事件投影。', { exact: true })).toBeVisible()
  await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible()
  await expect(previewSurface(page).getByTestId('turn-continue-error')).not.toBeVisible()
  await expectHealthyConversation(page)
  await page.screenshot({ path: testInfo.outputPath('failure-retry-completed.png'), fullPage: true })
})

test('pending approval and completed history survive leaving and reentering the session', async ({ page }, testInfo) => {
  const question = '验证离开再进入的审批与历史一致性'
  const answer = '模拟审批已批准；没有执行真实命令。'
  await openPreview(page)
  await openConversation(page, APPROVAL_SCENARIO)
  await send(page, question)
  await expect(previewSurface(page).locator('[data-hil-decision="allow-once"]')).toBeVisible()
  await leaveAndReenterConversation(page)
  await expect(previewSurface(page).getByTestId('user-bubble').getByText(question, { exact: true })).toHaveCount(1)
  await expect(previewSurface(page).locator('[data-hil-decision="allow-once"]')).toHaveCount(1)
  await expect(previewSurface(page).locator('[data-hil-decision="allow-once"]')).toBeVisible()
  await expect(previewSurface(page).getByText(answer, { exact: true })).not.toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('approval-pending-reentered.png'), fullPage: true })
  await previewSurface(page).locator('[data-hil-decision="allow-once"]').click()
  await expect(previewSurface(page).getByText(answer, { exact: true })).toBeVisible()
  await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible()
  await leaveAndReenterConversation(page)
  await expect(previewSurface(page).getByTestId('user-bubble').getByText(question, { exact: true })).toHaveCount(1)
  await expect(previewSurface(page).getByText(answer, { exact: true })).toHaveCount(1)
  await expect(previewSurface(page).getByText(answer, { exact: true })).toBeVisible()
  await expect(previewSurface(page).locator('[data-hil-decision="allow-once"]')).not.toBeVisible()
  await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible()
  await expectHealthyConversation(page)
  await page.screenshot({ path: testInfo.outputPath('approval-history-reentered.png'), fullPage: true })
})

test('unknown preview page reports its identity instead of silently showing home', async ({ page }, testInfo) => {
  await page.goto(`/?previewInstance=${randomUUID()}&scene=unknown-preview-scene&page=unknown-preview-page`)
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.locator('pre')).toContainText('400')
  await expect(page.locator('pre')).toContainText('preview_unknown_page')
  await expect(page.locator('pre')).toContainText('unknown-preview-page')
  await expect(page.locator('pre')).toContainText('unknown-preview-scene')
  await expect(page.getByTestId('project-center')).not.toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('unavailable-scene-diagnostic.png'), fullPage: true })
})

for (const viewer of ['markdown', 'code', 'pdf'] as const) {
  test(`direct ${viewer} scene restores the actual shared viewer`, { annotation: previewConsumption(`viewer-${viewer}`, `viewer-${viewer}-states`, ['loaded']) }, async ({ page }, testInfo) => {
    const regions = viewer === 'pdf' ? page.waitForResponse(response => new URL(response.url()).pathname === '/api/workbench/pdf/regions') : null
    await page.goto(`/?previewInstance=${randomUUID()}&scene=viewer-${viewer}-states&page=viewer-${viewer}`)
    if (viewer === 'markdown') {
      await expect(previewSurface(page).getByRole('heading', { name: 'Minimal Project', exact: true })).toBeVisible()
    } else if (viewer === 'code') {
      await expect(previewSurface(page).getByTestId('monaco-editor').contentFrame().locator('.view-lines')).toContainText('hello from minimal project')
    } else {
      await expect(previewSurface(page).getByTestId('pdf-page-1').locator('canvas')).toBeVisible()
      const regionResponse = await regions!
      expect(regionResponse.status()).toBe(200)
      expect(await regionResponse.json()).toMatchObject({ detector_version: 'preview-unavailable', page_count: 1, unavailable_pages: [1], pages: [{ page: 1, unavailable: true, regions: [] }] })
    }
    await expect(previewSurface(page).getByText('无法解析文件路径。', { exact: false })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`direct-${viewer}.png`), fullPage: true })
  })
}

for (const viewer of ['image', 'office', 'spreadsheet', 'table', 'unsupported'] as const) {
  test(`direct ${viewer} scene consumes the reviewed sample in its real viewer`, { annotation: previewConsumption(`viewer-${viewer}`, `viewer-${viewer}-states`, ['loaded']) }, async ({ page }, testInfo) => {
    await page.goto(`/?previewInstance=${randomUUID()}&scene=viewer-${viewer}-states&page=viewer-${viewer}`)
    if (viewer === 'image') {
      const image = previewSurface(page).getByTestId('image-viewer').getByRole('img', { name: 'sample.png', exact: true })
      await expect(image).toBeVisible()
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => ({ complete: element.complete, width: element.naturalWidth, height: element.naturalHeight }))).toEqual({ complete: true, width: 200, height: 200 })
      await expect(previewSurface(page).getByTestId('image-dimensions')).toHaveText('200 × 200')
      await expect(previewSurface(page).getByTestId('image-viewer').getByRole('alert')).toHaveCount(0)
    } else if (viewer === 'office') {
      const preview = previewSurface(page).getByTestId('office-preview')
      await expect(preview).toHaveAttribute('data-office-title', 'sample.docx')
      await expect(preview).toHaveAttribute('data-office-format', 'docx')
      await expect(previewSurface(page).getByTestId('office-preview-content')).toContainText('Normal + Courier New')
      await expect(preview.getByRole('status')).toHaveCount(0)
      await expect(preview.getByRole('alert')).toHaveCount(0)
    } else if (viewer === 'spreadsheet') {
      const grid = previewSurface(page).getByTestId('csv-grid')
      await expect(grid).toBeVisible()
      await expect(grid).toContainText('Temperature')
      await expect(grid).toContainText('Pressure')
      await expect(previewSurface(page).getByTestId('csv-document').getByRole('alert')).toHaveCount(0)
    } else if (viewer === 'table') {
      const table = previewSurface(page).getByTestId('table-viewer')
      await expect(table).toBeVisible()
      await expect(table.getByRole('columnheader', { name: 'Label', exact: true })).toBeVisible()
      await expect(table.getByRole('cell', { name: 'Temperature', exact: true })).toBeVisible()
      await expect(table.getByRole('cell', { name: '21.5', exact: true })).toBeVisible()
      await expect(table.getByRole('cell', { name: 'Pressure', exact: true })).toBeVisible()
      await expect(table.getByRole('cell', { name: '101.3', exact: true })).toBeVisible()
    } else {
      await expect(previewSurface(page).getByText('sample.bin 是二进制文件，暂不支持内置预览。可用系统默认应用查看。', { exact: true })).toBeVisible()
      await expect(previewSurface(page).getByRole('alert')).toHaveCount(0)
      await expect(previewSurface(page).getByTestId('project-center')).not.toBeVisible()
    }
    await expect(previewSurface(page).getByText('无法解析文件路径。', { exact: false })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`direct-${viewer}.png`), fullPage: true })
  })
}

test('legacy XLS opens from the real material list into its Office runtime', async ({ page }, testInfo) => {
  const childResponse = page.waitForResponse(response => new URL(response.url()).pathname === PREVIEW_OFFICE_FRAME_PATH)
  const mainResponse = await page.goto(`/?previewInstance=${randomUUID()}&scene=resource-states&page=page-resource`)
  await expect(previewSurface(page).getByTestId('project-library')).toBeVisible()
  const mainProbe = await probeCodeGeneration(page, () => previewSurface(page).getByTestId('project-library').click())
  const mainPolicy = mainResponse!.headers()['content-security-policy']
  const mainEvidence = testInfo.outputPath('main-csp-probe.json')
  await writeFile(mainEvidence, JSON.stringify({ policy: mainPolicy, probe: mainProbe }, null, 2))
  await testInfo.attach('main-csp-probe', { path: mainEvidence, contentType: 'application/json' })
  expect(mainPolicy).not.toContain("'unsafe-eval'")
  expect(mainProbe).toMatchObject({ result: 'EvalError', violation: { directive: 'script-src', blockedURI: 'eval', policy: mainPolicy } })
  await previewSurface(page).getByTestId('material-list').getByRole('button', { name: 'sample.xls', exact: true }).click()
  const document = previewSurface(page).locator('iframe[data-testid="office-editor"][title="sample.xls"]')
  try {
    await expect(document).toHaveAttribute('data-runtime-ready', 'true')
    await expect(document).toHaveAttribute('data-document-ready', 'true')
    await expect(document).toBeVisible()
    const bounds = await document.evaluate((element) => {
      const rectangle = element.getBoundingClientRect()
      return { left: rectangle.left, top: rectangle.top, right: rectangle.right, bottom: rectangle.bottom, width: rectangle.width, height: rectangle.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }
    })
    expect(bounds.width).toBeGreaterThan(0)
    expect(bounds.height).toBeGreaterThan(0)
    expect(bounds.left).toBeGreaterThanOrEqual(-GEOMETRY_ROUNDING_PX)
    expect(bounds.top).toBeGreaterThanOrEqual(-GEOMETRY_ROUNDING_PX)
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth + GEOMETRY_ROUNDING_PX)
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight + GEOMETRY_ROUNDING_PX)
    await expect(document.contentFrame().locator('#qtcanvas')).toBeVisible()
    const child = page.frames().find(frame => new URL(frame.url()).pathname === PREVIEW_OFFICE_FRAME_PATH)
    expect(child).toBeDefined()
    const childPolicy = (await childResponse).headers()['content-security-policy']
    const childProbe = await probeCodeGeneration(child!, () => document.contentFrame().locator('#qtcanvas').click())
    const path = testInfo.outputPath('child-csp-probe.json')
    await writeFile(path, JSON.stringify({ policy: childPolicy, probe: childProbe }, null, 2))
    await testInfo.attach('child-csp-probe', { path, contentType: 'application/json' })
    expect(childPolicy).toContain("'unsafe-eval'")
    expect(childProbe).toEqual({ result: '7', violation: null })
  } finally {
    const frames = await Promise.all(page.frames().map(async (frame) => ({
      url: frame.url(),
      state: await frame.evaluate(() => ({
        readyState: globalThis.document.readyState,
        isolated: globalThis.crossOriginIsolated,
        text: globalThis.document.body?.innerText,
        scripts: [...globalThis.document.scripts].map((script) => script.src),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        surfaces: [...globalThis.document.querySelectorAll('[data-office-anchor], iframe[data-testid="office-editor"]')].map((element) => {
          const bounds = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return { tag: element.tagName, anchor: element.getAttribute('data-office-anchor'), view: element.getAttribute('data-runtime-view'), runtimeReady: element.getAttribute('data-runtime-ready'), documentReady: element.getAttribute('data-document-ready'), bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height }, visibility: style.visibility, display: style.display, pointerEvents: style.pointerEvents }
        }),
      })).catch((error: Error) => ({ error: error.message })),
    })))
    const path = testInfo.outputPath('office-frames.json')
    await writeFile(path, JSON.stringify(frames, null, 2))
    await testInfo.attach('preview-office-frames', { path, contentType: 'application/json' })
  }
  await expect(previewSurface(page).getByText('无法解析文件路径。', { exact: false })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('legacy-xls-office.png'), fullPage: true })
})

test('project creation validates input and waits for the accepted operation before showing the project', async ({ page }, testInfo) => {
  const name = `预览创建-${randomUUID().slice(0, 8)}`
  await openPreview(page)
  await previewSurface(page).getByTestId('home-project-create-top').click()
  const form = previewSurface(page).getByTestId('project-new-modal')
  await expect(form).toBeVisible()
  await previewSurface(page).getByTestId('project-create').click()
  await expect(form.getByText('请填写项目名', { exact: true }).first()).toBeVisible()
  await expect(previewSurface(page).getByTestId('project-create-name')).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('project-required-name.png'), fullPage: true })
  await previewSurface(page).getByTestId('project-create-name').fill(name)
  const accepted = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/content/projects' && response.request().method() === 'POST' && response.status() === 202)
  await previewSurface(page).getByTestId('project-create').click()
  await accepted
  await expect(previewSurface(page).getByTestId('project-create')).toBeDisabled()
  await expect(previewSurface(page).getByTestId('project-create-name')).toBeDisabled()
  await expect(form.getByRole('button', { name: '取消', exact: true })).toBeDisabled()
  await expect(form).not.toBeVisible()
  await expect(previewSurface(page).getByRole('button', { name, exact: true })).toBeVisible()
  await previewSurface(page).getByRole('button', { name: '返回项目中心', exact: true }).click()
  await expect(previewSurface(page).getByTestId(`home-project-${name}`)).toBeVisible()
  await expect(previewSurface(page).getByText('无法创建项目，请重试。', { exact: true })).not.toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('project-created.png'), fullPage: true })
  await page.reload()
  await expect(previewSurface(page).getByTestId(`home-project-${name}`)).toBeVisible()
})

test('skill settings persist real toggles, show details, and delete only after confirmation', { annotation: previewConsumption('settings-skills', 'settings-skills-states', ['loaded', 'editing']) }, async ({ page }, testInfo) => {
  await page.goto(`/?previewInstance=${randomUUID()}&scene=settings-skills-states&page=settings-skills`)
  await expect(previewSurface(page).getByTestId('skills-tab-marketplace')).toHaveAttribute('aria-selected', 'true')
  await expect(previewSurface(page).getByTestId('skills-empty')).toBeVisible()
  await expect(previewSurface(page).getByTestId('skill-card-preview-notes')).toHaveCount(0)
  await expect(previewSurface(page).getByTestId('skill-card-preview-required')).toHaveCount(0)
  await expect(previewSurface(page).getByTestId('skill-card-preview-unavailable')).toHaveCount(0)
  await previewSurface(page).getByTestId('skills-tab-scholarseed').click()
  await expect(previewSurface(page).getByTestId('skill-toggle-preview-required')).toBeDisabled()
  await expect(previewSurface(page).getByTestId('skill-toggle-preview-required')).toHaveAttribute('aria-checked', 'true')
  await expect(previewSurface(page).getByTestId('skill-more-preview-required')).not.toBeVisible()
  await previewSurface(page).getByTestId('skills-tab-user').click()
  const card = previewSurface(page).getByTestId('skill-card-preview-notes')
  const toggle = previewSurface(page).getByTestId('skill-toggle-preview-notes')
  await expect(card).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await page.reload()
  await expect(previewSurface(page).getByTestId('skills-tab-marketplace')).toHaveAttribute('aria-selected', 'true')
  await previewSurface(page).getByTestId('skills-tab-user').click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await previewSurface(page).getByTestId('skill-view-preview-notes').click()
  const detail = previewSurface(page).getByTestId('skill-detail')
  await expect(detail).toBeVisible()
  await expect(previewSurface(page).getByTestId('skill-document')).toContainText('preview-notes')
  await expect(previewSurface(page).getByTestId('skill-document')).toContainText('不会执行工具或读取用户文件。')
  await page.screenshot({ path: testInfo.outputPath('skill-detail-disabled.png'), fullPage: true })
  await previewSurface(page).getByTestId('skill-detail-toggle-preview-notes').click()
  await expect(previewSurface(page).getByTestId('skill-detail-toggle-preview-notes')).toHaveAttribute('aria-checked', 'true')
  await detail.getByRole('button', { name: '返回技能', exact: true }).click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await card.hover()
  await previewSurface(page).getByTestId('skill-more-preview-notes').click()
  await previewSurface(page).getByTestId('skill-remove-preview-notes').click()
  await expect(previewSurface(page).getByTestId('skill-remove-confirm')).toBeVisible()
  await previewSurface(page).getByTestId('skill-remove-confirm').getByRole('button', { name: '取消', exact: true }).click()
  await expect(card).toBeVisible()
  await card.hover()
  await previewSurface(page).getByTestId('skill-more-preview-notes').click()
  await previewSurface(page).getByTestId('skill-remove-preview-notes').click()
  await page.screenshot({ path: testInfo.outputPath('skill-delete-confirm.png'), fullPage: true })
  await previewSurface(page).getByTestId('skill-remove-ok').click()
  await expect(card).not.toBeVisible()
  await page.reload()
  await expect(previewSurface(page).getByTestId('skills-tab-marketplace')).toHaveAttribute('aria-selected', 'true')
  await previewSurface(page).getByTestId('skills-tab-user').click()
  await expect(card).not.toBeVisible()
  await expect(previewSurface(page).getByTestId('skill-card-preview-unavailable')).toBeVisible()
  await previewSurface(page).getByTestId('skills-tab-scholarseed').click()
  await expect(previewSurface(page).getByTestId('skill-card-preview-required')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('skill-deleted.png'), fullPage: true })
})

test('skill settings retain mandatory controls and explain unavailable dependencies', { annotation: previewConsumption('settings-skills', 'settings-skills-states', ['loaded']) }, async ({ page }, testInfo) => {
  await page.goto(`/?previewInstance=${randomUUID()}&scene=settings-skills-states&page=settings-skills`)
  await expect(previewSurface(page).getByTestId('skills-tab-marketplace')).toHaveAttribute('aria-selected', 'true')
  await expect(previewSurface(page).getByTestId('skills-empty')).toBeVisible()
  await expect(previewSurface(page).getByTestId('skill-card-preview-notes')).toHaveCount(0)
  await expect(previewSurface(page).getByTestId('skill-card-preview-required')).toHaveCount(0)
  await expect(previewSurface(page).getByTestId('skill-card-preview-unavailable')).toHaveCount(0)
  await previewSurface(page).getByTestId('skills-tab-scholarseed').click()
  await expect(previewSurface(page).getByTestId('skill-toggle-preview-required')).toBeDisabled()
  await expect(previewSurface(page).getByTestId('skill-toggle-preview-required')).toHaveAttribute('aria-checked', 'true')
  await expect(previewSurface(page).getByTestId('skill-more-preview-required')).not.toBeVisible()
  await previewSurface(page).getByTestId('skills-tab-user').click()
  await expect(previewSurface(page).getByTestId('skill-card-preview-notes')).toBeVisible()
  await expect(previewSurface(page).getByTestId('skill-card-preview-required')).toHaveCount(0)
  await expect(previewSurface(page).getByTestId('skill-card-preview-unavailable')).toContainText('模拟依赖尚未准备')
  await previewSurface(page).getByTestId('skill-view-preview-unavailable').click()
  await expect(previewSurface(page).getByTestId('skill-detail')).toBeVisible()
  await expect(previewSurface(page).getByTestId('skill-document')).toContainText('preview-unavailable')
  await page.screenshot({ path: testInfo.outputPath('skill-unavailable-detail.png'), fullPage: true })
})

test('console diagnostics show real sanitized request and event metadata and reset clears old activity', async ({ page }, testInfo) => {
  const message = `诊断正文不得收集-${randomUUID()}`
  await openPreview(page)
  await openConversation(page, STREAM_SCENARIO)
  await send(page, message)
  await expect(previewSurface(page).getByText('这是模拟流式回答。', { exact: true })).toBeVisible()
  await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible()
  await page.keyboard.press('F8')
  await openPreviewTools(page)
  await page.getByRole('button', { name: '刷新诊断', exact: true }).click()
  const output = page.getByTestId('preview-diagnostic-history')
  await expect(output).toBeVisible()
  const serialized = await output.innerText()
  const diagnostic = JSON.parse(serialized) as PreviewDiagnosticSnapshot
  expect(diagnostic).toMatchObject({ requests: expect.any(Array), events: expect.any(Array), files: expect.any(Array) })
  const submitted = diagnostic.requests.find((request) => request.method === 'POST' && request.path.endsWith('/turns'))
  expect(submitted).toMatchObject({ method: 'POST', status: 200, outcome: 'completed' })
  expect(Object.keys(submitted!).sort()).toEqual(['durationMs', 'method', 'outcome', 'path', 'sequence', 'status'])
  expect(submitted!.durationMs).toBeGreaterThanOrEqual(0)
  expect(diagnostic.requests.every((request) => !request.path.includes('?'))).toBe(true)
  const completed = diagnostic.events.find((event) => event.type === 'turn_completed')
  expect(completed).toMatchObject({ session_id: 'preview-session', seq: expect.any(Number), turn_id: expect.any(String) })
  expect(serialized).not.toContain(message)
  await output.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('diagnostics-sanitized.png'), fullPage: true })
  await Promise.all([page.waitForEvent('load'), previewSurface(page).getByRole('button', { name: '重置当前场景', exact: true }).click()])
  await page.keyboard.press('F8')
  await openPreviewTools(page)
  await page.getByRole('button', { name: '刷新诊断', exact: true }).click()
  await expect(output).toBeVisible()
  const resetText = await output.innerText()
  const reset = JSON.parse(resetText) as PreviewDiagnosticSnapshot
  expect(reset).toMatchObject({ requests: expect.any(Array), events: expect.any(Array), files: expect.any(Array) })
  expect(reset.events.some((event) => event.turn_id === completed!.turn_id)).toBe(false)
  expect(reset.requests.some((request) => request.method === 'POST' && request.path.endsWith('/turns'))).toBe(false)
  expect(resetText).not.toContain(message)
  await output.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('diagnostics-after-reset.png'), fullPage: true })
})

test('declared project failure scene preserves the form and supports a successful real retry', async ({ page }, testInfo) => {
  const name = `失败重试-${randomUUID().slice(0, 8)}`
  await page.goto(`/?previewInstance=${randomUUID()}&scene=projects-create-failure&page=page-projects`)
  await previewSurface(page).getByRole('button', { name: '项目中心', exact: true }).click()
  await expect(previewSurface(page).getByTestId('project-center')).toBeVisible()
  await previewSurface(page).getByTestId('home-project-create-top').click()
  const form = previewSurface(page).getByTestId('project-new-modal')
  await previewSurface(page).getByTestId('project-create-name').fill(name)
  await previewSurface(page).getByTestId('project-create').click()
  await expect(form.getByText('无法创建项目，请重试。', { exact: true }).first()).toBeVisible()
  await expect(previewSurface(page).getByTestId('project-create-name')).toHaveValue(name)
  await expect(previewSurface(page).getByTestId('project-create-name')).toBeEnabled()
  await expect(previewSurface(page).getByTestId('project-create')).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('project-async-failure.png'), fullPage: true })
  await previewSurface(page).getByTestId('project-create').click()
  await expect(form).not.toBeVisible()
  await expect(previewSurface(page).getByRole('button', { name, exact: true })).toBeVisible()
  await previewSurface(page).getByRole('button', { name: '返回项目中心', exact: true }).click()
  await expect(previewSurface(page).getByTestId(`home-project-${name}`)).toHaveCount(1)
  await expect(previewSurface(page).getByTestId(`home-project-${name}`)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('project-failure-retry-created.png'), fullPage: true })
})
