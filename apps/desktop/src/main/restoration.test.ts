import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { constants } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import {
  applyTerminalRecovery,
  TerminalRestorationError,
  type TerminalRestorationRuntime,
  pendingOrphanRecovery,
} from './restoration.ts'
import {
  repairInstalledUpdate,
  updateRepairTarget,
  updateRepairSelection,
  UPDATE_REPAIR_ARGUMENT,
  UPDATE_REPAIR_SELECTION,
  planInstalledUpdate,
  verifyRepairApplication,
  UPDATE_REPAIR_PROTOCOL,
} from './repair.ts'
import { updateLaunchContextPath } from './relaunch.ts'
import { squirrelHandoffRecordPath } from './squirrel.ts'

const macosTest = process.platform === 'darwin' ? test : test.skip

function fixture(context: test.TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'terminal-restoration-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const application = join(root, 'ScholarSeed.app')
  const home = join(root, 'home')
  const userData = join(root, 'profile')
  const workspace = join(root, 'projects')
  const coordinator = join(root, 'coordinator')
  for (const directory of [
    join(application, 'Contents', 'Resources'),
    home,
    userData,
    workspace,
    coordinator,
  ])
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  const contextPath = updateLaunchContextPath(coordinator, application)
  const handoff = squirrelHandoffRecordPath(home)
  for (const directory of [dirname(contextPath), dirname(handoff)])
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  const requestId = 'a'.repeat(64)
  const binding = {
    schema: 1,
    requestId,
    candidate: 'failed-candidate',
    sha512: 'b'.repeat(128),
    size: 100,
  }
  const selection = {
    schema: 2,
    uid: process.getuid!(),
    application,
    bundleId: 'com.scholarseed.desktop',
    sourceBuild: '202611031043',
    targetBuild: '202611031329',
    candidate: binding.candidate,
    at: 1,
    home,
    userData,
    workspace,
    identities: Array(3).fill(
      `darwin:${'a'.repeat(32)}:${'b'.repeat(16)}:${'c'.repeat(16)}:${'d'.repeat(8)}`
    ),
  }
  const capture = (filename: string) => {
    const identity = (value: string) => {
      const info = statSync(value)
      return { dev: info.dev, ino: info.ino, uid: info.uid }
    }
    return { path: filename, parent: identity(dirname(filename)), item: identity(filename) }
  }
  const source = join(root, 'candidate', 'ScholarSeed.app')
  mkdirSync(join(source, 'Contents'), { recursive: true })
  const nativeRequest = { source: capture(source), target: capture(application), binding }
  const record = {
    version: '0.3.1',
    buildNumber: selection.targetBuild,
    candidate: binding.candidate,
    at: 1,
    state: 'installing',
    binding,
    nativeRequest,
  }
  writeFileSync(contextPath, JSON.stringify(selection), { mode: 0o600 })
  writeFileSync(handoff, JSON.stringify(record), { mode: 0o600 })
  writeFileSync(
    join(application, 'Contents', 'Resources', 'product.json'),
    JSON.stringify({
      bundle_id: selection.bundleId,
      expected_team_id: 'KYG3VP6NVH',
      build_number: selection.sourceBuild,
      release_lane: 'distribution',
    }),
    { mode: 0o600 }
  )
  const proof = {
    kind: 'terminal-failure-observation',
    bundleIdentifier: selection.bundleId,
    binding,
    code: 60,
    source: { ...nativeRequest.source, contents: capture(join(source, 'Contents')).item },
    target: { ...nativeRequest.target, contents: capture(join(application, 'Contents')).item },
    selection: { schema: selection.schema, sha256: 'c'.repeat(64) },
    journal: { sha256: 'd'.repeat(64) },
    ack: { sha256: 'e'.repeat(64) },
    state: { sha256: 'f'.repeat(64) },
  }
  const events: string[] = []
  let reserved = false
  let failAfterContext = false
  let failQualification = false
  let qualificationCode: string | undefined
  let qualificationAfter = 1
  let observations = 0
  let afterConsume: (() => void) | undefined
  const native = {
    persistentIdentity: () => selection.identities[0],
    pin: (filename: string) => {
      if (!statSync(filename).isDirectory()) throw new Error('not a directory')
      return filename
    },
    release: () => {
      events.push('release')
    },
    acquireAt: () => {
      events.push('context-lock')
      return 'context-lock'
    },
    createChild: (parent: unknown, name: string) => {
      mkdirSync(join(String(parent), name), { mode: 0o700 })
      return ''
    },
    readAt: (parent: unknown, name: string) => {
      try {
        return readFileSync(join(String(parent), name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    createAt: (parent: unknown, name: string, bytes: Buffer) => {
      events.push(`create:${name.split('.').at(-1)}`)
      writeFileSync(join(String(parent), name), bytes, { mode: 0o600, flag: 'wx' })
    },
    consumeAt: (parent: unknown, name: string, expected: Buffer, device: string, inode: string) => {
      const filename = join(String(parent), name)
      const info = statSync(filename, { bigint: true })
      assert.equal(String(info.dev), device)
      assert.equal(String(info.ino), inode)
      assert.deepEqual(readFileSync(filename), expected)
      events.push(`consume:${name}`)
      unlinkSync(filename)
      afterConsume?.()
      if (name === 'context.json' && failAfterContext)
        throw new Error('injected interruption after unlink')
    },
  }
  const runtime = {
    platform: 'darwin',
    uid: process.getuid!(),
    load: () => ({
      native,
      open: () => {
        events.push('native-open')
        return {
          observe: () => {
            events.push('observe')
            observations++
            if (failQualification && observations >= qualificationAfter)
              throw Object.assign(new Error('unknown'), { code: qualificationCode })
            return JSON.stringify({ schema: 1, mode: 'inspect', proof })
          },
          close: () => {
            events.push('native-close')
          },
        }
      },
    }),
    begin: () => ({
      occupy: () => {
        events.push('occupy')
      },
      check: () => {},
      checkWritable: () => {},
      reserveMutation: () => {
        events.push('reserve')
        reserved = true
        return {
          finish: () => {
            events.push('finish')
            reserved = false
          },
        }
      },
      close: () => {
        events.push('domains-close')
      },
    }),
    verifyApplication: async () => {
      events.push('signature')
    },
  } as unknown as TerminalRestorationRuntime
  const options = {
    application,
    coordinator,
    handoff,
    nativeState: join(root, 'ShipItState.plist'),
    preparation: join(root, 'CandidatePreparation'),
    cleanup: join(root, 'DeferredCleanup'),
    toolDirectory: join(root, 'tool'),
    expectedTeam: 'KYG3VP6NVH',
    requestId,
  }
  const recoveryDirectory = join(dirname(contextPath), 'terminal-recovery')
  return {
    root,
    options,
    runtime,
    events,
    contextPath,
    handoff,
    proof,
    recoveryDirectory,
    reserved: () => reserved,
    interrupt: () => {
      failAfterContext = true
    },
    resume: () => {
      failAfterContext = false
    },
    refuse: (code?: string, after = 1) => {
      failQualification = true
      qualificationCode = code
      qualificationAfter = after
    },
    afterConsume: (callback: () => void) => {
      afterConsume = callback
    },
  }
}

function orphanFixture(context: test.TestContext) {
  const current = fixture(context)
  const selection = JSON.parse(readFileSync(current.contextPath, 'utf8'))
  const handoff = JSON.parse(readFileSync(current.handoff, 'utf8'))
  handoff.state = 'failed'
  delete handoff.nativeRequest
  writeFileSync(current.handoff, JSON.stringify(handoff), { mode: 0o600 })
  const policy = JSON.parse(
    readFileSync(join(current.options.application, 'Contents', 'Resources', 'product.json'), 'utf8')
  )
  const source = current.proof.source.path
  mkdirSync(join(source, 'Contents', 'Resources'), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(source, 'Contents', 'Resources', 'product.json'),
    JSON.stringify({ ...policy, build_number: selection.targetBuild }),
    { mode: 0o600 }
  )
  const repairApplication = join(current.root, 'Repair.app')
  writeFileSync(
    join(current.options.application, 'Contents', 'Info.plist'),
    '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>ScholarSeed</string></dict></plist>'
  )
  const applicationSupport = join(current.root, 'support')
  const cache = join(current.root, 'cache')
  const owner = `${selection.bundleId}.ShipIt`
  for (const path of [repairApplication, join(applicationSupport, owner), join(cache, owner)])
    mkdirSync(path, { recursive: true, mode: 0o700 })
  const nativeState = join(cache, owner, 'ShipItState.plist')
  const state = Buffer.from(
    JSON.stringify({
      binding: handoff.binding,
      bundleIdentifier: selection.bundleId,
      updateBundleURL: pathToFileURL(source).href,
      targetBundleURL: pathToFileURL(current.options.application).href,
      installationAuthorized: false,
      launchAfterInstallation: false,
      useUpdateBundleName: true,
    })
  )
  writeFileSync(nativeState, state, { mode: 0o600 })
  const proof = {
    ...current.proof,
    kind: 'orphan-preparation-observation',
    stateBytes: state.toString('base64'),
    journalBytes: Buffer.from('legacy native journal').toString('base64'),
  }
  let interruptNative = false
  const load = current.runtime.load
  const runtime: TerminalRestorationRuntime = {
    ...current.runtime,
    load: (directory) => {
      const tools = load(directory)
      return {
        ...tools,
        open: (configuration) => {
          const config = JSON.parse(configuration)
          assert.equal(config.mode, 'orphan')
          if (config.expected) assert.deepEqual(config.expected, proof)
          const qualified = tools.open(configuration)
          return {
            ...qualified,
            observe: () => JSON.stringify({ schema: 1, mode: 'inspect', proof }),
            repair: () => {
              current.events.push('native-repair')
              if (existsSync(nativeState)) unlinkSync(nativeState)
              if (interruptNative) throw new Error('interrupted after native retirement')
            },
          }
        },
      }
    },
  }
  const scope = {
    application: current.options.application,
    repairApplication,
    coordinator: current.options.coordinator,
    applicationSupport,
    cache,
    bundleId: selection.bundleId,
    expectedTeam: current.options.expectedTeam,
  }
  return {
    ...current,
    scope,
    runtime,
    nativeState,
    selection,
    interruptNative: () => {
      interruptNative = true
    },
    resumeNative: () => {
      interruptNative = false
    },
  }
}

macosTest(
  'external repair entry preserves the original profile and reopens the old source for a normal update',
  async (context) => {
    const current = orphanFixture(context)
    const preferences = join(current.selection.userData, 'preferences.json')
    writeFileSync(preferences, '{"language":"zh-CN","preserved":true}')
    const before = readFileSync(preferences)
    const result = await repairInstalledUpdate(current.scope, current.runtime)
    assert.equal(result.outcome, 'recovered')
    assert.equal(result.installationPerformed, false)
    assert.equal(result.startup.home, current.selection.home)
    assert.equal(result.startup.workspace, current.selection.workspace)
    assert.deepEqual(result.arguments, [`--user-data-dir=${current.selection.userData}`])
    assert.deepEqual(readFileSync(preferences), before)
    assert.equal(existsSync(current.contextPath), false)
    assert.equal(existsSync(current.handoff), false)
    assert.equal(existsSync(current.nativeState), false)
    assert.ok(
      current.events.indexOf('consume:context.json') < current.events.indexOf('native-repair')
    )
    assert.ok(
      current.events.indexOf('native-repair') < current.events.indexOf('consume:squirrel.json')
    )
  }
)

macosTest(
  'repair planning is read-only and its observation is not installation or retirement authority',
  async (context) => {
    const current = orphanFixture(context)
    const before = readFileSync(current.handoff)
    const binding = JSON.parse(before.toString()).binding
    let closed = false
    await planInstalledUpdate(
      { ...current.scope, selection: current.selection },
      {
        ...current.runtime,
        load: (directory) => ({
          native: current.runtime.load(directory).native,
          open: (configuration) => {
            const config = JSON.parse(configuration)
            assert.equal(config.mode, 'orphan-plan')
            assert.equal(config.park, undefined)
            assert.equal(config.expected, undefined)
            return {
              observe: () =>
                JSON.stringify({ proof: { kind: 'orphan-preparation-plan', binding } }),
              close: () => {
                closed = true
              },
            }
          },
        }),
      }
    )
    assert.equal(closed, true)
    assert.deepEqual(readFileSync(current.handoff), before)
    assert.equal(existsSync(current.contextPath), true)
    assert.equal(existsSync(current.nativeState), true)
    assert.equal(
      current.events.some(
        (event) => event.startsWith('consume:') || event === 'native-repair' || event === 'reserve'
      ),
      false
    )
  }
)

macosTest(
  'an official signature alone cannot make an older application a repair helper',
  async (context) => {
    const current = orphanFixture(context)
    const resources = join(current.scope.repairApplication, 'Contents', 'Resources')
    mkdirSync(resources, { recursive: true, mode: 0o700 })
    const policy = {
      bundle_id: current.scope.bundleId,
      expected_team_id: current.scope.expectedTeam,
      release_lane: 'distribution',
    }
    const product = join(resources, 'product.json')
    writeFileSync(product, JSON.stringify(policy), { mode: 0o600 })
    await assert.rejects(
      verifyRepairApplication(
        current.scope.repairApplication,
        current.scope.bundleId,
        current.scope.expectedTeam,
        current.runtime
      ),
      /CAPABILITY/
    )
    writeFileSync(
      product,
      JSON.stringify({ ...policy, update_repair_protocol: UPDATE_REPAIR_PROTOCOL }),
      { mode: 0o600 }
    )
    await verifyRepairApplication(
      current.scope.repairApplication,
      current.scope.bundleId,
      current.scope.expectedTeam,
      current.runtime
    )
    writeFileSync(
      product,
      JSON.stringify({
        ...policy,
        update_repair_protocol: UPDATE_REPAIR_PROTOCOL,
        release_lane: 'local',
      }),
      { mode: 0o600 }
    )
    await assert.rejects(
      verifyRepairApplication(
        current.scope.repairApplication,
        current.scope.bundleId,
        current.scope.expectedTeam,
        current.runtime
      ),
      /CAPABILITY/
    )
  }
)

macosTest(
  'external repair resumes from its own durable intent after context and native state have disappeared',
  async (context) => {
    const current = orphanFixture(context)
    current.interruptNative()
    await assert.rejects(
      repairInstalledUpdate(current.scope, current.runtime),
      TerminalRestorationError
    )
    assert.equal(existsSync(current.contextPath), false)
    assert.equal(existsSync(current.nativeState), false)
    assert.equal(existsSync(current.handoff), true)
    assert.equal(current.reserved(), true)
    const pending = pendingOrphanRecovery(
      { ...current.scope, toolDirectory: current.scope.repairApplication },
      current.runtime.uid
    )
    assert.equal(pending?.requestId, current.options.requestId)
    current.resumeNative()
    const result = await repairInstalledUpdate(current.scope, current.runtime)
    assert.equal(result.outcome, 'recovered')
    assert.equal(existsSync(current.handoff), false)
    assert.equal(current.reserved(), false)
  }
)

macosTest(
  'external repair does not consume an in-flight authorized handoff or bypass signature refusal',
  async (context) => {
    const current = orphanFixture(context)
    const before = readFileSync(current.contextPath)
    const handoff = JSON.parse(readFileSync(current.handoff, 'utf8'))
    writeFileSync(current.handoff, JSON.stringify({ ...handoff, state: 'installing' }), {
      mode: 0o600,
    })
    await assert.rejects(repairInstalledUpdate(current.scope, current.runtime))
    assert.deepEqual(readFileSync(current.contextPath), before)
    writeFileSync(current.handoff, JSON.stringify(handoff), { mode: 0o600 })
    await assert.rejects(
      repairInstalledUpdate(current.scope, {
        ...current.runtime,
        verifyApplication: async () => {
          throw new Error('signature refused')
        },
      })
    )
    assert.deepEqual(readFileSync(current.contextPath), before)
    assert.equal(existsSync(current.nativeState), true)
    assert.equal(current.events.includes('native-repair'), false)
  }
)

macosTest(
  'repair routing is explicit and refuses Windows, development, duplicate and self repair',
  async (context) => {
    const current = orphanFixture(context)
    const argument = `${UPDATE_REPAIR_ARGUMENT}${current.scope.application}`
    assert.equal(updateRepairTarget([], 'darwin', true), null)
    assert.equal(updateRepairTarget([argument], 'darwin', true), current.scope.application)
    assert.throws(() => updateRepairTarget([argument], 'win32', true))
    assert.throws(() => updateRepairTarget([argument], 'darwin', false))
    assert.throws(() => updateRepairTarget([argument, argument], 'darwin', true))
    await assert.rejects(
      repairInstalledUpdate(
        { ...current.scope, repairApplication: current.scope.application },
        current.runtime
      )
    )
    assert.equal(current.events.includes('native-open'), false)
  }
)

macosTest(
  'handoff-only repair requires explicit directories and never reconstructs a deleted launch context',
  async (context) => {
    const current = orphanFixture(context)
    unlinkSync(current.contextPath)
    await assert.rejects(
      repairInstalledUpdate(current.scope, current.runtime),
      /ERR_UPDATE_REPAIR_SELECTION_REQUIRED/
    )
    const selection = {
      home: current.selection.home,
      userData: current.selection.userData,
      workspace: current.selection.workspace,
    }
    const args = Object.entries(UPDATE_REPAIR_SELECTION).map(
      ([key, prefix]) => `${prefix}${selection[key as keyof typeof selection]}`
    )
    assert.deepEqual(updateRepairSelection(args), selection)
    assert.throws(() => updateRepairSelection(args.slice(0, 1)), /SELECTION_REQUIRED/)
    const scope = { ...current.scope, selection }
    current.interruptNative()
    await assert.rejects(repairInstalledUpdate(scope, current.runtime), TerminalRestorationError)
    assert.equal(existsSync(current.contextPath), false)
    const intent = JSON.parse(
      readFileSync(join(current.recoveryDirectory, `${current.options.requestId}.intent`), 'utf8')
    )
    assert.equal(intent.context, null)
    assert.equal(intent.schema, 2)
    assert.equal(intent.kind, 'mac-orphan-selection-recovery')
    current.resumeNative()
    const result = await repairInstalledUpdate(current.scope, current.runtime)
    assert.equal(result.outcome, 'recovered')
    assert.equal(result.startup.userData, selection.userData)
    assert.equal(existsSync(current.contextPath), false)
    assert.equal(existsSync(current.handoff), false)
    assert.equal(
      current.events.some((event) => event === 'consume:context.json'),
      false
    )
  }
)

macosTest(
  'handoff-only repair rejects nonnumeric target builds before native mutation',
  async (context) => {
    const current = orphanFixture(context)
    unlinkSync(current.contextPath)
    const handoff = JSON.parse(readFileSync(current.handoff, 'utf8'))
    handoff.buildNumber = 'ZZZ'
    writeFileSync(current.handoff, JSON.stringify(handoff), { mode: 0o600 })
    const selection = {
      home: current.selection.home,
      userData: current.selection.userData,
      workspace: current.selection.workspace,
    }
    await assert.rejects(
      repairInstalledUpdate({ ...current.scope, selection }, current.runtime),
      (error) => error instanceof TerminalRestorationError && error.code === 'invalid_scope'
    )
    assert.equal(current.events.includes('native-repair'), false)
  }
)

macosTest(
  'repair entry classifies missing handoff and missing scope directories',
  async (context) => {
    const current = orphanFixture(context)
    unlinkSync(current.handoff)
    await assert.rejects(
      repairInstalledUpdate(current.scope, current.runtime),
      /ERR_UPDATE_REPAIR_STATE/
    )
    rmSync(current.scope.cache, { recursive: true })
    await assert.rejects(
      repairInstalledUpdate(current.scope, current.runtime),
      /ERR_UPDATE_REPAIR_SCOPE/
    )
    assert.equal(current.events.includes('native-repair'), false)
  }
)

macosTest(
  'handoff-only continuation refuses conflicting selection and a newly appeared context',
  async (context) => {
    const current = orphanFixture(context)
    unlinkSync(current.contextPath)
    const selection = {
      home: current.selection.home,
      userData: current.selection.userData,
      workspace: current.selection.workspace,
    }
    current.interruptNative()
    await assert.rejects(repairInstalledUpdate({ ...current.scope, selection }, current.runtime))
    const other = join(current.root, 'other-profile')
    mkdirSync(other, { mode: 0o700 })
    await assert.rejects(
      repairInstalledUpdate(
        { ...current.scope, selection: { ...selection, userData: other } },
        current.runtime
      )
    )
    writeFileSync(current.contextPath, JSON.stringify(current.selection), { mode: 0o600 })
    const replacement = readFileSync(current.contextPath)
    current.resumeNative()
    await assert.rejects(repairInstalledUpdate(current.scope, current.runtime))
    assert.deepEqual(readFileSync(current.contextPath), replacement)
    assert.equal(existsSync(current.handoff), true)
  }
)

macosTest(
  'a committed orphan transaction resumes startup after interruption without replaying a newer request',
  async (context) => {
    const current = orphanFixture(context)
    const result = await repairInstalledUpdate(current.scope, current.runtime)
    assert.equal(result.outcome, 'recovered')
    const continued = await repairInstalledUpdate(current.scope, current.runtime)
    assert.deepEqual(continued.startup, result.startup)
    assert.equal(existsSync(current.contextPath), false)
    assert.equal(existsSync(current.handoff), false)
    writeFileSync(current.handoff, '{"new":"request"}', { mode: 0o600 })
    assert.equal(
      pendingOrphanRecovery(
        {
          ...current.options,
          selection: {
            home: current.selection.home,
            userData: join(current.root, 'other-profile'),
            workspace: current.selection.workspace,
          },
        },
        current.runtime.uid
      ),
      null
    )
    await assert.rejects(repairInstalledUpdate(current.scope, current.runtime))
    assert.equal(readFileSync(current.handoff, 'utf8'), '{"new":"request"}')
  }
)

macosTest(
  'orphan entry retries only a released busy native qualification before acquiring domains',
  async (context) => {
    const current = orphanFixture(context)
    let opens = 0
    const runtime = {
      ...current.runtime,
      load: (directory: string) => {
        const tools = current.runtime.load(directory)
        return {
          ...tools,
          open: (configuration: string) => {
            if (++opens === 1)
              throw Object.assign(new Error('busy'), {
                code: 'ERR_TERMINAL_OPEN',
                systemCode: constants.errno.EWOULDBLOCK,
              })
            return tools.open(configuration)
          },
        }
      },
    }
    const result = await repairInstalledUpdate(current.scope, runtime)
    assert.equal(result.outcome, 'recovered')
    assert.equal(opens, 2)
    assert.equal(current.events.filter((event) => event === 'occupy').length, 1)
  }
)

test('terminal restoration refuses non-Darwin before loading tools or touching records', async () => {
  const runtime = {
    platform: 'win32',
    uid: -1,
    load: () => {
      throw new Error('must not load')
    },
  } as unknown as TerminalRestorationRuntime
  await assert.rejects(
    applyTerminalRecovery({} as never, runtime),
    (error) => error instanceof TerminalRestorationError && error.code === 'unsupported_platform'
  )
})

macosTest(
  'restoration holds qualifications and consumes only two bound records after durable intent',
  async (context) => {
    const current = fixture(context)
    const result = await applyTerminalRecovery(current.options, current.runtime)
    assert.equal(result.outcome, 'recovered')
    assert.equal(result.installationPerformed, false)
    assert.equal(result.executionAuthority, false)
    assert.equal(existsSync(current.contextPath), false)
    assert.equal(existsSync(current.handoff), false)
    assert.equal(current.reserved(), false)
    assert(current.events.indexOf('native-open') < current.events.indexOf('occupy'))
    assert(current.events.indexOf('reserve') < current.events.indexOf('consume:context.json'))
    assert(
      current.events.indexOf('consume:context.json') <
        current.events.indexOf('consume:squirrel.json')
    )
    assert(current.events.indexOf('create:committed') < current.events.indexOf('finish'))
    assert(current.events.indexOf('finish') < current.events.indexOf('domains-close'))
    assert(current.events.indexOf('domains-close') < current.events.indexOf('native-close'))
  }
)

macosTest(
  'uncertain native observation retains all remaining qualifications until process exit',
  async (context) => {
    const current = fixture(context)
    current.refuse('ERR_TERMINAL_RELEASE')
    await assert.rejects(
      applyTerminalRecovery(current.options, current.runtime),
      (error) => error instanceof TerminalRestorationError && error.code === 'release_uncertain'
    )
    assert.equal(current.events.includes('release'), false)
    assert.equal(current.events.includes('domains-close'), false)
    assert.equal(current.events.includes('native-close'), false)
    assert.equal(existsSync(current.contextPath), true)
    assert.equal(existsSync(current.handoff), true)
  }
)

macosTest(
  'uncertainty inside the reused inspector cannot be flattened into ordinary refusal',
  async (context) => {
    const current = fixture(context)
    current.refuse('ERR_TERMINAL_RELEASE', 2)
    await assert.rejects(
      applyTerminalRecovery(current.options, current.runtime),
      (error) => error instanceof TerminalRestorationError && error.code === 'release_uncertain'
    )
    assert.equal(current.events.includes('release'), false)
    assert.equal(current.events.includes('domains-close'), false)
    assert.equal(current.events.includes('native-close'), false)
  }
)

macosTest(
  'an interruption after the first unlink resumes forward without reconstructing the context',
  async (context) => {
    const current = fixture(context)
    current.interrupt()
    await assert.rejects(applyTerminalRecovery(current.options, current.runtime))
    assert.equal(existsSync(current.contextPath), false)
    assert.equal(existsSync(current.handoff), true)
    assert.equal(current.reserved(), true)
    current.resume()
    const result = await applyTerminalRecovery(current.options, current.runtime)
    assert.equal(result.outcome, 'recovered')
    assert.equal(current.events.filter((event) => event === 'consume:context.json').length, 1)
  }
)

macosTest(
  'a new same-byte handoff inode after interruption is preserved and refuses recovery',
  async (context) => {
    const current = fixture(context)
    current.interrupt()
    await assert.rejects(applyTerminalRecovery(current.options, current.runtime))
    const replacement = current.handoff + '.new'
    writeFileSync(replacement, readFileSync(current.handoff), { mode: 0o600 })
    renameSync(replacement, current.handoff)
    const before = readFileSync(current.handoff)
    current.resume()
    await assert.rejects(applyTerminalRecovery(current.options, current.runtime))
    assert.deepEqual(readFileSync(current.handoff), before)
    assert.equal(current.reserved(), true)
  }
)

macosTest('partial write-ahead intent cannot justify a missing record', async (context) => {
  const current = fixture(context)
  current.interrupt()
  await assert.rejects(applyTerminalRecovery(current.options, current.runtime))
  writeFileSync(join(current.recoveryDirectory, `${current.options.requestId}.context`), '{}', {
    mode: 0o600,
  })
  current.resume()
  await assert.rejects(applyTerminalRecovery(current.options, current.runtime))
  assert.equal(existsSync(current.handoff), true)
  assert.equal(current.reserved(), true)
})

macosTest(
  'qualification loss preserves the old records and cannot grant an install',
  async (context) => {
    const current = fixture(context)
    current.refuse()
    const before = createHash('sha256').update(readFileSync(current.contextPath)).digest('hex')
    await assert.rejects(applyTerminalRecovery(current.options, current.runtime))
    assert.equal(
      createHash('sha256').update(readFileSync(current.contextPath)).digest('hex'),
      before
    )
    assert.equal(
      current.events.some((event) => event.startsWith('consume:')),
      false
    )
  }
)

macosTest(
  'a late handoff replacement retains the barrier instead of deleting a newer transaction',
  async (context) => {
    const current = fixture(context)
    current.afterConsume(() => {
      if (!existsSync(current.contextPath) && existsSync(current.handoff))
        writeFileSync(current.handoff, '{"new":"transaction"}', { mode: 0o600 })
    })
    await assert.rejects(applyTerminalRecovery(current.options, current.runtime))
    assert.equal(readFileSync(current.handoff, 'utf8'), '{"new":"transaction"}')
    assert.equal(current.reserved(), true)
  }
)

macosTest(
  'reapplying a committed old intent cannot fence or consume a newer transaction',
  async (context) => {
    const current = fixture(context)
    const contextBytes = readFileSync(current.contextPath)
    const handoffBytes = readFileSync(current.handoff)
    await applyTerminalRecovery(current.options, current.runtime)
    writeFileSync(current.contextPath, contextBytes, { mode: 0o600 })
    writeFileSync(current.handoff, handoffBytes, { mode: 0o600 })
    await assert.rejects(applyTerminalRecovery(current.options, current.runtime))
    assert.equal(current.reserved(), false)
    assert.deepEqual(readFileSync(current.contextPath), contextBytes)
    assert.deepEqual(readFileSync(current.handoff), handoffBytes)
  }
)
