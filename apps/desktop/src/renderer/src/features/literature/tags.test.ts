import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { build } from 'esbuild'

const DESKTOP = fileURLToPath(new URL('../../../../../', import.meta.url))
const ORIGIN = 'http://127.0.0.1:18775'

test('tag header filters share catalogue selection, scope, search and clear semantics', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'literature-tags-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const bundle = join(directory, 'probe.js')
  await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { I18nextProvider } from 'react-i18next';
        import { createLocalization } from './src/localization/engine';
        import { resources } from './src/localization/resources';
        import { TagFilter } from './src/renderer/src/features/literature/Tags';
        import { catalogue } from './src/renderer/src/features/literature/catalog';
        catalogue.scope('project-a');
        catalogue.query({ q: 'retained search', collection_id: ['collection-a'] });
        catalogue.select('paper-a', true);
        const engine = createLocalization('zh', resources);
        createRoot(document.getElementById('root')).render(
          <I18nextProvider i18n={engine}><TagFilter /></I18nextProvider>);
        window.probe = {
          snapshot: () => catalogue.getSnapshot(),
          language: (language) => engine.changeLanguage(language),
          scope: () => { catalogue.scope('project-b'); }
        };
      `,
      resolveDir: DESKTOP,
      loader: 'tsx',
    },
    outfile: bundle,
    bundle: true,
    platform: 'browser',
    jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' },
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.css': 'empty' },
  })
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  context.after(() => browser.close())
  const page = await browser.newPage()
  const requests: URL[] = []
  let failed = false
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
      return
    }
    assert.ok(url.pathname.endsWith('/literatures/tag-facets'))
    requests.push(url)
    await route.fulfill({
      status: failed ? 500 : 200,
      contentType: 'application/json',
      body: JSON.stringify({
        tags: [
          { id: 'alpha', name: 'Alpha', count: 2 },
          { id: 'beta', name: 'Beta', count: 1 },
        ],
      }),
    })
  })
  await page.goto(ORIGIN)
  await page.addScriptTag({ path: bundle })
  await page.getByRole('button', { name: '筛选标签', exact: true }).waitFor({ state: 'visible' })
  page.setDefaultTimeout(5000)
  const snapshot = () => page.evaluate(() => Reflect.get(window, 'probe').snapshot())
  await page.getByRole('button', { name: '筛选标签', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Alpha', exact: true })).toBeVisible()
  assert.equal(requests[0].searchParams.get('project_id'), 'project-a')
  assert.equal(requests[0].searchParams.get('collection_id'), 'collection-a')
  assert.equal(requests[0].searchParams.has('q'), false)
  await page.getByRole('checkbox', { name: 'Alpha', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Beta', exact: true }).click()
  let state = await snapshot()
  assert.deepEqual(state.query.tag_id, ['alpha', 'beta'])
  assert.equal(state.query.q, 'retained search')
  assert.deepEqual(state.query.collection_id, ['collection-a'])
  assert.deepEqual(state.selected, ['paper-a'])
  await expect(page.getByRole('button', { name: '筛选标签', exact: true })).toHaveAttribute(
    'data-active',
    'true'
  )
  await page.getByRole('textbox', { name: '搜索标签', exact: true }).fill('bEt')
  await expect(page.getByRole('checkbox', { name: 'Alpha', exact: true })).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: 'Beta', exact: true })).toBeChecked()
  await page.getByRole('textbox', { name: '搜索标签', exact: true }).fill('missing')
  await expect(page.getByText('没有匹配的标签', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '清空标签筛选', exact: true }).click()
  state = await snapshot()
  assert.equal(state.query.tag_id, undefined)
  assert.deepEqual(state.selected, ['paper-a'])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '筛选标签', exact: true })).toBeFocused()
  await page.getByRole('button', { name: '筛选标签', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '搜索标签', exact: true })).toHaveValue('')
  await page.evaluate(() => Reflect.get(window, 'probe').scope())
  await expect.poll(() => requests.at(-1)?.searchParams.get('project_id')).toBe('project-b')
  await page.keyboard.press('Escape')
  failed = true
  await page.getByRole('button', { name: '筛选标签', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  failed = false
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Beta', exact: true })).toBeVisible()
  await page.evaluate(() => Reflect.get(window, 'probe').language('en'))
  await expect(page.getByRole('textbox', { name: 'Search tags', exact: true })).toBeVisible()
})
