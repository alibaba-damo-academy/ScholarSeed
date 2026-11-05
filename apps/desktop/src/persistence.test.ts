import assert from 'node:assert/strict'
import test from 'node:test'

import { PreferenceWriter } from './persistence.ts'
import {
  PREFERENCE_DIAGNOSTIC_PREFIX,
  PREFERENCE_SUBMISSION_SOURCE,
} from './preference-diagnostics.ts'
import {
  DEFAULT_RENDERER_PREFERENCES,
  defaultRendererPreferences,
  rendererLanguagePatch,
  sanitizeRendererPreferences,
  systemRendererPreferences,
  SYSTEM_LANGUAGE_MODE,
} from './preferences.ts'
import { defaultSelectionPrompts, selectionInstruction } from './prompts.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('system refresh is read-only and stops after an explicit language choice', async () => {
  const initial = systemRendererPreferences('zh')
  const applied: string[] = []
  let reads = 0
  let writes = 0
  const writer = new PreferenceWriter(initial, {
    save: async (value) => {
      writes += 1
      return value
    },
    reconcile: async () => {
      reads += 1
      return systemRendererPreferences('en')
    },
    apply: async (value) => {
      applied.push(value.language)
    },
    failed: () => assert.fail('unexpected preference failure'),
  })
  await writer.refreshSystemLanguage(() => false)
  assert.equal(reads, 0)
  await writer.refreshSystemLanguage(() => true)
  assert.equal(writer.current().language, 'en')
  assert.equal(writer.current().languageMode, SYSTEM_LANGUAGE_MODE)
  assert.deepEqual(applied, ['en'])
  assert.equal(writes, 0)

  assert.equal(await writer.submitConfirmed(rendererLanguagePatch('en')), true)
  await writer.refreshSystemLanguage(() => true)
  assert.equal(reads, 1)
  assert.equal(writes, 1)
})

for (const stage of ['read', 'apply'] as const) {
  test(`system refresh ${stage} failure is observable, blocks shutdown and retries without writing`, async () => {
    const initial = systemRendererPreferences('zh')
    let failing = true
    let failures = 0
    let projected = initial.language
    const writer = new PreferenceWriter(initial, {
      save: async () => assert.fail('refresh must not write'),
      reconcile: async () => {
        if (stage === 'read' && failing) throw new Error('read failed')
        return systemRendererPreferences('en')
      },
      apply: async (value) => {
        projected = value.language
        if (stage === 'apply' && failing && value.language === 'en') throw new Error('apply failed')
      },
      failed: () => {
        failures += 1
      },
    })
    await writer.refreshSystemLanguage(() => true)
    assert.equal(failures, 1)
    assert.equal(writer.current().language, 'zh')
    assert.equal(projected, 'zh')
    await assert.rejects(writer.prepareShutdown(), /ERR_PREFERENCES_UNSAVED/)
    writer.resume()
    failing = false
    await writer.retry()
    assert.equal(writer.current().language, 'en')
    assert.equal(projected, 'en')
    await writer.prepareShutdown()
  })
}

test('a confirmed explicit choice repairs a failed system refresh before shutdown', async () => {
  const writer = new PreferenceWriter(systemRendererPreferences('zh'), {
    save: async (value) => value,
    reconcile: async () => {
      throw new Error('read failed')
    },
    apply: async () => undefined,
    failed: () => undefined,
  })
  await writer.refreshSystemLanguage(() => true)
  assert.equal(await writer.submitConfirmed(rendererLanguagePatch('en')), true)
  await writer.prepareShutdown()
  assert.equal(writer.current().language, 'en')
})

test('a focus refresh does not replace an editor projection that became unsafe during IPC', async () => {
  const initial = systemRendererPreferences('en')
  const response = deferred<typeof initial>()
  let safe = true
  const writer = new PreferenceWriter(initial, {
    save: async () => assert.fail('focus must not write preferences'),
    reconcile: () => response.promise,
    apply: async () => assert.fail('editor state must stay intact'),
    failed: () => assert.fail('unexpected preference failure'),
  })
  const refresh = writer.refreshSystemLanguage(() => safe)
  safe = false
  response.resolve(systemRendererPreferences('zh'))
  await refresh
  assert.equal(writer.current().language, 'en')
})

test('prompt defaults only become durable through an explicit save and language changes retain one instruction map', async () => {
  let disk = defaultRendererPreferences('zh')
  const original = structuredClone(disk.selectionPrompts)
  const port = {
    save: async (value: typeof disk) => {
      disk = sanitizeRendererPreferences(JSON.parse(JSON.stringify(value)))
      return disk
    },
    reconcile: async () => disk,
    apply: async () => undefined,
    failed: () => assert.fail('unexpected save failure'),
  }
  const writer = new PreferenceWriter(disk, port)
  await writer.submit({ language: 'en' }, PREFERENCE_SUBMISSION_SOURCE.language)
  assert.deepEqual(disk.selectionPrompts, original)
  const draft = {
    ...writer.current().selectionPrompts,
    explain: defaultSelectionPrompts('en').explain,
  }
  assert.deepEqual(disk.selectionPrompts, original)
  await writer.submit({ selectionPrompts: draft }, PREFERENCE_SUBMISSION_SOURCE.prompts)
  const restarted = new PreferenceWriter(
    sanitizeRendererPreferences(JSON.parse(JSON.stringify(disk))),
    port
  )
  await restarted.submit({ language: 'zh' }, PREFERENCE_SUBMISSION_SOURCE.language)
  assert.deepEqual(disk.selectionPrompts, draft)
  assert.equal(selectionInstruction(restarted.current().selectionPrompts, 'explain'), draft.explain)
  assert.equal(disk.selectionPrompts.translate, original.translate)
})

test('cleared message versions are saved and retained by a fresh preference writer', async () => {
  let disk = sanitizeRendererPreferences({})
  const port = {
    save: async (value: typeof disk) => {
      disk = sanitizeRendererPreferences(JSON.parse(JSON.stringify(value)))
      return disk
    },
    reconcile: async () => disk,
    apply: async () => undefined,
    failed: () => assert.fail('unexpected save failure'),
  }
  const dismissed = { [JSON.stringify(['imports', 'completed-task'])]: 7 }
  const writer = new PreferenceWriter(disk, port)
  await writer.submit({ taskMessageDismissals: dismissed })
  await writer.prepareShutdown()
  assert.deepEqual(disk.taskMessageDismissals, dismissed)
  const restarted = new PreferenceWriter(disk, port)
  await restarted.submit({ theme: 'dark' })
  assert.deepEqual(restarted.current().taskMessageDismissals, dismissed)
})

test('shutdown freezes submissions and drains the in-flight and latest pending saves', async () => {
  let disk = { ...DEFAULT_RENDERER_PREFERENCES }
  const gate = deferred<void>()
  let saves = 0
  const writer = new PreferenceWriter(disk, {
    save: async (value) => {
      if (++saves === 1) await gate.promise
      disk = value
      return disk
    },
    reconcile: async () => disk,
    apply: async () => {
      void writer.submit({ theme: 'light' })
    },
    failed: () => assert.fail('unexpected failure'),
  })
  void writer.submit({ theme: 'dark' })
  void writer.submit({ language: 'en' })
  let drained = false
  const shutdown = writer.prepareShutdown().then((receipt) => {
    drained = true
    return receipt
  })
  assert.equal(writer.isFrozen(), true)
  await writer.submit({ language: 'zh' })
  await writer.retry()
  assert.equal(drained, false)
  gate.resolve()
  const receipt = await shutdown
  assert.equal(receipt.acknowledgedRevision, 2)
  assert.equal(disk.theme, 'dark')
  assert.equal(disk.language, 'en')
  assert.equal(saves, 2)
  writer.resume()
  await writer.submit({ language: 'zh' })
  assert.equal(disk.language, 'zh')
})

test('failed save blocks shutdown without retrying, cancellation permits explicit recovery', async () => {
  let disk = { ...DEFAULT_RENDERER_PREFERENCES }
  let fail = true
  let saves = 0
  const writer = new PreferenceWriter(disk, {
    save: async (value) => {
      saves++
      if (fail) throw Error('disk')
      disk = value
      return disk
    },
    reconcile: async () => disk,
    apply: async () => {},
    failed: () => {},
  })
  await writer.submit({ theme: 'dark' })
  await assert.rejects(writer.prepareShutdown(), /ERR_PREFERENCES_UNSAVED/)
  assert.equal(saves, 1)
  writer.resume()
  fail = false
  await writer.retry()
  await writer.prepareShutdown()
  assert.equal(disk.theme, 'dark')
  assert.equal(saves, 2)
})

test('diagnostics correlate sources, semantic changed fields and acknowledged revisions without values', async () => {
  let disk = { ...DEFAULT_RENDERER_PREFERENCES }
  const lines: string[] = []
  const writer = new PreferenceWriter(disk, {
    save: async (value, submission) => {
      assert.equal(submission.submittedRevision, 1)
      disk = value
      return disk
    },
    reconcile: async () => disk,
    apply: async () => {},
    failed: () => assert.fail('unexpected failure'),
    diagnostic: (line) => lines.push(line),
  })
  await writer.submit(
    {
      theme: 'dark',
      recentFiles: [{ projectId: 'secret-project', path: 'private-path', openedAt: 9 }],
    },
    PREFERENCE_SUBMISSION_SOURCE.automatic
  )
  const records = lines.map((line) => JSON.parse(line.slice(PREFERENCE_DIAGNOSTIC_PREFIX.length)))
  assert.deepEqual(records[0].submissionSources, ['state-effect'])
  assert.deepEqual(records[0].changedFields, ['theme', 'recentFiles'])
  assert.equal(records[0].submittedRevision, 1)
  assert.equal(records[0].acknowledgedRevision, 0)
  assert.equal(records[1].acknowledgedRevision, 1)
  assert.equal(records[0].writerId, records[1].writerId)
  assert.doesNotMatch(lines.join(''), /secret-project|private-path|dark/)
})

test('language round trip and concurrent theme are serialized without stale language writes', async () => {
  let disk = { ...DEFAULT_RENDERER_PREFERENCES }
  const gate = deferred<void>()
  const saved: (typeof disk)[] = []
  const applied: string[] = []
  const writer = new PreferenceWriter(disk, {
    save: async (value) => {
      saved.push(value)
      if (saved.length === 1) await gate.promise
      disk = value
      return disk
    },
    reconcile: async () => disk,
    apply: async (value) => {
      applied.push(value.language)
    },
    failed: () => assert.fail('unexpected failure'),
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

test('navigation changes keep only the newest location while preserving concurrent preferences', async () => {
  let disk = { ...DEFAULT_RENDERER_PREFERENCES }
  const gate = deferred<void>()
  let saves = 0
  const writer = new PreferenceWriter(disk, {
    save: async (value) => {
      if (++saves === 1) await gate.promise
      disk = value
      return disk
    },
    reconcile: async () => disk,
    apply: async () => {},
    failed: () => assert.fail('unexpected failure'),
  })
  const first = sanitizeRendererPreferences({ lastLocation: { view: 'literature' } }).lastLocation
  const last = sanitizeRendererPreferences({
    lastLocation: { view: 'resource', projectId: 'project-a' },
  }).lastLocation
  const done = writer.submit({ lastLocation: first })
  void writer.submit({ theme: 'dark' })
  void writer.submit({ lastLocation: last })
  gate.resolve()
  await done
  assert.deepEqual(disk.lastLocation, last)
  assert.equal(disk.theme, 'dark')
  assert.equal(saves, 2)
})

test('failed write does not commit language or loop, retry applies the intent', async () => {
  let disk = { ...DEFAULT_RENDERER_PREFERENCES }
  let fail = true
  let errors = 0
  let language = disk.language
  const writer = new PreferenceWriter(disk, {
    save: async (value) => {
      if (fail) throw Error('disk')
      disk = value
      return disk
    },
    reconcile: async () => disk,
    apply: async (value) => {
      language = value.language
    },
    failed: () => {
      errors++
    },
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
    save: async (value) => {
      disk = value
      return disk
    },
    reconcile: async () => disk,
    apply: async (value) => {
      if (fail) throw Error('projection')
      language = value.language
    },
    failed: () => {},
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
    save: async (value) => {
      if (fail) throw Error('disk')
      disk = value
      return disk
    },
    reconcile: async () => disk,
    apply: async () => {},
    failed: () => {},
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
    save: async (value) => {
      if (first) {
        first = false
        await gate.promise
        throw Error('disk')
      }
      disk = value
      return disk
    },
    reconcile: async () => disk,
    apply: async () => {},
    failed: () => {},
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
    recentFiles: [{ projectId: 'project', path: 'paper.pdf', openedAt: 3 }],
  })
  let saves = 0
  const writer: PreferenceWriter = new PreferenceWriter(disk, {
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
        recentFiles: [...value.recentFiles],
      })
    },
    failed: () => assert.fail('unexpected failure'),
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
    apply: async (value) => {
      applied.push(value.onboarding)
    },
    failed: () => assert.fail('unexpected failure'),
  })

  await writer.submit({ onboarding: { seen: { globalLib: true } } })

  assert.ok(disk.onboarding)
  assert.equal(disk.onboarding.seen.globalLib, true)
  assert.deepEqual(applied.at(-1), { seen: { globalLib: true } })
})

test('the writer exposes only the last fully committed preference snapshot', async () => {
  const gate = deferred<void>()
  let disk = { ...DEFAULT_RENDERER_PREFERENCES }
  const writer = new PreferenceWriter(disk, {
    save: async (value) => {
      await gate.promise
      disk = value
      return disk
    },
    reconcile: async () => disk,
    apply: async () => {},
    failed: () => assert.fail('unexpected failure'),
  })

  const pending = writer.submit({ language: 'en' })
  assert.equal(writer.current().language, 'zh')
  gate.resolve()
  await pending
  assert.equal(writer.current().language, 'en')
})

test('confirmed submissions wait for acknowledgement and accept only durable no-ops', async () => {
  let disk = { ...DEFAULT_RENDERER_PREFERENCES }
  const gate = deferred<void>()
  let saves = 0
  const writer = new PreferenceWriter(disk, {
    save: async (value) => {
      saves += 1
      await gate.promise
      disk = value
      return disk
    },
    reconcile: async () => disk,
    apply: async () => {},
    failed: () => assert.fail('unexpected failure'),
  })
  let confirmed = false
  const patch = { reasoningPreferences: { model: 'high' } }
  const saving = writer.submitConfirmed(patch).then((saved) => {
    confirmed = saved
    return saved
  })
  assert.equal(confirmed, false)
  assert.deepEqual(writer.current().reasoningPreferences ?? {}, {})
  gate.resolve()
  assert.equal(await saving, true)
  assert.equal(await writer.submitConfirmed(patch), true)
  assert.equal(saves, 1)
  await writer.prepareShutdown()
  assert.equal(await writer.submitConfirmed(patch), false)
  assert.equal(saves, 1)
})

test('confirmed initial preferences are durable no-ops without a new write', async () => {
  const initial = { ...DEFAULT_RENDERER_PREFERENCES, reasoningPreferences: { model: 'high' } }
  const writer = new PreferenceWriter(initial, {
    save: async () => assert.fail('a confirmed no-op must not write'),
    reconcile: async () => assert.fail('a confirmed no-op must not reconcile'),
    apply: async () => assert.fail('a confirmed no-op must not project'),
    failed: () => assert.fail('unexpected failure'),
  })
  assert.equal(await writer.submitConfirmed({ reasoningPreferences: { model: 'high' } }), true)
})

for (const explicitRetry of [false, true]) {
  test(`reconciled values need a real acknowledgement through ${explicitRetry ? 'retry' : 'another confirmation'}`, async () => {
    let disk = { ...DEFAULT_RENDERER_PREFERENCES }
    let saves = 0
    let failures = 0
    const writer = new PreferenceWriter(disk, {
      save: async (value) => {
        disk = value
        if (++saves === 1) throw Error('receipt unavailable')
        return disk
      },
      reconcile: async () => disk,
      apply: async () => {},
      failed: () => {
        failures += 1
      },
    })
    const patch = { reasoningPreferences: { model: 'high' } }
    assert.equal(await writer.submitConfirmed(patch), false)
    assert.deepEqual(writer.current().reasoningPreferences, patch.reasoningPreferences)
    assert.equal(saves, 1)
    assert.equal(failures, 1)
    if (explicitRetry) await writer.retry()
    assert.equal(await writer.submitConfirmed(patch), true)
    assert.equal(saves, 2)
  })
}

test('a failed confirmed batch stays failed when a later same-value batch succeeds', async () => {
  let disk = { ...DEFAULT_RENDERER_PREFERENCES }
  const gate = deferred<void>()
  let saves = 0
  const writer = new PreferenceWriter(disk, {
    save: async (value) => {
      disk = value
      if (++saves === 1) {
        await gate.promise
        throw Error('receipt unavailable')
      }
      return disk
    },
    reconcile: async () => disk,
    apply: async () => {},
    failed: () => {},
  })
  const patch = { reasoningPreferences: { model: 'high' } }
  const first = writer.submitConfirmed(patch)
  const second = writer.submitConfirmed(patch)
  gate.resolve()
  assert.equal(await first, false)
  assert.equal(await second, true)
  assert.equal(saves, 2)
})

test('coalesced confirmations distinguish superseded values and retain unrelated automatic patches', async () => {
  let disk = { ...DEFAULT_RENDERER_PREFERENCES }
  const gate = deferred<void>()
  let saves = 0
  const writer = new PreferenceWriter(disk, {
    save: async (value) => {
      if (++saves === 1) await gate.promise
      disk = value
      return disk
    },
    reconcile: async () => disk,
    apply: async () => {},
    failed: () => assert.fail('unexpected failure'),
  })
  void writer.submit({ theme: 'dark' }, PREFERENCE_SUBMISSION_SOURCE.automatic)
  const first = writer.submitConfirmed({ reasoningPreferences: { model: 'low' } })
  const second = writer.submitConfirmed({ reasoningPreferences: { model: 'high' } })
  void writer.submit({ editorWordWrap: false }, PREFERENCE_SUBMISSION_SOURCE.automatic)
  gate.resolve()
  assert.equal(await first, false)
  assert.equal(await second, true)
  assert.equal(saves, 2)
  assert.equal(disk.theme, 'dark')
  assert.equal(disk.editorWordWrap, false)
  assert.deepEqual(disk.reasoningPreferences, { model: 'high' })
})

test('failed reconciliation rejects confirmation without spinning and remains explicitly retryable', async () => {
  let disk = { ...DEFAULT_RENDERER_PREFERENCES }
  let failing = true
  let saves = 0
  const writer = new PreferenceWriter(disk, {
    save: async (value) => {
      saves += 1
      if (failing) throw Error('disk unavailable')
      disk = value
      return disk
    },
    reconcile: async () => {
      if (failing) throw Error('read unavailable')
      return disk
    },
    apply: async () => {},
    failed: () => {},
  })
  const patch = { reasoningPreferences: { model: 'high' } }
  assert.equal(await writer.submitConfirmed(patch), false)
  assert.equal(await writer.submitConfirmed(patch), false)
  assert.equal(saves, 1)
  failing = false
  await writer.retry()
  assert.equal(await writer.submitConfirmed(patch), true)
  assert.equal(saves, 2)
})

test('confirmed batches report projection failure even after the save was acknowledged', async () => {
  let disk = { ...DEFAULT_RENDERER_PREFERENCES }
  let failing = true
  let saves = 0
  const writer = new PreferenceWriter(disk, {
    save: async (value) => {
      saves += 1
      disk = value
      return disk
    },
    reconcile: async () => disk,
    apply: async () => {
      if (failing) throw Error('projection unavailable')
    },
    failed: () => {},
  })
  const patch = { reasoningPreferences: { model: 'high' } }
  assert.equal(await writer.submitConfirmed(patch), false)
  failing = false
  await writer.retry()
  assert.equal(await writer.submitConfirmed(patch), true)
  assert.equal(saves, 1)
})

test('confirmed submissions follow a drain restarted from its finalizer', async () => {
  let disk = { ...DEFAULT_RENDERER_PREFERENCES }
  const gate = deferred<void>()
  const started = deferred<void>()
  let saving: Promise<boolean> | undefined
  let saves = 0
  const writer = new PreferenceWriter(disk, {
    save: async (value) => {
      if (++saves === 2) {
        started.resolve()
        await gate.promise
      }
      disk = value
      return disk
    },
    reconcile: async () => disk,
    apply: async () => {},
    diagnostic: (line) => {
      const record = JSON.parse(line.slice(PREFERENCE_DIAGNOSTIC_PREFIX.length))
      if (
        record.stage === 'save' &&
        record.result === 'completed' &&
        record.acknowledgedRevision === 1
      )
        queueMicrotask(() => {
          saving = writer.submitConfirmed({ reasoningPreferences: { model: 'high' } })
        })
    },
    failed: () => assert.fail('unexpected failure'),
  })
  await writer.submit({ theme: 'dark' })
  await started.promise
  gate.resolve()
  assert.equal(await saving, true)
  assert.deepEqual(disk.reasoningPreferences, { model: 'high' })
})

test('old acknowledgements cannot bounce automatic MRU effects back into saving', async () => {
  const initial = { ...DEFAULT_RENDERER_PREFERENCES }
  const gates: Array<() => void> = []
  const effects: Array<() => void> = []
  const saved: (typeof initial)[] = []
  const writer = new PreferenceWriter(initial, {
    save: (value) => {
      saved.push(value)
      return new Promise((resolve) => gates.push(() => resolve(value)))
    },
    reconcile: async () => initial,
    apply: async (value, project) => {
      const projected = project?.() ?? value
      effects.push(() => {
        void writer.submit(
          { recentLiterature: projected.recentLiterature },
          PREFERENCE_SUBMISSION_SOURCE.automatic
        )
      })
    },
    failed: () => assert.fail('unexpected failure'),
  })
  void writer.submit(
    { theme: 'dark', recentLiterature: [] },
    PREFERENCE_SUBMISSION_SOURCE.automatic
  )
  void writer.submit(
    { recentLiterature: [{ id: 'literature', openedAt: 1 }] },
    PREFERENCE_SUBMISSION_SOURCE.automatic
  )
  for (let step = 0; step < 6; step++) {
    gates.shift()?.()
    await new Promise<void>((resolve) => setImmediate(resolve))
    effects.shift()?.()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.equal(saved.length, 2)
  assert.deepEqual(saved.at(-1)?.recentLiterature, [{ id: 'literature', openedAt: 1 }])
})

test('projection observes automatic intent arriving during asynchronous apply without committing it', async () => {
  const entered = deferred<void>()
  const gate = deferred<void>()
  const projected: Array<typeof DEFAULT_RENDERER_PREFERENCES> = []
  const writer = new PreferenceWriter(DEFAULT_RENDERER_PREFERENCES, {
    save: async (value) => value,
    reconcile: async () => DEFAULT_RENDERER_PREFERENCES,
    apply: async (value, project) => {
      if (!projected.length) {
        entered.resolve()
        await gate.promise
      }
      projected.push(project?.() ?? value)
    },
    failed: () => assert.fail('unexpected failure'),
  })
  const done = writer.submit({ language: 'en' }, PREFERENCE_SUBMISSION_SOURCE.language)
  await entered.promise
  void writer.submit(
    { recentLiterature: [{ id: 'literature', openedAt: 2 }], language: 'zh' },
    PREFERENCE_SUBMISSION_SOURCE.automatic
  )
  assert.deepEqual(writer.current().recentLiterature, [])
  gate.resolve()
  await done
  assert.deepEqual(projected[0].recentLiterature, [{ id: 'literature', openedAt: 2 }])
  assert.equal(projected[0].language, 'en')
  assert.equal(projected.at(-1)?.language, 'zh')
})

for (const latestSource of [
  PREFERENCE_SUBMISSION_SOURCE.automatic,
  PREFERENCE_SUBMISSION_SOURCE.explicit,
]) {
  test(`projection respects the latest ${latestSource} source of each pending field`, async () => {
    const gate = deferred<void>()
    const projected: Array<typeof DEFAULT_RENDERER_PREFERENCES> = []
    let first = true
    const writer = new PreferenceWriter(DEFAULT_RENDERER_PREFERENCES, {
      save: async (value) => {
        if (first) {
          first = false
          await gate.promise
        }
        return value
      },
      reconcile: async () => DEFAULT_RENDERER_PREFERENCES,
      apply: async (value, project) => {
        projected.push(project?.() ?? value)
      },
      failed: () => assert.fail('unexpected failure'),
    })
    const done = writer.submit({ theme: 'dark' })
    void writer.submit({ editorWordWrap: true }, PREFERENCE_SUBMISSION_SOURCE.automatic)
    void writer.submit({ editorWordWrap: false }, latestSource)
    gate.resolve()
    await done
    assert.equal(
      projected[0].editorWordWrap,
      latestSource === PREFERENCE_SUBMISSION_SOURCE.automatic
        ? false
        : DEFAULT_RENDERER_PREFERENCES.editorWordWrap
    )
    assert.equal(writer.current().editorWordWrap, false)
  })
}

test('failed-save reconciliation preserves later automatic MRU intent without claiming it committed', async () => {
  const gate = deferred<void>()
  const projected: Array<typeof DEFAULT_RENDERER_PREFERENCES> = []
  let disk = { ...DEFAULT_RENDERER_PREFERENCES }
  let first = true
  const writer = new PreferenceWriter(disk, {
    save: async (value) => {
      if (first) {
        first = false
        await gate.promise
        throw Error('disk')
      }
      disk = value
      return disk
    },
    reconcile: async () => disk,
    apply: async (value, project) => {
      projected.push(project?.() ?? value)
    },
    failed: () => {},
  })
  const done = writer.submit({ language: 'en' })
  void writer.submit(
    { recentLiterature: [{ id: 'literature', openedAt: 3 }] },
    PREFERENCE_SUBMISSION_SOURCE.automatic
  )
  gate.resolve()
  await done
  assert.equal(projected[0].language, 'zh')
  assert.deepEqual(projected[0].recentLiterature, [{ id: 'literature', openedAt: 3 }])
  assert.equal(writer.current().language, 'zh')
  await writer.retry()
  assert.equal(writer.current().language, 'en')
})

test('shutdown drains queued automatic intent while refusing projection feedback submissions', async () => {
  const gate = deferred<void>()
  const projected: Array<typeof DEFAULT_RENDERER_PREFERENCES> = []
  let saves = 0
  const writer = new PreferenceWriter(DEFAULT_RENDERER_PREFERENCES, {
    save: async (value) => {
      if (++saves === 1) await gate.promise
      return value
    },
    reconcile: async () => DEFAULT_RENDERER_PREFERENCES,
    apply: async (value, project) => {
      projected.push(project?.() ?? value)
      void writer.submit({ recentLiterature: [] }, PREFERENCE_SUBMISSION_SOURCE.automatic)
    },
    failed: () => assert.fail('unexpected failure'),
  })
  void writer.submit({ theme: 'dark' })
  void writer.submit(
    { recentLiterature: [{ id: 'literature', openedAt: 4 }] },
    PREFERENCE_SUBMISSION_SOURCE.automatic
  )
  const shutdown = writer.prepareShutdown()
  gate.resolve()
  const receipt = await shutdown
  assert.deepEqual(projected[0].recentLiterature, [{ id: 'literature', openedAt: 4 }])
  assert.equal(saves, 2)
  assert.equal(receipt.acknowledgedRevision, 2)
})

test('a deferred React projection retains newer in-flight automatic intent and later canonical acknowledgements', async () => {
  const gates: Array<() => void> = []
  const projections: Array<() => typeof DEFAULT_RENDERER_PREFERENCES> = []
  const writer = new PreferenceWriter(DEFAULT_RENDERER_PREFERENCES, {
    save: (value) => new Promise((resolve) => gates.push(() => resolve(value))),
    reconcile: async () => DEFAULT_RENDERER_PREFERENCES,
    apply: async (_value, project) => {
      projections.push(project)
    },
    failed: () => assert.fail('unexpected failure'),
  })
  const done = writer.submit({ language: 'en' })
  void writer.submit(
    { recentLiterature: [{ id: 'literature', openedAt: 5 }] },
    PREFERENCE_SUBMISSION_SOURCE.automatic
  )
  gates.shift()?.()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(projections[0]().recentLiterature, [{ id: 'literature', openedAt: 5 }])
  void writer.submit({ language: 'zh', editorWordWrap: false })
  gates.shift()?.()
  await new Promise<void>((resolve) => setImmediate(resolve))
  gates.shift()?.()
  await done
  assert.equal(projections[0]().language, 'zh')
  assert.equal(projections[0]().editorWordWrap, false)
  assert.deepEqual(projections[0]().recentLiterature, [{ id: 'literature', openedAt: 5 }])
})

test('a delayed old updater cannot restore fields or language older than the latest successful save', async () => {
  const projections: Array<() => typeof DEFAULT_RENDERER_PREFERENCES> = []
  const writer = new PreferenceWriter(DEFAULT_RENDERER_PREFERENCES, {
    save: async (value) => value,
    reconcile: async () => DEFAULT_RENDERER_PREFERENCES,
    apply: async (_value, project) => {
      projections.push(project)
    },
    failed: () => assert.fail('unexpected failure'),
  })
  await writer.submit({ language: 'en' })
  await writer.submit({ language: 'zh', editorWordWrap: false })
  assert.equal(projections[0]().language, 'zh')
  assert.equal(projections[0]().editorWordWrap, false)
})

for (const laterAutomatic of [false, true]) {
  test(`failed automatic intent rolls back without hiding ${laterAutomatic ? 'newer pending' : 'canonical'} state`, async () => {
    const gate = deferred<void>()
    const projected: Array<typeof DEFAULT_RENDERER_PREFERENCES> = []
    let disk = { ...DEFAULT_RENDERER_PREFERENCES }
    let first = true
    const writer = new PreferenceWriter(disk, {
      save: async (value) => {
        if (first) {
          first = false
          await gate.promise
          throw Error('disk')
        }
        disk = value
        return disk
      },
      reconcile: async () => disk,
      apply: async (_value, project) => {
        projected.push(project())
      },
      failed: () => {},
    })
    const done = writer.submit(
      { recentLiterature: [{ id: 'failed', openedAt: 1 }] },
      PREFERENCE_SUBMISSION_SOURCE.automatic
    )
    if (laterAutomatic)
      void writer.submit(
        { recentLiterature: [{ id: 'newer', openedAt: 2 }] },
        PREFERENCE_SUBMISSION_SOURCE.automatic
      )
    gate.resolve()
    await done
    assert.deepEqual(
      projected[0].recentLiterature,
      laterAutomatic ? [{ id: 'newer', openedAt: 2 }] : []
    )
  })
}

for (const failureStage of ['save', 'apply', 'reconcile', 'reconcile-apply'] as const) {
  test(`preference diagnostics distinguish ${failureStage} and retain retry behavior`, async () => {
    let disk = { ...DEFAULT_RENDERER_PREFERENCES }
    let failing = true
    let failures = 0
    const lines: string[] = []
    const writer = new PreferenceWriter(disk, {
      diagnostic: (line) => lines.push(line),
      save: async (value) => {
        if (failing && failureStage !== 'apply') throw Error('private save error')
        disk = value
        return disk
      },
      apply: async () => {
        if (failing && (failureStage === 'apply' || failureStage === 'reconcile-apply'))
          throw Error('private projection error')
      },
      reconcile: async () => {
        if (failing && failureStage === 'reconcile') throw Error('private read error')
        return disk
      },
      failed: () => {
        failures += 1
      },
    })
    await writer.submit({ language: 'en' })
    assert.equal(failures, 1)
    const records = lines.map((line) => JSON.parse(line.slice(PREFERENCE_DIAGNOSTIC_PREFIX.length)))
    assert.ok(records.some((entry) => entry.stage === failureStage && entry.result === 'failed'))
    assert.doesNotMatch(lines.join(''), /private/)
    failing = false
    await writer.retry()
    assert.equal(disk.language, 'en')
    assert.equal(failures, 1)
    assert.equal(
      JSON.parse(lines.at(-1)!.slice(PREFERENCE_DIAGNOSTIC_PREFIX.length)).result,
      'completed'
    )
  })
}
