import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { createInstance } from 'i18next'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import zh from '../../localization/locales/zh/conversation.json' with { type: 'json' }
import en from '../../localization/locales/en/conversation.json' with { type: 'json' }
import componentsZh from '../../localization/locales/zh/components.json' with { type: 'json' }
import componentsEn from '../../localization/locales/en/components.json' with { type: 'json' }
import { DirectiveStreamHarness } from './directive.ts'
import {
  describeTurnFailure,
  formatTurnFailure,
  isRecoverableTurnFailure,
  sameTurnFailureMessage,
} from './failures.ts'
import {
  projectHistorySnapshot,
  projectHistoryWithRuntime,
  projectStreamDelta,
} from './transcript.ts'

import {
  classifyHilResponseFailure,
  classifySessionResumeFailure,
  isProductEventEnvelope,
  parseSessionCatalog,
  parseSessionCatalogResult,
  parseOpenSessionResponse,
  sessionCatalogHttpFailure,
  serviceErrorDetail,
  type RuntimeIncidentData,
  type UncertainOperationSnapshot,
} from './api.ts'
import {
  projectResumeRunState,
  projectBackendAvailability,
  recoveredTurnOutcome,
  applyRuntimeIncident,
  blocksRuntimePreflight,
  catalogRunStateIsCurrent,
  canOfferTurnRecovery,
  canContinueFailedTurn,
  classifyReadiness,
  effectiveReadiness,
  formatRuntimeStatus,
  formatTurnUnknown,
  hasCurrentTurnCapabilityFailure,
  permissionModeFailure,
  permissionModeNeedsConfirmation,
  permissionModeShowsNextTurn,
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
  shouldRetrySessionResume,
} from './runtime.ts'
import type { ConvItem, QueuedMessage, RuntimeStatusMessage, Thread } from './model.ts'
import { mergeQueuedOutbox, releaseQueuedOutbox, retainQueuedOutbox } from './outbox.ts'
import { optimisticQueuedMessage, shouldPresentQueuedMessage } from './queue.ts'

test('known workbench identity survives only a verified same-instance accepted drain', () => {
  const current = { backendReady: true, workbenchReady: true, serviceInstanceId: 'instance' }
  const accepted = { state: 'accepted' as const, service_instance_id: 'instance' }
  assert.deepEqual(projectBackendAvailability(current, null, accepted), current)
  const unavailable = { backendReady: false, workbenchReady: false, serviceInstanceId: null }
  for (const reconfiguration of [
    null,
    { ...accepted, service_instance_id: 'other' },
    ...([null, 'applied', 'rejected', 'restart_required', 'unsupported'] as const).map((state) => ({
      ...accepted,
      state,
    })),
  ] as const) {
    assert.deepEqual(projectBackendAvailability(current, null, reconfiguration), unavailable)
  }
  for (const previous of [
    unavailable,
    { ...current, backendReady: false },
    { ...current, workbenchReady: false },
    { ...current, serviceInstanceId: null },
  ]) {
    assert.deepEqual(projectBackendAvailability(previous, null, accepted), unavailable)
  }
  const failed = { ok: false, runtime_id: 'codex' as const, workbench_ready: false }
  assert.deepEqual(projectBackendAvailability(current, failed, accepted), unavailable)
  const replacement = {
    ...failed,
    ok: true,
    workbench_ready: true,
    service_instance_id: 'replacement',
  }
  assert.deepEqual(projectBackendAvailability(current, replacement, accepted), {
    backendReady: true,
    workbenchReady: true,
    serviceInstanceId: 'replacement',
  })
})

test('late maintenance observations cannot retain a replaced or invalidated shell identity', () => {
  const old = { state: 'accepted' as const, service_instance_id: 'old' }
  for (const current of [
    { backendReady: true, workbenchReady: true, serviceInstanceId: 'new' },
    { backendReady: false, workbenchReady: false, serviceInstanceId: 'old' },
  ]) {
    assert.deepEqual(projectBackendAvailability(current, null, old), {
      backendReady: false,
      workbenchReady: false,
      serviceInstanceId: null,
    })
  }
})

test(
  'the real App health effect preserves only a currently verified maintenance identity',
  { timeout: 5000 },
  async () => {
    const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    const syntax = ts.createSourceFile(
      'App.tsx',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
    const effects: ts.CallExpression[] = []
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(syntax) === 'useEffect' &&
        node.arguments[0]?.getText(syntax).includes('await getBackendHealth()')
      )
        effects.push(node)
      ts.forEachChild(node, visit)
    }
    visit(syntax)
    assert.equal(effects.length, 1)
    const script = ts.transpileModule(effects[0].getText(syntax), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText
    const ready = { backendReady: true, workbenchReady: true, serviceInstanceId: 'instance' }
    for (const replacement of [false, true]) {
      let snapshot = { ...ready }
      let release: (value: { state: 'accepted'; service_instance_id: string }) => void = () =>
        undefined
      let entered = (): void => undefined
      const observation = new Promise<void>((resolve) => {
        entered = resolve
      })
      const pending = new Promise<{ state: 'accepted'; service_instance_id: string }>((resolve) => {
        release = resolve
      })
      let scheduled = 0
      runInNewContext(script, {
        useEffect: (effect: () => void) => effect(),
        startup: { phase: 'ready', generation: 1 },
        STARTUP_PHASE: { ready: 'ready' },
        getSnapshot: () => snapshot,
        getBackendHealth: async () => null,
        getSharedRuntimeReconfiguration: () => {
          entered()
          return pending
        },
        projectBackendAvailability,
        set: (patch: typeof ready | ((current: typeof ready) => typeof ready)) => {
          snapshot = { ...snapshot, ...(typeof patch === 'function' ? patch(snapshot) : patch) }
        },
        setTimeout: (_callback: unknown, duration: number) => {
          scheduled = duration
          return 0
        },
        clearTimeout: () => undefined,
        HEALTH_REFRESH_MS: 30000,
        HEALTH_RETRY_MS: 1500,
      })
      await observation
      if (replacement) snapshot = { ...ready, serviceInstanceId: 'replacement' }
      release({ state: 'accepted', service_instance_id: 'instance' })
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.deepEqual(
        snapshot,
        replacement
          ? { backendReady: false, workbenchReady: false, serviceInstanceId: null }
          : ready
      )
      assert.equal(scheduled, 1500)
    }
  }
)

test('turn recovery waits for the authoritative session to stop running', () => {
  assert.equal(canOfferTurnRecovery({ running: true, status: 'failed' }), false)
  assert.equal(canOfferTurnRecovery({ running: false, status: 'running' }), false)
  assert.equal(canOfferTurnRecovery({ running: false, status: 'waiting' }), false)
  assert.equal(canOfferTurnRecovery({ running: false, status: 'failed' }), true)
  assert.equal(canOfferTurnRecovery({ running: false, status: 'done' }), true)
})

test('failed turn recovery expires after subsequent turns and blocks pending submissions', () => {
  const failure = { ...describeTurnFailure({ retryable: true }), turnId: 'failed-turn' }
  const current: Thread = { ...thread(), running: false, status: 'failed', conversation: [failure] }
  assert.equal(canContinueFailedTurn(current, failure), true)
  assert.equal(canContinueFailedTurn({ ...current, running: true }, failure), false)
  assert.equal(canContinueFailedTurn(current, { ...failure, actionState: 'submitting' }), false)
  assert.equal(
    canContinueFailedTurn(current, { ...failure, actionState: 'outcome_unknown' }),
    false
  )
  const replayed: Thread = {
    ...current,
    status: 'done',
    conversation: [failure, { kind: 'user', text: '继续', turnId: 'next-turn' }],
  }
  assert.equal(canContinueFailedTurn(replayed, failure), false)
  assert.equal(
    canContinueFailedTurn({ ...current, conversation: replayed.conversation }, failure),
    false
  )
  assert.equal(canContinueFailedTurn(current, { ...failure, turnId: undefined }), false)
})

test('recoverable provider continuation obeys authoritative thread and submission guards', () => {
  const failure = {
    ...describeTurnFailure({ code: 'codex_provider_failed', retryable: true }),
    turnId: 'failed-turn',
  }
  const current: Thread = {
    ...thread(),
    running: false,
    status: 'failed',
    conversation: [failure],
    turnOutcomes: { 'failed-turn': 'failed' },
  }
  assert.equal(canContinueFailedTurn(current, failure), true)
  for (const update of [
    { running: true },
    { status: 'running' as const },
    { status: 'waiting' as const },
    { recoveryPending: true },
    { terminated: true },
    { turnOutcomes: { 'failed-turn': 'completed' as const } },
    {
      conversation: [failure, { kind: 'agent' as const, text: 'new response', turnId: 'new-turn' }],
    },
  ]) {
    assert.equal(
      canContinueFailedTurn({ ...current, ...update }, failure),
      false,
      JSON.stringify(update)
    )
  }
  for (const actionState of ['submitting', 'outcome_unknown'] as const) {
    assert.equal(canContinueFailedTurn(current, { ...failure, actionState }), false, actionState)
  }
  for (const state of [
    'queued',
    'waiting_resources',
    'submitting',
    'outcome_unknown',
    'failed',
  ] as const) {
    const queued: QueuedMessage = {
      queuedMessageId: 'queued-message',
      enqueueSeq: 1,
      state,
      submissionMode: 'queued',
      text: 'next instruction',
      input: [],
      assistantReferences: [],
    }
    assert.equal(
      canContinueFailedTurn({ ...current, queuedMessages: [queued] }, failure),
      state === 'failed',
      state
    )
  }
  assert.equal(canContinueFailedTurn(current, { ...failure, turnId: undefined }), false)
  assert.equal(canContinueFailedTurn(current, { ...failure, runtimeAction: undefined }), false)
  assert.equal(canContinueFailedTurn({ ...current, conversation: [] }, failure), false)
})

test('unknown turn continuation blocks pending recovery and subsequent messages', () => {
  const interrupted = {
    kind: 'error' as const,
    title: 'Interrupted',
    message: 'Interrupted',
    action: 'Continue',
    runtimeAction: 'confirm_turn_unknown' as const,
    turnId: 'interrupted-turn',
    actionState: 'idle' as const,
  }
  const current: Thread = {
    ...thread(),
    running: false,
    status: 'done',
    conversation: [interrupted],
  }
  assert.equal(canContinueFailedTurn(current, interrupted), true)
  assert.equal(canContinueFailedTurn({ ...current, recoveryPending: true }, interrupted), false)
  assert.equal(
    canContinueFailedTurn(current, { ...interrupted, actionState: 'outcome_unknown' }),
    false
  )
  assert.equal(canContinueFailedTurn(current, { ...interrupted, actionState: 'submitting' }), false)
  assert.equal(canContinueFailedTurn({ ...current, running: true }, interrupted), false)
  assert.equal(
    canContinueFailedTurn(
      {
        ...current,
        conversation: [
          ...current.conversation,
          { kind: 'user', text: 'new instruction', turnId: 'new-turn' },
        ],
      },
      interrupted
    ),
    false
  )
})

test('catalog state cannot revive a turn after a newer terminal event', () => {
  const completed = { lastSeq: 205, running: false }
  assert.equal(catalogRunStateIsCurrent({ last_seq: 204, running: true }, completed), false)
  assert.equal(catalogRunStateIsCurrent({ last_seq: 205, running: true }, completed), false)
  assert.equal(catalogRunStateIsCurrent({ last_seq: 205, running: false }, completed), true)
  assert.equal(catalogRunStateIsCurrent({ last_seq: 206, running: true }, completed), true)
})

test('session recovery restores running state while a child is still active', () => {
  const initial: Thread = { ...thread(), running: false, status: 'failed' }
  const recovered = {
    ...initial,
    ...projectSessionRecovery(initial, {
      sessionId: 'session-1',
      running: true,
      activeTurnId: 'native-turn',
      unknownOutcome: false,
      pendingHil: [],
      uncertainOperations: [],
      timestamp: 1,
    }),
  }
  assert.equal(recovered.running, true)
  assert.equal(recovered.status, 'running')
  assert.equal(recovered.turnOutcomes?.['native-turn'], 'running')
  assert.equal(canOfferTurnRecovery(recovered), false)
})

for (const kind of ['permission', 'user_input']) {
  test(`session recovery restores waiting for an existing ${kind} card`, () => {
    const snapshot = {
      sessionId: 'session-1',
      running: true,
      activeTurnId: 'native-turn',
      unknownOutcome: false,
      pendingHil: [{ request_id: 'pending-request', kind, turn_id: 'native-turn' }],
      uncertainOperations: [],
      timestamp: 1_700_000_000_000,
    }
    const initial = thread()
    const first = { ...initial, ...projectSessionRecovery(initial, snapshot) }
    const reopened: Thread = { ...first, status: 'running' }
    const recovered = { ...reopened, ...projectSessionRecovery(reopened, snapshot) }
    assert.equal(recovered.running, true)
    assert.equal(recovered.status, 'waiting')
    assert.equal(recovered.turnOutcomes?.['native-turn'], 'running')
    assert.equal(recovered.conversation, first.conversation)
    assert.equal(recovered.conversation.filter((item) => item.kind === 'hil').length, 1)
    assert.deepEqual({ ...recovered, ...projectSessionRecovery(recovered, snapshot) }, recovered)
  })
}

test('recovering product authorization does not revive its completed turn', () => {
  const initial: Thread = {
    ...thread(),
    running: false,
    status: 'done',
    turnOutcomes: { turn: 'completed' },
  }
  const snapshot = {
    sessionId: 'session-1',
    running: false,
    activeTurnId: null,
    unknownOutcome: false,
    pendingHil: [
      { request_id: 'product', kind: 'question', lifetime: 'session' as const, turn_id: 'turn' },
    ],
    uncertainOperations: [],
    timestamp: 1_700_000_000_000,
  }
  const once = { ...initial, ...projectSessionRecovery(initial, snapshot) }
  const twice = { ...once, ...projectSessionRecovery(once, snapshot) }
  assert.equal(twice.running, false)
  assert.equal(twice.status, 'done')
  assert.equal(twice.turnOutcomes?.turn, 'completed')
  assert.equal(twice.conversation.filter((item) => item.kind === 'hil').length, 1)
})

test('message snapshots remain cumulative exactly once through directive and transcript projection', () => {
  const stream = new DirectiveStreamHarness()
  let rows = projectStreamDelta(
    [],
    'thinking',
    stream.append('item', '我', true),
    'turn',
    'item',
    true
  )
  rows = projectStreamDelta(
    rows,
    'thinking',
    stream.append('item', '我会计算。', true),
    'turn',
    'item',
    true
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind === 'thinking' ? rows[0].text : null, '我会计算。')
  assert.equal(
    stream.append('item', '我会计算。\n::scholarseed-preview{file="a.py"}', true),
    '我会计算。'
  )
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
    data: { delta: 'ok' },
  }
  assert.equal(isProductEventEnvelope(current), true)
  assert.equal(isProductEventEnvelope({ ...current, v: 1 }), false)
  assert.equal(isProductEventEnvelope({ ...current, seq: 0 }), false)
  assert.equal(isProductEventEnvelope({ ...current, data: null }), false)
})

test('permission failures distinguish connection from runtime failures', () => {
  assert.match(
    permissionModeFailure({
      ok: false,
      error: 'session_permission_switch_requires_hil_resolution',
    }),
    /处理当前审批/
  )
  assert.match(
    permissionModeFailure({ ok: false, error: 'permission_mode_connection_failed' }),
    /无法连接/
  )
  assert.equal(
    permissionModeFailure({
      ok: false,
      error: 'session_permission_switch_failed',
      detail: 'Codex 拒绝恢复会话。',
    }),
    '权限模式切换未成功，请检查运行时连接后重试。'
  )
  assert.doesNotMatch(
    permissionModeFailure({ ok: false, error: 'session_permission_policy_immutable' }),
    /运行中/
  )
  assert.doesNotMatch(permissionModeFailure({ ok: false }), /运行中/)
})

test('turn failures map stable provider codes to actionable product guidance', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    resources: { zh: { conversation: zh }, en: { conversation: en } },
  })
  const display = (item: ReturnType<typeof describeTurnFailure>) =>
    formatTurnFailure(item, locale.getFixedT(null, 'conversation'))
  const policy = describeTurnFailure({ code: 'CONTENT_SAFETY_BLOCKED', retryable: true })
  assert.equal(display(policy).message, '本次内容未通过安全审核，请修改后重试。')
  assert.equal(display(policy).action, display(policy).message)
  assert.equal(policy.runtimeAction, undefined)
  assert.equal(describeTurnFailure({ code: 'CONTENT_SAFETY_UNAVAILABLE' }).failure?.kind, 'unknown')
  const quota = describeTurnFailure({
    code: 'insufficient_quota',
    message: 'You exceeded your current quota.',
    retryable: true,
  })
  assert.equal(display(quota).title, '回答生成失败')
  assert.match(display(quota).action, /剩余积分/)
  assert.equal(quota.runtimeAction, undefined)

  const allocationQuota = describeTurnFailure({
    message:
      'id:1\nevent:error\n:HTTP_STATUS/429\ndata:{"request_id":"private","code":"Throttling.AllocationQuota","message":"Allocated quota exceeded. https://private.example"}',
    retryable: true,
  })
  assert.equal(display(allocationQuota).message, '模型分配额度已用完。')
  assert.doesNotMatch(JSON.stringify(allocationQuota), /private|HTTP_STATUS|event:error/)
  assert.equal(allocationQuota.runtimeAction, undefined)

  const rateLimit = describeTurnFailure({
    code: 'rate_limit_exceeded',
    message: 'Please retry later.',
    retryable: true,
  })
  assert.match(display(rateLimit).message, /请求过于频繁/)
  assert.equal(rateLimit.runtimeAction, 'continue_turn')

  const auth = describeTurnFailure({
    code: 'runtime_not_authenticated',
    message: 'unauthorized',
    retryable: false,
  })
  assert.match(display(auth).action, /登录/)
  assert.equal(auth.runtimeAction, 'continue_turn')

  const codeWins = describeTurnFailure({
    code: 'runtime_not_authenticated',
    message: 'You exceeded your current quota.',
    retryable: true,
  })
  assert.match(display(codeWins).message, /认证失败/)
  assert.equal(codeWins.runtimeAction, 'continue_turn')

  const untyped = describeTurnFailure({ message: 'backend unavailable' })
  assert.equal(untyped.runtimeAction, undefined)
  const exhausted = describeTurnFailure({
    code: 'service_unavailable',
    message: 'The model provider is temporarily unavailable.',
    retryable: true,
    automatic_retry_attempts: 3,
  })
  assert.equal(exhausted.failure?.kind, 'unavailable')
  assert.equal(exhausted.failure?.automaticRetryAttempts, 3)
  assert.equal(display(exhausted).message, '模型服务暂时不可用，已自动重试 3 次')
  assert.equal(exhausted.runtimeAction, 'continue_turn')
  const overloaded = describeTurnFailure({
    code: 'server_is_overloaded',
    message: 'The model provider is temporarily unavailable.',
    retryable: true,
  })
  assert.equal(overloaded.failure?.kind, 'overloaded')
  assert.equal(display(overloaded).message, '上游模型服务返回过载。')
  assert.equal(display(overloaded).action, '请稍后重试；本轮问题与上下文已保留。')
  assert.equal(overloaded.runtimeAction, 'continue_turn')
  assert.equal(describeTurnFailure({ code: 'overloaded' }).failure?.kind, 'overloaded')
  assert.equal(describeTurnFailure({ code: 'server_error' }).failure?.kind, 'unavailable')
  assert.equal(
    describeTurnFailure({ message: 'server_is_overloaded' }).failure?.kind,
    'unavailable'
  )
  const retriedOverload = describeTurnFailure({
    code: 'server_is_overloaded',
    retryable: true,
    automatic_retry_attempts: 3,
  })
  assert.equal(display(retriedOverload).message, '上游模型服务返回过载，自动尝试 3 次后仍未恢复。')
  assert.equal(sameTurnFailureMessage(overloaded, retriedOverload), true)
  assert.equal(sameTurnFailureMessage(overloaded, exhausted), false)
  await locale.changeLanguage('en')
  assert.equal(display(quota).title, 'Answer generation failed')
  assert.equal(display(quota).message, 'The allocated model quota has been exhausted.')
  assert.equal(display(overloaded).message, 'The upstream model service reported overload.')
  assert.equal(
    display(retriedOverload).message,
    'The upstream model service reported overload and remains unavailable after 3 automatic attempts.'
  )
  assert.equal(sameTurnFailureMessage(quota, allocationQuota), true)
  assert.equal(sameTurnFailureMessage(quota, rateLimit), false)
  assert.equal(
    sameTurnFailureMessage(
      { kind: 'error', title: '旧标题', action: '旧建议', message: '模型分配额度已用完。' },
      quota
    ),
    true
  )
  const raw = describeTurnFailure({ message: 'opaque diagnostic /user/file' })
  assert.equal(raw.message, 'opaque diagnostic /user/file')
  assert.equal(display(raw).message, en.failure.unknown.message)
  const legacy = { kind: 'error' as const, title: '旧标题', message: '旧诊断', action: '旧建议' }
  assert.deepEqual(formatTurnFailure(legacy, locale.getFixedT(null, 'conversation')), legacy)
})

test('credit balance exhaustion maps to a dedicated credits card without retry', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    resources: { zh: { conversation: zh }, en: { conversation: en } },
  })
  const display = (item: ReturnType<typeof describeTurnFailure>) =>
    formatTurnFailure(item, locale.getFixedT(null, 'conversation'))
  const credits = describeTurnFailure({
    code: 'credit_balance_exhausted',
    message: 'The account credit balance is exhausted.',
    retryable: true,
  })
  assert.equal(credits.failure?.kind, 'credits')
  assert.equal(display(credits).title, '回答生成失败')
  assert.equal(display(credits).message, '积分余额已用尽，本次生成已停止。')
  assert.match(display(credits).action, /获取更多积分/)
  // 余额只能靠补充恢复：即使上游标了 retryable，积分卡也不给重试动作。
  assert.equal(credits.runtimeAction, undefined)
  await locale.changeLanguage('en')
  assert.equal(
    display(credits).message,
    'Your credit balance is exhausted, so generation has stopped.'
  )
})

test('subscription capability rejection stays localized and never offers unchanged continuation', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    resources: { zh: { conversation: zh }, en: { conversation: en } },
  })
  const providerCode = 'subscription_sharing_unsupported_capability'
  const message =
    'The ChatGPT subscription connection does not support this request capability. Use a compatible model source or start a task without that capability; retrying unchanged will fail.'
  for (const data of [
    { code: providerCode, message, retryable: true },
    { code: 'codex_provider_failed', provider_error_code: providerCode, message, retryable: true },
  ]) {
    const failure = { ...describeTurnFailure(data), turnId: 'capability-turn' }
    assert.equal(failure.failure?.kind, 'capability')
    assert.equal(failure.runtimeAction, undefined)
    assert.equal(isRecoverableTurnFailure(failure), false)
    assert.equal(
      sameTurnFailureMessage(
        { kind: 'error', title: '', message: '', action: '', runtimeAction: 'continue_turn' },
        failure
      ),
      false
    )
    const current: Thread = {
      ...thread(),
      running: false,
      status: 'failed',
      conversation: [failure],
      turnOutcomes: { 'capability-turn': 'failed' },
    }
    assert.equal(canContinueFailedTurn(current, failure), false)
    assert.equal(
      canContinueFailedTurn(current, { ...failure, runtimeAction: 'continue_turn' }),
      false
    )
    await locale.changeLanguage('zh')
    const before = JSON.stringify(failure)
    const chinese = formatTurnFailure(failure, locale.getFixedT(null, 'conversation'))
    assert.equal(chinese.message, 'ChatGPT 订阅连接不支持此请求使用的能力。')
    assert.equal(
      chinese.action,
      '请切换到支持该能力的模型来源，或新建不使用该能力的任务；保持当前请求不变并点击继续仍会失败。任务历史已保留。'
    )
    await locale.changeLanguage('en')
    const english = formatTurnFailure(failure, locale.getFixedT(null, 'conversation'))
    assert.equal(
      english.message,
      'The ChatGPT subscription connection does not support this request capability.'
    )
    assert.match(english.action, /compatible model source/)
    assert.match(english.action, /retrying unchanged will fail/)
    assert.equal(JSON.stringify(failure), before)
  }
  const ordinary = describeTurnFailure({
    code: 'codex_provider_failed',
    provider_error_code: 'unknown_provider_code',
    message: 'The model provider is temporarily unavailable.',
    retryable: true,
  })
  assert.equal(ordinary.failure?.kind, 'unavailable')
  assert.equal(ordinary.runtimeAction, 'continue_turn')
})

test('subscription capability history replay retains the terminal failure without a continue action', () => {
  const previous = {
    ...describeTurnFailure({ retryable: true }),
    turnId: 'capability-turn',
  }
  const conversation = projectHistorySnapshot(
    {
      turns: [],
      todos: [],
      todo_turn_id: null,
      artifacts: [],
      turn_activity: [],
      activity_events: [
        {
          v: 2,
          seq: 1,
          ts: 1,
          type: 'turn_failed',
          session_id: 'session-1',
          turn_id: 'capability-turn',
          data: {
            code: 'codex_provider_failed',
            provider_error_code: 'subscription_sharing_unsupported_capability',
            message:
              'The ChatGPT subscription connection does not support this request capability.',
            retryable: true,
          },
        },
      ],
    },
    [previous]
  )
  const failure = conversation.find(
    (item) => item.kind === 'error' && item.failure?.kind === 'capability'
  )
  assert.ok(failure?.kind === 'error')
  assert.equal(failure.failure?.kind, 'capability')
  assert.equal(failure.runtimeAction, undefined)
  assert.equal(
    canContinueFailedTurn({ ...thread(), running: false, status: 'failed', conversation }, failure),
    false
  )
  assert.ok(conversation.includes(previous))
  assert.equal(
    canContinueFailedTurn(
      { ...thread(), running: false, status: 'failed', conversation },
      previous
    ),
    false
  )
})

test('subscription capability incident explains the terminal rejection in both languages', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    resources: { zh: { conversation: zh }, en: { conversation: en } },
  })
  const update = reportRuntimeIncident(
    thread(),
    {
      ...incident('detected'),
      scope: 'turn',
      kind: 'rpc_rejected',
      strategy: 'none',
      retryability: 'terminal',
      safe_error: 'The ChatGPT subscription connection does not support this request capability.',
      provider_error_code: 'subscription_sharing_unsupported_capability',
    },
    'capability-turn'
  )
  const status = update.conversation?.find((item) => item.kind === 'status')
  assert.ok(status?.kind === 'status' && typeof status.text !== 'string')
  assert.match(
    formatRuntimeStatus(status.text, locale.getFixedT(null, 'conversation')),
    /订阅连接不支持/
  )
  await locale.changeLanguage('en')
  assert.match(
    formatRuntimeStatus(status.text, locale.getFixedT(null, 'conversation')),
    /subscription connection does not support/
  )
})

test('composer header continuation blocks only the current capability failure', async () => {
  const source = readFileSync(
    new URL('./components/business/Composer.tsx', import.meta.url),
    'utf8'
  )
  const syntax = ts.createSourceFile(
    'Composer.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const headers: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(syntax) === 'header')
      headers.push(node)
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  assert.equal(headers.length, 1)
  const script = ts.transpileModule(headers[0].getText(syntax), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const capability = {
    ...describeTurnFailure({ code: 'subscription_sharing_unsupported_capability' }),
    turnId: 'capability-turn',
  }
  for (const [conversation, blocked] of [
    [[capability], true],
    [[capability, { kind: 'user', text: 'new task', turnId: 'next-turn' }], false],
    [[{ ...describeTurnFailure({ retryable: true }), turnId: 'ordinary-turn' }], false],
  ] as [ConvItem[], boolean][]) {
    let submissions = 0
    let controls: { continueTurn: () => Promise<boolean>; continueDisabled: boolean } | undefined
    runInNewContext(script, {
      hasCurrentTurnCapabilityFailure,
      thread: { ...thread(), running: false, status: 'failed', conversation },
      continueDisabled: false,
      header: (value: typeof controls) => {
        controls = value
      },
      t: () => 'continue',
      submit: async () => {
        submissions += 1
        return true
      },
    })
    assert.ok(controls)
    assert.equal(controls.continueDisabled, blocked)
    assert.equal(await controls.continueTurn(), !blocked)
    assert.equal(submissions, blocked ? 0 : 1)
  }
})

test('classified turn failures keep a distinct reason for the card to surface', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    resources: { zh: { conversation: zh }, en: { conversation: en } },
  })
  const display = (item: ReturnType<typeof describeTurnFailure>) =>
    formatTurnFailure(item, locale.getFixedT(null, 'conversation'))

  // 适配器 _AUTH_CODES 里有这个码，渲染层曾漏登记，于是塌缩成 unknown 并只剩英文脱敏原文。
  const bridge = describeTurnFailure({
    code: 'model_bridge_credential_required',
    message: 'The model provider authentication failed.',
    retryable: false,
  })
  assert.equal(bridge.failure?.kind, 'auth')
  assert.equal(display(bridge).message, '模型服务认证失败。')
  assert.equal(display(bridge).action, zh.failure.auth.action)

  // 限流是原因句最要紧的一条：action 只说「已保留」，看不出是限流。
  const rateLimit = describeTurnFailure({
    code: 'rate_limit_exceeded',
    message: 'The model provider rate limit was reached.',
    retryable: true,
  })
  assert.equal(display(rateLimit).message, '模型请求过于频繁，请稍后再试。')
  assert.notEqual(display(rateLimit).action, display(rateLimit).message)

  // 未登记码仍落 unknown，原始诊断留在事件中，但错误卡片只显示通用文案。
  const unregistered = describeTurnFailure({
    code: 'codex_provider_failed',
    message: 'The model provider rejected the request.',
    retryable: true,
  })
  assert.equal(unregistered.failure?.kind, 'unknown')
  assert.equal(unregistered.message, 'The model provider rejected the request.')
  assert.equal(display(unregistered).message, zh.failure.unknown.message)
  assert.equal(display(unregistered).action, '生成过程中发生异常，已保留本轮问题和上下文。')

  await locale.changeLanguage('en')
  assert.equal(display(bridge).message, 'Model service authentication failed.')
  assert.equal(display(rateLimit).message, 'Too many model requests. Try again later.')
})

test('the turn failure card uses a compact description and retry action', () => {
  const host = readFileSync(new URL('./components/business/Stream.tsx', import.meta.url), 'utf8')
  assert.match(
    host,
    /<Failure[\s\S]*?recoveryAvailable=\{recoveryAvailable\}[\s\S]*?onContinue=\{onContinue\}[\s\S]*?onRepair=\{recoverAuthentication\}/
  )
  assert.match(host, /latest\.thread\.id !== recoveryThread\.id/)
  assert.match(host, /latest\.item\.turnId !== item\.turnId/)
  assert.match(host, /continueRequested && !canContinueFailedTurn\(latest\.thread, latest\.item\)/)
  const stream = readFileSync(new URL('./components/business/Failure.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(stream, /useApp|getAuthMe|getModels|openSettings|window\./)
  const anchor = stream.indexOf('data-testid="turn-failure-card"')
  assert.notEqual(anchor, -1)
  const card = stream.slice(anchor)
  assert.match(card, /data-testid="turn-failure-description"[\s\S]*?\{failureDescription\}/)
  assert.match(card, /data-testid="turn-continue"[\s\S]*?t\('stream\.retry'\)/)
  assert.doesNotMatch(card, /data-testid="turn-failure-(?:reason|action)"/)
})

test('recoverable failures reuse the compact continuation notice and interrupted action', () => {
  const stream = readFileSync(new URL('./components/business/Failure.tsx', import.meta.url), 'utf8')
  const notice = stream.indexOf('data-testid="turn-recoverable-notice"')
  const card = stream.indexOf('data-testid="turn-failure-card"')
  assert.notEqual(notice, -1)
  assert.notEqual(card, -1)
  assert.ok(notice < card)
  assert.match(stream.slice(notice, card), /data-testid="turn-continue"/)
  assert.match(stream.slice(notice, card), /t\('stream\.continueInterrupted'\)/)
})

test('recoverable notice JSX renders localized messages, pending buttons and bound continuation', async () => {
  const source = readFileSync(new URL('./components/business/Failure.tsx', import.meta.url), 'utf8')
  const syntax = ts.createSourceFile(
    'Stream.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const branches: ts.IfStatement[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && node.expression.getText(syntax) === 'recoverableFailure')
      branches.push(node)
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  assert.equal(branches.length, 1)
  const script = ts.transpileModule(`(() => { ${branches[0].getText(syntax)} return null })()`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    resources: {
      zh: { conversation: zh, components: componentsZh },
      en: { conversation: en, components: componentsEn },
    },
  })
  for (const language of ['zh', 'en']) {
    await locale.changeLanguage(language)
    const conversation = locale.getFixedT(null, 'conversation')
    const componentsTranslation = locale.getFixedT(null, 'components')
    for (const code of [
      'codex_provider_failed',
      'service_unavailable',
      'overloaded',
      'rate_limit_exceeded',
    ]) {
      for (const attempts of [undefined, 3]) {
        for (const actionState of ['idle', 'submitting', 'outcome_unknown'] as const) {
          const item = {
            ...describeTurnFailure({ code, retryable: true, automatic_retry_attempts: attempts }),
            actionState,
            turnId: 'failed-turn',
          }
          for (const recoveryAvailable of [false, true]) {
            let button: { disabled: boolean; onClick: () => void } | undefined
            let continued: ConvItem | undefined
            const element = runInNewContext(script, {
              React,
              item,
              conversation,
              t: componentsTranslation,
              failureText: formatTurnFailure(item, conversation),
              recoverableFailure: isRecoverableTurnFailure(item),
              recoveryAvailable,
              continuing: actionState === 'submitting',
              continueUnknown: actionState === 'outcome_unknown',
              actionError: undefined,
              aiThinking: '',
              IconFont: () => null,
              Spinner: () => null,
              Button: (props: {
                children: React.ReactNode
                disabled: boolean
                onClick: () => void
              }) => {
                button = props
                return React.createElement('button', { disabled: props.disabled }, props.children)
              },
              onContinue: (failure: ConvItem) => {
                continued = failure
              },
            })
            const html = renderToStaticMarkup(element)
            assert.ok(html.includes('data-testid="turn-recoverable-notice"'))
            assert.equal(html.includes('turn-failure-card'), false)
            const message =
              item.failure?.kind === 'unknown'
                ? conversation('failure.interrupted.message')
                : formatTurnFailure(item, conversation).message
            assert.ok(html.includes(message), `${language}: ${code}: ${attempts}: ${actionState}`)
            assert.equal(Boolean(button), recoveryAvailable)
            if (button) {
              assert.equal(button.disabled, actionState !== 'idle')
              assert.ok(
                html.includes(
                  componentsTranslation(
                    actionState === 'outcome_unknown'
                      ? 'stream.continuePending'
                      : 'stream.continueInterrupted'
                  )
                )
              )
              if (!button.disabled) {
                button.onClick()
                assert.equal(continued, item)
              }
            }
          }
        }
      }
    }
    for (const code of [
      'invalid_api_key',
      'insufficient_quota',
      'credit_balance_exhausted',
      'bad_request',
      'unsupported_model',
      'content_policy_violation',
    ]) {
      const item = describeTurnFailure({ code, retryable: true })
      assert.equal(
        runInNewContext(script, { recoverableFailure: isRecoverableTurnFailure(item) }),
        null
      )
    }
  }
})

test('assistant copy action appears only after the turn stops running', () => {
  const stream = readFileSync(new URL('./components/business/Stream.tsx', import.meta.url), 'utf8')
  assert.match(stream, /copyEnabled=\{turnOutcome !== 'running'\}/)
  assert.match(stream, /\{item\.text && copyEnabled && \(/)
})

test('queued send failures use product copy instead of raw service errors', () => {
  const composer = readFileSync(
    new URL('./components/business/Composer.tsx', import.meta.url),
    'utf8'
  )
  const pendingFailure = composer.indexOf("feedback('components', 'composer.pendingFailed'")
  assert.notEqual(pendingFailure, -1)
  assert.match(composer.slice(pendingFailure, pendingFailure + 500), /queuedMessageErrorText/)
  assert.doesNotMatch(
    composer.slice(pendingFailure, pendingFailure + 500),
    /String\(result\?\.error\)/
  )
})

test('unsupported model rejection maps to a model_config card without retry', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    resources: { zh: { conversation: zh }, en: { conversation: en } },
  })
  const display = (item: ReturnType<typeof describeTurnFailure>) =>
    formatTurnFailure(item, locale.getFixedT(null, 'conversation'))
  // 工单 87102385：上游 InvalidParameter（"Unsupported model"）经 bridge 恢复后到达产品面。
  const modelConfig = describeTurnFailure({
    code: 'InvalidParameter',
    message: "Unsupported model: 'minimax-m2.1'",
    retryable: true,
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
    total: 5,
  })
  assert.deepEqual(parseSessionCatalogResult({ sessions: [] }), {
    sessions: [],
    total: 0,
  })
  assert.deepEqual(parseSessionCatalogResult({ sessions: [], next_cursor: 'next' }), {
    sessions: [],
    total: 0,
    next_cursor: 'next',
  })
  assert.equal(parseSessionCatalogResult({ sessions: [], next_cursor: 42 }), null)
})

test('catalog cursors accept continuation and explicit exhaustion without offset state', () => {
  for (const cursor of [-1, 0, 30, 1.5, {}, []]) {
    assert.equal(parseSessionCatalogResult({ sessions: [], next_cursor: cursor }), null)
  }
  assert.deepEqual(parseSessionCatalogResult({ sessions: [], next_cursor: null }), {
    sessions: [],
    total: 0,
    next_cursor: null,
  })
  assert.deepEqual(parseSessionCatalogResult({ sessions: [], next_cursor: 'next-page' }), {
    sessions: [],
    total: 0,
    next_cursor: 'next-page',
  })
  assert.deepEqual(parseSessionCatalogResult({ sessions: [] }), { sessions: [], total: 0 })
})

test('session catalog HTTP failures distinguish retryable service outages', () => {
  assert.deepEqual(sessionCatalogHttpFailure(503), {
    kind: 'http',
    retryable: true,
    status: 503,
  })
  assert.deepEqual(sessionCatalogHttpFailure(401), {
    kind: 'http',
    retryable: false,
    status: 401,
  })
})

function thread(): Thread {
  return {
    id: 'thread-1',
    title: '长会话',
    conversation: [],
    sessionId: 'session-1',
    lastSeq: 0,
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
    safe_error: 'agent_runtime_exit',
    process_generation: 2,
    attempt: state === 'recovered' ? 2 : 1,
    max_attempts: 5,
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
            body: '安全展示内容',
          },
        }),
  }
}

test('one runtime incident updates one transcript item through recovery', () => {
  const initial = thread()
  const retrying = { ...initial, ...reportRuntimeIncident(initial, incident('retrying'), 'turn-1') }
  const recovered = {
    ...retrying,
    ...reportRuntimeIncident(retrying, incident('recovered'), 'turn-1'),
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

  const recovered = projectRuntimeIncidentReadiness(detected, {
    ...incident('recovered'),
    scope: 'process',
    process_generation: 2,
  })
  assert.equal(recovered?.ready, true)
  assert.equal(recovered?.process_state, 'ready')
  assert.equal(recovered?.process_generation, 2)
  assert.equal(recovered?.code, undefined)
  assert.equal(blocksRuntimePreflight(recovered), false)

  const failed = projectRuntimeIncidentReadiness(detected, {
    ...incident('failed'),
    scope: 'process',
  })
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
    readiness: { ready: false, process_state: 'recovering' },
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
      b: { ...thread(), id: 'b', readiness: { ready: true, process_state: 'ready' } },
    },
  }
  const next = applyRuntimeIncident(state, 'a', {
    data: { ...incident('detected'), scope: 'process' },
    turn_id: 'turn-1',
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
    threads: { a: { ...thread(), id: 'a', readiness: { ready: true, process_state: 'ready' } } },
  }
  const next = applyRuntimeIncident(state, 'a', {
    data: { ...incident('detected'), scope: 'turn' },
    turn_id: 'turn-1',
  })

  assert.deepEqual(next.threads.a.readiness, { ready: true, process_state: 'ready' })
  assert.equal(next.threads.a.conversation.length, 1)
  assert.equal(
    applyRuntimeIncident(state, null, {
      data: { ...incident('detected'), scope: 'process' },
    }),
    state
  )
  assert.equal(
    applyRuntimeIncident(state, 'missing', {
      data: { ...incident('detected'), scope: 'process' },
    }),
    state
  )
})

test('unassociated process incidents retain public event order without borrowing a turn', () => {
  const state = { threads: { a: { ...thread(), id: 'a' } } }
  const next = applyRuntimeIncident(state, 'a', {
    seq: 35,
    data: { ...incident('recovered'), scope: 'process' },
  })
  const notice = next.threads.a.conversation.at(-1)
  assert.equal(notice?.kind, 'status')
  assert.equal(notice?.eventSeq, 35)
  assert.equal(notice?.turnId, undefined)
})

test('SSE transport recovery is separate from Codex runtime incidents', () => {
  const initial = thread()
  const retrying = { ...initial, ...reportTransportState(initial, 'retrying') }
  const recovered = { ...retrying, ...reportTransportState(retrying, 'live') }

  assert.equal(recovered.transportState, 'live')
  assert.equal(retrying.conversation.length, 1)
  assert.deepEqual(
    retrying.conversation[0]?.kind === 'status' ? retrying.conversation[0].text : '',
    { key: 'runtime.transportRetrying' }
  )
  assert.equal(recovered.conversation.length, 0)
})

test('live transport removes stale recovery notices without removing other conversation items', () => {
  const initial = thread()
  const retrying = { ...initial, ...reportTransportState(initial, 'retrying') }
  const transportNotice = retrying.conversation[0]
  assert.ok(transportNotice?.kind === 'status')
  const unrelated: Thread['conversation'][number] = {
    kind: 'status',
    text: { key: 'runtime.recovered' },
    tone: 'experience',
  }
  const restored: Thread = {
    ...initial,
    conversation: [unrelated, { ...transportNotice, text: { key: 'runtime.transportRecovered' } }],
  }
  const recovered = reportTransportState(restored, 'live')
  assert.deepEqual(recovered.conversation, [unrelated])
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
        incidentId: 'incident-1',
      },
    ],
  }
  const processRecovered = {
    ...initial,
    ...reportRuntimeIncident(
      initial,
      { ...incident('recovered'), incident_id: 'process-incident' },
      'turn-1'
    ),
  }

  assert.equal(
    processRecovered.conversation.some((item) => item.kind === 'error'),
    true
  )

  const reconciled = {
    ...processRecovered,
    ...reportRuntimeIncident(processRecovered, incident('recovered'), 'turn-1'),
  }

  assert.equal(
    reconciled.conversation.some((item) => item.kind === 'error'),
    false
  )
  assert.equal(
    reconciled.conversation.some(
      (item) => item.kind === 'status' && item.incidentId === 'incident-1'
    ),
    true
  )
})

test('session resume classification uses HTTP and typed Service fields, never message regexes', () => {
  assert.equal(
    classifySessionResumeFailure({
      status: 404,
      error: '任意本地化提示',
      detail: '任意本地化提示',
      code: 'session_not_found',
    }).terminal,
    true
  )
  assert.equal(
    classifySessionResumeFailure({
      status: 503,
      error: 'harness_runtime_not_ready',
      detail: 'harness_runtime_not_ready',
      code: 'harness_runtime_not_ready',
      runtimeReadiness: { ready: false, code: 'unauthenticated', action: 'login' },
    }).terminal,
    true
  )
  assert.equal(
    classifySessionResumeFailure({
      status: 503,
      error: 'harness_runtime_not_ready',
      detail: 'harness_runtime_not_ready',
      code: 'harness_runtime_not_ready',
      runtimeReadiness: { ready: false, code: 'error', action: 'retry' },
    }).terminal,
    false
  )
  assert.equal(
    classifySessionResumeFailure({
      status: 500,
      error: 'harness_session_resume_failed',
      detail: '当前模型已下线',
      code: 'session_model_unavailable',
    }).terminal,
    true
  )
  assert.equal(
    classifySessionResumeFailure({
      status: 500,
      error: '会话不存在 forbidden invalid',
      detail: '会话不存在 forbidden invalid',
    }).terminal,
    false
  )
})

test('service errors preserve the specific failure code over the operation envelope', async () => {
  const failure = await serviceErrorDetail(
    new Response(
      JSON.stringify({
        error: 'harness_session_resume_failed',
        code: 'session_model_unavailable',
        detail: '当前模型已下线',
      }),
      {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }
    )
  )

  assert.equal(failure.code, 'session_model_unavailable')
  assert.equal(failure.message, '当前模型已下线')
})

test('session resume stops at five attempts and exposes a real reconnect action', () => {
  const retryable = classifySessionResumeFailure({
    status: 500,
    error: 'harness_session_resume_failed',
    detail: 'harness_session_resume_failed',
    code: 'harness_session_resume_failed',
  })

  assert.equal(shouldRetrySessionResume(retryable, 4, 5), true)
  assert.equal(shouldRetrySessionResume(retryable, 5, 5), false)
  assert.equal(shouldRetrySessionResume({ ...retryable, terminal: true }, 1, 5), false)
  assert.deepEqual(sessionResumeStatusItem('session-1', '恢复已停止', 'tension', true), {
    kind: 'status',
    text: '恢复已停止',
    tone: 'tension',
    incidentId: 'session-resume:session-1',
    runtimeAction: 'retry_session_resume',
    actionSessionId: 'session-1',
  })
})

test('session recovery blocking takes precedence over running and waiting', () => {
  for (const state of ['running', 'waiting'] as const) {
    const blocked = projectSessionState({
      state,
      runtime_id: 'codex',
      recovery_blocked: true,
      recovery_pending: true,
    })
    assert.equal(blocked.running, false)
    assert.equal(blocked.status, 'failed')
    assert.equal(blocked.recoveryBlocked, true)
    assert.equal(blocked.recoveryPending, true)
  }
})

test('a late typed running state restores the UI running projection', () => {
  const stopped: Thread = { ...thread(), running: false, status: 'done' }
  const running = {
    ...stopped,
    ...projectSessionState({ state: 'running', runtime_id: 'codex', reason: 'late turn/start' }),
  }

  assert.equal(running.runtimeId, 'codex')
  assert.equal(running.running, true)
  assert.equal(running.status, 'running')
})

test('native binding changes independently of the starting running flag', () => {
  const starting = projectSessionState({ state: 'starting', runtime_id: 'codex' })
  const bound = projectSessionState({
    state: 'running',
    runtime_id: 'codex',
    active_turn_id: 'native-turn',
  })
  assert.equal(starting.running, true)
  assert.equal(bound.running, true)
  assert.equal(starting.activeTurnId, null)
  assert.equal(bound.activeTurnId, 'native-turn')
  assert.equal(projectSessionState({ state: 'idle', runtime_id: 'codex' }).activeTurnId, null)
})

test('permission confirmation follows backend scope rather than hardcoded mode pairs', () => {
  const mode = {
    mode: 'ask',
    modes: ['ask', 'safe_auto', 'bypassPermissions'],
    current_turn_modes: ['safe_auto'],
  }
  assert.equal(permissionModeNeedsConfirmation(mode, 'safe_auto', true), false)
  assert.equal(permissionModeNeedsConfirmation(mode, 'bypassPermissions', true), true)
  assert.equal(permissionModeNeedsConfirmation(mode, 'bypassPermissions', false), false)
  assert.equal(permissionModeNeedsConfirmation(null, 'safe_auto', true), true)
})

test('only an explicit next-turn choice displays deferred mode text', () => {
  assert.equal(
    permissionModeShowsNextTurn({ mode: 'safe_auto', modes: [], active_mode: '', deferred: false }),
    false
  )
  assert.equal(
    permissionModeShowsNextTurn({
      mode: 'safe_auto',
      modes: [],
      active_mode: 'ask',
      deferred: true,
    }),
    false
  )
  assert.equal(
    permissionModeShowsNextTurn({
      mode: 'safe_auto',
      modes: [],
      active_mode: 'ask',
      deferred: true,
      next_turn_selected: true,
    }),
    true
  )
  assert.equal(
    permissionModeShowsNextTurn({
      mode: 'safe_auto',
      modes: [],
      active_mode: 'safe_auto',
      deferred: false,
      next_turn_selected: true,
    }),
    false
  )
})

test('native start activates a thread that previously had only a resource wait', () => {
  const waiting = {
    running: false,
    status: 'dormant' as const,
    queuedMessages: [{ queuedMessageId: 'waiting-1', state: 'waiting_resources' as const }],
  }
  const started = {
    ...waiting,
    ...projectSessionState({ state: 'running', runtime_id: 'codex' }),
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
          itemId: 'item-owned',
        },
        {
          kind: 'hil',
          requestId: 'request-other',
          hilKind: 'permission',
          hilState: 'pending',
          turnId: 'turn-1',
          itemId: 'item-other',
        },
      ],
    }
    const updated = {
      ...initial,
      ...reportRuntimeIncident(
        initial,
        {
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
          ambiguous_commit: true,
        },
        'turn-1',
        'item-owned'
      ),
    }
    const owned = updated.conversation.find(
      (item) => item.kind === 'hil' && item.itemId === 'item-owned'
    )
    const other = updated.conversation.find(
      (item) => item.kind === 'hil' && item.itemId === 'item-other'
    )

    assert.equal(owned?.kind === 'hil' ? owned.hilState : '', 'unknown')
    assert.match(owned?.kind === 'hil' ? (owned.submissionError ?? '') : '', /检查当前会话与产物/)
    assert.equal(other?.kind === 'hil' ? other.hilState : '', 'pending')
  }
})

test('typed operation state correlates unknown outcome by HIL request id', () => {
  const initial: Thread = {
    ...thread(),
    conversation: [
      {
        kind: 'hil',
        requestId: 'request-typed',
        hilKind: 'permission',
        hilState: 'submitting',
        turnId: 'turn-typed',
        itemId: 'item-typed',
      },
    ],
  }
  const updated = {
    ...initial,
    ...reportOperationState(
      initial,
      {
        kind: 'tool_response',
        correlation_id: 'request-typed',
        state: 'unknown',
        retryable: false,
        execution_count: 1,
      },
      'turn-typed',
      'item-typed'
    ),
  }

  const card = updated.conversation[0]
  assert.equal(card?.kind === 'hil' ? card.hilState : '', 'unknown')
  assert.match(card?.kind === 'hil' ? (card.submissionError ?? '') : '', /不会重新提交/)
  assert.equal(card?.kind === 'hil' ? card.submissionErrorMessage : undefined, 'outcomeUnknown')
  const stale = reportOperationState(
    updated,
    {
      kind: 'tool_response',
      correlation_id: 'request-typed',
      state: 'stale',
      retryable: false,
      execution_count: 1,
    },
    'turn-typed',
    'item-typed'
  ).conversation?.[0]
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
    conversation: [
      {
        kind: 'error',
        title: '上次任务已中断',
        message: 'unknown',
        action: '继续对话',
        runtimeAction: 'confirm_turn_unknown',
        actionSessionId: 'session-1',
        actionTurnId: 'turn-unknown',
        actionState: 'submitting',
        turnId: 'turn-unknown',
      },
    ],
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
    response: 'must-not-cross-the-snapshot-edge',
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
    last_turn_status: 'unknown_outcome',
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

for (const kind of ['user_input', 'permission', 'command_approval']) {
  test(`session open restores a waiting turn with pending ${kind}`, () => {
    const pendingHil = [
      {
        request_id: 'request-hil',
        kind,
        turn_id: 'turn-waiting',
        item_id: 'item-hil',
        questions:
          kind === 'user_input'
            ? [
                {
                  id: 'scope',
                  header: 'Scope',
                  question: 'Select the scope',
                  options: [{ label: 'Narrow' }, { label: 'Broad' }],
                },
              ]
            : undefined,
        options: kind !== 'user_input' ? [{ id: 'accept', label: 'Allow once' }] : undefined,
      },
    ]
    const snapshot = {
      session_id: 'session-1',
      running: true,
      uncertain_operations: [],
      unknown_outcome: false,
      active_turn_id: 'turn-waiting',
      last_turn_id: 'turn-waiting',
      last_turn_status: 'waiting',
      pending_hil: pendingHil,
    }
    const parsed = parseOpenSessionResponse(snapshot)
    assert.ok(!('error' in parsed))
    assert.equal(parsed.last_turn_status, 'waiting')
    assert.equal(recoveredTurnOutcome(parsed.last_turn_status), 'running')
    assert.equal(parsed.running, true)
    assert.equal(parsed.active_turn_id, 'turn-waiting')
    assert.deepEqual(parsed.pending_hil, pendingHil)
    const recovered = {
      ...thread(),
      ...projectSessionRecovery(thread(), {
        sessionId: parsed.session_id,
        running: parsed.running,
        activeTurnId: parsed.active_turn_id,
        unknownOutcome: parsed.unknown_outcome,
        pendingHil: parsed.pending_hil ?? [],
        uncertainOperations: parsed.uncertain_operations,
        timestamp: 1_700_000_000_000,
      }),
    }
    assert.equal(recovered.running, true)
    assert.equal(recovered.status, 'waiting')
    assert.equal(recovered.turnOutcomes?.['turn-waiting'], 'running')
    assert.equal(recovered.conversation.filter((item) => item.kind === 'hil').length, 1)
    const restoredHil = recovered.conversation.find((item) => item.kind === 'hil')
    assert.ok(restoredHil?.kind === 'hil')
    assert.equal(restoredHil.requestId, 'request-hil')
    assert.equal(restoredHil.hilState, 'pending')
    assert.equal(restoredHil.turnId, 'turn-waiting')
    assert.equal(restoredHil.itemId, 'item-hil')
  })
}

for (const status of [
  'running',
  'completed',
  'failed',
  'interrupted',
  'unknown_outcome',
  'unknown_confirmed',
]) {
  test(`session open preserves the existing turn status ${status}`, () => {
    const parsed = parseOpenSessionResponse({
      session_id: 'session-1',
      running: status === 'running',
      uncertain_operations: [],
      unknown_outcome: false,
      active_turn_id: status === 'running' ? 'turn-1' : null,
      last_turn_id: 'turn-1',
      last_turn_status: status,
    })
    assert.ok(!('error' in parsed))
    assert.equal(parsed.last_turn_status, status)
    assert.ok(parsed.last_turn_status)
    assert.equal(
      recoveredTurnOutcome(parsed.last_turn_status),
      status === 'unknown_outcome'
        ? 'unknown'
        : status === 'unknown_confirmed'
          ? 'completed'
          : status
    )
  })
}

test('session open fails closed on inconsistent or retryable recovery operations', () => {
  const turn = uncertain('turn', 'unknown', 'turn-unknown')
  for (const operation of [
    { ...turn, operation_state: 'stale' },
    { ...turn, retryable: true },
    {
      ...uncertain('hil_response', 'unknown', 'request-hil'),
      hil: { request_id: 'wrong-request', kind: 'permission' },
    },
  ]) {
    const parsed = parseOpenSessionResponse({
      session_id: 'session-1',
      running: false,
      uncertain_operations: [operation],
      unknown_outcome: operation.kind === 'turn',
      active_turn_id: null,
    })
    assert.equal('error' in parsed ? parsed.code : '', 'invalid_session_recovery_snapshot')
  }
  const hiddenUnknown = parseOpenSessionResponse({
    session_id: 'session-1',
    running: false,
    uncertain_operations: [turn],
    unknown_outcome: false,
    active_turn_id: null,
  })
  assert.equal(
    'error' in hiddenUnknown ? hiddenUnknown.code : '',
    'invalid_session_recovery_snapshot'
  )

  for (const invalidTerminal of [
    { last_turn_id: 'turn-1', last_turn_status: 'invented' },
    { last_turn_id: 'turn-1', last_turn_status: null },
    { last_turn_id: null, last_turn_status: 'failed' },
    { last_turn_id: null, last_turn_status: 'waiting' },
    {
      running: false,
      active_turn_id: 'turn-1',
      last_turn_id: 'turn-1',
      last_turn_status: 'waiting',
    },
  ]) {
    const parsed = parseOpenSessionResponse({
      session_id: 'session-1',
      running: false,
      uncertain_operations: [],
      unknown_outcome: false,
      active_turn_id: null,
      ...invalidTerminal,
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
    pendingHil: [
      {
        request_id: 'request-tool',
        kind: 'permission',
        turn_id: 'turn-hil',
        item_id: 'item-request-tool',
      },
    ],
    uncertainOperations: [
      uncertain('tool_response', 'unknown', 'request-tool'),
      uncertain('turn', 'unknown', 'turn-unknown', 'agent_runtime_exit'),
    ],
    timestamp: 1_700_000_000_000,
  }
  const once = { ...initial, ...projectSessionRecovery(initial, snapshot) }
  const twice = { ...once, ...projectSessionRecovery(once, snapshot) }
  const unknownTurns = twice.conversation.filter(
    (item) => item.kind === 'error' && item.runtimeAction === 'confirm_turn_unknown'
  )
  const unknownHil = twice.conversation.filter(
    (item) => item.kind === 'hil' && item.hilState === 'unknown'
  )

  assert.deepEqual(twice, once)
  assert.equal(once.running, false)
  assert.equal(once.status, 'abandon')
  assert.equal(unknownTurns.length, 1)
  assert.equal(unknownHil.length, 1)
  assert.equal(unknownTurns[0]?.kind === 'error' ? unknownTurns[0].actionState : '', 'idle')
  assert.equal(
    unknownTurns[0]?.kind === 'error' ? unknownTurns[0].turnUnknown?.reason : '',
    'processExit'
  )
  assert.match(
    unknownHil[0]?.kind === 'hil' ? (unknownHil[0].submissionError ?? '') : '',
    /不会重新提交/
  )
  assert.equal(
    twice.conversation.some((item) => item.kind === 'user'),
    false
  )
})

test('Serve restart projects stale operation terminally and preserves exact card ownership', () => {
  const initial: Thread = {
    ...thread(),
    conversation: [
      {
        kind: 'hil',
        requestId: 'request-stale',
        hilKind: 'permission',
        hilState: 'pending',
        turnId: 'turn-hil',
        itemId: 'item-request-stale',
      },
    ],
  }
  const operation = uncertain('hil_response', 'stale', 'request-stale')
  const snapshot = {
    sessionId: 'session-1',
    running: false,
    activeTurnId: null,
    unknownOutcome: false,
    pendingHil: [],
    uncertainOperations: [operation],
    timestamp: 1_700_000_000_000,
  }
  const recovered = { ...initial, ...projectSessionRecovery(initial, snapshot) }
  const card = recovered.conversation[0]

  assert.equal(card?.kind === 'hil' ? card.hilState : '', 'stale')
  assert.equal(card?.kind === 'hil' ? card.resolved : '', '请求已过期')
  assert.deepEqual({ ...recovered, ...projectSessionRecovery(recovered, snapshot) }, recovered)
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
      timestamp: 1_700_000_000_000,
    }),
  }
  assert.equal(running.turnOutcomes?.['turn-running'], 'running')

  const once = {
    ...running,
    ...reportTurnUnknown(running, { sessionId: 'session-1', turnId: 'turn-running' }),
  }
  const twice = {
    ...once,
    ...reportTurnUnknown(once, { sessionId: 'session-1', turnId: 'turn-running' }),
  }
  assert.equal(twice.conversation.filter((item) => item.kind === 'error').length, 1)
  assert.equal(twice.turnOutcomes?.['turn-running'], 'unknown')
})

test('unknown turn clears running command and native review without altering another turn', () => {
  const active: Thread = {
    ...thread(),
    running: true,
    status: 'running',
    conversation: [
      { kind: 'tool', toolId: 'command', name: 'shell', status: 'running', turnId: 'turn-unknown' },
      {
        kind: 'native_activity',
        activityId: 'review',
        activityType: 'approval_review',
        category: 'mode',
        status: 'running',
        nativeStatus: 'running',
        details: {},
        turnId: 'turn-unknown',
      },
      { kind: 'tool', toolId: 'other', name: 'shell', status: 'running', turnId: 'other' },
    ],
  }
  const updated = {
    ...active,
    ...reportTurnUnknown(active, { sessionId: 'session-1', turnId: 'turn-unknown' }),
  }
  assert.equal(
    updated.conversation[0]?.kind === 'tool' ? updated.conversation[0].status : undefined,
    'cancelled'
  )
  assert.equal(
    updated.conversation[1]?.kind === 'native_activity'
      ? updated.conversation[1].status
      : undefined,
    'error'
  )
  assert.equal(
    updated.conversation.find((item) => item.kind === 'tool' && item.toolId === 'other'),
    active.conversation[2]
  )
})

test('the same runtime status redraws in either language without changing its diagnostic identity', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    defaultNS: 'conversation',
    resources: { zh: { conversation: zh }, en: { conversation: en } },
  })
  const original = thread()
  const update = reportRuntimeIncident(original, incident('retrying'), 'turn-localization')
  const status = update.conversation?.find((item) => item.kind === 'status')
  assert.ok(status?.kind === 'status' && typeof status.text !== 'string')
  const before = JSON.stringify(status)
  assert.match(formatRuntimeStatus(status.text, locale.getFixedT(null, 'conversation')), /正在恢复/)
  await locale.changeLanguage('en')
  assert.match(
    formatRuntimeStatus(status.text, locale.getFixedT(null, 'conversation')),
    /Recovering/
  )
  assert.equal(JSON.stringify(status), before)
  for (const reason of ['Vendor 原始 diagnostic', '__proto__', 'toString']) {
    assert.equal(
      formatRuntimeStatus(
        { key: 'runtime.failed', reason },
        locale.getFixedT(null, 'conversation')
      ),
      en.runtime.failed
    )
  }
  assert.equal(
    formatRuntimeStatus(
      { key: 'runtime.recovered', reason: 'codex_provider_recovered' },
      locale.getFixedT(null, 'conversation')
    ),
    en.runtime.recovered
  )
})

test('repeated tool loop incident explains the stop in both languages', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    defaultNS: 'conversation',
    resources: { zh: { conversation: zh }, en: { conversation: en } },
  })
  const update = reportRuntimeIncident(
    thread(),
    {
      ...incident('detected'),
      scope: 'turn',
      kind: 'repeated_tool_loop',
      safe_error: 'codex_repeated_tool_loop',
    },
    'turn-loop'
  )
  const status = update.conversation?.find((item) => item.kind === 'status')
  assert.ok(status?.kind === 'status' && typeof status.text !== 'string')
  assert.match(
    formatRuntimeStatus(status.text, locale.getFixedT(null, 'conversation')),
    /重复|连续/
  )
  await locale.changeLanguage('en')
  assert.match(formatRuntimeStatus(status.text, locale.getFixedT(null, 'conversation')), /repeated/)
})

test('sandbox recovery incidents explain their exact cause without suggesting message replay', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    defaultNS: 'conversation',
    resources: { zh: { conversation: zh }, en: { conversation: en } },
  })
  const cases = [
    ['windows_sandbox_setup_failed', /初始化未完成/, /initialization did not complete/],
    ['windows_sandbox_setup_cancelled', /授权已取消/, /authorization was cancelled/],
    ['windows_sandbox_setup_unknown', /结果尚未确认/, /outcome is unconfirmed/],
    ['windows_sandbox_setup_in_progress', /仍在初始化/, /still being initialized/],
    ['windows_sandbox_policy_rejected', /安全策略/, /security policy/],
    ['windows_sandbox_tool_access_failed', /内置工具/, /built-in tools/],
  ] as const
  for (const [reason, chinese, english] of cases) {
    const observation = { ...incident('failed'), safe_error: reason }
    const update = reportRuntimeIncident(thread(), observation, 'sandbox-turn', undefined, 42)
    const status = update.conversation?.find((item) => item.kind === 'status')
    assert.ok(status?.kind === 'status' && typeof status.text !== 'string')
    const identity = JSON.stringify(status)
    await locale.changeLanguage('zh')
    const chineseText = formatRuntimeStatus(status.text, locale.getFixedT(null, 'conversation'))
    assert.match(chineseText, chinese)
    assert.doesNotMatch(chineseText, /请重新发送|请重发|UAC 已批准/)
    await locale.changeLanguage('en')
    const englishText = formatRuntimeStatus(status.text, locale.getFixedT(null, 'conversation'))
    assert.match(englishText, english)
    assert.doesNotMatch(englishText, /send again|please resend|UAC was approved/i)
    assert.equal(JSON.stringify(status), identity)
    assert.equal(observation.safe_error, reason)
    assert.equal(status.eventSeq, 42)
  }
  for (const reason of [
    'windows_sandbox_setup_failed private-token',
    'windows_sandbox_unknown_key',
  ]) {
    assert.equal(
      formatRuntimeStatus(
        { key: 'runtime.failed', reason },
        locale.getFixedT(null, 'conversation')
      ),
      en.runtime.failed
    )
  }
  assert.equal(
    formatRuntimeStatus(
      { key: 'runtime.recovered', reason: 'windows_sandbox_setup_cancelled' },
      locale.getFixedT(null, 'conversation')
    ),
    en.runtime.recovered
  )
})

test('provider retries are not presented as agent connection recovery', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    defaultNS: 'conversation',
    resources: { zh: { conversation: zh }, en: { conversation: en } },
  })
  const providerRetry = {
    ...incident('retrying'),
    scope: 'provider' as const,
    kind: 'provider_retry' as const,
    strategy: 'vendor_retry' as const,
    safe_error: 'The model provider rejected the request.',
    max_attempts: 0,
  }
  const update = reportRuntimeIncident(thread(), providerRetry, 'turn-provider')
  const status = update.conversation?.find((item) => item.kind === 'status')
  assert.ok(status?.kind === 'status' && typeof status.text !== 'string')
  assert.match(
    formatRuntimeStatus(status.text, locale.getFixedT(null, 'conversation')),
    /^模型服务正在重试/
  )
  assert.doesNotMatch(
    formatRuntimeStatus(status.text, locale.getFixedT(null, 'conversation')),
    /连接中断/
  )
})

test('resume status retains retry action ownership and renders parameters after language changes', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'en',
    fallbackLng: false,
    defaultNS: 'conversation',
    resources: { zh: { conversation: zh }, en: { conversation: en } },
  })
  const message: RuntimeStatusMessage = {
    key: 'resume.retrying',
    attempt: 2,
    maximum: 4,
    reason: 'Vendor diagnostic',
  }
  const notice = sessionResumeStatusItem('session-resume-i18n', message, 'tension', true)
  assert.equal(notice.runtimeAction, 'retry_session_resume')
  assert.equal(notice.actionSessionId, 'session-resume-i18n')
  assert.equal(notice.text, message)
  assert.equal(
    formatRuntimeStatus(message, locale.getFixedT(null, 'conversation')),
    'The session cannot be resumed yet. Retrying (2/4)'
  )
  await locale.changeLanguage('zh')
  assert.equal(
    formatRuntimeStatus(message, locale.getFixedT(null, 'conversation')),
    '会话暂时无法恢复，正在重试（2/4）'
  )
  assert.equal(notice.text, message)
})

test('resume request reasons translate on redraw without changing vendor diagnostics', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    resources: { zh: { conversation: zh }, en: { conversation: en } },
  })
  const message = {
    key: 'resume.stopped' as const,
    reason: { key: 'request.invalidRecovery' as const },
  }
  assert.match(formatRuntimeStatus(message, locale.getFixedT(null, 'conversation')), /不会自动重放/)
  await locale.changeLanguage('en')
  assert.match(
    formatRuntimeStatus(message, locale.getFixedT(null, 'conversation')),
    /will not automatically replay/
  )
  assert.match(
    formatRuntimeStatus(
      { key: 'resume.stopped', reason: { key: 'request.timeout' } },
      locale.getFixedT(null, 'conversation')
    ),
    /timed out/
  )
})

test('application status descriptors can be redrawn in either language', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    resources: { zh: { conversation: zh }, en: { conversation: en } },
    defaultNS: 'conversation',
  })
  const t = locale.getFixedT(null, 'conversation')
  const compacted = { key: 'context.compacted' } as const
  const missing = { key: 'artifactFailure.missing' } as const
  assert.equal(formatRuntimeStatus(compacted, t), '上下文已压缩，正在继续执行')
  assert.equal(formatRuntimeStatus(missing, t), '文件不存在，未能展示产物。')
  await locale.changeLanguage('en')
  assert.equal(formatRuntimeStatus(compacted, t), 'Context compacted. Continuing execution.')
  assert.equal(
    formatRuntimeStatus(missing, t),
    'The file does not exist, so the artifact could not be displayed.'
  )
  assert.deepEqual(compacted, { key: 'context.compacted' })
})

test('ambiguous turn application text switches language while raw diagnostics and confirmation semantics remain intact', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    interpolation: { escapeValue: false },
    resources: {
      zh: { conversation: zh, components: componentsZh },
      en: { conversation: en, components: componentsEn },
    },
  })
  const t = locale.getFixedT(null, 'conversation')
  for (const [message, reason] of [
    [undefined, 'unconfirmed'],
    ['runtime_rpc_timeout', 'timeout'],
    ['runtime_transport_lost', 'transportLost'],
    ['agent_runtime_exit', 'processExit'],
  ] as const) {
    const updated = {
      ...thread(),
      ...reportTurnUnknown(thread(), { sessionId: 'session-1', turnId: 'turn', message }),
    }
    const card = updated.conversation.find((item) => item.kind === 'error')
    assert.ok(card?.kind === 'error')
    assert.equal(card.runtimeAction, 'confirm_turn_unknown')
    assert.equal(card.actionState, 'idle')
    const canonical = { title: card.title, message: card.message, action: card.action }
    await locale.changeLanguage('en')
    assert.deepEqual(formatTurnUnknown(card, t), {
      title: en.turnUnknown.title,
      message: en.turnUnknown.reason[reason],
      action: en.turnUnknown.action,
    })
    assert.deepEqual({ title: card.title, message: card.message, action: card.action }, canonical)
    const reconciled = { ...updated, ...reportTurnReconciled(updated, 'turn') }
    assert.equal(
      reconciled.conversation.some((item) => item.kind === 'error'),
      false
    )
  }
  const diagnostic = 'vendor_outcome_unknown'
  const raw = reportTurnUnknown(thread(), {
    sessionId: 'session-1',
    turnId: 'raw',
    message: diagnostic,
  }).conversation?.find((item) => item.kind === 'error')
  assert.ok(raw?.kind === 'error')
  assert.equal(formatTurnUnknown(raw, t).message, en.turnUnknown.reason.unconfirmed)
  assert.equal(formatRuntimeStatus({ key: 'runtime.closed' }, t), en.runtime.closed)
  assert.equal(t('hil.invalidRequest'), en.hil.invalidRequest)
})
test('failed session recovery never invents a terminal outcome after retries stop', () => {
  const running = { running: true, status: 'running' as const }
  const retry = projectResumeRunState(running)
  assert.deepEqual(retry, running)
  assert.notEqual(retry.running, false)
  assert.deepEqual(projectResumeRunState(retry), running)
  for (const status of ['waiting', 'failed', 'done'] as const) {
    const previous = { running: status === 'waiting', status }
    assert.deepEqual(projectResumeRunState(previous), previous)
  }
})

test('invalid recovery snapshots retry within budget without replaying the running turn', () => {
  const failure = classifySessionResumeFailure(parseOpenSessionResponse({}))
  const running = { running: true, status: 'waiting' as const }
  assert.equal(failure.terminal, false)
  for (const attempt of [1, 2, 3, 4]) {
    assert.equal(shouldRetrySessionResume(failure, attempt, 5), true)
  }
  assert.equal(shouldRetrySessionResume(failure, 5, 5), false)
  assert.deepEqual(projectResumeRunState(running), running)
  assert.equal(
    sessionResumeStatusItem('session-1', 'Reconnect', 'tension', true).runtimeAction,
    'retry_session_resume'
  )
})

test('continuation submits through direct presentation instead of the queue placeholder', () => {
  const source = readFileSync(new URL('./components/business/Stream.tsx', import.meta.url), 'utf8')
  const syntax = ts.createSourceFile(
    'Stream.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const submissions: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'optimisticQueuedMessage'
    )
      submissions.push(node)
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  assert.equal(submissions.length, 1)
  assert.equal(submissions[0].arguments[5]?.getText(syntax), "'direct'")
})

test('history refresh preserves a pending direct user bubble and binds it only once', () => {
  const pending = { kind: 'user' as const, text: '继续', itemId: 'pending-client' }
  const previous = {
    kind: 'user' as const,
    role: 'user',
    text: '旧任务',
    turn_id: 'previous-turn',
    item_id: 'previous-client',
  }
  const refreshed = projectHistoryWithRuntime(
    [previous],
    [{ kind: 'user', text: '旧任务', turnId: 'previous-turn', itemId: 'previous-client' }, pending]
  )
  assert.deepEqual(refreshed.at(-1), pending)
  const bound = projectHistoryWithRuntime(
    [
      previous,
      {
        kind: 'user',
        role: 'user',
        text: '继续',
        turn_id: 'continued-turn',
        item_id: 'pending-client',
      },
    ],
    refreshed
  )
  assert.equal(bound.filter((item) => item.itemId === 'pending-client').length, 1)
  assert.equal(bound.at(-1)?.turnId, 'continued-turn')
})

test('live snapshot refresh keeps an in-flight direct submission while restart remains uncertain', (context) => {
  const values = new Map<string, string>()
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  context.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    },
  })
  const pending = optimisticQueuedMessage(
    [],
    'pending-direct',
    [{ type: 'text', text: '继续' }],
    [],
    undefined,
    'direct'
  )
  retainQueuedOutbox('snapshot-session', pending)
  const live = mergeQueuedOutbox('snapshot-session', [], true, [pending])
  assert.equal(live[0].state, 'submitting')
  assert.equal(shouldPresentQueuedMessage(live[0], []), false)
  const restarted = mergeQueuedOutbox('snapshot-session', [])
  assert.equal(restarted[0].state, 'outcome_unknown')
  assert.equal(shouldPresentQueuedMessage(restarted[0], []), true)
  const authoritative = {
    ...pending,
    state: 'queued' as const,
    submissionMode: 'queued' as const,
    serverPresent: true,
  }
  assert.deepEqual(mergeQueuedOutbox('snapshot-session', [authoritative], true, [pending]), [
    authoritative,
  ])
  assert.equal(shouldPresentQueuedMessage(authoritative, []), true)
  releaseQueuedOutbox('snapshot-session', 'pending-direct')
})
