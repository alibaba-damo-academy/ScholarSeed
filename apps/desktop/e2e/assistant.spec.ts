import { openAccountSettings } from './fixtures/menu'
import { createReadyProject, openProjectMenu, openProjectExplorer } from './fixtures/projects'
import { selectMarkdownMode } from './fixtures/markdown'
import { expect, test, type Locator, type Page, type Response as PlaywrightResponse } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PDFDocument, StandardFonts } from 'pdf-lib'

import { apiBase, DesktopSession, enterWorkbenchShell, liveStatus, waitForFinishedTurn } from './fixtures/electron'
import { importBibliography } from './fixtures/workbench'
import { createRuntime, seedLiveConfig } from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'
import { sseData } from '../src/renderer/src/sse'
import type { AssistantSelectionActionResult } from '../src/renderer/src/contracts/assistant'
import { ONBOARDING_GROUPS } from '../src/onboarding'
import { WORKSPACE_WINDOW_MINIMUM } from '../src/window'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const RUNTIME_READY_TIMEOUT_MS = 45_000
const TURN_COMPLETE_TIMEOUT_MS = 180_000
const MENU_ANIMATION_SETTLE_MS = 250
const REFERENCE_PICKER_LIST_HEIGHT = 265
const FIRST_PROMPT = '请只用一句话回答：上下文运行时验收已开始。'
const ANNOTATION_COMMENT = '请保留这条验收结论。'
const UPDATED_ANNOTATION_COMMENT = '请保留并明确强调这条验收结论。'
const DELETED_ANNOTATION_COMMENT = '这条注释用于验证删除。'
const CONTEXT_PROMPT = '请只用一句话确认：已收到上一条注释。'
const INTERNAL_CONTEXT_MARKER = '[SCHOLARSEED_ASSISTANT_CONTEXT v1]'
const CONTEXT_PROJECT_NAME = '上下文队列验收项目'
const MANAGED_RESOURCES_DIR = 'resources'
const CONTEXT_FILE_NAME = '真实上下文.md'
const CONTEXT_FILE_RELATIVE = `${MANAGED_RESOURCES_DIR}/${CONTEXT_FILE_NAME}`
const CONTEXT_NONCE = 'scholarseed-context-nonce-8f34d2'
const PROJECT_TAB_TEST_TITLE = 'project document tab and resource tree share one context and send real turns'
const PROJECT_TAB_PROMPT = '请读取加入对话的文件，只回复文件中的随机标记，不要添加其他文字。'
const PROJECT_TAB_FOLLOWUP = '请重新读取当前加入对话的文件，只回复文件中的随机标记，不要引用上一轮回答。'
const PROJECT_TAB_PREFERENCES_FILE = 'renderer-preferences.json'
const CONTEXT_FOLDER_NAME = '目录上下文'
const CONTEXT_FOLDER_RELATIVE = `${MANAGED_RESOURCES_DIR}/${CONTEXT_FOLDER_NAME}`
const CONTEXT_NESTED_FILE_NAME = '嵌套证据.md'
const CONTEXT_NESTED_FILE_RELATIVE = `${CONTEXT_FOLDER_RELATIVE}/${CONTEXT_NESTED_FILE_NAME}`
const CONTEXT_FOLDER_NONCE = 'scholarseed-folder-nonce-51ac09'
const CONTEXT_LITERATURE_TITLE = '上下文队列真实文献'
const CONTEXT_LITERATURE_NONCE = 'scholarseed-literature-nonce-72be10'
const CONTEXT_LITERATURE_FILE = 'context-literature.bib'
const FILE_CONTEXT_PROMPT = '请读取所有已附加资料，只回复其中三个随机标记，每行一个，不要添加其他文字。'
const TRANSLATION_PROJECT_NAME = 'AI 翻译验收项目'
const TRANSLATION_FILE_RELATIVE = 'resources/translation.md'
const TRANSLATION_SOURCE = 'The orbital validation nonce is helios-translation-47.'
const PDF_QUOTE_TEST_TITLE = 'PDF accepts a second quote during a real reply and sends only that pending quote next'
const PDF_QUOTE_PAPER_TITLE = 'PDF running reply quotes'
const PDF_FIRST_QUOTE = 'First evidence is quartz-alpha-87348500.'
const PDF_SECOND_QUOTE = 'Second evidence is cobalt-beta-87348500.'
const PDF_FIRST_PROMPT = '先完整复述所附选区，再用40个编号条目说明如何核验这段资料，每项写两句话。'
const PDF_SECOND_PROMPT = '请完整复述本次新加入的选区，只输出选区原文，不要复述上一轮资料。'
const HISTORY_SESSION_COUNT = 65
const HISTORY_PROJECT_NAME = '历史续载回归'

test('Assistant history with seeded sessions paginates, retries and isolates project searches', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const project = await createReadyProject(page, HISTORY_PROJECT_NAME)
    const other = await createReadyProject(page, `${HISTORY_PROJECT_NAME}-other`)
    const sessions = await page.evaluate(
      async ({ base, projectPath, otherPath, count }) => {
        const ids: string[] = []
        for (let index = 0; index < count + 2; index += 1) {
          const response = await fetch(`${base}/api/serve/sessions/open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              project_path: index < count ? projectPath : index === count ? otherPath : null,
            }),
          })
          if (!response.ok) throw new Error(`history creation failed: ${response.status}`)
          const session = (await response.json()) as { session_id: string }
          const renamed = await fetch(`${base}/api/serve/sessions/${session.session_id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: `History record ${index}` }),
          })
          if (!renamed.ok) throw new Error(`history rename failed: ${renamed.status}`)
          ids.push(session.session_id)
        }
        return ids
      },
      {
        base: await apiBase(page),
        projectPath: project.root,
        otherPath: other.root,
        count: HISTORY_SESSION_COUNT,
      }
    )
    await page.reload()
    await enterWorkbenchShell(page)
    await openProjectMenu(page)
    await page.getByTestId(`project-menu-option-${HISTORY_PROJECT_NAME}`).click()
    const panel = page.getByTestId('ai-panel')
    if (!(await panel.isVisible())) await page.getByTestId('topbar-ai').click()
    await panel.getByTestId('ai-session-toggle').click()
    const flyout = page.getByTestId('ai-session-flyout')
    await expect(flyout.getByRole('option')).toHaveCount(30)
    await page.route('**/api/serve/sessions?**', async (route) => {
      if (new URL(route.request().url()).searchParams.get('offset') === '30')
        await route.abort('failed')
      else await route.continue()
    })
    await flyout.getByTestId('ai-session-load-more').click()
    await expect(flyout.getByTestId('ai-session-retry')).toBeVisible()
    await expect(flyout.getByRole('option')).toHaveCount(30)
    await page.unroute('**/api/serve/sessions?**')
    await flyout.getByTestId('ai-session-retry').click()
    await expect(flyout.getByRole('option')).toHaveCount(60)
    await flyout.getByTestId('ai-session-load-more').focus()
    await flyout.getByTestId('ai-session-load-more').press('Enter')
    await expect(flyout.getByRole('option')).toHaveCount(HISTORY_SESSION_COUNT)
    await expect(flyout.getByTestId('ai-session-load-more')).toHaveCount(0)
    await expect(flyout.getByTestId('ai-session-search')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(flyout).toHaveCount(0)
    await expect(panel.getByTestId('ai-session-toggle')).toBeFocused()
    await panel.getByTestId('ai-session-toggle').press('Enter')
    await expect(flyout.getByRole('option')).toHaveCount(30)
    await flyout.getByTestId('ai-session-search').fill('History record 0')
    await expect(flyout.getByRole('option')).toHaveCount(1)
    await flyout.getByTestId('ai-session-search').fill('')
    await expect(flyout.getByRole('option')).toHaveCount(HISTORY_SESSION_COUNT)
    await expect(flyout.getByTestId('ai-session-load-more')).toHaveCount(0)
    const identities = await flyout
      .getByRole('option')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid')))
    expect(new Set(identities).size).toBe(HISTORY_SESSION_COUNT)
    await page.screenshot({ path: testInfo.outputPath('assistant-history-seeded-loaded.png') })
    await flyout.getByTestId('ai-session-search').fill('History record 0')
    await expect(flyout.getByRole('option')).toHaveCount(1)
    await expect(flyout.getByTestId(`ai-session-${sessions[0]}`)).toBeVisible()
    await flyout.getByTestId(`ai-session-${sessions[0]}`).click()
    await expect.poll(async () => (await liveStatus(page))?.activeSession).toBe(sessions[0])
    await openProjectMenu(page)
    await page.getByTestId(`project-menu-option-${other.name}`).click()
    await panel.getByTestId('ai-session-toggle').click()
    await expect(flyout.getByRole('option')).toHaveCount(1)
    await expect(flyout.getByTestId(`ai-session-${sessions[HISTORY_SESSION_COUNT]}`)).toBeVisible()
    await page.getByTestId('activity-literature').click()
    if (!(await flyout.isVisible())) await panel.getByTestId('ai-session-toggle').click()
    await expect(
      flyout.getByTestId(`ai-session-${sessions[HISTORY_SESSION_COUNT + 1]}`)
    ).toBeVisible()
    for (const identity of sessions.slice(0, HISTORY_SESSION_COUNT + 1)) {
      await expect(flyout.getByTestId(`ai-session-${identity}`)).toHaveCount(0)
    }
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('project sources, flat task references and pinned sections use real product navigation', async ({}, testInfo) => {
  test.skip(!process.env.SCHOLARSEED_REAL_HOME, 'requires an authorized real model configuration')
  const runtime = createRuntime(testInfo)
  expect(seedLiveConfig(runtime)).toBeNull()
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  const paths = ['resources/calibration.md', 'resources/comparison.md', 'resources/draft.md']
  const paperTitle = 'Tidal calibration abstract'
  try {
    const page = await desktop.launch()
    const project = await createReadyProject(page, '引用与置顶集成验收')
    for (const [index, path] of paths.entries()) {
      writeFileSync(
        join(project.root, path),
        index === 0
          ? '潮汐标定方案：静置37秒，采样11组。记录标记：tidal-project-evidence。'
          : `Comparison material ${index}`
      )
    }
    const bibliography = join(project.root, 'reference.bib')
    writeFileSync(
      bibliography,
      `@article{tidal, title={${paperTitle}}, year={2026}, abstract={Tidal calibration uses the abstract marker tidal-abstract-only.}}`
    )
    const identifiers = await importBibliography(page, project.id, [bibliography])
    await page.reload()
    await page.getByTestId('activity-home').click()
    await page.getByTestId(`home-project-${project.name}`).click()
    const panel = page.getByTestId('ai-panel')
    await expect
      .poll(async () => (await liveStatus(page))?.runtimeReady, {
        timeout: RUNTIME_READY_TIMEOUT_MS,
      })
      .toBe(true)
    await send(
      panel,
      '请查阅本项目已有的潮汐标定资料和相关文献，告诉我静置多久、采样几组，以及相关文献摘要中的标记。不要外部检索，不要把摘要说成全文；请给出可点击的项目资料和文献来源。'
    )
    await waitForFinishedTurn(page)
    const answer = panel.locator('.answer-annotation-root').last()
    await expect(answer).toContainText('37')
    await expect(answer).toContainText('11')
    await expect(answer).toContainText('tidal-abstract-only')
    const sourceLinks = answer.getByTestId('project-source-link')
    await expect.poll(() => sourceLinks.count()).toBeGreaterThanOrEqual(2)
    await page.screenshot({
      path: testInfo.outputPath('project-source-answer.png'),
      animations: 'disabled',
    })
    if (await sourceLinks.count()) {
      await sourceLinks.first().click()
      await expect(page.getByTestId('workbench-shell')).toBeVisible()
      await expect(page.locator('.ProseMirror')).toContainText('tidal-project-evidence')
      await page.screenshot({
        path: testInfo.outputPath('project-source-opened.png'),
        animations: 'disabled',
      })
    }
    const sessionId = (await liveStatus(page))!.activeSession!
    await page.getByTestId('task-overview-toggle').click()
    await expect(page.getByTestId('overview-source').filter({ hasText: 'calibration.md' })).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath('automatic-read-source.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    const row = page.getByTestId(`project-task-${sessionId}`)
    const sourceTitle = (await row.getByRole('button').first().innerText()).trim()
    await row.hover()
    await row.getByRole('button', { name: '任务操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '置顶', exact: true }).click()
    await expect(
      page.getByTestId('project-task-list').getByTestId(`project-task-${sessionId}`)
    ).toBeVisible()
    await expect(
      page.getByTestId('project-unpinned-tasks').getByTestId(`project-task-${sessionId}`)
    ).toHaveCount(0)
    await page.screenshot({
      path: testInfo.outputPath('task-pinned-section.png'),
      animations: 'disabled',
    })
    await page.getByTestId('project-new-task').click()
    await page.getByTestId('project-library').click()
    await page.getByTestId('project-library-content').getByRole('tab', { name: '资料', exact: true }).click()
    const input = panel.getByTestId('composer-input')
    const target = panel.getByTestId('composer-drop-zone')
    await page.getByTestId(`material-${paths[0]}`).dragTo(target)
    await expect(panel.getByTestId('ai-context-ref')).toContainText('calibration.md')
    await page.getByTestId(`material-${paths[1]}`).dragTo(target)
    await expect(panel.getByTestId('ai-context-ref')).toHaveCount(2)
    await expect(panel.getByTestId('ai-context-file-group')).toHaveCount(0)
    await page.getByTestId('project-library-content').getByRole('tab', { name: '文献', exact: true }).click()
    await page.locator('.lit-row').filter({ hasText: paperTitle }).dragTo(target)
    await expect(panel.getByTestId('ai-context-ref').filter({ hasText: paperTitle })).toBeVisible()
    await panel.getByTestId('composer-plus').click()
    await page.getByTestId('composer-add-session-context').click()
    await page.getByTestId(`ai-context-select-session-${sessionId}`).click()
    await page.getByTestId('reference-picker-confirm').click()
    await expect(panel.getByTestId('ai-context-ref').filter({ hasText: sourceTitle })).toBeVisible()
    const upload = join(project.root, 'uploaded.md')
    writeFileSync(upload, 'Uploaded reference evidence')
    await panel.getByTestId('composer-file-input').setInputFiles(upload)
    await expect(panel.locator('[data-testid^="message-attachment-"]').filter({ hasText: 'uploaded.md' })).toBeVisible()
    await send(panel, '请仅回复：已收到两份引用文件。不要修改文件。')
    await expect(panel.locator('.answer-annotation-root').last()).toContainText('已收到两份引用文件', { timeout: TURN_COMPLETE_TIMEOUT_MS })
    await waitForFinishedTurn(page)
    const referencedSessionId = (await liveStatus(page))!.activeSession!
    await page.getByTestId('project-library').click()
    await page.getByTestId('project-library-content').getByRole('tab', { name: '资料', exact: true }).click()
    await page.getByTestId(`material-${paths[0]}`).dragTo(target)
    await send(panel, '请仅回复：重复引用已收到。不要修改文件。')
    await expect(panel.locator('.answer-annotation-root').last()).toContainText('重复引用已收到', { timeout: TURN_COMPLETE_TIMEOUT_MS })
    await waitForFinishedTurn(page)
    await page.getByTestId('project-library').click()
    await page.getByTestId('project-library-content').getByRole('tab', { name: '资料', exact: true }).click()
    await page.getByTestId(`material-${paths[2]}`).dragTo(target)
    await input.fill('这份草稿不发送。')
    await page.getByTestId('task-overview-toggle').click()
    const files = page.getByTestId('overview-source')
    await expect(files.filter({ hasText: 'calibration.md' })).toHaveCount(1)
    await expect(files.filter({ hasText: 'comparison.md' })).toHaveCount(1)
    await expect(files.filter({ hasText: 'draft.md' })).toHaveCount(0)
    await expect(files.filter({ hasText: 'uploaded.md' })).toHaveCount(1)
    await expect(files.filter({ hasText: paperTitle })).toHaveCount(1)
    await expect(files.filter({ hasText: sourceTitle })).toHaveCount(1)
    await page.screenshot({
      path: testInfo.outputPath('overview-references-deduplicated.png'),
      animations: 'disabled',
    })
    await files.filter({ hasText: 'calibration.md' }).click()
    await expect(page.getByTestId('task-overview')).toHaveCount(0)
    await page.screenshot({
      path: testInfo.outputPath('overview-reference-opened.png'),
      animations: 'disabled',
    })
    await desktop.app!.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(size.width, size.height),
      WORKSPACE_WINDOW_MINIMUM
    )
    await page.getByTestId('task-overview-toggle').click()
    await page.screenshot({
      path: testInfo.outputPath('overview-references-minimum.png'),
      animations: 'disabled',
    })
    await files.filter({ hasText: 'uploaded.md' }).click()
    await expect(page.getByTestId('markdown-preview').locator('.ProseMirror')).toContainText('Uploaded reference evidence')
    await page.screenshot({ path: testInfo.outputPath('overview-upload-opened.png'), animations: 'disabled' })
    await page.getByTestId('task-overview-toggle').click()
    await files.filter({ hasText: paperTitle }).click()
    await expect(page.locator('.lit-detail-title')).toHaveText(paperTitle)
    const detailBounds = await page.locator('.lit-detail').evaluate((element) => {
      const detail = element.getBoundingClientRect()
      const parent = element.parentElement!.getBoundingClientRect()
      return [Math.round(detail.left - parent.left), Math.round(parent.right - detail.right)]
    })
    for (const distance of detailBounds) expect(distance).toBeGreaterThanOrEqual(0)
    await page.screenshot({ path: testInfo.outputPath('overview-literature-opened.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await page.getByTestId(`project-task-${referencedSessionId}`).getByRole('button').first().click()
    await page.getByTestId('task-overview-toggle').click()
    await files.filter({ hasText: sourceTitle }).click()
    await expect.poll(async () => (await liveStatus(page))?.activeSession).toBe(sessionId)
    expect(identifiers).toHaveLength(1)
    desktop.assertNoPageErrors()
    await desktop.close()
    seedTheme(runtime.userData, 'dark')
    const darkPage = await desktop.launch()
    await darkPage.getByTestId(`project-task-${referencedSessionId}`).getByRole('button').first().click()
    await desktop.app!.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), WORKSPACE_WINDOW_MINIMUM)
    await expect(darkPage.locator('html')).toHaveAttribute('data-theme', 'dark')
    await darkPage.getByTestId('task-overview-toggle').click()
    await expect(darkPage.getByTestId('overview-source').filter({ hasText: 'calibration.md' })).toHaveCount(1)
    await expect(darkPage.getByTestId('overview-source').filter({ hasText: 'draft.md' })).toHaveCount(0)
    await darkPage.screenshot({ path: testInfo.outputPath('overview-references-dark-restart.png'), animations: 'disabled' })
    await darkPage.keyboard.press('Escape')
    await darkPage.getByTestId(`project-task-${sessionId}`).hover()
    await darkPage.getByTestId(`project-task-${sessionId}`).getByRole('button', { name: '任务操作', exact: true }).click()
    await darkPage.getByRole('menuitem', { name: '取消置顶', exact: true }).click()
    await expect(darkPage.getByTestId(`project-task-${sessionId}`).getByRole('img', { name: '已置顶' })).toHaveCount(0)
    await expect(darkPage.getByTestId('project-task-list').getByTestId(`project-task-${sessionId}`)).toHaveCount(1)
    await darkPage.screenshot({ path: testInfo.outputPath('task-unpinned-dark.png'), animations: 'disabled' })
    await send(darkPage.getByTestId('ai-panel'), '请仅回复：第三份引用已收到。不要修改文件。')
    await expect(darkPage.locator('.answer-annotation-root').last()).toContainText('第三份引用已收到', { timeout: TURN_COMPLETE_TIMEOUT_MS })
    await waitForFinishedTurn(darkPage)
    await darkPage.getByTestId('task-overview-toggle').click()
    const submittedFiles = darkPage.getByTestId('overview-source')
    await expect(submittedFiles.filter({ hasText: 'draft.md' })).toHaveCount(1)
    await expect(submittedFiles.filter({ hasText: 'calibration.md' })).toHaveCount(1)
    await darkPage.screenshot({ path: testInfo.outputPath('overview-third-reference-submitted.png'), animations: 'disabled' })
    await darkPage.keyboard.press('Escape')
    await darkPage.getByTestId('project-new-task').click()
    await send(darkPage.getByTestId('ai-panel'), '本项目已有资料能否证明金星表面温度精确为312.75摄氏度？只检查当前项目资料和关联文献，不联网，不读取其他项目；如果没有支持证据，明确说明内部资料不足，不要引用无关材料。')
    await expect(darkPage.locator('.answer-annotation-root').last()).toContainText(/不足|无法证明|没有.*证据|不支持/, { timeout: TURN_COMPLETE_TIMEOUT_MS })
    await waitForFinishedTurn(darkPage)
    await expect(darkPage.locator('.answer-annotation-root').last().getByTestId('project-source-link')).toHaveCount(0)
    await darkPage.screenshot({ path: testInfo.outputPath('project-irrelevant-material-insufficient.png'), animations: 'disabled' })
    desktop.assertNoPageErrors()
  } finally {
    if (desktop.page) await desktop.page.screenshot({ path: testInfo.outputPath('final-product-state.png'), animations: 'disabled' })
    await desktop.attachArtifacts()
  }
})

function seedTheme(userData: string, theme: 'light' | 'dark'): void {
  const path = join(userData, PROJECT_TAB_PREFERENCES_FILE)
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), theme }))
}

test('project files and directories drag into task context through the real product', async ({}, testInfo) => {
  test.skip(!process.env.SCHOLARSEED_REAL_HOME, 'requires an authorized real model configuration')
  const runtime = createRuntime(testInfo)
  expect(seedLiveConfig(runtime)).toBeNull()
  seedTheme(runtime.userData, 'light')
  const desktop = new DesktopSession(runtime, testInfo)
  const draft = '请保留文件拖入验收草稿。'
  const folder = `${MANAGED_RESOURCES_DIR}/drag-folder`
  const first = `${MANAGED_RESOURCES_DIR}/drag-first.md`
  const second = `${MANAGED_RESOURCES_DIR}/drag-second.md`
  const markers = ['amber-file-87828198', 'cobalt-file-87828198', 'quartz-folder-87828198']
  const admittedPaths: string[] = []
  try {
    const page = await desktop.launch()
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (request.method() !== 'PATCH' || !path.startsWith('/api/assistant/sessions/') || !path.endsWith('/context')) return
      const body = request.postDataJSON() as { refs: Array<{ kind: string; source_id: string }> }
      admittedPaths.push(...body.refs.filter((ref) => ref.kind === 'file' || ref.kind === 'dir').map((ref) => ref.source_id))
    })
    await (await desktop.browserWindow(page)).evaluate((window) => { window.show(); window.focus() })
    const project = await createReadyProject(page, '项目文件拖入验收')
    mkdirSync(join(project.root, folder), { recursive: true })
    writeFileSync(join(project.root, first), markers[0])
    writeFileSync(join(project.root, second), markers[1])
    writeFileSync(join(project.root, folder, 'nested.md'), markers[2])
    await page.reload()
    await page.getByTestId('activity-home').click()
    await page.getByTestId(`home-project-${project.name}`).click()
    await page.getByTestId('project-library').click()
    const panel = page.getByTestId('ai-panel')
    const input = panel.getByTestId('composer-input')
    const target = panel.getByTestId('composer-drop-zone')
    const refs = panel.getByTestId('ai-context-ref')
    const group = panel.getByTestId('ai-context-file-group')
    await input.fill(draft)
    await page.getByTestId(`material-${folder}`).dragTo(target)
    await expect(refs).toHaveCount(1)
    await expect(refs).toContainText('drag-folder')
    await expect(refs).toContainText('按需读取')
    await page.getByTestId(`material-${first}`).dragTo(target)
    await expect(refs).toHaveCount(2)
    await expect(input).toHaveValue(draft)
    await expect(panel.getByTestId('user-bubble')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('file-drag-single-folder.png'), animations: 'disabled' })
    await page.getByTestId(`material-${first}`).dragTo(target)
    await expect(refs).toHaveCount(2)
    await page.getByTestId(`material-${second}`).dragTo(target)
    await expect(refs).toHaveCount(3)
    await expect(group).toHaveCount(0)
    await expect(refs.filter({ hasText: 'drag-first.md' })).toBeVisible()
    await expect(refs.filter({ hasText: 'drag-second.md' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('file-drag-individual.png'), animations: 'disabled' })
    await refs.filter({ hasText: 'drag-first.md' }).getByRole('button').click()
    await refs.filter({ hasText: 'drag-second.md' }).getByRole('button').click()
    await expect(refs).toHaveCount(1)
    await page.getByTestId('project-library-content').getByRole('button', { name: '项目资源管理器', exact: true }).click()
    const explorer = page.getByTestId('project-explorer')
    await explorer.getByRole('button', { name: '展开 resources', exact: true }).click()
    await explorer.getByTestId(`explorer-select-${folder}`).dragTo(target)
    await expect(refs).toHaveCount(1)
    await explorer.getByTestId(`explorer-select-${first}`).dragTo(target)
    await explorer.getByTestId(`explorer-select-${second}`).dragTo(target)
    await expect(refs).toHaveCount(3)
    await expect(input).toHaveValue(draft)
    await page.screenshot({ path: testInfo.outputPath('file-drag-explorer.png'), animations: 'disabled' })
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, { timeout: RUNTIME_READY_TIMEOUT_MS }).toBe(true)
    await send(panel, '读取本轮附加的两个文件与目录中的nested.md，报告三个随机标记。然后在本会话允许发布的输出目录中创建drag-result.md，只写入这三个标记，并以final产物正式发布交付该文件，产物标题为drag-result.md。不要修改任何输入文件，不要创建其他副本。')
    await waitForFinishedTurn(page)
    const answer = panel.locator('.answer-annotation-root').last()
    for (const marker of markers) await expect(answer).toContainText(marker)
    const status = await liveStatus(page)
    expect(admittedPaths).toEqual(expect.arrayContaining([folder, first, second]))
    const base = await apiBase(page)
    const context = await page.request.get(`${base}/api/assistant/sessions/${status!.activeSession}/context`)
    expect(context.ok()).toBe(true)
    expect((await context.json()).refs).toEqual([])
    const history = await page.request.get(`${base}/api/serve/history/${status!.activeSession}`)
    expect(history.ok()).toBe(true)
    const artifacts = (await history.json()).artifacts as Array<{ path: string; saved_to?: string; title?: string; name: string }>
    const published = artifacts.find((artifact) => artifact.title === 'drag-result.md' || artifact.name === 'drag-result.md')
    expect(published).toBeTruthy()
    await page.getByTestId('project-new-task').click()
    await expect(panel.getByTestId('user-bubble')).toHaveCount(0)
    await expect(panel.locator('.answer-annotation-root')).toHaveCount(0)
    await page.getByTestId('project-library').click()
    await page.getByTestId('project-library-content').getByRole('tab', { name: '任务产物', exact: true }).click()
    const output = page.getByTestId('project-outputs').locator('[data-testid^="output-"]').filter({ hasText: 'drag-result.md' })
    await expect(output).toHaveCount(1)
    await input.fill(draft)
    await output.dragTo(target)
    await expect(refs).toHaveCount(1)
    await expect(refs).toContainText('drag-result')
    await expect(input).toHaveValue(draft)
    await page.screenshot({ path: testInfo.outputPath('file-drag-output.png'), animations: 'disabled' })
    const beforeOutputTurn = (await liveStatus(page))!.lastSeq
    await send(panel, '重新读取本次附加的产物文件，逐行报告其中三个随机标记。')
    await expect(panel.locator('.answer-annotation-root').last()).toContainText(markers[0], { timeout: TURN_COMPLETE_TIMEOUT_MS })
    await waitForFinishedTurn(page, beforeOutputTurn)
    const outputStatus = await liveStatus(page)
    expect(outputStatus!.activeSession).not.toBe(status!.activeSession)
    expect(admittedPaths).toContain(published!.saved_to || published!.path)
    for (const marker of markers) await expect(panel.locator('.answer-annotation-root').last()).toContainText(marker)
    await page.screenshot({ path: testInfo.outputPath('file-drag-model.png'), animations: 'disabled' })
    const consumed = await page.request.get(`${base}/api/assistant/sessions/${outputStatus!.activeSession}/context`)
    expect((await consumed.json()).refs).toEqual([])
    expect(readFileSync(join(project.root, first), 'utf8')).toBe(markers[0])
    expect(readFileSync(join(project.root, second), 'utf8')).toBe(markers[1])
    expect(readFileSync(join(project.root, folder, 'nested.md'), 'utf8')).toBe(markers[2])
    writeFileSync(testInfo.outputPath('file-drag-result.json'), JSON.stringify({ projectId: project.id, sourceSessionId: status!.activeSession, sessionId: outputStatus!.activeSession, outputPath: published!.saved_to || published!.path, answer: await panel.locator('.answer-annotation-root').last().innerText() }, null, 2))
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('dark project context copy and directory move keep their targets separate', async ({}, testInfo) => {
  test.skip(!process.env.SCHOLARSEED_REAL_HOME, 'requires an authorized real model configuration')
  const runtime = createRuntime(testInfo)
  expect(seedLiveConfig(runtime)).toBeNull()
  seedTheme(runtime.userData, 'dark')
  const desktop = new DesktopSession(runtime, testInfo)
  const folder = `${MANAGED_RESOURCES_DIR}/drag-folder`
  const first = `${MANAGED_RESOURCES_DIR}/drag-first.md`
  const second = `${MANAGED_RESOURCES_DIR}/drag-second.md`
  const moveControl = `${MANAGED_RESOURCES_DIR}/move-control.md`
  const draft = '暗色文件引用与目录移动对照。'
  try {
    const page = await desktop.launch()
    await (await desktop.browserWindow(page)).evaluate((window, size) => { window.setSize(size.width, size.height); window.show(); window.focus() }, WORKSPACE_WINDOW_MINIMUM)
    const project = await createReadyProject(page, '暗色拖入移动对照')
    mkdirSync(join(project.root, folder), { recursive: true })
    for (const path of [first, second, moveControl]) writeFileSync(join(project.root, path), 'directory move control')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.getByTestId('activity-home').click()
    await page.getByTestId(`home-project-${project.name}`).click()
    await page.getByTestId('project-library').click()
    const panel = page.getByTestId('ai-panel')
    const input = panel.getByTestId('composer-input')
    const target = panel.getByTestId('composer-drop-zone')
    const refs = panel.getByTestId('ai-context-ref')
    const group = panel.getByTestId('ai-context-file-group')
    await input.fill(draft)
    await page.getByTestId(`material-${folder}`).dragTo(target)
    await expect(refs).toHaveCount(1)
    await page.getByTestId(`material-${first}`).dragTo(target)
    await expect(refs).toHaveCount(2)
    await page.getByTestId(`material-${second}`).dragTo(target)
    await expect(group).toHaveCount(0)
    await expect(refs).toHaveCount(3)
    await refs.filter({ hasText: 'drag-first.md' }).getByRole('button').focus()
    await expect(input).toHaveValue(draft)
    await expect(panel.getByTestId('user-bubble')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('file-drag-dark-minimum.png'), animations: 'disabled' })
    expect(existsSync(join(project.root, first))).toBe(true)
    expect(existsSync(join(project.root, second))).toBe(true)
    await page.getByTestId('project-library-content').getByRole('button', { name: '项目资源管理器', exact: true }).click()
    const explorer = page.getByTestId('project-explorer')
    await explorer.getByRole('button', { name: '展开 resources', exact: true }).click()
    await explorer.getByTestId(`explorer-select-${moveControl}`).dragTo(explorer.getByTestId(`explorer-node-${folder}`))
    await expect.poll(() => existsSync(join(project.root, moveControl))).toBe(false)
    expect(readFileSync(join(project.root, folder, 'move-control.md'), 'utf8')).toBe('directory move control')
    await expect(refs).toHaveCount(3)
    await expect(input).toHaveValue(draft)
    await expect(explorer.getByTestId(`explorer-select-${folder}/move-control.md`)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('file-drag-move-control.png'), animations: 'disabled' })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('dragged literature reads its uploaded primary PDF rather than another selected abstract', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  const title = 'Manual acceptance full-text sample'
  const abstractTitle = 'Manual acceptance abstract-only sample'
  const marker = 'PDF-FULLTEXT-907'
  try {
    const page = await desktop.launch()
    const project = await createReadyProject(page, '文献全文验收')
    const bibliography = join(project.root, 'sample.bib')
    writeFileSync(bibliography, `@article{fulltext,title={${title}},year={2026},abstract={PDF-ABSTRACT-315. The abstract contains no full-text measurements.}}\n@article{abstract,title={${abstractTitle}},year={2026},abstract={ABSTRACT-ONLY-628. No PDF supplied.}}`)
    const identifiers = await importBibliography(page, project.id, [bibliography])
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage().drawText(`1. Full-text verification: ${marker}\n\n2. Synthesis temperature: 23 degrees Celsius.\n\n3. Control group: 5 samples.`, { x: 50, y: 720, size: 14, font })
    const attachment = join(project.root, 'sample-fulltext.pdf')
    writeFileSync(attachment, await pdf.save())
    await page.reload()
    await page.getByTestId('activity-home').click()
    await page.getByTestId(`home-project-${project.name}`).click()
    await page.getByTestId('project-library').click()
    await page.getByTestId('project-library-content').getByRole('tab', { name: '文献', exact: true }).click()
    const row = page.locator('.lit-row').filter({ hasText: title })
    await row.click()
    await page.locator('input[type="file"][aria-label="上传全文 PDF"]').setInputFiles(attachment)
    const base = await apiBase(page)
    await expect.poll(async () => {
      const response = await page.request.get(`${base}/api/v1/literatures/${identifiers[0]}?project_id=${project.id}`)
      const detail = await response.json()
      return detail.primary_attachment?.name ?? detail.primary_attachment?.filename
    }).toBe('sample-fulltext.pdf')
    await page.screenshot({ path: testInfo.outputPath('primary-pdf-uploaded.png'), animations: 'disabled' })
    await page.getByRole('button', { name: '关闭详情', exact: true }).click()
    await page.locator('.lit-row').filter({ hasText: abstractTitle }).getByRole('checkbox').click()
    await row.dragTo(page.getByTestId('composer-drop-zone'))
    await expect(page.getByTestId('ai-context-ref')).toHaveCount(1)
    await expect(page.getByTestId('ai-context-ref')).toContainText(title)
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, { timeout: RUNTIME_READY_TIMEOUT_MS }).toBe(true)
    await send(page.getByTestId('ai-panel'), '请读取我本次附加文献的PDF正文，而不是只读摘要。报告正文独有的验证标记、第2节的合成温度和第3节的对照组份数，并给出可点击来源。不要联网；如果不能读取PDF请明确说明，不要猜。')
    await waitForFinishedTurn(page)
    const answer = page.locator('.answer-annotation-root').last()
    await expect(answer).toContainText(marker)
    await expect(answer).toContainText('23')
    await expect(answer).toContainText('5')
    const citation = answer.locator('button:has([data-citation-label])').first()
    await expect(citation).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('primary-pdf-answer.png'), animations: 'disabled' })
    await citation.click()
    await expect(page.getByTestId('pdf-page-1')).toBeInViewport()
    await expect(page.locator('[data-citation-highlight]').first()).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('primary-pdf-source-opened.png'), animations: 'disabled' })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('project literature rows drag into the current task without claiming full text', async ({}, testInfo) => {
  test.skip(!process.env.SCHOLARSEED_REAL_HOME, 'requires an authorized real model configuration')
  const runtime = createRuntime(testInfo)
  expect(seedLiveConfig(runtime)).toBeNull()
  seedTheme(runtime.userData, 'dark')
  const desktop = new DesktopSession(runtime, testInfo)
  const title = 'Project Literature Drag Evidence'
  const secondTitle = 'Project Literature Drag Comparison'
  const draft = '请保留这个任务草稿。'
  const admittedLiterature: string[] = []
  try {
    const page = await desktop.launch()
    await (await desktop.browserWindow(page)).evaluate((window) => {
      window.show()
      window.focus()
    })
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (request.method() !== 'PATCH' || !path.startsWith('/api/assistant/sessions/') || !path.endsWith('/context')) return
      const body = request.postDataJSON() as { refs: Array<{ kind: string; source_id: string }> }
      admittedLiterature.push(...body.refs.filter((ref) => ref.kind === 'literature').map((ref) => ref.source_id))
    })
    const project = await createReadyProject(page, '项目文献拖拽验收')
    const source = join(project.root, 'drag.bib')
    writeFileSync(source, `@article{drag, title={${title}}, author={Evidence Researcher}, year={2026}, abstract={The abstract reports the marker amber-drag-87828208.}}\n@article{comparison, title={${secondTitle}}, year={2025}}\n`)
    const identifiers = await importBibliography(page, project.id, [source])
    expect(identifiers).toHaveLength(2)
    await page.reload()
    await page.getByTestId('activity-home').click()
    await page.getByTestId(`home-project-${project.name}`).click()
    await page.getByTestId('project-library').click()
    await page.getByTestId('project-library-content').getByRole('tab', { name: '文献', exact: true }).click()
    const panel = page.getByTestId('ai-panel')
    await expect(panel).toBeVisible()
    const input = panel.getByTestId('composer-input')
    const target = panel.getByTestId('composer-drop-zone')
    const row = page.locator('.lit-row').filter({ hasText: title })
    const other = page.locator('.lit-row').filter({ hasText: secondTitle })
    const refs = panel.getByTestId('ai-context-ref')
    await expect(row).toHaveAttribute('draggable', 'true')
    await input.fill(draft)
    await row.dragTo(target)
    await expect(refs).toHaveCount(1)
    await expect(refs).toContainText(title)
    await expect(input).toHaveValue(draft)
    await expect(panel.getByTestId('user-bubble')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('literature-drag-single.png'), animations: 'disabled' })
    await row.dragTo(target)
    await expect(refs).toHaveCount(1)
    await refs.getByRole('button').click()
    await expect(refs).toHaveCount(0)
    await row.getByRole('checkbox').click()
    await other.getByRole('checkbox').click()
    await row.dragTo(target)
    const group = panel.getByTestId('ai-context-literature-group')
    await expect(group).toHaveCount(0)
    await expect(refs).toHaveCount(2)
    await expect(input).toHaveValue(draft)
    await expect(refs.filter({ hasText: title })).toBeVisible()
    await expect(refs.filter({ hasText: secondTitle })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('literature-drag-multiple.png'), animations: 'disabled' })
    await refs.filter({ hasText: title }).getByRole('button').click()
    await refs.filter({ hasText: secondTitle }).getByRole('button').click()
    await expect(refs).toHaveCount(0)
    await other.getByRole('checkbox').click()
    await other.dragTo(target)
    await expect(refs).toHaveCount(1)
    await expect(refs).toContainText(secondTitle)
    await refs.getByRole('button').click()
    await row.dragTo(target)
    await expect(refs).toContainText(title)
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS,
    }).toBe(true)
    await send(panel, '请只根据我附加的文献，报告标题、摘要中的随机标记，以及是否已经取得全文。请用两句话回答，不检索或下载全文；不要把摘要当作全文依据。')
    await waitForFinishedTurn(page)
    const answer = panel.locator('.answer-annotation-root').last()
    await expect(answer).toContainText('amber-drag-87828208')
    await expect(answer).toContainText(/未.*全文|没有.*全文|无全文|尚未.*全文/)
    const status = await liveStatus(page)
    expect(status?.activeSession).toBeTruthy()
    const base = await apiBase(page)
    const context = await page.request.get(`${base}/api/assistant/sessions/${status!.activeSession}/context`)
    expect(context.ok()).toBe(true)
    expect(admittedLiterature).toContain(identifiers[0])
    expect((await context.json()).refs).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('literature-drag-model.png'), animations: 'disabled' })
    writeFileSync(testInfo.outputPath('literature-drag-result.json'), JSON.stringify({
      projectId: project.id, identifiers, sessionId: status!.activeSession,
      answer: await answer.innerText(),
    }, null, 2))
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    const nativeWindow = await desktop.browserWindow(page)
    await nativeWindow.evaluate((window, size) => window.setSize(size.width, size.height), WORKSPACE_WINDOW_MINIMUM)
    await page.getByTestId('project-library').click()
    await page.getByTestId('project-library-content').getByRole('tab', { name: '文献', exact: true }).click()
    await input.fill(draft)
    await row.dragTo(target)
    await expect(refs).toHaveCount(1)
    await expect(input).toHaveValue(draft)
    await other.dragTo(target)
    await expect(refs).toHaveCount(2)
    await refs.filter({ hasText: title }).getByRole('button').focus()
    await expect(refs.filter({ hasText: title }).getByRole('button')).toBeFocused()
    await page.screenshot({ path: testInfo.outputPath('literature-drag-dark-minimum.png'), animations: 'disabled' })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

async function submitAnnotation(page: Page, sessionId: string, comment: string): Promise<void> {
  const input = page.getByLabel('批注内容')
  await input.fill(comment)
  const response = page.waitForResponse((candidate) => (
    candidate.url().includes(`/api/assistant/sessions/${sessionId}/annotations/`)
    && candidate.request().method() === 'PATCH'
  ))
  await input.press('Enter')
  expect((await response).status()).toBe(200)
}

async function addAnnotation(page: Page, sessionId: string): Promise<void> {
  const response = page.waitForResponse(candidate => (
    candidate.url().includes(`/api/assistant/sessions/${sessionId}/answers/`)
    && candidate.url().endsWith('/annotations')
    && candidate.request().method() === 'POST'
  ))
  await page.getByRole('button', { name: '添加到任务', exact: true }).click()
  const created = await response
  expect(created.status()).toBe(200)
  const { annotation } = await created.json()
  expect(annotation.comment).toBe('')
  await expect(page.getByLabel('批注内容')).toBeVisible()
  await expect(page.getByLabel('批注内容')).toHaveAttribute('placeholder', '说明处理方式并添加到对话（选填）')
  await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(0)
  await expect(page.getByTestId('ai-context-ref').filter({ hasText: '条注释' })).toBeVisible()
}
const POLISH_PROJECT_NAME = 'AI 润色验收项目'
const POLISH_FILE_RELATIVE = 'resources/polish.md'
const POLISH_SOURCE = 'This validation sentence are intentionally awkward.'
const ONE_SHOT_E2E_ENABLED = process.env.SCHOLARSEED_ONE_SHOT_E2E === '1'
const CONTEXT_SOURCES_E2E_ENABLED = process.env.SCHOLARSEED_CONTEXT_SOURCES_E2E === '1'

async function selectionResult(response: PlaywrightResponse): Promise<AssistantSelectionActionResult> {
  expect(response.headers()['content-type']).toContain('text/event-stream')
  const stream = new Response(await response.text()).body!
  for await (const frame of sseData(stream)) {
    const event = JSON.parse(frame)
    if (event.type === 'error') throw new Error(event.error)
    if (event.type === 'result') return event.result as AssistantSelectionActionResult
  }
  throw new Error('selection_stream_incomplete')
}

async function send(surface: Page | Locator, message: string): Promise<void> {
  const input = surface.getByTestId('composer-input')
  await input.fill(message)
  const button = surface.getByTestId('composer-send')
  if (await button.count()) await expect(button).toBeEnabled()
  await input.press('Enter')
}

async function sessionCount(page: Page): Promise<number> {
  return page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/serve/sessions?limit=100&scope=all`)
    const payload = await response.json() as { sessions?: unknown[] }
    return payload.sessions?.length ?? 0
  }, await apiBase(page))
}

test(PDF_QUOTE_TEST_TITLE, async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { home: true, project: true, globalLib: true, pdf: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    const pdf = await PDFDocument.create()
    pdf.setTitle(PDF_QUOTE_PAPER_TITLE)
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const pdfPage = pdf.addPage([612, 792])
    pdfPage.drawText(PDF_FIRST_QUOTE, { x: 50, y: 650, size: 12, font })
    pdfPage.drawText(PDF_SECOND_QUOTE, { x: 50, y: 620, size: 12, font })
    const imported = await page.request.post(`${await apiBase(page)}/api/v1/imports/pdf`, {
      multipart: { file: { name: 'running-quotes.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) } }
    })
    expect(imported.ok(), await imported.text()).toBe(true)
    await page.reload()
    await enterWorkbenchShell(page)
    await page.getByTestId('activity-literature').click()
    await page.locator('.lit-row').filter({ hasText: PDF_QUOTE_PAPER_TITLE }).first().click()
    await page.getByRole('button', { name: '打开', exact: true }).click()
    const selectQuote = async (text: string): Promise<void> => {
      const textSpan = page.getByTestId('pdf-page-1').locator('.textLayer span').filter({ hasText: text }).first()
      await expect(textSpan).toBeVisible()
      const bounds = await textSpan.boundingBox()
      if (!bounds) throw new Error('PDF quote bounds unavailable')
      await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2)
      await page.mouse.down()
      await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 20 })
      await page.mouse.up()
      await expect(page.getByTestId('selection-action-host')).toBeVisible()
    }
    await selectQuote(PDF_FIRST_QUOTE)
    await page.getByTestId('selection-action-host').getByRole('button', { name: '添加到任务', exact: true }).click()
    const panel = page.getByTestId('ai-panel')
    await expect(panel.getByTestId('ai-context-ref')).toHaveCount(1)
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, { timeout: RUNTIME_READY_TIMEOUT_MS }).toBe(true)
    await send(panel, PDF_FIRST_PROMPT)
    await expect.poll(async () => Boolean((await liveStatus(page))?.running)).toBe(true)
    const sessionId = (await liveStatus(page))?.activeSession
    expect(sessionId).toBeTruthy()
    await expect(panel.getByTestId('ai-context-ref')).toHaveCount(0)

    await selectQuote(PDF_SECOND_QUOTE)
    expect((await liveStatus(page))?.running).toBe(true)
    const appendedResponse = page.waitForResponse(response => (
      response.request().method() === 'PATCH'
      && response.url().endsWith(`/api/assistant/sessions/${sessionId}/context`)
    ))
    await page.getByTestId('selection-action-host').getByRole('button', { name: '添加到任务', exact: true }).click()
    const appended = await appendedResponse
    expect(appended.status(), await appended.text()).toBe(200)
    const selection = await appended.json()
    expect(selection.claimed_ref_ids).toHaveLength(1)
    expect(selection.refs.filter((ref: { ref_id: string }) => !selection.claimed_ref_ids.includes(ref.ref_id)))
      .toHaveLength(1)
    await expect(panel.getByTestId('ai-context-ref')).toHaveCount(1)
    await panel.getByTestId('ai-context-ref').hover()
    await expect(page.getByTestId('assistant-selection-quote')).toContainText(PDF_SECOND_QUOTE)
    await expect(panel).not.toContainText('上下文保存失败')
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-quote-B-during-reply.png') })
    await waitForFinishedTurn(page)
    await expect(panel).toContainText(PDF_FIRST_QUOTE)

    const secondTurnResponse = page.waitForResponse(response => (
      response.request().method() === 'POST'
      && response.url().endsWith(`/api/serve/sessions/${sessionId}/turns`)
    ))
    await send(panel, PDF_SECOND_PROMPT)
    expect((await secondTurnResponse).status()).toBe(202)
    await expect.poll(async () => Boolean((await liveStatus(page))?.running)).toBe(true)
    await waitForFinishedTurn(page)
    await expect(panel.locator('.answer-annotation-root').last()).toContainText(PDF_SECOND_QUOTE)
    await expect(panel.locator('.answer-annotation-root').last()).not.toContainText(PDF_FIRST_QUOTE)
    await expect(panel.getByTestId('ai-context-ref')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-quote-B-next-reply.png') })
    await testInfo.attach('pdf-quote-context', {
      body: JSON.stringify({ sessionId, status: appended.status(), claimedRefIds: selection.claimed_ref_ids,
        references: selection.refs.map((ref: { ref_id: string; anchor?: { snapshot_text: string } }) => ({
          id: ref.ref_id, text: ref.anchor?.snapshot_text
        })) }, null, 2), contentType: 'application/json'
    })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('Assistant context persists per Session and never leaks its model card into user history', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo)
  let sessionId = ''
  try {
    let page = await desktop.launch()
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)

    await expect(page.getByTestId('ai-panel')).toBeVisible()
    await send(page.getByTestId('ai-panel'), FIRST_PROMPT)
    sessionId = (await waitForFinishedTurn(page)).activeSession ?? ''
    expect(sessionId).not.toBe('')

    const answerLeaf = page.locator('.answer-annotation-root [data-md-source-start]').last()
    await expect(answerLeaf).toBeVisible()
    await answerLeaf.evaluate((element) => {
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(element)
      selection?.removeAllRanges()
      selection?.addRange(range)
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await addAnnotation(page, sessionId)
    await submitAnnotation(page, sessionId, ANNOTATION_COMMENT)

    const inlineAnnotation = page.getByRole('button', { name: new RegExp(ANNOTATION_COMMENT) })
    await expect(inlineAnnotation).toBeVisible()
    const composerSummary = page.getByTestId('ai-context-ref').filter({ hasText: '1 条注释' })
    const composerBox = await page.getByTestId('ai-context-workspace').boundingBox()
    const summaryBox = await composerSummary.boundingBox()
    expect(composerBox).not.toBeNull()
    expect(summaryBox).not.toBeNull()
    expect(summaryBox!.width).toBeLessThan(composerBox!.width)
    await composerSummary.getByRole('button', { name: '1 条注释' }).hover()
    await expect(page.getByTestId(/^answer-annotation-details-/)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('assistant-inline-annotation-details.png') })
    await page.getByRole('button', { name: '编辑注释 1' }).click()
    const editInput = page.getByRole('textbox', { name: '编辑注释 1' })
    await editInput.fill(UPDATED_ANNOTATION_COMMENT)
    const updateResponse = page.waitForResponse((response) => (
      response.url().includes(`/api/assistant/sessions/${sessionId}/annotations/`)
      && response.request().method() === 'PATCH'
    ))
    await editInput.press('Enter')
    expect((await updateResponse).status()).toBe(200)
    await expect(page.getByText(UPDATED_ANNOTATION_COMMENT)).toBeVisible()
    await page.keyboard.press('Escape')

    await expect(page.getByTestId('ai-context-loading')).toHaveCount(0, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    })
    await expect(page.getByTestId('ai-search-scope')).toHaveCount(0)

    const panel = page.getByTestId('ai-panel')
    await panel.getByTestId('composer-input').fill(CONTEXT_PROMPT)
    await panel.getByTestId('composer-send').click()
    await expect.poll(async () => (await liveStatus(page))?.running, {
      timeout: TURN_COMPLETE_TIMEOUT_MS
    }).toBe(false)
    await expect(page.getByTestId('user-bubble').last()).toContainText(CONTEXT_PROMPT)
    await expect(page.getByTestId('user-bubble').last()).not.toContainText(INTERNAL_CONTEXT_MARKER)
    await expect(inlineAnnotation).toHaveCount(0)
    const historyAnnotationSummary = page.getByTestId('user-bubble').last()
      .getByRole('button', { name: '1 条注释' })
    await historyAnnotationSummary.hover()
    await expect(page.getByTestId(/^answer-annotation-details-/)).toContainText(UPDATED_ANNOTATION_COMMENT)
    await expect(page.getByRole('button', { name: '编辑注释 1' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '移除注释 1' })).toHaveCount(0)
    await page.getByTestId(/^answer-annotation-open-/).click()
    const focusedAnnotation = page.locator('[data-scholarseed-answer-annotation-focused="true"]')
    await expect(focusedAnnotation).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('assistant-annotation-history-focus.png') })

    const latestAnswerLeaf = page.locator('.answer-annotation-root [data-md-source-start]').last()
    await expect(latestAnswerLeaf).toBeVisible()
    await latestAnswerLeaf.evaluate((element) => {
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(element)
      selection?.removeAllRanges()
      selection?.addRange(range)
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await expect(page.getByRole('button', { name: '添加到任务' })).toBeVisible()
    await expect(page.getByRole('button', { name: '＋ 导入回答到资料库' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('assistant-second-answer-selection.png') })
    await addAnnotation(page, sessionId)
    await submitAnnotation(page, sessionId, DELETED_ANNOTATION_COMMENT)
    const deletableAnnotation = page.getByRole('button', { name: new RegExp(DELETED_ANNOTATION_COMMENT) })
    await deletableAnnotation.click()
    await page.getByRole('button', { name: '删除注释' }).click()
    const deleteDialog = page.getByTestId('answer-annotation-delete-dialog')
    await expect(deleteDialog).toBeVisible()
    const deleteResponse = page.waitForResponse((response) => (
      response.url().includes(`/api/assistant/sessions/${sessionId}/annotations/`)
      && !response.url().endsWith('/context')
      && response.request().method() === 'DELETE'
    ))
    await deleteDialog.getByRole('button', { name: '删除注释' }).click()
    expect((await deleteResponse).status()).toBe(200)
    await expect(deletableAnnotation).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('assistant-inline-annotation-deleted.png') })

    const persisted = await page.evaluate(async ({ base, sid }) => {
      const response = await fetch(`${base}/api/assistant/sessions/${sid}/context`)
      return response.json() as Promise<{ revision: number; search_scope: string }>
    }, { base: await apiBase(page), sid: sessionId })
    expect(persisted).toMatchObject({
      search_scope: 'web'
    })
    await page.screenshot({ path: testInfo.outputPath('assistant-context-active.png') })

    await desktop.close()
    page = await desktop.launch()
    const reloadedPanel = page.getByTestId('ai-panel')
    await reloadedPanel.getByTestId('ai-toggle-dock').click()
    await expect(reloadedPanel).toHaveClass(/is-floating/)
    await page.getByTestId('ai-session-toggle').click()
    const actionTrigger = page.getByTestId(`ai-session-actions-${sessionId}`)
    await actionTrigger.click()
    const actionMenu = page.getByTestId(`ai-session-action-menu-${sessionId}`)
    await expect(actionMenu).toBeVisible()
    await expect(page.getByTestId(`ai-session-delete-${sessionId}`)).toBeVisible()
    const actionMenuBox = await actionMenu.boundingBox()
    const actionTriggerBox = await actionTrigger.boundingBox()
    const viewportHeight = await page.evaluate(() => window.innerHeight)
    expect(actionMenuBox).not.toBeNull()
    expect(actionTriggerBox).not.toBeNull()
    expect(actionMenuBox!.y).toBeGreaterThanOrEqual(0)
    expect(actionMenuBox!.y + actionMenuBox!.height).toBeLessThanOrEqual(viewportHeight)
    expect(actionMenuBox!.x + actionMenuBox!.width).toBeLessThanOrEqual(
      actionTriggerBox!.x + actionTriggerBox!.width + 1
    )
    await page.screenshot({ path: testInfo.outputPath('assistant-session-action-menu.png') })
    await page.keyboard.press('Escape')
    await expect(actionMenu).toHaveCount(0)
    await page.getByTestId(`ai-session-${sessionId}`).click()
    await expect.poll(async () => (await liveStatus(page))?.activeSession, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(sessionId)
    await expect(page.getByTestId('user-bubble').last()).toContainText(CONTEXT_PROMPT)
    await expect(page.getByTestId('user-bubble').last()).not.toContainText(INTERNAL_CONTEXT_MARKER)
    const resumedAnnotationSummary = page.getByTestId('user-bubble').last()
      .getByRole('button', { name: '1 条注释' })
    await resumedAnnotationSummary.hover()
    await expect(page.getByTestId(/^answer-annotation-details-/)).toContainText(UPDATED_ANNOTATION_COMMENT)
    await expect(page.getByRole('button', { name: '编辑注释 1' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '移除注释 1' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: new RegExp(UPDATED_ANNOTATION_COMMENT) })).toHaveCount(0)
    const resumedContext = await page.evaluate(async ({ base, sid }) => {
      const response = await fetch(`${base}/api/assistant/sessions/${sid}/context`)
      return response.json() as Promise<{ revision: number; search_scope: string }>
    }, { base: await apiBase(page), sid: sessionId })
    expect(resumedContext).toMatchObject({
      revision: persisted.revision,
      search_scope: 'web'
    })
    await page.screenshot({ path: testInfo.outputPath('assistant-context-resumed.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('AI selection actions use isolated Codex turns without creating a product Session', async ({}, testInfo) => {
  test.skip(
    !ONE_SHOT_E2E_ENABLED,
    'requires explicitly enabled real Codex action acceptance'
  )
  const runtime = createRuntime(testInfo)
  if (process.env.SCHOLARSEED_ACTION_MODEL) {
    const blocker = seedLiveConfig(runtime)
    if (blocker) throw new Error(blocker)
  }
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    // Only this test's isolated settings change. Subscription needs Codex login, not an API key.
    const modelKey = process.env.SCHOLARSEED_ACTION_MODEL
    if (!modelKey) throw new Error('SCHOLARSEED_ACTION_MODEL must name a configured model connection')
    const selected = await page.evaluate(async ({ base, modelKey }) => {
      const response = await fetch(`${base}/api/serve/models/default`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_key: modelKey, persist: true })
      })
      return { status: response.status, body: await response.json() }
    }, { base: await apiBase(page), modelKey })
    expect(selected.status).toBe(200)
    const project = await createReadyProject(page, TRANSLATION_PROJECT_NAME)
    writeFileSync(join(project.root, TRANSLATION_FILE_RELATIVE), `# Translation\n\n${TRANSLATION_SOURCE}\n`)

    await page.reload()
    await enterWorkbenchShell(page)
    await openProjectMenu(page)
    await page.getByTestId(`project-menu-option-${TRANSLATION_PROJECT_NAME}`).click()
    const beforeSessions = await sessionCount(page)
    await page.getByTestId(`explorer-select-${TRANSLATION_FILE_RELATIVE}`).click()
    await selectMarkdownMode(page, 'edit')
    const source = page.getByTestId('markdown-visual-editor').getByText(TRANSLATION_SOURCE, { exact: true })
    await expect(source).toBeVisible()
    await source.click({ clickCount: 3 })
    const menu = page.getByTestId('selection-action-host')
    await expect(menu).toBeVisible()
    const invocation = page.waitForResponse((response) => (
      response.url().endsWith('/api/workbench/selection/actions') && response.request().method() === 'POST'
    ), { timeout: TURN_COMPLETE_TIMEOUT_MS })
    await menu.getByRole('button', { name: 'AI 翻译', exact: true }).click()
    const response = await invocation
    expect(response.status()).toBe(200)
    const result = await selectionResult(response)
    expect(result.status).toBe('completed')
    expect(result.output.trim()).not.toBe('')
    expect(result.invocation_id).not.toBe('')
    await expect(menu.locator('.vds-selection-action-output')).not.toHaveText('')
    await page.screenshot({ path: join(runtime.artifacts, 'assistant-translation.png') })
    expect(await sessionCount(page)).toBe(beforeSessions)
    expect((await liveStatus(page))?.activeSession).toBeNull()
    const replayResponse = page.waitForResponse(candidate => candidate.url().endsWith('/api/workbench/selection/actions'))
    await menu.getByRole('button', { name: 'AI 翻译', exact: true }).click()
    const replay = await selectionResult(await replayResponse)
    expect(replay.invocation_id).toBe(result.invocation_id)
    expect(replay.output).toBe(result.output)
    await expect(menu.locator('.vds-selection-action-output')).toHaveText(result.output)

    await menu.getByRole('button', { name: 'AI 解读', exact: true }).click()
    const question = `原文中的标记是什么意思？刚才译文是：${result.output}。请用中文简短解释。`
    await menu.getByRole('textbox').fill(question)
    const interpretationResponse = page.waitForResponse(
      candidate => candidate.url().endsWith('/api/workbench/selection/actions'),
      { timeout: TURN_COMPLETE_TIMEOUT_MS }
    )
    await menu.getByRole('button', { name: '开始解读', exact: true }).click()
    const interpretation = await selectionResult(await interpretationResponse)
    expect(interpretation.status).toBe('completed')
    expect(interpretation.invocation_id).not.toBe(result.invocation_id)
    expect(interpretation.output.trim()).not.toBe('')
    const interpretationOutput = menu.locator('.vds-selection-action-output')
    await expect(interpretationOutput).toHaveText(interpretation.output)
    expect(await interpretationOutput.evaluate((element) => (
      getComputedStyle(element.parentElement as HTMLElement, '::before').content
    ))).toBe('none')
    await menu.getByRole('button', { name: '复制', exact: true }).click()
    await expect(menu.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
    expect(await desktop.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(interpretation.output)
    await page.screenshot({ path: join(runtime.artifacts, 'assistant-interpretation.png') })
    expect(await sessionCount(page)).toBe(beforeSessions)
    await menu.getByRole('button', { name: '添加到任务', exact: true }).click()
    await expect(page.getByTestId('assistant-selection-quote')).toContainText(TRANSLATION_SOURCE)
    const records = await page.evaluate(async ({ base, ids }) => Promise.all(ids.map(async id => {
      const response = await fetch(`${base}/api/assistant/invocations/${id}`)
      if (!response.ok) throw new Error(`invocation_status_${response.status}`)
      return response.json()
    })), { base: await apiBase(page), ids: [result.invocation_id, interpretation.invocation_id] })
    expect(records.every(record => record.status === 'completed')).toBe(true)
    writeFileSync(join(runtime.artifacts, 'selection-verdict.json'), JSON.stringify({
      status: 'passed', modelKey, productSessionsBefore: beforeSessions,
      productSessionsAfter: await sessionCount(page), translation: result, interpretation, records
    }, null, 2))
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('AI polish remains a suggestion until replacement and explicit save', async ({}, testInfo) => {
  test.skip(!ONE_SHOT_E2E_ENABLED, 'requires explicitly enabled real Codex action acceptance')
  const runtime = createRuntime(testInfo)
  if (process.env.SCHOLARSEED_ACTION_MODEL) {
    const blocker = seedLiveConfig(runtime)
    if (blocker) throw new Error(blocker)
  }
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const modelKey = process.env.SCHOLARSEED_ACTION_MODEL
    if (!modelKey) throw new Error('SCHOLARSEED_ACTION_MODEL must name a configured model connection')
    const selected = await page.evaluate(async ({ base, modelKey }) => {
      const response = await fetch(`${base}/api/serve/models/default`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_key: modelKey, persist: true })
      })
      return response.status
    }, { base: await apiBase(page), modelKey })
    expect(selected).toBe(200)
    const project = await createReadyProject(page, POLISH_PROJECT_NAME)
    const sourcePath = join(project.root, POLISH_FILE_RELATIVE)
    const sourceFile = `# Polish\n\n${POLISH_SOURCE}\n`
    writeFileSync(sourcePath, sourceFile)
    await page.reload()
    await enterWorkbenchShell(page)
    await openProjectMenu(page)
    await page.getByTestId(`project-menu-option-${POLISH_PROJECT_NAME}`).click()
    await page.getByTestId(`explorer-select-${POLISH_FILE_RELATIVE}`).click()
    await selectMarkdownMode(page, 'edit')
    const original = page.getByTestId('markdown-visual-editor').getByText(POLISH_SOURCE, { exact: true })
    await original.click({ clickCount: 3 })
    const menu = page.getByTestId('selection-action-host')
    const invocation = page.waitForResponse((response) => (
      response.url().endsWith('/api/workbench/selection/actions')
      && response.request().method() === 'POST'
    ), { timeout: TURN_COMPLETE_TIMEOUT_MS })
    await menu.getByRole('button', { name: 'AI 润色', exact: true }).click()
    const response = await invocation
    expect(response.status()).toBe(200)
    expect(response.request().postDataJSON()).toMatchObject({ action: 'polish' })
    const result = await selectionResult(response)
    expect(result.status).toBe('completed')
    expect(result.output.trim()).not.toBe('')
    await expect(menu.locator('.vds-selection-action-output')).toHaveText(result.output)
    expect(readFileSync(sourcePath, 'utf8')).toBe(sourceFile)
    await menu.getByRole('button', { name: '替换原文', exact: true }).click()
    const tab = page.locator('.vds-document-tab').filter({ hasText: 'polish.md' })
    await expect(tab.locator('i[aria-label="未保存"]')).toHaveCount(1)
    expect(readFileSync(sourcePath, 'utf8')).toBe(sourceFile)
    await expect(page.getByTestId('markdown-visual-editor')).toContainText(result.output.trim())
    const draftText = page.getByTestId('markdown-visual-editor').getByText(result.output.trim(), { exact: true })
    await draftText.click({ clickCount: 3 })
    const draftInvocation = page.waitForResponse((candidate) => (
      candidate.url().endsWith('/api/workbench/selection/actions')
      && candidate.request().method() === 'POST'
    ), { timeout: TURN_COMPLETE_TIMEOUT_MS })
    await page.getByTestId('selection-action-host')
      .getByRole('button', { name: 'AI 润色', exact: true }).click()
    const draftResponse = await draftInvocation
    expect(draftResponse.status()).toBe(200)
    expect(draftResponse.request().postDataJSON()).toMatchObject({
      action: 'polish',
      draft: { selected_text: result.output.trim() }
    })
    expect((await selectionResult(draftResponse)).status).toBe('completed')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    await expect(tab.locator('i[aria-label="未保存"]')).toHaveCount(0)
    await expect.poll(() => readFileSync(sourcePath, 'utf8')).toContain(result.output.trim())
    await page.screenshot({ path: join(runtime.artifacts, 'assistant-polish-replaced.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('Folder expands', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: Object.fromEntries(ONBOARDING_GROUPS.map((group) => [group, true])) }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const project = await createReadyProject(page, CONTEXT_PROJECT_NAME)
    mkdirSync(join(project.root, CONTEXT_FOLDER_RELATIVE), { recursive: true })
    writeFileSync(join(project.root, CONTEXT_NESTED_FILE_RELATIVE), `${CONTEXT_FOLDER_NONCE}\n`)

    await page.reload()
    await enterWorkbenchShell(page)
    await openProjectMenu(page)
    await page.getByTestId(`project-menu-option-${CONTEXT_PROJECT_NAME}`).click()
    const panel = page.getByTestId('ai-panel')
    if (!await panel.isVisible()) await page.getByTestId('topbar-ai').click()
    const input = panel.getByTestId('composer-input')
    await input.fill('@resource:')
    await expect(panel.getByTestId('composer-at-panel')).toBeVisible()

    const folderOption = panel.getByTestId(`composer-at-context-dir-${CONTEXT_FOLDER_RELATIVE}`)
    await folderOption.click()
    await expect(input).toHaveValue(`@resource:${CONTEXT_FOLDER_NAME}/`)
    await expect(panel.getByTestId(`composer-at-context-file-${CONTEXT_NESTED_FILE_RELATIVE}`)).toBeVisible()
    await expect(panel.getByTestId('ai-context-ref')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('assistant-resource-folder-expanded.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('Assistant reference picker keeps one visible flyout', async ({}, testInfo) => {
  test.skip(
    !CONTEXT_SOURCES_E2E_ENABLED,
    'requires Resource and Literature features to register their Assistant source contributions'
  )
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const panel = page.getByTestId('ai-panel')
    if (!await panel.isVisible()) await page.getByTestId('topbar-ai').click()
    await panel.getByTestId('composer-plus').click()
    await page.getByTestId('composer-add-session-context').click()
    await expect(page.getByTestId('ai-context-picker')).toBeVisible()
    const referenceSubmenu = page.getByTestId('composer-plus-submenu')
    const referenceSubmenuElement = await referenceSubmenu.elementHandle()
    if (!referenceSubmenuElement) throw new Error('reference_submenu_missing')
    await expect(page.getByTestId('reference-picker-back')).toHaveCount(0)
    await expect(page.locator('[data-testid^="reference-picker-filter-"]')).toHaveCount(0)
    await expect(referenceSubmenu).toBeVisible()
    expect(await referenceSubmenu.evaluate(
      (element, initialElement) => element === initialElement,
      referenceSubmenuElement
    )).toBe(true)
    await page.waitForTimeout(MENU_ANIMATION_SETTLE_MS)
    const sessionPickerHeight = await page.getByTestId('reference-picker').evaluate((element) => element.getBoundingClientRect().height)
    expect(await page.getByTestId('reference-picker-list').evaluate((element) => element.getBoundingClientRect().height)).toBe(REFERENCE_PICKER_LIST_HEIGHT)
    const search = page.getByTestId('reference-picker-search')
    await search.fill('啊')
    await page.mouse.move(0, 0)
    await page.waitForTimeout(MENU_ANIMATION_SETTLE_MS)
    await expect(search).toBeVisible()
    await expect(search).toBeFocused()
    await search.pressSequentially('发')
    await expect(search).toHaveValue('啊发')
    expect(await page.getByTestId('reference-picker').evaluate((element) => element.getBoundingClientRect().height)).toBe(sessionPickerHeight)
    const empty = referenceSubmenu.locator('.vds-empty-state')
    await expect(empty).toHaveAttribute('data-variant', 'compact')
    await expect(empty).toHaveCSS('row-gap', '16px')
    await expect(empty.locator('.vds-empty-state__title')).toHaveCSS('font-size', '14px')
    await expect(empty.locator('.vds-empty-state__title')).toHaveCSS('font-weight', '400')
    await expect(empty.locator('.vds-empty-state__icon')).toHaveCSS('width', '36px')
    await expect(empty.locator('.vds-empty-state__icon')).toHaveCSS('border-radius', '8px')
    await expect(empty.locator('svg')).toHaveCSS('width', '16px')
    await page.screenshot({ path: testInfo.outputPath('assistant-reference-picker-stable.png') })
    await search.press('Escape')
    await expect(referenceSubmenu).toHaveCount(0)
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('Assistant literature mentions list all scoped papers without keywords', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const project = await createReadyProject(page, '文献候选回归')
    const otherProject = await createReadyProject(page, '其他文献范围')
    const title = 'Literature Mention Regression'
    const otherTitle = 'Another Scoped Paper'
    for (const [target, paperTitle] of [[project, title], [otherProject, otherTitle]] as const) {
      const source = join(target.root, 'mention.bib')
      writeFileSync(source, `@article{mention, title = {${paperTitle}}, year = {2026}}\n`)
      await importBibliography(page, target.id, [source])
    }
    await page.reload()
    await openProjectMenu(page)
    await page.getByTestId(`project-menu-option-${project.name}`).click()
    await page.getByTestId('activity-literature').click()
    if (!(await page.getByTestId('ai-panel').isVisible())) {
      await page.getByTestId('topbar-ai').click()
    }
    const input = page.getByTestId('ai-panel').getByTestId('composer-input')
    const picker = page.getByTestId('composer-at-panel')
    await input.fill('@')
    await page.getByTestId('composer-at-kind-literature').click()
    await expect(picker.getByRole('option', { name: title, exact: false })).toBeVisible()
    await expect(picker.getByRole('option', { name: otherTitle, exact: false })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('literature-mentions-global.png') })
    await input.fill('@literature:Regression')
    await expect(picker.getByRole('option')).toHaveCount(1)
    await expect(picker.getByRole('option')).toContainText(title)
    await input.fill('@literature:')
    await expect(picker.getByRole('option')).toHaveCount(2)
    await input.fill('')
    await openProjectMenu(page)
    await page.getByTestId(`project-menu-option-${project.name}`).click()
    await input.fill('@literature:')
    await expect(picker.getByRole('option')).toHaveCount(1)
    await expect(picker.getByRole('option')).toContainText(title)
    await page.screenshot({ path: testInfo.outputPath('literature-mentions-project.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('Assistant reference picker selects across folders before adding references', async ({}, testInfo) => {
  test.skip(!CONTEXT_SOURCES_E2E_ENABLED, 'requires Resource and Literature source contributions')
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const project = await createReadyProject(page, CONTEXT_PROJECT_NAME)
    writeFileSync(join(project.root, CONTEXT_FILE_RELATIVE), `${CONTEXT_NONCE}\n`)
    const plainFileRelative = `${MANAGED_RESOURCES_DIR}/test.txt`
    writeFileSync(join(project.root, plainFileRelative), 'test\n')
    mkdirSync(join(project.root, CONTEXT_FOLDER_RELATIVE), { recursive: true })
    writeFileSync(join(project.root, CONTEXT_NESTED_FILE_RELATIVE), `${CONTEXT_FOLDER_NONCE}\n`)
    const longFolderName = '超长标题'.repeat(12)
    const longFolderRelative = `${MANAGED_RESOURCES_DIR}/${longFolderName}`
    const longFileName = `${'超长文件名'.repeat(10)}.md`
    const longFileRelative = `${CONTEXT_FOLDER_RELATIVE}/${longFileName}`
    mkdirSync(join(project.root, longFolderRelative), { recursive: true })
    writeFileSync(join(project.root, longFileRelative), `${CONTEXT_FOLDER_NONCE}\n`)
    const literatureTitle = 'A Long Literature Title for Checking the Two-Line Truncation and Side Tooltip in the Reference Picker'
    const literaturePath = join(project.root, CONTEXT_LITERATURE_FILE)
    writeFileSync(literaturePath, `@article{reference-picker-tooltip, title = {${literatureTitle}}, author = {Researcher, Context}, year = {2026}}\n`)
    const ungroupedPath = join(project.root, 'reference-picker-ungrouped.bib')
    writeFileSync(ungroupedPath, '@article{reference-picker-ungrouped, title = {Unorganized Reference}, author = {Author, Another}, year = {2025}}\n')
    const [literatureId, ungroupedId] = await importBibliography(page, project.id, [
      literaturePath,
      ungroupedPath
    ])
    expect(literatureId && ungroupedId, 'literature_import_missing_ids').toBeTruthy()
    const { parentCollectionId, childCollectionId } = await page.evaluate(async ({ base, projectId, literatureId }) => {
      const createCollection = async (name: string, parentId?: string): Promise<string> => {
        const result = await fetch(`${base}/api/v1/collections`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, project_id: projectId, parent_id: parentId ?? '' })
        })
        if (!result.ok) throw new Error(`literature_collection_${result.status}`)
        return (await result.json() as { id: string }).id
      }
      const parentCollectionId = await createCollection('科学')
      const childCollectionId = await createCollection('物理', parentCollectionId)
      const assign = await fetch(`${base}/api/v1/literatures/${encodeURIComponent(literatureId)}?project_id=${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_collection_ids: [childCollectionId] })
      })
      if (!assign.ok) throw new Error(`literature_assign_${assign.status}`)
      return { parentCollectionId, childCollectionId }
    }, { base: await apiBase(page), projectId: project.id, literatureId })
    await page.reload()
    await enterWorkbenchShell(page)
    await openProjectMenu(page)
    await page.getByTestId(`project-menu-option-${CONTEXT_PROJECT_NAME}`).click()
    const panel = page.getByTestId('ai-panel')
    if (!await panel.isVisible()) await page.getByTestId('topbar-ai').click()
    const pickerRequests: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (
        (url.pathname === '/api/resource/tree' && url.searchParams.get('depth') === '1' && !url.searchParams.has('path'))
        || (url.pathname === '/api/v1/literatures' && url.searchParams.get('page_size') === '200')
      ) pickerRequests.push(request.url())
    })
    await panel.getByTestId('composer-plus').click()
    await page.getByTestId('composer-add-resource-context').click()
    await page.waitForTimeout(MENU_ANIMATION_SETTLE_MS)
    expect(pickerRequests.filter((url) => url.includes('/api/resource/tree?'))).toHaveLength(1)
    expect(await page.getByTestId('reference-picker-list').evaluate((element) => element.getBoundingClientRect().height)).toBe(REFERENCE_PICKER_LIST_HEIGHT)
    await expect(page.getByTestId(`ai-context-option-file-${CONTEXT_FILE_RELATIVE}`).locator('svg.lucide-file')).toBeVisible()
    await expect(page.getByTestId(`ai-context-option-file-${plainFileRelative}`).locator('svg.lucide-file')).toBeVisible()
    const longFolderOption = page.getByTestId(`ai-context-option-dir-${longFolderRelative}`)
    await expect(longFolderOption.locator('.line-clamp-2')).toBeVisible()
    await expect(longFolderOption.locator('small')).toHaveText('文件夹 · 0项')
    await longFolderOption.hover()
    await expect(page.getByRole('tooltip')).toContainText(longFolderName)
    await page.screenshot({ path: testInfo.outputPath('assistant-reference-picker-long-folder-tooltip.png') })
    await longFolderOption.click()
    const breadcrumb = page.getByTestId('reference-picker-breadcrumb')
    await expect(breadcrumb).toBeVisible()
    await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText(longFolderName)
    const breadcrumbMetrics = await breadcrumb.locator('ol').evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight)
    }))
    expect(breadcrumbMetrics.height).toBeLessThanOrEqual(breadcrumbMetrics.lineHeight + 2)
    expect(await page.getByTestId('reference-picker-list').evaluate((element) => element.getBoundingClientRect().height)).toBe(REFERENCE_PICKER_LIST_HEIGHT)
    await breadcrumb.locator('[aria-current="page"]').hover()
    await expect(page.getByRole('tooltip')).toContainText(longFolderName)
    await page.screenshot({ path: testInfo.outputPath('assistant-reference-picker-single-line-breadcrumb.png') })
    await breadcrumb.getByRole('link', { name: '资料库' }).click()
    const resourceFolderOption = page.getByTestId(`ai-context-option-dir-${CONTEXT_FOLDER_RELATIVE}`)
    await expect(resourceFolderOption).toBeVisible()
    await expect(resourceFolderOption.locator('small')).toHaveText('文件夹 · 2项')
    const resourceTitleBounds = await resourceFolderOption.locator('.line-clamp-2').boundingBox()
    const resourceLineHeight = await resourceFolderOption.locator('.line-clamp-2').evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight))
    const resourceCheckboxBounds = await page.getByTestId(`ai-context-select-dir-${CONTEXT_FOLDER_RELATIVE}`).locator('.vds-checkbox__box').boundingBox()
    const resourceIconBounds = await resourceFolderOption.locator('svg').first().boundingBox()
    if (!resourceTitleBounds || !resourceCheckboxBounds || !resourceIconBounds) throw new Error('resource_row_bounds_missing')
    const resourceFirstLineCenter = resourceTitleBounds.y + resourceLineHeight / 2
    expect(Math.abs(resourceFirstLineCenter - resourceCheckboxBounds.y - resourceCheckboxBounds.height / 2)).toBeLessThanOrEqual(2)
    expect(Math.abs(resourceFirstLineCenter - resourceIconBounds.y - resourceIconBounds.height / 2)).toBeLessThanOrEqual(2)
    await resourceFolderOption.click()
    await expect(page.getByTestId(`ai-context-select-file-${CONTEXT_NESTED_FILE_RELATIVE}`)).toBeVisible()
    expect(await page.getByTestId('reference-picker-list').evaluate((element) => element.getBoundingClientRect().height)).toBe(REFERENCE_PICKER_LIST_HEIGHT)
    await page.screenshot({ path: testInfo.outputPath('assistant-reference-picker-folder-fixed-height.png') })
    const longFileOption = page.getByTestId(`ai-context-option-file-${longFileRelative}`)
    await expect(longFileOption.locator('.line-clamp-2')).toBeVisible()
    await expect(longFileOption.locator('small')).toHaveText('文件')
    await longFileOption.hover()
    await expect(page.getByRole('tooltip')).toContainText(longFileName)
    await page.screenshot({ path: testInfo.outputPath('assistant-reference-picker-long-file-tooltip.png') })
    await page.getByTestId(`ai-context-select-file-${CONTEXT_NESTED_FILE_RELATIVE}`).click()
    await page.getByTestId('ai-context-picker').getByRole('link', { name: '资料库' }).click()
    await page.getByTestId(`ai-context-select-file-${CONTEXT_FILE_RELATIVE}`).click()
    await expect(page.getByTestId('ai-context-picker')).toContainText('已选择 2 项')
    await page.screenshot({ path: testInfo.outputPath('assistant-reference-picker-multiselect.png') })
    await page.getByTestId('reference-picker-confirm').click()
    await expect(panel.getByTestId('ai-context-ref').filter({ hasText: CONTEXT_FILE_NAME })).toBeVisible()
    await expect(panel.getByTestId('ai-context-ref').filter({ hasText: CONTEXT_NESTED_FILE_NAME })).toBeVisible()
    await panel.getByTestId('composer-plus').click()
    await page.getByTestId('composer-add-literature-context').hover()
    await page.waitForTimeout(MENU_ANIMATION_SETTLE_MS)
    await expect(page.getByTestId('reference-picker')).toBeVisible()
    expect(pickerRequests.filter((url) => url.includes('/api/v1/literatures?'))).toHaveLength(1)
    await expect(page.getByTestId(`reference-picker-group-${parentCollectionId}`)).toBeVisible()
    await expect(page.getByTestId('reference-picker-group-literature:ungrouped')).toBeVisible()
    await expect(page.getByTestId('reference-picker-list')).toContainText('我的分类')
    await expect(page.getByTestId('reference-picker-categories-heading').locator('svg.lucide-list-tree')).toBeVisible()
    await expect(page.getByTestId(`reference-picker-group-${parentCollectionId}`).locator('svg.lucide-layers-2')).toBeVisible()
    await expect(page.getByTestId('reference-picker-group-literature:ungrouped').locator('svg.lucide-mail-question-mark')).toBeVisible()
    await expect(page.getByTestId('reference-picker-list')).not.toContainText('最近打开')
    await expect(page.getByTestId('reference-picker-list')).not.toContainText('最新添加')
    await page.screenshot({ path: testInfo.outputPath('assistant-literature-reference-categories.png') })
    await page.getByTestId(`reference-picker-group-${parentCollectionId}`).click()
    await expect(page.getByTestId(`reference-picker-group-${childCollectionId}`)).toBeVisible()
    await page.getByTestId(`reference-picker-group-${childCollectionId}`).click()
    const literatureOption = page.getByTestId(`ai-context-option-literature-${literatureId}`)
    await expect(literatureOption).toBeVisible()
    expect(pickerRequests.filter((url) => url.includes('/api/v1/literatures?'))).toHaveLength(3)
    const literaturePickerHeight = await page.getByTestId('reference-picker').evaluate((element) => element.getBoundingClientRect().height)
    expect(await page.getByTestId('reference-picker-list').evaluate((element) => element.getBoundingClientRect().height)).toBe(REFERENCE_PICKER_LIST_HEIGHT)
    await expect(literatureOption.locator('small')).toContainText('Context Researcher · 2026')
    await page.getByTestId('reference-picker-search').fill('Long')
    await expect.poll(() => pickerRequests.filter((url) => url.includes('/api/v1/literatures?')).length).toBe(4)
    await expect(literatureOption).toBeVisible()
    await page.getByTestId('reference-picker-clear').click()
    await expect(page.getByTestId('reference-picker-breadcrumb')).toContainText('物理')
    await expect(literatureOption).toBeVisible()
    await expect(literatureOption.locator('.line-clamp-2')).toBeVisible()
    const literatureTitleBounds = await literatureOption.locator('.line-clamp-2').boundingBox()
    const literatureLineHeight = await literatureOption.locator('.line-clamp-2').evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight))
    const literatureCheckboxBounds = await page.getByTestId(`ai-context-select-literature-${literatureId}`).locator('.vds-checkbox__box').boundingBox()
    const literatureIconBounds = await literatureOption.locator('svg').first().boundingBox()
    if (!literatureTitleBounds || !literatureCheckboxBounds || !literatureIconBounds) throw new Error('literature_row_bounds_missing')
    const firstLineCenter = literatureTitleBounds.y + literatureLineHeight / 2
    expect(Math.abs(firstLineCenter - literatureCheckboxBounds.y - literatureCheckboxBounds.height / 2)).toBeLessThanOrEqual(2)
    expect(Math.abs(firstLineCenter - literatureIconBounds.y - literatureIconBounds.height / 2)).toBeLessThanOrEqual(2)
    await literatureOption.hover()
    await expect(page.getByRole('tooltip')).toContainText(literatureTitle)
    await page.screenshot({ path: testInfo.outputPath('assistant-literature-reference-tooltip.png') })
    await page.getByTestId(`ai-context-select-literature-${literatureId}`).click()
    await page.getByTestId('reference-picker-breadcrumb').getByRole('link', { name: '文献库' }).click()
    await page.getByTestId('reference-picker-group-literature:ungrouped').click()
    await expect(page.getByTestId(`ai-context-option-literature-${ungroupedId}`)).toBeVisible()
    await page.getByTestId(`ai-context-select-literature-${ungroupedId}`).click()
    await expect(page.getByTestId('ai-context-picker')).toContainText('已选择 2 项')
    await page.screenshot({ path: testInfo.outputPath('assistant-literature-reference-unorganized.png') })
    await page.getByTestId('reference-picker-search').fill('no-matching-literature')
    await expect(page.getByTestId('reference-picker-list').locator('.vds-empty-state')).toBeVisible()
    expect(await page.getByTestId('reference-picker').evaluate((element) => element.getBoundingClientRect().height)).toBe(literaturePickerHeight)
    await page.screenshot({ path: testInfo.outputPath('assistant-literature-reference-empty-height.png') })
    await page.getByTestId('reference-picker-clear').click()
    await page.getByTestId('reference-picker-confirm').click()
    await expect(panel.getByTestId('ai-context-ref').filter({ hasText: literatureTitle })).toBeVisible()
    await expect(panel.getByTestId('ai-context-ref').filter({ hasText: 'Unorganized Reference' })).toBeVisible()
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test(PROJECT_TAB_TEST_TITLE, async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const preferences = join(runtime.userData, PROJECT_TAB_PREFERENCES_FILE)
  writeFileSync(preferences, JSON.stringify({
    ...JSON.parse(readFileSync(preferences, 'utf8')),
    onboarding: { seen: Object.fromEntries(ONBOARDING_GROUPS.map((group) => [group, true])) }
  }))
  const blocker = seedLiveConfig(runtime)
  if (process.env.SCHOLARSEED_CI_OFFLINE === '1') test.skip(Boolean(blocker), blocker ?? '')
  if (blocker) throw new Error(blocker)
  const realHome = process.env.SCHOLARSEED_REAL_HOME!
  for (const relative of ['model_profiles.json', 'service/settings.json']) {
    const source = join(realHome, relative)
    if (existsSync(source)) copyFileSync(source, join(runtime.home, relative))
  }
  const desktop = new DesktopSession(runtime, testInfo)
  const registrationRequests: string[] = []
  try {
    const page = await desktop.launch()
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/file-references')) {
        registrationRequests.push(request.postData() ?? '')
      }
    })
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    const project = await createReadyProject(page, CONTEXT_PROJECT_NAME)
    writeFileSync(join(project.root, CONTEXT_FILE_RELATIVE), `${CONTEXT_NONCE}\n`)
    await page.reload()
    await enterWorkbenchShell(page)
    await openProjectMenu(page)
    await page.getByTestId(`project-menu-option-${CONTEXT_PROJECT_NAME}`).click()
    await openProjectExplorer(page)
    const panel = page.getByTestId('ai-panel')
    if (!await panel.isVisible()) await page.getByTestId('topbar-ai').click()
    const treeFile = page.getByTestId(`explorer-select-${CONTEXT_FILE_RELATIVE}`)
    await treeFile.dblclick()
    const tab = page.getByRole('tab').filter({ hasText: CONTEXT_FILE_NAME })
    await tab.click({ button: 'right' })
    await page.getByTestId('tab-add-to-conversation').click()
    const chip = panel.getByTestId('ai-context-ref').filter({ hasText: CONTEXT_FILE_NAME })
    await expect(chip).toHaveCount(1)
    await treeFile.click({ button: 'right' })
    await page.getByTestId('menu-ai-context').click()
    await expect(chip).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath('project-tab-draft-deduplicated.png') })
    await send(panel, PROJECT_TAB_PROMPT)
    await waitForFinishedTurn(page)
    await expect(panel.getByTestId('ai-stream')).toContainText(CONTEXT_NONCE, {
      timeout: TURN_COMPLETE_TIMEOUT_MS
    })
    await expect(panel.locator('.answer-annotation-root').last()).toContainText(CONTEXT_NONCE)
    const sessionId = (await liveStatus(page))?.activeSession ?? ''
    const persisted = await page.evaluate(async ({ base, sid }) => {
      const response = await fetch(`${base}/api/assistant/sessions/${sid}/context`)
      if (!response.ok) throw new Error(`context_read_${response.status}`)
      return response.json() as Promise<{ refs: { kind: string; source_id: string; origin: string; retention: string }[] }>
    }, { base: await apiBase(page), sid: sessionId })
    expect(persisted.refs.filter((ref) => ref.kind === 'file' && ref.source_id === CONTEXT_FILE_RELATIVE)).toEqual([
      expect.objectContaining({ origin: 'explicit', retention: 'session' })
    ])
    expect(registrationRequests).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('project-tab-new-conversation.png') })
    await tab.click({ button: 'right' })
    await page.getByTestId('tab-add-to-conversation').click()
    await expect(chip).toHaveCount(1)
    await treeFile.click({ button: 'right' })
    await page.getByTestId('menu-ai-context').click()
    await expect(chip).toHaveCount(1)
    const nextNonce = `${CONTEXT_NONCE}-second`
    writeFileSync(join(project.root, CONTEXT_FILE_RELATIVE), `${nextNonce}\n`)
    const previousMessages = await panel.getByTestId('user-bubble').count()
    await send(panel, PROJECT_TAB_FOLLOWUP)
    await expect(panel.getByTestId('user-bubble')).toHaveCount(previousMessages + 1)
    await expect.poll(async () => (await liveStatus(page))?.running, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    await waitForFinishedTurn(page)
    await expect(panel.getByTestId('ai-stream')).toContainText(nextNonce, {
      timeout: TURN_COMPLETE_TIMEOUT_MS
    })
    await expect(panel.locator('.answer-annotation-root').last()).toContainText(nextNonce)
    expect((await liveStatus(page))?.activeSession).toBe(sessionId)
    expect(registrationRequests).toEqual([])
    await expect(chip).toHaveCount(1)
    await expect(panel.getByTestId('assistant-working')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('project-tab-existing-conversation.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('Assistant resources and literature enter through the prototype queue and reach the real Agent', async ({}, testInfo) => {
  test.skip(
    !CONTEXT_SOURCES_E2E_ENABLED,
    'requires Resource and Literature features to register their Assistant source contributions'
  )
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)

    const project = await createReadyProject(page, CONTEXT_PROJECT_NAME)
    writeFileSync(join(project.root, CONTEXT_FILE_RELATIVE), `${CONTEXT_NONCE}\n`)
    mkdirSync(join(project.root, CONTEXT_FOLDER_RELATIVE), { recursive: true })
    writeFileSync(
      join(project.root, CONTEXT_NESTED_FILE_RELATIVE),
      `${CONTEXT_FOLDER_NONCE}\n`
    )
    const literaturePath = join(project.root, CONTEXT_LITERATURE_FILE)
    writeFileSync(literaturePath, `@article{context-e2e,
  title = {${CONTEXT_LITERATURE_TITLE}},
  author = {Researcher, Context},
  journal = {Queue Validation},
  year = {2026},
  abstract = {${CONTEXT_LITERATURE_NONCE}},
  doi = {10.1000/context-e2e}
}\n`)
    const [literatureId] = await importBibliography(page, project.id, [literaturePath])
    expect(literatureId, 'literature_import_missing_id').toBeTruthy()

    await page.reload()
    await enterWorkbenchShell(page)
    await openProjectMenu(page)
    await page.getByTestId(`project-menu-option-${CONTEXT_PROJECT_NAME}`).click()
    await page.getByTestId('topbar-ai').click()

    const panel = page.getByTestId('ai-panel')
    await expect(panel.getByTestId('composer-input')).toBeVisible()
    await panel.getByTestId('composer-plus').click()
    await page.waitForTimeout(MENU_ANIMATION_SETTLE_MS)
    await page.screenshot({ path: testInfo.outputPath('assistant-plus-menu.png') })
    await panel.getByTestId('composer-skills-menu').click()
    const skillPicker = panel.getByTestId('composer-skill-picker')
    await expect(skillPicker).toBeVisible()
    const skillPickerInsideViewport = await skillPicker.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return rect.left >= 0 && rect.right <= window.innerWidth
    })
    expect(skillPickerInsideViewport).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('assistant-plus-skills.png') })
    await page.getByTestId('composer-add-resource-context').click()
    await expect(page.getByTestId('ai-context-picker')).toBeVisible()
    await page.waitForTimeout(MENU_ANIMATION_SETTLE_MS)
    await page.screenshot({ path: testInfo.outputPath('assistant-plus-resources.png') })
    const folderOption = page.getByTestId(`ai-context-option-dir-${CONTEXT_FOLDER_RELATIVE}`)
    await folderOption.click()
    await expect(page.getByTestId(`ai-context-option-file-${CONTEXT_NESTED_FILE_RELATIVE}`)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('assistant-plus-resources-folder-expanded.png') })
    await page.getByTestId(`ai-context-select-file-${CONTEXT_NESTED_FILE_RELATIVE}`).click()
    await page.getByTestId('ai-context-picker').getByRole('link', { name: '资料库' }).click()
    await page.getByTestId(`ai-context-select-file-${CONTEXT_FILE_RELATIVE}`).click()
    await expect(page.getByTestId('reference-picker-confirm')).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath('assistant-plus-resources-selected.png') })
    await page.getByTestId('reference-picker-confirm').click()
    const contextChip = panel.getByTestId('ai-context-ref').filter({ hasText: CONTEXT_FILE_NAME })
    await expect(contextChip).toBeVisible()
    await expect(panel.getByTestId('ai-context-ref').filter({ hasText: CONTEXT_NESTED_FILE_NAME })).toBeVisible()

    await panel.getByTestId('composer-plus').click()
    await page.getByTestId('composer-add-literature-context').click()
    await expect(page.getByTestId(`ai-context-option-literature-${literatureId}`)).toBeVisible()
    await page.waitForTimeout(MENU_ANIMATION_SETTLE_MS)
    await page.screenshot({ path: testInfo.outputPath('assistant-plus-literature.png') })
    await page.getByTestId(`ai-context-select-literature-${literatureId}`).click()
    await page.getByTestId('reference-picker-confirm').click()
    const literatureChip = panel.getByTestId('ai-context-ref').filter({ hasText: CONTEXT_LITERATURE_TITLE })
    await expect(literatureChip).toBeVisible()

    await panel.getByTestId('composer-plus').click()
    await panel.getByTestId('composer-add-session-context').click()
    await expect(panel.getByTestId('ai-context-picker')).toContainText('引用对话')
    await page.waitForTimeout(MENU_ANIMATION_SETTLE_MS)
    await page.screenshot({ path: testInfo.outputPath('assistant-plus-conversations.png') })
    await page.mouse.click(900, 500)

    await page.getByTestId(`explorer-select-${CONTEXT_FOLDER_RELATIVE}`).click({ button: 'right' })
    await page.getByTestId('menu-ai-context').click()
    const folderChip = panel.getByTestId('ai-context-ref').filter({ hasText: CONTEXT_FOLDER_NAME })
    await expect(folderChip).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('assistant-context-queue-before-send.png') })

    await panel.getByTestId('ai-toggle-dock').click()
    await expect(panel).toHaveClass(/is-floating/)
    await page.screenshot({ path: testInfo.outputPath('assistant-floating.png') })
    await panel.getByTestId('ai-toggle-dock').click()
    await expect(panel).toHaveClass(/is-docked/)

    await send(panel, FILE_CONTEXT_PROMPT)
    await waitForFinishedTurn(page)
    await expect(panel.getByTestId('ai-stream')).toContainText(CONTEXT_NONCE, {
      timeout: TURN_COMPLETE_TIMEOUT_MS
    })
    await expect(panel.getByTestId('ai-stream')).toContainText(CONTEXT_FOLDER_NONCE)
    await expect(panel.getByTestId('ai-stream')).toContainText(CONTEXT_LITERATURE_NONCE)
    await expect(panel.getByTestId('user-bubble').last()).not.toContainText(CONTEXT_NONCE)
    await expect(contextChip).toBeVisible()
    await expect(folderChip).toBeVisible()
    await expect(literatureChip).toBeVisible()

    const persisted = await page.evaluate(async ({ base, sid }) => {
      const response = await fetch(`${base}/api/assistant/sessions/${sid}/context`)
      return response.json() as Promise<{ refs: { kind: string; source_id: string }[] }>
    }, { base: await apiBase(page), sid: (await liveStatus(page))?.activeSession ?? '' })
    expect(persisted.refs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'file',
        source_id: CONTEXT_FILE_RELATIVE
      }),
      expect.objectContaining({
        kind: 'dir',
        source_id: CONTEXT_FOLDER_RELATIVE
      }),
      expect.objectContaining({
        kind: 'literature',
        source_id: literatureId
      })
    ]))
    await page.screenshot({ path: testInfo.outputPath('assistant-context-queue-after-send.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})


for (const scope of ['resource', 'literature'] as const) {
  test(`personal selection prompts reach real ${scope} turns`, async ({}, testInfo) => {
    const runtime = createRuntime(testInfo)
    const blocker = seedLiveConfig(runtime)
    if (process.env.SCHOLARSEED_CI_OFFLINE === '1') test.skip(Boolean(blocker), blocker ?? '')
    if (blocker) {
      const realHome = process.env.SCHOLARSEED_REAL_HOME
      const profiles = realHome ? join(realHome, 'model_profiles.json') : ''
      const settings = realHome ? join(realHome, 'service', 'settings.json') : ''
      if (!profiles || !existsSync(profiles) || !existsSync(settings)) throw new Error(blocker)
      const model = JSON.parse(readFileSync(settings, 'utf8')).codex_model
      if (typeof model !== 'string' || !model.startsWith('personal-')) throw new Error(blocker)
      copyFileSync(profiles, join(runtime.home, 'model_profiles.json'))
      mkdirSync(join(runtime.home, 'service'), { recursive: true })
      writeFileSync(join(runtime.home, 'service', 'settings.json'), JSON.stringify({ codex_model: model }))
    }
    const desktop = new DesktopSession(runtime, testInfo)
    const prompts = {
      explain: '用中文解释，术语 lattice 使用“晶格”。',
      translate: '译为中文时，将 lattice 译为“晶格”，保留专业语义。',
      polish: "Use formal academic English; replace 'very good' with 'effective'.",
      figure: '先说明坐标轴和图例，再解释关键趋势。'
    }
    const sourceText = 'A lattice method is very good for analyzing complex systems.'
    const source = 'resources/prompts.md'
    const name = '个人划词提示词验收'
    const failures: string[] = []
    try {
      const page = await desktop.launch()
      await openAccountSettings(page)
      await page.getByTestId('account-settings-nav-prompts').click()
      for (const [action, value] of Object.entries(prompts)) await page.getByTestId(`selection-prompt-${action}`).fill(value)
      await page.getByTestId('selection-prompts-save').click()
      await expect.poll(() => JSON.parse(readFileSync(join(runtime.userData, 'renderer-preferences.json'), 'utf8')).selectionPrompts).toEqual(prompts)
      await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
      const project = await createReadyProject(page, name)
      writeFileSync(join(project.root, source), `${sourceText}\n`)
      await page.reload()
      await enterWorkbenchShell(page)
      await openProjectMenu(page)
      await page.getByTestId(`project-menu-option-${name}`).click()
      await openProjectExplorer(page)
      await page.getByTestId('explorer-refresh').click()
      await page.getByTestId(`explorer-select-${source}`).click()
      await selectMarkdownMode(page, 'edit')
      const paragraph = page.getByTestId('markdown-visual-editor').getByText(sourceText, { exact: true })
      if (scope === 'resource') {
        for (const [action, label] of [['explain', 'AI 解释'], ['translate', 'AI 翻译'], ['polish', 'AI 润色']] as const) {
          await page.reload()
          await enterWorkbenchShell(page)
          await openProjectMenu(page)
          await page.getByTestId(`project-menu-option-${name}`).click()
          await openProjectExplorer(page)
          await page.getByTestId(`explorer-select-${source}`).click()
          await selectMarkdownMode(page, 'edit')
          await expect(paragraph).toBeVisible()
          await paragraph.click()
          await page.keyboard.press('ControlOrMeta+A')
          await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().trim())).toBe(sourceText)
          const responsePromise = page.waitForResponse(response => response.url().endsWith(`/api/resource/ai/${action}`), { timeout: TURN_COMPLETE_TIMEOUT_MS })
          await page.getByTestId('selection-action-host').getByRole('button', { name: label, exact: true }).click()
          const suggestion = page.getByTestId('resource-ai-suggestion')
          if (action !== 'translate') {
            if (action === 'explain') await suggestion.getByRole('textbox').fill('只写一句话')
            await suggestion.getByRole('button', { name: `提交${label}`, exact: true }).click()
          }
          const response = await responsePromise
          expect(response.status()).toBe(200)
          const body = response.request().postDataJSON()
          expect(body.instruction).toBe(prompts[action] + (action === 'explain' ? '\n\n只写一句话' : ''))
          if (action === 'translate') expect(body.target_language).toBe('zh')
          await expect.poll(async () => await suggestion.getByRole('alert').count() > 0
            || (await suggestion.innerText()).includes(action === 'polish' ? 'effective' : '晶格'), { timeout: TURN_COMPLETE_TIMEOUT_MS }).toBe(true)
          await expect(suggestion.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0, { timeout: TURN_COMPLETE_TIMEOUT_MS })
          if (await suggestion.getByRole('alert').count()) failures.push(`${action}: ${await suggestion.getByRole('alert').innerText()}`)
          else if (action === 'polish') await expect(suggestion.getByRole('button', { name: '替换原文', exact: true })).toBeEnabled()
          if (action === 'translate' && !await suggestion.getByRole('alert').count()) {
            const translation = await suggestion.locator('.whitespace-pre-wrap').last().innerText()
            await suggestion.getByRole('button', { name: '复制', exact: true }).click()
            await expect.poll(() => desktop.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(translation)
            await expect(suggestion.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
          }
          await testInfo.attach(`personal-prompt-${action}-evidence`, {
            body: JSON.stringify({ request: body, rendered: await suggestion.innerText() }, null, 2), contentType: 'application/json'
          })
          await page.screenshot({ path: join(runtime.artifacts, `personal-prompt-${action}.png`) })
          await suggestion.getByRole('button', { name: '关闭', exact: true }).click()
          await expect(suggestion).toHaveCount(0)
      }
      }
      if (scope === 'literature') {
        const pdf = await PDFDocument.create()
        pdf.setTitle('Personal prompt paper')
        pdf.setAuthor('Selection acceptance')
        const font = await pdf.embedFont(StandardFonts.Helvetica)
        pdf.addPage([612, 792]).drawText(sourceText, { x: 50, y: 650, size: 12, font })
        const pdfPath = join(project.root, 'resources/personal-prompt-paper.pdf')
        writeFileSync(pdfPath, await pdf.save())
        const base = await apiBase(page)
        const imported = await page.request.post(`${base}/api/v1/imports/pdf`, {
          multipart: { file: { name: 'personal-prompt-paper.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) } }
        })
        expect(imported.ok(), await imported.text()).toBe(true)
        await page.reload()
        await enterWorkbenchShell(page)
        await page.getByTestId('activity-literature').click()
        const paper = page.locator('.lit-row').filter({ hasText: 'Personal prompt paper' }).first()
        await expect(paper).toBeVisible()
        await paper.click()
        await page.getByRole('button', { name: '打开', exact: true }).click()
        const pdfText = page.getByTestId('pdf-page-1').locator('.textLayer span').filter({ hasText: sourceText }).first()
        await expect(pdfText).toBeVisible()
        const selectionBounds = await pdfText.boundingBox()
        if (!selectionBounds) throw new Error('PDF selection text unavailable')
        await page.mouse.move(selectionBounds.x + 1, selectionBounds.y + selectionBounds.height / 2)
        await page.mouse.down()
        await page.mouse.move(selectionBounds.x + selectionBounds.width - 1, selectionBounds.y + selectionBounds.height / 2, { steps: 20 })
        await page.mouse.up()
        await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().trim())).toBe(sourceText)
        await page.getByRole('button', { name: '添加高亮', exact: true }).first().click()
        await expect(page.locator('[data-testid^="pdf-mark-"]').first()).toBeVisible()
        for (const [action, kind, label] of [['explain', 'selection_explanation', '解释'], ['translate', 'selection_translation', '翻译']] as const) {
          await page.reload()
          await enterWorkbenchShell(page)
          await page.getByTestId('activity-literature').click()
          await paper.click()
          await page.getByRole('button', { name: '打开', exact: true }).click()
          const savedMark = page.locator('[data-testid^="pdf-mark-"]').first()
          await expect(savedMark).toBeVisible()
          await savedMark.focus()
          await page.keyboard.press('Enter')
          const inspector = page.locator('[data-testid^="pdf-annotation-inspector-"]')
          await expect(inspector).toBeVisible()
          await page.evaluate(() => window.getSelection()?.removeAllRanges())
          const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/literature/ai/tasks') && response.request().method() === 'POST')
          await inspector.getByRole('button', { name: label, exact: true }).click()
          const response = await responsePromise
          expect(response.status()).toBe(202)
          const request = response.request().postDataJSON()
          expect(request.kind).toBe(kind)
          expect(request.instruction).toBe(prompts[action])
          expect(request.text).toBe(sourceText)
          expect(request.quads.length).toBeGreaterThan(0)
          const initial = await response.json()
          const floating = page.getByRole('dialog', { name: action === 'explain' ? 'AI 解释' : '翻译', exact: true })
          await expect(floating).toBeVisible()
          await expect.poll(async () => (await floating.getByRole('status').allTextContents()).includes('已完成')
            || await floating.getByRole('alert').count() > 0, { timeout: TURN_COMPLETE_TIMEOUT_MS }).toBe(true)
          if (await floating.getByRole('alert').count()) failures.push(`${kind}: ${await floating.getByRole('alert').innerText()}`)
          else await expect(floating).toContainText('晶格')
          await testInfo.attach(`personal-pdf-prompt-${action}-evidence`, {
            body: JSON.stringify({ request, initial, rendered: await floating.innerText() }, null, 2), contentType: 'application/json'
          })
          await page.screenshot({ path: join(runtime.artifacts, `personal-pdf-annotation-prompt-${action}.png`) })
          await floating.getByRole('button', { name: action === 'explain' ? '关闭AI 解释' : '关闭翻译', exact: true }).click()
          await expect(floating).toHaveCount(0)
      }
      }
      expect(failures, 'Real model action failures').toEqual([])
      desktop.assertNoPageErrors()
    } finally { await desktop.attachArtifacts() }
  })
}
