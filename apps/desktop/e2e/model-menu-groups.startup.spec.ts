import { join } from 'path'
import { writeFileSync } from 'fs'
import { expect, test } from '@playwright/test'
import { DesktopSession, enterWorkbenchShell } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'

// 回归验收: 模型菜单按提供商分组, 且模型名整行铺开不被省略号截断。
// 目录由 /api/serve/models 的 route stub 提供, 只验菜单渲染, 不声明任何厂商连通性。
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
      label: 'qwen2.5-coder-14b-instruct-q5_K_M',
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

test('model menu groups models by provider and shows full model names', async ({}, testInfo) => {
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo)
  try {
    writeFileSync(
      join(desktop.runtime.userData, 'renderer-preferences.json'),
      JSON.stringify({ language: 'zh', onboarding: { seen: { home: true, project: true, globalLib: true, pdf: true } } })
    )
    const page = await desktop.launch()
    await page.route('**/api/serve/models', (route) => route.fulfill({ json: catalog }))
    await page.reload()
    await enterWorkbenchShell(page)
    if (!await page.getByTestId('ai-panel').isVisible().catch(() => false)) {
      await page.getByTestId('topbar-ai').click()
      await expect(page.getByTestId('ai-panel')).toBeVisible()
    }
    await page.getByTestId('model-selector-toggle').click()
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
    expect(truncated).toEqual([])
    // 思考强度二级卡向左弹: 展开后主菜单盒逐像素不变, 且二级卡整体位于主菜单左侧。
    const boxOf = async (locator: ReturnType<typeof page.getByTestId>) => {
      const box = await locator.boundingBox()
      return box && { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
    }
    // 置灰的内置模型行名字后挂灰色短 tag; 底部「切换后…」footnote 不再渲染。
    await expect(page.getByTestId('model-option-qwen3.8-max')).toContainText('登录可用')
    await expect(menu.getByText(/切换后/)).toHaveCount(0)
    const menuBox = await boxOf(menu)
    await page.getByTestId('model-effort-row').click()
    const effortMenu = page.getByTestId('model-effort-menu')
    await expect(effortMenu).toBeVisible()
    const effortBox = await boxOf(effortMenu)
    expect(await boxOf(menu)).toEqual(menuBox)
    expect(effortBox && menuBox && effortBox.x + effortBox.width <= menuBox.x + 1).toBe(true)
    await page.screenshot({ path: join(desktop.runtime.artifacts, 'model-menu-groups.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
