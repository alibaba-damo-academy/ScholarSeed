import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect, type Page, type Route } from '@playwright/test'
import { build } from 'esbuild'
import tailwindcss from '@tailwindcss/postcss'
import postcss from 'postcss'

const DESKTOP = fileURLToPath(new URL('../../../../../', import.meta.url))
const ORIGIN = 'http://127.0.0.1:18774'
const TIMEOUT_MS = 5000
const PAPER = { id: 'paper', title: 'Scope paper' }

test('metadata batch UI isolates project and global task ownership', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'metadata-scope-'))
  const bundle = join(directory, 'probe.js')
  await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { I18nextProvider } from 'react-i18next';
        import { createLocalization } from './src/localization/engine';
        import { resources } from './src/localization/resources';
        import { ToastProvider, Toaster } from './src/renderer/src/components/ui';
        import { MetadataBatch } from './src/renderer/src/features/literature/MetadataBatch';
        import { metadataBatch } from './src/renderer/src/features/literature/synchronization';
        const root = createRoot(document.getElementById('root'));
        const engine = createLocalization('zh', resources);
        window.probe = {
          snapshot: () => metadataBatch.getSnapshot(),
          language: (language) => engine.changeLanguage(language),
          render: (projectId, entries) => root.render(
            <I18nextProvider i18n={engine}><ToastProvider>
              <div className="whitespace-nowrap"><MetadataBatch projectId={projectId} entries={entries} /></div><Toaster />
            </ToastProvider></I18nextProvider>)
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
  context.after(async () => {
    await browser.close()
    rmSync(directory, { recursive: true, force: true })
  })

  async function fixture() {
    const page = await browser.newPage()
    page.setDefaultTimeout(TIMEOUT_MS)
    const requests: Route[] = []
    await page.route(`${ORIGIN}/**`, async (route) => {
      if (new URL(route.request().url()).pathname === '/') {
        await route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
      } else requests.push(route)
    })
    await page.goto(ORIGIN)
    await page.addScriptTag({ path: bundle })
    return { page, requests }
  }

  async function show(page: Page, projectId?: string, selected = false) {
    await page.evaluate(
      ({ projectId, entries }) => {
        Reflect.get(window, 'probe').render(projectId, entries)
      },
      { projectId, entries: selected ? [PAPER] : [] }
    )
  }

  async function snapshot(page: Page) {
    return page.evaluate(() => Reflect.get(window, 'probe').snapshot())
  }

  await context.test('dialog descriptions wrap independently of the batch toolbar', async () => {
    const { page, requests } = await fixture()
    const stylesheet = join(DESKTOP, 'src/renderer/src/styles.css')
    const compiled = await postcss([tailwindcss({ base: join(DESKTOP, 'src/renderer') })]).process(
      readFileSync(stylesheet, 'utf8'),
      { from: stylesheet }
    )
    await page.addStyleTag({ content: compiled.css })
    await show(page, 'project-a', true)
    await page.getByRole('button', { name: '同步元数据', exact: true }).click()
    const description = page.locator('.vds-dialog__description')
    for (const language of ['zh', 'en']) {
      await page.evaluate((language) => Reflect.get(window, 'probe').language(language), language)
      await expect(description).toHaveCSS('white-space', 'normal')
      const dimensions = await description.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        height: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
      }))
      assert.ok(dimensions.scrollWidth <= dimensions.clientWidth)
      assert.ok(dimensions.height > dimensions.lineHeight)
    }
    await expect.poll(() => requests.length).toBe(1)
    await requests[0].fulfill({ json: { doi: '', arxiv: '', title: PAPER.title } })
    await page.close()
  })

  for (const owner of ['project-a', undefined]) {
    await context.test(
      `running and completed tasks stay in ${owner ?? 'global library'}`,
      async () => {
        const { page, requests } = await fixture()
        await show(page, owner, true)
        await page.getByRole('button', { name: '同步元数据', exact: true }).click()
        await expect(page.getByRole('dialog')).toBeVisible()
        await expect.poll(() => requests.length).toBe(1)
        const original = await snapshot(page)
        for (const other of ['project-b', owner ? undefined : 'project-a']) {
          await show(page, other)
          await expect(page.getByRole('button', { name: '同步进度', exact: true })).toHaveCount(0)
          await expect(page.getByRole('dialog')).toHaveCount(0)
          await show(page, other, true)
          await page.getByRole('button', { name: '同步元数据', exact: true }).click()
          await expect(
            page
              .getByText('其他项目或文献中心正在同步元数据，请返回发起位置查看进度，完成后再试。')
              .last()
          ).toBeVisible()
          await expect(page.getByRole('dialog')).toHaveCount(0)
          assert.deepEqual(await snapshot(page), original)
          assert.equal(requests.length, 1)
        }
        await show(page, owner)
        await expect(page.getByRole('button', { name: '同步进度', exact: true })).toBeVisible()
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await page.getByRole('button', { name: '同步进度', exact: true }).click()
        await expect(page.getByRole('dialog')).toBeVisible()
        await requests[0].fulfill({ json: { doi: '', arxiv: '', title: PAPER.title } })
        await expect(page.getByRole('button', { name: '同步结果', exact: true })).toBeVisible()
        await page
          .locator('.vds-dialog__footer')
          .getByRole('button', { name: '关闭', exact: true })
          .click()
        await show(page, 'project-b')
        await expect(page.getByRole('button', { name: '同步结果', exact: true })).toHaveCount(0)
        await show(page, owner)
        await expect(page.getByRole('button', { name: '同步结果', exact: true })).toBeVisible()
        await page.close()
      }
    )
  }

  await context.test(
    'another project can start after completion, then retry and cancel its own batch',
    async () => {
      const { page, requests } = await fixture()
      await show(page, 'project-a', true)
      await page.getByRole('button', { name: '同步元数据', exact: true }).click()
      await expect.poll(() => requests.length).toBe(1)
      await requests[0].fulfill({ json: { doi: '', arxiv: '', title: PAPER.title } })
      await expect(page.getByRole('button', { name: '同步结果', exact: true })).toBeVisible()
      await show(page, 'project-b', true)
      await page.getByRole('button', { name: '同步元数据', exact: true }).click()
      await expect.poll(() => requests.length).toBe(2)
      assert.equal(new URL(requests[1].request().url()).searchParams.get('project_id'), 'project-b')
      await requests[1].fulfill({ status: 500, json: { message: 'contract fixture failure' } })
      await page.getByRole('button', { name: '重试失败和未完成项', exact: true }).click()
      await expect.poll(() => requests.length).toBe(3)
      assert.equal(new URL(requests[2].request().url()).searchParams.get('project_id'), 'project-b')
      await page.getByRole('button', { name: '停止同步', exact: true }).click()
      assert.equal((await snapshot(page)).cancelling, true)
      await requests[2].fulfill({ json: { doi: '', arxiv: '', title: PAPER.title } })
      await expect.poll(async () => (await snapshot(page)).running).toBe(false)
      assert.equal((await snapshot(page)).projectId, 'project-b')
      await page.close()
    }
  )
})
