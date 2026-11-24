import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { zipSync } from 'fflate'
import { assertSquirrelArchiveSize, UpdateArchiveLimitError } from './archive.ts'
import { assertDownloadSpace, downloadWithProgress } from './download.ts'
import { PreparedArchive, PublishedZipDigestMismatch } from './prepared.ts'
import { samePreviewArtifact } from './preview.ts'
import { planUpdatePrune, stagedInstallerName, updateArtifactKind } from './staging.ts'
import { InstallationProgress } from './installation.ts'
import {
  abandonedSquirrelRequest,
  decodeSquirrelHandoff,
  readSquirrelHandoff,
  SquirrelSourceVerificationRetry,
  type SquirrelHandoff,
} from './squirrel.ts'
import {
  commitWithActivation,
  ActivationCandidateChanged,
  ActivationExpired,
} from './update-authorization.ts'
import { retryUpdate, UpdateTransportError } from './retry.ts'
import { basename, dirname, join, resolve } from 'node:path'
import { SuccessorUpdater } from './successor.ts'
import { readRecord, writeJson } from './journal.ts'
import { MACOS_UPDATE_ZIP } from '../updates.ts'

const source = readFileSync(new URL('./updater.ts', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('updater.ts', source, ts.ScriptTarget.Latest, true)
function updaterFunctions(names: string[]): string {
  return ts.transpileModule(
    parsed.statements
      .filter(
        (statement) =>
          ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text ?? '')
      )
      .map((statement) => statement.getText(parsed))
      .join('\n'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText
}

test('successor rejects feed headers and releases a failed native disposal only once', () => {
  let disposals = 0
  const updater = new SuccessorUpdater(
    {
      prepareSuccessor: () => 42,
      installSuccessor: () => assert.fail('detached handle cannot install'),
      disposeSuccessor: (handle) => {
        assert.equal(handle, 42)
        disposals++
        throw new Error('native release failed')
      },
    },
    true
  )
  assert.throws(() => updater.setFeedURL({ url: 'local', headers: {} }), /headers/)
  assert.throws(() => updater.checkForUpdates(), /unavailable/)
  updater.setFeedURL({ url: 'local' })
  updater.checkForUpdates()
  assert.throws(() => updater.dispose(), /native release failed/)
  updater.dispose()
  assert.equal(disposals, 1)
  assert.throws(() => updater.quitAndInstall(), /unavailable/)
})

test('successor consumes only a successful install and keeps its handle for disposal', () => {
  const installations: number[] = []
  const disposed: number[] = []
  let complete!: (error: string | null) => void
  const port = new SuccessorUpdater(
    {
      prepareSuccessor(_url, _alternate, callback) {
        complete = callback
        return 19
      },
      installSuccessor(handle) {
        installations.push(handle)
        if (installations.length === 1) throw new Error('grant refused')
        assert.throws(() => port.quitAndInstall(), /Successor installation unavailable/)
      },
      disposeSuccessor(handle) {
        disposed.push(handle)
      },
    },
    false
  )
  let downloaded = 0
  port.on('update-downloaded', () => downloaded++)
  port.setFeedURL({ url: 'local' })
  port.checkForUpdates()
  complete(null)
  assert.equal(downloaded, 1)
  assert.throws(() => port.quitAndInstall(), /grant refused/)
  port.quitAndInstall()
  assert.throws(() => port.quitAndInstall(), /Successor installation unavailable/)
  assert.throws(() => port.checkForUpdates(), /Successor preparation unavailable/)
  complete(null)
  assert.equal(downloaded, 1)
  port.dispose()
  port.dispose()
  assert.deepEqual(installations, [19, 19])
  assert.deepEqual(disposed, [19])
})

test('a successor only replaces the selected slot after its native receipt and an uncontested commit', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'update-successor-retirement-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const outcome of [
    'promoted',
    'zip-promoted',
    'zip-verification-failed',
    'zip-clicked',
    'rotated',
    'download-failed',
    'native-failed',
    'missing-copy',
    'clicked',
    'changed-on-disk',
    'cancelled-after-staging',
    'write-failed',
    'write-refused',
    'another-ready-record',
    'publication-uncertain',
    'standby-references-D',
    'active-references-D',
    'different-publisher',
    'changed-ZIP',
    'missing-archive-before-cleanup',
    'missing-archive-during-cleanup',
    'release-failed',
    'invalid-sidecar',
  ] as const) {
    const alternate = outcome === 'rotated'
    const cache = join(root, outcome)
    mkdirSync(cache)
    const zip = outcome.startsWith('zip-')
    const installer = ({ id }: { id: string }) => join(cache, id + (zip ? '.zip' : '.dmg'))
    const workspace = (meta: { id: string }) => installer(meta) + '.prepared'
    const readyPath = (slot: boolean) => join(cache, slot ? 'ready.next.json' : 'ready.json')
    const release = (id: string, build_number: string) => {
      const meta = {
        id,
        version: '1',
        build_number,
        ...(zip ? { artifact_kind: MACOS_UPDATE_ZIP } : {}),
      }
      return {
        meta,
        path: installer(meta),
        archive: { path: zip ? installer(meta) : join(workspace(meta), 'application.zip') },
      }
    }
    const current = release('B', '2')
    const next = release('D', '4')
    for (const item of outcome === 'download-failed' ? [current] : [current, next]) {
      writeFileSync(item.path, item.meta.id)
      mkdirSync(workspace(item.meta))
      writeFileSync(item.archive.path, item.meta.id)
    }
    writeJson(readyPath(alternate), current)
    const other = release('A', '1')
    if (outcome === 'write-refused') writeJson(readyPath(!alternate), other)
    if (outcome === 'standby-references-D') writeJson(readyPath(!alternate), next)
    const previous = {
      candidate: 'B',
      state: 'downloaded',
      sourcePid: process.pid,
      ...(alternate ? { alternate } : {}),
    }
    let canonical: { candidate: string; state: string; sourcePid: number; alternate?: boolean } =
      previous
    const events: string[] = []
    const controller = new AbortController()
    const active = {
      detach() {
        events.push('detach B')
      },
    }
    const prepared = {
      workspace: workspace(next.meta),
      receipt: { matches: () => true, archive: next.archive },
    }
    const pending = {
      async prepare(
        archive: unknown,
        identity: { alternate?: true },
        authorize: Function,
        _interaction: boolean,
        _replacement: unknown,
        verifySource?: (source: string) => Promise<void>
      ) {
        assert.equal(archive, next.archive)
        assert.equal(!!identity.alternate, !alternate)
        const grant = await authorize()
        grant()
        events.push('native checked')
        assert.equal(!!verifySource, zip)
        if (verifySource) await verifySource('/native/standby')
        const sidecar = join(prepared.workspace, 'squirrel.pending.json')
        if (outcome === 'native-failed' || outcome === 'different-publisher') {
          writeJson(sidecar, {
            candidate: 'D',
            state: 'requested',
            version: '1',
            buildNumber: '4',
            at: 1,
            sourcePid: outcome === 'native-failed' ? process.pid : process.pid + 1,
          })
          writeFileSync(join(prepared.workspace, 'squirrel-handoff.lock'), '')
        }
        if (outcome === 'invalid-sidecar') writeFileSync(sidecar, '{')
        if (outcome === 'active-references-D') writeJson(readyPath(alternate), next)
        if (outcome === 'changed-ZIP') writeFileSync(next.archive.path, 'another ZIP')
        if (outcome === 'missing-archive-before-cleanup') rmSync(next.archive.path)
        if (
          [
            'native-failed',
            'standby-references-D',
            'active-references-D',
            'different-publisher',
            'changed-ZIP',
            'missing-archive-before-cleanup',
            'missing-archive-during-cleanup',
            'release-failed',
            'invalid-sidecar',
          ].includes(outcome)
        )
          throw new Error('refused')
        if (outcome === 'clicked' || outcome === 'zip-clicked') controller.abort()
      },
      matches: () => true,
      preparedCandidate: () => (outcome === 'missing-copy' ? undefined : { device: 1 }),
      promoteTo(path: string, _mutation: unknown, prior: unknown, guard: Function) {
        assert.equal(path, '/canonical')
        assert.equal(previous, prior)
        if (outcome === 'changed-on-disk') throw new Error('different request')
        guard()
        canonical = { ...previous, candidate: 'D', alternate: !alternate }
        if (outcome === 'publication-uncertain') throw new Error('unconfirmed after write')
        events.push('commit')
      },
      detach() {
        events.push('detach D')
      },
    }
    const exports: Record<string, Function> = {}
    const environment = {
      exports,
      squirrel: active,
      macPrepared: {},
      successorPreparing: false,
      activeReadyAlternate: alternate,
      activeSuccessorUpdater: undefined,
      canPrepareMacUpdateWithoutInteraction: () => true,
      macPreparationReady: () => true,
      isNewerRelease: () => true,
      squirrelHandoffPath: () => '/canonical',
      readSquirrelHandoff: (path: string) =>
        path === '/canonical' ? canonical : readSquirrelHandoff(path),
      readReadyState: () => current,
      macLaunchObserver: {
        prepareSuccessor: () => 11,
        disposeSuccessor: () => {
          if (outcome === 'release-failed') throw new Error('unknown handle')
        },
      },
      SuccessorUpdater,
      InstallationProgress,
      join,
      stageUpdate: async (
        candidate: unknown,
        _progress: unknown,
        _log: unknown,
        _signal: unknown,
        retained: unknown
      ) => {
        assert.equal(retained, current)
        assert.equal(candidate, next.meta)
        if (outcome === 'cancelled-after-staging') controller.abort()
        return outcome === 'download-failed' ? { ok: false } : { ok: true, ready: next, prepared }
      },
      revalidateMacArchive: async () => next.archive,
      MACOS_UPDATE_ZIP,
      SquirrelSourceVerificationRetry,
      resolveDesktopConfig: () => ({}),
      verifyUpdateApplication: async (source: string, meta: unknown) => {
        assert.equal(source, '/native/standby')
        assert.equal(meta, next.meta)
        events.push('verified standby ZIP')
        if (outcome === 'zip-verification-failed') throw new Error('Invalid publisher')
      },
      assertSquirrelPreparationSpace() {},
      newMacInstallation: (port: SuccessorUpdater) => {
        port.setFeedURL({ url: 'local' })
        port.checkForUpdates()
        return pending
      },
      SUCCESSOR_HANDOFF_FILE: 'squirrel.pending.json',
      authorizeActivation: async () => () => {},
      retryUpdate,
      squirrelPreparedDevice: (copy?: { device: number }) => copy?.device,
      mutateMacRecord: () => (operation: () => void) => operation(),
      stagedInstallerPath: installer,
      preparedApplicationDirectory: workspace,
      readyStatePath: readyPath,
      removeStaleInstaller: (path: string) => {
        if (outcome === 'missing-archive-during-cleanup') rmSync(next.archive.path)
        rmSync(path)
      },
      rmSync,
      rmdirSync,
      existsSync,
      lstatSync,
      process,
      SQUIRREL_HANDOFF_LOCK: 'squirrel-handoff.lock',
      Buffer,
      readRecord,
      READY_STATE_LIMIT: 64 * 1024,
      writeReadyState(ready: typeof current, nextSlot: boolean) {
        assert.equal(nextSlot, !alternate)
        if (outcome === 'write-refused') throw new Error('could not write standby')
        writeJson(readyPath(nextSlot), ready)
        if (outcome === 'another-ready-record') {
          writeJson(readyPath(nextSlot), { ...ready, at: 99 })
          throw new Error('standby changed')
        }
        if (outcome === 'write-failed') throw new Error('standby flush failed')
      },
      logUpdateEvent() {},
      logUpdateLine() {},
      UpdateVerifyError: class extends Error {},
      UpdateArchiveLimitError: class extends Error {},
    }
    runInNewContext(
      updaterFunctions([
        'prepareMacSuccessor',
        'captureSuccessorFiles',
        'macZipSourceVerifier',
        'discardUnselectedSuccessor',
      ]),
      environment
    )
    const result = await exports.prepareMacSuccessor(
      next.meta,
      () => {},
      () => {},
      controller.signal,
      () => !controller.signal.aborted
    )
    const selected = outcome === 'promoted' || outcome === 'rotated' || outcome === 'zip-promoted'
    assert.equal(events.includes('verified standby ZIP'), zip)
    assert.equal(result.ok, selected, outcome)
    assert.deepEqual(
      JSON.parse(readFileSync(readyPath(environment.activeReadyAlternate), 'utf8')),
      selected || outcome === 'active-references-D' ? next : current,
      outcome
    )
    assert.equal(environment.squirrel, selected ? pending : active, outcome)
    assert.equal(events.includes('detach B'), selected, outcome)
    assert.equal(environment.successorPreparing, false, outcome)
    const keepNext =
      selected ||
      [
        'publication-uncertain',
        'another-ready-record',
        'standby-references-D',
        'active-references-D',
        'different-publisher',
        'changed-ZIP',
        'release-failed',
        'invalid-sidecar',
      ].includes(outcome)
    for (const path of [next.path, next.archive.path])
      assert.equal(existsSync(path), keepNext, outcome)
    if (outcome === 'native-failed') {
      assert.deepEqual(readdirSync(prepared.workspace).sort(), [
        'squirrel-handoff.lock',
        'squirrel.pending.json',
      ])
    } else assert.equal(existsSync(prepared.workspace), keepNext, outcome)
    assert.equal(
      existsSync(readyPath(!alternate)),
      selected ||
        [
          'publication-uncertain',
          'another-ready-record',
          'standby-references-D',
          'write-refused',
        ].includes(outcome),
      outcome
    )
    if (outcome === 'write-refused')
      assert.deepEqual(JSON.parse(readFileSync(readyPath(!alternate), 'utf8')), other)
    for (const path of [current.path, current.archive.path, readyPath(alternate)])
      assert.ok(existsSync(path), outcome)
  }
})

test('cold-start selection follows the canonical handoff across a staged but uncommitted promotion', (t) => {
  const cache = mkdtempSync(join(tmpdir(), 'update-slots-'))
  t.after(() => rmSync(cache, { recursive: true, force: true }))
  let alternate = false
  const exports: Record<string, Function> = {}
  const path = (meta: { id: string; artifact_kind?: string }) =>
    join(cache, meta.id + (meta.artifact_kind === MACOS_UPDATE_ZIP ? '.zip' : '.dmg'))
  const directory = (meta: { id: string }) => path(meta) + '.prepared'
  runInNewContext(
    updaterFunctions([
      'readReadyState',
      'readyStatePath',
      'selectedReadyAlternate',
      'writeReadyState',
    ]) + '\nexports.writeReadyState = writeReadyState',
    {
      exports,
      join,
      writeJson,
      MACOS_UPDATE_ZIP,
      MACOS_PLATFORM: 'darwin',
      process: { platform: 'darwin' },
      activeReadyAlternate: undefined,
      squirrelHandoffPath: () => '/canonical',
      readSquirrelHandoff: () => (alternate ? { alternate } : {}),
      READY_STATE_FILE: 'ready.json',
      ALTERNATE_READY_STATE_FILE: 'ready.next.json',
      candidateStateDirectory: () => cache,
      readRejectedUpdate: () => null,
      stagedInstallerPath: path,
      preparedApplicationDirectory: directory,
      readFileSync,
      existsSync,
      statSync,
    }
  )
  for (const id of ['B', 'D']) {
    const meta = {
      id,
      sha512: '0'.repeat(128),
      file_size: 1,
      ...(id === 'D' ? { artifact_kind: MACOS_UPDATE_ZIP } : {}),
    }
    const archive = {
      path: id === 'D' ? path(meta) : join(directory(meta), 'application.zip'),
      size: 1,
      sha512: meta.sha512,
    }
    mkdirSync(directory(meta))
    writeFileSync(archive.path, id)
    writeFileSync(path(meta), id)
    exports.writeReadyState({ meta, archive, path: path(meta) }, id === 'D')
  }
  assert.equal(exports.readReadyState().meta.id, 'B')
  alternate = true
  assert.equal(exports.readReadyState().meta.id, 'D')
})

test('a failed successor download preserves the active DMG and ZIP through cache cleanup', async (t) => {
  const cache = mkdtempSync(join(tmpdir(), 'update-successor-'))
  t.after(() => rmSync(cache, { recursive: true, force: true }))
  const dmg = (meta: { id: string }) => join(cache, `scholarseed-${meta.id}.dmg`)
  const directory = (meta: { id: string }) => dmg(meta) + '.prepared'
  const b = { id: 'B' },
    d = { id: 'D', file_size: 1, sha512: 'verified' }
  const retained = { meta: b, path: dmg(b) }
  for (const meta of [b, { id: 'obsolete' }]) {
    mkdirSync(directory(meta))
    writeFileSync(dmg(meta), meta.id)
    writeFileSync(join(directory(meta), 'application.zip'), meta.id)
  }
  const exports: Record<string, Function> = {}
  const noop = () => {}
  runInNewContext(
    updaterFunctions(['stageUpdate', 'pruneUpdateArtifacts', 'discardPreparedApplications']),
    {
      exports,
      MACOS_PLATFORM: 'darwin',
      process: { platform: 'darwin' },
      macPrepared: {},
      macArchiveReady: () => false,
      MACOS_UPDATE_ZIP,
      samePreviewArtifact,
      macHandoffCommitted: () => true,
      readReadyState: () => retained,
      macPreparationReady: (meta: unknown) => meta === b,
      getDownloadInfo: async () => d,
      preparedIdentity: (meta: { id: string }) => meta.id,
      updateCacheDir: () => cache,
      stagedInstallerPath: dmg,
      preparedApplicationDirectory: directory,
      removeUpdateArtifact: async (path: string) => rmSync(path, { recursive: true }),
      join,
      basename,
      readdirSync,
      rmSync,
      rmdirSync,
      planUpdatePrune,
      updateArtifactKind,
      pruneInactiveMacCache: noop,
      logUpdateEvent: noop,
      assertDownloadSpace: noop,
      logTiming: noop,
      retryUpdate,
      downloadWithProgress: async (_url: unknown, destination: string) =>
        writeFileSync(destination, 'D'),
      sha512OfFile: async () => 'damaged',
      downloadResumable: () => false,
    }
  )
  const result = await exports.stageUpdate(d, noop, noop, new AbortController().signal, retained)
  assert.equal(result.ok, false)
  assert.match(result.error, /SHA-512/)
  assert.equal(readFileSync(dmg(b), 'utf8'), 'B')
  assert.equal(readFileSync(join(directory(b), 'application.zip'), 'utf8'), 'B')
  assert.equal(existsSync(dmg(d)), false)
  assert.equal(existsSync(directory({ id: 'obsolete' })), false)
})

test(
  'ZIP staging discards corrupt bytes and hashes the corrected download exactly once',
  {
    skip: process.platform !== 'darwin',
  },
  async (t) => {
    const cache = mkdtempSync(join(tmpdir(), 'zip-stage-'))
    t.after(() => rmSync(cache, { recursive: true, force: true }))
    const bytes = Buffer.from(
      zipSync(
        {
          'ScholarSeed.app/': new Uint8Array(),
          'ScholarSeed.app/Contents/Info.plist': Buffer.from('fixture'),
        },
        { level: 0 }
      )
    )
    const candidate = {
      id: 'zip',
      artifact_kind: MACOS_UPDATE_ZIP,
      file_size: bytes.length,
      version: '0.3.2',
      build_number: '202611240001',
      sha512: crypto.createHash('sha512').update(bytes).digest('hex'),
    }
    const path = join(
      cache,
      stagedInstallerName(candidate.version, candidate.build_number, 'darwin', true)
    )
    const damaged = Buffer.from(bytes)
    damaged[0] ^= 1
    let selected = candidate
    let publications = 0
    // A complete cached file is reused by the downloader until verification removes it.
    writeFileSync(path, damaged)
    const hashes = t.mock.method(crypto, 'createHash')
    syncBuiltinESMExports()
    t.after(() => {
      hashes.mock.restore()
      syncBuiltinESMExports()
    })
    const stage = runInNewContext(
      updaterFunctions([
        'stageUpdate',
        'downloadResumable',
        'sha512OfFile',
        'removeStaleInstaller',
      ]) + '\nstageUpdate',
      {
        PreparedArchive,
        PublishedZipDigestMismatch,
        exports: {},
        process,
        MACOS_PLATFORM: 'darwin',
        MACOS_UPDATE_ZIP,
        macPrepared: null,
        activeReadyAlternate: undefined,
        readReadyState: () => null,
        macHandoffCommitted: () => false,
        getDownloadInfo: (
          id: string,
          _log: unknown,
          _signal: unknown,
          expected: typeof candidate
        ) => {
          assert.equal(id, selected.id)
          assert.equal(expected, selected)
          return {
            ...selected,
            download_url: `data:application/zip;base64,${bytes.toString('base64')}`,
          }
        },
        samePreviewArtifact,
        assertSquirrelArchiveSize,
        UpdateArchiveLimitError,
        UpdateVerifyError: class extends Error {},
        stagedInstallerPath: () => path,
        preparedApplicationDirectory: () => path + '.prepared',
        basename,
        dirname,
        updateCacheDir: () => cache,
        updateArtifactKind,
        mkdirSync,
        rmSync,
        statSync,
        existsSync,
        removeUpdateArtifact: (workspace: string) =>
          rmSync(workspace, { recursive: true, force: true }),
        discardPreparedApplications() {},
        pruneInactiveMacCache() {},
        pruneUpdateArtifacts() {},
        assertDownloadSpace,
        retryUpdate,
        downloadWithProgress,
        createHash: hashes,
        createReadStream,
        InstallationProgress,
        writeReadyState() {
          publications++
        },
        persistUpdateLog() {},
        logUpdateEvent() {},
        logTiming() {},
      }
    )
    const corrupt = await stage(
      candidate,
      () => {},
      () => {}
    )
    assert.equal(corrupt.errorOrigin, 'download')
    assert.equal(corrupt.resumable, false)
    assert.equal(existsSync(path), false)
    hashes.mock.resetCalls()
    const fresh = await stage(
      candidate,
      () => {},
      () => {}
    )
    assert.equal(fresh.ok, true, fresh.error)
    assert.equal(fresh.ready.archive.sha512, candidate.sha512)
    assert.deepEqual(readFileSync(path), bytes)
    assert.equal(
      hashes.mock.calls.filter(({ arguments: [algorithm] }) => algorithm === 'sha512').length,
      1
    )

    const retained = { meta: { id: 'previous' }, path: join(cache, 'previous.zip') }
    writeFileSync(retained.path, 'previous')
    const standby = await stage(
      candidate,
      () => {},
      () => {},
      undefined,
      retained
    )
    assert.equal(standby.ok, true, standby.error)
    assert.equal(standby.ready.archive.path, path)
    assert.deepEqual(readdirSync(standby.prepared.workspace), [])
    assert.equal(publications, 1)
    assert.equal(readFileSync(retained.path, 'utf8'), 'previous')

    writeFileSync(path, damaged)
    selected = { ...candidate, sha512: crypto.createHash('sha512').update(damaged).digest('hex') }
    const malformed = await stage(
      selected,
      () => {},
      () => {}
    )
    assert.equal(malformed.errorOrigin, 'preparation')
    assert.match(malformed.error, /ZIP structure/)
  }
)

function fixture(
  failHelper = false,
  failFinalGrant = false,
  writable = true,
  zip: boolean | ((installation: InstallationProgress) => Promise<void>) = false
) {
  const events: string[] = []
  const nativeSpaceChecks: boolean[] = []
  let ready = false
  let committed = false
  const handoff: { current?: SquirrelHandoff } = {}
  const controller = new AbortController()
  const exports: Record<string, Function> = {}
  const prepared = {
    receipt: {
      get archive() {
        return staged.archive
      },
      matches: () => true,
      revalidate: async () => {
        events.push('revalidate')
        return staged.archive
      },
    },
  }
  let grants = 0
  let pendingVerification = false
  const authorize = async () => {
    events.push('grant')
    if (++grants === 2 && failFinalGrant) throw new Error('offline')
    return () => events.push('grant-guard')
  }
  const owner = {
    preparedCandidate: () => undefined,
    matches: (
      _archive: unknown,
      identity: { candidate: string; buildNumber: string; version: string }
    ) =>
      ready &&
      identity.candidate === staged.meta.id &&
      identity.buildNumber === staged.meta.build_number &&
      identity.version === staged.meta.version,
    get committed() {
      return committed
    },
    get ready() {
      return ready
    },
    dispose: () => {},
    canRetrySourceVerification: () => pendingVerification,
    prepare: async (
      _archive: unknown,
      _identity: unknown,
      authorize: Function,
      allowInteraction: boolean,
      mayReplace?: (current: SquirrelHandoff) => boolean,
      verifySource?: (source: string) => Promise<void>
    ) => {
      if (ready) return
      if (!committed) {
        events.push('helper')
        const guard = await authorize()
        if (handoff.current && (!allowInteraction || !mayReplace?.(handoff.current)))
          throw new Error('handoff exists')
        guard()
        committed = true
      }
      if (failHelper) throw new Error('native refused')
      try {
        await verifySource?.('/native/unpacked')
      } catch (error) {
        pendingVerification = error instanceof SquirrelSourceVerificationRetry
        throw error
      }
      pendingVerification = false
      ready = true
      events.push('ready')
    },
  }
  const staged = {
    meta: {
      id: 'candidate',
      version: '0.3.1',
      build_number: '202611100001',
      ...(zip ? { artifact_kind: MACOS_UPDATE_ZIP } : {}),
    },
    archive: {},
  }
  const progress: { phase: string; installation?: { step: string } }[] = []
  class UpdateVerifyError extends Error {
    readonly kind = 'notarization-indeterminate'
  }
  let checks = 0
  const environment = {
    exports,
    process: { platform: 'darwin' },
    MACOS_PLATFORM: 'darwin',
    MACOS_UPDATE_ZIP,
    NO_STAGED_UPDATE: 'No staged update',
    InstallationProgress,
    commitWithActivation,
    retryUpdate,
    assertSquirrelPreparationSpace: () => {
      nativeSpaceChecks.push(false)
      if (failFinalGrant && ready) throw new Error('ENOSPC')
    },
    assertSquirrelInstallSpace: () => nativeSpaceChecks.push(true),
    readReadyState: () => staged,
    preparedIdentity: (meta: { id: string }) => meta.id,
    authorizeActivation: authorize,
    canPrepareMacUpdateWithoutInteraction: () => writable,
    app: { getVersion: () => '0.3.1' },
    Date,
    macPrepared: prepared,
    squirrel: owner,
    macLaunchCleanup: undefined,
    macHandoffCommitted: () => committed,
    macHandoffReady: () => ready,
    logTiming: () => {},
    logUpdateLine: () => {},
    logUpdateEvent: () => {},
    persistUpdateLog: () => {},
    updateLog: undefined,
    discardOnTerminalSquirrelFailure: () => {},
    ActivationCandidateChanged,
    PreparedArtifactChangedError: class extends Error {},
    UpdateVerifyError,
    SquirrelSourceVerificationRetry,
    resolveDesktopConfig: () => ({}),
    verifyUpdateApplication: async (
      source: string,
      _meta: unknown,
      _config: unknown,
      _log: unknown,
      installation: InstallationProgress
    ) => {
      assert.equal(source, '/native/unpacked')
      events.push('verify-zip')
      if (typeof zip === 'function') return zip(installation)
      if (++checks === 1) throw new UpdateVerifyError('notarization timed out')
    },
    UpdateArchiveLimitError: class extends Error {},
  }
  runInNewContext(
    updaterFunctions([
      'prepareMacUpdate',
      'macHandoffReplacement',
      'macZipSourceVerifier',
      'revalidateMacArchive',
      'installStagedUpdate',
      'macArchiveReady',
      'macPreparationReady',
      'macNativePreparationMatches',
    ]),
    environment
  )
  const prepare = (allowInteraction = false, startup?: unknown, signal = controller.signal) =>
    exports.prepareMacUpdate(
      staged.meta.id,
      (value: (typeof progress)[number]) => progress.push(value),
      () => {},
      signal,
      startup,
      allowInteraction
    )
  const install = () =>
    exports.installStagedUpdate(
      (value: (typeof progress)[number]) => progress.push(value),
      () => {},
      undefined,
      authorize,
      async () => {
        assert.equal(ready, true)
        events.push('quiesce-and-context')
        return () => events.push('discard-context')
      }
    )
  return { prepare, install, events, progress, nativeSpaceChecks, handoff, environment }
}

test('preparation retries a restored installation only with a manual request and current failure evidence', async () => {
  const prior: SquirrelHandoff = {
    version: '0.3.1',
    buildNumber: '202611100001',
    candidate: 'candidate',
    state: 'installing',
    at: 1,
  }
  const evidence = { home: '/home', record: { bytes: Buffer.from(JSON.stringify(prior)) } }
  for (const [outcome, expectedChecks] of [
    ['restored', ['inspect', 'recheck']],
    ['background', []],
    ['wrong-home', ['inspect']],
    ['withdrawn', ['inspect', 'recheck']],
    ['record-changed', ['inspect']],
  ] as const) {
    const current = fixture()
    current.handoff.current = prior
    const inspected: string[] = []
    let nativeProof = true
    let recordMatches = true
    const grant = current.environment.authorizeActivation
    Object.assign(current.environment, {
      process: {
        platform: 'darwin',
        execPath: '/App.app/Contents/MacOS/ScholarSeed',
        getuid: () => 501,
      },
      decodeSquirrelHandoff,
      abandonedSquirrelRequest,
      dirname,
      resolve,
      realpathSync: (path: string) => path,
      systemCacheDir: () => '/cache',
      resolveDesktopConfig: () => ({ bundleId: 'fixture.bundle' }),
      desktopHome: () => '/home',
      squirrelHandoffPath: () => '/home/updates/squirrel.json',
      TERMINAL_RECORD_LIMITS: { handoff: 4096 },
      inspectRestoredSquirrelInstallation: async (
        cache: string,
        bundle: string,
        app: string,
        captured: SquirrelHandoff
      ) => {
        assert.deepEqual(
          [cache, bundle, app, captured],
          ['/cache', 'fixture.bundle', '/App.app', prior]
        )
        inspected.push('inspect')
        return () => {
          inspected.push('recheck')
          return nativeProof
        }
      },
      sameRecord: (_path: string, record: unknown) => record === evidence.record && recordMatches,
      authorizeActivation: async () => {
        if (outcome === 'withdrawn') nativeProof = false
        if (outcome === 'record-changed') recordMatches = false
        return grant()
      },
    })
    const startup = {
      admission: 'failed',
      evidence: { ...evidence, home: outcome === 'wrong-home' ? '/other' : evidence.home },
    }
    const result = await current.prepare(outcome !== 'background', startup)
    assert.equal(result.ok, outcome === 'restored', `${outcome}: ${result.error ?? ''}`)
    assert.equal(current.events.includes('grant'), true, outcome)
    assert.equal(current.events.includes('ready'), outcome === 'restored', outcome)
    assert.deepEqual(inspected, expectedChecks, outcome)
  }
})

test('background preparation proves native readiness before activation can quiesce writers', async () => {
  const current = fixture()
  assert.equal((await current.install()).ok, false)
  assert.deepEqual(current.events, [])
  assert.equal((await current.prepare()).ok, true)
  assert.deepEqual(current.events, ['revalidate', 'helper', 'grant', 'grant-guard', 'ready'])
  assert.equal((await current.install()).ok, true)
  assert.deepEqual(current.events, [
    'revalidate',
    'helper',
    'grant',
    'grant-guard',
    'ready',
    'quiesce-and-context',
    'grant',
    'grant-guard',
  ])
  assert.equal(
    current.progress.find((value) => value.installation?.step === 'helper')?.phase,
    'preparing'
  )
  assert.equal(
    current.progress.find((value) => value.installation?.step === 'saving')?.phase,
    'installing'
  )
  assert.ok(current.progress.every((value) => value.installation?.step !== 'restarting'))
})

test('a ZIP ticket timeout permits retry without restarting native preparation or releasing the install gate', async () => {
  const current = fixture(false, false, true, true)
  const first = await current.prepare()
  assert.equal(first.errorFallback, 'install_notarization_indeterminate')
  assert.deepEqual(current.events, ['revalidate', 'helper', 'grant', 'grant-guard', 'verify-zip'])
  assert.equal((await current.install()).ok, false)
  assert.equal((await current.prepare()).ok, true)
  assert.deepEqual(current.events, [
    'revalidate',
    'helper',
    'grant',
    'grant-guard',
    'verify-zip',
    'verify-zip',
    'ready',
  ])
  assert.equal((await current.install()).ok, true)
  assert.deepEqual(current.events.slice(-3), ['quiesce-and-context', 'grant', 'grant-guard'])
})

test('pausing ZIP source verification keeps the bound request for manual retry and final authorization', async () => {
  const pause = new AbortController()
  let entered!: () => void
  const verifying = new Promise<void>((resolve) => {
    entered = resolve
  })
  const verifyApplication = runInNewContext(
    updaterFunctions(['verifyUpdateApplication']) + '\nverifyUpdateApplication',
    {
      UpdateVerifyError: class extends Error {},
      plistValue: () => {
        entered()
        // An interrupted command probe rejects with its own Error.
        return new Promise((_, reject) =>
          pause.signal.addEventListener(
            'abort',
            () => reject(new Error('command aborted: /usr/bin/plutil')),
            { once: true }
          )
        )
      },
    }
  )
  const current = fixture(false, false, true, async (installation) => {
    if (installation.signal !== pause.signal) return
    await verifyApplication('/native/unpacked', {}, {}, () => {}, installation, 'staged')
  })
  const background = current.prepare(false, undefined, pause.signal)
  await verifying
  pause.abort()
  const interrupted = await background
  assert.equal(interrupted.cancelled, true)
  assert.equal((await current.install()).ok, false)
  assert.equal((await current.prepare(true)).ok, true)
  assert.equal((await current.install()).ok, true)
  assert.deepEqual(current.events, [
    'revalidate',
    'helper',
    'grant',
    'grant-guard',
    'verify-zip',
    'verify-zip',
    'ready',
    'quiesce-and-context',
    'grant',
    'grant-guard',
  ])
})

test('native preparation refusal never quiesces product writers or persists a launch context', async () => {
  const current = fixture(true)
  const result = await current.prepare()
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.errorFallback, 'activation_recovery_required')
  assert.equal(current.events.includes('quiesce-and-context'), false)
  assert.equal(current.events.includes('discard-context'), false)
  assert.ok(current.progress.every((value) => value.phase === 'preparing'))
})

test('an unwritable installation needs explicit preparation before native side effects', async () => {
  const current = fixture(false, false, false)
  assert.equal((await current.prepare()).errorFallback, 'preparation_failed')
  assert.equal(current.events.length, 0)
  assert.equal((await current.prepare(true)).ok, true)
  assert.ok(current.events.includes('helper'))
  assert.equal(current.events.includes('quiesce-and-context'), false)
})

test('silent preparation checks the canonical application and its containing directory', () => {
  const writes: string[] = []
  let denied: string | undefined
  const writable = runInNewContext(
    updaterFunctions(['canPrepareMacUpdateWithoutInteraction']) +
      '\ncanPrepareMacUpdateWithoutInteraction',
    {
      process: { execPath: '/Alias.app/Contents/MacOS/ScholarSeed' },
      fsConstants: { W_OK: 2 },
      dirname,
      resolve,
      realpathSync: (path: string) => {
        assert.equal(path, '/Alias.app')
        return '/Applications/ScholarSeed.app'
      },
      accessSync: (path: string, mode: number) => {
        assert.equal(mode, 2)
        writes.push(path)
        if (path === denied) throw new Error('Permission denied')
      },
    }
  )
  assert.equal(writable(), true)
  assert.deepEqual(writes, ['/Applications/ScholarSeed.app', '/Applications'])
  for (const path of writes.slice()) {
    denied = path
    assert.equal(writable(), false)
  }
})

test('failed final authorization consumes no launch context and cannot report handoff success', async () => {
  const current = fixture(false, true)
  assert.equal((await current.prepare()).ok, true)
  assert.equal((await current.install()).ok, false)
  assert.equal(current.events.at(-1), 'discard-context')
})

test('retry after authorization failure budgets only remaining space for a matching native preparation', async () => {
  const current = fixture(false, true)
  assert.equal((await current.prepare()).ok, true)
  assert.equal((await current.install()).ok, false)
  assert.equal((await current.install()).ok, true)
  assert.deepEqual(current.nativeSpaceChecks, [false, true, true])
  assert.equal(current.events.filter((event) => event === 'helper').length, 1)
})

test('macOS preparation budgets cache, candidate and installation on their respective volumes', () => {
  const requirements: Array<[string, bigint]> = []
  const devices: Record<string, number> = { '/cache': 1, '/support': 1, '/Applications': 1 }
  const { prepare, install } = runInNewContext(
    updaterFunctions(['assertSquirrelPreparationSpace', 'assertSquirrelInstallSpace']) +
      '\n({ prepare: assertSquirrelPreparationSpace, install: assertSquirrelInstallSpace })',
    {
      process: { execPath: '/Applications/ScholarSeed.app/Contents/MacOS/ScholarSeed' },
      app: { getPath: () => '/support' },
      dirname,
      resolve,
      systemCacheDir: () => '/cache',
      statSync: (path: string) => ({ dev: devices[path] }),
      squirrelPreparedDevice: (candidate?: { dev: number }) => candidate?.dev,
      assertUpdateSpace: (path: string, bytes: bigint) => requirements.push([path, bytes]),
    }
  )
  prepare({ size: 40 }, 100, false)
  install(100, { dev: 1 })
  assert.deepEqual(requirements.splice(0), [['/cache', 240n]])
  devices['/Applications'] = 2
  prepare({ size: 40 }, 100, false)
  assert.deepEqual(requirements.splice(0), [
    ['/cache', 240n],
    ['/Applications', 100n],
  ])
  devices['/support'] = 3
  prepare({ size: 40 }, 100, false)
  assert.deepEqual(requirements.splice(0), [
    ['/cache', 140n],
    ['/support', 100n],
    ['/Applications', 100n],
  ])
  prepare({ size: 40 }, 100, true)
  assert.deepEqual(requirements.splice(0), [
    ['/cache', 140n],
    ['/Applications', 100n],
  ])
  install(100, { dev: 3 })
  install(100)
  assert.deepEqual(requirements, [
    ['/Applications', 100n],
    ['/Applications', 100n],
  ])
})

test('normal quit cancels pre-handoff preparation and waits for its cleanup', async () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const index = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  let callback: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(index) === 'app.on' &&
      node.arguments[0]?.getText(index) === "'before-quit'"
    )
      callback = node.arguments[1]
    else ts.forEachChild(node, visit)
  }
  visit(index)
  assert.ok(callback)
  let finishPreparation!: () => void
  const preparation = new Promise<void>((resolve) => {
    finishPreparation = resolve
  })
  let finishQuit!: () => void
  const quit = new Promise<void>((resolve) => {
    finishQuit = resolve
  })
  const abort = new AbortController()
  const events: string[] = []
  abort.signal.addEventListener('abort', () => events.push('abort'), { once: true })
  const beforeQuit = runInNewContext(
    ts.transpileModule(`(${callback.getText(index)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      runtimePreparation: undefined,
      macInstallCommit: preparation,
      updateInstallAbort: abort,
      updater: { macHandoffCommitted: () => false },
      updateRestartRequested: false,
      updateInstallBlockingSince: null,
      updateInstallationInProgress: true,
      browserVaultIpc: undefined,
      browserVault: undefined,
      logWindowLifecycle: () => {},
      backendQuitFinished: false,
      backendQuitPending: false,
      backgroundUpdateTimerStopped: false,
      preferenceQuiescence: { prepare: () => events.push('preferences') },
      updatePreparation: { running: false },
      finishApplicationShutdown: () => events.push('shutdown'),
      setImmediate,
      app: { quit: finishQuit },
    }
  )
  beforeQuit({ preventDefault: () => events.push('prevent') })
  assert.deepEqual(events, ['abort', 'prevent'])
  events.push('cleanup')
  finishPreparation()
  await quit
  assert.deepEqual(events, ['abort', 'prevent', 'cleanup', 'preferences', 'shutdown'])
})

test('a newer independently opened App cannot acknowledge another or unbound installation transaction', async () => {
  const entry = parsed.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'macStartupAdmission'
  )!
  for (const target of [undefined, '/Applications/Other.app', '/Applications/ScholarSeed.app']) {
    const exports: Record<string, Function> = {}
    const handoff = { nativeRequest: target ? { target: { path: target } } : undefined }
    runInNewContext(
      ts.transpileModule(entry.getText(parsed), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
      {
        exports,
        process: {
          platform: 'darwin',
          getuid: () => 501,
          execPath: '/Applications/Alias.app/Contents/MacOS/ScholarSeed',
        },
        MACOS_PLATFORM: 'darwin',
        app: { isPackaged: true, getVersion: () => '0.3.1' },
        resolve,
        dirname,
        realpathSync: (path: string) => {
          assert.equal(path, '/Applications/Alias.app')
          return '/Applications/ScholarSeed.app'
        },
        readSquirrelHandoff: () => handoff,
        TERMINAL_RECORD_LIMITS: { handoff: 4096 },
        captureRecord: () => ({ bytes: JSON.stringify(handoff) }),
        decodeSquirrelHandoff: JSON.parse,
        squirrelHandoffPath: () => '/home/squirrel.json',
        resolveDesktopConfig: () => ({ buildNumber: '202611100001' }),
        squirrelAdmission: () => 'allow',
        JSON,
      }
    )
    const result = await exports.macStartupAdmission('/home', () => {})
    assert.equal(result.admission, target === '/Applications/ScholarSeed.app' ? 'allow' : 'exit')
  }
})

test('native installation authorization is fresh after shutdown and rechecks exact candidate synchronously', async () => {
  const entry = parsed.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'quitMacUpdate'
  )!
  for (const failure of [
    'none',
    'transport',
    'expired',
    'binding',
    'backend',
    'disk',
    'conflict',
  ] as const) {
    const exports: Record<string, Function> = {}
    const events: string[] = []
    let attempts = 0
    let diskFull = failure === 'disk'
    const archive = { sha512: 'digest', size: 1 }
    runInNewContext(
      ts.transpileModule(entry.getText(parsed), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
      {
        exports,
        commitWithActivation,
        ActivationCandidateChanged,
        persistRejectedUpdate: async () => {
          events.push('persist-rejection')
        },
        retryUpdate,
        AbortController,
        macPrepared: { receipt: { matches: () => true, expandedBytes: 100 } },
        assertSquirrelInstallSpace: (expanded: number) => {
          assert.equal(expanded, 100)
          events.push('disk-check')
          if (diskFull) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        },
        readReadyState: () => ({
          meta: { id: 'candidate', version: '0.3.1', build_number: '202611100001' },
          archive,
        }),
        authorizeActivation: async () => {
          attempts++
          events.push('grant')
          if (failure === 'conflict') throw new ActivationCandidateChanged('withdrawn')
          if (failure === 'transport' && attempts === 1) throw new UpdateTransportError(503)
          return () => {
            events.push('guard')
            if (failure === 'expired' && attempts === 1) throw new ActivationExpired()
          }
        },
        squirrel: {
          ready: true,
          preparedCandidate: () => undefined,
          matches: (selected: unknown, identity: { candidate: string }) => {
            assert.equal(selected, archive)
            assert.equal(identity.candidate, 'candidate')
            events.push('binding')
            return failure !== 'binding'
          },
          quitAndInstall: () => events.push('install'),
        },
      }
    )
    const run = () =>
      exports.quitMacUpdate(
        () => {},
        () => {
          events.push('shutdown-barrier')
          if (failure === 'backend') throw new Error('backend still active')
        }
      )
    if (failure === 'conflict') {
      await assert.rejects(run(), ActivationCandidateChanged)
      assert.deepEqual(events, ['grant', 'persist-rejection'])
    } else if (failure === 'backend' || failure === 'binding') {
      await assert.rejects(run())
      assert.equal(events.includes('install'), false)
    } else {
      if (failure === 'disk') {
        await assert.rejects(run(), { code: 'ENOSPC' })
        assert.equal(events.includes('install'), false)
        diskFull = false
      }
      await run()
      assert.deepEqual(events.slice(-5), [
        'shutdown-barrier',
        'binding',
        'disk-check',
        'guard',
        'install',
      ])
      assert.equal(attempts, failure === 'none' ? 1 : 2)
    }
  }
})
