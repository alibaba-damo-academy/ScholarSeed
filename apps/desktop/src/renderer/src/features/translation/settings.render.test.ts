import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium, expect } from '@playwright/test'

test('translation settings and grouped controls render without a fabricated offline capability', async (context) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: {} },
  })
  context.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  const desktop = fileURLToPath(new URL('../../../../../', import.meta.url))
  const directory = mkdtempSync(join(desktop, 'node_modules/.translation-render-'))
  try {
    const output = join(directory, 'render.mjs')
    await build({
      stdin: {
        contents: `
        import React from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { I18nextProvider } from 'react-i18next';
        import { createLocalization } from './src/localization/engine';
        import { resources } from './src/localization/resources';
        import { StoreContext } from './src/renderer/src/storeContext';
        import { defaultSelectionPrompts } from './src/prompts';
        import { TranslationSettings } from './src/renderer/src/features/translation/Settings';
        import { TranslationControls } from './src/renderer/src/features/translation/Controls';
        export function render(content = React.createElement(TranslationSettings)) {
          return renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: createLocalization('en', resources) },
            React.createElement(StoreContext.Provider, { value: { state: { lang: 'zh', selectionPrompts: defaultSelectionPrompts('zh'), catalog: { models: [] } }, act: {} } },
              content)));
        }
        export function renderControls(group, compact = false) {
          return render(React.createElement(TranslationControls, {
            group, compact, value: {engine:'ai:model',source:'auto',target:'zh-CN'},
            onChange:()=>{}, onRefresh:()=>{}
          }));
        }
      `,
        resolveDir: desktop,
        loader: 'ts',
      },
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'esm',
      nodePaths: [join(desktop, 'node_modules')],
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      jsx: 'automatic',
      define: { 'import.meta.env.DEV': 'false' },
      loader: { '.png': 'dataurl', '.svg': 'dataurl', '.webp': 'dataurl' },
      plugins: [
        {
          name: 'absent-translation-subscription',
          setup(builder) {
            builder.onResolve({ filter: /^\.\/context$/ }, (args) =>
              /features\/translation\/(Settings|Controls|Preferences)\.tsx$/.test(args.importer)
                ? { path: 'absent-subscription', namespace: 'fixture' }
                : undefined
            )
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
              contents:
                'export const useTranslationBackend = () => ({ backend: null, settings: null })',
              loader: 'js',
            }))
          },
        },
        {
          name: 'styles',
          setup(builder) {
            builder.onResolve({ filter: /\.css$/ }, (args) => ({
              path: args.path,
              namespace: 'styles',
            }))
            builder.onLoad({ filter: /.*/, namespace: 'styles' }, () => ({
              contents: '',
              loader: 'js',
            }))
          },
        },
      ],
    })
    const { render, renderControls } = await import(pathToFileURL(output).href)
    const html = render()
    assert.match(html, /Translation configuration/)
    assert.match(html, /Translation services are not connected/)
    assert.doesNotMatch(html, /Offline translation|Connection validated/)
    const engine = renderControls('engine')
    const languages = renderControls('languages')
    const combined = renderControls(undefined, true)
    assert.match(engine, /aria-label="Choose a translation model or service"/)
    assert.equal((engine.match(/role="combobox"/g) ?? []).length, 1)
    assert.doesNotMatch(languages, /aria-label="Choose a translation model or service"/)
    assert.equal((languages.match(/role="combobox"/g) ?? []).length, 2)
    assert.equal((combined.match(/role="combobox"/g) ?? []).length, 3)
    assert.match(combined, /aria-label="Choose a translation model or service"/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('saved public configuration survives save and settings remount without echoing secrets', async () => {
  const desktop = fileURLToPath(new URL('../../../../../', import.meta.url))
  const bundle = await build({
    stdin: {
      resolveDir: desktop,
      loader: 'tsx',
      contents: `
        import React, { useState } from 'react'
        import { createRoot } from 'react-dom/client'
        import { I18nextProvider } from 'react-i18next'
        import { createLocalization } from './src/localization/engine'
        import { resources } from './src/localization/resources'
        import { StoreContext } from './src/renderer/src/storeContext'
        import { defaultSelectionPrompts } from './src/prompts'
        import { ToastProvider } from './src/renderer/src/components/ui'
        import { TranslationSettings } from './src/renderer/src/features/translation/Settings'
        import { TranslationProvider } from './src/renderer/src/features/translation/context'
        import { createLiveTranslation } from './src/renderer/src/features/translation/live'
        let saved = { appId: 'original-app-id', appSecret: 'stored-secret' }
        let configured = true
        window.verifications = []
        function Fixture() {
          const [revision, setRevision] = useState(0)
          const [backend] = useState(() => createLiveTranslation(async request => {
            if (request.operation === 'invalidate') configured = false
            if (request.operation === 'verify') {
              saved = request.fields
              configured = true
              window.verifications.push(request.fields)
            }
            return { status: 200, body: JSON.stringify({
              services: { baidu: configured ? 'configured' : 'unconfigured' },
              configuration: configured ? { baidu: saved, unknown: { appId: 'unknown' } } : {},
              preferences: { toolbar: true, selectionAutomatic: false }
            }) }
          }))
          React.useEffect(() => { void backend.load() }, [backend])
          return <I18nextProvider i18n={createLocalization('en', resources)}><ToastProvider>
            <StoreContext.Provider value={{ state: { lang: 'en', selectionPrompts: defaultSelectionPrompts('en'), catalog: { models: [] } }, act: {} }}>
              <button onClick={() => { void backend.load(); setRevision(value => value + 1) }}>Reopen settings</button>
              <TranslationProvider backend={backend}><TranslationSettings key={revision} /></TranslationProvider>
              <button onClick={() => { window.publicState = backend.snapshot() }}>Inspect public state</button>
            </StoreContext.Provider>
          </ToastProvider></I18nextProvider>
        }
        createRoot(document.getElementById('root')).render(<Fixture />)
      `,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl' },
  })
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await expect
      .poll(async () => ({
        errors,
        rendered: await page.getByTestId('translation-service-baidu').count(),
      }))
      .toEqual({ errors: [], rendered: 1 })
    const service = page.getByTestId('translation-service-baidu')
    await service.getByRole('button', { name: 'Baidu Translate', exact: true }).click()
    const appId = service.getByRole('textbox', {
      name: 'Baidu Translate Application ID',
      exact: true,
    })
    const secret = service.getByRole('textbox', {
      name: 'Baidu Translate Application secret',
      exact: true,
    })
    await expect(appId).toHaveValue('original-app-id')
    await expect(secret).toHaveValue('')
    await appId.fill('replacement-app-id')
    await secret.fill('replacement-secret')
    await service.getByRole('button', { name: 'Save configuration', exact: true }).click()
    await expect(appId).toHaveValue('replacement-app-id')
    await expect(secret).toHaveValue('')
    await expect(service.getByRole('status')).toContainText('Connection verified')
    await page.getByRole('button', { name: 'Reopen settings', exact: true }).click()
    await service.getByRole('button', { name: 'Baidu Translate', exact: true }).click()
    await expect(appId).toHaveValue('replacement-app-id')
    await expect(secret).toHaveValue('')
    await secret.fill('another-secret')
    await expect(appId).toHaveValue('replacement-app-id')
    await service.getByRole('button', { name: 'Save configuration', exact: true }).click()
    await expect(secret).toHaveValue('')
    await page.getByRole('button', { name: 'Inspect public state', exact: true }).click()
    const result = await page.evaluate(() => ({
      state: (window as unknown as { publicState: unknown }).publicState,
      verifications: (window as unknown as { verifications: unknown }).verifications,
    }))
    assert.deepEqual(result.verifications, [
      { appId: 'replacement-app-id', appSecret: 'replacement-secret' },
      { appId: 'replacement-app-id', appSecret: 'another-secret' },
    ])
    assert.deepEqual((result.state as { configuration: unknown }).configuration, {
      baidu: { appId: 'replacement-app-id' },
    })
    assert.doesNotMatch(
      JSON.stringify(result.state),
      /stored-secret|replacement-secret|another-secret|unknown/
    )
  } finally {
    await browser.close()
  }
})
