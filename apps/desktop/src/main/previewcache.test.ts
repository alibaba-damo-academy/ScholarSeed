import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import type { discardPreviewPreparation } from './updater.ts'
import { planUpdatePrune, stagedInstallerName } from './staging.ts'

// Exercise the production cleanup against real files, with the application and
// native handoff boundaries controlled. This is not signed installer acceptance.
const source = ts.createSourceFile(
  'updater.ts',
  readFileSync(new URL('./updater.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)
const names = new Set([
  'discardPreviewPreparation',
  'pruneUpdateArtifacts',
  'candidateStateDirectory',
  'updateCacheDir',
  'readyStatePath',
])
const declarations = source.statements.filter(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? '')
)
assert.equal(declarations.length, names.size)
const code = ts.transpileModule(declarations.map((node) => node.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

function setup(t: test.TestContext, preview = true, handoff = false) {
  const root = mkdtempSync(join(tmpdir(), 'preview-cache-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  mkdirSync(stateRoot)
  let cleared = 0
  const exports = {} as {
    cache: () => string
    state: () => string
    ready: () => string
    discardPreviewPreparation: typeof discardPreviewPreparation
  }
  runInNewContext(
    code +
      '\nexports.cache = updateCacheDir; exports.state = candidateStateDirectory; exports.ready = readyStatePath;',
    {
      exports,
      join,
      readdirSync,
      rmSync,
      rmdirSync,
      mkdirSync,
      planUpdatePrune,
      previewUpdatesEnabled: () => preview,
      macHandoffCommitted: () => handoff,
      validatedPreviewCandidates: new Map(),
      updateStateDirectory: () => stateRoot,
      systemCacheDir: () => join(root, 'cache'),
      UPDATE_CACHE_DIRNAME: 'scholarseed-update',
      PREVIEW_CANDIDATE_DIRNAME: 'preview',
      READY_STATE_FILE: 'ready.json',
      desktopDirectoryWriter: () => ({ close() {} }),
      PREPARATION_STATE_FILE: 'preparation.json',
      readReadyState: () => null,
      clearReadyState: () => {
        cleared++
      },
    }
  )
  const cache = exports.cache(),
    state = exports.state()
  mkdirSync(state, { recursive: true })
  const partial = join(cache, stagedInstallerName('0.3.0', '202610200001', 'darwin'))
  writeFileSync(partial, 'unfinished download')
  writeFileSync(join(cache, 'user-notes.txt'), 'keep')
  writeFileSync(join(cache, 'install-owned.sh'), 'keep')
  writeFileSync(join(state, 'preparation.json'), '{}')
  return {
    root,
    cache,
    state,
    partial,
    ready: exports.ready(),
    cleared: () => cleared,
    discard: () => exports.discardPreviewPreparation(() => {}),
  }
}

test('preview cancellation removes partial payload without ready state and preserves unrelated files', (t) => {
  const h = setup(t)
  h.discard()
  assert.equal(existsSync(h.partial), false)
  assert.equal(existsSync(join(h.state, 'preparation.json')), false)
  assert.equal(readFileSync(join(h.cache, 'user-notes.txt'), 'utf8'), 'keep')
  assert.equal(existsSync(join(h.cache, 'install-owned.sh')), true)
})

test('release cleanup is unchanged and committed handoff cannot be revoked', (t) => {
  const release = setup(t, false)
  release.discard()
  assert.equal(existsSync(release.partial), true)
  assert.equal(existsSync(join(release.state, 'preparation.json')), true)
  assert.equal(release.cleared(), 0)
  const committed = setup(t, true, true)
  assert.throws(committed.discard, /handoff/)
  assert.equal(existsSync(committed.partial), true)
})

test('preview payload cleanup preserves the existing active-mount protection', (t) => {
  const h = setup(t)
  mkdirSync(join(h.cache, 'mount-active'))
  writeFileSync(join(h.cache, 'mount-active', 'in-use'), 'keep')
  h.discard()
  assert.equal(existsSync(h.partial), true)
})

test('preview paths cannot clear same-version release payloads, records or recovery journals', (t) => {
  const h = setup(t)
  const releaseCache = join(h.root, 'cache', 'scholarseed-update')
  const releaseState = join(h.root, 'state')
  const shared = [
    join(releaseCache, stagedInstallerName('0.3.0', '202610200001', 'darwin')),
    join(releaseState, 'ready.json'),
    join(releaseState, 'preparation.json'),
    join(releaseState, 'squirrel.json'),
  ]
  for (const path of shared) writeFileSync(path, 'release-or-legacy')
  assert.equal(h.cache, join(releaseCache, 'preview'))
  assert.equal(h.state, join(releaseState, 'preview'))
  assert.equal(h.ready, join(h.state, 'ready.json'))
  h.discard()
  for (const path of shared) assert.equal(readFileSync(path, 'utf8'), 'release-or-legacy')
  const release = setup(t, false)
  assert.equal(release.cache, join(release.root, 'cache', 'scholarseed-update'))
  assert.equal(release.state, join(release.root, 'state'))
  assert.equal(release.ready, join(release.state, 'ready.json'))
})
