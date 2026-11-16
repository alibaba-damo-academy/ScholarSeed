import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { build } from 'esbuild'

const DESKTOP = fileURLToPath(new URL('../../../../../', import.meta.url))
const DOCUMENT_MODULE = '/features/workbench/MarkdownDocument.tsx'
const EXTERNAL_URL = 'https://example.org/paper?query=attention#abstract'
const REFERENCE_URL = 'https://doi.org/10.1234/example'
const metadata = {
  version: 1,
  title: 'Reference title',
  authors: 'Stored author',
  year: '2026',
  publication: 'Stored journal',
  url: REFERENCE_URL,
  doi: '',
}
const markdown = [
  `[Web source](${EXTERNAL_URL})`,
  '[Reference](#ref-paper)',
  '## References',
  `<a id="ref-paper" data-scholarseed-reference="${encodeURIComponent(JSON.stringify(metadata))}"></a>`,
  '[1] Reference title. Stored author. 2026.',
].join('\n\n')
const workspaceModule = `
  const session = { id: 'session', documentId: 'document', revision: 'revision', changeVersion: 0, title: 'review.md', text: ${JSON.stringify(markdown)}, loadState: 'ready', saveState: 'clean', source: {kind:'project',project:'project',path:'review.md'}, capabilities:{can_edit:true,can_select:true} }
  const state = {focusedTabId:'tab',tabs:{tab:{id:'tab',sessionId:'session'}},sessions:{session}}
  const controller = {getSnapshot:()=>state,registerSaveDelegate:()=>()=>{},setSelection:()=>{},setTabView:()=>{},updateText:()=>{}}
  export const useDocumentWorkspace = () => state
  export const useWorkspaceController = () => controller
  export const selectionFingerprint = () => ''
  export const selectionViewport = () => undefined
  export const documentSelectionReveal = () => undefined
`

test('Markdown reader sends web links and bibliography titles through the embedded web navigator', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: DESKTOP,
      loader: 'tsx',
      contents: `
        import React from 'react'
        import { createRoot } from 'react-dom/client'
        import { I18nextProvider } from 'react-i18next'
        import { createLocalization } from './src/localization/engine'
        import { resources } from './src/localization/resources'
        import { ToastProvider } from './src/renderer/src/components/ui'
        import { WebNavigationContext } from './src/renderer/src/contracts/navigation'
        import { openWebPage } from './src/renderer/src/app/links'
        import { MarkdownDocument } from './src/renderer/src/features/workbench/MarkdownDocument'
        window.external=[]
        window.opened=[]
        window.revealed=[]
        window.failures=[]
        window.available=true
        window.scholarseed={platform:'darwin',openExternal:async url=>window.external.push(url)}
        const localization=createLocalization('en',resources,{report:()=>{}})
        const navigate=url=>{void openWebPage(url,{
          available:window.available,
          dispatch:async command=>{window.opened.push(command);return {ok:true,snapshot:{activeTabId:'embedded-page'}}},
          reveal:options=>window.revealed.push(options)
        }).catch(error=>window.failures.push(error.message))}
        createRoot(document.getElementById('root')).render(
          <I18nextProvider i18n={localization}><ToastProvider><WebNavigationContext.Provider value={navigate}>
            <MarkdownDocument sessionId="session" tabId="tab" viewKind="preview" />
          </WebNavigationContext.Provider></ToastProvider></I18nextProvider>
        )
      `,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    define: { 'import.meta.env.DEV': 'false' },
    jsx: 'automatic',
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    plugins: [
      {
        name: 'markdown-navigation-boundaries',
        setup(builder) {
          const modules: Record<string, string> = {
            '../../store': 'export const useApp=()=>({state:{editorRuntimeRevision:0}})',
            './workspace': workspaceModule,
            './MonacoDocument': 'export const MonacoDocument=()=>null',
          }
          builder.onResolve({ filter: /^\.\// }, (args) => {
            if (args.importer.endsWith(DOCUMENT_MODULE) && args.path in modules)
              return { path: args.path, namespace: 'markdown-navigation-test' }
          })
          builder.onResolve({ filter: /^\.\.\/\.\.\/store$/ }, (args) => {
            if (args.importer.endsWith(DOCUMENT_MODULE))
              return { path: args.path, namespace: 'markdown-navigation-test' }
          })
          builder.onLoad({ filter: /.*/, namespace: 'markdown-navigation-test' }, (args) => ({
            contents: modules[args.path],
            loader: 'js',
          }))
        },
      },
    ],
  })
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const source = page.getByText('Web source', { exact: true })
    await expect(source).toBeVisible()
    await source.click()
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'opened')))
      .toEqual([{ kind: 'open', input: EXTERNAL_URL }])
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'revealed')), [
      { preserveProject: true, browserPageId: 'embedded-page', browserPageOwned: true },
    ])
    await source.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'opened').length)).toBe(2)
    const reference = page.getByText('Reference', { exact: true })
    await expect(reference).toHaveAttribute('data-citation-marker', 'true')
    await expect(reference).toHaveAttribute('href', '#ref-paper')
    await expect(source).not.toHaveAttribute('data-citation-marker', 'true')
    await reference.hover()
    const card = page.getByTestId('bibliography-preview')
    await expect(card).toContainText('Stored author')
    await card.getByRole('button', { name: 'Reference title' }).click()
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'opened').at(-1)))
      .toEqual({
        kind: 'open',
        input: REFERENCE_URL,
      })
    await reference.click()
    const referenceTarget = page.getByText('[1] Reference title. Stored author. 2026.', {
      exact: true,
    })
    await expect
      .poll(() => referenceTarget.evaluate((element) => element.getAnimations().length))
      .toBe(1)
    assert.equal(await page.evaluate(() => Reflect.get(window, 'opened').length), 3)
    await page.evaluate(() => Reflect.set(window, 'available', false))
    await source.click()
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'failures').length)).toBe(1)
    assert.equal(await page.evaluate(() => Reflect.get(window, 'opened').length), 3)
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'external')), [])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
