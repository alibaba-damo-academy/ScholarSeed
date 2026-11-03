import { openMarkdownModes, selectMarkdownMode } from './fixtures/markdown'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type TestInfo } from '@playwright/test'

import { WORKSPACE_WINDOW_MINIMUM } from '../src/window'
import { apiBase, DesktopSession, enterWorkbenchShell } from './fixtures/electron'
import { createReadyProject } from './fixtures/projects'
import { withIsolatedRuntime, type RuntimePaths } from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const PROJECT_NAME = 'Markdown 三模式验收'
const DOCUMENT_PATH = 'resources/modes.md'
const ORIGINAL =
  '# Mode evidence\n\nOriginal paragraph.\n\n| Name | Value |\n| --- | --- |\n| Mode | Preview |\n\n$$x^2$$\n\n```python\nprint(1)\n```\n'
const EDITED = 'Unsaved visual evidence.'
const SHORTCUT = process.platform === 'darwin' ? 'Meta' : 'Control'
const SELECTION_PARAGRAPH = 'Preview selection remains visible while the document stays readonly.'
const SELECTION_STEPS = 12
const PREFERENCES_FILE = 'renderer-preferences.json'

const LONG_SESSION = 'cadd5a2768444da68ec9df1313c6137e'.repeat(3)
const LONG_PATH =
  '~/.scholarseed/codex/sessions/2026/10/14/rollout-2026-10-14T16-06-45-01a13973-132a-7410-9793-d706a0163092.jsonl'
const CONFIG_FILE = 'config.json'
const TRACE_DIRECTORY = 'trace'
const CODEX_DIRECTORY = 'codex'
const WORKSPACE_DIRECTORY = 'workspace'
const WRAPPING_DOCUMENT = [
  '# 行内代码换行',
  `会话：\`${LONG_SESSION}\` 后续正文。`,
  `- 日志路径：\`${LONG_PATH}\``,
  `> Windows 路径：\`C:\\Users\\ScholarSeed\\${LONG_SESSION}\\report.md\``,
  '短代码：`discover.py`。',
  `\`\`\`text\n${LONG_SESSION}\n\`\`\``,
  '| 第一列 | 第二列 | 第三列 | 第四列 |\n| --- | --- | --- | --- |\n| 内容 | 内容 | 内容 | 内容 |',
].join('\n\n')

const FIND_QUERY = 'EDITOR-NEEDLE'
const FIND_FIRST_PARAGRAPH = `${FIND_QUERY} appears in the first prose target.`
const FIND_SECOND_PARAGRAPH = `${FIND_QUERY} appears in the second prose target.`
const FIND_PARAGRAPH_COUNT = 40
const FIND_DOCUMENT = [
  '# Find navigation',
  FIND_FIRST_PARAGRAPH,
  ...Array.from(
    { length: FIND_PARAGRAPH_COUNT },
    (_, index) => `Intervening paragraph ${index + 1}.`
  ),
  FIND_SECOND_PARAGRAPH,
  ...Array.from({ length: FIND_PARAGRAPH_COUNT }, (_, index) => `Trailing paragraph ${index + 1}.`),
].join('\n\n')

async function withMarkdownRuntime(
  testInfo: TestInfo,
  operation: (runtime: RuntimePaths) => Promise<void>
): Promise<void> {
  await withIsolatedRuntime(testInfo, async (runtime) => {
    runtime.workspace = join(runtime.home, WORKSPACE_DIRECTORY)
    mkdirSync(runtime.workspace, { recursive: true })
    writeFileSync(join(runtime.home, CONFIG_FILE), '{}')
    const previousTraceHome = process.env.DAMOATRACE_HOME
    const previousCodexHome = process.env.SCHOLARSEED_CODEX_HOME
    process.env.DAMOATRACE_HOME = join(runtime.home, TRACE_DIRECTORY)
    process.env.SCHOLARSEED_CODEX_HOME = join(runtime.home, CODEX_DIRECTORY)
    try {
      await operation(runtime)
    } finally {
      if (previousTraceHome === undefined) delete process.env.DAMOATRACE_HOME
      else process.env.DAMOATRACE_HOME = previousTraceHome
      if (previousCodexHome === undefined) delete process.env.SCHOLARSEED_CODEX_HOME
      else process.env.SCHOLARSEED_CODEX_HOME = previousCodexHome
    }
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Markdown find reveals cross-screen matches without moving focus out of the dialog (${theme})`, async ({}, testInfo) => {
    await withMarkdownRuntime(testInfo, async (runtime) => {
      const preferencesPath = join(runtime.userData, PREFERENCES_FILE)
      const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'))
      writeFileSync(preferencesPath, JSON.stringify({ ...preferences, theme }))
      const desktop = new DesktopSession(runtime, testInfo)
      try {
        const page = await desktop.launch()
        const project = await createReadyProject(page, PROJECT_NAME)
        const path = join(project.root, DOCUMENT_PATH)
        writeFileSync(path, FIND_DOCUMENT)
        await page.reload()
        await enterWorkbenchShell(page)
        await page.getByTestId('activity-home').click()
        await page.getByTestId(`home-project-${project.name}`).click()
        await page.getByRole('button', { name: '项目文件', exact: true }).click()
        await page.getByRole('button', { name: '刷新资料库', exact: true }).click()
        await page.getByRole('button', { name: 'modes.md', exact: true }).click()
        await selectMarkdownMode(page, 'edit')
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        const editor = page.getByTestId('markdown-visual-editor').locator('.ProseMirror')
        await editor.getByRole('heading', { name: 'Find navigation' }).click()
        await page.keyboard.press(`${SHORTCUT}+f`)
        const input = page.getByTestId('markdown-find-input')
        const dialog = page.getByRole('dialog').filter({ has: input })
        const first = editor.getByText(FIND_FIRST_PARAGRAPH, { exact: true })
        const second = editor.getByText(FIND_SECOND_PARAGRAPH, { exact: true })
        const expectMatchVisible = async (paragraph: typeof first): Promise<void> => {
          await expect
            .poll(() =>
              paragraph.evaluate((element) => {
                const range = document.createRange()
                range.selectNodeContents(element)
                const bounds = range.getBoundingClientRect()
                const viewport = element.closest('.milkdown')!.getBoundingClientRect()
                const overlay = document.querySelector('[role="dialog"]')?.getBoundingClientRect()
                const visible =
                  bounds.top >= viewport.top &&
                  bounds.bottom <= viewport.bottom &&
                  bounds.top >= 0 &&
                  bounds.bottom <= window.innerHeight &&
                  (!overlay ||
                    bounds.bottom <= overlay.top ||
                    bounds.top >= overlay.bottom ||
                    bounds.right <= overlay.left ||
                    bounds.left >= overlay.right)
                return visible
                  ? null
                  : {
                      match: bounds.toJSON(),
                      viewport: viewport.toJSON(),
                      overlay: overlay?.toJSON(),
                    }
              })
            )
            .toBeNull()
        }
        await input.fill(FIND_QUERY)
        await input.press('Enter')
        await expect(dialog).toContainText('第 1 个，共 2 个')
        await expect(second).not.toBeInViewport()
        await expectMatchVisible(first)
        await dialog.getByRole('button', { name: '下一个', exact: true }).click()
        await expect(dialog).toContainText('第 2 个，共 2 个')
        await page.screenshot({ path: join(runtime.artifacts, `find-next-${theme}.png`) })
        await expectMatchVisible(second)
        expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
          true
        )
        await dialog.getByRole('button', { name: '上一个', exact: true }).click()
        await expect(dialog).toContainText('第 1 个，共 2 个')
        await expectMatchVisible(first)
        await input.focus()
        await input.press('Shift+Enter')
        await expect(dialog).toContainText('第 2 个，共 2 个')
        await expectMatchVisible(second)
        await expect(input).toBeFocused()
        await input.press('Enter')
        await expect(dialog).toContainText('第 1 个，共 2 个')
        await expectMatchVisible(first)
        const nativeWindow = await desktop.browserWindow(page)
        await nativeWindow.evaluate(
          (window, size) => window.setSize(size.width, size.height),
          WORKSPACE_WINDOW_MINIMUM
        )
        await nativeWindow.dispose()
        await input.press('Enter')
        await expect(dialog).toContainText('第 2 个，共 2 个')
        await expectMatchVisible(second)
        await page.screenshot({ path: join(runtime.artifacts, `find-minimum-${theme}.png`) })
        await input.press('Escape')
        await expect(dialog).toHaveCount(0)
        await expectMatchVisible(second)
        await expect(editor).toBeFocused()
        await page.screenshot({ path: join(runtime.artifacts, `find-closed-${theme}.png`) })
        expect(readFileSync(path, 'utf8')).toBe(FIND_DOCUMENT)
        desktop.assertNoPageErrors()
      } finally {
        await desktop.attachArtifacts()
      }
    })
  })
}

for (const autoSave of [false, true]) {
  test(`Markdown close retains protection when automatic save is ${autoSave ? 'conflicted' : 'disabled'}`, async ({}, testInfo) => {
    await withMarkdownRuntime(testInfo, async (runtime) => {
      const preferencesPath = join(runtime.userData, PREFERENCES_FILE)
      const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'))
      writeFileSync(preferencesPath, JSON.stringify({ ...preferences, autoSave }))
      const desktop = new DesktopSession(runtime, testInfo)
      try {
        const page = await desktop.launch()
        const project = await createReadyProject(page, PROJECT_NAME)
        const path = join(project.root, DOCUMENT_PATH)
        writeFileSync(path, '# Protected document\n\nOriginal paragraph.\n')
        await page.reload()
        await enterWorkbenchShell(page)
        await page.getByTestId('topbar-project').click()
        await page.getByTestId(`project-menu-option-${PROJECT_NAME}`).click()
        await page.getByTestId('activity-resource').click()
        await page.getByTestId('resource-refresh').click()
        await page.getByTestId(`tree-${DOCUMENT_PATH}`).click()
        await selectMarkdownMode(page, 'edit')
        const visual = page.getByTestId('markdown-visual-editor').locator('.ProseMirror')
        await visual.getByText('Original paragraph.').click()
        await page.keyboard.press('End')
        await page.keyboard.insertText(EDITED)
        await expect(visual).toContainText(EDITED)
        if (autoSave) writeFileSync(path, '# External changes must survive\n')
        const tab = page.getByRole('tab', { name: /modes\.md/ })
        if (!autoSave) await expect(tab.locator('[data-slot="navigation-tab-dirty"]')).toHaveCount(1)
        await tab.getByRole('button', { name: '关闭 modes.md' }).click()
        await expect(page.getByTestId('document-close-dialog')).toBeVisible()
        await expect(page.getByTestId('markdown-save')).toHaveCount(0)
        await page.screenshot({ path: join(runtime.artifacts, `close-protected-${autoSave}.png`) })
        await page.getByTestId('document-close-cancel').click()
        await expect(visual).toContainText(EDITED)
        if (autoSave) {
          expect(readFileSync(path, 'utf8')).toBe('# External changes must survive\n')
        } else {
          await visual.getByText(EDITED, { exact: false }).click()
          await page.keyboard.press(`${SHORTCUT}+s`)
          await expect.poll(() => readFileSync(path, 'utf8')).toContain(EDITED)
          await tab.getByRole('button', { name: '关闭 modes.md' }).click()
          await expect(tab).toHaveCount(0)
          await expect(page.getByTestId('document-close-dialog')).toHaveCount(0)
        }
        desktop.assertNoPageErrors()
      } finally {
        await desktop.attachArtifacts()
      }
    })
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Markdown automatically saves on close without a save button (${theme})`, async ({}, testInfo) => {
    await withMarkdownRuntime(testInfo, async (runtime) => {
      const preferencesPath = join(runtime.userData, PREFERENCES_FILE)
      const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'))
      writeFileSync(preferencesPath, JSON.stringify({ ...preferences, theme, autoSave: true }))
      const desktop = new DesktopSession(runtime, testInfo)
      try {
        const page = await desktop.launch()
        const project = await createReadyProject(page, PROJECT_NAME)
        const path = join(project.root, DOCUMENT_PATH)
        writeFileSync(path, ORIGINAL)
        await page.reload()
        await enterWorkbenchShell(page)
        await page.getByTestId('topbar-project').click()
        await page.getByTestId(`project-menu-option-${PROJECT_NAME}`).click()
        await page.getByTestId('activity-resource').click()
        await page.getByTestId('resource-refresh').click()
        const file = page.getByTestId(`tree-${DOCUMENT_PATH}`)
        await file.click()
        const tab = page.getByRole('tab', { name: /modes\.md/ })
        for (const mode of ['editor', 'source', 'preview'] as const) {
          await selectMarkdownMode(page, 'edit')
          const visual = page.getByTestId('markdown-visual-editor').locator('.ProseMirror')
          await expect(visual).toBeVisible()
          const marker = `Automatic close ${mode} ${theme}`
          if (mode === 'source') {
            await selectMarkdownMode(page, 'source')
            const source = page.getByTestId('markdown-source-editor').frameLocator('iframe').locator('.view-lines')
            await expect(source).toBeVisible()
            await source.click()
            await page.keyboard.press(`${SHORTCUT}+End`)
            await page.keyboard.press('Enter')
            await page.keyboard.insertText(marker)
            await expect(source).toContainText(marker)
            const sourceFrame = await page.getByTestId('markdown-source-editor').locator('iframe').elementHandle()
            await selectMarkdownMode(page, 'preview')
            await expect(page.getByTestId('markdown-preview')).toContainText(marker)
            await expect(page.getByTestId('markdown-source-editor')).toBeHidden()
            await expect(page.getByTestId('markdown-undo')).toHaveCount(0)
            expect(await sourceFrame!.evaluate((frame) => frame.isConnected)).toBe(true)
            await selectMarkdownMode(page, 'source')
            await expect(source).toContainText(marker)
            expect(await sourceFrame!.evaluate((frame) => frame.isConnected)).toBe(true)
            await sourceFrame!.dispose()
          } else {
            await visual.click()
            await page.keyboard.press(`${SHORTCUT}+End`)
            await page.keyboard.press('Enter')
            await page.keyboard.insertText(marker)
            await expect(visual).toContainText(marker)
            if (mode === 'preview') await selectMarkdownMode(page, 'preview')
          }
          await expect(page.getByTestId('markdown-save')).toHaveCount(0)
          await expect(page.getByTestId('source-document-save')).toHaveCount(0)
          await expect(page.locator('.vds-markdown-header')).toHaveAttribute('data-save-state', 'dirty')
          await page.screenshot({ path: join(runtime.artifacts, `autosave-${mode}-${theme}-edited.png`) })
          await tab.getByRole('button', { name: '关闭 modes.md' }).click()
          await expect(tab).toHaveCount(0)
          await expect(page.getByTestId('document-close-dialog')).toHaveCount(0)
          await expect.poll(() => readFileSync(path, 'utf8')).toContain(marker)
          await file.click()
          await selectMarkdownMode(page, 'edit')
          await expect(visual).toContainText(marker)
          await page.screenshot({ path: join(runtime.artifacts, `autosave-${mode}-${theme}-reopened.png`) })
        }
        await desktop.app!.evaluate(({ BrowserWindow }, minimum) => {
          const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().startsWith('http://'))!
          window.setSize(minimum.width, minimum.height)
        }, WORKSPACE_WINDOW_MINIMUM)
        await expect(page.getByTestId('markdown-mode-select')).toBeVisible()
        await expect(page.getByTestId('markdown-save')).toHaveCount(0)
        await page.screenshot({ path: join(runtime.artifacts, `autosave-minimum-${theme}.png`) })
        desktop.assertNoPageErrors()
      } finally {
        await desktop.attachArtifacts()
      }
    })
  })

  test(`long inline code wraps inside the document without changing block scrolling (${theme})`, async ({}, testInfo) => {
    await withMarkdownRuntime(testInfo, async (runtime) => {
      const preferencesPath = join(runtime.userData, PREFERENCES_FILE)
      const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'))
      writeFileSync(preferencesPath, JSON.stringify({ ...preferences, theme }))
      const desktop = new DesktopSession(runtime, testInfo)
      try {
        const page = await desktop.launch()
        const project = await createReadyProject(page, PROJECT_NAME)
        const path = join(project.root, DOCUMENT_PATH)
        writeFileSync(path, WRAPPING_DOCUMENT)
        await page.reload()
        await enterWorkbenchShell(page)
        await page.getByTestId('topbar-project').click()
        await page.getByTestId(`project-menu-option-${PROJECT_NAME}`).click()
        await page.getByTestId('activity-resource').click()
        await page.getByTestId('resource-refresh').click()
        await page.getByTestId(`tree-${DOCUMENT_PATH}`).click()
        await selectMarkdownMode(page, 'edit')
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        await desktop.app!.evaluate(({ BrowserWindow }, minimum) => {
          const main = BrowserWindow.getAllWindows().find((window) =>
            window.webContents.getURL().startsWith('http://')
          )!
          main.setSize(minimum.width, minimum.height)
        }, WORKSPACE_WINDOW_MINIMUM)
        const editor = page.getByTestId('markdown-visual-editor')
        await expect(editor.locator('.ProseMirror')).toBeVisible()
        const geometry = await editor.evaluate((element) => {
          const paper = element.querySelector('.ProseMirror')!
          const bounds = paper.getBoundingClientRect()
          const codes = [...paper.querySelectorAll('p code, li code, blockquote code')]
          return {
            overflow: codes.some((code) =>
              [...code.getClientRects()].some((rect) => rect.right > bounds.right)
            ),
            lines: codes.slice(0, 3).map((code) => {
              const range = document.createRange()
              range.selectNodeContents(code)
              return new Set([...range.getClientRects()].map((rect) => rect.top)).size
            }),
          }
        })
        expect(geometry.overflow).toBe(false)
        expect(geometry.lines.every((lines) => lines > 1)).toBe(true)
        const scroll = editor.locator(':scope > .milkdown')
        expect(await scroll.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true
        )
        const codeScroller = editor.locator('.cm-scroller')
        expect(
          await codeScroller.evaluate((element) => element.scrollWidth > element.clientWidth)
        ).toBe(true)
        const tableScroller = editor.locator('.table-wrapper')
        expect(
          await tableScroller.evaluate((element) => element.scrollWidth > element.clientWidth)
        ).toBe(true)
        await page.screenshot({ path: join(runtime.artifacts, `inline-code-visual-${theme}.png`) })
        await selectMarkdownMode(page, 'preview')
        const preview = page.getByTestId('markdown-preview')
        await expect(preview.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false')
        expect(
          await preview
            .locator(':scope > .milkdown')
            .evaluate((element) => element.scrollWidth <= element.clientWidth)
        ).toBe(true)
        await page.screenshot({ path: join(runtime.artifacts, `inline-code-preview-${theme}.png`) })
        expect(readFileSync(path, 'utf8')).toBe(WRAPPING_DOCUMENT)
        desktop.assertNoPageErrors()
      } finally {
        await desktop.close()
      }
    })
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Markdown preview preserves native text selection in ${theme}`, async ({}, testInfo) => {
    await withMarkdownRuntime(testInfo, async (runtime) => {
      const preferencesPath = join(runtime.userData, PREFERENCES_FILE)
      const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'))
      writeFileSync(preferencesPath, JSON.stringify({ ...preferences, theme }))
      const desktop = new DesktopSession(runtime, testInfo)
      try {
        const page = await desktop.launch()
        const project = await createReadyProject(page, PROJECT_NAME)
        const path = join(project.root, DOCUMENT_PATH)
        const source = `# Preview selection\n\n${SELECTION_PARAGRAPH}\n`
        writeFileSync(path, source)
        await page.reload()
        await enterWorkbenchShell(page)
        await page.getByTestId('topbar-project').click()
        await page.getByTestId(`project-menu-option-${PROJECT_NAME}`).click()
        await page.getByTestId('activity-resource').click()
        await page.getByTestId('resource-refresh').click()
        await page.getByTestId(`tree-${DOCUMENT_PATH}`).click()
        await selectMarkdownMode(page, 'preview')
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        const preview = page.getByTestId('markdown-preview')
        const paragraph = preview.getByText(SELECTION_PARAGRAPH, { exact: true })
        await expect(paragraph).toBeVisible()
        await expect(paragraph).toHaveCSS('user-select', 'text')
        await expect(preview.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false')
        const selectParagraph = async () => {
          const points = await paragraph.evaluate((element) => {
            const text = element.firstChild!
            const range = document.createRange()
            range.setStart(text, 0)
            range.setEnd(text, text.textContent!.length)
            const rectangles = [...range.getClientRects()]
            const first = rectangles[0]
            const last = rectangles.at(-1)!
            return {
              start: { x: first.left, y: first.top + first.height / 2 },
              end: { x: last.right, y: last.top + last.height / 2 },
            }
          })
          await page.mouse.move(points.start.x, points.start.y)
          await page.mouse.down()
          await page.mouse.move(points.end.x, points.end.y, { steps: SELECTION_STEPS })
          await page.mouse.up()
        }
        await selectParagraph()
        const toolbar = page.getByTestId('selection-action-host')
        await expect(toolbar).toBeVisible()
        await page.screenshot({ path: join(runtime.artifacts, `markdown-selection-${theme}.png`) })
        await expect
          .poll(() => page.evaluate(() => window.getSelection()?.toString()))
          .toBe(SELECTION_PARAGRAPH)
        const selectionBackground = await paragraph.evaluate(
          (element) => getComputedStyle(element, '::selection').backgroundColor
        )
        expect(selectionBackground).not.toBe('rgba(0, 0, 0, 0)')
        await toolbar.getByRole('button', { name: '添加到对话', exact: true }).hover()
        await expect
          .poll(() => page.evaluate(() => window.getSelection()?.toString()))
          .toBe(SELECTION_PARAGRAPH)
        await page.screenshot({
          path: join(runtime.artifacts, `markdown-selection-toolbar-${theme}.png`),
        })
        await toolbar.getByRole('button', { name: '添加到对话', exact: true }).click()
        await expect(page.getByText(SELECTION_PARAGRAPH, { exact: false }).last()).toBeVisible()
        await paragraph.click()
        await expect(toolbar).toHaveCount(0)
        await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('')
        await page.keyboard.type('MUST_NOT_EDIT')
        await expect(paragraph).toHaveText(SELECTION_PARAGRAPH)
        expect(readFileSync(path, 'utf8')).toBe(source)
        await expect(page.getByTestId('markdown-save')).toHaveCount(0)
        await page.screenshot({
          path: join(runtime.artifacts, `markdown-selection-cleared-${theme}.png`),
        })
        const nativeWindow = await desktop.browserWindow(page)
        await nativeWindow.evaluate(
          (window, size) => window.setSize(size.width, size.height),
          WORKSPACE_WINDOW_MINIMUM
        )
        await expect
          .poll(() => page.evaluate(() => window.innerWidth))
          .toBe(WORKSPACE_WINDOW_MINIMUM.width)
        await selectParagraph()
        await expect(toolbar).toBeVisible()
        await expect
          .poll(() => page.evaluate(() => window.getSelection()?.toString()))
          .toBe(SELECTION_PARAGRAPH)
        await page.screenshot({
          path: join(runtime.artifacts, `markdown-selection-narrow-${theme}.png`),
        })
        desktop.assertNoPageErrors()
      } finally {
        await desktop.close()
      }
    })
  })
}

test('Markdown text, visual and readonly preview share edits without preview writes', async ({}, testInfo) => {
  await withMarkdownRuntime(testInfo, async (runtime) => {
    runtime.workspace = join(runtime.home, 'workspace')
    mkdirSync(runtime.workspace, { recursive: true })
    const desktop = new DesktopSession(runtime, testInfo)
    try {
      let page = await desktop.launch()
      const project = await createReadyProject(page, PROJECT_NAME)
      const path = join(project.root, DOCUMENT_PATH)
      writeFileSync(path, ORIGINAL)
      await page.reload()
      await enterWorkbenchShell(page)
      await page.getByTestId('topbar-project').click()
      await page.getByTestId(`project-menu-option-${PROJECT_NAME}`).click()
      await page.getByTestId('activity-resource').click()
      await page.getByTestId('resource-refresh').click()
      await page.getByTestId(`tree-${DOCUMENT_PATH}`).click()
      await openMarkdownModes(page)
      await expect(page.getByTestId('markdown-open-source')).toHaveText('源码')
      await expect(page.getByTestId('markdown-open-editor')).toHaveText('编辑模式')
      await expect(page.getByTestId('markdown-open-preview')).toHaveText('只读模式')
      await selectMarkdownMode(page, 'edit')
      const visual = page.getByTestId('markdown-visual-editor').locator('.ProseMirror')
      await expect(visual).toHaveAttribute('contenteditable', 'true')
      await visual.getByText('Original paragraph.').click()
      await page.keyboard.press('End')
      await page.keyboard.type(EDITED)
      await selectMarkdownMode(page, 'preview')
      const preview = page.getByTestId('markdown-preview')
      await expect(preview.getByText(EDITED, { exact: false })).toBeVisible()
      await expect(preview.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false')
      await expect(preview.locator('h1')).toHaveText('Mode evidence')
      await expect(preview.locator('.ProseMirror table.children')).toBeVisible()
      await expect(preview.locator('.katex').first()).toBeVisible()
      await expect(page.getByTestId('markdown-save')).toHaveCount(0)
      const diskBefore = readFileSync(path, 'utf8')
      const renderedBefore = await preview.innerText()
      await preview.getByText(EDITED, { exact: false }).click()
      await page.keyboard.type('MUST_NOT_EDIT')
      await page.keyboard.press('Backspace')
      await page.keyboard.press(`${SHORTCUT}+b`)
      await page.keyboard.press(`${SHORTCUT}+s`)
      await desktop.app!.evaluate(({ clipboard }) => clipboard.writeText('MUST_NOT_PASTE'))
      await page.keyboard.press(`${SHORTCUT}+v`)
      await preview.locator('.cm-content').first().click()
      await page.keyboard.type('MUST_NOT_EDIT_CODE')
      await expect.poll(() => preview.innerText()).toBe(renderedBefore)
      expect(readFileSync(path, 'utf8')).toBe(diskBefore)
      await expect(page.getByTestId('markdown-editor-actions').getByRole('button')).toHaveCount(0)
      await page.screenshot({ path: join(runtime.artifacts, 'markdown-preview-readonly.png') })
      await selectMarkdownMode(page, 'source')
      await expect(page.getByTestId('markdown-source-editor')).toBeVisible()
      await expect(
        page.getByTestId('markdown-source-editor').frameLocator('iframe').locator('.view-lines')
      ).toContainText(EDITED)
      await page.screenshot({ path: join(runtime.artifacts, 'markdown-text.png') })
      await selectMarkdownMode(page, 'edit')
      await expect(visual).toContainText(EDITED)
      await visual.click()
      await page.keyboard.press(`${SHORTCUT}+s`)
      await expect.poll(() => readFileSync(path, 'utf8')).toContain(EDITED)
      await page.screenshot({ path: join(runtime.artifacts, 'markdown-visual-saved.png') })
      const projection = await page.request.get(`${await apiBase(page)}/api/workbench/open`, {
        params: { project: project.id, path: DOCUMENT_PATH },
      })
      expect(projection.ok()).toBe(true)
      const saved = await projection.json()
      expect(saved.versioning.version_id).toBeTruthy()
      await desktop.close()
      const preferencesPath = join(runtime.userData, 'renderer-preferences.json')
      const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'))
      writeFileSync(
        preferencesPath,
        JSON.stringify({
          ...preferences,
          lastLocation: {
            view: 'resource',
            projectId: project.id,
            aiPanelOpen: true,
            target: {
              kind: 'document',
              title: 'Readonly version',
              viewKind: 'preview',
              source: {
                kind: 'version',
                project: project.id,
                path: DOCUMENT_PATH,
                versionId: saved.versioning.version_id,
                revision: saved.versioning.working_revision,
              },
            },
          },
        })
      )
      page = await desktop.launch()
      await expect(page.getByTestId('markdown-preview')).toContainText(EDITED)
      await openMarkdownModes(page)
      await expect(page.getByTestId('markdown-open-editor')).toBeDisabled()
      await expect(
        page.getByText('此文件只读，无法使用编辑模式；可查看源码或只读模式。')
      ).toBeVisible()
      await selectMarkdownMode(page, 'source')
      const readonlyText = page
        .getByTestId('markdown-source-editor')
        .frameLocator('iframe')
        .locator('.view-lines')
      await expect(readonlyText).toContainText(EDITED)
      await readonlyText.click()
      await page.keyboard.type('MUST_NOT_EDIT_READONLY')
      await expect(readonlyText).not.toContainText('MUST_NOT_EDIT_READONLY')
      await selectMarkdownMode(page, 'preview')
      await page.screenshot({ path: join(runtime.artifacts, 'markdown-readonly-file.png') })
      desktop.assertNoPageErrors()
    } finally {
      await desktop.close()
    }
  })
})
