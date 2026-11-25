import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import type test from 'node:test'
import ts from 'typescript'
import type { discardPreviewPreparation } from './updater.ts'
import { reclaimMacComponentCache, type MacCacheNative } from './maccomponentcache.ts'
import { planUpdatePrune, stagedInstallerName, updateArtifactKind } from './staging.ts'

// Exercise the production cleanup against real files, with the application and
// native handoff boundaries controlled. This is not signed installer acceptance.
const source = ts.createSourceFile(
  'updater.ts',
  readFileSync(new URL('./updater.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)
export function updaterFunctions(names: string[]): string {
  const declarations = source.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? '')
  )
  assert.equal(declarations.length, names.length)
  return ts.transpileModule(declarations.map((node) => node.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
}

const code = updaterFunctions([
  'discardPreviewPreparation',
  'pruneUpdateArtifacts',
  'candidateStateDirectory',
  'updateCacheDir',
  'updateCacheRoot',
  'updateProfileKey',
  'pruneInactiveMacCache',
  'inactiveMacCache',
  'ensureMacUpdateSpace',
  'readyStatePath',
])

export function setupPreviewCache(
  t: test.TestContext,
  preview = true,
  handoff = false,
  profile = 'primary',
  base?: string,
  native?: MacCacheNative
) {
  const root = base ?? realpathSync(mkdtempSync(join(tmpdir(), 'preview-cache-')))
  if (!base) t.after(() => rmSync(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  mkdirSync(stateRoot, { recursive: true })
  let cleared = 0
  const exports = {} as {
    cache: () => string
    cacheRoot: () => string
    pruneInactive: () => Promise<void>
    ensureSpace: (check: () => void) => Promise<void>
    state: () => string
    ready: () => string
    discardPreviewPreparation: typeof discardPreviewPreparation
  }
  runInNewContext(
    code +
      '\nexports.cache = updateCacheDir; exports.cacheRoot = updateCacheRoot; exports.pruneInactive = () => pruneInactiveMacCache(() => {}); exports.ensureSpace = (check) => ensureMacUpdateSpace(join(updateCacheDir(), "update.zip"), check); exports.state = candidateStateDirectory; exports.ready = readyStatePath;',
    {
      exports,
      AbortController,
      dirname,
      join,
      createHash,
      process: { platform: 'darwin' },
      MACOS_PLATFORM: 'darwin',
      desktopStorage: () => ({ home: stateRoot, userData: join(root, profile) }),
      UPDATE_CACHE_PROFILE_DIRNAME: 'profiles',
      INACTIVE_UPDATE_CACHE_RETENTION_MS: 7 * 24 * 60 * 60_000,
      updateArtifactKind,
      lstatSync,
      statSync,
      reclaimMacComponentCache,
      desktopDirectoryNative: () => {
        assert.ok(native, 'this scenario requires the native component cache fixture')
        return native
      },
      realpathSync,
      existsSync,
      removeUpdateArtifact: async (path: string) => rmSync(path, { recursive: true, force: true }),
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
    cacheRoot: exports.cacheRoot(),
    cache,
    state,
    partial,
    ready: exports.ready(),
    cleared: () => cleared,
    discard: () => exports.discardPreviewPreparation(() => {}),
    pruneInactive: exports.pruneInactive,
    ensureSpace: exports.ensureSpace,
  }
}
