import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwindcss from '@tailwindcss/postcss'

const DESKTOP = fileURLToPath(new URL('../../../../../', import.meta.url))
const COMPACT_WIDTH = 450
const CHANGED = '配置已变更，点击刷新重新翻译；当前保留旧译文。'
const APPLIED_CHANGED = '配置已变更，点击刷新重新翻译；当前保留的旧译文语言为德语。'

test('compact translation changes keep selectors readable and wait for explicit regeneration', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: DESKTOP,
      loader: 'tsx',
      contents: `
        import React, { useState } from 'react'
        import { createRoot } from 'react-dom/client'
        import { I18nextProvider } from 'react-i18next'
        import { Copy, MessageSquareText, SlidersHorizontal } from 'lucide-react'
        import { createLocalization } from './src/localization/engine'
        import { resources } from './src/localization/resources'
        import { IconButton } from './src/renderer/src/components/ui'
        import { TranslationControls } from './src/renderer/src/features/translation/Controls'
        import { TranslationProvider } from './src/renderer/src/features/translation/context'
        import { initialTranslation, translationDirty } from './src/renderer/src/features/translation/model'
        const settings = { ...initialTranslation(), services: { aliyun: 'configured', youdao: 'configured' } }
        const backend = { live: true, snapshot: () => settings, subscribe: () => () => {} }
        const original = { engine: 'aliyun', source: 'auto', target: 'de' }
        function Fixture() {
          const [choice, setChoice] = useState(original)
          const [applied, setApplied] = useState(original)
          const [result, setResult] = useState('Existing translated text')
          const [refreshes, setRefreshes] = useState(0)
          return <I18nextProvider i18n={createLocalization('zh', resources)}><TranslationProvider backend={backend}>
            <div style={{ width: ${COMPACT_WIDTH}, fontWeight: 'var(--vds-fw-medium)' }}>
              <TranslationControls compact value={choice} changed={translationDirty(choice, applied)} appliedTarget={applied.target} onChange={setChoice}
                onRefresh={() => { setApplied(choice); setRefreshes(value => value + 1); setResult('Regenerated text') }}
                trailingActions={<><IconButton label="Comment" icon={<MessageSquareText />} size="sm" /><IconButton label="Copy" icon={<Copy />} size="sm" /><IconButton label="Settings" icon={<SlidersHorizontal />} size="sm" /></>} />
              <output>{JSON.stringify({ choice, result, refreshes })}</output>
            </div>
          </TranslationProvider></I18nextProvider>
        }
        createRoot(document.getElementById('root')).render(<Fixture />)
      `,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    plugins: [
      {
        name: 'translation-catalog',
        setup(builder) {
          builder.onResolve({ filter: /\/store$/ }, (args) =>
            args.importer.endsWith('/features/translation/Controls.tsx')
              ? { path: 'catalog', namespace: 'fixture' }
              : undefined
          )
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            loader: 'js',
            contents:
              'export const useApp = () => ({ state: { catalog: { models: [{ key: "flash", label: "Qwen Flash" }] } }, act: {} })',
          }))
        },
      },
    ],
  })
  const stylesheet = join(DESKTOP, 'src/renderer/src/styles.css')
  const compiled = await postcss([tailwindcss({ base: join(DESKTOP, 'src/renderer') })]).process(
    readFileSync(stylesheet, 'utf8'),
    { from: stylesheet }
  )
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage()
      await page.setContent(`<html data-theme="${theme}"><body><div id="root"></div></body></html>`)
      await page.addStyleTag({ content: compiled.css })
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      const controls = page.getByTestId('translation-controls')
      const trailingBounds = await controls
        .getByRole('button', { name: 'Settings', exact: true })
        .boundingBox()
      const controlsBounds = await controls.boundingBox()
      assert.ok(trailingBounds && controlsBounds)
      assert.ok(
        Math.abs(
          trailingBounds.x + trailingBounds.width - controlsBounds.x - controlsBounds.width
        ) < 2
      )
      const engine = controls.getByRole('combobox', { name: '选择翻译模型或服务', exact: true })
      const refresh = controls.getByRole('button', { name: '刷新翻译', exact: true })
      await expect(controls.getByRole('status')).toHaveCount(0)
      await engine.click()
      await page.getByRole('option', { name: '有道智云', exact: true }).click()
      const status = controls.getByRole('status')
      await expect(status).toHaveText(APPLIED_CHANGED)
      await expect(status).toHaveCSS('font-weight', '400')
      const placeholderColor = await status.evaluate((element) => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--vds-text-placeholder)'
        element.append(probe)
        const color = getComputedStyle(probe).color
        probe.remove()
        return color
      })
      await expect(status).toHaveCSS('color', placeholderColor)
      const statusBounds = await status.boundingBox()
      const engineBounds = await engine.boundingBox()
      assert.ok(statusBounds && engineBounds)
      assert.ok(
        statusBounds.y >= engineBounds.y + engineBounds.height,
        'change notice must occupy its own row'
      )
      for (const label of ['有道智云', '自动识别', '德语']) {
        const bounds = await controls.getByText(label, { exact: true }).boundingBox()
        assert.ok(bounds && bounds.width > 20, `${label} must not collapse to an arrow`)
      }
      await expect(controls.getByTestId('translation-refresh-pending')).toBeVisible()
      await refresh.hover()
      await expect(page.getByRole('tooltip')).toHaveText(CHANGED)
      await controls.getByRole('combobox', { name: '目标语言', exact: true }).click()
      await page.getByRole('option', { name: '中文', exact: true }).click()
      await engine.click()
      await page.getByRole('option', { name: 'Qwen Flash', exact: true }).click()
      assert.deepEqual(JSON.parse(await page.locator('output').innerText()), {
        choice: { engine: 'ai:flash', source: 'auto', target: 'zh-CN' },
        result: 'Existing translated text',
        refreshes: 0,
      })
      await refresh.focus()
      await expect(page.getByRole('tooltip')).toHaveText(CHANGED)
      await page.keyboard.press('Enter')
      await expect(status).toHaveCount(0)
      await expect(controls.getByTestId('translation-refresh-pending')).toHaveCount(0)
      assert.equal(JSON.parse(await page.locator('output').innerText()).refreshes, 1)
      await page.close()
    }
  } finally {
    await browser.close()
  }
})
