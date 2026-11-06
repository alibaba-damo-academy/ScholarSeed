import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

test('authorization preview renders localized diagnostics and preserves the forty-paper count', async (context) => {
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
  const directory = mkdtempSync(join(desktop, 'node_modules/.literature-preview-'))
  try {
    const output = join(directory, 'preview.mjs')
    await build({
      stdin: {
        contents: `
          import React from 'react';
          import { renderToStaticMarkup } from 'react-dom/server';
          import { I18nextProvider } from 'react-i18next';
          import { createLocalization } from './src/localization/engine';
          import { resources } from './src/localization/resources';
          import { StoreContext } from './src/renderer/src/storeContext';
          import { LiteratureResults } from './src/renderer/src/features/literature/Summary';
          import { ResultReport } from './src/renderer/src/features/literature/Report';
          export function renderReport(language, criteriaData) {
            const result = { schema_version: '1.0', session_id: 'session', status: 'no_confident_match',
              retained: 0, candidates: 0, deduplicated: 0, papers: [], sources: [], warnings: [], ...criteriaData };
            const View = ({query, output}) => React.createElement('pre', null, query + '\\n' + output);
            return renderToStaticMarkup(React.createElement(I18nextProvider,
              { i18n: createLocalization(language, resources) }, React.createElement(ResultReport, {result, View})));
          }
          export function render(language, warnings, criteriaData = {}) {
            const content = { schema_version: '1.0', session_id: 'session', status: 'success',
              selection: { artifact_id: 'selection' }, retained: 40, candidates: 40,
              criteria: ['Review'], sources: [], warnings,
              papers: Array.from({ length: 3 }, (_, index) => ({ id: String(index), title: 'Paper ' + index,
                authors: [], year: 2025, reasons: [], sources: [], access: 'unknown' })), ...criteriaData };
            return renderToStaticMarkup(React.createElement(I18nextProvider,
              { i18n: createLocalization(language, resources) },
              React.createElement(StoreContext.Provider, { value: { act: {} } },
                React.createElement(LiteratureResults, { content, cardId: 'card' }))));
          }
        `,
        resolveDir: desktop,
        loader: 'ts',
      },
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      jsx: 'automatic',
      define: { 'import.meta.env.DEV': 'false' },
      loader: { '.png': 'dataurl', '.svg': 'dataurl' },
      plugins: [
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
    const { render, renderReport } = await import(pathToFileURL(output).href)
    const diagnostic = 'agentic-search used degraded retrieval (source_mode=web_only)'
    const chinese = render('zh', [diagnostic])
    assert.match(chinese, /待授权文献 · 40 篇/)
    assert.match(chinese, /本次仅使用网页来源检索/)
    assert.match(chinese, /查看全部结果/)
    assert.match(chinese, /Paper 2/)
    assert.doesNotMatch(chinese, /agentic-search|source_mode|web_only/)
    const english = render('en', [diagnostic])
    assert.match(english, /40/)
    assert.match(english, /This search used web sources only/)
    assert.doesNotMatch(english, /agentic-search|source_mode|web_only/)
    const unknown = render('zh', ['private-tool raw_parameter=private-value'])
    assert.match(unknown, /本次检索存在限制/)
    assert.doesNotMatch(unknown, /private-tool|raw_parameter|private-value/)
    const criteriaData = {
      criteria: ['年份：2023–不限', '本轮结果上限：1 篇'],
      criteria_details: [
        { kind: 'years', text: '年份：2023–不限', values: ['2023', ''] },
        { kind: 'limit', text: '本轮结果上限：1 篇', values: ['1'] },
      ],
    }
    const frozen = JSON.stringify(criteriaData)
    const englishReport = renderReport('en', criteriaData)
    assert.match(englishReport, /Years: 2023–Any/)
    assert.match(englishReport, /Result limit: 1 paper/)
    assert.doesNotMatch(englishReport, /年份|不限|本轮结果上限/)
    const englishCard = render('en', [], criteriaData)
    assert.match(englishCard, /Years: 2023–Any/)
    assert.doesNotMatch(englishCard, /年份|不限/)
    assert.match(renderReport('zh', criteriaData), /年份：2023–不限/)
    assert.match(render('zh', [], criteriaData), /年份：2023–不限/)
    assert.match(renderReport('en', { criteria: criteriaData.criteria }), /年份：2023–不限/)
    assert.equal(JSON.stringify(criteriaData), frozen)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
