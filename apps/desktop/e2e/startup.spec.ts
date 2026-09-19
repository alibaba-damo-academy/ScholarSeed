import { copyFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { expect, test } from '@playwright/test'
import { apiBase, DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { SUBSCRIPTION_CHANNEL, type SubscriptionReply } from '../src/subscriptions'

const SCHOLARSEED_GATEWAY_BASE_URL = 'https://scholarseed.damo.alibaba.com/v1'

test('P0-1 starts Electron with the real new-stack backend', async ({}, testInfo) => {
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo)
  try {
    const page = await desktop.launch()
    const health = await page.evaluate(async (base) => {
      const response = await fetch(`${base}/api/healthz`)
      return response.json()
    }, await apiBase(page))
    expect(health).toMatchObject({ ok: true, stack: 'codex-appserver', runtime_id: 'codex' })
    await expect(page.getByTestId('composer-send')).toBeVisible()
    const webPreferences = await desktop.app!.evaluate(({ BrowserWindow }) => {
      const productWindow = BrowserWindow.getAllWindows().find((candidate) => (
        candidate.webContents.getURL().startsWith('http://')
      ))
      if (!productWindow) throw new Error('ScholarSeed product window did not open')
      const preferences = productWindow.webContents.getLastWebPreferences()
      return {
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration
      }
    })
    expect(webPreferences).toEqual({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    })
    await page.screenshot({ path: join(desktop.runtime.artifacts, 'startup-ready.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('model menu excludes retired native Codex and offers configured connections', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.home, 'config.json'), JSON.stringify({
    provider: 'openai',
    base_url: SCHOLARSEED_GATEWAY_BASE_URL,
    call_url: `${SCHOLARSEED_GATEWAY_BASE_URL}/chat/completions`,
    model_name: 'qwen3.8-max',
    small_model_name: 'qwen3.8-max',
    selected_model_key: 'qwen3.8-max'
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await page.getByTestId('model-selector-toggle').click()

    const options = page.locator('[data-testid^="model-option-"]')
    await expect(options).toHaveCount(1)
    await expect(page.getByTestId('model-option-codex-subscription-default')).toHaveCount(0)
    await expect(page.getByTestId('model-option-qwen3.8-max')).toBeVisible()
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
    const search = page.getByRole('textbox', { name: '搜索已启用的技能' })
    const candidate = page.getByTestId(`composer-skill-${skillName}`)
    const openPicker = async (): Promise<void> => {
      const refreshed = page.waitForResponse((response) => response.url().includes('/api/serve/skills?force_reload=true'))
      await page.getByTestId('composer-plus').click()
      await page.getByTestId('composer-skills-menu').click()
      expect((await refreshed).ok()).toBe(true)
      await search.fill(skillName)
      await expect(page.getByText('加载技能…', { exact: true })).toHaveCount(0)
    }

    // Populate the composer before installation, reproducing the stale-cache path.
    await openPicker()
    await expect(candidate).toHaveCount(0)
    await page.getByTestId('composer-skill-library').click()
    await page.getByTestId('skills-add').click()
    await page.getByTestId('skill-upload-input').setInputFiles({
      name: 'SKILL.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(skillDocument)
    })
    await page.getByTestId('skill-install').click()
    await expect(page.getByTestId('skill-add-modal')).toHaveCount(0)
    await expect(page.getByTestId(`skill-card-${skillName}`)).toBeVisible()
    await expect(page.getByTestId(`skill-toggle-${skillName}`)).toHaveAttribute('aria-checked', 'true')

    await page.getByTestId('sidebar-new-chat').click()
    await openPicker()
    await expect(candidate).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('user-skill-search.png') })
    await candidate.click()
    await expect(page.locator('.composer-skill-refs')).toContainText(skillName)
    await page.screenshot({ path: testInfo.outputPath('user-skill-selected.png') })

    // Both entry points share the authoritative inventory, including disabled state.
    await page.getByTestId('sidebar-skills').click()
    await page.getByTestId(`skill-toggle-${skillName}`).click()
    await expect(page.getByTestId(`skill-toggle-${skillName}`)).toHaveAttribute('aria-checked', 'false')
    await page.getByTestId('sidebar-new-chat').click()
    await openPicker()
    await expect(candidate).toHaveCount(0)
    // A real click outside the popup hits its dismissal backdrop.
    const plus = await page.getByTestId('composer-plus').boundingBox()
    if (!plus) throw new Error('Composer plus button is not visible')
    await page.mouse.click(plus.x + plus.width / 2, plus.y + plus.height / 2)
    await page.getByTestId('composer-input').fill(`@skill:${skillName}`)
    await expect(page.getByTestId(`composer-at-skill-${skillName}`)).toHaveAttribute('aria-disabled', 'true')

    await page.getByTestId('sidebar-skills').click()
    await page.getByTestId(`skill-toggle-${skillName}`).click()
    await expect(page.getByTestId(`skill-toggle-${skillName}`)).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('sidebar-new-chat').click()
    await page.getByTestId('composer-input').fill(`@skill:${skillName}`)
    await expect(page.getByTestId(`composer-at-skill-${skillName}`)).toHaveAttribute('aria-disabled', 'false')
    await page.getByTestId(`composer-at-skill-${skillName}`).click()
    await expect(page.locator('.composer-skill-refs')).toContainText(skillName)

    await page.getByTestId('sidebar-skills').click()
    await page.getByTestId(`skill-remove-${skillName}`).click()
    await page.getByTestId('skill-remove-confirm').click()
    await expect(page.getByTestId(`skill-card-${skillName}`)).toHaveCount(0)
    await page.getByTestId('sidebar-new-chat').click()
    await openPicker()
    await expect(candidate).toHaveCount(0)
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('ChatGPT subscription connection can be created in Desktop without CLI login', async ({}, testInfo) => {
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
    await page.locator('[data-testid^="model-connection-pick-"]').filter({ hasText: 'ChatGPT' }).click()
    await expect(section.getByText('ChatGPT · 未连接', { exact: true })).toBeVisible()
    await page.screenshot({ path: join(desktop.runtime.artifacts, 'chatgpt-connection-dark.png') })
    // Adding a subscription card must not push the existing endpoint controls out of view.
    await expect(page.getByTestId('model-connection-add')).toBeInViewport()
    await page.getByTestId('model-connection-add').click()
    await expect(page.getByTestId('model-endpoint-save')).toBeInViewport()
    await page.getByTestId('model-endpoint-provider').click()
    await page.getByRole('option', { name: '自定义（自建服务或未列出的供应商）', exact: true }).click()
    await page.getByTestId('model-endpoint-name').fill('Endpoint alongside ChatGPT')
    await page.getByTestId('model-endpoint-base-url').fill('http://127.0.0.1:8000/v1')
    await page.getByTestId('model-endpoint-api-key').fill('fixture-key-not-for-network')
    await page.getByTestId('model-endpoint-manual-model').fill('endpoint-model')
    await page.getByTestId('model-endpoint-add-model').click()
    await page.getByTestId('model-endpoint-save').click()
    await expect(page.locator('[data-testid^="model-connection-pick-"]').filter({ hasText: 'Endpoint alongside ChatGPT' })).toContainText('Endpoint alongside ChatGPT')
    await page.reload()
    await page.getByTestId('activity-account').click()
    await page.getByTestId('account-menu-settings').click()
    await page.getByTestId('account-settings-nav-models').click()
    await page.locator('[data-testid^="model-connection-pick-"]').filter({ hasText: 'Endpoint alongside ChatGPT' }).click()
    await expect(page.getByTestId('model-endpoint-name')).toHaveValue('Endpoint alongside ChatGPT')
    await expect(page.getByTestId('model-endpoint-save')).toBeInViewport()
    await page.screenshot({ path: join(desktop.runtime.artifacts, 'chatgpt-and-endpoint.png') })
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
      const state = globalThis as typeof globalThis & { releaseSubscriptionLogin?: (reply: SubscriptionReply) => void }
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, request) => request.action === 'available'
        ? { available: true }
        : new Promise<SubscriptionReply>(resolve => { state.releaseSubscriptionLogin = resolve }))
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
    await page.getByTestId('account-settings-nav-preferences').click()
    await expect(section).toHaveCount(0)
    await page.route(`**/login/${transactionId}`, route => route.fulfill({
      status: 200, contentType: 'application/json', body: '{}'
    }))
    const cancelled = page.waitForRequest(request => request.method() === 'DELETE'
      && request.url().endsWith(`/login/${transactionId}`))
    await desktop.app!.evaluate((_electron, id) => {
      const state = globalThis as typeof globalThis & { releaseSubscriptionLogin?: (reply: SubscriptionReply) => void }
      state.releaseSubscriptionLogin!({ available: true, login: {
        transaction_id: id, state: 'authorizing', expires_at: 0, error: ''
      } })
      delete state.releaseSubscriptionLogin
    }, transactionId)
    await cancelled
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('preset provider connects with only an API key and keeps custom configuration separate', async ({}, testInfo) => {
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    await page.getByTestId('activity-account').click()
    await page.getByTestId('account-menu-settings').click()
    await page.getByTestId('account-settings-nav-models').click()
    await page.getByTestId('model-connection-add').click()
    await expect(page.getByTestId('model-endpoint-base-url')).toHaveCount(0)
    await expect(page.getByTestId('model-endpoint-wire-api')).toHaveCount(0)
    await expect(page.getByTestId('model-endpoint-manual-model')).toHaveCount(0)
    await expect(page.getByTestId('model-endpoint-save')).toBeDisabled()
    // Directory fixture verifies UI orchestration only; no vendor connectivity claim.
    let attempts = 0
    await page.route('**/api/serve/model-profiles/models', async route => {
      const body = route.request().postDataJSON()
      expect(body.api_key).toBe('fixture-provider-key')
      expect(body.base_url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
      expect(body.wire_api).toBe('chat_completions')
      attempts += 1
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(attempts === 1
        ? { ok: false, models: [], message: '密钥无效，请重试', latency_ms: 1 }
        : { ok: true, models: ['provider-model-a', 'provider-model-b'], message: '已读取模型', latency_ms: 1 }) })
    })
    await page.getByTestId('model-endpoint-api-key').fill('fixture-provider-key')
    await page.screenshot({ path: join(desktop.runtime.artifacts, 'provider-key-only.png') })
    await page.getByTestId('model-endpoint-save').click()
    await expect(page.getByRole('alert')).toContainText('密钥无效')
    await expect(page.locator('[data-testid^="model-connection-pick-"]')).toHaveCount(0)
    await page.getByTestId('model-endpoint-save').click()
    await expect(page.locator('[data-testid^="model-connection-pick-"]')).toContainText('阿里云百炼')
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
      available_models: [{ key: 'slow-switch-model', label: 'Slow switch model', provider: 'openai', billing: 'api' }],
      current_model: '', subscription_groups: []
    }
    await page.route('**/api/serve/models', route => route.fulfill({ json: catalog }))
    // Hold the response until after asserting the click feedback; no latency sleeps.
    const gate = new Promise<void>(resolve => { release = resolve })
    await page.route('**/api/serve/models/default', async route => {
      await gate
      await route.fulfill({ status: 500, json: { detail: 'switch failed' } })
    })
    await page.reload()
    await page.getByTestId('activity-literature').click()
    if (!await page.getByTestId('ai-panel').isVisible()) await page.getByTestId('topbar-ai').click()
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
  test.skip(!realHome || !existsSync(join(realHome, 'model_profiles.json')), 'Requires an existing DeepSeek connection')
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
    const edit = page.locator('[data-testid^="model-reasoning-edit-"][data-testid$="deepseek-v4-flash-0731"]')
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
    await page.screenshot({ path: join(runtime.artifacts, 'deepseek-flash-reasoning.png'), animations: 'disabled' })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
