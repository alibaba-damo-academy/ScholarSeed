import { join } from 'path'
import { writeFileSync } from 'fs'
import { expect, test } from '@playwright/test'
import { DesktopSession, enterWorkbenchShell, apiBase } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const catalog = {
  available_models: [
    {
      key: 'qwen3.8-max',
      label: 'Qwen 3.8 Max',
      source: 'builtin',
      billing: 'api',
      disabled: true,
      disabled_reason_code: 'gateway_credential_required',
      disabled_reason: '登录后可使用内置模型'
    },
    { key: 'qwen3.8-flash-preview', label: 'Qwen 3.8 Flash Preview', source: 'builtin', billing: 'api' },
    {
      key: 'personal-aa:liquid/lfm-2.5-1b-instruct',
      label: 'liquid/lfm-2.5-1b-instruct',
      provider_label: 'OpenRouter',
      source: 'personal',
      billing: 'api'
    },
    {
      key: 'personal-bb:qwen2.5-coder-14b-instruct-q5_K_M',
      label: 'qwen2.5-coder-14b-instruct-q5_K_M-long-context-experimental',
      provider_label: 'Local Ollama / vLLM',
      source: 'personal',
      billing: 'api',
      reasoning_efforts: ['low', 'medium', 'high']
    },
    {
      key: 'personal-bb:glm-4.6v-flash-free',
      label: 'glm-4.6v-flash-free',
      provider_label: 'Local Ollama / vLLM',
      source: 'personal',
      billing: 'api'
    },
    {
      key: 'personal-bb:qwen3-vl-235b-a22b-thinking',
      label: 'qwen3-vl-235b-a22b-thinking',
      provider_label: 'Local Ollama / vLLM',
      source: 'personal',
      billing: 'api'
    },
    {
      key: 'personal-cc:gemini-2.5-flash-lite',
      label: 'gemini-2.5-flash-lite',
      provider_label: 'Gemini Direct',
      source: 'personal',
      billing: 'api'
    }
  ],
  current_model: 'personal-bb:qwen2.5-coder-14b-instruct-q5_K_M',
  subscription_groups: []
}

test('model menus fit content within bounds and animate without moving the main menu', async ({}, testInfo) => {
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo)
  try {
    writeFileSync(
      join(desktop.runtime.userData, 'renderer-preferences.json'),
      JSON.stringify({ language: 'zh', onboarding: { seen: { home: true, project: true, globalLib: true, pdf: true } } })
    )
    const page = await desktop.launch()
    const actualCatalog = await (await page.request.get(`${await apiBase(page)}/api/serve/models`)).json()
    await page.route('**/api/serve/models', (route) => route.fulfill({ json: {
      ...actualCatalog, ...catalog, configured: true,
    } }))
    await page.reload()
    await enterWorkbenchShell(page)
    if (!await page.getByTestId('ai-panel').isVisible().catch(() => false)) {
      await page.getByTestId('topbar-ai').click()
      await expect(page.getByTestId('ai-panel')).toBeVisible()
    }
    await page.getByTestId('model-selector-toggle').focus()
    await page.getByTestId('model-selector-toggle').press('Enter')
    const menu = page.getByTestId('model-selector-menu')
    await expect(menu).toBeVisible()
    for (const header of [/内置模型|Built-in model/, 'OpenRouter', 'Local Ollama / vLLM', 'Gemini Direct']) {
      await expect(menu.getByText(header, { exact: true })).toHaveCount(1)
    }
    await expect(menu.getByTestId('model-option-personal-bb:qwen2.5-coder-14b-instruct-q5_K_M')).toHaveAttribute(
      'data-selected',
      'true'
    )
    const truncated = await menu
      .locator('[data-testid^="model-option-"]')
      .evaluateAll((rows) =>
        rows
          .map((row) => {
            const name = row.querySelector('[data-slot="ellipsis-text"]')
            return name && name.scrollWidth > name.clientWidth ? name.textContent : null
          })
          .filter(Boolean)
      )
    expect(truncated).toContain('qwen2.5-coder-14b-instruct-q5_K_M-long-context-experimental')
    await menu.getByText('qwen2.5-coder-14b-instruct-q5_K_M-long-context-experimental', { exact: true }).hover()
    await expect(page.getByRole('tooltip')).toHaveText('qwen2.5-coder-14b-instruct-q5_K_M-long-context-experimental')
    await page.mouse.move(0, 0)
    // 思考强度二级卡向左弹: 展开后主菜单盒逐像素不变, 且二级卡整体位于主菜单左侧。
    const boxOf = async (locator: ReturnType<typeof page.getByTestId>) => {
      const box = await locator.boundingBox()
      return box && { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
    }
    // 置灰的内置模型行名字后挂灰色短 tag; 底部「切换后…」footnote 不再渲染。
    await expect(page.getByTestId('model-option-qwen3.8-max')).toContainText('登录可用')
    await expect(menu.getByText(/切换后/)).toHaveCount(0)
    const menuBox = await boxOf(menu)
    expect(menuBox?.width).toBe(320)
    const samples = await page.evaluate(async () => {
      const trigger = document.querySelector<HTMLElement>('[data-testid="model-effort-row"]')!
      const main = document.querySelector<HTMLElement>('[data-testid="model-selector-menu"]')!
      const frames: { width: number; right: number; gap: number | null }[] = []
      trigger.click()
      await new Promise<void>((resolve) => {
        const start = performance.now()
        const sample = () => {
          const effort = document.querySelector<HTMLElement>('[data-testid="model-effort-menu"]')
          const effortBox = effort?.getBoundingClientRect()
          const mainBox = main.getBoundingClientRect()
          frames.push({ width: effortBox?.width ?? 0, right: mainBox.right, gap: effortBox ? mainBox.left - effortBox.right : null })
          if (performance.now() - start < 500) requestAnimationFrame(sample)
          else resolve()
        }
        requestAnimationFrame(sample)
      })
      return frames
    })
    const effortMenu = page.getByTestId('model-effort-menu')
    await expect(effortMenu).toBeVisible()
    const effortBox = await boxOf(effortMenu)
    expect(effortBox?.width).toBe(200)
    expect(samples.some(({ width }) => width > 0 && width < 199)).toBe(true)
    expect(Math.max(...samples.map(({ right }) => right)) - Math.min(...samples.map(({ right }) => right))).toBeLessThanOrEqual(1)
    expect(samples.filter(({ width }) => width > 0).every(({ gap }) => gap === 8)).toBe(true)
    expect(await boxOf(menu)).toEqual(menuBox)
    expect(effortBox && menuBox && effortBox.x + effortBox.width <= menuBox.x + 1).toBe(true)
    expect(menuBox!.x - effortBox!.x - effortBox!.width).toBe(8)
    await page.screenshot({ path: join(desktop.runtime.artifacts, 'model-menu-groups.png') })
    await page.setViewportSize({ width: 480, height: 800 })
    await expect.poll(async () => (await boxOf(menu))!.width).toBeLessThanOrEqual(224)
    const narrowMain = (await boxOf(menu))!
    const narrowEffort = (await boxOf(effortMenu))!
    expect(narrowEffort.x).toBeGreaterThanOrEqual(0)
    expect(narrowMain.x + narrowMain.width).toBeLessThanOrEqual(480)
    expect(narrowMain.x - narrowEffort.x - narrowEffort.width).toBe(8)
    await page.setViewportSize({ width: 1280, height: 840 })
    await page.getByTestId('model-effort-row').click()
    await expect(effortMenu).not.toBeVisible()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByTestId('model-effort-row').click()
    await expect(effortMenu).toBeVisible()
    await expect(effortMenu).toHaveCSS('transition-property', 'none')
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
    await expect(page.getByTestId('model-selector-toggle')).toHaveAttribute('aria-expanded', 'false')
    for (const [label, minimum, maximum] of [['Qwen', 200, 200], ['Medium length model name', 201, 319]] as const) {
      await page.unroute('**/api/serve/models')
      await page.route('**/api/serve/models', (route) => route.fulfill({ json: {
        ...actualCatalog, configured: true,
        available_models: [{ key: 'qwen', label, source: 'builtin', billing: 'api' }],
        current_model: 'qwen', subscription_groups: []
      } }))
      await page.reload()
      await enterWorkbenchShell(page)
      await page.getByTestId('model-selector-toggle').click()
      await expect(menu).toBeVisible()
      const width = (await boxOf(menu))!.width
      expect(width).toBeGreaterThanOrEqual(minimum)
      expect(width).toBeLessThanOrEqual(maximum)
    }
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
