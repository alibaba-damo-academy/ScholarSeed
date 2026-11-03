import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build } from 'vite'
import type * as IconModule from './Iconfont'

test('production stylesheet emits every icon font and references its emitted asset', async () => {
  // Exercise the real nested CSS imports and PostCSS pipeline: dev and SSR
  // markup alone cannot detect a font URL left pointing into the source tree.
  const result = await build({
    configFile: false,
    root: fileURLToPath(new URL('../../../', import.meta.url)),
    base: './',
    logLevel: 'silent',
    build: {
      write: false,
      assetsInlineLimit: 0,
      rollupOptions: { input: fileURLToPath(new URL('../../styles.css', import.meta.url)) },
    },
  })
  assert.ok(!Array.isArray(result) && 'output' in result)
  const assets = result.output.filter((entry) => entry.type === 'asset')
  const css = assets
    .filter((entry) => entry.fileName.endsWith('.css'))
    .map((entry) => String(entry.source))
    .join('\n')
  for (const extension of ['woff2', 'woff', 'ttf']) {
    const expected = readFileSync(
      new URL(`./Iconfont/download/iconfont.${extension}`, import.meta.url)
    )
    const asset = assets.find(
      (entry) =>
        entry.fileName.endsWith(`.${extension}`) && Buffer.from(entry.source).equals(expected)
    )
    assert.ok(asset, `production CSS must emit iconfont.${extension}`)
    assert.ok(
      css.includes(`./${asset.fileName.split('/').at(-1)}`),
      `CSS must reference emitted ${extension}`
    )
  }
  assert.equal(css.includes('components/primitive/Iconfont/download'), false)
})

test('icon catalog preserves every supplier glyph and both public name forms', () => {
  const catalog = JSON.parse(
    readFileSync(new URL('./Iconfont/download/iconfont.json', import.meta.url), 'utf8')
  )
  const compiled = buildSync({
    entryPoints: [fileURLToPath(new URL('./Iconfont/index.tsx', import.meta.url))],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    packages: 'external',
    jsx: 'automatic',
  }).outputFiles[0].text
  const loaded = { exports: {} as typeof IconModule }
  runInNewContext(compiled, {
    module: loaded,
    exports: loaded.exports,
    require: createRequire(import.meta.url),
  })
  const names = new Set<string>()
  for (const glyph of catalog.glyphs) {
    assert.equal(names.has(glyph.font_class), false)
    names.add(glyph.font_class)
    assert.equal(parseInt(glyph.unicode, 16), glyph.unicode_decimal)
    for (const type of [glyph.font_class, `${catalog.css_prefix_text}${glyph.font_class}`]) {
      const markup = renderToStaticMarkup(
        createElement(loaded.exports.IconFont, { type, className: 'consumer' })
      )
      assert.ok(markup.includes(`data-icon-glyph="${String.fromCodePoint(glyph.unicode_decimal)}"`))
      assert.ok(markup.includes('aria-hidden="true"'))
      assert.ok(markup.includes('consumer'))
      assert.ok(markup.endsWith('></span>'))
    }
  }
  const missing = renderToStaticMarkup(
    createElement(loaded.exports.IconFont, { type: 'unknown-glyph' })
  )
  assert.equal(missing.includes('data-icon-glyph='), false)
})
