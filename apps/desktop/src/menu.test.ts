import assert from 'node:assert/strict'
import test from 'node:test'
import * as menu from './menu.ts'
import * as browser from './browser.ts'

for (const [index, factor] of browser.PAGE_ZOOM_FACTORS.entries()) {
  test(`zoom steps distinguish configured ${factor} from its conversion noise`, () => {
    const noise = Number.EPSILON * Math.max(1, factor) * 2
    for (const actual of [factor, factor - noise, factor + noise, Math.pow(1.2, Math.log(factor) / Math.log(1.2))]) {
      assert.deepEqual(browser.pageZoomSteps(actual), {
        lower: browser.PAGE_ZOOM_FACTORS[index - 1], higher: browser.PAGE_ZOOM_FACTORS[index + 1],
        reset: factor !== browser.PAGE_ZOOM_DEFAULT
      }, `actual ${actual}`)
      if (actual !== factor) assert.throws(() => browser.parsePageRequest({ kind: 'zoom', target: { tabId: 'tab', instanceId: 'instance', navigationId: 1 }, factor: actual }))
    }
  })
}

test('zoom steps preserve genuine off-table factors and use only a narrow equivalence window', () => {
  assert.deepEqual(browser.pageZoomSteps(1.21), { lower: 1.1, higher: 1.25, reset: true })
  assert.deepEqual(browser.pageZoomSteps(0.24), { lower: undefined, higher: 0.25, reset: true })
  assert.deepEqual(browser.pageZoomSteps(5.01), { lower: 5, higher: undefined, reset: true })
  for (const factor of browser.PAGE_ZOOM_FACTORS) {
    const outsideNoise = Number.EPSILON * Math.max(1, factor) * 32
    assert.equal(browser.pageZoomSteps(factor - outsideNoise).higher, factor)
    assert.equal(browser.pageZoomSteps(factor + outsideNoise).lower, factor)
  }
  assert.equal(browser.pageZoomSteps(1 + Number.EPSILON * 32).reset, true)
})

test('page commands require an exact expected target and a supported zoom level', () => {
  assert.equal(typeof browser.parsePageRequest, 'function')
  const target = { tabId: 'tab', instanceId: 'instance', navigationId: 1 }
  assert.deepEqual(browser.parsePageRequest({ kind: 'zoom', target, factor: 1.25 }), { kind: 'zoom', target, factor: 1.25 })
  for (const input of [{ kind: 'zoom', target, factor: 1.21 }, { kind: 'print', target, bytes: 'bad' },
    { kind: 'print', target: { ...target, navigationId: 0 } }]) assert.throws(() => browser.parsePageRequest(input))
})

test('find scene accepts only bounded typed queries without relaxing menu values', () => {
  const ack = { sessionId: 'session', revision: 1 }
  const query = { ...ack, kind: 'find', requestId: 'query', querySequence: 1, text: 'needle', direction: 'forward' }
  assert.deepEqual(menu.parseMenuEvent(query), query)
  for (const input of [{ ...query, text: 'x'.repeat(4097) }, { ...query, selector: 'body' },
    { ...query, direction: 'anything' }, { ...query, querySequence: 0 }]) assert.throws(() => menu.parseMenuEvent(input))
})

test('account projection rejects secrets and distinguishes failed credits from a zero balance', () => {
  const parse = (menu as unknown as { parseAccountMenuView: (value: unknown) => unknown }).parseAccountMenuView
  assert.equal(typeof parse, 'function')
  const view = { alias: '138****8001', avatar: '13', credits: { phase: 'error', value: null, unlimited: false }, availableActions: ['account.logout', 'account.settings', 'account.language'], logoutBusy: false, logoutError: null, locale: 'zh-CN' }
  assert.deepEqual(parse(view), view)
  assert.throws(() => parse({ ...view, cloudUrl: 'https://secret.test' }))
  assert.throws(() => parse({ ...view, alias: '13812348001' }))
  assert.throws(() => parse({ ...view, credits: { ...view.credits, value: 0 } }))
  assert.deepEqual(parse({ ...view, credits: { phase: 'ready', value: 0, unlimited: false } }), { ...view, credits: { phase: 'ready', value: 0, unlimited: false } })
  assert.throws(() => parse({ ...view, availableActions: ['account.arbitrary'] }))
})
