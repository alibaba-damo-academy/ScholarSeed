import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import { transformSync } from 'esbuild'

test('viewer identity survives mode changes and failed viewers can recover in another mode', () => {
  const source = readFileSync(new URL('./viewer.tsx', import.meta.url), 'utf8')
  const compiled = transformSync(`${source}\nexport { ViewerBoundary }`, {
    loader: 'tsx',
    format: 'cjs',
    jsx: 'transform',
  }).code
  const loaded = { exports: {} as any }
  runInNewContext(compiled, {
    module: loaded,
    exports: loaded.exports,
    require: (name: string) =>
      name === 'react'
        ? React
        : name === 'react-i18next'
          ? { useTranslation: () => ({ t: (key: string) => key }) }
          : { Alert: 'Alert' },
  })
  const viewer = loaded.exports.withViewerBoundary({ kind: 'markdown', render: () => null })
  const document = {
    documentSessionId: 'document',
    tabId: 'tab',
    path: 'file.md',
    viewKind: 'source',
  }
  const first = viewer.render(document)
  const preview = viewer.render({ ...document, viewKind: 'preview' })
  assert.equal(first.key, preview.key, 'mode is not document identity')
  assert.notEqual(first.key, viewer.render({ ...document, documentSessionId: 'other' }).key)
  const boundary = new loaded.exports.ViewerBoundary(preview.props)
  boundary.state = { failed: true }
  boundary.setState = (state: unknown) => {
    boundary.state = state
  }
  boundary.componentDidUpdate(first.props)
  assert.equal(boundary.state.failed, false)
  boundary.state = { failed: true }
  boundary.componentDidUpdate(preview.props)
  assert.equal(boundary.state.failed, true)
})
