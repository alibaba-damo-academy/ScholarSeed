import assert from 'node:assert/strict'
import test from 'node:test'
import { createMenuPresenter, type MenuPresentationModel } from '../../components/primitive/presenter.ts'
import type { MenuAck, MenuActionResult, MenuBridge, MenuDismissReason, MenuEvent, MenuModel, MenuReply } from '../../../../menu.ts'
import { MENU_LIMIT } from '../../../../menu.ts'

const input: MenuPresentationModel = { request: { surface: 'browser-menu', tabId: 'first' }, viewport: { width: 800, height: 600 }, theme: 'light', language: 'en',
  items: [{ kind: 'action', id: 'settings', actionId: 'browser.settings', label: 'Settings', disabled: false, checked: false, value: { kind: 'none' } }] }
const anchor = { x: 700, y: 40, width: 32, height: 32 }

function fixture() {
  let revision = 0
  let listener: (event: MenuEvent) => void = () => undefined
  let revoked: (event: MenuAck & { reason: MenuDismissReason }) => void = () => undefined
  let completed: (result: MenuActionResult) => void = () => undefined
  const models: MenuModel[] = []
  const dismissals: MenuDismissReason[] = []
  const pending: Array<(reply: MenuReply) => void> = []
  const bridge: MenuBridge = {
    presentation: async () => ({ ok: true, revision: 1, presentation: 'native' }),
    subscribePresentation: () => () => undefined,
    seed: async () => ({ ok: true, seed: { sessionId: `session-${++revision}`, revision, target: { kind: 'browser', tabId: 'first', instanceId: 'instance', navigationId: 1 } } }),
    publish: model => { models.push(model); return new Promise(resolve => pending.push(resolve)) },
    dismiss: async reason => { dismissals.push(reason) },
    subscribe: callback => { listener = callback; return () => { listener = () => undefined } },
    subscribeRevoked: callback => { revoked = callback; return () => { revoked = () => undefined } },
    subscribeResult: callback => { completed = callback; return () => { completed = () => undefined } }
  }
  const presenter = createMenuPresenter(bridge)
  const finish = (index: number, ok = true) => pending[index](ok ? { ok: true, ack: { sessionId: models[index].sessionId, revision: models[index].revision } } : { ok: false, error: 'menu_failed' })
  return { presenter, bridge, models, dismissals, finish, result: (result: MenuActionResult) => completed(result), event: (event: MenuEvent) => listener(event), revoke: (reason: MenuDismissReason, index = models.length - 1) => revoked({ sessionId: models[index].sessionId, revision: models[index].revision, reason }) }
}

test('pending paint does not authorize and late ACK after tab change cannot resurrect native takeover', async () => {
  const probe = fixture()
  const opening = probe.presenter.open('browser-menu', anchor, input)
  await Promise.resolve()
  assert.equal(probe.presenter.current(), null)
  await probe.presenter.dismiss('target')
  probe.finish(0)
  await opening
  assert.equal(probe.presenter.current(), null)
})

test('close-before actions carry the accepted target instead of looking up a later tab', async () => {
  const probe = fixture()
  const accepted: { model: MenuModel | null } = { model: null }
  probe.presenter.subscribeAction((_event, model) => { accepted.model = model })
  const opening = probe.presenter.open('browser-menu', anchor, input)
  await Promise.resolve()
  probe.finish(0)
  await opening
  probe.revoke('action')
  probe.event({ kind: 'action', sessionId: 'session-1', revision: 1, requestId: 'find', actionId: 'browser.settings', value: { kind: 'none' } })
  assert.deepEqual(accepted.model?.target, probe.models[0].target)
})

test('shared bridge coordinator scopes replacement and disposal to the current consumer lease', async () => {
  const probe = fixture()
  const second = createMenuPresenter(probe.bridge)
  const reasons: MenuDismissReason[] = []
  probe.presenter.subscribe((_model, reason) => { if (reason) reasons.push(reason) })
  const first = probe.presenter.open('browser-menu', anchor, input)
  await Promise.resolve()
  probe.finish(0)
  await first
  const replacement = second.open('browser-menu', anchor, input)
  await Promise.resolve()
  probe.finish(1)
  await replacement
  assert.equal(probe.presenter.current(), null)
  assert.equal(second.current()?.sessionId, 'session-2')
  assert.deepEqual(reasons, ['replaced'])
  probe.presenter.dispose()
  assert.equal(second.current()?.sessionId, 'session-2')
  assert.deepEqual(probe.dismissals, [])
})

test('stale pending consumer publish rejection never dismisses its replacement', async () => {
  const probe = fixture()
  const second = createMenuPresenter(probe.bridge)
  const pending = probe.presenter.open('browser-menu', anchor, input)
  await Promise.resolve()
  const replacement = second.open('browser-menu', anchor, input)
  await Promise.resolve()
  probe.finish(1)
  await replacement
  probe.finish(0, false)
  await pending
  assert.equal(second.current()?.sessionId, 'session-2')
  assert.deepEqual(probe.dismissals, [])
})

test('close-before exact lease permits one legitimate callback and invalidates across new target or menu', async () => {
  const probe = fixture()
  const actions: MenuEvent[] = []
  probe.presenter.subscribeAction(event => actions.push(event))
  const opening = probe.presenter.open('browser-menu', anchor, input)
  await Promise.resolve()
  probe.finish(0)
  await opening
  const event: MenuEvent = { kind: 'action', sessionId: 'session-1', revision: 1, requestId: 'request', actionId: 'browser.settings', value: { kind: 'none' } }
  probe.revoke('action')
  assert.equal(probe.presenter.current(), null)
  probe.event(event)
  probe.event({ ...event, requestId: 'duplicate' })
  assert.equal(actions.length, 1)
  const replacement = probe.presenter.open('browser-menu', anchor, input)
  await Promise.resolve()
  probe.finish(1)
  await replacement
  probe.revoke('action')
  await probe.presenter.dismiss('navigation')
  probe.event({ ...event, sessionId: 'session-2', revision: 2 })
  assert.equal(actions.length, 1)
})

test('paint failure restores toolbar status and keep-open update ignores old acknowledgements', async () => {
  const probe = fixture()
  const opening = probe.presenter.open('browser-menu', anchor, input)
  await Promise.resolve()
  probe.finish(0, false)
  await assert.rejects(opening, /menu_failed/)
  assert.equal(probe.presenter.current(), null)
  const next = probe.presenter.open('browser-menu', anchor, input)
  await Promise.resolve()
  probe.finish(1)
  await next
  const update = probe.presenter.update(input)
  assert.equal(probe.presenter.current()?.revision, 2)
  probe.revoke('resize')
  probe.finish(2)
  await update
  assert.equal(probe.presenter.current(), null)
})

test('rejected publish immediately revokes pending presentation rather than retaining hidden lease', async () => {
  const probe = fixture()
  probe.bridge.publish = async () => { throw new Error('transport_failure') }
  await assert.rejects(probe.presenter.open('browser-menu', anchor, input), /transport_failure/)
  assert.deepEqual(probe.dismissals, ['invalid'])
})

for (const transport of [false, true]) test(`failed seed revokes the old native presentation with transport rejection ${transport}`, async () => {
  const probe = fixture()
  probe.bridge.seed = async () => { if (transport) throw new Error('transport_failure'); return { ok: false, error: 'invalid_menu' } }
  await assert.rejects(probe.presenter.open('browser-menu', anchor, input))
  assert.deepEqual(probe.dismissals, ['invalid'])
  assert.equal(probe.presenter.current(), null)
})

test('closing lease expires silently without reporting a fictitious execution failure', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const probe = fixture()
  const results: MenuActionResult[] = []
  const reasons: MenuDismissReason[] = []
  probe.presenter.subscribeResult(result => results.push(result))
  probe.presenter.subscribe((_model, reason) => { if (reason) reasons.push(reason) })
  const opening = probe.presenter.open('browser-menu', anchor, input)
  await Promise.resolve()
  probe.finish(0)
  await opening
  probe.revoke('action')
  context.mock.timers.tick(MENU_LIMIT.resultLeaseTimeout)
  probe.result({ sessionId: 'session-1', revision: 1, requestId: 'expired', actionId: 'browser.settings', outcome: 'failed' })
  assert.deepEqual(results, [])
  assert.deepEqual(reasons, ['action'])
})

test('close-before result releases one exact lease and late failure cannot contaminate navigation or newer menu', async () => {
  const probe = fixture()
  const results: MenuActionResult[] = []
  probe.presenter.subscribeResult(result => results.push(result))
  const opening = probe.presenter.open('browser-menu', anchor, input)
  await Promise.resolve()
  probe.finish(0)
  await opening
  probe.revoke('action')
  const failure: MenuActionResult = { sessionId: 'session-1', revision: 1, requestId: 'request-1', actionId: 'browser.settings', outcome: 'failed' }
  probe.result(failure)
  probe.result({ ...failure, requestId: 'duplicate' })
  assert.equal(results.length, 1)
  const next = probe.presenter.open('browser-menu', anchor, input)
  await Promise.resolve()
  probe.finish(1)
  await next
  probe.result(failure)
  probe.revoke('action')
  await probe.presenter.dismiss('target')
  probe.result({ ...failure, sessionId: 'session-2', revision: 2 })
  assert.equal(results.length, 1)
})
