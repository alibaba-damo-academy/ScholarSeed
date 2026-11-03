import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import {
  decodeDeviceIdentity,
  DEVICE_FILENAME,
  DEVICE_MAX_BYTES,
  resolveDeviceIdentity,
} from './device.ts'

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'scholarseed-device-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const events: string[] = []
  return {
    root,
    events,
    options: {
      beforeCreate() {
        events.push('admit')
      },
      acquireWriter() {
        events.push('acquire')
        return {
          close() {
            events.push('close')
          },
        }
      },
      log() {
        events.push('log')
      },
    },
  }
}

test('existing device identity is read without acquiring a writer or changing bytes', (t) => {
  const { root, events, options } = fixture(t)
  const bytes = '{ "device_id": "existing", "extension": true }\n'
  writeFileSync(join(root, DEVICE_FILENAME), bytes)
  assert.deepEqual(resolveDeviceIdentity(root, 'new label', options), {
    device_id: 'existing',
    device_label: 'new label',
  })
  assert.deepEqual(events, [])
  assert.equal(readFileSync(join(root, DEVICE_FILENAME), 'utf8'), bytes)
})

test('missing device record is atomically published under a scoped writer and reused', (t) => {
  const { root, events, options } = fixture(t)
  const first = resolveDeviceIdentity(root, 'device', options)
  assert.match(first.device_id, /^[a-f0-9-]{36}$/)
  assert.equal(decodeDeviceIdentity(readFileSync(join(root, DEVICE_FILENAME))), first.device_id)
  assert.deepEqual(events, ['admit', 'acquire', 'close'])
  assert.deepEqual(readdirSync(root), [DEVICE_FILENAME])
  assert.deepEqual(resolveDeviceIdentity(root, 'device', options), first)
  assert.deepEqual(events, ['admit', 'acquire', 'close'])
})

test('malformed and oversized records cannot supply an invalid device identifier', (t) => {
  const { root, options } = fixture(t)
  for (const bytes of [
    '{broken',
    '{"device_id":42}',
    '{"device_id":{}}',
    ' '.repeat(DEVICE_MAX_BYTES + 1),
  ]) {
    writeFileSync(join(root, DEVICE_FILENAME), bytes)
    const result = resolveDeviceIdentity(root, 'device', options)
    assert.equal(typeof result.device_id, 'string')
    assert.equal(decodeDeviceIdentity(readFileSync(join(root, DEVICE_FILENAME))), result.device_id)
  }
  assert.throws(() => decodeDeviceIdentity(Uint8Array.of(255)))
  assert.equal(decodeDeviceIdentity(Buffer.from('[]')), null)
})

test('warmup and writer acquisition failure cannot create a device record', (t) => {
  const { root, events, options } = fixture(t)
  assert.throws(
    () =>
      resolveDeviceIdentity(root, 'device', {
        ...options,
        beforeCreate() {
          throw new Error('warming')
        },
      }),
    /warming/
  )
  assert.deepEqual(events, [])
  assert.throws(
    () =>
      resolveDeviceIdentity(root, 'device', {
        ...options,
        acquireWriter() {
          throw new Error('ownership denied')
        },
      }),
    /ownership denied/
  )
  assert.equal(existsSync(join(root, DEVICE_FILENAME)), false)
})

test('release uncertainty is not swallowed as a successful session-only identity', (t) => {
  const { root, options } = fixture(t)
  assert.throws(
    () =>
      resolveDeviceIdentity(root, 'device', {
        ...options,
        acquireWriter() {
          return {
            close() {
              throw new Error('release uncertain')
            },
          }
        },
      }),
    /release uncertain/
  )
})

test('ordinary write failure keeps fallback behavior and closes the writer', (t) => {
  const { root, events, options } = fixture(t)
  mkdirSync(join(root, DEVICE_FILENAME))
  const result = resolveDeviceIdentity(root, 'device', options)
  assert.match(result.device_id, /^[a-f0-9-]{36}$/)
  assert.equal(events.at(-1), 'close')
  assert.deepEqual(readdirSync(root), [DEVICE_FILENAME])
  assert.deepEqual(readdirSync(join(root, DEVICE_FILENAME)), [])
})
