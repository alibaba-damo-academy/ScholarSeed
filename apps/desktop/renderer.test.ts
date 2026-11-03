import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { chromium, type Browser } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer, loadConfigFromFile, normalizePath, type Plugin, type UserConfig } from 'vite'

import { supportedFontSources } from './renderer.ts'

const DESKTOP_ROOT = path.dirname(fileURLToPath(import.meta.url))
const RENDERER_ROOT = path.join(DESKTOP_ROOT, 'src', 'renderer')
const PROBE_PATH = '/__renderer_probe'
const INITIAL_ENTRY = 'virtual:renderer-initial'
const LATE_ENTRY = 'virtual:renderer-late'
const BOUNDARY_ENTRY = 'virtual:renderer-boundary'
const VIRTUAL_PREFIX = '\0'
const MODULE_URL_PREFIX = '/@id/__x00__'
const CACHE_PREFIX = 'scholarseed-renderer-'

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        server.close(() => reject(new Error('Unable to reserve a local test port')))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

function probePlugin(modules: Record<string, string>, transformHtml = false): Plugin {
  return {
    name: 'renderer-contract-probe',
    resolveId(id) { if (id in modules) return VIRTUAL_PREFIX + id },
    load(id) { if (id.startsWith(VIRTUAL_PREFIX)) return modules[id.slice(VIRTUAL_PREFIX.length)] },
    configureServer(server) {
      server.middlewares.use(PROBE_PATH, (_request, response, next) => {
        const html = '<!doctype html><html><body><div id="root"></div></body></html>'
        const transformed = transformHtml ? server.transformIndexHtml(PROBE_PATH, html) : Promise.resolve(html)
        transformed.then(content => {
          response.setHeader('Content-Type', 'text/html')
          response.end(content)
        }).catch(next)
      })
    }
  }
}

for (const configFile of ['electron.vite.config.ts', 'vite.web.config.ts']) {
  test(`${configFile} preserves selection identity when a Milkdown subpath is loaded later`, async () => {
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, path.join(DESKTOP_ROOT, configFile))
    assert.ok(loaded)
    const config = configFile.startsWith('electron')
      ? (loaded.config as UserConfig & { renderer: UserConfig }).renderer : loaded.config
    const cache = await mkdtemp(path.join(os.tmpdir(), CACHE_PREFIX))
    const server = await createServer({
      configFile: false,
      root: RENDERER_ROOT,
      cacheDir: cache,
      optimizeDeps: {
        ...config.optimizeDeps,
        // Only the initially opened editor is known to the scanner. Later plugin
        // entries must remain in the same module graph without relying on a reload.
        entries: [],
        include: ['@milkdown/crepe', '@milkdown/kit/prose/state', ...(config.optimizeDeps?.include ?? [])]
      },
      plugins: [probePlugin({
        [INITIAL_ENTRY]: "export { Crepe } from '@milkdown/crepe'; export { Selection } from '@milkdown/kit/prose/state'",
        [LATE_ENTRY]: "export { CellSelection } from '@milkdown/kit/prose/tables'; export { Selection } from '@milkdown/kit/prose/state'"
      })],
      server: { host: '127.0.0.1', port: await reservePort(), strictPort: true }
    })
    let browser: Browser | undefined
    try {
      await server.listen()
      browser = await chromium.launch()
      const page = await browser.newPage()
      await page.goto(new URL(PROBE_PATH, server.resolvedUrls!.local[0]).href)
      const initialUrl = MODULE_URL_PREFIX + INITIAL_ENTRY
      const lateUrl = MODULE_URL_PREFIX + LATE_ENTRY
      const identity = await page.evaluate(async ({ initialUrl, lateUrl }) => {
        const initial = await import(initialUrl)
        const late = await import(lateUrl)
        return {
          sameSelection: initial.Selection === late.Selection,
          sameCellBase: Object.getPrototypeOf(late.CellSelection) === initial.Selection
        }
      }, { initialUrl, lateUrl })
      assert.deepEqual(identity, { sameSelection: true, sameCellBase: true })
    } finally {
      await browser?.close()
      await server.close()
      await rm(cache, { recursive: true, force: true })
    }
  })
}

test('viewer boundary isolates lazy/render errors, survives language changes and resets for a new document', async () => {
  const cache = await mkdtemp(path.join(os.tmpdir(), CACHE_PREFIX))
  const server = await createServer({
    configFile: false,
    root: RENDERER_ROOT,
    cacheDir: cache,
    plugins: [react(), probePlugin({
      [BOUNDARY_ENTRY]: `
        import React from 'react'
        import { createRoot } from 'react-dom/client'
        import { I18nextProvider } from 'react-i18next'
        import { createInstance } from 'i18next'
        import { withViewerBoundary } from '/src/app/viewer.tsx'
        import { Button } from '/src/components/ui/index.ts'
        import zh from ${JSON.stringify('/@fs/' + normalizePath(path.join(DESKTOP_ROOT, 'src', 'localization', 'locales', 'zh', 'workbench.json')))}
        import en from ${JSON.stringify('/@fs/' + normalizePath(path.join(DESKTOP_ROOT, 'src', 'localization', 'locales', 'en', 'workbench.json')))}
        const i18n = createInstance()
        await i18n.init({ lng: 'zh', fallbackLng: 'en', resources: { zh: {workbench: zh}, en: {workbench: en} } })
        const BrokenLazy = React.lazy(() => Promise.reject(new RangeError('Duplicate use of selection JSON ID cell')))
        const viewer = withViewerBoundary({ kind: 'contract', render: props => {
          if (props.path === 'lazy.md') return React.createElement(BrokenLazy)
          if (props.path === 'render.md') throw new Error('viewer render failed')
          return React.createElement('p', { 'data-testid': 'healthy-viewer' }, props.path)
        } })
        function App() {
          const [path, setPath] = React.useState('lazy.md')
          return React.createElement(I18nextProvider, { i18n },
            React.createElement(React.Fragment, null,
              React.createElement(Button, { onClick: () => setPath('healthy.md') }, 'Healthy document'),
              React.createElement(Button, { onClick: () => setPath('render.md') }, 'Render failure'),
              React.createElement(Button, { onClick: () => i18n.changeLanguage('en') }, 'English'),
              viewer.render({ path, tabId: 'same-tab' }),
              viewer.render({ path: 'sibling.md', tabId: 'sibling' })))
        }
        createRoot(document.getElementById('root')).render(React.createElement(App))
      `
    }, true)],
    server: { host: '127.0.0.1', port: await reservePort(), strictPort: true }
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    browser = await chromium.launch()
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto(new URL(PROBE_PATH, server.resolvedUrls!.local[0]).href)
    await page.evaluate(async url => { await import(url) }, MODULE_URL_PREFIX + BOUNDARY_ENTRY)
    await page.getByRole('alert').waitFor()
    assert.match(await page.getByRole('alert').innerText(), /文档视图/)
    assert.equal(await page.getByTestId('healthy-viewer').innerText(), 'sibling.md')
    await page.getByRole('button', { name: 'English' }).click()
    await page.getByRole('alert').filter({ hasText: 'Document view' }).waitFor()
    await page.getByRole('button', { name: 'Healthy document' }).click()
    await page.getByTestId('healthy-viewer').filter({ hasText: 'healthy.md' }).waitFor()
    assert.equal(await page.getByRole('alert').count(), 0)
    await page.getByRole('button', { name: 'Render failure' }).click()
    await page.getByRole('alert').waitFor()
    assert.equal(await page.getByTestId('healthy-viewer').innerText(), 'sibling.md')
    assert.ok(errors.some(message => message.includes('[viewer]') && message.includes('Duplicate use of selection JSON ID cell')))
    assert.ok(errors.some(message => message.includes('[viewer]') && message.includes('viewer render failed')))
  } finally {
    await browser?.close()
    await server.close()
    await rm(cache, { recursive: true, force: true })
  }
})

const FONT_ROOT = path.join(DESKTOP_ROOT, 'node_modules', '@fontsource')
const PUBLISHED_SHEETS = ['ibm-plex-mono/400.css', 'ibm-plex-mono/600.css', 'noto-serif-sc/600.css']

function rewriteFontCss(code: string, id: string): string | null {
  const plugin = supportedFontSources()
  const hook = typeof plugin.transform === 'function' ? plugin.transform : plugin.transform?.handler
  if (!hook) throw new Error('font plugin must register a transform hook')
  const result = (hook as (this: unknown, source: string, module: string) => unknown).call({}, code, id)
  if (result === null || result === undefined) return null
  assert.equal(typeof result, 'object')
  return (result as { code: string }).code
}

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0

test('published @fontsource stylesheets keep every woff2 face and drop the woff fallback', () => {
  for (const relative of PUBLISHED_SHEETS) {
    const file = path.join(FONT_ROOT, ...relative.split('/'))
    const source = readFileSync(file, 'utf8')
    assert.ok(count(source, /@font-face/g) > 0, `${relative} declares no face`)
    assert.ok(count(source, /format\('woff'\)/g) > 0, `${relative} is not the dual-format upstream shape`)
    const rewritten = rewriteFontCss(source, normalizePath(file))
    assert.ok(rewritten, `${relative} was not rewritten`)
    assert.equal(count(rewritten, /@font-face/g), count(source, /@font-face/g))
    assert.equal(count(rewritten, /\.woff2\)/g), count(source, /\.woff2\)/g))
    assert.equal(count(rewritten, /unicode-range:/g), count(source, /unicode-range:/g))
    assert.equal(count(rewritten, /\.woff\)/g), 0)
    assert.equal(count(rewritten, /format\(['"]woff['"]\)/g), 0)
  }
})

test('font rewrite only applies to published @fontsource stylesheets', () => {
  const published = normalizePath(path.join(FONT_ROOT, ...PUBLISHED_SHEETS[0].split('/')))
  const source = readFileSync(path.join(FONT_ROOT, ...PUBLISHED_SHEETS[0].split('/')), 'utf8')
  assert.equal(count(rewriteFontCss(source, `${published}?direct`) ?? '', /\.woff\)/g), 0)
  const product = normalizePath(path.join(DESKTOP_ROOT, 'src', 'renderer', 'src', 'design', 'tokens.css'))
  assert.equal(rewriteFontCss(source, product), null)
  assert.equal(rewriteFontCss(source, published.replace(/\.css$/, '.ts')), null)
})

test('font rewrite fails instead of shipping a declaration it does not understand', () => {
  const published = normalizePath(path.join(FONT_ROOT, ...PUBLISHED_SHEETS[0].split('/')))
  assert.throws(() => rewriteFontCss("@font-face { src: url(a.woff) format('woff'); }", published),
    /only offers a woff fallback/)
  assert.throws(() => rewriteFontCss("@font-face { src: url(a.woff2) format('woff2'), url(a.woff); }", published),
    /unhandled woff declaration/)
  assert.throws(() => rewriteFontCss('@font-face { src: , ; }', published), /has no candidate/)
})

test('both renderer builds register the font source rewrite', async () => {
  const expected = supportedFontSources().name
  for (const configFile of ['electron.vite.config.ts', 'vite.web.config.ts']) {
    const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(DESKTOP_ROOT, configFile))
    assert.ok(loaded, `${configFile} did not load`)
    const config = configFile.startsWith('electron')
      ? (loaded.config as UserConfig & { renderer: UserConfig }).renderer : loaded.config
    const plugins: unknown[] = config.plugins ?? []
    const names = plugins.flat(Infinity).map(entry => (entry as { name?: string } | null)?.name)
    assert.ok(names.includes(expected), `${configFile} must register ${expected}`)
  }
})
