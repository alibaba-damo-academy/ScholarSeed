import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium, expect, type Browser } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { transformWithEsbuild, type Plugin } from 'vite'
import { renderServers } from '../../../../../test-helpers/render.ts'

const servers = renderServers({ after })

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const PROBE_PATH = '/__pdf_page_probe'
const VIRTUAL_PREFIX = '\0pdf-page-probe:'
const VIRTUAL_SUFFIX = '.tsx'
const ENTRY = 'pdf-page-probe-entry'
const PAGE_SUFFIX = '/features/workbench/pdf/Page.tsx'
const INTERACTION_TIMEOUT_MS = 10000
const modules: Record<string, string> = {
  'pdfjs-dist/legacy/web/pdf_viewer.mjs': `
    window.textLayers = []
    export class TextLayerBuilder {
      constructor(options) {
        this.options = options
        this.div = document.createElement('div')
        this.div.className = 'textLayer'
        this.cancelled = false
        window.textLayers.push(this)
      }
      render() {
        this.connectedDuringRender = this.div.isConnected
        return new Promise((resolve, reject) => {
          this.complete = () => {
            const span = document.createElement('span')
            span.textContent = 'selectable text'
            this.div.append(span)
            this.options.onAppend?.(this.div)
            resolve()
          }
          this.fail = () => reject(new Error('text render failed'))
        })
      }
      cancel() { this.cancelled = true; this.div.replaceChildren() }
    }
  `,
  'react-i18next': 'export const useTranslation = () => ({ t: key => key })',
  '../../../icons': 'export const Icon = () => null',
  '../../../components/ui': `
    export const Button = () => null
    export const IconButton = () => null
    export const Popover = () => null
    export const PopoverContent = () => null
    export const PopoverTrigger = () => null
    export const Tooltip = () => null
  `,
  [ENTRY]: `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { PdfPage, PdfPageSlot } from '/features/workbench/pdf/Page.tsx'
    import { selectionRectangles } from '/features/workbench/pdf/geometry.ts'
    import '/features/workbench/pdf/pdf.css'
    const pdfPage = {
      pageNumber: 1, userUnit: 1,
      getViewport: ({ scale }) => ({ width: 200 * scale, height: 300 * scale }),
      render: () => ({ promise: Promise.resolve(), cancel() {} }),
      getAnnotations: async () => [], cleanup() {},
      getOperatorList: async () => ({ fnArray: [], argsArray: [] })
    }
    window.textPageLanguages = []
    const fonts = {
      prepare: async () => ({ lang: window.pdfLanguage ?? null, items: [], styles: {} }),
      textPage: (page, language) => {
        window.textPageLanguages.push(language)
        return page
      }
    }
    const loadPage = async pageNumber => {
      window.loadedPages.push(pageNumber)
      return { ...pdfPage, pageNumber }
    }
    window.loadedPages = []
    window.measurePdfSelectionRectangles = () => {
      const layer = document.createElement('div')
      layer.className = 'textLayer'
      layer.style.cssText = 'position:absolute;left:0;top:0;font:20px monospace;white-space:pre;'
      const text = document.createTextNode('abcdef')
      layer.append(text)
      document.body.append(layer)
      const range = document.createRange()
      range.setStart(text, 1)
      range.setEnd(text, 4)
      const rectangles = selectionRectangles(range, layer).map(rect => ({
        left: rect.left,
        right: rect.right,
        width: rect.right - rect.left
      }))
      const full = layer.getBoundingClientRect()
      layer.remove()
      return { rectangles, fullWidth: full.width }
    }
    function Fixture() {
      const [scale, setScale] = useState(1)
      const [visible, setVisible] = useState(true)
      const [focus, setFocus] = useState(undefined)
      const [quads, setQuads] = useState([])
      window.setPdfScale = setScale
      window.setPdfVisible = setVisible
      window.focusPdfCitation = quads => {
        setQuads(quads)
        setFocus(previous => ({ kind: 'citation', page: 5, sequence: (previous?.sequence ?? 0) + 1 }))
      }
      if (location.search) return <div className="vds-pdf-pages" style={{ height: 300, overflow: 'auto' }}>
        <div style={{ height: 3000 }} />
        <PdfPageSlot estimatedSize={{ width: 200, height: 300 }} loadPage={loadPage}
          pageNumber={5} fonts={fonts} scale={scale} focus={focus} citationQuads={quads} />
      </div>
      return visible ? <PdfPage page={pdfPage} fonts={fonts} scale={scale} /> : null
    }
    createRoot(document.getElementById('root')).render(<Fixture />)
  `,
}
const MODULE_KEYS = Object.keys(modules)

function moduleId(key: string): string {
  return VIRTUAL_PREFIX + MODULE_KEYS.indexOf(key) + VIRTUAL_SUFFIX
}

function probePlugin(): Plugin {
  return {
    name: 'pdf-page-lifecycle-probe',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id.startsWith(VIRTUAL_PREFIX)) return id
      if (id === ENTRY || (importer?.includes(PAGE_SUFFIX) && id in modules)) return moduleId(id)
    },
    load(id) {
      if (id.startsWith(VIRTUAL_PREFIX))
        return modules[MODULE_KEYS[Number(id.slice(VIRTUAL_PREFIX.length, -VIRTUAL_SUFFIX.length))]]
    },
    transform(code, id) {
      if (id.startsWith(VIRTUAL_PREFIX))
        return transformWithEsbuild(code, 'pdf-page-probe.tsx', {
          loader: 'tsx',
          jsx: 'automatic',
          tsconfigRaw: {},
        })
    },
    configureServer(server) {
      server.middlewares.use(PROBE_PATH, (_request, response, next) => {
        server
          .transformIndexHtml(
            PROBE_PATH,
            `<!doctype html><html lang="zh-CN"><body style="font-weight:500;font-style:italic"><div id="root"></div><script type="module" src="/@id/__x00__pdf-page-probe:${MODULE_KEYS.indexOf(ENTRY)}${VIRTUAL_SUFFIX}"></script></body></html>`
          )
          .then((html) => {
            response.setHeader('Content-Type', 'text/html')
            response.end(html)
          })
          .catch(next)
      })
    },
  }
}

test('PDF selection rectangles measure selected glyphs instead of whole text nodes', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT_DIR,
    plugins: [probePlugin(), react()],
    cacheKey: 'pdf-selection',
    server: { host: '127.0.0.1', port: 0 },
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    browser = await chromium.launch()
    const page = await browser.newPage()
    page.setDefaultTimeout(INTERACTION_TIMEOUT_MS)
    await page.goto(new URL(PROBE_PATH, server.resolvedUrls!.local[0]).href)
    const measured = await page.evaluate(() =>
      Reflect.get(window, 'measurePdfSelectionRectangles')()
    )
    assert.equal(measured.rectangles.length, 3)
    assert.ok(measured.rectangles.every((rect: { width: number }) => rect.width > 0))
    assert.ok(
      measured.rectangles.reduce(
        (total: number, rect: { width: number }) => total + rect.width,
        0
      ) < measured.fullWidth
    )
  } finally {
    await browser?.close()
    await server.close()
  }
})

test('PDF text layer matches canvas language and normal font metrics', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT_DIR,
    plugins: [probePlugin(), react()],
    cacheKey: 'pdf-metrics',
    server: { host: '127.0.0.1', port: 0 },
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    browser = await chromium.launch()
    for (const documentLanguage of [null, 'fr-FR']) {
      const page = await browser.newPage()
      page.setDefaultTimeout(INTERACTION_TIMEOUT_MS)
      if (documentLanguage)
        await page.addInitScript((language) => {
          Reflect.set(window, 'pdfLanguage', language)
        }, documentLanguage)
      await page.goto(new URL(PROBE_PATH, server.resolvedUrls!.local[0]).href)
      await page.waitForFunction(() => Reflect.get(window, 'textLayers')?.[0]?.complete)
      await page.evaluate(() => Reflect.get(window, 'textLayers')[0].complete())
      const metrics = await page.locator('.vds-pdf-page .textLayer').evaluate((layer) => {
        const span = layer.querySelector('span')!
        const style = getComputedStyle(span)
        return {
          language: layer.getAttribute('lang'),
          weight: style.fontWeight,
          fontStyle: style.fontStyle,
        }
      })
      const language = documentLanguage ?? 'zh-CN'
      assert.deepEqual(metrics, { language, weight: '400', fontStyle: 'normal' })
      assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'textPageLanguages')), [
        language,
      ])
      await page.close()
    }
  } finally {
    await browser?.close()
    await server.close()
  }
})

test('PDF text layers build detached and only the current completed render becomes selectable', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT_DIR,
    plugins: [probePlugin(), react()],
    cacheKey: 'pdf-page',
    server: { host: '127.0.0.1', port: 0 },
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    browser = await chromium.launch()
    const page = await browser.newPage()
    page.setDefaultTimeout(INTERACTION_TIMEOUT_MS)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(new URL(PROBE_PATH, server.resolvedUrls!.local[0]).href)
    const target = page.getByTestId('pdf-page-1')
    await page.waitForFunction(() => Reflect.get(window, 'textLayers')?.[0]?.complete)
    assert.equal(
      await page.evaluate(() => Reflect.get(window, 'textLayers')[0].connectedDuringRender),
      false
    )
    await expect(target.locator('.textLayer')).toHaveCount(0)
    await expect(target).toHaveAttribute('data-text-rendered', 'false')
    await page.evaluate(() => Reflect.get(window, 'textLayers')[0].complete())
    await expect(target.locator('.textLayer')).toHaveText('selectable text')
    await expect(target).toHaveAttribute('data-text-rendered', 'true')

    await page.evaluate(() => Reflect.get(window, 'setPdfScale')(2))
    await page.waitForFunction(() => Reflect.get(window, 'textLayers')?.[1]?.complete)
    await page.evaluate(() => Reflect.get(window, 'setPdfScale')(3))
    await page.waitForFunction(() => Reflect.get(window, 'textLayers')[1].cancelled)
    await page.evaluate(() => Reflect.get(window, 'textLayers')[1].complete())
    await page.waitForFunction(() => Reflect.get(window, 'textLayers')?.[2]?.complete)
    await expect(target.locator('.textLayer')).toHaveCount(0)
    await expect(target).toHaveAttribute('data-text-rendered', 'false')
    await page.evaluate(() => Reflect.get(window, 'textLayers')[2].complete())
    await expect(target.locator('.textLayer')).toHaveCount(1)
    await expect(target).toHaveAttribute('data-text-rendered', 'true')

    await page.evaluate(() => Reflect.get(window, 'setPdfScale')(4))
    await page.waitForFunction(() => Reflect.get(window, 'textLayers')?.[3]?.complete)
    await page.evaluate(() => Reflect.get(window, 'setPdfVisible')(false))
    await expect(target).toHaveCount(0)
    await page.evaluate(() => Reflect.get(window, 'textLayers')[3].complete())
    assert.equal(
      await page.evaluate(() => Reflect.get(window, 'textLayers')[3].div.isConnected),
      false
    )
    assert.equal(
      await page.evaluate(() => Reflect.get(window, 'textLayers')[3].options.abortSignal.aborted),
      true
    )
    await page.evaluate(() => Reflect.get(window, 'setPdfVisible')(true))
    await page.waitForFunction(() => Reflect.get(window, 'textLayers')?.[4]?.complete)
    await page.evaluate(() => Reflect.get(window, 'textLayers')[4].fail())
    await expect(target).toHaveAttribute('data-canvas-rendered', 'true')
    await expect(target).toHaveAttribute('data-text-rendered', 'false')
    await expect(target.locator('.textLayer')).toHaveCount(0)
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await server.close()
  }
})

test('citation focus loads an offscreen page and navigates exact and page-only targets', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT_DIR,
    plugins: [probePlugin(), react()],
    cacheKey: 'pdf-focus',
    server: { host: '127.0.0.1', port: 0 },
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    browser = await chromium.launch()
    const page = await browser.newPage()
    page.setDefaultTimeout(INTERACTION_TIMEOUT_MS)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    for (const quads of [[[0.1, 0.2, 0.8, 0.3]], []]) {
      await page.goto(new URL(`${PROBE_PATH}?slot`, server.resolvedUrls!.local[0]).href)
      const target = page.getByTestId('pdf-page-5')
      await expect(target).toHaveAttribute('data-rendered', 'false')
      assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'loadedPages')), [])
      await page.evaluate((quads) => Reflect.get(window, 'focusPdfCitation')(quads), quads)
      await page.waitForFunction(() => Reflect.get(window, 'loadedPages').includes(5))
      await expect(target).toBeInViewport()
      await expect(target.locator('[data-citation-highlight]')).toHaveCount(quads.length)
      await page.waitForFunction(() => Reflect.get(window, 'textLayers')?.[0]?.complete)
      await page.evaluate(() => Reflect.get(window, 'textLayers')[0].complete())
      await expect(target).toHaveAttribute('data-text-rendered', 'true')
      await page.evaluate(() => {
        document.querySelector('.vds-pdf-pages')!.scrollTop = 0
      })
      await expect(target).not.toBeInViewport()
      await page.evaluate((quads) => Reflect.get(window, 'focusPdfCitation')(quads), quads)
      await expect(target).toBeInViewport()
      assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'loadedPages')), [5])
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await server.close()
  }
})
