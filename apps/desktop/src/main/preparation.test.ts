import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LatestVersionMeta } from '../updates.ts'
import { backgroundPreparationPolicy, UpdatePreparation } from './preparation.ts'
import type { PreparationCheckpoint } from './preparation.ts'
import type { LegacyPreparationCheckpoint } from './preparation.ts'

function release(build: string): LatestVersionMeta {
  return {
    id: build,
    version: '0.2.0',
    build_number: build,
    product_id: 'scholarseed',
    bundle_id: 'com.scholarseed.desktop',
    arch_type: 'darwin-arm64',
    channel: 'release',
    file_size: 1,
    sha512: 'a'.repeat(128),
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const TEST_POLICY = {
  coalesceMs: 300,
  intervalMs: 10_000,
  recoveryBaseMs: 100,
  retryBaseMs: 100,
  retryMaxMs: 1000,
  retryJitter: 0,
}

test('first preparation records occupancy and success only at completion', async () => {
  let now = 1000
  let saved: PreparationCheckpoint | null = null
  const completion = deferred()
  const queue = new UpdatePreparation(
    async () => {
      await completion.promise
      return true
    },
    {
      load: () => saved,
      save: (next) => {
        saved = next
      },
      failed: (error) => assert.fail(String(error)),
    },
    TEST_POLICY,
    () => now
  )
  const candidate = release('202610141000')
  queue.observe(candidate)
  assert.equal(queue.background(true), true)
  await Promise.resolve()
  assert.equal(saved!.admission!.inFlight!.candidateId, candidate.id)
  assert.equal(saved!.admission!.lastSuccess, null)
  now += 5000
  completion.resolve()
  await queue.settled()
  assert.equal(saved!.admission!.inFlight, null)
  assert.deepEqual(saved!.admission!.lastSuccess, { candidateId: candidate.id, at: now })
  assert.equal(queue.decision(true).reason, 'already-ready')
})

test('candidate coalescing and adoption preserve the first deadline and completed time', async () => {
  let now = 1000
  const seen: string[] = []
  let saved: PreparationCheckpoint | null = null
  const queue = new UpdatePreparation(
    async ({ candidate }) => {
      seen.push(candidate.id)
      return true
    },
    {
      load: () => saved,
      save: (next) => {
        saved = next
      },
      failed: (error) => assert.fail(String(error)),
    },
    TEST_POLICY,
    () => now
  )
  const first = release('202610141000')
  const second = release('202610141001')
  const latest = release('202610141002')
  queue.observe(first)
  queue.background(true)
  await queue.settled()
  queue.observe(second)
  const deadline = queue.nextBackgroundAt
  now += 200
  queue.adopt(first)
  queue.observe(latest)
  queue.observe(latest)
  assert.equal(queue.nextBackgroundAt, deadline)
  assert.equal(saved!.admission!.pending!.since, 1000)
  assert.equal(saved!.admission!.pending!.candidate.id, latest.id)
  assert.equal(saved!.admission!.lastSuccess!.at, 1000)
  now = deadline
  assert.equal(queue.background(true), true)
  await queue.settled()
  assert.deepEqual(seen, [first.id, latest.id])
})

test('cold ready has a bounded merge window without inventing a new successful preparation', () => {
  let now = 1000
  const queue = new UpdatePreparation(
    async () => true,
    undefined,
    TEST_POLICY,
    () => now
  )
  queue.adopt(release('202610141000'))
  queue.observe(release('202610141001'))
  assert.equal(queue.decision(true).reason, 'coalescing')
  assert.equal(queue.nextBackgroundAt, now + TEST_POLICY.coalesceMs)
  now += 200
  queue.observe(release('202610141002'))
  assert.equal(queue.nextBackgroundAt, 1300)
})

test('transient pending persistence failure retains the original merge anchor', () => {
  let now = 1000
  let unavailable = false
  let saved: PreparationCheckpoint | null = null
  const queue = new UpdatePreparation(
    async () => true,
    {
      load: () => saved,
      save: (next) => {
        if (unavailable) throw new Error('pending checkpoint unavailable')
        saved = next
      },
      failed: () => {},
    },
    TEST_POLICY,
    () => now
  )
  queue.adopt(release('202610141000'))
  const second = release('202610141001')
  unavailable = true
  queue.observe(second)
  assert.equal(queue.background(true), false)
  assert.equal(queue.decision(true).reason, 'checkpoint-unavailable')
  now += 50
  unavailable = false
  queue.observe(second)
  assert.equal(queue.background(true), false)
  assert.equal(queue.nextBackgroundAt, 1300)
  assert.equal(saved!.admission!.pending!.since, 1000)
})

test('normal exit clears occupancy without a success interval and restart can recover', async () => {
  let saved: PreparationCheckpoint | null = null
  const started = deferred()
  const persistence = {
    load: () => saved,
    save: (next: PreparationCheckpoint) => {
      saved = next
    },
    failed: (error: unknown) => assert.fail(String(error)),
  }
  const candidate = release('202610141000')
  const queue = new UpdatePreparation(
    async ({ signal }) => {
      started.resolve()
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      )
      return false
    },
    persistence,
    TEST_POLICY,
    () => 1000
  )
  queue.observe(candidate)
  queue.background(true)
  await started.promise
  await queue.stop()
  assert.equal(saved!.admission!.inFlight, null)
  assert.equal(saved!.admission!.lastSuccess, null)
  const restored = new UpdatePreparation(
    async () => true,
    persistence,
    TEST_POLICY,
    () => 1000
  )
  restored.observe(candidate)
  assert.equal(restored.background(true), true)
  await restored.settled()
  assert.equal(saved!.preparedRelease, candidate.id)
})

test('cancelling a queued attempt also clears its occupancy', async () => {
  let saved: PreparationCheckpoint | null = null
  let attempts = 0
  const queue = new UpdatePreparation(
    async () => {
      attempts++
      return true
    },
    {
      load: () => saved,
      save: (next) => {
        saved = next
      },
      failed: (error) => assert.fail(String(error)),
    },
    TEST_POLICY,
    () => 1000
  )
  queue.observe(release('202610141000'))
  queue.background(true)
  await queue.stop()
  assert.equal(attempts, 0)
  assert.equal(saved!.admission!.inFlight, null)
  assert.equal(saved!.admission!.lastSuccess, null)
})

test('explicit resume persists a new occupancy before restarting a paused attempt', async () => {
  let saved: PreparationCheckpoint | null = null
  let attempts = 0
  const started = deferred()
  const queue = new UpdatePreparation(
    async ({ signal, generation }) => {
      attempts++
      assert.equal(saved!.admission!.inFlight!.generation, generation)
      if (attempts === 1) {
        started.resolve()
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true })
        )
        return false
      }
      return true
    },
    {
      load: () => saved,
      save: (next) => {
        saved = next
      },
      failed: (error) => assert.fail(String(error)),
    },
    TEST_POLICY,
    () => 1000
  )
  queue.observe(release('202610141000'))
  queue.background(true)
  await started.promise
  await queue.pause()
  queue.resume()
  await queue.settled()
  assert.equal(attempts, 2)
  assert.equal(saved!.admission!.inFlight, null)
})

test('crash recovery deadline survives file-backed reloads without sliding', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'update-preparation-recovery-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'preparation.json')
  const candidate = release('202610141000')
  const state: PreparationCheckpoint = {
    generation: 1,
    desiredRelease: candidate,
    preparedRelease: null,
    admission: {
      version: 2,
      pending: null,
      inFlight: { candidateId: candidate.id, generation: 1, startedAt: 900 },
      lastSuccess: null,
      retry: { at: 0, failures: 0 },
      recovery: { at: 0, interruptions: 0 },
    },
  }
  writeFileSync(file, JSON.stringify(state))
  const persistence = {
    load: () => JSON.parse(readFileSync(file, 'utf8')) as PreparationCheckpoint,
    save: (next: PreparationCheckpoint) => writeFileSync(file, JSON.stringify(next)),
    failed: (error: unknown) => assert.fail(String(error)),
  }
  let now = 1000
  const queue = new UpdatePreparation(
    async () => true,
    persistence,
    TEST_POLICY,
    () => now
  )
  queue.observe(candidate)
  assert.equal(queue.decision(true).reason, 'interruption-recovery')
  assert.equal(queue.nextBackgroundAt, 1100)
  now += 20
  const restored = new UpdatePreparation(
    async () => true,
    persistence,
    TEST_POLICY,
    () => now
  )
  restored.observe(release('202610141001'))
  assert.equal(restored.nextBackgroundAt, 1100)
  assert.equal(persistence.load().admission!.recovery.interruptions, 1)
  assert.equal(persistence.load().admission!.inFlight, null)
})

test('legacy six-hour reservation becomes one short recovery and is never written again', () => {
  const candidate = release('202610141000')
  let saved: LegacyPreparationCheckpoint = {
    generation: 7,
    desiredRelease: candidate,
    preparedRelease: null,
    schedule: { failures: 0, notBefore: 21_601_000 },
  }
  const persistence = {
    load: () => saved,
    save: (next: PreparationCheckpoint) => {
      saved = next
    },
    failed: (error: unknown) => assert.fail(String(error)),
  }
  const queue = new UpdatePreparation(
    async () => true,
    persistence,
    TEST_POLICY,
    () => 1000
  )
  queue.observe(candidate)
  assert.equal(queue.nextBackgroundAt, 1100)
  assert.equal(saved.schedule, undefined)
  assert.equal(saved.admission!.lastSuccess, null)
  const restored = new UpdatePreparation(
    async () => true,
    persistence,
    TEST_POLICY,
    () => 1020
  )
  restored.observe(candidate)
  assert.equal(restored.nextBackgroundAt, 1100)
})

test('legacy failure evidence is retained without a six-hour reservation', () => {
  const candidate = release('202610141000')
  let saved: LegacyPreparationCheckpoint = {
    generation: 7,
    desiredRelease: candidate,
    preparedRelease: null,
    schedule: { failures: 2, notBefore: 21_601_000 },
  }
  const queue = new UpdatePreparation(
    async () => true,
    {
      load: () => saved,
      save: (next) => {
        saved = next
      },
      failed: (error) => assert.fail(String(error)),
    },
    TEST_POLICY,
    () => 1000
  )
  queue.observe(release('202610141002'))
  assert.equal(queue.nextBackgroundAt, 1200)
  assert.equal(saved.admission!.retry.failures, 2)
  assert.equal(saved.admission!.lastSuccess, null)
})

test('legacy completed hint does not invent successful time or grant restart authority', () => {
  const candidate = release('202610141000')
  let saved: LegacyPreparationCheckpoint = {
    generation: 7,
    desiredRelease: candidate,
    preparedRelease: candidate.id,
    schedule: { failures: 0, notBefore: 21_601_000 },
  }
  const queue = new UpdatePreparation(
    async () => true,
    {
      load: () => saved,
      save: (next) => {
        saved = next
      },
      failed: (error) => assert.fail(String(error)),
    },
    TEST_POLICY,
    () => 1000
  )
  queue.observe(candidate)
  assert.equal(saved.admission!.lastSuccess, null)
  assert.equal(queue.commit(candidate.id), false)
  queue.adopt(candidate)
  assert.equal(queue.decision(true).reason, 'already-ready')
  assert.equal(saved.admission!.lastSuccess, null)
})

test('claiming retained ready does not clear replacement retry evidence', async () => {
  let saved: PreparationCheckpoint | null = null
  const first = release('202610141000')
  const queue = new UpdatePreparation(
    async () => false,
    {
      load: () => saved,
      save: (next) => {
        saved = next
      },
      failed: (error) => assert.fail(String(error)),
    },
    TEST_POLICY,
    () => 1000
  )
  queue.adopt(first)
  queue.request(release('202610141001'))
  await queue.settled()
  const retry = saved!.admission!.retry
  assert.equal(queue.claim(first), true)
  assert.deepEqual(saved!.admission!.retry, retry)
  assert.equal(saved!.admission!.lastSuccess, null)
  assert.equal(queue.decision(true).reason, 'installation-committed')
})

for (const ready of [false, true]) {
  test(`terminal persistence failure does not repeat expensive work (ready=${ready})`, async () => {
    let saved: PreparationCheckpoint | null = null
    let unavailable = false
    let attempts = 0
    const candidate = release('202610141000')
    const persistence = {
      load: () => saved,
      save: (next: PreparationCheckpoint) => {
        if (unavailable) throw new Error('terminal checkpoint unavailable')
        saved = next
      },
      failed: () => {},
    }
    const queue = new UpdatePreparation(
      async () => {
        attempts++
        unavailable = true
        return ready
      },
      persistence,
      TEST_POLICY,
      () => 1000
    )
    queue.observe(candidate)
    queue.background(true)
    await queue.settled()
    assert.equal(queue.decision(true).reason, 'checkpoint-unavailable')
    assert.equal(queue.background(true), false)
    assert.equal(attempts, 1)
    unavailable = false
    assert.equal(queue.decision(true).reason, ready ? 'already-ready' : 'failure-backoff')
    assert.equal(queue.background(true), false)
    assert.equal(saved!.admission!.inFlight, null)
    assert.equal(saved!.admission!.retry.failures, ready ? 0 : 1)
    assert.equal(saved!.admission!.lastSuccess?.at ?? null, ready ? 1000 : null)
    assert.equal(attempts, 1)
  })
}

test('pausing a completed but unsaved receipt keeps its generation current', async () => {
  let saved: PreparationCheckpoint | null = null
  let unavailable = false
  let isCurrent: (() => boolean) | undefined
  const candidate = release('202610141000')
  const queue = new UpdatePreparation(
    async (attempt) => {
      isCurrent = attempt.isCurrent
      unavailable = true
      return true
    },
    {
      load: () => saved,
      save: (next) => {
        if (unavailable) throw new Error('terminal checkpoint unavailable')
        saved = next
      },
      failed: () => {},
    },
    TEST_POLICY,
    () => 1000
  )
  queue.observe(candidate)
  queue.background(true)
  await queue.settled()
  await queue.pause()
  assert.equal(isCurrent!(), true)
  unavailable = false
  queue.adopt(candidate)
  assert.equal(queue.invalidate(candidate.id, saved!.generation), true)
  assert.equal(queue.commit(candidate.id), false)
})

test('background coalesces releases without interrupting work and waits after success', async () => {
  let now = 1000
  const complete = deferred()
  const seen: string[] = []
  const first = release('202610131000')
  const second = release('202610131001')
  const newest = release('202610131002')
  const queue = new UpdatePreparation(
    async (attempt) => {
      seen.push(attempt.candidate.id)
      await complete.promise
      assert.equal(attempt.signal.aborted, false)
      return true
    },
    undefined,
    TEST_POLICY,
    () => now
  )
  queue.observe(first)
  assert.equal(queue.background(true), true)
  queue.observe(second)
  queue.observe(newest)
  assert.equal(queue.background(true), false)
  complete.resolve()
  await queue.settled()
  assert.deepEqual(seen, [first.id])
  assert.equal(queue.background(true), false)
  now += TEST_POLICY.intervalMs
  assert.equal(queue.background(true), true)
  await queue.settled()
  assert.deepEqual(seen, [first.id, newest.id])
})

test('slow failures back off from completion across new builds and process restart', async () => {
  let now = 1000
  let saved: PreparationCheckpoint | null = null
  const persistence = {
    load: () => saved,
    save: (value: PreparationCheckpoint) => {
      saved = value
    },
    failed: (error: unknown) => assert.fail(String(error)),
  }
  const queue = new UpdatePreparation(
    async () => {
      now += 5000
      return false
    },
    persistence,
    TEST_POLICY,
    () => now
  )
  queue.observe(release('202610131000'))
  queue.background(true)
  await queue.settled()
  assert.equal(queue.nextBackgroundAt, now + TEST_POLICY.retryBaseMs)
  const newest = release('202610131002')
  queue.observe(newest)
  assert.equal(queue.background(true), false)
  const restored = new UpdatePreparation(
    async () => false,
    persistence,
    TEST_POLICY,
    () => now
  )
  restored.observe(newest)
  assert.equal(restored.background(true), false)
  now += TEST_POLICY.retryBaseMs
  assert.equal(restored.background(true), true)
  await restored.settled()
  assert.equal(restored.nextBackgroundAt, now + TEST_POLICY.retryBaseMs * 2)
})

test('disabled background and a cold ready receipt do not reprepare; manual bypass still works', async () => {
  const seen: string[] = []
  const first = release('202610131000')
  const newest = release('202610131002')
  const queue = new UpdatePreparation(
    async ({ candidate }) => {
      seen.push(candidate.id)
      return true
    },
    undefined,
    TEST_POLICY,
    () => 1000
  )
  queue.adopt(first)
  queue.observe(newest)
  assert.equal(queue.background(false), false)
  assert.equal(queue.background(true), false)
  assert.deepEqual(seen, [])
  queue.offer(newest)
  await queue.settled()
  assert.deepEqual(seen, [newest.id])
})

test('a retained ready release can be claimed after a replacement failure without starting latest', async () => {
  const first = release('202610131000')
  const newest = release('202610131002')
  let attempts = 0
  const queue = new UpdatePreparation(
    async () => {
      attempts += 1
      return false
    },
    undefined,
    TEST_POLICY,
    () => 1000
  )
  queue.adopt(first)
  queue.offer(newest)
  await queue.settled()
  assert.equal(queue.claim(first), true)
  assert.equal(queue.latest?.id, newest.id)
  assert.equal(attempts, 1)
  assert.equal(queue.background(true), false)
})

test('rejected manual admission does not rebuild a retained cold ready candidate', async () => {
  const first = release('202610131000')
  const newest = release('202610131002')
  const seen: string[] = []
  let failures = 0
  const queue = new UpdatePreparation(
    async ({ candidate }) => {
      seen.push(candidate.id)
      return true
    },
    {
      load: () => null,
      save: (checkpoint) => {
        if (checkpoint.desiredRelease.id === newest.id) throw new Error('checkpoint unavailable')
      },
      failed: () => {
        failures += 1
      },
    },
    TEST_POLICY,
    () => 1000
  )
  queue.adopt(first)
  assert.equal(queue.request(newest), false)
  await queue.settled()
  assert.equal(queue.candidate?.id, first.id)
  assert.deepEqual(seen, [])
  assert.equal(failures, 1)
  assert.equal(queue.claim(first), true)
})

test('manual request persists occupancy without success and fails closed on checkpoint errors', async () => {
  const first = release('202610131000')
  const origins: string[] = []
  const started = deferred()
  let now = 1000
  let unavailable = false
  let checkpoint: PreparationCheckpoint | null = null
  const queue = new UpdatePreparation(
    async (attempt) => {
      origins.push(attempt.origin)
      started.resolve()
      if (attempt.origin === 'background') {
        await new Promise<void>((resolve) =>
          attempt.signal.addEventListener('abort', () => resolve())
        )
        return false
      }
      assert.equal(checkpoint?.admission?.inFlight?.startedAt, now)
      assert.equal(checkpoint?.admission?.lastSuccess, null)
      return true
    },
    {
      load: () => null,
      save: (next) => {
        if (unavailable) throw new Error('checkpoint unavailable')
        checkpoint = next
      },
      failed: () => {},
    },
    TEST_POLICY,
    () => now
  )
  queue.observe(first)
  queue.background(true)
  await started.promise
  await queue.pause()
  now += TEST_POLICY.intervalMs + 1
  unavailable = true
  assert.equal(queue.request(first), false)
  await queue.settled()
  assert.deepEqual(origins, ['background'])
  unavailable = false
  assert.equal(queue.request(first), true)
  await queue.settled()
  assert.deepEqual(origins, ['background', 'manual'])
})

test('manual resume labels a paused background attempt as manual', async () => {
  const first = release('202610131000')
  const origins: string[] = []
  const started = deferred()
  const queue = new UpdatePreparation(
    async (attempt) => {
      origins.push(attempt.origin)
      started.resolve()
      if (attempt.origin === 'background') {
        await new Promise<void>((resolve) =>
          attempt.signal.addEventListener('abort', () => resolve())
        )
        return false
      }
      return true
    },
    undefined,
    TEST_POLICY,
    () => 1000
  )
  queue.observe(first)
  queue.background(true)
  await started.promise
  await queue.pause()
  queue.resume()
  await queue.settled()
  assert.deepEqual(origins, ['background', 'manual'])
  assert.equal(queue.claim(first), true)
})

test('only macOS opts into preparation admission and jitter respects the retry cap', async () => {
  assert.ok(backgroundPreparationPolicy('darwin'))
  assert.equal(backgroundPreparationPolicy('win32'), undefined)
  let now = 1000
  const queue = new UpdatePreparation(
    async () => false,
    undefined,
    { ...TEST_POLICY, retryJitter: 0.2 },
    () => now,
    () => 1
  )
  queue.offer(release('202610131000'))
  await queue.settled()
  assert.equal(queue.nextBackgroundAt, now + 120)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    queue.retry()
    await queue.settled()
    assert.ok(queue.nextBackgroundAt <= now + TEST_POLICY.retryMaxMs)
    now += 1
  }
})

test('latest-only worker waits for cancellation cleanup and discards stale callbacks', async () => {
  const cleanup = deferred()
  const began = deferred()
  const seen: string[] = []
  const published: string[] = []
  let aborted = false
  const a = release('202609281000'),
    b = release('202609281001'),
    c = release('202609281002')
  const queue = new UpdatePreparation(async (attempt) => {
    seen.push(attempt.candidate.id)
    if (attempt.candidate.id === a.id) {
      began.resolve()
      await cleanup.promise
      aborted = attempt.signal.aborted
    }
    if (attempt.isCurrent()) published.push(attempt.candidate.id)
    return true
  })
  queue.offer(a)
  await began.promise
  queue.offer(b)
  queue.offer(c)
  assert.deepEqual(seen, [a.id])
  cleanup.resolve()
  await queue.settled()
  assert.equal(aborted, true)
  assert.deepEqual(seen, [a.id, c.id])
  assert.deepEqual(published, [c.id])
  assert.equal(queue.offer(b), false)
  assert.equal(queue.commit(b.id), false)
  assert.equal(queue.commit(c.id), true)
  assert.equal(queue.offer(release('202609281003')), false)
})

test('failed preparation retries explicitly; equal builds do not loop', async () => {
  let attempts = 0
  const candidate = release('202609281000')
  const queue = new UpdatePreparation(async () => ++attempts > 1)
  queue.offer(candidate)
  await queue.settled()
  assert.equal(queue.commit(candidate.id), false)
  assert.equal(queue.offer(candidate), false)
  queue.retry()
  await queue.settled()
  assert.equal(queue.commit(candidate.id), true)
  assert.equal(attempts, 2)
})

test('restored ready state commits without repeating preparation', async () => {
  let attempts = 0
  const candidate = release('202609281000')
  const queue = new UpdatePreparation(async () => {
    attempts += 1
    return true
  })
  queue.adopt(candidate)
  assert.equal(queue.commit(candidate.id), true)
  assert.equal(attempts, 0)
})

test('cancelling restart wait keeps background preparation alive', async () => {
  const done = deferred()
  const queue = new UpdatePreparation(async () => {
    await done.promise
    return true
  })
  const candidate = release('202609281000')
  queue.offer(candidate)
  const controller = new AbortController()
  const waiting = queue.settled(controller.signal)
  controller.abort()
  await assert.rejects(waiting, { name: 'AbortError' })
  assert.equal(queue.running, true)
  done.resolve()
  await queue.settled()
  assert.equal(queue.commit(candidate.id), true)
})

test('stop waits for cleanup and prevents later candidates from starting', async () => {
  const started = deferred(),
    cleaned = deferred()
  let current = true
  const queue = new UpdatePreparation(async (attempt) => {
    started.resolve()
    await cleaned.promise
    current = attempt.isCurrent()
    return true
  })
  queue.offer(release('202609281000'))
  await started.promise
  const stopping = queue.stop()
  assert.equal(queue.running, true)
  cleaned.resolve()
  await stopping
  assert.equal(current, false)
  assert.equal(queue.offer(release('202609281001')), false)
})

test('restart preserves generation but requires a fresh check and never restores restart intent', async () => {
  const candidate = release('202609281000')
  let state = {
    generation: 41,
    desiredRelease: candidate,
    preparedRelease: candidate.id as string | null,
  }
  const seen: number[] = []
  const queue = new UpdatePreparation(
    async (attempt) => {
      seen.push(attempt.generation)
      return true
    },
    {
      load: () => state,
      save: (next) => {
        state = next
      },
      failed: (error) => assert.fail(String(error)),
    }
  )
  assert.equal(queue.candidate, null)
  assert.equal(queue.commit(candidate.id), false)
  queue.offer(candidate)
  await queue.settled()
  assert.deepEqual(seen, [42])
  assert.equal(state.preparedRelease, candidate.id)
  assert.equal(queue.commit(candidate.id), true)
})

test('an unexpected worker exception is reported once and explicit retry remains possible', async () => {
  const errors: unknown[] = []
  let attempts = 0
  const candidate = release('202609281000')
  const queue = new UpdatePreparation(
    async () => {
      if (++attempts === 1) throw new Error('disk unavailable')
      return true
    },
    { load: () => null, save: () => {}, failed: (error) => errors.push(error) }
  )
  queue.offer(candidate)
  await queue.settled()
  assert.equal(errors.length, 1)
  assert.equal(attempts, 1)
  assert.equal(queue.commit(candidate.id), false)
  queue.retry()
  await queue.settled()
  assert.equal(queue.commit(candidate.id), true)
})

test('an offer at the worker completion boundary is not lost', async () => {
  const first = release('202609281000'),
    last = release('202609281001')
  const seen: string[] = []
  const queue = new UpdatePreparation(
    async (attempt) => {
      seen.push(attempt.candidate.id)
      return true
    },
    {
      load: () => null,
      save: (state) => {
        if (state.preparedRelease === first.id) queueMicrotask(() => queue.offer(last))
      },
      failed: (error) => assert.fail(String(error)),
    }
  )
  queue.offer(first)
  await queue.settled()
  assert.deepEqual(seen, [first.id, last.id])
  assert.equal(queue.commit(last.id), true)
})

test('pausing preparation aborts and drains the worker; explicit resume can finish it', async () => {
  const began = deferred(),
    finish = deferred()
  let attempts = 0
  const queue = new UpdatePreparation(async (attempt) => {
    if (++attempts === 1) {
      began.resolve()
      await finish.promise
    }
    return !attempt.signal.aborted
  })
  const candidate = release('202609281000')
  queue.offer(candidate)
  await began.promise
  const paused = queue.pause()
  finish.resolve()
  await paused
  assert.equal(attempts, 1)
  assert.equal(queue.commit(candidate.id), false)
  queue.resume()
  await queue.settled()
  assert.equal(attempts, 2)
  assert.equal(queue.commit(candidate.id), true)
})

test('a failed checkpoint does not accept a candidate and the same build can be retried', async () => {
  const errors: unknown[] = []
  let fail = true,
    attempts = 0
  const queue = new UpdatePreparation(
    async () => {
      attempts += 1
      return true
    },
    {
      load: () => null,
      save: () => {
        if (fail) throw new Error('disk full')
      },
      failed: (error) => errors.push(error),
    }
  )
  const candidate = release('202609281000')
  assert.equal(queue.offer(candidate), false)
  assert.equal(queue.candidate, null)
  assert.equal(attempts, 0)
  fail = false
  assert.equal(queue.offer(candidate), true)
  await queue.settled()
  assert.equal(queue.commit(candidate.id), true)
  assert.equal(errors.length, 1)
})

test('resuming an already enabled queue does not bypass explicit failure backoff', async () => {
  let attempts = 0
  const queue = new UpdatePreparation(async () => {
    attempts += 1
    return false
  })
  queue.offer(release('202609281000'))
  await queue.settled()
  queue.resume()
  await queue.settled()
  assert.equal(attempts, 1)
})

test('lost preparation invalidates completion and waits for explicit retry', async () => {
  const candidate = release('202609281000')
  let generation = 0
  let prepared: string | null = null
  let attempts = 0
  let current = () => false
  const queue = new UpdatePreparation(
    async (attempt) => {
      generation = attempt.generation
      current = attempt.isCurrent
      attempts += 1
      return true
    },
    {
      load: () => null,
      save: (state) => {
        prepared = state.preparedRelease
      },
      failed: (error) => assert.fail(String(error)),
    }
  )
  queue.offer(candidate)
  await queue.settled()
  assert.equal(prepared, candidate.id)
  assert.equal(queue.invalidate(candidate.id, generation), true)
  assert.equal(prepared, null)
  assert.equal(current(), false)
  assert.equal(queue.commit(candidate.id), false)
  assert.equal(queue.offer(candidate), false)
  queue.resume()
  await queue.settled()
  assert.equal(attempts, 1)
  const invalidated = generation
  queue.retry()
  await queue.settled()
  assert.equal(attempts, 2)
  assert.equal(queue.invalidate(candidate.id, invalidated), false)
  assert.equal(queue.commit(candidate.id), true)
})

test('connection loss before completion cannot publish a late ready checkpoint', async () => {
  const candidate = release('202609281000')
  const began = deferred(),
    finish = deferred()
  const checkpoints: Array<string | null> = []
  let generation = 0
  let attempts = 0
  const queue = new UpdatePreparation(
    async (attempt) => {
      generation = attempt.generation
      attempts += 1
      began.resolve()
      await finish.promise
      return true
    },
    {
      load: () => null,
      save: (state) => {
        checkpoints.push(state.preparedRelease)
      },
      failed: (error) => assert.fail(String(error)),
    }
  )
  queue.offer(candidate)
  await began.promise
  assert.equal(queue.invalidate(candidate.id, generation), true)
  finish.resolve()
  await queue.settled()
  assert.equal(attempts, 1)
  assert.equal(checkpoints.includes(candidate.id), false)
  assert.equal(queue.commit(candidate.id), false)
  const newer = release('202609281001')
  queue.offer(newer)
  await queue.settled()
  assert.equal(queue.invalidate(candidate.id, generation - 1), false)
  assert.equal(queue.commit(newer.id), true)
})

for (const cleanupFails of [false, true]) {
  test(`B disconnects while C/D/E arrive; only E prepares after cleanup (failure=${cleanupFails})`, async () => {
    const builds = ['202609281001', '202609281002', '202609281003', '202609281004'].map(release)
    const [first, , , latest] = builds
    const began = deferred(),
      cleanup = deferred()
    const started: string[] = [],
      ready: string[] = [],
      errors: unknown[] = []
    let generation = 0,
      active = 0,
      peak = 0
    const queue = new UpdatePreparation(
      async (attempt) => {
        active += 1
        peak = Math.max(peak, active)
        started.push(attempt.candidate.id)
        try {
          if (attempt.candidate.id === first.id) {
            generation = attempt.generation
            began.resolve()
            await cleanup.promise
            assert.equal(attempt.isCurrent(), false)
            assert.equal(attempt.signal.aborted, true)
            if (cleanupFails) throw new Error('old connection cleanup failed')
          }
          return true
        } finally {
          active -= 1
        }
      },
      {
        load: () => null,
        save: (state) => {
          if (state.preparedRelease) ready.push(state.preparedRelease)
        },
        failed: (error) => {
          errors.push(error)
        },
      }
    )
    queue.offer(first)
    await began.promise
    assert.equal(queue.invalidate(first.id, generation), true)
    for (const candidate of builds.slice(1)) assert.equal(queue.offer(candidate), true)
    assert.deepEqual(started, [first.id])
    cleanup.resolve()
    await queue.settled()
    assert.deepEqual(started, [first.id, latest.id])
    assert.deepEqual(ready, [latest.id])
    assert.equal(peak, 1)
    assert.equal(active, 0)
    assert.equal(errors.length, cleanupFails ? 1 : 0)
    assert.equal(queue.invalidate(first.id, generation), false)
    for (const candidate of builds.slice(0, -1)) assert.equal(queue.commit(candidate.id), false)
    assert.equal(queue.commit(latest.id), true)
  })
}

test('failed invalidation persistence cannot retain in-memory restart permission', async () => {
  const candidate = release('202609281000')
  const errors: unknown[] = []
  let generation = 0,
    fail = false
  let persisted: PreparationCheckpoint | null = null
  const queue = new UpdatePreparation(
    async (attempt) => {
      generation = attempt.generation
      return true
    },
    {
      load: () => null,
      save: (state) => {
        if (fail) throw new Error('checkpoint disk unavailable')
        persisted = state
      },
      failed: (error) => {
        errors.push(error)
      },
    }
  )
  queue.offer(candidate)
  await queue.settled()
  fail = true
  queue.invalidate(candidate.id, generation)
  assert.equal(queue.commit(candidate.id), false)
  assert.equal(errors.length, 1)
  queue.retry()
  await queue.settled()
  assert.equal(queue.commit(candidate.id), false)
  assert.equal(errors.length, 2)
  let attempts = 0
  const restarted = new UpdatePreparation(
    async () => {
      attempts += 1
      return true
    },
    {
      load: () => persisted,
      save: () => {},
      failed: (error) => assert.fail(String(error)),
    }
  )
  assert.equal(restarted.commit(candidate.id), false)
  assert.equal(attempts, 0)
  restarted.offer(candidate)
  await restarted.settled()
  assert.equal(attempts, 1)
  assert.equal(restarted.commit(candidate.id), true)
})

test('paused completed preparation still loses readiness when its native receipt expires', async () => {
  const candidate = release('202609281000')
  let generation = 0
  let current = () => false
  let attempts = 0
  let prepared: string | null = null
  const queue = new UpdatePreparation(
    async (attempt) => {
      generation = attempt.generation
      current = attempt.isCurrent
      attempts += 1
      return true
    },
    {
      load: () => null,
      save: (state) => {
        prepared = state.preparedRelease
      },
      failed: (error) => assert.fail(String(error)),
    }
  )
  queue.offer(candidate)
  await queue.settled()
  await queue.pause()
  assert.equal(queue.commit(candidate.id), false)
  // The connection owns the completed receipt even while downloads are paused.
  assert.equal(current(), true)
  assert.equal(queue.invalidate(candidate.id, generation), true)
  assert.equal(prepared, null)
  queue.resume()
  await queue.settled()
  assert.equal(attempts, 1)
  assert.equal(queue.commit(candidate.id), false)
  queue.retry()
  await queue.settled()
  assert.equal(attempts, 2)
  assert.equal(queue.commit(candidate.id), true)
})

test('a preparation commitment has one owner until explicit release', async () => {
  const candidate = release('202610091000')
  const next = release('202610091001')
  let preparations = 0
  const queue = new UpdatePreparation(async () => {
    preparations++
    return true
  })
  queue.offer(candidate)
  await queue.settled()
  assert.equal(queue.commit(candidate.id), true)
  assert.equal(queue.commit(candidate.id), false)
  queue.retry()
  assert.equal(queue.offer(next), false)
  await queue.settled()
  assert.equal(preparations, 1)
  queue.release()
  assert.equal(queue.offer(next), true)
  await queue.settled()
  assert.equal(queue.commit(next.id), true)
  assert.equal(preparations, 2)
})

for (const restored of [false, true]) {
  test(`restart pins ${restored ? 'restored' : 'live'} preparation across later publications`, async () => {
    const first = release('202610131000')
    const next = release('202610131001')
    const started: string[] = []
    const queue = new UpdatePreparation(async ({ candidate }) => {
      started.push(candidate.id)
      return true
    })
    if (!restored) {
      queue.offer(first)
      await queue.settled()
    }
    assert.equal(queue.claim(first), true)
    // A check already in flight resolves after the click; repeated publications
    // cannot schedule new preparation or change the installation target.
    await Promise.resolve()
    assert.equal(queue.offer(next), false)
    queue.retry()
    await queue.settled()
    assert.equal(queue.candidate?.id, first.id)
    assert.deepEqual(started, restored ? [] : [first.id])
    assert.equal(queue.claim(first), false)
    queue.release()
    assert.equal(queue.offer(next), true)
    await queue.settled()
    assert.equal(queue.claim(next), true)
  })
}

test('restart cannot claim stale or unfinished preparation', async () => {
  const pending = deferred()
  const first = release('202610131000')
  const next = release('202610131001')
  const queue = new UpdatePreparation(async () => {
    await pending.promise
    return true
  })
  queue.offer(next)
  assert.equal(queue.claim(first), false)
  assert.equal(queue.claim(next), false)
  pending.resolve()
  await queue.settled()
  assert.equal(queue.claim(first), false)
  assert.equal(queue.claim(next), true)
})

test('a released restart with lost evidence can rebuild the same completed candidate', async () => {
  let preparations = 0
  const candidate = release('202610131200')
  const queue = new UpdatePreparation(async () => {
    preparations++
    return true
  })
  queue.offer(candidate)
  await queue.settled()
  assert.equal(queue.claim(candidate), true)
  queue.release()
  assert.equal(queue.offer(candidate), false)
  queue.retry()
  await queue.settled()
  assert.equal(preparations, 2)
  assert.equal(queue.claim(candidate), true)
})

test('scope reset drains obsolete worker and allows an eligible lower candidate without lowering installed version', async () => {
  const started = deferred(),
    stopped = deferred()
  const attempted: string[] = []
  const higher = { ...release('202610201200'), version: '0.3.0' }
  const lower = { ...release('202610201300'), version: '0.2.1' }
  const queue = new UpdatePreparation(async ({ candidate, signal, isCurrent }) => {
    attempted.push(candidate.version)
    if (candidate.version === higher.version) {
      started.resolve()
      await stopped.promise
      assert.equal(signal.aborted, true)
      assert.equal(isCurrent(), false)
    }
    return true
  })
  queue.request(higher)
  await started.promise
  const reset = queue.reset()
  assert.equal(queue.running, true)
  stopped.resolve()
  await reset
  assert.equal(queue.candidate, null)
  assert.equal(queue.latest, null)
  assert.equal(queue.request(lower), true)
  await queue.settled()
  assert.equal(queue.claim(lower), true)
  assert.deepEqual(attempted, ['0.3.0', '0.2.1'])
  await assert.rejects(queue.reset(), /handoff/)
})

test('scope reset clears restored coalescing and ready state before next candidate', async () => {
  const higher = { ...release('202610201200'), version: '0.3.0' }
  const lower = { ...release('202610201300'), version: '0.2.1' }
  const queue = new UpdatePreparation(async () => true, undefined, TEST_POLICY)
  queue.request(higher)
  await queue.settled()
  assert.equal(queue.decision(true).reason, 'already-ready')
  await queue.reset()
  queue.observe(lower)
  assert.equal(queue.background(true), true)
  await queue.settled()
  assert.equal(queue.claim(lower), true)
})
