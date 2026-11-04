import { test, expect, _electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { buildPdfe, pdfeEnvironment } from '../scripts/dev/pdfe.mjs'
import { PREVIEW_CATALOG } from './catalog.ts'
import { PREVIEW_HOME } from './home.ts'
import { PREVIEW_ARCHIVE } from './archive.ts'
import { previewConsumption } from './coverage.ts'
import { parsePdfeManifest, PDFE_CONTROL_SIZE, PDFE_DOCK_STEP, pdfeDockWidth } from '../src/pdfe.ts'
import { WORKSPACE_WINDOW_SIZE } from '../src/window.ts'
import zh from './locales/zh.json' with { type: 'json' }
import en from './locales/en.json' with { type: 'json' }
import { projectCenterAppearance } from '../e2e/fixtures/appearance.ts'

const require = createRequire(import.meta.url)
const desktop = fileURLToPath(new URL('..', import.meta.url))
const INITIAL_TARGET_ANNOTATION = 'pdfe-initial-target'
const CENTER_MATRIX_TIMEOUT_MS = 180_000
let application
let server
let manifest
let app
let product
let controls

test.beforeAll(async () => {
  server = await createServer({ configFile: resolve(desktop, 'vite.preview.config.ts'), clearScreen: false, server: { strictPort: false } })
  await server.listen()
  application = await buildPdfe(server.resolvedUrls.local[0].replace(/\/$/, ''))
  manifest = JSON.parse(readFileSync(resolve(application, 'pdfe.json'), 'utf8'))
})

test.beforeEach(async ({}, testInfo) => {
  const requested = testInfo.annotations.find(annotation => annotation.type === INITIAL_TARGET_ANNOTATION)
  const initial = requested ? JSON.parse(requested.description) : manifest.initial
  const configured = parsePdfeManifest({ ...manifest, initial })
  writeFileSync(resolve(application, 'pdfe.json'), JSON.stringify(configured), { mode: 0o600 })
  app = await _electron.launch({ executablePath: require('electron'), args: [application], env: pdfeEnvironment({ ...process.env, OPENAI_API_KEY: 'pdfe-test-must-not-forward' }), timeout: 60_000 })
  await expect.poll(() => app.windows().filter(page => page.url().includes('pdfe=')).length).toBe(2)
  product = app.windows().find(page => new URL(page.url()).searchParams.get('pdfe') === 'product')
  controls = app.windows().find(page => new URL(page.url()).searchParams.get('pdfe') === 'controls')
  await expect(product).toHaveURL(url => url.searchParams.get('page') === initial.pageId && url.searchParams.get('scene') === initial.sceneId)
  await expect(controls).toHaveURL(url => url.searchParams.get('page') === initial.pageId && url.searchParams.get('scene') === initial.sceneId)
  if (!requested) await expect(product.getByTestId('home-project-设计协作项目')).toBeVisible()
  await expect(controls.getByRole('heading', { name: 'PDFE 工作台', exact: true })).toBeVisible()
})

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) for (const [index, page] of (app?.windows() ?? []).entries()) if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('native-failure-' + index + '.png') })
  await app?.close()
  const response = await fetch(manifest.origin + '/__preview/state?previewInstance=' + manifest.instance, { method: 'DELETE' })
  expect([200, 404]).toContain(response.status)
})

test.afterAll(async () => { await server?.close() })

async function scenario(pageId, sceneId, dictionary = zh) {
  const entry = PREVIEW_CATALOG.find(page => page.id === pageId)
  expect(entry?.scenarios.some(scene => scene.id === sceneId)).toBe(true)
  const current = new URL(product.url())
  if (current.searchParams.get('page') === pageId && current.searchParams.get('scene') === sceneId) {
    await expect(controls).toHaveURL(url => url.searchParams.get('page') === pageId && url.searchParams.get('scene') === sceneId)
    return
  }
  if (entry.launch?.kind === 'components') {
    await controls.getByRole('tab', { name: dictionary.componentsEntry, exact: true }).click()
    await expect(product).toHaveURL(url => url.searchParams.get('page') === pageId)
    return
  }
  const features = controls.getByRole('tab', { name: dictionary.featureSection, exact: true })
  if (await features.getAttribute('aria-selected') !== 'true') await features.click()
  expect(entry.navigation, 'hidden legacy entries require an explicit initial target, not a restored product navigation button').not.toBe('hidden')
  await controls.getByRole('searchbox').fill(sceneId)
  await controls.getByTestId('preview-scene-' + pageId + '-' + sceneId).click()
  await expect(product).toHaveURL(url => url.searchParams.get('page') === pageId && url.searchParams.get('scene') === sceneId)
  await expect(controls).toHaveURL(url => url.searchParams.get('page') === pageId && url.searchParams.get('scene') === sceneId)
}

async function reloadCenter(action) {
  await Promise.all([
    product.waitForEvent('framenavigated', frame => frame === product.mainFrame()),
    controls.waitForEvent('framenavigated', frame => frame === controls.mainFrame()),
    action(),
  ])
  await expect(product.getByTestId('project-center')).toBeVisible()
}

for (const mode of ['single', 'batch']) {
  test(`archives project ${mode} deletion preserves the failure reason and allows retry`, { annotation: [
    { type: INITIAL_TARGET_ANNOTATION, description: JSON.stringify({ pageId: 'settings-archives', sceneId: 'settings-archives-write-failed' }) },
    previewConsumption('settings-archives', 'settings-archives-write-failed', ['error', 'retried', 'deleted']),
  ] }, async ({}, testInfo) => {
    const remove = product.locator('[data-testid^="account-archived-delete-"]').first()
    await expect(remove).toBeVisible()
    const identifier = await remove.getAttribute('data-testid')
    const row = product.getByTestId(identifier.replace('account-archived-delete-', 'account-archived-'))
    if (mode === 'batch') {
      await product.getByTestId('account-archived-select-all').click()
      await product.getByTestId('account-archived-batch-delete').click()
    } else {
      await remove.click()
    }
    const dialog = product.getByRole('alertdialog')
    await dialog.getByTestId('account-archived-delete-confirm').click()
    await expect(dialog).not.toBeVisible()
    await expect(product.getByText(`未能移除项目（${PREVIEW_ARCHIVE.writeFailure}），请确认原因后重试。`, { exact: true })).toBeVisible()
    await expect(product.getByText('操作失败（unknown_project）', { exact: true })).toHaveCount(0)
    await expect(row).toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('deletion-failure.png') })
    await row.getByTestId(identifier).click()
    await dialog.getByTestId('account-archived-delete-confirm').click()
    await expect(row).toHaveCount(0)
  })
}

test('literature grid surfaces cover every configured column when horizontally scrolled', { annotation: { type: INITIAL_TARGET_ANNOTATION, description: JSON.stringify({ pageId: 'page-literature', sceneId: 'library-populated' }) } }, async () => {
  await scenario('page-literature', 'library-populated')
  await expect(product.locator('.lit-row').first()).toBeVisible()
  const table = product.locator('.lit-table')
  await table.evaluate(element => { element.scrollLeft = element.scrollWidth })
  for (const selector of ['.lit-table-head', '.lit-row']) {
    for (const surface of await table.locator(selector).all()) {
      const geometry = await surface.evaluate(element => {
        const tracks = getComputedStyle(element).gridTemplateColumns.split(' ').map(parseFloat)
        return { width: element.clientWidth, columnsWidth: tracks.reduce((total, width) => total + width, 0) }
      })
      expect(geometry.width).toBeGreaterThanOrEqual(geometry.columnsWidth)
    }
  }
  await product.getByRole('button', { name: '展开附件', exact: true }).first().click()
  await expect(table.locator('.lit-attachment-row').first()).toBeVisible()
  const headerWidth = await table.locator('.lit-table-head').evaluate(element => element.clientWidth)
  for (const attachment of await table.locator('.lit-attachment-row').all()) {
    expect(await attachment.evaluate(element => element.clientWidth)).toBe(headerWidth)
  }
})

test('native product uses top-level shared renderer, real OS fonts and isolated secure windows', async ({}, testInfo) => {
  const observed = await product.evaluate(async () => {
    const fonts = await window.scholarseed.listOfficeFonts()
    return { platform: window.scholarseed.platform, kind: window.pdfe.kind, dock: window.pdfe.dock, topLevel: window.top === window, legacyViewport: Boolean(document.getElementById('scholarseed-preview-viewport')), width: innerWidth, height: innerHeight, faceCount: fonts.faceCount, fontFiles: fonts.fonts.length }
  })
  expect(observed).toMatchObject({ platform: process.platform, kind: 'product', dock: 'docked', topLevel: true, legacyViewport: false, width: WORKSPACE_WINDOW_SIZE.width - pdfeDockWidth(WORKSPACE_WINDOW_SIZE.width, PDFE_CONTROL_SIZE.width), height: WORKSPACE_WINDOW_SIZE.height })
  expect(observed.faceCount).toBeGreaterThan(1)
  expect(observed.fontFiles).toBeGreaterThan(1)
  expect(await app.evaluate(() => process.env.OPENAI_API_KEY)).toBeUndefined()
  const systemVersion = await app.evaluate(() => process.getSystemVersion())
  expect(await product.evaluate(() => window.scholarseed.systemVersion)).toContain(systemVersion)
  const profile = await app.evaluate(({ app }) => app.getPath('userData'))
  expect(basename(profile)).toMatch(/^scholarseed-pdfe-/)
  const native = await app.browserWindow(product)
  expect(await native.evaluate(window => window.contentView.children.length)).toBe(2)
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), children: window.contentView.children.length })))
  expect(windows).toEqual(expect.arrayContaining([{ visible: true, children: 2 }, { visible: false, children: 0 }]))
  expect(windows.filter(window => window.visible)).toHaveLength(1)
  await expect(controls.getByRole('button', { name: '独立弹出', exact: true })).toBeVisible()
  const isolation = await native.evaluate(window => {
    const preferences = window.contentView.children[0].webContents.getLastWebPreferences()
    return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration }
  })
  expect(isolation).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false })
  writeFileSync(testInfo.outputPath('native-diagnostics.json'), JSON.stringify({ ...observed, ...isolation, profile }, null, 2))
  await product.screenshot({ path: testInfo.outputPath('pdfe-native-product.png') })
  await controls.screenshot({ path: testInfo.outputPath('pdfe-native-controls.png') })
  const layout = await native.evaluate(window => ({ size: window.getContentSize(), views: window.contentView.children.map(view => ({ bounds: view.getBounds(), url: view.webContents.getURL() })) }))
  expect(layout.views[0].bounds).toEqual({ x: 0, y: 0, width: observed.width, height: observed.height })
  expect(layout.views[1].bounds).toEqual({ x: observed.width, y: 0, width: layout.size[0] - observed.width, height: observed.height })
  writeFileSync(testInfo.outputPath('pdfe-native-default-docked.json'), JSON.stringify(layout, null, 2))
})

test('native scenario controls, F8 and help preserve the same product draft and component entry', async ({}, testInfo) => {
  await controls.getByRole('button', { name: '独立弹出', exact: true }).click()
  await scenario('page-conversation', 'conversation-stream')
  const composer = product.getByTestId('composer-input')
  await composer.fill('原生 PDFE 草稿保持')
  const original = await composer.elementHandle()
  const nativeControls = await app.browserWindow(controls)
  await controls.getByRole('button', { name: '收起工作台', exact: true }).click()
  await expect.poll(() => nativeControls.evaluate(window => window.isVisible())).toBe(false)
  const nativeProduct = await app.browserWindow(product)
  await nativeProduct.evaluate(window => {
    window.focus()
    window.contentView.children[0].webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F8' })
    window.contentView.children[0].webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F8' })
  })
  await expect.poll(() => nativeControls.evaluate(window => window.isVisible())).toBe(true)
  await expect(composer).toHaveValue('原生 PDFE 草稿保持')
  expect(await composer.evaluate((node, prior) => node === prior, original)).toBe(true)
  await controls.getByRole('button', { name: '使用说明', exact: true }).click()
  const guide = controls.getByRole('dialog', { name: '使用说明', exact: true })
  await expect(guide).toBeVisible()
  await controls.screenshot({ path: testInfo.outputPath('pdfe-native-guide.png') })
  await controls.keyboard.press('Escape')
  await expect(guide).not.toBeVisible()
  await expect(composer).toHaveValue('原生 PDFE 草稿保持')
  await product.screenshot({ path: testInfo.outputPath('pdfe-native-conversation.png') })
  await scenario('development-components', 'components-states')
  await expect(product.getByRole('heading', { name: 'Veda Design System', exact: true })).toBeVisible()
  await product.screenshot({ path: testInfo.outputPath('pdfe-native-components.png') })
})

test('native docked resizing preserves project form and workbench search without dock transitions', async ({}, testInfo) => {
  await product.getByTestId('home-project-create-top').click()
  const name = product.getByTestId('project-create-name')
  await name.fill('停靠调宽保留输入')
  const originalName = await name.elementHandle()
  const search = controls.getByRole('searchbox')
  await search.fill('home')
  const originalSearch = await search.elementHandle()
  const productDocument = await product.locator('html').elementHandle()
  const controlsDocument = await controls.locator('html').elementHandle()
  const workspace = await app.browserWindow(product)
  const width = await product.evaluate(() => innerWidth)
  const total = await workspace.evaluate(window => window.getContentSize()[0])
  const divider = controls.getByRole('separator', { name: zh.resizeWorkbench, exact: true })
  await divider.press('ArrowLeft')
  await expect.poll(() => product.evaluate(() => innerWidth)).toBe(width - PDFE_DOCK_STEP)
  expect(await product.evaluate(() => innerWidth) + await controls.evaluate(() => innerWidth)).toBe(total)
  await expect(name).toHaveValue('停靠调宽保留输入')
  await expect(search).toHaveValue('home')
  expect(await name.evaluate((node, original) => node === original, originalName)).toBe(true)
  expect(await search.evaluate((node, original) => node === original, originalSearch)).toBe(true)
  expect(await product.locator('html').evaluate((node, original) => node === original, productDocument)).toBe(true)
  expect(await controls.locator('html').evaluate((node, original) => node === original, controlsDocument)).toBe(true)
  await product.screenshot({ path: testInfo.outputPath('native-resize-project-form.png') })
  await divider.hover()
  await controls.screenshot({ path: testInfo.outputPath('native-resize-divider-hover.png') })
  const layout = await workspace.evaluate(window => ({
    size: window.getContentSize(),
    views: window.contentView.children.map(view => ({ bounds: view.getBounds(), url: view.webContents.getURL() }))
  }))
  expect(layout.views.map(view => view.bounds)).toEqual([
    { x: 0, y: 0, width: width - PDFE_DOCK_STEP, height: layout.size[1] },
    { x: width - PDFE_DOCK_STEP, y: 0, width: total - width + PDFE_DOCK_STEP, height: layout.size[1] }
  ])
  writeFileSync(testInfo.outputPath('native-resize-layout.json'), JSON.stringify(layout, null, 2))
  await divider.press('ArrowRight')
  await expect.poll(() => product.evaluate(() => innerWidth)).toBe(width)
  await expect(name).toHaveValue('停靠调宽保留输入')
  await expect(search).toHaveValue('home')
  for (const { target, clamped } of [
    { target: pdfeDockWidth(total, total), clamped: true },
    { target: pdfeDockWidth(total, 0), clamped: true },
    { target: total - width, clamped: false }
  ]) {
    const current = await controls.evaluate(() => innerWidth)
    const direction = target > current ? 'ArrowLeft' : 'ArrowRight'
    const steps = Math.ceil(Math.abs(target - current) / PDFE_DOCK_STEP) + Number(clamped)
    for (let index = 0; index < steps; index += 1) {
      const previous = await controls.evaluate(() => innerWidth)
      const expected = pdfeDockWidth(total, previous + (direction === 'ArrowLeft' ? PDFE_DOCK_STEP : -PDFE_DOCK_STEP))
      await divider.press(direction)
      await expect.poll(() => controls.evaluate(() => innerWidth)).toBe(expected)
    }
    await expect.poll(() => controls.evaluate(() => innerWidth)).toBe(target)
    await expect(name).toHaveValue('停靠调宽保留输入')
    await expect(search).toHaveValue('home')
    expect(await product.locator('html').evaluate((node, original) => node === original, productDocument)).toBe(true)
    expect(await controls.locator('html').evaluate((node, original) => node === original, controlsDocument)).toBe(true)
    if (target === pdfeDockWidth(total, total)) {
      await product.screenshot({ path: testInfo.outputPath('native-resize-narrow-product-form.png') })
    }
  }
})

test('native scrollbar thumbs keep token colors and geometry in both themes', async ({}, testInfo) => {
  await scenario('viewer-markdown', 'viewer-markdown-states')
  await expect(product.getByRole('heading', { name: 'Minimal Project', exact: true })).toBeVisible()
  const observations = []
  for (const theme of ['light', 'dark']) {
    const choice = controls.locator('#preview-theme')
    if ((await choice.textContent())?.trim() !== zh[theme]) {
      await choice.click()
      await Promise.all([
        product.waitForEvent('framenavigated', frame => frame === product.mainFrame()),
        controls.waitForEvent('framenavigated', frame => frame === controls.mainFrame()),
        controls.getByRole('option', { name: zh[theme], exact: true }).click(),
      ])
    }
    await expect(product.locator('.vds-markdown-crepe > .milkdown')).toBeVisible()
    await product.getByTestId('markdown-mode-select').click()
    await product.getByTestId('markdown-open-editor').click()
    const editor = product.locator('[data-testid="markdown-visual-editor"] .ProseMirror[contenteditable="true"]')
    await editor.fill(Array.from({ length: 64 }, (_, index) => `滚动条验收段落 ${index + 1}：保留主题颜色、边框和滚动能力。`).join('\n\n'))
    const observed = await product.evaluate(() => {
      const root = document.getElementById('root')
      const viewport = document.querySelector('[data-testid="markdown-visual-editor"] > .milkdown')
      if (!root || !viewport) throw new Error('Expected real product scroll containers')
      const values = getComputedStyle(viewport)
      const token = name => values.getPropertyValue(name).trim()
      const describe = element => {
        const thumb = getComputedStyle(element, '::-webkit-scrollbar-thumb')
        return { color: thumb.backgroundColor.replaceAll(' ', ''), border: thumb.borderTopWidth, radius: thumb.borderTopLeftRadius, clip: thumb.backgroundClip }
      }
      return {
        theme: document.documentElement.dataset.theme,
        global: describe(root), editor: describe(viewport),
        scrollbar: getComputedStyle(viewport, '::-webkit-scrollbar').width,
        expected: {
          color: token('--vds-scrollbar-thumb').replaceAll(' ', ''),
          globalBorder: token('--vds-border-width-2'), globalRadius: token('--vds-radius-3'),
          editorBorder: token('--vds-border-width-3'), editorRadius: token('--vds-radius-4'),
          scrollbar: token('--vds-space-3'),
        },
        scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight,
      }
    })
    expect(observed.theme).toBe(theme)
    expect(observed.global).toEqual({ color: observed.expected.color, border: observed.expected.globalBorder, radius: observed.expected.globalRadius, clip: 'content-box' })
    expect(observed.editor).toEqual({ color: observed.expected.color, border: observed.expected.editorBorder, radius: observed.expected.editorRadius, clip: 'padding-box' })
    expect(observed.scrollbar).toBe(observed.expected.scrollbar)
    expect(observed.scrollHeight).toBeGreaterThan(observed.clientHeight)
    const viewport = product.locator('[data-testid="markdown-visual-editor"] > .milkdown')
    await viewport.hover()
    await product.mouse.wheel(0, observed.clientHeight)
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await product.screenshot({ path: testInfo.outputPath('native-scrollbar-' + theme + '.png') })
    observations.push(observed)
  }
  expect(observations[0].editor.color).not.toBe(observations[1].editor.color)
  writeFileSync(testInfo.outputPath('native-scrollbar-styles.json'), JSON.stringify(observations, null, 2))
})

test('native dock and detach preserve both renderer documents, draft and workbench search', async ({}, testInfo) => {
  await controls.getByRole('button', { name: '独立弹出', exact: true }).click()
  await scenario('page-conversation', 'conversation-stream')
  const composer = product.getByTestId('composer-input')
  await composer.fill('停靠与独立弹出时保持草稿')
  const original = await composer.elementHandle()
  const search = controls.getByRole('searchbox')
  await search.fill('conversation')
  const originalSearch = await search.elementHandle()
  const popup = await app.browserWindow(controls)
  const workspace = await app.browserWindow(product)
  await controls.getByRole('button', { name: '窗口内停靠', exact: true }).click()
  await expect(controls.getByRole('button', { name: '独立弹出', exact: true })).toBeVisible()
  await expect.poll(() => popup.evaluate(window => window.isVisible())).toBe(false)
  expect(await workspace.evaluate(window => window.contentView.children.length)).toBe(2)
  const dockedWidth = await product.evaluate(() => innerWidth)
  const totalWidth = await workspace.evaluate(window => window.getContentSize()[0])
  writeFileSync(testInfo.outputPath('docked-view-tree.json'), JSON.stringify(await workspace.evaluate(window => {
    const describe = view => ({ type: view.constructor.name, bounds: view.getBounds(), ...(view.webContents ? { url: view.webContents.getURL() } : {}), children: view.children.map(describe) })
    return describe(window.contentView)
  }), null, 2))
  expect(dockedWidth + await controls.evaluate(() => innerWidth)).toBe(totalWidth)
  await expect(composer).toHaveValue('停靠与独立弹出时保持草稿')
  expect(await composer.evaluate((node, prior) => node === prior, original)).toBe(true)
  await expect(search).toHaveValue('conversation')
  expect(await search.evaluate((node, prior) => node === prior, originalSearch)).toBe(true)
  const divider = controls.getByRole('separator', { name: '调整工作台宽度', exact: true })
  await divider.focus()
  await divider.press('ArrowLeft')
  await expect.poll(() => product.evaluate(() => innerWidth)).toBe(dockedWidth - 20)
  await controls.getByRole('button', { name: '收起工作台', exact: true }).click()
  await expect.poll(() => product.evaluate(() => innerWidth)).toBe(totalWidth)
  await workspace.evaluate(window => {
    window.contentView.children[0].webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F8' })
    window.contentView.children[0].webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F8' })
  })
  await expect(divider).toBeVisible()
  await expect.poll(() => product.evaluate(() => innerWidth)).toBe(dockedWidth - 20)
  await expect(search).toHaveValue('conversation')
  await product.screenshot({ path: testInfo.outputPath('pdfe-docked-product.png') })
  await controls.screenshot({ path: testInfo.outputPath('pdfe-docked-controls.png') })
  await controls.getByRole('button', { name: '独立弹出', exact: true }).click()
  await expect.poll(() => popup.evaluate(window => window.isVisible())).toBe(true)
  await expect(controls.getByRole('button', { name: '窗口内停靠', exact: true })).toBeVisible()
  expect(await workspace.evaluate(window => window.contentView.children.length)).toBe(1)
  await expect.poll(() => product.evaluate(() => innerWidth)).toBe(totalWidth)
  await expect(composer).toHaveValue('停靠与独立弹出时保持草稿')
  expect(await composer.evaluate((node, prior) => node === prior, original)).toBe(true)
  await expect(search).toHaveValue('conversation')
  await controls.screenshot({ path: testInfo.outputPath('pdfe-detached-controls.png') })
  await expect(product.evaluate(() => window.pdfe.setDock('docked'))).rejects.toThrow('Invalid PDFE sender')
  await expect(controls.evaluate(() => window.pdfe.setDock('invalid'))).rejects.toThrow('Invalid PDFE dock mode')
})

test('native workbench navigation and help preserve product form input and return from UI assets', async ({}, testInfo) => {
  await scenario('page-home', 'home-empty')
  await product.getByTestId('home-project-create-empty').click()
  const input = product.getByTestId('project-create-name')
  const draft = '工作台浏览期间保留未提交项目'
  await input.fill(draft)
  const original = await input.elementHandle()
  const location = product.url()
  const daily = controls.getByTestId('preview-section-page-home-areaDaily')
  const boundaries = controls.getByTestId('preview-section-page-home-areaBoundaries')
  await expect(daily).toHaveAttribute('aria-expanded', 'true')
  await boundaries.click()
  await expect(daily).toHaveAttribute('aria-expanded', 'true')
  await expect(boundaries).toHaveAttribute('aria-expanded', 'true')
  const projectPages = controls.getByTestId('preview-family-page-home-homeProjectBoundaryGroup')
  const taskPages = controls.getByTestId('preview-family-page-home-homeTaskBoundaryGroup')
  await projectPages.click()
  await taskPages.click()
  await expect(projectPages).toHaveAttribute('aria-expanded', 'true')
  await expect(taskPages).toHaveAttribute('aria-expanded', 'true')
  const search = controls.getByRole('searchbox')
  await search.fill('home-projects-' + (PREVIEW_HOME.projectPage + 1))
  await expect(controls.getByTestId('preview-scene-page-home-home-projects-' + (PREVIEW_HOME.projectPage + 1))).toBeVisible()
  await search.clear()
  for (const section of [daily, boundaries, projectPages, taskPages]) await expect(section).toHaveAttribute('aria-expanded', 'true')
  expect(product.url()).toBe(location)
  await expect(input).toHaveValue(draft)
  expect(await input.evaluate((node, prior) => node === prior, original)).toBe(true)

  const help = controls.getByRole('button', { name: zh.guide, exact: true })
  await help.click()
  const guide = controls.getByRole('dialog', { name: zh.guide, exact: true })
  await expect(guide).toBeVisible()
  await expect(guide.getByText(zh.homeEmptyExpected, { exact: true })).toBeVisible()
  await guide.getByRole('button', { name: zh.guideCommon, exact: true }).click()
  await expect(guide).toContainText(zh.publicControlScope)
  await controls.screenshot({ animations: 'disabled', path: testInfo.outputPath('native-workbench-guide.png') })
  await guide.press('Escape')
  await expect(guide).toHaveCount(0)
  await expect(help).toBeFocused()
  await expect(input).toHaveValue(draft)
  expect(await input.evaluate((node, prior) => node === prior, original)).toBe(true)
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('native-form-draft-preserved.png') })
  await product.getByTestId('project-new-modal').getByRole('button', { name: '取消', exact: true }).click()
  await scenario('development-components', 'components-states')
  await expect(product.getByRole('heading', { name: 'Veda Design System', exact: true })).toBeVisible()
  await controls.getByRole('tab', { name: zh.featureSection, exact: true }).click()
  await expect(product).toHaveURL(url => url.searchParams.get('page') === 'page-home' && url.searchParams.get('scene') === 'home-empty')
  await expect(product.getByTestId('home-projects-empty')).toBeVisible()
  await expect(product.getByTestId('home-tasks-empty')).toBeVisible()
})

test('native component examples support real light/dark, Chinese/English and keyboard controls', { annotation: previewConsumption('development-components', 'components-states', ['light', 'dark', 'zh', 'en', 'keyboard']) }, async ({}, testInfo) => {
  await scenario('development-components', 'components-states')
  await expect(product.getByRole('heading', { name: 'Veda Design System', exact: true })).toBeVisible()
  await expect(product.locator('html')).toHaveAttribute('data-theme', 'light')
  const english = product.getByRole('button', { name: 'English', exact: true })
  await english.focus()
  await english.press('Space')
  await expect(product.getByRole('heading', { name: 'Label and Form', exact: true })).toBeVisible()
  await expect(product.getByText('Foundation component state matrix', { exact: true })).toBeVisible()
  await product.locator('#theme-preview-mode').click()
  await product.getByRole('option', { name: /dark/i }).click()
  await expect(product.locator('html')).toHaveAttribute('data-theme', 'dark')
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('pdfe-native-components-dark-english.png') })
  await product.getByRole('button', { name: '中文', exact: true }).click()
  await expect(product.getByText('项目名称', { exact: true })).toBeVisible()
})

test('native home and project search operate the shared product navigation', { annotation: [previewConsumption('page-projects', 'projects-browse', ['populated', 'filtered', 'no-match', 'opened']), { type: INITIAL_TARGET_ANNOTATION, description: JSON.stringify({ pageId: 'page-projects', sceneId: 'projects-browse' }) }] }, async ({}, testInfo) => {
  await scenario('page-projects', 'projects-browse')
  const card = product.getByTestId('project-card-设计协作项目')
  const search = product.getByTestId('projects-search')
  await expect(card).toBeVisible()
  await search.fill('pdfe-no-matching-project')
  await expect(product.getByTestId('projects-empty')).toBeVisible()
  await expect(card).toHaveCount(0)
  await search.fill('设计协作')
  await expect(card).toBeVisible()
  await card.getByRole('button').first().click()
  await expect(product.getByTestId('project-navigation-selector')).toContainText('设计协作项目')
  await product.screenshot({ path: testInfo.outputPath('pdfe-native-project-opened.png') })
  await scenario('page-home', 'home-browse')
  await expect(product.getByTestId('home-tasks-list')).toContainText('设计协作演示')
  await product.getByTestId('home-project-设计协作项目').click()
  await expect(product.getByTestId('project-navigation-selector')).toContainText('设计协作项目')
})

test('native project creation preserves failed form input and retries successfully', { annotation: [previewConsumption('page-projects', 'projects-create-failure', ['submitting', 'failed', 'retry', 'completed']), { type: INITIAL_TARGET_ANNOTATION, description: JSON.stringify({ pageId: 'page-projects', sceneId: 'projects-create-failure' }) }] }, async ({}, testInfo) => {
  await scenario('page-projects', 'projects-create-failure')
  await product.getByRole('button', { name: '项目中心', exact: true }).click()
  await expect(product.getByTestId('project-center')).toBeVisible()
  await product.getByTestId('home-project-create-top').click()
  const form = product.getByTestId('project-new-modal')
  const name = '原生 Mock 失败重试'
  await product.getByTestId('project-create-name').fill(name)
  await product.getByTestId('project-create').click()
  await expect(form.getByText('无法创建项目，请重试。', { exact: true }).first()).toBeVisible()
  await expect(product.getByTestId('project-create-name')).toHaveValue(name)
  await expect(product.getByTestId('project-create')).toBeEnabled()
  await product.screenshot({ path: testInfo.outputPath('pdfe-native-project-failure.png') })
  await product.getByTestId('project-create').click()
  await expect(form).not.toBeVisible()
  await expect(product.getByRole('button', { name, exact: true })).toBeVisible()
  await product.getByRole('button', { name: '返回项目中心', exact: true }).click()
  await expect(product.getByTestId('home-project-' + name)).toHaveCount(1)
  await expect(product.getByTestId('home-project-' + name)).toBeVisible()
  await product.screenshot({ path: testInfo.outputPath('pdfe-native-project-retried.png') })
})

test('native project center consumes every declared data policy through workbench navigation', async ({}, testInfo) => {
  test.setTimeout(CENTER_MATRIX_TIMEOUT_MS)
  const observations = []
  const errors = []
  product.on('pageerror', error => errors.push(error.message))
  const projects = product.getByTestId('home-projects-grid').locator('button[data-testid^="home-project-"]:not([aria-haspopup])')
  const tasks = product.locator('[data-testid^="home-task-"]')
  const collect = async (rows, previous, next, total, capacity) => {
    const identities = []
    if (total === 0 && await previous.count() === 0) {
      await expect(rows).toHaveCount(0)
      await expect(next).toHaveCount(0)
      return identities
    }
    await expect(previous).toBeDisabled()
    for (let offset = 0; offset < Math.max(total, 1); offset += capacity) {
      await expect(rows).toHaveCount(Math.min(capacity, Math.max(total - offset, 0)))
      identities.push(...await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-testid'))))
      if (offset + capacity >= total) await expect(next).toBeDisabled()
      else {
        await expect(next).toBeEnabled()
        const firstIdentity = await rows.first().getAttribute('data-testid')
        await next.click()
        await expect(rows.first()).not.toHaveAttribute('data-testid', firstIdentity)
        await expect(previous).toBeEnabled()
      }
    }
    expect(identities).toHaveLength(total)
    expect(new Set(identities).size).toBe(total)
    return identities
  }
  for (const entry of PREVIEW_CATALOG.find(page => page.id === 'page-home').scenarios) {
    await scenario('page-home', entry.id)
    if (entry.home.projectRead === 'failed') {
      await expect(product.getByRole('button', { name: '重新加载', exact: true })).toBeVisible()
      await expect(product.getByTestId('home-projects-empty')).toHaveCount(0)
      await controls.getByTestId('preview-home-projects-recover').click()
      await product.getByRole('button', { name: '重新加载', exact: true }).click()
    }
    await expect(product.getByTestId('project-center')).toBeVisible()
    const policy = entry.home
    if (policy.read === 'fail-once') {
      await expect(product.getByTestId('project-center').getByRole('status').filter({ hasText: '无法读取任务，请重试' })).toBeVisible()
      await expect(product.getByTestId('home-tasks-empty')).toHaveCount(0)
      await product.getByRole('button', { name: '重试', exact: true }).click()
    }
    await expect(projects).toHaveCount(Math.min(policy.projects, PREVIEW_HOME.projectPage))
    await expect(tasks).toHaveCount(Math.min(policy.tasks, PREVIEW_HOME.taskPage))
    if (policy.projects === 0) await expect(product.getByTestId('home-projects-empty')).toBeVisible()
    else await expect(product.getByTestId('home-projects-empty')).toHaveCount(0)
    if (policy.tasks === 0) await expect(product.getByTestId('home-tasks-empty')).toBeVisible()
    else await expect(product.getByTestId('home-tasks-empty')).toHaveCount(0)
    const projectIds = await collect(projects, product.getByTestId('home-projects-previous'), product.getByTestId('home-projects-next'), policy.projects, PREVIEW_HOME.projectPage)
    const taskIds = await collect(tasks, product.getByTestId('home-tasks-previous'), product.getByTestId('home-tasks-next'), policy.tasks, PREVIEW_HOME.taskPage)
    expect(await product.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    observations.push({ sceneId: entry.id, policy, projectIds, taskIds })
    if (['home-empty', 'home-no-tasks', 'home-dense', 'home-long-content', 'home-cross-batch'].includes(entry.id)) await product.screenshot({ path: testInfo.outputPath(entry.id + '.png') })
    if (entry.id === 'home-empty') {
      await product.getByTestId('home-tasks-empty').scrollIntoViewIfNeeded()
      await product.screenshot({ path: testInfo.outputPath('home-empty-tasks.png') })
    }
    if (entry.id === 'home-cross-batch') {
      await product.getByTestId('home-task-preview-session-' + policy.tasks).click()
      await expect(product.getByTestId('composer-input')).toBeEditable()
      await product.getByTestId('project-navigation-home').click()
      await expect(product.getByTestId('project-center')).toBeVisible()
      await expect(tasks).toHaveCount(PREVIEW_HOME.taskPage)
    }
  }
  expect(errors).toEqual([])
  writeFileSync(testInfo.outputPath('project-center-observations.json'), JSON.stringify(observations, null, 2))
})

test('native project center distinguishes task loading, read failure and successful retry from emptiness', async ({}, testInfo) => {
  const responses = []
  product.on('response', response => {
    if (new URL(response.url()).pathname === '/api/serve/sessions') responses.push({ url: response.url(), status: response.status() })
  })
  try {
  const center = product.getByTestId('project-center')
  const tasks = product.locator('[data-testid^="home-task-"]')
  await scenario('page-home', 'home-task-loading')
  await expect(center.locator('[role="status"][aria-label]')).toBeVisible()
  await expect(product.getByTestId('home-tasks-empty')).toHaveCount(0)
  await expect(tasks).toHaveCount(0)
  const native = await app.browserWindow(product)
  const loadingImage = await native.evaluate(async window => (await window.contentView.children[0].webContents.capturePage()).toPNG().toString('base64'))
  writeFileSync(testInfo.outputPath('native-task-loading.png'), Buffer.from(loadingImage, 'base64'))
  await expect(center.locator('[role="status"][aria-label]')).toBeVisible()
  await expect(tasks).toHaveCount(1)
  await expect(center.locator('[role="status"][aria-label]')).toHaveCount(0)
  const failed = product.waitForResponse(response => new URL(response.url()).pathname === '/api/serve/sessions' && response.status() === 503)
  await scenario('page-home', 'home-task-retry')
  expect((await failed).status()).toBe(503)
  await expect(center.getByRole('status').filter({ hasText: '无法读取任务，请重试' })).toBeVisible()
  await expect(product.getByTestId('home-tasks-empty')).toHaveCount(0)
  await expect(tasks).toHaveCount(0)
  await product.screenshot({ path: testInfo.outputPath('native-task-read-failed.png') })
  await center.getByRole('button', { name: '重试', exact: true }).click()
  await expect(tasks).toHaveCount(1)
  await expect(center.getByRole('status').filter({ hasText: '无法读取任务，请重试' })).toHaveCount(0)
  await product.screenshot({ path: testInfo.outputPath('native-task-read-recovered.png') })
  await reloadCenter(() => controls.getByRole('button', { name: zh.reset, exact: true }).click())
  await expect(center.getByRole('status').filter({ hasText: '无法读取任务，请重试' })).toBeVisible()
  } finally {
    writeFileSync(testInfo.outputPath('task-read-responses.json'), JSON.stringify(responses, null, 2))
  }
})

test('native project catalog loading and persistent failure recover through real controls without fake emptiness', async ({}, testInfo) => {
  const responses = []
  product.on('response', response => {
    if (new URL(response.url()).pathname === '/api/content/projects') responses.push({ url: response.url(), status: response.status() })
  })
  try {
    await scenario('page-home', 'home-project-read-loading')
    await expect(product.getByText('正在加载工作台', { exact: true })).toBeVisible()
    await expect(product.getByTestId('home-projects-empty')).toHaveCount(0)
    const native = await app.browserWindow(product)
    const loading = await native.evaluate(async window => (await window.contentView.children[0].webContents.capturePage()).toPNG().toString('base64'))
    writeFileSync(testInfo.outputPath('native-project-read-loading.png'), Buffer.from(loading, 'base64'))
    await expect(product.getByTestId('home-project-设计协作项目')).toBeVisible()
    await scenario('page-home', 'home-project-read-failed')
    const retry = product.getByRole('button', { name: '重新加载', exact: true })
    await expect(retry).toBeVisible()
    await expect(product.getByText('工作台数据暂时无法加载', { exact: true })).toBeVisible()
    await expect(product.getByText('本地服务未返回完整的项目或任务目录，可以重新加载。', { exact: true })).toBeVisible()
    await expect(product.getByTestId('home-projects-empty')).toHaveCount(0)
    const failedAgain = product.waitForResponse(response => new URL(response.url()).pathname === '/api/content/projects' && response.status() === 503)
    await retry.click()
    await failedAgain
    await expect(retry).toBeVisible()
    await expect(product.getByRole('button', { name: '返回项目中心', exact: true })).toBeDisabled()
    await expect(product.getByTestId('home-projects-empty')).toHaveCount(0)
    await expect(retry).toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('native-project-read-failed.png') })
    await controls.getByTestId('preview-home-projects-recover').click()
    await retry.click()
    await expect(product.getByTestId('home-project-设计协作项目')).toBeVisible()
    await expect(product.locator('[data-testid^="home-task-"]')).toHaveCount(1)
    await product.screenshot({ path: testInfo.outputPath('native-project-read-recovered.png') })
    await Promise.all([
      product.waitForEvent('framenavigated', frame => frame === product.mainFrame()),
      controls.waitForEvent('framenavigated', frame => frame === controls.mainFrame()),
      controls.getByRole('button', { name: zh.reset, exact: true }).click(),
    ])
    await expect(product.getByRole('button', { name: '重新加载', exact: true })).toBeVisible()
    await controls.getByRole('combobox', { name: zh.language, exact: true }).click()
    await Promise.all([
      product.waitForEvent('framenavigated', frame => frame === product.mainFrame()),
      controls.waitForEvent('framenavigated', frame => frame === controls.mainFrame()),
      controls.getByRole('option', { name: zh.english, exact: true }).click(),
    ])
    await expect(product.getByText('Workspace data could not be loaded', { exact: true })).toBeVisible()
    await expect(product.getByRole('button', { name: 'Back to Project Center', exact: true })).toBeDisabled()
    await product.screenshot({ path: testInfo.outputPath('native-project-read-failed-en.png') })
    await controls.getByTestId('preview-home-projects-recover').click()
    await product.getByRole('button', { name: 'Reload', exact: true }).click()
    await expect(product.getByTestId('home-project-设计协作项目')).toBeVisible()
  } finally {
    writeFileSync(testInfo.outputPath('project-read-responses.json'), JSON.stringify(responses, null, 2))
  }
})

test('native project center creates from empty, edits, pins and archives across page boundaries', { timeout: 90_000 }, async ({}, testInfo) => {
  const errors = []
  product.on('pageerror', error => errors.push(error.message))
  const stateUrl = new URL('/__preview/state', manifest.origin)
  stateUrl.searchParams.set('previewInstance', manifest.instance)
  const snapshot = async () => {
    const response = await product.request.get(stateUrl.href)
    expect(response.ok()).toBe(true)
    return response.json()
  }
  await scenario('page-home', 'home-empty')
  await product.getByTestId('home-project-create-empty').click()
  const createdName = '原生空态创建项目'
  await product.getByTestId('project-create-name').fill(createdName)
  await product.getByTestId('project-create').click()
  await expect(product.getByTestId('project-new-modal')).toHaveCount(0)
  await expect(product.getByTestId('project-navigation-selector')).toContainText(createdName)
  await product.getByTestId('project-navigation-home').click()
  await expect(product.getByTestId('home-project-' + createdName)).toBeVisible()
  await expect(product.getByTestId('home-tasks-empty')).toBeVisible()
  const created = await snapshot()
  expect(created.projects).toHaveLength(1)
  expect(created.sessions).toHaveLength(0)
  await product.screenshot({ path: testInfo.outputPath('native-created-from-empty.png') })
  await reloadCenter(() => controls.getByRole('button', { name: zh.reload, exact: true }).click())
  await expect(product.getByTestId('home-project-' + createdName)).toBeVisible()
  expect((await snapshot()).projects).toEqual(created.projects)
  await reloadCenter(() => controls.getByRole('button', { name: zh.reset, exact: true }).click())
  await expect(product.getByTestId('home-projects-empty')).toBeVisible()
  await expect(product.getByTestId('home-tasks-empty')).toBeVisible()
  expect((await snapshot()).projects).toHaveLength(0)

  await scenario('page-home', 'home-project-actions')
  const original = await snapshot()
  const edited = original.projects[PREVIEW_HOME.projectPage]
  const archived = original.projects[PREVIEW_HOME.projectPage - 1]
  await product.getByTestId('home-projects-next').click()
  await product.getByTestId('home-project-' + edited.name).hover()
  await product.getByTestId('home-project-menu-' + edited.id).click()
  await product.getByTestId('home-rename-' + edited.id).click()
  const renamed = '原生编辑并置顶的项目'
  await product.getByTestId('project-edit-name').fill(renamed)
  await product.getByTestId('project-save').click()
  await expect(product.getByTestId('project-edit-modal')).toHaveCount(0)
  await expect(product.getByTestId('home-project-' + renamed)).toBeVisible()
  await product.getByTestId('home-project-' + renamed).hover()
  await product.getByTestId('home-project-menu-' + edited.id).click()
  await product.getByTestId('home-pin-' + edited.id).click()
  await expect(product.getByTestId('home-project-' + archived.name)).toBeVisible()
  await product.getByTestId('home-projects-previous').click()
  const projects = product.getByTestId('home-projects-grid').locator('button[data-testid^="home-project-"]:not([aria-haspopup])')
  await expect(projects.first()).toContainText(renamed)
  await product.screenshot({ path: testInfo.outputPath('native-edited-pinned.png') })
  await product.getByTestId('home-project-' + renamed).click()
  await expect(product.getByTestId('project-navigation-selector')).toContainText(renamed)
  await product.getByTestId('project-navigation-home').click()
  await expect(product.getByTestId('project-center')).toBeVisible()
  await product.getByTestId('home-projects-next').click()
  await product.getByTestId('home-project-' + archived.name).hover()
  await product.getByTestId('home-project-menu-' + archived.id).click()
  await product.getByTestId('home-archive-' + archived.id).click()
  await expect(product.getByRole('alertdialog')).toBeVisible()
  await product.getByTestId('home-archive-confirm').click()
  await expect(product.getByRole('alertdialog')).toHaveCount(0)
  await expect(projects).toHaveCount(PREVIEW_HOME.projectPage)
  await expect(product.getByTestId('home-projects-previous')).toBeDisabled()
  await expect(product.getByTestId('home-projects-next')).toBeDisabled()
  await expect(product.getByTestId('home-project-' + archived.name)).toHaveCount(0)
  const changed = await snapshot()
  expect(changed.projects.find(project => project.id === edited.id)).toMatchObject({ name: renamed, pinned: true })
  expect(changed.projects.find(project => project.id === archived.id)).toMatchObject({ archived_at: expect.any(Number) })
  expect(changed.projects.filter(project => !project.archived_at)).toHaveLength(PREVIEW_HOME.projectPage)
  await product.screenshot({ path: testInfo.outputPath('native-archive-clamped.png') })
  expect(errors).toEqual([])
  writeFileSync(testInfo.outputPath('native-project-mutations.json'), JSON.stringify({ createdProjectIds: created.projects.map(project => project.id), editedId: edited.id, archivedId: archived.id, activeProjectIds: changed.projects.filter(project => !project.archived_at).map(project => project.id) }, null, 2))
})

test('native credits report explicit unavailability while preserving simulated login', async ({}, testInfo) => {
  const login = controls.getByRole('combobox', { name: zh.loginState, exact: true })
  await expect(login).toBeEnabled()
  await login.click()
  await reloadCenter(() => controls.getByRole('option', { name: zh.mockLoggedOut, exact: true }).click())
  const reading = product.waitForResponse(response => new URL(response.url()).pathname === '/api/account/credits')
  await login.click()
  await reloadCenter(() => controls.getByRole('option', { name: zh.mockLoggedIn, exact: true }).click())
  const response = await reading
  expect(response.status()).toBe(503)
  expect(await response.json()).toEqual({ code: 'preview_credits_unavailable' })
  await product.getByTestId('activity-account').click()
  await expect(product.getByTestId('account-menu-name')).toContainText('模拟协作账号')
  await expect(product.getByTestId('account-menu-credits-value')).toHaveText('--')
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('native-credits-unavailable.png') })
  await controls.getByRole('button', { name: zh.tools, exact: true }).click()
  await controls.getByRole('button', { name: zh.refresh, exact: true }).click()
  const history = controls.getByTestId('preview-diagnostic-history')
  await expect(history).toBeVisible()
  const diagnostics = JSON.parse(await history.innerText())
  expect(diagnostics.requests).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/api/account/credits', status: 503, outcome: 'completed' })]))
  await history.scrollIntoViewIfNeeded()
  await controls.screenshot({ animations: 'disabled', path: testInfo.outputPath('native-credits-diagnostics.png') })
  writeFileSync(testInfo.outputPath('native-credits-diagnostics.json'), JSON.stringify(diagnostics, null, 2))
})

test('native project center records appearance under normal host conditions', { timeout: 120_000 }, async ({}, testInfo) => {
  await controls.getByRole('button', { name: zh.detachWorkbench, exact: true }).click()
  await scenario('page-home', 'home-no-tasks')
  let dictionary = zh
  const observations = []
  for (const theme of ['light', 'dark']) for (const language of ['zh', 'en']) {
    for (const [label, value] of [[dictionary.theme, dictionary[theme]], [dictionary.language, language === 'en' ? dictionary.english : dictionary.chinese]]) {
      const choice = controls.getByRole('combobox', { name: label, exact: true })
      if ((await choice.textContent())?.trim() !== value) {
        await choice.click()
        await reloadCenter(() => controls.getByRole('option', { name: value, exact: true }).click())
      }
    }
    dictionary = language === 'en' ? en : zh
    const nativeProduct = await app.browserWindow(product)
    await nativeProduct.evaluate(window => { window.focus(); window.contentView.children[0].webContents.focus() })
    await expect.poll(() => product.evaluate(() => document.hasFocus())).toBe(true)
    await expect(product.getByTestId('home-tasks-empty')).toBeVisible()
    await expect(product.locator('html')).toHaveAttribute('data-theme', theme)
    const center = await projectCenterAppearance(product, 'center')
    expect(center.environment).toMatchObject(WORKSPACE_WINDOW_SIZE)
    await product.screenshot({ path: testInfo.outputPath('pdfe-center-' + theme + '-' + language + '.png') })
    await product.getByTestId('home-project-create-top').click()
    await product.getByTestId('project-create-name').fill('PDFE交付核对')
    const form = await projectCenterAppearance(product, 'form')
    await product.screenshot({ path: testInfo.outputPath('pdfe-form-' + theme + '-' + language + '.png') })
    observations.push({ theme, language, data: 'Mock home-no-tasks projects; no tasks', center, form })
    await product.keyboard.press('Escape')
    await expect(product.getByTestId('project-new-modal')).toHaveCount(0)
  }
  writeFileSync(testInfo.outputPath('appearance.json'), JSON.stringify(observations, null, 2))
})

test('native project center follows host theme notifications without reloading either document', async ({}, testInfo) => {
  const errors = []
  for (const page of [product, controls]) page.on('pageerror', error => errors.push(error.message))
  await controls.getByRole('combobox', { name: zh.theme, exact: true }).click()
  await reloadCenter(() => controls.getByRole('option', { name: zh.system, exact: true }).click())
  await controls.getByRole('searchbox').fill('home-no-tasks')
  for (const page of [product, controls]) await page.emulateMedia({ colorScheme: null })
  const documents = await Promise.all([product, controls].map(page => page.locator('html').elementHandle()))
  const originalSource = await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)
  const observations = []
  try {
    for (const theme of ['dark', 'light']) {
      await app.evaluate(({ nativeTheme }, source) => { nativeTheme.themeSource = source }, theme)
      for (const [index, page] of [product, controls].entries()) {
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        expect(await documents[index].evaluate(element => element === document.documentElement)).toBe(true)
        expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark')
      }
      await expect(controls.getByRole('combobox', { name: zh.theme, exact: true })).toContainText(zh.system)
      await expect(controls.getByRole('searchbox')).toHaveValue('home-no-tasks')
      await expect(product.getByTestId('home-project-设计协作项目')).toBeVisible()
      observations.push({ theme, host: await app.evaluate(({ nativeTheme }) => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors })) })
      await product.screenshot({ path: testInfo.outputPath('native-system-theme-' + theme + '.png') })
    }
  } finally {
    await app.evaluate(({ nativeTheme }, source) => { nativeTheme.themeSource = source }, originalSource)
  }
  expect(errors).toEqual([])
  writeFileSync(testInfo.outputPath('native-system-theme.json'), JSON.stringify({ stimulus: 'test-owned Electron nativeTheme.themeSource; no OS settings changed', observations }, null, 2))
})

test('native project center retains global login, theme and language through navigation and reset', { timeout: 120_000 }, async ({}, testInfo) => {
  const errors = []
  for (const page of [product, controls]) page.on('pageerror', error => errors.push(error.message))
  const stateUrl = new URL('/__preview/state', manifest.origin)
  stateUrl.searchParams.set('previewInstance', manifest.instance)
  const snapshot = async () => {
    const response = await product.request.get(stateUrl.href)
    expect(response.ok()).toBe(true)
    return response.json()
  }
  let dictionary = zh
  const choose = async (label, option) => {
    await controls.getByRole('combobox', { name: label, exact: true }).click()
    await reloadCenter(() => controls.getByRole('option', { name: option, exact: true }).click())
  }
  const observations = []
  await scenario('page-home', 'home-no-tasks')
  const original = await snapshot()
  for (const combination of [
    { login: 'anonymous', theme: 'dark', language: 'en' },
    { login: 'ready', theme: 'light', language: 'zh' },
  ]) {
    await expect(controls.getByRole('combobox', { name: dictionary.loginState })).toBeEnabled()
    await choose(dictionary.loginState, combination.login === 'ready' ? dictionary.mockLoggedIn : dictionary.mockLoggedOut)
    await choose(dictionary.theme, dictionary[combination.theme])
    await choose(dictionary.language, combination.language === 'en' ? dictionary.english : dictionary.chinese)
    dictionary = combination.language === 'en' ? en : zh
    const unchanged = await snapshot()
    expect(unchanged.projects).toEqual(original.projects)
    expect(unchanged.sessions).toEqual(original.sessions)
    for (const sceneId of ['home-empty', 'home-no-tasks']) {
      await scenario('page-home', sceneId, dictionary)
      await expect(product.getByTestId('home-tasks-empty')).toBeVisible()
      if (sceneId === 'home-empty') await expect(product.getByTestId('home-projects-empty')).toBeVisible()
      await reloadCenter(() => controls.getByRole('button', { name: dictionary.reset, exact: true }).click())
      const current = await snapshot()
      expect(current.account.mode).toBe(combination.login)
      expect(current.preferences).toMatchObject({ theme: combination.theme, language: combination.language })
      expect(current.projects).toHaveLength(sceneId === 'home-empty' ? 0 : original.projects.length)
      expect(current.sessions).toHaveLength(0)
      for (const page of [product, controls]) await expect(page.locator('html')).toHaveAttribute('data-theme', combination.theme)
      await expect(controls.getByRole('combobox', { name: dictionary.loginState })).toContainText(combination.login === 'ready' ? dictionary.mockLoggedIn : dictionary.mockLoggedOut)
      await expect(controls.getByRole('combobox', { name: dictionary.language })).toContainText(combination.language === 'en' ? dictionary.english : dictionary.chinese)
      observations.push({ sceneId, combination, projectCount: current.projects.length, taskCount: current.sessions.length })
    }
    await product.getByTestId('activity-account').click()
    if (combination.login === 'anonymous') await expect(product.getByTestId('account-menu-anonymous-login')).toBeVisible()
    else await expect(product.getByTestId('account-menu-name')).toContainText('模拟协作账号')
    await product.screenshot({ path: testInfo.outputPath('native-account-' + combination.login + '.png') })
    await product.getByTestId('activity-account').click()
    await controls.screenshot({ path: testInfo.outputPath('native-controls-' + combination.language + '.png') })
  }
  expect(errors).toEqual([])
  writeFileSync(testInfo.outputPath('native-global-observations.json'), JSON.stringify(observations, null, 2))
})

test('native long stream cancellation persists its interrupted answer through actual product reentry', { annotation: previewConsumption('page-conversation', 'conversation-cancel', ['streaming', 'cancelling', 'cancelled']) }, async ({}, testInfo) => {
  await scenario('page-conversation', 'conversation-cancel')
  const question = '原生工作台中断后重新进入'
  const sending = product.waitForResponse(response => /\/api\/serve\/sessions\/[^/]+\/turns$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
  await product.getByTestId('composer-input').fill(question)
  await product.getByTestId('composer-send').click()
  const accepted = await sending
  expect(accepted.status()).toBe(200)
  const receipt = await accepted.json()
  expect(receipt).toMatchObject({ ok: true, accepted: true })
  const sessionId = decodeURIComponent(new URL(accepted.url()).pathname.split('/').at(-2))
  const answers = product.locator('.answer-annotation-root').filter({ hasText: '开始模拟长回答。' })
  await expect(answers).toHaveCount(1)
  const stop = product.getByTestId('composer-stop')
  await expect(stop).toBeEnabled()
  const interrupting = product.waitForResponse(response => new URL(response.url()).pathname.endsWith('/interrupt') && response.request().method() === 'POST')
  await stop.click()
  expect((await interrupting).status()).toBe(200)
  await expect(stop).not.toBeVisible()
  const prefix = await answers.innerText()
  expect(prefix).not.toContain('模拟长回答已完成。')
  await product.screenshot({ path: testInfo.outputPath('pdfe-native-stream-cancelled.png') })
  const home = product.getByRole('button', { name: '返回首页', exact: true })
  if (await home.isVisible()) await home.click()
  else await product.getByRole('button', { name: '返回项目中心', exact: true }).click()
  const reading = product.waitForResponse(response => new URL(response.url()).pathname === '/api/serve/history/' + encodeURIComponent(sessionId))
  await product.getByTestId('home-task-preview-session').click()
  const history = await (await reading).json()
  const events = history.activity_events.filter(event => event.turn_id === receipt.turn_id)
  expect(events.filter(event => event.type === 'turn_interrupted')).toHaveLength(1)
  expect(events.filter(event => event.type === 'turn_completed')).toEqual([])
  expect(history.turn_activity.find(turn => turn.turn_id === receipt.turn_id)?.outcome).toBe('interrupted')
  await expect(answers).toHaveText(prefix)
  await expect(product.getByTestId('user-bubble').getByText(question, { exact: true })).toHaveCount(1)
  await product.screenshot({ path: testInfo.outputPath('pdfe-native-stream-reentered.png') })
})

for (const entry of PREVIEW_CATALOG.filter(page => page.target || page.host)) {
  test('native page entry: ' + entry.id, { annotation: entry.navigation === 'hidden' ? { type: INITIAL_TARGET_ANNOTATION, description: JSON.stringify({ pageId: entry.id, sceneId: entry.scenarios[0].id }) } : [] }, async ({}, testInfo) => {
    const errors = []
    product.on('pageerror', error => errors.push(error.message))
    await scenario(entry.id, entry.scenarios[0].id)
    await expect(product.locator('#root')).not.toBeEmpty()
    await expect(product.getByText('预览启动失败。请检查预览服务和启动日志。', { exact: true })).not.toBeVisible()
    if (entry.host?.kind === 'panel') {
      const trigger = product.getByTestId('preview-panel-open')
      await expect(trigger).toBeInViewport()
      await trigger.click()
      await expect(product.getByTestId('preview-panel-sheet')).toBeVisible()
      await product.getByTestId('preview-panel-close').click()
      await expect(product.getByTestId('preview-panel-sheet')).not.toBeVisible()
      const geometry = await product.locator('.vds-app-shell').evaluate(shell => ({ bottom: shell.getBoundingClientRect().bottom, viewport: innerHeight }))
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewport)
    }
    await product.screenshot({ path: testInfo.outputPath('pdfe-native-entry.png') })
    expect(errors).toEqual([])
    writeFileSync(testInfo.outputPath('entry-observation.json'), JSON.stringify({ pageId: entry.id, sceneId: entry.scenarios[0].id, level: 'entry-only', errors }, null, 2))
  })
}

for (const group of ['ui', 'primitive', 'business']) {
  test('native component example navigation: ' + group, async ({}, testInfo) => {
    const errors = []
    product.on('pageerror', error => errors.push(error.message))
    await scenario('development-components', 'components-states')
    await expect(product.getByRole('heading', { name: 'Veda Design System', exact: true })).toBeVisible()
    const trigger = product.getByRole('button', { name: new RegExp('components/' + group) })
    if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
    const contentId = await trigger.getAttribute('aria-controls')
    expect(contentId).toBeTruthy()
    const menu = product.locator('[id="' + contentId + '"]')
    const labels = await menu.getByRole('button').allTextContents()
    expect(labels.length).toBeGreaterThan(0)
    const observations = []
    for (const label of labels) {
      const action = menu.getByRole('button', { name: label.trim(), exact: true })
      await action.click()
      await expect(action).toHaveAttribute('aria-current', 'page')
      const sections = product.locator('section[id]:visible')
      await expect(sections.first()).toBeVisible()
      observations.push({ label: label.trim(), sections: await sections.evaluateAll(elements => elements.map(element => element.id)) })
    }
    expect(errors).toEqual([])
    writeFileSync(testInfo.outputPath('component-navigation.json'), JSON.stringify({ group, level: 'navigation-only', observations, errors }, null, 2))
    await product.screenshot({ path: testInfo.outputPath('pdfe-native-component-navigation.png') })
  })
}
