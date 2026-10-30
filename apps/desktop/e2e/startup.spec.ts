import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { expect, test } from '@playwright/test'
import { apiBase, DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { createReadyProject } from './fixtures/projects'
import { STARTUP_BUDGET_ONE_TIME_MS, STARTUP_BUDGET_STEADY_MS } from '../src/main/startupmarker'
import { ONBOARDING_GROUPS } from '../src/onboarding'
import { SUBSCRIPTION_CHANNEL, type SubscriptionReply } from '../src/subscriptions'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

test('parallel frontend paints before backend readiness without navigating again', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, { recordTrace: false, nativeWindowLifecycle: true })
  const launched = desktop.launch()
  void launched.catch(() => undefined)
  try {
    await expect.poll(() => desktop.app?.windows().find(page => page.url().startsWith('http://'))?.url() ?? '').not.toBe('')
    const page = desktop.app!.windows().find(page => page.url().startsWith('http://'))!
    await expect(page.getByTestId('progress-screen')).toBeVisible()
    const bounds = await page.getByTestId('progress-screen').boundingBox()
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    expect(bounds?.width).toBe(viewport.width)
    expect(bounds?.height).toBe(viewport.height)
    const before = await page.evaluate(() => ({
      startup: window.scholarseed.getStartup?.(),
      timeOrigin: performance.timeOrigin,
      url: location.href,
      paints: performance.getEntriesByType('paint').map(entry => ({ name: entry.name, time: entry.startTime })),
    }))
    expect(before.startup?.phase).toBe('connecting')
    expect(before.startup?.apiBase).toBeNull()
    await expect.poll(() => desktop.app!.evaluate(({ BrowserWindow }, url) =>
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url)?.isVisible() ?? false,
    page.url())).toBe(true)
    await page.screenshot({ path: join(runtime.artifacts, 'parallel-frontend.png') })
    await launched
    const after = await page.evaluate(() => ({
      startup: window.scholarseed.getStartup?.(),
      timeOrigin: performance.timeOrigin,
      url: location.href,
      isolated: crossOriginIsolated,
    }))
    expect(after.startup?.phase).toBe('ready')
    expect(after.url).toBe(before.url)
    expect(after.timeOrigin).toBe(before.timeOrigin)
    expect(new URL(after.startup!.apiBase!).origin).not.toBe(new URL(after.url).origin)
    expect(after.isolated).toBe(true)
    await page.screenshot({ path: join(runtime.artifacts, 'parallel-workbench.png') })
    writeFileSync(join(runtime.artifacts, 'parallel-startup.json'), JSON.stringify({ before, after }, null, 2))
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

const SCHOLARSEED_GATEWAY_BASE_URL = 'https://scholarseed.damo.alibaba.com/v1'
const HISTORICAL_PROJECT_COUNT = 76
const STARTUP_NOTE_FILENAME = 'startup-preserved.md'
const STARTUP_NOTE_CONTENT = '历史项目启动验收：这份资料必须保留。'
const HISTORICAL_PROJECT_SEED = `
import json
import shutil
import sys
import time
from pathlib import Path
from uuid import uuid4
from service.content.persistence.catalog import ContentCatalog, ProjectRow
from service.paths import CONTENT_DB

workspace, template = Path(sys.argv[1]), Path(sys.argv[2])
catalog = ContentCatalog(CONTENT_DB)
projects = []
for index in range(int(sys.argv[3])):
    root = workspace / ("historical-" + str(index))
    shutil.copytree(template, root)
    project = ProjectRow(uuid4().hex, "启动验收-" + str(index), str(root), "managed", time.time())
    catalog.insert_project(project)
    projects.append(project)
operation = uuid4().hex
assert catalog.accept_operation(operation, "local", "{}", limit=128, retention=3600)
catalog.start_operation(operation)
catalog.begin_project_removal(operation, projects[-1].project_id)
print(json.dumps({"roots": [project.dir_root for project in projects], "operation": operation}))
`

test('historical projects restart and recover pending work without losing files', async ({}, testInfo) => {
  test.setTimeout(STARTUP_BUDGET_ONE_TIME_MS)
  const runtime = createRuntime(testInfo)
  runtime.workspace = join(runtime.home, 'workspace')
  mkdirSync(runtime.workspace, { recursive: true })
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    let page = await desktop.launch()
    const template = await createReadyProject(page, '启动验收模板')
    writeFileSync(join(template.root, 'resources', STARTUP_NOTE_FILENAME), STARTUP_NOTE_CONTENT)
    await desktop.close()
    const repository = resolve(__dirname, '../../..')
    const python = process.platform === 'win32'
      ? join(repository, '.venv', 'Scripts', 'python.exe')
      : join(repository, '.venv', 'bin', 'python')
    const fixture = JSON.parse(execFileSync(python, [
      '-c', HISTORICAL_PROJECT_SEED, runtime.workspace, template.root, String(HISTORICAL_PROJECT_COUNT)
    ], { env: { ...process.env, SCHOLARSEED_HOME: runtime.home }, encoding: 'utf8' })) as { roots: string[]; operation: string }
    const started = Date.now()
    page = await desktop.launch()
    const elapsedMs = Date.now() - started
    expect(elapsedMs).toBeLessThan(STARTUP_BUDGET_STEADY_MS)
    const response = await page.request.get(`${await apiBase(page)}/api/content/projects`)
    expect(response.ok()).toBe(true)
    expect((await response.json()).projects).toHaveLength(HISTORICAL_PROJECT_COUNT)
    for (const root of [template.root, ...fixture.roots]) {
      expect(readFileSync(join(root, 'resources', STARTUP_NOTE_FILENAME), 'utf8')).toBe(STARTUP_NOTE_CONTENT)
    }
    const backendLog = readFileSync(join(runtime.home, 'logs', 'backend.log'), 'utf8')
    expect(backendLog).toContain(`startup_project_inspection_completed projects=${HISTORICAL_PROJECT_COUNT}`)
    expect(backendLog).toContain(`content_operation_completed operation_id=${fixture.operation} command=ReconcileProjectRemoval state=succeeded`)
    const operation = await page.request.get(`${await apiBase(page)}/api/content/operations/${fixture.operation}`)
    expect(operation.ok()).toBe(true)
    expect((await operation.json()).state).toBe('succeeded')
    await expect(page.getByTestId('composer-send')).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'historical-projects-restarted.png') })
    await page.getByTestId('topbar-project').click()
    await page.getByTestId(`project-menu-option-${template.name}`).click()
    await page.getByTestId('resource-refresh').click()
    await page.getByTestId(`tree-resources/${STARTUP_NOTE_FILENAME}`).dblclick()
    await expect(page.getByText(STARTUP_NOTE_CONTENT, { exact: true }).first()).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'historical-projects-files-preserved.png') })
    const outcome = {
      projects: HISTORICAL_PROJECT_COUNT,
      elapsedMs,
      filesPreserved: fixture.roots.length + 1,
      recoveredOperation: fixture.operation
    }
    writeFileSync(join(runtime.artifacts, 'historical-project-startup.json'), JSON.stringify(outcome))
    await testInfo.attach('historical-project-startup', {
      body: JSON.stringify(outcome),
      contentType: 'application/json'
    })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('P0-1 starts Electron with the real new-stack backend', async ({}, testInfo) => {
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo)
  try {
    const page = await desktop.launch()
    const health = await page.evaluate(
      async (base) => {
        const response = await fetch(`${base}/api/healthz`)
        return response.json()
      },
      await apiBase(page)
    )
    expect(health).toMatchObject({ ok: true, stack: 'codex-appserver', runtime_id: 'codex' })
    await expect(page.getByTestId('composer-send')).toBeVisible()
    const webPreferences = await desktop.app!.evaluate(({ BrowserWindow }) => {
      const productWindow = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().startsWith('http://')
      )
      if (!productWindow) throw new Error('ScholarSeed product window did not open')
      const contents = productWindow.webContents
      if (!('getLastWebPreferences' in contents) || typeof contents.getLastWebPreferences !== 'function') {
        throw new Error('Electron does not expose the WebPreferences diagnostic method')
      }
      const preferences: unknown = contents.getLastWebPreferences()
      if (typeof preferences !== 'object' || preferences === null ||
          !('sandbox' in preferences) || typeof preferences.sandbox !== 'boolean' ||
          !('contextIsolation' in preferences) || typeof preferences.contextIsolation !== 'boolean' ||
          !('nodeIntegration' in preferences) || typeof preferences.nodeIntegration !== 'boolean') {
        throw new Error('Electron WebPreferences diagnostic returned invalid security fields')
      }
      return {
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
      }
    })
    expect(webPreferences).toEqual({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    })
    await page.screenshot({ path: join(desktop.runtime.artifacts, 'startup-ready.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('model menu excludes retired native Codex and offers configured connections', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(
    join(runtime.home, 'config.json'),
    JSON.stringify({
      provider: 'openai',
      base_url: SCHOLARSEED_GATEWAY_BASE_URL,
      call_url: `${SCHOLARSEED_GATEWAY_BASE_URL}/chat/completions`,
      model_name: 'qwen3.8-max',
      small_model_name: 'qwen3.8-max',
      selected_model_key: 'qwen3.8-max',
    })
  )
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await page.getByTestId('model-selector-toggle').click()

    const options = page.locator('[data-testid^="model-option-"]')
    await expect(options).toHaveCount(2)
    await expect(page.getByTestId('model-option-codex-subscription-default')).toHaveCount(0)
    await expect(page.getByTestId('model-option-qwen3.8-max')).toBeVisible()
    await expect(page.getByTestId('model-option-qwen3.8-flash')).toBeVisible()
    await expect(page.getByTestId('model-option-codex-5.6-sol')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'model-catalog-configured.png') })

    const qwenOption = page.getByTestId('model-option-qwen3.8-max')
    const hitTarget = await qwenOption.evaluate((option) => {
      const rect = option.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return hit === option || Boolean(hit?.closest('[data-testid^="model-option-"]'))
    })
    expect(hitTarget).toBe(true)

    await qwenOption.click()
    await expect(page.locator('.model-menu-popover')).toHaveCount(0)

    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('conversation skill pickers refresh after user skill installation and activation changes', async ({}, testInfo) => {
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo)
  const skillName = 'user-skill-search-check'
  const skillDocument = `---\nname: ${skillName}\ndescription: A local skill for checking conversation selection.\n---\n\nExplain the user's selected topic in one sentence.\n`
  try {
    const page = await desktop.launch()
    const search = page.getByRole('searchbox', { name: '搜索已启用的技能' })
    const candidate = page.getByTestId(`composer-skill-${skillName}`)
    const openSkills = async (): Promise<void> => {
      await page.getByTestId('activity-account').click()
      await page.getByTestId('account-menu-settings').click()
      await page.getByTestId('account-settings-nav-skills').click()
    }
    const newChat = async (): Promise<void> => {
      await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
      await page.getByTestId('ai-new-session').click()
    }
    const openPicker = async (): Promise<void> => {
      await page.getByTestId('composer-plus').click()
      await page.getByTestId('composer-skills-menu').click()
      await expect(search).toBeVisible()
      await search.fill(skillName)
      await expect(page.getByText('加载技能…', { exact: true })).toHaveCount(0)
    }

    // Populate the composer before installation, reproducing the stale-cache path.
    await openPicker()
    await expect(candidate).toHaveCount(0)
    await page.getByTestId('composer-skill-add').click()
    await page.getByTestId('skill-upload-input').setInputFiles({
      name: 'SKILL.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(skillDocument),
    })
    await page.getByTestId('skill-install').click()
    await expect(page.getByTestId('skill-add-modal')).toHaveCount(0)
    await openSkills()
    await expect(page.getByTestId(`skill-card-${skillName}`)).toBeVisible()
    await expect(page.getByTestId(`skill-toggle-${skillName}`)).toHaveAttribute(
      'aria-checked',
      'true'
    )

    await newChat()
    await openPicker()
    await expect(candidate).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('user-skill-search.png') })
    await candidate.click()
    await expect(page.getByRole('button', { name: `移除技能 ${skillName}` })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('user-skill-selected.png') })

    // Both entry points share the authoritative inventory, including disabled state.
    await openSkills()
    await page.getByTestId(`skill-toggle-${skillName}`).click()
    await expect(page.getByTestId(`skill-toggle-${skillName}`)).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByText(`${skillName}已停用`, { exact: true })).toBeVisible()
    await newChat()
    await openPicker()
    await expect(candidate).toHaveCount(0)
    // A real click outside the popup hits its dismissal backdrop.
    const plus = await page.getByTestId('composer-plus').boundingBox()
    if (!plus) throw new Error('Composer plus button is not visible')
    await page.mouse.click(plus.x + plus.width / 2, plus.y + plus.height / 2)
    await page.getByTestId('composer-input').fill(`@skill:${skillName}`)
    await expect(page.getByTestId(`composer-at-skill-${skillName}`)).toHaveCount(0)

    await openSkills()
    await page.getByTestId(`skill-toggle-${skillName}`).click()
    await expect(page.getByTestId(`skill-toggle-${skillName}`)).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByText(`${skillName}已启用`, { exact: true })).toBeVisible()
    await newChat()
    await openPicker()
    await expect(candidate).toBeVisible()
    await page.getByTestId('composer-plus').click()
    await page.getByTestId('composer-input').fill('')
    await page.getByTestId('composer-input').fill(`@skill:${skillName}`)
    await expect(page.getByTestId(`composer-at-skill-${skillName}`)).toHaveAttribute(
      'aria-disabled',
      'false'
    )
    await page.getByTestId(`composer-at-skill-${skillName}`).click()
    await expect(page.getByRole('button', { name: `移除技能 ${skillName}` })).toBeVisible()

    await openSkills()
    await page.getByTestId(`skill-remove-${skillName}`).click()
    await page.getByTestId('skill-remove-confirm').getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(page.getByTestId(`skill-card-${skillName}`)).toHaveCount(0)
    await newChat()
    await openPicker()
    await expect(candidate).toHaveCount(0)
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('ChatGPT subscription connection can be created in Desktop without CLI login', async ({}, testInfo) => {
  test.skip(process.env.SCHOLARSEED_CI_OFFLINE === '1', 'Requires real provider credentials')
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    await page.getByTestId('activity-account').click()
    await page.getByTestId('account-menu-settings').click()
    await page.getByTestId('account-settings-nav-models').click()
    await page.getByTestId('model-connection-add').click()
    await page.getByTestId('model-endpoint-provider').click()
    await page.getByRole('option', { name: 'ChatGPT（订阅登录）', exact: true }).click()
    const section = page.getByRole('region', { name: 'ChatGPT 订阅连接' })
    await expect(section).toBeVisible()
    await section.getByRole('button', { name: '连接 ChatGPT', exact: true }).click()
    await expect(section.getByRole('button', { name: '登录 ChatGPT', exact: true })).toBeVisible()
    await expect(section.getByText('ChatGPT · 未连接', { exact: true })).toBeVisible()
    await page.screenshot({ path: join(desktop.runtime.artifacts, 'chatgpt-connection.png') })
    await page.getByTestId('account-settings-nav-preferences').click()
    await page.getByRole('combobox', { name: '外观' }).click()
    await page.getByRole('option', { name: '深色', exact: true }).click()
    await page.getByTestId('account-settings-nav-models').click()
    await page
      .locator('[data-testid^="model-connection-pick-"]')
      .filter({ hasText: 'ChatGPT' })
      .click()
    await expect(section.getByText('ChatGPT · 未连接', { exact: true })).toBeVisible()
    await page.screenshot({ path: join(desktop.runtime.artifacts, 'chatgpt-connection-dark.png') })
    // Adding a subscription card must not push the existing endpoint controls out of view.
    await expect(page.getByTestId('model-connection-add')).toBeInViewport()
    await page.getByTestId('model-connection-add').click()
    await expect(page.getByTestId('model-endpoint-save')).toBeInViewport()
    await page.getByTestId('model-endpoint-provider').click()
    await page
      .getByRole('option', { name: '自定义（自建服务或未列出的供应商）', exact: true })
      .click()
    await page.getByTestId('model-endpoint-name').fill('Endpoint alongside ChatGPT')
    await page.getByTestId('model-endpoint-base-url').fill('http://127.0.0.1:8000/v1')
    await page.getByTestId('model-endpoint-api-key').fill('fixture-key-not-for-network')
    await page.getByTestId('model-endpoint-manual-model').fill('endpoint-model')
    await page.getByTestId('model-endpoint-add-model').click()
    await page.getByTestId('model-endpoint-save').click()
    await expect(
      page
        .locator('[data-testid^="model-connection-pick-"]')
        .filter({ hasText: 'Endpoint alongside ChatGPT' })
    ).toContainText('Endpoint alongside ChatGPT')
    await page.reload()
    await page.getByTestId('activity-account').click()
    await page.getByTestId('account-menu-settings').click()
    await page.getByTestId('account-settings-nav-models').click()
    await page
      .locator('[data-testid^="model-connection-pick-"]')
      .filter({ hasText: 'Endpoint alongside ChatGPT' })
      .click()
    await expect(page.getByTestId('model-endpoint-name')).toHaveValue('Endpoint alongside ChatGPT')
    await expect(page.getByTestId('model-endpoint-save')).toBeInViewport()
    await page.screenshot({ path: join(desktop.runtime.artifacts, 'chatgpt-and-endpoint.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('saved API key stays masked and clearing requires replacement before saving', async ({}, testInfo) => {
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    await page.getByTestId('activity-account').click()
    await page.getByTestId('account-menu-settings').click()
    await page.getByTestId('account-settings-nav-models').click()
    await page.getByTestId('model-connection-add').click()
    await page.getByTestId('model-endpoint-provider').click()
    await page
      .getByRole('option', { name: '自定义（自建服务或未列出的供应商）', exact: true })
      .click()
    await page.getByTestId('model-endpoint-name').fill('API key mask regression')
    await page.getByTestId('model-endpoint-base-url').fill('http://127.0.0.1:8000/v1')
    await page.getByTestId('model-endpoint-api-key').fill('fixture-key-not-for-network')
    await page.getByTestId('model-endpoint-manual-model').fill('fixture-model')
    await page.getByTestId('model-endpoint-add-model').click()
    await page.getByTestId('model-endpoint-save').click()
    const connection = page
      .locator('[data-testid^="model-connection-pick-"]')
      .filter({ hasText: 'API key mask regression' })
    await expect(connection).toBeVisible()

    await page.reload()
    await page.getByTestId('activity-account').click()
    await page.getByTestId('account-menu-settings').click()
    await page.getByTestId('account-settings-nav-models').click()
    await connection.click()
    const apiKey = page.getByTestId('model-endpoint-api-key')
    await expect(apiKey).toHaveAttribute('type', 'password')
    await expect(apiKey).toHaveValue('')
    await expect(apiKey).toHaveAttribute('placeholder', '••••••••')
    await expect(page.getByTestId('model-endpoint-api-key-clear')).toBeVisible()
    await expect(page.getByRole('button', { name: /显示密码|Show password/ })).toHaveCount(0)
    await expect(page.getByTestId('model-endpoint-save')).toBeEnabled()
    await page.getByTestId('model-endpoint-api-key-clear').click()
    await expect(page.getByTestId('model-endpoint-save')).toBeDisabled()
    await expect(page.getByTestId('model-endpoint-probe')).toBeDisabled()
    await expect(page.getByTestId('model-endpoint-fetch-models')).toBeDisabled()
    await page.screenshot({ path: join(desktop.runtime.artifacts, 'saved-api-key-cleared.png') })
    await apiKey.fill('replacement-key-not-for-network')
    await expect(page.getByTestId('model-endpoint-save')).toBeEnabled()
    await page.getByTestId('model-endpoint-cancel').click()
    await expect(apiKey).toHaveValue('')
    await expect(apiKey).toHaveAttribute('placeholder', '••••••••')
    await page.screenshot({ path: join(desktop.runtime.artifacts, 'saved-api-key-masked.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('leaving model settings cancels a subscription login delivered after unmount', async ({}, testInfo) => {
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo)
  const transactionId = 'pending-login-unmount-regression'
  try {
    const page = await desktop.launch()
    // Deterministic IPC lifecycle regression: no issuer login or model acceptance.
    await desktop.app!.evaluate(({ ipcMain }, channel) => {
      const state = globalThis as typeof globalThis & {
        releaseSubscriptionLogin?: (reply: SubscriptionReply) => void
      }
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, request) =>
        request.action === 'available'
          ? { available: true }
          : new Promise<SubscriptionReply>((resolve) => {
              state.releaseSubscriptionLogin = resolve
            })
      )
    }, SUBSCRIPTION_CHANNEL)
    await page.getByTestId('activity-account').click()
    await page.getByTestId('account-menu-settings').click()
    await page.getByTestId('account-settings-nav-models').click()
    await page.getByTestId('model-connection-add').click()
    await page.getByTestId('model-endpoint-provider').click()
    await page.getByRole('option', { name: 'ChatGPT（订阅登录）', exact: true }).click()
    const section = page.getByRole('region', { name: 'ChatGPT 订阅连接' })
    await section.getByRole('button', { name: '连接 ChatGPT', exact: true }).click()
    const login = section.getByRole('button', { name: '登录 ChatGPT', exact: true })
    await login.click()
    await expect(login).toBeDisabled()
    await expect.poll(() => desktop.app!.evaluate(() => Boolean(
      (globalThis as typeof globalThis & { releaseSubscriptionLogin?: unknown }).releaseSubscriptionLogin
    ))).toBe(true)
    await page.getByTestId('account-settings-nav-skills').click()
    await expect(section).toHaveCount(0)
    await page.route(`**/login/${transactionId}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{}',
      })
    )
    const cancelled = page.waitForRequest(
      (request) =>
        request.method() === 'DELETE' && request.url().endsWith(`/login/${transactionId}`)
    )
    await desktop.app!.evaluate((_electron, id) => {
      const state = globalThis as typeof globalThis & {
        releaseSubscriptionLogin?: (reply: SubscriptionReply) => void
      }
      state.releaseSubscriptionLogin!({
        available: true,
        login: {
          transaction_id: id,
          state: 'authorizing',
          expires_at: 0,
          error: '',
        },
      })
      delete state.releaseSubscriptionLogin
    }, transactionId)
    await cancelled
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('preset provider connects with only an API key and keeps custom configuration separate', async ({}, testInfo) => {
  test.skip(process.env.SCHOLARSEED_CI_OFFLINE === '1', 'Requires real provider credentials')
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    await page.getByTestId('activity-account').click()
    await page.getByTestId('account-menu-settings').click()
    await page.getByTestId('account-settings-nav-models').click()
    await page.getByTestId('model-connection-add').click()
    await expect(page.getByTestId('model-endpoint-provider')).toContainText('自定义')
    await expect(page.getByTestId('model-endpoint-name')).toHaveValue('')
    await expect(page.getByTestId('model-endpoint-base-url')).toHaveValue('')
    await page.getByTestId('model-endpoint-provider').click()
    await page.getByRole('option', { name: '阿里云百炼', exact: true }).click()
    await expect(page.getByTestId('model-endpoint-base-url')).toHaveCount(0)
    await expect(page.getByTestId('model-endpoint-wire-api')).toHaveCount(0)
    await expect(page.getByTestId('model-endpoint-manual-model')).toHaveCount(0)
    await expect(page.getByTestId('model-endpoint-save')).toBeDisabled()
    // Directory fixture verifies UI orchestration only; no vendor connectivity claim.
    let attempts = 0
    await page.route('**/api/serve/model-profiles/models', async (route) => {
      const body = route.request().postDataJSON()
      expect(body.api_key).toBe('fixture-provider-key')
      expect(body.base_url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
      expect(body.wire_api).toBe('chat_completions')
      attempts += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          attempts === 1
            ? { ok: false, models: [], message: '密钥无效，请重试', latency_ms: 1 }
            : {
                ok: true,
                models: ['provider-model-a', 'provider-model-b'],
                message: '已读取模型',
                latency_ms: 1,
              }
        ),
      })
    })
    await page.getByTestId('model-endpoint-api-key').fill('fixture-provider-key')
    await page.screenshot({ path: join(desktop.runtime.artifacts, 'provider-key-only.png') })
    await page.getByTestId('model-endpoint-save').click()
    await expect(page.getByRole('alert')).toContainText('密钥无效')
    await expect(page.locator('[data-testid^="model-connection-pick-"]')).toHaveCount(0)
    await page.getByTestId('model-endpoint-save').click()
    await expect(page.locator('[data-testid^="model-connection-pick-"]')).toContainText(
      '阿里云百炼'
    )
    await expect(page.getByTestId('model-endpoint-model-provider-model-a')).not.toBeChecked()
    await expect(page.getByTestId('model-endpoint-model-provider-model-b')).not.toBeChecked()
    await page.getByTestId('model-endpoint-model-search').fill('MODEL-A')
    await expect(page.getByTestId('model-endpoint-model-provider-model-b')).toHaveCount(0)
    await page.getByTestId('model-endpoint-select-all').click()
    await page.getByTestId('model-endpoint-model-search').fill('')
    await expect(page.getByTestId('model-endpoint-model-provider-model-a')).toBeChecked()
    await expect(page.getByTestId('model-endpoint-model-provider-model-b')).not.toBeChecked()
    await page.getByTestId('model-endpoint-save').click()
    await expect(page.locator('[data-testid^="model-connection-pick-"]')).toContainText('已选 1')
    await expect(page.getByTestId('model-endpoint-api-key')).toHaveValue('')
    await page.screenshot({ path: join(desktop.runtime.artifacts, 'provider-connected.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('model selection closes immediately while a slow switch is pending', async ({}, testInfo) => {
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo)
  let release: (() => void) | undefined
  try {
    const page = await desktop.launch()
    const catalog = {
      available_models: [
        { key: 'stable-model', label: 'Stable model', provider: 'openai', billing: 'api' },
        { key: 'slow-switch-model', label: 'Slow switch model', provider: 'openai', billing: 'api' }
      ],
      current_model: 'stable-model', subscription_groups: []
    }
    await page.route('**/api/serve/models', (route) => route.fulfill({ json: catalog }))
    // Hold the response until after asserting the click feedback; no latency sleeps.
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/api/serve/models/default', async (route) => {
      await gate
      await route.fulfill({ status: 500, json: { detail: 'switch failed' } })
    })
    await page.reload()
    await page.getByTestId('activity-literature').click()
    if (!(await page.getByTestId('ai-panel').isVisible()))
      await page.getByTestId('topbar-ai').click()
    await page.getByTestId('model-selector-toggle').click()
    await page.getByTestId('model-option-slow-switch-model').click()
    await expect(page.getByTestId('model-option-slow-switch-model')).toHaveCount(0)
    await expect(page.getByTestId('model-selector-toggle')).toContainText('切换中')
    await expect(page.getByTestId('model-selector-toggle')).toBeDisabled()
    release!()
    await expect(page.getByTestId('model-selector-toggle')).toBeEnabled()
    await expect(page.getByTestId('model-selector-toggle')).not.toContainText('Slow switch model')
    await expect(page.getByText('模型切换失败。', { exact: true })).toBeVisible()
    desktop.assertNoPageErrors()
  } finally {
    release?.()
    await desktop.attachArtifacts()
  }
})

test('DeepSeek flash reasoning declarations save and survive catalog reload', async ({}, testInfo) => {
  const realHome = process.env.SCHOLARSEED_REAL_HOME
  test.skip(
    !realHome || !existsSync(join(realHome, 'model_profiles.json')),
    'Requires an existing DeepSeek connection'
  )
  const runtime = createRuntime(testInfo)
  for (const file of ['config.json', 'model_profiles.json']) {
    copyFileSync(join(realHome!, file), join(runtime.home, file))
  }
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const openSettings = async (): Promise<void> => {
      await page.getByTestId('activity-account').click()
      await page.getByTestId('account-menu-settings').click()
      await page.getByTestId('account-settings-nav-model-settings').click()
    }
    await openSettings()
    const edit = page.locator(
      '[data-testid^="model-reasoning-edit-"][data-testid$="deepseek-v4-flash-0731"]'
    )
    await expect(edit).toHaveCount(1)
    const key = (await edit.getAttribute('data-testid'))!.replace('model-reasoning-edit-', '')
    await edit.click()
    const input = page.getByTestId(`model-reasoning-levels-${key}`)
    await input.fill('invalid-effort')
    await page.getByRole('button', { name: '保存档位', exact: true }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(input).toBeVisible()
    await input.fill('low,high')
    await page.getByRole('button', { name: '保存档位', exact: true }).click()
    await expect(input).toHaveCount(0, { timeout: 60_000 })
    const selector = page.getByTestId(`model-reasoning-${key}`)
    await selector.click()
    await page.getByRole('option', { name: 'high', exact: true }).click()
    await expect(selector).toContainText('high')
    await page.reload()
    await openSettings()
    await expect(page.getByTestId(`model-reasoning-${key}`)).toContainText('high')
    await page.screenshot({
      path: join(runtime.artifacts, 'deepseek-flash-reasoning.png'),
      animations: 'disabled',
    })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

for (const source of ['pointer', 'home', 'workspace'] as const) {
  test(`invalid storage ${source} stops the real Electron entry before backend startup`, async ({}, testInfo) => {
    const runtime = createRuntime(testInfo)
    const pointer = join(runtime.userData, 'storage-config.json')
    const content = '{ interrupted-pointer'
    writeFileSync(pointer, content)
    // Capture every persistent entry, not just the pointer or backend log: an early
    // startup regression must not initialize or rewrite any selected data root.
    function snapshot(directory: string): Record<string, string> {
      const entries: Record<string, string> = {}
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          entries[entry.name] = 'directory'
          for (const [child, digest] of Object.entries(snapshot(path))) {
            entries[join(entry.name, child)] = digest
          }
        } else {
          expect(entry.isFile()).toBe(true)
          entries[entry.name] = createHash('sha256').update(readFileSync(path)).digest('hex')
        }
      }
      return entries
    }
    const protectedRoots = [runtime.home, runtime.userData, runtime.workspace]
    const before = protectedRoots.map(snapshot)
    const environment = { ...process.env }
    // Isolate the OS home too: a regression must not fall back to the developer's data.
    environment[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = runtime.home
    environment.APPDATA = runtime.root
    environment.LOCALAPPDATA = runtime.root
    environment.SCHOLARSEED_DEFAULT_WORKSPACE = runtime.workspace
    if (source === 'pointer') delete environment.SCHOLARSEED_HOME
    else environment.SCHOLARSEED_HOME = source === 'home' ? 'relative-home' : runtime.home
    if (source === 'workspace') environment.SCHOLARSEED_DEFAULT_WORKSPACE = 'relative-workspace'
    delete environment.ELECTRON_RUN_AS_NODE
    const executable = require('electron') as string
    const result = await new Promise<{
      code: number | string | null | undefined
      killed: boolean
      stdout: string
      stderr: string
    }>((resolve) => {
      execFile(
        executable,
        ['.', '--shoot', `--user-data-dir=${runtime.userData}`],
        {
          cwd: join(__dirname, '..'),
          env: environment,
          timeout: 15_000,
        },
        (error, stdout, stderr) => {
          resolve({ code: error?.code, killed: error?.killed ?? false, stdout, stderr })
        }
      )
    })
    await testInfo.attach('storage-startup-output', {
      body: result.stdout + result.stderr,
      contentType: 'text/plain',
    })
    expect(result.killed).toBe(false)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain(
      source === 'pointer'
        ? pointer
        : `${source === 'home' ? 'SCHOLARSEED_HOME' : 'SCHOLARSEED_DEFAULT_WORKSPACE'} must be an absolute supported root`
    )
    expect(result.stdout).not.toContain('[backend]')
    expect(result.stderr).not.toContain('A JavaScript error occurred in the main process')
    expect(readFileSync(pointer, 'utf8')).toBe(content)
    expect(existsSync(join(runtime.home, 'logs', 'backend.log'))).toBe(false)
    expect(protectedRoots.map(snapshot)).toEqual(before)
  })
}

test('native storage pointer selects the real backend home without an environment override', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const pointer = join(runtime.userData, 'storage-config.json')
  const content = JSON.stringify({ schemaVersion: 1, dataHome: runtime.home })
  writeFileSync(pointer, content)
  writeFileSync(
    join(runtime.userData, 'renderer-preferences.json'),
    JSON.stringify({
      language: 'zh',
      onboarding: { seen: Object.fromEntries(ONBOARDING_GROUPS.map((group) => [group, true])) },
    })
  )
  const desktop = new DesktopSession(runtime, testInfo, { homeFromPointer: true })
  try {
    const page = await desktop.launch()
    const selected = await desktop.app!.evaluate(() => process.env.SCHOLARSEED_HOME)
    expect(selected).toBe(runtime.home)
    const health = await page.evaluate(
      async (base) => (await fetch(`${base}/api/healthz`)).json(),
      await apiBase(page)
    )
    expect(health).toMatchObject({ ok: true, stack: 'codex-appserver', runtime_id: 'codex' })
    await expect(page.getByTestId('composer-send')).toBeVisible()
    expect(readFileSync(pointer, 'utf8')).toBe(content)
    expect(existsSync(join(runtime.home, 'logs', 'backend.log'))).toBe(true)
    await page.screenshot({
      path: join(runtime.artifacts, 'native-pointer-startup.png'),
      animations: 'disabled',
    })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('data home IPC refuses a configured runtime without changing its pointer or home', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, { preserveNavigation: true })
  const pointer = join(runtime.userData, 'storage-config.json')
  const content = JSON.stringify({ schemaVersion: 1, dataHome: runtime.home })
  writeFileSync(pointer, content)
  try {
    const page = await desktop.launch()
    const before = await page.evaluate(() => window.scholarseed.storageConfig())
    expect(before.firstLaunchEligible).toBe(false)
    const result = await page.evaluate(
      (parent) => window.scholarseed.commitDataHome(parent),
      runtime.workspace
    )
    expect(result).toEqual({ ok: false, reason: 'unsupported' })
    expect(readFileSync(pointer, 'utf8')).toBe(content)
    expect(existsSync(join(runtime.workspace, '.scholarseed'))).toBe(false)
    expect(await desktop.app!.evaluate(() => process.env.SCHOLARSEED_HOME)).toBe(runtime.home)
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
