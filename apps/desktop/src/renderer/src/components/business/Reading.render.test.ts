import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect, type Page, type Route } from '@playwright/test'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwindcss from '@tailwindcss/postcss'

const DESKTOP = fileURLToPath(new URL('../../../../../', import.meta.url))
const ORIGIN = 'http://127.0.0.1:18776'
const TASKS = '/api/literature/ai/tasks'
const TIMEOUT = 5000
const SAVED = {
  revision: 'revision',
  model_key: 'model',
  modules: {
    summary: {
      text: 'Previously saved reading',
      organized: true,
      organization: 'complete',
      paper_type: 'method',
      contribution: { text: '' },
      method: { text: '' },
      limitations: { text: '' },
      claims: [],
      sections: [],
    },
  },
  metadata: {
    task_id: 'previous',
    schema_version: 'test',
    l1_retries: 0,
    citation_retries: 0,
    reading_retries: 1,
    elapsed_seconds: 1,
    coverage: {
      complete: true,
      total_pages: 1,
      included_pages: [1],
      unavailable_pages: [],
      omissions: [],
    },
    usage: { input_tokens: 10, output_tokens: 10, calls: 2 },
  },
}

test(
  'reading submission ownership and generation diagnostics',
  { timeout: 60_000 },
  async (context) => {
    const directory = mkdtempSync(join(tmpdir(), 'reading-render-'))
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
        import { Reading } from './src/renderer/src/components/business/Reading';
        import { Generation } from './src/renderer/src/components/business/Generation';
        import { ToastProvider, Toaster } from './src/renderer/src/components/ui';
        const root = createRoot(document.getElementById('root'));
        const engine = createLocalization('zh', resources);
        window.setLanguage = language => engine.changeLanguage(language);
        window.scholarseed = { getApiBase: () => '' };
        window.renderReading = (id = 'paper') => root.render(
          <I18nextProvider i18n={engine}><ToastProvider>
            {id && <Reading literatureId={id} attachmentId={id} revision="revision" onSource={() => {}} onChat={text => {
              window.chatDraft = text;
              if (window.chatMode === 'pending') return new Promise(resolve => { window.resolveChat = resolve });
              if (window.chatMode === 'failed') return Promise.reject(new Error('offline'));
            }} />}
            <Toaster />
          </ToastProvider></I18nextProvider>
        );
        window.renderGeneration = metadata => root.render(
          <I18nextProvider i18n={engine}><Generation metadata={metadata} /></I18nextProvider>
        );
        window.renderReading();
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
          name: 'reading-fixture',
          setup(builder) {
            builder.onResolve({ filter: /^(\.\.\/\.\.\/store|\.\/ModelMenu)$/ }, (args) => ({
              path: args.path,
              namespace: 'reading-fixture',
            }))
            builder.onLoad({ filter: /.*/, namespace: 'reading-fixture' }, (args) => ({
              contents: args.path.endsWith('ModelMenu')
                ? 'export const ModelMenu = () => null'
                : `export const useApp = () => ({state: {
                literatureAiModels: {interpretation: 'model'}, catalog: {models: [{key: 'model'}]},
                model: 'model', activeSession: null, threads: {}
              }, act: {}})`,
            }))
          },
        },
      ],
    })
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.PLAYWRIGHT_CHANNEL,
    })
    context.after(() => browser.close())

    async function fixture(saved = true, withMetadata = true) {
      const result = { ...SAVED, metadata: withMetadata ? SAVED.metadata : undefined }
      const page = await browser.newPage()
      page.setDefaultTimeout(TIMEOUT)
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      const submissions: Route[] = []
      const cancelled: string[] = []
      await page.route(`${ORIGIN}/**`, async (route) => {
        const pathname = new URL(route.request().url()).pathname
        if (pathname === '/')
          return route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/probe.js"></script>',
          })
        if (pathname === '/probe.js')
          return route.fulfill({
            contentType: 'application/javascript',
            body: readFileSync(bundle, 'utf8'),
          })
        if (pathname.endsWith('/ai/state'))
          return route.fulfill({
            json: {
              revision: 'revision',
              attachment_id: 'paper',
              results: saved ? { summary: result } : {},
              task: saved ? { task_id: 'previous', status: 'completed', result } : null,
            },
          })
        if (pathname === TASKS) {
          submissions.push(route)
          return
        }
        if (pathname.endsWith('/cancel')) {
          const id = pathname.split('/').at(-2)!
          cancelled.push(id)
          return route.fulfill({ json: { task_id: id, status: 'cancelled' } })
        }
        if (pathname.endsWith('/events')) return
        return route.fulfill({ json: {} })
      })
      await page.goto(ORIGIN)
      const start = saved
        ? page.getByRole('button', { name: '重新生成', exact: true })
        : page.getByTestId('pdf-generate-summary')
      await expect(start).toBeEnabled()
      if (!saved) {
        await expect(page.getByTestId('reading-chat')).toBeVisible()
        await expect(page.getByTestId('reading-chat')).toBeDisabled()
        await expect(start).toHaveText('立即生成')
        await expect(page.getByText('暂无解读', { exact: true })).toBeVisible()
        await expect(
          page.getByText('帮你梳理论文的核心思考与重要发现', { exact: true })
        ).toBeVisible()
        await expect(page.getByTestId('reading-empty').locator('img')).toBeVisible()
        await expect(page.getByTestId('reading-empty')).toHaveClass(/--vds-space-10/)
        await expect(page.getByTestId('reading-empty').locator('img')).toHaveClass(/--vds-icon-10/)
        await expect(start).toHaveClass(/--vds-font-body-lv1/)
      }
      if (saved) {
        await expect(page.getByTestId('reading-chat')).toHaveText('继续与书深讨论')
        await expect(
          page
            .getByTestId('reading-body')
            .locator('xpath=following-sibling::*')
            .getByTestId('reading-chat')
        ).toBeVisible()
        await expect(start.locator('svg')).toHaveClass(/lucide-rotate-cw/)
        await expect(start).toHaveText('')
        await start.hover()
        await expect(page.getByRole('tooltip')).toHaveText('重新生成')
        await page.keyboard.press('Escape')
        await page.getByTestId('reading-chat').focus()
        await page.keyboard.press('Enter')
        assert.equal(
          await page.evaluate(() => Reflect.get(window, 'chatDraft')),
          SAVED.modules.summary.text
        )
      }
      return { page, start, submissions, cancelled, errors, result }
    }

    async function verifyChatFailure(page: Page): Promise<void> {
      await page.evaluate(() => {
        Reflect.set(window, 'chatMode', 'pending')
      })
      const chat = page.getByTestId('reading-chat')
      await page.keyboard.press('Escape')
      await chat.focus()
      await page.keyboard.press('Enter')
      await expect(chat).toBeDisabled()
      await page.evaluate(() => Reflect.get(window, 'resolveChat')(false))
      await expect(chat).toBeEnabled()
      await expect(page.getByRole('alert')).toContainText('未能打开对话')
      await expect(page.getByText(SAVED.modules.summary.text, { exact: true })).toBeVisible()
      await page.evaluate(() => {
        Reflect.set(window, 'chatMode', 'failed')
      })
      await page.keyboard.press('Escape')
      await chat.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('alert')).toContainText('未能打开对话')
      await expect(chat).toBeEnabled()
      await page.evaluate(() => {
        Reflect.set(window, 'chatMode', '')
      })
      await page.keyboard.press('Escape')
      await page.mouse.move(0, 0)
    }

    for (const saved of [true, false]) {
      await context.test(
        `cancel before acknowledgement targets the new task (saved=${saved})`,
        async () => {
          const { page, start, submissions, cancelled, errors } = await fixture(saved)
          try {
            if (saved) await verifyChatFailure(page)
            await start.click()
            await expect.poll(() => submissions.length).toBe(1)
            await expect(page.getByTestId('reading-generating')).toBeVisible()
            await expect(page.getByTestId('reading-chat')).toBeDisabled()
            await expect(
              page.getByTestId('reading-generating').getByText('正在生成解读', { exact: true })
            ).toBeVisible()
            await expect(page.getByTestId('reading-generating').getByRole('button')).toHaveCount(0)
            await page.getByRole('button', { name: '取消', exact: true }).click()
            await submissions[0].fulfill({ json: { task_id: 'new', status: 'running' } })
            await expect.poll(() => cancelled).toEqual(['new'])
            await expect(
              page.getByText(saved ? '已取消生成，已恢复上次解读。' : '已取消生成。', {
                exact: true,
              })
            ).toBeVisible()
            if (saved)
              await expect(
                page.getByText(SAVED.modules.summary.text, { exact: true })
              ).toBeVisible()
            else await expect(page.getByTestId('pdf-generate-summary')).toBeVisible()
            assert.deepEqual(errors, [])
          } finally {
            await page.close()
          }
        }
      )
    }

    for (const saved of [true, false]) {
      await context.test(
        `partial reading is visible and cancellation restores saved=${saved}`,
        async () => {
          const { page, start, submissions } = await fixture(saved)
          try {
            await start.click()
            await expect.poll(() => submissions.length).toBe(1)
            await submissions[0].fulfill({
              json: {
                task_id: 'streaming',
                status: 'running',
                preview: {
                  text: 'Partial reading',
                  overview: { text: 'Partial reading' },
                  sections: [],
                  organized: true,
                },
              },
            })
            await expect(page.getByText('Partial reading', { exact: true })).toBeVisible()
            await expect(page.getByTestId('reading-chat')).toBeDisabled()
            await expect(page.getByTestId('reading-generating')).toHaveCount(0)
            await page.getByRole('button', { name: '取消', exact: true }).click()
            await expect(page.getByText('Partial reading', { exact: true })).toHaveCount(0)
            if (saved)
              await expect(
                page.getByText(SAVED.modules.summary.text, { exact: true })
              ).toBeVisible()
            else await expect(page.getByTestId('pdf-generate-summary')).toBeVisible()
            if (saved) await expect(page.getByTestId('reading-chat')).toBeEnabled()
            else await expect(page.getByTestId('reading-chat')).toBeDisabled()
          } finally {
            await page.close()
          }
        }
      )
    }

    await context.test(
      'failed submission with a pending cancel preserves the saved reading and permits retry',
      async () => {
        const { page, start, submissions, cancelled, errors } = await fixture()
        try {
          await start.click()
          await expect.poll(() => submissions.length).toBe(1)
          await page.getByRole('button', { name: '取消', exact: true }).click()
          await submissions[0].fulfill({
            status: 503,
            json: { detail: { code: 'pdf_ai_execution_failed' } },
          })
          await expect(page.getByRole('alert')).toBeVisible()
          await expect(page.getByText(SAVED.modules.summary.text, { exact: true })).toBeVisible()
          assert.deepEqual(cancelled, [])
          await start.click()
          await expect.poll(() => submissions.length).toBe(2)
          await submissions[1].fulfill({ json: { task_id: 'retry', status: 'running' } })
          await page.getByRole('button', { name: '取消', exact: true }).click()
          await expect.poll(() => cancelled).toEqual(['retry'])
          assert.deepEqual(errors, [])
        } finally {
          await page.close()
        }
      }
    )

    for (const cancel of [true, false]) {
      await context.test(
        `unmount preserves explicit cancel intent only (cancel=${cancel})`,
        async () => {
          const { page, start, submissions, cancelled, errors } = await fixture()
          try {
            await start.click()
            await expect.poll(() => submissions.length).toBe(1)
            if (cancel) await page.getByRole('button', { name: '取消', exact: true }).click()
            await page.evaluate('window.renderReading(null)')
            await expect(page.getByTestId('paper-reading')).toHaveCount(0)
            const accepted = page.waitForResponse(
              (response) => new URL(response.url()).pathname === TASKS
            )
            await submissions[0].fulfill({ json: { task_id: 'detached', status: 'running' } })
            await accepted
            if (cancel) await expect.poll(() => cancelled).toEqual(['detached'])
            else {
              await page.evaluate(() => new Promise(requestAnimationFrame))
              assert.deepEqual(cancelled, [])
            }
            assert.deepEqual(errors, [])
          } finally {
            await page.close()
          }
        }
      )
    }

    for (const saved of [true, false]) {
      for (const withMetadata of [true, false]) {
        await context.test(
          `reading diagnostics remain hidden (saved=${saved}, metadata=${withMetadata})`,
          async () => {
            const { page, start, submissions, errors, result } = await fixture(saved, withMetadata)
            try {
              if (!saved) {
                await start.click()
                await expect.poll(() => submissions.length).toBe(1)
                await submissions[0].fulfill({
                  json: { task_id: 'completed', status: 'completed', result },
                })
              }
              await expect(
                page.getByText(SAVED.modules.summary.text, { exact: true })
              ).toBeVisible()
              await expect(
                page.getByRole('button', { name: '重新生成', exact: true })
              ).toBeEnabled()
              await expect(page.getByTestId('reading-details')).toBeHidden()
              await expect(page.getByTestId('reading-technical-details')).toBeHidden()
              await expect(page.getByRole('button', { name: '生成详情', exact: true })).toHaveCount(
                0
              )
              await expect(page.getByRole('button', { name: '技术明细', exact: true })).toHaveCount(
                0
              )
              await expect(page.getByTestId('reading-chat')).toBeEnabled()
              assert.equal(submissions.length, saved ? 0 : 1)
              assert.deepEqual(errors, [])
            } finally {
              await page.close()
            }
          }
        )
      }
    }

    await context.test(
      'chat requires a complete published reading, not a preview or fallback',
      async () => {
        const { page, start, submissions, errors } = await fixture(false)
        try {
          for (const [status, organization, readingComplete, text, enabled] of [
            ['running', 'complete', false, 'Preview only', false],
            ['running', 'complete', true, 'Published reading', true],
            ['completed', 'complete', true, 'Finished reading', true],
            ['completed', 'complete', true, '   ', false],
            ['completed', 'partial', true, 'Partial result', false],
            ['completed', 'fallback', true, 'Fallback result', false],
            ['completed', 'abstract', true, 'Abstract only', false],
            ['failed', 'partial', false, 'Failed preview', false],
          ] as const) {
            const requestIndex = submissions.length
            await page.evaluate((id) => {
              Reflect.set(window, 'chatDraft', undefined)
              Reflect.get(window, 'renderReading')(id)
            }, `paper-${requestIndex}`)
            await expect(start).toBeEnabled()
            await start.click()
            await expect.poll(() => submissions.length).toBe(requestIndex + 1)
            const summary = {
              ...SAVED.modules.summary,
              organization,
              text,
              overview: { text },
            }
            await submissions[requestIndex].fulfill({
              json: {
                task_id: `new-${requestIndex}`,
                status,
                reading_complete: readingComplete,
                preview: summary,
                result: { ...SAVED, modules: { summary } },
              },
            })
            const chat = page.getByTestId('reading-chat')
            await expect(page.getByTestId('reading-generating')).toHaveCount(0)
            if (enabled) {
              await expect(chat).toBeEnabled()
              await chat.focus()
              await page.keyboard.press('Enter')
              assert.equal(await page.evaluate(() => Reflect.get(window, 'chatDraft')), text)
            } else {
              await expect(chat, `${status}/${organization}/${text}`).toBeDisabled()
              await chat.evaluate((element: HTMLButtonElement) => element.click())
              assert.equal(await page.evaluate(() => Reflect.get(window, 'chatDraft')), undefined)
            }
            assert.deepEqual(errors, [])
          }
        } finally {
          await page.close()
        }
      }
    )

    await context.test(
      'chat footer stays outside scrolling content in narrow panes and both languages',
      async () => {
        const { page, start, submissions } = await fixture()
        try {
          const stylesheet = join(DESKTOP, 'src/renderer/src/styles.css')
          const compiled = await postcss([
            tailwindcss({ base: join(DESKTOP, 'src/renderer') }),
          ]).process(readFileSync(stylesheet, 'utf8'), { from: stylesheet })
          await page.addStyleTag({ content: compiled.css })
          await start.click()
          await expect.poll(() => submissions.length).toBe(1)
          await submissions[0].fulfill({
            json: {
              task_id: 'long-reading',
              status: 'completed',
              result: {
                ...SAVED,
                modules: {
                  summary: { ...SAVED.modules.summary, text: 'Reading paragraph.\n\n'.repeat(80) },
                },
              },
            },
          })
          const chat = page.getByTestId('reading-chat')
          await expect(chat).toBeEnabled()
          const content = page.getByTestId('reading-body').locator('.overscroll-contain')
          for (const theme of ['light', 'dark']) {
            await page
              .locator('html')
              .evaluate((element, value) => element.setAttribute('data-theme', value), theme)
            for (const [language, label] of [
              ['zh', '继续与书深讨论'],
              ['en', 'Continue discussing with ScholarSeed'],
            ]) {
              await page.evaluate((value) => Reflect.get(window, 'setLanguage')(value), language)
              await expect(chat).toHaveText(label)
              for (const width of [320, 520]) {
                await page.setViewportSize({ width, height: 640 })
                const before = await chat.boundingBox()
                const body = await page.getByTestId('reading-body').boundingBox()
                assert.ok(before && body)
                assert.ok(before.y >= body.y + body.height)
                assert.ok(before.x >= 0 && before.x + before.width <= width)
                assert.ok(before.y + before.height <= 640)
                assert.equal(
                  await chat.evaluate((element) => element.scrollWidth <= element.clientWidth),
                  true
                )
                await content.evaluate((element) => {
                  element.scrollTop = element.scrollHeight
                })
                assert.ok(await content.evaluate((element) => element.scrollTop > 0))
                assert.deepEqual(await chat.boundingBox(), before)
              }
            }
          }
        } finally {
          await page.close()
        }
      }
    )

    await context.test(
      'diagnostics count reading repairs and preserve unknown observations',
      async () => {
        const { page } = await fixture()
        try {
          for (const [retries, expected] of [
            [{ l1_retries: 0, citation_retries: 0, reading_retries: 1 }, '1'],
            [{ l1_retries: 1, citation_retries: 2, reading_retries: 1 }, '4'],
            [{ reading_retries: 0 }, '0'],
            [{}, '未记录'],
          ] as const) {
            const {
              l1_retries: _l1,
              citation_retries: _citations,
              reading_retries: _reading,
              ...metadata
            } = SAVED.metadata
            await page.evaluate(
              `window.renderGeneration(${JSON.stringify({ ...metadata, ...retries })})`
            )
            const generation = page.getByRole('button', { name: '生成详情', exact: true })
            if ((await generation.getAttribute('aria-expanded')) === 'false')
              await generation.click()
            await expect(
              page.getByText(`共 2 次 · 其中修复 ${expected} 次`, { exact: true })
            ).toBeVisible()
            const technical = page.getByRole('button', { name: '技术明细', exact: true })
            await expect(technical).toHaveAttribute('aria-expanded', 'false')
            await expect(page.getByText('生成模型', { exact: true })).not.toBeVisible()
            await technical.click()
            await expect(technical).toHaveAttribute('aria-expanded', 'true')
            await expect(page.getByText('生成模型', { exact: true })).toBeVisible()
            await technical.click()
          }
        } finally {
          await page.close()
        }
      }
    )
  }
)
