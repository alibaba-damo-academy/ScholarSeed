import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createInstance } from 'i18next'

import { buildSessionOpenRequest, setSessionModel } from './api.ts'
import type { ModelInfo } from './api'
import {
  confirmedReasoningSelection,
  declaredEffortValues,
  reasoningLabel,
  reasoningPreference,
  modelDefaultEffort,
} from './reasoning.ts'

test('first-turn request carries an explicit effort but leaves model default omitted', () => {
  assert.equal(
    buildSessionOpenRequest({ modelId: 'model', reasoningEffort: 'high' }).reasoning_effort,
    'high'
  )
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      buildSessionOpenRequest({ reasoningEffort: '' }),
      'reasoning_effort'
    ),
    false
  )
})

test('new conversation preferences are per model and constrained by its capabilities', () => {
  const model = { key: 'a', reasoning_efforts: ['low', 'high'] } as ModelInfo
  assert.equal(reasoningPreference(model, { a: 'high', b: 'low' }), 'high')
  assert.equal(reasoningPreference({ ...model, key: 'b' }, { a: 'high', b: 'low' }), 'low')
  // 「模型默认」伪档位已去除：失效偏好回落到模型定义的确定默认档（未声明 default 时取最低档）。
  assert.equal(reasoningPreference(model, { a: 'xhigh' }), 'low')
  assert.equal(reasoningPreference({ ...model, reasoning_efforts: [] }, { a: 'high' }), '')
})

test('options-only effort declarations share menu, preference and default resolution', () => {
  const model = {
    key: 'options-only',
    label: 'Options only',
    reasoning_efforts: [],
    reasoning_options: [
      { kind: 'toggle', values: ['enabled', 'disabled'] },
      { kind: 'budget', values: ['1024', '2048'] },
      { kind: 'effort', values: ['low', 'high'], default: 'low' },
    ],
  } as ModelInfo
  assert.deepEqual(declaredEffortValues(model), ['low', 'high'])
  assert.equal(reasoningPreference(model, { [model.key]: 'high' }), 'high')
  assert.equal(reasoningPreference(model, { [model.key]: 'enabled' }), 'low')
  assert.deepEqual(declaredEffortValues(undefined), [])
  assert.deepEqual(
    declaredEffortValues({ ...model, reasoning_options: model.reasoning_options?.slice(0, 2) }),
    []
  )
})

test('target model preferences never inherit another model or connection effort', () => {
  const first = {
    key: 'personal-first:shared-model',
    reasoning_efforts: ['low', 'high'],
    reasoning_options: [{ kind: 'effort', values: ['low', 'high'], default: 'low' }],
  } as ModelInfo
  const second = { ...first, key: 'personal-second:shared-model' }
  const preferences = { [first.key]: 'high', [second.key]: 'low' }
  assert.equal(reasoningPreference(first, preferences), 'high')
  assert.equal(reasoningPreference(second, preferences), 'low')
  assert.equal(reasoningPreference(second, { [first.key]: 'high' }), 'low')
  assert.equal(reasoningPreference(second, { ...preferences, [second.key]: 'unavailable' }), 'low')
})

test('confirmed selected reasoning is independent of native application success', () => {
  const authority = {
    ok: false,
    error: 'native_application_failed',
    session_id: 'session',
    model_id: 'selected',
    reasoning_effort: 'high',
    active_model_id: 'previous',
    active_reasoning_effort: 'low',
    runtime: { name: 'codex' as const, model_id: 'selected', reasoning_effort: 'high' },
  }
  assert.equal(confirmedReasoningSelection(authority, 'session', 'selected', 'high'), true)
  for (const snapshot of [
    null,
    undefined,
    { ...authority, session_id: 'another-session' },
    { ...authority, model_id: 'another-model' },
    { ...authority, reasoning_effort: 'low' },
    { ...authority, runtime: undefined },
    { ...authority, runtime: { ...authority.runtime, model_id: 'another-model' } },
    { ...authority, runtime: { ...authority.runtime, reasoning_effort: 'low' } },
    { ...authority, runtime: { ...authority.runtime, reasoning_effort: undefined } },
  ]) {
    assert.equal(confirmedReasoningSelection(snapshot, 'session', 'selected', 'high'), false)
  }
})

test('models without named effort accept empty or absent effort projections', () => {
  for (const reasoningEffort of ['', undefined]) {
    const authority = {
      session_id: 'session',
      model_id: 'fixed',
      reasoning_effort: reasoningEffort,
      runtime: { name: 'codex' as const, model_id: 'fixed', reasoning_effort: reasoningEffort },
    }
    assert.equal(confirmedReasoningSelection(authority, 'session', 'fixed', ''), true)
    assert.equal(confirmedReasoningSelection(authority, 'session', 'fixed', 'high'), false)
  }
})

test('the definite default is the declared default, else the lowest declared level', () => {
  const declared = {
    key: 'a',
    reasoning_efforts: ['low', 'medium', 'xhigh'],
    reasoning_options: [{ kind: 'effort', values: ['low', 'medium', 'xhigh'], default: 'medium' }],
  } as ModelInfo
  assert.equal(modelDefaultEffort(declared), 'medium')
  assert.equal(
    modelDefaultEffort({ key: 'a', reasoning_efforts: ['low', 'medium', 'xhigh'] } as ModelInfo),
    'low'
  )
  // 声明的 default 不在 values 里时防御性回落到最低档，而不是照发未声明的值。
  const inconsistent = {
    key: 'a',
    reasoning_efforts: ['high', 'max'],
    reasoning_options: [{ kind: 'effort', values: ['high', 'max'], default: 'medium' }],
  } as ModelInfo
  assert.equal(modelDefaultEffort(inconsistent), 'high')
  // 只声明 reasoning_options、没有 reasoning_efforts 投影时同样可解析。
  const optionsOnly = {
    key: 'a',
    reasoning_options: [{ kind: 'effort', values: ['none', 'low', 'high'] }],
  } as ModelInfo
  assert.equal(modelDefaultEffort(optionsOnly), 'none')
  assert.equal(modelDefaultEffort({ key: 'a' } as ModelInfo), '')
  assert.equal(modelDefaultEffort(undefined), '')
})

test('bundled Qwen defaults reach new sessions without overriding saved low', () => {
  const document = JSON.parse(
    readFileSync(
      new URL('../../../../serve/service/settings/capabilities.alibaba.json', import.meta.url),
      'utf8'
    )
  )
  for (const modelName of ['qwen3.8-flash', 'qwen3.8-max']) {
    const options = document.models[modelName].reasoning.options
    const model = {
      key: modelName,
      reasoning_efforts: options.find((option: { kind: string }) => option.kind === 'effort')
        .values,
      reasoning_options: options,
    } as ModelInfo
    assert.equal(modelDefaultEffort(model), 'medium')
    assert.equal(
      buildSessionOpenRequest({ reasoningEffort: reasoningPreference(model, {}) }).reasoning_effort,
      'medium'
    )
    assert.equal(
      buildSessionOpenRequest({
        reasoningEffort: reasoningPreference(model, { [modelName]: 'low' }),
      }).reasoning_effort,
      'low'
    )
  }
})

test('model failure reconciles saved intent without turning the failed operation into success', async (t) => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  globalThis.window = { scholarseed: { getApiBase: () => 'http://service.test' } } as Window &
    typeof globalThis
  t.after(() => {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  })
  const scenarios = [
    {
      name: 'native attachment rejected after save',
      status: 500,
      selected: 'new-model',
      effort: 'high',
      deferred: true,
    },
    {
      name: 'invalid selection rejected before save',
      status: 422,
      selected: 'old-model',
      effort: 'low',
      deferred: false,
    },
    {
      name: 'transport lost after save',
      status: null,
      selected: 'new-model',
      effort: 'high',
      deferred: true,
    },
  ]
  for (const scenario of scenarios) {
    const requests: string[] = []
    const authority = {
      session_id: 'session-1',
      model_id: scenario.selected,
      active_model_id: 'old-model',
      reasoning_effort: scenario.effort,
      active_reasoning_effort: 'low',
      deferred: scenario.deferred,
      runtime: { name: 'codex', model_id: scenario.selected, reasoning_effort: scenario.effort },
    }
    globalThis.fetch = async (url, options) => {
      requests.push(`${options?.method ?? 'GET'} ${String(url)}`)
      if (options?.method === 'POST') {
        if (scenario.status === null) throw new TypeError('connection lost')
        return Response.json(
          { error: 'model_change_failed', detail: scenario.name },
          { status: scenario.status }
        )
      }
      return Response.json(authority)
    }
    const result = await setSessionModel('session-1', 'new-model', 'high')
    assert.equal(result?.ok, false, scenario.name)
    assert.equal(result?.model_id, scenario.selected, scenario.name)
    assert.deepEqual(result?.runtime, authority.runtime, scenario.name)
    assert.equal(result?.active_model_id, 'old-model')
    assert.equal(result?.deferred, scenario.deferred)
    assert.equal(
      result?.error,
      scenario.status === null ? 'connection lost' : 'model_change_failed'
    )
    assert.deepEqual(requests, [
      'POST http://service.test/api/serve/sessions/session-1/model',
      'GET http://service.test/api/serve/sessions/session-1/model',
    ])
  }
})

test('only explicit model selection requests remember the default alongside the session model', async (context) => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const bodies: Record<string, unknown>[] = []
  globalThis.window = { scholarseed: { getApiBase: () => 'http://service.test' } } as Window &
    typeof globalThis
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return Response.json({
      ok: true,
      session_id: 'session',
      model_id: 'target',
      default_model_id: 'target',
    })
  }
  context.after(() => {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  })
  await setSessionModel('session', 'target', 'low')
  const result = await setSessionModel('session', 'target', 'high', true)
  assert.equal(Object.prototype.hasOwnProperty.call(bodies[0], 'remember_default'), false)
  assert.equal(bodies[1].remember_default, true)
  assert.equal(result?.default_model_id, 'target')
})

test('unavailable model readback never fabricates the requested selection', async (t) => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  globalThis.window = { scholarseed: { getApiBase: () => 'http://service.test' } } as Window &
    typeof globalThis
  globalThis.fetch = async () => Response.json({ error: 'unavailable' }, { status: 503 })
  t.after(() => {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  })
  const result = await setSessionModel('session-1', 'unconfirmed-target', 'high')
  assert.equal(result?.ok, false)
  assert.equal(result?.model_id, '')
  assert.equal(result?.runtime, undefined)
})

test('reasoning display localizes known values and preserves unknown provider values', async () => {
  const i18n = createInstance()
  const resources = Object.fromEntries(
    ['zh', 'en'].map((language) => [
      language,
      {
        conversation: JSON.parse(
          readFileSync(
            new URL(`../../localization/locales/${language}/conversation.json`, import.meta.url),
            'utf8'
          )
        ),
      },
    ])
  )
  await i18n.init({ lng: 'zh', resources, defaultNS: 'conversation' })
  const t = i18n.getFixedT(null, 'conversation')
  assert.equal(reasoningLabel('', t), '模型默认')
  assert.equal(reasoningLabel('high', t), '高 (high)')
  assert.equal(reasoningLabel('medium', t, true), '中')
  assert.equal(t('reasoning.fixed'), '思考 · 固定开启')
  await i18n.changeLanguage('en')
  assert.equal(reasoningLabel('', t), 'Model default')
  assert.equal(reasoningLabel('high', t), 'high')
  assert.equal(reasoningLabel('medium', t, true), 'Medium')
  assert.equal(t('reasoning.fixed'), 'Thinking · Always on')
  for (const value of ['provider-defined', 'constructor', '用户原文']) {
    assert.equal(reasoningLabel(value, t), value)
  }
})
