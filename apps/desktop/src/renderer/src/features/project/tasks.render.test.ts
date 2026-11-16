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
        import { ToastProvider, Toaster } from './src/renderer/src/components/ui';
        const root = createRoot(document.getElementById('root'));
        window.renderTasks = (status, pinned, unread) => {
          window.node = { id: 'task', status };
          window.unread = unread;
          flushSync(() => root.render(<ToastProvider><Tasks
            rows={[
              {session_id:'parent', title:'Source', project_path:'/a'},
              {session_id:'task', title:'Task', pinned, project_path:'/a', display_parent_session_id:'parent'},
            ]}
            projectPath="/a" onOrder={() => {}} onDetach={() => {}}
            pending={new Set()} onPin={() => {}} registerAction={() => {}}
          /><Toaster /></ToastProvider>));
        };
        window.renderGroupedTasks = () => {
          flushSync(() => root.render(<ToastProvider><Tasks
            rows={[
              {session_id:'c',title:'Child',display_parent_session_id:'p'},
              {session_id:'p',title:'Parent',running:true},
              {session_id:'d',title:'Sibling',display_parent_session_id:'p'},
              {session_id:'independent',title:'Independent'},
            ].map(row => ({...row, project_path:'/a'}))}
            projectPath="/a" onDetach={() => {}}
            pending={new Set()} onPin={() => {}} registerAction={() => {}}
          /><Toaster /></ToastProvider>));
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
                /^(react-i18next|\.\.\/\.\.\/(store|session)|\.\.\/assistant\/attention|\.\.\/\.\.\/components\/business\/SessionTitle)$/,
            },
            (args) => ({ path: args.path, namespace: 'probe' })
          )
          builder.onLoad({ filter: /.*/, namespace: 'probe' }, (args) => ({
            contents:
              args.path === 'react-i18next'
                ? 'export const useTranslation = () => ({ t: key => key });'
                : args.path.endsWith('/store')
                  ? 'export const useApp = () => ({state:{sessions:[window.node],sessionActivitySeen:{},collapsedSessionIds:window.collapsed||{}},set(){},act:{forkSession(id){window.forked=(window.forked||[]).concat(id);return new Promise(resolve=>window.finishFork=resolve)},openSession(id){window.opened=id},toggleSessionChildren(id){window.collapsed={...window.collapsed,[id]:!window.collapsed?.[id]};window.renderGroupedTasks()}}});'
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
    await row.locator('[data-session-actions]').click({ force: true })
    await expect(page.getByRole('menuitem', { name: 'moveSessionUp', exact: true })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'moveSessionDown', exact: true })).toHaveCount(
      0
    )
    const fork = page.getByTestId('session-fork-menu')
    await expect(fork).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'detachSession', exact: true })).toHaveCount(0)
    assert.deepEqual(await page.getByRole('menuitem').allTextContents(), [
      'pin',
      'sessionMenu.fork',
      'panel.rename',
      'archiveTask',
      'panel.delete',
    ])
    await fork.focus()
    await page.keyboard.press('Enter')
    await expect(fork).toBeDisabled()
    await page.keyboard.press('Enter')
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'forked')), ['task'])
    await page.evaluate(() => Reflect.get(window, 'finishFork')(false))
    await expect(page.getByText('stream.forkFailed', { exact: true })).toBeVisible()
    await expect(fork).toBeEnabled()
    await fork.click()
    await page.evaluate(() => Reflect.get(window, 'finishFork')(true))
    await expect(page.getByRole('menu')).toHaveCount(0)
    await row.locator('[data-session-actions]').click({ force: true })
    await page.keyboard.press('Escape')
    await page.evaluate(() => Reflect.get(window, 'renderGroupedTasks')())
    const parent = page.getByTestId('project-task-p')
    const child = page.getByTestId('project-task-c')
    await expect(child).toBeVisible()
    await expect(page.getByTestId('project-task-d')).toBeVisible()
    await expect(parent.getByText('2', { exact: true })).toBeAttached()
    await expect(
      page.getByTestId('project-task-independent').locator('.lucide-message-circle')
    ).toHaveCount(1)
    await expect(child.locator('.lucide-message-circle')).toHaveCount(0)
    await expect(parent.getByRole('button', { name: 'collapseChildren' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    await expect(parent.locator('[data-session-status]')).toBeVisible()
    assert.match(
      (await parent.locator('[data-session-status]').getAttribute('class')) ?? '',
      /data-session-actions/
    )
    await expect(parent.locator('[data-session-actions]')).toHaveCount(1)
    await parent.getByRole('button', { name: 'collapseChildren' }).click()
    await expect(child).toHaveCount(0)
    assert.equal(await page.evaluate(() => Reflect.get(window, 'opened')), undefined)
    await parent.getByRole('button', { name: 'expandChildren' }).click()
    await expect(child).toBeVisible()
    await child.getByRole('button', { name: 'Child', exact: true }).click()
    assert.equal(await page.evaluate(() => Reflect.get(window, 'opened')), 'c')
    await expect(
      page.getByTestId('project-task-independent').locator('[data-session-disclosure-slot]')
    ).toHaveCount(0)
    await expect(parent.locator('[data-session-disclosure-slot]')).toHaveCount(1)
    await expect(child.locator('[data-session-disclosure-slot]')).toHaveCount(1)
  } finally {
    await browser.close()
  }
})
