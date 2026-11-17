import assert from 'node:assert/strict'
import { syncBuiltinESMExports } from 'node:module'
import { setTimeout as delay, setImmediate as flush } from 'node:timers/promises'
import test, { beforeEach, type TestContext } from 'node:test'
import { inspectProductSearchOrigin, runBrowserSearch } from './search.ts'
import {
  SCOPE,
  TAB_ID,
  RESULT_URL,
  ORIGIN,
  HOME_URL,
  REGIONAL_ORIGIN,
  REGIONAL_HOME,
  CARD,
  FIRST_CARD,
  DEADLINE_MS,
  fixture,
  type SearchResult,
} from './search.fixture.ts'

const ORIGINAL_DELAY = delay
const ORIGINAL_DATE = Date
const HOME_SETTLE_MS = 1_000
const RESULT_SETTLE_MS = 1_500
const READ_SAMPLE_MS = 250
const MAX_CLOCK_TURNS = 64

beforeEach((context) => {
  assert.ok('mock' in context, 'Search clock requires a test context')
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  syncBuiltinESMExports()
  context.after(() => {
    context.mock.timers.reset()
    syncBuiltinESMExports()
    assert.equal(delay, ORIGINAL_DELAY)
    assert.equal(Date, ORIGINAL_DATE)
  })
})

async function runSearch(context: TestContext, ...args: Parameters<typeof runBrowserSearch>) {
  let finished = false
  const pending = runBrowserSearch(...args)
    .then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    .finally(() => {
      finished = true
    })
  for (let turn = 0; turn < MAX_CLOCK_TURNS; turn += 1) {
    context.signal.throwIfAborted()
    await flush()
    if (finished) break
    context.mock.timers.runAll()
  }
  await flush()
  assert.equal(finished, true, 'Search did not settle under virtual time')
  const outcome = await pending
  if ('error' in outcome) throw outcome.error
  return outcome.value
}

test('product search policy admits only declared exact HTTPS origins', () => {
  for (const origin of [ORIGIN, REGIONAL_ORIGIN])
    assert.equal(inspectProductSearchOrigin(origin).decision, 'allow')
  for (const origin of [
    'http://www.bing.com',
    'https://www.bing.com:8443',
    'https://www.bing.com.evil.example',
    'https://other.example',
  ])
    assert.equal(inspectProductSearchOrigin(origin).decision, 'block')
})

test(
  'virtual search clock preserves homepage result and sampling boundaries',
  { timeout: DEADLINE_MS },
  async (context) => {
    assert.equal(Date.now(), 0)
    assert.notEqual(delay, ORIGINAL_DELAY)
    const state = fixture()
    const pending = runBrowserSearch(state.input, state.ports)
    await flush()
    assert.deepEqual(state.steps, [`navigate:${HOME_URL}`])
    context.mock.timers.tick(HOME_SETTLE_MS - 1)
    await flush()
    assert.equal(state.steps.length, 1)
    context.mock.timers.tick(1)
    await flush()
    assert.deepEqual(state.steps, [`navigate:${HOME_URL}`, 'prepare:test', 'submit'])
    context.mock.timers.tick(RESULT_SETTLE_MS - 1)
    await flush()
    assert.equal(state.status().evaluated, 0)
    context.mock.timers.tick(1)
    await flush()
    assert.equal(state.status().evaluated, 1)
    context.mock.timers.tick(READ_SAMPLE_MS - 1)
    await flush()
    assert.equal(state.status().evaluated, 1)
    context.mock.timers.tick(1)
    assert.deepEqual((await pending).cards, [CARD])
    assert.equal(state.status().evaluated, 2)
    assert.equal(state.status().closed, true)
    assert.equal(Date.now(), HOME_SETTLE_MS + RESULT_SETTLE_MS + READ_SAMPLE_MS)
  }
)

test(
  'virtual search clock cancellation clears the target before a waiting deadline',
  { timeout: DEADLINE_MS },
  async (context) => {
    assert.equal(Date.now(), 0)
    assert.notEqual(delay, ORIGINAL_DELAY)
    for (const phase of ['homepage', 'result']) {
      const state = fixture()
      const rejected = assert.rejects(runBrowserSearch(state.input, state.ports), /request_expired/)
      await flush()
      if (phase === 'result') {
        context.mock.timers.tick(HOME_SETTLE_MS)
        await flush()
      }
      const interval = phase === 'homepage' ? HOME_SETTLE_MS : RESULT_SETTLE_MS
      context.mock.timers.tick(interval / 2)
      await flush()
      assert.equal(state.status().evaluated, 0)
      state.abort.abort()
      await rejected
      assert.equal(state.status().closed, true)
      assert.equal(state.status().created, 1)
      assert.equal(
        state.steps.filter((step) => step === 'submit').length,
        phase === 'result' ? 1 : 0
      )
      context.mock.timers.tick(interval)
      await flush()
      assert.equal(state.status().evaluated, 0)
    }
  }
)

test('search opens the homepage and submits its observed form instead of navigating to a query URL', async (context) => {
  const state = fixture()
  await runSearch(context, state.input, state.ports)
  assert.deepEqual(state.steps, [`navigate:${HOME_URL}`, 'prepare:test', 'submit'])
})

test('search stage diagnostics retain target correlation without query contents', async (context) => {
  const state = fixture()
  const diagnostics: Array<{ stage: string; tabId: string }> = []
  state.ports.onStage = (stage, tabId) => diagnostics.push({ stage, tabId })
  await runSearch(context, state.input, state.ports)
  assert.deepEqual(
    diagnostics,
    [
      'homepage',
      'homepage-settle',
      'form-inspection',
      'form-submit',
      'result-read',
      'result-settle',
    ].map((stage) => ({
      stage,
      tabId: TAB_ID,
    }))
  )
})

test('diagnostic failures do not change search success, original rejection or cleanup', async (context) => {
  for (const failure of [false, true]) {
    const state = fixture()
    if (failure)
      state.ports.controller.executeNavigate = async () => {
        throw new Error('navigation_cancelled_before_dispatch')
      }
    state.ports.onStage = () => {
      throw new Error('diagnostic sink unavailable')
    }
    state.ports.onFailure = () => {
      throw new Error('diagnostic sink unavailable')
    }
    if (!failure) assert.equal((await runSearch(context, state.input, state.ports)).cards.length, 1)
    else
      await assert.rejects(
        runSearch(context, state.input, state.ports),
        /navigation_cancelled_before_dispatch/
      )
    assert.equal(state.status().closed, true)
  }
})

test('an actually blocked regional homepage redirect requires independent destination grants', async (context) => {
  const state = fixture({ redirects: [{ url: REGIONAL_HOME }] })
  const result = await runSearch(context, state.input, state.ports)
  assert.deepEqual(state.steps, [
    `navigate:${HOME_URL}`,
    `navigate:${REGIONAL_HOME}`,
    'prepare:test',
    'submit',
  ])
  assert.equal(result.url, `${REGIONAL_ORIGIN}/search?q=test`)
  assert.equal(state.status().closed, true)
})

test('regional navigation and reading never auto-approve ask or block', async (context) => {
  for (const decision of ['ask', 'block'] as const) {
    for (const permission of ['regionalNavigate', 'regionalRead'] as const) {
      const state = fixture({ redirects: [{ url: REGIONAL_HOME }], [permission]: decision })
      await assert.rejects(
        runSearch(context, state.input, state.ports),
        decision === 'ask' ? /browser_search_authorization_required/ : /stale_grant/
      )
      assert.equal(
        state.steps.some((step) => step.startsWith('prepare:')),
        false
      )
      assert.equal(state.status().evaluated, 0)
      assert.equal(state.status().closed, true)
      assert.equal(state.steps.length, permission === 'regionalNavigate' ? 1 : 2)
    }
  }
})

test('regional redirect receipts reject foreign origins, stale requests and non-homepage targets', async (context) => {
  for (const receipt of [
    { url: 'https://other.example/' },
    { url: 'http://cn.bing.com/' },
    { url: 'not-a-url' },
    { url: `${REGIONAL_ORIGIN}/search?q=test` },
    { url: `${REGIONAL_ORIGIN}/?q=test` },
    { url: `${REGIONAL_ORIGIN}/#fragment` },
    { url: 'https://user@cn.bing.com/' },
    { url: REGIONAL_HOME, requestedUrl: 'https://www.bing.com/other' },
    { url: HOME_URL },
  ]) {
    const state = fixture({ redirects: [receipt] })
    await assert.rejects(
      runSearch(context, state.input, state.ports),
      /browser_search_redirect_denied/
    )
    assert.deepEqual(state.steps, [`navigate:${HOME_URL}`])
    assert.equal(state.status().closed, true)
  }
})

test('regional redirect loops stop after one independently authorized hop', async (context) => {
  const state = fixture({ redirects: [{ url: REGIONAL_HOME }, { url: HOME_URL }] })
  await assert.rejects(
    runSearch(context, state.input, state.ports),
    /browser_search_redirect_denied/
  )
  assert.deepEqual(state.steps, [`navigate:${HOME_URL}`, `navigate:${REGIONAL_HOME}`])
  assert.equal(state.status().evaluated, 0)
})

test('regional redirect consumption cannot revive a cancelled or retired search', async (context) => {
  for (const change of ['cancel', 'retire'] as const) {
    const state = fixture({ redirects: [{ url: REGIONAL_HOME }] })
    const take = state.ports.registry.takeSearchRedirect
    state.ports.registry.takeSearchRedirect = (tabId) => {
      const receipt = take(tabId)
      if (change === 'cancel') state.abort.abort()
      else state.retire()
      return receipt
    }
    await assert.rejects(
      runSearch(context, state.input, state.ports),
      change === 'cancel' ? /request_expired/ : /stale_grant/
    )
    assert.deepEqual(state.steps, [`navigate:${HOME_URL}`])
    assert.equal(state.status().evaluated, 0)
    assert.equal(state.status().closed, true)
  }
})

test('regional search cannot publish results from the originally authorized origin', async (context) => {
  const state = fixture({
    redirects: [{ url: REGIONAL_HOME }],
    responses: [{ url: RESULT_URL, cards: [CARD], challenge: false, ready: true }],
  })
  await assert.rejects(runSearch(context, state.input, state.ports), /browser_search_page_changed/)
  assert.equal(state.status().closed, true)
})

test('form submission rechecks policy and scope and never extracts on revocation', async (context) => {
  for (const change of ['retire', 'replace', 'changePolicy'] as const) {
    const state: ReturnType<typeof fixture> = fixture({
      submit: async () => {
        state[change]()
      },
    })
    await assert.rejects(
      runSearch(context, state.input, state.ports),
      /stale_grant|browser_search_page_changed/
    )
    assert.equal(state.status().evaluated, 0)
    assert.equal(state.status().closed, true)
  }
})

test('unknown form submission is never retried or reported as an empty search', async (context) => {
  const state = fixture({
    submit: async () => {
      throw new Error('browser_search_submission_unknown')
    },
  })
  await assert.rejects(
    runSearch(context, state.input, state.ports),
    /browser_search_submission_unknown/
  )
  assert.equal(state.steps.filter((step) => step === 'submit').length, 1)
  assert.equal(state.status().evaluated, 0)
  assert.equal(state.status().closed, true)
})

test('form authorization failures preserve their code and submission stage without retrying', async (context) => {
  for (const code of ['browser_search_form_stale', 'browser_search_submission_blocked']) {
    const state = fixture({
      submit: async () => {
        throw new Error(code)
      },
    })
    const failures: Array<{ stage: string; code: string }> = []
    state.ports.onFailure = (stage, failure) => {
      failures.push({ stage, code: failure })
    }
    await assert.rejects(runSearch(context, state.input, state.ports), { message: code })
    assert.deepEqual(failures, [{ stage: 'submission', code }])
    assert.equal(state.steps.filter((step) => step === 'submit').length, 1)
    assert.equal(state.status().evaluated, 0)
    assert.equal(state.status().closed, true)
  }
})

test('search requires stable card content and closes only its owned target', async (context) => {
  const state = fixture({
    responses: [
      { url: RESULT_URL, cards: [FIRST_CARD], challenge: false, ready: true },
      { url: RESULT_URL, cards: [CARD], challenge: false, ready: true },
    ],
  })
  const result = await runSearch(context, state.input, state.ports)
  assert.deepEqual(result.cards, [CARD])
  assert.deepEqual(state.status(), {
    created: 1,
    evaluated: 3,
    navigated: 1,
    revoked: 1,
    closed: true,
  })
  assert.throws(
    () =>
      state.grants.prepareRead({
        sessionId: SCOPE.sessionId,
        turnId: SCOPE.turnId,
        requestId: 'after-close',
        tabId: TAB_ID,
        intent: 'Read',
      }),
    /stale_grant/
  )
})

test('stable ready empty results are valid', async (context) => {
  const state = fixture({
    responses: [{ url: RESULT_URL, cards: [], challenge: false, ready: true }],
  })
  assert.deepEqual((await runSearch(context, state.input, state.ports)).cards, [])
  assert.equal(state.status().evaluated, 2)
  assert.equal(state.status().closed, true)
})

test(
  'unstable or unready results never become empty success',
  { timeout: DEADLINE_MS },
  async (context) => {
    for (const responses of [
      [{ url: RESULT_URL, cards: [], challenge: false, ready: false }],
      Array.from({ length: 8 }, (_value, index) => ({
        url: RESULT_URL,
        cards: [{ ...CARD, title: 'Result ' + index }],
        challenge: false,
        ready: true,
      })),
    ]) {
      const state = fixture({ responses })
      await assert.rejects(
        runSearch(context, state.input, state.ports),
        /browser_search_results_unstable/
      )
      assert.equal(state.status().closed, true)
    }
  }
)

test('CAPTCHA is returned without extracting successful candidates', async (context) => {
  const response = {
    url: RESULT_URL,
    query: null,
    renderTarget: null,
    cards: [],
    challenge: true,
    ready: false,
  }
  const state = fixture({ responses: [response] })
  assert.deepEqual(await runSearch(context, state.input, state.ports), response)
  assert.equal(state.status().evaluated, 1)
  assert.equal(state.status().closed, true)
})

test('navigation and read ask or block never silently approve', async (context) => {
  for (const phase of ['navigate', 'read'] as const) {
    for (const decision of ['ask', 'block'] as const) {
      const state = fixture({ [phase]: decision })
      await assert.rejects(
        runSearch(context, state.input, state.ports),
        decision === 'ask' ? /browser_search_authorization_required/ : /stale_grant/
      )
      assert.equal(state.status().evaluated, 0)
      assert.equal(state.status().closed, true)
      assert.equal(state.status().navigated, phase === 'read' ? 1 : 0)
    }
  }
})

test('disabled or aborted search creates no target', async (context) => {
  for (const condition of ['disabled', 'aborted']) {
    const state = fixture()
    if (condition === 'disabled') state.disable()
    else state.abort.abort()
    await assert.rejects(runSearch(context, state.input, state.ports), /browser_unavailable/)
    assert.equal(state.status().created, 0)
  }
})

test('query or origin change rejects candidates and disposes its target', async (context) => {
  for (const url of [
    'https://www.bing.com/search?q=wrong',
    'https://www.bing.com/search?q=test&q=extra',
    'http://www.bing.com/search?q=test',
    'https://example.org/search?q=test',
  ]) {
    const state = fixture({ responses: [{ url, cards: [CARD], challenge: false, ready: true }] })
    await assert.rejects(
      runSearch(context, state.input, state.ports),
      /browser_search_page_changed/
    )
    assert.equal(state.status().closed, true)
  }
})

test('homepage and result settling remain cancellable without publishing or replay', async (context) => {
  for (const stage of ['homepage-settle', 'result-settle']) {
    const state = fixture()
    state.ports.onStage = (observed) => {
      if (observed === stage) state.abort.abort()
    }
    await assert.rejects(runSearch(context, state.input, state.ports), /request_expired/)
    assert.equal(state.status().closed, true)
    assert.equal(state.status().evaluated, 0)
    assert.equal(
      state.steps.filter((step) => step === 'submit').length,
      stage === 'result-settle' ? 1 : 0
    )
  }
})

test('a skipped result is scrolled before a new stable read and cannot survive revocation', async (context) => {
  for (const revoked of [false, true]) {
    let scrolled = false
    const state: ReturnType<typeof fixture> = fixture({
      evaluate: async (expression) => {
        if (expression.includes('.scrollIntoView(')) {
          scrolled = true
          if (revoked) state.changePolicy()
        }
        return {
          url: RESULT_URL,
          cards: [CARD],
          challenge: false,
          ready: scrolled,
          renderTarget: scrolled ? null : 0,
        }
      },
    })
    if (revoked) await assert.rejects(runSearch(context, state.input, state.ports), /stale_grant/)
    else assert.deepEqual((await runSearch(context, state.input, state.ports)).cards, [CARD])
    assert.equal(scrolled, true)
    assert.equal(state.status().closed, true)
  }
})

test('result input must match the requested query even when the URL is correct', async (context) => {
  const state = fixture({
    responses: [
      {
        url: RESULT_URL,
        query: 'different query',
        cards: [CARD],
        challenge: false,
        ready: true,
      } as SearchResult,
    ],
  })
  await assert.rejects(runSearch(context, state.input, state.ports), /browser_search_page_changed/)
  assert.equal(state.status().closed, true)
})

test('scope, target or policy revocation during extraction cannot publish cards', async (context) => {
  for (const change of ['retire', 'replace', 'changePolicy'] as const) {
    const state: ReturnType<typeof fixture> = fixture({
      evaluate: async () => {
        state[change]()
        return { url: RESULT_URL, cards: [CARD], challenge: false, ready: true }
      },
    })
    await assert.rejects(
      runSearch(context, state.input, state.ports),
      /browser_search_page_changed|stale_grant/
    )
    assert.equal(state.status().closed, true)
  }
})

test('cancel during page read immediately disposes its target and rejects the late result', async (context) => {
  const state: ReturnType<typeof fixture> = fixture({
    evaluate: async () => {
      state.abort.abort()
      assert.equal(state.status().closed, true)
      return { url: RESULT_URL, cards: [CARD], challenge: false, ready: true }
    },
  })
  await assert.rejects(
    runSearch(context, state.input, state.ports),
    /target_closed|request_expired|browser_search_page_changed/
  )
  assert.equal(state.status().closed, true)
})

test('page execution failure preserves failure and still releases its target', async (context) => {
  const state = fixture({
    evaluate: async () => {
      throw new Error('page_execution_failed')
    },
  })
  await assert.rejects(
    runSearch(context, state.input, state.ports),
    /browser_search_extraction_failed/
  )
  assert.equal(state.status().closed, true)
})

test('search classifies uncertain navigation without replaying or retaining its target', async (context) => {
  const state = fixture()
  let attempts = 0
  state.ports.controller.executeNavigate = async () => {
    attempts += 1
    throw new Error('navigation_outcome_unknown')
  }
  await assert.rejects(
    runSearch(context, state.input, state.ports),
    /browser_search_navigation_unknown/
  )
  assert.equal(attempts, 1)
  assert.equal(state.status().closed, true)
  assert.equal(state.status().evaluated, 0)
})

test('navigation failures retain their stage and release grants without replay', async (context) => {
  const cases = [
    {
      thrown: 'navigation_cancelled_before_dispatch',
      expected: 'navigation_cancelled_before_dispatch',
    },
    { thrown: 'stale_grant', expected: 'stale_grant' },
    { thrown: 'network execution failed', expected: 'browser_search_navigation_failed' },
  ]
  for (const scenario of cases) {
    const state = fixture()
    const diagnostics: Array<{ stage: string; code: string }> = []
    let dispatched = 0
    state.ports.onFailure = (stage, code) => diagnostics.push({ stage, code })
    state.ports.controller.executeNavigate = async () => {
      dispatched += 1
      throw new Error(scenario.thrown)
    }
    await assert.rejects(runSearch(context, state.input, state.ports), {
      message: scenario.expected,
    })
    assert.equal(dispatched, 1)
    assert.deepEqual(state.status(), {
      created: 1,
      evaluated: 0,
      navigated: 0,
      revoked: 1,
      closed: true,
    })
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0].stage, 'navigation')
  }
})

test('confirmed network causes are classified without treating an aborted navigation as network failure', async (context) => {
  for (const scenario of [
    {
      code: 'ERR_INTERNET_DISCONNECTED',
      outer: 'navigation_outcome_unknown',
      expected: 'browser_search_network_failed',
    },
    {
      code: 'ERR_ABORTED',
      outer: 'navigation_outcome_unknown',
      expected: 'browser_search_navigation_unknown',
    },
    { code: 'ERR_INTERNET_DISCONNECTED', outer: 'stale_grant', expected: 'stale_grant' },
  ]) {
    const state = fixture()
    state.ports.controller.executeNavigate = async () => {
      const cause = Object.assign(new Error('navigation failed'), { code: scenario.code })
      throw new Error(scenario.outer, { cause })
    }
    await assert.rejects(runSearch(context, state.input, state.ports), {
      message: scenario.expected,
    })
    assert.equal(state.status().evaluated, 0)
    assert.equal(state.status().revoked, 1)
    assert.equal(state.status().closed, true)
  }
})

test('a failed search does not affect the next independent search scope', async (context) => {
  const failed = fixture({
    evaluate: async () => {
      throw new Error('extraction failed')
    },
  })
  await assert.rejects(
    runSearch(context, failed.input, failed.ports),
    /browser_search_extraction_failed/
  )
  const next = fixture()
  assert.deepEqual((await runSearch(context, next.input, next.ports)).cards, [CARD])
  assert.equal(failed.status().revoked, 1)
  assert.equal(next.status().revoked, 1)
  assert.equal(failed.status().closed, true)
  assert.equal(next.status().closed, true)
})
