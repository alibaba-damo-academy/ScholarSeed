import assert from 'node:assert/strict'
import type { BrowserSearchInput } from './agenttransport.ts'
import { createBrowserReadGrants } from './grant.ts'
import type { runBrowserSearch } from './search.ts'

export const SCOPE = {
  sessionId: 'invocation-search',
  instanceId: 'execution-instance',
  productTurnId: 'invocation-search',
  turnId: 'vendor-turn',
  generation: 1,
  interruptGeneration: 0,
  lifecycleEpoch: 1,
}
export const TAB_ID = 'dedicated-search-tab'
export const RESULT_URL = 'https://www.bing.com/search?q=test'
export const ORIGIN = 'https://www.bing.com'
export const HOME_URL = `${ORIGIN}/`
export const REGIONAL_ORIGIN = 'https://cn.bing.com'
export const REGIONAL_HOME = `${REGIONAL_ORIGIN}/?mkt=zh-CN`
export const CARD = { title: 'Result', href: 'https://example.org/result', description: 'Summary' }
export const FIRST_CARD = { ...CARD, title: 'Loading result' }
export const DEADLINE_MS = 10_000
type Decision = 'ask' | 'allow' | 'block'
type SearchPorts = Parameters<typeof runBrowserSearch>[1]
export type SearchResult = Awaited<ReturnType<typeof runBrowserSearch>>
type SearchSample = Omit<SearchResult, 'query' | 'renderTarget'> &
  Partial<Pick<SearchResult, 'query' | 'renderTarget'>>

interface SearchFixture {
  input: BrowserSearchInput
  ports: SearchPorts
  abort: AbortController
  requests: string[]
  steps: string[]
  grants: ReturnType<typeof createBrowserReadGrants>
  status(): {
    created: number
    evaluated: number
    navigated: number
    revoked: number
    closed: boolean
  }
  disable(): void
  retire(): void
  replace(): void
  changePolicy(): void
}

export function fixture(
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
): SearchFixture {
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
