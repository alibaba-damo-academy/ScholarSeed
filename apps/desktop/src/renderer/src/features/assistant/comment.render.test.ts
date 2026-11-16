import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { chromium, expect } from '@playwright/test'

const DESKTOP = fileURLToPath(new URL('../../../../../', import.meta.url))

test('PDF comment pending preview distinguishes feedback, revalidates on reopen and exposes stale failures', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: DESKTOP,
      loader: 'tsx',
      contents: `
      import React from 'react'
      import {createRoot} from 'react-dom/client'
      import {PdfCommentReference} from './src/renderer/src/features/assistant/Comment'
      window.requests=[]; window.failed=false;
      window.fetch=async(url,init)=>{window.requests.push([url,JSON.parse(init.body)]);return new Response(JSON.stringify({comment:'My own PDF thought',page:3}),{status:window.failed?409:200})};
      const reference={id:'comment',sourceId:'stable-identity',sourceRevision:'record-version',label:'PDF · 3'};
      createRoot(document.getElementById('root')).render(<PdfCommentReference {...reference} presentation="draft" onClear={()=>{}} testId="draft-pdf-comment"/>);
    `,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl' },
    plugins: [
      {
        name: 'translation',
        setup(builder) {
          builder.onResolve({ filter: /^react-i18next$/ }, () => ({
            path: 'i18n',
            namespace: 'fixture',
          }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            loader: 'js',
            contents: 'export const useTranslation=()=>({t:key=>key,i18n:{resolvedLanguage:"en"}})',
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
    const attachment = page.getByTestId('draft-pdf-comment')
    await expect(attachment).toContainText('pdfComment.page')
    const chip = attachment.getByRole('button', { name: 'contextGroups.annotations' })
    await chip.hover()
    const preview = page.getByTestId('pdf-comment-context-preview')
    await expect(preview).toContainText('My own PDF thought')
    await expect(preview).not.toContainText('pdfComment.feedback')
    await expect(preview).not.toContainText('pdfComment.page')
    await expect(preview).toContainText('annotation.userComment')
    await page.mouse.move(700, 700)
    await expect(preview).toHaveCount(0)
    await page.evaluate(() => Reflect.set(window, 'failed', true))
    await chip.focus()
    await expect(preview.getByRole('alert')).toHaveText('pdfComment.unavailable')
    await expect(preview).not.toContainText('My own PDF thought')
    const requests = await page.evaluate(() => Reflect.get(window, 'requests'))
    assert.equal(requests.length, 2)
    assert.deepEqual(requests[0], [
      '/api/workbench/pdf-comments/preview',
      { source_id: 'stable-identity', source_revision: 'record-version' },
    ])
  } finally {
    await browser.close()
  }
})
