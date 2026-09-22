import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createInstance } from 'i18next'
import zh from '../../localization/locales/zh/conversation.json' with { type: 'json' }
import en from '../../localization/locales/en/conversation.json' with { type: 'json' }
import componentsZh from '../../localization/locales/zh/components.json' with { type: 'json' }
import componentsEn from '../../localization/locales/en/components.json' with { type: 'json' }
import { DirectiveStreamHarness } from './directive.ts'
import { describeTurnFailure, formatTurnFailure, sameTurnFailureMessage } from './failures.ts'
import { projectStreamDelta } from './transcript.ts'

import {
  classifyHilResponseFailure,
  classifySessionResumeFailure,
  isProductEventEnvelope,
  parseSessionCatalog,
  parseSessionCatalogResult,
  parseOpenSessionResponse,
  serviceErrorDetail,
  type RuntimeIncidentData,
  type UncertainOperationSnapshot
} from './api.ts'
import {
  applyRuntimeIncident,
  blocksRuntimePreflight,
  classifyReadiness,
  effectiveReadiness,
  formatRuntimeStatus,
  formatTurnUnknown,
  permissionModeFailure,
  projectRuntimeIncidentReadiness,
  projectSessionRecovery,
  projectSessionState,
  readinessAdmission,
  reportOperationState,
  reportRuntimeIncident,
  reportTransportState,
  reportTurnUnknown,
  reportTurnReconciled,
  sessionResumeStatusItem,
  shouldRetrySessionResume
} from './runtime.ts'
import type { RuntimeStatusMessage, Thread } from './model.ts'

test('message snapshots remain cumulative exactly once through directive and transcript projection', () => {
  const stream = new DirectiveStreamHarness()
  let rows = projectStreamDelta([], 'thinking', stream.append('item', '我', true), 'turn', 'item', true)
  rows = projectStreamDelta(rows, 'thinking', stream.append('item', '我会计算。', true), 'turn', 'item', true)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind === 'thinking' ? rows[0].text : null, '我会计算。')
  assert.equal(stream.append('item', '我会计算。\n::scholarseed-preview{file="a.py"}', true), '我会计算。')
})

test('authoritative completed snapshots shorten and clear the same message without duplication', () => {
  const stream = new DirectiveStreamHarness()
  const project = (rows: Parameters<typeof projectStreamDelta>[0], text: string) =>
    projectStreamDelta(rows, 'agent', stream.append('item', text, true), 'turn', 'item', true, 7)
  let rows = project([], '报告已经生成，以下是临时说明。')
  rows = project(rows, '报告已生成。')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind === 'agent' ? rows[0].text : null, '报告已生成。')
  const completed = rows
  assert.deepEqual(project(rows, '报告已生成。'), completed)
  rows = project(rows, '')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind === 'agent' ? rows[0].text : null, '')
  assert.equal(rows[0].eventSeq, 7)
  assert.deepEqual(project([], ''), [])
})

test('desktop accepts only complete ProductEvent v2 envelopes', () => {
  const current = {
    v: 2,
    seq: 1,
    ts: 1,
    type: 'message_delta',
    session_id: 'session-1',
    data: { delta: 'ok' }
  }
  assert.equal(isProductEventEnvelope(current), true)
  assert.equal(isProductEventEnvelope({ ...current, v: 1 }), false)
  assert.equal(isProductEventEnvelope({ ...current, seq: 0 }), false)
  assert.equal(isProductEventEnvelope({ ...current, data: null }), false)
})

test('permission failures distinguish connection from runtime failures', () => {
  assert.match(permissionModeFailure({ ok: false, error: 'session_permission_switch_requires_hil_resolution' }), /处理当前审批/)
  assert.match(permissionModeFailure({ ok: false, error: 'permission_mode_connection_failed' }), /无法连接/)
  assert.equal(permissionModeFailure({ ok: false, error: 'session_permission_switch_failed', detail: 'Codex 拒绝恢复会话。' }), 'Codex 拒绝恢复会话。')
  assert.doesNotMatch(permissionModeFailure({ ok: false, error: 'session_permission_policy_immutable' }), /运行中/)
  assert.doesNotMatch(permissionModeFailure({ ok: false }), /运行中/)
})

test('turn failures map stable provider codes to actionable product guidance', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, resources: { zh: { conversation: zh }, en: { conversation: en } } })
  const display = (item: ReturnType<typeof describeTurnFailure>) => formatTurnFailure(item, locale.getFixedT(null, 'conversation'))
  const policy = describeTurnFailure({ code: 'CONTENT_SAFETY_BLOCKED', retryable: true })
  assert.equal(display(policy).message, '本次内容未通过安全审核，请修改后重试。')
  assert.equal(display(policy).action, display(policy).message)
  assert.equal(policy.runtimeAction, undefined)
  assert.equal(describeTurnFailure({ code: 'CONTENT_SAFETY_UNAVAILABLE' }).failure?.kind, 'unknown')
  const quota = describeTurnFailure({
    code: 'insufficient_quota',
    message: 'You exceeded your current quota.',
    retryable: true
  })
  assert.equal(display(quota).title, '回答生成失败')
  assert.match(display(quota).action, /剩余积分/)
  assert.equal(quota.runtimeAction, undefined)

  const allocationQuota = describeTurnFailure({
    message: 'id:1\nevent:error\n:HTTP_STATUS/429\ndata:{"request_id":"private","code":"Throttling.AllocationQuota","message":"Allocated quota exceeded. https://private.example"}',
    retryable: true
  })
  assert.equal(display(allocationQuota).message, '模型分配额度已用完。')
  assert.doesNotMatch(JSON.stringify(allocationQuota), /private|HTTP_STATUS|event:error/)
  assert.equal(allocationQuota.runtimeAction, undefined)

  const rateLimit = describeTurnFailure({
    code: 'rate_limit_exceeded',
    message: 'Please retry later.',
    retryable: true
  })
  assert.match(display(rateLimit).message, /请求过于频繁/)
  assert.equal(rateLimit.runtimeAction, 'continue_turn')

  const auth = describeTurnFailure({
    code: 'runtime_not_authenticated',
    message: 'unauthorized',
    retryable: false
  })
  assert.match(display(auth).action, /登录/)
  assert.equal(auth.runtimeAction, undefined)

  const codeWins = describeTurnFailure({
    code: 'runtime_not_authenticated',
    message: 'You exceeded your current quota.',
    retryable: true
  })
  assert.match(display(codeWins).message, /认证失败/)
  assert.equal(codeWins.runtimeAction, undefined)

  const untyped = describeTurnFailure({ message: 'backend unavailable' })
  assert.equal(untyped.runtimeAction, undefined)
  await locale.changeLanguage('en')
  assert.equal(display(quota).title, 'Answer generation failed')
  assert.equal(display(quota).message, 'The allocated model quota has been exhausted.')
  assert.equal(sameTurnFailureMessage(quota, allocationQuota), true)
  assert.equal(sameTurnFailureMessage(quota, rateLimit), false)
  assert.equal(sameTurnFailureMessage({ kind: 'error', title: '旧标题', action: '旧建议', message: '模型分配额度已用完。' }, quota), true)
  const raw = describeTurnFailure({ message: 'opaque diagnostic /user/file' })
  assert.equal(display(raw).message, 'opaque diagnostic /user/file')
  const legacy = { kind: 'error' as const, title: '旧标题', message: '旧诊断', action: '旧建议' }
  assert.deepEqual(formatTurnFailure(legacy, locale.getFixedT(null, 'conversation')), legacy)
})

test('credit balance exhaustion maps to a dedicated credits card without retry', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, resources: { zh: { conversation: zh }, en: { conversation: en } } })
  const display = (item: ReturnType<typeof describeTurnFailure>) => formatTurnFailure(item, locale.getFixedT(null, 'conversation'))
  const credits = describeTurnFailure({
    code: 'credit_balance_exhausted',
    message: 'The account credit balance is exhausted.',
    retryable: true
  })
  assert.equal(credits.failure?.kind, 'credits')
  assert.equal(display(credits).title, '回答生成失败')
  assert.equal(display(credits).message, '积分余额已用尽，本次生成已停止。')
  assert.match(display(credits).action, /获取更多积分/)
  // 余额只能靠补充恢复：即使上游标了 retryable，积分卡也不给重试动作。
  assert.equal(credits.runtimeAction, undefined)
  await locale.changeLanguage('en')
  assert.equal(display(credits).message, 'Your credit balance is exhausted, so generation has stopped.')
})

test('classified turn failures keep a distinct reason for the card to surface', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, resources: { zh: { conversation: zh }, en: { conversation: en } } })
  const display = (item: ReturnType<typeof describeTurnFailure>) => formatTurnFailure(item, locale.getFixedT(null, 'conversation'))

  // 适配器 _AUTH_CODES 里有这个码，渲染层曾漏登记，于是塌缩成 unknown 并只剩英文脱敏原文。
  const bridge = describeTurnFailure({
    code: 'model_bridge_credential_required',
    message: 'The model provider authentication failed.',
    retryable: false
  })
  assert.equal(bridge.failure?.kind, 'auth')
  assert.equal(display(bridge).message, '模型服务认证失败。')
  assert.equal(display(bridge).action, '请检查登录或模型凭证。')

  // 限流是原因句最要紧的一条：action 只说「已保留」，看不出是限流。
  const rateLimit = describeTurnFailure({
    code: 'rate_limit_exceeded',
    message: 'The model provider rate limit was reached.',
    retryable: true
  })
  assert.equal(display(rateLimit).message, '模型请求过于频繁，请稍后再试。')
  assert.notEqual(display(rateLimit).action, display(rateLimit).message)

  // 未登记码仍落 unknown，但脱敏原文必须留在 message 里，不能只剩通用文案。
  const unregistered = describeTurnFailure({
    code: 'codex_provider_failed',
    message: 'The model provider rejected the request.',
    retryable: true
  })
  assert.equal(unregistered.failure?.kind, 'unknown')
  assert.equal(display(unregistered).message, 'The model provider rejected the request.')
  assert.equal(display(unregistered).action, '生成过程中发生异常，已保留本轮问题和上下文。')

  await locale.changeLanguage('en')
  assert.equal(display(bridge).message, 'Model service authentication failed.')
  assert.equal(display(rateLimit).message, 'Too many model requests. Try again later.')
})

test('the turn failure card renders the reason ahead of the next step', () => {
  const stream = readFileSync(new URL('./components/business/Stream.tsx', import.meta.url), 'utf8')
  const anchor = stream.indexOf('data-testid="turn-failure-card"')
  assert.notEqual(anchor, -1)
  const card = stream.slice(anchor)
  const body = card.slice(0, card.indexOf('{item.runtimeAction ==='))
  assert.match(body, /data-testid="turn-failure-reason"[\s\S]*?\{failureText\.message\}/)
  assert.match(body, /data-testid="turn-failure-action"[\s\S]*?\{failureText\.action\}/)
  // 原因与下一步同源时 (content_policy 的 messageKey==actionKey) 只渲染一次。
  assert.match(body, /failureText\.action && failureText\.action !== failureText\.message/)
  assert.ok(body.indexOf('turn-failure-reason') < body.indexOf('turn-failure-action'))
})

test('unsupported model rejection maps to a model_config card without retry', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, resources: { zh: { conversation: zh }, en: { conversation: en } } })
  const display = (item: ReturnType<typeof describeTurnFailure>) => formatTurnFailure(item, locale.getFixedT(null, 'conversation'))
  // 工单 87102385：上游 InvalidParameter（"Unsupported model"）经 bridge 恢复后到达产品面。
  const modelConfig = describeTurnFailure({
    code: 'InvalidParameter',
    message: "Unsupported model: 'minimax-m2.1'",
    retryable: true
  })
  assert.equal(modelConfig.failure?.kind, 'model_config')
  assert.equal(display(modelConfig).title, '回答生成失败')
  assert.equal(display(modelConfig).message, '该模型不被当前端点支持。')
  assert.match(display(modelConfig).action, /检查模型名/)
  // 确定性配置错误：用户改个模型名即可自修，即使上游标了 retryable 也不给重试按钮。
  assert.equal(modelConfig.runtimeAction, undefined)
  // model_not_found 归到同一可操作分类（不再落泛 request）。
  assert.equal(describeTurnFailure({ code: 'model_not_found' }).failure?.kind, 'model_config')
  await locale.changeLanguage('en')
  assert.equal(display(modelConfig).message, 'This model is not supported by the current endpoint.')
})

test('session catalog distinguishes a failed payload from an authoritative empty list', () => {
  assert.equal(parseSessionCatalog(null), null)
  assert.equal(parseSessionCatalog({}), null)
  assert.deepEqual(parseSessionCatalog({ sessions: [] }), [])
  assert.deepEqual(parseSessionCatalogResult({ sessions: [], total: 5 }), {
    sessions: [],
    total: 5
  })
  assert.deepEqual(parseSessionCatalogResult({ sessions: [] }), {
    sessions: [],
    total: 0
  })
})

function thread(): Thread {
  return {
    id: 'thread-1',
    title: '长会话',
    conversation: [],
    sessionId: 'session-1',
    lastSeq: 0
  }
}

function incident(state: RuntimeIncidentData['state']): RuntimeIncidentData {
  return {
    incident_id: 'incident-1',
    scope: 'process',
    state,
    kind: 'process_exit',
    strategy: 'auto_restart',
    retryability: state === 'failed' ? 'user_retryable' : 'in_progress',
    safe_error: 'codex_process_exit',
    process_generation: 2,
    attempt: state === 'recovered' ? 2 : 1,
    max_attempts: 5
  }
}

function uncertain(
  kind: UncertainOperationSnapshot['kind'],
  state: UncertainOperationSnapshot['state'],
  correlationId: string,
  safeError?: string
): UncertainOperationSnapshot {
  return {
    kind,
    uncertainty_kind: kind,
    correlation_id: correlationId,
    incident_id: `incident-${correlationId}`,
    process_generation: 2,
    state,
    operation_state: state,
    retryable: false,
    execution_count: 1,
    ...(safeError ? { safe_error: safeError } : {}),
    ...(kind === 'turn'
      ? {}
      : {
          turn_id: 'turn-hil',
          item_id: `item-${correlationId}`,
          hil: {
            request_id: correlationId,
            kind: 'permission',
            title: '需要确认',
            body: '安全展示内容'
          }
        })
  }
}

test('one runtime incident updates one transcript item through recovery', () => {
  const initial = thread()
  const retrying = { ...initial, ...reportRuntimeIncident(initial, incident('retrying'), 'turn-1') }
  const recovered = {
    ...retrying,
    ...reportRuntimeIncident(retrying, incident('recovered'), 'turn-1')
  }

  assert.equal(recovered.conversation.length, 1)
  assert.equal(recovered.conversation[0]?.kind, 'status')
  assert.deepEqual(
    recovered.conversation[0]?.kind === 'status' ? recovered.conversation[0].text : '',
    { key: 'runtime.recovered', reason: incident('recovered').safe_error }
  )
})

test('process incident drives one readiness truth without blocking inspectable recovery', () => {
  const detected = projectRuntimeIncidentReadiness(
    { ready: true, version: 'codex-cli 0.147.0', process_state: 'ready' },
    { ...incident('detected'), scope: 'process' }
  )
  assert.equal(detected?.ready, false)
  assert.equal(detected?.process_state, 'recovering')
  assert.equal(detected?.version, 'codex-cli 0.147.0')
  assert.equal(blocksRuntimePreflight(detected), false)

  const recovered = projectRuntimeIncidentReadiness(
    detected,
    { ...incident('recovered'), scope: 'process', process_generation: 2 }
  )
  assert.equal(recovered?.ready, true)
  assert.equal(recovered?.process_state, 'ready')
  assert.equal(recovered?.process_generation, 2)
  assert.equal(recovered?.code, undefined)
  assert.equal(blocksRuntimePreflight(recovered), false)

  const failed = projectRuntimeIncidentReadiness(
    detected,
    { ...incident('failed'), scope: 'process' }
  )
  assert.equal(failed?.process_state, 'unavailable')
  assert.equal(blocksRuntimePreflight(failed), true)
})

test('readiness admission separates an unloaded probe from a two-second restart', () => {
  // 一个 ready 布尔无法区分「还没探测」「正在重启」「真的不可用」, 三者的准入结论不同。
  assert.equal(classifyReadiness(null), 'unknown')
  assert.equal(classifyReadiness(undefined), 'unknown')
  assert.equal(classifyReadiness({ ready: true }), 'ready')
  assert.equal(classifyReadiness({ ready: false, process_state: 'starting' }), 'transient')
  assert.equal(classifyReadiness({ ready: false, process_state: 'recovering' }), 'transient')
  assert.equal(classifyReadiness({ ready: false, process_state: 'unavailable' }), 'blocked')
  assert.equal(classifyReadiness({ ready: false, process_state: 'crashed' }), 'blocked')
  assert.equal(classifyReadiness({ ready: false }), 'blocked')
  // 预检阻断卡只认终态: 未知与瞬态都不该把工作区判死。
  assert.equal(blocksRuntimePreflight(null), false)
  assert.equal(blocksRuntimePreflight({ ready: false, process_state: 'starting' }), false)
  assert.equal(blocksRuntimePreflight({ ready: false, process_state: 'unavailable' }), true)
})

test('session readiness outranks the runtime-wide probe for that session', () => {
  const restarting: Thread = {
    ...thread(),
    readiness: { ready: false, process_state: 'recovering' }
  }
  assert.deepEqual(effectiveReadiness(restarting, { ready: true }), restarting.readiness)
  assert.equal(readinessAdmission(restarting, { ready: true }), 'transient')
  assert.deepEqual(effectiveReadiness(thread(), { ready: true }), { ready: true })
  assert.equal(readinessAdmission(thread(), { ready: true }), 'ready')
  assert.equal(readinessAdmission(null, { ready: false, process_state: 'unavailable' }), 'blocked')
  assert.equal(effectiveReadiness(thread(), null), null)
  assert.equal(readinessAdmission(thread(), null), 'unknown')
})

test('a process incident reaches only the session that owns it', () => {
  const state = {
    threads: {
      a: { ...thread(), id: 'a', readiness: { ready: true, process_state: 'ready' } },
      b: { ...thread(), id: 'b', readiness: { ready: true, process_state: 'ready' } }
    }
  }
  const next = applyRuntimeIncident(state, 'a', {
    data: { ...incident('detected'), scope: 'process' },
    turn_id: 'turn-1'
  })

  assert.equal(next.threads.a.readiness?.ready, false)
  assert.equal(next.threads.a.readiness?.process_state, 'recovering')
  assert.equal(next.threads.a.conversation.length, 1)
  // 会话 B 既不换对象也不换 readiness: 别人的进程事件不该动它。
  assert.equal(next.threads.b, state.threads.b)
  assert.deepEqual(next.threads.b.readiness, { ready: true, process_state: 'ready' })
  // 形状上就不可能写回全局 readiness —— 这是修复的结构性保证, 不是纪律要求。
  assert.deepEqual(Object.keys(next), ['threads'])
})

test('a runtime incident outside process scope leaves session readiness untouched', () => {
  const state = {
    threads: { a: { ...thread(), id: 'a', readiness: { ready: true, process_state: 'ready' } } }
  }
  const next = applyRuntimeIncident(state, 'a', {
    data: { ...incident('detected'), scope: 'turn' },
    turn_id: 'turn-1'
  })

  assert.deepEqual(next.threads.a.readiness, { ready: true, process_state: 'ready' })
  assert.equal(next.threads.a.conversation.length, 1)
  assert.equal(applyRuntimeIncident(state, null, {
    data: { ...incident('detected'), scope: 'process' }
  }), state)
  assert.equal(applyRuntimeIncident(state, 'missing', {
    data: { ...incident('detected'), scope: 'process' }
  }), state)
})

test('SSE transport recovery is separate from Codex runtime incidents', () => {
  const initial = thread()
  const retrying = { ...initial, ...reportTransportState(initial, 'retrying') }
  const recovered = { ...retrying, ...reportTransportState(retrying, 'live') }

  assert.equal(recovered.transportState, 'live')
  assert.equal(recovered.conversation.length, 1)
  assert.deepEqual(
    recovered.conversation[0]?.kind === 'status' ? recovered.conversation[0].text : '',
    { key: 'runtime.transportRecovered' }
  )
})

test('process recovery alone keeps an unresolved ambiguous submission actionable', () => {
  const initial: Thread = {
    ...thread(),
    conversation: [
      {
        kind: 'error',
        title: '上次任务已中断',
        message: '未确认',
        action: '先检查',
        incidentId: 'incident-1'
      }
    ]
  }
  const processRecovered = {
    ...initial,
    ...reportRuntimeIncident(
      initial,
      { ...incident('recovered'), incident_id: 'process-incident' },
      'turn-1'
    )
  }

  assert.equal(processRecovered.conversation.some((item) => item.kind === 'error'), true)

  const reconciled = {
    ...processRecovered,
    ...reportRuntimeIncident(processRecovered, incident('recovered'), 'turn-1')
  }

  assert.equal(reconciled.conversation.some((item) => item.kind === 'error'), false)
  assert.equal(reconciled.conversation.some(
    (item) => item.kind === 'status' && item.incidentId === 'incident-1'
  ), true)
})

test('session resume classification uses HTTP and typed Service fields, never message regexes', () => {
  assert.equal(classifySessionResumeFailure({
    status: 404,
    error: '任意本地化提示',
    detail: '任意本地化提示',
    code: 'session_not_found'
  }).terminal, true)
  assert.equal(classifySessionResumeFailure({
    status: 503,
    error: 'harness_runtime_not_ready',
    detail: 'harness_runtime_not_ready',
    code: 'harness_runtime_not_ready',
    runtimeReadiness: { ready: false, code: 'unauthenticated', action: 'login' }
  }).terminal, true)
  assert.equal(classifySessionResumeFailure({
    status: 503,
    error: 'harness_runtime_not_ready',
    detail: 'harness_runtime_not_ready',
    code: 'harness_runtime_not_ready',
    runtimeReadiness: { ready: false, code: 'error', action: 'retry' }
  }).terminal, false)
  assert.equal(classifySessionResumeFailure({
    status: 500,
    error: 'harness_session_resume_failed',
    detail: '当前模型已下线',
    code: 'session_model_unavailable'
  }).terminal, true)
  assert.equal(classifySessionResumeFailure({
    status: 500,
    error: '会话不存在 forbidden invalid',
    detail: '会话不存在 forbidden invalid'
  }).terminal, false)
})

test('service errors preserve the specific failure code over the operation envelope', async () => {
  const failure = await serviceErrorDetail(new Response(JSON.stringify({
    error: 'harness_session_resume_failed',
    code: 'session_model_unavailable',
    detail: '当前模型已下线'
  }), {
    status: 500,
    headers: { 'content-type': 'application/json' }
  }))

  assert.equal(failure.code, 'session_model_unavailable')
  assert.equal(failure.message, '当前模型已下线')
})

test('session resume stops at five attempts and exposes a real reconnect action', () => {
  const retryable = classifySessionResumeFailure({
    status: 500,
    error: 'harness_session_resume_failed',
    detail: 'harness_session_resume_failed',
    code: 'harness_session_resume_failed'
  })

  assert.equal(shouldRetrySessionResume(retryable, 4, 5), true)
  assert.equal(shouldRetrySessionResume(retryable, 5, 5), false)
  assert.equal(shouldRetrySessionResume({ ...retryable, terminal: true }, 1, 5), false)
  assert.deepEqual(
    sessionResumeStatusItem('session-1', '恢复已停止', 'tension', true),
    {
      kind: 'status',
      text: '恢复已停止',
      tone: 'tension',
      incidentId: 'session-resume:session-1',
      runtimeAction: 'retry_session_resume',
      actionSessionId: 'session-1'
    }
  )
})

test('a late typed running state restores the UI running projection', () => {
  const stopped: Thread = { ...thread(), running: false, status: 'done' }
  const running = {
    ...stopped,
    ...projectSessionState({ state: 'running', runtime_id: 'codex', reason: 'late turn/start' })
  }

  assert.equal(running.runtimeId, 'codex')
  assert.equal(running.running, true)
  assert.equal(running.status, 'running')
})

test('native start activates a thread that previously had only a resource wait', () => {
  const waiting = {
    running: false,
    status: 'dormant' as const,
    queuedMessages: [{ queuedMessageId: 'waiting-1', state: 'waiting_resources' as const }]
  }
  const started = {
    ...waiting,
    ...projectSessionState({ state: 'running', runtime_id: 'codex' })
  }
  assert.equal(started.running, true)
  assert.equal(started.status, 'running')
  assert.deepEqual(started.queuedMessages, waiting.queuedMessages)
})

test('unknown HIL and dynamic-tool responses disable only their owned card', () => {
  for (const rpcMethod of ['server-response/hil', 'server-response/tool']) {
    const initial: Thread = {
      ...thread(),
      conversation: [
        {
          kind: 'hil',
          requestId: `request-${rpcMethod}`,
          hilKind: 'permission',
          hilState: 'failed',
          turnId: 'turn-1',
          itemId: 'item-owned'
        },
        {
          kind: 'hil',
          requestId: 'request-other',
          hilKind: 'permission',
          hilState: 'pending',
          turnId: 'turn-1',
          itemId: 'item-other'
        }
      ]
    }
    const updated = {
      ...initial,
      ...reportRuntimeIncident(initial, {
        incident_id: `incident-${rpcMethod}`,
        scope: 'turn',
        state: 'failed',
        kind: 'transport_lost',
        strategy: 'none',
        retryability: 'unknown_outcome',
        safe_error: 'runtime_transport_lost',
        process_generation: 3,
        attempt: 1,
        max_attempts: 1,
        rpc_method: rpcMethod,
        ambiguous_commit: true
      }, 'turn-1', 'item-owned')
    }
    const owned = updated.conversation.find(
      (item) => item.kind === 'hil' && item.itemId === 'item-owned'
    )
    const other = updated.conversation.find(
      (item) => item.kind === 'hil' && item.itemId === 'item-other'
    )

    assert.equal(owned?.kind === 'hil' ? owned.hilState : '', 'unknown')
    assert.match(owned?.kind === 'hil' ? owned.submissionError ?? '' : '', /检查当前会话与产物/)
    assert.equal(other?.kind === 'hil' ? other.hilState : '', 'pending')
  }
})

test('typed operation state correlates unknown outcome by HIL request id', () => {
  const initial: Thread = {
    ...thread(),
    conversation: [{
      kind: 'hil',
      requestId: 'request-typed',
      hilKind: 'permission',
      hilState: 'submitting',
      turnId: 'turn-typed',
      itemId: 'item-typed'
    }]
  }
  const updated = {
    ...initial,
    ...reportOperationState(initial, {
      kind: 'tool_response',
      correlation_id: 'request-typed',
      state: 'unknown',
      retryable: false,
      execution_count: 1
    }, 'turn-typed', 'item-typed')
  }

  const card = updated.conversation[0]
  assert.equal(card?.kind === 'hil' ? card.hilState : '', 'unknown')
  assert.match(card?.kind === 'hil' ? card.submissionError ?? '' : '', /不会重新提交/)
  assert.equal(card?.kind === 'hil' ? card.submissionErrorMessage : undefined, 'outcomeUnknown')
  const stale = reportOperationState(updated, {
    kind: 'tool_response', correlation_id: 'request-typed', state: 'stale', retryable: false, execution_count: 1
  }, 'turn-typed', 'item-typed').conversation?.[0]
  assert.equal(stale?.kind === 'hil' ? stale.submissionError : null, undefined)
  assert.equal(stale?.kind === 'hil' ? stale.submissionErrorMessage : null, undefined)
  assert.deepEqual(stale?.kind === 'hil' ? stale.resolvedMessage : null, { kind: 'stale' })
})

test('typed HIL rejection disables retry only for durable unknown or stale outcomes', () => {
  assert.equal(classifyHilResponseFailure('hil_response_not_retryable', 'unknown'), 'unknown')
  assert.equal(classifyHilResponseFailure('hil_response_not_retryable', 'stale'), 'stale')
  assert.equal(classifyHilResponseFailure('hil_request_stale', 'stale'), 'stale')
  assert.equal(classifyHilResponseFailure('hil_response_not_retryable', 'executing'), undefined)
})

test('turn reconciliation removes the interruption notice without changing the unknown outcome', () => {
  const initial: Thread = {
    ...thread(),
    running: false,
    status: 'abandon',
    turnOutcomes: { 'turn-unknown': 'unknown' },
    conversation: [{
      kind: 'error',
      title: '上次任务已中断',
      message: 'unknown',
      action: '继续对话',
      runtimeAction: 'confirm_turn_unknown',
      actionSessionId: 'session-1',
      actionTurnId: 'turn-unknown',
      actionState: 'submitting',
      turnId: 'turn-unknown'
    }]
  }
  const updated = { ...initial, ...reportTurnReconciled(initial, 'turn-unknown') }

  assert.equal(updated.status, 'done')
  assert.equal(updated.turnOutcomes?.['turn-unknown'], 'unknown')
  assert.equal(updated.conversation.length, 0)

  const laterRunning = { ...initial, running: true, status: 'running' as const }
  const lateReconcile = { ...laterRunning, ...reportTurnReconciled(laterRunning, 'turn-unknown') }
  assert.equal(lateReconcile.running, true)
  assert.equal(lateReconcile.status, 'running')
})

test('session open validates and allow-lists the typed recovery snapshot', () => {
  const turn = uncertain('turn', 'unknown', 'turn-unknown')
  const hil = uncertain('tool_response', 'unknown', 'request-tool')
  const rawHil = {
    ...hil.hil,
    command: 'must-not-cross-the-snapshot-edge',
    response: 'must-not-cross-the-snapshot-edge'
  }
  const parsed = parseOpenSessionResponse({
    session_id: 'session-1',
    runtime_id: 'codex',
    runtime: {},
    readiness: { ready: true },
    capabilities: {},
    running: false,
    uncertain_operations: [turn, { ...hil, hil: rawHil }],
    unknown_outcome: true,
    active_turn_id: null,
    last_turn_id: 'turn-unknown',
    last_turn_status: 'unknown_outcome'
  })

  assert.equal('error' in parsed, false)
  if (!('uncertain_operations' in parsed)) assert.fail('expected a validated OpenResp')
  assert.equal(parsed.uncertain_operations.length, 2)
  assert.equal(parsed.last_turn_id, 'turn-unknown')
  assert.equal(parsed.last_turn_status, 'unknown_outcome')
  const safeHil = parsed.uncertain_operations[1]?.hil
  assert.equal(safeHil?.request_id, 'request-tool')
  assert.equal(safeHil?.command, undefined)
  assert.equal('response' in (safeHil ?? {}), false)
})

test('session open fails closed on inconsistent or retryable recovery operations', () => {
  const turn = uncertain('turn', 'unknown', 'turn-unknown')
  for (const operation of [
    { ...turn, operation_state: 'stale' },
    { ...turn, retryable: true },
    {
      ...uncertain('hil_response', 'unknown', 'request-hil'),
      hil: { request_id: 'wrong-request', kind: 'permission' }
    }
  ]) {
    const parsed = parseOpenSessionResponse({
      session_id: 'session-1',
      running: false,
      uncertain_operations: [operation],
      unknown_outcome: operation.kind === 'turn',
      active_turn_id: null
    })
    assert.equal('error' in parsed ? parsed.code : '', 'invalid_session_recovery_snapshot')
  }
  const hiddenUnknown = parseOpenSessionResponse({
    session_id: 'session-1',
    running: false,
    uncertain_operations: [turn],
    unknown_outcome: false,
    active_turn_id: null
  })
  assert.equal('error' in hiddenUnknown ? hiddenUnknown.code : '', 'invalid_session_recovery_snapshot')

  for (const invalidTerminal of [
    { last_turn_id: 'turn-1', last_turn_status: 'invented' },
    { last_turn_id: 'turn-1', last_turn_status: null },
    { last_turn_id: null, last_turn_status: 'failed' }
  ]) {
    const parsed = parseOpenSessionResponse({
      session_id: 'session-1',
      running: false,
      uncertain_operations: [],
      unknown_outcome: false,
      active_turn_id: null,
      ...invalidTerminal
    })
    assert.equal('error' in parsed ? parsed.code : '', 'invalid_session_recovery_snapshot')
  }
})

test('Electron reload projects unknown TURN and HIL once without replaying a request', () => {
  const initial: Thread = { ...thread(), running: true, status: 'running' }
  const snapshot = {
    sessionId: 'session-1',
    running: false,
    activeTurnId: null,
    unknownOutcome: true,
    pendingHil: [{
      request_id: 'request-tool',
      kind: 'permission',
      turn_id: 'turn-hil',
      item_id: 'item-request-tool'
    }],
    uncertainOperations: [
      uncertain('tool_response', 'unknown', 'request-tool'),
      uncertain('turn', 'unknown', 'turn-unknown', 'codex_process_exit')
    ],
    timestamp: 1_700_000_000_000
  }
  const once = { ...initial, ...projectSessionRecovery(initial, snapshot) }
  const twice = { ...once, ...projectSessionRecovery(once, snapshot) }
  const unknownTurns = twice.conversation.filter((item) => (
    item.kind === 'error' && item.runtimeAction === 'confirm_turn_unknown'
  ))
  const unknownHil = twice.conversation.filter((item) => (
    item.kind === 'hil' && item.hilState === 'unknown'
  ))

  assert.deepEqual(twice, once)
  assert.equal(once.running, false)
  assert.equal(once.status, 'abandon')
  assert.equal(unknownTurns.length, 1)
  assert.equal(unknownHil.length, 1)
  assert.equal(unknownTurns[0]?.kind === 'error' ? unknownTurns[0].actionState : '', 'idle')
  assert.equal(unknownTurns[0]?.kind === 'error' ? unknownTurns[0].turnUnknown?.reason : '', 'processExit')
  assert.match(unknownHil[0]?.kind === 'hil' ? unknownHil[0].submissionError ?? '' : '', /不会重新提交/)
  assert.equal(twice.conversation.some((item) => item.kind === 'user'), false)
})

test('Serve restart projects stale operation terminally and preserves exact card ownership', () => {
  const initial: Thread = {
    ...thread(),
    conversation: [{
      kind: 'hil',
      requestId: 'request-stale',
      hilKind: 'permission',
      hilState: 'pending',
      turnId: 'turn-hil',
      itemId: 'item-request-stale'
    }]
  }
  const operation = uncertain('hil_response', 'stale', 'request-stale')
  const snapshot = {
    sessionId: 'session-1',
    running: false,
    activeTurnId: null,
    unknownOutcome: false,
    pendingHil: [],
    uncertainOperations: [operation],
    timestamp: 1_700_000_000_000
  }
  const recovered = { ...initial, ...projectSessionRecovery(initial, snapshot) }
  const card = recovered.conversation[0]

  assert.equal(card?.kind === 'hil' ? card.hilState : '', 'stale')
  assert.equal(card?.kind === 'hil' ? card.resolved : '', '请求已过期')
  assert.deepEqual(
    { ...recovered, ...projectSessionRecovery(recovered, snapshot) },
    recovered
  )
})

test('active_turn_id restores running ownership and a late TURN_UNKNOWN stays idempotent', () => {
  const initial: Thread = { ...thread(), running: true, status: 'running' }
  const running = {
    ...initial,
    ...projectSessionRecovery(initial, {
      sessionId: 'session-1',
      running: true,
      activeTurnId: 'turn-running',
      unknownOutcome: false,
      pendingHil: [],
      uncertainOperations: [],
      timestamp: 1_700_000_000_000
    })
  }
  assert.equal(running.turnOutcomes?.['turn-running'], 'running')

  const once = {
    ...running,
    ...reportTurnUnknown(running, { sessionId: 'session-1', turnId: 'turn-running' })
  }
  const twice = {
    ...once,
    ...reportTurnUnknown(once, { sessionId: 'session-1', turnId: 'turn-running' })
  }
  assert.equal(twice.conversation.filter((item) => item.kind === 'error').length, 1)
  assert.equal(twice.turnOutcomes?.['turn-running'], 'unknown')
})


test('the same runtime status redraws in either language without changing its diagnostic identity', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, defaultNS: 'conversation', resources: { zh: { conversation: zh }, en: { conversation: en } } })
  const original = thread()
  const update = reportRuntimeIncident(original, incident('retrying'), 'turn-localization')
  const status = update.conversation?.find((item) => item.kind === 'status')
  assert.ok(status?.kind === 'status' && typeof status.text !== 'string')
  const before = JSON.stringify(status)
  assert.match(formatRuntimeStatus(status.text, locale.getFixedT(null, 'conversation')), /正在恢复/)
  await locale.changeLanguage('en')
  assert.match(formatRuntimeStatus(status.text, locale.getFixedT(null, 'conversation')), /Recovering/)
  assert.equal(JSON.stringify(status), before)
  for (const reason of ['Vendor 原始 diagnostic', '__proto__', 'toString']) {
    assert.ok(formatRuntimeStatus({ key: 'runtime.failed', reason }, locale.getFixedT(null, 'conversation')).endsWith(reason))
  }
})

test('provider retries are not presented as agent connection recovery', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, defaultNS: 'conversation', resources: { zh: { conversation: zh }, en: { conversation: en } } })
  const providerRetry = {
    ...incident('retrying'),
    scope: 'provider' as const,
    kind: 'provider_retry' as const,
    strategy: 'vendor_retry' as const,
    safe_error: 'The model provider rejected the request.',
    max_attempts: 0
  }
  const update = reportRuntimeIncident(thread(), providerRetry, 'turn-provider')
  const status = update.conversation?.find((item) => item.kind === 'status')
  assert.ok(status?.kind === 'status' && typeof status.text !== 'string')
  assert.match(formatRuntimeStatus(status.text, locale.getFixedT(null, 'conversation')), /^模型服务正在重试/)
  assert.doesNotMatch(formatRuntimeStatus(status.text, locale.getFixedT(null, 'conversation')), /连接中断/)
})


test('resume status retains retry action ownership and renders parameters after language changes', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'en', fallbackLng: false, defaultNS: 'conversation', resources: { zh: { conversation: zh }, en: { conversation: en } } })
  const message: RuntimeStatusMessage = { key: 'resume.retrying', attempt: 2, maximum: 4, reason: 'Vendor diagnostic' }
  const notice = sessionResumeStatusItem('session-resume-i18n', message, 'tension', true)
  assert.equal(notice.runtimeAction, 'retry_session_resume')
  assert.equal(notice.actionSessionId, 'session-resume-i18n')
  assert.equal(notice.text, message)
  assert.match(formatRuntimeStatus(message, locale.getFixedT(null, 'conversation')), /Retrying \(2\/4\).*Vendor diagnostic/)
  await locale.changeLanguage('zh')
  assert.match(formatRuntimeStatus(message, locale.getFixedT(null, 'conversation')), /正在重试（2\/4）.*Vendor diagnostic/)
  assert.equal(notice.text, message)
})

test('resume request reasons translate on redraw without changing vendor diagnostics', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', resources: { zh: { conversation: zh }, en: { conversation: en } } })
  const message = { key: 'resume.stopped' as const, reason: { key: 'request.invalidRecovery' as const } }
  assert.match(formatRuntimeStatus(message, locale.getFixedT(null, 'conversation')), /避免重复提交/)
  await locale.changeLanguage('en')
  assert.match(formatRuntimeStatus(message, locale.getFixedT(null, 'conversation')), /prevent duplicate submissions/)
  assert.match(formatRuntimeStatus({ key: 'resume.stopped', reason: { key: 'request.timeout' } }, locale.getFixedT(null, 'conversation')), /timed out/)
})


test('application status descriptors can be redrawn in either language', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', resources: { zh: { conversation: zh }, en: { conversation: en } }, defaultNS: 'conversation' })
  const t = locale.getFixedT(null, 'conversation')
  const compacted = { key: 'context.compacted' } as const
  const missing = { key: 'artifactFailure.missing' } as const
  assert.equal(formatRuntimeStatus(compacted, t), '上下文已压缩，正在继续执行')
  assert.equal(formatRuntimeStatus(missing, t), '文件不存在，未能展示产物。')
  await locale.changeLanguage('en')
  assert.equal(formatRuntimeStatus(compacted, t), 'Context compacted. Continuing execution.')
  assert.equal(formatRuntimeStatus(missing, t), 'The file does not exist, so the artifact could not be displayed.')
  assert.deepEqual(compacted, { key: 'context.compacted' })
})


test('ambiguous turn application text switches language while raw diagnostics and confirmation semantics remain intact', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, interpolation: { escapeValue: false }, resources: {
    zh: { conversation: zh, components: componentsZh }, en: { conversation: en, components: componentsEn }
  } })
  const t = locale.getFixedT(null, 'conversation')
  for (const [message, reason] of [
    [undefined, 'unconfirmed'], ['runtime_rpc_timeout', 'timeout'],
    ['runtime_transport_lost', 'transportLost'], ['codex_process_exit', 'processExit']
  ] as const) {
    const updated = { ...thread(), ...reportTurnUnknown(thread(), { sessionId: 'session-1', turnId: 'turn', message }) }
    const card = updated.conversation.find(item => item.kind === 'error')
    assert.ok(card?.kind === 'error')
    assert.equal(card.runtimeAction, 'confirm_turn_unknown')
    assert.equal(card.actionState, 'idle')
    const canonical = { title: card.title, message: card.message, action: card.action }
    await locale.changeLanguage('en')
    assert.deepEqual(formatTurnUnknown(card, t), {
      title: en.turnUnknown.title, message: en.turnUnknown.reason[reason], action: en.turnUnknown.action
    })
    assert.deepEqual({ title: card.title, message: card.message, action: card.action }, canonical)
    const reconciled = { ...updated, ...reportTurnReconciled(updated, 'turn') }
    assert.equal(reconciled.conversation.some(item => item.kind === 'error'), false)
  }
  const diagnostic = '请求可能已经送达 Agent 运行时，但客户端没有收到确认。'
  const raw = reportTurnUnknown(thread(), { sessionId: 'session-1', turnId: 'raw', message: diagnostic }).conversation?.find(item => item.kind === 'error')
  assert.ok(raw?.kind === 'error')
  assert.equal(formatTurnUnknown(raw, t).message, diagnostic)
  assert.equal(formatRuntimeStatus({ key: 'runtime.closed' }, t), en.runtime.closed)
  assert.equal(t('hil.invalidRequest'), en.hil.invalidRequest)
})
