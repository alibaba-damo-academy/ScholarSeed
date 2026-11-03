import assert from 'node:assert/strict'
import test from 'node:test'
import { GuideEngine, type GuidePort, type GuideRequest, type GuideStep } from './engine.ts'
import {
  sanitizeOnboarding,
  onboardingEqual,
  type OnboardingGroup,
} from '../../../../onboarding.ts'
import { cardPosition } from './dom.ts'
import { loadBuiltinDocument } from '../workbench/builtin.ts'

function fixture(overrides: Partial<GuidePort> = {}) {
  const seen = new Set<OnboardingGroup>(),
    visited: string[] = []
  let blocked = false
  let valid = (_: GuideRequest): boolean => true
  const engine = new GuideEngine({
    seen: (group) => seen.has(group),
    markSeen: (group) => {
      seen.add(group)
    },
    valid: (request) => valid(request),
    blocked: () => blocked,
    steps: () => [
      { id: 'one', targets: ['one'] },
      { id: 'two', targets: ['two'] },
    ],
    prepare: async (step) => {
      visited.push(step.id)
      return true
    },
    cleanup: () => {},
    unavailable: () => {},
    ...overrides,
  })
  return {
    engine,
    seen,
    visited,
    block: (value: boolean) => {
      blocked = value
    },
    validate: (predicate: typeof valid) => {
      valid = predicate
    },
  }
}

test('onboarding: queues serialize and recheck eligibility only when they start', async () => {
  const f = fixture()
  f.engine.enqueue({ group: 'project' })
  f.engine.enqueue({ group: 'pdf' })
  await f.engine.drain()
  assert.equal(f.engine.snapshot().request?.group, 'project')
  await f.engine.drain()
  assert.deepEqual(f.visited, ['one'])
  f.validate((request) => request.group !== 'pdf')
  f.engine.finish()
  await f.engine.drain()
  assert.equal(f.engine.snapshot().request, null)
  assert.equal(f.seen.has('pdf'), false)
  f.validate(() => true)
  f.engine.enqueue({ group: 'pdf' })
  await f.engine.drain()
  assert.equal(f.engine.snapshot().request?.group, 'pdf')
})
test('onboarding: first visible card marks viewed, replay ignores viewed, reset does not start anything', async () => {
  const f = fixture()
  f.engine.enqueue({ group: 'home' })
  await f.engine.drain()
  assert(f.seen.has('home'))
  f.engine.finish()
  f.engine.enqueue({ group: 'home' })
  await f.engine.drain()
  assert.equal(f.engine.snapshot().request, null)
  f.engine.replay({ group: 'home' })
  await f.engine.drain()
  assert.equal(f.engine.snapshot().request?.force, true)
  f.engine.finish()
  f.seen.clear()
  await f.engine.drain()
  assert.equal(f.engine.snapshot().request, null)
})
test('onboarding: blocked surfaces postpone without consuming first-use state', async () => {
  const f = fixture()
  f.block(true)
  f.engine.enqueue({ group: 'pdf' })
  await f.engine.drain()
  assert.equal(f.engine.snapshot().request, null)
  assert.equal(f.seen.size, 0)
  f.block(false)
  await f.engine.drain()
  assert.equal(f.engine.snapshot().request?.group, 'pdf')
})
test('onboarding: before, setup, prepare and after execute in order', async () => {
  const order: string[] = []
  const step: GuideStep = {
    id: 'one',
    targets: [],
    before: async () => {
      order.push('before')
    },
    setup: () => {
      order.push('setup')
    },
    after: () => {
      order.push('after')
    },
  }
  const f = fixture({
    steps: () => [step],
    prepare: async () => {
      order.push('prepare')
      return true
    },
  })
  f.engine.enqueue({ group: 'project' })
  await f.engine.drain()
  assert.deepEqual(order, ['before', 'setup', 'prepare'])
  assert(f.seen.has('project'))
  await f.engine.next()
  assert.deepEqual(order, ['before', 'setup', 'prepare', 'after'])
  assert(f.seen.has('project'))
})
test('onboarding: no targets means no viewed flag, missing individual steps are skipped', async () => {
  const f = fixture({ prepare: async (step) => step.id !== 'one' })
  f.engine.enqueue({ group: 'pdf' })
  await f.engine.drain()
  assert.deepEqual(
    f.engine.snapshot().steps.map((step) => step.id),
    ['two']
  )
  assert.equal(f.engine.snapshot().ready, true)
  const missing = fixture({ prepare: async () => false })
  missing.engine.enqueue({ group: 'pdf' })
  await missing.engine.drain()
  assert.equal(missing.engine.snapshot().request, null)
  assert.equal(missing.seen.size, 0)
})
test('onboarding: cancellation during a hook cannot resurrect an obsolete tour', async () => {
  let finish!: () => void
  const f = fixture({
    steps: () => [
      {
        id: 'one',
        targets: [],
        before: () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      },
    ],
  })
  f.engine.enqueue({ group: 'pdf' })
  const running = f.engine.drain()
  f.engine.openCenter()
  finish()
  await running
  assert.equal(f.engine.snapshot().center, true)
  assert.equal(f.engine.snapshot().request, null)
  assert.equal(f.seen.size, 0)
})
test('onboarding: manual replay suppresses automatic navigation-triggered groups', async () => {
  const f = fixture()
  f.engine.replay({ group: 'pdf' })
  await f.engine.drain()
  f.engine.enqueue({ group: 'globalLib' })
  f.engine.finish()
  await f.engine.drain()
  assert.equal(f.engine.snapshot().request, null)
  assert.equal(f.seen.has('globalLib'), false)
})
test('onboarding: duplicate triggers and rapid double next do not skip steps', async () => {
  const f = fixture()
  f.engine.enqueue({ group: 'project' })
  f.engine.enqueue({ group: 'project' })
  await f.engine.drain()
  await Promise.all([f.engine.next(), f.engine.next()])
  assert.equal(f.engine.snapshot().index, 1)
  assert(f.seen.has('project'))
  f.engine.finish()
  await f.engine.drain()
  assert.equal(f.engine.snapshot().request, null)
})

test('onboarding: automatic entry never navigates and a missing step cannot inherit explicit navigation', async () => {
  const navigated: string[] = []
  const steps = ['one', 'two', 'three'].map((id) => ({
    id,
    targets: [id],
    navigate: () => {
      navigated.push(id)
    },
  }))
  const f = fixture({ steps: () => steps, prepare: async (step) => step.id !== 'two' })
  f.engine.enqueue({ group: 'project' })
  await f.engine.drain()
  assert.deepEqual(navigated, [])
  await f.engine.next()
  assert.deepEqual(navigated, ['two'])
  assert.equal(f.engine.snapshot().steps[f.engine.snapshot().index].id, 'three')
})

test('onboarding: replay authorizes its first step only, not missing-step navigation', async () => {
  const navigated: string[] = []
  const steps = ['one', 'two'].map((id) => ({
    id,
    targets: [id],
    navigate: () => {
      navigated.push(id)
    },
  }))
  const f = fixture({ steps: () => steps, prepare: async () => false })
  f.engine.replay({ group: 'project' })
  await f.engine.drain()
  assert.deepEqual(navigated, ['one'])
  assert.equal(f.engine.snapshot().request, null)
  assert.equal(f.seen.size, 0)
  f.engine.replay({ group: 'project' })
  await f.engine.drain()
  assert.deepEqual(navigated, ['one', 'one'])
})

test('onboarding: force grants eligibility, not navigation, even when all automatic anchors are missing', async () => {
  let navigations = 0,
    notices = 0
  const f = fixture({
    steps: () =>
      ['one', 'two'].map((id) => ({
        id,
        targets: [id],
        navigate: () => {
          navigations++
        },
      })),
    prepare: async () => false,
    unavailable: () => {
      notices++
    },
  })
  f.seen.add('project')
  f.engine.enqueue({ group: 'project', force: true })
  await f.engine.drain()
  assert.equal(navigations, 0)
  assert.equal(notices, 1)
  assert.equal(f.engine.snapshot().request, null)
})

test('onboarding: cancelling a completion flight prevents navigation to its next step', async () => {
  let resolve!: () => void
  let navigations = 0
  const f = fixture({
    steps: () => [
      {
        id: 'one',
        targets: [],
        after: () =>
          new Promise<void>((done) => {
            resolve = done
          }),
      },
      {
        id: 'two',
        targets: [],
        navigate: () => {
          navigations++
        },
      },
    ],
  })
  f.engine.enqueue({ group: 'project' })
  await f.engine.drain()
  const running = f.engine.next()
  f.engine.openCenter()
  resolve()
  await running
  assert.equal(navigations, 0)
  assert.equal(f.engine.snapshot().center, true)
})

test('onboarding: skipping an unready step aborts navigation and does not consume first use', async () => {
  let resolve!: () => void
  let prepared = false
  const f = fixture({
    steps: () => [
      {
        id: 'one',
        targets: [],
        navigate: () =>
          new Promise<void>((done) => {
            resolve = done
          }),
      },
    ],
    prepare: async () => {
      prepared = true
      return true
    },
  })
  f.engine.replay({ group: 'project' })
  const running = f.engine.drain()
  f.engine.finish()
  resolve()
  await running
  assert.equal(prepared, false)
  assert.equal(f.engine.snapshot().request, null)
  assert.equal(f.seen.size, 0)
})
test('onboarding preferences: only four boolean flags survive; reset preserves project history', () => {
  const value = sanitizeOnboarding({
    seen: { pdf: true, home: false, project: 'true', extra: true },
    recentProjectId: 'p1',
  })
  assert.deepEqual(value, { seen: { pdf: true }, recentProjectId: 'p1' })
  assert(onboardingEqual(undefined, { seen: {} }))
  assert(!onboardingEqual(value, { ...value, seen: {} }))
  assert.equal(sanitizeOnboarding({ ...value, seen: {} }).recentProjectId, 'p1')
})

test('onboarding: a failed completion hook keeps the already viewed state', async () => {
  let notices = 0,
    cleaned = 0
  const f = fixture({
    steps: () => [
      {
        id: 'one',
        targets: [],
        after: () => {
          throw new Error('test completion failure')
        },
      },
    ],
    unavailable: () => {
      notices++
    },
    cleanup: () => {
      cleaned++
    },
  })
  f.engine.enqueue({ group: 'project' })
  await f.engine.drain()
  await f.engine.next()
  assert.equal(f.engine.snapshot().request, null)
  assert(f.seen.has('project'))
  assert.equal(notices, 1)
  assert.equal(cleaned, 1)
})

test('onboarding: card avoids a sidebar and remains inside a resized viewport', () => {
  const anchor = { left: 48, top: 40, width: 240, height: 700 }
  const wide = cardPosition(anchor, 550, 150, { width: 1280, height: 840 })
  assert(wide.left >= anchor.left + anchor.width)
  const narrow = cardPosition({ left: 370, top: 560, width: 30, height: 30 }, 340, 160, {
    width: 420,
    height: 640,
  })
  assert(narrow.left >= 16 && narrow.left + 340 <= 404)
  assert(narrow.top >= 16 && narrow.top + 160 <= 624)
})

test('project files card leaves the file pane unobscured in wide and narrow windows', () => {
  for (const width of [1440, 725]) {
    const anchor = { left: width - 300, top: 12, width: 160, height: 36 }
    const position = cardPosition(anchor, 360, 460, { width, height: 840 }, 'left')
    assert(position.left + 360 <= anchor.left - 16)
    assert(position.top >= 16)
    assert(position.left >= 16 && position.left + 360 <= width - 16)
  }
})

test('onboarding sample registry refuses unregistered sources instead of reading arbitrary files', async () => {
  await assert.rejects(
    loadBuiltinDocument({ kind: 'builtin', id: 'not-registered', path: '/private/user.pdf' }),
    /builtin_document_unregistered/
  )
})

test('onboarding: previous revisits the prior step without running completion hooks or advancing twice', async () => {
  const calls: string[] = []
  const f = fixture({
    steps: () => [
      {
        id: 'one',
        targets: ['one'],
        navigate: async () => {
          calls.push('navigate')
        },
        after: () => {
          calls.push('after')
        },
      },
      { id: 'two', targets: ['two'] },
    ],
  })
  f.engine.enqueue({ group: 'project' })
  await f.engine.drain()
  await f.engine.previous()
  assert.equal(f.engine.snapshot().index, 0)
  await f.engine.next()
  await Promise.all([f.engine.previous(), f.engine.previous()])
  assert.equal(f.engine.snapshot().index, 0)
  assert.deepEqual(calls, ['after', 'navigate'])
})
