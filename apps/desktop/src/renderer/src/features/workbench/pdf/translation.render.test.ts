import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { chromium, expect } from '@playwright/test'

const DESKTOP = path.resolve(import.meta.dirname, '../../../../../..')

test('translation separates folding from locating, retains streaming state and renders emphasis', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: DESKTOP,
      loader: 'tsx',
      contents: `
      import React, { useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import { Translation } from './src/renderer/src/features/workbench/pdf/Translation'
      const initial = [
        {source_id:'heading',paragraph_id:'heading',source_text:'Method',translated_text:'方法',located:true,heading:true,heading_level:1},
        {source_id:'body',paragraph_id:'body',source_text:'Do not infer.',translated_text:'不要推断。',located:true,
          translated_spans:[{text:'不要',bold:true},{text:'推断。',bold:false}]},
        {source_id:'child',paragraph_id:'child',source_text:'Details',translated_text:'细节',located:true,heading:true,heading_level:2},
        {source_id:'detail',paragraph_id:'detail',source_text:'More.',translated_text:'更多。',located:true}
      ]
      window.located = []
      function Fixture() {
        const [sentences,setSentences] = useState(initial)
        window.appendTranslation = () => setSentences(previous => [...previous,
          {source_id:'last',paragraph_id:'last',source_text:'Last.',translated_text:'最后。',located:true}])
        return <Translation sentences={sentences} active="" compact sections
          onSelect={sentence => window.located.push(sentence.source_id)} />
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
        name: 'translation-fixture',
        setup(builder) {
          builder.onResolve({ filter: /^react-i18next$/ }, () => ({
            path: 'i18n',
            namespace: 'fixture',
          }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents:
              'export const useTranslation = () => ({t:key=>key,i18n:{resolvedLanguage:"en"}})',
            loader: 'js',
          }))
        },
      },
    ],
  })
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const heading = page.getByRole('button', { name: '方法', exact: true })
    const section = page.locator('[data-translation-section="heading"]')
    const fold = section.getByRole('button', { name: 'translation.collapseHeading' }).first()
    const expand = section.getByRole('button', { name: 'translation.expandHeading' }).first()
    await expect(fold).toHaveAttribute('aria-expanded', 'true')
    await expect(section.getByRole('heading', { name: '方法' })).toHaveClass(
      /font-\[var\(--vds-fw-semibold\)\]/
    )
    await expect(heading).not.toHaveAttribute('style')
    await expect(page.locator('[data-translation-section="heading"] > [data-state]')).toHaveClass(
      /!border-0/
    )
    await expect(page.locator('strong')).toHaveText('不要')
    await fold.focus()
    await page.keyboard.press('Enter')
    await expect(expand).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText('不要', { exact: true })).not.toBeVisible()
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'located')), [])
    await page.evaluate(() => Reflect.get(window, 'appendTranslation')())
    await expect(expand).toHaveAttribute('aria-expanded', 'false')
    await expand.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByText('最后。', { exact: true })).toBeVisible()
    const detailSection = page.locator('[data-translation-section="child"]')
    await detailSection.getByRole('button', { name: 'translation.collapseHeading' }).focus()
    await page.keyboard.press('Enter')
    await fold.focus()
    await page.keyboard.press('Enter')
    await expand.focus()
    await page.keyboard.press('Enter')
    await expect(
      detailSection.getByRole('button', { name: 'translation.expandHeading' })
    ).toHaveAttribute('aria-expanded', 'false')
    await heading.click()
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'located')), [])
    await heading.dblclick()
    await page.getByRole('button', { name: '不要推断。', exact: true }).dblclick()
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'located')), ['heading', 'body'])
    await expect(fold).toHaveAttribute('aria-expanded', 'true')
  } finally {
    await browser.close()
  }
})
