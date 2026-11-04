import { openAccountSettings } from './fixtures/menu'
import { selectMarkdownMode } from './fixtures/markdown'
import { createReadyProject, openProjectMenu, openProjectExplorer, openProjectFile } from './fixtures/projects'
import { ONBOARDING_GROUPS } from '../src/onboarding'
import { defaultSelectionPrompts } from '../src/prompts'
import { WORKSPACE_WINDOW_MINIMUM, WORKSPACE_WINDOW_SIZE } from '../src/window'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { expect, test, type TestInfo } from '@playwright/test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { apiBase, DesktopSession, enterWorkbenchShell } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const PROJECT_NAME = '划词验收'
const SOURCE_PATH = 'resources/selection.md'
const PDF_SOURCE_PATH = 'resources/selection.pdf'
const SOURCE_NAME = 'selection.md'
const SOURCE_TEXT = 'Verified selection evidence.'
const FORMATTED_SOURCE_TEXT = '**Verified** selection evidence.'
const SECOND_SOURCE_TEXT = 'Fresh selection evidence.'

function selectionRuntime(testInfo: TestInfo) {
  const runtime = createRuntime(testInfo)
  const preferencesPath = join(runtime.userData, 'renderer-preferences.json')
  const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'))
  writeFileSync(
    preferencesPath,
    JSON.stringify({
      ...preferences,
      onboarding: { seen: Object.fromEntries(ONBOARDING_GROUPS.map((group) => [group, true])) },
    })
  )
  return runtime
}

test('short Markdown selection keeps its first block and scroll state stable', async ({}, testInfo) => {
  const runtime = selectionRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    const project = await createReadyProject(page, PROJECT_NAME)
    writeFileSync(
      join(project.root, SOURCE_PATH),
      `# Evidence\n\n${FORMATTED_SOURCE_TEXT}\n\n## Details\n\n| Name | Value |\n| --- | --- |\n| Example | Verified |\n`
    )
    await page.reload()
    await enterWorkbenchShell(page)
    await openProjectMenu(page)
    await page.getByTestId(`project-menu-option-${PROJECT_NAME}`).click()
    await openProjectExplorer(page)
    await page.getByTestId('explorer-refresh').click()
    await openProjectFile(page, SOURCE_PATH)
    await selectMarkdownMode(page, 'edit')
    const editor = page.locator('[data-testid="markdown-visual-editor"]:visible')
    const paragraph = editor.getByText(SOURCE_TEXT, { exact: true })
    const heading = editor.locator('.ProseMirror > h1').first()
    const scroller = editor.locator(':scope > .milkdown')
    await expect(paragraph).toBeVisible()
    const assertFirstBlockSpacing = async (): Promise<void> => {
      await expect
        .poll(() => heading.evaluate((element) => getComputedStyle(element).marginTop))
        .toBe('0px')
    }
    await paragraph.click()
    await expect(editor.locator('.ProseMirror > .prosemirror-virtual-cursor')).toHaveCount(1)
    await assertFirstBlockSpacing()
    const beforeSelection = {
      headingTop: (await heading.boundingBox())?.y,
      scroll: await scroller.evaluate((element) => ({
        height: element.scrollHeight,
        top: element.scrollTop,
      })),
    }
    expect(beforeSelection.headingTop).toBeDefined()
    const selectionToolbar = page.getByTestId('selection-action-host')
    const textPoint = await paragraph.evaluate((element) => {
      const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!
      const range = document.createRange()
      range.setStart(text, 1)
      range.setEnd(text, 2)
      const bounds = range.getBoundingClientRect()
      return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
    })
    await page.mouse.dblclick(textPoint.x, textPoint.y)
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().trim())).not.toBe('')
    await expect(selectionToolbar).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-double-click-selection.png') })
    await page.mouse.click(textPoint.x, textPoint.y, { clickCount: 3 })
    await expect(selectionToolbar).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().trim())).toBe(SOURCE_TEXT)
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-paragraph-selection.png') })
    await expect
      .poll(async () => (await heading.boundingBox())?.y)
      .toBeCloseTo(beforeSelection.headingTop!, 0)
    await expect
      .poll(async () =>
        scroller.evaluate((element) => ({
          height: element.scrollHeight,
          top: element.scrollTop,
        }))
      )
      .toEqual(beforeSelection.scroll)
    const tableCell = editor.getByText('Example', { exact: true })
    for (const target of [heading, paragraph, tableCell, paragraph]) {
      await target.click()
      await assertFirstBlockSpacing()
      await expect
        .poll(async () => (await heading.boundingBox())?.y)
        .toBeCloseTo(beforeSelection.headingTop!, 0)
      await expect
        .poll(() =>
          scroller.evaluate((element) => ({
            height: element.scrollHeight,
            top: element.scrollTop,
          }))
        )
        .toEqual(beforeSelection.scroll)
    }
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Shift+ArrowLeft')
    await expect(selectionToolbar).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().trim())).not.toBe('')
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-keyboard-selection.png') })
    await assertFirstBlockSpacing()
    await page.keyboard.press('ArrowRight')
    await assertFirstBlockSpacing()
    await page.screenshot({ path: join(runtime.artifacts, 'short-markdown-selection-stable.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('real Markdown selection opens the shared menu and adds a pending source quote', async ({}, testInfo) => {
  skipQuarantined(testInfo)
  const runtime = selectionRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const project = await createReadyProject(page, PROJECT_NAME)
    writeFileSync(join(project.root, SOURCE_PATH), `# Evidence\n\n${SOURCE_TEXT}\n`)
    await page.reload()
    await enterWorkbenchShell(page)
    await openProjectMenu(page)
    await page.getByTestId(`project-menu-option-${PROJECT_NAME}`).click()
    // 选择项目已进入资料视图；刷新读取 reload 之前写进磁盘的文件。
    await openProjectExplorer(page)
    await page.getByTestId('explorer-refresh').click()
    await openProjectFile(page, SOURCE_PATH)
    await selectMarkdownMode(page, 'edit')
    const paragraph = page
      .locator('[data-testid="markdown-visual-editor"]:visible')
      .getByText(SOURCE_TEXT, { exact: true })
    await expect(paragraph).toBeVisible()
    const selectSourceText = async (): Promise<void> => {
      const points = await paragraph.evaluate((element) => {
        const text = element.firstChild
        if (!text || text.nodeType !== Node.TEXT_NODE || !text.textContent) throw new Error('source text node missing')
        const first = document.createRange()
        first.setStart(text, 0)
        first.setEnd(text, 1)
        const last = document.createRange()
        last.setStart(text, text.textContent.length - 1)
        last.setEnd(text, text.textContent.length)
        const start = first.getBoundingClientRect()
        const end = last.getBoundingClientRect()
        return { start: { x: start.left, y: start.top + start.height / 2 },
          end: { x: end.right, y: end.top + end.height / 2 } }
      })
      await page.mouse.move(points.start.x, points.start.y)
      await page.mouse.down()
      await page.mouse.move(points.end.x, points.end.y, { steps: 8 })
      await page.mouse.up()
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(SOURCE_TEXT)
    }
    // Actual pointer and keyboard input; the application must derive the Range and source locator.
    await selectSourceText()
    const menu = page.getByTestId('selection-action-host')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('button', { name: 'AI 解释', exact: true })).toBeVisible()
    await expect(menu.getByRole('button', { name: 'AI 翻译', exact: true })).toBeVisible()
    await expect(menu.getByRole('button', { name: 'AI 润色', exact: true })).toBeVisible()
    for (const label of ['粗体', '斜体', '删除线', '行内代码', '行内公式', '链接']) {
      await expect(menu.getByRole('button', { name: label, exact: true })).toBeVisible()
    }
    const menuBackground = await menu.evaluate(
      (element) => window.getComputedStyle(element).backgroundColor
    )
    expect(menuBackground).toMatch(/^rgb\(/)
    expect(menuBackground).not.toBe('rgba(0, 0, 0, 0)')
    await page.getByTestId('activity-account').click()
    await expect(menu).toHaveCount(0)
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('')
    await page.getByTestId('account-menu-settings').click()
    const settingsDialog = page.getByRole('dialog', { name: '设置' })
    await expect(settingsDialog).toBeVisible()
    const settingsLayer = await settingsDialog.evaluate((element) => ({
      actual: Number.parseInt(getComputedStyle(element).zIndex, 10),
      modal: Number.parseInt(
        getComputedStyle(document.documentElement).getPropertyValue('--vds-z-modal'),
        10
      ),
    }))
    expect(settingsLayer.actual).toBe(settingsLayer.modal)
    await page.screenshot({ path: join(runtime.artifacts, 'selection-dismissed-settings-top.png') })
    await settingsDialog.getByRole('button', { name: '关闭' }).click()
    await selectSourceText()
    await expect(menu).toBeVisible()
    await menu.getByRole('button', { name: '粗体', exact: true }).click()
    await expect(page.locator('[data-testid="markdown-visual-editor"]:visible').locator('strong')).toContainText(
      SOURCE_TEXT
    )
    await selectSourceText()
    await expect(menu).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'selection-menu.png') })
    // Real model calls belong to explicitly enabled live acceptance, not smoke.
    await menu.getByRole('button', { name: '添加到任务', exact: true }).click()
    await expect(page.getByTestId('assistant-selection-quote')).toHaveCount(0)
    const pendingReference = page
      .getByTestId('ai-context-ref')
      .filter({ hasText: 'selection.md · 选区' })
    await pendingReference.hover()
    await expect(page.getByTestId('assistant-selection-quote')).toContainText(SOURCE_TEXT)
    await expect(page.getByTestId('assistant-selection-quote')).toContainText(SOURCE_NAME)
    await page.screenshot({ path: join(runtime.artifacts, 'selection-pending-quote.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('selection suggestions resize and move without losing the draft in a minimum dark window', async ({}, testInfo) => {
  const runtime = selectionRuntime(testInfo)
  const preferencesPath = join(runtime.userData, 'renderer-preferences.json')
  writeFileSync(preferencesPath, JSON.stringify({ ...JSON.parse(readFileSync(preferencesPath, 'utf8')), theme: 'dark' }))
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true, nativeWindowLifecycle: true })
  try {
    const page = await desktop.launch()
    const project = await createReadyProject(page, `${PROJECT_NAME}窗口缩放`)
    writeFileSync(join(project.root, SOURCE_PATH), `# Evidence\n\n${SOURCE_TEXT}\n`)
    await page.reload()
    await enterWorkbenchShell(page)
    await openProjectMenu(page)
    await page.getByTestId(`project-menu-option-${PROJECT_NAME}窗口缩放`).click()
    await openProjectExplorer(page)
    await page.getByTestId('explorer-refresh').click()
    await openProjectFile(page, SOURCE_PATH)
    await selectMarkdownMode(page, 'edit')
    const paragraph = page.locator('[data-testid="markdown-visual-editor"]:visible').getByText(SOURCE_TEXT, { exact: true })
    for (const label of ['AI 解释', 'AI 润色']) {
      await paragraph.click()
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home')
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+ArrowRight' : 'Shift+End')
      await page.getByTestId('selection-action-host').getByRole('button', { name: label, exact: true }).click()
      const suggestion = page.getByTestId('resource-ai-suggestion')
      const instruction = suggestion.getByRole('textbox', { name: '补充说明（选填）', exact: true })
      await instruction.fill('保留这段补充说明')
      const before = await suggestion.boundingBox()
      const handle = suggestion.getByTestId('resource-suggestion-resize')
      const grip = await handle.boundingBox()
      if (!before || !grip) throw new Error('Selection suggestion layout unavailable')
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
      await page.mouse.down()
      await page.mouse.move(grip.x - 100, grip.y + 60, { steps: 12 })
      await page.mouse.up()
      const resized = await suggestion.boundingBox()
      if (!resized) throw new Error('Resized selection suggestion unavailable')
      expect(resized.width).toBeLessThan(before.width)
      expect(resized.height).toBeGreaterThan(before.height)
      await handle.press('ArrowRight')
      await expect.poll(async () => (await suggestion.boundingBox())?.width).toBeGreaterThan(resized.width)
      const title = suggestion.locator('strong')
      await title.focus()
      await title.press('ArrowLeft')
      await title.press('ArrowDown')
      const nativeWindow = await desktop.browserWindow(page)
      await nativeWindow.evaluate((window, bounds) => window.setSize(bounds.width, bounds.height), WORKSPACE_WINDOW_MINIMUM)
      await expect.poll(async () => {
        const bounds = await suggestion.boundingBox()
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
        return Boolean(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height)
      }).toBe(true)
      await expect(instruction).toHaveValue('保留这段补充说明')
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await expect(suggestion.getByRole('button', { name: 'AI 提示词设置', exact: true })).toBeVisible()
      await page.screenshot({ path: join(runtime.artifacts, `${label}-resize-dark-minimum.png`) })
      await suggestion.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(suggestion).toHaveCount(0)
      await nativeWindow.evaluate((window, bounds) => window.setSize(bounds.width, bounds.height), WORKSPACE_WINDOW_SIZE)
    }
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('selection AI actions show optional input and prompt settings guidance', async ({}, testInfo) => {
  const runtime = selectionRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    const project = await createReadyProject(page, `${PROJECT_NAME}提示词引导`)
    writeFileSync(join(project.root, SOURCE_PATH), `# Evidence\n\n${SOURCE_TEXT}\n`)
    await page.reload()
    await enterWorkbenchShell(page)
    await openProjectMenu(page)
    await page.getByTestId(`project-menu-option-${PROJECT_NAME}提示词引导`).click()
    await openProjectExplorer(page)
    await page.getByTestId('explorer-refresh').click()
    await openProjectFile(page, SOURCE_PATH)
    await selectMarkdownMode(page, 'edit')
    const paragraph = page
      .locator('[data-testid="markdown-visual-editor"]:visible')
      .getByText(SOURCE_TEXT, { exact: true })
    const selectSourceText = async (): Promise<void> => {
      await paragraph.click()
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home')
      await page.keyboard.press(
        process.platform === 'darwin' ? 'Meta+Shift+ArrowRight' : 'Shift+End'
      )
      expect(await page.evaluate(() => window.getSelection()?.toString())).toContain(SOURCE_TEXT)
    }

    for (const [action, label, screenshot] of [
      ['explain', 'AI 解释', 'selection-explain-optional.png'],
      ['polish', 'AI 润色', 'selection-polish-optional.png'],
    ] as const) {
      await selectSourceText()
      await page
        .getByTestId('selection-action-host')
        .getByRole('button', { name: label, exact: true })
        .click()
      const suggestion = page.getByTestId('resource-ai-suggestion')
      await expect(
        suggestion.getByRole('textbox', { name: '补充说明（选填）', exact: true })
      ).toHaveValue('')
      const settingsLink = suggestion.getByRole('button', { name: 'AI 提示词设置', exact: true })
      await expect(settingsLink).toBeVisible()
      await expect
        .poll(async () => (await suggestion.boundingBox())?.width ?? Number.POSITIVE_INFINITY)
        .toBeLessThan(1000)
      const suggestionBox = await suggestion.boundingBox()
      if (!suggestionBox) throw new Error('Selection suggestion layout unavailable')
      for (const toolbarLabel of [
        'AI 解释',
        'AI 润色',
        'AI 翻译',
        '添加到任务',
        '粗体',
        '斜体',
        '删除线',
        '链接',
        '行内代码',
        '行内公式',
        '关闭',
      ]) {
        const toolbarButton = suggestion.getByRole('button', { name: toolbarLabel, exact: true })
        await expect(toolbarButton).toBeVisible()
        const toolbarButtonBox = await toolbarButton.boundingBox()
        if (!toolbarButtonBox)
          throw new Error(`Selection toolbar action unavailable: ${toolbarLabel}`)
        expect(toolbarButtonBox.x + toolbarButtonBox.width).toBeLessThanOrEqual(
          suggestionBox.x + suggestionBox.width
        )
      }
      await page.screenshot({ path: join(runtime.artifacts, screenshot) })
      if (action === 'explain') {
        await settingsLink.click()
        const settingsDialog = page.getByRole('dialog', { name: '设置', exact: true })
        await expect(settingsDialog).toBeVisible()
        await expect(page.getByTestId('selection-prompt-explain')).toBeVisible()
        await page.screenshot({
          path: join(runtime.artifacts, 'selection-prompt-settings-link.png'),
        })
        await settingsDialog.getByRole('button', { name: '关闭', exact: true }).click()
      }
      if (await suggestion.count())
        await suggestion.getByRole('button', { name: '关闭', exact: true }).click()
    }

    await selectSourceText()
    await page
      .getByTestId('selection-action-host')
      .getByRole('button', { name: 'AI 翻译', exact: true })
      .click()
    const translation = page.getByTestId('resource-ai-suggestion')
    const translationSettings = translation.getByRole('button', {
      name: 'AI 提示词设置',
      exact: true,
    })
    const translationCopy = translation.getByRole('button', { name: '复制', exact: true })
    const translationDirection = translation.getByRole('combobox', { name: '目标语言', exact: true })
    await expect(translationSettings).toBeVisible()
    await expect(translation).toContainText('术语与翻译偏好可在')
    await expect(translation).not.toContainText('中英互译 · 可手动切换方向')
    await expect(
      translation.getByRole('button', { name: /固定 AI 翻译|取消固定 AI 翻译/ })
    ).toHaveCount(0)
    const [translationBox, settingsBox, copyBox, directionBox] = await Promise.all([
      translation.boundingBox(),
      translationSettings.boundingBox(),
      translationCopy.boundingBox(),
      translationDirection.boundingBox(),
    ])
    if (!translationBox || !settingsBox || !copyBox || !directionBox) throw new Error('Translation layout unavailable')
    expect(Math.abs((settingsBox.y + settingsBox.height / 2) - (copyBox.y + copyBox.height / 2))).toBeLessThan(8)
    expect(directionBox.x + directionBox.width / 2).toBeGreaterThan(translationBox.x + translationBox.width / 2)
    await page.screenshot({ path: join(runtime.artifacts, 'selection-translation-prompt-guide.png') })
    await translation.getByRole('button', { name: '关闭', exact: true }).click()

    const pdf = await PDFDocument.create()
    pdf.setTitle('Optional prompt paper')
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const pdfPage = pdf.addPage([612, 792])
    pdfPage.drawText(SOURCE_TEXT, { x: 50, y: 650, size: 12, font })
    pdfPage.drawText(SECOND_SOURCE_TEXT, { x: 50, y: 620, size: 12, font })
    const pdfBytes = await pdf.save()
    const imported = await page.request.post(`${await apiBase(page)}/api/v1/imports/pdf?project_id=${encodeURIComponent(project.id)}`, {
      multipart: { file: { name: 'optional-prompt-paper.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdfBytes) } }
    })
    expect(imported.ok(), await imported.text()).toBe(true)
    await page.reload()
    await enterWorkbenchShell(page)
    await page.getByTestId('activity-literature').click()
    const paper = page.locator('.lit-row').filter({ hasText: 'Optional prompt paper' }).first()
    await expect(paper).toBeVisible()
    await paper.click()
    await page.getByRole('button', { name: '打开', exact: true }).click()
    const selectPdfSourceText = async (text: string): Promise<void> => {
      const pdfText = page
        .getByTestId('pdf-page-1')
        .locator('.textLayer span')
        .filter({ hasText: text })
        .first()
      await expect(pdfText).toBeVisible()
      const selectionBounds = await pdfText.boundingBox()
      if (!selectionBounds) throw new Error('PDF selection text unavailable')
      await page.mouse.move(selectionBounds.x + 1, selectionBounds.y + selectionBounds.height / 2)
      await page.mouse.down()
      await page.mouse.move(
        selectionBounds.x + selectionBounds.width - 1,
        selectionBounds.y + selectionBounds.height / 2,
        { steps: 20 }
      )
      await page.mouse.up()
    }
    await selectPdfSourceText(SOURCE_TEXT)
    const pdfSelectionToolbar = page.getByTestId('selection-action-host')
    await pdfSelectionToolbar.getByRole('button', { name: 'AI 解释', exact: true }).click()
    await expect(
      pdfSelectionToolbar.getByRole('textbox', { name: '补充说明（选填）', exact: true })
    ).toBeVisible()
    await page.locator('[data-testid="pdf-page-1"]:visible').click({ position: { x: 20, y: 20 } })
    await expect(pdfSelectionToolbar).toHaveCount(0)
    await selectPdfSourceText(SECOND_SOURCE_TEXT)
    await expect(pdfSelectionToolbar).toHaveAttribute('data-state', 'collapsed')
    await expect(
      pdfSelectionToolbar.getByRole('textbox', { name: '补充说明（选填）', exact: true })
    ).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-selection-explain-reset.png') })
    await page.getByRole('button', { name: '添加高亮', exact: true }).first().click()
    const savedMark = page.locator('[data-testid^="pdf-mark-"]').first()
    await expect(savedMark).toBeVisible()
    await savedMark.focus()
    await page.keyboard.press('Enter')
    const inspector = page.locator('[data-testid^="pdf-annotation-inspector-"]')
    await expect(inspector).toBeVisible()
    await inspector.getByRole('button', { name: '解释', exact: true }).click()
    await expect(
      inspector.getByRole('textbox', { name: '补充说明（选填）', exact: true })
    ).toHaveValue('')
    await expect(
      inspector.getByRole('button', { name: 'AI 提示词设置', exact: true })
    ).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-annotation-explain-optional.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('project PDF selection AI closes without restoring the legacy input', async ({}, testInfo) => {
  const runtime = selectionRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    const project = await createReadyProject(page, `${PROJECT_NAME}PDF浮窗关闭`)
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const pdfPage = pdf.addPage([612, 792])
    pdfPage.drawText(SOURCE_TEXT, { x: 50, y: 650, size: 12, font })
    writeFileSync(join(project.root, PDF_SOURCE_PATH), await pdf.save())
    await page.reload()
    await enterWorkbenchShell(page)
    await openProjectMenu(page)
    await page.getByTestId(`project-menu-option-${PROJECT_NAME}PDF浮窗关闭`).click()
    await openProjectExplorer(page)
    await page.getByTestId('explorer-refresh').click()
    await openProjectFile(page, PDF_SOURCE_PATH)
    const pdfText = page
      .getByTestId('pdf-page-1')
      .locator('.textLayer span')
      .filter({ hasText: SOURCE_TEXT })
      .first()
    await expect(pdfText).toBeVisible()
    const selectionBounds = await pdfText.boundingBox()
    if (!selectionBounds) throw new Error('PDF selection text unavailable')
    await page.mouse.move(selectionBounds.x + 1, selectionBounds.y + selectionBounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(
      selectionBounds.x + selectionBounds.width - 1,
      selectionBounds.y + selectionBounds.height / 2,
      { steps: 20 }
    )
    await page.mouse.up()
    await page
      .getByTestId('selection-action-host')
      .getByRole('button', { name: 'AI 解释', exact: true })
      .click()
    const suggestion = page.getByTestId('resource-ai-suggestion')
    await expect(
      suggestion.getByRole('textbox', { name: '补充说明（选填）', exact: true })
    ).toBeFocused()
    await page.locator('[data-testid="pdf-page-1"]:visible').click({ position: { x: 20, y: 20 } })
    await expect(suggestion).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-selection-ai-dismissed.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('Markdown selection across blocks, inline code and code blocks opens the menu with an exact source quote', async ({}, testInfo) => {
  const runtime = selectionRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  const markdown = [
    '# Evidence',
    '',
    'Heat **lowers efficiency** after `run()` finishes.',
    '',
    'Second paragraph text.',
    '',
    '```python',
    'print("alpha")',
    'return beta',
    '```',
    '',
  ].join('\n')
  try {
    const page = await desktop.launch()
    const project = await createReadyProject(page, PROJECT_NAME)
    writeFileSync(join(project.root, SOURCE_PATH), markdown)
    await page.reload()
    await enterWorkbenchShell(page)
    await openProjectMenu(page)
    await page.getByTestId(`project-menu-option-${PROJECT_NAME}`).click()
    await openProjectExplorer(page)
    await page.getByTestId('explorer-refresh').click()
    await openProjectFile(page, SOURCE_PATH)
    await selectMarkdownMode(page, 'edit')
    const editor = page.locator('[data-testid="markdown-visual-editor"]:visible')
    await expect(editor.getByText('Second paragraph text.', { exact: true })).toBeVisible()
    await expect(editor.locator('.cm-content')).toBeVisible()
    const menu = page.getByTestId('selection-action-host')
    // Drag with the real pointer from the first character of one text to the last character of another.
    const drag = async (
      startText: string,
      endText: string,
      onMove?: () => Promise<void>
    ): Promise<void> => {
      await editor.locator('.ProseMirror p').first().click()
      await page.keyboard.press('ArrowRight')
      await expect(menu).toHaveCount(0)
      const points = await editor.evaluate(
        (root, needles) => {
          const point = (needle: string, edge: 'start' | 'end') => {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
              acceptNode: (node) =>
                node.parentElement?.closest('.milkdown-code-block-placeholder')
                  ? NodeFilter.FILTER_REJECT
                  : NodeFilter.FILTER_ACCEPT,
            })
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              const index = node.nodeValue?.indexOf(needle) ?? -1
              if (index < 0) continue
              const range = document.createRange()
              const offset = edge === 'start' ? index : index + needle.length - 1
              range.setStart(node, offset)
              range.setEnd(node, offset + 1)
              const rect = range.getBoundingClientRect()
              return {
                x: edge === 'start' ? rect.left + 1 : rect.right - 1,
                y: rect.top + rect.height / 2,
              }
            }
            throw new Error(`missing_text_${needle}`)
          }
          return { start: point(needles.startText, 'start'), end: point(needles.endText, 'end') }
        },
        { startText, endText }
      )
      await page.mouse.move(points.start.x, points.start.y)
      await page.mouse.down()
      await page.mouse.move(points.end.x, points.end.y, { steps: 12 })
      await onMove?.()
      await page.mouse.up()
    }
    const scenarios = [
      {
        name: 'into-code-block',
        start: 'paragraph',
        end: 'print',
        quote: 'paragraph text.\n\n```python\nprint\n```',
      },
      { name: 'bold-partial', start: 'lowers', end: 'efficiency', quote: '**lowers efficiency**' },
      { name: 'heading', start: 'Evidence', end: 'Heat', quote: '# Evidence\n\nHeat' },
      { name: 'paragraphs', start: 'finishes', end: 'Second', quote: 'finishes.\n\nSecond' },
      { name: 'inline-code-partial', start: 'run', end: 'run', quote: '`run`' },
      {
        name: 'code-block',
        start: 'print',
        end: 'beta',
        quote: '```python\nprint("alpha")\nreturn beta\n```',
      },
    ]
    const expectPrintHighlight = async (label: string): Promise<void> => {
      await expect(editor.locator('.cm-selectionBackground'), label).not.toHaveCount(0)
      expect(
        await editor.evaluate((root) => {
          const point = (needle: string) => {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              const index = node.nodeValue?.indexOf(needle) ?? -1
              if (index < 0) continue
              const range = document.createRange()
              range.setStart(node, index)
              range.setEnd(node, index + needle.length)
              const rect = range.getBoundingClientRect()
              return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
            }
            throw new Error(`missing_text_${needle}`)
          }
          const backgrounds = Array.from(
            root.querySelectorAll('.cm-selectionBackground'),
            (element) => element.getBoundingClientRect()
          )
          const covered = ({ x, y }: { x: number; y: number }) =>
            backgrounds.some(
              (rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
            )
          return { alpha: covered(point('alpha')), print: covered(point('print')) }
        })
      ).toEqual({ alpha: false, print: true })
    }
    const pendingReferences = page
      .getByTestId('ai-context-ref')
      .filter({ hasText: 'selection.md · 选区' })
    for (const [index, scenario] of scenarios.entries()) {
      await drag(
        scenario.start,
        scenario.end,
        scenario.name === 'into-code-block'
          ? async () => {
              await expectPrintHighlight('code selection during drag')
              await page.screenshot({
                path: join(runtime.artifacts, 'selection-markdown-during-drag.png'),
              })
            }
          : undefined
      )
      await expect(menu, scenario.name).toBeVisible()
      await expect(menu.getByRole('button', { name: 'AI 解释', exact: true })).toBeVisible()
      if (scenario.name === 'into-code-block') {
        await expectPrintHighlight('code selection after drag')
      }
      await menu.getByRole('button', { name: '添加到任务', exact: true }).click()
      if (scenario.name === 'into-code-block') {
        await expectPrintHighlight('code selection after adding context')
      }
      await expect(pendingReferences).toHaveCount(index + 1)
      await pendingReferences.nth(index).hover()
      await expect(page.getByTestId('assistant-selection-quote'), scenario.name).toContainText(
        scenario.quote
      )
      await page.screenshot({
        path: join(runtime.artifacts, `selection-markdown-${scenario.name}.png`),
      })
      await page.mouse.move(1, 1)
      await expect(page.getByTestId('assistant-selection-quote')).toHaveCount(0)
    }
    await page.screenshot({
      path: join(runtime.artifacts, 'selection-markdown-cross-block-quote.png'),
    })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('selection prompts save through personal settings, survive restart, and restore independently', async ({}, testInfo) => {
  const runtime = selectionRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  const prompts = { explain: '结合上下文解释\n说明推断', translate: '使用领域术语',
    polish: '更学术，保留引用', figure: '区分图表证据和推断' }
  try {
    let page = await desktop.launch()
    const settings = async () => {
      if (!await page.getByTestId('account-settings-nav-prompts').isVisible()) {
        await openAccountSettings(page)
      }
      await page.getByTestId('account-settings-nav-prompts').click()
    }
    await settings()
    for (const [action, value] of Object.entries(prompts))
      await page.getByTestId(`selection-prompt-${action}`).fill(value)
    await page.getByTestId('selection-prompts-save').click()
    await expect
      .poll(
        () =>
          JSON.parse(readFileSync(join(runtime.userData, 'renderer-preferences.json'), 'utf8'))
            .selectionPrompts
      )
      .toEqual(prompts)
    await expect(page.getByTestId('selection-prompts-save')).toBeDisabled()
    await page.getByRole('heading', { name: 'AI 提示词', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(runtime.artifacts, 'selection-prompts-saved.png') })
    await desktop.close()
    page = await desktop.launch()
    await settings()
    for (const [action, value] of Object.entries(prompts))
      await expect(page.getByTestId(`selection-prompt-${action}`)).toHaveValue(value)
    await page.getByTestId('selection-prompt-restore-translate').click()
    await expect(page.getByTestId('selection-prompt-translate')).toHaveValue(
      defaultSelectionPrompts('zh').translate
    )
    await expect(page.getByTestId('selection-prompt-explain')).toHaveValue(prompts.explain)
    await expect(page.getByTestId('selection-prompt-polish')).toHaveValue(prompts.polish)
    await expect(page.getByTestId('selection-prompt-figure')).toHaveValue(prompts.figure)
    await page.getByTestId('selection-prompts-save').click()
    await expect
      .poll(
        () =>
          JSON.parse(readFileSync(join(runtime.userData, 'renderer-preferences.json'), 'utf8'))
            .selectionPrompts
      )
      .toEqual({ ...prompts, translate: defaultSelectionPrompts('zh').translate })
    await page.getByRole('heading', { name: 'AI 提示词', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(runtime.artifacts, 'selection-prompts-restored.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('Markdown selection link reuses the top bar icon and saves through the native link editor', async ({}, testInfo) => {
  const runtime = selectionRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const project = await createReadyProject(page, PROJECT_NAME)
    writeFileSync(join(project.root, SOURCE_PATH), `# Evidence\n\n${SOURCE_TEXT}\n`)
    await page.reload()
    await enterWorkbenchShell(page)
    await openProjectMenu(page)
    await page.getByTestId(`project-menu-option-${PROJECT_NAME}`).click()
    // 选择项目已进入资料视图；刷新读取 reload 之前写进磁盘的文件。
    await openProjectExplorer(page)
    await page.getByTestId('explorer-refresh').click()
    await openProjectFile(page, SOURCE_PATH)
    await selectMarkdownMode(page, 'edit')
    const paragraph = page
      .locator('[data-testid="markdown-visual-editor"]:visible')
      .locator('.ProseMirror p')
      .filter({ hasText: SOURCE_TEXT })
    await expect(paragraph).toBeVisible()
    // Actual pointer input; the application must derive the Range and source locator.
    await paragraph.click({ clickCount: 3 })
    const menu = page.getByTestId('selection-action-host')
    await expect(menu).toBeVisible()
    const topbar = page.locator('[data-testid="markdown-visual-editor"]:visible').locator('.milkdown-top-bar')
    for (const label of ['粗体', '斜体', '删除线', '链接', '行内代码', '行内公式']) {
      const quick = menu.getByRole('button', { name: label, exact: true })
      const top = topbar.locator('button').filter({ has: page.getByLabel(label, { exact: true }) })
      await expect(quick).toBeVisible()
      expect(await quick.locator('svg').innerHTML()).toBe(await top.locator('svg').innerHTML())
      const size = (element: HTMLElement) => {
        const style = getComputedStyle(element)
        return { width: parseFloat(style.width), height: parseFloat(style.height) }
      }
      const quickSize = await quick.evaluate(size)
      const topSize = await top.evaluate(size)
      expect(quickSize.width).toBeGreaterThanOrEqual(topSize.width)
      expect(quickSize.height).toBeGreaterThanOrEqual(topSize.height)
    }
    await menu.getByRole('button', { name: '行内公式', exact: true }).click()
    await expect(page.locator('[data-testid="markdown-visual-editor"]:visible').locator('[data-type="math_inline"]')).toBeVisible()
    // An atomic formula has a native node selection, rather than a text Range.
    // The same editor command reverses it through the persistent native toolbar.
    const nativeMath = page.locator('[data-testid="markdown-editor-actions"]:visible')
      .getByRole('button', { name: '行内公式', exact: true })
    await nativeMath.click()
    await expect(page.locator('[data-testid="markdown-visual-editor"]:visible').locator('[data-type="math_inline"]')).toHaveCount(0)
    await paragraph.click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+ArrowRight' : 'Shift+End')
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(SOURCE_TEXT)
    await expect(menu).toBeVisible()
    await menu.getByRole('button', { name: '删除线', exact: true }).click()
    await expect(page.locator('[data-testid="markdown-visual-editor"]:visible').locator('del')).toContainText(SOURCE_TEXT)
    await menu.getByRole('button', { name: '删除线', exact: true }).click()
    await expect(page.locator('[data-testid="markdown-visual-editor"]:visible').locator('del')).toHaveCount(0)
    const link = menu.getByRole('button', { name: '链接', exact: true })
    const nativeIcon = page
      .locator('[data-testid="markdown-visual-editor"]:visible')
      .locator('.milkdown-top-bar')
      .getByLabel('链接', { exact: true })
      .locator('svg')
    await expect(link.locator('svg')).toBeVisible()
    expect(await link.locator('svg').innerHTML()).toBe(await nativeIcon.innerHTML())
    await page.screenshot({ path: join(runtime.artifacts, 'selection-link-menu.png') })
    await link.click()
    const input = page.getByPlaceholder('粘贴链接').and(page.locator(':visible'))
    await expect(input).toBeVisible()
    await input.fill('https://example.com/')
    await input.press('Enter')
    await expect(
      page.locator('[data-testid="markdown-visual-editor"]:visible').locator('a').filter({ hasText: SOURCE_TEXT })
    ).toHaveAttribute('href', 'https://example.com/')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    await expect
      .poll(() => readFileSync(join(project.root, SOURCE_PATH), 'utf8'))
      .toContain(`[${SOURCE_TEXT}](https://example.com/)`)
    await page.screenshot({ path: join(runtime.artifacts, 'selection-link.png') })
    // Saving the link restores the original text selection for the next quick action.
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(SOURCE_TEXT)
    await menu.getByRole('button', { name: '行内公式', exact: true }).click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    await expect
      .poll(() => readFileSync(join(project.root, SOURCE_PATH), 'utf8'))
      .toContain(`$${SOURCE_TEXT}$`)
    await nativeMath.click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    await expect
      .poll(() => readFileSync(join(project.root, SOURCE_PATH), 'utf8'))
      .not.toContain(`$${SOURCE_TEXT}$`)
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
