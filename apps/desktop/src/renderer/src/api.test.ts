import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance } from 'i18next'
import zh from '../../localization/locales/zh/conversation.json' with { type: 'json' }
import en from '../../localization/locales/en/conversation.json' with { type: 'json' }
import componentsZh from '../../localization/locales/zh/components.json' with { type: 'json' }
import componentsEn from '../../localization/locales/en/components.json' with { type: 'json' }
import { renderFeedback } from './contracts/feedback.ts'
import { describeTurnAdmissionFailure, turnAdmissionFeedback } from './input.ts'
import { formatApplicationRequestFailure, permissionModeFeedback, permissionModeSelectedFeedback, formatRuntimeStatus } from './runtime.ts'

import {
  serviceErrorDetail, openSession, confirmUnknownTurn, requestFailureFeedback, postTurn, postSide, sendQueuedMessage, setMode, setSessionModel,
  createSubscriptionProfile, parseOpenSessionResponse, classifySessionResumeFailure, interruptSession, respondHil,
  DiagnosticOperationError, getDiagnosticPolicy, getSkillDocument, getSkills,
  getGlobalPermissionMode, setGlobalPermissionMode, GLOBAL_PERMISSION_MODES,
  SkillCatalogError, SkillDocumentError, setSkillActive
} from './api.ts'
import { SKILL_CATALOG_CHANGED_EVENT } from '../../skills.ts'

test('only successful skill preference mutations invalidate open catalogs', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const requests: unknown[] = []
  const events: string[] = []
  let status = 200
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    scholarseed: { deviceSkills: async (request: unknown) => { requests.push(request); return { status, body: '{}' } } },
    dispatchEvent: (event: Event) => { events.push(event.type); return true }
  } })
  try {
    assert.equal(await setSkillActive('literature-review', false), true)
    status = 503
    assert.equal(await setSkillActive('literature-review', true), false)
    assert.deepEqual(requests, [
      { operation: 'toggle', name: 'literature-review', enabled: false },
      { operation: 'toggle', name: 'literature-review', enabled: true }
    ])
    assert.deepEqual(events, [SKILL_CATALOG_CHANGED_EVENT])
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('all permission choices can be restored and persisted as the new-session default', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  const requests: Array<{ method: string; body: string }> = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    scholarseed: { getApiBase: () => '' },
    setTimeout,
    clearTimeout
  } })
  try {
    globalThis.fetch = async (_input, init) => {
      requests.push({ method: init?.method ?? 'GET', body: String(init?.body ?? '') })
      const requested = init?.body ? JSON.parse(String(init.body)).mode : 'ask'
      return new Response(JSON.stringify({ ok: true, mode: requested, modes: GLOBAL_PERMISSION_MODES }))
    }
    assert.deepEqual(GLOBAL_PERMISSION_MODES, ['ask', 'safe_auto', 'bypassPermissions'])
    assert.equal((await getGlobalPermissionMode())?.mode, 'ask')
    assert.equal((await setGlobalPermissionMode('bypassPermissions'))?.mode, 'bypassPermissions')
    assert.deepEqual(requests, [
      { method: 'GET', body: '' },
      { method: 'POST', body: '{"mode":"bypassPermissions"}' }
    ])
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('locally generated skill failures carry stable classes and preserve HTTP status', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    scholarseed: { deviceSkills: async () => ({ status: 503, body: '{}' }) }
  } })
  try {
    await assert.rejects(getSkillDocument('user-named-skill'), error =>
      error instanceof SkillDocumentError && error.status === 503 && error.message === 'skill_document_unavailable')
    await assert.rejects(getSkills(), error =>
      error instanceof SkillCatalogError && error.status === 503 && error.message === 'skill_catalog_unavailable')
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('diagnostic fallback is distinguishable from original server diagnostics', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { scholarseed: { getApiBase: () => '' } } })
  try {
    globalThis.fetch = async () => new Response('{}', { status: 503 })
    await assert.rejects(getDiagnosticPolicy('session'), error =>
      error instanceof DiagnosticOperationError && error.status === 503)
    const original = '原始诊断: diagnostic_operation_failed'
    globalThis.fetch = async () => new Response(JSON.stringify({ detail: original }), { status: 503 })
    await assert.rejects(getDiagnosticPolicy('session'), error =>
      error instanceof Error && !(error instanceof DiagnosticOperationError) && error.message === original)
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('invalid recovery remains terminal with a stable diagnostic code', () => {
  const invalid = parseOpenSessionResponse({})
  assert.ok('error' in invalid)
  assert.equal(invalid.code, 'invalid_session_recovery_snapshot')
  assert.equal(invalid.error, 'invalid_session_recovery_snapshot')
  assert.equal(classifySessionResumeFailure(invalid).terminal, true)
})

test('empty HIL and interruption errors leave presentation to the caller while preserving original diagnostics', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { scholarseed: { getApiBase: () => '' } } })
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false }), { status: 200 })
    assert.equal((await interruptSession('session')).error, '')
    assert.equal((await respondHil('session', 'request', { option_id: 'yes' })).error, '')
    const original = 'Upstream 原始诊断'
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: { message: original } }), { status: 200 })
    assert.equal((await interruptSession('session')).error, original)
    assert.equal((await respondHil('session', 'request', { option_id: 'yes' })).error, original)
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('model profile requests preserve auth events and raw HTTP diagnostics without localized state', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  const events: string[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { scholarseed: { getApiBase: () => '' }, dispatchEvent: (event: Event) => { events.push(event.type); return true } } })
  try {
    globalThis.fetch = async () => new Response('{}', { status: 401 })
    assert.deepEqual(await createSubscriptionProfile(), { ok: false, error: '', code: 'authentication_required', status: 401 })
    assert.deepEqual(events, ['scholarseed:auth-required'])
    globalThis.fetch = async () => new Response(JSON.stringify({ detail: '原始拒绝原因' }), { status: 400 })
    assert.deepEqual(await createSubscriptionProfile(), { ok: false, error: '原始拒绝原因', code: 'http_failure', status: 400 })
    globalThis.fetch = async () => { throw new Error('network unavailable') }
    assert.deepEqual(await createSubscriptionProfile(), { ok: false, error: 'network unavailable', code: 'network_failure' })
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})


async function requestTranslations() {
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, interpolation: { escapeValue: false }, resources: {
    zh: { conversation: zh, components: componentsZh }, en: { conversation: en, components: componentsEn }
  } })
  return locale
}

test('service HTTP fallbacks carry producer provenance and retain same-named raw diagnostics', async () => {
  const locale = await requestTranslations()
  const fallback = await serviceErrorDetail(new Response('', { status: 503 }))
  assert.equal(fallback.message, '503 request failed')
  assert.deepEqual(fallback.applicationFailure, { key: 'request.httpFailure', status: 503, statusText: '' })
  assert.ok(fallback.applicationFailure)
  const stored = requestFailureFeedback(fallback.applicationFailure)
  assert.equal(renderFeedback(locale, stored), '请求失败（503）：请求失败')
  await locale.changeLanguage('en')
  assert.equal(renderFeedback(locale, stored), 'Request failed (503): Request failed')
  assert.equal(fallback.message, '503 request failed')
  for (const response of [
    new Response('503 request failed', { status: 503 }),
    Response.json({ detail: '503 request failed', code: 'unknown_upstream' }, { status: 503 }),
    Response.json({ detail: { detail: '原诊断', code: 'request_timeout' } }, { status: 503 })
  ]) {
    const original = await serviceErrorDetail(response)
    assert.equal(original.applicationFailure, undefined)
    assert.ok(original.message.includes('request'))
  }
  const status = await serviceErrorDetail(new Response('', { status: 503, statusText: 'RAW status reason' }))
  assert.equal(status.message, '503 RAW status reason')
  assert.ok(status.applicationFailure)
  assert.equal(renderFeedback(locale, requestFailureFeedback(status.applicationFailure)), 'Request failed (503): RAW status reason')
})

test('session open distinguishes local timeout and empty failures without reclassifying diagnostic strings', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  const events: string[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    scholarseed: { getApiBase: () => '' }, dispatchEvent: (event: Event) => { events.push(event.type); return true }
  } })
  try {
    const locale = await requestTranslations()
    await locale.changeLanguage('en')
    for (const cause of [new Error(''), new Error('request failed'), new DOMException('upstream timeout detail', 'TimeoutError')]) {
      globalThis.fetch = async () => { throw cause }
      const opened = await openSession({ resumeSessionId: 'session' })
      assert.ok(opened && 'error' in opened)
      const resume = classifySessionResumeFailure(opened)
      assert.equal(resume.status, 0)
      assert.equal(resume.terminal, false)
      assert.equal(opened.error, cause instanceof DOMException ? 'request_timeout' : 'request failed')
      if (cause instanceof DOMException) {
        assert.equal(resume.code, 'request_timeout')
        assert.deepEqual(resume.applicationFailure, { key: 'request.timeout', diagnostic: 'upstream timeout detail' })
        assert.equal(formatRuntimeStatus({ key: 'resume.stopped', reason: resume.applicationFailure }, locale.getFixedT(null, 'conversation')), `${en.resume.stopped}: Request timed out\nupstream timeout detail`)
      } else if (cause.message) assert.equal(resume.applicationFailure, undefined)
      else assert.deepEqual(resume.applicationFailure, { key: 'request.failed' })
    }
    globalThis.fetch = async () => new Response('', { status: 401 })
    const unauthorized = await openSession()
    assert.ok(unauthorized && 'error' in unauthorized)
    assert.equal(unauthorized.error, 'authentication required')
    assert.equal(classifySessionResumeFailure(unauthorized).terminal, true)
    assert.deepEqual(events, ['scholarseed:auth-required'])
    assert.deepEqual(unauthorized.applicationFailure, { key: 'request.authentication' })
    const empty = classifySessionResumeFailure({ status: 429, error: '', detail: '' })
    assert.equal(empty.message, 'request failed')
    assert.equal(empty.terminal, false)
    assert.deepEqual(empty.applicationFailure, { key: 'request.failed' })
    const upstream = classifySessionResumeFailure({ status: 503, code: 'request_timeout', error: 'request_timeout', detail: 'request_timeout' })
    assert.equal(upstream.applicationFailure, undefined)
    assert.equal(upstream.message, 'request_timeout')
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('unknown-turn confirmation preserves decision requests, raw errors, and generated fallback provenance', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  const calls: Array<{ url: string; method: string | undefined; body: unknown }> = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { scholarseed: { getApiBase: () => '' } } })
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body })
      return Response.json({ ok: false, code: 'confirmation_pending' })
    }
    const local = await confirmUnknownTurn('session/id', 'turn/id')
    assert.equal(local.error, 'turn unknown confirmation failed')
    assert.equal(local.code, 'confirmation_pending')
    assert.deepEqual(local.applicationFailure, { key: 'retry.continueUnconfirmed' })
    assert.deepEqual(calls, [{ url: '/api/serve/sessions/session%2Fid/turns/turn%2Fid/confirm-unknown', method: 'POST', body: '{"decision":"continue_without_replay"}' }])
    globalThis.fetch = async () => Response.json({ ok: false, error: 'turn unknown confirmation failed' })
    const raw = await confirmUnknownTurn('session', 'turn')
    assert.equal(raw.applicationFailure, undefined)
    assert.equal(raw.error, local.error)
    globalThis.fetch = async () => { throw new Error('原始确认错误') }
    assert.deepEqual(await confirmUnknownTurn('session', 'turn'), { ok: false, error: '原始确认错误' })
    globalThis.fetch = async () => Response.json({ ok: true, turn_id: 'turn', resolution: 'continue_without_replay' })
    assert.deepEqual(await confirmUnknownTurn('session', 'turn'), { ok: true, turn_id: 'turn', resolution: 'continue_without_replay' })
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('HTTP fallback provenance survives every service-error adapter without changing requests or failure events', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  const events: Array<CustomEvent> = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    scholarseed: { getApiBase: () => '' }, dispatchEvent: (event: CustomEvent) => { events.push(event); return true }
  } })
  try {
    globalThis.fetch = async () => new Response('', { status: 503 })
    const submitted = await postTurn('session', [{ type: 'text', text: '用户消息' }])
    assert.ok(submitted)
    const results = [
      submitted,
      await postSide('session', 'queued'), await sendQueuedMessage('session', 'queued'),
      await interruptSession('session'), await respondHil('session', 'hil', { option_id: 'deny' }),
      await setSessionModel('session', 'model'), await setMode('session', 'ask'),
      await confirmUnknownTurn('session', 'turn'), await openSession()
    ]
    for (const result of results) {
      assert.ok(result && 'applicationFailure' in result)
      assert.deepEqual(result.applicationFailure, { key: 'request.httpFailure', status: 503, statusText: '' })
      assert.equal('ok' in result ? result.ok : undefined, 'status' in result ? undefined : false)
    }
    assert.equal(events.length, 3)
    assert.ok(events.every(event => event.detail.message === '503 request failed' && event.detail.code === undefined))
    const locale = await requestTranslations()
    await locale.changeLanguage('en')
    assert.equal(renderFeedback(locale, turnAdmissionFeedback(submitted)), 'Request failed (503): Request failed')
    assert.equal(describeTurnAdmissionFailure(locale.getFixedT(null, 'components'), submitted), 'Request failed (503): Request failed')
    const mode = await setMode('session', 'ask')
    assert.equal(mode.error, undefined)
    assert.equal(mode.detail, '503 request failed')
    assert.equal(renderFeedback(locale, permissionModeFeedback(mode)), 'Request failed (503): Request failed')
    const diagnostic = requestFailureFeedback({ key: 'request.timeout', diagnostic: '<raw>&{{message}}' })
    assert.equal(renderFeedback(locale, diagnostic), 'Request timed out\n<raw>&{{message}}')
    assert.equal(formatApplicationRequestFailure({ key: 'request.timeout', diagnostic: '<raw>&{{message}}' }, locale.getFixedT(null, 'conversation')), renderFeedback(locale, diagnostic))
    const selected = permissionModeSelectedFeedback('safe_auto')
    assert.equal(renderFeedback(locale, selected), 'Selected “Approve for me”. Applies to the next turn.')
    await locale.changeLanguage('zh')
    assert.equal(renderFeedback(locale, selected), componentsZh.composer.modeSelected.replace('{{mode}}', componentsZh.composer.autoPermission))
    assert.equal(renderFeedback(locale, permissionModeSelectedFeedback('vendor_raw_mode')), componentsZh.composer.modeSelected.replace('{{mode}}', 'vendor_raw_mode'))
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('turn submission marks HTTP admission failures as rejected and transport failures as unknown', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  const events: Array<CustomEvent> = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    scholarseed: { getApiBase: () => '' },
    dispatchEvent: (event: CustomEvent) => { events.push(event); return true }
  } })
  try {
    globalThis.fetch = async () => Response.json({
      detail: 'resource review required',
      code: 'resource_review_required'
    }, { status: 409 })
    assert.deepEqual(await postTurn('session', [{ type: 'text', text: '重试' }]), {
      ok: false,
      error: 'resource_review_required',
      code: 'resource_review_required',
      submissionOutcome: 'rejected',
      issues: undefined
    })
    assert.equal(events.at(-1)?.detail.code, 'resource_review_required')
    const locale = await requestTranslations()
    assert.equal(
      renderFeedback(locale, turnAdmissionFeedback(events.at(-1)?.detail)),
      zh.request.resourceReviewRequired
    )
    await locale.changeLanguage('en')
    assert.equal(
      renderFeedback(locale, turnAdmissionFeedback(events.at(-1)?.detail)),
      en.request.resourceReviewRequired
    )

    globalThis.fetch = async () => { throw new Error('connection lost') }
    assert.deepEqual(await postTurn('session', [{ type: 'text', text: '重试' }]), {
      ok: false,
      error: 'connection lost',
      submissionOutcome: 'unknown'
    })
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})


test('history-load recovery explanations redraw without translating raw server diagnostics', async () => {
  const locale = await requestTranslations()
  const stored = requestFailureFeedback({ key: 'request.historyUnavailable' })
  assert.equal(renderFeedback(locale, stored), '历史记录未能加载')
  await locale.changeLanguage('en')
  assert.equal(renderFeedback(locale, stored), 'The conversation history could not be loaded.')
  assert.equal(renderFeedback(locale, '历史记录未能加载'), '历史记录未能加载')
})
