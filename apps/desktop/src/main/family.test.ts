import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  WINDOWS_BACKEND_BOOTSTRAP,
  FAMILY_START_BYTE,
  drainProcessFamily,
  installationFailure,
} from './family.ts'

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

test('remaining descendants are terminated and confirmed before closing the family', async () => {
  const calls: string[] = []
  let remaining = 2
  const clean = await drainProcessFamily({
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
  assert.equal(clean, false)
  assert.deepEqual(calls, ['active', 'terminate', 'active', 'close'])
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

test('family retry preserves a forced drain when termination acknowledgement fails', async () => {
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
  await assert.rejects(drainProcessFamily(family), /termination acknowledgement failed/)
  assert.equal(closes, 0)
  assert.equal(await drainProcessFamily(family), false)
  assert.equal(closes, 1)
})
