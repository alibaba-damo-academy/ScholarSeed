import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { RuntimePreparation } from './api'
import {
  PREPARATION_INSTANCE_CHANGED_ERROR,
  PREPARATION_SUPERSEDED_ERROR,
  RuntimePreparationController,
  preparationContextMatches,
  waitForPreparation,
  type PreparationSnapshot,
} from './preparation.ts'

test('confirmed login invalidates old preparation before the new account catalog arrives', () => {
  const source = readFileSync(new URL('./store.tsx', import.meta.url), 'utf8')
  const marker = '// Confirmed login replaces the authority of pending and completed preparations.'
  const start = source.indexOf(marker)
  assert.notEqual(start, -1)
  const end = source.indexOf('  }, [setState])', start)
  assert.notEqual(end, -1)
  const listeners = new Map<string, () => void>()
  let disposed = false
  let state = {
    modelCatalogInstanceId: 'instance',
    runtimePreparation: { state: 'applied' },
    runtimePreparationTarget: 'personal-model',
    modelSelectionGeneration: 3,
  }
  const refs = {
    preparationControllerRef: {
      current: {
        dispose: () => {
          disposed = true
        },
      },
    },
    preparationIntentRef: { current: {} },
    preparationPublicationRef: { current: {} },
    preparationSequenceRef: { current: 4 },
    startupPreparation: { current: { started: true } },
  }
  const script = ts.transpile(`(function () { ${source.slice(start, end)} })()`)
  const cleanup = runInNewContext(script, {
    ...refs,
    setState: (update: (previous: typeof state) => typeof state) => {
      state = update(state)
    },
    window: {
      addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    },
  }) as () => void
  assert.equal(disposed, false)
  listeners.get('scholarseed:auth-restored')!()
  assert.equal(disposed, true)
  assert.equal(refs.preparationControllerRef.current, null)
  assert.equal(refs.preparationIntentRef.current, null)
  assert.equal(refs.preparationPublicationRef.current, null)
  assert.equal(refs.startupPreparation.current, null)
  assert.equal(refs.preparationSequenceRef.current, 5)
  assert.equal(state.modelCatalogInstanceId, null)
  assert.equal(state.runtimePreparation, null)
  assert.equal(state.runtimePreparationTarget, null)
  assert.equal(state.modelSelectionGeneration, 4)
  cleanup()
  assert.equal(listeners.size, 0)
})

test('discarding an old account controller cannot publish a late applied receipt', async () => {
  const probe = fixture()
  const pending = deferred<RuntimePreparation>()
  probe.handlers.prepare = () => pending.promise
  const old = probe.controller.prepare('model-a')
  const rejected = assert.rejects(old, { message: PREPARATION_SUPERSEDED_ERROR })
  probe.controller.dispose()
  pending.resolve(probe.operation('applied'))
  await rejected
  assert.equal(probe.publications.length, 0)
})

function deferred<Value>() {
  let resolve: (value: Value) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<Value>((completed, failed) => {
    resolve = completed
    reject = failed
  })
  return { promise, resolve, reject }
}

function failure(status: number, message = 'request failed'): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

function controlledPauses() {
  const gates: ReturnType<typeof deferred<void>>[] = []
  const arrivals: ReturnType<typeof deferred<void>>[] = []
  return {
    pause: async (): Promise<void> => {
      const index = gates.length
      const gate = deferred<void>()
      gates.push(gate)
      arrivals[index]?.resolve()
      await gate.promise
    },
    at: (index: number): Promise<void> => {
      if (gates[index]) return Promise.resolve()
      arrivals[index] ??= deferred<void>()
      return arrivals[index].promise
    },
    advance: (index: number): void => gates[index].resolve(),
  }
}

function fixture() {
  let snapshot: PreparationSnapshot = {
    model: 'model-a',
    serviceInstanceId: 'instance',
    draftGeneration: 0,
    homeSelectedProjectId: 'project',
    activeSession: null,
  }
  const requests: Array<{
    requestId: string
    modelId: string
    serviceInstanceId: string
    persistDefault: boolean
  }> = []
  const reads: string[] = []
  const publications: RuntimePreparation[] = []
  let identities = 0
  const operation = (
    state: RuntimePreparation['state'],
    request = requests[requests.length - 1]!
  ): RuntimePreparation => ({
    request_id: request.requestId,
    model_id: request.modelId,
    session_id: null,
    service_instance_id: request.serviceInstanceId,
    state,
    error: '',
  })
  const handlers = {
    prepare: async (): Promise<RuntimePreparation> => operation('applied'),
    read: async (): Promise<RuntimePreparation> => operation('applied'),
    shared: async () => ({ service_instance_id: 'instance' }),
    pause: async (_signal: AbortSignal): Promise<void> => undefined,
  }
  const controller = new RuntimePreparationController({
    snapshot: () => snapshot,
    prepare: async (request) => {
      requests.push(request)
      return handlers.prepare()
    },
    read: async (requestId) => {
      reads.push(requestId)
      return handlers.read()
    },
    shared: () => handlers.shared(),
    pause: (signal) => handlers.pause(signal),
    publish: (value) => publications.push(value),
    requestId: () => `00000000-0000-0000-0000-${String(++identities).padStart(12, '0')}`,
  })
  return {
    controller,
    handlers,
    requests,
    reads,
    publications,
    operation,
    snapshot: () => snapshot,
    patch: (patch: Partial<PreparationSnapshot>) => {
      snapshot = { ...snapshot, ...patch }
    },
  }
}

test('a completed preparation is never reused as an unverified future admission', async () => {
  const probe = fixture()
  const first = await probe.controller.prepare('model-a', true)
  const second = await probe.controller.prepare('model-a')
  assert.notEqual(first.request_id, second.request_id)
  assert.equal(probe.requests.length, 2)
  assert.deepEqual(
    probe.requests.map((request) => request.persistDefault),
    [true, false]
  )
  assert.deepEqual(probe.publications, [first, second])
})

test('a matching in-flight prepare joins without another control request', async () => {
  const probe = fixture()
  const gate = deferred<void>()
  const paused = deferred<void>()
  probe.handlers.prepare = async () => probe.operation('accepted')
  probe.handlers.pause = async () => {
    paused.resolve()
    await gate.promise
  }
  const first = probe.controller.prepare('model-a', true)
  await paused.promise
  const second = probe.controller.prepare('model-a')
  assert.equal(first, second)
  gate.resolve()
  assert.equal((await second).state, 'applied')
  assert.equal(probe.requests.length, 1)
  assert.deepEqual(probe.reads, [probe.requests[0].requestId])
})

test('latest selection supersedes unsent targets while the active control reaches its real terminal', async () => {
  const probe = fixture()
  const gate = deferred<void>()
  const paused = deferred<void>()
  probe.handlers.prepare = async () =>
    probe.operation(probe.requests.length === 1 ? 'accepted' : 'applied')
  probe.handlers.pause = async () => {
    paused.resolve()
    await gate.promise
  }
  const first = probe.controller.prepare('model-a', true)
  await paused.promise
  probe.patch({ model: 'model-b' })
  const skipped = probe.controller.prepare('model-b', true)
  const skippedResult = assert.rejects(skipped, new RegExp(PREPARATION_SUPERSEDED_ERROR))
  probe.patch({ model: 'model-c' })
  const latest = probe.controller.prepare('model-c', true)
  assert.equal(probe.requests.length, 1)
  gate.resolve()
  await first
  await latest
  await skippedResult
  assert.deepEqual(
    probe.requests.map((request) => request.modelId),
    ['model-a', 'model-c']
  )
  assert.deepEqual(
    probe.publications.filter((value) => value.state === 'applied').map((value) => value.model_id),
    ['model-c']
  )
})

test('unknown POST recovery queries the same identity without issuing another POST when found', async () => {
  const probe = fixture()
  probe.handlers.prepare = async () => {
    throw new TypeError('network unavailable')
  }
  let queries = 0
  probe.handlers.read = async () => probe.operation(++queries === 1 ? 'accepted' : 'applied')
  await probe.controller.prepare('model-a')
  assert.equal(probe.requests.length, 1)
  assert.deepEqual(probe.reads, [probe.requests[0].requestId, probe.requests[0].requestId])
})

test('an explicitly absent same-instance request recovers with the same UUID', async () => {
  const probe = fixture()
  probe.handlers.prepare = async () => {
    if (probe.requests.length === 1) throw new TypeError('network unavailable')
    return probe.operation('applied')
  }
  probe.handlers.read = async () => {
    throw failure(404)
  }
  await probe.controller.prepare('model-a', true)
  assert.equal(probe.requests.length, 2)
  assert.equal(probe.requests[0].requestId, probe.requests[1].requestId)
})

test('unknown POST plus 404 never creates an old request in a different service instance', async () => {
  const probe = fixture()
  probe.handlers.prepare = async () => {
    throw new TypeError('network unavailable')
  }
  probe.handlers.read = async () => {
    throw failure(404)
  }
  probe.handlers.shared = async () => ({ service_instance_id: 'new-instance' })
  await assert.rejects(
    probe.controller.prepare('model-a', true),
    new RegExp(PREPARATION_INSTANCE_CHANGED_ERROR)
  )
  assert.equal(probe.requests.length, 1)
})

test('a default writer waits for a stale unknown request to settle using its original UUID', async () => {
  const probe = fixture()
  const recovery = deferred<void>()
  const queried = deferred<void>()
  const order: string[] = []
  probe.handlers.prepare = async () => {
    if (probe.requests.length === 1) throw new TypeError('network unavailable')
    order.push('model-a')
    return probe.operation('applied')
  }
  probe.handlers.read = async () => {
    probe.patch({ model: 'model-b', activeSession: 'existing-session' })
    queried.resolve()
    await recovery.promise
    throw failure(404)
  }
  const previous = probe.controller.prepare('model-a', true)
  await queried.promise
  const writer = probe.controller.runSelection(async () => {
    order.push('model-b')
  })
  assert.deepEqual(order, [])
  recovery.resolve()
  await Promise.all([previous, writer])
  assert.equal(probe.requests.length, 2)
  assert.equal(probe.requests[0].requestId, probe.requests[1].requestId)
  assert.deepEqual(order, ['model-a', 'model-b'])
  assert.deepEqual(probe.publications, [])
})

test('host-busy before registration waits and retries only the original preparation identity', async () => {
  const probe = fixture()
  probe.handlers.prepare = async () => {
    if (probe.requests.length === 1) throw failure(409, 'runtime_host_busy')
    return probe.operation('applied')
  }
  probe.handlers.read = async () => {
    throw failure(404)
  }
  await probe.controller.prepare('model-a')
  assert.equal(probe.requests.length, 2)
  assert.equal(probe.requests[0].requestId, probe.requests[1].requestId)
})

test('preparation waits behind an existing selection writer and keeps only the latest queued target', async () => {
  const probe = fixture()
  const gate = deferred<void>()
  const order: string[] = []
  const writer = probe.controller.runSelection(async () => {
    await gate.promise
    order.push('existing-session')
  })
  probe.handlers.prepare = async () => {
    order.push(probe.snapshot().model)
    return probe.operation('applied')
  }
  const skipped = probe.controller.prepare('model-a', true)
  const skippedResult = assert.rejects(skipped, new RegExp(PREPARATION_SUPERSEDED_ERROR))
  probe.patch({ model: 'model-b' })
  const latest = probe.controller.prepare('model-b', true)
  assert.deepEqual(probe.requests, [])
  gate.resolve()
  await Promise.all([writer, latest, skippedResult])
  assert.deepEqual(order, ['existing-session', 'model-b'])
  assert.equal(probe.requests.length, 1)
})

test('selection writers share the control barrier and preserve their execution order', async () => {
  const probe = fixture()
  const gate = deferred<void>()
  const order: string[] = []
  const first = probe.controller.runSelection(async () => {
    await gate.promise
    order.push('first')
    return 'first-result'
  })
  const second = probe.controller.runSelection(async () => {
    order.push('second')
    return 'second-result'
  })
  const settled = probe.controller.runSelection(async () => order.push('settled'))
  assert.deepEqual(order, [])
  gate.resolve()
  assert.deepEqual(await Promise.all([first, second]), ['first-result', 'second-result'])
  await settled
  assert.deepEqual(order, ['first', 'second', 'settled'])
})

test('an explicit selection writer cannot mutate while shell instance identity is unknown', async () => {
  const probe = fixture()
  const pauses = controlledPauses()
  probe.handlers.pause = pauses.pause
  probe.patch({ serviceInstanceId: null })
  let written = false
  const writer = probe.controller.runSelection(async () => {
    written = true
  })
  await pauses.at(0)
  assert.equal(written, false)
  probe.patch({ serviceInstanceId: 'instance' })
  probe.controller.reconcile()
  pauses.advance(0)
  await writer
  assert.equal(written, true)
  assert.deepEqual(probe.requests, [])
})

test('terminal server results and access failures remain explicit and are not retried', async () => {
  for (const state of ['rejected', 'restart_required', 'unsupported'] as const) {
    const probe = fixture()
    probe.handlers.prepare = async () => ({ ...probe.operation(state), error: 'blocked' })
    assert.equal((await probe.controller.prepare('model-a')).state, state)
    assert.equal(probe.requests.length, 1)
  }
  const denied = fixture()
  denied.handlers.prepare = async () => {
    throw failure(403)
  }
  await assert.rejects(denied.controller.prepare('model-a'))
  assert.equal(denied.requests.length, 1)
  assert.deepEqual(denied.reads, [])
})

test('malformed receipts keep reconciling the original control without publishing false readiness', async () => {
  for (const patch of [
    { request_id: 'other' },
    { model_id: 'other' },
    { model_id: 'other', service_instance_id: 'other' },
    { service_instance_id: '' },
  ]) {
    const probe = fixture()
    const pauses = controlledPauses()
    probe.handlers.pause = pauses.pause
    probe.handlers.prepare = async () => ({ ...probe.operation('applied'), ...patch })
    const operation = probe.controller.prepare('model-a')
    await pauses.at(0)
    assert.deepEqual(probe.publications, [])
    pauses.advance(0)
    assert.equal((await operation).state, 'applied')
    assert.equal(probe.requests.length, 1)
    assert.deepEqual(probe.reads, [probe.requests[0].requestId])
  }
})

test('a confirmed different instance receipt terminates the old observation', async () => {
  const probe = fixture()
  probe.handlers.prepare = async () => ({
    ...probe.operation('applied'),
    service_instance_id: 'other',
  })
  await assert.rejects(
    probe.controller.prepare('model-a'),
    new RegExp(PREPARATION_INSTANCE_CHANGED_ERROR)
  )
  assert.deepEqual(probe.publications, [])
  assert.deepEqual(probe.reads, [])
})

test('query access failures retain the original control barrier until an authoritative receipt arrives', async () => {
  for (const status of [401, 403]) {
    const probe = fixture()
    const pauses = controlledPauses()
    probe.handlers.pause = pauses.pause
    probe.handlers.prepare = async () => {
      if (probe.requests.length === 1) throw new TypeError('unknown POST')
      return probe.operation('applied')
    }
    probe.handlers.read = async () => {
      if (probe.reads.length === 1) throw failure(status)
      return probe.operation('applied')
    }
    const first = probe.controller.prepare('model-a', true)
    await pauses.at(0)
    probe.patch({ model: 'model-b' })
    const queued = probe.controller.prepare('model-b', true)
    pauses.advance(0)
    await pauses.at(1)
    assert.equal(probe.requests.length, 1)
    assert.deepEqual(probe.publications, [])
    pauses.advance(1)
    await Promise.all([first, queued])
    assert.deepEqual(
      probe.requests.map((request) => request.modelId),
      ['model-a', 'model-b']
    )
    assert.deepEqual(probe.reads, [probe.requests[0].requestId, probe.requests[0].requestId])
  }
})

test('accepted control survives unknown identity and preserves serial queued preparation after recovery', async () => {
  const probe = fixture()
  const pauses = controlledPauses()
  probe.handlers.pause = pauses.pause
  probe.handlers.prepare = async () =>
    probe.operation(probe.requests.length === 1 ? 'accepted' : 'applied')
  probe.handlers.read = async () =>
    probe.operation(probe.snapshot().serviceInstanceId ? 'applied' : 'accepted')
  const first = probe.controller.prepare('model-a', true)
  await pauses.at(0)
  probe.patch({ model: 'model-b' })
  const queued = probe.controller.prepare('model-b', true)
  probe.patch({ serviceInstanceId: null })
  probe.controller.reconcile()
  pauses.advance(0)
  await pauses.at(1)
  assert.equal(probe.requests.length, 1)
  assert.deepEqual(probe.reads, [probe.requests[0].requestId])
  assert.equal(probe.publications.length, 1)
  probe.patch({ serviceInstanceId: 'instance' })
  probe.controller.reconcile()
  pauses.advance(1)
  await Promise.all([first, queued])
  assert.deepEqual(
    probe.requests.map((request) => request.modelId),
    ['model-a', 'model-b']
  )
  assert.deepEqual(
    probe.publications.map((operation) => [operation.model_id, operation.state]),
    [
      ['model-a', 'accepted'],
      ['model-b', 'applied'],
    ]
  )
})

test('an unsent queued preparation stays paused while identity is unknown after its predecessor settles', async () => {
  const probe = fixture()
  const pauses = controlledPauses()
  probe.handlers.pause = pauses.pause
  probe.handlers.prepare = async () =>
    probe.operation(probe.requests.length === 1 ? 'accepted' : 'applied')
  const first = probe.controller.prepare('model-a', true)
  await pauses.at(0)
  probe.patch({ model: 'model-b' })
  const queued = probe.controller.prepare('model-b', true)
  probe.patch({ serviceInstanceId: null })
  probe.controller.reconcile()
  pauses.advance(0)
  await first
  assert.equal(probe.requests.length, 1)
  probe.patch({ serviceInstanceId: 'instance' })
  probe.controller.reconcile()
  assert.equal((await queued).model_id, 'model-b')
  assert.equal(probe.requests.length, 2)
})

test('unknown POST plus 404 during unknown identity never recreates before the same instance recovers', async () => {
  const probe = fixture()
  const pauses = controlledPauses()
  const initial = deferred<RuntimePreparation>()
  probe.handlers.pause = pauses.pause
  probe.handlers.prepare = async () => {
    if (probe.requests.length === 1) return initial.promise
    return probe.operation('applied')
  }
  probe.handlers.read = async () => {
    throw failure(404)
  }
  const first = probe.controller.prepare('model-a', true)
  probe.patch({ model: 'model-b' })
  const queued = probe.controller.prepare('model-b', true)
  probe.patch({ serviceInstanceId: null })
  probe.controller.reconcile()
  initial.reject(new TypeError('unknown POST'))
  await pauses.at(0)
  pauses.advance(0)
  await pauses.at(1)
  assert.equal(probe.requests.length, 1)
  assert.deepEqual(probe.reads, [probe.requests[0].requestId])
  assert.deepEqual(probe.publications, [])
  probe.patch({ serviceInstanceId: 'instance' })
  probe.controller.reconcile()
  pauses.advance(1)
  await pauses.at(2)
  assert.equal(probe.requests.length, 1)
  pauses.advance(2)
  await Promise.all([first, queued])
  assert.deepEqual(
    probe.requests.map((request) => request.modelId),
    ['model-a', 'model-a', 'model-b']
  )
  assert.equal(probe.requests[0].requestId, probe.requests[1].requestId)
  assert.notEqual(probe.requests[1].requestId, probe.requests[2].requestId)
})

test('a new draft identity cannot join an old draft and stale queued work never starts', async () => {
  const probe = fixture()
  const gate = deferred<void>()
  const paused = deferred<void>()
  probe.handlers.prepare = async () => probe.operation('accepted')
  probe.handlers.pause = async () => {
    paused.resolve()
    await gate.promise
  }
  const first = probe.controller.prepare('model-a')
  await paused.promise
  probe.patch({ draftGeneration: 1 })
  const queued = probe.controller.prepare('model-a')
  const rejected = assert.rejects(queued, new RegExp(PREPARATION_SUPERSEDED_ERROR))
  probe.patch({ draftGeneration: 2 })
  probe.controller.reconcile()
  gate.resolve()
  await first
  await rejected
  assert.equal(probe.requests.length, 1)
})

test('service replacement aborts only the frontend observation of active work', async () => {
  const probe = fixture()
  const paused = deferred<void>()
  probe.handlers.prepare = async () => probe.operation('accepted')
  probe.handlers.pause = (signal) =>
    new Promise((_resolve, reject) => {
      paused.resolve()
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  const operation = probe.controller.prepare('model-a')
  await paused.promise
  probe.patch({ serviceInstanceId: 'new-instance' })
  probe.controller.reconcile()
  await assert.rejects(operation, new RegExp(PREPARATION_INSTANCE_CHANGED_ERROR))
  assert.equal(probe.requests.length, 1)
  assert.deepEqual(probe.reads, [])
})

test('cancelling a caller wait does not cancel control or replay any message', async () => {
  const pending = deferred<RuntimePreparation>()
  const caller = new AbortController()
  const wait = waitForPreparation(pending.promise, caller.signal)
  caller.abort()
  await assert.rejects(wait, new RegExp(PREPARATION_SUPERSEDED_ERROR))
  const probe = fixture()
  pending.resolve(
    probe.operation('applied', {
      requestId: 'request',
      modelId: 'model-a',
      serviceInstanceId: 'instance',
      persistDefault: false,
    })
  )
  assert.equal((await pending.promise).state, 'applied')
  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  const rejected = deferred<RuntimePreparation>()
  await assert.rejects(
    waitForPreparation(rejected.promise, alreadyAborted.signal),
    new RegExp(PREPARATION_SUPERSEDED_ERROR)
  )
  rejected.reject(new Error('late control failure'))
  await Promise.resolve()
})

test('preparation context is scoped to model, draft, project, session and service identity', () => {
  const probe = fixture()
  const context = {
    modelId: 'model-a',
    serviceInstanceId: 'instance',
    draftGeneration: 0,
    projectId: 'project',
    sessionId: null,
  }
  assert.equal(preparationContextMatches(probe.snapshot(), context), true)
  for (const patch of [
    { model: 'other' },
    { serviceInstanceId: 'other' },
    { draftGeneration: 1 },
    { homeSelectedProjectId: 'other' },
    { activeSession: 'other' },
  ]) {
    assert.equal(preparationContextMatches({ ...probe.snapshot(), ...patch }, context), false)
  }
})
