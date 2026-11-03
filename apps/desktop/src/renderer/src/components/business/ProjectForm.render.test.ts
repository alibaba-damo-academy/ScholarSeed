import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect, type Route } from '@playwright/test'
import { build } from 'esbuild'

const DESKTOP = fileURLToPath(new URL('../../../../../', import.meta.url))
const ORIGIN = 'http://127.0.0.1:18776'
const TIMEOUT = 10000

test('project form preserves folder previews and cancels trust without creating a project', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'project-form-'))
  const bundle = join(directory, 'probe.js')
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { I18nextProvider } from 'react-i18next';
        import { createLocalization } from './src/localization/engine';
        import { resources } from './src/localization/resources';
        import { Button } from './src/renderer/src/components/ui';
        import { ProjectForm } from './src/renderer/src/components/business/ProjectForm';
        const root = createRoot(document.getElementById('root'));
        const engine = createLocalization('zh', resources);
        window.scholarseed = { getApiBase: () => '', pickDir: async () => '/selected/project' };
        window.renderForm = target => root.render(
          <I18nextProvider i18n={engine}>
            <ProjectForm key={target.mode} target={target} footerLeading={busy => <Button data-testid="guide-skip" disabled={busy}>Skip</Button>} onClose={() => {}} onDone={async (message, created) => {
              document.body.dataset.createdName = created?.name ?? '';
              document.body.dataset.createdMessage = message;
              await new Promise(resolve => { window.finishCompletion = resolve; });
            }} />
          </I18nextProvider>
        );
        window.renderForm({ mode: 'create' });
      `,
      resolveDir: DESKTOP,
      loader: 'tsx',
    },
    outfile: bundle,
    bundle: true,
    platform: 'browser',
    jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' },
    loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl' },
  })
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL })
  context.after(() => browser.close())
  const page = await browser.newPage()
  page.setDefaultTimeout(TIMEOUT)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const requests = new Map<string, Route>()
  await page.route('**/api/content/projects/directory?*', (route) => {
    requests.set(new URL(route.request().url()).searchParams.get('name') ?? '', route)
  })
  await page.route(`${ORIGIN}/`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div id="root"></div><script src="/probe.js"></script>',
    })
  )
  await page.route(`${ORIGIN}/probe.js`, (route) =>
    route.fulfill({ contentType: 'application/javascript', body: readFileSync(bundle, 'utf8') })
  )
  await page.goto(ORIGIN)
  assert.deepEqual(errors, [])
  const name = page.getByTestId('project-create-name')
  const folder = page.locator('input[disabled]')
  const respond = async (input: string, root: string | null): Promise<void> => {
    await expect.poll(() => requests.has(input)).toBe(true)
    await requests.get(input)!.fulfill({
      status: root === null ? 503 : 200,
      contentType: 'application/json',
      body: JSON.stringify(root === null ? { error: 'unavailable' } : { root }),
    })
  }
  await respond('', '/workspace/untitled')
  await expect(folder).toHaveValue('/workspace/untitled')

  await name.fill('研究')
  await expect.poll(() => requests.has('研究')).toBe(true)
  await expect(folder).toHaveValue('/workspace/untitled')
  await respond('研究', '/workspace/研究')
  await expect(folder).toHaveValue('/workspace/研究')

  await name.fill('旧名称')
  await expect.poll(() => requests.has('旧名称')).toBe(true)
  await name.fill('新名称')
  await expect.poll(() => requests.has('新名称')).toBe(true)
  await expect(folder).toHaveValue('/workspace/研究')
  await respond('新名称', '/workspace/新名称')
  await expect(folder).toHaveValue('/workspace/新名称')
  const staleResponse = page.waitForResponse(
    (response) => new URL(response.url()).searchParams.get('name') === '旧名称'
  )
  await respond('旧名称', '/workspace/旧名称')
  await staleResponse
  await page.evaluate(() => new Promise(requestAnimationFrame))
  await expect(folder).toHaveValue('/workspace/新名称')

  await name.fill('失败')
  await expect.poll(() => requests.has('失败')).toBe(true)
  await expect(folder).toHaveValue('/workspace/新名称')
  await respond('失败', null)
  await expect(folder).toHaveValue('自动在默认工作区创建项目文件夹')

  await name.fill('选择目录')
  await expect.poll(() => requests.has('选择目录')).toBe(true)
  await page.getByRole('button', { name: '选择文件夹', exact: true }).click()
  await expect(folder).toHaveValue('/selected/project')
  await respond('选择目录', '/workspace/选择目录')
  await expect(folder).toHaveValue('/selected/project')
  const count = requests.size
  await name.fill('人工目录不变')
  await expect(name).toHaveValue('人工目录不变')
  await expect(folder).toHaveValue('/selected/project')
  assert.equal(requests.size, count)

  const writes: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(request.url())
  })
  await page.getByTestId('project-create').click()
  const confirmation = page.getByRole('alertdialog')
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(confirmation).not.toBeVisible()
  await expect(page.getByTestId('project-new-modal')).toBeVisible()
  await expect(name).toHaveValue('人工目录不变')
  await expect(folder).toHaveValue('/selected/project')
  await page.getByTestId('project-create').click()
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  await expect(confirmation).not.toBeVisible()
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])

  const metadataWrites: unknown[] = []
  const created = { id: 'generated-project', name: '研究-2', root: '/workspace/研究-2' }
  await page.route(`${ORIGIN}/api/content/projects`, async (route) => {
    if (route.request().method() === 'PATCH') metadataWrites.push(route.request().postDataJSON())
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(created) })
  })
  for (const description of ['', '保留项目描述']) {
    requests.clear()
    metadataWrites.length = 0
    await page.reload()
    await respond('', '/workspace/untitled')
    await page.getByTestId('project-create-name').fill('研究')
    await respond('研究', '/workspace/研究-2')
    await page.getByRole('textbox', { name: '项目描述', exact: true }).fill(description)
    await page.getByTestId('project-create').click()
    await expect(page.locator('body')).toHaveAttribute('data-created-name', '研究-2')
    await expect(page.locator('body')).toHaveAttribute('data-created-message', '已创建项目 研究-2')
    await expect(page.getByTestId('guide-skip')).toBeDisabled()
    await expect(page.getByTestId('project-create')).toBeDisabled()
    await page.evaluate('window.finishCompletion()')
    await expect(page.getByTestId('guide-skip')).toBeEnabled()
    assert.deepEqual(
      metadataWrites,
      description ? [{ id: created.id, name: created.name, description }] : []
    )
  }
  assert.deepEqual(errors, [])
})
