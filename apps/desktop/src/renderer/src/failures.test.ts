import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authenticationRecoveryAction,
  describeTurnFailure,
  isRecoverableTurnFailure,
} from './failures.ts'
import { feedback } from './contracts/feedback.ts'
import { canContinueFailedTurn } from './runtime.ts'
import { projectActivityEvents } from './transcript.ts'
import type { ConvItem, Thread } from './model.ts'

const authenticationEvent = {
  v: 2 as const,
  seq: 12,
  ts: 2,
  type: 'turn_failed' as const,
  session_id: 'session',
  turn_id: 'failed-turn',
  data: {
    code: 'model_bridge_credential_required',
    message: 'Authentication failed',
    retryable: false,
  },
}

for (const code of [
  'codex_provider_failed',
  'agent_runtime_failed',
  'service_unavailable',
  'overloaded',
  'rate_limit_exceeded',
]) {
  for (const attempts of [undefined, 1, 3]) {
    test(`recoverable ${code} uses the continuation notice with retry attempts ${attempts}`, () => {
      const failure = describeTurnFailure({
        code,
        retryable: true,
        automatic_retry_attempts: attempts,
      })
      assert.equal(isRecoverableTurnFailure(failure), true)
      assert.equal(failure.runtimeAction, 'continue_turn')
      if (code === 'codex_provider_failed' || code === 'agent_runtime_failed') {
        assert.equal(failure.failure?.kind, 'unknown')
      }
    })
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
  test(`${code} retains its actionable failure card instead of a recovery notice`, () => {
    assert.equal(
      isRecoverableTurnFailure(
        describeTurnFailure({ code, retryable: true, automatic_retry_attempts: 3 })
      ),
      false
    )
  })
}

test('ChatGPT subscription usage limits retain a dedicated terminal card despite a retry hint', () => {
  const failure = describeTurnFailure({
    code: 'subscription_sharing_usage_limit_exceeded',
    message: 'agent_runtime_failed',
    retryable: true,
    automatic_retry_attempts: 3,
  })
  assert.equal(failure.failure?.kind, 'subscription_limit')
  assert.equal(failure.message, '')
  assert.equal(failure.runtimeAction, undefined)
  assert.equal(isRecoverableTurnFailure(failure), false)
})

test('original provider runtime failure replays as a recoverable unknown failure with its turn identity', () => {
  const replayed = projectActivityEvents(
    [],
    [
      {
        ...authenticationEvent,
        data: { code: 'codex_provider_failed', message: 'agent_runtime_failed', retryable: true },
      },
    ]
  )
  assert.equal(replayed.length, 1)
  const failure = replayed[0]
  assert.equal(failure.kind, 'error')
  if (failure.kind !== 'error') throw new Error('Expected a provider failure')
  assert.equal(failure.failure?.kind, 'unknown')
  assert.equal(failure.failure?.automaticRetryAttempts, undefined)
  assert.equal(failure.turnId, authenticationEvent.turn_id)
  assert.equal(isRecoverableTurnFailure(failure), true)
})

test('nonretryable provider failures never become recoverable notices', () => {
  for (const code of [
    'codex_provider_failed',
    'agent_runtime_failed',
    'service_unavailable',
    'overloaded',
    'rate_limit_exceeded',
  ]) {
    assert.equal(
      isRecoverableTurnFailure(describeTurnFailure({ code, retryable: false })),
      false,
      code
    )
  }
})

test('recovery notice classification excludes unknown outcomes and application request failures', () => {
  const failure = describeTurnFailure({ code: 'codex_provider_failed', retryable: true })
  assert.equal(
    isRecoverableTurnFailure({ ...failure, runtimeAction: 'confirm_turn_unknown' }),
    false
  )
  assert.equal(
    isRecoverableTurnFailure({ ...failure, turnUnknown: { reason: 'unconfirmed' } }),
    false
  )
  assert.equal(
    isRecoverableTurnFailure({ ...failure, applicationFailure: { key: 'request.failed' } }),
    false
  )
  assert.equal(isRecoverableTurnFailure({ ...failure, failure: undefined }), false)
  assert.equal(isRecoverableTurnFailure({ ...failure, runtimeAction: undefined }), false)
})

test('recovery notice classification is independent of continuation button availability', () => {
  const failure = {
    ...describeTurnFailure({ code: 'codex_provider_failed', retryable: true }),
    turnId: 'failed-turn',
  }
  const current: Thread = {
    id: 'session',
    sessionId: 'session',
    title: 'Recovery',
    lastSeq: 1,
    running: true,
    status: 'failed',
    conversation: [failure],
  }
  assert.equal(isRecoverableTurnFailure(failure), true)
  assert.equal(canContinueFailedTurn(current, failure), false)
  for (const actionState of ['submitting', 'outcome_unknown'] as const) {
    const pending = { ...failure, actionState }
    assert.equal(isRecoverableTurnFailure(pending), true)
    assert.equal(canContinueFailedTurn({ ...current, running: false }, pending), false)
  }
})

test('terminal authentication failures retain an explicit continuation without automatic retry', () => {
  const failure = describeTurnFailure(authenticationEvent.data)
  assert.equal(failure.runtimeAction, 'continue_turn')
  assert.equal(failure.actionState, 'idle')
  assert.equal(failure.failure?.authentication, 'account')
  assert.equal(authenticationEvent.data.retryable, false)
  assert.equal(describeTurnFailure({ code: 'invalid_api_key' }).failure?.authentication, 'model')
})

test('authentication continuation opens login only for the affected account-backed model', () => {
  const failure = describeTurnFailure(authenticationEvent.data)
  const builtin = { source: 'builtin', disabled: false }
  assert.equal(authenticationRecoveryAction(failure, builtin, false), 'continue_turn')
  assert.equal(
    authenticationRecoveryAction(
      failure,
      { ...builtin, disabled: true, disabled_reason_code: 'gateway_credential_required' },
      false
    ),
    'login'
  )
  assert.equal(authenticationRecoveryAction(failure, builtin, true), 'continue_turn')
  assert.equal(
    authenticationRecoveryAction(failure, { source: 'personal', disabled: false }, false),
    'continue_turn'
  )
  assert.equal(authenticationRecoveryAction(failure, undefined, false), 'login')
  assert.equal(authenticationRecoveryAction(failure, undefined, true), 'configure')
  assert.equal(
    authenticationRecoveryAction(
      failure,
      { disabled: true, disabled_reason_code: 'gateway_credential_required' },
      true
    ),
    'login'
  )
})

test('model authentication recovery never treats account login as fixing a disabled personal connection', () => {
  const failure = describeTurnFailure({ code: 'invalid_api_key', retryable: false })
  const disconnected = {
    source: 'personal',
    disabled: true,
    disabled_reason_code: 'subscription_connection_required',
  }
  assert.equal(authenticationRecoveryAction(failure, disconnected, false), 'configure')
  assert.equal(authenticationRecoveryAction(failure, disconnected, true), 'configure')
  assert.equal(
    authenticationRecoveryAction(failure, { source: 'personal', disabled: false }, false),
    'continue_turn'
  )
  assert.equal(authenticationRecoveryAction(failure, undefined, false), 'configure')
})

test('history replay upgrades old authentication cards once without losing their turn identity', () => {
  const legacy: ConvItem[] = [
    {
      kind: 'error',
      title: '',
      message: '',
      action: '',
      turnId: 'failed-turn',
      failure: { kind: 'auth', fallback: 'raw' },
    },
  ]
  const replayed = projectActivityEvents(legacy, [authenticationEvent])
  assert.equal(replayed.length, 1)
  const failure = replayed[0]
  assert.equal(failure.kind, 'error')
  if (failure.kind !== 'error') throw new Error('Expected an authentication failure')
  assert.equal(failure.runtimeAction, 'continue_turn')
  assert.equal(failure.failure?.authentication, 'account')
  assert.equal(failure.turnId, 'failed-turn')
  assert.deepEqual(projectActivityEvents(replayed, [authenticationEvent]), replayed)
  const current: Thread = {
    id: 'session',
    title: 'Recovery',
    sessionId: 'session',
    lastSeq: authenticationEvent.seq,
    running: false,
    status: 'failed',
    conversation: replayed,
    turnOutcomes: { 'failed-turn': 'failed' },
  }
  assert.equal(canContinueFailedTurn(current, failure), true)
  assert.equal(canContinueFailedTurn({ ...current, running: true }, failure), false)
  assert.equal(canContinueFailedTurn({ ...current, terminated: true }, failure), false)
  assert.equal(canContinueFailedTurn({ ...current, recoveryPending: true }, failure), false)
  assert.equal(canContinueFailedTurn(current, { ...failure, actionState: 'submitting' }), false)
  assert.equal(
    canContinueFailedTurn(current, { ...failure, actionState: 'outcome_unknown' }),
    false
  )
  assert.equal(
    canContinueFailedTurn(
      {
        ...current,
        conversation: [...replayed, { kind: 'user', text: 'next', turnId: 'next-turn' }],
      },
      failure
    ),
    false
  )
})

test('authentication history replay preserves pending continuation and its error details', () => {
  const pending: ConvItem = {
    ...describeTurnFailure(authenticationEvent.data),
    turnId: authenticationEvent.turn_id,
    actionState: 'outcome_unknown',
    actionError: feedback('conversation', 'retry.continueUnconfirmed'),
  }
  assert.deepEqual(projectActivityEvents([pending], [authenticationEvent]), [pending])
})

test('authentication history replay upgrades untranslated legacy error cards', () => {
  const legacy: ConvItem = {
    kind: 'error',
    title: '回答生成失败',
    message: '模型服务认证失败。',
    action: '',
    turnId: authenticationEvent.turn_id,
  }
  const replayed = projectActivityEvents([legacy], [authenticationEvent])
  assert.equal(replayed.length, 1)
  assert.deepEqual(replayed[0], { ...legacy, ...describeTurnFailure(authenticationEvent.data) })
})
