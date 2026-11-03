import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { build } from 'esbuild'

const DESKTOP = fileURLToPath(new URL('../../../../../', import.meta.url))

test('pinning preserves task status and completion read semantics', async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { Tasks } from './src/renderer/src/features/project/Tasks';
        const root = createRoot(document.getElementById('root'));
        window.renderTasks = (status, pinned, unread) => {
          window.node = { id: 'task', status };
          window.unread = unread;
          flushSync(() => root.render(<Tasks
            rows={[{session_id:'task', title:'Task', pinned}]}
            pending={new Set()} onPin={() => {}} registerAction={() => {}}
          />));
        };
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
        name: 'task-boundaries',
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^(react-i18next|\.\.\/\.\.\/(store|tree|session)|\.\.\/assistant\/attention|\.\.\/\.\.\/components\/business\/SessionTitle)$/,
            },
            (args) => ({ path: args.path, namespace: 'probe' })
          )
          builder.onLoad({ filter: /.*/, namespace: 'probe' }, (args) => ({
            contents:
              args.path === 'react-i18next'
                ? 'export const useTranslation = () => ({ t: key => key });'
                : args.path.endsWith('/store')
                  ? 'export const useApp = () => ({state:{sessions:[],sessionActivitySeen:{}},set(){},act:{openSession(){}}});'
                  : args.path.endsWith('/tree')
                    ? 'export const findSessionNode = () => window.node; export const serveSessionNode = () => window.node;'
                    : args.path.endsWith('/session')
                      ? 'export const sessionDisplayTitle = row => row.title;'
                      : args.path.endsWith('/attention')
                        ? 'export const useAttention = () => ({by_session:{task:window.unread ? 1 : 0}});'
                        : 'export const SessionTitleEditor = () => null;',
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
    const row = page.getByTestId('project-task-task')
    for (const status of ['running', 'waiting', 'failed', 'completed', 'abandon']) {
      for (const unread of [false, true]) {
        const expected =
          status === 'abandon' || (status === 'completed' && !unread)
            ? null
            : status === 'completed'
              ? 'completed · taskUnread'
              : status
        for (const pinned of [false, true, false]) {
          await page.evaluate(
            ({ status, pinned, unread }) => {
              Reflect.get(window, 'renderTasks')(status, pinned, unread)
            },
            { status, pinned, unread }
          )
          await expect(row.getByRole('img', { name: 'pinned', exact: true })).toHaveCount(0)
          const indicators = row.locator('span[aria-label]:not([role="img"])')
          assert.deepEqual(
            await indicators.evaluateAll((elements) =>
              elements.map((element) => element.getAttribute('aria-label'))
            ),
            expected ? [expected] : [],
            `${status}, unread=${unread}, pinned=${pinned}`
          )
        }
      }
    }
  } finally {
    await browser.close()
  }
})
