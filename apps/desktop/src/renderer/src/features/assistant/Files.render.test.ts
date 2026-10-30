import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium, expect } from '@playwright/test'
import { build } from 'esbuild'

const DESKTOP = fileURLToPath(new URL('../../../../../', import.meta.url))
const ORIGIN = 'http://127.0.0.1:18776'

for (const mode of ['link', 'actions'] as const) {
  test(`output file ${mode} menus reuse project actions and protect unsaved documents`, async (context) => {
    const directory = mkdtempSync(join(tmpdir(), 'output-actions-'))
    context.after(() => rmSync(directory, { recursive: true, force: true }))
    const bundle = join(directory, 'probe.js')
    await build({
      stdin: {
        contents: `
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {I18nextProvider} from 'react-i18next';
        import {createLocalization} from './src/localization/engine';
        import {resources} from './src/localization/resources';
        import {ToastProvider} from './src/renderer/src/components/ui';
        import {OutputFileLink} from './src/renderer/src/features/assistant/Files';
        window.calls = []; window.dirty = false;
        createRoot(document.getElementById('root')).render(<I18nextProvider i18n={createLocalization('zh', resources)}>
          <ToastProvider><OutputFileLink mode="${mode}" project="project" projectPath="sessions/session/results/paper.md" absolutePath="/project/sessions/session/results/paper.md" sessionId="session" path="results/paper.md" onOpen={() => window.calls.push(['open'])}>paper.md</OutputFileLink></ToastProvider>
        </I18nextProvider>);
      `,
        resolveDir: DESKTOP,
        loader: 'tsx',
      },
      plugins: [
        {
          name: 'output-boundaries',
          setup(builder) {
            const modules: Record<string, string> = {
              '../../store': `import {useState} from 'react'; export const useApp = () => {
              const [project, setProject] = useState('project'); window.changeProject = setProject;
              return {state: {homeSelectedProjectId:project}, act: {
            addAiContextRef: value => window.calls.push(['reference', value]),
            confirmResourceDelete: value => window.calls.push(['delete', value]),
            importResourceFiles: (...args) => window.calls.push(['import', ...args]),
            relocateProjectExplorerNode: async (...args) => {window.calls.push(['relocate', ...args]); return true;}
          }};};`,
              '../project/api': `export const mutateProjectNode = async (...args) => {window.calls.push(['rename', ...args]); return {ok:true,node:{path:'sessions/session/results/renamed.md',name:'renamed.md',kind:'file'}};};`,
              '../workbench/workspace': `export const documentWorkspaces = {forProject: () => ({hasDirtyProjectPath: () => window.dirty})};`,
              '../../api': `export const getSessionFiles = async () => ({root:'/project/sessions/session',items:[{name:'paper.md',dir:false}]}); export const appsForFile = async () => []; export const downloadSessionFile = async () => null; export const openPathWith = async () => ({ok:true}); export const revealSystemPath = async () => ({ok:true});`,
            }
            builder.onResolve(
              { filter: /^(\.\.\/\.\.\/(store|api)|\.\.\/(project\/api|workbench\/workspace))$/ },
              (args) => ({ path: args.path, namespace: 'boundary' })
            )
            builder.onLoad({ filter: /.*/, namespace: 'boundary' }, (args) => ({
              contents: modules[args.path],
              loader: 'js',
              resolveDir: DESKTOP,
            }))
          },
        },
      ],
      outfile: bundle,
      bundle: true,
      platform: 'browser',
      jsx: 'automatic',
      define: { 'import.meta.env.DEV': 'false' },
      loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl', '.webp': 'dataurl' },
    })
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    context.after(() => browser.close())
    const page = await browser.newPage()
    await page.route(`${ORIGIN}/`, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
    )
    await page.goto(ORIGIN)
    await page.addScriptTag({ path: bundle })
    const menu = async (): Promise<void> => {
      if (mode === 'actions') await page.getByTestId('session-file-actions').click()
      else await page.getByText('paper.md', { exact: true }).click({ button: 'right' })
    }
    if (mode === 'actions') {
      await page.getByTestId('session-file-actions').focus()
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('session-file-link-menu')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('session-file-actions')).toBeFocused()
    }
    await menu()
    await page.getByTestId('output-file-reference').click()
    await menu()
    await page.getByTestId('output-file-import').click()
    await menu()
    await page.getByTestId('output-file-delete').click()
    await menu()
    await page.getByTestId('output-file-rename').click()
    await page.getByRole('textbox').fill('renamed')
    await page.getByTestId('output-file-rename-confirm').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const calls = await page.evaluate(() => (window as unknown as { calls: unknown[] }).calls)
    assert.deepEqual(calls, [
      [
        'reference',
        {
          kind: 'file',
          sourceId: 'sessions/session/results/paper.md',
          projectId: 'project',
          label: 'paper.md',
        },
      ],
      ['import', 'copy', ['/project/sessions/session/results/paper.md']],
      ['delete', { path: 'sessions/session/results/paper.md', name: 'paper.md', kind: 'file' }],
      [
        'rename',
        'project',
        'rename',
        { path: 'sessions/session/results/paper.md', name: 'renamed.md' },
      ],
      [
        'relocate',
        'sessions/session/results/paper.md',
        'sessions/session/results/renamed.md',
        'renamed.md',
      ],
    ])
    await page.evaluate(() => {
      ;(window as unknown as { dirty: boolean }).dirty = true
    })
    await menu()
    await page.getByTestId('output-file-rename').click()
    await page.getByRole('textbox').fill('blocked')
    await page.getByTestId('output-file-rename-confirm').click()
    await expect(page.getByRole('dialog')).toHaveCount(1)
    assert.equal(
      await page.evaluate(() => (window as unknown as { calls: unknown[] }).calls.length),
      calls.length
    )
    await page.evaluate(() => {
      ;(window as unknown as { changeProject: (project: string) => void }).changeProject('other')
    })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await menu()
    for (const action of ['reference', 'import', 'rename', 'delete']) {
      await expect(page.getByTestId(`output-file-${action}`)).toBeDisabled()
    }
    await expect(page.getByTestId('session-file-link-open')).not.toBeDisabled()
  })
}
