import { test, expect, _electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { buildPdfe, pdfeEnvironment } from '../scripts/dev/pdfe.mjs'
import { PREVIEW_CATALOG } from './catalog.ts'
import { PREVIEW_HOME } from './home.ts'
import { PREVIEW_ARCHIVE } from './archive.ts'
import { conversationEntries } from '../src/renderer/src/components/examples/navigation.ts'
import { API_DIAGNOSTIC_PREFIX, SESSION_CATALOG_PATH } from '../src/requests.ts'
import { NOTIFICATION_PATH } from '../src/notifications.ts'
import { previewConsumption } from './coverage.ts'
import { parsePdfeManifest, PDFE_CONTROL_SIZE, PDFE_DOCK_STEP, pdfeDockWidth, pdfeWindowWidth, PREVIEW_INSTANCE_PARAMETER, PREVIEW_PAGE_PARAMETER, PREVIEW_SCENE_PARAMETER } from '../src/pdfe.ts'
import { WORKSPACE_WINDOW_SIZE, WORKSPACE_WINDOW_MINIMUM } from '../src/window.ts'
import zh from './locales/zh.json' with { type: 'json' }
import en from './locales/en.json' with { type: 'json' }
import { projectCenterAppearance } from '../e2e/fixtures/appearance.ts'
import { DIALOG_APPLICATIONS } from './dialogs.ts'
import { PREVIEW_AUTHORIZATION } from './authorization.ts'
import { PREVIEW_CREDITS } from './accounts.ts'
import { resolveExample } from '../../../scripts/shared/examples.cjs'
import { WINDOW_CLOSE_ACTION } from '../src/window.ts'
import { PREVIEW_DIAGNOSTIC_EVENT } from './bridge.ts'
import { defaultSelectionPrompts } from '../src/prompts.ts'
import { PREVIEW_DOCUMENTS } from './documents.ts'
import { PREVIEW_SEARCH } from './searches.ts'
import { PREVIEW_OFFICE_FRAME_PATH, previewOfficeFrameParameters } from './frames.ts'
import { PREVIEW_CONTENT } from './content.ts'
import { PREVIEW_ARTIFACTS } from './publications.ts'
import { PREVIEW_CONVERSATION } from './conversation.ts'
import { previewContextReferences, previewDraftReferences } from './references.ts'
import layoutZh from '../src/localization/locales/zh/layout.json' with { type: 'json' }
import layoutEn from '../src/localization/locales/en/layout.json' with { type: 'json' }
import assistantZh from '../src/localization/locales/zh/assistant.json' with { type: 'json' }
import uiZh from '../src/localization/locales/zh/ui.json' with { type: 'json' }
import uiEn from '../src/localization/locales/en/ui.json' with { type: 'json' }
import shellZh from '../src/localization/locales/zh/shell.json' with { type: 'json' }
import literatureZh from '../src/localization/locales/zh/literature.json' with { type: 'json' }
import literatureEn from '../src/localization/locales/en/literature.json' with { type: 'json' }
import skillsZh from '../src/localization/locales/zh/skills.json' with { type: 'json' }
import { PREVIEW_LITERATURE } from './literature.ts'
import { PREVIEW_BROWSER } from './browser.ts'
import { BROWSER_ERROR } from '../src/browser.ts'
import browserZh from '../src/localization/locales/zh/browser.json' with { type: 'json' }
import browserEn from '../src/localization/locales/en/browser.json' with { type: 'json' }
import { PREVIEW_DEVELOPER } from './developer.ts'
import { PREVIEW_STORAGE } from './storage.ts'
import { PREVIEW_STORAGE_READ } from './directory.ts'
import { PREVIEW_BROWSING } from './listing.ts'
import { PREVIEW_PROJECT_ID, PREVIEW_RUNTIME_RECONFIGURATION } from './constants.ts'
import componentsZh from '../src/localization/locales/zh/components.json' with { type: 'json' }
import componentsEn from '../src/localization/locales/en/components.json' with { type: 'json' }
import accountZh from '../src/localization/locales/zh/account.json' with { type: 'json' }
import accountEn from '../src/localization/locales/en/account.json' with { type: 'json' }
import conversationZh from '../src/localization/locales/zh/conversation.json' with { type: 'json' }
import conversationEn from '../src/localization/locales/en/conversation.json' with { type: 'json' }
import workbenchZh from '../src/localization/locales/zh/workbench.json' with { type: 'json' }
import { LOCALES } from '../src/localization/catalog.ts'
import { SKILLS_PATH } from '../src/skills.ts'

const require = createRequire(import.meta.url)

const desktop = fileURLToPath(new URL('..', import.meta.url))

const INITIAL_TARGET_ANNOTATION = 'pdfe-initial-target'
const MATERIALS_INITIAL_TARGET = { type: INITIAL_TARGET_ANNOTATION, description: JSON.stringify({ pageId: 'development-components', sceneId: 'components-states' }) }
const NATIVE_EVIDENCE_ROLES = ['product', 'controls']
const NATIVE_EVIDENCE_STATUS = { captured: 'captured', hidden: 'hidden', unavailable: 'unavailable', failed: 'failed' }
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const OUTPUT_READS = {
  catalog: '/api/serve/task-files',
  files: /^\/api\/serve\/sessions\/[^/]+\/files$/,
  raw: /^\/api\/serve\/sessions\/[^/]+\/files\/raw$/,
  snapshot: /^\/api\/serve\/sessions\/[^/]+\/artifacts\/[^/]+\/(raw|content)$/,
}

const CENTER_MATRIX_TIMEOUT_MS = 180_000
const FRAME_GEOMETRY_ROUNDING_PX = 1
const LITERATURE_PATH = '/api/v1/literatures'
const LITERATURE_COLLECTIONS_PATH = '/api/v1/collections'
const ARCHIVE_PROJECTS_PATH = '/api/content/projects'
const ARCHIVE_SESSIONS_PATH = '/api/serve/sessions'
const ARCHIVE_HISTORY_PATH = '/api/serve/history/'
const FEEDBACK_SUBMISSION_PATH = '/api/serve/feedback'
const REFERENCE_CONTEXT_PATH = /^\/api\/assistant\/sessions\/[^/]+\/context$/
const BOOTSTRAP_READ_PATHS = new Set([ARCHIVE_PROJECTS_PATH, SESSION_CATALOG_PATH, NOTIFICATION_PATH, '/api/healthz'])

const DIALOG_ACTION_TIMEOUT_MS = 15_000
const COMPOSER_FOCUS_FRAME_MS = 16
const DELIVERY_TIMEOUT_MS = PREVIEW_CONVERSATION.interruptibleChunks.length * PREVIEW_CONVERSATION.interruptibleIntervalMs + 5_000
const CONVERSATION_EXPECTED = {
  prefix: '开始模拟长回答。',
  suffix: '模拟长回答已完成。',
  answer: '这里复用真实产品组件与事件投影。',
  diagnostic: '[session-stream] ',
  route: /^\/api\/serve\/sessions\/([^/]+)\/(events|turns|interrupt|hil\/[^/]+)$/,
}

const DIALOG_SHORTCUT_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control'

let application

let app

let server

let manifest

let product

let controls

test.beforeAll(async () => {
  server = await createServer({ configFile: resolve(desktop, 'vite.preview.config.ts'), clearScreen: false, server: { strictPort: false } })
  // Native acceptance runs against fixed source; metadata-only file events must not reset a scenario.
  await server.watcher.close()
  await server.listen()
  application = await buildPdfe(server.resolvedUrls.local[0].replace(/\/$/, ''))
  manifest = JSON.parse(readFileSync(resolve(application, 'pdfe.json'), 'utf8'))
})

test.beforeEach(async ({}, testInfo) => {
  app = undefined
  product = undefined
  controls = undefined
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

async function nativeEvidenceSurfaces() {
  if (!app) return []
  return app.evaluate(({ BrowserWindow, WebContentsView }, roles) => BrowserWindow.getAllWindows().flatMap(window => window.contentView.children.flatMap(view => {
    if (!(view instanceof WebContentsView) || view.webContents.isDestroyed()) return []
    const url = view.webContents.getURL()
    if (!url) return []
    const role = new URL(url).searchParams.get('pdfe')
    return roles.includes(role) ? [{ role, url, windowId: window.id, contentsId: view.webContents.id, windowVisible: window.isVisible(), minimized: window.isMinimized(), viewVisible: view.getVisible(), bounds: view.getBounds() }] : []
  })), NATIVE_EVIDENCE_ROLES)
}

async function captureNativeFailure(testInfo, prefix = 'native-failure') {
  const native = await nativeEvidenceSurfaces()
  const surfaces = []
  const failures = []
  for (const role of NATIVE_EVIDENCE_ROLES) {
    const current = native.find(surface => surface.role === role)
    if (!current) {
      surfaces.push({ role, status: NATIVE_EVIDENCE_STATUS.unavailable })
      continue
    }
    const { url, ...state } = current
    if (!state.windowVisible || state.minimized || !state.viewVisible || state.bounds.width <= 0 || state.bounds.height <= 0) {
      surfaces.push({ ...state, status: NATIVE_EVIDENCE_STATUS.hidden })
      continue
    }
    try {
      const page = app.windows().find(page => !page.isClosed() && page.url() === url)
      if (!page) throw new Error('PDFE visible surface has no live renderer: ' + role)
      const path = testInfo.outputPath(prefix + '-' + role + '.png')
      const focus = await page.evaluate(() => ({
        documentFocused: document.hasFocus(),
        active: {
          tag: document.activeElement?.tagName ?? null,
          testId: document.activeElement?.getAttribute('data-testid') ?? null,
          role: document.activeElement?.getAttribute('role') ?? null,
        },
        menus: [...document.querySelectorAll('[role="menu"]')].map(menu => ({
          testId: menu.getAttribute('data-testid'),
          visible: menu.getClientRects().length > 0 && getComputedStyle(menu).visibility !== 'hidden',
          activeWithin: menu.contains(document.activeElement),
        })),
      }))
      await page.screenshot({ path, timeout: DIALOG_ACTION_TIMEOUT_MS })
      surfaces.push({ ...state, status: NATIVE_EVIDENCE_STATUS.captured, path, focus })
    } catch (error) {
      failures.push(error)
      surfaces.push({ ...state, status: NATIVE_EVIDENCE_STATUS.failed, error: error.message })
    }
  }
  writeFileSync(testInfo.outputPath(prefix + '-surfaces.json'), JSON.stringify({ applicationAvailable: Boolean(app), surfaces }, null, 2))
  if (failures.length) throw new AggregateError(failures, 'PDFE failure screenshots failed')
  return surfaces.filter(surface => surface.status === NATIVE_EVIDENCE_STATUS.captured).map(surface => surface.role)
}

test.afterEach(async ({}, testInfo) => {
  const failures = []
  try {
    if (testInfo.status !== testInfo.expectedStatus) await captureNativeFailure(testInfo)
  } catch (error) {
    failures.push(error)
  }
  try {
    await app?.close()
  } catch (error) {
    failures.push(error)
  }
  try {
    if (manifest) {
      const response = await fetch(manifest.origin + '/__preview/state?previewInstance=' + manifest.instance, { method: 'DELETE', signal: AbortSignal.timeout(DIALOG_ACTION_TIMEOUT_MS) })
      expect([200, 404]).toContain(response.status)
    }
  } catch (error) {
    failures.push(error)
  }
  if (failures.length) throw new AggregateError(failures, 'PDFE evidence or cleanup failed')
})

test.afterAll(async () => { await server?.close() })

test('native failure evidence captures rendered surfaces without showing hidden controls', async ({}, testInfo) => {
  await product.getByTestId('home-project-设计协作项目').focus()
  expect(await captureNativeFailure(testInfo, 'visible')).toEqual(['product', 'controls'])
  const visible = JSON.parse(readFileSync(testInfo.outputPath('visible-surfaces.json'), 'utf8'))
  expect(visible.surfaces[0].focus.active.testId).toBe('home-project-设计协作项目')
  for (const surface of visible.surfaces) {
    expect(typeof surface.focus.documentFocused).toBe('boolean')
    expect(typeof surface.focus.active.tag).toBe('string')
    expect(surface.focus.menus).toEqual([])
  }
  for (const role of NATIVE_EVIDENCE_ROLES) expect(readFileSync(testInfo.outputPath('visible-' + role + '.png')).subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE)
  const screenshot = product.screenshot.bind(product)
  const injected = 'injected screenshot failure'
  product.screenshot = async () => { throw new Error(injected) }
  try {
    await expect(captureNativeFailure(testInfo, 'failed')).rejects.toThrow('PDFE failure screenshots failed')
  } finally {
    product.screenshot = screenshot
  }
  const failure = JSON.parse(readFileSync(testInfo.outputPath('failed-surfaces.json'), 'utf8'))
  expect(failure.surfaces.map(surface => ({ role: surface.role, status: surface.status }))).toEqual([{ role: 'product', status: 'failed' }, { role: 'controls', status: 'captured' }])
  expect(failure.surfaces[0].error).toBe(injected)
  expect(readFileSync(testInfo.outputPath('failed-controls.png')).subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE)
  await controls.getByRole('button', { name: zh.close, exact: true }).click()
  await expect.poll(async () => (await nativeEvidenceSurfaces()).find(surface => surface.role === 'controls')?.viewVisible).toBe(false)
  expect(await captureNativeFailure(testInfo, 'hidden')).toEqual(['product'])
  expect(readFileSync(testInfo.outputPath('hidden-product.png')).subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE)
  expect(existsSync(testInfo.outputPath('hidden-controls.png'))).toBe(false)
  const hidden = JSON.parse(readFileSync(testInfo.outputPath('hidden-surfaces.json'), 'utf8'))
  expect(hidden.surfaces.map(surface => ({ role: surface.role, status: surface.status }))).toEqual([{ role: 'product', status: 'captured' }, { role: 'controls', status: 'hidden' }])
  expect((await nativeEvidenceSurfaces()).find(surface => surface.role === 'controls').viewVisible).toBe(false)
})

test('native conversation directory follows prototype categories and marks unbuilt entries', async ({}, testInfo) => {
  await scenario('development-components', 'components-states')
  await product.getByRole('button', { name: /会话组件/ }).click()
  const directory = product.getByTestId('conversation-directory')
  const official = directory.getByTestId('official-directory')
  const prototypeEntries = directory.locator('[data-construction]')
  await expect(directory.getByRole('group')).toHaveCount(8)
  expect(await directory.getByRole('heading').allTextContents()).toEqual(['用户输入', '处理过程', '确认与澄清', '正文与富内容', '图表', '引用、证据与上下文', '附件、产物与工作台', '基础组件'])
  await expect(prototypeEntries).toHaveCount(conversationEntries.length)
  expect(await prototypeEntries.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-scene-number')))).toEqual(conversationEntries.map(entry => entry.number))
  await expect(official.getByTestId('openui-directory')).toBeVisible()
  await expect(directory.locator('[data-construction="unbuilt"]')).toHaveCount(1)
  await directory.getByRole('button', { name: '插件安装卡片', exact: true }).click()
  const installation = product.getByTestId('plugin-installation-card')
  await expect(installation).toBeVisible()
  await expect(installation.getByRole('status')).toHaveText(skillsZh.installation.states.pending)
  await expect(installation.getByRole('button')).toHaveCount(3)
  for (const label of [skillsZh.installation.generatedDirectory, skillsZh.installation.install, skillsZh.installation.defer]) {
    await expect(installation.getByRole('button', { name: label, exact: true })).toBeEnabled()
  }
  await expect(product.locator('details pre code')).toContainText('PluginInstallationCard')
  await directory.getByRole('button', { name: '确认卡片', exact: true }).click()
  await product.getByRole('button', { name: '普通权限', exact: true }).click()
  const authorization = product.locator('section#conversation-approval').getByRole('group', { name: '请求权限', exact: true })
  await expect(authorization).toContainText('echo preview')
  await authorization.getByRole('button', { name: '允许一次', exact: true }).click()
  await expect(authorization).toHaveCount(0)
  await product.getByRole('button', { name: '重置交互演示', exact: true }).click()
  await authorization.getByRole('button', { name: '拒绝', exact: true }).click()
  await expect(authorization).toHaveCount(0)
  await directory.getByRole('button', { name: '图片', exact: true }).click()
  const images = product.locator('section#prototype-images')
  await expect(images.getByRole('heading', { name: '发送前', exact: true })).toBeVisible()
  await expect(images.getByRole('heading', { name: '发送后', exact: true })).toBeVisible()
  await expect(images.getByRole('heading', { name: '文件附件', exact: true })).toHaveCount(0)
  await product.screenshot({ path: testInfo.outputPath('conversation-images.png') })
  await directory.getByRole('button', { name: '文件', exact: true }).click()
  const files = product.locator('section#prototype-files')
  await expect(files.getByRole('heading', { name: '发送前', exact: true })).toBeVisible()
  await expect(files.getByRole('heading', { name: '发送后', exact: true })).toBeVisible()
  await expect(files.getByTestId('sent-attachments-preview')).toBeVisible()
  await expect(files.getByRole('heading')).toHaveCount(3)
  await product.screenshot({ path: testInfo.outputPath('conversation-files.png') })
  await directory.getByRole('button', { name: '引用与上下文', exact: true }).click()
  const references = product.getByTestId('context-reference-examples')
  await expect(references.getByRole('heading', { name: '发送前', exact: true })).toBeVisible()
  await expect(references.getByRole('heading', { name: '发送后', exact: true })).toBeVisible()
  for (const kind of ['annotation', 'selection', 'skill', 'session']) {
    await expect(references.getByTestId('reference-attachment-example-' + kind)).toHaveCount(1)
    await expect(references.getByTestId('sent-reference-attachment-example-' + kind)).toHaveCount(1)
  }
  await product.screenshot({ path: testInfo.outputPath('conversation-references.png') })
  await directory.getByRole('button', { name: '总览与通用约定', exact: true }).click()
  const unbuilt = product.getByTestId('conversation-unbuilt')
  await expect(unbuilt).toContainText('未建设')
  await expect(unbuilt.getByRole('heading', { name: '总览与通用约定', exact: true })).toBeVisible()
  await expect(product.getByTestId('answer-body')).toHaveCount(0)
  await product.screenshot({ path: testInfo.outputPath('conversation-directory-unbuilt.png') })
  await official.locator('[data-export="Formula"]').click()
  await expect(product.getByTestId('preview-answer')).toHaveAttribute('data-sample', 'Formula')
  await expect(product.getByTestId('preview-component').locator('.katex')).not.toHaveCount(0)
  await expect(product.getByTestId('conversation-unbuilt')).toHaveCount(0)
  await directory.getByRole('button', { name: '文字消息', exact: true }).click()
  await expect(product.getByTestId('conversation-material')).toBeVisible()
  await expect(product.getByTestId('user-bubble')).toBeVisible()
  await product.getByRole('button', { name: 'English', exact: true }).click()
  await directory.getByRole('button', { name: 'Overview and conventions', exact: true }).click()
  await expect(unbuilt).toContainText('Not built')
  await expect(directory.getByRole('group')).toHaveCount(8)
})


test('native tool execution materials cover adopted states and shared search interactions', {
  timeout: CENTER_MATRIX_TIMEOUT_MS,
  annotation: MATERIALS_INITIAL_TARGET,
}, async ({}, testInfo) => {
  const errors = []
  const writes = []
  product.on('pageerror', error => errors.push(error.message))
  product.on('request', request => {
    if (request.method() !== 'GET' && /\/api\//.test(request.url())) writes.push(request.url())
  })
  await scenario('development-components', 'components-states')
  await product.getByRole('button', { name: /会话组件/ }).click()
  await product.getByRole('button', { name: '工具执行', exact: true }).click()
  const sample = product.getByTestId('conversation-material')
  const states = sample.getByRole('group', { name: '示例状态' })
  const capture = filename => sample.getByTestId('conversation-preview').screenshot({ path: testInfo.outputPath(filename) })
  await product.screenshot({ path: testInfo.outputPath('tools-pdfe-workbench.png') })
  const matrix = [
    ['进行中', '进行中', 'running'],
    ['回答输出中', '进行中', 'streaming'],
    ['已完成', '已完成', 'completed'],
    ['含失败', '未完成', 'failed'],
    ['已暂停', '已暂停', 'paused'],
    ['网页检索', '已完成', 'search'],
  ]
  await expect(states.getByRole('button')).toHaveCount(matrix.length)
  for (const [label, outcome, filename] of matrix) {
    await states.getByRole('button', { name: label, exact: true }).click()
    const process = sample.getByTestId('turn-process-trigger')
    if (outcome === '进行中') {
      await expect(process).toHaveCount(0)
      const activity = sample.getByTestId('turn-activity-trigger').last()
      await expect(activity).toBeVisible()
      if (filename === 'running') {
        await expect(activity).toHaveAttribute('aria-expanded', 'true')
        const toolIcon = sample.getByTestId('tool-run-step').last().locator('[role="status"] img')
        await expect(toolIcon).toHaveCount(1)
        await expect(toolIcon).toBeVisible()
      } else {
        await expect(activity).toHaveAttribute('aria-expanded', 'false')
        await activity.click()
        await expect(activity).toHaveAttribute('aria-expanded', 'true')
        await expect(sample.getByTestId('tool-run-step').last().locator('[role="status"] img')).toHaveCount(0)
      }
    } else {
      await expect(process).toHaveText(outcome + ' 用时 0 分 23 秒')
      await expect(process).toBeEnabled()
      await expect(process.locator('[role="status"]')).toHaveCount(0)
      expect(await process.evaluate(element => {
        const label = Array.from(element.querySelectorAll(':scope > span')).at(-1)?.getBoundingClientRect()
        const icon = element.querySelector('svg')?.getBoundingClientRect()
        return Boolean(label && icon && Math.abs(icon.left - label.right - 4) < 0.5)
      })).toBe(true)
      expect(await process.evaluate(element => getComputedStyle(element).paddingLeft)).toBe('0px')
    }
    if (filename === 'streaming') await expect(sample.getByTestId('conversation-content')).toContainText('工具已完成，回答仍在输出')
    if (filename === 'failed') {
      await process.click()
      await expect(sample.getByTestId('tool-batch-warning')).toHaveAttribute('aria-label', assistantZh.toolProcess.failures_other.replace('{{count}}', '1'))
    }
    if (filename === 'paused') await expect(sample.getByTestId('turn-process-duration')).toHaveText('用时 0 分 23 秒')
    if (filename !== 'search') await capture('tools-' + filename + '.png')
  }
  await sample.getByTestId('turn-process-trigger').click()
  await sample.getByTestId('turn-activity-trigger').last().click()
  const search = sample.getByTestId('web-search-step')
  await expect(search).toHaveCSS('border-radius', '12px')
  await expect(search).toHaveCSS('border-top-width', '1px')
  const summary = search.getByTestId('web-search-summary')
  await expect(sample.getByTestId('web-search-node')).toHaveAttribute('aria-expanded', 'true')
  await expect(summary).not.toHaveAttribute('aria-expanded')
  await expect(search.locator('[aria-expanded]')).toHaveCount(0)
  const query = search.locator('li').first()
  await expect(query).toHaveCSS('height', '24px')
  await expect(query).toHaveCSS('padding', '4px 8px')
  await expect(query).toHaveCSS('background-color', 'rgba(103, 73, 15, 0.04)')
  await expect(query).toHaveCSS('font-size', '10px')
  await expect(query.locator('..')).toHaveCSS('gap', '4px')
  const results = search.getByTestId('web-search-results').locator(':scope > div')
  await expect(results).toHaveCount(6)
  await expect(summary).toContainText('6 个网页结果')
  await search.scrollIntoViewIfNeeded()
  await capture('tools-search-preview.png')
  await product.getByRole('button', { name: 'English', exact: true }).click()
  await product.locator('#theme-preview-mode').click()
  await product.getByRole('option', { name: /dark/i }).click()
  await expect(sample.getByTestId('turn-process-trigger')).toContainText('Completed')
  if (await sample.getByTestId('turn-process-trigger').getAttribute('aria-expanded') === 'false') await sample.getByTestId('turn-process-trigger').click()
  if (await sample.getByTestId('turn-activity-trigger').last().getAttribute('aria-expanded') === 'false') await sample.getByTestId('turn-activity-trigger').last().click()
  await expect(query).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.04)')
  await expect(query).toHaveCSS('height', '24px')
  await capture('tools-dark-english.png')
  expect(errors).toEqual([])
  expect(writes).toEqual([])
})

test('native draft mixed context previews, removes and sends actual references', async ({}, testInfo) => {
  await scenario('page-conversation', 'conversation-context-draft')
  await expect(product.getByTestId('composer-reference-tray')).toBeVisible()
  await expect(product.getByRole('button', { name: 'measurements.csv', exact: true }).locator('[data-slot="attachment-format"]')).toContainText('Excel')
  await expect(product.getByRole('button', { name: '移除附件 measurements.csv', exact: true })).toBeVisible()
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('draft-direct-entry.png') })
  await expect(product.getByTestId('user-bubble')).toHaveCount(0)
  await product.getByRole('button', { name: '查看图片 sample.png（1 / 1）', exact: true }).click()
  await expect(product.getByTestId('attachment-image-viewer')).toBeVisible()
  await product.keyboard.press('Escape')
  await product.getByRole('button', { name: 'measurements.csv', exact: true }).hover()
  await expect(product.getByRole('button', { name: '移除附件 measurements.csv', exact: true })).toBeVisible()
  await product.getByRole('button', { name: '移除附件 measurements.csv', exact: true }).click()
  await product.getByRole('button', { name: 'sample.pdf', exact: true }).click()
  await expect(product.getByTestId('pdf-document')).toBeVisible()
  const input = product.getByTestId('composer-input')
  await input.fill('/')
  await expect(product.getByTestId('composer-skill-list')).toBeVisible()
  await expect(product.getByTestId('composer-skill-preview-notes')).toBeVisible()
  await product.getByTestId('composer-skill-preview-notes').click()
  const editor = product.getByTestId('composer-editor')
  const skill = editor.getByText('preview-notes', { exact: true })
  await expect(skill).toBeVisible()
  await expect(editor).toContainText('模拟研究背景与实验设计')
  await input.fill('')
  await input.press('Backspace')
  await expect(skill).toHaveCount(0)
  await expect(editor).toContainText('模拟研究背景与实验设计')
  await input.fill('/')
  await product.getByTestId('composer-skill-preview-notes').click()
  await expect(skill).toBeVisible()
  await input.fill('请根据这些引用整理研究结论。')
  const tray = product.getByTestId('composer-reference-tray')
  await expect(product.getByRole('button', { name: 'sample.pdf', exact: true }).locator('[data-slot="attachment-format"]')).toContainText('PDF')
  for (const name of ['移除图片 sample.png', '移除附件 sample.pdf', '移除 readme.md', '移除 notes.md', '移除全部注释']) {
    await expect(product.getByRole('button', { name, exact: true, includeHidden: true })).toHaveCount(1)
  }
  await expect(product.getByRole('button', { name: '移除附件 measurements.csv', exact: true, includeHidden: true })).toHaveCount(0)
  const viewport = tray.locator('..')
  await expect(viewport).toHaveClass(/vds-scroll-area__viewport/)
  const geometry = await viewport.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth, height: element.clientHeight, contentHeight: element.scrollHeight }))
  expect(geometry.content).toBeGreaterThan(geometry.width)
  expect(geometry.contentHeight).toBeLessThanOrEqual(geometry.height)
  const centers = []
  for (const locator of [product.getByRole('button', { name: '查看图片 sample.png（1 / 1）', exact: true }), product.getByRole('button', { name: 'sample.pdf', exact: true }), ...await tray.getByTestId('ai-context-ref').all()]) {
    const bounds = await locator.boundingBox()
    expect(bounds).not.toBeNull()
    centers.push(bounds.y + bounds.height / 2)
  }
  writeFileSync(testInfo.outputPath('draft-reference-layout.json'), JSON.stringify({ geometry, centers }, null, 2))
  await product.getByRole('button', { name: '查看图片 sample.png（1 / 1）', exact: true }).scrollIntoViewIfNeeded()
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('mixed-draft-start.png') })
  await tray.getByTestId('ai-context-ref').last().scrollIntoViewIfNeeded()
  await expect(tray.getByTestId('ai-context-ref').last()).toBeInViewport()
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('mixed-draft.png') })
  await input.press('Enter')
  await expect(product.getByTestId('sent-context-layer-images')).toBeVisible()
  await expect(product.getByTestId('sent-context-layer-files').getByRole('button', { name: 'sample.pdf', exact: true })).toBeVisible()
  await expect(product.getByTestId('sent-context-layer-files').getByRole('button', { name: 'measurements.csv', exact: true })).toHaveCount(0)
  await expect(product.getByTestId('user-bubble')).toContainText('preview-notes')
  await expect(product.getByTestId('user-message-annotations')).toBeVisible()
  const referenceTops = await product.getByTestId('sent-context-layer-selections').locator('[data-slot="sent-reference-attachment"]').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top))
  expect(referenceTops).toHaveLength(3)
  expect(Math.max(...referenceTops) - Math.min(...referenceTops)).toBeLessThanOrEqual(1)
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('mixed-draft-sent.png') })
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(2)
})

test('native draft shared attachment deletion preserves unselected sources and does not open previews', async ({}, testInfo) => {
  const [opened] = await Promise.all([
    product.waitForResponse(response => response.request().method() === 'GET' && REFERENCE_CONTEXT_PATH.test(new URL(response.url()).pathname)),
    scenario('page-conversation', 'conversation-context-draft'),
  ])
  expect(opened.status()).toBe(200)
  const initial = await opened.json()
  expect(initial.refs).toEqual(previewDraftReferences())
  const notes = product.getByTestId('ai-context-ref').filter({ has: product.getByRole('button', { name: '移除全部注释', exact: true }) })
  await notes.hover()
  const remove = notes.getByRole('button', { name: '移除全部注释', exact: true })
  const geometry = await remove.evaluate(element => {
    const button = element.getBoundingClientRect()
    const parent = element.parentElement.getBoundingClientRect()
    return { width: button.width, height: button.height, radius: Number.parseFloat(getComputedStyle(element).borderRadius), top: button.top - parent.top, right: button.right - parent.right }
  })
  expect(geometry.width).toBe(geometry.height)
  expect(geometry.radius).toBeGreaterThanOrEqual(geometry.width / 2)
  expect(geometry.top).toBeLessThan(0)
  expect(geometry.right).toBeGreaterThan(0)
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('shared-attachment-note-close.png') })
  const contextUrl = new URL(opened.url())
  const noteReferences = initial.refs.filter(reference => reference.kind === 'note')
  expect(noteReferences).toHaveLength(2)
  const readAnnotations = async sessionId => {
    const url = new URL('/api/assistant/sessions/' + encodeURIComponent(sessionId) + '/annotations', contextUrl)
    url.searchParams.set('previewInstance', manifest.instance)
    const response = await product.request.get(url.href)
    expect(response.status()).toBe(200)
    return (await response.json()).annotations
  }
  const annotations = await readAnnotations(initial.session_id)
  const requestedAnnotations = noteReferences.map(reference => {
    const annotation = annotations.find(item => item.annotation_id === reference.source_id)
    expect(annotation).toBeDefined()
    return { annotation_id: annotation.annotation_id, expected_annotation_revision: annotation.revision }
  })
  const selectedIds = new Set(requestedAnnotations.map(annotation => annotation.annotation_id))
  const unselectedAnnotations = annotations.filter(annotation => !selectedIds.has(annotation.annotation_id))
  const otherSession = initial.refs.find(reference => reference.kind === 'session')
  expect(otherSession).toBeDefined()
  const otherAnnotations = await readAnnotations(otherSession.source_id)
  const annotationsPath = contextUrl.pathname.replace(/\/context$/, '/annotations')
  const annotationRequests = []
  const observe = request => {
    const url = new URL(request.url())
    if (request.method() === 'DELETE' && url.origin === contextUrl.origin && (url.pathname === annotationsPath || url.pathname.startsWith(annotationsPath + '/'))) annotationRequests.push(request)
  }
  product.on('request', observe)
  try {
    const [receipt] = await Promise.all([
      product.waitForResponse(response => response.request().method() === 'DELETE' && new URL(response.url()).origin === contextUrl.origin && new URL(response.url()).pathname === annotationsPath),
      remove.click(),
    ])
    expect(receipt.status()).toBe(200)
    expect(receipt.request().postDataJSON()).toEqual({ expected_context_revision: initial.revision, annotations: requestedAnnotations })
    const notesContext = await receipt.json()
    const withoutNotes = initial.refs.filter(reference => reference.kind !== 'note')
    expect(notesContext).toEqual({ ...initial, refs: withoutNotes, revision: initial.revision + 1, updated_at: expect.any(Number) })
    expect(await readAnnotations(initial.session_id)).toEqual(unselectedAnnotations)
    expect(await readAnnotations(otherSession.source_id)).toEqual(otherAnnotations)
    await expect(product.getByRole('button', { name: '2 条注释', exact: true })).toHaveCount(0)
    await expect(product.getByRole('button', { name: /^注释 [12]：/ })).toHaveCount(0)
    const selection = product.getByTestId('ai-context-ref').filter({ has: product.getByRole('button', { name: '移除 readme.md', exact: true }) }).first()
    const selectionRefs = notesContext.refs.filter(reference => reference.kind === 'selection' && reference.source_id === 'readme.md')
    expect(selectionRefs).toHaveLength(2)
    await selection.hover()
    const [selectionReceipt] = await Promise.all([
      product.waitForResponse(response => response.request().method() === 'PATCH' && response.url() === opened.url()),
      selection.getByRole('button', { name: '移除 readme.md', exact: true }).click(),
    ])
    expect(selectionReceipt.status()).toBe(200)
    const remaining = notesContext.refs.filter(reference => !selectionRefs.some(selectionRef => selectionRef.ref_id === reference.ref_id))
    expect(selectionReceipt.request().postDataJSON()).toMatchObject({ expected_revision: notesContext.revision, refs: remaining })
    expect(await selectionReceipt.json()).toEqual({ ...notesContext, refs: remaining, revision: notesContext.revision + 1, updated_at: expect.any(Number) })
    await expect(product.getByRole('button', { name: '移除 readme.md', exact: true })).toHaveCount(0)
    await expect(product.getByRole('button', { name: '移除 notes.md', exact: true })).toHaveCount(1)
    await expect(product.getByTestId('attachment-image-viewer')).toHaveCount(0)
    await expect(product.getByTestId('pdf-document')).toHaveCount(0)
    await expect(product.getByTestId('user-bubble')).toHaveCount(0)
    await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('shared-attachment-notes-deleted.png') })
    expect(annotationRequests.map(request => new URL(request.url()).pathname)).toEqual([annotationsPath])
  } finally {
    product.off('request', observe)
  }
})

test('native attachment material includes reusable reference attachments with shared removal', async ({}, testInfo) => {
  await scenario('development-components', 'components-states')
  await product.getByRole('button', { name: /会话组件/ }).click()
  await product.getByRole('button', { name: '引用与上下文', exact: true }).click()
  const sample = product.getByTestId('context-reference-examples')
  const reference = sample.getByTestId('reference-attachment-example-annotation')
  await reference.scrollIntoViewIfNeeded()
  await reference.hover()
  for (const identifier of ['0', '1']) await expect(product.getByTestId('answer-annotation-details-' + identifier)).toBeVisible()
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('reference-attachments-material.png') })
  await reference.getByRole('button', { name: '移除：注释引用', exact: true }).click()
  await expect(reference).toHaveCount(0)
  await expect(sample.getByTestId('sent-reference-attachment-example-annotation')).toBeVisible()
  await expect(sample.getByTestId('reference-attachment-example-selection')).toBeVisible()
  await sample.getByRole('button', { name: '重置', exact: true }).click()
  await expect(reference).toBeVisible()
  for (const kind of ['annotation', 'selection', 'skill', 'session']) {
    const sent = sample.getByTestId(`sent-reference-attachment-example-${kind}`)
    await sent.scrollIntoViewIfNeeded()
    await expect(sent).toBeVisible()
    await expect(sent.locator('[data-slot="attachment-remove"]')).toHaveCount(0)
  }
  await sample.getByTestId('sent-reference-attachment-example-annotation').hover()
  for (const identifier of ['0', '1']) await expect(product.getByTestId('answer-annotation-details-' + identifier)).toBeVisible()
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('sent-reference-attachments-material.png') })
})

test('native mixed context shows four layers, image viewer and source conversation', async ({}, testInfo) => {
  await scenario('page-conversation', 'conversation-context-mixed')
  await expect(product.getByTestId('sent-selection-group')).toHaveCount(2)
  await expect(product.getByTestId('user-message-annotations')).toBeVisible()
  await expect(product.getByTestId('sent-context-layer-images').locator('img')).toHaveCount(2)
  await expect(product.getByTestId('sent-context-layer-files').getByRole('button', { name: 'sample.pdf', exact: true })).toBeVisible()
  await expect(product.getByTestId('sent-context-layer-files').getByRole('button', { name: 'measurements.csv', exact: true })).toBeVisible()
  await expect(product.getByTestId('user-bubble')).toContainText('research')
  await product.getByRole('button', { name: '隐藏任务监控', exact: true }).click()
  await product.getByRole('button', { name: '折叠侧栏', exact: true }).click()
  const layers = await product.locator('[data-testid="sent-context-layer-selections"], [data-testid="sent-context-layer-images"], [data-testid="sent-context-layer-files"], [data-testid="user-bubble"]').evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')))
  expect(layers).toEqual(['sent-context-layer-images', 'sent-context-layer-selections', 'sent-context-layer-files', 'user-bubble'])
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('mixed-context.png') })
  await product.getByTestId('user-message-annotations').scrollIntoViewIfNeeded()
  await product.getByTestId('user-message-annotations').getByRole('button').first().hover()
  await expect(product.getByText('请结合附件补充分析。', { exact: true })).toBeVisible()
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('mixed-annotations.png') })
  await product.getByRole('button', { name: '展开侧栏', exact: true }).hover()
  await expect(product.getByText('请结合附件补充分析。', { exact: true })).not.toBeVisible()
  await product.getByTestId('sent-context-layer-images').getByRole('button').first().click()
  await expect(product.getByTestId('attachment-image-viewer')).toBeVisible()
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('mixed-image-viewer.png') })
  await product.keyboard.press('Escape')
  await controls.getByRole('combobox', { name: '主题', exact: true }).click()
  await controls.getByRole('option', { name: '深色', exact: true }).click()
  await expect(product.locator('html')).toHaveAttribute('data-theme', 'dark')
  const native = await app.browserWindow(product)
  await native.evaluate((window, size) => window.setSize(size.width, size.height), WORKSPACE_WINDOW_MINIMUM)
  await expect(product.getByTestId('sent-context-layer-images').locator('img')).toHaveCount(2)
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('mixed-context-dark-minimum.png') })
  const referenceRow = product.getByTestId('sent-context-layer-references')
  await referenceRow.scrollIntoViewIfNeeded()
  const referenceViewport = referenceRow.locator('..')
  await expect(referenceViewport).toHaveClass(/vds-scroll-area__viewport/)
  const overflow = await referenceViewport.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth, height: element.clientHeight, contentHeight: element.scrollHeight }))
  expect(overflow.content).toBeGreaterThan(overflow.width)
  expect(overflow.contentHeight).toBeLessThanOrEqual(overflow.height)
  await referenceViewport.hover()
  await product.mouse.wheel(500, 0)
  await expect.poll(() => referenceViewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('mixed-references-scrolled.png') })
  await product.getByTestId('sent-session-reference-preview-conversation-ref').click()
  await expect(product.getByText('这是被引用的模拟原对话，可通过返回导航回到混合场景。', { exact: true })).toBeVisible()
})

test('native mixed context file opens existing PDF workbench', async ({}, testInfo) => {
  await scenario('page-conversation', 'conversation-context-mixed')
  const attachment = product.getByTestId('sent-context-layer-files').getByRole('button', { name: 'sample.pdf', exact: true })
  await expect(attachment).toBeVisible()
  await attachment.click()
  const document = product.getByTestId('pdf-document')
  await expect(document).toBeAttached()
  const workspace = product.getByTestId('workspace-open')
  if (await workspace.isVisible()) {
    await expect(workspace).toHaveAttribute('aria-expanded', 'false')
    await workspace.click()
  }
  await expect(document).toBeVisible()
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('mixed-pdf-workbench.png') })
})

test('native context references group submitted selections', async ({}, testInfo) => {
  await scenario('page-conversation', 'conversation-references')
  await expect(product.getByTestId('composer-input')).toBeVisible()
  await product.getByTestId('composer-input').fill('比较这些划词')
  await product.getByTestId('composer-input').press('Enter')
  await expect(product.getByTestId('sent-selection-group')).toHaveCount(2)
  await expect(product.getByTestId('sent-selection-group').first()).toContainText('2 条划词')
  const firstReference = previewContextReferences()[0]
  const firstQuote = product.getByRole('button', { name: assistantZh.quote.open.replace('{{name}}', firstReference.label), exact: true }).filter({ hasText: firstReference.anchor.preview_text })
  await product.getByTestId('sent-selection-group').first().getByRole('button', { name: '2 条划词', exact: true }).hover()
  await expect(firstQuote).toBeVisible()
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('context-references.png') })
  await controls.getByRole('combobox', { name: '主题', exact: true }).click()
  await controls.getByRole('option', { name: '深色', exact: true }).click()
  await expect(product.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(product.getByTestId('sent-selection-group')).toHaveCount(2)
  await product.getByRole('button', { name: '隐藏任务监控', exact: true }).click()
  await product.getByRole('button', { name: '折叠侧栏', exact: true }).click()
  const native = await app.browserWindow(product)
  await native.evaluate((window, size) => window.setSize(size.width, size.height), WORKSPACE_WINDOW_MINIMUM)
  await product.getByTestId('sent-selection-group').first().scrollIntoViewIfNeeded()
  await product.getByTestId('sent-selection-group').first().getByRole('button').focus()
  await expect(product.getByTestId('sent-selection-group').first()).toBeInViewport()
  await expect(firstQuote).toBeVisible()
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('context-references-dark-minimum.png') })
})

test('native context references remove only the last draft reference at input start', async () => {
  const [opened] = await Promise.all([
    product.waitForResponse(response => response.request().method() === 'GET' && REFERENCE_CONTEXT_PATH.test(new URL(response.url()).pathname)),
    scenario('page-conversation', 'conversation-references'),
  ])
  expect(opened.status()).toBe(200)
  const initial = await opened.json()
  expect(initial.refs).toEqual(previewContextReferences())
  await product.getByRole('button', { name: '打开工作台', exact: true }).click()
  await expect(product.getByTestId('ai-context-ref')).toHaveCount(2)
  await product.getByTestId('composer-input').focus()
  const [receipt] = await Promise.all([
    product.waitForResponse(response => response.request().method() === 'PATCH' && response.url() === opened.url()),
    product.getByTestId('composer-input').press('Backspace'),
  ])
  expect(receipt.status()).toBe(200)
  const remaining = initial.refs.slice(0, -1)
  expect(receipt.request().postDataJSON()).toMatchObject({ expected_revision: initial.revision, refs: remaining })
  expect(await receipt.json()).toEqual({ ...initial, refs: remaining, revision: initial.revision + 1, updated_at: expect.any(Number) })
  await expect(product.getByTestId('ai-context-ref')).toHaveCount(1)
  await expect(product.getByTestId('ai-context-ref')).toContainText('2 条划词')
})

test('native translation configuration saves prompts, validates demo credentials and installs packages', async ({}, testInfo) => {
  await scenario('settings-translation', 'translation-settings')
  const settings = product.getByTestId('account-settings-translation')
  const prompt = settings.getByRole('textbox', { name: 'AI 翻译提示词', exact: true })
  await prompt.fill('准确翻译，保留引用及专业术语。')
  await expect(settings.getByRole('status').first()).toHaveText('已自动保存')
  await settings.getByRole('switch', { name: 'PDF 划词即翻译', exact: true }).click()
  await settings.getByRole('button', { name: 'DeepL', exact: true }).click()
  const deepl = product.getByTestId('translation-service-deepl')
  await deepl.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect(deepl.getByRole('status')).toHaveText('请补全当前服务的必填项。')
  await deepl.getByRole('textbox', { name: 'DeepL API Key', exact: true }).fill('demo-not-real')
  await Promise.all([
    expect(deepl.getByTestId('translation-save-deepl')).toBeDisabled(),
    deepl.getByTestId('translation-save-deepl').click(),
  ])
  await expect(deepl.getByRole('status').filter({ hasText: '连接验证成功（演示）' })).toBeVisible()
  await settings.getByRole('button', { name: '离线翻译', exact: true }).click()
  const languages = product.getByTestId('translation-language-list')
  const french = languages.getByText('法语', { exact: true }).locator('..')
  await Promise.all([
    expect(french.getByRole('button')).toBeDisabled(),
    french.getByRole('button', { name: '安装', exact: true }).click(),
  ])
  await expect(french.getByText('已安装', { exact: true })).toBeVisible()
  await product.screenshot({ path: testInfo.outputPath('translation-settings.png') })
  await product.reload()
  await expect(product.getByRole('textbox', { name: 'AI 翻译提示词', exact: true })).toHaveValue('准确翻译，保留引用及专业术语。')
  await expect(product.getByRole('switch', { name: 'PDF 划词即翻译', exact: true })).toBeChecked()
  await expect(product.getByTestId('translation-service-deepl')).toContainText('已配置')
  await product.getByRole('button', { name: '恢复默认', exact: true }).click()
  await expect(product.getByRole('textbox', { name: 'AI 翻译提示词', exact: true })).toHaveValue('准确翻译所选内容，保留专业术语、引用、数字和段落格式。')
  await controls.getByRole('button', { name: '重置模拟数据', exact: true }).click()
  await expect(product.getByTestId('translation-service-deepl')).toContainText('未配置')
  await expect(product.getByRole('switch', { name: 'PDF 划词即翻译', exact: true })).not.toBeChecked()
})

test('native translation PDF preserves old results until refresh and opens the exact service configuration', async ({}, testInfo) => {
  await scenario('viewer-pdf', 'viewer-pdf-states')
  await product.getByTestId('pdf-document-translation').click()
  const result = product.getByTestId('pdf-translation-page-1')
  await expect(result).toContainText('【模拟译文】')
  const toolbar = product.getByRole('region', { name: '全文翻译设置', exact: true })
  await expect(toolbar.getByRole('button', { name: '交换源语言和目标语言', exact: true })).toBeDisabled()
  await toolbar.getByRole('combobox', { name: '目标语言', exact: true }).click()
  await product.getByRole('option', { name: '英语', exact: true }).click()
  await expect(result).toContainText('【模拟译文】')
  await expect(toolbar.getByRole('combobox', { name: '目标语言', exact: true })).toHaveText('英语')
  await toolbar.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(result).toContainText('【模拟译文】')
  await result.getByRole('button', { name: '重新翻译本页', exact: true }).click()
  await expect(result).toContainText('[Simulated translation]')
  await product.getByTestId('pdf-document-translation').click()
  await toolbar.getByRole('combobox', { name: '选择翻译模型或服务', exact: true }).click()
  await product.getByRole('option').filter({ hasText: '百度翻译' }).click()
  const baidu = product.getByTestId('translation-service-baidu')
  await expect(baidu.getByRole('textbox').first()).toBeVisible()
  await expect(baidu).toContainText('未配置')
  await product.screenshot({ path: testInfo.outputPath('translation-service-focus.png') })
})

test('native translation failures retain demo input and never enable failed services or packages', async () => {
  await scenario('settings-translation', 'translation-verification-failed')
  await product.getByRole('button', { name: 'DeepL', exact: true }).click()
  const deepl = product.getByTestId('translation-service-deepl')
  await deepl.getByRole('textbox', { name: 'DeepL API Key', exact: true }).fill('demo-not-real')
  await deepl.getByTestId('translation-save-deepl').click()
  await expect(deepl).toContainText('模拟连接验证失败')
  await expect(deepl.getByRole('textbox')).toHaveValue('demo-not-real')
  await deepl.getByTestId('translation-save-deepl').click()
  await expect(deepl).toContainText('模拟连接验证失败')
  await expect(deepl).not.toContainText('已配置')
  await scenario('settings-translation', 'translation-installation-failed')
  await product.getByRole('button', { name: '离线翻译', exact: true }).click()
  const row = product.getByTestId('translation-language-list').getByText('法语', { exact: true }).locator('..')
  await row.getByRole('button', { name: '安装', exact: true }).click()
  await expect(row.getByRole('button')).toHaveText('安装失败，重试')
  await row.getByRole('button').click()
  await expect(row.getByRole('button')).toHaveText('安装失败，重试')
  await expect(row).not.toContainText('已安装')
})

test('native translation selection respects the toolbar gate without clearing the saved preference', async ({}, testInfo) => {
  await scenario('viewer-pdf', 'viewer-pdf-states')
  await product.getByTestId('pdf-translation-settings').click()
  await product.getByRole('switch', { name: 'PDF 划词即翻译', exact: true }).click()
  await product.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
  await product.getByRole('switch', { name: '划词工具条', exact: true }).click()
  await product.getByTestId('pdf-translation-settings').click()
  await expect(product.getByRole('switch', { name: 'PDF 划词即翻译', exact: true })).toBeChecked()
  await expect(product.getByRole('switch', { name: 'PDF 划词即翻译', exact: true })).toBeDisabled()
  await product.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
  await product.getByText('Minimal sample PDF', { exact: true }).dblclick()
  await expect(product.getByTestId('selection-action-host')).toHaveCount(0)
  await expect(product.getByTestId('pdf-selection-translation-inline')).toHaveCount(0)
  await expect(product.getByRole('dialog', { name: '翻译', exact: true })).toHaveCount(0)
  await product.getByRole('switch', { name: '划词工具条', exact: true }).click()
  await product.getByText('Minimal sample PDF', { exact: true }).dblclick()
  const translation = product.getByTestId('selection-action-host').getByTestId('pdf-selection-translation-inline')
  await expect(translation).toBeVisible()
  await expect(translation.getByTestId('pdf-selection-translation-content')).toContainText('【模拟译文】')
  await expect(product.getByRole('dialog', { name: '翻译', exact: true })).toHaveCount(0)
  await product.getByText('Minimal sample PDF', { exact: true }).click()
  await expect(translation).toHaveCount(0)
  await product.getByText('Needle marker for smoke tests.', { exact: true }).dblclick()
  const selected = await product.evaluate(() => window.getSelection()?.toString())
  expect(selected?.trim()).toBeTruthy()
  expect('Needle marker for smoke tests.').toContain(selected.trim())
  await expect(translation.getByTestId('pdf-selection-translation-content')).toContainText('【模拟译文】')
  await expect(translation.getByTestId('pdf-selection-translation-annotate')).toHaveText('添加为评论')
  await expect(translation.getByRole('button', { name: '添加到会话框', exact: true })).toHaveCount(0)
  await expect(translation.getByTestId('translation-controls')).toHaveCSS('column-gap', '8px')
  const toggleResult = translation.getByTestId('pdf-selection-result-toggle-size')
  await expect(translation.getByTestId('pdf-selection-result-actions')).toHaveCSS('column-gap', '2px')
  const engineBox = await translation.getByRole('combobox', { name: '选择翻译模型或服务', exact: true }).boundingBox()
  const toggleBox = await toggleResult.boundingBox()
  expect(engineBox && toggleBox).toBeTruthy()
  expect(engineBox.y).toBeCloseTo(toggleBox.y, 0)
  await toggleResult.click()
  const expanded = product.getByTestId('pdf-selection-result-expanded')
  await expect(expanded.getByTestId('pdf-selection-translation-content')).toContainText('【模拟译文】')
  await expect(expanded.getByTestId('pdf-selection-result-toggle-size')).toBeFocused()
  await expect(translation).toHaveCount(0)
  await product.screenshot({ path: testInfo.outputPath('translation-expanded.png'), animations: 'disabled' })
  await product.keyboard.press('Escape')
  await expect(expanded).toHaveCount(0)
  await expect(toggleResult).toBeFocused()
  await expect(translation.getByTestId('pdf-selection-translation-content')).toContainText('【模拟译文】')
  await product.screenshot({ path: testInfo.outputPath('translation-selection.png'), animations: 'disabled' })
  await translation.getByRole('button', { name: '翻译设置', exact: true }).click()
  await expect(product.getByRole('dialog', { name: '设置', exact: true })).toBeVisible()
  await expect(product.getByRole('switch', { name: 'PDF 划词即翻译', exact: true })).toBeChecked()
  await expect(product.getByRole('switch', { name: 'PDF 划词即翻译', exact: true })).toBeEnabled()
  await product.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
})

test('native selection explanation replaces its prompt inside the same PDF bubble', async ({}, testInfo) => {
  await scenario('viewer-pdf', 'viewer-pdf-states')
  const taskId = 'pdfe-selection-explanation'
  const explanation = '这段文字用一个简单例子说明如何验证 PDF 文本选区。'
  let selectedRequest
  let releasePreview
  let releaseCompletion
  const previewReady = new Promise(resolve => { releasePreview = resolve })
  const completionReady = new Promise(resolve => { releaseCompletion = resolve })
  await product.route('**/api/literature/ai/tasks', async (route) => {
    const request = route.request().postDataJSON()
    selectedRequest = request
    expect(request.kind).toBe('selection_explanation')
    expect(request.text).toBeTruthy()
    await route.fulfill({ status: 202, json: { task_id: taskId, status: 'pending' } })
  })
  await product.route(`**/api/literature/ai/tasks/${taskId}/events`, async (route) => {
    await previewReady
    await route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ task_id: taskId, status: 'running', preview: { text: explanation.slice(0, 5) } })}\n\n`,
    })
  })
  await product.route(`**/api/literature/ai/tasks/${taskId}`, async (route) => {
    await completionReady
    await route.fulfill({ json: { task_id: taskId, status: 'completed', result: {
      kind: 'selection_explanation', page: 1, text: explanation,
      selected_text: selectedRequest.text, quads: selectedRequest.quads,
    } } })
  })

  await product.getByText('Needle marker for smoke tests.', { exact: true }).dblclick()
  const bubble = product.getByTestId('selection-action-host')
  await bubble.getByRole('button', { name: '解释', exact: true }).click()
  const originalBubble = await bubble.elementHandle()
  const input = bubble.getByRole('textbox')
  await input.fill('解释这段话')
  await input.press('Shift+Enter')
  await expect(input).toHaveValue('解释这段话\n')
  await bubble.getByRole('button', { name: '解释一下', exact: true }).hover()
  await expect(product.getByRole('tooltip')).toContainText('Enter')
  await product.screenshot({ path: testInfo.outputPath('explanation-prompt.png'), animations: 'disabled' })
  await input.press('Enter')
  const result = bubble.getByTestId('pdf-selection-explanation-inline')
  await expect(result.getByTestId('pdf-selection-result-skeleton')).toBeVisible()
  await expect(result.getByRole('button', { name: '复制', exact: true })).toHaveCount(0)
  await expect(result.getByRole('button', { name: '添加到会话框', exact: true })).toHaveCount(0)
  await expect(result.getByRole('button', { name: '添加为评论', exact: true })).toHaveCount(0)
  await expect(result.getByText('生成中...', { exact: true })).toHaveCount(0)
  const waitingHeight = (await result.boundingBox()).height
  await product.screenshot({ path: testInfo.outputPath('explanation-waiting.png'), animations: 'disabled' })
  releasePreview()
  await expect(result.getByTestId('pdf-selection-explanation-content')).toHaveText(explanation.slice(0, 5))
  await expect(result.getByTestId('pdf-selection-result-skeleton')).toHaveCount(0)
  await expect(result.getByRole('button', { name: '复制', exact: true })).toHaveCount(0)
  expect((await result.boundingBox()).height).toBeCloseTo(waitingHeight, 0)
  await product.screenshot({ path: testInfo.outputPath('explanation-streaming.png'), animations: 'disabled' })
  releaseCompletion()
  await expect(result.getByTestId('pdf-selection-explanation-content')).toHaveText(explanation)
  expect(await bubble.evaluate((node, original) => node === original, originalBubble)).toBe(true)
  await originalBubble.dispose()
  await expect(result.getByRole('button', { name: '添加到会话框', exact: true })).toBeEnabled()
  await expect(result.getByRole('button', { name: '添加为评论', exact: true })).toBeVisible()
  // This preview source is read-only; persistence is exercised in the live reader.
  await expect(result.getByRole('button', { name: '添加为评论', exact: true })).toBeDisabled()
  await result.getByRole('button', { name: '添加到会话框', exact: true }).click()
  await expect(result).toBeVisible()
  await expect(result.getByTestId('pdf-selection-explanation-content')).toHaveText(explanation)
  await result.getByTestId('pdf-selection-result-toggle-size').click()
  const expanded = product.getByTestId('pdf-selection-result-expanded')
  await expect(expanded.getByTestId('pdf-selection-explanation-content')).toHaveText(explanation)
  await expanded.getByTestId('pdf-selection-result-toggle-size').click()
  await expect(result.getByTestId('pdf-selection-explanation-content')).toHaveText(explanation)
  await product.screenshot({ path: testInfo.outputPath('explanation-selection.png'), animations: 'disabled' })
})

test('native translation configuration supports dark English, keyboard navigation and the native minimum window', async ({}, testInfo) => {
  await scenario('settings-translation', 'translation-settings')
  await expect(product.getByRole('heading', { name: '翻译配置', exact: true })).toBeVisible()
  await useDarkEnglishAppearance()
  await expect(product.getByRole('heading', { name: 'Translation configuration', exact: true })).toBeVisible()
  const native = await app.browserWindow(product)
  await native.evaluate((window, minimum) => window.setSize(minimum.width, minimum.height), WORKSPACE_WINDOW_MINIMUM)
  const picker = product.getByRole('combobox', { name: 'Choose a translation model or service', exact: true })
  await picker.focus()
  await product.keyboard.press('Enter')
  await expect(product.getByRole('listbox')).toBeVisible()
  await product.keyboard.press('Escape')
  await expect(product.getByRole('listbox')).toHaveCount(0)
  await expect(picker).toBeFocused()
  await product.getByRole('button', { name: 'Offline translation', exact: true }).click()
  await expect(product.getByTestId('translation-language-list')).toBeVisible()
  await product.screenshot({ path: testInfo.outputPath('translation-dark-english-minimum.png') })
})

async function openHomeProjectForm() {
  await product.getByTestId('home-project-create-top').click()
}

async function expectHomeTasksHidden() {
  await expect(product.locator('#home-tasks-heading')).toHaveCount(0)
  for (const identifier of ['home-tasks-list', 'home-tasks-previous', 'home-tasks-next']) await expect(product.getByTestId(identifier)).toHaveCount(0)
}

async function workspaceShortcut(keyCode, modifiers = []) {
  const window = await app.browserWindow(product)
  await window.evaluate((window, input) => {
    window.focus()
    const contents = window.contentView.children[0].webContents
    contents.focus()
    contents.sendInputEvent({ type: 'keyDown', ...input })
    contents.sendInputEvent({ type: 'keyUp', ...input })
  }, { keyCode, modifiers })
}

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
  await Promise.all([
    product.waitForURL(url => url.searchParams.get('page') === pageId && url.searchParams.get('scene') === sceneId, { waitUntil: 'domcontentloaded' }),
    controls.getByTestId('preview-scene-' + pageId + '-' + sceneId).click(),
  ])
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

function nativeArchivedTasksResponse() {
  return product.waitForResponse(response => {
    const url = new URL(response.url())
    return response.request().method() === 'GET' && url.pathname === ARCHIVE_SESSIONS_PATH && url.searchParams.get('archived') === 'true' && url.searchParams.get('scope') === 'project'
  })
}

async function openNativeTaskArchive(scene, dictionary = zh) {
  await scenario('page-resource', scene, dictionary)
  await product.getByTestId('project-archive-toggle').click()
  await expect(product.getByTestId('project-archived-list')).toBeVisible()
  return nativeArchiveState()
}

async function nativeArchivedTask(state) {
  const archived = state.sessions.filter(session => session.archived)
  expect(archived).toHaveLength(2)
  const project = state.projects.find(project => project.archived_at == null)
  const local = archived.filter(session => session.project_path === project.root)
  expect(local).toHaveLength(1)
  for (const task of local) await expect(product.getByTestId('project-archived-task-' + task.session_id)).toBeVisible()
  for (const task of archived.filter(session => session.project_path !== project.root)) await expect(product.getByTestId('project-archived-task-' + task.session_id)).toHaveCount(0)
  return local[0]
}

async function nativeArchivedReadonly(testInfo, task, action) {
  const requests = []
  const observe = request => {
    const path = new URL(request.url()).pathname
    const sessionPath = ARCHIVE_SESSIONS_PATH + '/' + task.session_id
    if ((path === ARCHIVE_SESSIONS_PATH + '/open' && request.method() === 'POST' && request.postDataJSON()?.resume_session_id === task.session_id) || ((path === sessionPath || path.startsWith(sessionPath + '/')) && (path.endsWith('/events') || request.method() !== 'GET'))) requests.push({ path, method: request.method() })
  }
  product.on('request', observe)
  try {
    await action()
    expect(requests).toEqual([])
  } finally {
    product.off('request', observe)
    writeFileSync(testInfo.outputPath('archived-readonly-requests.json'), JSON.stringify(requests, null, 2))
  }
}

async function nativeArchivedReadonlyControls() {
  if (await product.getByTestId('workspace-expand-messages').isVisible()) await product.getByTestId('workspace-expand-messages').click()
  const history = product.getByTestId('archived-conversation')
  await expect(history.getByTestId('composer-input')).toBeDisabled()
  await expect(history.getByTestId('composer-send')).toBeDisabled()
  await expect(history.getByTestId('composer-stop')).toHaveCount(0)
}

async function nativeArchivedHistoryRoles(payload) {
  await nativeArchivedReadonlyControls()
  const history = product.getByTestId('archived-conversation')
  for (const turn of payload.turns) {
    if (turn.role === 'user' && turn.text) {
      await expect(history.getByTestId('user-bubble').getByText(turn.text, { exact: true })).toBeVisible()
      await expect(history.locator('.answer-annotation-root').filter({ hasText: turn.text })).toHaveCount(0)
    } else if (turn.role === 'assistant' && turn.text) {
      await expect(history.locator('.answer-annotation-root').getByText(turn.text, { exact: true })).toBeVisible()
      await expect(history.getByTestId('user-bubble').getByText(turn.text, { exact: true })).toHaveCount(0)
    } else if (turn.kind === 'tool' && turn.output) {
      const tool = await conversationTool()
      await expect(tool).toHaveAttribute('data-message-item-id', turn.item_id)
      await expect(tool).toHaveAttribute('data-message-turn-id', turn.turn_id)
      await expect(tool.getByText(turn.output, { exact: true })).toBeVisible()
    }
  }
}

test('native archived task history stays read-only through dark English tree reentry and restore', { annotation: previewConsumption('page-resource', 'project-archives-states', ['populated', 'details', 'readonly', 'tree', 'restored']) }, async ({}, testInfo) => {
  await useDarkEnglishAppearance()
  await expect(product.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(product.locator('html')).toHaveAttribute('lang', LOCALES.en.tag)
  await normalUi(testInfo, async () => {
    const initial = await openNativeTaskArchive('project-archives-states', en)
    const task = await nativeArchivedTask(initial)
    await controls.getByRole('button', { name: en.close, exact: true }).click()
    const row = product.getByTestId('project-archived-task-' + task.session_id)
    await nativeArchivedReadonly(testInfo, task, async () => {
      const reading = product.waitForResponse(response => new URL(response.url()).pathname === ARCHIVE_HISTORY_PATH + task.session_id && response.request().method() === 'GET')
      await row.getByRole('button', { name: task.title, exact: true }).click()
      const response = await reading
      expect(response.status()).toBe(200)
      const payload = await response.json()
      expect(payload.turns.some(turn => turn.kind === 'text' && turn.role === 'user')).toBe(true)
      expect(payload.turns.some(turn => turn.kind === 'text' && turn.role === 'assistant')).toBe(true)
      expect(payload.turns.some(turn => turn.kind === 'tool')).toBe(true)
      await nativeArchivedHistoryRoles(payload)
      await product.getByTestId('project-archive-toggle').click()
      await expect(product.getByTestId('project-archived-list')).not.toBeVisible()
      await product.getByTestId('project-archive-toggle').click()
      await expect(row).toContainText(task.title)
      await row.getByRole('button', { name: task.title, exact: true }).click()
      await nativeArchivedHistoryRoles(payload)
      await product.screenshot({ path: testInfo.outputPath('archived-task-dark-readonly.png'), animations: 'disabled' })
    })
    const restoring = product.waitForResponse(response => new URL(response.url()).pathname === ARCHIVE_SESSIONS_PATH + '/' + task.session_id + '/archive' && response.request().method() === 'PUT')
    await row.hover()
    await row.getByRole('button', { name: componentsEn.taskArchive.restoreTask, exact: true }).click()
    expect((await restoring).status()).toBe(200)
    await expect(row).toHaveCount(0)
    await expect(product.getByTestId('project-task-' + task.session_id)).toBeVisible()
    await expect(product.getByTestId('archived-conversation')).toHaveCount(0)
    const current = await nativeArchiveState()
    expect(current.sessions.find(session => session.session_id === task.session_id).archived).toBe(false)
    expect(current.sessions.filter(session => session.session_id !== task.session_id)).toEqual(initial.sessions.filter(session => session.session_id !== task.session_id))
    expect(current.projects).toEqual(initial.projects)
    await product.screenshot({ path: testInfo.outputPath('archived-task-restored.png'), animations: 'disabled' })
  })
})

for (const state of ['empty', 'pending', 'failed']) {
  const scene = 'project-archives-' + (state === 'empty' ? 'empty' : 'read-' + state)
  test('native archived task catalogue lifecycle: ' + state, { annotation: previewConsumption('page-resource', scene, state === 'empty' ? ['empty'] : state === 'pending' ? ['loading', 'loaded'] : ['error', 'retry-failed']) }, async ({}, testInfo) => {
    await normalUi(testInfo, async () => {
      const reading = nativeArchivedTasksResponse()
      const initial = await openNativeTaskArchive(scene)
      const list = product.getByTestId('project-archived-list')
      if (state === 'pending') {
        await expect(list.getByRole('status')).toBeVisible()
        expect((await reading).status()).toBe(200)
        await nativeArchivedTask(initial)
        await expect(list.getByRole('status')).toHaveCount(0)
        await product.reload()
        const reentered = nativeArchivedTasksResponse()
        await product.getByTestId('project-archive-toggle').click()
        await expect(list.getByRole('status')).toBeVisible()
        await product.screenshot({ path: testInfo.outputPath('archived-task-list-reentry-loading.png'), animations: 'disabled' })
        expect((await reentered).status()).toBe(200)
        await nativeArchivedTask(initial)
        await expect(list.getByRole('status')).toHaveCount(0)
      } else if (state === 'failed') {
        expect((await reading).status()).toBe(503)
        const retry = list.getByRole('button', { name: layoutZh.loadFailed, exact: true })
        await expect(retry).toBeVisible()
        const retried = nativeArchivedTasksResponse()
        await retry.click()
        expect((await retried).status()).toBe(503)
        await expect(retry).toBeVisible()
        await expect(list.getByText(layoutZh.emptyArchivedTasks, { exact: true })).toHaveCount(0)
      } else {
        const response = await reading
        expect(response.status()).toBe(200)
        expect((await response.json()).sessions).toEqual([])
        expect(initial.sessions.filter(session => session.archived)).toEqual([])
        await expect(list.getByText(layoutZh.emptyArchivedTasks, { exact: true })).toBeVisible()
      }
      const current = await nativeArchiveState()
      expect(current.sessions).toEqual(initial.sessions)
      expect(current.projects).toEqual(initial.projects)
      await product.screenshot({ path: testInfo.outputPath('archived-task-list-' + state + '.png'), animations: 'disabled' })
    }, state === 'failed' ? [{ path: ARCHIVE_SESSIONS_PATH, method: 'GET', status: 503 }] : [])
  })
}

for (const state of ['pending', 'failed', 'empty']) {
  test('native archived task history lifecycle: ' + state, { annotation: previewConsumption('page-resource', 'project-archives-history-' + state, state === 'pending' ? ['loading', 'loaded', 'readonly'] : state === 'failed' ? ['error', 'retry-failed'] : ['empty', 'readonly']) }, async ({}, testInfo) => {
    const failures = []
    await normalUi(testInfo, async () => {
      const initial = await openNativeTaskArchive('project-archives-history-' + state)
      const task = await nativeArchivedTask(initial)
      const path = ARCHIVE_HISTORY_PATH + task.session_id
      if (state === 'failed') failures.push({ path, method: 'GET', status: 503 })
      await nativeArchivedReadonly(testInfo, task, async () => {
        const reading = product.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'GET')
        await product.getByTestId('project-archived-task-' + task.session_id).getByRole('button', { name: task.title, exact: true }).click()
        const history = product.getByTestId('archived-conversation')
        if (state === 'pending') {
          await expect(history.getByRole('status')).toBeVisible()
          await product.screenshot({ path: testInfo.outputPath('archived-task-history-loading.png'), animations: 'disabled' })
        }
        const response = await reading
        expect(response.status()).toBe(state === 'failed' ? 503 : 200)
        if (state === 'failed') {
          const retry = history.getByRole('button', { name: componentsZh.taskArchive.retry, exact: true })
          await expect(retry).toBeVisible()
          const retried = product.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'GET')
          await retry.click()
          expect((await retried).status()).toBe(503)
          await expect(retry).toBeVisible()
          await expect(history.getByTestId('user-bubble')).toHaveCount(0)
          await expect(history.locator('.answer-annotation-root')).toHaveCount(0)
        } else {
          const payload = await response.json()
          if (state === 'empty') {
            expect(payload.turns).toEqual([])
            await nativeArchivedReadonlyControls()
            await expect(history.getByTestId('user-bubble')).toHaveCount(0)
            await expect(history.locator('.answer-annotation-root')).toHaveCount(0)
            await expect(history.getByTestId('turn-activity-trigger')).toHaveCount(0)
          } else {
            expect(payload.turns.length).toBeGreaterThan(0)
            await nativeArchivedHistoryRoles(payload)
          }
        }
        await product.screenshot({ path: testInfo.outputPath('archived-task-history-' + state + '.png'), animations: 'disabled' })
      })
      const current = await nativeArchiveState()
      expect(current.projects).toEqual(initial.projects)
      expect(current.sessions).toEqual(initial.sessions)
    }, failures)
  })
}

for (const state of ['pending', 'failed']) {
  test('native archived task deletion lifecycle: ' + state, { annotation: previewConsumption('page-resource', 'project-archives-write-' + state, state === 'pending' ? ['pending', 'deleted'] : ['error', 'retried', 'deleted']) }, async ({}, testInfo) => {
    const failures = []
    await normalUi(testInfo, async () => {
      const initial = await openNativeTaskArchive('project-archives-write-' + state)
      const task = await nativeArchivedTask(initial)
      const row = product.getByTestId('project-archived-task-' + task.session_id)
      const path = ARCHIVE_SESSIONS_PATH + '/' + task.session_id
      if (state === 'failed') failures.push({ path, method: 'DELETE', status: 503 })
      const deletions = []
      product.on('request', request => {
        if (request.method() === 'DELETE' && new URL(request.url()).pathname.startsWith(ARCHIVE_SESSIONS_PATH + '/')) deletions.push(new URL(request.url()).pathname)
      })
      await row.hover()
      await row.getByRole('button', { name: assistantZh.panel.delete, exact: true }).click()
      const dialog = product.getByTestId('session-delete-confirm')
      await dialog.getByRole('button', { name: componentsZh.accountPanel.common.cancel, exact: true }).click()
      expect(deletions).toEqual([])
      await row.hover()
      await row.getByRole('button', { name: assistantZh.panel.delete, exact: true }).click()
      const deleting = product.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'DELETE')
      await dialog.getByRole('button', { name: shellZh.delete.confirm, exact: true }).click()
      if (state === 'pending') {
        await expect(dialog.getByRole('button', { name: componentsZh.accountPanel.common.cancel, exact: true })).toBeDisabled()
        await expect(dialog.getByRole('button', { name: shellZh.delete.deleting, exact: true })).toBeDisabled()
        await product.keyboard.press('Escape')
        await expect(dialog).toBeVisible()
        await product.screenshot({ path: testInfo.outputPath('archived-task-delete-pending.png'), animations: 'disabled' })
        expect((await deleting).status()).toBe(200)
      } else {
        expect((await deleting).status()).toBe(503)
        await expect(dialog).toContainText(shellZh.delete.failed)
        await expect(row).toBeVisible()
        await expect(dialog.getByRole('button', { name: shellZh.delete.confirm, exact: true })).toBeEnabled()
        await product.screenshot({ path: testInfo.outputPath('archived-task-delete-failed.png'), animations: 'disabled' })
        const retried = product.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'DELETE')
        await dialog.getByRole('button', { name: shellZh.delete.confirm, exact: true }).click()
        expect((await retried).status()).toBe(200)
      }
      await expect(dialog).toHaveCount(0)
      await expect(row).toHaveCount(0)
      expect(deletions).toEqual(state === 'pending' ? [path] : [path, path])
      const current = await nativeArchiveState()
      expect(current.sessions.some(session => session.session_id === task.session_id)).toBe(false)
      expect(current.sessions).toEqual(initial.sessions.filter(session => session.session_id !== task.session_id))
      expect(current.projects).toEqual(initial.projects)
      await product.screenshot({ path: testInfo.outputPath('archived-task-deleted-' + state + '.png'), animations: 'disabled' })
    }, failures)
  })
}

function nativeArchivedProjectQuery(url) {
  return url.pathname === ARCHIVE_PROJECTS_PATH && url.searchParams.get('includeArchived') === 'true'
}

function nativeArchivedProjectResponse() {
  return product.waitForResponse(response => response.request().method() === 'GET' && nativeArchivedProjectQuery(new URL(response.url())))
}

async function nativeArchiveState() {
  const url = new URL('/__preview/state', manifest.origin)
  url.searchParams.set('previewInstance', manifest.instance)
  const response = await product.request.get(url.href)
  expect(response.status()).toBe(200)
  return response.json()
}

async function nativeArchiveProjectUi(testInfo, action, readFailure = false) {
  const failures = []
  product.on('response', response => {
    const url = new URL(response.url())
    if (url.pathname === ARCHIVE_PROJECTS_PATH && response.status() >= 400) failures.push({ method: response.request().method(), archived: url.searchParams.get('includeArchived'), status: response.status() })
  })
  await normalUi(testInfo, async () => {
    await action()
    if (readFailure) expect(failures.length).toBeGreaterThan(0)
    for (const failure of failures) expect(failure).toEqual({ method: 'GET', archived: 'true', status: 503 })
  }, readFailure ? [{ path: ARCHIVE_PROJECTS_PATH, method: 'GET', status: 503 }] : [])
}

async function nativeArchivedProjectBusy(projects) {
  for (const id of ['account-archived-selection-mode', 'account-archived-select-all', 'account-archived-batch-unarchive', 'account-archived-batch-delete']) await expect(product.getByTestId(id)).toBeDisabled()
  for (const project of projects) {
    for (const action of ['select', 'restore', 'delete']) await expect(product.getByTestId('account-archived-' + action + '-' + project.id)).toBeDisabled()
  }
}

for (const state of ['pending', 'failed']) {
  const scene = 'settings-archives-project-read-' + state
  test('native archived project read lifecycle: ' + state, { annotation: previewConsumption('settings-archives', scene, state === 'pending' ? ['project-read-loading', 'project-read-loaded'] : ['project-read-error', 'project-read-retried']) }, async ({}, testInfo) => {
    await nativeArchiveProjectUi(testInfo, async () => {
      const reading = nativeArchivedProjectResponse()
      await scenario('settings-archives', scene)
      const page = product.getByTestId('account-settings-archives')
      await expect(page).toBeVisible()
      await expect(product.getByTestId('account-settings-archives-empty')).not.toBeVisible()
      const initial = await nativeArchiveState()
      const archived = initial.projects.filter(project => project.archived_at != null)
      expect(archived).toHaveLength(2)
      if (state === 'pending') {
        await expect(page.getByRole('status')).toBeVisible()
        await product.screenshot({ path: testInfo.outputPath('archives-project-loading.png'), animations: 'disabled' })
        expect((await reading).status()).toBe(200)
        for (const project of archived) await expect(product.getByTestId('account-archived-' + project.id)).toBeVisible()
        await expect(page.getByRole('status')).toHaveCount(0)
      } else {
        expect((await reading).status()).toBe(503)
        await expect(page.getByRole('alert')).toBeVisible()
        const retry = page.getByRole('button', { name: componentsZh.accountPanel.common.retry, exact: true })
        const retried = nativeArchivedProjectResponse()
        await retry.click()
        expect((await retried).status()).toBe(503)
        await expect(page.getByRole('alert')).toBeVisible()
        await expect(retry).toBeEnabled()
        await expect(product.getByTestId('account-settings-archives-empty')).not.toBeVisible()
      }
      const current = await nativeArchiveState()
      expect(current.projects).toEqual(initial.projects)
      expect(current.sessions).toEqual(initial.sessions)
      await product.screenshot({ path: testInfo.outputPath('archives-project-' + state + '-result.png'), animations: 'disabled' })
    }, state === 'failed')
  })
}

test('native archived project recovery keeps single restore busy through its receipt and catalogue refresh', { annotation: previewConsumption('settings-archives', 'settings-archives-required', ['project-read-error', 'project-read-retried', 'project-read-recovered', 'project-single-restore-busy']) }, async ({}, testInfo) => {
  await nativeArchiveProjectUi(testInfo, async () => {
    const mutations = []
    for (const surface of [product, controls]) surface.on('request', request => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'POST' && (path === PREVIEW_ARCHIVE.recoveryPath || path.endsWith('/archive'))) mutations.push(path)
    })
    const reading = nativeArchivedProjectResponse()
    await scenario('settings-archives', 'settings-archives-required')
    expect((await reading).status()).toBe(503)
    const page = product.getByTestId('account-settings-archives')
    const retry = page.getByRole('button', { name: componentsZh.accountPanel.common.retry, exact: true })
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(product.getByTestId('account-settings-archives-empty')).not.toBeVisible()
    const initial = await nativeArchiveState()
    const archived = initial.projects.filter(project => project.archived_at != null)
    expect(archived).toHaveLength(2)
    const recovering = controls.waitForResponse(response => new URL(response.url()).pathname === PREVIEW_ARCHIVE.recoveryPath && response.request().method() === 'POST')
    await controls.getByTestId('preview-archive-recover').click()
    expect((await recovering).status()).toBe(200)
    await expect(page.getByRole('alert')).toBeVisible()
    const recovered = nativeArchivedProjectResponse()
    await retry.click()
    expect((await recovered).status()).toBe(200)
    for (const project of archived) await expect(product.getByTestId('account-archived-' + project.id)).toBeVisible()
    await expect(page.getByRole('alert')).not.toBeVisible()
    await product.getByTestId('account-archived-selection-mode').click()
    await product.getByTestId('account-archived-select-' + archived[1].id).click()
    const path = ARCHIVE_PROJECTS_PATH + '/' + archived[0].id + '/archive'
    const restore = product.getByTestId('account-archived-restore-' + archived[0].id)
    const release = await holdNativeRead(nativeArchivedProjectQuery)
    let received = false
    const completed = product.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST').then(response => { received = true; return response })
    const refreshed = nativeArchivedProjectResponse()
    const refreshing = product.waitForRequest(request => request.method() === 'GET' && nativeArchivedProjectQuery(new URL(request.url())))
    try {
      await restore.click()
      await nativeArchivedProjectBusy(archived)
      expect(received).toBe(false)
      expect((await completed).status()).toBe(200)
      await refreshing
      await nativeArchivedProjectBusy(archived)
      await expect(product.getByTestId('account-archived-' + archived[0].id)).toBeVisible()
      await product.screenshot({ path: testInfo.outputPath('archives-project-restore-refresh-pending.png'), animations: 'disabled' })
    } finally {
      await release()
    }
    expect((await refreshed).status()).toBe(200)
    await expect(product.getByTestId('account-archived-' + archived[0].id)).toHaveCount(0)
    await expect(product.getByTestId('account-archived-' + archived[1].id)).toBeVisible()
    const current = await nativeArchiveState()
    expect(current.projects.find(project => project.id === archived[0].id).archived_at).toBeNull()
    expect(current.projects.filter(project => project.id !== archived[0].id)).toEqual(initial.projects.filter(project => project.id !== archived[0].id))
    expect(current.sessions).toEqual(initial.sessions)
    expect(mutations).toEqual([PREVIEW_ARCHIVE.recoveryPath, path])
    await product.reload()
    await expect(product.getByTestId('account-archived-' + archived[0].id)).toHaveCount(0)
    await expect(product.getByTestId('account-archived-' + archived[1].id)).toBeVisible()
    await product.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: componentsZh.accountPanel.common.close, exact: true }).click()
    await expect(product.getByTestId('home-project-' + archived[0].name)).toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('archives-project-restored-home.png'), animations: 'disabled' })
  }, true)
})

test('native archived project empty catalogue is genuine and read-only', { annotation: previewConsumption('settings-archives', 'settings-archives-empty', ['empty']) }, async ({}, testInfo) => {
  await nativeArchiveProjectUi(testInfo, async () => {
    const reading = nativeArchivedProjectResponse()
    await scenario('settings-archives', 'settings-archives-empty')
    const response = await reading
    expect(response.status()).toBe(200)
    expect((await response.json()).projects.filter(project => project.archived_at != null)).toEqual([])
    await expect(product.getByTestId('account-settings-archives-empty')).toBeVisible()
    await expect(product.getByTestId('account-settings-archives').getByRole('alert')).toHaveCount(0)
    const current = await nativeArchiveState()
    expect(current.projects.filter(project => project.archived_at != null)).toEqual([])
    await product.screenshot({ path: testInfo.outputPath('archives-project-empty.png'), animations: 'disabled' })
  })
})

test('native archived project dark English public settings navigation cancels deletion without mutation', { annotation: previewConsumption('settings-archives', 'settings-archives-states', ['selected', 'cancelled']) }, async ({}, testInfo) => {
  await useDarkEnglishAppearance()
  await expect(product.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(product.locator('html')).toHaveAttribute('lang', LOCALES.en.tag)
  await scenario('settings-archives', 'settings-archives-states', en)
  await product.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: componentsEn.accountPanel.common.close, exact: true }).click()
  await controls.getByRole('button', { name: en.close, exact: true }).click()
  await nativeArchiveProjectUi(testInfo, async () => {
    const deletions = []
    product.on('request', request => {
      if (request.method() === 'DELETE' && new URL(request.url()).pathname.startsWith(ARCHIVE_PROJECTS_PATH + '/')) deletions.push(request.url())
    })
    await product.getByTestId('activity-account').click()
    await product.getByTestId('account-menu-settings').click()
    await product.getByTestId('account-settings-nav-archives').click()
    const initial = await nativeArchiveState()
    const archived = initial.projects.filter(project => project.archived_at != null)
    expect(archived).toHaveLength(2)
    await product.getByTestId('account-archived-selection-mode').click()
    await product.getByTestId('account-archived-select-' + archived[0].id).click()
    await expect(product.getByTestId('account-archived-select-all')).toHaveAttribute('aria-checked', 'mixed')
    await product.getByTestId('account-archived-batch-delete').click()
    const confirmation = product.getByRole('alertdialog')
    await expect(confirmation).toContainText(componentsEn.accountPanel.archives.deleteFilesNote)
    await expect(confirmation.getByRole('button', { name: componentsEn.accountPanel.archives.delete, exact: true })).toBeEnabled()
    await product.screenshot({ path: testInfo.outputPath('archives-project-dark-cancel-confirm.png'), animations: 'disabled' })
    await confirmation.getByRole('button', { name: componentsEn.accountPanel.archives.cancel, exact: true }).focus()
    await product.keyboard.press('Enter')
    await expect(confirmation).not.toBeVisible()
    await expect(product.getByTestId('account-archived-' + archived[0].id)).toBeVisible()
    expect(deletions).toEqual([])
    const current = await nativeArchiveState()
    expect(current.projects).toEqual(initial.projects)
    expect(current.sessions).toEqual(initial.sessions)
  })
})

test('native archived projects restore mixed selection through single and batch actions', { annotation: previewConsumption('settings-archives', 'settings-archives-states', ['populated', 'selected', 'mixed', 'restored']) }, async ({}, testInfo) => {
  await normalUi(testInfo, async () => {
    await scenario('settings-archives', 'settings-archives-states')
    const initial = await nativeArchiveState()
    const archived = initial.projects.filter(project => project.archived_at != null)
    expect(archived).toHaveLength(2)
    for (const project of archived) await expect(product.getByTestId('account-archived-' + project.id)).toBeVisible()
    await product.getByTestId('account-archived-selection-mode').click()
    const all = product.getByTestId('account-archived-select-all')
    await expect(product.getByTestId('account-archived-batch-unarchive')).toBeDisabled()
    await product.getByTestId('account-archived-select-' + archived[0].id).click()
    await expect(all).toHaveAttribute('aria-checked', 'mixed')
    await expect(product.getByTestId('account-archived-selected-count')).toContainText('1')
    await all.click()
    await expect(all).toHaveAttribute('aria-checked', 'true')
    await all.click()
    await expect(product.getByTestId('account-archived-batch-delete')).toBeDisabled()
    const path = ARCHIVE_PROJECTS_PATH + '/' + archived[0].id + '/archive'
    const restoring = product.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST')
    await product.getByTestId('account-archived-restore-' + archived[0].id).click()
    expect((await restoring).status()).toBe(200)
    await expect(product.getByTestId('account-archived-' + archived[0].id)).toHaveCount(0)
    await expect(all).toBeEnabled()
    await all.click()
    await product.getByTestId('account-archived-batch-unarchive').click()
    await expect(product.getByTestId('account-settings-archives-empty')).toBeVisible()
    await expect(product.getByText('成功 1 项，失败 0 项', { exact: true })).toBeVisible()
    const current = await nativeArchiveState()
    for (const project of archived) expect(current.projects.find(item => item.id === project.id).archived_at).toBeNull()
    expect(current.projects.filter(project => !archived.some(item => item.id === project.id))).toEqual(initial.projects.filter(project => !archived.some(item => item.id === project.id)))
    expect(current.sessions).toEqual(initial.sessions)
    await product.reload()
    await expect(product.getByTestId('account-settings-archives-empty')).toBeVisible()
    await product.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: componentsZh.accountPanel.common.close, exact: true }).click()
    for (const project of archived) await expect(product.getByTestId('home-project-' + project.name)).toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('archives-project-mixed-restored.png'), animations: 'disabled' })
  })
})

test('native archived projects retry partial batch restoration through the retained project selection', { annotation: previewConsumption('settings-archives', 'settings-archives-write-failed', ['partial', 'error', 'retried', 'restored']) }, async ({}, testInfo) => {
  const failures = []
  await normalUi(testInfo, async () => {
    await scenario('settings-archives', 'settings-archives-write-failed')
    const initial = await nativeArchiveState()
    const archived = initial.projects.filter(project => project.archived_at != null)
    expect(archived).toHaveLength(2)
    const responses = []
    product.on('response', response => {
      const path = new URL(response.url()).pathname
      if (response.request().method() === 'POST' && archived.some(project => path === ARCHIVE_PROJECTS_PATH + '/' + project.id + '/archive')) responses.push({ path, status: response.status() })
    })
    for (const project of archived) failures.push({ path: ARCHIVE_PROJECTS_PATH + '/' + project.id + '/archive', method: 'POST', status: 503 })
    await product.getByTestId('account-archived-selection-mode').click()
    await product.getByTestId('account-archived-select-all').click()
    await product.getByTestId('account-archived-batch-unarchive').click()
    await expect(product.getByText('成功 1 项，失败 1 项', { exact: true })).toBeVisible()
    await expect(product.getByTestId('account-archived-batch-unarchive')).toBeDisabled()
    const partial = await nativeArchiveState()
    const remaining = partial.projects.filter(project => project.archived_at != null)
    expect(remaining).toHaveLength(1)
    const retained = remaining[0]
    expect(archived.some(project => project.id === retained.id)).toBe(true)
    expect(responses).toHaveLength(2)
    expect(responses.filter(response => response.status === 503)).toEqual([{ path: ARCHIVE_PROJECTS_PATH + '/' + retained.id + '/archive', status: 503 }])
    expect(responses.filter(response => response.status === 200)).toHaveLength(1)
    await expect(product.getByTestId('account-archived-' + retained.id)).toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('archives-project-partial.png'), animations: 'disabled' })
    await product.getByTestId('account-archived-select-' + retained.id).click()
    await product.getByTestId('account-archived-batch-unarchive').click()
    await expect(product.getByTestId('account-settings-archives-empty')).toBeVisible()
    expect(responses).toHaveLength(3)
    expect(responses[2]).toEqual({ path: ARCHIVE_PROJECTS_PATH + '/' + retained.id + '/archive', status: 200 })
    const current = await nativeArchiveState()
    for (const project of archived) expect(current.projects.find(item => item.id === project.id).archived_at).toBeNull()
    expect(current.sessions).toEqual(initial.sessions)
    await product.screenshot({ path: testInfo.outputPath('archives-project-partial-retried.png'), animations: 'disabled' })
  }, failures)
})

for (const action of ['restore', 'delete']) {
  test('native archived projects batch mutation: ' + action, { annotation: previewConsumption('settings-archives', 'settings-archives-write-pending', ['pending', action === 'restore' ? 'restored' : 'deleted']) }, async ({}, testInfo) => {
    await normalUi(testInfo, async () => {
      await scenario('settings-archives', 'settings-archives-write-pending')
      const initial = await nativeArchiveState()
      const archived = initial.projects.filter(project => project.archived_at != null)
      expect(archived).toHaveLength(2)
      const requests = []
      const responses = []
      const operations = []
      let deletions = []
      product.on('request', request => {
        if (archived.some(project => new URL(request.url()).pathname === ARCHIVE_PROJECTS_PATH + '/' + project.id + (action === 'restore' ? '/archive' : '')) && request.method() === (action === 'restore' ? 'POST' : 'DELETE')) requests.push(request)
      })
      product.on('response', response => {
        if (archived.some(project => new URL(response.url()).pathname === ARCHIVE_PROJECTS_PATH + '/' + project.id + (action === 'restore' ? '/archive' : '')) && response.request().method() === (action === 'restore' ? 'POST' : 'DELETE')) responses.push(response)
        if (new URL(response.url()).pathname.startsWith('/api/content/operations/') && response.request().method() === 'GET' && response.status() === 200) operations.push(response)
      })
      await product.getByTestId('account-archived-selection-mode').click()
      await product.getByTestId('account-archived-select-all').click()
      const trigger = product.getByTestId('account-archived-batch-' + (action === 'restore' ? 'unarchive' : 'delete'))
      await trigger.click()
      const dialog = product.getByRole('alertdialog')
      if (action === 'delete') {
        await expect(dialog).toContainText(componentsZh.accountPanel.archives.deleteFilesNote)
        await dialog.getByRole('button', { name: componentsZh.accountPanel.archives.cancel, exact: true }).click()
        expect(requests).toEqual([])
        await trigger.click()
        deletions = archived.flatMap(project => {
          const accepted = product.waitForResponse(response => new URL(response.url()).pathname === ARCHIVE_PROJECTS_PATH + '/' + project.id && response.request().method() === 'DELETE' && response.status() === 202)
          const completed = product.waitForResponse(async response => {
            if (!new URL(response.url()).pathname.startsWith('/api/content/operations/') || response.request().method() !== 'GET' || response.status() !== 200) return false
            const receipt = await response.json()
            if (receipt.state !== 'succeeded' || receipt.result?.id !== project.id) return false
            const submission = await (await accepted).json()
            return receipt.operation === submission.operation && new URL(response.url()).pathname === '/api/content/operations/' + submission.operation
          })
          return [accepted, completed]
        })
      }
      const interaction = (async () => {
        if (action === 'delete') await dialog.getByTestId('account-archived-delete-confirm').click()
        await nativeArchivedProjectBusy(archived)
        if (action === 'delete') {
          await expect(dialog.getByTestId('account-archived-delete-confirm')).toHaveAttribute('aria-disabled', 'true')
          await expect(dialog.getByRole('button', { name: componentsZh.accountPanel.archives.cancel, exact: true })).toBeDisabled()
          await product.keyboard.press('Escape')
          await expect(dialog).toBeVisible()
        }
        await product.screenshot({ path: testInfo.outputPath('archives-project-batch-' + action + '-pending.png'), animations: 'disabled' })
      })()
      const settled = await Promise.allSettled([...deletions, interaction])
      const errors = settled.filter(result => result.status === 'rejected').map(result => result.reason)
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, 'Archived project batch mutation failed')
      await expect(product.getByTestId('account-settings-archives-empty')).toBeVisible()
      await expect(dialog).not.toBeVisible()
      await expect(product.getByText('成功 2 项，失败 0 项', { exact: true })).toBeVisible()
      expect(requests).toHaveLength(2)
      expect(new Set(requests.map(request => new URL(request.url()).pathname)).size).toBe(2)
      expect(responses.map(response => response.status())).toEqual(action === 'restore' ? [200, 200] : [202, 202])
      if (action === 'delete') {
        const accepted = await Promise.all(responses.map(response => response.json()))
        expect(new Set(accepted.map(response => response.operation)).size).toBe(2)
        const receipts = await Promise.all(operations.map(response => response.json()))
        for (const project of archived) expect(receipts.some(receipt => receipt.state === 'succeeded' && receipt.result?.id === project.id && receipt.result.removed && receipt.result.files_kept)).toBe(true)
      } else for (const request of requests) expect(request.postDataJSON()).toMatchObject({ archived: false })
      const current = await nativeArchiveState()
      for (const project of archived) {
        if (action === 'restore') expect(current.projects.find(item => item.id === project.id).archived_at).toBeNull()
        else expect(current.projects.some(item => item.id === project.id)).toBe(false)
      }
      expect(current.projects.filter(project => !archived.some(item => item.id === project.id))).toEqual(initial.projects.filter(project => !archived.some(item => item.id === project.id)))
      expect(current.sessions.filter(session => !archived.some(project => project.root === session.project_path))).toEqual(initial.sessions.filter(session => !archived.some(project => project.root === session.project_path)))
      await product.reload()
      await expect(product.getByTestId('account-settings-archives-empty')).toBeVisible()
      await product.screenshot({ path: testInfo.outputPath('archives-project-batch-' + action + '-reloaded.png'), animations: 'disabled' })
    })
  })
}

for (const mode of ['single', 'batch']) {
  test(`archives project ${mode} deletion preserves the failure reason and allows retry`, { annotation: [
    { type: INITIAL_TARGET_ANNOTATION, description: JSON.stringify({ pageId: 'settings-archives', sceneId: 'settings-archives-write-failed' }) },
    previewConsumption('settings-archives', 'settings-archives-write-failed', ['error', 'retried', 'deleted']),
  ] }, async ({}, testInfo) => {
    const deletions = []
    product.on('request', request => {
      if (request.method() === 'DELETE' && new URL(request.url()).pathname.startsWith(ARCHIVE_PROJECTS_PATH + '/')) deletions.push(new URL(request.url()).pathname)
    })
    const remove = product.locator('[data-testid^="account-archived-delete-"]').first()
    await expect(remove).toBeVisible()
    const identifier = await remove.getAttribute('data-testid')
    const row = product.getByTestId(identifier.replace('account-archived-delete-', 'account-archived-'))
    if (mode === 'batch') {
      const selection = product.getByTestId('account-archived-selection-mode')
      await selection.click()
      await expect(selection).toHaveAttribute('aria-pressed', 'true')
      await product.getByTestId('account-archived-select-all').click()
      await product.getByTestId('account-archived-batch-delete').click()
    } else {
      await remove.click()
    }
    const dialog = product.getByRole('alertdialog')
    await expect(dialog).toContainText(componentsZh.accountPanel.archives.deleteFilesNote)
    await dialog.getByRole('button', { name: componentsZh.accountPanel.archives.cancel, exact: true }).click()
    expect(deletions).toEqual([])
    if (mode === 'batch') await product.getByTestId('account-archived-batch-delete').click()
    else await remove.click()
    await dialog.getByTestId('account-archived-delete-confirm').click()
    await expect(dialog).not.toBeVisible()
    await expect(product.getByText(`未能移除项目（${PREVIEW_ARCHIVE.writeFailure}），请确认原因后重试。`, { exact: true })).toBeVisible()
    await expect(product.getByText('操作失败（unknown_project）', { exact: true })).toHaveCount(0)
    await expect(row).toBeVisible()
    if (mode === 'batch') {
      await expect(product.getByText('成功 1 项，失败 1 项', { exact: true })).toBeVisible()
      await expect(product.locator('[data-testid^="account-archived-delete-"]')).toHaveCount(1)
    }
    await product.screenshot({ path: testInfo.outputPath('deletion-failure.png') })
    await row.getByTestId(identifier).click()
    const path = ARCHIVE_PROJECTS_PATH + '/' + identifier.replace('account-archived-delete-', '')
    const release = await holdNativeRead(url => url.pathname.startsWith('/api/content/operations/'))
    const accepted = product.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'DELETE')
    let terminal
    try {
      await dialog.getByTestId('account-archived-delete-confirm').click()
      const response = await accepted
      expect(response.status()).toBe(202)
      const receipt = await response.json()
      expect(receipt.operation).toBeTruthy()
      terminal = product.waitForResponse(async response => new URL(response.url()).pathname === '/api/content/operations/' + receipt.operation && response.request().method() === 'GET' && (await response.json()).state === 'succeeded')
    } finally {
      await release()
    }
    expect(await (await terminal).json()).toMatchObject({ state: 'succeeded', result: { id: identifier.replace('account-archived-delete-', ''), removed: true, files_kept: true } })
    await expect(row).toHaveCount(0)
    expect(deletions.filter(value => value === path)).toHaveLength(2)
    expect(deletions).toHaveLength(mode === 'single' ? 2 : 3)
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

async function openNativeAuthorization(sceneId) {
  await scenario('page-conversation', sceneId)
  await product.getByRole('button', { name: '返回首页', exact: true }).click()
  await product.getByTestId('home-project-设计协作项目').click()
  await product.getByRole('navigation', { name: layoutZh.tasks, exact: true }).getByRole('button', { name: /模拟(?:文献会话|会话)/ }).click()
}

function nativeAuthorizationReply() {
  return product.waitForResponse(response => /\/api\/serve\/sessions\/[^/]+\/hil\//.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
}

test('native read-only authorization is compact without changing selectable authorization', async ({}, testInfo) => {
  test.setTimeout(CENTER_MATRIX_TIMEOUT_MS)
  await openNativeAuthorization('conversation-review-fulltext-pending')
  const pending = product.getByTestId('hil-card')
  await expect(pending).toBeVisible()
  await expect(product.getByTestId('hil-question-scroll-area')).toBeHidden()
  await expect(pending.getByRole('group', { name: '请求授权文献', exact: true })).toBeVisible()
  await expect(pending.getByRole('checkbox')).toHaveCount(0)
  await expect(pending.getByTestId('hil-question-toggle')).toHaveCount(0)
  await expect(pending.getByRole('button', { name: '调整授权范围', exact: true })).toHaveCount(0)
  await expect(product.getByRole('button', { name: literatureZh.result.viewAll, exact: true })).toBeVisible()
  await product.screenshot({ path: testInfo.outputPath('compact-review-pending.png') })
  const fixedReply = nativeAuthorizationReply()
  await pending.getByRole('button', { name: '确认授权', exact: true }).click()
  expect((await (await fixedReply).json()).interaction.selected_paper_ids).toHaveLength(PREVIEW_AUTHORIZATION.papers.length)
  const node = product.getByTestId('literature-authorization-node')
  await expect(node).toContainText('用户已为读取文献全文授权')
  await expect(product.getByTestId('literature-authorization-receipt')).toHaveCount(0)
  await expect(product.getByTestId('literature-reauthorize')).toHaveCount(0)
  await product.screenshot({ path: testInfo.outputPath('compact-review-authorized.png') })
  await openNativeAuthorization('conversation-review-fulltext-rejected')
  await expect(node).toContainText('用户已拒绝为读取文献全文授权')
  await expect(node).toContainText('已拒绝全文授权')
  await expect(node.getByRole('button', { name: '重新授权', exact: true })).toBeEnabled()
  await product.screenshot({ path: testInfo.outputPath('compact-review-rejected.png') })
  await openNativeAuthorization('conversation-fulltext-pending')
  await pending.getByRole('button', { name: '调整授权范围', exact: true }).click()
  await expect(pending.getByRole('checkbox')).toHaveCount(PREVIEW_AUTHORIZATION.papers.length + 1)
  await expect(product.getByTestId('hil-question-scroll-area')).toBeVisible()
  await expect(pending.getByRole('button', { name: '调整授权范围', exact: true })).toBeVisible()
  await product.screenshot({ path: testInfo.outputPath('selectable-fulltext-pending.png') })
  await pending.getByRole('checkbox').nth(1).uncheck()
  const subsetReply = nativeAuthorizationReply()
  await pending.getByRole('button', { name: '确认授权', exact: true }).click()
  const selected = (await (await subsetReply).json()).interaction.selected_paper_ids
  expect(selected).toHaveLength(PREVIEW_AUTHORIZATION.papers.length - 1)
  expect(selected).not.toContain('paper:preview-paper-1')
  expect(selected).toContain('paper:preview-paper-2')
  await expect(node).toContainText('用户已为读取文献全文授权')
  await expect(node.getByRole('button', { name: literatureZh.result.viewAll, exact: true })).toBeVisible()
  await product.screenshot({ path: testInfo.outputPath('selectable-fulltext-authorized.png') })
})

test('native authorization shows one standalone status row without a separate receipt', async ({}, testInfo) => {
  test.setTimeout(CENTER_MATRIX_TIMEOUT_MS)
  for (const kind of ['fulltext', 'review-fulltext']) {
    for (const state of ['authorized', 'rejected']) {
      await scenario('page-conversation', `conversation-${kind}-${state}`)
      const node = product.getByTestId('literature-authorization-node')
      const result = node.getByRole('button', { name: literatureZh.result.viewAll, exact: true })
      await expect(node).toHaveCount(1)
      const status = node.getByRole('status')
      const label = state === 'authorized' ? '用户已为读取文献全文授权' : '用户已拒绝为读取文献全文授权'
      await expect(status).toHaveText(label)
      await expect(status.getByText(label, { exact: true })).toHaveCSS('font-size', '14px')
      await expect(status.locator('.icon-qingqiupizhun')).toBeVisible()
      await expect(result).toBeVisible()
      await expect(node.locator('[data-artifact-receipt]')).toHaveCount(1)
      await expect(product.getByTestId('literature-authorization-receipt')).toHaveCount(0)
      await expect(node.getByTestId('turn-activity-trigger')).toHaveCount(0)
      if (state === 'rejected') await expect(node.getByTestId('literature-reauthorize')).toBeVisible()
      else await expect(node.getByTestId('literature-reauthorize')).toHaveCount(0)
      await product.screenshot({
        path: testInfo.outputPath(`authorization-node-${kind}-${state}.png`),
      })
      await result.click()
      const results = product.getByTestId('literature-search-tab')
      await expect(results).toBeInViewport()
      for (const title of PREVIEW_AUTHORIZATION.papers) {
        await expect(results.getByText(title, { exact: true }).first()).toBeVisible()
      }
    }
  }
  const monitor = product.getByRole('button', { name: '隐藏任务监控', exact: true })
  if (await monitor.isVisible()) await monitor.click()
  const sidebar = product.getByTestId('sidebar-collapse')
  if (await sidebar.isVisible()) await sidebar.click()
  await controls.getByRole('combobox', { name: '主题', exact: true }).click()
  await controls.getByRole('option', { name: '深色', exact: true }).click()
  await expect(product.locator('html')).toHaveAttribute('data-theme', 'dark')
  const native = await app.browserWindow(product)
  await native.evaluate(
    (window, minimum) => window.setSize(minimum.width, minimum.height),
    WORKSPACE_WINDOW_MINIMUM
  )
  const retry = product.getByRole('button', { name: '重新授权', exact: true })
  await retry.scrollIntoViewIfNeeded()
  await expect(retry).toBeInViewport({ ratio: 1 })
  await expect(retry).toBeEnabled()
  await product.screenshot({ path: testInfo.outputPath('authorization-node-dark-minimum.png') })
})

test('native authorization expansion restores the conversation bottom position', async ({}, testInfo) => {
  test.setTimeout(CENTER_MATRIX_TIMEOUT_MS)
  const native = await app.browserWindow(product)
  await native.evaluate((window, minimum) => window.setSize(window.getSize()[0], minimum.height), WORKSPACE_WINDOW_MINIMUM)
  await scenario('page-conversation', 'conversation-fulltext-pending')
  const scopeToggle = product.getByRole('button', { name: '调整授权范围', exact: true })
  await scopeToggle.click()
  const stream = product.locator('.conversation-stream')
  const position = () => stream.evaluate(element => ({ top: element.scrollTop, distance: element.scrollHeight - element.clientHeight - element.scrollTop, height: element.clientHeight }))
  await expect.poll(async () => (await position()).distance).toBeLessThanOrEqual(1)
  const original = await position()
  expect(original.top).toBeGreaterThan(0)
  await product.screenshot({ path: testInfo.outputPath('authorization-scroll-before.png') })
  for (let cycle = 0; cycle < 3; cycle++) {
    await scopeToggle.click()
    await expect.poll(async () => (await position()).height).toBeGreaterThan(original.height)
    if (cycle === 0) await product.screenshot({ path: testInfo.outputPath('authorization-scroll-collapsed.png') })
    await scopeToggle.click()
    await expect.poll(async () => (await position()).height).toBe(original.height)
    await expect.poll(async () => (await position()).distance).toBeLessThanOrEqual(1)
    await expect.poll(async () => (await position()).top).toBeCloseTo(original.top, 0)
  }
  await product.screenshot({ path: testInfo.outputPath('authorization-scroll-restored.png') })
  await stream.hover()
  await product.mouse.wheel(0, -100)
  await expect.poll(async () => (await position()).distance).toBeGreaterThan(0)
  await scopeToggle.click()
  await scopeToggle.click()
  await expect.poll(async () => (await position()).height).toBe(original.height)
  await expect.poll(async () => (await position()).distance).toBeGreaterThan(0)
})

test('native authorization cards keep eight pixel gaps above and below', async ({}, testInfo) => {
  test.setTimeout(CENTER_MATRIX_TIMEOUT_MS)
  const gaps = () => product.getByTestId('hil-card').evaluate(element => {
    const composer = document.querySelector('[data-testid="composer-drop-zone"]')
    const stream = document.querySelector('.conversation-stream')
    return {
      below: composer.getBoundingClientRect().top - element.getBoundingClientRect().bottom,
      above: element.getBoundingClientRect().top - stream.getBoundingClientRect().bottom,
    }
  })
  for (const scene of ['conversation-review-fulltext-pending', 'conversation-fulltext-pending']) {
    await scenario('page-conversation', scene)
    const card = product.getByTestId('hil-card')
    const composer = product.getByTestId('composer-drop-zone')
    await expect(card).toBeVisible()
    await expect(composer).toBeVisible()
    await expect(product.locator('.conversation-stream')).toBeVisible()
    await expect.poll(async () => (await gaps()).below).toBe(8)
    await expect.poll(async () => (await gaps()).above).toBe(8)
    await product.screenshot({ path: testInfo.outputPath(scene + '-spaced.png') })
  }
  await controls.getByRole('combobox', { name: '主题', exact: true }).click()
  await Promise.all([
    product.waitForEvent('framenavigated', frame => frame === product.mainFrame()),
    controls.waitForEvent('framenavigated', frame => frame === controls.mainFrame()),
    controls.getByRole('option', { name: '深色', exact: true }).click(),
  ])
  await expect(product.getByTestId('hil-card')).toBeVisible()
  await expect(product.locator('html')).toHaveAttribute('data-theme', 'dark')
  const native = await app.browserWindow(product)
  await native.evaluate((window, minimum) => window.setSize(minimum.width, minimum.height), WORKSPACE_WINDOW_MINIMUM)
  await expect.poll(async () => (await gaps()).below).toBe(8)
  await expect.poll(async () => (await gaps()).above).toBe(8)
  await product.screenshot({ path: testInfo.outputPath('authorization-spaced-dark-minimum.png') })
})


test('native fulltext authorization scenes show pending authorized rejected and reopen the same mock scope', async ({}, testInfo) => {
  test.setTimeout(CENTER_MATRIX_TIMEOUT_MS)
  await openNativeAuthorization('conversation-fulltext-pending')
  const pending = product.getByTestId('hil-card')
  await pending.getByRole('button', { name: '调整授权范围', exact: true }).click()
  await expect(pending.getByRole('checkbox')).toHaveCount(PREVIEW_AUTHORIZATION.papers.length + 1)
  await expect(pending).toContainText(PREVIEW_AUTHORIZATION.papers[0])
  await product.screenshot({ path: testInfo.outputPath('authorization-pending.png') })
  await expect(pending.getByRole('button', { name: '确认授权', exact: true })).toBeVisible()
  await expect(pending.getByRole('button', { name: '拒绝', exact: true })).toBeVisible()
  await pending.getByRole('button', { name: '确认授权', exact: true }).click()
  await expect(product.getByTestId('literature-authorization-node')).toContainText('用户已为读取文献全文授权')
  await expect(product.getByTestId('literature-authorization-receipt')).toHaveCount(0)

  await openNativeAuthorization('conversation-fulltext-authorized')
  await expect(product.getByRole('button', { name: literatureZh.result.viewAll, exact: true })).toBeVisible()
  await expect(product.getByTestId('literature-authorization-node')).toContainText('用户已为读取文献全文授权')
  await expect(product.getByTestId('hil-dock')).toHaveCount(0)
  await expect(product.getByTestId('literature-authorization-receipt')).toHaveCount(0)
  await product.screenshot({ path: testInfo.outputPath('authorization-authorized.png') })

  await openNativeAuthorization('conversation-fulltext-rejected')
  await expect(product.getByRole('button', { name: literatureZh.result.viewAll, exact: true })).toBeVisible()
  await expect(product.getByTestId('literature-authorization-node')).toContainText('用户已拒绝为读取文献全文授权')
  await expect(product.getByTestId('literature-reauthorize')).toBeEnabled()
  await product.screenshot({ path: testInfo.outputPath('authorization-rejected.png') })
  await product.getByTestId('literature-reauthorize').click()
  await pending.getByRole('button', { name: '调整授权范围', exact: true }).click()
  await expect(product.getByTestId('hil-card').getByRole('checkbox')).toHaveCount(
    PREVIEW_AUTHORIZATION.papers.length + 1
  )
  await product
    .getByTestId('hil-card')
    .getByRole('checkbox', { name: '全选', exact: true })
    .uncheck()
  await product.getByTestId('hil-subset-paper-0-paper:preview-paper-1').check()
  const subsetReply = nativeAuthorizationReply()
  await pending.getByRole('button', { name: '确认授权', exact: true }).click()
  expect((await (await subsetReply).json()).interaction.selected_paper_ids).toEqual(['paper:preview-paper-1'])
  await expect(product.getByTestId('literature-authorization-node')).toHaveCount(1)
  await expect(product.getByTestId('literature-authorization-node')).toContainText('用户已为读取文献全文授权')
  await expect(product.getByTestId('literature-authorization-receipt')).toHaveCount(0)
  await product.screenshot({ path: testInfo.outputPath('authorization-subset-authorized.png') })
  await product.getByRole('button', { name: literatureZh.result.viewAll, exact: true }).click()
  await expect(product.getByTestId('literature-search-tab')).toBeInViewport()
  for (const title of PREVIEW_AUTHORIZATION.papers)
    await expect(product.getByTestId('literature-search-tab').getByText(title, { exact: true }).first()).toBeVisible()
  await product.screenshot({ path: testInfo.outputPath('authorization-results.png') })
})

test('native product uses top-level shared renderer, real OS fonts and isolated secure windows', async ({}, testInfo) => {
  const available = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workAreaSize.width)
  const width = pdfeWindowWidth(available)
  const observed = await product.evaluate(async () => {
    const fonts = await window.scholarseed.listOfficeFonts()
    return { platform: window.scholarseed.platform, kind: window.pdfe.kind, dock: window.pdfe.dock, topLevel: window.top === window, legacyViewport: Boolean(document.getElementById('scholarseed-preview-viewport')), width: innerWidth, height: innerHeight, faceCount: fonts.faceCount, fontFiles: fonts.fonts.length }
  })
  expect(observed).toMatchObject({ platform: process.platform, kind: 'product', dock: 'docked', topLevel: true, legacyViewport: false, width: width - pdfeDockWidth(width, PDFE_CONTROL_SIZE.width), height: WORKSPACE_WINDOW_SIZE.height })
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

test('native controls preserve settings selection across collapse and native viewport changes', async ({}, testInfo) => {
  const native = await app.browserWindow(product)
  const available = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workAreaSize.width)
  const size = await native.evaluate(window => window.getContentSize())
  expect(size[0]).toBe(pdfeWindowWidth(available))
  const surfaces = await nativeEvidenceSurfaces()
  const productWidth = surfaces.find(surface => surface.role === 'product').bounds.width
  const controlsWidth = surfaces.find(surface => surface.role === 'controls').bounds.width
  expect(productWidth + controlsWidth).toBe(size[0])
  expect(controlsWidth).toBe(PDFE_CONTROL_SIZE.width)
  writeFileSync(testInfo.outputPath('native-startup-window.json'), JSON.stringify({ available, size, productWidth, controlsWidth }, null, 2))
  await product.screenshot({ path: testInfo.outputPath('native-startup-product.png') })
  await controls.screenshot({ path: testInfo.outputPath('native-startup-controls.png') })
  await normalUi(testInfo, async () => {
    await scenario('settings-archives', 'settings-archives-states')
    const archives = product.getByTestId('account-settings-archives')
    await archives.getByRole('button', { name: '批量管理', exact: true }).click()
    await expect(archives.getByTestId(/^account-archived-select-(?!all$)/)).toHaveCount(2)
    const selection = archives.getByTestId(/^account-archived-select-(?!all$)/).first()
    await expect(selection).toBeVisible()
    await selection.check()
    const original = await archives.elementHandle()
    const window = await app.browserWindow(product)
    const width = await window.evaluate(window => window.getContentSize()[0])
    await controls.getByRole('button', { name: zh.close, exact: true }).click()
    await expect.poll(() => product.evaluate(() => innerWidth)).toBe(width)
    await workspaceShortcut('F8', ['shift'])
    await expect.poll(() => product.evaluate(() => innerWidth)).toBe(width)
    await workspaceShortcut('F8')
    await expect.poll(() => product.evaluate(() => innerWidth)).toBeLessThan(width)
    await expect(controls.getByRole('heading', { name: zh.title, exact: true })).toBeVisible()
    await expect(controls.getByRole('dialog', { name: zh.title, exact: true })).not.toHaveAttribute('aria-modal', 'true')
    await expect(selection).toBeChecked()
    expect(await archives.evaluate((node, previous) => node === previous, original)).toBe(true)
    await controls.getByRole('separator', { name: zh.resizeWorkbench, exact: true }).press('ArrowLeft')
    await selection.uncheck()
    await selection.check()
    await controls.getByRole('button', { name: zh.guide, exact: true }).click()
    const guide = controls.getByRole('dialog', { name: zh.guide, exact: true })
    await guide.getByRole('button', { name: zh.guideCommon, exact: true }).click()
    await expect(guide).toContainText(zh.consoleShortcut)
    await guide.press('Escape')
    await expect(guide).not.toBeVisible()
    await expect(controls.getByTestId('preview-archive-recover')).toHaveCount(0)
    await window.evaluate((window, minimum) => window.setSize(minimum.width, minimum.height), WORKSPACE_WINDOW_MINIMUM)
    await expect(selection).toBeChecked()
    await product.screenshot({ path: testInfo.outputPath('native-settings-selection-minimum.png') })
    await controls.getByRole('button', { name: zh.close, exact: true }).click()
    await expect(selection).toBeChecked()
    expect(await archives.evaluate((node, previous) => node === previous, original)).toBe(true)
    await workspaceShortcut('F8')
    await expect.poll(() => product.evaluate(() => innerWidth)).toBeLessThan(WORKSPACE_WINDOW_MINIMUM.width)
    await expect(controls.getByRole('heading', { name: zh.title, exact: true })).toBeVisible()
    const settings = product.getByRole('dialog', { name: '设置', exact: true })
    const close = settings.getByRole('button', { name: '关闭', exact: true })
    const bounds = await close.boundingBox()
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(await product.evaluate(() => innerWidth))
    await close.click()
    await expect(settings).not.toBeVisible()
    await expect(controls.getByRole('heading', { name: zh.title, exact: true })).toBeVisible()
    await original.dispose()
  })
})

test('native docked resizing preserves project form and workbench search without dock transitions', async ({}, testInfo) => {
  await openHomeProjectForm()
  const name = product.getByTestId('project-create-name')
  await name.fill('停靠调宽保留输入')
  const cancel = product.getByTestId('project-new-modal').getByRole('button', { name: '取消', exact: true })
  await cancel.focus()
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
  const pointerEvents = []
  await controls.exposeFunction('observeDockPointer', event => pointerEvents.push(event))
  await divider.evaluate(node => {
    for (const type of ['pointerdown', 'pointerup']) node.addEventListener(type, event => {
      void window.observeDockPointer({ type, screenX: event.screenX, width: innerWidth })
    }, { capture: true })
  })
  const handle = await divider.boundingBox()
  await controls.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await controls.mouse.down()
  await controls.mouse.move(handle.x - PDFE_DOCK_STEP, handle.y + handle.height / 2)
  await controls.mouse.up()
  await expect(divider).toHaveAttribute('data-dragging', 'false')
  await expect.poll(() => pointerEvents.map(event => event.type)).toEqual(['pointerdown', 'pointerup'])
  const resizedWidth = pdfeDockWidth(total, pointerEvents[0].width + pointerEvents[0].screenX - pointerEvents[1].screenX)
  expect(resizedWidth).toBeGreaterThan(total - width)
  await expect.poll(() => product.evaluate(() => innerWidth)).toBe(total - resizedWidth)
  await expect.poll(() => controls.evaluate(() => innerWidth)).toBe(resizedWidth)
  writeFileSync(testInfo.outputPath('native-resize-pointer.json'), JSON.stringify({ pointerEvents, resizedWidth, total }, null, 2))
  await controls.getByRole('button', { name: zh.close, exact: true }).click()
  await expect.poll(() => product.evaluate(() => innerWidth)).toBe(total)
  await expect(cancel).toBeFocused()
  await workspaceShortcut('F8')
  await expect.poll(() => product.evaluate(() => innerWidth)).toBe(total - resizedWidth)
  await expect.poll(() => controls.evaluate(() => innerWidth)).toBe(resizedWidth)
  await expect(name).toHaveValue('停靠调宽保留输入')
  expect(await name.evaluate((node, original) => node === original, originalName)).toBe(true)
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
      try {
        await expect.poll(() => controls.evaluate(() => innerWidth)).toBe(expected)
      } catch (error) {
        writeFileSync(testInfo.outputPath('native-resize-failure.json'), JSON.stringify({
          target, previous, expected, direction, total,
          control: await controls.evaluate(() => ({ width: innerWidth, focused: document.activeElement?.getAttribute('data-testid') })),
          dragging: await divider.getAttribute('data-dragging'),
          native: await workspace.evaluate(window => ({ size: window.getContentSize(), bounds: window.contentView.children.map(view => view.getBounds()) })),
        }, null, 2))
        throw error
      }
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
  await expect(controls.getByRole('navigation', { name: zh.navigation, exact: true })).toBeVisible()
  await expect(controls.locator('#pdfe-role')).toHaveCount(0)
  await expect(controls.locator('#preview-viewport-size')).toHaveCount(0)
  await expect(controls.getByTestId('preview-scene-page-home-home-empty')).toHaveAttribute('aria-current', 'page')
  await search.fill('conversation')
  const conversation = PREVIEW_CATALOG.find(page => page.id === 'page-conversation')
  for (const scene of conversation.scenarios) await expect(controls.getByTestId('preview-hint-' + conversation.id + '-' + scene.id)).not.toBeEmpty()
  for (const [sceneId, states] of [
    ['conversation-context-draft', ['draft', 'preview', 'remove']],
    ['conversation-context-mixed', ['grouped', 'images', 'files', 'annotations', 'navigation']],
    ['conversation-stream', ['streaming']],
  ]) for (const state of states) await expect(controls.getByTestId('preview-hint-page-conversation-' + sceneId)).toContainText(zh['state_' + state])
  await search.fill('no-matching-pdfe-page-or-state')
  await expect(controls.getByRole('status')).toHaveText(zh.discoveryEmpty)
  expect(product.url()).toBe(location)
  await expect(input).toHaveValue(draft)
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
  await expect(product.getByTestId('home-tasks-list')).toHaveCount(0)
  const native = await app.browserWindow(product)
  await native.evaluate((window, minimum) => window.setSize(minimum.width, minimum.height), WORKSPACE_WINDOW_MINIMUM)
  await useDarkEnglishAppearance()
  await expect(controls.getByRole('heading', { name: en.title, exact: true })).toBeVisible()
  await expect(controls.getByRole('navigation', { name: en.navigation, exact: true })).toBeVisible()
  await expect(controls.getByRole('tab', { name: en.componentsEntry, exact: true })).toBeInViewport()
  await expect(product.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await controls.locator('#root').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await controls.getByRole('button', { name: en.guide, exact: true }).click()
  const englishGuide = controls.getByRole('dialog', { name: en.guide, exact: true })
  await englishGuide.getByRole('button', { name: en.guideCommon, exact: true }).click()
  await expect(englishGuide).toContainText(en.sharedFunctions)
  await controls.screenshot({ animations: 'disabled', path: testInfo.outputPath('native-navigation-dark-english-minimum.png') })
  await englishGuide.press('Escape')
  await expect(englishGuide).not.toBeVisible()
  await expect(controls.getByRole('heading', { name: en.title, exact: true })).toBeVisible()
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

for (const entry of [
  { pageId: 'page-browser', prefix: 'browser', english: false },
  { pageId: 'viewer-browser', prefix: 'viewer-browser', english: true },
]) {
  test('native browser guidance uses current controls and rejects external navigation: ' + entry.pageId, {
    annotation: [
      { type: INITIAL_TARGET_ANNOTATION, description: JSON.stringify({ pageId: entry.pageId, sceneId: entry.prefix + '-blank' }) },
      previewConsumption(entry.pageId, entry.prefix + '-blank', ['start', 'reloaded', 'blocked']),
    ],
  }, async ({}, testInfo) => {
    if (entry.english) {
      const window = await app.browserWindow(product)
      await window.evaluate((window, minimum) => window.setSize(minimum.width, minimum.height), WORKSPACE_WINDOW_MINIMUM)
      await useDarkEnglishAppearance()
      await expect(controls.getByRole('heading', { name: en.title, exact: true })).toBeVisible()
    }
    const dictionary = entry.english ? browserEn : browserZh
    await normalUi(testInfo, async () => {
      const workspace = product.getByTestId('browser-workspace')
      await expect(workspace.getByRole('tablist')).toHaveCount(0)
      await expect(workspace.getByRole('button', { name: dictionary.newTabAction, exact: true })).toHaveCount(0)
      await expect(product.getByTestId('browser-start-page')).toBeVisible()
      const address = workspace.getByRole('textbox', { name: dictionary.address, exact: true })
      await address.fill('https://example.invalid/preview-blocked')
      const [receipt] = await Promise.all([
        product.waitForResponse(response => new URL(response.url()).pathname === PREVIEW_BROWSER.path + '/command' && response.request().method() === 'POST'),
        address.press('Enter'),
      ])
      expect(await receipt.json()).toEqual({ ok: false, error: BROWSER_ERROR.permissionDenied })
      await expect(product.getByTestId('browser-start-page')).toBeVisible()
      await product.reload()
      await expect(product.getByTestId('browser-start-page')).toBeVisible()
      await expect(workspace.getByRole('tablist')).toHaveCount(0)
      await expect(product.locator('html')).toHaveAttribute('data-theme', entry.english ? 'dark' : 'light')
      await product.screenshot({ path: testInfo.outputPath('browser-current-guidance.png') })
    })
  })
}

async function normalUi(testInfo, action, expectedFailures = []) {
  const observations = { failures: [], externalOrigins: [], pageErrors: [] }
  const origin = new URL(product.url()).origin
  for (const page of [product, controls]) {
    page.on('pageerror', error => observations.pageErrors.push(error.message))
    page.on('request', request => {
      const url = new URL(request.url())
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) observations.externalOrigins.push(url.origin)
    })
    page.on('response', response => {
      const path = new URL(response.url()).pathname
      if ((path.startsWith('/api/') || path.startsWith('/__preview/')) && response.status() >= 400) observations.failures.push({ path, method: response.request().method(), status: response.status() })
    })
  }
  try {
    await action()
    expect(observations.failures.filter(failure => !(failure.path === PREVIEW_CREDITS.path && failure.method === 'GET' && failure.status === 503) && !expectedFailures.some(expected => failure.path === expected.path && failure.method === expected.method && failure.status === expected.status))).toEqual([])
    expect(observations.externalOrigins).toEqual([])
    expect(observations.pageErrors).toEqual([])
  } finally {
    writeFileSync(testInfo.outputPath('normal-ui-observations.json'), JSON.stringify(observations, null, 2))
  }
}

for (const target of [
  { kind: 'library', label: '项目文件', surface: 'project-library-content' },
  { kind: 'explorer', label: '项目资源管理器', surface: 'project-explorer' },
]) {
  test('native project new tab keeps its identity through selection, closing and reentry: ' + target.kind, { annotation: previewConsumption('viewer-new_tab', 'viewer-new_tab-states', ['opened', target.kind, 'closed', 'reentered']) }, async ({}, testInfo) => {
    await normalUi(testInfo, async () => {
      await scenario('viewer-new_tab', 'viewer-new_tab-states')
      await controls.getByRole('button', { name: zh.close, exact: true }).click()
      await product.getByTestId('project-library').click()
      const library = product.getByRole('tab', { name: '项目文件', exact: false }).filter({ has: product.getByRole('button', { name: /项目文件/ }) })
      const originalLibrary = await library.elementHandle()
      expect(originalLibrary).not.toBeNull()
      const plus = product.getByTestId('workspace-new-tab')
      await expect(plus).toBeVisible()
      await plus.click()
      const chooser = product.getByTestId('project-new-tab')
      await expect(chooser).toBeVisible()
      const newTab = product.getByRole('tab', { name: '新标签页', exact: false }).filter({ has: product.getByRole('button', { name: /新标签页/ }) })
      await expect(newTab).toHaveCount(1)
      const original = await newTab.elementHandle()
      expect(original).not.toBeNull()
      try {
        await library.getByRole('button').click()
        expect(await originalLibrary.evaluate(node => node.isConnected)).toBe(false)
        await expect(chooser).toBeVisible()
        expect(await newTab.evaluate((node, previous) => node === previous, original)).toBe(true)
        await chooser.getByRole('button', { name: target.label, exact: true }).click()
        await expect(product.getByTestId(target.surface)).toBeVisible()
        await expect(chooser).not.toBeVisible()
        const selected = product.getByRole('tab', { name: target.label, exact: false }).filter({ has: product.getByRole('button', { name: new RegExp(target.label) }) }).and(product.locator('[aria-selected="true"]'))
        await expect(selected).toHaveCount(1)
        expect(await selected.evaluate((node, previous) => node === previous, original)).toBe(true)
        const tabs = product.getByTestId('workspace-content').getByRole('tablist').filter({ has: selected }).first()
        const header = tabs.locator('xpath=ancestor::header[1]')
        await expect(header).toHaveCSS('border-bottom-width', '0px')
        const headerBounds = await header.boundingBox()
        const tabBounds = await tabs.boundingBox()
        expect(headerBounds).not.toBeNull()
        expect(tabBounds).not.toBeNull()
        expect(tabBounds.y + tabBounds.height).toBe(headerBounds.y + headerBounds.height)
        await product.screenshot({ path: testInfo.outputPath('workbench-header-seam.png') })
        if (target.kind === 'library') {
          await expect(product.getByTestId('material-readme.md')).toBeVisible()
          await selectNativeLibraryCategory(layoutZh.papers)
          await expect(product.getByTestId('literature-overview')).toBeVisible()
          await expect(product.getByTestId('literature-overview')).toContainText(literatureZh.list.empty)
          await product.screenshot({ path: testInfo.outputPath('library-literature-empty.png'), animations: 'disabled' })
          await selectNativeLibraryCategory(layoutZh.outputs)
          await expect(product.getByTestId('project-outputs')).toBeVisible()
          await expect(product.getByTestId('project-outputs')).toContainText('暂无任务产物')
          await product.screenshot({ path: testInfo.outputPath('library-outputs-empty.png'), animations: 'disabled' })
          await selectNativeLibraryCategory(layoutZh.materials)
          await expect(product.getByTestId('material-readme.md')).toBeVisible()
        } else await expect(product.getByTestId('explorer-node-readme.md')).toBeVisible()
        await product.screenshot({ path: testInfo.outputPath(target.kind + '-selected.png') })
        await selected.getByRole('button').click()
        expect(await original.evaluate(node => node.isConnected)).toBe(false)
        await expect(product.getByTestId('workspace-content')).not.toBeVisible()
        const reopen = product.getByTestId('workspace-open')
        await expect(reopen).toHaveAttribute('aria-expanded', 'false')
        await reopen.click()
        await expect(chooser).toBeVisible()
        await expect(newTab).toHaveCount(1)
        expect(await newTab.evaluate((node, previous) => node === previous, original)).toBe(false)
        await product.screenshot({ path: testInfo.outputPath(target.kind + '-reentered.png') })
      } finally {
        await originalLibrary.dispose()
        await original.dispose()
      }
    })
  })
}

test('native project layout preserves mounted controls and persists panel placement across reload', { annotation: previewConsumption('page-resource', 'project-layout-states', ['split', 'moved-right', 'moved-left', 'reloaded', 'narrow']) }, async ({}, testInfo) => {
  await normalUi(testInfo, async () => {
    const submissions = []
    product.on('request', request => {
      if (request.method() === 'POST' && /\/sessions\/[^/]+\/turns$/.test(new URL(request.url()).pathname)) submissions.push(request.url())
    })
    await scenario('page-resource', 'project-layout-states')
    await product.getByTestId('project-library').click()
    const conversation = product.getByTestId('workspace-conversation')
    const content = product.getByTestId('workspace-content')
    const input = product.getByTestId('composer-input')
    await expect(conversation).toHaveAttribute('data-mode', 'split')
    const draft = '模拟布局草稿，不发送'
    await input.fill(draft)
    const tab = product.getByRole('tab', { name: '项目文件', exact: false }).filter({ has: product.getByRole('button', { name: /项目文件/ }) })
    const originalInput = await input.elementHandle()
    const originalTab = await tab.elementHandle()
    expect(originalInput).not.toBeNull()
    expect(originalTab).not.toBeNull()
    const placement = async right => {
      await expect.poll(async () => {
        const conversationBox = await conversation.boundingBox()
        const contentBox = await content.boundingBox()
        return Boolean(conversationBox && contentBox && (right ? conversationBox.x > contentBox.x : conversationBox.x < contentBox.x))
      }).toBe(true)
    }
    try {
      for (const right of [true, false, true]) {
        await product.getByTestId('workspace-conversation-menu').click()
        await saveNativePreferences(preferences => preferences.projectLayouts?.[PREVIEW_PROJECT_ID]?.swapped === right, () => product.getByRole('menuitem', { name: right ? '移至右侧面板' : '移至左侧面板', exact: true }).click())
        await placement(right)
        await expect(input).toHaveValue(draft)
        expect(await input.evaluate((node, previous) => node === previous, originalInput)).toBe(true)
        expect(await tab.evaluate((node, previous) => node === previous, originalTab)).toBe(true)
      }
      await product.reload()
      await expect(conversation).toHaveAttribute('data-mode', 'split')
      await placement(true)
      await product.getByTestId('project-library').click()
      await expect(product.getByTestId('project-library-content')).toBeVisible()
      await controls.getByRole('button', { name: zh.close, exact: true }).click()
      const window = await app.browserWindow(product)
      await window.evaluate((window, minimum) => window.setSize(minimum.width, minimum.height), WORKSPACE_WINDOW_MINIMUM)
      await expect.poll(() => window.evaluate(window => window.getSize())).toEqual([WORKSPACE_WINDOW_MINIMUM.width, WORKSPACE_WINDOW_MINIMUM.height])
      await expect.poll(() => product.evaluate(() => innerWidth)).toBeLessThanOrEqual(WORKSPACE_WINDOW_MINIMUM.width)
      const category = product.getByTestId('project-library-content').getByRole('combobox', { name: layoutZh.fileCategory, exact: true })
      await expect(category).toBeInViewport()
      await category.click()
      for (const name of [layoutZh.materials, layoutZh.papers, layoutZh.outputs]) await expect(product.getByRole('option', { name, exact: true })).toBeInViewport()
      await product.screenshot({ path: testInfo.outputPath('project-layout-narrow-categories.png') })
      await product.keyboard.press('Escape')
      expect(await product.getByTestId('project-library-toolbar-actions').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(submissions).toEqual([])
      await product.screenshot({ path: testInfo.outputPath('project-layout-reloaded-narrow.png') })
    } finally {
      await originalInput.dispose()
      await originalTab.dispose()
    }
  })
})

async function storageRead(path) {
  const url = new URL(path, manifest.origin)
  url.searchParams.set('previewInstance', manifest.instance)
  const response = await product.request.get(url.href)
  expect(response.status()).toBe(200)
  return response.json()
}

const STORAGE_UI_READS = [
  { prefix: 'storage-data-home', path: PREVIEW_STORAGE_READ.configPath },
  { prefix: 'storage-container-root', path: PREVIEW_STORAGE.path },
]

async function storageReady(source, state) {
  await expect(product.getByTestId(source.prefix + '-loading')).not.toBeVisible()
  await expect(product.getByTestId(source.prefix + '-error')).not.toBeVisible()
  const root = source.path === PREVIEW_STORAGE.path ? await storageRead(PREVIEW_STORAGE.path) : null
  await expect(product.getByTestId(source.prefix + '-value')).toHaveValue(root ? root.configured || root.root : state.storage.config.home)
}

function storageReading(source, action) {
  return Promise.all([
    product.waitForResponse(response => new URL(response.url()).pathname === source.path && response.request().method() === 'GET'),
    action(),
  ]).then(([response]) => response)
}

async function storageReenter() {
  await product.getByTestId('activity-account').click()
  await product.getByTestId('account-menu-settings').click()
  await product.getByTestId('account-settings-nav-storage').click()
  await expect(product.getByTestId('account-settings-storage')).toBeVisible()
}

async function storageUnchanged(initial) {
  const state = await storageRead('/__preview/state')
  expect(state.storage).toEqual(initial.storage)
  expect(state.projects).toEqual(initial.projects)
}

async function storageReadUi(testInfo, action) {
  const writes = []
  const failed = []
  product.on('request', request => {
    if (new URL(request.url()).pathname === PREVIEW_STORAGE.path && request.method() === 'PUT') writes.push(request.postDataJSON())
  })
  product.on('requestfailed', request => {
    if (STORAGE_UI_READS.some(source => new URL(request.url()).pathname === source.path)) failed.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText })
  })
  await normalUi(testInfo, async () => {
    await action()
    expect(writes).toEqual([])
    expect(failed).toEqual([])
  }, STORAGE_UI_READS.map(source => ({ path: source.path, method: 'GET', status: 503 })))
}

test('native storage reads isolate waiting and failed sources without virtual writes', { annotation: [
  previewConsumption('settings-storage', 'settings-storage-home-read-pending', ['loading', 'loaded']),
  previewConsumption('settings-storage', 'settings-storage-read-required', ['loading', 'error', 'recovered']),
] }, async ({}, testInfo) => {
  await storageReadUi(testInfo, async () => {
    for (const [index, sceneId] of ['settings-storage-home-read-pending', 'settings-storage-read-required'].entries()) {
      const delayed = STORAGE_UI_READS[index]
      const other = STORAGE_UI_READS[1 - index]
      let initial
      for (const phase of ['initial', 'reentered']) {
        const release = await holdNativeRead(url => url.pathname === delayed.path)
        try {
          await Promise.all([
            product.waitForRequest(request => new URL(request.url()).pathname === delayed.path && request.method() === 'GET'),
            phase === 'initial' ? scenario('settings-storage', sceneId) : storageReenter(),
          ])
          await expect(product.getByTestId(delayed.prefix + '-loading')).toBeVisible()
          await expect(product.getByTestId(delayed.prefix + '-value')).not.toBeVisible()
          const state = await storageRead('/__preview/state')
          if (phase === 'initial') initial = state
          if (index === 0) {
            await storageReady(other, state)
            await expect(product.getByTestId('storage-container-root-change')).toBeEnabled()
          } else {
            await expect(product.getByTestId(other.prefix + '-error')).toBeVisible()
            await expect(product.getByTestId('storage-container-root-change')).toBeDisabled()
          }
          await product.screenshot({ path: testInfo.outputPath(sceneId + '-' + phase + '-waiting.png') })
        } finally {
          await release()
        }
        await storageReady(delayed, await storageRead('/__preview/state'))
        if (phase === 'initial') {
          await product.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: componentsZh.accountPanel.common.close, exact: true }).click()
          await expect(product.getByTestId('account-settings-storage')).not.toBeVisible()
        }
      }
      const state = await storageRead('/__preview/state')
      await storageReady(delayed, state)
      if (index === 1) {
        const home = STORAGE_UI_READS[0]
        const retry = product.getByTestId(home.prefix + '-retry')
        expect((await storageReading(home, () => retry.click())).status()).toBe(503)
        await expect(product.getByTestId(home.prefix + '-error')).toBeVisible()
        const [recovery] = await Promise.all([
          controls.waitForResponse(response => new URL(response.url()).pathname === PREVIEW_STORAGE_READ.recoveryPath && response.request().method() === 'POST'),
          controls.getByTestId('preview-storage-recover').click(),
        ])
        expect(recovery.status()).toBe(200)
        await expect(product.getByTestId(home.prefix + '-error')).toBeVisible()
        expect((await storageReading(home, () => retry.click())).status()).toBe(200)
        await storageReady(home, state)
        await storageReady(delayed, state)
      }
      await storageChoose()
      await product.getByTestId('preview-directory-cancel').click()
      await expect(product.getByTestId('preview-directory-dialog')).not.toBeVisible()
      await storageUnchanged(initial)
    }
  })
})

test('native storage read recovery preserves public reentry and narrow keyboard access', { annotation: previewConsumption('settings-storage', 'settings-storage-both-read-failed', ['error', 'retry-failed', 'recovered']) }, async ({}, testInfo) => {
  await scenario('settings-storage', 'settings-storage-both-read-failed')
  await useDarkEnglishAppearance()
  await expect(controls.getByRole('heading', { name: en.title, exact: true })).toBeVisible()
  await controls.getByRole('button', { name: en.close, exact: true }).click()
  const window = await app.browserWindow(product)
  await window.evaluate((window, minimum) => window.setSize(minimum.width, minimum.height), WORKSPACE_WINDOW_MINIMUM)
  await expect.poll(() => window.evaluate(window => window.getSize())).toEqual([WORKSPACE_WINDOW_MINIMUM.width, WORKSPACE_WINDOW_MINIMUM.height])
  await expect(product.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(product.locator('html')).toHaveAttribute('lang', LOCALES.en.tag)
  await storageReadUi(testInfo, async () => {
    const state = await storageRead('/__preview/state')
    const closeSettings = async () => {
      await product.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: componentsEn.accountPanel.common.close, exact: true }).click()
      await expect(product.getByTestId('account-settings-storage')).not.toBeVisible()
    }
    const retry = async (source, status) => {
      const button = product.getByTestId(source.prefix + '-retry')
      await button.scrollIntoViewIfNeeded()
      await expect(button).toBeInViewport()
      const box = await button.boundingBox()
      const viewport = await product.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      expect(box).not.toBeNull()
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
      await button.focus()
      await expect(button).toBeFocused()
      expect((await storageReading(source, () => button.press('Enter'))).status()).toBe(status)
    }
    for (const source of STORAGE_UI_READS) {
      await expect(product.getByTestId(source.prefix + '-error')).toBeVisible()
      await expect(product.getByTestId(source.prefix + '-value')).not.toBeVisible()
      await retry(source, 503)
      await expect(product.getByTestId(source.prefix + '-error')).toBeVisible()
    }
    await expect(product.getByTestId('storage-container-root-change')).toBeDisabled()
    await product.screenshot({ path: testInfo.outputPath('storage-dark-narrow-failed.png') })
    await closeSettings()
    const firstLaunch = product.getByTestId('storage-first-launch-read-retry')
    await expect(product.getByTestId('storage-first-launch-read-error')).toBeVisible()
    expect((await storageReading(STORAGE_UI_READS[0], () => firstLaunch.click())).status()).toBe(503)
    await expect(product.getByTestId('storage-first-launch-read-error')).toBeVisible()
    await storageReenter()
    for (const source of STORAGE_UI_READS) await expect(product.getByTestId(source.prefix + '-error')).toBeVisible()
    await workspaceShortcut('F8')
    await expect(controls.getByRole('heading', { name: en.title, exact: true })).toBeVisible()
    const [recovery] = await Promise.all([
      controls.waitForResponse(response => new URL(response.url()).pathname === PREVIEW_STORAGE_READ.recoveryPath && response.request().method() === 'POST'),
      controls.getByTestId('preview-storage-recover').click(),
    ])
    expect(recovery.status()).toBe(200)
    await controls.getByRole('button', { name: en.close, exact: true }).click()
    for (const source of STORAGE_UI_READS) await expect(product.getByTestId(source.prefix + '-error')).toBeVisible()
    for (const source of STORAGE_UI_READS) {
      await retry(source, 200)
      await storageReady(source, state)
    }
    await product.screenshot({ path: testInfo.outputPath('storage-dark-narrow-recovered.png') })
    await closeSettings()
    await expect(product.getByTestId('storage-first-launch-read-error')).toBeVisible()
    await firstLaunch.focus()
    await expect(firstLaunch).toBeFocused()
    expect((await storageReading(STORAGE_UI_READS[0], () => firstLaunch.press('Enter'))).status()).toBe(200)
    await expect(product.getByTestId('storage-first-launch-read-error')).not.toBeAttached()
    await expect(firstLaunch).not.toBeAttached()
    await storageReenter()
    for (const source of STORAGE_UI_READS) await storageReady(source, state)
    await storageChoose()
    await product.getByTestId('preview-directory-cancel').click()
    await expect(product.getByTestId('preview-directory-dialog')).not.toBeVisible()
    await storageUnchanged(state)
  })
})

async function storageUi(testInfo, sceneId, action) {
  const writes = []
  const failures = []
  product.on('request', request => {
    if (new URL(request.url()).pathname === PREVIEW_STORAGE.path && request.method() === 'PUT') writes.push(request.postDataJSON())
  })
  product.on('response', response => {
    if (new URL(response.url()).pathname === PREVIEW_STORAGE.path && response.status() >= 400) failures.push(response.status())
  })
  const failed = sceneId === 'settings-storage-save-failed'
  await normalUi(testInfo, async () => {
    await scenario('settings-storage', sceneId)
    await expect(product.getByTestId('account-settings-storage')).toBeVisible()
    const initial = await storageRead('/__preview/state')
    const root = await storageRead(PREVIEW_STORAGE.path)
    const chosen = initial.storage.choices.find(choice => choice.id === PREVIEW_STORAGE.choiceIds[0]).path
    await expect(product.getByTestId('storage-data-home-value')).toHaveValue(initial.storage.config.home)
    await expect(product.getByTestId('storage-container-root-value')).toHaveValue(root.configured || root.root)
    await action({ initial, root, chosen, writes })
    expect(failures).toEqual(failed ? [503] : [])
    expect((await storageRead('/__preview/state')).projects).toEqual(initial.projects)
  }, failed ? [{ path: PREVIEW_STORAGE.path, method: 'PUT', status: 503 }] : [])
}

async function storageChoose() {
  await product.getByTestId('storage-container-root-change').click()
  await expect(product.getByTestId('preview-directory-dialog')).toBeVisible()
  await expect(product.getByTestId('preview-directory-confirm')).toBeDisabled()
  const choice = product.getByTestId('preview-directory-choice-' + PREVIEW_STORAGE.choiceIds[0])
  await choice.click()
  await expect(choice).toHaveAttribute('aria-checked', 'true')
  await expect(product.getByTestId('preview-directory-confirm')).toBeEnabled()
}

function storageWriting() {
  return product.waitForResponse(response => new URL(response.url()).pathname === PREVIEW_STORAGE.path && response.request().method() === 'PUT')
}

test('native storage configuration preserves virtual roots across cancellation, reload and appearance changes', { annotation: previewConsumption('settings-storage', 'settings-storage-states', ['loaded', 'cancelled', 'saved', 'restart-required', 'reloaded']) }, async ({}, testInfo) => {
  await storageUi(testInfo, 'settings-storage-states', async ({ initial, root, chosen, writes }) => {
    await storageChoose()
    await expect(product.getByTestId('preview-directory-dialog')).toContainText('不访问本机文件系统')
    await product.screenshot({ path: testInfo.outputPath('storage-virtual-picker.png') })
    await product.getByTestId('preview-directory-cancel').click()
    await expect(product.getByTestId('preview-directory-dialog')).not.toBeVisible()
    expect(writes).toEqual([])
    await storageChoose()
    await product.keyboard.press('Escape')
    await expect(product.getByTestId('preview-directory-dialog')).not.toBeVisible()
    expect(writes).toEqual([])
    await storageChoose()
    const saving = storageWriting()
    await product.getByTestId('preview-directory-confirm').click()
    const saved = await saving
    expect(saved.status()).toBe(200)
    expect(await saved.json()).toEqual({ root: root.root, configured: chosen, restartRequired: true })
    await expect(product.getByTestId('storage-container-root-value')).toHaveValue(chosen)
    await expect(product.getByTestId('storage-container-root-restart')).toBeVisible()
    await product.reload()
    await expect(product.getByTestId('storage-container-root-value')).toHaveValue(chosen)
    await expect(product.getByTestId('storage-data-home-value')).toHaveValue(initial.storage.config.home)
    await expect(product.getByTestId('storage-container-root-restart')).not.toBeVisible()
    expect(await storageRead(PREVIEW_STORAGE.path)).toEqual({ root: root.root, configured: chosen })
    const settings = product.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(settings).not.toBeVisible()
    await product.getByTestId('activity-account').click()
    await product.getByTestId('account-menu-settings').click()
    await product.getByTestId('account-settings-nav-storage').click()
    await expect(product.getByTestId('storage-container-root-value')).toHaveValue(chosen)
    for (const [label, option] of [[zh.theme, zh.dark], [zh.language, zh.english]]) {
      await controls.getByRole('combobox', { name: label, exact: true }).click()
      await Promise.all([
        product.waitForEvent('framenavigated', frame => frame === product.mainFrame()),
        controls.getByRole('option', { name: option, exact: true }).click(),
      ])
      await expect(product.getByTestId('storage-container-root-value')).toHaveValue(chosen)
    }
    await expect(product.locator('html')).toHaveAttribute('data-theme', 'dark')
    const englishSettings = product.getByRole('dialog', { name: 'Settings', exact: true })
    await englishSettings.getByRole('button', { name: componentsEn.accountPanel.common.close, exact: true }).click()
    await expect(englishSettings).not.toBeVisible()
    await product.getByTestId('activity-account').click()
    await product.getByTestId('account-menu-settings').click()
    await product.getByTestId('account-settings-nav-storage').click()
    await storageChoose()
    await expect(product.getByTestId('preview-directory-dialog')).toContainText('does not access local files')
    await product.screenshot({ path: testInfo.outputPath('storage-picker-dark-english.png') })
    await product.keyboard.press('Escape')
    await expect(product.getByTestId('preview-directory-dialog')).not.toBeVisible()
    expect(writes).toEqual([{ root: chosen }])
  })
})

for (const mode of ['pending', 'failed']) {
  const sceneId = 'settings-storage-save-' + mode
  test('native storage save lifecycle: ' + sceneId, { annotation: previewConsumption('settings-storage', sceneId, mode === 'pending' ? ['loaded', 'saving', 'saved', 'restart-required'] : ['loaded', 'error', 'retried', 'saved']) }, async ({}, testInfo) => {
    await storageUi(testInfo, sceneId, async ({ root, chosen, writes }) => {
      await storageChoose()
      let settled = false
      let saving = storageWriting().then(response => { settled = true; return response })
      await product.getByTestId('preview-directory-confirm').click()
      if (mode === 'pending') {
        await expect(product.getByTestId('preview-directory-dialog')).not.toBeVisible()
        await expect(product.getByTestId('storage-container-root-change')).toBeDisabled()
        expect(settled).toBe(false)
        await product.screenshot({ path: testInfo.outputPath('storage-save-pending.png') })
      } else {
        expect((await saving).status()).toBe(503)
        await expect(product.getByTestId('storage-container-root-failed')).toBeVisible()
        await expect(product.getByTestId('storage-container-root-value')).toHaveValue(root.configured || root.root)
        expect(await storageRead(PREVIEW_STORAGE.path)).toEqual(root)
        await product.screenshot({ path: testInfo.outputPath('storage-save-failed.png') })
        await storageChoose()
        saving = storageWriting()
        await product.getByTestId('preview-directory-confirm').click()
      }
      expect((await saving).status()).toBe(200)
      await expect(product.getByTestId('storage-container-root-change')).toBeEnabled()
      await expect(product.getByTestId('storage-container-root-failed')).not.toBeVisible()
      await expect(product.getByTestId('storage-container-root-value')).toHaveValue(chosen)
      await expect(product.getByTestId('storage-container-root-restart')).toBeVisible()
      expect(await storageRead(PREVIEW_STORAGE.path)).toEqual({ root: root.root, configured: chosen })
      expect(writes).toEqual(Array.from({ length: mode === 'pending' ? 1 : 2 }, () => ({ root: chosen })))
      await product.screenshot({ path: testInfo.outputPath('storage-save-completed.png') })
    })
  })
}

function developerResponse(method, path = PREVIEW_DEVELOPER.keysPath) {
  return product.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method)
}

async function developerKeys(reading) {
  const response = await reading
  expect(response.status()).toBe(200)
  const { keys } = await response.json()
  expect(Array.isArray(keys)).toBe(true)
  for (const key of keys) {
    expect(key).not.toHaveProperty('token')
    expect(typeof key.key_id).toBe('string')
  }
  expect(keys.filter(key => key.managed).length).toBeLessThanOrEqual(1)
  return keys
}

async function openNativeDeveloper(sceneId) {
  const reading = developerResponse('GET')
  await scenario('settings-developer', sceneId)
  await expect(product.getByTestId('account-settings-developer')).toBeVisible()
  return { reading }
}

async function developerUi(testInfo, action, expectedFailures = []) {
  const requests = []
  product.on('request', request => requests.push({ method: request.method(), path: new URL(request.url()).pathname }))
  try {
    await normalUi(testInfo, () => action(requests), expectedFailures)
  } finally {
    writeFileSync(testInfo.outputPath('developer-requests.json'), JSON.stringify(requests, null, 2))
  }
}

async function developerCreated(response, name) {
  expect(response.status()).toBe(200)
  const created = await response.json()
  expect(created.name).toBe(name)
  expect(created.managed).toBe(false)
  expect(created.token.startsWith(PREVIEW_DEVELOPER.tokenPrefix)).toBe(true)
  expect(created.key_id).not.toBe('')
  return created
}

test('native developer keys preserve managed identity and one-time simulated secrets across mutation and reentry', { annotation: previewConsumption('settings-developer', 'settings-developer-states', ['loaded', 'editing', 'created', 'secret-hidden', 'revoked', 'rotated', 'reloaded']) }, async ({}, testInfo) => {
  await developerUi(testInfo, async requests => {
    const name = '模拟外部协作 · 非真实凭据'
    const { reading } = await openNativeDeveloper('settings-developer-states')
    const initial = await developerKeys(reading)
    const managed = initial.find(key => key.managed)
    expect(managed).toBeDefined()
    await expect(product.getByTestId('api-key-row-' + managed.key_id)).toContainText(accountZh.accountExtra.managedName)
    await expect(product.getByTestId('api-key-rotate-' + managed.key_id)).toBeEnabled()
    await expect(product.getByTestId('api-key-revoke-' + managed.key_id)).toHaveCount(0)
    await expect(product.getByTestId('api-key-fresh')).toHaveCount(0)
    expect(requests.some(request => request.method === 'POST' && request.path === PREVIEW_DEVELOPER.ensurePath)).toBe(true)
    const rereading = developerResponse('GET')
    await product.reload()
    expect((await developerKeys(rereading)).map(key => key.key_id).sort()).toEqual(initial.map(key => key.key_id).sort())
    await product.getByTestId('api-key-name').fill(name)
    const creating = developerResponse('POST')
    const listing = developerResponse('GET')
    await product.getByTestId('api-key-create').click()
    const created = await developerCreated(await creating, name)
    const added = await developerKeys(listing)
    expect(added).toHaveLength(initial.length + 1)
    expect(added.filter(key => key.managed).map(key => key.key_id)).toEqual([managed.key_id])
    await expect(product.getByTestId('api-key-secret')).toHaveText(created.token)
    await expect(product.getByTestId('api-key-row-' + created.key_id)).toContainText(name)
    await product.screenshot({ path: testInfo.outputPath('developer-created-once.png') })
    await product.getByTestId('api-key-fresh-close').click()
    await expect(product.getByTestId('api-key-secret')).toHaveCount(0)
    const reloaded = developerResponse('GET')
    await product.reload()
    expect((await developerKeys(reloaded)).some(key => key.key_id === created.key_id)).toBe(true)
    await expect(product.getByTestId('api-key-fresh')).toHaveCount(0)
    await expect(product.getByTestId('api-key-secret')).toHaveCount(0)
    const revoking = developerResponse('DELETE', PREVIEW_DEVELOPER.keysPath + '/' + encodeURIComponent(created.key_id))
    const revoked = developerResponse('GET')
    await product.getByTestId('api-key-revoke-' + created.key_id).click()
    expect((await revoking).status()).toBe(200)
    expect((await developerKeys(revoked)).some(key => key.key_id === created.key_id)).toBe(false)
    await expect(product.getByTestId('api-key-row-' + created.key_id)).toHaveCount(0)
    const rotating = developerResponse('POST', PREVIEW_DEVELOPER.keysPath + '/' + encodeURIComponent(managed.key_id) + '/rotate')
    const refreshing = developerResponse('POST', PREVIEW_DEVELOPER.refreshPath)
    const rotatedList = developerResponse('GET')
    await product.getByTestId('api-key-rotate-' + managed.key_id).click()
    expect(await (await rotating).json()).toEqual({ rotated: true })
    expect((await refreshing).status()).toBe(200)
    const rotated = (await developerKeys(rotatedList)).filter(key => key.managed)
    expect(rotated).toHaveLength(1)
    expect(rotated[0].key_id).not.toBe(managed.key_id)
    await expect(product.getByTestId('api-key-row-' + managed.key_id)).toHaveCount(0)
    await expect(product.getByTestId('api-key-rotate-' + rotated[0].key_id)).toBeEnabled()
    await expect(product.getByTestId('api-key-secret')).toHaveCount(0)
    expect(requests.filter(request => request.method === 'POST' && request.path === PREVIEW_DEVELOPER.keysPath)).toHaveLength(1)
    const settings = product.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(settings).not.toBeVisible()
    await product.getByTestId('activity-account').click()
    const reentering = developerResponse('GET')
    await product.getByTestId('account-menu-settings').click()
    await product.getByTestId('account-settings-nav-developer').click()
    expect((await developerKeys(reentering)).filter(key => key.managed).map(key => key.key_id)).toEqual([rotated[0].key_id])
    await expect(product.getByTestId('api-key-fresh')).toHaveCount(0)
    await expect(product.getByTestId('api-key-secret')).toHaveCount(0)
    for (const [label, option] of [[zh.theme, zh.dark], [zh.language, zh.english]]) {
      const rereading = developerResponse('GET')
      await controls.getByRole('combobox', { name: label, exact: true }).click()
      await Promise.all([
        product.waitForEvent('framenavigated', frame => frame === product.mainFrame()),
        controls.getByRole('option', { name: option, exact: true }).click(),
      ])
      expect((await developerKeys(rereading)).filter(key => key.managed).map(key => key.key_id)).toEqual([rotated[0].key_id])
    }
    await expect(product.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(product.getByTestId('account-settings-developer').getByRole('heading', { name: componentsEn.accountPanel.developer.title, exact: true })).toBeVisible()
    await expect(product.getByTestId('api-key-row-' + rotated[0].key_id)).toContainText(accountEn.accountExtra.managedName)
    await expect(product.getByTestId('api-key-rotate-' + rotated[0].key_id)).toHaveText(accountEn.actions.rotate)
    await expect(product.getByTestId('api-key-create')).toHaveText(componentsEn.accountPanel.developer.generate)
    await expect(product.getByTestId('api-key-secret')).toHaveCount(0)
    await product.screenshot({ path: testInfo.outputPath('developer-dark-english.png') })
  })
})

for (const mode of ['empty', 'pending', 'failed']) {
  const sceneId = 'settings-developer-' + mode
  test('native developer list lifecycle: ' + sceneId, { annotation: previewConsumption('settings-developer', sceneId, mode === 'empty' ? ['empty'] : mode === 'pending' ? ['loading', 'loaded'] : ['error', 'retry-failed']) }, async ({}, testInfo) => {
    await developerUi(testInfo, async () => {
      const { reading } = await openNativeDeveloper(sceneId)
      const page = product.getByTestId('account-settings-developer')
      const create = product.getByTestId('api-key-create')
      if (mode === 'pending') {
        await expect(page.getByText(componentsZh.accountPanel.developer.loadingDesc, { exact: true })).toBeVisible()
        await expect(create).toBeDisabled()
        await product.screenshot({ path: testInfo.outputPath('developer-loading.png') })
      }
      if (mode === 'failed') {
        expect((await reading).status()).toBe(503)
        await expect(page.getByRole('alert')).toContainText('503')
        await expect(create).toBeDisabled()
        const retrying = developerResponse('GET')
        await product.getByTestId('api-key-retry').click()
        expect((await retrying).status()).toBe(503)
        await expect(page.getByRole('alert')).toContainText('503')
        await expect(product.getByTestId('api-key-retry')).toBeEnabled()
        await expect(create).toBeDisabled()
      } else {
        const keys = await developerKeys(reading)
        if (mode === 'empty') {
          expect(keys).toEqual([])
          await expect(page.getByText(componentsZh.accountPanel.developer.none, { exact: true })).toBeVisible()
          await expect(page.locator('[data-testid^="api-key-row-"]')).toHaveCount(0)
        } else {
          expect(keys.length).toBeGreaterThan(0)
          await expect(product.getByTestId('api-key-row-' + keys[0].key_id)).toBeVisible()
        }
        await expect(create).toBeEnabled()
      }
      await product.screenshot({ path: testInfo.outputPath('developer-list-result.png') })
    }, mode === 'failed' ? [{ path: PREVIEW_DEVELOPER.keysPath, method: 'GET', status: 503 }] : [])
  })
}

for (const mode of ['pending', 'failed']) {
  const sceneId = 'settings-developer-save-' + mode
  test('native developer creation lifecycle: ' + sceneId, { annotation: previewConsumption('settings-developer', sceneId, mode === 'pending' ? ['editing', 'saving', 'created'] : ['editing', 'error', 'retried', 'created']) }, async ({}, testInfo) => {
    await developerUi(testInfo, async requests => {
      const name = '模拟外部协作 · 非真实凭据'
      const { reading } = await openNativeDeveloper(sceneId)
      const initial = await developerKeys(reading)
      const create = product.getByTestId('api-key-create')
      await expect(create).toBeEnabled()
      await product.getByTestId('api-key-name').fill(name)
      let creating = developerResponse('POST')
      if (mode === 'failed') {
        await create.click()
        expect((await creating).status()).toBe(503)
        await expect(product.getByTestId('account-settings-developer').getByRole('alert')).toContainText('503')
        await expect(product.getByTestId('api-key-name')).toHaveValue(name)
        await expect(create).toBeEnabled()
        await expect(product.getByTestId('api-key-fresh')).toHaveCount(0)
        await expect(product.locator('[data-testid^="api-key-row-"]')).toHaveCount(initial.length)
        await product.screenshot({ path: testInfo.outputPath('developer-create-failed.png') })
        creating = developerResponse('POST')
      }
      const listing = developerResponse('GET')
      await create.click()
      if (mode === 'pending') {
        await expect(create).toBeDisabled()
        for (const key of initial) await expect(product.getByTestId('api-key-' + (key.managed ? 'rotate-' : 'revoke-') + key.key_id)).toBeDisabled()
        expect(requests.filter(request => request.method === 'POST' && request.path === PREVIEW_DEVELOPER.keysPath)).toHaveLength(1)
        await product.screenshot({ path: testInfo.outputPath('developer-create-pending.png') })
      }
      const created = await developerCreated(await creating, name)
      const keys = await developerKeys(listing)
      expect(keys).toHaveLength(initial.length + 1)
      expect(keys.filter(key => key.key_id === created.key_id)).toHaveLength(1)
      await expect(create).toBeEnabled()
      await expect(product.getByTestId('api-key-secret')).toHaveText(created.token)
      await expect(product.getByTestId('api-key-name')).toHaveValue('')
      await expect(product.getByTestId('account-settings-developer').getByRole('alert')).toHaveCount(0)
      await product.getByTestId('api-key-fresh-close').click()
      await expect(product.getByTestId('api-key-secret')).toHaveCount(0)
      expect(requests.filter(request => request.method === 'POST' && request.path === PREVIEW_DEVELOPER.keysPath)).toHaveLength(mode === 'failed' ? 2 : 1)
      await product.screenshot({ path: testInfo.outputPath('developer-create-result.png') })
    }, mode === 'failed' ? [{ path: PREVIEW_DEVELOPER.keysPath, method: 'POST', status: 503 }] : [])
  })
}

async function openNativeBrowser(sceneId) {
  await scenario('settings-browser', sceneId)
  await expect(product.getByTestId('account-settings-browser')).toBeVisible()
  await product.getByRole('button', { name: '高级设置', exact: true }).first().click()
}

async function expectBrowserNativeUnavailable() {
  await expect(product.getByTestId('browser-settings-cdp').getByRole('switch')).toBeDisabled()
  await expect(product.getByTestId('browser-settings-downloads').getByRole('button', { name: '更改', exact: true })).toBeDisabled()
  await expect(product.getByTestId('browser-settings-vault').getByRole('button').first()).toBeDisabled()
}

async function openBrowserHistory() {
  await product.getByTestId('browser-history-management').getByRole('button', { name: '管理', exact: true }).click()
  await expect(product.getByTestId('account-settings-browser-history')).toBeVisible()
}

async function returnBrowserOverview() {
  await product.getByTestId('account-settings-browser-history').getByRole('link', { name: browserZh.settings.title, exact: true }).click()
  await expect(product.getByTestId('account-settings-browser')).toBeVisible()
  await product.getByRole('button', { name: '高级设置', exact: true }).first().click()
}

test('native browser settings preserve rules and history across edits, confirmation and reentry', { annotation: previewConsumption('settings-browser', 'settings-browser-states', ['loaded', 'editing', 'error', 'searched', 'paged', 'deleted', 'cleared', 'reloaded']) }, async ({}, testInfo) => {
  const origin = 'https://research.example.org'
  const requests = []
  product.on('request', request => {
    const path = new URL(request.url()).pathname
    if (path.startsWith(PREVIEW_BROWSER.path)) requests.push({ path, body: request.postDataJSON() })
  })
  try {
    await normalUi(testInfo, async () => {
      await openNativeBrowser('settings-browser-states')
      const rules = product.getByTestId('browser-settings-agent-sites')
      await expect(rules.getByTestId('browser-agent-site-list').locator('li')).toHaveCount(1)
      await rules.getByRole('textbox', { name: '精确网站来源地址', exact: true }).fill(origin)
      const [saved] = await Promise.all([
        product.waitForResponse(response => new URL(response.url()).pathname === PREVIEW_BROWSER.path + '/policy' && response.request().postDataJSON().kind === 'set'),
        rules.getByRole('button', { name: '添加规则', exact: true }).click(),
      ])
      expect((await saved.json()).ok).toBe(true)
      await expect(rules.getByTestId('browser-agent-site-list').locator('li')).toHaveCount(2)
      await product.screenshot({ path: testInfo.outputPath('browser-rule-added.png') })
      await product.reload()
      await product.getByRole('button', { name: '高级设置', exact: true }).first().click()
      const removeRule = product.getByRole('button', { name: '移除 ' + origin + ' 的规则', exact: true })
      await expect(removeRule).toBeVisible()
      await expectBrowserNativeUnavailable()
      await openBrowserHistory()
      const history = product.getByTestId('browser-settings-history')
      const rows = history.getByRole('button', { name: browserZh.settings.historyActions, exact: true })
      const search = history.getByRole('searchbox', { name: '搜索标题或网址', exact: true })
      await expect(rows).toHaveCount(20)
      await history.getByRole('button', { name: '下一页', exact: true }).click()
      await expect(rows).toHaveCount(4)
      await search.fill('notes/24')
      await expect(rows).toHaveCount(1)
      await rows.click()
      await product.getByRole('menuitem', { name: browserZh.settings.reopenHistory, exact: true }).click()
      await expect(history.getByRole('alert')).toHaveText('内置浏览器仅在桌面端可用。')
      await history.scrollIntoViewIfNeeded()
      await product.screenshot({ path: testInfo.outputPath('browser-open-unavailable.png') })
      await history.getByRole('button', { name: '更多历史记录操作', exact: true }).click()
      await product.getByRole('menuitem', { name: '删除记录', exact: true }).click()
      await expect(history.getByText(browserZh.settings.historyEmpty, { exact: true })).toBeVisible()
      await search.clear()
      await expect(rows).toHaveCount(20)
      await history.getByRole('button', { name: '清除浏览数据', exact: true }).click()
      const confirmation = product.getByRole('alertdialog')
      await expect(confirmation).toBeVisible()
      await expect(confirmation.getByRole('button', { name: '清除所选数据', exact: true })).toBeDisabled()
      await confirmation.getByRole('combobox', { name: '历史记录时间范围', exact: true }).click()
      await product.getByRole('option', { name: '全部历史', exact: true }).click()
      await confirmation.getByRole('checkbox', { name: '浏览历史', exact: true }).check()
      await product.screenshot({ path: testInfo.outputPath('browser-clear-confirmation.png') })
      await confirmation.getByRole('button', { name: '取消', exact: true }).click()
      expect(requests.filter(request => request.path.endsWith('/data'))).toHaveLength(0)
      await history.getByRole('button', { name: '清除浏览数据', exact: true }).click()
      await product.getByRole('alertdialog').getByRole('button', { name: '清除所选数据', exact: true }).click()
      await expect(history.getByText(browserZh.settings.historyEmpty, { exact: true })).toBeVisible()
      await product.reload()
      await openBrowserHistory()
      await expect(history.getByText(browserZh.settings.historyEmpty, { exact: true })).toBeVisible()
      await returnBrowserOverview()
      await expect(removeRule).toBeVisible()
      await removeRule.click()
      await expect(removeRule).toHaveCount(0)
      const window = await app.browserWindow(product)
      await window.evaluate((window, minimum) => window.setSize(minimum.width, minimum.height), WORKSPACE_WINDOW_MINIMUM)
      await openBrowserHistory()
      await history.scrollIntoViewIfNeeded()
      await product.screenshot({ path: testInfo.outputPath('browser-cleared-minimum.png') })
    })
  } finally {
    writeFileSync(testInfo.outputPath('browser-settings-requests.json'), JSON.stringify(requests, null, 2))
  }
})

for (const mode of ['empty', 'pending', 'failed', 'retry']) {
  const sceneId = 'settings-browser-' + mode
  test('native browser settings read lifecycle: ' + sceneId, { annotation: previewConsumption('settings-browser', sceneId, mode === 'empty' ? ['empty'] : mode === 'pending' ? ['loading', 'loaded'] : mode === 'failed' ? ['error', 'retry-failed'] : ['error', 'retried', 'loaded']) }, async ({}, testInfo) => {
    await normalUi(testInfo, async () => {
      await openNativeBrowser(sceneId)
      const rules = product.getByTestId('browser-settings-agent-sites')
      const history = product.getByTestId('browser-settings-history')
      if (mode === 'pending') {
        await expect(rules.getByText('正在读取 Agent 网站规则…', { exact: true })).toBeVisible()
        await rules.scrollIntoViewIfNeeded()
        await product.screenshot({ path: testInfo.outputPath('browser-loading.png') })
      }
      if (mode === 'empty') {
        await expect(rules.getByText('暂无 Agent 网站规则。', { exact: true })).toBeVisible()
      } else if (mode === 'failed' || mode === 'retry') {
        await expect(rules.getByRole('alert')).toBeVisible()
        await rules.scrollIntoViewIfNeeded()
        await product.screenshot({ path: testInfo.outputPath('browser-read-failed.png') })
        if (mode === 'retry') {
          const [recovered] = await Promise.all([
            controls.waitForResponse(response => new URL(response.url()).pathname === PREVIEW_BROWSER.recoveryPath && response.request().method() === 'POST'),
            controls.getByTestId('preview-browser-recover').click(),
          ])
          expect(recovered.status()).toBe(200)
          await expect(rules.getByRole('alert')).toBeVisible()
        }
        const [reread] = await Promise.all([
          product.waitForResponse(response => new URL(response.url()).pathname === PREVIEW_BROWSER.path + '/policy' && response.request().postDataJSON().kind === 'read'),
          rules.getByRole('button', { name: '重新读取网站规则', exact: true }).click(),
        ])
        expect(reread.status()).toBe(200)
        if (mode === 'failed') {
          await expect(rules.getByRole('alert')).toBeVisible()
        } else await expect(rules.getByTestId('browser-agent-site-list').locator('li')).toHaveCount(1)
      } else {
        await expect(rules.getByTestId('browser-agent-site-list').locator('li')).toHaveCount(1)
      }
      await rules.scrollIntoViewIfNeeded()
      await product.screenshot({ path: testInfo.outputPath('browser-read-result.png') })
      await expectBrowserNativeUnavailable()
      await openBrowserHistory()
      if (mode === 'pending') {
        await expect(history.getByText('正在加载浏览记录…', { exact: true })).toBeVisible()
        await product.screenshot({ path: testInfo.outputPath('browser-history-loading.png') })
      }
      if (mode === 'empty') await expect(history.getByText(browserZh.settings.historyEmpty, { exact: true })).toBeVisible()
      else if (mode === 'failed') {
        await expect(history.getByRole('alert')).toHaveText('浏览器操作失败，请重试。')
        const [queried] = await Promise.all([
          product.waitForResponse(response => new URL(response.url()).pathname === PREVIEW_BROWSER.path + '/history' && response.request().postDataJSON().kind === 'query'),
          history.getByRole('searchbox', { name: '搜索标题或网址', exact: true }).fill('notes'),
        ])
        expect(queried.status()).toBe(200)
        await expect(history.getByRole('alert')).toHaveText('浏览器操作失败，请重试。')
      } else await expect(history.getByRole('button', { name: browserZh.settings.historyActions, exact: true })).toHaveCount(20)
      await product.screenshot({ path: testInfo.outputPath('browser-history-result.png') })
    })
  })
}

for (const mode of ['pending', 'failed']) {
  const sceneId = 'settings-browser-write-' + mode
  test('native browser policy write lifecycle: ' + sceneId, { annotation: previewConsumption('settings-browser', sceneId, mode === 'pending' ? ['saving', 'saved'] : ['error', 'retried', 'saved']) }, async ({}, testInfo) => {
    await normalUi(testInfo, async () => {
      await openNativeBrowser(sceneId)
      const rules = product.getByTestId('browser-settings-agent-sites')
      const rows = rules.getByTestId('browser-agent-site-list').locator('li')
      const input = rules.getByRole('textbox', { name: '精确网站来源地址', exact: true })
      const add = rules.getByRole('button', { name: '添加规则', exact: true })
      await expect(rows).toHaveCount(1)
      await input.fill('https://research.example.org')
      const [response] = await Promise.all([
        product.waitForResponse(response => new URL(response.url()).pathname === PREVIEW_BROWSER.path + '/policy' && response.request().postDataJSON().kind === 'set'),
        (async () => {
          await add.click()
          if (mode === 'pending') {
            await expect(add).toBeDisabled()
            await expect(input).toBeDisabled()
            await expect(rows).toHaveCount(1)
            await product.screenshot({ path: testInfo.outputPath('browser-write-pending.png') })
          }
        })(),
      ])
      expect((await response.json()).ok).toBe(mode !== 'failed')
      if (mode === 'failed') {
        await expect(rules.getByRole('alert')).toHaveText('此平台或数据位置不支持安全的 Agent 网站规则，无法保存或应用规则。')
        await product.screenshot({ path: testInfo.outputPath('browser-write-failed.png') })
        await rules.getByRole('button', { name: '重新读取网站规则', exact: true }).click()
        await expect(rows).toHaveCount(1)
        await expect(input).toHaveValue('https://research.example.org')
        await add.click()
      }
      await expect(rows).toHaveCount(2)
      await expectBrowserNativeUnavailable()
      await product.screenshot({ path: testInfo.outputPath('browser-write-result.png') })
    })
  })
}

for (const feedback of [
  { id: 'feedback-normal', status: 200, errorKey: null },
  { id: 'feedback-failed', status: 502, errorKey: 'failed' },
  { id: 'feedback-rate-limited', status: 429, errorKey: 'rateLimited' },
]) {
  const english = feedback.status === 429
  test('native feedback submission preserves consent and explicit retry: ' + feedback.id, { annotation: previewConsumption('surface-feedback', feedback.id, ['editing', feedback.status === 200 ? 'submitted' : feedback.status === 429 ? 'rate-limited' : 'failed']) }, async ({}, testInfo) => {
    const dictionary = english ? en : zh
    const labels = english ? componentsEn : componentsZh
    await normalUi(testInfo, async () => {
      if (english) {
        const nativeWindow = await app.browserWindow(product)
        await nativeWindow.evaluate((window, minimum) => window.setSize(minimum.width, minimum.height), WORKSPACE_WINDOW_MINIMUM)
        await useDarkEnglishAppearance()
        await expect(product.locator('html')).toHaveAttribute('data-theme', 'dark')
        await expect(product.locator('html')).toHaveAttribute('lang', LOCALES.en.tag)
      }
      await scenario('surface-feedback', feedback.id, dictionary)
      await controls.getByRole('button', { name: dictionary.guide, exact: true }).click()
      const guide = controls.getByRole('dialog', { name: dictionary.guide, exact: true })
      await expect(guide.getByText(dictionary['dialogEntry_feedback-form'], { exact: true })).toBeVisible()
      if (feedback.status === 200) await expect(guide.getByText(dictionary.feedbackSubmitExpected, { exact: true })).toBeVisible()
      if (feedback.status !== 502) await controls.screenshot({ path: testInfo.outputPath('feedback-entry-guide.png'), animations: 'disabled' })
      await controls.keyboard.press('Escape')
      await expect(guide).not.toBeVisible()
      const submissions = []
      product.on('request', request => {
        if (new URL(request.url()).pathname === FEEDBACK_SUBMISSION_PATH) submissions.push({ method: request.method(), body: request.postDataBuffer()?.toString('utf8') })
      })
      const entry = product.getByTestId('feedback-recorder-entry')
      await entry.click()
      const dialog = product.getByTestId('feedback-dialog')
      const description = product.getByTestId('feedback-description')
      const submit = product.getByTestId('feedback-submit')
      await expect(dialog).toBeVisible()
      await expect(submit).toBeDisabled()
      await expect(product.getByTestId('feedback-auto-screenshot')).toHaveCount(0)
      if (feedback.status === 200) {
        await product.keyboard.press('Escape')
        await expect(dialog).not.toBeVisible()
        expect(submissions).toEqual([])
        await entry.click()
        await expect(dialog).toBeVisible()
      }
      await product.getByTestId('feedback-include-logs').uncheck()
      await expect(product.getByTestId('feedback-include-logs')).not.toBeChecked()
      await expect(product.getByTestId('feedback-include-trace')).not.toBeChecked()
      await expect(product.getByTestId('feedback-include-trace')).toBeDisabled()
      const message = 'Synthetic feedback fixture for ' + feedback.id + '.'
      await description.fill(message)
      await expect(submit).toBeEnabled()
      const submitOnce = async keyboard => {
        const sending = product.waitForResponse(response => new URL(response.url()).pathname === FEEDBACK_SUBMISSION_PATH && response.request().method() === 'POST')
        if (keyboard) {
          await submit.focus()
          await expect(submit).toBeFocused()
          await submit.press('Enter')
        } else await submit.click()
        const response = await sending
        expect(response.status()).toBe(feedback.status)
        const multipart = response.request().postDataBuffer().toString('utf8')
        expect(multipart).toContain('name="include_logs"\r\n\r\nfalse')
        expect(multipart).toContain('name="include_trace"\r\n\r\nfalse')
        expect(multipart).not.toContain('filename=')
        expect(multipart).not.toContain('name="recording_report"')
        expect(multipart).not.toContain('name="renderer_diagnostics"')
      }
      await submitOnce(false)
      expect(submissions).toHaveLength(1)
      if (feedback.status === 200) {
        const done = product.getByTestId('feedback-done')
        await expect(done).toContainText(labels.feedback.received)
        const state = await nativeArchiveState()
        expect(state.feedback.receipts).toHaveLength(1)
        const receipt = state.feedback.receipts[0]
        expect(receipt.id).toMatch(/^preview-feedback:/)
        expect(receipt).toMatchObject({ imageCount: 0, imageBytes: 0, recordingReportBytes: 0, rendererDiagnosticsBytes: 0, requestedLogs: false, requestedTrace: false, collectedLogs: false, collectedTrace: false })
        expect(JSON.stringify(state)).not.toContain(message)
        await expect(done).toContainText(receipt.id)
        await expect(description).not.toBeVisible()
        await product.screenshot({ path: testInfo.outputPath('feedback-submitted.png'), animations: 'disabled' })
        await dialog.getByRole('button', { name: labels.feedback.done, exact: true }).click()
      } else {
        const error = product.getByTestId('feedback-error')
        await expect(error).toContainText(labels.feedback[feedback.errorKey])
        await expect(description).toHaveValue(message)
        await expect(submit).toBeEnabled()
        await expect(product.getByTestId('feedback-done')).toHaveCount(0)
        expect((await nativeArchiveState()).feedback.receipts).toEqual([])
        await submitOnce(english)
        expect(submissions).toHaveLength(2)
        await expect(error).toContainText(labels.feedback[feedback.errorKey])
        await expect(description).toHaveValue(message)
        await expect(submit).toBeEnabled()
        await expect(product.getByTestId('feedback-include-logs')).not.toBeChecked()
        await expect(product.getByTestId('feedback-include-trace')).not.toBeChecked()
        expect((await nativeArchiveState()).feedback.receipts).toEqual([])
        await product.screenshot({ path: testInfo.outputPath('feedback-failed-retained.png'), animations: 'disabled' })
        await product.keyboard.press('Escape')
      }
      await expect(dialog).not.toBeVisible()
      expect(submissions).toHaveLength(feedback.status === 200 ? 1 : 2)
      expect(submissions.every(request => request.method === 'POST')).toBe(true)
      writeFileSync(testInfo.outputPath('feedback-submissions.json'), JSON.stringify(submissions, null, 2))
    }, feedback.status === 200 ? [] : [{ path: FEEDBACK_SUBMISSION_PATH, method: 'POST', status: feedback.status }])
  })
}

test('native embedded render failure recovers locally without changing project or session state', { annotation: previewConsumption('surface-error', 'surface-error-states', ['closed', 'open', 'error']) }, async ({}, testInfo) => {
  const observations = { failures: [], externalOrigins: [], productErrors: [], controlErrors: [], caughtErrors: [] }
  const origin = new URL(product.url()).origin
  product.on('console', message => {
    if (message.type() !== 'error' || !message.text().startsWith('[renderer] Unhandled React render failure')) return
    void message.args()[1]?.jsonValue().then(
      diagnostic => observations.caughtErrors.push(diagnostic.message),
      error => observations.caughtErrors.push(error.message),
    )
  })
  for (const page of [product, controls]) {
    page.on('pageerror', error => (page === product ? observations.productErrors : observations.controlErrors).push(error.message))
    page.on('request', request => {
      const url = new URL(request.url())
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) observations.externalOrigins.push(url.origin)
    })
    page.on('response', response => {
      const path = new URL(response.url()).pathname
      if ((path.startsWith('/api/') || path.startsWith('/__preview/')) && response.status() >= 400) observations.failures.push({ path, method: response.request().method(), status: response.status() })
    })
  }
  try {
    await scenario('surface-error', 'surface-error-states')
    const original = await nativeArchiveState()
    const host = product.getByTestId('preview-error-host')
    const trigger = product.getByTestId('preview-error-trigger')
    const recover = product.getByTestId('preview-error-recover')
    const failure = product.getByRole('heading', { name: shellZh.errorBoundary.title, exact: true })
    await expect(host).toBeVisible()
    await expect(trigger).toBeEnabled()
    await expect(recover).toBeDisabled()
    for (const interaction of ['mouse', 'keyboard']) {
      const previous = observations.caughtErrors.length
      await trigger.click()
      await expect(failure).toBeVisible()
      await expect.poll(() => observations.caughtErrors.slice(previous)).toEqual(['preview-only-render-failure'])
      await expect(host).toContainText(shellZh.errorBoundary.description)
      await expect(trigger).toBeDisabled()
      await expect(recover).toBeEnabled()
      await product.screenshot({ path: testInfo.outputPath('error-caught-' + interaction + '.png'), animations: 'disabled' })
      if (interaction === 'keyboard') {
        await recover.focus()
        await expect(recover).toBeFocused()
        await recover.press('Enter')
      } else await recover.click()
      await expect(failure).not.toBeVisible()
      await expect(trigger).toBeEnabled()
      await expect(recover).toBeDisabled()
      await expect(host).toBeVisible()
      const current = await nativeArchiveState()
      for (const key of ['generation', 'scene', 'preferences', 'projects', 'sessions']) expect(current[key]).toEqual(original[key])
    }
    await product.screenshot({ path: testInfo.outputPath('error-locally-recovered.png'), animations: 'disabled' })
    expect(observations.failures).toEqual([])
    expect(observations.externalOrigins).toEqual([])
    expect(observations.controlErrors).toEqual([])
    expect(observations.productErrors.every(message => message === 'preview-only-render-failure')).toBe(true)
  } finally {
    writeFileSync(testInfo.outputPath('render-failure-observations.json'), JSON.stringify(observations, null, 2))
  }
})

test('native literature search restores terminal identities and preserves selection and details without imports', { annotation: previewConsumption('viewer-literature_search', 'viewer-literature_search-states', ['loaded']) }, async ({}, testInfo) => {
  await normalUi(testInfo, async () => {
    const writes = []
    product.on('request', request => {
      const path = new URL(request.url()).pathname
      if ((path.startsWith('/api/literature/') || path.startsWith('/api/resource/')) && !['GET', 'HEAD'].includes(request.method()) && !(path === '/api/literature/searches/result-status' && request.method() === 'POST')) writes.push({ path, method: request.method() })
    })
    await scenario('viewer-literature_search', 'viewer-literature_search-states')
    const history = new URL('/api/literature/searches', manifest.origin)
    history.searchParams.set('previewInstance', manifest.instance)
    const readTasks = async () => {
      const response = await product.request.get(history.href)
      expect(response.status()).toBe(200)
      return (await response.json()).items
    }
    const tasks = await readTasks()
    expect(tasks).toHaveLength(1)
    const task = tasks[0]
    expect(task.status).toBe('completed')
    expect(task.query).toBe(PREVIEW_SEARCH.literatureQuery)
    expect(task.result.papers).toHaveLength(2)
    expect(JSON.parse(task.output)).toEqual(task.result)
    const paper = task.result.papers.find(candidate => candidate.title === PREVIEW_SEARCH.literatureTitle)
    expect(paper).toBeDefined()
    const tab = product.getByRole('tab', { name: new RegExp(PREVIEW_SEARCH.literatureQuery) })
    await tab.click()
    const search = product.getByTestId('literature-search-tab')
    const rows = search.locator('[data-testid^="search-paper-"]')
    await expect(rows).toHaveCount(task.result.papers.length)
    const row = search.getByTestId('search-paper-' + paper.paper_id)
    await expect(row).toContainText(paper.title)
    await expect(row).toContainText(paper.authors[0])
    const selection = row.getByRole('checkbox')
    await selection.check()
    await expect(selection).toBeChecked()
    await row.locator('p').click()
    await expect(row).toHaveAttribute('data-active', 'true')
    const detail = search.locator('aside')
    for (const text of [paper.title, ...paper.authors, paper.venue, String(paper.year), paper.reason]) await expect(detail).toContainText(text)
    await expect(detail).not.toContainText(paper.abstract)
    await product.screenshot({ path: testInfo.outputPath('search-terminal-detail.png'), animations: 'disabled' })
    await detail.getByRole('button', { name: '收起详情', exact: true }).click()
    await expect(detail).not.toBeVisible()
    await expect(selection).toBeChecked()
    await product.reload()
    await tab.click()
    await expect(search).toBeVisible()
    await expect(rows).toHaveCount(task.result.papers.length)
    await expect(row).toContainText(paper.title)
    expect(await readTasks()).toEqual(tasks)
    expect(writes).toEqual([])
    await product.screenshot({ path: testInfo.outputPath('search-terminal-reloaded.png'), animations: 'disabled' })
    writeFileSync(testInfo.outputPath('search-terminal-identities.json'), JSON.stringify({ taskId: task.id, paperIds: task.result.papers.map(paper => paper.paper_id), writes }, null, 2))
  })
})

test('native version comparison preserves one file and both immutable Monaco revisions without writes', { annotation: previewConsumption('viewer-version_diff', 'viewer-version_diff-states', ['loaded']) }, async ({}, testInfo) => {
  await normalUi(testInfo, async () => {
    const writes = []
    product.on('request', request => {
      const path = new URL(request.url()).pathname
      if ((path.startsWith('/api/resource/files/') || path.startsWith('/api/resource/versions/') || path === '/api/workbench/content') && !['GET', 'HEAD'].includes(request.method())) writes.push({ path, method: request.method() })
    })
    const opening = product.waitForResponse(response => new URL(response.url()).pathname === '/api/workbench/open' && new URL(response.url()).searchParams.get('path') === 'readme.md' && response.request().method() === 'GET')
    await scenario('viewer-version_diff', 'viewer-version_diff-states')
    const opened = await opening
    expect(opened.status()).toBe(200)
    const projection = await opened.json()
    await expect(product.getByRole('heading', { name: 'Revision notes', exact: true })).toBeVisible()
    const historyPath = '/api/resource/files/' + encodeURIComponent(projection.asset_id) + '/versions'
    const reading = product.waitForResponse(response => new URL(response.url()).pathname === historyPath && response.request().method() === 'GET')
    await product.getByTestId('document-version-history').click()
    const response = await reading
    expect(response.status()).toBe(200)
    const history = await response.json()
    expect(history.total).toBe(2)
    expect(history.versions).toHaveLength(2)
    expect(history.file_id).toBe(projection.asset_id)
    expect(projection.versioning.file_id).toBe(history.file_id)
    const historical = history.versions.find(version => version.sequence === 1)
    const current = history.versions.find(version => version.sequence === 2)
    expect(historical).toBeDefined()
    expect(current).toBeDefined()
    expect(historical.file_id).toBe(history.file_id)
    expect(current.file_id).toBe(history.file_id)
    expect(current.id).toBe(projection.versioning.version_id)
    expect(current.object_id).toBe(projection.revision)
    expect(projection.versioning.working_revision).toBe(projection.revision)
    expect(projection.versioning.disk_revision).toBe(projection.revision)
    expect(historical.id).not.toBe(current.id)
    const rows = product.locator('.vds-version-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ has: product.getByText('v2', { exact: true }) })).toContainText('当前版本')
    await product.screenshot({ path: testInfo.outputPath('version-history.png'), animations: 'disabled' })
    const historicalContent = product.waitForResponse(response => new URL(response.url()).pathname === '/api/resource/versions/' + encodeURIComponent(historical.id) + '/content' && response.request().method() === 'GET')
    const currentContent = product.waitForResponse(response => new URL(response.url()).pathname === '/api/resource/versions/' + encodeURIComponent(current.id) + '/content' && response.request().method() === 'GET')
    await rows.filter({ has: product.getByText('v1', { exact: true }) }).getByTestId('version-history-row-action').click()
    const baseline = await historicalContent
    const latest = await currentContent
    expect(baseline.status()).toBe(200)
    expect(latest.status()).toBe(200)
    const baselineText = await baseline.text()
    const currentText = await latest.text()
    expect(baselineText).toContain('# Minimal Project')
    expect(baselineText).not.toContain('## Revision notes')
    expect(currentText).toContain('## Revision notes')
    expect(currentText).toContain('The reviewed preview revision adds a reproducible comparison example.')
    const comparison = product.getByTestId('version-text-diff')
    await expect(comparison).toBeVisible()
    const original = comparison.contentFrame().locator('.original .view-lines')
    const modified = comparison.contentFrame().locator('.modified .view-lines')
    await expect(original).toBeVisible()
    await expect(modified).toBeVisible()
    await expect(original).toContainText('Minimal Project')
    await expect(original).not.toContainText('Revision notes')
    await expect(modified).toContainText('Revision notes')
    await expect(modified).toContainText('The reviewed preview revision adds a reproducible comparison example.')
    expect(writes).toEqual([])
    writeFileSync(testInfo.outputPath('version-identity.json'), JSON.stringify({ projection, history, baselineText, currentText, writes }, null, 2))
    await product.screenshot({ path: testInfo.outputPath('version-comparison.png'), animations: 'disabled' })
  })
})

test('native legacy XLS uses its bounded Office child runtime and dedicated compilation policy', async ({}, testInfo) => {
  await normalUi(testInfo, async () => {
    await scenario('page-resource', 'resource-browse')
    await product.getByTestId('project-library').click()
    await selectNativeLibraryCategory(layoutZh.materials)
    const sample = PREVIEW_DOCUMENTS.find(document => document.path === 'sample.xls')
    const opening = product.waitForResponse(response => new URL(response.url()).pathname === '/api/workbench/open' && new URL(response.url()).searchParams.get('path') === sample.path && response.request().method() === 'GET')
    await product.getByTestId('material-' + sample.path).getByRole('button', { name: sample.path, exact: true }).click()
    const opened = await opening
    expect(opened.status()).toBe(200)
    const projection = await opened.json()
    expect(projection.viewer).toBe('office')
    expect(projection.processor).toBe('xls')
    expect(projection.revision).toBe('sha256:' + sample.sha256)
    const document = product.locator('iframe[data-testid="office-editor"][title="sample.xls"]')
    await expect(document).toHaveAttribute('data-runtime-ready', 'true')
    await expect(document).toHaveAttribute('data-document-ready', 'true')
    await expect(document).toBeVisible()
    const child = document.contentFrame()
    await expect(child.locator('#qtcanvas')).toBeVisible()
    const bounds = await document.evaluate(element => {
      const rectangle = element.getBoundingClientRect()
      return { left: rectangle.left, top: rectangle.top, right: rectangle.right, bottom: rectangle.bottom, width: rectangle.width, height: rectangle.height, viewportWidth: innerWidth, viewportHeight: innerHeight }
    })
    expect(bounds.width).toBeGreaterThan(0)
    expect(bounds.height).toBeGreaterThan(0)
    expect(bounds.left).toBeGreaterThanOrEqual(-FRAME_GEOMETRY_ROUNDING_PX)
    expect(bounds.top).toBeGreaterThanOrEqual(-FRAME_GEOMETRY_ROUNDING_PX)
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth + FRAME_GEOMETRY_ROUNDING_PX)
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight + FRAME_GEOMETRY_ROUNDING_PX)
    const childUrl = new URL(await document.getAttribute('src'))
    expect(childUrl.origin).toBe(manifest.origin)
    expect(childUrl.pathname).toBe(PREVIEW_OFFICE_FRAME_PATH)
    expect(previewOfficeFrameParameters(childUrl).locale).toBe('zh')
    const childResponse = await product.request.get(childUrl.href)
    expect(childResponse.status()).toBe(200)
    const policy = childResponse.headers()['content-security-policy']
    expect(policy).toContain("'unsafe-eval'")
    await child.locator('html').evaluate(element => {
      element.dataset.pdfeOfficeViolations = '[]'
      const violations = []
      document.addEventListener('securitypolicyviolation', event => {
        violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI, policy: event.originalPolicy })
        element.dataset.pdfeOfficeViolations = JSON.stringify(violations)
      })
      document.addEventListener('click', () => {
        const script = document.createElement('script')
        script.textContent = "try { document.documentElement.dataset.pdfeOfficeCompilation = String(Function('return 7')()) } catch (error) { document.documentElement.dataset.pdfeOfficeCompilation = error.name }"
        document.body.appendChild(script)
        script.remove()
      }, { once: true, capture: true })
    })
    await child.locator('#qtcanvas').click()
    await expect(child.locator('html')).toHaveAttribute('data-pdfe-office-compilation', '7')
    await expect(child.locator('html')).toHaveAttribute('data-pdfe-office-violations', '[]')
    await child.locator('html').evaluate(() => {
      document.addEventListener('click', () => {
        const object = document.createElement('object')
        object.id = 'pdfe-office-csp-object'
        object.data = 'data:text/html,<p>PDFE blocked object probe</p>'
        document.body.appendChild(object)
      }, { once: true, capture: true })
    })
    await child.locator('#qtcanvas').click()
    await expect.poll(() => child.locator('html').getAttribute('data-pdfe-office-violations').then(value => JSON.parse(value).some(violation => violation.directive === 'object-src'))).toBe(true)
    const violations = JSON.parse(await child.locator('html').getAttribute('data-pdfe-office-violations'))
    expect(violations).toHaveLength(1)
    expect(violations[0]).toEqual({ directive: 'object-src', blockedURI: 'data', policy })
    await child.locator('#pdfe-office-csp-object').evaluate(element => element.remove())
    await expect(product.getByText('无法解析文件路径。', { exact: false })).toHaveCount(0)
    writeFileSync(testInfo.outputPath('office-child-policy.json'), JSON.stringify({ projection, bounds, childUrl: childUrl.href, policy, compilation: '7', violations }, null, 2))
    await product.screenshot({ path: testInfo.outputPath('xls-child-runtime.png'), animations: 'disabled' })
  })
})

test('native project documents preserve manual Markdown saves and rendered PDF samples after reload', { annotation: previewConsumption('page-resource', 'resource-browse', ['populated', 'opened']) }, async ({}, testInfo) => {
  await normalUi(testInfo, async () => {
    await scenario('page-resource', 'resource-browse')
    await product.getByTestId('project-library').click()
    await selectNativeLibraryCategory(layoutZh.materials)
    const contentPath = '/api/workbench/content'
    const filePath = 'readme.md'
    const marker = 'Saved through the public native PDFE editor.'
    const opening = product.waitForResponse(response => new URL(response.url()).pathname === '/api/workbench/open' && new URL(response.url()).searchParams.get('path') === filePath && response.request().method() === 'GET')
    await product.getByTestId('material-' + filePath).getByRole('button', { name: filePath, exact: true }).click()
    const opened = await opening
    expect(opened.status()).toBe(200)
    const initial = await opened.json()
    expect(initial.viewer).toBe('markdown')
    await product.getByTestId('activity-account').click()
    await product.getByTestId('account-menu-settings').click()
    await expect(product.getByRole('dialog', { name: '设置', exact: true })).toBeVisible()
    await expect(product.getByTestId('account-settings-nav-shortcuts')).toHaveCount(0)
    await expect(product.getByTestId('account-settings-shortcuts')).toHaveCount(0)
    await product.screenshot({ path: testInfo.outputPath('shortcut-settings-hidden.png') })
    await product.getByRole('button', { name: '资料库文件', exact: true }).click()
    const autoSave = product.getByTestId('file-version-auto-save')
    if (await autoSave.isChecked()) await saveNativePreferences(value => value.autoSave === false, () => autoSave.uncheck())
    await expect(autoSave).not.toBeChecked()
    await product.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
    await product.getByTestId('markdown-mode-select').click()
    await product.getByTestId('markdown-open-editor').click()
    const editor = product.getByTestId('markdown-visual-editor').locator('.ProseMirror')
    await expect(editor).toContainText('Minimal Project')
    const paper = product.getByTestId('markdown-paper')
    await expect(paper).toBeVisible()
    await expect(product.locator('[data-testid^="markdown-page-width-"]')).toHaveCount(0)
    await expect(paper).toHaveCSS('max-width', 'none')
    await product.screenshot({ path: testInfo.outputPath('markdown-full-width.png') })
    const writes = []
    product.on('request', request => {
      if (new URL(request.url()).pathname === contentPath && !['GET', 'HEAD'].includes(request.method())) writes.push({ method: request.method(), path: new URL(request.url()).searchParams.get('path'), revision: request.headers()['if-match'], body: request.postData() })
    })
    await editor.click()
    await product.keyboard.press('ControlOrMeta+End')
    await product.keyboard.insertText(marker)
    await expect(editor).toContainText(marker)
    const dirty = product.getByRole('tab', { name: filePath, exact: true }).locator('[data-slot="navigation-tab-dirty"]')
    await expect(dirty).toBeVisible()
    expect(writes).toEqual([])
    const saving = product.waitForResponse(response => new URL(response.url()).pathname === contentPath && response.request().method() === 'PUT')
    await editor.press('ControlOrMeta+s')
    const saved = await saving
    expect(saved.status()).toBe(204)
    expect(saved.request().headers()['if-match']).toBe('"' + initial.revision + '"')
    await expect(dirty).toHaveCount(0)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ method: 'PUT', path: filePath, revision: '"' + initial.revision + '"' })
    expect(writes[0].body).toContain(marker)
    const savedRevision = saved.headers()['etag']
    expect(savedRevision).not.toBe('"' + initial.revision + '"')
    await product.reload()
    await product.getByTestId('markdown-mode-select').click()
    await product.getByTestId('markdown-open-editor').click()
    await expect(editor).toContainText(marker)
    await expect(dirty).toHaveCount(0)
    const contentUrl = new URL(contentPath, manifest.origin)
    contentUrl.searchParams.set('previewInstance', manifest.instance)
    contentUrl.searchParams.set('project', PREVIEW_PROJECT_ID)
    contentUrl.searchParams.set('path', filePath)
    const content = await product.request.get(contentUrl.href)
    expect(content.status()).toBe(200)
    const bytes = await content.body()
    expect(bytes.toString('utf8')).toContain(marker)
    const revision = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
    expect(content.headers()['etag']).toBe('"' + revision + '"')
    expect(savedRevision).toBe('"' + revision + '"')
    const projectionUrl = new URL('/api/workbench/open', contentUrl)
    projectionUrl.search = contentUrl.search
    const projection = await product.request.get(projectionUrl.href)
    expect(projection.status()).toBe(200)
    const current = await projection.json()
    expect(current.asset_id).toBe(initial.asset_id)
    expect(current.revision).toBe(revision)
    await product.screenshot({ path: testInfo.outputPath('document-saved-reopened.png'), animations: 'disabled' })
    await product.getByTestId('project-library').click()
    await selectNativeLibraryCategory(layoutZh.materials)
    const regionReads = []
    product.on('request', request => {
      if (new URL(request.url()).pathname === '/api/workbench/pdf/regions') regionReads.push({ method: request.method(), url: request.url() })
    })
    const [pdf] = await Promise.all([
      product.waitForResponse(response => new URL(response.url()).pathname === '/api/workbench/open' && new URL(response.url()).searchParams.get('path') === 'sample.pdf' && response.request().method() === 'GET').then(response => {
        expect(response.status()).toBe(200)
        return response.json()
      }),
      product.getByTestId('material-sample.pdf').getByRole('button', { name: 'sample.pdf', exact: true }).click(),
    ])
    await expect(product.getByTestId('pdf-page-1').locator('canvas')).toBeVisible()
    expect(pdf.viewer).toBe('pdf')
    expect(pdf.revision).toBe('sha256:' + PREVIEW_DOCUMENTS.find(document => document.viewer === 'pdf').sha256)
    expect(regionReads).toEqual([])
    await expect(product.getByText('批注读取失败，请重新打开文件后重试。', { exact: true })).toHaveCount(0)
    await expect(product.getByText('没读到项目目录。本地服务可能还没就绪，稍后点刷新重试。', { exact: true })).toHaveCount(0)
    expect(writes).toHaveLength(1)
    writeFileSync(testInfo.outputPath('document-save-identity.json'), JSON.stringify({ initial, current, writes, pdf, regionReads }, null, 2))
    await product.screenshot({ path: testInfo.outputPath('document-pdf-rendered.png'), animations: 'disabled' })
  })
})

for (const viewer of ['spreadsheet', 'table', 'unsupported']) {
  test('native reviewed data viewer preserves its sample through reload and public reentry: ' + viewer, { annotation: previewConsumption('viewer-' + viewer, 'viewer-' + viewer + '-states', ['loaded']) }, async ({}, testInfo) => {
    await normalUi(testInfo, async () => {
      const sample = PREVIEW_DOCUMENTS.find(document => document.viewer === viewer)
      const opening = () => product.waitForResponse(response => {
        const url = new URL(response.url())
        return response.request().method() === 'GET' && url.pathname === '/api/workbench/open' && url.searchParams.get('path') === sample.path
      })
      const contentWrites = []
      product.on('request', request => {
        if (new URL(request.url()).pathname === '/api/workbench/content' && !['GET', 'HEAD'].includes(request.method())) contentWrites.push({ method: request.method(), body: request.postData() })
      })
      const inspect = async () => {
        if (viewer === 'spreadsheet') {
          const grid = product.getByTestId('csv-grid')
          await expect(grid).toBeVisible()
          await expect(grid).toContainText('Temperature')
          await expect(grid).toContainText('Pressure')
          await expect(product.getByTestId('csv-document').getByRole('alert')).toHaveCount(0)
        } else if (viewer === 'table') {
          const table = product.getByTestId('table-viewer')
          await expect(table).toBeVisible()
          await expect(table.getByRole('columnheader', { name: 'Label', exact: true })).toBeVisible()
          for (const value of ['Temperature', '21.5', 'Pressure', '101.3']) await expect(table.getByRole('cell', { name: value, exact: true })).toBeVisible()
        } else {
          await expect(product.getByText(sample.path + ' 是二进制文件，暂不支持内置预览。可用系统默认应用查看。', { exact: true })).toBeVisible()
          await expect(product.getByRole('alert')).toHaveCount(0)
          await expect(product.getByTestId('project-center')).not.toBeVisible()
        }
        await expect(product.getByTestId('document-load-error')).toHaveCount(0)
        await expect(product.getByText('无法解析文件路径。', { exact: false })).toHaveCount(0)
      }
      const first = opening()
      await scenario('viewer-' + viewer, 'viewer-' + viewer + '-states')
      const response = await first
      expect(response.status()).toBe(200)
      const initial = await response.json()
      expect(initial.asset_id).toEqual(expect.any(String))
      expect(initial.asset_id.length).toBeGreaterThan(0)
      expect(initial.viewer).toBe(viewer)
      expect(initial.revision).toBe('sha256:' + sample.sha256)
      await inspect()
      await product.reload()
      await inspect()
      await product.getByRole('tab', { name: sample.path, exact: false }).getByRole('button').click()
      await product.getByTestId('project-library').click()
      await selectNativeLibraryCategory(layoutZh.materials)
      const reopened = opening()
      await product.getByTestId('material-' + sample.path).getByRole('button', { name: sample.path, exact: true }).click()
      const reentered = await reopened
      expect(reentered.status()).toBe(200)
      const current = await reentered.json()
      expect(current.asset_id).toBe(initial.asset_id)
      expect(current.revision).toBe(initial.revision)
      await inspect()
      expect(contentWrites).toEqual([])
      writeFileSync(testInfo.outputPath('data-viewer-identity.json'), JSON.stringify({ initial, current, contentWrites }, null, 2))
      await product.screenshot({ path: testInfo.outputPath('data-viewer-reentered.png'), animations: 'disabled' })
    })
  })
}

async function expectLoadedDocument(viewer) {
  if (viewer === 'markdown') {
    await product.getByTestId('markdown-mode-select').click()
    await product.getByTestId('markdown-open-preview').click()
    await expect(product.getByTestId('markdown-preview')).toContainText('Minimal Project')
  } else if (viewer === 'pdf') await expect(product.getByTestId('pdf-page-1').locator('canvas')).toBeVisible()
  else if (viewer === 'code') await expect(product.getByTestId('monaco-editor').contentFrame().locator('.view-lines')).toContainText('hello from minimal project')
  else if (viewer === 'image') {
    const image = product.getByTestId('image-viewer').getByRole('img', { name: 'sample.png', exact: true })
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate(element => ({ complete: element.complete, width: element.naturalWidth, height: element.naturalHeight }))).toEqual({ complete: true, width: 200, height: 200 })
    await expect(product.getByTestId('image-viewer').getByTestId('image-dimensions')).toHaveCount(0)
    await expect(product.getByTestId('image-viewer').getByRole('alert')).toHaveCount(0)
  } else if (viewer === 'office') {
    await expect(product.getByTestId('office-preview')).toHaveAttribute('data-office-title', 'sample.docx')
    await expect(product.getByTestId('office-preview')).toHaveAttribute('data-office-format', 'docx')
    await expect(product.getByTestId('office-preview-content')).toContainText('Normal + Courier New')
    await expect(product.getByTestId('office-preview').getByRole('status')).toHaveCount(0)
    await expect(product.getByTestId('office-preview').getByRole('alert')).toHaveCount(0)
  } else throw new Error('Unsupported document assertion: ' + viewer)
  await expect(product.getByTestId('document-load-error')).toHaveCount(0)
}

async function holdNativeRead(url) {
  let releaseRead
  const heldRead = new Promise(resolve => { releaseRead = resolve })
  let continuedRead = Promise.resolve()
  const holdRead = route => {
    continuedRead = (async () => {
      if (route.request().method() === 'GET') await heldRead
      await route.continue()
    })()
    return continuedRead
  }
  await product.route(url, holdRead)
  return async () => {
    releaseRead()
    await continuedRead
    await product.unroute(url, holdRead)
  }
}

const DOCUMENT_CONTENT_CASES = [
  ...['markdown', 'pdf'].flatMap(viewer => ['pending', 'failed', 'retry'].map(mode => ({ viewer, mode }))),
  { viewer: 'code', mode: 'pending' },
  { viewer: 'image', mode: 'retry' },
  { viewer: 'office', mode: 'failed' },
]

for (const { viewer, mode } of DOCUMENT_CONTENT_CASES) {
  const pageId = 'viewer-' + viewer
  const sceneId = pageId + '-' + mode
  test('native document content lifecycle: ' + sceneId, { annotation: previewConsumption(pageId, sceneId, mode === 'pending' ? ['loading', 'loaded'] : mode === 'failed' ? ['error', 'retry-failed', 'recovered'] : ['error', 'retried', 'loaded']) }, async ({}, testInfo) => {
    if (viewer === 'office') {
      const window = await app.browserWindow(product)
      await window.evaluate((window, minimum) => window.setSize(minimum.width, minimum.height), WORKSPACE_WINDOW_MINIMUM)
      await useDarkEnglishAppearance()
      await expect(controls.getByRole('heading', { name: en.title, exact: true })).toBeVisible()
      await expect(product.locator('html')).toHaveAttribute('data-theme', 'dark')
      await expect(product.locator('html')).toHaveAttribute('lang', LOCALES.en.tag)
    }
    const dictionary = viewer === 'office' ? en : zh
    const sample = PREVIEW_DOCUMENTS.find(document => document.viewer === viewer)
    const responses = []
    const writes = []
    const requests = new WeakSet()
    const matches = request => request.method() === 'GET' && new URL(request.url()).pathname === '/api/workbench/content' && new URL(request.url()).searchParams.get('path') === sample.path
    product.on('request', request => { if (matches(request) && new URL(product.url()).searchParams.get('scene') === sceneId) requests.add(request) })
    product.on('response', response => { if (requests.has(response.request())) responses.push(response.status()) })
    product.on('request', request => {
      const path = new URL(request.url()).pathname
      if (path.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) writes.push({ method: request.method(), path, body: request.postData() })
    })
    try {
      await normalUi(testInfo, async () => {
        if (mode === 'pending') {
          const releaseRead = await holdNativeRead(url => url.pathname === '/api/workbench/content' && url.searchParams.get('path') === sample.path)
          const progress = product.getByTestId('progress-screen')
          try {
            await Promise.all([product.waitForRequest(matches), scenario(pageId, sceneId)])
            await expect(progress).toBeVisible()
            await expect(progress).toHaveAttribute('aria-busy', 'true')
            if (viewer === 'markdown') await expect(product.getByRole('heading', { name: 'Minimal Project', exact: true })).toHaveCount(0)
            else await expect(product.getByTestId(viewer === 'code' ? 'monaco-editor' : 'pdf-page-1')).toHaveCount(0)
            expect(responses).toEqual([])
            await product.screenshot({ path: testInfo.outputPath('document-loading.png') })
          } finally {
            await releaseRead()
          }
          await expectLoadedDocument(viewer)
          await expect(progress).toHaveCount(0)
          expect(responses.length).toBeGreaterThan(0)
          expect(responses.every(status => status === 200)).toBe(true)
        } else {
          await scenario(pageId, sceneId, dictionary)
          const error = product.getByTestId('document-load-error')
          const retry = product.getByTestId('document-load-retry')
          await expect(error).toBeVisible()
          await expect(error).toContainText(PREVIEW_CONTENT.failureCode)
          await expect(retry).toBeEnabled()
          expect(responses).toEqual([503])
          if (viewer === 'office') {
            await controls.getByRole('button', { name: en.close, exact: true }).click()
            await expect.poll(() => product.evaluate(() => innerWidth)).toBeGreaterThanOrEqual(WORKSPACE_WINDOW_MINIMUM.width)
            await retry.focus()
            await expect(retry).toBeFocused()
            const geometry = await retry.boundingBox()
            const viewport = await product.evaluate(() => ({ width: innerWidth, height: innerHeight }))
            expect(geometry).not.toBeNull()
            expect(geometry.x).toBeGreaterThanOrEqual(0)
            expect(geometry.y).toBeGreaterThanOrEqual(0)
            expect(geometry.x + geometry.width).toBeLessThanOrEqual(viewport.width)
            expect(geometry.y + geometry.height).toBeLessThanOrEqual(viewport.height)
          }
          await product.screenshot({ path: testInfo.outputPath('document-failed.png') })
          await Promise.all([product.waitForResponse(response => matches(response.request())), viewer === 'office' ? retry.press('Enter') : retry.click()])
          if (mode === 'failed') {
            await expect(error).toBeVisible()
            await expect(retry).toBeEnabled()
            expect(responses).toEqual([503, 503])
            const currentUrl = product.url()
            if (viewer === 'office') await workspaceShortcut('F8')
            const [recovered] = await Promise.all([
              controls.waitForResponse(response => new URL(response.url()).pathname === PREVIEW_CONTENT.recoveryPath && response.request().method() === 'POST'),
              controls.getByTestId('preview-content-recover').click(),
            ])
            expect(recovered.status()).toBe(200)
            expect(product.url()).toBe(currentUrl)
            if (viewer === 'office') {
              await controls.getByRole('button', { name: en.close, exact: true }).click()
              await retry.focus()
              await expect(retry).toBeFocused()
              await retry.press('Enter')
            } else await retry.click()
          }
          await expectLoadedDocument(viewer)
          expect(responses).toEqual(mode === 'failed' ? [503, 503, 200] : [503, 200])
        }
        if (viewer === 'office') {
          await product.getByRole('button', { name: layoutEn.full, exact: true }).click()
          await expect(product.getByRole('button', { name: layoutEn.exitFull, exact: true })).toBeVisible()
          await expectLoadedDocument(viewer)
          await product.screenshot({ path: testInfo.outputPath('document-dark-fullview.png') })
          await product.getByRole('button', { name: layoutEn.exitFull, exact: true }).click()
        }
        if (['code', 'image', 'office'].includes(viewer)) {
          await product.getByRole('tab', { name: sample.path, exact: false }).getByRole('button').click()
          await product.getByTestId('project-library').click()
          const dictionary = viewer === 'office' ? layoutEn : layoutZh
          await selectNativeLibraryCategory(dictionary.materials, dictionary)
          const reopened = product.waitForResponse(response => matches(response.request()))
          await product.getByTestId('material-' + sample.path).getByRole('button', { name: sample.path, exact: true }).click()
          expect((await reopened).status()).toBe(200)
          await expectLoadedDocument(viewer)
        }
        await product.screenshot({ path: testInfo.outputPath('document-result.png') })
        const modelUrl = new URL('/api/serve/models', product.url())
        modelUrl.searchParams.set('previewInstance', manifest.instance)
        const models = await product.request.get(modelUrl.href)
        expect(models.status()).toBe(200)
        const model = (await models.json()).current_model
        for (const write of writes) {
          expect(write.method).toBe('POST')
          if (write.path === PREVIEW_RUNTIME_RECONFIGURATION.preparationPath) {
            expect(JSON.parse(write.body)).toEqual({
              request_id: expect.stringMatching(PREVIEW_RUNTIME_RECONFIGURATION.requestPattern),
              model_id: model,
              service_instance_id: 'preview-' + manifest.instance,
              persist_default: false,
            })
          } else {
            expect(write.path).toBe('/api/resource/reveal')
            expect(JSON.parse(write.body)).toEqual({ project: PREVIEW_PROJECT_ID, path: sample.path })
          }
        }
      }, mode === 'pending' ? [] : [{ path: '/api/workbench/content', method: 'GET', status: 503 }])
    } finally {
      writeFileSync(testInfo.outputPath('document-content-responses.json'), JSON.stringify(responses))
      writeFileSync(testInfo.outputPath('document-content-writes.json'), JSON.stringify(writes))
    }
  })
}

async function selectNativeLibraryCategory(label, dictionary = layoutZh) {
  const library = product.getByTestId('project-library-content')
  const category = library.getByRole('combobox', { name: dictionary.fileCategory, exact: true })
  const tab = library.getByRole('tab', { name: label, exact: true })
  await category.or(tab).click()
  const option = product.getByRole('option', { name: label, exact: true })
  if (await option.isVisible()) await option.click()
  await expect(library.getByRole('tabpanel', { name: label, exact: true })).toBeVisible()
}

async function openNativeOutputs(dictionary = layoutZh) {
  await product.getByTestId('project-library').click()
  await selectNativeLibraryCategory(dictionary.outputs, dictionary)
  await expect(product.getByTestId('project-outputs')).toBeVisible()
}

function nativeOutputRows() {
  return product.getByTestId('project-outputs').locator('tr[data-testid^="output-"]:not([data-testid^="output-group-"])')
}

async function expandNativeOutputs() {
  const groups = product.getByTestId('project-outputs').locator('tr[data-testid^="output-group-"] button[aria-expanded]')
  await expect(groups).toHaveCount(PREVIEW_ARTIFACTS.sampleSessions)
  for (const group of await groups.all()) if (await group.getAttribute('aria-expanded') === 'false') await group.click()
  await expect(nativeOutputRows()).toHaveCount(PREVIEW_ARTIFACTS.sampleSessions * PREVIEW_ARTIFACTS.sample.length)
}

test('native published outputs preserve filters, file and snapshot sources across reload and appearance', { annotation: previewConsumption('viewer-outputs', 'outputs-published', ['loaded', 'searched', 'filtered', 'collapsed', 'opened', 'reloaded']) }, async ({}, testInfo) => {
  await normalUi(testInfo, async () => {
    await scenario('viewer-outputs', 'outputs-published')
    await controls.getByRole('button', { name: zh.close, exact: true }).click()
    await openNativeOutputs()
    await expandNativeOutputs()
    const outputs = product.getByTestId('project-outputs')
    const identities = await nativeOutputRows().evaluateAll(rows => rows.map(row => row.getAttribute('data-testid')).sort())
    const sessionIds = await outputs.locator('tr[data-testid^="output-group-"]').evaluateAll(rows => rows.map(row => row.getAttribute('data-testid').slice('output-group-'.length)))
    const historyIds = []
    for (const sessionId of sessionIds) {
      const url = new URL('/api/serve/history/' + encodeURIComponent(sessionId), manifest.origin)
      url.searchParams.set('previewInstance', manifest.instance)
      const response = await product.request.get(url.href)
      expect(response.status()).toBe(200)
      const history = await response.json()
      expect(history.artifacts.map(({ path, role }) => ({ path, role })).sort((left, right) => left.path.localeCompare(right.path))).toEqual([...PREVIEW_ARTIFACTS.sample].sort((left, right) => left.path.localeCompare(right.path)))
      historyIds.push(...history.artifacts.map(artifact => 'output-' + artifact.artifact_id))
    }
    expect(historyIds.sort()).toEqual(identities)
    await outputs.getByRole('button', { name: layoutZh.fileName, exact: true }).click()
    await expect(outputs.getByRole('columnheader').first()).toHaveAttribute('aria-sort', 'ascending')
    await outputs.getByRole('button', { name: layoutZh.fileName, exact: true }).click()
    await expect(outputs.getByRole('columnheader').first()).toHaveAttribute('aria-sort', 'descending')
    const filter = async (label, choice) => {
      await outputs.getByRole('button', { name: label, exact: true }).click()
      await product.getByRole('menuitemradio', { name: choice, exact: true }).click()
    }
    for (const stage of [{ label: layoutZh.final, roles: ['final'] }, { label: layoutZh.intermediate, roles: ['intermediate', 'supporting'] }]) {
      await filter(layoutZh.outputStage, stage.label)
      await expect(nativeOutputRows()).toHaveCount(PREVIEW_ARTIFACTS.sampleSessions * PREVIEW_ARTIFACTS.sample.filter(file => stage.roles.includes(file.role)).length)
      for (const file of PREVIEW_ARTIFACTS.sample) await expect(outputs.getByRole('button', { name: file.path, exact: true })).toHaveCount(stage.roles.includes(file.role) ? PREVIEW_ARTIFACTS.sampleSessions : 0)
    }
    await filter(layoutZh.outputStage, layoutZh.all)
    await filter(layoutZh.fileType, 'PDF')
    await expect(nativeOutputRows()).toHaveCount(PREVIEW_ARTIFACTS.sampleSessions)
    await expect(outputs.getByRole('button', { name: 'sample.pdf', exact: true })).toHaveCount(PREVIEW_ARTIFACTS.sampleSessions)
    await filter(layoutZh.fileType, layoutZh.all)
    const groups = outputs.locator('tr[data-testid^="output-group-"] button[aria-expanded]')
    const title = await groups.first().getAttribute('aria-label')
    expect(title).toBeTruthy()
    const search = async value => {
      const input = product.getByRole('searchbox', { name: layoutZh.searchTaskFiles, exact: true })
      if (!await input.isVisible())
        await product.getByTestId('project-library-content').getByRole('button', { name: layoutZh.searchTaskFiles, exact: true }).click()
      await expect(input).toBeFocused()
      await input.fill(value)
    }
    await search(title)
    await expect(nativeOutputRows()).toHaveCount(PREVIEW_ARTIFACTS.sample.length)
    await search('')
    await groups.first().press('Enter')
    await expect(groups.first()).toHaveAttribute('aria-expanded', 'false')
    await expect(nativeOutputRows()).toHaveCount(PREVIEW_ARTIFACTS.sample.length)
    await groups.first().press('Enter')
    await expect(groups.first()).toHaveAttribute('aria-expanded', 'true')
    await search('preview-no-matching-publication')
    await expect(nativeOutputRows()).toHaveCount(0)
    await expect(outputs.getByText(layoutZh.noMatchingOutputs, { exact: true })).toBeVisible()
    await search('readme')
    await expect(nativeOutputRows()).toHaveCount(PREVIEW_ARTIFACTS.sampleSessions)
    const current = product.waitForResponse(response => /\/api\/serve\/sessions\/[^/]+\/files\/raw$/.test(new URL(response.url()).pathname) && response.request().method() === 'GET')
    await outputs.getByRole('button', { name: 'readme.md', exact: true }).first().click()
    expect((await current).status()).toBe(200)
    await expectLoadedDocument('markdown')
    for (const [name, viewer] of [['readme.md', 'markdown'], ['sample.pdf', 'pdf']]) {
      await openNativeOutputs()
      await search('')
      await expandNativeOutputs()
      const row = nativeOutputRows().filter({ has: product.getByRole('button', { name, exact: true }) }).first()
      await row.getByTestId(/^output-actions-/).click()
      const snapshot = product.waitForResponse(response => /\/api\/serve\/sessions\/[^/]+\/artifacts\/[^/]+\/raw$/.test(new URL(response.url()).pathname) && response.request().method() === 'GET')
      await product.getByRole('menuitem', { name: assistantZh.artifactEntry.open, exact: true }).click()
      expect((await snapshot).status()).toBe(200)
      await expectLoadedDocument(viewer)
      await product.screenshot({ path: testInfo.outputPath('outputs-snapshot-' + viewer + '.png') })
    }
    await product.reload()
    await openNativeOutputs()
    await expandNativeOutputs()
    expect(await nativeOutputRows().evaluateAll(rows => rows.map(row => row.getAttribute('data-testid')).sort())).toEqual(identities)
    expect(new URL(product.url()).searchParams.get('previewInstance')).toBe(manifest.instance)
    await workspaceShortcut('F8')
    await expect.poll(async () => (await nativeEvidenceSurfaces()).find(surface => surface.role === 'controls')?.viewVisible).toBe(true)
    for (const [label, option] of [[zh.theme, zh.dark], [zh.language, zh.english]]) {
      await controls.getByRole('combobox', { name: label, exact: true }).click()
      await Promise.all([
        product.waitForEvent('framenavigated', frame => frame === product.mainFrame()),
        controls.getByRole('option', { name: option, exact: true }).click(),
      ])
    }
    await controls.getByRole('button', { name: en.close, exact: true }).click()
    const window = await app.browserWindow(product)
    await window.evaluate((window, size) => window.setSize(size.width, size.height), WORKSPACE_WINDOW_MINIMUM)
    await expect.poll(() => window.evaluate(window => window.getSize())).toEqual([WORKSPACE_WINDOW_MINIMUM.width, WORKSPACE_WINDOW_MINIMUM.height])
    await expect(product.locator('html')).toHaveAttribute('data-theme', 'dark')
    await openNativeOutputs(layoutEn)
    await expandNativeOutputs()
    await expect(outputs.getByRole('button', { name: layoutEn.outputStage, exact: true })).toBeVisible()
    expect(await nativeOutputRows().evaluateAll(rows => rows.map(row => row.getAttribute('data-testid')).sort())).toEqual(identities)
    await product.screenshot({ path: testInfo.outputPath('outputs-dark-english-minimum.png') })
  })
})

async function outputUi(testInfo, sceneId, action) {
  const observations = { failures: [], recoveries: [] }
  const expected = []
  for (const page of [product, controls]) page.on('response', response => {
    const url = new URL(response.url())
    if (url.pathname === PREVIEW_ARTIFACTS.recoveryPath) observations.recoveries.push(response.status())
    if (response.status() < 400 || !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/__preview/')) return
    const failure = { path: url.pathname, method: response.request().method(), status: response.status() }
    observations.failures.push(failure)
    const declared = sceneId === 'outputs-catalog-failed'
      ? url.pathname === OUTPUT_READS.catalog || url.pathname === '/api/serve/sessions' && url.searchParams.get('scope') === 'project' && Boolean(url.searchParams.get('project_path'))
      : sceneId === 'outputs-history-failed'
        ? OUTPUT_READS.files.test(url.pathname) || url.pathname.startsWith('/api/serve/history/')
        : sceneId === 'outputs-content-failed' && (OUTPUT_READS.raw.test(url.pathname) || OUTPUT_READS.snapshot.test(url.pathname))
    if (declared && failure.method === 'GET' && failure.status === 503) expected.push(failure)
  })
  try {
    await normalUi(testInfo, async () => {
      await scenario('viewer-outputs', sceneId)
      await controls.getByRole('button', { name: zh.close, exact: true }).click()
      await action(observations)
      expect(observations.recoveries).toEqual(sceneId.endsWith('-failed') ? [200] : [])
    }, expected)
  } finally {
    writeFileSync(testInfo.outputPath('outputs-observations.json'), JSON.stringify(observations, null, 2))
  }
}

async function recoverNativeOutputs() {
  await workspaceShortcut('F8')
  await expect.poll(async () => (await nativeEvidenceSurfaces()).find(surface => surface.role === 'controls')?.viewVisible).toBe(true)
  const recovering = controls.waitForResponse(response => new URL(response.url()).pathname === PREVIEW_ARTIFACTS.recoveryPath && response.request().method() === 'POST')
  await controls.getByTestId('preview-artifacts-recover').click()
  expect((await recovering).status()).toBe(200)
  expect(new URL(product.url()).searchParams.get('previewInstance')).toBe(manifest.instance)
  await controls.getByRole('button', { name: zh.close, exact: true }).click()
}

for (const sceneId of ['outputs-pending', 'outputs-history-pending']) {
  test('native output catalogue wait: ' + sceneId, { annotation: previewConsumption('viewer-outputs', sceneId, ['loading', 'loaded']) }, async ({}, testInfo) => {
    await outputUi(testInfo, sceneId, async () => {
      const matches = request => request.method() === 'GET' && new URL(request.url()).pathname === OUTPUT_READS.catalog && Boolean(new URL(request.url()).searchParams.get('project_path'))
      let settled = false
      const started = product.waitForRequest(matches)
      const reading = product.waitForResponse(response => matches(response.request())).then(response => { settled = true; return response })
      await openNativeOutputs()
      await started
      const loading = product.getByTestId('project-outputs').getByRole('status').filter({ hasText: uiZh.loadingFallback })
      await expect(loading).toBeVisible()
      await expect(loading).toHaveText(uiZh.loadingFallback)
      expect(settled).toBe(false)
      await product.screenshot({ path: testInfo.outputPath(sceneId + '.png') })
      const response = await reading
      expect(response.status()).toBe(200)
      const page = await response.json()
      expect(page.entries).toHaveLength(PREVIEW_ARTIFACTS.sampleSessions)
      expect(page.entries.every(entry => entry.files?.has_files)).toBe(true)
      await expandNativeOutputs()
      await expect(loading).not.toBeVisible()
    })
  })
}

for (const kind of ['catalog', 'history']) {
  const sceneId = 'outputs-' + kind + '-failed'
  test('native output catalogue recovery: ' + sceneId, { annotation: previewConsumption('viewer-outputs', sceneId, ['error', 'retry-failed', 'recovered']) }, async ({}, testInfo) => {
    await outputUi(testInfo, sceneId, async observations => {
      await openNativeOutputs()
      const retry = product.getByTestId('project-outputs').getByRole('button', { name: kind === 'catalog' ? layoutZh.readFailed : layoutZh.outputSearchIncomplete, exact: true })
      await expect(retry).toBeVisible()
      await expect(nativeOutputRows()).toHaveCount(0)
      const matches = path => kind === 'catalog' ? path === OUTPUT_READS.catalog : OUTPUT_READS.files.test(path)
      const failed = product.waitForResponse(response => response.status() === 503 && response.request().method() === 'GET' && matches(new URL(response.url()).pathname))
      await retry.click()
      await failed
      await expect(retry).toBeVisible()
      await product.screenshot({ path: testInfo.outputPath(sceneId + '.png') })
      await recoverNativeOutputs()
      await expect(retry).toBeVisible()
      await retry.click()
      await expandNativeOutputs()
      expect(observations.failures.filter(failure => matches(failure.path)).length).toBeGreaterThanOrEqual(2)
    })
  })
}

for (const mode of ['pending', 'failed']) {
  const sceneId = 'outputs-content-' + mode
  test('native output file content lifecycle: ' + sceneId, { annotation: previewConsumption('viewer-outputs', sceneId, mode === 'pending' ? ['request-pending', 'opened'] : ['loaded', 'error', 'retry-failed', 'recovered', 'opened']) }, async ({}, testInfo) => {
    await outputUi(testInfo, sceneId, async observations => {
      await openNativeOutputs()
      await expandNativeOutputs()
      const matches = request => request.method() === 'GET' && OUTPUT_READS.raw.test(new URL(request.url()).pathname)
      let settled = false
      const releaseRead = mode === 'pending' ? await holdNativeRead(url => OUTPUT_READS.raw.test(url.pathname)) : null
      const started = product.waitForRequest(matches)
      let reading = product.waitForResponse(response => matches(response.request())).then(response => { settled = true; return response })
      try {
        await product.getByTestId('project-outputs').getByRole('button', { name: 'readme.md', exact: true }).first().click()
        await started
        if (mode === 'pending') {
          expect(settled).toBe(false)
          await expect(product.getByRole('tab', { name: 'readme.md', exact: false })).toHaveAttribute('aria-selected', 'true')
          await expect(product.getByText(workbenchZh.dock.loading.replace('{{title}}', 'readme.md'), { exact: true })).toBeVisible()
          await expect(product.getByTestId('markdown-preview')).toHaveCount(0)
          await product.screenshot({ path: testInfo.outputPath(sceneId + '.png') })
        }
      } finally {
        if (releaseRead) await releaseRead()
      }
      if (mode === 'failed') {
        expect((await reading).status()).toBe(503)
        const error = product.getByTestId('document-load-error')
        const retry = product.getByTestId('document-load-retry')
        await expect(error).toContainText(PREVIEW_ARTIFACTS.readFailed)
        await expect(retry).toBeEnabled()
        reading = product.waitForResponse(response => matches(response.request()))
        await retry.click()
        expect((await reading).status()).toBe(503)
        await expect(error).toBeVisible()
        await expect(retry).toBeEnabled()
        await product.screenshot({ path: testInfo.outputPath(sceneId + '.png') })
        await recoverNativeOutputs()
        reading = product.waitForResponse(response => matches(response.request()))
        await retry.click()
      }
      expect((await reading).status()).toBe(200)
      await expectLoadedDocument('markdown')
      await expect(product.getByText(workbenchZh.dock.loading.replace('{{title}}', 'readme.md'), { exact: true })).toHaveCount(0)
      expect(observations.failures.filter(failure => OUTPUT_READS.raw.test(failure.path))).toHaveLength(mode === 'failed' ? 2 : 0)
      await product.screenshot({ path: testInfo.outputPath(sceneId + '-opened.png') })
    })
  })
}

test('native delivery cancellation and later publication preserve the same session history after reentry', { annotation: previewConsumption('viewer-outputs', 'outputs-delivery', ['empty', 'submitting', 'published', 'reentered']) }, async ({}, testInfo) => {
  await normalUi(testInfo, async () => {
    await scenario('viewer-outputs', 'outputs-delivery')
    const history = async session => {
      const url = new URL('/api/serve/history/' + encodeURIComponent(session), product.url())
      url.searchParams.set('previewInstance', new URL(product.url()).searchParams.get('previewInstance'))
      const response = await product.request.get(url.href)
      expect(response.status()).toBe(200)
      return response.json()
    }
    const submit = async text => {
      await product.getByTestId('composer-input').fill(text)
      const [response] = await Promise.all([
        product.waitForResponse(response => /\/api\/serve\/sessions\/[^/]+\/turns$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST'),
        product.getByTestId('composer-send').click(),
      ])
      expect(response.status()).toBe(200)
      expect(await response.json()).toMatchObject({ accepted: true })
      return decodeURIComponent(new URL(response.url()).pathname.split('/').at(-2))
    }
    const expand = async () => {
      const conversation = product.getByTestId('workspace-conversation')
      if (await conversation.getAttribute('data-content-collapsed') === 'true') {
        const action = product.getByTestId('workspace-expand-messages')
        await expect(action).toHaveAttribute('aria-expanded', 'false')
        await action.click()
        await expect(action).toHaveAttribute('aria-expanded', 'true')
      }
      await expect(conversation).toHaveAttribute('data-content-collapsed', 'false')
    }
    const showOutputs = async () => {
      await product.getByTestId('project-library').click()
      await selectNativeLibraryCategory(layoutZh.outputs)
    }
    await showOutputs()
    const outputs = product.getByTestId('project-outputs')
    await expect(outputs.getByText(layoutZh.emptyOutputs, { exact: true })).toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('delivery-empty.png') })
    const session = await submit('取消本次模拟文件交付')
    const stop = product.getByTestId('composer-stop')
    await expect(stop).toBeEnabled()
    await product.screenshot({ path: testInfo.outputPath('delivery-submitting.png') })
    await stop.click()
    await expect(stop).not.toBeVisible()
    expect((await history(session)).artifacts).toEqual([])
    expect(await submit('完成当前模拟文件交付')).toBe(session)
    await expect(stop).toBeVisible()
    await expect(stop).not.toBeVisible({ timeout: DELIVERY_TIMEOUT_MS })
    const completed = await history(session)
    expect(completed.artifacts).toHaveLength(PREVIEW_ARTIFACTS.sample.length)
    expect(completed.activity_events.filter(event => event.type === 'artifact_changed').map(event => event.data.artifact)).toEqual(completed.artifacts)
    const final = completed.artifacts.find(artifact => artifact.role === 'final')
    await expand()
    await expect(product.getByTestId('turn-artifact-' + final.artifact_id)).toBeVisible()
    await showOutputs()
    for (const artifact of completed.artifacts) await expect(outputs.getByTestId('output-' + artifact.artifact_id)).toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('delivery-published.png') })
    await product.reload()
    await expect(product.getByTestId('composer-input')).toBeVisible()
    expect((await history(session)).artifacts).toEqual(completed.artifacts)
    await expand()
    await expect(product.getByTestId('turn-artifact-' + final.artifact_id)).toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('delivery-reentered.png') })
  })
})

for (const sceneId of ['settings-files-states', 'settings-files-save-pending', 'settings-files-save-failed']) {
  const pending = sceneId === 'settings-files-save-pending'
  const failed = sceneId === 'settings-files-save-failed'
  test('native file version settings lifecycle: ' + sceneId, { annotation: previewConsumption('settings-files', sceneId, pending ? ['editing', 'saving', 'saved'] : failed ? ['editing', 'error', 'retried', 'saved'] : ['loaded', 'invalid', 'editing', 'saved', 'reloaded']) }, async ({}, testInfo) => {
    const path = '/api/serve/settings/file-versions'
    let writes = 0
    product.on('request', request => { if (new URL(request.url()).pathname === path && request.method() === 'POST') writes += 1 })
    await normalUi(testInfo, async () => {
      const [reading] = await Promise.all([
        product.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'GET'),
        scenario('settings-files', sceneId),
      ])
      expect(reading.status()).toBe(200)
      const settings = await reading.json()
      const limit = product.getByTestId('file-version-limit')
      const size = product.getByTestId('file-version-max-size')
      await expect(product.getByTestId('account-settings-files')).toBeVisible()
      await expect(limit).toHaveValue(String(settings.max_versions_per_file))
      await expect(limit).toBeEnabled()
      const writing = () => product.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST')
      if (!pending && !failed) {
        await limit.fill('0')
        await limit.press('Enter')
        await expect(product.getByTestId('account-settings-files')).toBeVisible()
        await expect(product.getByTestId('account-settings-notifications')).not.toBeVisible()
        await expect(limit).toHaveAttribute('aria-invalid', 'true')
        await expect(product.getByText('每个文件可保留 1–1000 个版本', { exact: true })).toBeVisible()
        expect(writes).toBe(0)
      }
      const next = String(settings.max_versions_per_file + 1)
      await limit.fill(next)
      const saved = writing()
      await limit.press('Enter')
      if (pending) {
        await expect(limit).toBeDisabled()
        await expect(size).toBeDisabled()
        await product.screenshot({ path: testInfo.outputPath('configuration-saving.png') })
      }
      expect((await saved).status()).toBe(failed ? 503 : 200)
      if (failed) {
        await expect(product.getByText('文件版本设置请求失败', { exact: true })).toBeVisible()
        await expect(limit).toHaveValue(next)
        await expect(limit).toBeEnabled()
        expect(writes).toBe(1)
        await product.screenshot({ path: testInfo.outputPath('configuration-failed.png') })
        const [retried] = await Promise.all([writing(), product.getByRole('button', { name: '重试', exact: true }).click()])
        expect(retried.status()).toBe(200)
      }
      await expect(product.getByText('文件版本设置已保存', { exact: true })).toBeVisible()
      await expect(limit).toHaveValue(next)
      await expect(limit).toBeEnabled()
      if (!pending && !failed) {
        await size.fill('0')
        await size.press('Enter')
        await expect(size).toHaveAttribute('aria-invalid', 'true')
        await expect(product.getByText('最大文件大小需为 1–2048 MB', { exact: true })).toBeVisible()
        expect(writes).toBe(1)
        const nextSize = String(Math.floor(settings.max_file_size_kb / 1024) + 1)
        await size.fill(nextSize)
        const [resized] = await Promise.all([writing(), size.press('Enter')])
        expect(resized.status()).toBe(200)
        await expect(size).toBeEnabled()
        const autoSave = product.getByTestId('file-version-auto-save')
        const format = product.getByTestId('file-version-format-on-save')
        const expectedAutoSave = !(await autoSave.isChecked())
        const expectedFormat = !(await format.isChecked())
        await saveNativePreferences(value => value.autoSave === expectedAutoSave, () => autoSave.click())
        await saveNativePreferences(value => value.formatOnSave === expectedFormat, () => format.click())
        await product.reload()
        await expect(size).toHaveValue(nextSize)
        await expect(autoSave).toBeChecked({ checked: expectedAutoSave })
        await expect(format).toBeChecked({ checked: expectedFormat })
      } else if (failed) await product.reload()
      await expect(limit).toHaveValue(next)
      await expect(limit).toBeEnabled()
      expect(writes).toBe(pending ? 1 : 2)
      writeFileSync(testInfo.outputPath('configuration-writes.json'), JSON.stringify({ writes }))
      await product.screenshot({ path: testInfo.outputPath('configuration-result.png') })
    }, failed ? [{ path, method: 'POST', status: 503 }] : [])
  })
}

for (const sceneId of ['settings-models-states', 'settings-models-empty', 'settings-models-pending', 'settings-models-failed']) {
  const pending = sceneId === 'settings-models-pending'
  const failed = sceneId === 'settings-models-failed'
  const empty = sceneId === 'settings-models-empty'
  test('native model profiles read-only lifecycle: ' + sceneId, { annotation: previewConsumption('settings-models', sceneId, failed ? ['error', 'retry-failed'] : pending ? ['loading', 'loaded'] : empty ? ['empty'] : ['loaded', 'filtered', 'details']) }, async ({}, testInfo) => {
    const path = '/api/serve/model-profiles'
    const requests = []
    product.on('request', request => { if (new URL(request.url()).pathname.startsWith(path)) requests.push({ path: new URL(request.url()).pathname, method: request.method() }) })
    try {
      await normalUi(testInfo, async () => {
        const reading = product.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'GET')
        await scenario('settings-models', sceneId)
        const settings = product.getByTestId('account-settings-models')
        await expect(settings).toBeVisible()
        await expect(product.getByRole('tab', { name: '模型服务', exact: true })).toHaveAttribute('aria-selected', 'true')
        if (pending) {
          const loading = settings.getByText('正在读取…', { exact: true })
          await expect(loading).toBeVisible()
          await expect(product.getByTestId('model-connection-add')).toBeDisabled()
          await product.screenshot({ path: testInfo.outputPath('models-loading.png') })
        }
        const response = await reading
        expect(response.status()).toBe(failed ? 503 : 200)
        if (failed) {
          await expect(settings.getByRole('alert')).toContainText('模型服务加载失败，请重试。')
          await expect(product.getByTestId('model-connection-add')).toBeDisabled()
          const [retried] = await Promise.all([
            product.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'GET'),
            product.getByTestId('model-endpoint-retry').click(),
          ])
          expect(retried.status()).toBe(503)
          await expect(settings.getByRole('alert')).toContainText('模型服务加载失败，请重试。')
          await expect(product.getByTestId('model-endpoint-form')).toHaveCount(0)
        } else {
          const payload = await response.json()
          if (empty) {
            expect(payload.profiles).toEqual([])
            await expect(settings.locator('[data-testid^="model-connection-pick-"]')).toHaveCount(0)
            await expect(settings.getByText('未添加', { exact: true }).first()).toBeVisible()
            await expect(product.getByTestId('model-endpoint-form')).toHaveCount(0)
          } else {
            expect(payload.profiles).toHaveLength(1)
            const profile = payload.profiles[0]
            expect(profile.enabled).toBe(false)
            expect(profile.has_api_key).toBe(false)
            expect(profile).not.toHaveProperty('api_key')
            expect(profile.authentication).not.toBe('oauth')
            expect(new URL(profile.base_url).hostname).toBe('example.invalid')
            expect(profile.selected_models.length).toBeGreaterThan(0)
            const pick = product.getByTestId('model-connection-pick-' + profile.id)
            await expect(pick).toContainText(profile.name)
            await expect(pick).toContainText('未设密钥')
            await expect(product.getByTestId('model-connection-enabled-' + profile.id)).not.toBeChecked()
            if (!pending) {
              const search = product.getByTestId('model-connection-search')
              await search.fill('no-reviewed-model-connection-matches')
              await expect(settings.getByText('没有匹配的连接。', { exact: true })).toBeVisible()
              await expect(pick).toHaveCount(0)
              await search.fill(new URL(profile.base_url).hostname)
              await expect(pick).toBeVisible()
              await expect(settings.locator('[data-testid^="model-connection-pick-"]')).toHaveCount(1)
              await pick.click()
              await expect(product.getByTestId('model-endpoint-form')).toBeVisible()
              await expect(product.getByTestId('model-endpoint-name')).toHaveValue(profile.preview_name)
              await expect(product.getByTestId('model-endpoint-base-url')).toHaveValue(profile.base_url)
              await expect(product.getByTestId('model-endpoint-api-key')).toHaveValue('')
              for (const model of profile.selected_models) await expect(product.getByTestId('model-endpoint-model-' + model.id)).toBeChecked()
              const searchModels = product.getByTestId('model-endpoint-model-search')
              await searchModels.fill(profile.selected_models[0].id)
              await expect(product.getByTestId('model-endpoint-model-' + profile.selected_models[0].id)).toBeChecked()
              await searchModels.scrollIntoViewIfNeeded()
              await product.screenshot({ path: testInfo.outputPath('models-details.png') })
              await product.reload()
              await expect(pick).toBeVisible()
              await expect(product.getByTestId('model-endpoint-base-url')).toHaveValue(profile.base_url)
              await expect(product.getByTestId('model-endpoint-api-key')).toHaveValue('')
            }
          }
          await expect(product.getByTestId('model-connection-add')).toBeEnabled()
        }
        await product.screenshot({ path: testInfo.outputPath('models-result.png') })
      }, failed ? [{ path, method: 'GET', status: 503 }] : [])
    } finally {
      writeFileSync(testInfo.outputPath('models-requests.json'), JSON.stringify(requests, null, 2))
      expect(requests.filter(request => request.method !== 'GET')).toEqual([])
    }
  })
}

for (const account of [
  { scene: 'settings-account-states', mode: 'no-base', states: ['error'] },
  { scene: 'settings-account-ready', mode: 'ready', states: ['loaded'] },
  { scene: 'settings-account-pending', mode: 'delayed', states: ['loading', 'loaded'] },
  { scene: 'settings-account-failed', mode: 'failed', states: ['error', 'retry-failed'] },
  { scene: 'settings-account-anonymous', mode: 'anonymous', states: ['loaded', 'unauthorized'] },
]) {
  test('native account client lifecycle: ' + account.scene, { annotation: [previewConsumption('settings-account', account.scene, account.states), ...(account.mode === 'no-base' ? [previewConsumption('surface-login', 'surface-login-states', ['closed', 'open'])] : [])] }, async ({}, testInfo) => {
    const profilePath = '/api/account/me'
    const profiles = []
    const profileRequests = new WeakSet()
    product.on('request', request => {
      if (new URL(product.url()).searchParams.get('scene') === account.scene && new URL(request.url()).pathname === profilePath) profileRequests.add(request)
    })
    product.on('response', response => {
      if (profileRequests.has(response.request())) profiles.push(response.status())
    })
    await normalUi(testInfo, async () => {
      await scenario('settings-account', account.scene)
      const content = product.getByTestId('account-settings-account')
      await expect(content).toBeVisible()
      const unconfirmed = async () => {
        await expect(content).not.toContainText('已登录')
        for (const action of ['account-edit-nickname', 'account-change-phone-open', 'account-reset-password-open', 'account-switch', 'account-logout', 'account-nickname-save']) await expect(product.getByTestId(action)).toHaveCount(0)
      }
      if (account.mode === 'delayed') {
        await expect(content.getByRole('status')).toHaveText('正在确认账号状态…')
        await unconfirmed()
        await product.screenshot({ path: testInfo.outputPath('account-loading.png') })
      }
      if (account.mode === 'ready' || account.mode === 'delayed') {
        await expect(product.getByTestId('account-edit-nickname')).toHaveText('模拟协作账号（非真实用户）')
        await expect(product.getByTestId('account-reset-password-open')).toBeEnabled()
        await expect(content.getByRole('alert')).toHaveCount(0)
        expect(profiles.length).toBeGreaterThan(0)
        expect(profiles.every(status => status === 200)).toBe(true)
        await product.screenshot({ path: testInfo.outputPath('account-profile.png') })
        await product.reload()
        await expect(product.getByTestId('account-edit-nickname')).toHaveText('模拟协作账号（非真实用户）')
        expect(profiles.every(status => status === 200)).toBe(true)
      } else {
        await unconfirmed()
        if (account.mode === 'anonymous') {
          await expect(product.getByTestId('account-login-open')).toBeEnabled()
          await expect(product.getByTestId('account-profile-retry')).toHaveCount(0)
          expect(profiles).toEqual([])
        } else {
          const retry = product.getByTestId('account-profile-retry')
          const failure = account.mode === 'no-base' ? '账号服务地址未配置' : '请求失败（503）'
          await expect(retry).toBeEnabled()
          await expect(content.getByRole('alert')).toContainText(failure)
          const before = profiles.length
          await retry.click()
          await expect(retry).toBeEnabled()
          if (account.mode === 'failed') await expect.poll(() => profiles.length).toBeGreaterThan(before)
          else expect(profiles).toEqual([])
          await expect(content.getByRole('alert')).toContainText(failure)
          await unconfirmed()
          if (account.mode === 'no-base') {
            await scenario('surface-login', 'surface-login-states')
            expect((await nativeArchiveState()).account.mode).toBe('no-base')
            const credentialWrites = []
            product.on('request', request => {
              const path = new URL(request.url()).pathname
              if ((path.startsWith('/api/auth/') || path.startsWith('/api/account/')) && !['GET', 'HEAD'].includes(request.method())) credentialWrites.push({ path, method: request.method() })
            })
            const login = product.getByTestId('account-login')
            for (const dismiss of ['escape', 'button']) {
              await product.getByTestId('activity-account').click()
              const authStatus = product.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/status' && response.request().method() === 'GET')
              await product.getByTestId('account-menu-anonymous-login').click()
              const response = await authStatus
              expect(response.status()).toBe(200)
              expect(await response.json()).toMatchObject({ enabled: false, account_base_url: '' })
              await expect(login).toBeVisible()
              await expect(login.getByRole('heading', { name: accountZh.accountLogin.notRequired, exact: true })).toBeVisible()
              await expect(login).toContainText(accountZh.accountLogin.disabled)
              await product.screenshot({ path: testInfo.outputPath('account-unconfigured-' + dismiss + '.png'), animations: 'disabled' })
              if (dismiss === 'escape') await product.keyboard.press('Escape')
              else await product.getByTestId('account-login-close').click()
              await expect(login).not.toBeVisible()
              await expect(product.getByTestId('project-center')).toBeVisible()
            }
            expect(credentialWrites).toEqual([])
          }
        }
      }
      if (account.mode === 'failed') {
        expect(profiles.length).toBeGreaterThan(0)
        expect(profiles.every(status => status === 503)).toBe(true)
      }
      writeFileSync(testInfo.outputPath('account-profile-responses.json'), JSON.stringify(profiles))
      await product.screenshot({ path: testInfo.outputPath('account-result.png') })
    }, account.mode === 'failed' ? [{ path: profilePath, method: 'GET', status: 503 }] : [])
  })
}

async function openNativeSettings(id, surface) {
  const entry = PREVIEW_CATALOG.find(candidate => candidate.id === id)
  await scenario(id, entry.scenarios[0].id)
  await expect(product.getByTestId(surface ?? 'account-settings-' + entry.entry)).toBeVisible()
}

async function saveNativePreferences(matches, action) {
  const [response] = await Promise.all([
    product.waitForResponse(response => new URL(response.url()).pathname === '/__preview/state' && response.request().method() === 'POST' && matches(response.request().postDataJSON().preferences)),
    action(),
  ])
  expect(response.status()).toBe(200)
  expect(matches((await response.json()).preferences)).toBe(true)
}

const SHORTCUT_ID = 'markdown.bold'
const SHORTCUT_SELECTOR = '[data-shortcut-id="' + SHORTCUT_ID + '"]'

test('native preferences page uses real controls and persists appearance, auto-save and language after reload', { annotation: previewConsumption('settings-preferences', 'settings-preferences-states', ['loaded', 'editing']) }, async ({}, testInfo) => {
  await normalUi(testInfo, async () => {
    await openNativeSettings('settings-preferences')
    const preferences = product.getByTestId('account-settings-preferences')
    await preferences.getByRole('combobox', { name: '外观', exact: true }).click()
    await saveNativePreferences(value => value.theme === 'dark', async () => { await product.getByRole('option', { name: '深色', exact: true }).click() })
    await expect(product.locator('html')).toHaveAttribute('data-theme', 'dark')
    const autoSave = preferences.getByTestId('preferences-auto-save')
    const initial = await autoSave.isChecked()
    await saveNativePreferences(value => value.autoSave === !initial, async () => { await autoSave.click() })
    await preferences.getByRole('combobox', { name: '语言', exact: true }).click()
    await saveNativePreferences(value => value.language === 'en', async () => { await product.getByRole('option', { name: 'English', exact: true }).click() })
    await product.reload()
    await expect(preferences).toBeVisible()
    await expect(product.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(preferences.getByRole('combobox', { name: 'Language', exact: true })).toContainText('English')
    await expect(preferences.getByRole('combobox', { name: 'Appearance', exact: true })).toContainText('Dark')
    await expect(autoSave).toBeChecked({ checked: !initial })
    await product.screenshot({ path: testInfo.outputPath('settings-preferences-dark-english.png'), fullPage: true })
  })
})

test('native shortcuts page filters, rejects conflicts, records a real key combination and restores its persisted default', { annotation: previewConsumption('settings-shortcuts', 'settings-shortcuts-states', ['loaded', 'editing', 'error']) }, async ({}, testInfo) => {
  await normalUi(testInfo, async () => {
    await openNativeSettings('settings-shortcuts')
    const settings = product.getByTestId('account-settings-shortcuts')
    const row = settings.locator(SHORTCUT_SELECTOR)
    const original = await row.locator('kbd').innerText()
    const search = settings.getByTestId('shortcut-search')
    await search.fill('preview-no-matching-shortcut')
    await expect(settings.getByText('未找到快捷键', { exact: true })).toBeVisible()
    await search.fill('切换粗体')
    await expect(settings.locator('[data-shortcut-id]')).toHaveCount(1)
    await row.getByTestId(`shortcut-edit-${SHORTCUT_ID}`).click()
    const dialog = product.getByTestId('shortcut-editor-dialog')
    const recorder = dialog.getByTestId('shortcut-recorder')
    await recorder.press('ControlOrMeta+s')
    await expect(dialog.getByRole('alert')).toContainText('冲突')
    await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
    await product.screenshot({ path: testInfo.outputPath('settings-shortcuts-conflict.png'), fullPage: true })
    await recorder.press('ControlOrMeta+Alt+Shift+y')
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    const changed = await recorder.innerText()
    expect(changed).not.toBe(original)
    await saveNativePreferences(value => Boolean(value.shortcutOverrides[SHORTCUT_ID]), async () => { await dialog.getByRole('button', { name: '保存', exact: true }).click() })
    await expect(dialog).not.toBeVisible()
    await expect(row.locator('kbd')).toHaveText(changed)
    await product.reload()
    await expect(settings).toBeVisible()
    await expect(row.locator('kbd')).toHaveText(changed)
    await product.screenshot({ path: testInfo.outputPath('settings-shortcuts-saved.png'), fullPage: true })
    await row.getByTestId(`shortcut-edit-${SHORTCUT_ID}`).click()
    await saveNativePreferences(value => !Object.prototype.hasOwnProperty.call(value.shortcutOverrides, SHORTCUT_ID), async () => { await dialog.getByRole('button', { name: '恢复默认', exact: true }).click() })
    const origin = new URL(product.url()).origin
    const scripts = []
    const onResponse = response => {
      const url = new URL(response.url())
      if (url.origin === origin && response.request().resourceType() === 'script') {
        scripts.push({ path: url.pathname, status: response.status(), statusText: response.statusText() })
      }
    }
    const onFailure = request => {
      const url = new URL(request.url())
      if (url.origin === origin && request.resourceType() === 'script') {
        scripts.push({ path: url.pathname, error: request.failure()?.errorText })
      }
    }
    product.on('response', onResponse)
    product.on('requestfailed', onFailure)
    try {
      await product.reload()
      await expect(row.locator('kbd')).toHaveText(original)
      await product.screenshot({ path: testInfo.outputPath('settings-shortcuts-restored.png'), fullPage: true })
    } finally {
      product.off('response', onResponse)
      product.off('requestfailed', onFailure)
      writeFileSync(testInfo.outputPath('settings-shortcuts-reload-scripts.json'), JSON.stringify(scripts, null, 2))
    }
  })
})

test('native selection prompts page validates empty drafts, saves through the actual form and restores the persisted default', { annotation: previewConsumption('settings-prompts', 'settings-prompts-states', ['loaded', 'editing']) }, async ({}, testInfo) => {
  const defaults = defaultSelectionPrompts('zh')
  await normalUi(testInfo, async () => {
    await openNativeSettings('settings-prompts')
    const settings = product.getByTestId('account-settings-prompts')
    const explain = settings.getByTestId('selection-prompt-explain')
    const save = settings.getByTestId('selection-prompts-save')
    await expect(explain).toHaveValue(defaults.explain)
    await expect(save).toBeDisabled()
    await explain.fill('')
    await expect(save).toBeDisabled()
    await product.screenshot({ path: testInfo.outputPath('settings-prompts-invalid.png'), fullPage: true })
    const revised = 'Reviewed preview selection instruction: explain the selected text clearly.'
    await explain.fill(revised)
    await expect(save).toBeEnabled()
    await saveNativePreferences(value => value.selectionPrompts.explain === revised, async () => { await save.click() })
    await expect(save).toBeDisabled()
    await product.reload()
    await expect(explain).toHaveValue(revised)
    await product.screenshot({ path: testInfo.outputPath('settings-prompts-saved.png'), fullPage: true })
    await settings.getByTestId('selection-prompt-restore-explain').click()
    await expect(explain).toHaveValue(defaults.explain)
    await saveNativePreferences(value => value.selectionPrompts.explain === defaults.explain, async () => { await save.click() })
    await product.reload()
    await expect(explain).toHaveValue(defaults.explain)
    await expect(save).toBeDisabled()
    await product.screenshot({ path: testInfo.outputPath('settings-prompts-restored.png'), fullPage: true })
  })
})

test('native notification settings preserve the real sound preference without invoking native notification controls', { annotation: previewConsumption('settings-notifications', 'settings-notifications-states', ['loaded', 'editing']) }, async ({}, testInfo) => {
  await normalUi(testInfo, async () => {
    await openNativeSettings('settings-notifications')
    const settings = product.getByTestId('account-settings-notifications')
    const sound = settings.getByTestId('notification-sound')
    const initial = await sound.isChecked()
    await expect(settings.getByTestId('notification-desktop')).toBeVisible()
    await expect(settings.getByTestId('notification-mark-read')).toBeVisible()
    await saveNativePreferences(value => value.soundAlerts === !initial, async () => { await sound.click() })
    await product.reload()
    await expect(settings).toBeVisible()
    await expect(sound).toBeChecked({ checked: !initial })
    await expect(settings.getByRole('alert')).toHaveCount(0)
    await product.screenshot({ path: testInfo.outputPath('settings-notifications-sound-saved.png'), fullPage: true })
    await saveNativePreferences(value => value.soundAlerts === initial, async () => { await sound.click() })
    await product.reload()
    await expect(sound).toBeChecked({ checked: initial })
    await product.screenshot({ path: testInfo.outputPath('settings-notifications-sound-restored.png'), fullPage: true })
  })
})

test('native about settings display the real preview information, persist an update preference and block external link actions', { annotation: previewConsumption('settings-about', 'settings-about-states', ['loaded', 'editing']) }, async ({}, testInfo) => {
  await normalUi(testInfo, async () => {
    await openNativeSettings('settings-about', 'about-settings-page')
    const about = product.getByTestId('about-settings-page')
    const packaged = JSON.parse(readFileSync(resolve(application, 'package.json'), 'utf8'))
    await expect(about.getByTestId('version-current')).toHaveText('当前版本：' + packaged.version)
    await expect(about.getByTestId('version-status')).toBeVisible()
    await expect(about.getByTestId('about-copyright')).toContainText('书深')
    await expect(about.getByTestId('about-guide')).toHaveCount(0)
    const automatic = about.getByTestId('update-auto-download')
    const initial = await automatic.isChecked()
    await saveNativePreferences(value => value.autoDownloadUpdates === !initial, async () => { await automatic.click() })
    await product.reload()
    await expect(about).toBeVisible()
    await expect(automatic).toBeChecked({ checked: !initial })
    await product.screenshot({ path: testInfo.outputPath('settings-about-preference-saved.png'), fullPage: true })
    const originalUrl = product.url()
    const context = product.context()
    const originalPages = context.pages().length
    const popups = []
    const externalRequests = []
    product.on('popup', popup => popups.push(popup.url()))
    product.on('request', request => {
      const url = new URL(request.url())
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== new URL(originalUrl).origin) externalRequests.push(url.origin)
    })
    const navigationEvents = []
    await product.exposeFunction('observeExternalNavigation', detail => navigationEvents.push(detail))
    await product.evaluate(eventName => window.addEventListener(eventName, event => { void window.observeExternalNavigation(event.detail) }), PREVIEW_DIAGNOSTIC_EVENT)
    for (const action of ['about-site', 'about-community', 'about-manual']) await about.getByTestId(action).click()
    const dialog = product.getByRole('dialog', { name: '设置', exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect.poll(() => navigationEvents.filter(event => event.kind === 'external-navigation-blocked').length).toBe(3)
    expect(popups).toEqual([])
    expect(externalRequests).toEqual([])
    expect(context.pages()).toHaveLength(originalPages)
    expect(product.url()).toBe(originalUrl)
    await product.screenshot({ path: testInfo.outputPath('settings-about-external-blocked.png') })
  })
})

for (const sceneId of ['surface-close-pending', 'surface-close-failed']) {
  const pending = sceneId === 'surface-close-pending'
  test('native close decision lifecycle: ' + sceneId, { annotation: [previewConsumption('surface-close', sceneId, pending ? ['open', 'pending', 'completed'] : ['open', 'failed', 'retried']), ...(pending ? [previewConsumption('surface-close', 'surface-close-states', ['closed', 'open', 'completed'])] : [])] }, async ({}, testInfo) => {
    await normalUi(testInfo, async () => {
      await scenario('surface-close', sceneId)
      const launcher = product.getByTestId('preview-close-open')
      await launcher.click()
      const dialog = product.getByTestId('window-close-dialog')
      const remember = dialog.getByRole('checkbox')
      await remember.check()
      const decision = dialog.getByRole('button', { name: pending ? '最小化到托盘' : '退出书深', exact: true })
      await decision.click()
      if (pending) {
        for (const button of await dialog.getByRole('button').all()) await expect(button).toBeDisabled()
        await expect(remember).toBeDisabled()
        await product.keyboard.press('Escape')
        await expect(dialog).toBeVisible()
      } else {
        await expect(dialog.getByRole('alert')).toBeVisible()
        await expect(remember).toBeChecked()
        await expect(decision).toBeEnabled()
      }
      await expect(product.getByTestId('preview-close-reply')).toHaveCount(0)
      await product.screenshot({ path: testInfo.outputPath('close-before-receipt.png') })
      if (!pending) await decision.click()
      await expect(dialog).not.toBeVisible()
      await expect(product.getByTestId('preview-close-reply')).toHaveText(JSON.stringify({ requestId: 1, action: pending ? WINDOW_CLOSE_ACTION.minimize : WINDOW_CLOSE_ACTION.quit, remember: true }))
      await expect(launcher).toBeFocused()
      await product.screenshot({ path: testInfo.outputPath('close-receipt.png') })
      if (pending) {
        await scenario('surface-close', 'surface-close-states')
        const host = product.getByTestId('preview-close-host')
        await expect(host).toBeVisible()
        const replies = []
        for (const [index, choice] of [
          { label: '取消', action: WINDOW_CLOSE_ACTION.cancel, remember: false },
          { label: '退出书深', action: WINDOW_CLOSE_ACTION.quit, remember: true },
          { label: '最小化到托盘', action: WINDOW_CLOSE_ACTION.minimize, remember: false },
          { label: null, action: WINDOW_CLOSE_ACTION.cancel, remember: false },
        ].entries()) {
          await launcher.click()
          await expect(dialog).toBeVisible()
          await expect(remember).not.toBeChecked()
          await expect(product.getByTestId('preview-close-reply')).toHaveCount(0)
          if (choice.remember) await remember.check()
          if (choice.label === null) await product.keyboard.press('Escape')
          else await dialog.getByRole('button', { name: choice.label, exact: true }).click()
          await expect(dialog).not.toBeVisible()
          const expected = { requestId: index + 1, action: choice.action, remember: choice.remember }
          await expect(product.getByTestId('preview-close-reply')).toHaveText(JSON.stringify(expected))
          await expect(launcher).toBeFocused()
          await expect(host).toBeVisible()
          expect(app.process().exitCode).toBeNull()
          replies.push(expected)
        }
        writeFileSync(testInfo.outputPath('close-local-replies.json'), JSON.stringify(replies, null, 2))
        await product.screenshot({ path: testInfo.outputPath('close-normal-cancelled.png'), animations: 'disabled' })
      }
    })
  })
}

for (const sceneId of ['settings-permissions-states', 'settings-permissions-pending', 'settings-permissions-failed']) {
  const failed = sceneId === 'settings-permissions-failed'
  const pending = sceneId === 'settings-permissions-pending'
  test('native simulated permission lifecycle: ' + sceneId, { annotation: previewConsumption('settings-permissions', sceneId, failed ? ['failed', 'retry-failed'] : pending ? ['loading', 'unavailable', 'query-error'] : ['loaded', 'unavailable', 'query-error']) }, async ({}, testInfo) => {
    await normalUi(testInfo, async () => {
      let failureCount = 0
      if (failed) {
        await product.exposeFunction('observePermissionDiagnostic', detail => { if (detail.kind === 'permissions-failed') failureCount += 1 })
        await product.addInitScript(eventName => {
          window.addEventListener(eventName, event => { void window.observePermissionDiagnostic(event.detail) })
        }, PREVIEW_DIAGNOSTIC_EVENT)
      }
      await scenario('settings-permissions', sceneId)
      await expect(controls.getByRole('heading', { name: zh.title, exact: true })).toBeVisible()
      const permissions = product.getByTestId('account-settings-permissions')
      await expect(permissions).toBeVisible()
      const refresh = product.getByTestId('permissions-refresh')
      if (pending) {
        await expect(refresh).toBeDisabled()
        await expect(refresh).toHaveText('正在检查…')
        await product.screenshot({ path: testInfo.outputPath('permissions-loading.png') })
      }
      await expect(refresh).toBeEnabled()
      if (failed) {
        const failure = permissions.getByRole('alert')
        await expect(failure).toContainText('无法读取系统能力状态')
        await expect.poll(() => failureCount).toBeGreaterThan(0)
        const before = failureCount
        await product.screenshot({ path: testInfo.outputPath('permissions-failed.png') })
        await refresh.click()
        await expect(refresh).toBeEnabled()
        await expect(failure).toContainText('无法读取系统能力状态')
        await expect.poll(() => failureCount).toBeGreaterThan(before)
        writeFileSync(testInfo.outputPath('permission-diagnostics.json'), JSON.stringify({ before, after: failureCount }))
        await expect(product.getByTestId('permission-screen').locator('[data-status]')).toHaveAttribute('data-status', 'query-error')
      } else {
        for (const permission of ['screen', 'accessibility', 'microphone', 'automation', 'location']) {
          const row = product.getByTestId('permission-' + permission)
          await expect(row.locator('[data-status]')).toHaveAttribute('data-status', 'unavailable')
          await expect(row).toBeDisabled()
        }
        for (const permission of ['full-disk', 'notifications']) await expect(product.getByTestId('permission-' + permission).locator('[data-status]')).toHaveAttribute('data-status', 'query-error')
        await expect(permissions.locator('[data-status="granted"]')).toHaveCount(0)
        await expect(permissions.getByRole('alert')).toHaveCount(0)
      }
      await product.screenshot({ path: testInfo.outputPath('permissions-result.png') })
    })
  })
}

test('native resource entry opens its project directory and reviewed document', { annotation: previewConsumption('page-resource', 'resource-browse', ['populated', 'opened']) }, async ({}, testInfo) => {
  await normalUi(testInfo, async () => {
    await scenario('page-resource', 'resource-browse')
    await expect(product.getByRole('navigation', { name: layoutZh.tasks, exact: true }).getByRole('button', { name: '设计协作项目', exact: true })).toBeVisible()
    await expect(product.getByTestId('preview-panel-open')).toHaveCount(0)
    await product.getByTestId('project-library').click()
    await product.getByTestId('project-library-explorer').click()
    await expect(product.getByTestId('explorer-tree')).toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('primary-resource-directory.png') })
    await product.getByTestId('explorer-select-readme.md').click()
    await product.getByTestId('markdown-mode-select').click()
    await product.getByTestId('markdown-open-preview').click()
    await expect(product.getByTestId('markdown-preview')).toBeVisible()
    await expect(product.getByTestId('markdown-preview')).toContainText('Minimal Project')
    await product.screenshot({ path: testInfo.outputPath('primary-resource-document.png') })
  })
})

async function browsingUi(testInfo, action, expectedFailures = []) {
  await normalUi(testInfo, async () => {
    const writes = []
    const preparations = []
    product.on('request', request => {
      const path = new URL(request.url()).pathname
      if (path === PREVIEW_RUNTIME_RECONFIGURATION.preparationPath && request.method() === 'POST') preparations.push(request.postDataJSON())
      else if (path.startsWith('/api/') && request.method() !== 'GET') writes.push({ method: request.method(), url: request.url() })
    })
    const snapshot = async path => {
      const url = new URL(path, manifest.origin)
      url.searchParams.set('previewInstance', manifest.instance)
      const response = await product.request.get(url.href)
      expect(response.ok()).toBe(true)
      return response.json()
    }
    const original = await snapshot('/__preview/state')
    const failedListing = expectedFailures.some(failure => failure.path === '/api/resource/list')
    const filesPath = (failedListing ? '/api/resource/tree?project=' : '/api/resource/list?project=') + PREVIEW_PROJECT_ID
    const files = await snapshot(filesPath)
    try {
      await action({ snapshot })
    } finally {
      const state = await snapshot('/__preview/state')
      writeFileSync(testInfo.outputPath('browsing-diagnostics.json'), JSON.stringify(state.diagnostics, null, 2))
    }
    const current = await snapshot('/__preview/state')
    expect(current.projects).toEqual(original.projects)
    expect(current.sessions).toEqual(original.sessions)
    expect(await snapshot(filesPath)).toEqual(files)
    expect(writes).toEqual([])
    expect(preparations.length).toBeLessThanOrEqual(1)
    for (const preparation of preparations) {
      expect(preparation.persist_default).toBe(false)
      expect(preparation.request_id).toMatch(PREVIEW_RUNTIME_RECONFIGURATION.requestPattern)
      expect(await snapshot(PREVIEW_RUNTIME_RECONFIGURATION.preparationPath + '/' + preparation.request_id)).toMatchObject({ request_id: preparation.request_id, session_id: null, state: PREVIEW_RUNTIME_RECONFIGURATION.preparationState.applied })
    }
  }, expectedFailures)
}

async function browsingOpen(source) {
  await product.getByTestId('project-library').click()
  if (source === 'explorer') await product.getByTestId('project-library-explorer').click()
  await expect(product.getByTestId(source === 'listing' ? 'material-list' : 'project-explorer')).toBeVisible()
}

function browsingResponse(source, offset = 0) {
  return product.waitForResponse(response => {
    const url = new URL(response.url())
    return response.request().method() === 'GET' && url.pathname === (source === 'listing' ? '/api/resource/list' : '/api/content/projects/' + PREVIEW_PROJECT_ID + '/tree') && (source === 'listing' || (url.searchParams.get('path') ?? '') === '' && Number(url.searchParams.get('offset') ?? 0) === offset)
  })
}

function browsingNodes() {
  return product.getByTestId('project-explorer').locator('[data-testid^="explorer-node-"]')
}

for (const sceneId of ['browsing-paged', 'browsing-empty']) {
  test('native resource browsing preserves shared nested content and genuine emptiness: ' + sceneId, { annotation: [
    { type: INITIAL_TARGET_ANNOTATION, description: JSON.stringify({ pageId: 'viewer-material-list', sceneId }) },
    previewConsumption('viewer-material-list', sceneId, sceneId === 'browsing-empty' ? ['empty'] : ['loaded', 'nested', 'filtered', 'no-match', 'opened']),
    previewConsumption('viewer-explorer', sceneId, sceneId === 'browsing-empty' ? ['empty'] : ['loaded', 'nested', 'opened', 'paginated']),
  ] }, async ({}, testInfo) => {
    await browsingUi(testInfo, async ({ snapshot }) => {
      await product.getByTestId('project-library').click()
      const listing = product.getByTestId('material-list')
      await expect(listing).toBeVisible()
      if (sceneId === 'browsing-empty') {
        await expect(listing.getByText('暂无资料', { exact: true })).toBeVisible()
        await expect(listing.getByText('没有符合条件的文件', { exact: true })).not.toBeVisible()
        await product.screenshot({ path: testInfo.outputPath('browsing-listing-empty.png') })
      } else {
        await listing.getByTestId('material-preview-docs').getByRole('button', { name: 'preview-docs', exact: true }).click()
        await listing.getByTestId('material-preview-docs/nested').getByRole('button', { name: 'nested', exact: true }).click()
        for (const sample of PREVIEW_BROWSING.seed.nested) await expect(listing.getByTestId('material-' + sample.path)).toBeVisible()
        await product.getByTestId('project-library-content').getByRole('button', { name: '搜索文件', exact: true }).click()
        const search = product.getByRole('searchbox', { name: '搜索文件', exact: true })
        await search.fill('overview.md')
        await expect(listing.getByTestId('material-' + PREVIEW_BROWSING.seed.nested[0].path)).toBeVisible()
        await search.fill('reviewed-browsing-no-match')
        await expect(listing.getByText('没有符合条件的文件', { exact: true })).toBeVisible()
        await expect(listing.getByText('暂无资料', { exact: true })).not.toBeVisible()
        await product.screenshot({ path: testInfo.outputPath('browsing-listing-no-match.png') })
        await search.fill('')
        await listing.getByTestId('material-' + PREVIEW_BROWSING.seed.nested[0].path).getByRole('button', { name: 'overview.md', exact: true }).click()
        await product.getByTestId('markdown-mode-select').click()
        await product.getByTestId('markdown-open-preview').click()
        await expect(product.getByTestId('markdown-preview')).toContainText('模拟目录概览')
        await product.getByTestId('project-library').click()
      }
      await product.getByTestId('project-library-explorer').click()
      const explorer = product.getByTestId('project-explorer')
      const nodes = explorer.locator('[data-testid^="explorer-node-"]')
      await expect(product.getByTestId('explorer-directory-loading-/')).not.toBeVisible()
      await expect(product.getByTestId('explorer-directory-error-/')).not.toBeVisible()
      if (sceneId === 'browsing-empty') {
        await expect(product.getByTestId('explorer-root').locator('[aria-expanded]')).toHaveAttribute('aria-expanded', 'true')
        await expect(nodes).toHaveCount(0)
        await product.screenshot({ path: testInfo.outputPath('browsing-explorer-empty.png') })
      } else {
        await expect(nodes).toHaveCount(PREVIEW_BROWSING.pageSize)
        await product.getByTestId('explorer-more-/').click()
        const tree = await snapshot('/api/content/projects/' + PREVIEW_PROJECT_ID + '/tree')
        await expect(nodes).toHaveCount(tree.total)
        const identities = await nodes.evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')))
        expect(new Set(identities).size).toBe(tree.total)
        await expect(product.getByTestId('explorer-more-/')).not.toBeVisible()
        await product.getByTestId('explorer-node-preview-docs').getByRole('button', { name: '展开 preview-docs', exact: true }).click()
        await expect(product.getByTestId('explorer-node-' + PREVIEW_BROWSING.seed.nested[0].path)).toBeVisible()
        await product.getByTestId('explorer-node-preview-docs/nested').getByRole('button', { name: '展开 nested', exact: true }).click()
        await product.getByTestId('explorer-select-' + PREVIEW_BROWSING.seed.nested[1].path).click()
        const preview = product.getByTestId('explorer-preview')
        await expect(preview).toContainText('模拟嵌套资料')
        const originalPreview = await preview.elementHandle()
        for (const expanded of ['false', 'true', 'false']) {
          await product.getByTestId('explorer-toggle-tree').click()
          await expect(product.getByTestId('explorer-toggle-tree')).toHaveAttribute('aria-expanded', expanded)
          await expect(preview).toBeVisible()
          expect(await preview.evaluate((node, original) => node === original, originalPreview)).toBe(true)
        }
        await originalPreview.dispose()
        await product.screenshot({ path: testInfo.outputPath('browsing-nested-preview.png') })
      }
    })
  })
}

for (const source of ['listing', 'explorer']) {
  for (const state of ['pending', 'failed']) {
    const pageId = source === 'listing' ? 'viewer-material-list' : 'viewer-explorer'
    const sceneId = 'browsing-' + source + '-' + state
    const path = source === 'listing' ? '/api/resource/list' : '/api/content/projects/' + PREVIEW_PROJECT_ID + '/tree'
    test('native resource read lifecycle: ' + source + '-' + state, { annotation: [
      { type: INITIAL_TARGET_ANNOTATION, description: JSON.stringify({ pageId, sceneId }) },
      previewConsumption(pageId, sceneId, state === 'pending' ? ['loading', 'loaded', 'reentered'] : ['error', 'retry-failed', 'independent', 'recovered']),
    ] }, async ({}, testInfo) => {
      await browsingUi(testInfo, async () => {
        const initial = state === 'pending' ? browsingResponse(source) : null
        await browsingOpen(source)
        const loaded = product.getByTestId(source === 'listing' ? 'material-readme.md' : 'explorer-node-readme.md')
        const close = product.getByRole('button', { name: source === 'listing' ? '关闭 项目文件' : '关闭 项目资源管理器', exact: true })
        if (state === 'pending') {
          const ready = await initial
          expect(ready.status()).toBe(200)
          expect(await ready.finished()).toBeNull()
          writeFileSync(testInfo.outputPath('browsing-initial-response.json'), JSON.stringify(await ready.json(), null, 2))
          await expect(loaded).toBeVisible()
          for (const phase of ['opened', 'reentered']) {
            await product.getByRole('tab').filter({ has: close }).hover()
            await close.click()
            const response = browsingResponse(source)
            await browsingOpen(source)
            const loading = source === 'listing' ? product.getByTestId('material-list').getByRole('region', { name: '资料', exact: true }).getByRole('status') : product.getByTestId('explorer-directory-loading-/')
            await expect(loading).toBeVisible()
            await expect(loaded).not.toBeVisible()
            await product.screenshot({ path: testInfo.outputPath('browsing-' + source + '-' + phase + '-loading.png') })
            const completed = await response
            expect(completed.status()).toBe(200)
            expect(await completed.finished()).toBeNull()
            await expect(loading).not.toBeVisible()
            await expect(loaded).toBeVisible()
          }
        } else {
          const retry = source === 'listing' ? product.getByTestId('material-list').getByRole('button', { name: '读取失败，点击重试', exact: true }) : product.getByTestId('explorer-directory-retry-/')
          await expect(retry).toBeVisible()
          const failed = browsingResponse(source)
          await retry.click()
          expect((await failed).status()).toBe(503)
          await expect(retry).toBeVisible()
          await expect(product.getByTestId('material-list').getByText('暂无资料', { exact: true })).not.toBeVisible()
          await browsingOpen(source === 'listing' ? 'explorer' : 'listing')
          await expect(product.getByTestId(source === 'listing' ? 'explorer-node-readme.md' : 'material-readme.md')).toBeVisible()
          await browsingOpen(source)
          await expect(retry).toBeVisible()
          await product.screenshot({ path: testInfo.outputPath('browsing-' + source + '-failed.png') })
          await controls.getByTestId('preview-browsing-recover').click()
          const recovered = browsingResponse(source)
          await retry.click()
          expect((await recovered).status()).toBe(200)
          await expect(retry).not.toBeVisible()
          await expect(loaded).toBeVisible()
        }
        await product.screenshot({ path: testInfo.outputPath('browsing-' + source + '-loaded.png') })
      }, state === 'failed' ? [{ path, method: 'GET', status: 503 }] : [])
    })
  }
}

test('native resource pagination failure preserves its first page and supports dark English keyboard retry', { annotation: [
  { type: INITIAL_TARGET_ANNOTATION, description: JSON.stringify({ pageId: 'viewer-explorer', sceneId: 'browsing-more-failed' }) },
  previewConsumption('viewer-explorer', 'browsing-more-failed', ['loaded', 'error', 'retained', 'retried', 'paginated']),
] }, async ({}, testInfo) => {
  await useDarkEnglishAppearance()
  await controls.getByRole('button', { name: en.close, exact: true }).click()
  const window = await app.browserWindow(product)
  await window.evaluate((window, minimum) => window.setSize(minimum.width, minimum.height), WORKSPACE_WINDOW_MINIMUM)
  await expect.poll(() => product.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(WORKSPACE_WINDOW_MINIMUM)
  await browsingUi(testInfo, async ({ snapshot }) => {
    await browsingOpen('explorer')
    await expect(browsingNodes()).toHaveCount(PREVIEW_BROWSING.pageSize)
    const more = product.getByTestId('explorer-more-/')
    const failed = browsingResponse('explorer', PREVIEW_BROWSING.pageSize)
    await more.click()
    expect((await failed).status()).toBe(503)
    await expect(product.getByTestId('explorer-more-error-/')).toBeVisible()
    await expect(browsingNodes()).toHaveCount(PREVIEW_BROWSING.pageSize)
    await more.scrollIntoViewIfNeeded()
    await more.focus()
    await expect(more).toBeFocused()
    const box = await more.boundingBox()
    const viewport = await product.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    expect(box).not.toBeNull()
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
    await product.screenshot({ path: testInfo.outputPath('browsing-dark-keyboard-error.png') })
    const retried = browsingResponse('explorer', PREVIEW_BROWSING.pageSize)
    await product.keyboard.press('Enter')
    expect((await retried).status()).toBe(200)
    const tree = await snapshot('/api/content/projects/' + PREVIEW_PROJECT_ID + '/tree')
    await expect(browsingNodes()).toHaveCount(tree.total)
    await expect(product.getByTestId('explorer-more-error-/')).not.toBeVisible()
    await expect(more).not.toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('browsing-dark-keyboard-recovered.png') })
  }, [{ path: '/api/content/projects/' + PREVIEW_PROJECT_ID + '/tree', method: 'GET', status: 503 }])
})

for (const action of ['complete', 'refresh', 'remount']) {
  test('native resource pending pagination preserves generation: ' + action, { annotation: [
    { type: INITIAL_TARGET_ANNOTATION, description: JSON.stringify({ pageId: 'viewer-explorer', sceneId: 'browsing-more-pending' }) },
    previewConsumption('viewer-explorer', 'browsing-more-pending', action === 'complete' ? ['loaded', 'loading', 'paginated', 'retained'] : ['loaded', 'loading', 'retained', 'superseded', action === 'refresh' ? 'refreshed' : 'remounted']),
  ] }, async ({}, testInfo) => {
    await browsingUi(testInfo, async ({ snapshot }) => {
      await browsingOpen('explorer')
      await expect(browsingNodes()).toHaveCount(PREVIEW_BROWSING.pageSize)
      const more = product.getByTestId('explorer-more-/')
      const pending = browsingResponse('explorer', PREVIEW_BROWSING.pageSize)
      await more.click()
      await expect(more).toBeDisabled()
      await expect(browsingNodes()).toHaveCount(PREVIEW_BROWSING.pageSize)
      await product.screenshot({ path: testInfo.outputPath('browsing-more-' + action + '-pending.png') })
      if (action !== 'complete') {
        const current = browsingResponse('explorer')
        if (action === 'refresh') await product.getByTestId('explorer-refresh').click()
        else {
          await product.getByTestId('explorer-root').getByRole('button', { name: '收起 设计协作项目', exact: true }).click()
          await product.getByTestId('explorer-root').getByRole('button', { name: '展开 设计协作项目', exact: true }).click()
        }
        expect((await current).status()).toBe(200)
        await expect(browsingNodes()).toHaveCount(PREVIEW_BROWSING.pageSize)
        const stale = await pending
        expect(stale.status()).toBe(200)
        expect(await stale.finished()).toBeNull()
        await expect(browsingNodes()).toHaveCount(PREVIEW_BROWSING.pageSize)
        await expect(more).toBeEnabled()
        const retried = browsingResponse('explorer', PREVIEW_BROWSING.pageSize)
        await more.click()
        expect((await retried).status()).toBe(200)
      } else expect((await pending).status()).toBe(200)
      const tree = await snapshot('/api/content/projects/' + PREVIEW_PROJECT_ID + '/tree')
      await expect(browsingNodes()).toHaveCount(tree.total)
      const paths = await browsingNodes().evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')))
      expect(new Set(paths).size).toBe(tree.total)
      await expect(more).not.toBeVisible()
      await product.screenshot({ path: testInfo.outputPath('browsing-more-' + action + '-completed.png') })
    })
  })
}

function nativeLiteratureRow(title = PREVIEW_LITERATURE.titles[0]) {
  return product.locator('.lit-row').filter({ has: product.getByText(title, { exact: true }) })
}

function nativeLiteratureResponse(path = LITERATURE_PATH, method = 'GET') {
  return product.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method)
}

async function useDarkEnglishAppearance() {
  for (const [label, option] of [[zh.theme, zh.dark], [zh.language, zh.english]]) {
    await controls.getByRole('combobox', { name: label, exact: true }).click()
    await Promise.all([
      product.waitForEvent('framenavigated', frame => frame === product.mainFrame()),
      controls.waitForEvent('framenavigated', frame => frame === controls.mainFrame()),
      controls.getByRole('option', { name: option, exact: true }).click(),
    ])
  }
  await expect(product.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(product.locator('html')).toHaveAttribute('lang', LOCALES.en.tag)
  await expect(controls.getByRole('heading', { name: en.title, exact: true })).toBeVisible()
}

async function openNativeLiterature(scene, dictionary = zh) {
  const pageId = 'page-literature'
  const [catalogue] = await Promise.all([
    product.waitForResponse(response => {
      const request = response.request()
      const endpoint = new URL(response.url())
      const referrer = request.headers().referer
      if (endpoint.origin !== manifest.origin || endpoint.pathname !== LITERATURE_PATH || request.method() !== 'GET' || !referrer) return false
      const source = new URL(referrer)
      return source.origin === manifest.origin &&
        source.searchParams.get(PREVIEW_INSTANCE_PARAMETER) === manifest.instance &&
        source.searchParams.get(PREVIEW_PAGE_PARAMETER) === pageId &&
        source.searchParams.get(PREVIEW_SCENE_PARAMETER) === scene
    }).then(response => {
      expect(response.status()).toBe(200)
      return response.json()
    }),
    scenario(pageId, scene, dictionary),
  ])
  return catalogue
}

async function nativeLiteratureDetail(item, title = item.title) {
  const reading = nativeLiteratureResponse(LITERATURE_PATH + '/' + encodeURIComponent(item.id))
  await nativeLiteratureRow(title).click()
  const response = await reading
  expect(response.status()).toBe(200)
  const detail = await response.json()
  expect(detail.id).toBe(item.id)
  return detail
}

test('native literature catalogue preserves filters, sorted rows, saved notes and the same PDF after reload', { annotation: previewConsumption('page-literature', 'library-populated', ['populated', 'filtered', 'sorted', 'detail', 'attachment', 'notes', 'reloaded']) }, async ({}, testInfo) => {
  await normalUi(testInfo, async () => {
    const catalogue = await openNativeLiterature('library-populated')
    expect(catalogue.total).toBe(3)
    const paper = catalogue.items.find(item => item.title === PREVIEW_LITERATURE.titles[0])
    for (const title of PREVIEW_LITERATURE.titles) await expect(nativeLiteratureRow(title)).toBeVisible()
    const sidebar = product.getByTestId('literature-panel')
    const tagHeader = sidebar.locator('.lit-section-head').filter({ hasText: literatureZh.panel.tags })
    const tags = sidebar.locator('.lit-tag-cloud')
    const tagSearch = sidebar.getByRole('button', { name: literatureZh.panel.searchTags, exact: true })
    const tagInput = sidebar.getByRole('searchbox', { name: literatureZh.panel.searchTags, exact: true })
    await expect(tagSearch).toBeVisible()
    await tagSearch.click({ trial: true })
    await expect(tagSearch).toBeVisible()
    await expect(tagInput).toHaveCount(0)
    const headerBefore = await tagHeader.boundingBox()
    const tagsBefore = await tags.boundingBox()
    expect(headerBefore).not.toBeNull()
    expect(tagsBefore).not.toBeNull()
    for (const dismiss of ['escape', 'blur']) {
      await tagSearch.click()
      await expect(tagInput).toBeFocused()
      await expect.poll(() => tagHeader.boundingBox()).toEqual(headerBefore)
      await expect.poll(() => tags.boundingBox()).toEqual(tagsBefore)
      if (dismiss === 'escape') await tagInput.press('Escape')
      else await tagInput.press('Tab')
      await expect(tagSearch).toBeVisible()
      await expect.poll(() => tagHeader.boundingBox()).toEqual(headerBefore)
      await expect.poll(() => tags.boundingBox()).toEqual(tagsBefore)
    }
    await product.screenshot({ path: testInfo.outputPath('literature-tag-search-geometry.png') })
    const search = product.getByPlaceholder(literatureZh.list.searchPlaceholder, { exact: true })
    const filtered = product.waitForResponse(response => new URL(response.url()).pathname === LITERATURE_PATH && new URL(response.url()).searchParams.get('q') === PREVIEW_LITERATURE.titles[2])
    await search.fill(PREVIEW_LITERATURE.titles[2])
    const filteredResponse = await filtered
    expect(filteredResponse.status()).toBe(200)
    expect((await filteredResponse.json()).items.map(item => item.id)).toEqual([catalogue.items.find(item => item.title === PREVIEW_LITERATURE.titles[2]).id])
    await expect(nativeLiteratureRow()).toHaveCount(0)
    await expect(nativeLiteratureRow(PREVIEW_LITERATURE.titles[2])).toBeVisible()
    const unfiltered = product.waitForResponse(response => new URL(response.url()).pathname === LITERATURE_PATH && !new URL(response.url()).searchParams.get('q'))
    await search.clear()
    expect((await unfiltered).status()).toBe(200)
    const sorted = product.waitForResponse(response => new URL(response.url()).pathname === LITERATURE_PATH && new URL(response.url()).searchParams.get('sort') === 'title')
    await product.getByRole('button', { name: literatureZh.columns.title, exact: true }).click()
    const sortedResponse = await sorted
    expect(sortedResponse.status()).toBe(200)
    expect(['asc', 'desc']).toContain(new URL(sortedResponse.url()).searchParams.get('order'))
    const sortedPage = await sortedResponse.json()
    await expect(product.locator('.lit-row')).toHaveCount(sortedPage.items.length)
    expect(await product.locator('.lit-row').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).toEqual(sortedPage.items.map(item => item.title))
    const detail = await nativeLiteratureDetail(paper)
    const noteButton = title => product.getByRole('button').filter({ has: product.getByText(title, { exact: true }) })
    await product.getByRole('tab', { name: /^笔记 / }).click()
    const originalNote = detail.notes[0]
    await expect(noteButton(originalNote.title)).toBeVisible()
    const notesPath = LITERATURE_PATH + '/' + encodeURIComponent(paper.id) + '/notes'
    const mutations = []
    product.on('request', request => {
      if (new URL(request.url()).pathname.startsWith(notesPath) && request.method() !== 'GET') mutations.push({ method: request.method(), path: new URL(request.url()).pathname })
    })
    const noteTitle = '模拟消费笔记'
    const noteText = '受审模拟笔记：通过真实编辑器保存，不代表用户资料。'
    const revised = noteText + '\n\n## 模拟修订\n真实自动保存。'
    await product.getByRole('button', { name: literatureZh.relations.addNote, exact: true }).click()
    await product.getByRole('textbox', { name: literatureZh.notes.title, exact: true }).fill(noteTitle)
    const creating = nativeLiteratureResponse(notesPath, 'POST')
    const body = product.getByRole('textbox', { name: literatureZh.notes.bodyPlaceholder, exact: true })
    await body.fill(noteText)
    const createdResponse = await creating
    expect(createdResponse.status()).toBe(200)
    const created = await createdResponse.json()
    expect(created).toMatchObject({ title: noteTitle, text: noteText })
    await expect(product.getByRole('status')).toHaveText(literatureZh.notes.statusSaved)
    const updating = nativeLiteratureResponse(notesPath + '/' + encodeURIComponent(created.id), 'PATCH')
    await body.fill(revised)
    const updatedResponse = await updating
    expect(updatedResponse.status()).toBe(200)
    const updated = await updatedResponse.json()
    expect(updated).toMatchObject({ id: created.id, title: noteTitle, text: revised })
    expect(updated.version).toBeGreaterThan(created.version)
    await expect(product.getByRole('status')).toHaveText(literatureZh.notes.statusSaved)
    await product.getByRole('tab', { name: literatureZh.notes.modePreview, exact: true }).click()
    await expect(product.getByRole('heading', { name: '模拟修订', exact: true })).toBeVisible()
    await product.reload()
    const reloaded = await nativeLiteratureDetail(paper)
    expect(reloaded.notes).toHaveLength(detail.notes.length + 1)
    expect(reloaded.notes.find(note => note.id === created.id)).toMatchObject(updated)
    expect(reloaded.notes.find(note => note.id === originalNote.id)).toEqual(originalNote)
    await product.getByRole('tab', { name: /^笔记 / }).click()
    await noteButton(noteTitle).click()
    await expect(body).toHaveValue(revised)
    await product.screenshot({ path: testInfo.outputPath('literature-note-reloaded.png') })
    const remove = product.getByRole('button', { name: literatureZh.notes.deleteNamed.replace('{{title}}', noteTitle), exact: true })
    await remove.click()
    const confirmation = product.getByRole('alertdialog')
    await expect(confirmation.getByText(literatureZh.notes.deleteDescription, { exact: true })).toBeVisible()
    await confirmation.getByRole('button', { name: literatureZh.notes.cancel, exact: true }).click()
    expect(mutations.filter(request => request.method === 'DELETE')).toEqual([])
    await expect(body).toHaveValue(revised)
    await remove.click()
    const deleting = nativeLiteratureResponse(notesPath + '/' + encodeURIComponent(created.id), 'DELETE')
    await confirmation.getByRole('button', { name: literatureZh.notes.delete, exact: true }).click()
    expect((await deleting).status()).toBe(200)
    await expect(noteButton(noteTitle)).toHaveCount(0)
    await expect(noteButton(originalNote.title)).toBeVisible()
    expect(mutations).toEqual([{ method: 'POST', path: notesPath }, { method: 'PATCH', path: notesPath + '/' + created.id }, { method: 'DELETE', path: notesPath + '/' + created.id }])
    await product.getByRole('button', { name: literatureZh.detail.close, exact: true }).click()
    const attachmentPath = LITERATURE_PATH + '/' + paper.id + '/attachments/' + detail.primary_attachment.id + '/open'
    const opening = nativeLiteratureResponse(attachmentPath)
    await nativeLiteratureRow().dblclick()
    const opened = await opening
    expect(opened.status()).toBe(200)
    const projection = await opened.json()
    expect(projection.viewer).toBe('pdf')
    expect(projection.revision).toBe('sha256:' + PREVIEW_DOCUMENTS.find(document => document.path === 'sample.pdf').sha256)
    await expect(product.getByTestId('pdf-page-1').locator('canvas')).toBeVisible()
    const reopening = nativeLiteratureResponse(attachmentPath)
    await product.reload()
    const reopened = await reopening
    expect(reopened.status()).toBe(200)
    expect(await reopened.json()).toEqual(projection)
    await expect(product.getByTestId('pdf-page-1').locator('canvas')).toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('literature-attachment-reloaded.png') })
  })
})

for (const scene of ['metadata-pending', 'metadata-failed']) {
  test('native literature metadata lifecycle: ' + scene, { annotation: previewConsumption('page-literature', scene, scene === 'metadata-pending' ? ['editing', 'pending', 'saved'] : ['editing', 'error', 'retried', 'saved']) }, async ({}, testInfo) => {
    const failures = []
    await normalUi(testInfo, async () => {
      const catalogue = await openNativeLiterature(scene)
      const paper = catalogue.items.find(item => item.title === PREVIEW_LITERATURE.titles[0])
      const original = await nativeLiteratureDetail(paper)
      const path = LITERATURE_PATH + '/' + encodeURIComponent(paper.id)
      if (scene === 'metadata-failed') failures.push({ path, method: 'PATCH', status: 503 })
      const statuses = []
      product.on('response', response => {
        if (new URL(response.url()).pathname === path && response.request().method() === 'PATCH') statuses.push(response.status())
      })
      const label = literatureZh.detail.edit.replace('{{label}}', literatureZh.columns.title)
      const field = product.getByRole('button', { name: label, exact: true })
      await expect(field).toHaveText(paper.title)
      await field.click()
      const input = product.getByRole('textbox', { name: label, exact: true })
      await expect(input).toHaveValue(paper.title)
      const revised = paper.title + ' · 受审修订'
      await input.fill(revised)
      let responded = false
      const saving = nativeLiteratureResponse(path, 'PATCH').then(response => { responded = true; return response })
      const submitted = product.waitForRequest(request => new URL(request.url()).pathname === path && request.method() === 'PATCH')
      await input.press('Tab')
      expect((await submitted).postDataJSON()).toMatchObject({ fields: { title: revised } })
      if (scene === 'metadata-pending') {
        await expect(input).toBeDisabled()
        await expect(input).toHaveValue(revised)
        expect(responded).toBe(false)
        await product.screenshot({ path: testInfo.outputPath(scene + '-pending.png') })
      } else {
        expect((await saving).status()).toBe(503)
        await expect(product.getByText(literatureZh.detail.saveFailed, { exact: true }).first()).toBeVisible()
        await expect(input).toBeEnabled()
        await expect(input).toHaveValue(revised)
        const url = new URL(path, manifest.origin)
        url.searchParams.set('previewInstance', manifest.instance)
        const unchanged = await product.request.get(url.href)
        expect(unchanged.status()).toBe(200)
        expect((await unchanged.json()).title).toBe(paper.title)
        await product.screenshot({ path: testInfo.outputPath(scene + '-failed.png') })
      }
      const successful = scene === 'metadata-pending' ? saving : nativeLiteratureResponse(path, 'PATCH')
      if (scene === 'metadata-failed') await product.getByRole('button', { name: literatureZh.detail.retry, exact: true }).click()
      const response = await successful
      expect(response.status()).toBe(200)
      const updated = await response.json()
      expect(updated).toMatchObject({ id: paper.id, title: revised })
      expect(updated.version).toBeGreaterThan(original.version)
      await expect(field).toHaveText(revised)
      expect(statuses).toEqual(scene === 'metadata-pending' ? [200] : [503, 200])
      await product.reload()
      const reloaded = await nativeLiteratureDetail(paper, revised)
      expect(reloaded).toMatchObject({ id: paper.id, title: revised, version: updated.version })
      expect(reloaded.primary_attachment).toEqual(original.primary_attachment)
      await expect(field).toHaveText(revised)
      await product.screenshot({ path: testInfo.outputPath(scene + '-reloaded.png'), animations: 'disabled' })
    }, failures)
  })
}

for (const source of ['library', 'detail']) {
  for (const state of ['pending', 'failed']) {
    const scene = source + '-' + state
    test('native literature read lifecycle: ' + scene, { annotation: previewConsumption('page-literature', scene, state === 'pending' ? ['loading', 'loaded'] : ['error', 'retry-failed']) }, async ({}, testInfo) => {
      const failures = source === 'library' && state === 'failed'
        ? [LITERATURE_PATH, LITERATURE_PATH + '/counts', LITERATURE_PATH + '/facets', LITERATURE_PATH + '/tag-facets', LITERATURE_PATH + '/projects', '/api/v1/collections'].map(path => ({ path, method: 'GET', status: 503 }))
        : []
      await normalUi(testInfo, async () => {
        let reading = nativeLiteratureResponse()
        await scenario('page-literature', scene)
        const library = product.getByTestId('literature-overview')
        await expect(library).toBeVisible()
        let path = LITERATURE_PATH
        let readingState
        if (source === 'detail') {
          const catalogue = await reading
          expect(catalogue.status()).toBe(200)
          const paper = (await catalogue.json()).items.find(item => item.title === PREVIEW_LITERATURE.titles[0])
          expect(paper.id).toBeTruthy()
          path += '/' + encodeURIComponent(paper.id)
          if (state === 'failed') failures.push({ path, method: 'GET', status: 503 })
          reading = nativeLiteratureResponse(path)
          if (state === 'pending') readingState = nativeLiteratureResponse('/api/literature/' + encodeURIComponent(paper.id) + '/ai/state')
          await nativeLiteratureRow().click()
          await expect(product.getByRole('button', { name: literatureZh.detail.close, exact: true })).toBeVisible()
        }
        const spinner = source === 'library'
          ? library.getByLabel(literatureZh.list.loading, { exact: true })
          : product.getByRole('tabpanel').filter({ visible: true }).getByLabel(literatureZh.detail.loading, { exact: true })
        if (state === 'pending') {
          await expect(spinner).toBeVisible()
          await product.screenshot({ path: testInfo.outputPath(scene + '-loading.png') })
          await expect(spinner).toBeVisible()
          const response = await reading
          expect(response.status()).toBe(200)
          const body = await response.json()
          if (source === 'library') {
            expect(body.total).toBe(3)
            for (const title of PREVIEW_LITERATURE.titles) await expect(nativeLiteratureRow(title)).toBeVisible()
          } else {
            expect(body.id).toBe(decodeURIComponent(path.split('/').at(-1)))
            const title = product.getByRole('button', { name: literatureZh.detail.edit.replace('{{label}}', literatureZh.columns.title), exact: true })
            await expect(title).toBeVisible()
            await expect(title).toHaveText(body.title)
            const response = await readingState
            expect(response.status()).toBe(200)
            expect(await response.json()).toEqual({ revision: expect.stringMatching(/^[a-f0-9]{64}$/), attachment_id: body.primary_attachment.id, results: {}, task: null })
          }
          await expect(spinner).not.toBeVisible()
          await product.screenshot({ path: testInfo.outputPath(scene + '-loaded.png') })
        } else {
          expect((await reading).status()).toBe(503)
          const error = source === 'library' ? library.locator('.lit-error') : product.getByText(literatureZh.detail.loadFailed, { exact: true })
          const retry = source === 'library' ? library.getByRole('button', { name: uiZh.retry, exact: true }).last() : product.getByRole('button', { name: uiZh.retry, exact: true })
          await expect(error).toBeVisible()
          if (source === 'library') {
            await expect(product.getByTestId('literature-panel').getByText(literatureZh.panel.readFailed, { exact: true })).toBeVisible()
            await expect(nativeLiteratureRow()).toHaveCount(0)
          }
          const retried = nativeLiteratureResponse(path)
          await retry.click()
          expect((await retried).status()).toBe(503)
          await expect(error).toBeVisible()
          await expect(spinner).not.toBeVisible()
          if (source === 'library') {
            await expect(product.getByTestId('literature-panel').getByText(literatureZh.panel.readFailed, { exact: true })).toBeVisible()
            await expect(nativeLiteratureRow()).toHaveCount(0)
          } else {
            for (const tab of [literatureZh.detail.tabs.attachments, literatureZh.detail.tabs.notes]) {
              await product.getByRole('tab', { name: tab + ' 0', exact: true }).click()
              const panel = product.getByRole('tabpanel').filter({ visible: true })
              await expect(panel.getByText(literatureZh.detail.loadFailed, { exact: true })).toBeVisible()
              await expect(product.getByText(literatureZh.detail.loadFailed, { exact: true })).toHaveCount(1)
              const retried = nativeLiteratureResponse(path)
              await panel.getByRole('button', { name: uiZh.retry, exact: true }).click()
              expect((await retried).status()).toBe(503)
              await expect(panel.getByText(literatureZh.detail.loadFailed, { exact: true })).toBeVisible()
              await expect(panel.getByLabel(literatureZh.detail.loading, { exact: true })).not.toBeVisible()
              await product.screenshot({ path: testInfo.outputPath(scene + '-' + tab + '.png') })
            }
          }
          await product.screenshot({ path: testInfo.outputPath(scene + '-retry-failed.png') })
        }
      }, failures)
    })
  }
}

test('native literature detail failure supports dark English minimum-window keyboard retry', { annotation: previewConsumption('page-literature', 'detail-failed', ['error', 'retry-failed']) }, async ({}, testInfo) => {
  await useDarkEnglishAppearance()
  const failures = []
  await normalUi(testInfo, async () => {
    const catalogue = await openNativeLiterature('detail-failed', en)
    const paper = catalogue.items.find(item => item.title === PREVIEW_LITERATURE.titles[0])
    expect(paper).toBeDefined()
    await controls.getByRole('button', { name: en.close, exact: true }).click()
    const window = await app.browserWindow(product)
    await window.evaluate((window, minimum) => window.setSize(minimum.width, minimum.height), WORKSPACE_WINDOW_MINIMUM)
    await expect.poll(() => product.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(WORKSPACE_WINDOW_MINIMUM)
    const path = LITERATURE_PATH + '/' + encodeURIComponent(paper.id)
    failures.push({ path, method: 'GET', status: 503 })
    const detail = nativeLiteratureResponse(path)
    await nativeLiteratureRow().click()
    expect((await detail).status()).toBe(503)
    const error = product.getByText(literatureEn.detail.loadFailed, { exact: true })
    await expect(error).toBeVisible()
    const retry = product.getByRole('button', { name: uiEn.retry, exact: true })
    for (let step = 0; step < 12 && !(await retry.evaluate(element => element === document.activeElement)); step += 1) await product.keyboard.press('Tab')
    await expect(retry).toBeFocused()
    const retried = nativeLiteratureResponse(path)
    await product.keyboard.press('Enter')
    expect((await retried).status()).toBe(503)
    await expect(error).toBeVisible()
    await expect(product.getByLabel(literatureEn.detail.loading, { exact: true })).not.toBeVisible()
    await expect(retry).toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('literature-detail-dark-english-minimum.png') })
    await product.getByRole('button', { name: literatureEn.detail.close, exact: true }).click()
    await expect(nativeLiteratureRow()).toBeVisible()
    await expect(error).not.toBeVisible()
  }, failures)
})

test('native literature empty catalogue distinguishes filtering from emptiness', { annotation: previewConsumption('page-literature', 'literature-browse', ['empty', 'filtered']) }, async ({}, testInfo) => {
  await normalUi(testInfo, async () => {
    await scenario('page-literature', 'literature-browse')
    const library = product.getByTestId('literature-overview')
    await expect(library).toBeVisible()
    await expect(library.getByText('暂无文献', { exact: true })).toBeVisible()
    const search = library.getByPlaceholder('标题、作者、年份')
    await expect(search).toBeVisible()
    await search.fill('preview-no-matching-paper')
    await expect(search).toHaveValue('preview-no-matching-paper')
    await expect(library.getByText('暂无搜索结果', { exact: true })).toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('primary-literature-filtered.png') })
    await search.clear()
    await expect(search).toHaveValue('')
    await expect(library.getByText('暂无文献', { exact: true })).toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('primary-literature-empty.png') })
  })
})

test('native skills retains policy and persists edits and confirmed deletion across reentry', { annotation: previewConsumption('page-skills', 'skills-browse', ['populated', 'filtered', 'no-match', 'details']) }, async ({}, testInfo) => {
  await normalUi(testInfo, async () => {
    await scenario('page-skills', 'skills-browse')
    await expect(product.getByTestId('skills-installed')).toBeVisible()
    await expect(product.getByTestId('skills-empty')).toBeVisible()
    for (const skill of ['preview-notes', 'preview-required', 'preview-unavailable']) await expect(product.getByTestId('skill-card-' + skill)).toHaveCount(0)
    await product.getByTestId('skills-installed').click()
    await product.getByTestId('skills-tab-scholarseed').click()
    await expect(product.getByTestId('skill-card-preview-required')).toBeVisible()
    await expect(product.getByTestId('skill-toggle-preview-required')).toBeDisabled()
    await expect(product.getByTestId('skill-toggle-preview-required')).toHaveAttribute('aria-checked', 'true')
    await product.getByTestId('skill-more-preview-required').click()
    await expect(product.getByTestId('skill-remove-preview-required')).toHaveCount(0)
    await product.keyboard.press('Escape')
    await product.getByTestId('skills-tab-user').click()
    await expect(product.getByTestId('skill-card-preview-notes')).toBeVisible()
    await expect(product.getByTestId('skill-card-preview-unavailable')).toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('primary-skills.png') })
    const search = product.getByTestId('skills-search')
    await search.fill('preview-no-matching-skill')
    await expect(product.getByTestId('skills-empty')).toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('primary-skills-no-match.png') })
    await search.clear()
    await product.getByTestId('skills-tab-user').click()
    await expect(product.getByTestId('skills-tab-user')).toHaveAttribute('aria-selected', 'true')
    await expect(product.getByTestId('skill-card-preview-required')).toHaveCount(0)
    await search.fill('preview-notes')
    await expect(product.getByTestId('skill-card-preview-notes')).toBeVisible()
    await expect(product.getByTestId('skill-card-preview-required')).toHaveCount(0)
    await product.getByTestId('skill-view-preview-notes').click()
    const detail = product.getByTestId('skill-detail')
    await expect(detail).toBeVisible()
    await expect(detail.getByTestId('skill-document')).toContainText('preview-notes')
    await expect(detail.getByTestId('skill-document')).toContainText('不会执行工具或读取用户文件。')
    await product.screenshot({ path: testInfo.outputPath('primary-skills-detail.png') })
    await detail.getByRole('button', { name: '取消', exact: true }).click()
    await expect(detail).not.toBeVisible()
    await search.clear()
    await expect(product.getByTestId('skill-card-preview-unavailable')).toContainText('模拟依赖缺失状态，不访问本机依赖。')
    await expect(product.getByTestId('skill-card-preview-unavailable')).not.toContainText('模拟依赖尚未准备')
    await product.getByTestId('skill-view-preview-unavailable').click()
    await expect(detail.getByTestId('skill-document')).toContainText('preview-unavailable')
    await detail.getByRole('button', { name: '取消', exact: true }).click()
    const card = product.getByTestId('skill-card-preview-notes')
    const toggle = product.getByTestId('skill-toggle-preview-notes')
    const reopen = async () => {
      await product.reload()
      await product.getByTestId('skills-installed').click()
      await product.getByTestId('skills-tab-user').click()
    }
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await reopen()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await product.getByTestId('skill-view-preview-notes').click()
    const detailToggle = detail.getByTestId('skill-detail-toggle-preview-notes')
    await expect(detailToggle).toHaveAttribute('aria-checked', 'false')
    await detailToggle.click()
    await expect(detailToggle).toHaveAttribute('aria-checked', 'true')
    await detail.getByRole('button', { name: '取消', exact: true }).click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    const deletions = []
    product.on('request', request => {
      if (request.method() === 'DELETE' && new URL(request.url()).pathname === SKILLS_PATH + '/preview-notes') deletions.push(request.url())
    })
    await card.hover()
    await product.getByTestId('skill-more-preview-notes').click()
    await product.getByTestId('skill-remove-preview-notes').click()
    const confirmation = product.getByTestId('skill-remove-confirm')
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    await expect(card).toBeVisible()
    expect(deletions).toEqual([])
    await card.hover()
    await product.getByTestId('skill-more-preview-notes').click()
    await product.getByTestId('skill-remove-preview-notes').click()
    await expect(confirmation).toBeVisible()
    expect(deletions).toEqual([])
    await product.screenshot({ path: testInfo.outputPath('skills-delete-confirmation.png') })
    await confirmation.getByTestId('skill-remove-ok').click()
    await expect.poll(() => deletions.length).toBe(1)
    await expect(card).toHaveCount(0)
    await reopen()
    await expect(card).toHaveCount(0)
    await expect(product.getByTestId('skill-card-preview-unavailable')).toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('skills-after-reentry.png') })
    await product.getByTestId('skills-tab-scholarseed').click()
    await expect(product.getByTestId('skill-card-preview-required')).toBeVisible()
    expect(deletions).toHaveLength(1)
  })
})

test('native home and project search operate the shared product navigation', { annotation: [previewConsumption('page-home', 'home-browse', ['populated', 'opened']), previewConsumption('page-projects', 'projects-browse', ['populated', 'filtered', 'no-match', 'opened']), { type: INITIAL_TARGET_ANNOTATION, description: JSON.stringify({ pageId: 'page-projects', sceneId: 'projects-browse' }) }] }, async ({}, testInfo) => {
  await normalUi(testInfo, async () => {
    await scenario('page-projects', 'projects-browse')
    const card = product.getByTestId('project-card-设计协作项目')
    const search = product.getByTestId('projects-search')
    await expect(card).toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('pdfe-native-projects.png') })
    await search.fill('pdfe-no-matching-project')
    await expect(product.getByTestId('projects-empty')).toBeVisible()
    await expect(card).toHaveCount(0)
    await product.screenshot({ path: testInfo.outputPath('pdfe-native-projects-no-match.png') })
    await search.fill('设计协作')
    await expect(card).toBeVisible()
    await card.getByRole('button').first().click()
    await expect(product.getByRole('navigation', { name: layoutZh.tasks, exact: true }).getByRole('button', { name: '设计协作项目', exact: true })).toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('pdfe-native-project-opened.png') })
    await scenario('page-home', 'home-browse')
    await expect(product.getByTestId('home-project-设计协作项目')).toBeVisible()
    await expect(product.getByTestId('home-tasks-list')).toContainText('设计协作演示')
    await product.screenshot({ path: testInfo.outputPath('pdfe-native-home.png') })
    await product.getByTestId('home-project-设计协作项目').click()
    await expect(product.getByRole('navigation', { name: layoutZh.tasks, exact: true }).getByRole('button', { name: '设计协作项目', exact: true })).toBeVisible()
    const selector = product.getByTestId('project-navigation-selector')
    await selector.click()
    const menu = product.getByTestId('project-menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByTestId('project-menu-option-设计协作项目')).toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('project-menu-current-entry.png'), animations: 'disabled' })
    await product.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
    await expect(selector).toBeFocused()
    await expect(selector).toContainText('设计协作项目')
    await product.screenshot({ path: testInfo.outputPath('pdfe-native-home-project.png') })
  })
})

test('native project creation preserves failed form input and retries successfully', { annotation: [previewConsumption('page-projects', 'projects-create-failure', ['submitting', 'failed', 'retry', 'completed']), { type: INITIAL_TARGET_ANNOTATION, description: JSON.stringify({ pageId: 'page-projects', sceneId: 'projects-create-failure' }) }] }, async ({}, testInfo) => {
  const submissions = []
  product.on('request', request => {
    if (new URL(request.url()).pathname === '/api/content/projects' && request.method() === 'POST') submissions.push(request.postDataJSON())
  })
  const registry = new URL('/api/content/projects', manifest.origin)
  registry.searchParams.set('previewInstance', manifest.instance)
  const projects = async () => {
    const response = await product.request.get(registry.href)
    expect(response.status()).toBe(200)
    return (await response.json()).projects
  }
  const original = await projects()
  await scenario('page-projects', 'projects-create-failure')
  await product.getByRole('button', { name: '项目中心', exact: true }).click()
  await expect(product.getByTestId('project-center')).toBeVisible()
  await openHomeProjectForm()
  const form = product.getByTestId('project-new-modal')
  const name = '原生 Mock 失败重试'
  await product.getByTestId('project-create-name').fill(name)
  await product.getByTestId('project-create').click()
  await expect(form.getByText('无法创建项目，请重试。', { exact: true }).first()).toBeVisible()
  await expect(product.getByTestId('project-create-name')).toHaveValue(name)
  await expect(product.getByTestId('project-create-name')).toBeEnabled()
  await expect(product.getByTestId('project-create')).toBeEnabled()
  expect(await projects()).toEqual(original)
  expect(submissions).toEqual([expect.objectContaining({ name })])
  await product.screenshot({ path: testInfo.outputPath('pdfe-native-project-failure.png') })
  await product.getByTestId('project-create').click()
  await expect(form).not.toBeVisible()
  await expect(product.getByRole('button', { name, exact: true })).toBeVisible()
  await product.getByRole('button', { name: '返回项目中心', exact: true }).click()
  await expect(product.getByTestId('home-project-' + name)).toHaveCount(1)
  await expect(product.getByTestId('home-project-' + name)).toBeVisible()
  const completed = await projects()
  const created = completed.filter(project => project.name === name)
  expect(created).toHaveLength(1)
  expect(completed.filter(project => project.id !== created[0].id)).toEqual(original)
  expect(submissions).toEqual([expect.objectContaining({ name }), expect.objectContaining({ name })])
  await reloadCenter(() => controls.getByRole('button', { name: zh.reload, exact: true }).click())
  await expect(product.getByTestId('home-project-' + name)).toHaveCount(1)
  expect(await projects()).toEqual(completed)
  await product.screenshot({ path: testInfo.outputPath('pdfe-native-project-retried.png') })
})

test('native project center consumes every declared data policy through workbench navigation', async ({}, testInfo) => {
  test.setTimeout(CENTER_MATRIX_TIMEOUT_MS)
  const observations = []
  const errors = []
  product.on('pageerror', error => errors.push(error.message))
  const reads = new Map()
  product.on('console', message => {
    const text = message.text()
    if (!text.startsWith(API_DIAGNOSTIC_PREFIX)) return
    const scene = new URL(product.url()).searchParams.get('scene')
    const observation = observations.find(item => item.sceneId === scene)
    if (observation) (observation.diagnostics ??= []).push({ at: Date.now(), text })
  })
  product.on('request', request => {
    const url = new URL(request.url())
    if (request.method() !== 'GET' || !BOOTSTRAP_READ_PATHS.has(url.pathname)) return
    const referrer = request.headers().referer
    const source = referrer ? new URL(referrer) : undefined
    const observation = source?.searchParams.get('page') === 'page-home'
      ? observations.find(item => item.sceneId === source.searchParams.get('scene'))
      : undefined
    if (!observation) return
    const record = { sceneId: observation.sceneId, path: url.pathname, query: Object.fromEntries(url.searchParams), startedAt: Date.now(), status: null, finishedAt: null, error: null }
    observation.reads.push(record)
    reads.set(request, { observation, record })
  })
  product.on('response', response => {
    const read = reads.get(response.request())
    if (read) {
      read.record.status = response.status()
      read.record.contentType = response.headers()['content-type']
      if (read.record.contentType?.includes('application/json')) {
        void response.json().then(body => { read.record.body = body }, error => { read.record.bodyError = error.message })
      }
    }
  })
  product.on('requestfinished', request => {
    const read = reads.get(request)
    if (read) read.record.finishedAt = Date.now()
  })
  product.on('requestfailed', request => {
    const read = reads.get(request)
    if (read) {
      read.record.finishedAt = Date.now()
      read.record.error = request.failure()?.errorText
    }
  })
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
  try {
    for (const entry of PREVIEW_CATALOG.find(page => page.id === 'page-home').scenarios) {
      const observation = { sceneId: entry.id, policy: entry.home, projectIds: [], taskIds: [], reads: [] }
      observations.push(observation)
      const projectRead = status => product.waitForResponse(response => new URL(response.url()).pathname === ARCHIVE_PROJECTS_PATH && reads.get(response.request())?.observation === observation && (status === undefined || response.status() === status))
      const [loaded] = await Promise.all([projectRead(), scenario('page-home', entry.id)])
      expect(loaded.status()).toBe(entry.home.projectRead === 'failed' ? 503 : 200)
      expect(await loaded.finished()).toBeNull()
      if (entry.home.projectRead === 'failed') {
        await expect(product.getByRole('button', { name: '重新加载', exact: true })).toBeVisible()
        await expect(product.getByTestId('home-projects-empty')).toHaveCount(0)
        const [released] = await Promise.all([
          controls.waitForResponse(response => new URL(response.url()).pathname === PREVIEW_HOME.recoveryPath && response.request().method() === 'POST'),
          controls.getByTestId('preview-home-projects-recover').click(),
        ])
        expect(released.status()).toBe(200)
        expect(await released.finished()).toBeNull()
        const [recovered] = await Promise.all([
          projectRead(200),
          product.getByRole('button', { name: '重新加载', exact: true }).click(),
        ])
        expect(recovered.status()).toBe(200)
        expect(await recovered.finished()).toBeNull()
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
      if (policy.tasks === 0) await expectHomeTasksHidden()
      else await expect(product.getByTestId('home-tasks-empty')).toHaveCount(0)
      const projectIds = await collect(projects, product.getByTestId('home-projects-previous'), product.getByTestId('home-projects-next'), policy.projects, PREVIEW_HOME.projectPage)
      const taskIds = await collect(tasks, product.getByTestId('home-tasks-previous'), product.getByTestId('home-tasks-next'), policy.tasks, PREVIEW_HOME.taskPage)
      expect(await product.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      Object.assign(observation, { projectIds, taskIds })
      if (['home-empty', 'home-no-tasks', 'home-dense', 'home-long-content', 'home-cross-batch'].includes(entry.id)) await product.screenshot({ path: testInfo.outputPath(entry.id + '.png') })
      if (entry.id === 'home-empty') {
        await expectHomeTasksHidden()
        await product.screenshot({ path: testInfo.outputPath('home-empty-no-tasks.png') })
      }
      if (entry.id === 'home-cross-batch') {
        await product.getByTestId('home-task-preview-session-' + policy.tasks).click()
        await expect(product.getByTestId('composer-input')).toBeEditable()
        await product.getByRole('button', { name: layoutZh.back, exact: true }).click()
        await expect(product.getByTestId('project-center')).toBeVisible()
        await expect(tasks).toHaveCount(PREVIEW_HOME.taskPage)
      }
    }
    expect(errors).toEqual([])
    await product.screenshot({ path: testInfo.outputPath('project-center-matrix-complete.png') })
  } finally {
    writeFileSync(testInfo.outputPath('project-center-observations.json'), JSON.stringify(observations, null, 2))
    writeFileSync(testInfo.outputPath('project-center-errors.json'), JSON.stringify(errors, null, 2))
  }
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

test('native shared example reads public project files and creates a genuinely empty project', async ({}, testInfo) => {
  const definition = resolveExample().projects[0]
  await scenario('page-home', 'home-states')
  await product.getByTestId('home-project-设计协作项目').click()
  await product.getByTestId('project-library').click()
  await product.getByTestId('project-library-explorer').click()
  for (const file of definition.files) await expect(product.getByTestId('explorer-node-' + file.path)).toBeVisible()
  await expect(product.locator('[data-testid^="explorer-node-"]')).toHaveCount(definition.files.length)
  await product.getByTestId('explorer-select-sample.md').click()
  await product.getByRole('button', { name: '进入完整视图', exact: true }).click()
  await expect(product.getByTestId('markdown-preview').getByRole('heading', { name: 'Synthetic editor first target', exact: true })).toBeVisible()
  await product.screenshot({ path: testInfo.outputPath('native-shared-example-document.png') })

  await scenario('page-home', 'home-empty')
  await product.getByTestId('home-project-create-empty').click()
  const name = '共享示例真实空项目'
  await product.getByTestId('project-create-name').fill(name)
  await product.getByTestId('project-create').click()
  await expect(product.getByTestId('project-new-modal')).toHaveCount(0)
  await expect(product.getByRole('navigation', { name: layoutZh.tasks, exact: true }).getByRole('button', { name, exact: true })).toBeVisible()
  await product.getByTestId('project-library').click()
  await product.getByTestId('project-library-explorer').click()
  await expect(product.getByTestId('explorer-tree')).toBeVisible()
  await expect(product.locator('[data-testid^="explorer-node-"]')).toHaveCount(0)
  const stateUrl = new URL('/__preview/state', manifest.origin)
  stateUrl.searchParams.set('previewInstance', manifest.instance)
  const stateResponse = await product.request.get(stateUrl.href)
  expect(stateResponse.ok()).toBe(true)
  const state = await stateResponse.json()
  expect(state.projects).toHaveLength(1)
  const treeUrl = new URL('/api/content/projects/' + state.projects[0].id + '/tree', manifest.origin)
  treeUrl.searchParams.set('previewInstance', manifest.instance)
  const treeResponse = await product.request.get(treeUrl.href)
  expect(treeResponse.ok()).toBe(true)
  const tree = await treeResponse.json()
  expect(tree.total).toBe(0)
  expect(tree.nodes).toEqual([])
  await product.screenshot({ path: testInfo.outputPath('native-shared-example-empty-project.png') })
  writeFileSync(testInfo.outputPath('shared-example-observations.json'), JSON.stringify({ selection: resolveExample().selection, contentDigest: resolveExample().contentDigest, expectedFiles: definition.files.map(file => ({ id: file.id, path: file.path, sha256: file.sha256 })), createdProject: state.projects[0], tree }, null, 2))
})

test('native project center creates from empty, edits, pins and archives across page boundaries', { timeout: 90_000 }, async ({}, testInfo) => {
  const errors = []
  const submissions = []
  product.on('pageerror', error => errors.push(error.message))
  product.on('request', request => {
    if (new URL(request.url()).pathname === '/api/content/projects' && request.method() === 'POST') submissions.push(request.postDataJSON())
  })
  const stateUrl = new URL('/__preview/state', manifest.origin)
  stateUrl.searchParams.set('previewInstance', manifest.instance)
  const snapshot = async () => {
    const response = await product.request.get(stateUrl.href)
    expect(response.ok()).toBe(true)
    return response.json()
  }
  await scenario('page-home', 'home-empty')
  await product.getByTestId('home-project-create-empty').click()
  const form = product.getByTestId('project-new-modal')
  const input = product.getByTestId('project-create-name')
  const create = product.getByTestId('project-create')
  const cancel = form.getByRole('button', { name: componentsZh.project.cancel, exact: true })
  await create.click()
  await expect(form.getByText(componentsZh.project.required, { exact: true }).first()).toBeVisible()
  await expect(input).toBeEnabled()
  expect(submissions).toEqual([])
  await input.fill('取消创建的模拟项目')
  await cancel.click()
  await expect(form).toHaveCount(0)
  expect((await snapshot()).projects).toEqual([])
  expect(submissions).toEqual([])
  await product.getByTestId('home-project-create-empty').click()
  const createdName = '原生空态创建项目'
  await input.fill(createdName)
  const isOperation = url => url.pathname.startsWith('/api/content/operations/')
  const releaseOperation = await holdNativeRead(isOperation)
  const accepted = product.waitForResponse(response => new URL(response.url()).pathname === '/api/content/projects' && response.request().method() === 'POST')
  const polling = product.waitForRequest(request => request.method() === 'GET' && isOperation(new URL(request.url())))
  try {
    await create.click()
    const response = await accepted
    expect(response.status()).toBe(202)
    const receipt = await response.json()
    expect(receipt.operation).toBeTruthy()
    expect(new URL((await polling).url()).pathname).toBe('/api/content/operations/' + receipt.operation)
    await expect(create).toBeDisabled()
    await expect(input).toBeDisabled()
    await expect(cancel).toBeDisabled()
    expect(submissions).toEqual([expect.objectContaining({ name: createdName })])
    await product.screenshot({ path: testInfo.outputPath('native-project-awaiting-operation.png') })
  } finally {
    await releaseOperation()
  }
  await expect(product.getByTestId('project-new-modal')).toHaveCount(0)
  await expect(product.getByRole('navigation', { name: layoutZh.tasks, exact: true }).getByRole('button', { name: createdName, exact: true })).toBeVisible()
  await product.getByRole('button', { name: layoutZh.back, exact: true }).click()
  await expect(product.getByTestId('home-project-' + createdName)).toBeVisible()
  await expectHomeTasksHidden()
  const created = await snapshot()
  expect(created.projects).toHaveLength(1)
  expect(created.sessions).toHaveLength(0)
  await product.screenshot({ path: testInfo.outputPath('native-created-from-empty.png') })
  await reloadCenter(() => controls.getByRole('button', { name: zh.reload, exact: true }).click())
  await expect(product.getByTestId('home-project-' + createdName)).toBeVisible()
  expect((await snapshot()).projects).toEqual(created.projects)
  await reloadCenter(() => controls.getByRole('button', { name: zh.reset, exact: true }).click())
  await expect(product.getByTestId('home-projects-empty')).toBeVisible()
  await expectHomeTasksHidden()
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
  await expect(product.getByRole('navigation', { name: layoutZh.tasks, exact: true }).getByRole('button', { name: renamed, exact: true })).toBeVisible()
  await product.getByRole('button', { name: layoutZh.back, exact: true }).click()
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
  const native = await app.browserWindow(product)
  await native.evaluate((window, size) => window.setSize(size.width, size.height), WORKSPACE_WINDOW_SIZE)
  await expect.poll(() => product.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(WORKSPACE_WINDOW_SIZE)
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
    await expectHomeTasksHidden()
    await expect(product.locator('html')).toHaveAttribute('data-theme', theme)
    const center = await projectCenterAppearance(product, 'center')
    expect(center.environment).toMatchObject(WORKSPACE_WINDOW_SIZE)
    await product.screenshot({ path: testInfo.outputPath('pdfe-center-' + theme + '-' + language + '.png') })
    await openHomeProjectForm()
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
      await expectHomeTasksHidden()
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

async function conversationUi(testInfo, sceneId, action, dictionary = zh) {
  const observation = { requests: [], streams: [], diagnostics: [], invalidDiagnostics: [], interruptions: 0 }
  const identity = request => {
    const url = new URL(request.url())
    const match = url.pathname.match(CONVERSATION_EXPECTED.route)
    return match ? { action: match[2], sessionId: decodeURIComponent(match[1]), fromSeq: Number(url.searchParams.get('from_seq')) } : null
  }
  product.on('request', request => {
    const entry = identity(request)
    if (entry) observation.requests.push({ ...entry, method: request.method(),
      ...(entry.action === 'turns' && request.method() === 'POST' ? { body: request.postData() } : {}),
    })
  })
  for (const stage of ['requestfinished', 'requestfailed']) product.on(stage, request => {
    const entry = identity(request)
    if (entry?.action === 'events') observation.streams.push({ ...entry, stage, error: request.failure()?.errorText })
  })
  product.on('response', response => {
    if (identity(response.request())?.action === 'interrupt' && response.status() === 200) observation.interruptions += 1
  })
  product.on('console', message => {
    if (!message.text().startsWith(CONVERSATION_EXPECTED.diagnostic)) return
    try {
      const { stage, sessionId, sequence, reason, attempt, delayMs } = JSON.parse(message.text().slice(CONVERSATION_EXPECTED.diagnostic.length))
      observation.diagnostics.push({ stage, sessionId, sequence, reason, attempt, delayMs })
    } catch { observation.invalidDiagnostics.push('invalid-session-stream-diagnostic') }
  })
  try {
    await normalUi(testInfo, async () => {
      await scenario('page-conversation', sceneId, dictionary)
      await controls.getByRole('button', { name: dictionary.close, exact: true }).click()
      await expect(product.getByTestId('composer-input')).toBeVisible()
      await action(observation)
      expect(observation.invalidDiagnostics).toEqual([])
    })
  } finally {
    writeFileSync(testInfo.outputPath('conversation-observations.json'), JSON.stringify(observation, null, 2))
  }
}

function conversationResponse(action) {
  return product.waitForResponse(response => new URL(response.url()).pathname.match(CONVERSATION_EXPECTED.route)?.[2] === action && response.request().method() === 'POST')
}

async function conversationInspection(sessionId) {
  const responses = await Promise.all(['/api/serve/history/' + encodeURIComponent(sessionId), '/api/serve/sessions/' + encodeURIComponent(sessionId) + '/navigation'].map(path => {
    const url = new URL(path, manifest.origin)
    url.searchParams.set('previewInstance', manifest.instance)
    return product.request.get(url.href)
  }))
  for (const response of responses) expect(response.status()).toBe(200)
  const [history, snapshot] = await Promise.all(responses.map(response => response.json()))
  return { history, snapshot }
}

async function conversationAccepted(response) {
  expect(response.status()).toBe(200)
  const receipt = await response.json()
  expect(receipt).toMatchObject({ ok: true, accepted: true, turn_id: expect.any(String) })
  expect(receipt.turn_id).toBeTruthy()
  return { sessionId: decodeURIComponent(new URL(response.url()).pathname.match(CONVERSATION_EXPECTED.route)[1]), turnId: receipt.turn_id }
}

async function conversationSend(question) {
  const observation = { question, accepted: null }
  const input = product.getByTestId('composer-input')
  try {
    await input.fill(question)
    await expect(input).toHaveValue(question)
    await expect(product.getByTestId('composer-send')).toBeEnabled()
    const [response] = await Promise.all([
      conversationResponse('turns'),
      product.getByTestId('composer-send').click(),
    ])
    const submitted = response.request().postDataJSON()
    observation.input = submitted.input
    expect(submitted.input.filter(item => item.type === 'text')).toEqual([{ type: 'text', text: question }])
    observation.accepted = await conversationAccepted(response)
    await expect(product.getByTestId('user-bubble').getByText(question, { exact: true })).toHaveCount(1)
    const { history } = await conversationInspection(observation.accepted.sessionId)
    observation.historyTurns = history.turns.filter(turn => turn.kind === 'user' && turn.turn_id === observation.accepted.turnId)
    expect(observation.historyTurns).toHaveLength(1)
    expect(observation.historyTurns[0].text).toBe(question)
    return observation.accepted
  } catch (error) {
    try {
      observation.inputValue = await input.inputValue()
      observation.bubbles = await product.getByTestId('user-bubble').allTextContents()
      if (observation.accepted && !observation.historyTurns) {
        const { history } = await conversationInspection(observation.accepted.sessionId)
        observation.historyTurns = history.turns.filter(turn => turn.kind === 'user' && turn.turn_id === observation.accepted.turnId)
      }
    } catch (error) { observation.diagnosticError = String(error) }
    try {
      writeFileSync(test.info().outputPath(`conversation-send-${Date.now()}.json`), JSON.stringify(observation, null, 2))
    } catch (diagnosticError) { console.warn('Could not write conversation send diagnostics', diagnosticError) }
    throw error
  }
}

async function conversationStop() {
  await expect(product.getByTestId('composer-stop')).toBeEnabled()
  const interrupting = conversationResponse('interrupt')
  await product.getByTestId('composer-stop').click()
  const response = await interrupting
  expect(response.status()).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true })
  await expect(product.getByTestId('composer-stop')).not.toBeVisible()
  await expect(product.getByText(componentsZh.stream.stopped, { exact: true }).first()).toBeVisible()
}

async function conversationHistory(sessionId, action) {
  await action()
  await expect(product.getByTestId('composer-input')).toBeVisible()
  if (await product.getByTestId('workspace-conversation').getAttribute('data-content-collapsed') === 'true') await product.getByTestId('workspace-expand-messages').click()
  return (await conversationInspection(sessionId)).history
}

test('native conversation diagnostics preserve two-turn history and reset sanitized metadata', { annotation: previewConsumption('page-conversation', 'conversation-stream', ['completed']) }, async ({}, testInfo) => {
  await conversationUi(testInfo, 'conversation-stream', async observation => {
    const questions = ['模拟诊断私有正文第一轮', '模拟诊断私有正文第二轮']
    const answer = PREVIEW_CONVERSATION.normalChunks.join('')
    const turns = []
    for (const [index, question] of questions.entries()) {
      turns.push(await conversationSend(question))
      await expect(product.getByText(answer, { exact: true })).toHaveCount(index + 1)
      await expect(product.getByTestId('composer-stop')).not.toBeVisible()
      await expect(product.getByTestId('composer-send')).toBeDisabled()
    }
    expect(turns[1].sessionId).toBe(turns[0].sessionId)
    expect(turns[1].turnId).not.toBe(turns[0].turnId)
    const consistent = history => {
      expect(history.turns.filter(turn => turn.role === 'user')).toHaveLength(questions.length)
      expect(history.turns.filter(turn => turn.role === 'assistant' && turn.kind === 'text')).toHaveLength(questions.length)
      for (const [index, turn] of turns.entries()) {
        expect(history.turns.filter(item => item.role === 'user' && item.text === questions[index])).toHaveLength(1)
        expect(history.turns.filter(item => item.role === 'assistant' && item.turn_id === turn.turnId && item.text === answer)).toHaveLength(1)
        expect(history.activity_events.filter(event => event.turn_id === turn.turnId && event.type === 'turn_completed')).toHaveLength(1)
      }
    }
    await workspaceShortcut('F8')
    const diagnostics = async filename => {
      await controls.getByRole('button', { name: zh.tools, exact: true }).click()
      await controls.getByRole('button', { name: zh.refresh, exact: true }).click()
      const output = controls.getByTestId('preview-diagnostic-history')
      await expect(output).toBeVisible()
      const serialized = await output.innerText()
      const value = JSON.parse(serialized)
      expect(value).toMatchObject({ requests: expect.any(Array), events: expect.any(Array), files: expect.any(Array) })
      expect(value.requests.every(request => !request.path.includes('?'))).toBe(true)
      for (const question of questions) expect(serialized).not.toContain(question)
      for (const request of value.requests.filter(request => request.method === 'POST' && request.path.endsWith('/turns'))) {
        expect(Object.keys(request).sort()).toEqual(['durationMs', 'method', 'outcome', 'path', 'sequence', 'status'])
        expect(request).toMatchObject({ status: 200, outcome: 'completed' })
        expect(request.durationMs).toBeGreaterThanOrEqual(0)
      }
      await output.scrollIntoViewIfNeeded()
      await controls.screenshot({ path: testInfo.outputPath(filename + '.png') })
      writeFileSync(testInfo.outputPath(filename + '.json'), JSON.stringify(value, null, 2))
      await controls.keyboard.press('Escape')
      return value
    }
    const original = await diagnostics('diagnostics-sanitized')
    expect(original.requests.filter(request => request.method === 'POST' && request.path.endsWith('/turns'))).toHaveLength(2)
    for (const turn of turns) {
      const completed = original.events.filter(event => event.type === 'turn_completed' && event.turn_id === turn.turnId)
      expect(completed).toHaveLength(1)
      expect(completed[0]).toMatchObject({ session_id: turn.sessionId, seq: expect.any(Number) })
    }
    consistent(await conversationReenter(turns[0].sessionId))
    const restored = await conversationHistory(turns[0].sessionId, () => product.reload())
    consistent(restored)
    const resetCursor = restored.activity_events.at(-1).seq
    for (const question of questions) await expect(product.getByTestId('user-bubble').getByText(question, { exact: true })).toHaveCount(1)
    await expect(product.getByText(answer, { exact: true })).toHaveCount(2)
    await expect(product.getByTestId('composer-stop')).not.toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('conversation-two-turns-reloaded.png') })
    expect(observation.diagnostics.filter(entry => entry.stage === 'retry')).toEqual([])
    await Promise.all([
      product.waitForEvent('framenavigated', frame => frame === product.mainFrame()),
      controls.waitForEvent('framenavigated', frame => frame === controls.mainFrame()),
      controls.getByRole('button', { name: zh.reset, exact: true }).click(),
    ])
    await expect(product.getByTestId('composer-input')).toBeVisible()
    await expect(product.getByTestId('user-bubble')).toHaveCount(0)
    await expect(product.getByText(answer, { exact: true })).toHaveCount(0)
    const reset = await diagnostics('diagnostics-reset')
    expect(reset.requests.filter(request => request.method === 'POST' && request.path.endsWith('/turns'))).toHaveLength(0)
    expect(reset.events.some(event => turns.some(turn => turn.turnId === event.turn_id))).toBe(false)
    const freshQuestion = '重置后的独立模拟回合'
    const fresh = await conversationSend(freshQuestion)
    expect(turns.some(turn => turn.turnId === fresh.turnId)).toBe(false)
    await expect(product.getByText(answer, { exact: true })).toHaveCount(1)
    await expect(product.getByTestId('composer-stop')).not.toBeVisible()
    const current = await conversationInspection(fresh.sessionId)
    expect(current.history.turns.filter(turn => turn.role === 'user')).toEqual([expect.objectContaining({ text: freshQuestion })])
    expect(current.history.activity_events.some(event => turns.some(turn => turn.turnId === event.turn_id))).toBe(false)
    expect(observation.requests.filter(request => request.action === 'turns' && request.method === 'POST')).toHaveLength(3)
    expect(observation.interruptions).toBe(0)
    const resetRetries = observation.diagnostics.filter(entry => entry.stage === 'retry')
    expect(resetRetries.length).toBeLessThanOrEqual(1)
    for (const retry of resetRetries) expect(retry).toMatchObject({ reason: 'transport', sessionId: turns[0].sessionId, sequence: resetCursor, attempt: 1 })
    await product.screenshot({ path: testInfo.outputPath('conversation-reset-fresh-turn.png') })
  })
})

async function conversationReenter(sessionId, labels = { home: conversationZh.header.home, back: layoutZh.back }) {
  const home = product.getByRole('button', { name: labels.home, exact: true })
  if (await home.isVisible()) await home.click()
  else await product.getByRole('button', { name: labels.back, exact: true }).click()
  await expect(product.getByTestId('project-center')).toBeVisible()
  return conversationHistory(sessionId, () => product.getByTestId('home-task-' + sessionId).click())
}

function conversationInterrupted(history, turnId, prefix) {
  expect(history.turn_activity.find(turn => turn.turn_id === turnId)?.outcome).toBe('interrupted')
  const events = history.activity_events.filter(event => event.turn_id === turnId)
  const terminal = events.filter(event => event.type === 'turn_interrupted')
  expect(terminal).toHaveLength(1)
  expect(events.filter(event => event.type === 'turn_completed')).toEqual([])
  expect(events.filter(event => event.type === 'message_delta' && event.seq > terminal[0].seq)).toEqual([])
  const answers = history.turns.filter(turn => turn.turn_id === turnId && turn.role === 'assistant' && turn.kind === 'text')
  expect(answers).toHaveLength(1)
  expect(answers[0].text).toContain(CONVERSATION_EXPECTED.prefix)
  expect(answers[0].text).not.toContain(CONVERSATION_EXPECTED.suffix)
  expect(answers[0].text.trim()).toBe(prefix.trim())
}

test('native long stream cancellation persists its interrupted answer through actual product reentry', { annotation: previewConsumption('page-conversation', 'conversation-cancel', ['streaming', 'cancelling', 'cancelled']) }, async ({}, testInfo) => {
  await conversationUi(testInfo, 'conversation-cancel', async observation => {
    const firstQuestion = '停止模拟长流后重新进入'
    const first = await conversationSend(firstQuestion)
    const answers = product.locator('.answer-annotation-root').filter({ hasText: CONVERSATION_EXPECTED.prefix })
    await expect(answers).toHaveCount(1)
    await expect(answers.first()).toBeVisible()
    await expect(product.getByTestId('composer-stop')).toBeEnabled()
    await expect(product.getByText(CONVERSATION_EXPECTED.suffix, { exact: false })).not.toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('conversation-long-streaming.png') })
    await conversationStop()
    const firstPrefix = await answers.first().innerText()
    conversationInterrupted(await conversationReenter(first.sessionId), first.turnId, firstPrefix)
    await expect(answers).toHaveCount(1)
    await expect(answers.first()).toHaveText(firstPrefix)
    await expect(product.getByTestId('user-bubble').getByText(firstQuestion, { exact: true })).toHaveCount(1)
    const secondQuestion = '中断后第二轮模拟长流'
    const second = await conversationSend(secondQuestion)
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.turnId).not.toBe(first.turnId)
    await expect(answers).toHaveCount(2)
    await expect(answers.first()).toHaveText(firstPrefix)
    await conversationStop()
    const secondPrefix = await answers.nth(1).innerText()
    const history = await conversationHistory(first.sessionId, () => product.reload())
    conversationInterrupted(history, first.turnId, firstPrefix)
    conversationInterrupted(history, second.turnId, secondPrefix)
    await expect(answers).toHaveCount(2)
    await expect(answers.first()).toHaveText(firstPrefix)
    await expect(answers.nth(1)).toHaveText(secondPrefix)
    for (const question of [firstQuestion, secondQuestion]) await expect(product.getByTestId('user-bubble').getByText(question, { exact: true })).toHaveCount(1)
    await expect(product.getByTestId('composer-stop')).not.toBeVisible()
    expect(observation.interruptions).toBe(2)
    await product.screenshot({ path: testInfo.outputPath('conversation-cancelled-reloaded.png') })
  })
})

test('native failed conversation resumes its closed stream without duplicate turns or answers', { annotation: previewConsumption('page-conversation', 'conversation-recovery', ['disconnected', 'reconnecting', 'failed', 'recovered']) }, async ({}, testInfo) => {
  await conversationUi(testInfo, 'conversation-recovery', async observation => {
    const question = '模拟断流后继续当前任务'
    const first = await conversationSend(question)
    await expect(product.getByTestId('turn-recoverable-notice')).toContainText(conversationZh.failure.interrupted.message)
    await expect(product.getByTestId('turn-continue')).toBeEnabled()
    await expect(product.getByTestId('composer-stop')).not.toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('conversation-failed-before-retry.png') })
    const streams = () => observation.requests.filter(entry => entry.action === 'events' && entry.sessionId === first.sessionId)
    const previousRequests = streams().length
    const retrying = conversationResponse('turns')
    await product.getByTestId('turn-continue').click()
    const retried = await conversationAccepted(await retrying)
    expect(retried.sessionId).toBe(first.sessionId)
    expect(retried.turnId).not.toBe(first.turnId)
    const reconnecting = product.getByText(conversationZh.runtime.transportRetrying, { exact: true })
    await expect(reconnecting).toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('conversation-reconnecting.png') })
    const retries = () => observation.diagnostics.filter(entry => entry.sessionId === first.sessionId && entry.stage === 'retry' && entry.reason === 'transport')
    await expect.poll(() => retries().length).toBe(1)
    await expect.poll(() => streams().length).toBeGreaterThan(previousRequests)
    const answer = product.locator('.answer-annotation-root').filter({ hasText: CONVERSATION_EXPECTED.answer })
    await expect(answer).toHaveCount(1)
    await expect(answer).toBeVisible()
    await expect(product.getByTestId('composer-stop')).not.toBeVisible()
    await expect(reconnecting).not.toBeVisible()
    const diagnostic = retries()[0]
    expect(streams().at(-1).fromSeq).toBeGreaterThan(streams()[0].fromSeq)
    expect(streams().at(-1).fromSeq).toBe(diagnostic.sequence)
    expect(observation.diagnostics.some(entry => entry.sessionId === first.sessionId && entry.stage === 'live' && entry.sequence >= diagnostic.sequence)).toBe(true)
    const visibleAnswer = await answer.innerText()
    const consistent = history => {
      expect(history.turn_activity.find(turn => turn.turn_id === first.turnId)?.outcome).toBe('failed')
      expect(history.turn_activity.find(turn => turn.turn_id === retried.turnId)?.outcome).toBe('completed')
      for (const text of [question, componentsZh.stream.continueTaskPrompt]) expect(history.turns.filter(turn => turn.role === 'user' && turn.text === text)).toHaveLength(1)
      const answers = history.turns.filter(turn => turn.role === 'assistant' && turn.kind === 'text' && turn.turn_id === retried.turnId)
      expect(answers).toHaveLength(1)
      const deltas = history.activity_events.filter(event => event.turn_id === retried.turnId && event.type === 'message_delta')
      expect(deltas.length).toBeGreaterThan(1)
      expect(new Set(deltas.map(event => event.seq)).size).toBe(deltas.length)
      for (const [index, event] of deltas.entries()) if (index > 0) expect(event.data.delta.startsWith(deltas[index - 1].data.delta)).toBe(true)
      expect(deltas.at(-1).data.delta).toBe(answers[0].text)
      expect(history.activity_events.filter(event => event.turn_id === retried.turnId && event.type === 'turn_completed')).toHaveLength(1)
    }
    consistent(await conversationReenter(first.sessionId))
    await expect(answer).toHaveCount(1)
    await expect(answer).toHaveText(visibleAnswer)
    consistent(await conversationHistory(first.sessionId, () => product.reload()))
    await expect(answer).toHaveCount(1)
    await expect(answer).toHaveText(visibleAnswer)
    for (const text of [question, componentsZh.stream.continueTaskPrompt]) await expect(product.getByTestId('user-bubble').getByText(text, { exact: true })).toHaveCount(1)
    await expect(product.getByTestId('composer-stop')).not.toBeVisible()
    await expect(product.getByTestId('turn-continue-error')).not.toBeVisible()
    await expect(reconnecting).not.toBeVisible()
    expect(observation.requests.filter(entry => entry.action === 'turns' && entry.method === 'POST')).toHaveLength(2)
    await product.screenshot({ path: testInfo.outputPath('conversation-recovered-reloaded.png') })
  })
})

async function openNativeReview(sceneId = 'viewer-review-states') {
  await scenario('viewer-review', sceneId)
  await expect(product.getByTestId('preview-panel-open')).toHaveCount(0)
  await product.getByRole('navigation', { name: layoutZh.tasks, exact: true }).getByRole('button', { name: '设计协作演示', exact: true }).click()
  const card = product.locator('[data-testid^="review-card-open-"]')
  await expect(card).toHaveCount(1)
  const loaded = product.waitForResponse(response => /\/api\/resource\/review-batches\/[^/]+$/.test(new URL(response.url()).pathname) && response.request().method() === 'GET')
  await card.click()
  const batch = await (await loaded).json()
  expect(batch.members).toHaveLength(1)
  expect(batch.members[0].path).toBe('readme.md')
  await product.getByTestId('workspace-full').click()
  await expect(product.getByTestId('review-batch')).toBeInViewport()
  await expect(product.getByTestId('review-diff').contentFrame().locator('.original .view-lines')).toContainText('Minimal Project')
  return batch
}

function nativeReviewSubmission(batch) {
  return product.waitForResponse(response => new URL(response.url()).pathname === `/api/resource/review-batches/${batch.id}/commit` && response.request().method() === 'POST')
}

for (const action of ['accept', 'reject', 'revise']) {
  const state = { accept: 'accepted', reject: 'rejected', revise: 'revised' }[action]
  test('native review decision lifecycle: ' + action, { annotation: previewConsumption('viewer-review', 'viewer-review-states', ['pending', state]) }, async ({}, testInfo) => {
    await normalUi(testInfo, async () => {
      const batch = await openNativeReview()
      const modified = product.getByTestId('review-diff').contentFrame().locator('.modified .view-lines')
      await expect(modified).toContainText('Revision notes')
      const marker = 'UI-reviewed revision text'
      if (action === 'revise') {
        await modified.click()
        await product.keyboard.press('ControlOrMeta+End')
        await product.keyboard.press('End')
        await product.keyboard.type(`\n${marker}`)
        await expect(modified).toContainText(marker)
      }
      await product.getByTestId('review-file-' + action).click()
      await expect(product.getByTestId('review-file-' + action)).toHaveAttribute('aria-pressed', 'true')
      if (action === 'reject') await expect(modified).not.toContainText('Revision notes')
      await product.screenshot({ path: testInfo.outputPath('review-decision.png') })
      const submitted = nativeReviewSubmission(batch)
      await product.getByTestId('review-batch-actions').getByRole('button', { name: '提交', exact: true }).click()
      const response = await submitted
      expect(response.status()).toBe(200)
      const request = response.request().postDataJSON()
      expect(request.decisions).toHaveLength(1)
      expect(request.decisions[0].action).toBe(action)
      expect(request.decisions[0].file_id).toBe(batch.members[0].file_id)
      if (action === 'revise') expect(Buffer.from(request.decisions[0].revised_content, 'base64').toString()).toContain(marker)
      const result = await response.json()
      expect(result.batch.state).toBe('completed')
      expect(result.batch.members[0].action).toBe(action)
      await expect(product.getByTestId('review-batch')).not.toBeVisible()
      await expect(product.getByTestId('project-workspace')).toBeVisible()
      await product.screenshot({ path: testInfo.outputPath('review-completed.png') })
    })
  })
}

test('native review failed submission retains its decision through explicit retry', { annotation: previewConsumption('viewer-review', 'viewer-review-failed', ['pending', 'failed', 'retried']) }, async ({}, testInfo) => {
  await normalUi(testInfo, async () => {
    const batch = await openNativeReview('viewer-review-failed')
    await product.getByTestId('review-file-accept').click()
    const failed = nativeReviewSubmission(batch)
    await product.getByTestId('review-batch-actions').getByRole('button', { name: '提交', exact: true }).click()
    const failure = await (await failed).json()
    expect(failure.batch.state).toBe('failed')
    expect(failure.results[0].error).toBe('preview_review_apply_failed')
    await expect(product.getByText('部分文件未提交', { exact: true })).toBeVisible()
    await expect(product.getByTestId('review-file-accept')).toHaveAttribute('aria-pressed', 'true')
    await product.screenshot({ path: testInfo.outputPath('review-failed.png') })
    const retried = nativeReviewSubmission(batch)
    await product.getByRole('button', { name: '重试失败文件', exact: true }).click()
    expect((await (await retried).json()).batch.state).toBe('completed')
    await expect(product.getByTestId('review-batch')).not.toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('review-retried.png') })
  })
})

test('native review conflict revises the current disk content', { annotation: previewConsumption('viewer-review', 'viewer-review-conflict', ['pending', 'conflict']) }, async ({}, testInfo) => {
  await normalUi(testInfo, async () => {
    const batch = await openNativeReview('viewer-review-conflict')
    await expect(product.getByText('文件在 Agent 完成后又发生了变化', { exact: true })).toBeVisible()
    const modified = product.getByTestId('review-diff').contentFrame().locator('.modified .view-lines')
    await expect(modified).not.toContainText('Revision notes')
    await expect(product.getByTestId('review-file-revise')).toBeEnabled()
    await product.getByTestId('review-file-revise').click()
    await expect(product.getByTestId('review-preview-source')).toContainText('当前磁盘')
    await product.screenshot({ path: testInfo.outputPath('review-conflict.png') })
    const submitted = nativeReviewSubmission(batch)
    await product.getByTestId('review-batch-actions').getByRole('button', { name: '提交', exact: true }).click()
    const result = await (await submitted).json()
    expect(result.batch.state).toBe('completed')
    expect(result.batch.members[0].action).toBe('revise')
    await expect(product.getByTestId('review-batch')).not.toBeVisible()
    await expect(product.getByRole('heading', { name: 'Revision notes', exact: true })).not.toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('review-conflict-completed.png') })
  })
})

async function conversationTool() {
  const process = product.getByTestId('turn-process-trigger')
  if (await process.count() && await process.getAttribute('aria-expanded') !== 'true') await process.click()
  const activity = product.getByTestId('turn-activity-trigger')
  await expect(activity).toBeVisible()
  if (await activity.getAttribute('aria-expanded') !== 'true') await activity.click()
  const tool = product.getByTestId('tool-run-step')
  await expect(tool).toHaveCount(1)
  const toggle = tool.getByRole('button').first()
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  return tool
}

function conversationToolHistory(history, turnId, status, output, itemId) {
  const tools = history.turns.filter(item => item.turn_id === turnId && item.kind === 'tool')
  expect(tools).toHaveLength(1)
  expect(tools[0]).toMatchObject({ item_id: itemId, tool: PREVIEW_CONVERSATION.toolName, input: PREVIEW_CONVERSATION.toolInput, status, output })
  const events = history.activity_events.filter(event => event.turn_id === turnId)
  const started = events.filter(event => event.type === 'tool_started')
  expect(started).toHaveLength(1)
  expect(started[0]).toMatchObject({ item_id: itemId, data: { tool_id: itemId } })
  const completed = events.filter(event => event.type === 'tool_completed')
  expect(completed).toHaveLength(status === 'cancelled' ? 0 : 1)
  if (status !== 'cancelled') expect(completed[0].data).toMatchObject({ tool_id: itemId, success: status === 'done', output })
  const terminal = events.filter(event => ['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type))
  expect(terminal).toHaveLength(1)
  expect(terminal[0].type).toBe(status === 'cancelled' ? 'turn_interrupted' : 'turn_completed')
  expect(history.turn_activity.find(turn => turn.turn_id === turnId)?.outcome).toBe(status === 'cancelled' ? 'interrupted' : 'completed')
  expect(events.filter(event => event.seq > terminal[0].seq && ['tool_output_delta', 'tool_completed', 'message_delta'].includes(event.type))).toEqual([])
}

for (const status of ['done', 'error', 'cancelled']) {
  const failed = status === 'error'
  const sceneId = failed ? 'conversation-tool-failed' : 'conversation-tool-running'
  test('native tool lifecycle preserves live output and restored identity: ' + status, { annotation: previewConsumption('page-conversation', sceneId, status === 'cancelled' ? ['running', 'cancelled', 'reentered'] : failed ? ['running', 'failed', 'completed', 'reentered'] : ['running', 'completed', 'reentered']) }, async ({}, testInfo) => {
    if (failed) {
      await useDarkEnglishAppearance()
      await expect(controls.getByRole('heading', { name: en.title, exact: true })).toBeVisible()
    }
    await conversationUi(testInfo, sceneId, async observation => {
      if (failed) {
        const window = await app.browserWindow(product)
        await window.evaluate((window, minimum) => window.setSize(minimum.width, minimum.height), WORKSPACE_WINDOW_MINIMUM)
        await expect.poll(() => window.evaluate(window => window.getSize())).toEqual([WORKSPACE_WINDOW_MINIMUM.width, WORKSPACE_WINDOW_MINIMUM.height])
        await expect(product.locator('html')).toHaveAttribute('data-theme', 'dark')
        await expect(product.locator('html')).toHaveAttribute('lang', LOCALES.en.tag)
      }
      const dictionary = failed ? componentsEn : componentsZh
      const expectedStatus = status === 'done' ? dictionary.stream.ran : dictionary.stream.toolStatus[status]
      const chunks = failed ? PREVIEW_CONVERSATION.toolFailedOutputChunks : PREVIEW_CONVERSATION.toolOutputChunks
      const question = '核对模拟工具生命周期 ' + status
      const turn = await conversationSend(question)
      let tool = await conversationTool()
      await expect(tool.getByRole('button').first()).toContainText(dictionary.stream.toolStatus.running)
      await expect(tool.locator('[aria-hidden="false"]')).toContainText(PREVIEW_CONVERSATION.toolInput.path)
      await expect(tool.locator('[aria-hidden="false"]')).toContainText(chunks[0])
      const pending = await conversationInspection(turn.sessionId)
      expect(pending.snapshot).toMatchObject({ active_turn_id: turn.turnId, running: true })
      const tools = pending.history.turns.filter(item => item.turn_id === turn.turnId && item.kind === 'tool')
      expect(tools).toHaveLength(1)
      const itemId = tools[0].item_id
      expect(itemId).toBeTruthy()
      expect(tools[0]).toMatchObject({ tool: PREVIEW_CONVERSATION.toolName, input: PREVIEW_CONVERSATION.toolInput, status: 'pending', output: chunks[0] })
      expect(pending.history.activity_events.filter(event => event.turn_id === turn.turnId && ['tool_completed', 'turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type))).toEqual([])
      await expect(product.getByTestId('composer-stop')).toBeEnabled()
      await product.screenshot({ path: testInfo.outputPath('tool-running-prefix.png') })
      if (status === 'cancelled') await conversationStop()
      else {
        await expect(product.locator('.answer-annotation-root').filter({ hasText: failed ? PREVIEW_CONVERSATION.toolFailureAnswer : PREVIEW_CONVERSATION.toolSuccessAnswer })).toHaveCount(1)
        await expect(product.getByTestId('composer-stop')).not.toBeVisible()
      }
      const output = status === 'cancelled' ? chunks[0] : chunks.join('')
      const completed = await conversationInspection(turn.sessionId)
      expect(completed.snapshot).toMatchObject({ active_turn_id: null, running: false })
      conversationToolHistory(completed.history, turn.turnId, status, output, itemId)
      tool = await conversationTool()
      await expect(tool.getByRole('button').first()).toContainText(expectedStatus)
      if (failed) await tool.getByRole('button', { name: conversationEn.toolOutcome.technicalDetails, exact: true }).click()
      await expect(tool.locator('[aria-hidden="false"]')).toContainText(output)
      const completedOutput = tool.locator('pre').filter({ hasText: output })
      await expect(completedOutput).toHaveText(output)
      await completedOutput.scrollIntoViewIfNeeded()
      await expect(completedOutput).toBeInViewport({ ratio: 1 })
      await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('tool-terminal-output.png') })
      const restored = await conversationReenter(turn.sessionId, failed ? { home: conversationEn.header.home, back: layoutEn.back } : undefined)
      conversationToolHistory(restored, turn.turnId, status, output, itemId)
      tool = await conversationTool()
      const toggle = tool.getByRole('button').first()
      await expect(toggle).toContainText(expectedStatus)
      if (failed) {
        await toggle.click()
        await expect(toggle).toHaveAttribute('aria-expanded', 'false')
        await toggle.focus()
        await expect(toggle).toBeFocused()
        await toggle.press('Enter')
        await expect(toggle).toHaveAttribute('aria-expanded', 'true')
        const details = tool.getByRole('button', { name: conversationEn.toolOutcome.technicalDetails, exact: true })
        await details.scrollIntoViewIfNeeded()
        await details.focus()
        await expect(details).toBeFocused()
        await details.press('Enter')
        await expect(details).toHaveAttribute('aria-expanded', 'true')
        const box = await details.boundingBox()
        const viewport = await product.evaluate(() => ({ width: innerWidth, height: innerHeight }))
        expect(box).not.toBeNull()
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.y).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
      }
      await expect(tool.locator('[aria-hidden="false"]')).toContainText(output)
      const restoredOutput = tool.locator('pre').filter({ hasText: output })
      await expect(restoredOutput).toHaveText(output)
      await restoredOutput.scrollIntoViewIfNeeded()
      await expect(restoredOutput).toBeInViewport({ ratio: 1 })
      await expect(product.getByTestId('user-bubble').getByText(question, { exact: true })).toHaveCount(1)
      if (status === 'cancelled') await expect(product.locator('.answer-annotation-root').filter({ hasText: PREVIEW_CONVERSATION.toolSuccessAnswer })).toHaveCount(0)
      expect(observation.requests.filter(entry => entry.action === 'turns')).toHaveLength(1)
      expect(observation.interruptions).toBe(status === 'cancelled' ? 1 : 0)
      expect(observation.diagnostics.filter(entry => entry.stage === 'retry')).toEqual([])
      await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('tool-restored-output.png') })
      if (status === 'done') {
        conversationToolHistory(await conversationHistory(turn.sessionId, () => product.reload()), turn.turnId, status, output, itemId)
        tool = await conversationTool()
        await expect(tool).toHaveCount(1)
        await expect(tool.locator('[aria-hidden="false"]')).toContainText(PREVIEW_CONVERSATION.toolInput.path)
        const reloadedAnswer = product.getByText(PREVIEW_CONVERSATION.toolSuccessAnswer, { exact: true })
        await expect(reloadedAnswer).toHaveCount(1)
        await expect(reloadedAnswer).toBeVisible()
        const reloadedOutput = tool.locator('pre').filter({ hasText: output })
        await expect(reloadedOutput).toHaveText(output)
        await reloadedOutput.scrollIntoViewIfNeeded()
        await expect(reloadedOutput).toBeInViewport({ ratio: 1 })
        expect(observation.requests.filter(entry => entry.action === 'turns')).toHaveLength(1)
        await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('tool-reloaded-output.png') })
      }
    }, failed ? en : zh)
  })
}

test('native approval resumes the same request and turn through public reentry', { annotation: previewConsumption('page-conversation', 'conversation-approval-resume', ['waiting', 'approved', 'resumed', 'completed']) }, async ({}, testInfo) => {
  await conversationUi(testInfo, 'conversation-approval-resume', async observation => {
    const question = '同一审批请求与回合公开重入后继续'
    const turn = await conversationSend(question)
    const allow = product.locator('[data-hil-decision="allow-once"]')
    await expect(allow).toBeVisible()
    const waiting = await conversationInspection(turn.sessionId)
    expect(waiting.snapshot.active_turn_id).toBe(turn.turnId)
    expect(waiting.snapshot.pending_hil).toHaveLength(1)
    const requestId = waiting.snapshot.pending_hil[0].request_id
    await conversationReenter(turn.sessionId)
    await expect(allow).toHaveCount(1)
    await expect(product.getByTestId('user-bubble').getByText(question, { exact: true })).toHaveCount(1)
    expect((await conversationInspection(turn.sessionId)).snapshot.pending_hil[0].request_id).toBe(requestId)
    await product.screenshot({ path: testInfo.outputPath('approval-waiting-reentered.png') })
    const allowing = conversationResponse('hil/' + requestId)
    await allow.click()
    const response = await allowing
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, request_id: requestId, interaction: {
      request_id: requestId, turn_id: turn.turnId, session_id: turn.sessionId, state: 'resolved', decision: 'allow_once',
    } })
    await expect(allow).not.toBeVisible()
    await expect(product.getByTestId('composer-stop')).toBeEnabled()
    const answer = product.locator('.answer-annotation-root').filter({ hasText: PREVIEW_CONVERSATION.approvalAnswer })
    await expect(answer).toHaveCount(0)
    const resumed = await conversationInspection(turn.sessionId)
    expect(resumed.snapshot).toMatchObject({ active_turn_id: turn.turnId, running: true, pending_hil: [] })
    expect(resumed.history.activity_events.filter(event => event.turn_id === turn.turnId && ['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type))).toEqual([])
    expect(resumed.history.activity_events.some(event => event.turn_id === turn.turnId && event.type === 'session_state' && event.data.state === 'running' && event.seq > waiting.snapshot.last_seq)).toBe(true)
    await product.screenshot({ path: testInfo.outputPath('approval-resumed-same-turn.png') })
    await expect(answer).toHaveCount(1)
    await expect(product.getByTestId('composer-stop')).not.toBeVisible()
    const history = await conversationReenter(turn.sessionId)
    await expect(answer).toHaveCount(1)
    await expect(product.getByTestId('user-bubble').getByText(question, { exact: true })).toHaveCount(1)
    const completed = await conversationInspection(turn.sessionId)
    expect(completed.snapshot).toMatchObject({ active_turn_id: null, running: false, pending_hil: [], last_turn_id: turn.turnId })
    expect(history).toEqual(completed.history)
    const events = history.activity_events.filter(event => event.turn_id === turn.turnId)
    for (const type of ['hil_requested', 'hil_resolved', 'turn_completed']) expect(events.filter(event => event.type === type)).toHaveLength(1)
    for (const type of ['hil_requested', 'hil_resolved']) expect(events.find(event => event.type === type).data.request_id).toBe(requestId)
    expect(history.turns.filter(item => item.turn_id === turn.turnId && item.role === 'user')).toHaveLength(1)
    expect(observation.requests.filter(entry => entry.action === 'turns')).toHaveLength(1)
    expect(observation.requests.filter(entry => entry.action === 'hil/' + requestId)).toHaveLength(1)
    await product.screenshot({ path: testInfo.outputPath('approval-completed-reentered.png') })
  })
})

for (const decision of ['deny', 'cancel']) {
  test('native approval decision preserves terminal identity through reload: ' + decision, { annotation: previewConsumption('page-conversation', 'conversation-approval', decision === 'deny' ? ['waiting', 'rejected'] : ['waiting']) }, async ({}, testInfo) => {
    await conversationUi(testInfo, 'conversation-approval', async observation => {
      const question = '模拟审批决策 ' + decision
      const turn = await conversationSend(question)
      const allow = product.locator('[data-hil-decision="allow-once"]')
      await expect(allow).toBeVisible()
      const waiting = await conversationInspection(turn.sessionId)
      expect(waiting.snapshot).toMatchObject({ active_turn_id: turn.turnId, running: true })
      expect(waiting.snapshot.pending_hil).toHaveLength(1)
      const requestId = waiting.snapshot.pending_hil[0].request_id
      expect(requestId).toBeTruthy()
      await conversationReenter(turn.sessionId)
      await expect(allow).toHaveCount(1)
      expect((await conversationInspection(turn.sessionId)).snapshot.pending_hil[0].request_id).toBe(requestId)
      await product.screenshot({ path: testInfo.outputPath('approval-' + decision + '-waiting-reentered.png') })
      if (decision === 'deny') {
        const denying = conversationResponse('hil/' + requestId)
        await product.locator('[data-hil-decision="deny"]').click()
        const response = await denying
        expect(response.status()).toBe(200)
        expect(await response.json()).toMatchObject({ ok: true, request_id: requestId, interaction: { request_id: requestId, turn_id: turn.turnId, session_id: turn.sessionId, state: 'resolved', decision: 'deny' } })
        await expect(product.getByText(PREVIEW_CONVERSATION.denialAnswer, { exact: true })).toHaveCount(1)
      } else await conversationStop()
      await expect(allow).toHaveCount(0)
      await expect(product.getByTestId('composer-stop')).not.toBeVisible()
      await expect(product.getByText(PREVIEW_CONVERSATION.approvalAnswer, { exact: true })).toHaveCount(0)
      const consistent = async history => {
        const current = await conversationInspection(turn.sessionId)
        expect(current.snapshot).toMatchObject({ active_turn_id: null, running: false, pending_hil: [], last_turn_id: turn.turnId })
        expect(history).toEqual(current.history)
        const events = history.activity_events.filter(event => event.turn_id === turn.turnId)
        expect(events.filter(event => event.type === 'hil_requested')).toHaveLength(1)
        const resolved = events.filter(event => event.type === 'hil_resolved')
        expect(resolved).toHaveLength(1)
        expect(resolved[0].data).toMatchObject({ request_id: requestId, state: decision === 'deny' ? 'resolved' : 'cancelled' })
        if (decision === 'deny') expect(resolved[0].data.decision).toBe('deny')
        const terminal = events.filter(event => ['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type))
        expect(terminal).toHaveLength(1)
        expect(terminal[0].type).toBe(decision === 'deny' ? 'turn_completed' : 'turn_interrupted')
        expect(events.filter(event => ['tool_started', 'tool_completed'].includes(event.type))).toEqual([])
        expect(history.turns.filter(item => item.turn_id === turn.turnId && item.role === 'user' && item.text === question)).toHaveLength(1)
        expect(history.turns.filter(item => item.turn_id === turn.turnId && item.kind === 'tool')).toEqual([])
        await expect(product.getByTestId('user-bubble').getByText(question, { exact: true })).toHaveCount(1)
        await expect(product.locator('[data-hil-decision]')).toHaveCount(0)
        await expect(product.getByText(PREVIEW_CONVERSATION.approvalAnswer, { exact: true })).toHaveCount(0)
        await expect(product.getByText(PREVIEW_CONVERSATION.denialAnswer, { exact: true })).toHaveCount(decision === 'deny' ? 1 : 0)
      }
      await consistent(await conversationReenter(turn.sessionId))
      await consistent(await conversationHistory(turn.sessionId, () => product.reload()))
      expect(observation.requests.filter(entry => entry.action === 'turns')).toHaveLength(1)
      expect(observation.requests.filter(entry => entry.action === 'hil/' + requestId)).toHaveLength(decision === 'deny' ? 1 : 0)
      expect(observation.interruptions).toBe(decision === 'cancel' ? 1 : 0)
      expect(observation.diagnostics.filter(entry => entry.stage === 'retry')).toEqual([])
      await product.screenshot({ path: testInfo.outputPath('approval-' + decision + '-reloaded.png') })
    })
  })
}

test('native shared queue extraction retains the original Composer keyboard submission and stop path', { annotation: [
  previewConsumption('page-conversation', 'conversation-submit-pending', ['submitting', 'completed']),
  previewConsumption('page-conversation', 'conversation-cancel', ['streaming', 'cancelling', 'cancelled']),
] }, async ({}, testInfo) => {
  await conversationUi(testInfo, 'conversation-submit-pending', async observation => {
    await expect.poll(() => observation.requests.filter(entry => entry.action === 'events').length).toBeGreaterThan(0)
    const sessionId = observation.requests.find(entry => entry.action === 'events').sessionId
    const before = await conversationInspection(sessionId)
    const question = '受审提交中重复Enter不新增任务'
    await product.getByTestId('composer-input').fill(question)
    let release
    const held = new Promise(resolve => { release = resolve })
    const pending = []
    const matches = url => url.pathname.match(CONVERSATION_EXPECTED.route)?.[2] === 'turns'
    const hold = route => {
      const continued = (async () => {
        if (route.request().method() === 'POST') await held
        await route.continue()
      })()
      pending.push(continued)
      return continued
    }
    await product.route(matches, hold)
    const admitting = conversationResponse('turns')
    try {
      await product.getByTestId('composer-send').click()
      await expect.poll(() => pending.length).toBe(1)
      const button = product.getByTestId('composer-send')
      await expect(button).toHaveAttribute('data-state', 'submitting')
      await expect(button).toHaveAttribute('aria-busy', 'true')
      await expect(button).toBeDisabled()
      await product.getByTestId('composer-input').focus()
      await product.keyboard.press('Enter')
      await product.keyboard.press('Enter')
      const waiting = await conversationInspection(sessionId)
      expect(waiting.snapshot).toMatchObject({ active_turn_id: null, running: false })
      for (const field of ['turns', 'turn_activity', 'activity_events']) expect(waiting.history[field]).toEqual(before.history[field])
      expect(waiting.history.turns.some(turn => turn.role === 'user' && turn.text === question)).toBe(false)
      expect(observation.requests.filter(entry => entry.action === 'turns')).toHaveLength(1)
      expect(pending).toHaveLength(1)
      await product.screenshot({ path: testInfo.outputPath('composer-before-admission.png') })
    } finally {
      release()
      await Promise.all(pending)
      await product.unroute(matches, hold)
    }
    const response = await admitting
    expect(await response.json()).toMatchObject({ ok: true, accepted: true, disposition: 'direct' })
    const admitted = await conversationAccepted(response)
    expect(admitted.sessionId).toBe(sessionId)
    await expect(product.locator('.answer-annotation-root').filter({ hasText: CONVERSATION_EXPECTED.answer })).toHaveCount(1)
    await expect(product.getByTestId('composer-stop')).not.toBeVisible()
    await expect(product.getByTestId('user-bubble').getByText(question, { exact: true })).toHaveCount(1)
    const completed = await conversationInspection(sessionId)
    expect(completed.snapshot).toMatchObject({ active_turn_id: null, running: false, last_turn_id: admitted.turnId })
    expect(completed.history.turns.filter(turn => turn.turn_id === admitted.turnId && turn.role === 'user')).toHaveLength(1)
    expect(completed.history.activity_events.filter(event => event.turn_id === admitted.turnId && event.type === 'turn_completed')).toHaveLength(1)
    expect(observation.requests.filter(entry => entry.action === 'turns')).toHaveLength(1)
    await product.screenshot({ path: testInfo.outputPath('composer-admitted-once.png') })
    await workspaceShortcut('F8')
    await scenario('page-conversation', 'conversation-cancel')
    await controls.getByRole('button', { name: zh.close, exact: true }).click()
    await product.getByTestId('composer-input').fill('检查共享队列展示层接入后的原输入框')
    const sending = product.waitForResponse(response => /\/api\/serve\/sessions\/[^/]+\/turns$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
    await product.getByTestId('composer-send').focus()
    await product.keyboard.press('Enter')
    expect((await sending).status()).toBe(200)
    await expect(product.locator('.answer-annotation-root').filter({ hasText: '开始模拟长回答。' })).toHaveCount(1)
    const stop = product.getByTestId('composer-stop')
    await expect(stop).toBeEnabled()
    const stopping = product.waitForResponse(response => new URL(response.url()).pathname.endsWith('/interrupt') && response.request().method() === 'POST')
    await stop.focus()
    await product.keyboard.press('Enter')
    expect((await stopping).status()).toBe(200)
    await expect(stop).not.toBeVisible()
    await product.screenshot({ path: testInfo.outputPath('composer-keyboard-consumer.png') })
    expect(observation.requests.filter(entry => entry.action === 'turns')).toHaveLength(2)
    expect(observation.interruptions).toBe(1)
  })
})



test('native suggestion materials retain failed actions and consume only accepted submissions', { annotation: MATERIALS_INITIAL_TARGET }, async ({}, testInfo) => {
  const writes = []
  const errors = []
  product.on('request', request => {
    if (request.method() !== 'GET' && /\/api\//.test(request.url())) writes.push(request.url())
  })
  product.on('pageerror', error => errors.push(error.message))
  await scenario('development-components', 'components-states')
  await product.getByRole('button', { name: /会话组件/ }).click()
  await product.getByRole('button', { name: '下一步建议', exact: true }).click()
  const states = product.getByRole('group', { name: '示例状态', exact: true })
  const next = product.getByTestId('next-steps-card')
  const submitted = product.getByTestId('next-step-local-result')
  await next.getByRole('button', { name: /补充文献/ }).click()
  await expect(next).toHaveAttribute('aria-busy', 'true')
  await expect(next.getByRole('button').first()).toBeDisabled()
  await expect(submitted).toContainText('补充文献')
  await expect(next).toHaveCount(0)
  await states.getByRole('button', { name: '提交失败样例', exact: true }).click()
  const rejected = next.getByRole('button', { name: /补充文献/ })
  await rejected.click()
  await expect(next.getByRole('alert')).toBeVisible()
  await expect(rejected).toBeEnabled()
  await expect(submitted).toHaveCount(0)
  await rejected.click()
  await expect(next.getByRole('alert')).toBeVisible()
  await expect(rejected).toBeEnabled()
  await expect(submitted).toHaveCount(0)
  await states.getByRole('button', { name: '可交互样例', exact: true }).click()
  await next.getByRole('button', { name: /设计验证方案/ }).click()
  await expect(submitted).toContainText('设计验证方案')
  await expect(next).toHaveCount(0)
  await submitted.scrollIntoViewIfNeeded()
  await product.screenshot({ path: testInfo.outputPath('suggestions-local.png') })
  await states.getByRole('button', { name: '旧卡失活', exact: true }).click()
  await expect(next).toHaveCount(0)
  await expect(submitted).toHaveCount(0)
  await product.getByRole('button', { name: 'English', exact: true }).click()
  await product.locator('#theme-preview-mode').click()
  await product.getByRole('option', { name: /dark/i }).click()
  const native = await app.browserWindow(product)
  await native.evaluate((window, minimum) => window.setSize(minimum.width, minimum.height), WORKSPACE_WINDOW_MINIMUM)
  await product.getByRole('group', { name: 'Sample state', exact: true }).getByRole('button', { name: 'Interactive sample', exact: true }).click()
  await next.getByRole('button', { name: /Add related literature/ }).focus()
  await product.keyboard.press('Enter')
  await expect(submitted).toContainText('Add related literature')
  await expect(next).toHaveCount(0)
  await product.screenshot({ path: testInfo.outputPath('suggestions-dark-english.png') })
  expect(writes).toEqual([])
  expect(errors).toEqual([])
})

test('native context materials show only before and after references', async ({}, testInfo) => {
  await scenario('development-components', 'components-states')
  await product.getByRole('button', { name: /会话组件/ }).click()
  await product.getByRole('button', { name: '引用与上下文', exact: true }).click()
  const sample = product.getByTestId('context-reference-examples')
  await expect(product.getByTestId('context-material')).toHaveCount(0)
  await expect(product.getByRole('group', { name: '示例状态', exact: true })).toHaveCount(0)
  await expect(sample.getByRole('heading', { name: '发送前', exact: true })).toBeVisible()
  await expect(sample.getByRole('heading', { name: '发送后', exact: true })).toBeVisible()
  expect(await sample.locator('[data-testid^="reference-attachment-example-"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')))).toEqual(['annotation', 'selection', 'skill', 'session'].map(kind => 'reference-attachment-example-' + kind))
  expect(await sample.locator('[data-testid^="sent-reference-attachment-example-"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')))).toEqual(['annotation', 'selection', 'skill', 'session'].map(kind => 'sent-reference-attachment-example-' + kind))
  await sample.scrollIntoViewIfNeeded()
  await product.screenshot({ path: testInfo.outputPath('context-reference-only.png') })
})

test('native confirmation materials show four shared variants with collapsed selection', async ({}, testInfo) => {
  await scenario('development-components', 'components-states')
  await product.getByRole('button', { name: /会话组件/ }).click()
  await product.getByRole('button', { name: '确认卡片', exact: true }).click()
  const sample = product.locator('section#conversation-approval')
  const types = sample.getByRole('group', { name: '确认卡片类型', exact: true })
  await expect(types.getByRole('button', { pressed: true })).toHaveText('带勾选功能')
  const toggle = sample.getByTestId('hil-question-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(sample.getByRole('checkbox')).toHaveCount(0)
  await toggle.click()
  const paper = sample.getByRole('checkbox').nth(1)
  await paper.click()
  await expect(sample.getByRole('checkbox').first()).toHaveAttribute('aria-checked', 'mixed')
  await toggle.click()
  await toggle.focus()
  await product.keyboard.press('Enter')
  await expect(paper).not.toBeChecked()
  await sample.screenshot({ path: testInfo.outputPath('confirmation-selection.png') })
  for (const label of ['普通权限', '高风险权限', '自定义内容']) {
    await types.getByRole('button', { name: label, exact: true }).click()
    if (label === '高风险权限') await expect(sample.locator('svg.lucide-triangle-alert')).toBeVisible()
    if (label === '自定义内容') {
      await expect(sample.getByText('~/Documents/组会材料/研究简报.md', { exact: true })).toBeVisible()
      await expect(sample.getByRole('button', { name: '允许本次访问', exact: true })).toBeVisible()
    }
    await sample.screenshot({ path: testInfo.outputPath('confirmation-' + label + '.png') })
  }
})

test('native conversation interaction materials keep approval and clarification isolated', { annotation: MATERIALS_INITIAL_TARGET }, async ({}, testInfo) => {
  const writes = []
  const errors = []
  product.on('request', request => {
    if (request.method() !== 'GET' && /\/api\//.test(request.url())) writes.push(request.url())
  })
  product.on('pageerror', error => errors.push(error.message))
  await scenario('development-components', 'components-states')
  await product.getByRole('button', { name: /会话组件/ }).click()
  await product.getByRole('button', { name: '确认卡片', exact: true }).click()
  const confirmation = product.locator('section#conversation-approval')
  await confirmation.getByRole('button', { name: '确认授权', exact: true }).click()
  await expect(confirmation.getByRole('group', { name: '请求授权文献', exact: true })).toHaveCount(0)
  await confirmation.getByRole('button', { name: '重置交互演示', exact: true }).click()
  await confirmation.getByRole('button', { name: '拒绝', exact: true }).click()
  await expect(confirmation.getByRole('group', { name: '请求授权文献', exact: true })).toHaveCount(0)
  const sample = product.getByTestId('conversation-material')
  const states = sample.getByRole('group', { name: '示例状态' })
  await product.getByRole('button', { name: '澄清卡片', exact: true }).click()
  await expect(sample.getByTestId('hil-question-position')).toContainText('1 / 3')
  await expect(sample.getByTestId('hil-question-toggle')).toHaveCount(0)
  await expect(sample.getByTestId('hil-question-pages')).toHaveCount(0)
  await expect(sample.getByRole('checkbox', { name: /方法对比/ })).toHaveCount(0)
  await sample.getByRole('radio', { name: /质量优先/ }).click()
  await sample.getByTestId('hil-question-next').click()
  await expect(sample.getByTestId('hil-question-position')).toContainText('2 / 3')
  await expect(sample.getByRole('radio', { name: /质量优先/ })).toHaveCount(0)
  await sample.getByRole('checkbox', { name: /方法对比/ }).check()
  await sample.getByTestId('hil-question-next').click()
  await expect(sample.getByTestId('hil-question-position')).toContainText('3 / 3')
  await expect(sample.getByTestId('hil-question-confirm')).toBeDisabled()
  await sample.getByRole('textbox').last().fill('保留原文与术语')
  await expect(sample.getByTestId('hil-question-previous')).toHaveCount(0)
  await expect(sample.getByRole('textbox').last()).toHaveValue('保留原文与术语')
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('conversation-clarification.png') })
  await sample.getByTestId('hil-dock').screenshot({ animations: 'disabled', path: testInfo.outputPath('clarification-card.png') })
  await sample.getByTestId('hil-question-confirm').click()
  await expect(sample.getByTestId('interaction-reply')).toContainText('保留原文与术语')
  await states.getByRole('button', { name: '失败', exact: true }).click()
  await sample.getByRole('radio', { name: /质量优先/ }).click()
  await sample.getByTestId('hil-question-next').click()
  await sample.getByRole('checkbox', { name: /方法对比/ }).check()
  await sample.getByTestId('hil-question-next').click()
  await sample.getByRole('textbox').last().fill('失败后仍保留补充')
  await sample.getByTestId('hil-question-confirm').click()
  await expect(sample.getByTestId('hil-submit-error')).toBeVisible()
  await expect(sample.getByRole('textbox').last()).toHaveValue('失败后仍保留补充')
  await sample.getByTestId('hil-question-confirm').click()
  await expect(sample.getByTestId('hil-submit-error')).toBeVisible()
  await expect(sample.getByRole('textbox').last()).toHaveValue('失败后仍保留补充')
  await sample.getByRole('button', { name: '重置交互演示', exact: true }).click()
  await sample.getByTestId('hil-question-skip').click()
  await expect(sample.getByTestId('hil-question-position')).toContainText('2 / 3')
  await sample.getByTestId('hil-question-skip').click()
  await expect(sample.getByTestId('hil-question-position')).toContainText('3 / 3')
  await sample.getByTestId('hil-question-skip').click()
  await expect(sample.getByTestId('interaction-reply')).toContainText('已跳过')
  await expect(sample.getByTestId('interaction-reply')).toContainText('未作答')
  for (const label of ['提交中', '结果未知', '已失效']) {
    await states.getByRole('button', { name: label, exact: true }).click()
    await expect(sample.getByTestId('hil-card')).toBeVisible()
  }
  await sample.getByRole('button', { name: '重置交互演示', exact: true }).click()
  await product.getByRole('button', { name: 'English', exact: true }).focus()
  await product.keyboard.press('Space')
  await product.locator('#theme-preview-mode').click()
  await product.getByRole('option', { name: /dark/i }).click()
  const native = await app.browserWindow(product)
  await native.evaluate((window, minimum) => window.setSize(minimum.width, minimum.height), WORKSPACE_WINDOW_MINIMUM)
  await expect(sample.getByTestId('hil-dock')).toBeVisible()
  await sample.getByTestId('hil-dock').scrollIntoViewIfNeeded()
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('conversation-clarification-dark-english.png') })
  await product.getByRole('button', { name: 'Confirmation card', exact: true }).click()
  await expect(confirmation.getByRole('button', { name: 'With selection', exact: true })).toBeVisible()
  await confirmation.scrollIntoViewIfNeeded()
  await product.screenshot({ animations: 'disabled', path: testInfo.outputPath('conversation-approval-dark-english.png') })
  expect(writes).toEqual([])
  expect(errors).toEqual([])
})

test('native conversation materials reuse existing views and switch isolated states', { annotation: MATERIALS_INITIAL_TARGET }, async ({}, testInfo) => {
  const errors = []
  const writes = []
  product.on('pageerror', error => errors.push(error.message))
  product.on('request', request => {
    if (request.method() !== 'GET' && /\/api\//.test(request.url())) writes.push(request.url())
  })
  await scenario('development-components', 'components-states')
  await product.getByRole('button', { name: /会话组件/ }).click()
  for (const label of ['文字消息', '执行计划', '澄清卡片']) {
    await product.getByRole('button', { name: label, exact: true }).click()
    const sample = product.getByTestId('conversation-material')
    await expect(sample).toBeVisible()
    const states = sample.getByRole('group', { name: '示例状态' }).locator('button[aria-pressed]')
    await expect(states).toHaveCount(label === '澄清卡片' ? 7 : 3)
    for (let index = 0; index < await states.count(); index++) {
      await states.nth(index).click()
      await expect(states.nth(index)).toHaveAttribute('aria-pressed', 'true')
      await expect(sample.getByTestId('conversation-preview')).toBeVisible()
      if (label === '文字消息') await expect(sample.getByTestId('user-bubble').first()).toContainText('蛋白质折叠')
      if (label === '执行计划') await expect(sample.getByTestId('conversation-preview')).toContainText('执行计划')
      if (label === '澄清卡片') {
        if (index === 1 || index === 2 || index === 6) {
          const expired = index === 6
          const reply = sample.getByTestId('interaction-reply')
          const summary = sample.getByRole('button', {
            name: expired ? conversationZh.reply.expiredSummary : index === 1 ? conversationZh.reply.confirmedSummary : conversationZh.reply.skippedSummary,
            exact: true,
          })
          if (expired) {
            await expect(sample.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'stale')
            await expect(sample.getByTestId('hil-card')).toHaveAttribute('data-hil-resolved', 'true')
          }
          await expect(summary).toHaveAttribute('aria-expanded', 'false')
          await summary.click()
          await expect(summary).toHaveAttribute('aria-expanded', 'true')
          await expect(reply).toBeVisible()
          for (const question of ['本次任务更关注什么？', '希望获得哪些产物？', '还有哪些需要保留的要求？']) await expect(reply).toContainText(question)
          if (expired) {
            const options = reply.locator('[role="radio"], [role="checkbox"]')
            await expect(options).toHaveCount(4)
            for (const [role, label] of [['radio', '质量优先（推荐）'], ['radio', '速度优先'], ['checkbox', '文献列表（推荐）'], ['checkbox', '方法对比']]) {
              const option = reply.getByRole(role, { name: label, exact: true })
              await expect(option).toBeVisible()
              await expect(option).toBeDisabled()
              await expect(option).toHaveAttribute('aria-checked', 'false')
            }
          } else {
            await expect(reply).toContainText(conversationZh.reply.readOnly)
            await expect(reply).toContainText(index === 1 ? '结构预测与实验验证；补充：保留专业术语。' : '已跳过')
            if (index === 1) {
              await expect(reply).toContainText('质量优先（推荐）')
              await expect(reply).toContainText('文献列表（推荐）')
            }
            for (const option of await reply.locator('[role="radio"], [role="checkbox"]').all()) await expect(option).toBeDisabled()
          }
          await expect(reply.locator('input, textarea, [contenteditable="true"]')).toHaveCount(0)
          await expect(reply.getByRole('button')).toHaveCount(0)
          await summary.click()
          await expect(summary).toHaveAttribute('aria-expanded', 'false')
          const contentId = await summary.getAttribute('aria-controls')
          expect(contentId).toBeTruthy()
          const content = sample.locator('[id="' + contentId + '"]')
          await expect(content).toHaveAttribute('data-state', 'closed')
          await expect(content).toHaveAttribute('aria-hidden', 'true')
          await expect(content).toHaveJSProperty('inert', true)
          await expect(content.locator(':scope > div')).toHaveCSS('overflow', 'hidden')
          await expect.poll(() => content.evaluate(element => element.getBoundingClientRect().height)).toBe(0)
          expect(writes).toEqual([])
          expect(errors).toEqual([])
        } else {
          await expect(sample.getByTestId('hil-card')).toBeVisible()
          await expect(sample.getByTestId('interaction-reply')).toHaveCount(0)
        }
      }
      await expect(sample.getByText('无法读取审阅快照状态，请稍后重试。', { exact: true })).toHaveCount(0)
    }
    if (label === '澄清卡片') await states.filter({ hasText: '已提交' }).click()
    await product.screenshot({ path: testInfo.outputPath('conversation-' + label + '.png') })
  }
  await product.screenshot({ path: testInfo.outputPath('conversation-materials.png') })
  await product.getByRole('button', { name: 'English', exact: true }).focus()
  await product.keyboard.press('Space')
  await expect(product.getByRole('heading', { name: 'Clarification cards', exact: true })).toBeVisible()
  await product.locator('#theme-preview-mode').click()
  await product.getByRole('option', { name: /dark/i }).click()
  await expect(product.locator('html')).toHaveAttribute('data-theme', 'dark')
  const native = await app.browserWindow(product)
  await native.evaluate((window, minimum) => window.setSize(minimum.width, minimum.height), WORKSPACE_WINDOW_MINIMUM)
  await product.getByRole('button', { name: 'Execution plan', exact: true }).click()
  await expect(product.getByRole('heading', { name: 'Execution plan', exact: true })).toBeVisible()
  const receipts = product.getByRole('button', { name: 'Clarification cards', exact: true })
  const group = product.getByRole('button', { name: /Conversation components/ })
  const contentId = await group.getAttribute('aria-controls')
  await expect(product.locator('[id="' + contentId + '"]')).toHaveCSS('overflow-y', 'auto')
  await receipts.focus()
  await receipts.press('Enter')
  await expect(receipts).toBeInViewport()
  const sample = product.getByTestId('conversation-material')
  await expect(sample.getByTestId('hil-dock')).toBeVisible()
  await expect(sample.getByTestId('interaction-reply')).toHaveCount(0)
  await sample.getByRole('button', { name: 'Answered', exact: true }).click()
  const answeredSummary = sample.getByRole('button', { name: conversationEn.reply.confirmedSummary, exact: true })
  await expect(answeredSummary).toHaveAttribute('aria-expanded', 'false')
  await answeredSummary.click()
  const answeredReply = sample.getByTestId('interaction-reply')
  await expect(answeredReply).toBeVisible()
  await expect(answeredReply).toContainText(conversationEn.reply.readOnly)
  await expect(answeredReply.locator('input, textarea, [contenteditable="true"]')).toHaveCount(0)
  await expect(answeredReply.getByRole('button')).toHaveCount(0)
  await answeredReply.scrollIntoViewIfNeeded()
  await product.screenshot({ path: testInfo.outputPath('conversation-materials-dark-english.png') })
  expect(errors).toEqual([])
  expect(writes).toEqual([])
})

test('native composer menus coordinate stationary pointers and keyboard selection', async ({}, testInfo) => {
  await product.clock.install()
  await scenario('page-conversation', 'conversation-references')
  const input = product.getByTestId('composer-input')
  await input.fill('/')
  const first = product.getByTestId('composer-skill-preview-notes')
  const second = product.getByTestId('composer-skill-preview-required')
  await expect(first).toBeFocused()
  const bounds = await second.boundingBox()
  await product.keyboard.press('Escape')
  await product.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await input.fill('/')
  await expect(first).toBeFocused()
  await expect(second).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await product.keyboard.press('ArrowDown')
  await expect(second).toBeFocused()
  await product.keyboard.press('ArrowUp')
  await expect(first).toBeFocused()
  await expect(second).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await product.screenshot({ path: testInfo.outputPath('stationary-pointer-keyboard-selection.png') })
  await product.mouse.move(bounds.x + bounds.width / 2 + 4, bounds.y + bounds.height / 2)
  await expect(second).toBeFocused()
  await product.keyboard.press('ArrowUp')
  await expect(first).toBeFocused()
  await expect(second).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  const focusTime = await product.evaluate(() => Date.now())
  await product.clock.setFixedTime(focusTime)
  await product.clock.pauseAt(focusTime)
  try {
    await product.keyboard.press('Enter')
    await expect(input).toBeFocused()
    await product.keyboard.insertText('@')
    await expect(product.getByTestId('composer-skills-menu')).toBeFocused()
    await product.clock.runFor(COMPOSER_FOCUS_FRAME_MS)
    await expect(product.getByTestId('composer-skills-menu')).toBeFocused()
  } finally {
    await product.clock.resume()
  }
  await product.keyboard.press('ArrowDown')
  await expect(product.getByTestId('composer-add-file')).toBeFocused()
  await product.keyboard.press('ArrowUp')
  await expect(product.getByTestId('composer-skills-menu')).toBeFocused()
  await product.screenshot({ path: testInfo.outputPath('plus-pointer-keyboard-selection.png') })
  for (const interruption of ['keyboard', 'pointer']) {
    await product.keyboard.press('Escape')
    await input.fill('/')
    await expect(first).toBeFocused()
    await product.clock.pauseAt(focusTime)
    try {
      await product.keyboard.press('Enter')
      await expect(input).toBeFocused()
      const target = product.getByTestId(interruption === 'keyboard' ? 'composer-plus' : 'composer-skills-menu')
      if (interruption === 'keyboard') await product.keyboard.press('Tab')
      else await product.getByTestId('composer-plus').click()
      await expect(target).toBeFocused()
      await product.clock.runFor(COMPOSER_FOCUS_FRAME_MS)
      await expect(target).toBeFocused()
    } finally {
      await product.clock.resume()
    }
  }
  await product.screenshot({ path: testInfo.outputPath('composer-focus-interruptions.png') })
})

async function dialogProjectMenu() {
  await product.getByTestId('home-project-设计协作项目').hover()
  await product.getByTestId('home-project-menu-preview-project').click()
}

async function dialogTaskMenu() {
  await product.getByTestId('home-task-preview-session').click()
  await product.getByTestId('workspace-conversation-menu').click()
}

async function dialogLiteratureDetail() {
  await product.locator('.lit-row').first().click()
  await expect(product.getByRole('button', { name: '关闭详情', exact: true })).toBeVisible()
}

async function dialogLiteratureOrganization() {
  await dialogLiteratureDetail()
  const trigger = product.getByRole('button', { name: literatureZh.information.organization, exact: true })
  await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
}

async function dialogLiteratureSelection(count = 1) {
  const rows = product.locator('.lit-row')
  for (let index = 0; index < count; index += 1) await rows.nth(index).getByRole('checkbox').check()
}

async function dialogCollectionMenu() {
  await product.getByTestId(/^literature-collection-/).filter({ hasText: '模拟研究' }).first().click({ button: 'right' })
}

async function dialogInstalledSkills() {
  await product.getByTestId('skills-installed').click()
  await product.getByTestId('skills-tab-user').click()
  await expect(product.getByTestId('skills-tab-user')).toHaveAttribute('aria-selected', 'true')
}

async function dialogSkillMenu() {
  await dialogInstalledSkills()
  await product.getByTestId('skill-more-preview-notes').click()
}

async function dialogProjectLiterature() {
  await product.getByTestId('project-library').click()
  await selectNativeLibraryCategory(layoutZh.papers)
  await expect(product.locator('.lit-row').first()).toBeVisible()
}

async function dialogGroupRename(dialog, testInfo) {
  const url = new URL(LITERATURE_COLLECTIONS_PATH, manifest.origin)
  url.searchParams.set('previewInstance', manifest.instance)
  url.searchParams.set('project_id', PREVIEW_PROJECT_ID)
  const initialResponse = await product.request.get(url.href)
  expect(initialResponse.status()).toBe(200)
  const initial = await initialResponse.json()
  const matches = initial.filter(group => group.name === '模拟项目资料')
  expect(matches).toHaveLength(1)
  const original = matches[0]
  const mutations = []
  product.on('request', request => {
    const target = new URL(request.url())
    if (target.pathname.startsWith(LITERATURE_COLLECTIONS_PATH) && request.method() !== 'GET') mutations.push({ path: target.pathname, project: target.searchParams.get('project_id'), method: request.method(), body: request.postDataJSON() })
  })
  await normalUi(testInfo, async () => {
    const input = dialog.getByRole('textbox', { name: literatureZh.groups.name, exact: true })
    await expect(input).toHaveValue(original.name)
    await input.fill('未提交的分组名')
    await product.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    expect(mutations).toEqual([])
    await product.reload()
    dialog = await openDialogApplication('project-group-rename')
    const restored = dialog.getByRole('textbox', { name: literatureZh.groups.name, exact: true })
    await expect(restored).toHaveValue(original.name)
    await restored.fill('重入后未提交的分组名')
    await product.screenshot({ path: testInfo.outputPath('group-rename-draft.png') })
    await product.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    expect(mutations).toEqual([])
    const reloaded = await product.request.get(url.href)
    expect(reloaded.status()).toBe(200)
    const groups = await reloaded.json()
    expect(groups).toEqual(initial)
    await product.screenshot({ path: testInfo.outputPath('group-rename-cancelled.png') })
    writeFileSync(testInfo.outputPath('group-rename-observation.json'), JSON.stringify({ initial, groups, mutations }, null, 2))
  })
}

async function dialogDirtyMarkdown() {
  await product.getByTestId('activity-account').click()
  await product.getByTestId('account-menu-settings').click()
  await product.getByRole('button', { name: '资料库文件', exact: true }).click()
  await product.getByRole('switch', { name: '文件自动保存', exact: true }).uncheck()
  await product.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
  await product.getByTestId('markdown-mode-select').click()
  await product.getByTestId('markdown-open-editor').click()
  await product.locator('.milkdown .ProseMirror').click()
  await product.keyboard.type('Unsaved preview edit')
  await expect(product.locator('.milkdown .ProseMirror')).toContainText('Unsaved preview edit')
  await expect(product.getByRole('tab', { name: 'readme.md', exact: true }).locator('[data-slot="navigation-tab-dirty"]')).toBeVisible()
}

async function openDialogApplication(identity) {
  const ordinary = name => product.getByRole('dialog').filter({ has: product.getByRole('heading', { name, exact: typeof name === 'string' }) }).last()
  const confirmation = name => product.getByRole('alertdialog').filter({ has: product.getByRole('heading', { name, exact: typeof name === 'string' }) }).last()
  const openers = {
    'project-create': async () => { await openHomeProjectForm(); return product.getByTestId('project-new-modal') },
    'project-edit': async () => { await dialogProjectMenu(); await product.getByRole('menuitem', { name: '编辑项目', exact: true }).click(); return product.getByTestId('project-edit-modal') },
    'project-archive': async () => { await dialogProjectMenu(); await product.getByRole('menuitem', { name: /归档/ }).click(); return product.getByRole('alertdialog') },
    'project-folder': async () => {
      await openHomeProjectForm()
      await product.getByTestId('project-create-name').fill('模拟已有目录')
      await product.getByRole('button', { name: '选择文件夹', exact: true }).click()
      await product.getByTestId('preview-directory-dialog').getByRole('radio').first().check()
      await product.getByTestId('preview-directory-confirm').click()
      await product.getByTestId('project-create').click()
      return confirmation('信任这个文件夹吗？')
    },
    'task-rename': async () => { await dialogTaskMenu(); await product.getByTestId('session-rename-menu').click(); return ordinary('重命名') },
    'task-archive': async () => { await dialogTaskMenu(); await product.getByTestId('session-archive-menu').click(); return product.getByRole('alertdialog') },
    'task-delete': async () => { await dialogTaskMenu(); await product.getByTestId('session-delete-menu').click(); return product.getByTestId('session-delete-confirm') },
    'archived-task-delete': async () => {
      await dialogTaskMenu()
      await product.getByTestId('session-archive-menu').click()
      await product.getByRole('alertdialog').getByRole('button', { name: /归档/ }).click()
      await product.getByTestId('project-archive-toggle').click()
      await product.getByTestId('project-archived-task-preview-session').hover()
      await product.getByTestId('project-archived-list').getByRole('button', { name: /删除/ }).first().click()
      return product.getByRole('alertdialog')
    },
    'conversation-mode': async () => {
      await product.getByTestId('composer-input').fill('展示运行模式切换确认')
      await product.getByTestId('composer-send').click()
      await expect(product.locator('.answer-annotation-root').filter({ hasText: '开始模拟长回答。' })).toBeVisible()
      await product.getByTestId('mode-chip').click()
      await product.getByTestId('mode-ask').click()
      return product.getByTestId('mode-application-dialog')
    },
    'file-rename': async () => {
      await product.getByTestId('project-library').click()
      await product.getByTestId('project-library-explorer').click()
      await product.getByTestId('explorer-tree').getByText('readme.md', { exact: true }).click({ button: 'right' })
      await product.getByRole('menuitem', { name: '重命名', exact: true }).click()
      return product.getByTestId('explorer-name-dialog')
    },
    'file-path-failure': async () => {
      await product.getByTestId('project-library').click()
      await product.getByTestId('project-library-explorer').click()
      await product.getByTestId('explorer-tree').getByText('readme.md', { exact: true }).click()
      await product.getByTestId('explorer-open-menu').click()
      await product.getByTestId('explorer-reveal-file').click()
      return product.getByTestId('explorer-path-failure')
    },
    'pdf-page': async () => {
      await expect(product.getByTestId('pdf-document')).toBeVisible()
      await product.getByTestId('pdf-document').click({ position: { x: 100, y: 100 } })
      await product.keyboard.press(DIALOG_SHORTCUT_MODIFIER + '+l')
      return product.getByTestId('pdf-go-to-page-dialog')
    },
    'code-line': async () => {
      await product.frameLocator('iframe[data-testid="monaco-editor"]').locator('.monaco-editor').click()
      await product.keyboard.press(DIALOG_SHORTCUT_MODIFIER + '+l')
      return product.getByTestId('code-go-to-line-dialog')
    },
    'markdown-find': async () => {
      await product.getByTestId('markdown-mode-select').click()
      await product.getByTestId('markdown-open-editor').click()
      await product.locator('.milkdown .ProseMirror').press(DIALOG_SHORTCUT_MODIFIER + '+f')
      return product.getByTestId('markdown-find-input').locator('xpath=ancestor::*[@role="dialog"]')
    },
    'document-unsaved': async () => {
      await dialogDirtyMarkdown()
      await product.getByRole('button', { name: '关闭 readme.md', exact: true }).click()
      return product.getByTestId('document-close-dialog')
    },
    'version-alias': async () => {
      await product.getByTestId('document-version-history').click()
      await product.getByRole('button', { name: '更多版本操作', exact: true }).last().click()
      await product.getByRole('menuitem', { name: /别名/ }).click()
      return ordinary(/设置 v\d+ 的别名/)
    },
    'version-delete': async () => {
      await product.getByTestId('document-version-history').click()
      await product.getByRole('button', { name: '更多版本操作', exact: true }).last().click()
      await product.getByRole('menuitem', { name: /删除/ }).click()
      return confirmation(/删除 v/)
    },
    'literature-identifier': async () => {
      await product.getByTestId('literature-toolbar-import').click()
      await product.getByRole('menuitem', { name: '从 ArXiv ID / DOI 导入', exact: true }).click()
      return ordinary('从 ArXiv ID / DOI 导入')
    },
    'literature-batch-project': async () => { await dialogLiteratureSelection(); await product.getByRole('button', { name: '添加到', exact: true }).click(); await product.getByRole('menuitem', { name: '项目', exact: true }).click(); return ordinary('项目') },
    'literature-batch-collection': async () => { await dialogLiteratureSelection(); await product.getByRole('button', { name: '添加到', exact: true }).click(); await product.getByRole('menuitem', { name: '我的分组', exact: true }).click(); return ordinary('我的分组') },
    'literature-batch-tag': async () => { await dialogLiteratureSelection(); await product.getByRole('button', { name: '添加到', exact: true }).click(); await product.getByRole('menuitem', { name: '标签', exact: true }).click(); return ordinary('标签') },
    'literature-delete': async () => { await product.locator('.lit-row').first().click({ button: 'right' }); await product.getByRole('menuitem', { name: '删除文献', exact: true }).click(); return confirmation('删除文献') },
    'literature-batch-delete': async () => { await dialogLiteratureSelection(2); await product.getByRole('button', { name: '删除', exact: true }).click(); return confirmation('删除文献') },
    'literature-relations-projects': async () => { await dialogLiteratureOrganization(); await product.getByRole('button', { name: literatureZh.relations.chooseProject, exact: true }).click(); return ordinary('管理关联项目') },
    'literature-relations-collections': async () => { await dialogLiteratureOrganization(); await product.getByRole('button', { name: literatureZh.detail.chooseCollection, exact: true }).click(); return ordinary('管理我的分类') },
    'literature-attachment-delete': async () => { await dialogLiteratureDetail(); await product.getByRole('tab', { name: /^附件/ }).click(); await product.getByRole('button', { name: '删除附件', exact: true }).first().click(); return ordinary('删除附件') },
    'literature-note-delete': async () => { await dialogLiteratureDetail(); await product.getByRole('tab', { name: /^笔记/ }).click(); await product.getByRole('button', { name: '删除笔记《模拟阅读笔记》', exact: true }).click(); return confirmation('删除这份笔记？') },
    'collection-create': async () => { await product.getByRole('button', { name: '新建全局分类', exact: true }).click(); return ordinary('新建分类') },
    'collection-child': async () => { const row = product.getByTestId(/^literature-collection-/).filter({ hasText: '模拟研究' }).first(); await row.hover(); await row.getByRole('button', { name: '导入文献', exact: true }).click(); await product.getByRole('menuitem', { name: '新建子分类', exact: true }).click(); return ordinary('新建子分类') },
    'collection-rename': async () => { await dialogCollectionMenu(); await product.getByRole('menuitem', { name: '重命名', exact: true }).click(); return ordinary('重命名') },
    'collection-move': async () => { await dialogCollectionMenu(); await product.getByRole('menuitem', { name: '移动分类', exact: true }).click(); return ordinary('移动到') },
    'collection-delete': async () => { await dialogCollectionMenu(); await product.getByRole('menuitem', { name: '删除分类', exact: true }).click(); return confirmation('删除分类“模拟研究”？') },
    'tag-delete': async () => { await product.getByRole('button', { name: '删除标签「模拟协作」', exact: true }).click(); return confirmation('删除标签“模拟协作”？') },
    'skill-detail': async () => { await dialogInstalledSkills(); await product.getByTestId('skill-view-preview-notes').click(); return product.getByTestId('skill-detail') },
    'skill-use': async () => { await dialogSkillMenu(); await product.getByTestId('skill-use-preview-notes').click(); return product.getByRole('dialog') },
    'skill-enable': async () => { await dialogInstalledSkills(); await product.getByTestId('skill-toggle-preview-notes').click(); await product.getByTestId('skill-more-preview-notes').click(); await product.getByTestId('skill-use-preview-notes').click(); return product.getByRole('alertdialog') },
    'skill-remove': async () => { await dialogSkillMenu(); await product.getByTestId('skill-remove-preview-notes').click(); return product.getByTestId('skill-remove-confirm') },
    'skill-add': async () => { await dialogInstalledSkills(); await product.getByTestId('skills-add').click(); await product.getByRole('menuitem').filter({ hasText: skillsZh.uploadSkill }).click(); return product.getByTestId('skill-add-modal') },
    'settings-open': async () => product.getByRole('dialog', { name: '设置', exact: true }),
    'feedback-form': async () => { await product.getByTestId('feedback-recorder-entry').click(); return product.getByTestId('feedback-dialog') },
    'language-switch': async () => { await dialogDirtyMarkdown(); await product.getByTestId('activity-account').click(); await product.getByTestId('account-menu-language').click(); await product.getByRole('menuitemradio', { name: 'English', exact: true }).click(); return product.getByTestId('language-switch-dialog') },
    'connector-add': async () => { await product.getByRole('tab', { name: '连接器', exact: true }).click(); await product.getByRole('button', { name: '添加连接器', exact: true }).click(); return product.getByTestId('custom-connector-dialog') },
    'project-group-create': async () => { await dialogProjectLiterature(); await product.getByRole('button', { name: '文献分类', exact: true }).click(); await product.getByRole('menuitem', { name: literatureZh.groups.new, exact: true }).click(); return ordinary(literatureZh.groups.title) },
    'project-group-delete': async () => { await dialogProjectLiterature(); await product.getByRole('button', { name: '文献分类', exact: true }).click(); await product.getByTestId('literature-group-row').first().hover(); await product.getByRole('button', { name: '模拟项目资料的更多操作', exact: true }).click(); await product.getByRole('menuitem', { name: '删除分组', exact: true }).click(); return confirmation('删除分组“模拟项目资料”？') },
    'project-group-child': async () => { await dialogProjectLiterature(); await product.getByRole('button', { name: '文献分类', exact: true }).click(); await product.getByTestId('literature-group-row').first().hover(); await product.getByRole('button', { name: '在模拟项目资料下新建子分组', exact: true }).click(); return ordinary('新增分组') },
    'project-group-rename': async () => { await dialogProjectLiterature(); await product.getByRole('button', { name: '文献分类', exact: true }).click(); await product.getByTestId('literature-group-row').first().hover(); await product.getByRole('button', { name: '模拟项目资料的更多操作', exact: true }).click(); await product.getByRole('menuitem', { name: '重命名', exact: true }).click(); return ordinary('重命名') },
    'project-literature-remove': async () => { await dialogProjectLiterature(); await product.locator('.lit-row').first().click({ button: 'right' }); await product.getByRole('menuitem', { name: '移出项目', exact: true }).click(); return confirmation('移出项目') },
    'project-literature-batch-remove': async () => { await dialogProjectLiterature(); await dialogLiteratureSelection(2); await product.getByRole('button', { name: '删除', exact: true }).click(); return confirmation('移出项目') },
    'archive-project-delete': async () => { await product.getByTestId(/^account-archived-delete-/).first().click(); return product.getByTestId('account-archived-delete-confirm').locator('xpath=ancestor::*[@role="alertdialog"]') },
    'archive-project-batch': async () => { await product.getByTestId('account-archived-selection-mode').click(); await product.getByTestId('account-archived-select-all').check(); await product.getByTestId('account-archived-batch-delete').click(); return product.getByRole('alertdialog') },
  }
  expect(openers[identity], identity).toBeDefined()
  return openers[identity]()
}

for (const application of DIALOG_APPLICATIONS) {
  test('native dialog application: ' + application.id, { timeout: 90_000 }, async ({}, testInfo) => {
    product.setDefaultTimeout(DIALOG_ACTION_TIMEOUT_MS)
    const pageId = application.id === 'project-create' ? 'dialog-projects' : 'dialog-' + application.id
    const sceneId = 'dialog-' + application.id
    await scenario(pageId, sceneId)
    await expect(controls.getByTestId('preview-collection-dialogs-' + application.collection)).toBeVisible()
    const dialog = await openDialogApplication(application.id)
    await expect(dialog).toBeVisible()
    if (application.id === 'project-group-rename') {
      await dialogGroupRename(dialog, testInfo)
      return
    }
    await product.screenshot({ path: testInfo.outputPath(application.id + '.png') })
    await product.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    if (application.id === 'version-delete') {
      await product.getByRole('button', { name: '更多版本操作', exact: true }).last().click()
      await product.getByRole('menuitem', { name: /删除/ }).click()
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: '删除版本', exact: true }).click()
      await expect(dialog).not.toBeVisible()
      await expect(product.getByRole('button', { name: '更多版本操作', exact: true })).toHaveCount(1)
      await product.screenshot({ path: testInfo.outputPath('version-deleted.png') })
    }
  })
}

test('native dialog navigation preserves original entries, drafts and bilingual themed groups', { timeout: CENTER_MATRIX_TIMEOUT_MS }, async ({}, testInfo) => {
  await scenario('dialog-projects', 'dialog-project-create')
  await controls.getByRole('searchbox').fill('')
  await expect(controls.getByTestId('preview-group-dialogs')).toContainText(String(new Set(DIALOG_APPLICATIONS.map(application => application.collection)).size))
  for (const identity of new Set(DIALOG_APPLICATIONS.map(application => application.collection))) {
    await expect(controls.getByTestId('preview-collection-dialogs-' + identity)).toBeVisible()
  }
  await expect(controls.getByTestId('preview-collection-dialogs-projects')).toContainText('4')
  await expect(controls.getByTestId('preview-collection-dialogs-literature')).toContainText('12')
  await expect(controls.getByTestId('preview-group-center')).toBeVisible()
  await expect(controls.getByTestId('preview-group-literature')).toBeVisible()
  await expect(controls.getByTestId('preview-group-settings')).toBeVisible()
  const address = product.url()
  await openHomeProjectForm()
  await product.getByTestId('project-create-name').fill('展开分类不丢失表单')
  await controls.getByTestId('preview-collection-dialogs-literature').click()
  await expect(product.getByTestId('project-create-name')).toHaveValue('展开分类不丢失表单')
  expect(product.url()).toBe(address)
  await controls.getByTestId('preview-collection-dialogs-literature').click()
  await controls.screenshot({ path: testInfo.outputPath('dialog-collections-zh.png') })
  await product.screenshot({ path: testInfo.outputPath('dialog-project-zh.png') })
  await product.keyboard.press('Escape')
  await controls.getByRole('combobox', { name: '主题', exact: true }).click()
  await controls.getByRole('option', { name: '深色', exact: true }).click()
  await expect(product.locator('html')).toHaveAttribute('data-theme', 'dark')
  await controls.getByRole('combobox', { name: '界面语言', exact: true }).click()
  await controls.getByRole('option', { name: 'English', exact: true }).click()
  await expect(controls.getByRole('heading', { name: 'PDFE Workbench', exact: true })).toBeVisible()
  const nativeWindow = await app.browserWindow(product)
  await nativeWindow.evaluate((window, minimum) => window.setSize(minimum.width, minimum.height), WORKSPACE_WINDOW_MINIMUM)
  await controls.getByRole('searchbox').fill('Project management')
  await expect(controls.getByTestId('preview-group-dialogs')).toContainText('1')
  await expect(controls.locator('[data-testid^="preview-scene-dialog-"]')).toHaveCount(4)
  await openHomeProjectForm()
  await expect(product.getByTestId('project-new-modal')).toContainText('Project')
  await product.keyboard.press('Tab')
  expect(await product.getByTestId('project-new-modal').evaluate(element => element.contains(document.activeElement))).toBe(true)
  await controls.screenshot({ path: testInfo.outputPath('dialog-collections-dark-en.png') })
  await product.screenshot({ path: testInfo.outputPath('dialog-project-dark-en-minimum.png') })
})
