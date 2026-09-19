import { DEFAULT_SELECTION_PROMPTS } from '../src/prompts'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { expect, test } from '@playwright/test'
import { apiBase, DesktopSession, enterWorkbenchShell } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'

const PROJECT_NAME = '划词验收'
const SOURCE_PATH = 'resources/selection.md'
const SOURCE_NAME = 'selection.md'
const SOURCE_TEXT = 'Verified selection evidence.'

test('short Markdown selection keeps its first block and scroll state stable', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    const project = await page.evaluate(async ({ base, name }) => {
      const response = await fetch(`${base}/api/content/projects`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      })
      if (!response.ok) throw new Error(`project_create_${response.status}`)
      return response.json() as Promise<{ root: string }>
    }, { base: await apiBase(page), name: PROJECT_NAME })
    writeFileSync(join(project.root, SOURCE_PATH), `# Evidence\n\n${SOURCE_TEXT}\n\n## Details\n\n| Name | Value |\n| --- | --- |\n| Example | Verified |\n`)
    await page.reload()
    await enterWorkbenchShell(page)
    await page.getByTestId('topbar-project').click()
    await page.getByTestId(`project-menu-option-${PROJECT_NAME}`).click()
    await page.getByTestId('activity-resource').click()
    await page.getByTestId('resource-refresh').click()
    await page.getByTestId(`tree-${SOURCE_PATH}`).click()
    const editorMode = page.getByTestId('markdown-open-editor')
    if (await editorMode.count()) await editorMode.click()
    const editor = page.getByTestId('markdown-visual-editor')
    const paragraph = editor.getByText(SOURCE_TEXT, { exact: true })
    const heading = editor.locator('.ProseMirror > h1').first()
    const scroller = editor.locator(':scope > .milkdown')
    await expect(paragraph).toBeVisible()
    const assertFirstBlockSpacing = async (): Promise<void> => {
      await expect.poll(() => heading.evaluate((element) => getComputedStyle(element).marginTop)).toBe('0px')
    }
    await paragraph.click()
    await expect(editor.locator('.ProseMirror > .prosemirror-virtual-cursor')).toHaveCount(1)
    await assertFirstBlockSpacing()
    const beforeSelection = {
      headingTop: (await heading.boundingBox())?.y,
      scroll: await scroller.evaluate((element) => ({
        height: element.scrollHeight,
        top: element.scrollTop
      }))
    }
    expect(beforeSelection.headingTop).toBeDefined()
    await paragraph.click({ clickCount: 3 })
    await expect(page.getByTestId('selection-action-host')).toBeVisible()
    await expect.poll(async () => (await heading.boundingBox())?.y).toBeCloseTo(beforeSelection.headingTop!, 0)
    await expect.poll(async () => scroller.evaluate((element) => ({
      height: element.scrollHeight,
      top: element.scrollTop
    }))).toEqual(beforeSelection.scroll)
    const tableCell = editor.getByText('Example', { exact: true })
    for (const target of [heading, paragraph, tableCell, paragraph]) {
      await target.click()
      await assertFirstBlockSpacing()
      await expect.poll(async () => (await heading.boundingBox())?.y).toBeCloseTo(beforeSelection.headingTop!, 0)
      await expect.poll(() => scroller.evaluate((element) => ({
        height: element.scrollHeight,
        top: element.scrollTop
      }))).toEqual(beforeSelection.scroll)
    }
    await page.keyboard.press('Shift+ArrowRight')
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
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const project = await page.evaluate(async ({ base, name }) => {
      const response = await fetch(`${base}/api/content/projects`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      })
      if (!response.ok) throw new Error(`project_create_${response.status}`)
      return response.json() as Promise<{ root: string }>
    }, { base: await apiBase(page), name: PROJECT_NAME })
    writeFileSync(join(project.root, SOURCE_PATH), `# Evidence\n\n${SOURCE_TEXT}\n`)
    await page.reload()
    await enterWorkbenchShell(page)
    await page.getByTestId('topbar-project').click()
    await page.getByTestId(`project-menu-option-${PROJECT_NAME}`).click()
    // 离开首页时进的是文献库视图, 资料树要用活动栏真实入口打开; 刷新一次让
    // reload 之前写进磁盘的文件进入树。
    await page.getByTestId('activity-resource').click()
    await page.getByTestId('resource-refresh').click()
    await page.getByTestId(`tree-${SOURCE_PATH}`).click()
    const editorMode = page.getByTestId('markdown-open-editor')
    if (await editorMode.count()) await editorMode.click()
    const paragraph = page.getByTestId('markdown-visual-editor').getByText(SOURCE_TEXT, { exact: true })
    await expect(paragraph).toBeVisible()
    const selectSourceText = async (): Promise<void> => {
      await paragraph.click({ clickCount: 3 })
      await page.keyboard.press('Home')
      await page.keyboard.press('Shift+End')
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
    const menuBackground = await menu.evaluate((element) => window.getComputedStyle(element).backgroundColor)
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
      modal: Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--vds-z-modal'), 10)
    }))
    expect(settingsLayer.actual).toBe(settingsLayer.modal)
    await page.screenshot({ path: join(runtime.artifacts, 'selection-dismissed-settings-top.png') })
    await settingsDialog.getByRole('button', { name: '关闭' }).click()
    await selectSourceText()
    await expect(menu).toBeVisible()
    await menu.getByRole('button', { name: '粗体', exact: true }).click()
    await expect(page.getByTestId('markdown-visual-editor').locator('strong')).toContainText(SOURCE_TEXT)
    await page.screenshot({ path: join(runtime.artifacts, 'selection-menu.png') })
    // Real model calls belong to explicitly enabled live acceptance, not smoke.
    await menu.getByRole('button', { name: '添加到对话', exact: true }).click()
    await expect(page.getByTestId('assistant-selection-quote')).toHaveCount(0)
    const pendingReference = page.getByTestId('ai-context-ref').filter({ hasText: 'selection.md · 选区' })
    await pendingReference.hover()
    await expect(page.getByTestId('assistant-selection-quote')).toContainText(SOURCE_TEXT)
    await expect(page.getByTestId('assistant-selection-quote')).toContainText(SOURCE_NAME)
    await page.screenshot({ path: join(runtime.artifacts, 'selection-pending-quote.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})


test('Markdown selection across blocks, inline code and code blocks opens the menu with an exact source quote', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  const markdown = [
    '# Evidence', '', 'Heat **lowers efficiency** after `run()` finishes.', '',
    'Second paragraph text.', '', '```python', 'print("alpha")', 'return beta', '```', ''
  ].join('\n')
  try {
    const page = await desktop.launch()
    const project = await page.evaluate(async ({ base, name }) => {
      const response = await fetch(`${base}/api/content/projects`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      })
      if (!response.ok) throw new Error(`project_create_${response.status}`)
      return response.json() as Promise<{ root: string }>
    }, { base: await apiBase(page), name: PROJECT_NAME })
    writeFileSync(join(project.root, SOURCE_PATH), markdown)
    await page.reload()
    await enterWorkbenchShell(page)
    await page.getByTestId('topbar-project').click()
    await page.getByTestId(`project-menu-option-${PROJECT_NAME}`).click()
    await page.getByTestId('activity-resource').click()
    await page.getByTestId('resource-refresh').click()
    await page.getByTestId(`tree-${SOURCE_PATH}`).click()
    const editorMode = page.getByTestId('markdown-open-editor')
    if (await editorMode.count()) await editorMode.click()
    const editor = page.getByTestId('markdown-visual-editor')
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
      const points = await editor.evaluate((root, needles) => {
        const point = (needle: string, edge: 'start' | 'end') => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => node.parentElement?.closest('.milkdown-code-block-placeholder')
              ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
          })
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const index = node.nodeValue?.indexOf(needle) ?? -1
            if (index < 0) continue
            const range = document.createRange()
            const offset = edge === 'start' ? index : index + needle.length - 1
            range.setStart(node, offset)
            range.setEnd(node, offset + 1)
            const rect = range.getBoundingClientRect()
            return { x: edge === 'start' ? rect.left + 1 : rect.right - 1, y: rect.top + rect.height / 2 }
          }
          throw new Error(`missing_text_${needle}`)
        }
        return { start: point(needles.startText, 'start'), end: point(needles.endText, 'end') }
      }, { startText, endText })
      await page.mouse.move(points.start.x, points.start.y)
      await page.mouse.down()
      await page.mouse.move(points.end.x, points.end.y, { steps: 12 })
      await onMove?.()
      await page.mouse.up()
    }
    const scenarios = [
      { name: 'into-code-block', start: 'paragraph', end: 'print', quote: 'paragraph text.\n\n```python\nprint\n```' },
      { name: 'bold-partial', start: 'lowers', end: 'efficiency', quote: '**lowers efficiency**' },
      { name: 'heading', start: 'Evidence', end: 'Heat', quote: '# Evidence\n\nHeat' },
      { name: 'paragraphs', start: 'finishes', end: 'Second', quote: 'finishes.\n\nSecond' },
      { name: 'inline-code-partial', start: 'run', end: 'run', quote: '`run`' },
      { name: 'code-block', start: 'print', end: 'beta', quote: '```python\nprint("alpha")\nreturn beta\n```' }
    ]
    const expectPrintHighlight = async (label: string): Promise<void> => {
      await expect(editor.locator('.cm-selectionBackground'), label).not.toHaveCount(0)
      expect(await editor.evaluate((root) => {
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
        const backgrounds = Array.from(root.querySelectorAll('.cm-selectionBackground'), (element) => (
          element.getBoundingClientRect()
        ))
        const covered = ({ x, y }: { x: number; y: number }) => backgrounds.some(
          (rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
        )
        return { alpha: covered(point('alpha')), print: covered(point('print')) }
      })).toEqual({ alpha: false, print: true })
    }
    const pendingReferences = page.getByTestId('ai-context-ref').filter({ hasText: 'selection.md · 选区' })
    for (const [index, scenario] of scenarios.entries()) {
      await drag(
        scenario.start,
        scenario.end,
        scenario.name === 'into-code-block'
          ? async () => {
              await expectPrintHighlight('code selection during drag')
              await page.screenshot({ path: join(runtime.artifacts, 'selection-markdown-during-drag.png') })
            }
          : undefined
      )
      await expect(menu, scenario.name).toBeVisible()
      await expect(menu.getByRole('button', { name: 'AI 解释', exact: true })).toBeVisible()
      if (scenario.name === 'into-code-block') {
        await expectPrintHighlight('code selection after drag')
      }
      await menu.getByRole('button', { name: '添加到对话', exact: true }).click()
      if (scenario.name === 'into-code-block') {
        await expectPrintHighlight('code selection after adding context')
      }
      await expect(pendingReferences).toHaveCount(index + 1)
      await pendingReferences.nth(index).hover()
      await expect(page.getByTestId('assistant-selection-quote'), scenario.name).toContainText(scenario.quote)
      await page.screenshot({ path: join(runtime.artifacts, `selection-markdown-${scenario.name}.png`) })
      await page.mouse.move(1, 1)
      await expect(page.getByTestId('assistant-selection-quote')).toHaveCount(0)
    }
    await page.screenshot({ path: join(runtime.artifacts, 'selection-markdown-cross-block-quote.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('selection prompts save through personal settings, survive restart, and restore independently', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  const prompts = { explain: '结合上下文解释\n说明推断', translate: '使用领域术语', polish: '更学术，保留引用' }
  try {
    let page = await desktop.launch()
    const settings = async () => {
      await page.getByTestId('activity-account').click()
      await page.getByTestId('account-menu-settings').click()
      await page.getByTestId('account-settings-nav-prompts').click()
    }
    await settings()
    for (const [action, value] of Object.entries(prompts)) await page.getByTestId(`selection-prompt-${action}`).fill(value)
    await page.getByTestId('selection-prompts-save').click()
    await expect.poll(() => JSON.parse(readFileSync(join(runtime.userData, 'renderer-preferences.json'), 'utf8')).selectionPrompts).toEqual(prompts)
    await expect(page.getByTestId('selection-prompts-save')).toBeDisabled()
    await page.getByRole('heading', { name: 'AI 提示词', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(runtime.artifacts, 'selection-prompts-saved.png') })
    await desktop.close()
    page = await desktop.launch()
    await settings()
    for (const [action, value] of Object.entries(prompts)) await expect(page.getByTestId(`selection-prompt-${action}`)).toHaveValue(value)
    await page.getByTestId('selection-prompt-restore-translate').click()
    await expect(page.getByTestId('selection-prompt-translate')).toHaveValue(DEFAULT_SELECTION_PROMPTS.translate)
    await expect(page.getByTestId('selection-prompt-explain')).toHaveValue(prompts.explain)
    await expect(page.getByTestId('selection-prompt-polish')).toHaveValue(prompts.polish)
    await page.getByTestId('selection-prompts-save').click()
    await expect.poll(() => JSON.parse(readFileSync(join(runtime.userData, 'renderer-preferences.json'), 'utf8')).selectionPrompts).toEqual({ ...prompts, translate: DEFAULT_SELECTION_PROMPTS.translate })
    await page.getByRole('heading', { name: 'AI 提示词', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(runtime.artifacts, 'selection-prompts-restored.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('Markdown selection link reuses the top bar icon and saves through the native link editor', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const project = await page.evaluate(async ({ base, name }) => {
      const response = await fetch(`${base}/api/content/projects`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      })
      if (!response.ok) throw new Error(`project_create_${response.status}`)
      return response.json() as Promise<{ root: string }>
    }, { base: await apiBase(page), name: PROJECT_NAME })
    writeFileSync(join(project.root, SOURCE_PATH), `# Evidence\n\n${SOURCE_TEXT}\n`)
    await page.reload()
    await enterWorkbenchShell(page)
    await page.getByTestId('topbar-project').click()
    await page.getByTestId(`project-menu-option-${PROJECT_NAME}`).click()
    // 离开首页时进的是文献库视图, 资料树要用活动栏真实入口打开; 刷新一次让
    // reload 之前写进磁盘的文件进入树。
    await page.getByTestId('activity-resource').click()
    await page.getByTestId('resource-refresh').click()
    await page.getByTestId(`tree-${SOURCE_PATH}`).click()
    const editorMode = page.getByTestId('markdown-open-editor')
    if (await editorMode.count()) await editorMode.click()
    const paragraph = page.getByTestId('markdown-visual-editor').locator('.ProseMirror p').filter({ hasText: SOURCE_TEXT })
    await expect(paragraph).toBeVisible()
    // Actual pointer input; the application must derive the Range and source locator.
    await paragraph.click({ clickCount: 3 })
    const menu = page.getByTestId('selection-action-host')
    await expect(menu).toBeVisible()
    const topbar = page.getByTestId('markdown-visual-editor').locator('.milkdown-top-bar')
    for (const label of ['粗体', '斜体', '删除线', '链接', '行内代码', '行内公式']) {
      const quick = menu.getByRole('button', { name: label, exact: true })
      const top = topbar.locator('button').filter({ has: page.getByLabel(label, { exact: true }) })
      await expect(quick).toBeVisible()
      expect(await quick.locator('svg').innerHTML()).toBe(await top.locator('svg').innerHTML())
      const appearance = (element: HTMLElement) => {
        const style = getComputedStyle(element)
        return { width: style.width, height: style.height, padding: style.padding, color: style.color, borderRadius: style.borderRadius }
      }
      expect(await quick.evaluate(appearance)).toEqual(await top.evaluate(appearance))
    }
    await topbar.getByLabel('删除线', { exact: true }).click()
    await expect(page.getByTestId('markdown-visual-editor').locator('del')).toContainText(SOURCE_TEXT)
    await paragraph.click({ clickCount: 3 })
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(SOURCE_TEXT)
    await menu.getByRole('button', { name: '删除线', exact: true }).click()
    await expect(page.getByTestId('markdown-visual-editor').locator('del')).toHaveCount(0)
    const link = menu.getByRole('button', { name: '链接', exact: true })
    const nativeIcon = page.getByTestId('markdown-visual-editor').locator('.milkdown-top-bar').getByLabel('链接', { exact: true }).locator('svg')
    await expect(link.locator('svg')).toBeVisible()
    expect(await link.locator('svg').innerHTML()).toBe(await nativeIcon.innerHTML())
    await page.screenshot({ path: join(runtime.artifacts, 'selection-link-menu.png') })
    await link.click()
    const input = page.getByPlaceholder('粘贴链接')
    await expect(input).toBeVisible()
    await input.fill('https://example.com/')
    await input.press('Enter')
    await expect(page.getByTestId('markdown-visual-editor').locator('a').filter({ hasText: SOURCE_TEXT })).toHaveAttribute('href', 'https://example.com/')
    await page.getByTestId('markdown-save').click()
    await expect.poll(() => readFileSync(join(project.root, SOURCE_PATH), 'utf8')).toContain(`[${SOURCE_TEXT}](https://example.com/)`)
    await page.screenshot({ path: join(runtime.artifacts, 'selection-link.png') })
    await paragraph.click()
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(SOURCE_TEXT)
    await topbar.getByLabel('行内公式', { exact: true }).click()
    await page.getByTestId('markdown-save').click()
    await expect.poll(() => readFileSync(join(project.root, SOURCE_PATH), 'utf8')).toContain(`$${SOURCE_TEXT}$`)
    await topbar.getByLabel('行内公式', { exact: true }).click()
    await page.getByTestId('markdown-save').click()
    await expect.poll(() => readFileSync(join(project.root, SOURCE_PATH), 'utf8')).not.toContain(`$${SOURCE_TEXT}$`)
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
