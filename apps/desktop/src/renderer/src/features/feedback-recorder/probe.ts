import {
  RECORDER_ROOT_ATTRIBUTE,
  type NetworkRecord,
  type RecordedStep,
  type StepKind,
} from './model.ts'
import { summarizeTarget } from './target.ts'
import {
  fileMetadata,
  isCredentialName,
  redactUrl,
  responseFileMetadata,
  summarizeBody,
  summarizeBodyText,
  summarizeText,
} from './utils.ts'

const REQUEST_STEP_WINDOW_MS = 10_000
const PAGE_LABEL_MAX_LENGTH = 80
const BODY_CAPTURE_PENDING = '[正文摘要生成中]'
const PASSWORD_INPUT_TYPE = 'password'
const SENSITIVE_AUTOCOMPLETE = new Set(['current-password', 'new-password', 'one-time-code'])
/** fetch 被自己的 signal 取消时 reject 的 DOMException 名字。超时器用的是 TimeoutError,
 * 那是客户端给接口设的期限到了, 仍然按失败记录。 */
const ABORT_ERROR_NAME = 'AbortError'
const EVENT_SOURCE_MEDIA_TYPE = 'text/event-stream'
const MULTIPART_MEDIA_TYPE = 'multipart/form-data'
const BINARY_MEDIA_PREFIXES = ['image/', 'audio/', 'video/']
const PAGE_LABEL_SELECTORS = [
  '[data-feedback-page-name]',
  '[role="tab"][aria-selected="true"]',
  '[aria-current="page"]',
  'main h1',
  'main h2',
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
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized ? normalized.slice(0, PAGE_LABEL_MAX_LENGTH) : undefined
}

function labelledByText(element: Element): string | undefined {
  const labelledBy = element.getAttribute('aria-labelledby')
  if (!labelledBy || typeof document.getElementById !== 'function') return undefined
  return normalizedLabel(
    labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || '')
      .join(' ')
  )
}

function dialogLabel(eventTarget: EventTarget | null): string | undefined {
  if (!(eventTarget instanceof Element)) return undefined
  const dialog = eventTarget.closest(DIALOG_SELECTOR)
  if (!dialog) return undefined
  return (
    normalizedLabel(dialog.getAttribute('aria-label')) ||
    labelledByText(dialog) ||
    normalizedLabel(dialog.querySelector('h1, h2, h3, [role="heading"]')?.textContent)
  )
}

function pageContext(eventTarget: EventTarget | null): RecordedStep['page'] {
  const path = redactUrl(
    `${window.location.pathname || ''}${window.location.search || ''}${window.location.hash || ''}`
  )
  const label =
    typeof document.querySelector === 'function'
      ? PAGE_LABEL_SELECTORS.map((selector) => document.querySelector(selector)?.textContent || '')
          .map(normalizedLabel)
          .find(Boolean)
      : undefined
  const currentDialogLabel = eventTarget ? dialogLabel(eventTarget) : undefined
  return {
    url: redactUrl(window.location.href),
    title: document.title,
    ...(path ? { path } : {}),
    ...(label ? { label } : {}),
    ...(currentDialogLabel ? { dialogLabel: currentDialogLabel } : {}),
  }
}

function isRecorderEvent(event: Event): boolean {
  return event
    .composedPath()
    .some((entry) => entry instanceof Element && entry.hasAttribute(RECORDER_ROOT_ATTRIBUTE))
}

function isCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === ABORT_ERROR_NAME
}

function inputValue(target: EventTarget | null): string | undefined {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    if (isCredentialInput(target)) return undefined
    return summarizeText(target.value)
  }
  if (target instanceof HTMLSelectElement) return target.value
  if (target instanceof HTMLElement && target.isContentEditable) {
    return summarizeText(String(target.textContent || ''))
  }
  return undefined
}

function isCredentialInput(target: HTMLInputElement | HTMLTextAreaElement): boolean {
  return (
    (target instanceof HTMLInputElement && target.type === PASSWORD_INPUT_TYPE) ||
    isCredentialName(target.getAttribute('name') || '') ||
    SENSITIVE_AUTOCOMPLETE.has(target.getAttribute('autocomplete') || '')
  )
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (
    (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
    isCredentialInput(target)
  )
    return false
  if (target instanceof HTMLInputElement) {
    return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(
      String(target.type || 'text').toLowerCase()
    )
  }
  if (target instanceof HTMLTextAreaElement) return true
  return target instanceof HTMLElement && target.isContentEditable
}

function bodyText(value: unknown): string | undefined {
  return summarizeBody(value)
}

function canReadResponse(contentType: string): boolean {
  const normalized = contentType.toLowerCase()
  return (
    !normalized.includes(EVENT_SOURCE_MEDIA_TYPE) &&
    !normalized.includes('application/octet-stream') &&
    !BINARY_MEDIA_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  )
}

async function responseText(response: Response, url: string): Promise<string | undefined> {
  const metadata = responseFileMetadata(response.headers, response.url || url)
  if (metadata) return metadata
  const contentType = response.headers.get('content-type') || ''
  if (!canReadResponse(contentType)) return undefined
  try {
    return summarizeBodyText(await response.clone().text())
  } catch {
    return undefined
  }
}

async function requestText(request: Request): Promise<string | undefined> {
  const metadata = responseFileMetadata(request.headers, '')
  if (metadata) return metadata
  const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (contentType === MULTIPART_MEDIA_TYPE) return fileMetadata(undefined, undefined)
  if (!contentType.includes('json') && !contentType.startsWith('text/')) return undefined
  try {
    return summarizeBodyText(await request.clone().text())
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
    target: { tag: 'window', role: 'navigation' },
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
    const target =
      kind === 'navigation' ? { tag: 'window', role: 'navigation' } : summarizeTarget(eventTarget)
    options.onStep({
      stepId: id('step'),
      occurredAt: new Date(now).toISOString(),
      elapsedMs: now - options.startedAtMs,
      kind,
      page: pageContext(eventTarget),
      target: {
        ...target,
        ...('href' in target && target.href ? { href: redactUrl(target.href) } : {}),
      },
      ...(value !== undefined ? { value } : {}),
      ...(pointer ? { pointer } : {}),
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
        y: Math.round(event.clientY),
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
    const requestBody =
      init?.body !== undefined
        ? bodyText(init.body)
        : request
          ? responseFileMetadata(request.headers, '') ||
            (request.body ? BODY_CAPTURE_PENDING : undefined)
          : undefined
    const requestSummary =
      request && init?.body === undefined ? requestText(request) : Promise.resolve(requestBody)
    const stepId = associatedStep(options, startedAtMs)
    try {
      const response = await originalFetch(input, init)
      const endedAtMs = Date.now()
      if (active) {
        const responseSummary = responseText(response, url)
        const record: NetworkRecord = {
          requestId: id('request'),
          startedAt: new Date(startedAtMs).toISOString(),
          endedAt: new Date(endedAtMs).toISOString(),
          durationMs: endedAtMs - startedAtMs,
          method,
          url: redactUrl(url),
          status: response.status,
          ...(requestBody ? { requestBody } : {}),
          responseBody:
            responseFileMetadata(response.headers, response.url || url) || BODY_CAPTURE_PENDING,
          ...(stepId ? { stepId } : {}),
        }
        options.onRequest(record)
        void Promise.all([requestSummary, responseSummary]).then(([requestBody, responseBody]) => {
          if (active) options.onRequest({ ...record, requestBody, responseBody })
        })
      }
      return response
    } catch (error) {
      const endedAtMs = Date.now()
      if (active) {
        const cancelled = isCancellation(error)
        options.onRequest({
          requestId: id('request'),
          startedAt: new Date(startedAtMs).toISOString(),
          endedAt: new Date(endedAtMs).toISOString(),
          durationMs: endedAtMs - startedAtMs,
          method,
          url: redactUrl(url),
          ...(requestBody ? { requestBody } : {}),
          ...(cancelled ? { cancelled: true } : {}),
          error: error instanceof Error ? error.message : String(error),
          ...(stepId ? { stepId } : {}),
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
      this.addEventListener(
        'loadend',
        () => {
          if (!active) return
          const endedAtMs = Date.now()
          const contentType = this.getResponseHeader('content-type') || ''
          const headers = new Headers()
          for (const name of [
            'content-type',
            'content-disposition',
            'content-length',
            'content-encoding',
          ]) {
            const value = this.getResponseHeader(name)
            if (value) headers.set(name, value)
          }
          const binary = this.responseType === 'blob' || this.responseType === 'arraybuffer'
          const payload = binary ? this.response : undefined
          const size =
            payload instanceof Blob
              ? payload.size
              : payload instanceof ArrayBuffer
                ? payload.byteLength
                : undefined
          let responseBody = responseFileMetadata(headers, this.responseURL || metadata.url, size)
          if (!responseBody && binary) {
            responseBody = fileMetadata(undefined, size)
          }
          if (
            !responseBody &&
            canReadResponse(contentType) &&
            (!this.responseType || this.responseType === 'text')
          ) {
            try {
              responseBody = summarizeBodyText(String(this.responseText || ''))
            } catch {
              responseBody = undefined
            }
          }
          if (!responseBody && this.responseType === 'json' && this.response !== null) {
            responseBody = summarizeBodyText(JSON.stringify(this.response))
          }
          options.onRequest({
            requestId: id('request'),
            startedAt: new Date(metadata.startedAtMs).toISOString(),
            endedAt: new Date(endedAtMs).toISOString(),
            durationMs: endedAtMs - metadata.startedAtMs,
            method: metadata.method,
            url: redactUrl(metadata.url),
            status: this.status,
            ...(metadata.requestBody ? { requestBody: metadata.requestBody } : {}),
            ...(responseBody ? { responseBody } : {}),
            ...(metadata.stepId ? { stepId: metadata.stepId } : {}),
          })
        },
        { once: true }
      )
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
      if (XMLHttpRequest.prototype.open === openWrapper)
        XMLHttpRequest.prototype.open = originalOpen
      if (XMLHttpRequest.prototype.send === sendWrapper)
        XMLHttpRequest.prototype.send = originalSend
      if (history.pushState === pushStateWrapper) history.pushState = originalPushState
      if (history.replaceState === replaceStateWrapper) history.replaceState = originalReplaceState
      if (currentLease === lease) currentLease = null
    },
  }
  currentLease = lease
  return lease
}
