import {
  RECORDER_BODY_MAX_LENGTH,
  RECORDER_ROOT_ATTRIBUTE,
  type NetworkRecord,
  type RecordedStep,
  type StepKind
} from './model.ts'
import { summarizeTarget } from './target.ts'

const REQUEST_STEP_WINDOW_MS = 10_000
const PAGE_LABEL_MAX_LENGTH = 80
const EVENT_SOURCE_MEDIA_TYPE = 'text/event-stream'
const BINARY_MEDIA_PREFIXES = ['image/', 'audio/', 'video/']
const PAGE_LABEL_SELECTORS = [
  '[data-feedback-page-name]',
  '[role="tab"][aria-selected="true"]',
  '[aria-current="page"]',
  'main h1',
  'main h2'
]
const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]'

export interface RecorderLease {
  dispose: () => void
}

export interface RecorderProbeOptions {
  startedAtMs: number
  onStep: (step: RecordedStep) => void
  onRequest: (request: NetworkRecord) => void
  latestStep: () => RecordedStep | undefined
}

interface XhrMeta {
  method: string
  url: string
  startedAtMs: number
  requestBody?: string
  stepId?: string
}

let currentLease: RecorderLease | null = null

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function normalizedLabel(value: string | null | undefined): string | undefined {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, PAGE_LABEL_MAX_LENGTH) : undefined
}

function labelledByText(element: Element): string | undefined {
  const labelledBy = element.getAttribute('aria-labelledby')
  if (!labelledBy || typeof document.getElementById !== 'function') return undefined
  return normalizedLabel(labelledBy
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent || '')
    .join(' '))
}

function dialogLabel(eventTarget: EventTarget | null): string | undefined {
  if (!(eventTarget instanceof Element)) return undefined
  const dialog = eventTarget.closest(DIALOG_SELECTOR)
  if (!dialog) return undefined
  return normalizedLabel(dialog.getAttribute('aria-label'))
    || labelledByText(dialog)
    || normalizedLabel(dialog.querySelector('h1, h2, h3, [role="heading"]')?.textContent)
}

function pageContext(eventTarget: EventTarget | null): RecordedStep['page'] {
  const path = `${window.location.pathname || ''}${window.location.search || ''}${window.location.hash || ''}`
  const label = typeof document.querySelector === 'function'
    ? PAGE_LABEL_SELECTORS
      .map((selector) => document.querySelector(selector)?.textContent || '')
      .map(normalizedLabel)
      .find(Boolean)
    : undefined
  const currentDialogLabel = eventTarget ? dialogLabel(eventTarget) : undefined
  return {
    url: window.location.href,
    title: document.title,
    ...(path ? { path } : {}),
    ...(label ? { label } : {}),
    ...(currentDialogLabel ? { dialogLabel: currentDialogLabel } : {})
  }
}

function isRecorderEvent(event: Event): boolean {
  return event.composedPath().some(
    (entry) => entry instanceof Element && entry.hasAttribute(RECORDER_ROOT_ATTRIBUTE)
  )
}

function inputValue(target: EventTarget | null): string | undefined {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return target.value.slice(0, RECORDER_BODY_MAX_LENGTH)
  }
  if (target instanceof HTMLSelectElement) return target.value
  if (target instanceof HTMLElement && target.isContentEditable) {
    return String(target.textContent || '').slice(0, RECORDER_BODY_MAX_LENGTH)
  }
  return undefined
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) {
    return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(
      String(target.type || 'text').toLowerCase()
    )
  }
  if (target instanceof HTMLTextAreaElement) return true
  return target instanceof HTMLElement && target.isContentEditable
}

function bodyText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value.slice(0, RECORDER_BODY_MAX_LENGTH)
  if (value instanceof URLSearchParams) return value.toString().slice(0, RECORDER_BODY_MAX_LENGTH)
  if (value instanceof FormData) {
    const entries = Array.from(value.entries(), ([key, item]) => [key, item instanceof File ? `[File ${item.name}]` : item])
    return JSON.stringify(entries).slice(0, RECORDER_BODY_MAX_LENGTH)
  }
  if (value instanceof Blob) return `[Blob ${value.type || 'application/octet-stream'} ${value.size} bytes]`
  if (ArrayBuffer.isView(value)) return `[Binary ${value.byteLength} bytes]`
  if (value instanceof ArrayBuffer) return `[Binary ${value.byteLength} bytes]`
  return String(value).slice(0, RECORDER_BODY_MAX_LENGTH)
}

function canReadResponse(contentType: string): boolean {
  const normalized = contentType.toLowerCase()
  return !normalized.includes(EVENT_SOURCE_MEDIA_TYPE) &&
    !normalized.includes('application/octet-stream') &&
    !BINARY_MEDIA_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

async function responseText(response: Response): Promise<string | undefined> {
  const contentType = response.headers.get('content-type') || ''
  if (!canReadResponse(contentType)) return undefined
  try {
    return (await response.clone().text()).slice(0, RECORDER_BODY_MAX_LENGTH)
  } catch {
    return undefined
  }
}

function associatedStep(options: RecorderProbeOptions, startedAtMs: number): string | undefined {
  const step = options.latestStep()
  if (!step) return undefined
  const occurredAt = Date.parse(step.occurredAt)
  return startedAtMs - occurredAt <= REQUEST_STEP_WINDOW_MS ? step.stepId : undefined
}

export function createInitialPageStep(startedAtMs: number): RecordedStep {
  return {
    stepId: id('step'),
    occurredAt: new Date(startedAtMs).toISOString(),
    elapsedMs: 0,
    kind: 'navigation',
    page: pageContext(null),
    target: { tag: 'window', role: 'navigation' }
  }
}

export function installRecorderProbe(options: RecorderProbeOptions): RecorderLease {
  currentLease?.dispose()
  let active = true
  let pendingInput: { target: EventTarget | null; value?: string } | null = null
  const originalFetch = window.fetch
  const originalOpen = XMLHttpRequest.prototype.open
  const callOpen = originalOpen as (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ) => void
  const originalSend = XMLHttpRequest.prototype.send
  const originalPushState = history.pushState
  const originalReplaceState = history.replaceState
  const xhrMetadata = new WeakMap<XMLHttpRequest, XhrMeta>()

  const record = (
    kind: StepKind,
    eventTarget: EventTarget | null,
    value?: string,
    pointer?: RecordedStep['pointer']
  ): void => {
    if (!active) return
    const now = Date.now()
    options.onStep({
      stepId: id('step'),
      occurredAt: new Date(now).toISOString(),
      elapsedMs: now - options.startedAtMs,
      kind,
      page: pageContext(eventTarget),
      target: kind === 'navigation' ? { tag: 'window', role: 'navigation' } : summarizeTarget(eventTarget),
      ...(value !== undefined ? { value } : {}),
      ...(pointer ? { pointer } : {})
    })
  }

  const flushPendingInput = (): void => {
    const pending = pendingInput
    pendingInput = null
    if (pending) record('input', pending.target, pending.value)
  }

  const onClick = (event: MouseEvent): void => {
    if (!isRecorderEvent(event)) {
      record('click', event.target, undefined, {
        x: Math.round(event.clientX),
        y: Math.round(event.clientY)
      })
    }
  }
  const onInput = (event: Event): void => {
    if (isRecorderEvent(event) || !isTextEntryTarget(event.target)) return
    if (pendingInput && pendingInput.target !== event.target) flushPendingInput()
    pendingInput = { target: event.target, value: inputValue(event.target) }
  }
  const onChange = (event: Event): void => {
    if (isRecorderEvent(event)) return
    if (isTextEntryTarget(event.target)) {
      if (pendingInput?.target === event.target) flushPendingInput()
      return
    }
    record('change', event.target, inputValue(event.target))
  }
  const onFocusOut = (event: FocusEvent): void => {
    if (pendingInput?.target === event.target) flushPendingInput()
  }
  const onNavigation = (): void => record('navigation', window)

  document.addEventListener('click', onClick, true)
  document.addEventListener('input', onInput, true)
  document.addEventListener('change', onChange, true)
  document.addEventListener('focusout', onFocusOut, true)
  window.addEventListener('popstate', onNavigation)
  window.addEventListener('hashchange', onNavigation)

  const pushStateWrapper: History['pushState'] = function (...args): void {
    originalPushState.apply(history, args)
    onNavigation()
  }
  const replaceStateWrapper: History['replaceState'] = function (...args): void {
    originalReplaceState.apply(history, args)
    onNavigation()
  }
  history.pushState = pushStateWrapper
  history.replaceState = replaceStateWrapper

  const fetchWrapper: typeof window.fetch = async (input, init) => {
    const startedAtMs = Date.now()
    const request = input instanceof Request ? input : null
    const method = String(init?.method || request?.method || 'GET').toUpperCase()
    const url = request?.url || String(input)
    const requestBody = bodyText(init?.body)
    const stepId = associatedStep(options, startedAtMs)
    try {
      const response = await originalFetch(input, init)
      const endedAtMs = Date.now()
      if (active) {
        const responseBody = await responseText(response)
        options.onRequest({
          requestId: id('request'),
          startedAt: new Date(startedAtMs).toISOString(),
          endedAt: new Date(endedAtMs).toISOString(),
          durationMs: endedAtMs - startedAtMs,
          method,
          url,
          status: response.status,
          ...(requestBody ? { requestBody } : {}),
          ...(responseBody ? { responseBody } : {}),
          ...(stepId ? { stepId } : {})
        })
      }
      return response
    } catch (error) {
      const endedAtMs = Date.now()
      if (active) {
        options.onRequest({
          requestId: id('request'),
          startedAt: new Date(startedAtMs).toISOString(),
          endedAt: new Date(endedAtMs).toISOString(),
          durationMs: endedAtMs - startedAtMs,
          method,
          url,
          ...(requestBody ? { requestBody } : {}),
          error: error instanceof Error ? error.message : String(error),
          ...(stepId ? { stepId } : {})
        })
      }
      throw error
    }
  }
  window.fetch = fetchWrapper

  const openWrapper = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async = true,
    username?: string | null,
    password?: string | null
  ): void {
    xhrMetadata.set(this, { method: method.toUpperCase(), url: String(url), startedAtMs: 0 })
    callOpen.call(this, method, url, async, username, password)
  }
  const sendWrapper: typeof XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null
  ): void {
    const metadata = xhrMetadata.get(this)
    if (metadata) {
      metadata.startedAtMs = Date.now()
      metadata.requestBody = bodyText(body)
      metadata.stepId = associatedStep(options, metadata.startedAtMs)
      this.addEventListener('loadend', () => {
        if (!active) return
        const endedAtMs = Date.now()
        const contentType = this.getResponseHeader('content-type') || ''
        let responseBody: string | undefined
        if (canReadResponse(contentType) && (!this.responseType || this.responseType === 'text')) {
          try {
            responseBody = String(this.responseText || '').slice(0, RECORDER_BODY_MAX_LENGTH)
          } catch {
            responseBody = undefined
          }
        }
        options.onRequest({
          requestId: id('request'),
          startedAt: new Date(metadata.startedAtMs).toISOString(),
          endedAt: new Date(endedAtMs).toISOString(),
          durationMs: endedAtMs - metadata.startedAtMs,
          method: metadata.method,
          url: metadata.url,
          status: this.status,
          ...(metadata.requestBody ? { requestBody: metadata.requestBody } : {}),
          ...(responseBody ? { responseBody } : {}),
          ...(metadata.stepId ? { stepId: metadata.stepId } : {})
        })
      }, { once: true })
    }
    originalSend.call(this, body)
  }
  XMLHttpRequest.prototype.open = openWrapper as typeof XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.send = sendWrapper

  const lease: RecorderLease = {
    dispose: () => {
      if (!active) return
      flushPendingInput()
      active = false
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('input', onInput, true)
      document.removeEventListener('change', onChange, true)
      document.removeEventListener('focusout', onFocusOut, true)
      window.removeEventListener('popstate', onNavigation)
      window.removeEventListener('hashchange', onNavigation)
      if (window.fetch === fetchWrapper) window.fetch = originalFetch
      if (XMLHttpRequest.prototype.open === openWrapper) XMLHttpRequest.prototype.open = originalOpen
      if (XMLHttpRequest.prototype.send === sendWrapper) XMLHttpRequest.prototype.send = originalSend
      if (history.pushState === pushStateWrapper) history.pushState = originalPushState
      if (history.replaceState === replaceStateWrapper) history.replaceState = originalReplaceState
      if (currentLease === lease) currentLease = null
    }
  }
  currentLease = lease
  return lease
}
