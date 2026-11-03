import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { DESKTOP } from '../resources.mjs'

test('main startup tolerates damaged preferences but reconciliation cannot acknowledge them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scholarseed-i18n-preferences-'))
  const output = join(directory, 'preferences.mjs')
  const file = join(directory, 'renderer-preferences.json')
  const appData = join(directory, 'app-data')
  const previousHome = process.env.SCHOLARSEED_HOME
  try {
    process.env.SCHOLARSEED_HOME = join(directory, 'home')
    await build({
      stdin: { contents: `export * from './src/main/preferences.ts'; export { selectStorage, publishStorage } from './src/main/storage.ts'; export { writerEvents } from './src/main/writer'`, resolveDir: DESKTOP, sourcefile: 'preferences-contract.ts' }, outfile: output,
      bundle: true, platform: 'node', format: 'esm',
      plugins: [{ name: 'isolated-electron-path', setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'contract' }))
        builder.onLoad({ filter: /.*/, namespace: 'contract' }, () => ({ contents: `export const app = {
          getName: () => 'ScholarSeed',
          getPath: (name) => {
            if (name === 'userData') return ${JSON.stringify(directory)}
            if (name === 'appData') return ${JSON.stringify(appData)}
            throw new Error('unexpected Electron path: ' + name)
          },
          getAppPath: () => ${JSON.stringify(DESKTOP)},
          getLocale: () => 'en-US',
          getPreferredSystemLanguages: () => ['en-US']
        }` }))
        builder.onResolve({ filter: /(?:^|\/)writer$/ }, (args) => {
          if (!args.importer.startsWith(join(DESKTOP, 'src', 'main')) && args.path !== './src/main/writer') return
          return { path: 'writer', namespace: 'preference-writer' }
        })
        builder.onLoad({ filter: /.*/, namespace: 'preference-writer' }, () => ({ contents: `
          import assert from 'node:assert/strict';
          export const writerEvents = [];
          export function desktopDirectoryWriter(directory) {
            assert.equal(directory, ${JSON.stringify(directory)});
            writerEvents.push(['acquire', directory]);
            let closed = false;
            return { close() { assert.equal(closed, false); closed = true; writerEvents.push(['release', directory]); } };
          }
        ` }))
      } }]
    })
    const preferences = await import(pathToFileURL(output).href)
    const selected = preferences.selectStorage('contract', { pin() { throw new Error('explicit home must not read pointer') }, readAt() { throw new Error('unexpected read') }, release() { throw new Error('unexpected release') } })
    assert.equal(selected.userData, directory)
    assert.equal(selected.sessionData, join(directory, 'scholarseed-desktop-session-contract'))
    preferences.publishStorage(selected)
    writeFileSync(file, '{invalid')
    const initial = preferences.loadRendererPreferences()
    assert.ok(['zh', 'en'].includes(initial.language))
    await assert.rejects(preferences.reconcileRendererPreferences(), SyntaxError)
    assert.equal(readFileSync(file, 'utf8'), '{invalid', 'reading never overwrites damaged user state')
    assert.deepEqual(preferences.writerEvents, [], 'startup and reconciliation never acquire a writer')

    await assert.rejects(preferences.commitRendererPreferences({ ...initial, language: 'en' }), SyntaxError)
    assert.equal(readFileSync(file, 'utf8'), '{invalid', 'failed saving never overwrites damaged user state')
    unlinkSync(file)
    const saved = await preferences.commitRendererPreferences({ ...initial, language: 'en', theme: 'dark' })
    assert.equal(saved.language, 'en')
    assert.equal(saved.theme, 'dark')
    assert.deepEqual(await preferences.reconcileRendererPreferences(), saved)
    assert.deepEqual(preferences.loadRendererPreferences(), saved)
    assert.deepEqual(preferences.writerEvents, [['acquire', directory], ['release', directory]])
  } finally {
    if (previousHome === undefined) delete process.env.SCHOLARSEED_HOME
    else process.env.SCHOLARSEED_HOME = previousHome
    rmSync(directory, { recursive: true, force: true })
  }
})
