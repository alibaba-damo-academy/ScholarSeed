import { expect, test, type Locator, type Page, type Response as PlaywrightResponse } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PDFDocument, StandardFonts } from 'pdf-lib'

import { apiBase, DesktopSession, enterWorkbenchShell, liveStatus, waitForFinishedTurn } from './fixtures/electron'
import { createRuntime, seedLiveConfig } from './fixtures/runtime'
import { sseData } from '../src/renderer/src/sse'
import type { AssistantSelectionActionResult } from '../src/renderer/src/contracts/assistant'
import { ONBOARDING_GROUPS } from '../src/onboarding'

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
  await page.getByRole('button', { name: '添加到对话', exact: true }).click()
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

interface CreatedProject {
  root: string
}

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
    await page.getByTestId('selection-action-host').getByRole('button', { name: '添加到对话', exact: true }).click()
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
    await page.getByTestId('selection-action-host').getByRole('button', { name: '添加到对话', exact: true }).click()
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
    await expect(page.getByRole('button', { name: '添加到对话' })).toBeVisible()
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
    const project = await page.evaluate(async ({ base, name }) => {
      const response = await fetch(`${base}/api/content/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      })
      if (!response.ok) throw new Error(`project_create_${response.status}`)
      return response.json() as Promise<CreatedProject>
    }, { base: await apiBase(page), name: TRANSLATION_PROJECT_NAME })
    writeFileSync(join(project.root, TRANSLATION_FILE_RELATIVE), `# Translation\n\n${TRANSLATION_SOURCE}\n`)

    await page.reload()
    await enterWorkbenchShell(page)
    await page.getByTestId('topbar-project').click()
    await page.getByTestId(`project-menu-option-${TRANSLATION_PROJECT_NAME}`).click()
    const beforeSessions = await sessionCount(page)
    await page.getByTestId(`tree-${TRANSLATION_FILE_RELATIVE}`).click()
    const editorMode = page.getByTestId('markdown-open-editor')
    if (await editorMode.count()) await editorMode.click()
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
    await menu.getByRole('button', { name: '添加到对话', exact: true }).click()
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
    const project = await page.evaluate(async ({ base, name }) => {
      const response = await fetch(`${base}/api/content/projects`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      })
      if (!response.ok) throw new Error(`project_create_${response.status}`)
      return response.json() as Promise<CreatedProject>
    }, { base: await apiBase(page), name: POLISH_PROJECT_NAME })
    const sourcePath = join(project.root, POLISH_FILE_RELATIVE)
    const sourceFile = `# Polish\n\n${POLISH_SOURCE}\n`
    writeFileSync(sourcePath, sourceFile)
    await page.reload()
    await enterWorkbenchShell(page)
    await page.getByTestId('topbar-project').click()
    await page.getByTestId(`project-menu-option-${POLISH_PROJECT_NAME}`).click()
    await page.getByTestId(`tree-${POLISH_FILE_RELATIVE}`).click()
    const editorMode = page.getByTestId('markdown-open-editor')
    if (await editorMode.count()) await editorMode.click()
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
    await page.getByTestId('markdown-save').click()
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
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const project = await page.evaluate(async ({ base, name }) => {
      const response = await fetch(`${base}/api/content/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      })
      if (!response.ok) throw new Error(`project_create_${response.status}`)
      return response.json() as Promise<CreatedProject>
    }, { base: await apiBase(page), name: CONTEXT_PROJECT_NAME })
    mkdirSync(join(project.root, CONTEXT_FOLDER_RELATIVE), { recursive: true })
    writeFileSync(join(project.root, CONTEXT_NESTED_FILE_RELATIVE), `${CONTEXT_FOLDER_NONCE}\n`)

    await page.reload()
    await enterWorkbenchShell(page)
    await page.getByTestId('topbar-project').click()
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
    const project = await page.evaluate(async ({ base, name }) => {
      const response = await fetch(`${base}/api/content/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      })
      if (!response.ok) throw new Error(`project_create_${response.status}`)
      return response.json() as Promise<CreatedProject>
    }, { base: await apiBase(page), name: CONTEXT_PROJECT_NAME })
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
    const literatureId = await page.evaluate(async ({ base, projectId, source }) => {
      const response = await fetch(`${base}/api/literature/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: projectId, source: 'local', sources: [source] })
      })
      if (!response.ok) throw new Error(`literature_import_${response.status}`)
      const payload = await response.json() as { item_ids?: string[] }
      const identifier = payload.item_ids?.[0]
      if (!identifier) throw new Error('literature_import_missing_id')
      return identifier
    }, { base: await apiBase(page), projectId: project.id, source: literaturePath })
    await page.reload()
    await enterWorkbenchShell(page)
    await page.getByTestId('topbar-project').click()
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
    await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText('超长…')
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
    const resourceTitleBounds = await resourceFolderOption.locator('span.font-medium').boundingBox()
    const resourceLineHeight = await resourceFolderOption.locator('span.font-medium').evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight))
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
    await page.getByTestId('composer-add-literature-context').click()
    await page.waitForTimeout(MENU_ANIMATION_SETTLE_MS)
    expect(pickerRequests.filter((url) => url.includes('/api/v1/literatures?'))).toHaveLength(1)
    const literatureOption = page.getByTestId(`ai-context-option-literature-${literatureId}`)
    await expect(literatureOption).toBeVisible()
    const literaturePickerHeight = await page.getByTestId('reference-picker').evaluate((element) => element.getBoundingClientRect().height)
    expect(await page.getByTestId('reference-picker-list').evaluate((element) => element.getBoundingClientRect().height)).toBe(REFERENCE_PICKER_LIST_HEIGHT)
    await page.getByTestId('reference-picker-search').fill('Long')
    await expect.poll(() => pickerRequests.filter((url) => url.includes('/api/v1/literatures?')).length).toBe(2)
    await expect(literatureOption).toBeVisible()
    await expect(literatureOption.locator('small')).toHaveCount(0)
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
    await page.getByTestId('reference-picker-search').fill('no-matching-literature')
    await expect(page.getByTestId('reference-picker-list').locator('.vds-empty-state')).toBeVisible()
    expect(await page.getByTestId('reference-picker').evaluate((element) => element.getBoundingClientRect().height)).toBe(literaturePickerHeight)
    await page.screenshot({ path: testInfo.outputPath('assistant-literature-reference-empty-height.png') })
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
    const project = await page.evaluate(async ({ base, name }) => {
      const response = await fetch(`${base}/api/content/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      })
      if (!response.ok) throw new Error(`project_create_${response.status}`)
      return response.json() as Promise<CreatedProject>
    }, { base: await apiBase(page), name: CONTEXT_PROJECT_NAME })
    writeFileSync(join(project.root, CONTEXT_FILE_RELATIVE), `${CONTEXT_NONCE}\n`)
    await page.reload()
    await enterWorkbenchShell(page)
    await page.getByTestId('topbar-project').click()
    await page.getByTestId(`project-menu-option-${CONTEXT_PROJECT_NAME}`).click()
    await page.getByTestId('activity-resource').click()
    const panel = page.getByTestId('ai-panel')
    if (!await panel.isVisible()) await page.getByTestId('topbar-ai').click()
    const treeFile = page.getByTestId(`tree-${CONTEXT_FILE_RELATIVE}`)
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

    const project = await page.evaluate(async ({ base, name }) => {
      const response = await fetch(`${base}/api/content/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      })
      if (!response.ok) throw new Error(`project_create_${response.status}`)
      return response.json() as Promise<CreatedProject>
    }, { base: await apiBase(page), name: CONTEXT_PROJECT_NAME })
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
    const literatureId = await page.evaluate(async ({ base, projectId, source }) => {
      const response = await fetch(`${base}/api/literature/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: projectId, source: 'local', sources: [source] })
      })
      if (!response.ok) throw new Error(`literature_import_${response.status}`)
      const payload = await response.json() as { item_ids?: string[] }
      const identifier = payload.item_ids?.[0]
      if (!identifier) throw new Error('literature_import_missing_id')
      return identifier
    }, { base: await apiBase(page), projectId: project.id, source: literaturePath })

    await page.reload()
    await enterWorkbenchShell(page)
    await page.getByTestId('topbar-project').click()
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

    await page.getByTestId(`tree-${CONTEXT_FOLDER_RELATIVE}`).click({ button: 'right' })
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
      await page.getByTestId('activity-account').click()
      await page.getByTestId('account-menu-settings').click()
      await page.getByTestId('account-settings-nav-prompts').click()
      for (const [action, value] of Object.entries(prompts)) await page.getByTestId(`selection-prompt-${action}`).fill(value)
      await page.getByTestId('selection-prompts-save').click()
      await expect.poll(() => JSON.parse(readFileSync(join(runtime.userData, 'renderer-preferences.json'), 'utf8')).selectionPrompts).toEqual(prompts)
      await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
      const project = await page.evaluate(async ({ base, name }) => {
        const response = await fetch(`${base}/api/content/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
        if (!response.ok) throw new Error(`project_create_${response.status}`)
        return response.json() as Promise<{ id: string; root: string }>
      }, { base: await apiBase(page), name })
      writeFileSync(join(project.root, source), `${sourceText}\n`)
      await page.reload()
      await enterWorkbenchShell(page)
      await page.getByTestId('topbar-project').click()
      await page.getByTestId(`project-menu-option-${name}`).click()
      await page.getByTestId('activity-resource').click()
      await page.getByTestId('resource-refresh').click()
      await page.getByTestId(`tree-${source}`).click()
      const editorMode = page.getByTestId('markdown-open-editor')
      if (await editorMode.count()) await editorMode.click()
      const paragraph = page.getByTestId('markdown-visual-editor').getByText(sourceText, { exact: true })
      if (scope === 'resource') {
        for (const [action, label] of [['explain', 'AI 解释'], ['translate', 'AI 翻译'], ['polish', 'AI 润色']] as const) {
          await page.reload()
          await enterWorkbenchShell(page)
          await page.getByTestId('topbar-project').click()
          await page.getByTestId(`project-menu-option-${name}`).click()
          await page.getByTestId('activity-resource').click()
          await page.getByTestId(`tree-${source}`).click()
          if (await editorMode.count()) await editorMode.click()
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
