import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { DESKTOP } from './resources.mjs'

test('provider language selects defaults while explicit labels and null overlays remain caller-owned', async () => {
  const directory = mkdtempSync(join(DESKTOP, 'node_modules/.i18n-components-'))
  try {
    const output = join(directory, 'contract.mjs')
    await build({ stdin: { contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { I18nextProvider } from 'react-i18next';
      import { createLocalization } from './src/localization/engine';
      import { resources } from './src/localization/resources';
      import { CopyButton } from './src/renderer/src/components/ui/CopyButton';
      import { Spinner } from './src/renderer/src/components/ui/Spinner';
      import { LoadingOverlay } from './src/renderer/src/components/ui/LoadingOverlay';
      import { Pagination } from './src/renderer/src/components/ui/Pagination';
      export const engine = createLocalization('zh',resources);
      export function render(custom=false) {
        return renderToStaticMarkup(React.createElement(I18nextProvider,{i18n:engine},
          React.createElement(React.Fragment,null,
            React.createElement(CopyButton,{value:'raw',idleLabel:custom?'Custom copy':undefined}),
            React.createElement(Spinner,custom?{'aria-label':'Custom loading'}:{}),
            React.createElement(LoadingOverlay,{visible:true,label:custom?null:undefined}),
            React.createElement(Pagination,{page:2,pageCount:4,onPageChange:()=>{},ariaLabel:custom?'Custom pages':undefined})
          )));
      }`, resolveDir: DESKTOP, loader: 'ts' }, outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic' })
    const {engine,render} = await import(pathToFileURL(output).href)
    assert.match(render(), /复制/)
    assert.match(render(), /加载中/)
    assert.match(render(), /第 2 页/)
    await engine.changeLanguage('en')
    assert.match(render(), /Copy/)
    assert.match(render(), /Loading/)
    assert.match(render(), /Page 2/)
    const custom=render(true)
    for (const label of ['Custom copy','Custom loading','Custom pages']) assert.ok(custom.includes(label))
    assert.doesNotMatch(custom,/>Loading<\/span>/)
  } finally { rmSync(directory,{recursive:true,force:true}) }
})
