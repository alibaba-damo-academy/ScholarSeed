import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { chromium, expect } from '@playwright/test'
import { build } from 'esbuild'

const DESKTOP = fileURLToPath(new URL('../../../../../', import.meta.url))
const ORIGIN = 'http://127.0.0.1:18776'

test(
  'recorder saves notes locally and submits every step together with retry and exit isolation',
  { timeout: 60_000 },
  async (context) => {
    const directory = mkdtempSync(join(tmpdir(), 'recorder-submission-'))
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
        import { Recorder } from './src/renderer/src/features/feedback-recorder/Recorder';
        import { ToastProvider, Toaster } from './src/renderer/src/components/ui';
        import { FEEDBACK_RECORDER_START_EVENT } from './src/feedback';
        window.submissions = [];
        window.failSubmission = true;
        window.scholarseed = {
          platform: 'darwin', feedbackRecorderEnabled: true,
          captureFeedbackScreenshot: async () => ({ ok: false, error: 'capture_failed' }),
        };
        createRoot(document.getElementById('root')).render(
          <I18nextProvider i18n={createLocalization('zh', resources)}><ToastProvider>
            <button onClick={() => window.dispatchEvent(new Event(FEEDBACK_RECORDER_START_EVENT))}>开始测试记录</button>
            <button>第一步操作</button><button>第二步操作</button>
            <Recorder /><Toaster />
          </ToastProvider></I18nextProvider>
        );
      `,
        resolveDir: DESKTOP,
        loader: 'tsx',
      },
      outfile: bundle,
      bundle: true,
      platform: 'browser',
      jsx: 'automatic',
      define: { 'import.meta.env.DEV': 'false' },
      loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl', '.webp': 'dataurl' },
      plugins: [
        {
          name: 'recorder-boundaries',
          setup(plugin) {
            plugin.onResolve(
              { filter: /^(\.\.\/){2}(api|store|components\/business\/access)$/ },
              (args) =>
                args.importer.endsWith('/Recorder.tsx')
                  ? { path: args.path, namespace: 'recorder-test' }
                  : undefined
            )
            plugin.onLoad({ filter: /.*/, namespace: 'recorder-test' }, (args) => ({
              contents: args.path.endsWith('/api')
                ? `export async function submitFeedback(input) {
                const report = JSON.parse(await input.recordingReport.text());
                window.submissions.push({ report, description: input.description, includeLogs: input.includeLogs, includeTrace: input.includeTrace });
                return window.failSubmission ? { ok: false, error: '测试提交失败' } : { ok: true, id: 'test-ticket' };
              }`
                : args.path.endsWith('/store')
                  ? `const state = { backendReady: true, activeSession: 'test-session' }; export const useApp = () => ({ state, act: {}, set() {} });`
                  : `export const useAccountAccess = () => ({ authenticated: true });`,
            }))
          },
        },
      ],
    })
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    context.after(() => browser.close())
    const page = await browser.newPage()
    page.setDefaultTimeout(5000)
    await page.route(`${ORIGIN}/`, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
    )
    await page.goto(ORIGIN)
    await page.addScriptTag({ path: bundle })
    await page.getByRole('button', { name: '开始测试记录' }).click()
    const note = page.getByTestId('feedback-recorder-note')
    await expect(note).toBeVisible()
    await expect(page.getByTestId('feedback-recorder-note-submit')).toHaveCount(0)
    await expect(note).toHaveAttribute('placeholder', '请输入当前步骤的问题描述，后台将自动记录')
    await page.getByRole('button', { name: '第一步操作', exact: true }).click()
    await note.fill('第一步首次说明')
    await note.fill('第一步补充说明')
    await note.press('Enter')
    await expect(note).toHaveValue('第一步补充说明\n')
    await page.getByRole('button', { name: '第二步操作', exact: true }).click()
    await note.fill('第二步说明')
    assert.equal(await page.evaluate(() => Reflect.get(window, 'submissions').length), 0)
    await page.getByTestId('feedback-recorder-stop').click()
    await expect(page.getByTestId('feedback-recorder-review')).toBeVisible()
    assert.equal(await page.evaluate(() => Reflect.get(window, 'submissions').length), 0)
    await page.getByTestId('feedback-recorder-submit').click()
    await expect(page.getByTestId('feedback-recorder-review')).toContainText('测试提交失败')
    const first = await page.evaluate(() => Reflect.get(window, 'submissions')[0])
    assert.equal(first.report.steps.length, 3)
    assert.deepEqual(
      first.report.stepNotes.map((entry: { text: string }) => entry.text.trim()),
      ['第一步补充说明', '第二步说明']
    )
    assert.equal(first.includeLogs, true)
    assert.equal(first.includeTrace, true)
    await page.evaluate(() => Reflect.set(window, 'failSubmission', false))
    await page.getByTestId('feedback-recorder-submit').click()
    await expect(page.getByTestId('feedback-recorder-review')).toHaveCount(0)
    const retried = await page.evaluate(() => Reflect.get(window, 'submissions')[1])
    assert.deepEqual(retried.report.steps, first.report.steps)
    assert.deepEqual(retried.report.stepNotes, first.report.stepNotes)
    await page.getByRole('dialog').getByRole('button', { name: '完成', exact: true }).click()
    await page.getByRole('button', { name: '开始测试记录' }).click()
    await expect(note).toBeVisible()
    await note.fill('退出时丢弃的说明')
    await page.getByTestId('feedback-recorder-exit').click()
    await page.getByRole('button', { name: '开始测试记录' }).click()
    await expect(note).toHaveValue('')
    await expect(page.getByTestId('feedback-recorder-submitted-note')).toHaveCount(0)
    assert.equal(await page.evaluate(() => Reflect.get(window, 'submissions').length), 2)
  }
)
