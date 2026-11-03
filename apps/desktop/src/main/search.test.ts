import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { _electron } from 'playwright'
import type { BrowserSearchInput } from './agenttransport.ts'
import { createBrowserReadGrants } from './grant.ts'
import { runBrowserSearch } from './search.ts'

const SCOPE = {
  sessionId: 'invocation-search',
  instanceId: 'execution-instance',
  productTurnId: 'invocation-search',
  turnId: 'vendor-turn',
  generation: 1,
  interruptGeneration: 0,
  lifecycleEpoch: 1,
}
const TAB_ID = 'dedicated-search-tab'
const RESULT_URL = 'https://www.bing.com/search?q=test'
const ORIGIN = 'https://www.bing.com'
const HOME_URL = `${ORIGIN}/`
const REGIONAL_ORIGIN = 'https://cn.bing.com'
const REGIONAL_HOME = `${REGIONAL_ORIGIN}/?mkt=zh-CN`
const CARD = { title: 'Result', href: 'https://example.org/result', description: 'Summary' }
const FIRST_CARD = { ...CARD, title: 'Loading result' }
const DEADLINE_MS = 10_000
type Decision = 'ask' | 'allow' | 'block'
type SearchPorts = Parameters<typeof runBrowserSearch>[1]
type SearchResult = Awaited<ReturnType<typeof runBrowserSearch>>
type SearchSample = Omit<SearchResult, 'query' | 'renderTarget'> &
  Partial<Pick<SearchResult, 'query' | 'renderTarget'>>

function fixture(
  options: {
    navigate?: Decision
    read?: Decision
    submit?: () => Promise<void>
    redirects?: Array<{ url: string; requestedUrl?: string }>
    regionalNavigate?: Decision
    regionalRead?: Decision
    responses?: SearchSample[]
    evaluate?: (expression: string) => Promise<SearchSample>
  } = {}
) {
  const abort = new AbortController()
  let enabled = true
  let activeScope: typeof SCOPE | null = SCOPE
  let navigationOrigin: string | null = null
  let revision = 1
  let generation = 1
  let closed = false
  let created = 0
  let evaluated = 0
  let navigated = 0
  let revoked = 0
  let currentUrl = HOME_URL
  let redirectReceipt: { url: string; requestedUrl: string } | null = null
  let redirectIndex = 0
  const requests: string[] = []
  const steps: string[] = []
  const responses = options.responses
  const contents = {
    async executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]) {
      assert.equal(worldId, 1001)
      const expression = scripts[0].code
      evaluated += 1
      requests.push(expression)
      if (options.evaluate)
        return { query: 'test', renderTarget: null, ...(await options.evaluate(expression)) }
      return {
        query: 'test',
        renderTarget: null,
        ...(responses
          ? responses[Math.min(evaluated - 1, responses.length - 1)]
          : { url: currentUrl, cards: [CARD], challenge: false, ready: true }),
      }
    },
  }
  const identity = () => ({
    instanceId: 'search-target-instance',
    generation,
    origin: new URL(currentUrl).origin,
  })
  const grants = createBrowserReadGrants({
    scope: () => activeScope,
    target: () => (closed ? null : identity()),
    navigateTarget: () => (closed ? null : { ...identity(), origin: navigationOrigin }),
    policy: (origin) => ({
      revision,
      decision: (origin === REGIONAL_ORIGIN ? options.regionalRead : options.read) ?? 'allow',
    }),
    navigatePolicy: (origin) => ({
      revision,
      decision:
        (origin === REGIONAL_ORIGIN ? options.regionalNavigate : options.navigate) ?? 'allow',
    }),
  })
  const ports: SearchPorts = {
    registry: {
      async createSearchTarget() {
        created += 1
        return {
          tabId: TAB_ID,
          close() {
            closed = true
          },
        }
      },
      takeSearchRedirect(tabId) {
        assert.equal(tabId, TAB_ID)
        const receipt = redirectReceipt
        redirectReceipt = null
        return receipt
      },
      agentTarget(tabId: string) {
        assert.equal(tabId, TAB_ID)
        if (closed) throw new Error('target_closed')
        return {
          ...identity(),
          contents,
          url: currentUrl,
          title: 'Search',
        } as unknown as ReturnType<SearchPorts['registry']['agentTarget']>
      },
      async prepareSearchForm(tabId, config, query) {
        assert.equal(tabId, TAB_ID)
        assert.equal(config.landingUrl, currentUrl)
        assert.equal(new URL(config.resultUrl).origin, new URL(currentUrl).origin)
        assert.deepEqual(config.submitter, { name: 'search', value: '' })
        steps.push(`prepare:${query}`)
        const destination = new URL(config.resultUrl)
        destination.searchParams.set(config.queryParameter, query)
        return {
          tabId,
          destinationUrl: destination.href,
          source: { instanceId: identity().instanceId, generation },
        }
      },
      async executeSearchForm(prepared, validate) {
        assert.equal(prepared.tabId, TAB_ID)
        if (!validate()) throw new Error('stale_grant')
        steps.push('submit')
        if (options.submit) await options.submit()
        if (!validate()) throw new Error('stale_grant')
        currentUrl = prepared.destinationUrl
        generation += 1
        grants.revokeTab(TAB_ID, true)
        if (!validate()) throw new Error('stale_grant')
      },
    },
    grants,
    controller: {
      prepareNavigate(proof) {
        assert.ok([ORIGIN, REGIONAL_ORIGIN].includes(proof.destinationOrigin))
      },
      async executeNavigate(grant) {
        assert.equal(grant.scope.sessionId, SCOPE.sessionId)
        steps.push(`navigate:${grant.url}`)
        const redirect = options.redirects?.[redirectIndex++]
        if (redirect) {
          redirectReceipt = { url: redirect.url, requestedUrl: redirect.requestedUrl ?? grant.url }
          throw new Error('navigation_outcome_unknown')
        }
        currentUrl = grant.url
        navigationOrigin = new URL(grant.url).origin
        navigated += 1
      },
      revoke(tabId: string) {
        assert.equal(tabId, TAB_ID)
        revoked += 1
      },
    },
    enabled: () => enabled,
  }
  const input: BrowserSearchInput = {
    scope: SCOPE,
    requestId: 'search-request',
    engine: 'bing',
    query: 'test',
    limit: 20,
    signal: abort.signal,
  }
  return {
    input,
    ports,
    abort,
    requests,
    steps,
    grants,
    status: () => ({ created, evaluated, navigated, revoked, closed }),
    disable: () => {
      enabled = false
    },
    retire: () => {
      activeScope = null
    },
    replace: () => {
      generation += 1
    },
    changePolicy: () => {
      revision += 1
    },
  }
}

test('search opens the homepage and submits its observed form instead of navigating to a query URL', async () => {
  const state = fixture()
  await runBrowserSearch(state.input, state.ports)
  assert.deepEqual(state.steps, [`navigate:${HOME_URL}`, 'prepare:test', 'submit'])
})

test('search stage diagnostics retain target correlation without query contents', async () => {
  const state = fixture()
  const diagnostics: Array<{ stage: string; tabId: string }> = []
  state.ports.onStage = (stage, tabId) => diagnostics.push({ stage, tabId })
  await runBrowserSearch(state.input, state.ports)
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

test('diagnostic failures do not change search success, original rejection or cleanup', async () => {
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
    if (!failure) assert.equal((await runBrowserSearch(state.input, state.ports)).cards.length, 1)
    else
      await assert.rejects(
        runBrowserSearch(state.input, state.ports),
        /navigation_cancelled_before_dispatch/
      )
    assert.equal(state.status().closed, true)
  }
})

test('an actually blocked regional homepage redirect requires independent destination grants', async () => {
  const state = fixture({ redirects: [{ url: REGIONAL_HOME }] })
  const result = await runBrowserSearch(state.input, state.ports)
  assert.deepEqual(state.steps, [
    `navigate:${HOME_URL}`,
    `navigate:${REGIONAL_HOME}`,
    'prepare:test',
    'submit',
  ])
  assert.equal(result.url, `${REGIONAL_ORIGIN}/search?q=test`)
  assert.equal(state.status().closed, true)
})

test('regional navigation and reading never auto-approve ask or block', async () => {
  for (const decision of ['ask', 'block'] as const) {
    for (const permission of ['regionalNavigate', 'regionalRead'] as const) {
      const state = fixture({ redirects: [{ url: REGIONAL_HOME }], [permission]: decision })
      await assert.rejects(
        runBrowserSearch(state.input, state.ports),
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

test('regional redirect receipts reject foreign origins, stale requests and non-homepage targets', async () => {
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
      runBrowserSearch(state.input, state.ports),
      /browser_search_redirect_denied/
    )
    assert.deepEqual(state.steps, [`navigate:${HOME_URL}`])
    assert.equal(state.status().closed, true)
  }
})

test('regional redirect loops stop after one independently authorized hop', async () => {
  const state = fixture({ redirects: [{ url: REGIONAL_HOME }, { url: HOME_URL }] })
  await assert.rejects(runBrowserSearch(state.input, state.ports), /browser_search_redirect_denied/)
  assert.deepEqual(state.steps, [`navigate:${HOME_URL}`, `navigate:${REGIONAL_HOME}`])
  assert.equal(state.status().evaluated, 0)
})

test('regional redirect consumption cannot revive a cancelled or retired search', async () => {
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
      runBrowserSearch(state.input, state.ports),
      change === 'cancel' ? /request_expired/ : /stale_grant/
    )
    assert.deepEqual(state.steps, [`navigate:${HOME_URL}`])
    assert.equal(state.status().evaluated, 0)
    assert.equal(state.status().closed, true)
  }
})

test('regional search cannot publish results from the originally authorized origin', async () => {
  const state = fixture({
    redirects: [{ url: REGIONAL_HOME }],
    responses: [{ url: RESULT_URL, cards: [CARD], challenge: false, ready: true }],
  })
  await assert.rejects(runBrowserSearch(state.input, state.ports), /browser_search_page_changed/)
  assert.equal(state.status().closed, true)
})

test('form submission rechecks policy and scope and never extracts on revocation', async () => {
  for (const change of ['retire', 'replace', 'changePolicy'] as const) {
    const state: ReturnType<typeof fixture> = fixture({
      submit: async () => {
        state[change]()
      },
    })
    await assert.rejects(
      runBrowserSearch(state.input, state.ports),
      /stale_grant|browser_search_page_changed/
    )
    assert.equal(state.status().evaluated, 0)
    assert.equal(state.status().closed, true)
  }
})

test('unknown form submission is never retried or reported as an empty search', async () => {
  const state = fixture({
    submit: async () => {
      throw new Error('browser_search_submission_unknown')
    },
  })
  await assert.rejects(
    runBrowserSearch(state.input, state.ports),
    /browser_search_submission_unknown/
  )
  assert.equal(state.steps.filter((step) => step === 'submit').length, 1)
  assert.equal(state.status().evaluated, 0)
  assert.equal(state.status().closed, true)
})

test('form authorization failures preserve their code and submission stage without retrying', async () => {
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
    await assert.rejects(runBrowserSearch(state.input, state.ports), { message: code })
    assert.deepEqual(failures, [{ stage: 'submission', code }])
    assert.equal(state.steps.filter((step) => step === 'submit').length, 1)
    assert.equal(state.status().evaluated, 0)
    assert.equal(state.status().closed, true)
  }
})

test('search requires stable card content and closes only its owned target', async () => {
  const state = fixture({
    responses: [
      { url: RESULT_URL, cards: [FIRST_CARD], challenge: false, ready: true },
      { url: RESULT_URL, cards: [CARD], challenge: false, ready: true },
    ],
  })
  const result = await runBrowserSearch(state.input, state.ports)
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

test('stable ready empty results are valid', async () => {
  const state = fixture({
    responses: [{ url: RESULT_URL, cards: [], challenge: false, ready: true }],
  })
  assert.deepEqual((await runBrowserSearch(state.input, state.ports)).cards, [])
  assert.equal(state.status().evaluated, 2)
  assert.equal(state.status().closed, true)
})

test(
  'unstable or unready results never become empty success',
  { timeout: DEADLINE_MS },
  async () => {
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
        runBrowserSearch(state.input, state.ports),
        /browser_search_results_unstable/
      )
      assert.equal(state.status().closed, true)
    }
  }
)

test('CAPTCHA is returned without extracting successful candidates', async () => {
  const response = {
    url: RESULT_URL,
    query: null,
    renderTarget: null,
    cards: [],
    challenge: true,
    ready: false,
  }
  const state = fixture({ responses: [response] })
  assert.deepEqual(await runBrowserSearch(state.input, state.ports), response)
  assert.equal(state.status().evaluated, 1)
  assert.equal(state.status().closed, true)
})

test('navigation and read ask or block never silently approve', async () => {
  for (const phase of ['navigate', 'read'] as const) {
    for (const decision of ['ask', 'block'] as const) {
      const state = fixture({ [phase]: decision })
      await assert.rejects(
        runBrowserSearch(state.input, state.ports),
        decision === 'ask' ? /browser_search_authorization_required/ : /stale_grant/
      )
      assert.equal(state.status().evaluated, 0)
      assert.equal(state.status().closed, true)
      assert.equal(state.status().navigated, phase === 'read' ? 1 : 0)
    }
  }
})

test('disabled or aborted search creates no target', async () => {
  for (const condition of ['disabled', 'aborted']) {
    const state = fixture()
    if (condition === 'disabled') state.disable()
    else state.abort.abort()
    await assert.rejects(runBrowserSearch(state.input, state.ports), /browser_unavailable/)
    assert.equal(state.status().created, 0)
  }
})

test('query or origin change rejects candidates and disposes its target', async () => {
  for (const url of [
    'https://www.bing.com/search?q=wrong',
    'https://www.bing.com/search?q=test&q=extra',
    'http://www.bing.com/search?q=test',
    'https://example.org/search?q=test',
  ]) {
    const state = fixture({ responses: [{ url, cards: [CARD], challenge: false, ready: true }] })
    await assert.rejects(runBrowserSearch(state.input, state.ports), /browser_search_page_changed/)
    assert.equal(state.status().closed, true)
  }
})

test('homepage and result settling remain cancellable without publishing or replay', async () => {
  for (const stage of ['homepage-settle', 'result-settle']) {
    const state = fixture()
    state.ports.onStage = (observed) => {
      if (observed === stage) state.abort.abort()
    }
    await assert.rejects(runBrowserSearch(state.input, state.ports), /request_expired/)
    assert.equal(state.status().closed, true)
    assert.equal(state.status().evaluated, 0)
    assert.equal(
      state.steps.filter((step) => step === 'submit').length,
      stage === 'result-settle' ? 1 : 0
    )
  }
})

test('a skipped result is scrolled before a new stable read and cannot survive revocation', async () => {
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
    if (revoked) await assert.rejects(runBrowserSearch(state.input, state.ports), /stale_grant/)
    else assert.deepEqual((await runBrowserSearch(state.input, state.ports)).cards, [CARD])
    assert.equal(scrolled, true)
    assert.equal(state.status().closed, true)
  }
})

test('result input must match the requested query even when the URL is correct', async () => {
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
  await assert.rejects(runBrowserSearch(state.input, state.ports), /browser_search_page_changed/)
  assert.equal(state.status().closed, true)
})

test('scope, target or policy revocation during extraction cannot publish cards', async () => {
  for (const change of ['retire', 'replace', 'changePolicy'] as const) {
    const state: ReturnType<typeof fixture> = fixture({
      evaluate: async () => {
        state[change]()
        return { url: RESULT_URL, cards: [CARD], challenge: false, ready: true }
      },
    })
    await assert.rejects(
      runBrowserSearch(state.input, state.ports),
      /browser_search_page_changed|stale_grant/
    )
    assert.equal(state.status().closed, true)
  }
})

test('cancel during page read immediately disposes its target and rejects the late result', async () => {
  const state: ReturnType<typeof fixture> = fixture({
    evaluate: async () => {
      state.abort.abort()
      assert.equal(state.status().closed, true)
      return { url: RESULT_URL, cards: [CARD], challenge: false, ready: true }
    },
  })
  await assert.rejects(
    runBrowserSearch(state.input, state.ports),
    /target_closed|request_expired|browser_search_page_changed/
  )
  assert.equal(state.status().closed, true)
})

test('page execution failure preserves failure and still releases its target', async () => {
  const state = fixture({
    evaluate: async () => {
      throw new Error('page_execution_failed')
    },
  })
  await assert.rejects(
    runBrowserSearch(state.input, state.ports),
    /browser_search_extraction_failed/
  )
  assert.equal(state.status().closed, true)
})

test('search classifies uncertain navigation without replaying or retaining its target', async () => {
  const state = fixture()
  let attempts = 0
  state.ports.controller.executeNavigate = async () => {
    attempts += 1
    throw new Error('navigation_outcome_unknown')
  }
  await assert.rejects(
    runBrowserSearch(state.input, state.ports),
    /browser_search_navigation_unknown/
  )
  assert.equal(attempts, 1)
  assert.equal(state.status().closed, true)
  assert.equal(state.status().evaluated, 0)
})

test('navigation failures retain their stage and release grants without replay', async () => {
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
    await assert.rejects(runBrowserSearch(state.input, state.ports), { message: scenario.expected })
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

test('confirmed network causes are classified without treating an aborted navigation as network failure', async () => {
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
    await assert.rejects(runBrowserSearch(state.input, state.ports), { message: scenario.expected })
    assert.equal(state.status().evaluated, 0)
    assert.equal(state.status().revoked, 1)
    assert.equal(state.status().closed, true)
  }
})

test('a failed search does not affect the next independent search scope', async () => {
  const failed = fixture({
    evaluate: async () => {
      throw new Error('extraction failed')
    },
  })
  await assert.rejects(
    runBrowserSearch(failed.input, failed.ports),
    /browser_search_extraction_failed/
  )
  const next = fixture()
  assert.deepEqual((await runBrowserSearch(next.input, next.ports)).cards, [CARD])
  assert.equal(failed.status().revoked, 1)
  assert.equal(next.status().revoked, 1)
  assert.equal(failed.status().closed, true)
  assert.equal(next.status().closed, true)
})

test(
  'real Electron DOM prioritizes result headings and excludes hidden, inert, sensitive and cross-frame text',
  { timeout: DEADLINE_MS },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'search-dom-'))
    const entry = join(temporary, 'main.cjs')
    await writeFile(
      entry,
      `const {app}=require('electron'); app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))}); app.on('window-all-closed',()=>{}); app.whenReady();`
    )
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
    delete environment.ELECTRON_RUN_AS_NODE
    const browser = await _electron.launch({ args: [entry], env: environment })
    try {
      const body = `
        <input id="sb_form_q" value="test">
        <div id="b_results">
          <div class="b_algo"><a class="tilk" href="https://example.org/visible">Brand and domain</a><h2><a href="https://example.org/visible">Visible
            <span hidden>hidden title</span><span style="opacity:0">transparent title</span></a></h2>
            <div class="b_caption"><p>Summary <span inert>secret inert</span>
              <span contenteditable>secret editable</span><input value="secret input">
              <span aria-hidden="true">secret aria</span><span style="visibility:hidden">secret style</span></p></div>
          </div>
          <div class="b_algo"><h2 hidden><a href="https://example.org/hidden-heading">Hidden heading</a></h2>
            <a class="tilk" href="https://example.org/fallback">Fallback title</a></div>
          <div class="b_algo" hidden><h2><a href="https://example.org/hidden">Hidden card</a></h2></div>
          <div inert><div class="b_algo"><h2><a href="https://example.org/inert">Inert card</a></h2></div></div>
          <div class="b_algo" style="opacity:0"><h2><a href="https://example.org/transparent">Transparent card</a></h2></div>
          <div class="b_algo"><h2><a style="display:none" href="https://example.org/hidden-link">Secret link</a></h2></div>
          <div class="b_algo"><h2><a href="https://example.org/${'long'.repeat(600)}">Overlong link</a></h2></div>
        </div>
        <iframe srcdoc='<div class="b_algo"><h2><a href="https://example.org/frame">Frame secret</a></h2></div>'></iframe>
      `
      await browser.evaluate(
        async ({ app, BrowserWindow, session }, input) => {
          await app.whenReady()
          await session.defaultSession.protocol.handle(
            'https',
            () => new Response(input.body, { headers: { 'content-type': 'text/html' } })
          )
          const window = new BrowserWindow({
            show: false,
            webPreferences: { contextIsolation: true, sandbox: true },
          })
          await window.loadURL(input.url)
          await window.webContents.executeJavaScript(
            "window.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' }); null"
          )
        },
        { body, url: RESULT_URL }
      )
      const state = fixture({
        evaluate: async (expression) => {
          return (await browser.evaluate(async ({ BrowserWindow }, script) => {
            return await BrowserWindow.getAllWindows()[0].webContents.executeJavaScriptInIsolatedWorld(
              1001,
              [{ code: script }]
            )
          }, expression)) as SearchResult
        },
      })
      const result = await runBrowserSearch(state.input, state.ports)
      assert.deepEqual(
        result.cards.filter((card) => card.title),
        [
          { title: 'Visible', href: 'https://example.org/visible', description: 'Summary' },
          { title: 'Fallback title', href: 'https://example.org/fallback', description: '' },
        ]
      )
      assert.ok(result.cards.every((card) => !JSON.stringify(card).includes('secret')))
      assert.equal(state.status().closed, true)
    } finally {
      await browser.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)
