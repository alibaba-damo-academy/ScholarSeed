import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { block } from '../../test-helpers/source-contract.ts'

import {
  hasSelectableModel,
  personalModelId,
  pruneMissingCatalogThreads,
  requestModelKey,
  retainCatalogThread,
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

  assert.equal(requestModelKey('qwen3.8-max', runtimeless.id, threads), 'qwen3.8-max')
  assert.equal(requestModelKey('qwen3.8-max', 'unloaded-session', threads), 'qwen3.8-max')
  assert.equal(requestModelKey('qwen3.8-max', null, threads), 'qwen3.8-max')
  assert.equal(requestModelKey('qwen3.8-max', configured.id, threads), 'deepseek-v4-pro')
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
