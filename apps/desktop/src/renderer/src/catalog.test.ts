import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { block } from '../../test-helpers/source-contract.ts'

import {
  effectiveSessionModelKey,
  hasSelectableModel,
  personalModelId,
  pruneMissingCatalogThreads,
  requestModelSupportsImageInput,
  requestModelKey,
  retainCatalogThread,
  selectableCatalogModelKey,
  selectedSessionModelKey
} from './catalog.ts'
import type { SessionNode, Thread } from './model.ts'

const APPEARANCE_GRACE_SECONDS = 5
const NOW_SECONDS = 100

function thread(id: string): Thread {
  return {
    id,
    title: id,
    conversation: [],
    sessionId: id,
    lastSeq: 0
  }
}

function node(id: string, createdAt: number): SessionNode {
  return { id, title: id, status: 'running', createdAt }
}

test('active conversation survives a stale catalog after the appearance grace', () => {
  const active = thread('active-session')
  assert.equal(retainCatalogThread(
    active.id,
    active,
    [node(active.id, 1)],
    new Set(),
    active.id,
    NOW_SECONDS,
    APPEARANCE_GRACE_SECONDS
  ), true)

  assert.deepEqual(pruneMissingCatalogThreads(
    { [active.id]: active },
    [node(active.id, 1)],
    new Set(),
    active.id,
    NOW_SECONDS,
    APPEARANCE_GRACE_SECONDS
  ), { [active.id]: active })
})

test('inactive missing conversation is pruned only after its appearance grace', () => {
  const recent = thread('recent-session')
  const stale = thread('stale-session')
  const threads = { [recent.id]: recent, [stale.id]: stale }

  assert.deepEqual(Object.keys(pruneMissingCatalogThreads(
    threads,
    [node(recent.id, NOW_SECONDS - 1), node(stale.id, 1)],
    new Set(),
    null,
    NOW_SECONDS,
    APPEARANCE_GRACE_SECONDS
  )), [recent.id])
})

test('transient workbench thread stays private while its result tab is open', () => {
  const search = { ...thread('search-session'), surface: 'workbench' as const }
  assert.equal(retainCatalogThread(
    search.id,
    search,
    [],
    new Set(),
    null,
    NOW_SECONDS,
    APPEARANCE_GRACE_SECONDS
  ), true)
})

test('model selection follows each active session without replacing the new-session default', () => {
  const first = thread('first-session')
  first.runtime = { name: 'codex', model_id: 'deepseek-v4-pro' }
  const second = thread('second-session')
  second.runtime = { name: 'codex', model_id: 'gpt-5-codex' }
  const threads = { [first.id]: first, [second.id]: second }

  assert.equal(selectedSessionModelKey('codex-default', first.id, threads), 'deepseek-v4-pro')
  assert.equal(selectedSessionModelKey('codex-default', second.id, threads), 'gpt-5-codex')
  assert.equal(selectedSessionModelKey('codex-default', null, threads), 'codex-default')
  assert.equal(selectedSessionModelKey('codex-default', 'unloaded-session', threads), '')
})

// 阅读面板把 model_key 发给后端, 后端按目录匹配, 空键直接 422「无法准备阅读任务」。
// 选择器可以显示空(它报告会话真实 runtime), 但请求不能带空键。
test('a request model key falls back to the default instead of sending an empty selection', () => {
  const runtimeless = thread('workbench-pdf-session')
  const configured = thread('chat-session')
  configured.runtime = { name: 'codex', model_id: 'deepseek-v4-pro' }
  const threads = { [runtimeless.id]: runtimeless, [configured.id]: configured }
  const models = [{ key: 'qwen3.8-max' }, { key: 'deepseek-v4-pro' }]

  assert.equal(requestModelKey(models, 'qwen3.8-max', runtimeless.id, threads), 'qwen3.8-max')
  assert.equal(requestModelKey(models, 'qwen3.8-max', 'unloaded-session', threads), 'qwen3.8-max')
  assert.equal(requestModelKey(models, 'qwen3.8-max', null, threads), 'qwen3.8-max')
  assert.equal(requestModelKey(models, 'qwen3.8-max', configured.id, threads), 'deepseek-v4-pro')
})

test('figure explanation reads image support from the same model selected for its request', () => {
  const active = thread('active-session')
  const personalKey = 'personal-0123456789abcdef0123456789abcdef:qwen3.8-max'
  active.runtime = { name: 'codex', model_id: personalKey }
  const threads = { [active.id]: active }
  const models = [
    { key: 'qwen3.8-max', image_input: false },
    { key: personalKey, model_id: 'qwen3.8-max', image_input: true },
    { key: 'text-only', image_input: false }
  ]

  assert.equal(requestModelSupportsImageInput(models, 'qwen3.8-max', active.id, threads), true)
  assert.equal(requestModelSupportsImageInput(models, 'text-only', null, threads), false)
  assert.equal(requestModelSupportsImageInput([{ key: 'undeclared' }], 'undeclared', null, {}), false)
  assert.equal(requestModelSupportsImageInput([], 'qwen3.8-max', null, {}), false)
})

// 与后端 `parse_personal_model_key` 是同一份契约; 两侧都断言才不会各自漂移。
test('a personal composite key yields its model segment even when the id contains a separator', () => {
  const profileId = 'personal-0123456789abcdef0123456789abcdef'

  assert.equal(personalModelId(`${profileId}:gpt-4o`), 'gpt-4o')
  assert.equal(personalModelId(`${profileId}:org/exact-model:version`), 'org/exact-model:version')
  assert.equal(personalModelId(`${profileId}:a:b:c`), 'a:b:c')

  assert.equal(personalModelId('qwen3.8-max'), '')
  assert.equal(personalModelId(profileId), '')
  assert.equal(personalModelId(''), '')
})

// 目录重取 effect 活在 live.ts（一个顶层 import React、无法在 node:test 里 import 的大 hook
// 文件），故按仓库既有做法（credits.test.ts / review.test.ts）用源码契约钉住。登出与登录是
// 同一份身份投影的两个方向：少订一边，界面就会停在上一次身份抓到的旧目录，内置模型不置灰。
const liveSource = readFileSync(new URL('./live.ts', import.meta.url), 'utf8')
const reloadEffect = block(
  liveSource,
  'const reloadCatalog = (): void => {',
  "window.addEventListener('scholarseed:refresh-session-list'"
)

test('the model catalog reloads on logout as well as login, so built-in models grey out without a manual refresh', () => {
  // 重取复用冷启动同一个出口：getModels() → applyModelCatalog，不另抄一份置灰逻辑。
  assert.match(
    reloadEffect,
    /void getModels\(\)\.then\(\(catalog\) => act\.applyModelCatalog\(catalog\)\)/
  )
  // 登录成功（auth-restored）与登出/凭据失效（auth-required，任意 401）都必须触发重取。
  assert.match(reloadEffect, /window\.addEventListener\('scholarseed:auth-restored', reloadCatalog\)/)
  assert.match(reloadEffect, /window\.addEventListener\('scholarseed:auth-required', reloadCatalog\)/)
  // 加的监听要在 cleanup 里成对移除，否则 effect 重跑会叠加出重复重取。
  const added = [...reloadEffect.matchAll(/window\.addEventListener\('([^']+)', reloadCatalog\)/g)].map(([, name]) => name)
  const removed = [...reloadEffect.matchAll(/window\.removeEventListener\('([^']+)', reloadCatalog\)/g)].map(([, name]) => name)
  assert.deepEqual([...removed].sort(), [...added].sort())
  assert.deepEqual([...added].sort(), ['scholarseed:auth-required', 'scholarseed:auth-restored'])
})

test('an empty or fully greyed catalogue counts as no selectable model', () => {
  assert.equal(hasSelectableModel([]), false)
  assert.equal(hasSelectableModel([{ disabled: true }, { disabled: true }]), false)
  assert.equal(hasSelectableModel([{ disabled: true }, {}]), true)
  assert.equal(hasSelectableModel([{ disabled: undefined }]), true)
})

test('logout replaces a disabled built-in default with the equivalent personal model', () => {
  const personalKey = 'personal-0123456789abcdef0123456789abcdef:qwen3.8-max'
  const models = [
    { key: 'qwen3.8-max', disabled: true },
    { key: personalKey, model_id: 'qwen3.8-max' },
    { key: 'personal-fedcba9876543210fedcba9876543210:other-model', model_id: 'other-model' }
  ]

  assert.equal(selectableCatalogModelKey('qwen3.8-max', models), personalKey)
  assert.equal(selectableCatalogModelKey(personalKey, models), personalKey)
})

test('catalog selection preserves an enabled previous choice before using the first fallback', () => {
  const models = [
    { key: 'disabled-default', disabled: true },
    { key: 'personal-first:first', model_id: 'first' },
    { key: 'personal-previous:previous', model_id: 'previous' }
  ]

  assert.equal(
    selectableCatalogModelKey('disabled-default', models, 'personal-previous:previous'),
    'personal-previous:previous'
  )
  assert.equal(selectableCatalogModelKey('missing', models), 'personal-first:first')
  assert.equal(selectableCatalogModelKey('missing', []), 'missing')
})

// 登出前开的会话，其 runtime 仍是置灰的内置键：会话面（选择器/文献解释/阅读请求）必须
// 按目录回落到可用模型，而不是把置灰键当真或原地报「模型不可用」。
test('a session runtime disabled by the gateway gate falls back to an enabled catalog model', () => {
  const stale = thread('stale-session')
  stale.runtime = { name: 'codex', model_id: 'qwen3.8-max' }
  const threads = { [stale.id]: stale }
  const personalKey = 'personal-0123456789abcdef0123456789abcdef:qwen3.8-max'
  const models = [
    { key: 'qwen3.8-max', disabled: true },
    { key: personalKey, model_id: 'qwen3.8-max' }
  ]

  // 会话 runtime 可用时保持不变。
  const enabled = thread('enabled-session')
  enabled.runtime = { name: 'codex', model_id: personalKey }
  assert.equal(
    effectiveSessionModelKey(models, personalKey, enabled.id, { [enabled.id]: enabled }),
    personalKey
  )
  // 置灰时优先同底层模型的个人连接，其次已切换的默认，最后第一个可用模型。
  assert.equal(effectiveSessionModelKey(models, 'qwen3.8-max', stale.id, threads), personalKey)
  assert.equal(effectiveSessionModelKey(models, '', stale.id, threads), personalKey)
  // 目录整体置灰时如实保留原键，交给既有「模型不可用」引导。
  const greyed = [{ key: 'qwen3.8-max', disabled: true }]
  assert.equal(effectiveSessionModelKey(greyed, 'qwen3.8-max', stale.id, threads), 'qwen3.8-max')
  // 键不在目录里（隐藏/删除的模型）不自动切换，保持「不可用」的诚实展示。
  const missing = thread('missing-session')
  missing.runtime = { name: 'codex', model_id: 'hidden-model' }
  assert.equal(
    effectiveSessionModelKey(models, personalKey, missing.id, { [missing.id]: missing }),
    'hidden-model'
  )
  // 无会话时回落到默认键。
  assert.equal(effectiveSessionModelKey(models, personalKey, null, threads), personalKey)
})
