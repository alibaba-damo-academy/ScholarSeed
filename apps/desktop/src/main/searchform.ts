import type { WebContents } from 'electron'

const SEARCH_FORM_WORLD = 1002
const SEARCH_FORM_TIMEOUT_MS = 15_000
const SEARCH_FORM_QUERY_LIMIT = 4096
const SEARCH_FORM_FIELD_LIMIT = 16
const SEARCH_FORM_ERROR = 'browser_search_form_invalid'
const SEARCH_FORM_STALE = 'browser_search_form_stale'
const SEARCH_FORM_UNKNOWN = 'browser_search_submission_unknown'
const SEARCH_FORM_BLOCKED = 'browser_search_submission_blocked'
const SEARCH_FORM_INSPECTION_ERRORS = new Set([
  'browser_search_form_invalid',
  'browser_search_form_page',
  'browser_search_form_input',
  'browser_search_form_submit',
  'browser_search_form_charset',
  'browser_search_form_action',
  'browser_search_form_fields',
])
const SEARCH_FORM_CONTROL_MODIFIER = process.platform === 'darwin' ? 4 : 2
const SEARCH_FORM_PHASE = {
  prepare: 'prepare',
  prepared: 'prepared',
  execute: 'execute',
  renderWait: 'render_wait',
  renderCycles: 'render_cycles',
  effectIssued: 'effect_issued',
  effectAck: 'effect_ack',
  inputVerified: 'input_verified',
  submitIssued: 'submit_issued',
  submitAck: 'submit_ack',
  request: 'request',
  intent: 'navigation_intent',
  start: 'navigation_start',
  commit: 'navigation_commit',
  redirect: 'navigation_redirect',
  domReady: 'dom_ready',
  failed: 'failed',
  completed: 'completed',
} as const
const SEARCH_FORM_REASON = {
  timeout: 'timeout',
  aborted: 'aborted',
  targetInvalidated: 'target_invalidated',
  targetChanged: 'target_changed',
  authorityInvalid: 'authority_invalid',
  navigationGeneration: 'navigation_generation',
  requestBeforeSubmit: 'request_before_submit',
  requestRejected: 'request_rejected',
  navigationBeforeSubmit: 'navigation_before_submit',
  navigationRejected: 'navigation_rejected',
  domReadyRejected: 'dom_ready_rejected',
  inspectionFailed: 'inspection_failed',
  verificationFailed: 'verification_failed',
  cdpFailed: 'cdp_failed',
  submissionFailed: 'submission_failed',
  submissionIncomplete: 'submission_incomplete',
  preparationFailed: 'preparation_failed',
  sameDocumentNavigation: 'same_document_navigation',
  loadFailed: 'load_failed',
  renderNotReady: 'render_not_ready',
} as const
const SEARCH_FORM_EFFECT = {
  focus: 'focus',
  selectAll: 'select_all',
  selectAllRelease: 'select_all_release',
  insertText: 'insert_text',
} as const

export type SearchFormFailureReason = (typeof SEARCH_FORM_REASON)[keyof typeof SEARCH_FORM_REASON]
export interface SearchFormDiagnostic {
  phase: (typeof SEARCH_FORM_PHASE)[keyof typeof SEARCH_FORM_PHASE]
  stage: 'prepare' | 'execute'
  elapsedMs: number
  submitIssued: boolean
  submissionAcknowledged: boolean
  reason?: SearchFormFailureReason
  effect?: (typeof SEARCH_FORM_EFFECT)[keyof typeof SEARCH_FORM_EFFECT]
  exact?: boolean
  allowed?: boolean
  mainFrame?: boolean
  get?: boolean
  committed?: boolean
  documentFocused?: boolean
  formValid?: boolean
  viewportPositive?: boolean
  nativeFocused?: boolean
  deniedSubresources?: number
}

export interface SearchFormConfig {
  landingUrl: string
  resultUrl: string
  inputSelector: string
  submitSelector: string
  submitter?: { name: string; value: string }
  queryParameter: string
  fields: Record<string, { pattern: string; maxLength: number }>
}

export interface PreparedSearchForm {
  readonly tabId: string
  readonly destinationUrl: string
  readonly source: { readonly instanceId: string; readonly generation: number }
}

interface SearchFormRequest {
  url: string
  method: string
  resourceType: string
}
type SearchFormNavigation = 'intent' | 'start' | 'commit' | 'redirect'

export function createSearchFormBoundary(
  destinationUrl: string,
  parameter: string,
  validate: () => boolean
) {
  if (new URL(destinationUrl).searchParams.getAll(parameter).length !== 1)
    throw new Error(SEARCH_FORM_ERROR)
  const navigation = new Set<SearchFormNavigation>()
  let locked = false
  let requested = false
  const valid = (): boolean => {
    try {
      if (!validate()) locked = true
    } catch {
      locked = true
    }
    return !locked
  }
  return {
    valid,
    invalidate() {
      locked = true
    },
    committed: () => requested && navigation.has('commit') && valid(),
    request(request: SearchFormRequest): boolean {
      if (request.resourceType !== 'mainFrame') return false
      if (!valid()) return false
      if (requested || request.method !== 'GET' || request.url !== destinationUrl) {
        locked = true
        return false
      }
      requested = true
      return true
    },
    navigation(url: string, phase: SearchFormNavigation): boolean {
      if (!valid() || phase === 'redirect' || url !== destinationUrl || navigation.has(phase)) {
        locked = true
        return false
      }
      navigation.add(phase)
      return true
    },
  }
}

const SEARCH_FORM_RENDER = String.raw`new Promise(resolve => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(
    innerWidth > 0 && innerHeight > 0 && visualViewport !== null
      && visualViewport.width > 0 && visualViewport.height > 0
  )))
})`

const SEARCH_FORM_INSPECT = String.raw`function(config, query) {
  const fail = (reason = 'invalid') => { throw new Error('browser_search_form_' + reason) }
  const visible = element => {
    if (!(element instanceof HTMLElement) || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor)
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false
    }
    return [...element.getClientRects()].some(rectangle => rectangle.width > 0 && rectangle.height > 0)
  }
  if (window !== top || location.href !== config.landingUrl) fail('page')
  const inputs = document.querySelectorAll(config.inputSelector)
  const submits = document.querySelectorAll(config.submitSelector)
  if (inputs.length !== 1 || submits.length !== 1) fail('input')
  const input = inputs[0]
  const submit = submits[0]
  if (!(input instanceof HTMLInputElement) || !['text', 'search'].includes(input.type)
    || !visible(input) || input.matches(':disabled') || input.readOnly || input.name !== config.queryParameter
    || input.maxLength >= 0 && input.maxLength < query.length || !visible(submit)) fail('input')
  const form = input.form
  const submitControl = submit instanceof HTMLLabelElement ? submit.control : submit
  if (!(form instanceof HTMLFormElement) || !submitControl
    || !(submitControl instanceof HTMLInputElement || submitControl instanceof HTMLButtonElement)
    || submitControl.type !== 'submit' || submitControl.form !== form || submitControl.matches(':disabled')) fail('submit')
  const action = new URL(form.action, location.href)
  const result = new URL(config.resultUrl)
  if (form.acceptCharset && form.acceptCharset.toLowerCase() !== 'utf-8'
    || !form.acceptCharset && document.characterSet.toLowerCase() !== 'utf-8') fail('charset')
  if (form.method.toLowerCase() !== 'get' || form.target && form.target !== '_self'
    || form.enctype !== 'application/x-www-form-urlencoded'
    || action.href !== result.href || action.origin !== location.origin || action.search || action.hash) fail('action')
  const fields = []
  let submitCount = 0
  if (form.elements.length > config.maximumFields) fail('fields')
  const names = new Set()
  const parameters = new URLSearchParams()
  for (const control of form.elements) {
    if (!(control instanceof HTMLInputElement || control instanceof HTMLButtonElement)) fail('fields')
    const kind = control.type.toLowerCase()
    if (kind === 'submit') {
      if (control !== submitControl || control.hasAttribute('formaction') || control.hasAttribute('formmethod')
        || control.hasAttribute('formenctype') || control.hasAttribute('formtarget')) fail('submit')
      if (config.submitter
        ? control.name !== config.submitter.name || control.value !== config.submitter.value
        : control.name) fail('submit')
      if (control.name) {
        if (names.has(control.name)) fail('fields')
        names.add(control.name)
      }
      submitCount += 1
      fields.push({ kind, name: control.name, value: control.value, disabled: control.matches(':disabled') })
      continue
    }
    if (control.matches(':disabled') || !control.name || names.has(control.name)) fail('fields')
    names.add(control.name)
    const value = control === input ? query : control.value
    if (control !== input) {
      const policy = Object.hasOwn(config.fields, control.name) ? config.fields[control.name] : null
      if (kind !== 'hidden' || !policy || value.length > policy.maxLength || !new RegExp(policy.pattern).test(value)) fail('fields')
    }
    fields.push({ kind, name: control.name, value })
    parameters.append(control.name, value)
  }
  if (!names.has(config.queryParameter) || submitCount !== 1) fail('submit')
  result.search = parameters.toString()
  return { destinationUrl: result.href, inputValue: input.value, inputFocused: document.activeElement === input,
    documentFocused: document.hasFocus(), formValid: form.matches(':valid'),
    fingerprint: JSON.stringify({ action: action.href, fields, inputId: input.id, submitId: submit.id }) }
}`

const SEARCH_FORM_SUBMIT = `function(config, query, fingerprint, destination) {
  const inspected = (${SEARCH_FORM_INSPECT})(config, query)
  if (inspected.fingerprint !== fingerprint || inspected.destinationUrl !== destination
    || inspected.inputValue !== query || !inspected.inputFocused || !inspected.formValid)
    throw new Error('browser_search_form_stale')
  HTMLFormElement.prototype.submit.call(document.querySelector(config.inputSelector).form)
}`

interface SearchFormTarget {
  contents: WebContents
  instanceId: string
  generation: number
  url: string
}
interface SearchFormPort {
  tabId: string
  target(): SearchFormTarget
  attach(): WebContents
  close(): void
  onFailure?(code: string): void
  onDiagnostic?(event: SearchFormDiagnostic): void
}
interface SearchFormInspection {
  destinationUrl: string
  fingerprint: string
  inputValue: string
  inputFocused: boolean
  documentFocused: boolean
  formValid: boolean
}
interface SearchFormState {
  prepared: PreparedSearchForm
  config: SearchFormConfig
  query: string
  signal: AbortSignal
  contents: WebContents
  inspection: SearchFormInspection
  inputNodeId: number
  submitNodeId: number
}

export function createSearchFormExecutor(port: SearchFormPort) {
  const states = new WeakMap<PreparedSearchForm, SearchFormState>()
  let boundary: ReturnType<typeof createSearchFormBoundary> | null = null
  let expectedGeneration = 0
  let expectedAdvance = false
  let executing = false
  let submitting = false
  let failed = false
  let stage: SearchFormDiagnostic['stage'] = 'prepare'
  let startedAt = performance.now()
  let submitIssued = false
  let submissionAcknowledged = false
  let deniedSubresources = 0
  let settled = false
  let destinationUrl = ''
  let firstFailure: Error | null = null
  let rejectExecution: ((error: Error) => void) | null = null
  const observe = (
    phase: SearchFormDiagnostic['phase'],
    details: Partial<
      Pick<
        SearchFormDiagnostic,
        | 'reason'
        | 'effect'
        | 'exact'
        | 'allowed'
        | 'mainFrame'
        | 'get'
        | 'committed'
        | 'documentFocused'
        | 'formValid'
        | 'viewportPositive'
        | 'nativeFocused'
      >
    > = {}
  ): void => {
    if (settled) return
    try {
      port.onDiagnostic?.({
        phase,
        stage,
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
        submitIssued,
        submissionAcknowledged,
        ...(phase === SEARCH_FORM_PHASE.failed || phase === SEARCH_FORM_PHASE.completed
          ? { deniedSubresources }
          : {}),
        ...details,
      })
    } catch {
      return
    }
  }
  const recordFailure = (reason: SearchFormFailureReason): Error => {
    if (!firstFailure) {
      firstFailure = new Error(reason)
      observe(SEARCH_FORM_PHASE.failed, { reason })
    }
    return firstFailure
  }
  const invalidate = (
    reason: SearchFormFailureReason = SEARCH_FORM_REASON.targetInvalidated
  ): void => {
    failed = true
    recordFailure(reason)
    boundary?.invalidate()
    rejectExecution?.(new Error(SEARCH_FORM_BLOCKED))
  }
  const inspect = async (
    contents: WebContents,
    config: SearchFormConfig,
    query: string
  ): Promise<SearchFormInspection> => {
    const result = (await contents.executeJavaScriptInIsolatedWorld(SEARCH_FORM_WORLD, [
      {
        code: `(() => { try { return (${SEARCH_FORM_INSPECT})(${JSON.stringify({ ...config, maximumFields: SEARCH_FORM_FIELD_LIMIT })}, ${JSON.stringify(query)}) }
        catch (error) { return { error: error?.message } } })()`,
      },
    ])) as SearchFormInspection | { error: string }
    if ('error' in result) {
      const code = SEARCH_FORM_INSPECTION_ERRORS.has(result.error)
        ? result.error
        : SEARCH_FORM_ERROR
      recordFailure(SEARCH_FORM_REASON.inspectionFailed)
      port.onFailure?.(code)
      throw new Error(SEARCH_FORM_ERROR, { cause: new Error(code) })
    }
    return result
  }
  const nodes = async (
    contents: WebContents,
    config: SearchFormConfig
  ): Promise<[number, number]> => {
    const document = (await contents.debugger.sendCommand('DOM.getDocument', { depth: 0 })) as {
      root: { nodeId: number }
    }
    const identifiers: number[] = []
    for (const selector of [config.inputSelector, config.submitSelector]) {
      const selected = (await contents.debugger.sendCommand('DOM.querySelector', {
        nodeId: document.root.nodeId,
        selector,
      })) as { nodeId: number }
      if (!selected.nodeId) throw new Error(SEARCH_FORM_STALE)
      const described = (await contents.debugger.sendCommand('DOM.describeNode', {
        nodeId: selected.nodeId,
      })) as { node: { backendNodeId: number } }
      identifiers.push(described.node.backendNodeId)
    }
    return [identifiers[0], identifiers[1]]
  }
  const current = (state: SearchFormState): boolean => {
    try {
      const target = port.target()
      const valid =
        !failed &&
        !state.signal.aborted &&
        target.contents === state.contents &&
        target.instanceId === state.prepared.source.instanceId &&
        target.generation === expectedGeneration &&
        !state.contents.isDestroyed() &&
        state.contents.debugger.isAttached()
      if (!valid)
        recordFailure(
          state.signal.aborted ? SEARCH_FORM_REASON.aborted : SEARCH_FORM_REASON.targetChanged
        )
      return valid
    } catch {
      recordFailure(SEARCH_FORM_REASON.targetChanged)
      return false
    }
  }
  return {
    active: () => boundary !== null,
    invalidate,
    advance(generation: number) {
      if (!expectedAdvance || generation !== expectedGeneration + 1) {
        invalidate(SEARCH_FORM_REASON.navigationGeneration)
        return
      }
      expectedAdvance = false
      expectedGeneration = generation
      if (!boundary?.valid()) invalidate()
    },
    request(request: SearchFormRequest): boolean {
      if (request.resourceType !== 'mainFrame') {
        deniedSubresources = Math.min(Number.MAX_SAFE_INTEGER, deniedSubresources + 1)
        return false
      }
      if (!submitting) {
        observe(SEARCH_FORM_PHASE.request, {
          mainFrame: true,
          get: request.method === 'GET',
          exact: request.url === destinationUrl,
          allowed: false,
        })
        invalidate(SEARCH_FORM_REASON.requestBeforeSubmit)
        return false
      }
      const accepted = boundary?.request(request) ?? false
      const valid = boundary?.valid() ?? false
      const allowed = accepted && valid
      observe(SEARCH_FORM_PHASE.request, {
        mainFrame: request.resourceType === 'mainFrame',
        get: request.method === 'GET',
        exact: request.url === destinationUrl,
        allowed,
      })
      if (boundary && !valid) invalidate(SEARCH_FORM_REASON.requestRejected)
      return allowed
    },
    navigation(url: string, phase: SearchFormNavigation): boolean {
      if (!submitting) {
        observe(SEARCH_FORM_PHASE[phase], { exact: url === destinationUrl, allowed: false })
        invalidate(SEARCH_FORM_REASON.navigationBeforeSubmit)
        return false
      }
      const allowed = boundary?.navigation(url, phase) ?? false
      observe(SEARCH_FORM_PHASE[phase], { exact: url === destinationUrl, allowed })
      if (!allowed) invalidate(SEARCH_FORM_REASON.navigationRejected)
      else if (phase === 'intent' || phase === 'commit') expectedAdvance = true
      return allowed
    },
    async prepare(
      config: SearchFormConfig,
      query: string,
      signal: AbortSignal
    ): Promise<PreparedSearchForm> {
      startedAt = performance.now()
      observe(SEARCH_FORM_PHASE.prepare)
      if (
        boundary ||
        executing ||
        failed ||
        signal.aborted ||
        !query ||
        query !== query.trim() ||
        query.length > SEARCH_FORM_QUERY_LIMIT
      )
        throw new Error(SEARCH_FORM_STALE)
      const frozenConfig = structuredClone(config)
      const target = port.target()
      if (target.url !== frozenConfig.landingUrl) throw new Error(SEARCH_FORM_ERROR)
      const contents = port.attach()
      let rejectPreparation: (error: Error) => void = () => {}
      const failure = new Promise<never>((_resolve, reject) => {
        rejectPreparation = reject
      })
      const stop = (reason: SearchFormFailureReason): void => {
        failed = true
        recordFailure(reason)
        rejectPreparation(new Error(SEARCH_FORM_STALE))
        port.close()
      }
      const aborted = (): void => stop(SEARCH_FORM_REASON.aborted)
      signal.addEventListener('abort', aborted, { once: true })
      const timer = setTimeout(() => stop(SEARCH_FORM_REASON.timeout), SEARCH_FORM_TIMEOUT_MS)
      const prepare = async (): Promise<PreparedSearchForm> => {
        const inspection = await inspect(contents, frozenConfig, query)
        const [inputNodeId, submitNodeId] = await nodes(contents, frozenConfig)
        const after = port.target()
        if (
          failed ||
          signal.aborted ||
          after.contents !== contents ||
          after.instanceId !== target.instanceId ||
          after.generation !== target.generation ||
          after.url !== frozenConfig.landingUrl
        )
          throw new Error(SEARCH_FORM_STALE)
        const prepared: PreparedSearchForm = Object.freeze({
          tabId: port.tabId,
          destinationUrl: inspection.destinationUrl,
          source: Object.freeze({ instanceId: target.instanceId, generation: target.generation }),
        })
        states.set(prepared, {
          prepared,
          config: frozenConfig,
          query,
          signal,
          contents,
          inspection,
          inputNodeId,
          submitNodeId,
        })
        observe(SEARCH_FORM_PHASE.prepared)
        return prepared
      }
      try {
        return await Promise.race([prepare(), failure])
      } catch (error) {
        recordFailure(SEARCH_FORM_REASON.preparationFailed)
        throw error
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', aborted)
      }
    },
    async execute(prepared: PreparedSearchForm, validate: () => boolean): Promise<void> {
      const state = states.get(prepared)
      if (!state || executing || boundary || failed) throw new Error(SEARCH_FORM_STALE)
      states.delete(prepared)
      executing = true
      deniedSubresources = 0
      stage = 'execute'
      startedAt = performance.now()
      destinationUrl = prepared.destinationUrl
      observe(SEARCH_FORM_PHASE.execute)
      expectedGeneration = prepared.source.generation
      boundary = createSearchFormBoundary(
        prepared.destinationUrl,
        state.config.queryParameter,
        () => {
          if (!current(state)) return false
          try {
            const valid = validate()
            if (!valid) recordFailure(SEARCH_FORM_REASON.authorityInvalid)
            return valid
          } catch (error) {
            recordFailure(SEARCH_FORM_REASON.authorityInvalid)
            throw error
          }
        }
      )
      let timer: ReturnType<typeof setTimeout> | undefined
      const failure = new Promise<never>((_resolve, reject) => {
        rejectExecution = reject
      })
      void failure.catch(() => {})
      const stop = (reason: SearchFormFailureReason): void => {
        invalidate(reason)
        port.close()
      }
      const aborted = (): void => stop(SEARCH_FORM_REASON.aborted)
      state.signal.addEventListener('abort', aborted, { once: true })
      timer = setTimeout(() => stop(SEARCH_FORM_REASON.timeout), SEARCH_FORM_TIMEOUT_MS)
      const verify = async (
        expectedValue: string,
        requireFocus = true
      ): Promise<SearchFormInspection> => {
        if (!boundary?.valid()) throw new Error(SEARCH_FORM_STALE)
        const [inputNodeId, submitNodeId] = await nodes(state.contents, state.config)
        const inspected = await inspect(state.contents, state.config, state.query)
        if (
          !boundary.valid() ||
          inspected.fingerprint !== state.inspection.fingerprint ||
          inspected.destinationUrl !== prepared.destinationUrl ||
          inspected.inputValue !== expectedValue ||
          (requireFocus && !inspected.inputFocused) ||
          inputNodeId !== state.inputNodeId ||
          submitNodeId !== state.submitNodeId
        ) {
          recordFailure(SEARCH_FORM_REASON.verificationFailed)
          throw new Error(SEARCH_FORM_STALE)
        }
        return inspected
      }
      const effect = async (
        name: NonNullable<SearchFormDiagnostic['effect']>,
        method: string,
        parameters: Record<string, unknown>,
        expectedValue: string
      ): Promise<void> => {
        await verify(expectedValue, method !== 'DOM.focus')
        if (!boundary?.valid()) throw new Error(SEARCH_FORM_STALE)
        observe(SEARCH_FORM_PHASE.effectIssued, { effect: name })
        try {
          await state.contents.debugger.sendCommand(method, parameters)
          observe(SEARCH_FORM_PHASE.effectAck, { effect: name })
        } catch (error) {
          recordFailure(SEARCH_FORM_REASON.cdpFailed)
          throw error
        }
      }
      let finishNavigation: (() => void) | null = null
      const navigation = new Promise<void>((resolve) => {
        finishNavigation = resolve
      })
      const committed = (): void => {
        const accepted = Boolean(
          boundary?.committed() &&
          current(state) &&
          state.contents.getURL() === prepared.destinationUrl
        )
        observe(SEARCH_FORM_PHASE.domReady, { allowed: accepted })
        if (accepted) finishNavigation?.()
        else invalidate(SEARCH_FORM_REASON.domReadyRejected)
      }
      state.contents.on('dom-ready', committed)
      try {
        const dispatch = async (): Promise<void> => {
          const initial = state.inspection.inputValue
          await verify(initial, false)
          observe(SEARCH_FORM_PHASE.renderWait)
          let viewportPositive: unknown
          try {
            viewportPositive = await state.contents.executeJavaScriptInIsolatedWorld(
              SEARCH_FORM_WORLD,
              [{ code: SEARCH_FORM_RENDER }]
            )
          } catch {
            recordFailure(SEARCH_FORM_REASON.renderNotReady)
            throw new Error(SEARCH_FORM_STALE)
          }
          await verify(initial, false)
          observe(SEARCH_FORM_PHASE.renderCycles, {
            viewportPositive: viewportPositive === true,
            nativeFocused: state.contents.isFocused(),
          })
          if (viewportPositive !== true) {
            recordFailure(SEARCH_FORM_REASON.renderNotReady)
            throw new Error(SEARCH_FORM_STALE)
          }
          await effect(
            SEARCH_FORM_EFFECT.focus,
            'DOM.focus',
            { backendNodeId: state.inputNodeId },
            initial
          )
          await effect(
            SEARCH_FORM_EFFECT.selectAll,
            'Input.dispatchKeyEvent',
            {
              type: 'keyDown',
              key: 'a',
              code: 'KeyA',
              windowsVirtualKeyCode: 65,
              modifiers: SEARCH_FORM_CONTROL_MODIFIER,
              commands: ['selectAll'],
            },
            initial
          )
          await effect(
            SEARCH_FORM_EFFECT.selectAllRelease,
            'Input.dispatchKeyEvent',
            {
              type: 'keyUp',
              key: 'a',
              code: 'KeyA',
              windowsVirtualKeyCode: 65,
              modifiers: SEARCH_FORM_CONTROL_MODIFIER,
            },
            initial
          )
          await effect(
            SEARCH_FORM_EFFECT.insertText,
            'Input.insertText',
            { text: state.query },
            initial
          )
          const verified = await verify(state.query)
          observe(SEARCH_FORM_PHASE.inputVerified, {
            documentFocused: verified.documentFocused,
            formValid: verified.formValid,
          })
          submitting = true
          submitIssued = true
          observe(SEARCH_FORM_PHASE.submitIssued)
          try {
            await state.contents.executeJavaScriptInIsolatedWorld(SEARCH_FORM_WORLD, [
              {
                code: `(${SEARCH_FORM_SUBMIT})(${JSON.stringify({ ...state.config, maximumFields: SEARCH_FORM_FIELD_LIMIT })}, ${JSON.stringify(state.query)}, ${JSON.stringify(verified.fingerprint)}, ${JSON.stringify(prepared.destinationUrl)})`,
              },
            ])
            submissionAcknowledged = true
            observe(SEARCH_FORM_PHASE.submitAck)
          } catch (error) {
            recordFailure(SEARCH_FORM_REASON.submissionFailed)
            throw error
          }
          await navigation
          if (!boundary?.committed() || !current(state)) throw new Error(SEARCH_FORM_UNKNOWN)
        }
        await Promise.race([dispatch(), failure])
        observe(SEARCH_FORM_PHASE.completed)
      } catch (error) {
        const cause = recordFailure(
          submitIssued
            ? SEARCH_FORM_REASON.submissionIncomplete
            : SEARCH_FORM_REASON.verificationFailed
        )
        invalidate()
        port.close()
        if (submitIssued) throw new Error(SEARCH_FORM_UNKNOWN, { cause })
        throw error
      } finally {
        clearTimeout(timer)
        rejectExecution = null
        settled = true
        state.signal.removeEventListener('abort', aborted)
        state.contents.removeListener('dom-ready', committed)
      }
    },
  }
}
