import assert from 'node:assert/strict'
import test from 'node:test'

import { PreferenceWriter } from './persistence.ts'
import {
  DEFAULT_RENDERER_PREFERENCES,
  sanitizeRendererPreferences
} from './preferences.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test('language round trip and concurrent theme are serialized without stale language writes', async () => {
  let disk = { ...DEFAULT_RENDERER_PREFERENCES }
  const gate = deferred<void>()
  const saved: typeof disk[] = []
  const applied: string[] = []
  const writer = new PreferenceWriter(disk, {
    save: async (value) => {
      saved.push(value)
      if (saved.length === 1) await gate.promise
      disk = value
      return disk
    },
    reconcile: async () => disk,
    apply: async (value) => { applied.push(value.language) },
    failed: () => assert.fail('unexpected failure')
  })
  const done = writer.submit({ language: 'en' })
  void writer.submit({ theme: 'dark' })
  void writer.submit({ language: 'zh' })
  gate.resolve()
  await done
  assert.equal(saved.length, 2)
  assert.equal(disk.language, 'zh')
  assert.equal(disk.theme, 'dark')
  assert.deepEqual(applied, ['en', 'zh'])
})

test('failed write does not commit language or loop, retry applies the intent', async () => {
  let disk = { ...DEFAULT_RENDERER_PREFERENCES }
  let fail = true
  let errors = 0
  let language = disk.language
  const writer = new PreferenceWriter(disk, {
    save: async (value) => { if (fail) throw Error('disk'); disk = value; return disk },
    reconcile: async () => disk,
    apply: async (value) => { language = value.language },
    failed: () => { errors++ }
  })
  await writer.submit({ language: 'en' })
  assert.equal(language, 'zh')
  assert.equal(errors, 1)
  fail = false
  await writer.retry()
  assert.equal(language, 'en')
})

test('persisted language whose projection failed must be reapplied even when retry equals disk', async () => {
  let disk = { ...DEFAULT_RENDERER_PREFERENCES }
  let fail = true
  let language = disk.language
  const writer = new PreferenceWriter(disk, {
    save: async (value) => { disk = value; return disk },
    reconcile: async () => disk,
    apply: async (value) => { if (fail) throw Error('projection'); language = value.language },
    failed: () => {}
  })
  await writer.submit({ language: 'en' })
  assert.equal(disk.language, 'en')
  assert.equal(language, 'zh')
  fail = false
  await writer.retry()
  assert.equal(language, 'en')
})

test('unrelated successful change retains failed language retry, later explicit language cancels it', async () => {
  let disk = { ...DEFAULT_RENDERER_PREFERENCES }
  let fail = true
  const writer = new PreferenceWriter(disk, {
    save: async (value) => { if (fail) throw Error('disk'); disk = value; return disk },
    reconcile: async () => disk,
    apply: async () => {},
    failed: () => {}
  })
  await writer.submit({ language: 'en' })
  fail = false
  await writer.submit({ theme: 'dark' })
  await writer.retry()
  assert.equal(disk.language, 'en')
  fail = true
  await writer.submit({ language: 'zh' })
  fail = false
  await writer.submit({ language: 'en' })
  await writer.retry()
  assert.equal(disk.language, 'en')
})

test('a pending latest no-op language cancels an older intent that fails later', async () => {
  const gate = deferred<void>()
  let disk = { ...DEFAULT_RENDERER_PREFERENCES }
  let first = true
  const writer = new PreferenceWriter(disk, {
    save: async (value) => { if (first) { first = false; await gate.promise; throw Error('disk') }; disk = value; return disk },
    reconcile: async () => disk,
    apply: async () => {},
    failed: () => {}
  })
  const done = writer.submit({ language: 'en' })
  void writer.submit({ language: 'zh' })
  gate.resolve()
  await done
  await writer.retry()
  assert.equal(disk.language, 'zh')
})

test('an applied fresh array cannot feed an equivalent preference snapshot back into saving', async () => {
  let disk = sanitizeRendererPreferences({
    ...DEFAULT_RENDERER_PREFERENCES,
    sessionActivitySeen: { newer: 1, older: 1 },
    reasoningPreferences: { modelB: 'high', modelA: 'low' },
    recentFiles: [{ projectId: 'project', path: 'paper.pdf', openedAt: 3 }]
  })
  let saves = 0
  let writer!: PreferenceWriter
  writer = new PreferenceWriter(disk, {
    save: async (value) => {
      saves += 1
      disk = sanitizeRendererPreferences(value)
      return disk
    },
    reconcile: async () => disk,
    apply: async (value) => {
      void writer.submit({
        sessionActivitySeen: { older: 1, newer: 1 },
        reasoningPreferences: { modelA: 'low', modelB: 'high' },
        recentFiles: [...value.recentFiles]
      })
    },
    failed: () => assert.fail('unexpected failure')
  })

  await writer.submit({ theme: 'dark' })

  assert.equal(saves, 1)
  assert.equal(disk.theme, 'dark')
})

test('onboarding seen state persists through the preference writer', async () => {
  let disk = { ...DEFAULT_RENDERER_PREFERENCES }
  const applied: Array<typeof disk.onboarding> = []
  const writer = new PreferenceWriter(disk, {
    save: async (value) => {
      disk = sanitizeRendererPreferences(value)
      return disk
    },
    reconcile: async () => disk,
    apply: async (value) => { applied.push(value.onboarding) },
    failed: () => assert.fail('unexpected failure')
  })

  await writer.submit({ onboarding: { seen: { globalLib: true } } })

  assert.equal(disk.onboarding.seen.globalLib, true)
  assert.deepEqual(applied.at(-1), { seen: { globalLib: true } })
})
