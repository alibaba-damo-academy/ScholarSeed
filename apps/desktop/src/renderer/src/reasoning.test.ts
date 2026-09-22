import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createInstance } from 'i18next'

import { buildSessionOpenRequest, setSessionModel } from './api.ts'
import type { ModelInfo } from './api'
import { reasoningLabel, reasoningPreference, modelDefaultEffort } from './reasoning.ts'

test('first-turn request carries an explicit effort but leaves model default omitted', () => {
  assert.equal(buildSessionOpenRequest({ modelId: 'model', reasoningEffort: 'high' }).reasoning_effort, 'high')
  assert.equal(Object.prototype.hasOwnProperty.call(buildSessionOpenRequest({ reasoningEffort: '' }), 'reasoning_effort'), false)
})

test('new conversation preferences are per model and constrained by its capabilities', () => {
  const model = { key: 'a', reasoning_efforts: ['low', 'high'] } as ModelInfo
  assert.equal(reasoningPreference(model, { a: 'high', b: 'low' }), 'high')
  assert.equal(reasoningPreference({ ...model, key: 'b' }, { a: 'high', b: 'low' }), 'low')
  // 「模型默认」伪档位已去除：失效偏好回落到模型定义的确定默认档（未声明 default 时取最低档）。
  assert.equal(reasoningPreference(model, { a: 'xhigh' }), 'low')
  assert.equal(reasoningPreference({ ...model, reasoning_efforts: [] }, { a: 'high' }), '')
})

test('the definite default is the declared default, else the lowest declared level', () => {
  const declared = {
    key: 'a',
    reasoning_efforts: ['low', 'medium', 'xhigh'],
    reasoning_options: [{ kind: 'effort', values: ['low', 'medium', 'xhigh'], default: 'medium' }]
  } as ModelInfo
  assert.equal(modelDefaultEffort(declared), 'medium')
  assert.equal(modelDefaultEffort({ key: 'a', reasoning_efforts: ['low', 'medium', 'xhigh'] } as ModelInfo), 'low')
  // 声明的 default 不在 values 里时防御性回落到最低档，而不是照发未声明的值。
  const inconsistent = {
    key: 'a',
    reasoning_efforts: ['high', 'max'],
    reasoning_options: [{ kind: 'effort', values: ['high', 'max'], default: 'medium' }]
  } as ModelInfo
  assert.equal(modelDefaultEffort(inconsistent), 'high')
  // 只声明 reasoning_options、没有 reasoning_efforts 投影时同样可解析。
  const optionsOnly = {
    key: 'a',
    reasoning_options: [{ kind: 'effort', values: ['none', 'low', 'high'] }]
  } as ModelInfo
  assert.equal(modelDefaultEffort(optionsOnly), 'none')
  assert.equal(modelDefaultEffort({ key: 'a' } as ModelInfo), '')
  assert.equal(modelDefaultEffort(undefined), '')
})

test('model failure reconciles saved intent without turning the failed operation into success', async (t) => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  globalThis.window = { scholarseed: { getApiBase: () => 'http://service.test' } } as Window & typeof globalThis
  t.after(() => { globalThis.window = originalWindow; globalThis.fetch = originalFetch })
  const scenarios = [
    { name: 'native attachment rejected after save', status: 500, selected: 'new-model', effort: 'high', deferred: true },
    { name: 'invalid selection rejected before save', status: 422, selected: 'old-model', effort: 'low', deferred: false },
    { name: 'transport lost after save', status: null, selected: 'new-model', effort: 'high', deferred: true }
  ]
  for (const scenario of scenarios) {
    const requests: string[] = []
    const authority = {
      session_id: 'session-1', model_id: scenario.selected,
      active_model_id: 'old-model', reasoning_effort: scenario.effort,
      active_reasoning_effort: 'low', deferred: scenario.deferred,
      runtime: { name: 'codex', model_id: scenario.selected, reasoning_effort: scenario.effort }
    }
    globalThis.fetch = async (url, options) => {
      requests.push(`${options?.method ?? 'GET'} ${String(url)}`)
      if (options?.method === 'POST') {
        if (scenario.status === null) throw new TypeError('connection lost')
        return Response.json({ error: 'model_change_failed', detail: scenario.name }, { status: scenario.status })
      }
      return Response.json(authority)
    }
    const result = await setSessionModel('session-1', 'new-model', 'high')
    assert.equal(result?.ok, false, scenario.name)
    assert.equal(result?.model_id, scenario.selected, scenario.name)
    assert.deepEqual(result?.runtime, authority.runtime, scenario.name)
    assert.equal(result?.active_model_id, 'old-model')
    assert.equal(result?.deferred, scenario.deferred)
    assert.equal(result?.error, scenario.status === null ? 'connection lost' : 'model_change_failed')
    assert.deepEqual(requests, ['POST http://service.test/api/serve/sessions/session-1/model', 'GET http://service.test/api/serve/sessions/session-1/model'])
  }
})

test('unavailable model readback never fabricates the requested selection', async (t) => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  globalThis.window = { scholarseed: { getApiBase: () => 'http://service.test' } } as Window & typeof globalThis
  globalThis.fetch = async () => Response.json({ error: 'unavailable' }, { status: 503 })
  t.after(() => { globalThis.window = originalWindow; globalThis.fetch = originalFetch })
  const result = await setSessionModel('session-1', 'unconfirmed-target', 'high')
  assert.equal(result?.ok, false)
  assert.equal(result?.model_id, '')
  assert.equal(result?.runtime, undefined)
})


test('reasoning display localizes known values and preserves unknown provider values', async () => {
  const i18n = createInstance()
  const resources = Object.fromEntries(['zh', 'en'].map(language => [language, {
    conversation: JSON.parse(readFileSync(new URL(`../../localization/locales/${language}/conversation.json`, import.meta.url), 'utf8'))
  }]))
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
