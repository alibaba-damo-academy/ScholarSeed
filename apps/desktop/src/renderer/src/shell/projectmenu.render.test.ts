import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { build } from 'esbuild'

const DESKTOP = fileURLToPath(new URL('../../../../', import.meta.url))

test('project menu distinguishes pinned and selected projects and updates pin presence', async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { ProjectMenu } from './src/renderer/src/shell/ProjectMenu';
        const root = createRoot(document.getElementById('root'));
        window.calls = [];
        window.renderMenu = (pinned, selected) => {
          window.state = {
            mainView: 'resource', homeSelectedProjectId: selected,
            projects: [
              { id: 'plain', name: 'Plain project', path: '/plain', pinned: false },
              { id: 'pinned', name: 'Long project name for pin indicator', path: '/pinned', pinned }
            ]
          };
          flushSync(() => root.render(<ProjectMenu onClose={() => window.calls.push('close')} />));
        };
        window.renderMenu(true, 'pinned');
      `,
      resolveDir: DESKTOP,
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    platform: 'browser',
    jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' },
    loader: { '.css': 'empty', '.webp': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
    plugins: [
      {
        name: 'project-menu-boundaries',
        setup(builder) {
          builder.onResolve(
            { filter: /^(react-i18next|\.\.\/store|\.\.\/components\/business\/ProjectActions)$/ },
            (args) => ({ path: args.path, namespace: 'probe' })
          )
          builder.onLoad({ filter: /.*/, namespace: 'probe' }, (args) => ({
            contents:
              args.path === 'react-i18next'
                ? 'export const useTranslation = () => ({ t: key => key });'
                : args.path.endsWith('ProjectActions')
                  ? 'export const ProjectActionsMenu = () => null;'
                  : `export const useApp = () => ({state:window.state,set(){},act:{selectProject(id){window.calls.push(id)},openWorkbenchView(view){window.calls.push(view)}}});`,
            loader: 'js',
          }))
        },
      },
    ],
  })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const pinned = page.getByTestId('project-menu-option-Long project name for pin indicator')
    const plain = page.getByTestId('project-menu-option-Plain project')
    await expect(pinned.getByRole('img', { name: 'pinned', exact: true })).toBeAttached()
    await expect(pinned).toHaveAttribute('aria-current', 'page')
    await expect(plain.getByRole('img')).toHaveCount(0)
    assert.deepEqual(
      await page
        .locator('[data-testid^="project-menu-option-"]')
        .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid'))),
      [
        'project-menu-option-Long project name for pin indicator',
        'project-menu-option-Plain project',
      ]
    )
    await page.evaluate(() => Reflect.get(window, 'renderMenu')(true, 'plain'))
    await expect(pinned.getByRole('img', { name: 'pinned', exact: true })).toBeAttached()
    await expect(pinned).not.toHaveAttribute('aria-current', 'page')
    await expect(plain).toHaveAttribute('aria-current', 'page')
    await pinned.focus()
    await page.keyboard.press('Enter')
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'calls')), [
      'close',
      'pinned',
      'resource',
    ])
    await page.evaluate(() => Reflect.get(window, 'renderMenu')(false, 'pinned'))
    await expect(pinned.getByRole('img')).toHaveCount(0)
    await expect(pinned).toHaveAttribute('aria-current', 'page')
  } finally {
    await browser.close()
  }
})
