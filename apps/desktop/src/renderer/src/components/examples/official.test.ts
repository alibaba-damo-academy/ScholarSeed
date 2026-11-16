import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, expect } from '@playwright/test'
import { normalizePath } from 'vite'
import { contracts, GROUPS } from '../../../../../../../packages/ui/preview/catalog.mjs'
import { renderServers } from '../../../../test-helpers/render.ts'
import { conversationEntries } from './navigation.ts'

const servers = renderServers({ after })

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

test(
  'upstream OpenUI category exposes every built-in independently of Agent admission',
  { timeout: 300000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'upstream-materials',
      configFile: resolve(DESKTOP, 'vite.web.config.ts'),
      root: resolve(DESKTOP, 'src/renderer'),
      server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => {
        if (
          message.type() === 'error' &&
          /(?:TypeError|RangeError|Error:|same key)/.test(message.text())
        )
          errors.push(message.text())
      })
      await page.route(
        (url) => url.pathname.startsWith('/api/'),
        (route) => route.fulfill({ status: 404, json: {} })
      )
      await page.goto(
        new URL('/src/components/examples/official.fixture.html', server.resolvedUrls!.local[0])
          .href
      )
      await page.getByRole('button', { name: '中文', exact: true }).click()
      await expect(page.getByRole('button', { name: /^基础组件 components\/ui/ })).toBeVisible()
      await expect(
        page.getByRole('button', { name: /^通用组件 components\/primitive/ })
      ).toBeVisible()
      await expect(
        page.getByRole('button', { name: /^业务组件 components\/business/ })
      ).toBeVisible()
      await expect(page.locator('#conversation-messages')).toBeVisible()
      await expect(page.getByRole('button', { name: /^会话组件/ })).toHaveAttribute(
        'aria-expanded',
        'true'
      )
      await expect(page.getByTestId('conversation-directory')).toBeVisible()
      assert.deepEqual(
        await page
          .getByTestId('conversation-directory')
          .locator(':scope > [role="group"]')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label'))),
        ['用户输入', '对话组件', '图表', '工作台', 'A2UI']
      )
      const userInput = page.getByRole('group', { name: '用户输入', exact: true })
      await expect(userInput.getByRole('button')).toHaveCount(2)
      await userInput.getByRole('button', { name: '引用与上下文', exact: true }).click()
      const selectedContext = userInput.getByRole('button', { name: '引用与上下文', exact: true })
      await page.locator('#conversation-context h2').click()
      await expect(selectedContext).toHaveAttribute('aria-current', 'page')
      await expect(selectedContext).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(
        userInput.getByRole('button', { name: '文字消息', exact: true })
      ).not.toHaveAttribute('aria-current', 'page')
      const context = page.locator('#conversation-context')
      await expect(context.getByRole('tab')).toHaveCount(3)
      await expect(context.getByRole('tab', { name: '图片', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      await context.getByRole('tab', { name: '文件', exact: true }).click()
      await expect(context.getByRole('tabpanel')).toBeVisible()
      await context.getByRole('tab', { name: '引用与上下文', exact: true }).click()
      await expect(context.getByRole('tabpanel')).toBeVisible()
      await expect(context.getByRole('tab', { name: '引用与上下文', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      await userInput.getByRole('button', { name: '文字消息', exact: true }).click()
      await expect(page.locator('#conversation-messages')).toBeVisible()
      await expect(page.locator('#conversation-messages').getByRole('tab')).toHaveCount(0)
      await page
        .getByRole('group', { name: '对话组件', exact: true })
        .getByRole('button', { name: '产物', exact: true })
        .click()
      const artifacts = page.locator('#conversation-artifacts')
      const artifactPanel = artifacts.getByRole('tabpanel')
      await expect(artifacts.getByRole('tab')).toHaveCount(3)
      await expect(artifactPanel.locator('[data-artifact-card]')).toHaveCount(1)
      await expect(artifacts).toContainText('一页简报.md')
      await expect(
        artifactPanel.getByRole('group', { name: '预置示例', exact: true }).getByRole('button')
      ).toHaveCount(1)
      await artifacts.getByRole('tab', { name: '图片产物', exact: true }).click()
      await expect(artifactPanel.getByTestId('artifact-image-group').locator('img')).toHaveCount(4)
      await artifacts.getByRole('button', { name: '恢复默认数据', exact: true }).click()
      await expect(artifactPanel.getByTestId('artifact-image-group').locator('img')).toHaveCount(4)
      await artifacts.getByRole('tab', { name: '组合示例', exact: true }).click()
      await expect(artifactPanel.locator('[data-sample="ArtifactGroup"]')).toBeVisible()
      await artifacts.getByRole('tab', { name: '图片产物', exact: true }).click()
      await expect(artifactPanel.getByTestId('artifact-image-group').locator('img')).toHaveCount(4)
      const dialogue = page.getByRole('group', { name: '对话组件', exact: true })
      await dialogue.getByRole('button', { name: '引用', exact: true }).click()
      const citations = page.locator('#conversation-citations')
      await expect(citations.getByRole('tab')).toHaveCount(2)
      await expect(citations.getByRole('tab', { name: '引用来源', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      await expect(
        citations.getByRole('tabpanel').locator('[data-sample="CitationSources"]')
      ).toBeVisible()
      await citations
        .getByRole('button', { name: '研究对照：网页、PDF 与本地文件', exact: true })
        .click()
      await citations.getByRole('button', { name: '7 个来源', exact: true }).hover()
      const sourcePanel = page.locator('[data-citation-source-panel][data-state="open"]')
      await expect(sourcePanel).toHaveCSS('display', 'flex')
      const sourceViewport = sourcePanel.getByRole('list', { name: '7 个来源', exact: true })
      await expect
        .poll(() =>
          sourceViewport.evaluate((element) => element.scrollHeight > element.clientHeight)
        )
        .toBe(true)
      await sourceViewport.hover()
      await page.mouse.wheel(0, 600)
      await expect
        .poll(() => sourceViewport.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0)
      await expect(sourcePanel.getByText('阅读笔记.md', { exact: true })).toBeInViewport()
      const scrollbar = sourcePanel.getByRole('scrollbar')
      await expect(scrollbar).toHaveCSS('width', '6px')
      const [panelBounds, scrollbarBounds] = await Promise.all([
        sourcePanel.boundingBox(),
        scrollbar.boundingBox(),
      ])
      assert.ok(panelBounds && scrollbarBounds)
      assert.ok(
        Math.abs(panelBounds.x + panelBounds.width - scrollbarBounds.x - scrollbarBounds.width) < 1
      )
      if (process.env.CITATION_SCROLL_SCREENSHOT) {
        await sourcePanel.screenshot({ path: process.env.CITATION_SCROLL_SCREENSHOT })
      }
      await expect
        .poll(() =>
          sourcePanel.evaluate((element) => parseFloat(getComputedStyle(element).paddingBottom))
        )
        .toBeGreaterThan(4)
      await page.keyboard.press('Escape')
      await citations.getByRole('tab', { name: '引用标记', exact: true }).click()
      await expect(
        citations.getByRole('tabpanel').locator('[data-sample="CitationLink"]')
      ).toBeVisible()
      await dialogue.getByRole('button', { name: '产物', exact: true }).click()
      await expect(artifacts.getByRole('tab', { name: '文件产物', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      await dialogue.getByRole('button', { name: '正文', exact: true }).click()
      const body = page.locator('#conversation-body')
      const bodyTabs = body.getByRole('tablist', { name: '正文', exact: true })
      await expect(bodyTabs.getByRole('tab')).toHaveText(['公式', '简表', 'Markdown'])
      await expect(bodyTabs.getByRole('tab', { name: '公式', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      await expect(body.getByRole('tabpanel').locator('[data-sample="Formula"]')).toBeVisible()
      await bodyTabs.getByRole('tab', { name: '简表', exact: true }).click()
      await expect(body.getByRole('tabpanel').locator('[data-sample="Tabulation"]')).toBeVisible()
      await bodyTabs.getByRole('tab', { name: 'Markdown', exact: true }).click()
      await expect(body.getByRole('tabpanel').locator('[data-sample="Markdown"]')).toBeVisible()
      const sceneNumbers = await page
        .getByTestId('conversation-directory')
        .locator('[data-scene-number]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-scene-number')))
      assert.equal(new Set(sceneNumbers).size, sceneNumbers.length)
      await dialogue.getByRole('button', { name: '确认卡片', exact: true }).click()
      const approval = page.locator('#conversation-confirmation')
      await expect(approval).toBeVisible()
      await expect(
        approval.getByRole('group', { name: '确认卡片类型', exact: true }).getByRole('button')
      ).toHaveCount(5)
      await approval.getByRole('button', { name: '普通权限', exact: true }).click()
      await approval.getByRole('button', { name: '拒绝', exact: true }).click()
      await expect(approval.getByRole('status')).toContainText('本次演示已结束')
      await approval.getByRole('button', { name: '重置交互演示', exact: true }).click()
      await expect(approval.getByRole('button', { name: '允许一次', exact: true })).toBeVisible()
      await dialogue.getByRole('button', { name: '澄清', exact: true }).click()
      const clarification = page.locator('#conversation-clarify')
      await expect(clarification.getByRole('heading', { name: '澄清', exact: true })).toBeVisible()
      const clarificationStates = clarification.getByRole('group', {
        name: '示例状态',
        exact: true,
      })
      await expect(
        clarificationStates.getByRole('button', { name: '待填写', exact: true })
      ).toHaveAttribute('aria-pressed', 'true')
      for (const state of ['已提交', '已跳过', '待填写']) {
        await clarificationStates.getByRole('button', { name: state, exact: true }).click()
        await expect(
          clarificationStates.getByRole('button', { name: state, exact: true })
        ).toHaveAttribute('aria-pressed', 'true')
        await expect(clarification.getByTestId('conversation-preview')).toBeVisible()
      }
      await expect(page.getByRole('group', { name: '确认与澄清', exact: true })).toHaveCount(0)
      await dialogue.getByRole('button', { name: '处理过程', exact: true }).click()
      const processing = page.locator('#conversation-processing')
      const processingTabs = processing.getByRole('tablist', { name: '处理过程', exact: true })
      await expect(processingTabs.getByRole('tab')).toHaveText([
        '工具执行',
        '执行计划',
        '异常与中断',
      ])
      await expect(
        processingTabs.getByRole('tab', { name: '工具执行', exact: true })
      ).toHaveAttribute('aria-selected', 'true')
      await expect(
        processing.getByRole('tabpanel').getByTestId('conversation-material')
      ).toBeVisible()
      await processingTabs.getByRole('tab', { name: '执行计划', exact: true }).click()
      await expect(
        processing.getByRole('tabpanel').getByTestId('conversation-material')
      ).toBeVisible()
      await processingTabs.getByRole('tab', { name: '异常与中断', exact: true }).click()
      const exceptions = processing.getByRole('tabpanel')
      await expect(exceptions.locator('[data-testid^="conversation-alert-"]')).toHaveCount(3)
      for (const title of ['上次任务已中断', '发现可恢复内容', '正在重试']) {
        await expect(exceptions).toContainText(title)
      }
      await expect(
        exceptions.getByTestId('conversation-alert-retry').getByRole('button')
      ).toBeDisabled()
      await page
        .getByRole('group', { name: '图表', exact: true })
        .getByRole('button', { name: '通用图表', exact: true })
        .click()
      await expect(page.locator('[data-sample="Plot"]')).toBeVisible()
      await expect(page.getByTestId('preview-render-error')).toHaveCount(0)
      await expect(page.getByTestId('official-directory')).toHaveCount(0)
      const workbench = page.getByRole('group', { name: '工作台', exact: true })
      await expect(workbench.getByRole('button')).toHaveCount(2)
      await workbench.getByRole('button', { name: '科研结果', exact: true }).click()
      await expect(page.locator('[data-sample="Results"]')).toBeVisible()
      await expect(page.getByTestId('preview-render-error')).toHaveCount(0)
      await workbench.getByRole('button', { name: '科研综述', exact: true }).click()
      await expect(page.locator('[data-sample="Review"]')).toBeVisible()
      await expect(page.getByTestId('preview-render-error')).toHaveCount(0)
      const a2ui = page.getByRole('group', { name: 'A2UI', exact: true })
      await a2ui.getByRole('button', { name: '画布', exact: true }).click()
      await expect(page.locator('[data-sample="Canvas"]')).toBeVisible()
      const a2uiDirectory = a2ui.getByTestId('a2ui-openui-directory')
      await a2uiDirectory.getByRole('button', { name: /OpenUI基础组件/ }).click()
      await expect(a2uiDirectory.locator('[data-upstream-export]')).toHaveCount(82)
      await a2uiDirectory.locator('[data-upstream-export="Card"]').click()
      await expect(page.locator('[data-upstream-preview]')).toHaveAttribute(
        'data-component',
        'Card'
      )
      const directory = a2uiDirectory
      await expect(page.getByTestId('openui-directory')).toHaveCount(0)
      const names = await directory
        .locator('[data-upstream-export]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-upstream-export')!))
      assert.equal(names.length, 82)
      const surfaces = page.getByRole('group', { name: '预览展示位置', exact: true })
      for (const name of names) {
        const button = directory.locator(`[data-upstream-export="${name}"]`)
        assert.match(await button.innerText(), /[\u3400-\u9fff]/, name)
        await button.click()
        for (const scenario of ['文献调研', '实验对比 · 长内容与边界值']) {
          const preset = page
            .getByRole('group', { name: '预置示例', exact: true })
            .getByRole('button', { name: scenario, exact: true })
          await preset.click()
          await expect(preset).toHaveAttribute('aria-pressed', 'true')
          for (const [label, surface] of [
            ['对话展示', 'conversation'],
            ['Canvas 展示', 'canvas'],
          ]) {
            await surfaces.getByRole('button', { name: label, exact: true }).click()
            await expect(page.locator('[data-upstream-preview]')).toHaveAttribute(
              'data-component',
              name
            )
            await expect(page.locator('[data-upstream-preview]')).toHaveAttribute(
              'data-surface',
              surface
            )
            await expect(page.getByTestId('conversation-canvas')).toHaveCount(
              surface === 'canvas' ? 1 : 0
            )
            await expect(page.getByTestId('preview-render-error')).toHaveCount(0)
          }
        }
      }
      await directory.getByRole('button', { name: '模态对话框', exact: true }).click()
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await page.getByRole('button', { name: '打开弹窗预览', exact: true }).click()
        await expect(page.getByRole('dialog')).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog')).toHaveCount(0)
      }
      await directory.getByRole('button', { name: '单行输入框', exact: true }).click()
      const input = page.locator('[data-upstream-preview] input')
      await input.fill('Inspect local state')
      await expect(input).toHaveValue('Inspect local state')
      await page.getByRole('combobox', { name: '预览主题', exact: true }).click()
      await page.getByRole('option', { name: '深色主题', exact: true }).click()
      await expect(input).toHaveValue('Inspect local state')
      await directory.getByRole('button', { name: '基础表格', exact: true }).click()
      const examples = page.getByRole('group', { name: '预置示例', exact: true })
      await expect(examples.getByRole('button')).toHaveCount(5)
      for (const scale of ['小规模', '中等规模', '大规模']) {
        const preset = examples.getByRole('button', { name: new RegExp(`^${scale}：`) })
        await preset.click()
        await expect(preset).toHaveAttribute('aria-pressed', 'true')
        await surfaces.getByRole('button', { name: 'Canvas 展示', exact: true }).click()
        await expect(page.getByTestId('conversation-canvas').getByRole('table')).toBeVisible()
        await expect(page.getByTestId('preview-render-error')).toHaveCount(0)
      }
      await page.getByRole('button', { name: '实验对比 · 长内容与边界值', exact: true }).click()
      await surfaces.getByRole('button', { name: 'Canvas 展示', exact: true }).click()
      const canvas = page.getByTestId('conversation-canvas')
      await expect(canvas.getByRole('table')).toContainText('-8')
      await canvas.getByRole('button', { name: 'Table · Canvas 预览', exact: true }).click()
      await expect(canvas.getByRole('table')).toBeHidden()
      await canvas.getByRole('button', { name: 'Table · Canvas 预览', exact: true }).click()
      await expect(canvas.getByRole('table')).toBeVisible()
      await page.getByRole('button', { name: '编辑 JSON', exact: true }).click()
      const editor = page.getByRole('textbox', { name: '数据 JSON', exact: true })
      const draft = JSON.parse(await editor.inputValue())
      draft.columns[0].props.label = 'Edited scenario column'
      await editor.fill(JSON.stringify(draft))
      await page.keyboard.press('Escape')
      await surfaces.getByRole('button', { name: '对话展示', exact: true }).click()
      await expect(page.getByRole('table')).toContainText('Edited scenario column')
      await surfaces.getByRole('button', { name: 'Canvas 展示', exact: true }).click()
      await expect(canvas.getByRole('table')).toContainText('Edited scenario column')
      await page.getByRole('button', { name: 'English', exact: true }).click()
      await expect(
        page.getByRole('button', { name: 'Literature review', exact: true })
      ).toBeVisible()
      await expect(
        page
          .getByRole('group', { name: 'Preview surface', exact: true })
          .getByRole('button', { name: 'Canvas view', exact: true })
      ).toBeVisible()
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  }
)

test('the standalone official catalog keeps every component and editable preview after navigation cleanup', async () => {
  const server = await servers.create({
    cacheKey: 'materials',
    configFile: resolve(DESKTOP, 'vite.web.config.ts'),
    root: resolve(DESKTOP, 'src/renderer'),
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    const errors: string[] = []
    const diagnostics: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') diagnostics.push(message.text())
    })
    page.on('requestfailed', (request) =>
      diagnostics.push(`${request.url()}: ${request.failure()?.errorText}`)
    )
    page.on('response', (response) => {
      if (response.status() >= 400 && !response.url().includes('/api/'))
        diagnostics.push(`${response.status()}: ${response.url()}`)
    })
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      (route) => route.fulfill({ status: 404, json: {} })
    )
    await page.goto(
      new URL(
        '/src/components/examples/official.fixture.html?catalog',
        server.resolvedUrls!.local[0]
      ).href
    )
    await expect(page.getByRole('button', { name: '中文', exact: true }))
      .toBeVisible()
      .catch(async (error) => {
        throw new Error(
          JSON.stringify({
            errors,
            diagnostics,
            body: await page.locator('body').innerText(),
            error: String(error),
          })
        )
      })
    await page.getByRole('button', { name: '中文', exact: true }).click()
    const directory = page.getByTestId('official-directory')
    assert.equal(
      await directory.locator('[data-category]').first().getAttribute('data-category'),
      'content'
    )
    assert.deepEqual(await directory.getByRole('heading').allTextContents(), [
      '正文与富内容',
      '图表',
      '引用、证据与上下文',
      '附件、产物与工作台',
      '基础组件',
    ])
    const publicContracts = Object.entries(contracts).flatMap(([name, contract]) => {
      assert.ok(contract && typeof contract === 'object')
      if (
        ('internal' in contract && contract.internal) ||
        ('aliasOf' in contract && contract.aliasOf)
      )
        return []
      assert.ok('group' in contract && typeof contract.group === 'string')
      return [{ name, group: contract.group }]
    })
    const foundations = publicContracts
      .filter((contract) => contract.group === GROUPS.foundations)
      .map(({ name }) => name)
      .sort()
    assert.ok(foundations.length > 0)
    assert.deepEqual(
      (
        await directory
          .locator('[data-category="foundations"] [data-export]')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-export')))
      ).sort(),
      foundations
    )
    await expect(directory.locator('[data-category="missing"]')).toHaveCount(0)
    const entries = await directory.locator('[data-export]').evaluateAll((nodes) =>
      nodes.map((node) => ({
        name: node.getAttribute('data-export')!,
        number: node.getAttribute('data-scene-number'),
        aliases: JSON.parse(node.getAttribute('data-aliases')!) as string[],
      }))
    )
    const discovered = await page.evaluate(
      async (url) => {
        const { entries } = await import(url)
        return entries.map((entry: { name: string }) => entry.name).sort()
      },
      `/@fs/${normalizePath(resolve(DESKTOP, '../../packages/ui/preview/inventory.js'))}`
    )
    assert.deepEqual(entries.map((entry) => entry.name).sort(), discovered)
    assert.deepEqual(
      entries.map((entry) => entry.number),
      entries.map((_, index) => String(index + conversationEntries.length))
    )
    assert.deepEqual(entries.find((entry) => entry.name === 'FileMenuItems')?.aliases, [
      'ArtifactMenuItems',
    ])
    for (const { name } of entries) {
      await directory.locator(`[data-export="${name}"]`).click()
      await expect(page.getByTestId('preview-answer')).toHaveAttribute('data-sample', name)
      await expect(page.getByTestId('preview-render-error')).toHaveCount(0)
      await expect(page.getByTestId('preview-data-state')).toHaveCount(0)
    }
    await directory.locator('[data-export="CitationLink"]').click()
    await page.getByRole('button', { name: '长文件名与长引用', exact: true }).click()
    const longMarker = page.getByTestId('preview-component').getByRole('button', {
      name: /用于展示长文件名换行的研究阅读笔记与不同任务边界比较\.md/,
    })
    await expect(longMarker).toHaveCSS('max-width', 'min(100%, 180px)')
    const truncatedName = longMarker.getByText(
      '用于展示长文件名换行的研究阅读笔记与不同任务边界比较',
      { exact: true }
    )
    await expect(truncatedName).toHaveCSS('text-overflow', 'ellipsis')
    assert.ok(await truncatedName.evaluate((element) => element.scrollWidth > element.clientWidth))
    await expect(longMarker.getByText('.md', { exact: true })).toBeVisible()
    if (process.env.CITATION_MARKER_SCREENSHOT) {
      await longMarker.screenshot({ path: process.env.CITATION_MARKER_SCREENSHOT })
    }
    await directory.locator('[data-export="Markdown"]').click()
    await page.getByRole('button', { name: '编辑 JSON', exact: true }).click()
    const dialogBounds = (await page.getByRole('dialog').boundingBox())!
    const editorBounds = (await page
      .getByRole('textbox', { name: '数据 JSON', exact: true })
      .boundingBox())!
    assert.ok(dialogBounds.width >= 1000)
    assert.ok(dialogBounds.height >= 800)
    assert.ok(editorBounds.height >= 500)
    await page
      .getByRole('textbox', { name: '数据 JSON', exact: true })
      .fill(JSON.stringify({ text: 'Shared official material', math: true }))
    await expect(page.getByTestId('preview-component')).toContainText('Shared official material')
    await page.keyboard.press('Escape')
    await directory.locator('[data-export="BarChart"]').click()
    await directory.locator('[data-export="Markdown"]').click()
    await expect(page.getByTestId('preview-component')).toContainText('Shared official material')
    await page.getByRole('button', { name: 'English', exact: true }).click()
    await expect(directory.getByRole('heading', { name: 'Charts', exact: true })).toBeVisible()
    await expect(directory.getByRole('heading', { name: 'Foundations', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Edit JSON', exact: true })).toBeVisible()
    await expect(page.locator('iframe')).toHaveCount(0)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
    await server.close()
  }
})
