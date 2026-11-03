import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  WINDOWS_BACKEND_BOOTSTRAP,
  FAMILY_START_BYTE,
  drainProcessFamily,
  installationFailure,
  type FamilyNative,
} from './family.ts'

const requireNative = createRequire(import.meta.url)

test(
  'Windows Job drains naturally after a real leader closes',
  {
    skip: process.platform !== 'win32' || !process.env.SCHOLARSEED_LEASE_LIBRARY,
    timeout: 30_000,
  },
  async () => {
    const library = process.env.SCHOLARSEED_LEASE_LIBRARY
    assert.ok(library, 'select the actual compiled SCHOLARSEED_LEASE_LIBRARY')
    const native = requireNative(library) as FamilyNative
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const leader = spawn(process.execPath, [
        '-e',
        "process.stdin.once('data', () => process.exit(0))",
      ])
      let family: ReturnType<FamilyNative['openFamily']> | undefined
      try {
        await once(leader, 'spawn')
        family = native.openFamily(leader.pid!)
        const closed = once(leader, 'close')
        leader.stdin.end(FAMILY_START_BYTE)
        const [code] = await closed
        assert.equal(code, 0)
        const clean = await drainProcessFamily(family)
        family = undefined
        assert.equal(clean, true, `attempt ${attempt}`)
      } finally {
        if (family) {
          await drainProcessFamily(family)
        }
        if (leader.exitCode === null) leader.kill()
      }
    }
  }
)

test('bootstrap blocks product entry and preserves args and unbuffered control bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'family-'))
  const python = resolve(
    import.meta.dirname,
    '../../../../.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
  )
  writeFileSync(
    join(directory, 'entry.py'),
    'import os,sys,json\nprint(json.dumps([sys.argv[1:],os.read(0,10).decode()]),flush=True)\n'
  )
  const child = spawn(python, ['-c', WINDOWS_BACKEND_BOOTSTRAP, 'entry', '中文', 'with spaces'], {
    cwd: directory,
  })
  let output = '',
    error = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    error += chunk
  })
  try {
    await once(child, 'spawn')
    if (!error.includes('phase=python.wrapper_entered'))
      await once(child.stderr, 'data', { signal: AbortSignal.timeout(30_000) })
    assert.equal(output, '')
    assert.match(error, /phase=python.wrapper_entered/)
    assert.doesNotMatch(error, /phase=python.family_released/)
    const closed = once(child, 'close')
    child.stdin.end(Buffer.concat([FAMILY_START_BYTE, Buffer.from('bootstrap\n')]))
    const [code] = await closed
    assert.equal(code, 0, error)
    assert.deepEqual(JSON.parse(output), [['中文', 'with spaces'], 'bootstrap\n'])
    const checkpoints = error.split('\n').filter((line) => line.startsWith('startup_checkpoint'))
    assert.deepEqual(
      checkpoints.map((line) => /phase=(\S+)/.exec(line)?.[1]),
      ['python.wrapper_entered', 'python.family_released', 'python.module_dispatch']
    )
    for (const checkpoint of checkpoints) {
      assert.match(checkpoint, /pid=\d+ monotonic_seconds=\d+\.\d+ unix_seconds=\d+\.\d+/)
      assert.doesNotMatch(checkpoint, /中文|with spaces|bootstrap\\n/)
    }
  } finally {
    if (child.exitCode === null) child.kill()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('bootstrap diagnostics do not admit a child with an invalid family token', async () => {
  const python = resolve(
    import.meta.dirname,
    '../../../../.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
  )
  const child = spawn(python, ['-c', WINDOWS_BACKEND_BOOTSTRAP, 'missing_product_entry'])
  let output = ''
  let error = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    error += chunk
  })
  const closed = once(child, 'close')
  child.stdin.end(Buffer.from([0]))
  const [code] = await closed
  assert.equal(code, 125)
  assert.equal(output, '')
  assert.match(error, /phase=python.wrapper_entered/)
  assert.doesNotMatch(error, /phase=python.family_released|phase=python.module_dispatch|Traceback/)
})

test('naturally exiting family members are drained without forced termination', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  let remaining = 1
  let closed = false
  const drained = drainProcessFamily({
    active: () => remaining,
    terminate() {
      assert.fail('naturally exiting family must not be terminated')
    },
    close() {
      assert.equal(remaining, 0)
      closed = true
    },
  })
  assert.equal(closed, false)
  remaining = 0
  context.mock.timers.tick(50)
  assert.equal(await drained, true)
  assert.equal(closed, true)
})

test('natural exit at the grace deadline does not require forced termination', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const deadline = Date.now() + 5_000
  let closed = false
  const drained = drainProcessFamily({
    active: () => (Date.now() >= deadline ? 0 : 1),
    terminate() {
      assert.fail('family exited naturally at the deadline')
    },
    close() {
      closed = true
    },
  })
  context.mock.timers.tick(5_000)
  assert.equal(await drained, true)
  assert.equal(closed, true)
})

test('forced-exit observation errors propagate without closing the family', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const failure = new Error('native family observation failed')
  let forced = false
  let closed = false
  const rejected = assert.rejects(
    drainProcessFamily({
      active() {
        if (forced) throw failure
        return 1
      },
      terminate() {
        forced = true
      },
      close() {
        closed = true
      },
    }),
    (error) => error === failure
  )
  context.mock.timers.tick(5_000)
  await rejected
  assert.equal(forced, true)
  assert.equal(closed, false)
})

test('remaining descendants are terminated and confirmed before closing the family', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const calls: string[] = []
  let remaining = 2
  const drained = drainProcessFamily({
    active() {
      calls.push('active')
      return remaining
    },
    terminate() {
      calls.push('terminate')
      remaining = 0
    },
    close() {
      assert.equal(remaining, 0)
      calls.push('close')
    },
  })
  assert.equal(remaining, 2)
  assert.equal(calls.includes('terminate'), false)
  context.mock.timers.tick(5_000)
  assert.equal(await drained, false)
  assert.equal(remaining, 0)
  assert.ok(calls.indexOf('terminate') < calls.indexOf('close'))
})

test('clean family does not terminate processes', async () => {
  let closed = false
  assert.equal(
    await drainProcessFamily({
      active: () => 0,
      terminate() {
        assert.fail('unexpected kill')
      },
      close() {
        closed = true
      },
    }),
    true
  )
  assert.equal(closed, true)
})

test('family remains unclosed when forced termination has not been acknowledged', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  let terminated = false
  let closed = false
  let observeTermination!: () => void
  const termination = new Promise<void>((resolve) => {
    observeTermination = resolve
  })
  const rejected = assert.rejects(
    drainProcessFamily({
      active: () => 1,
      terminate() {
        terminated = true
        observeTermination()
      },
      close() {
        closed = true
      },
    }),
    /Owned runtime process family did not exit/
  )
  context.mock.timers.tick(5_000)
  await termination
  assert.equal(terminated, true)
  context.mock.timers.tick(5_000)
  await rejected
  assert.equal(closed, false)
})

test('installation failures use native codes, never message text', () => {
  assert.equal(installationFailure({ code: 'ERR_UPDATE_INSTALLATION_IN_USE' }), 'install_in_use')
  assert.equal(
    installationFailure({ code: 'ERR_UPDATE_INSTALLATION_QUERY' }),
    'install_occupancy_unknown'
  )
  assert.equal(
    installationFailure({ code: 'ERR_UPDATE_INSTALLATION_SESSION' }),
    'install_occupancy_unknown'
  )
  assert.equal(installationFailure(new Error('ERR_UPDATE_INSTALLATION_IN_USE')), undefined)
  assert.equal(installationFailure(null), undefined)
})

test('family retry preserves a forced drain when termination acknowledgement fails', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  let active = 1
  let closes = 0
  const family = {
    active: () => active,
    terminate() {
      active = 0
      throw new Error('termination acknowledgement failed')
    },
    close() {
      closes += 1
    },
  }
  const rejected = assert.rejects(drainProcessFamily(family), /termination acknowledgement failed/)
  context.mock.timers.tick(5_000)
  await rejected
  assert.equal(closes, 0)
  assert.equal(await drainProcessFamily(family), false)
  assert.equal(closes, 1)
})
