import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { DESKTOP } from './resources.mjs'

test('main startup tolerates damaged preferences but reconciliation cannot acknowledge them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scholarseed-i18n-preferences-'))
  const output = join(directory, 'preferences.mjs')
  const file = join(directory, 'renderer-preferences.json')
  try {
    await build({
      entryPoints: [join(DESKTOP, 'src/main/preferences.ts')], outfile: output,
      bundle: true, platform: 'node', format: 'esm',
      plugins: [{ name: 'isolated-electron-path', setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'contract' }))
        builder.onLoad({ filter: /.*/, namespace: 'contract' }, () => ({ contents: `export const app = { getPath: () => ${JSON.stringify(directory)}, getLocale: () => 'en-US', getPreferredSystemLanguages: () => ['en-US'] }` }))
      } }]
    })
    const preferences = await import(pathToFileURL(output).href)
    writeFileSync(file, '{invalid')
    const initial = preferences.loadRendererPreferences()
    assert.ok(['zh', 'en'].includes(initial.language))
    await assert.rejects(preferences.reconcileRendererPreferences(), SyntaxError)
    assert.equal(readFileSync(file, 'utf8'), '{invalid', 'reading never overwrites damaged user state')
    const saved = await preferences.commitRendererPreferences({ ...initial, language: 'en', theme: 'dark' })
    assert.equal(saved.language, 'en')
    assert.equal(saved.theme, 'dark')
    assert.deepEqual(await preferences.reconcileRendererPreferences(), saved)
    assert.deepEqual(preferences.loadRendererPreferences(), saved)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
