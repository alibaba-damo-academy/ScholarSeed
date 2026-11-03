import { setTimeout as delay } from 'node:timers/promises'
import type { BrowserRegistry } from './browser.ts'
import type { BrowserSearchGrant, createBrowserReadGrants } from './grant.ts'
import type { createAgentBrowserController } from './agent.ts'
import type { BrowserSearchInput } from './agenttransport.ts'
import { BrowserSearchError } from './agenttransport.ts'
import { BROWSER_ERROR } from '../browser.ts'

const SEARCH_INTENT = 'Collect public search result candidates'
const SEARCH_SAMPLES = 8
const SEARCH_SAMPLE_MS = 250
const SEARCH_STABLE_SAMPLES = 2
const SEARCH_CARD_SCAN_FACTOR = 3
const SEARCH_MAX_CARDS = 20
const SEARCH_MAX_TITLE = 128
const SEARCH_MAX_URL = 2048
const SEARCH_MAX_DESCRIPTION = 512
const SEARCH_READ_WORLD = 1001
const SEARCH_REGIONAL_HOPS = 1
const SEARCH_FAILURE_CODES = new Set<string>([
  ...Object.values(BROWSER_ERROR),
  'stale_grant',
  'stale_target',
  'stale_action',
  'stale_scope',
  'replayed_request',
  'navigation_outcome_unknown',
  'navigation_cancelled_before_dispatch',
  'browser_search_authorization_required',
  'browser_search_results_unstable',
  'browser_search_page_changed',
  'browser_search_redirect_denied',
  'browser_search_form_invalid',
  'browser_search_form_stale',
  'browser_search_submission_unknown',
  'browser_search_submission_blocked',
])
const SEARCH_STAGE = {
  navigation: 'navigation',
  form: 'form',
  submission: 'submission',
  read: 'read',
} as const
const SEARCH_UNCLASSIFIED_ERROR = 'unclassified_error'
const SEARCH_NAVIGATION_UNKNOWN = 'browser_search_navigation_unknown'
const SEARCH_NETWORK_FAILURE = 'browser_search_network_failed'
const SEARCH_NETWORK_CODES = new Set([
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_NETWORK_CHANGED',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_TUNNEL_CONNECTION_FAILED',
])
const SEARCH_STAGE_FAILURE = {
  navigation: 'browser_search_navigation_failed',
  form: 'browser_search_form_failed',
  submission: 'browser_search_submission_failed',
  read: 'browser_search_extraction_failed',
} as const
const SEARCH_PROVIDERS = new Map([
  [
    'bing',
    {
      base: 'https://www.bing.com/search',
      home: 'https://www.bing.com/',
      parameter: 'q',
      homeWaitMs: 1_000,
      resultsWaitMs: 1_500,
      homeOrigins: ['https://www.bing.com', 'https://cn.bing.com'],
      input: '#sb_form_q',
      submit: '#search_icon',
      submitter: { name: 'search', value: '' },
      fields: { form: { pattern: '^[A-Za-z0-9_-]{1,32}$', maxLength: 32 } },
      cards: '#b_results .b_algo',
      links: ['h2 a', 'a.tilk'],
      snippetSelector: '.b_caption p, p.b_lineclamp2, .b_snippet',
      challenge: '#b_captcha, iframe[src*="captcha"], [id*="captcha"]',
      ready: '#b_results',
    },
  ],
])

interface SearchCard {
  title: string
  href: string
  description: string
}
interface SearchPage {
  url: string
  query: string | null
  renderTarget: number | null
  cards: SearchCard[]
  challenge: boolean
  ready: boolean
}
type SearchPorts = {
  registry: Pick<
    BrowserRegistry,
    | 'createSearchTarget'
    | 'takeSearchRedirect'
    | 'agentTarget'
    | 'prepareSearchForm'
    | 'executeSearchForm'
  >
  grants: ReturnType<typeof createBrowserReadGrants>
  controller: Pick<
    ReturnType<typeof createAgentBrowserController>,
    'prepareNavigate' | 'executeNavigate' | 'revoke'
  >
  enabled(): boolean
  onFailure?(stage: string, code: string, tabId: string): void
  onStage?(stage: string, tabId: string): void
}

const SEARCH_VISIBLE_SCRIPT = String.raw`element => {
    if (!(element instanceof HTMLElement) || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor)
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false
    }
    return [...element.getClientRects()].some(rectangle => rectangle.width > 0 && rectangle.height > 0)
  }`

const SEARCH_READ_SCRIPT = String.raw`function (config) {
  const visible = (${SEARCH_VISIBLE_SCRIPT})
  const text = (element, maximum) => {
    if (!visible(element)) return ''
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let output = ''
    let node = walker.nextNode()
    while (node && output.length < maximum) {
      if (visible(node.parentElement) && !node.parentElement?.closest('input, textarea, select, [contenteditable]')) {
        output += node.textContent ?? ''
      }
      node = walker.nextNode()
    }
    return output.slice(0, maximum).replace(/\s+/g, ' ').trim()
  }
  const elements = [...document.querySelectorAll(config.cards)].filter(visible).slice(0, config.maximum)
  const renderTarget = elements.findIndex(element => element.checkVisibility
    && element.checkVisibility() && !element.checkVisibility({ contentVisibilityAuto: true }))
  const cards = elements.map(card => {
    const link = config.links.map(selector => [...card.querySelectorAll(selector)].find(visible)).find(Boolean)
    const href = link?.href ?? ''
    return { title: text(link, config.titleLimit),
      href: href.length <= config.urlLimit ? href : '',
      description: text(card.querySelector(config.snippetSelector), config.descriptionLimit) }
  }).filter(card => card.href)
  const container = document.querySelector(config.ready)
  return { url: location.href, query: document.querySelector(config.input)?.value ?? null,
    renderTarget: renderTarget < 0 ? null : renderTarget,
    cards, challenge: Boolean(document.querySelector(config.challenge)),
    ready: document.readyState === 'complete' && visible(container)
      && container.getAttribute('aria-busy') !== 'true' && renderTarget < 0 }
}`

const SEARCH_SCROLL_SCRIPT = String.raw`function(config, index) {
  if (location.href !== config.expectedUrl || document.querySelector(config.input)?.value !== config.query)
    throw new Error('browser_search_page_changed')
  const visible = (${SEARCH_VISIBLE_SCRIPT})
  const elements = [...document.querySelectorAll(config.cards)].filter(visible).slice(0, config.maximum)
  if (!Number.isInteger(index) || index < 0 || index >= elements.length) throw new Error('browser_search_page_changed')
  elements[index].scrollIntoView({ block: 'center', behavior: 'instant' })
}`

export async function runBrowserSearch(
  input: BrowserSearchInput,
  ports: SearchPorts
): Promise<SearchPage> {
  const provider = SEARCH_PROVIDERS.get(input.engine)
  if (!provider) throw new BrowserSearchError('browser_search_engine_unavailable')
  if (!ports.enabled() || input.signal.aborted) throw new BrowserSearchError('browser_unavailable')
  const target = await ports.registry.createSearchTarget()
  const navigationId = `${input.requestId}:navigate`
  const readId = `${input.requestId}:read`
  const homeReadId = `${input.requestId}:home-read`
  const submitId = `${input.requestId}:submit`
  let searchGrant: BrowserSearchGrant | null = null
  const assertCurrent = () => {
    if (input.signal.aborted || !ports.enabled()) throw new BrowserSearchError('request_expired')
  }
  const wait = async (milliseconds: number): Promise<void> => {
    try {
      await delay(milliseconds, undefined, { signal: input.signal })
    } finally {
      assertCurrent()
    }
  }
  const abort = () => {
    ports.controller.revoke(target.tabId)
    target.close()
  }
  const observe = (stage: string): void => {
    try {
      ports.onStage?.(stage, target.tabId)
    } catch {}
  }
  input.signal.addEventListener('abort', abort, { once: true })
  let stage: (typeof SEARCH_STAGE)[keyof typeof SEARCH_STAGE] = SEARCH_STAGE.navigation
  try {
    assertCurrent()
    observe('homepage')
    let landingUrl = provider.home
    for (let hop = 0; ; hop += 1) {
      assertCurrent()
      const requestId = `${navigationId}:${hop}`
      const proof = ports.grants.prepareNavigate({
        sessionId: input.scope.sessionId,
        turnId: input.scope.turnId,
        requestId,
        tabId: target.tabId,
        url: landingUrl,
        intent: SEARCH_INTENT,
      })
      if (proof.policyDecision !== 'allow')
        throw new BrowserSearchError('browser_search_authorization_required')
      ports.controller.prepareNavigate(proof)
      const navigation = await ports.grants.acquireNavigate({
        scope: input.scope,
        requestId,
        proofId: proof.proofId,
        tabId: target.tabId,
      })
      assertCurrent()
      try {
        await ports.controller.executeNavigate(navigation)
        assertCurrent()
        break
      } catch (error) {
        assertCurrent()
        if (!(error instanceof Error) || error.message !== 'navigation_outcome_unknown') throw error
        const redirect = ports.registry.takeSearchRedirect(target.tabId)
        if (!redirect) throw error
        let address: URL
        try {
          address = new URL(redirect.url)
        } catch {
          throw new BrowserSearchError('browser_search_redirect_denied')
        }
        if (
          hop >= SEARCH_REGIONAL_HOPS ||
          redirect.requestedUrl !== landingUrl ||
          !provider.homeOrigins.includes(address.origin) ||
          address.origin === new URL(landingUrl).origin ||
          address.pathname !== '/' ||
          address.username ||
          address.password ||
          address.hash ||
          address.searchParams.has(provider.parameter)
        )
          throw new BrowserSearchError('browser_search_redirect_denied')
        landingUrl = address.href
        observe('regional-homepage')
      }
    }
    observe('homepage-settle')
    await wait(provider.homeWaitMs)
    assertCurrent()
    const resultUrl = new URL(new URL(provider.base).pathname, landingUrl).href
    const destination = new URL(resultUrl)
    destination.searchParams.set(provider.parameter, input.query.trim())
    stage = SEARCH_STAGE.form
    const homeRead = ports.grants.prepareRead({
      sessionId: input.scope.sessionId,
      turnId: input.scope.turnId,
      requestId: homeReadId,
      tabId: target.tabId,
      intent: SEARCH_INTENT,
    })
    if (homeRead.policyDecision !== 'allow')
      throw new BrowserSearchError('browser_search_authorization_required')
    const homeAuthority = await ports.grants.acquireSnapshot({
      scope: input.scope,
      requestId: homeReadId,
      proofId: homeRead.proofId,
      tabId: target.tabId,
    })
    observe('form-inspection')
    const form = await ports.registry.prepareSearchForm(
      target.tabId,
      {
        landingUrl,
        resultUrl,
        inputSelector: provider.input,
        submitSelector: provider.submit,
        queryParameter: provider.parameter,
        fields: provider.fields,
        submitter: provider.submitter,
      },
      input.query.trim(),
      input.signal
    )
    assertCurrent()
    searchGrant = ports.grants.issueSearch({
      authority: homeAuthority,
      requestId: submitId,
      url: form.destinationUrl,
      query: input.query.trim(),
      parameter: provider.parameter,
    })
    ports.grants.claimSearch(searchGrant)
    const authority = searchGrant
    stage = SEARCH_STAGE.submission
    observe('form-submit')
    await ports.registry.executeSearchForm(
      form,
      () => !input.signal.aborted && ports.enabled() && ports.grants.validateSearch(authority)
    )
    assertCurrent()
    stage = SEARCH_STAGE.read
    observe('result-read')
    const read = ports.grants.prepareRead({
      sessionId: input.scope.sessionId,
      turnId: input.scope.turnId,
      requestId: readId,
      tabId: target.tabId,
      intent: SEARCH_INTENT,
    })
    if (read.policyDecision !== 'allow')
      throw new BrowserSearchError('browser_search_authorization_required')
    const resultAuthority = await ports.grants.acquireSnapshot({
      scope: input.scope,
      requestId: readId,
      proofId: read.proofId,
      tabId: target.tabId,
    })
    observe('result-settle')
    await wait(provider.resultsWaitMs)
    assertCurrent()
    const source = ports.registry.agentTarget(target.tabId)
    const config = {
      ...provider,
      expectedUrl: form.destinationUrl,
      query: input.query.trim(),
      maximum: Math.min(SEARCH_MAX_CARDS, input.limit * SEARCH_CARD_SCAN_FACTOR),
      titleLimit: SEARCH_MAX_TITLE,
      urlLimit: SEARCH_MAX_URL,
      descriptionLimit: SEARCH_MAX_DESCRIPTION,
    }
    let previous = ''
    let stable = 0
    for (let sample = 0; sample < SEARCH_SAMPLES; sample += 1) {
      assertCurrent()
      if (!ports.grants.validateAuthority(resultAuthority)) throw new Error('stale_grant')
      const result = (await source.contents.executeJavaScriptInIsolatedWorld(SEARCH_READ_WORLD, [
        { code: `(${SEARCH_READ_SCRIPT})(${JSON.stringify(config)})` },
      ])) as SearchPage
      const current = ports.registry.agentTarget(target.tabId)
      const address = new URL(result.url)
      if (
        !ports.grants.validateAuthority(resultAuthority) ||
        current.instanceId !== source.instanceId ||
        current.generation !== source.generation ||
        current.contents !== source.contents ||
        address.origin !== destination.origin ||
        address.pathname !== destination.pathname ||
        address.searchParams.getAll(provider.parameter).length !== 1 ||
        address.searchParams.get(provider.parameter) !== input.query.trim() ||
        (!result.challenge && result.query !== input.query.trim())
      )
        throw new BrowserSearchError('browser_search_page_changed')
      assertCurrent()
      if (result.challenge) return result
      if (result.renderTarget !== null && result.renderTarget !== undefined) {
        if (!ports.grants.validateSearch(authority)) throw new Error('stale_grant')
        await source.contents.executeJavaScriptInIsolatedWorld(SEARCH_READ_WORLD, [
          {
            code: `(${SEARCH_SCROLL_SCRIPT})(${JSON.stringify(config)}, ${JSON.stringify(result.renderTarget)})`,
          },
        ])
        if (
          !ports.grants.validateSearch(authority) ||
          !ports.grants.validateAuthority(resultAuthority)
        )
          throw new Error('stale_grant')
        previous = ''
        stable = 0
        await wait(SEARCH_SAMPLE_MS)
        continue
      }
      const signature = JSON.stringify({
        query: result.query,
        ready: result.ready,
        cards: result.cards,
      })
      stable = signature === previous ? stable + 1 : 1
      previous = signature
      if (result.ready && stable >= SEARCH_STABLE_SAMPLES) return result
      await wait(SEARCH_SAMPLE_MS)
    }
    throw new BrowserSearchError('browser_search_results_unstable')
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined
    const networkCode =
      cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
    const networkFailed =
      stage === SEARCH_STAGE.navigation &&
      error instanceof Error &&
      (error.message === 'navigation_outcome_unknown' ||
        error.message === BROWSER_ERROR.navigationFailed) &&
      typeof networkCode === 'string' &&
      SEARCH_NETWORK_CODES.has(networkCode)
    const code = networkFailed
      ? SEARCH_NETWORK_FAILURE
      : error instanceof Error && SEARCH_FAILURE_CODES.has(error.message)
        ? error.message
        : SEARCH_UNCLASSIFIED_ERROR
    try {
      ports.onFailure?.(stage, code, target.tabId)
    } catch {}
    if (error instanceof BrowserSearchError) throw error
    throw new BrowserSearchError(
      code === 'navigation_outcome_unknown'
        ? SEARCH_NAVIGATION_UNKNOWN
        : code === SEARCH_UNCLASSIFIED_ERROR
          ? SEARCH_STAGE_FAILURE[stage]
          : code
    )
  } finally {
    input.signal.removeEventListener('abort', abort)
    if (searchGrant) ports.grants.finishSearch(searchGrant)
    ports.grants.revokeTab(target.tabId)
    ports.controller.revoke(target.tabId)
    target.close()
  }
}
