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
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  applyTerminalRecovery,
  TerminalRestorationError,
  type TerminalRestorationRuntime,
} from './restoration.ts'
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
