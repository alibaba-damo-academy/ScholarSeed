import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { StartupState, STARTUP_PHASE } from '../startup.ts'
import { UpdatePreparation } from './preparation.ts'
import { BackendMaintenanceRejected } from './backend-control.ts'
import { installationFailure } from './family.ts'
import { PreferenceQuiescence } from '../quiescence.ts'
import {
  ActivationCandidateChanged,
  ActivationExpired,
  commitWithActivation,
  type HandoffAuthorization,
} from './update-authorization.ts'
import { WindowsHandoffCancelled, WindowsHandoffExitUnconfirmed } from './transfer.ts'
import type { LatestVersionMeta, UpdateSnapshot } from '../updates.ts'

// Contract-test the real IPC handler with controlled installation boundaries;
// this does not substitute for packaged update acceptance.
const source = ts.createSourceFile(
  'index.ts',
  readFileSync(new URL('./index.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)
const declarations: string[] = []
function visit(node: ts.Node): void {
  if (
    ts.isFunctionDeclaration(node) &&
    [
      'publishUpdateCheckResult',
      'installWindowsPreparedUpdate',
      'recoverUpdateConflict',
      'finishMacUpdateHandoff',
    ].includes(node.name?.text ?? '')
  )
    declarations.push(node.getText(source))
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(source) === 'ipcMain.handle' &&
    ts.isStringLiteral(node.arguments[0]) &&
    node.arguments[0].text === 'scholarseed:update-install'
  )
    declarations.push(node.getText(source))
  ts.forEachChild(node, visit)
}
visit(source)
assert.equal(declarations.length, 5)
const code = ts.transpileModule(declarations.join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

test('native quit cleanup failure keeps maintenance writes fenced but exposes recovery', async () => {
  let registration = ''
  function find(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'app.on' &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === 'before-quit'
    )
      registration = node.getText(source)
    ts.forEachChild(node, find)
  }
  find(source)
  assert.notEqual(registration, '')
  for (const windows of [false, true]) {
    const requests: unknown[] = []
    const preferences = new PreferenceQuiescence((request) => requests.push(request))
    preferences.register()
    const saved = preferences.prepare(undefined, 'maintenance')
    preferences.accept({ requestId: 1, ok: true, writerId: 'renderer', acknowledgedRevision: 0 })
    await saved
    let quit!: (event: { preventDefault: () => void }) => void
    let snapshot: UpdateSnapshot = { phase: 'restarting', currentVersion: '0.3.0' }
    const context = {
      app: {
        on: (_event: string, handler: typeof quit) => {
          quit = handler
        },
      },
      runtimePreparation: null,
      browserVaultIpc: null,
      browserVault: null,
      updateInstallBlockingSince: null,
      updateInstallationInProgress: true,
      updateRestartRequested: true,
      backendQuitFinished: false,
      backendQuitPending: false,
      appQuitting: true,
      backgroundUpdateTimerStopped: true,
      windowsUpdateMaintenanceActive: windows,
      macUpdateMaintenanceActive: !windows,
      preferenceQuiescence: preferences,
      finishApplicationShutdown: async () => {
        throw new Error('cleanup failed')
      },
      currentUpdateSnapshot: () => snapshot,
      publishUpdateSnapshot: (next: UpdateSnapshot) => {
        snapshot = next
      },
      logWindowLifecycle: () => {},
      armBackgroundUpdateCheck: () => {},
      startupScreen: false,
      revealMainWindow: () => {},
      reportStartupFailure: () => {},
      mainLocalization: () => ({ getFixedT: () => (key: string) => key }),
    }
    runInNewContext(
      ts.transpileModule(registration, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      context
    )
    quit({ preventDefault: () => {} })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(context.appQuitting, false)
    assert.equal(snapshot.phase, 'failed')
    assert.equal(snapshot.errorFallback, 'activation_recovery_required')
    assert.deepEqual(requests.at(-1), { requestId: 1, mode: 'maintenance' })
    await assert.rejects(
      preferences.save(undefined, async () => {}),
      /ERR_PREFERENCES_FROZEN/
    )
  }
})

function candidate(build: string): LatestVersionMeta {
  return {
    id: build,
    version: '0.2.0',
    build_number: build,
    channel: 'preview',
    product_id: 'scholarseed',
    bundle_id: 'com.scholarseed.desktop',
    arch_type: 'windows-amd64',
    file_size: 1,
    sha512: 'a'.repeat(128),
  }
}
for (const windows of [false, true]) {
  for (const rejected of [false, true]) {
    test(`${windows ? 'Velopack' : 'Squirrel'} pins restart across publication and ${rejected ? 'rejection' : 'handoff'}`, async () => {
      const first = candidate('202610131000'),
        newer = candidate('202610131001')
      let snapshot: UpdateSnapshot = { phase: 'ready', currentVersion: '0.2.0', candidate: first }
      const prepared: string[] = []
      const preparation = new UpdatePreparation(async ({ candidate }) => {
        prepared.push(candidate.id)
        return true
      })
      preparation.offer(first)
      await preparation.settled()
      let finish!: () => void
      const waiting = new Promise<void>((resolve) => {
        finish = resolve
      })
      let install!: (_event: unknown, expectedId: string) => Promise<{ ok: boolean }>
      let checks = 0,
        exits = 0
      const context = {
        macShutdownReady: false,
        previewPolicyChanging: false,
        updateChecks: { isCurrent: () => true },
        updateDebugArguments: () => [],
        preparationPolicy: undefined,
        latestUpdateCandidate: null,
        loadRendererPreferences: () => ({ autoDownloadUpdates: true }),
        installationFailure,
        AbortController,
        fetch,
        process: { platform: windows ? 'win32' : 'darwin' },
        WINDOWS_PLATFORM: 'win32',
        MACOS_PLATFORM: 'darwin',
        ipcMain: {
          handle: (_: string, handler: typeof install) => {
            install = handler
          },
        },
        currentUpdateSnapshot: () => snapshot,
        publishUpdateSnapshot: (next: UpdateSnapshot) => {
          snapshot = next
          return next
        },
        publishUpdateProgress: () => {},
        requireDesktopWorkbench: () => {},
        preferenceQuiescence: new PreferenceQuiescence(() => {}),
        desktopWorkbenchReady: () => true,
        updatePreparation: preparation,
        updateInstallAbort: null,
        updateRestartRequested: false,
        updateInstallationInProgress: false,
        macMaintenanceUncertain: false,
        setUpdateInstallationInProgress: (active: boolean) => {
          context.updateInstallationInProgress = active
        },
        windowsPrepared: {
          candidate: first,
          update: {
            lock: async (args: string[]) => {
              assert.deepEqual(Array.from(args), ['--user-data-dir=C:/profile'])
            },
            verify: async () => {},
            apply: async (authorize: HandoffAuthorization) =>
              commitWithActivation(authorize, (guard) => guard()),
            close: async () => {},
          },
        },
        windowsUpdateMaintenanceActive: false,
        backendManaged: true,
        assertWindowsInstallationIdle: () => {},
        desktopStorage: () => ({ userData: 'C:/profile' }),
        clearBackendRestart: () => {},
        drainManagedBackend: async () => ({}),
        requireCleanBackendStop: () => {},
        startManagedBackend: async () => true,
        sendToMainWindow: () => {},
        apiBase: 'http://localhost',
        BackendMaintenanceRejected,
        WindowsHandoffCancelled,
        WindowsHandoffExitUnconfirmed,
        updater: {
          ActivationCandidateChanged,
          isCurrentPreviewResult: () => true,
          NO_STAGED_UPDATE: 'no staged update',
          macHandoffCommitted: () => false,
          checkForUpdate: async () => {
            checks++
            return { has_update: true, latest: newer }
          },
          authorizeActivation: async (selected: LatestVersionMeta) => {
            assert.equal(selected.id, first.id)
            await waiting
            if (rejected) throw new Error('candidate withdrawn')
            return () => {}
          },
          logUpdateEvent: () => {},
          readReadyState: () => ({}),
          installStagedUpdate: async () => {
            await waiting
            return rejected
              ? { ok: false, errorFallback: 'activation_unavailable' }
              : { ok: true, mode: 'manual' }
          },
        },
        desktopHandoff: { isBusy: () => false },
        backend: null,
        backendUpdateControl: () => ({
          prepareUpdate: async () => 'generation',
          resume: async () => {},
        }),
        observeBackendControl: () => ({}),
        resolveProductConfig: () => ({ updateBaseUrl: 'https://updates.example' }),
        pushLog: () => {},
        updateInstallFailure: () => ({ errorOrigin: 'install' }),
        app: {
          getVersion: () => '0.2.0',
          quit: () => {
            exits++
          },
        },
        appQuitting: false,
        isNewerRelease: () => true,
        newer,
      }
      runInNewContext(code, context)
      const pending = install(null, first.id)
      assert.equal(checks, 0, 'restart must not reselect the latest release')
      runInNewContext('publishUpdateCheckResult({ has_update: true, latest: newer })', context)
      assert.equal(preparation.offer(newer), false)
      assert.equal(snapshot.candidate?.id, first.id)
      finish()
      const result = await pending
      assert.equal(result.ok, !rejected)
      assert.equal(checks, 0)
      assert.deepEqual(prepared, [first.id])
      assert.equal(snapshot.candidate?.id, first.id)
      assert.equal(exits, windows && !rejected ? 1 : 0)
    })
  }
}

const windowsHandoff = ts.transpileModule(
  declarations
    .filter(
      (text) =>
        text.startsWith('async function installWindowsPreparedUpdate') ||
        text.startsWith('async function recoverUpdateConflict')
    )
    .join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
).outputText

for (const failure of [
  'none',
  'preferences',
  'cancel-preferences',
  'signature',
  'occupied',
  'occupancy-unknown',
  'occupied-after-drain',
  'occupancy-unknown-after-drain',
  'occupied-at-commit',
  'refused',
  'lost-prepare-update',
  'authorization',
  'candidate-conflict',
  'conflict-recovery',
  'conflict-revocation',
  'drain',
  'storage-drain',
  'apply',
  'helper-close-failed',
  'lock-exit-unconfirmed',
  'uac-cancelled',
  'grant-expired',
  'cancel-authorizing',
  'backend-raced',
  'recovery',
  'window-services',
  'stale-recovery',
] as const) {
  test(`Windows handoff preserves exit barrier and same-version recovery: ${failure}`, async () => {
    const events: string[] = []
    const startupState = new StartupState(() => {})
    const window = {}
    const selected = candidate('202610131000')
    let snapshot: UpdateSnapshot = { phase: 'ready', currentVersion: '0.2.0', candidate: selected }
    const owned = { stopping: false, port: 1234 }
    let verifies = 0
    let occupancyChecks = 0
    const preferenceQuiescence = new PreferenceQuiescence((request) => {
      if (request === null) {
        events.push('preferences-resume')
        return
      }
      if (request.mode === 'shutdown') {
        events.push('preferences-block-interaction')
        return
      }
      const { requestId } = request
      events.push('preferences-freeze')
      // A late renderer write must finish while its backend is still available.
      void (async () => {
        await new Promise<void>((resolve) => setImmediate(resolve))
        if (failure === 'preferences') {
          preferenceQuiescence.accept({ requestId, ok: false })
          return
        }
        await preferenceQuiescence.save(undefined, async () => {
          assert.equal(context.backend, owned)
          assert.equal(owned.stopping, false)
          events.push('preferences-saved')
        })
        if (failure === 'cancel-preferences') context.updateInstallAbort?.abort()
        preferenceQuiescence.accept({
          requestId,
          ok: true,
          writerId: 'renderer',
          acknowledgedRevision: 0,
        })
      })()
    })
    preferenceQuiescence.register()
    const context = {
      preferenceQuiescence,
      updateChecks: { invalidate: () => events.push('invalidate-check') },
      latestUpdateCandidate: selected,
      lastPreparationDeferral: null,
      nextPreparationRetryAt: 0,
      runBackgroundUpdateCheck: () => events.push('fresh-check'),
      updateDebugArguments: () => [],
      process: { argv: [], env: {} },
      installationFailure,
      AbortController,
      BackendMaintenanceRejected,
      WindowsHandoffCancelled,
      WindowsHandoffExitUnconfirmed,
      windowsPrepared: {
        candidate: selected,
        update: {
          lock: async (args: string[]) => {
            events.push('lock')
            if (failure === 'lock-exit-unconfirmed') throw new WindowsHandoffExitUnconfirmed()
            assert.deepEqual(Array.from(args), ['--user-data-dir=C:/frozen-profile'])
          },
          verify: async () => {
            events.push(`verify${++verifies}`)
            if (failure === 'signature') throw new Error('invalid signature')
          },
          apply: async (authorize: HandoffAuthorization) => {
            events.push('apply')
            if (
              [
                'apply',
                'helper-close-failed',
                'recovery',
                'window-services',
                'stale-recovery',
              ].includes(failure)
            )
              throw new Error('apply failed')
            await Promise.resolve()
            if (failure === 'uac-cancelled') throw new WindowsHandoffCancelled()
            events.push('uac-authorized')
            await commitWithActivation(authorize, (guard) => guard())
          },
          close: async () => {
            events.push('close')
            if (failure === 'helper-close-failed') throw new Error('helper exit unconfirmed')
          },
        },
      },
      backend: owned as typeof owned | null,
      backendManaged: true,
      updateInstallAbort: null as AbortController | null,
      windowsUpdateMaintenanceActive: false,
      updateRestartRequested: false,
      appQuitting: false,
      currentUpdateSnapshot: () => snapshot,
      publishUpdateSnapshot: (next: UpdateSnapshot) => {
        snapshot = next
        return next
      },
      desktopHandoff: { isBusy: () => false },
      desktopStorage: () => ({ userData: 'C:/frozen-profile' }),
      assertWindowsInstallationIdle: () => {
        events.push('idle')
        occupancyChecks++
        const blocked =
          (occupancyChecks === 1 && ['occupied', 'occupancy-unknown'].includes(failure)) ||
          (occupancyChecks === 2 &&
            ['occupied-after-drain', 'occupancy-unknown-after-drain'].includes(failure)) ||
          (occupancyChecks === 3 && failure === 'occupied-at-commit')
        if (blocked)
          throw Object.assign(new Error('private diagnostic'), {
            code: failure.startsWith('occupied')
              ? 'ERR_UPDATE_INSTALLATION_IN_USE'
              : 'ERR_UPDATE_INSTALLATION_QUERY',
          })
      },
      backendUpdateControl: () => ({
        quiesce: async () => {
          assert.fail('explicit updates must not quiesce runtime attachments')
        },
        prepareUpdate: async () => {
          events.push('prepare-update')
          if (failure === 'refused') throw new BackendMaintenanceRejected('busy')
          if (failure === 'lost-prepare-update') throw new Error('response lost')
          return 'owned-generation'
        },
        resume: async (generation: string) => {
          assert.equal(generation, 'owned-generation')
          events.push('resume')
          if (failure === 'conflict-recovery') throw new Error('resume failed')
        },
      }),
      clearBackendRestart: () => {},
      updater: {
        ActivationCandidateChanged,
        discardRejectedUpdate: (value: LatestVersionMeta) => {
          assert.equal(value, selected)
          events.push('revoke')
          if (failure === 'conflict-revocation') throw new Error('disk unavailable')
        },
        authorizeActivation: async (value: LatestVersionMeta) => {
          assert.equal(value, selected)
          events.push('authorize')
          assert.ok(events.includes('verify2'))
          assert.ok(events.includes('uac-authorized'))
          if (failure === 'cancel-authorizing')
            (context.updateInstallAbort as AbortController | null)?.abort()
          if (failure === 'backend-raced') context.backend = { stopping: false, port: 1234 }
          if (failure.startsWith('conflict-') || failure === 'candidate-conflict')
            throw new ActivationCandidateChanged('changed')
          if (failure === 'authorization') throw new Error('withdrawn')
          return () => {
            events.push('grant-check')
            if (failure === 'grant-expired' && events.includes('uac-authorized'))
              throw new ActivationExpired()
          }
        },
      },
      setUpdateInstallationInProgress: () => {},
      drainManagedBackend: async () => {
        events.push('drain')
        owned.stopping = true
        if (failure === 'storage-drain')
          throw new Error('storage cleanup failed after process exit')
        context.backend = null
        return { clean: failure !== 'drain' }
      },
      requireCleanBackendStop: (result: { clean: boolean }) => {
        if (!result.clean) throw new Error('runtime required forced termination')
      },
      stopBackend: async () => {
        events.push('join-family')
      },
      startManagedBackend: async (port: number) => {
        assert.equal(port, owned.port)
        events.push('restart-runtime')
        startupState.begin()
        return !['recovery', 'conflict-recovery'].includes(failure)
      },
      startupState,
      aliveMainWindow: () => window,
      currentStartup: () => failure !== 'stale-recovery',
      initializeWindowServices: async () => {
        events.push('window-services')
        if (failure === 'window-services') throw new Error('window services failed')
      },
      rendererBase: 'http://127.0.0.1:1235',
      ROOT_ROUTE: '/',
      browserStorageWindowGeneration: 1,
      finalizeStartup: () => events.push('ready'),
      sendToMainWindow: () => events.push('obsolete-notification'),
      apiBase: 'http://127.0.0.1:1234',
      updatePreparation: {
        release: () => events.push('release'),
        reset: async () => {
          events.push('reset')
        },
      },
      pushLog: () => {},
      app: { getVersion: () => '0.2.0', quit: () => events.push('quit') },
    }
    runInNewContext(windowsHandoff, context)
    const result = await runInNewContext('installWindowsPreparedUpdate()', context)
    assert.equal(result.ok, failure === 'none')
    assert.equal(events.includes('quit'), failure === 'none')
    assert.equal(events.includes('resume'), false)
    if (events.includes('prepare-update')) {
      assert.ok(events.includes('preferences-saved'))
      assert.ok(events.indexOf('preferences-saved') < events.indexOf('prepare-update'))
    }
    if (['preferences', 'cancel-preferences'].includes(failure)) {
      assert.equal(events.includes('prepare-update'), false)
      assert.equal(events.includes('drain'), false)
      assert.equal(context.backend, owned)
      if (failure === 'preferences') assert.match(result.error, /ERR_PREFERENCES_UNSAVED/)
      else assert.equal(result.cancelled, true)
    }
    assert.equal(
      events.includes('restart-runtime'),
      [
        'authorization',
        'candidate-conflict',
        'conflict-recovery',
        'conflict-revocation',
        'lost-prepare-update',
        'drain',
        'storage-drain',
        'apply',
        'recovery',
        'window-services',
        'stale-recovery',
        'uac-cancelled',
        'grant-expired',
        'cancel-authorizing',
        'backend-raced',
        'occupied-after-drain',
        'occupancy-unknown-after-drain',
        'occupied-at-commit',
      ].includes(failure)
    )
    if (
      events.includes('restart-runtime') &&
      ![
        'recovery',
        'conflict-recovery',
        'conflict-revocation',
        'window-services',
        'stale-recovery',
      ].includes(failure)
    ) {
      assert.equal(startupState.snapshot().phase, STARTUP_PHASE.ready)
      assert.equal(startupState.snapshot().apiBase, context.apiBase)
      assert.ok(events.indexOf('window-services') < events.indexOf('ready'))
      assert.equal(events.includes('obsolete-notification'), false)
    }
    assert.equal(events.includes('join-family'), failure === 'storage-drain')
    assert.equal(events.includes('close'), failure !== 'none')
    if (failure.startsWith('occupied') || failure.startsWith('occupancy-unknown')) {
      const expected = failure.startsWith('occupied')
        ? 'install_in_use'
        : 'install_occupancy_unknown'
      assert.equal(result.errorFallback, expected)
      assert.equal(snapshot.errorFallback, expected)
      assert.equal(result.error, undefined)
      assert.equal(snapshot.error, undefined)
      assert.equal(
        events.includes('prepare-update'),
        failure !== 'occupied' && failure !== 'occupancy-unknown'
      )
      assert.equal(snapshot.candidate?.id, selected.id)
    }
    if (['uac-cancelled', 'cancel-authorizing'].includes(failure))
      assert.equal(result.cancelled, true)
    if (events.includes('restart-runtime'))
      assert.ok(events.indexOf('close') < events.indexOf('restart-runtime'))
    if (failure === 'grant-expired') assert.equal(events.filter((e) => e === 'authorize').length, 2)
    if (failure === 'uac-cancelled') assert.equal(events.includes('authorize'), false)
    if (events.includes('apply')) {
      assert.ok(events.indexOf('drain') < events.indexOf('verify2'))
      assert.ok(events.indexOf('verify2') < events.indexOf('apply'))
    }
    if (failure === 'none') {
      // before-quit reuses the completed barrier after the backend has exited.
      await preferenceQuiescence.prepare()
      assert.equal(events.filter((event) => event === 'preferences-freeze').length, 1)
      await assert.rejects(
        preferenceQuiescence.save(undefined, async () => {}),
        /FROZEN/
      )
      assert.equal(context.updateRestartRequested, true)
      assert.equal(snapshot.phase, 'installing')
      assert.equal(snapshot.installStage, 'handoff')
      assert.equal(events.includes('release'), false)
    } else if (
      [
        'recovery',
        'window-services',
        'stale-recovery',
        'conflict-recovery',
        'conflict-revocation',
        'helper-close-failed',
        'lock-exit-unconfirmed',
      ].includes(failure)
    ) {
      assert.equal(snapshot.errorFallback, 'activation_recovery_required')
      if (failure === 'lock-exit-unconfirmed') {
        assert.equal(snapshot.phase, 'failed')
        assert.equal(result.errorFallback, 'activation_recovery_required')
        assert.equal(context.windowsUpdateMaintenanceActive, true)
        assert.equal(context.backend, owned)
        assert.equal(events.includes('prepare-update'), false)
      }
      assert.equal(context.backendManaged, !['recovery', 'conflict-recovery'].includes(failure))
      if (failure !== 'conflict-revocation')
        assert.notEqual(startupState.snapshot().phase, STARTUP_PHASE.ready)
      assert.equal(events.includes('release'), false)
      assert.equal(events.includes('preferences-resume'), false)
    } else if (failure === 'candidate-conflict') {
      assert.equal(result.errorFallback, 'activation_candidate_changed')
      assert.equal(snapshot.phase, 'failed')
      assert.equal(snapshot.candidate, undefined)
      assert.equal(context.windowsPrepared, null)
      assert.ok(events.indexOf('revoke') < events.indexOf('restart-runtime'))
      assert.ok(events.indexOf('close') < events.indexOf('reset'))
      assert.ok(events.indexOf('reset') < events.indexOf('fresh-check'))
      assert.equal(events.includes('apply'), true)
    } else {
      assert.equal(snapshot.phase, 'ready')
      assert.equal(events.includes('release'), true)
    }
    if (events.includes('release')) {
      assert.equal(events.includes('preferences-resume'), events.includes('preferences-freeze'))
      if (events.includes('ready'))
        assert.ok(events.indexOf('ready') < events.indexOf('preferences-resume'))
      await preferenceQuiescence.save(undefined, async () => {})
    }
  })
}

for (const failure of [
  'none',
  'preferences',
  'refused',
  'lost-prepare-update',
  'offline',
  'shutdown',
  'cancelled',
  'expired',
  'resume-failed',
] as const) {
  test(`macOS resumes maintenance without consuming handoff: ${failure}`, async () => {
    const selected = candidate('202610131000')
    let snapshot: UpdateSnapshot = { phase: 'ready', currentVersion: '0.2.0', candidate: selected }
    const preparation = new UpdatePreparation(async () => true)
    preparation.offer(selected)
    await preparation.settled()
    const events: string[] = []
    let install!: (
      _event: unknown,
      expectedId: string
    ) => Promise<{ ok: boolean; cancelled?: boolean; errorFallback?: string }>
    const context = {
      macShutdownReady: false,
      storageNative: {},
      coordinationRoot: () => '/coordination',
      userInfo: () => ({ uid: 501 }),
      applicationBundle: () => '/Applications/ScholarSeed.app',
      desktopStorage: () => ({ home: '/home', userData: '/profile', workspace: '/workspace' }),
      resolveProductConfig: () => ({
        bundleId: 'com.scholarseed.desktop',
        buildNumber: '202610130001',
      }),
      persistUpdateLaunch: () => {
        events.push('context')
        return () => {}
      },
      AbortController,
      process: { platform: 'darwin' },
      WINDOWS_PLATFORM: 'win32',
      MACOS_PLATFORM: 'darwin',
      previewPolicyChanging: false,
      updateInstallAbort: null as AbortController | null,
      updateRestartRequested: false,
      updateInstallationInProgress: false,
      macMaintenanceUncertain: false,
      macUpdateMaintenanceActive: false,
      currentUpdateSnapshot: () => snapshot,
      publishUpdateSnapshot: (next: UpdateSnapshot) => {
        snapshot = next
        return next
      },
      publishUpdateProgress: () => {},
      requireDesktopWorkbench: () => {},
      preferenceQuiescence: {
        prepare: async () => {
          events.push('preferences-saved')
          if (failure === 'preferences') throw new Error('ERR_PREFERENCES_UNSAVED')
        },
        resume: () => {
          events.push('preferences-resume')
        },
        allowInteraction: () => {
          events.push('preferences-allow-interaction')
        },
      },
      finishApplicationShutdown: async () => {
        events.push('drain')
        if (failure === 'shutdown') throw new Error('cleanup failed')
        context.backend = null
        return {}
      },
      requireCleanBackendStop: () => {},
      ipcMain: {
        handle: (_name: string, handler: typeof install) => {
          install = handler
        },
      },
      updatePreparation: preparation,
      desktopHandoff: { isBusy: () => false },
      backend: { stopping: false, proc: { exitCode: null, signalCode: null } } as {
        stopping: boolean
        proc: { exitCode: null; signalCode: null }
      } | null,
      clearBackendRestart: () => {},
      BackendMaintenanceRejected,
      backendUpdateControl: () => ({
        quiesce: async () => {
          assert.fail('explicit updates must not quiesce runtime attachments')
        },
        prepareUpdate: async () => {
          events.push('prepare-update')
          if (failure === 'refused') throw new BackendMaintenanceRejected('busy')
          if (failure === 'lost-prepare-update') throw new Error('response lost')
          return 'generation'
        },
        resume: async (generation: string) => {
          assert.equal(generation, 'generation')
          events.push('resume')
          if (failure === 'resume-failed') throw new Error('resume failed')
        },
      }),
      setUpdateInstallationInProgress: () => {},
      pushLog: () => {},
      app: {
        getVersion: () => '0.2.0',
        getPath: () => '/Applications/ScholarSeed.app/Contents/MacOS/ScholarSeed',
      },
      updateInstallFailure: () => ({ errorOrigin: 'install' }),
      updater: {
        logUpdateEvent: () => {},
        NO_STAGED_UPDATE: 'none',
        macHandoffCommitted: () => false,
        macHandoffReady: () => true,
        macHandoffRetryable: () => false,
        readReadyState: () => ({ meta: selected }),
        quitMacUpdate: async (_log: unknown, beforeCommit: () => void) => {
          beforeCommit()
          events.push('quit')
        },
        authorizeActivation: async () => {
          events.push('authorize')
          if (failure === 'none' || failure === 'shutdown') return () => {}
          if (failure === 'cancelled') context.updateInstallAbort?.abort()
          if (failure === 'expired')
            return () => {
              throw new ActivationExpired()
            }
          throw new Error('offline')
        },
        installStagedUpdate: async (
          _progress: unknown,
          _log: unknown,
          _signal: unknown,
          authorize: (value: LatestVersionMeta) => Promise<() => void>,
          prepareLaunch: (value: LatestVersionMeta) => Promise<() => void>
        ) => {
          events.push('prepared')
          events.push('native-ready')
          await prepareLaunch(selected)
          await commitWithActivation(
            () => authorize(selected),
            (guard) => {
              guard()
              events.push('commit')
            }
          )
          return { ok: true, mode: 'auto' }
        },
      },
    }
    runInNewContext(code, context)
    const result = await install(null, selected.id)
    if (failure === 'shutdown') {
      assert.equal(result.ok, false)
      assert.equal(snapshot.phase, 'failed')
      assert.equal(snapshot.errorFallback, 'activation_recovery_required')
      assert.equal(events.includes('preferences-allow-interaction'), true)
      assert.equal(events.includes('preferences-resume'), false)
      assert.equal(events.includes('quit'), false)
      assert.equal(events.includes('commit'), true)
      return
    }
    if (failure === 'none') {
      assert.equal(result.ok, true)
      assert.equal(snapshot.phase, 'installing')
      assert.equal(snapshot.installStage, 'handoff')
      assert.ok(events.indexOf('native-ready') < events.indexOf('preferences-saved'))
      assert.ok(events.indexOf('preferences-saved') < events.indexOf('prepare-update'))
      assert.ok(events.indexOf('commit') < events.indexOf('drain'))
      assert.ok(events.indexOf('drain') < events.indexOf('quit'))
      assert.equal(events.includes('preferences-resume'), false)
      return
    }
    if (failure === 'preferences') {
      assert.equal(result.ok, false)
      assert.equal(snapshot.phase, 'ready')
      assert.equal(events.includes('prepare-update'), false)
      assert.equal(events.includes('commit'), false)
      assert.equal(events.includes('drain'), false)
      assert.equal(events.includes('preferences-resume'), true)
      assert.equal(preparation.claim(selected), true)
      return
    }
    if (failure === 'refused' || failure === 'lost-prepare-update') {
      assert.equal(result.ok, false)
      assert.equal(events.includes('commit'), false)
      assert.equal(events.includes('drain'), false)
      assert.equal(events.includes('resume'), false)
      assert.equal(events.includes('authorize'), false)
      assert.equal(events.includes('preferences-resume'), failure === 'refused')
      assert.equal(snapshot.phase, failure === 'refused' ? 'ready' : 'failed')
      if (failure === 'lost-prepare-update') {
        assert.equal(result.errorFallback, 'activation_recovery_required')
        assert.equal(context.macMaintenanceUncertain, true)
        assert.equal(context.macUpdateMaintenanceActive, true)
      } else {
        assert.equal(context.macMaintenanceUncertain, false)
        assert.equal(context.macUpdateMaintenanceActive, false)
        assert.equal(preparation.claim(selected), true)
      }
      return
    }
    assert.equal(result.ok, false)
    assert.equal(events.includes('commit'), false)
    assert.equal(events.includes('resume'), true)
    assert.ok(events.indexOf('prepared') < events.indexOf('authorize'))
    assert.equal(
      events.filter((event) => event === 'authorize').length,
      failure === 'expired' ? 2 : 1
    )
    assert.equal(events.filter((event) => event === 'prepare-update').length, 1)
    assert.ok(events.includes('preferences-saved'))
    assert.ok(events.indexOf('preferences-saved') < events.indexOf('prepare-update'))
    assert.equal(events.includes('preferences-resume'), failure !== 'resume-failed')
    assert.equal(context.updateRestartRequested, false)
    assert.equal(result.cancelled, failure === 'cancelled' ? true : undefined)
    assert.equal(snapshot.phase, failure === 'resume-failed' ? 'failed' : 'ready')
    if (failure === 'resume-failed')
      assert.equal(result.errorFallback, 'activation_recovery_required')
    else assert.equal(preparation.claim(selected), true)
  })
}
