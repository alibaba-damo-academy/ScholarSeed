import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { block } from '../../test-helpers/source-contract.ts'

import {
  effectiveSessionModelKey,
  hasSelectableModel,
  personalModelId,
  projectCatalogFailure,
  pruneMissingCatalogThreads,
  requestModelSupportsImageInput,
  requestModelKey,
  retainCatalogThread,
  selectableActionModelKey,
  sessionCatalogRetryDelay,
  sessionCatalogNeedsRefresh,
  sameSessionCatalog,
  sessionSummaryNeedsCatalog,
  selectableCatalogModelKey,
  selectedSessionModelKey,
} from './catalog.ts'
import type { SessionNode, Thread } from './model.ts'
import type { ServeSession } from './api.ts'
import { skillName } from './skill.ts'
import { buildTurnInput } from './input.ts'

test('composer skill fetches use the interface language and preserve registered send identities', async () => {
  const source = readFileSync(
    new URL('./components/business/Composer.tsx', import.meta.url),
    'utf8'
  )
  const parsed = ts.createSourceFile(
    'Composer.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const effects: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(parsed) === 'React.useEffect' &&
      node.arguments[0]?.getText(parsed).includes('getSkills(')
    )
      effects.push(node)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.equal(effects.length, 2)
  for (const language of ['zh', 'en']) {
    for (const effect of effects) {
      assert.ok(effect.arguments[1]?.getText(parsed).includes('language'))
      const requests: unknown[][] = []
      const registered = {
        name: 'eln',
        display_name: language === 'zh' ? '整理实验记录' : 'Lab Notes Organizer',
        path: '/skills/eln/SKILL.md',
        enabled: true,
        active: true,
      }
      const script = ts.transpile(`(${effect.arguments[0].getText(parsed)})()`, {
        target: ts.ScriptTarget.ES2022,
      })
      runInNewContext(script, {
        language,
        state: { backendReady: true },
        selectedSkillKey: '["eln"]',
        skillPickerOpen: true,
        skillRevision: 1,
        authenticated: true,
        SKILL_SURFACE_SETTINGS: 'settings',
        SKILL_SURFACE_CONVERSATION: 'conversation',
        getSkills: (...args: unknown[]) => {
          requests.push(args)
          return Promise.resolve([registered])
        },
        setSelectedSkillCatalog() {},
        setSkillRows() {},
        setSkillRowsLoading() {},
        skillCallable: () => true,
        set() {},
        t: (key: string) => key,
      })
      await Promise.resolve()
      assert.equal(requests.length, 1)
      assert.equal(requests[0][1], language)
      const input = buildTurnInput('请使用此技能', [
        { type: 'skill', id: registered.name, title: skillName(registered), path: registered.path },
      ])
      assert.deepEqual(input[1], {
        type: 'skill',
        name: 'eln',
        path: registered.path,
        version: undefined,
      })
    }
  }
})

test('composer skill menu renders display names and selects canonical references', () => {
  const source = readFileSync(
    new URL('./components/business/Composer.tsx', import.meta.url),
    'utf8'
  )
  const parsed = ts.createSourceFile(
    'Composer.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  let menu: ts.JsxElement | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.attributes.properties.some(
        (attribute) =>
          ts.isJsxAttribute(attribute) &&
          attribute.name.getText(parsed) === 'data-testid' &&
          attribute.initializer?.getText(parsed) === '{`composer-skill-${s.name}`}'
      )
    )
      menu = node
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(menu)
  const script = ts.transpile(`(${menu.getText(parsed)})`, {
    jsx: ts.JsxEmit.React,
    target: ts.ScriptTarget.ES2022,
  })
  for (const display_name of ['学术检索', 'Academic Search', '', undefined]) {
    const selected = {
      name: 'agentic-search',
      display_name,
      path: '/skills/agentic-search/SKILL.md',
      version: '1.0.0',
    }
    let references: unknown[] = []
    const element = runInNewContext(script, {
      React,
      Button: 'button',
      s: selected,
      loaded: false,
      skillName,
      t: (key: string) => key,
      setPendingRefs: (update: (previous: unknown[]) => unknown[]) => {
        references = update(references)
      },
      clearAtTrigger() {},
      setSkillPanelOpen() {},
      setPlusMenuOpen() {},
      setSkillQuery() {},
    }) as React.ReactElement<{ onClick: () => void }>
    const markup = renderToStaticMarkup(element)
    assert.ok(markup.includes(`>${display_name || selected.name}</span>`))
    element.props.onClick()
    element.props.onClick()
    assert.equal(
      JSON.stringify(references),
      JSON.stringify([
        {
          type: 'skill',
          id: selected.name,
          title: display_name || selected.name,
          path: selected.path,
          version: selected.version,
        },
      ])
    )
  }
})

test('catalog polling invalidates consumers only when server contents change', () => {
  const rows = [{ session_id: 'task', title: 'Task', mtime: 1, last_seq: 2 }] as ServeSession[]
  assert.equal(sameSessionCatalog(null, []), false)
  assert.equal(sameSessionCatalog([], []), true)
  assert.equal(sameSessionCatalog(rows, structuredClone(rows)), true)
  for (const change of [
    { title: 'Renamed' },
    { mtime: 2 },
    { last_seq: 3 },
    { running: true },
    { archived: true },
  ]) {
    assert.equal(sameSessionCatalog(rows, [{ ...rows[0], ...change }]), false)
  }
  assert.equal(sameSessionCatalog(rows, []), false)
  assert.equal(sameSessionCatalog([], rows), false)
})

const APPEARANCE_GRACE_SECONDS = 5

test('status-only notifications do not invalidate catalog metadata but lifecycle and membership do', () => {
  const previous = {
    session_id: 'task',
    title: 'Task',
    running: true,
    turns: 1,
    mtime: 1,
    last_seq: 2,
  } as ServeSession
  assert.equal(
    sessionSummaryNeedsCatalog(previous, { ...previous, waiting: true, mtime: 2, last_seq: 3 }),
    false
  )
  for (const change of [
    { title: 'Renamed' },
    { title_fallback: 'new_session' as const },
    { running: false },
    { turns: 2 },
    { archived: true },
    { pinned: true },
    { project_path: '/project' },
    { last_turn_status: 'completed' as const },
  ])
    assert.equal(sessionSummaryNeedsCatalog(previous, { ...previous, ...change }), true)
  assert.equal(sessionSummaryNeedsCatalog(undefined, previous), true)
  assert.equal(
    sessionSummaryNeedsCatalog(
      { ...previous, running: false, last_turn_status: 'completed' },
      { ...previous, running: false, last_turn_status: 'completed', mtime: 2 }
    ),
    true
  )
})
const NOW_SECONDS = 100

test('composer skill entries share contextual navigation while upload stays separate', () => {
  const source = readFileSync(
    new URL('./components/business/Composer.tsx', import.meta.url),
    'utf8'
  )
  const parsed = ts.createSourceFile(
    'Composer.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const menus: ts.JsxElement[] = []
  const managers: ts.JsxElement[] = []
  let navigation: ts.VariableDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(parsed) === 'DropdownMenuSub' &&
      node.getText(parsed).includes('data-testid="composer-skill-add"')
    )
      menus.push(node)
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'openSkillCenter')
      navigation = node
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(parsed) === 'Button' &&
      node.getText(parsed).includes("t('composer.manageSkills')")
    )
      managers.push(node)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  const menu = menus.sort((left, right) => left.getWidth() - right.getWidth())[0]
  assert.ok(menu)
  assert.ok(navigation)
  assert.equal(managers.length, 2)
  const script = ts.transpile(
    `const ${navigation.getText(parsed)}; [${menu.getText(parsed)}, ${managers.map((node) => node.getText(parsed)).join(',')}]`,
    {
      jsx: ts.JsxEmit.React,
      target: ts.ScriptTarget.ES2022,
    }
  )
  const actions: unknown[] = []
  const element = runInNewContext(script, {
    React,
    Button: 'button',
    Settings: 'icon',
    DropdownMenuSub: 'sub',
    DropdownMenuSubTrigger: 'trigger',
    DropdownMenuSubContent: 'content',
    DropdownMenuItem: 'item',
    IconFont: 'icon',
    Upload: 'icon',
    Plug: 'icon',
    t: (key: string) => key,
    state: { homeSelectedProjectId: 'origin-project' },
    set: (value: unknown) => actions.push(value),
    clearAtTrigger() {},
    setSkillPanelOpen() {},
    setPlusMenuOpen() {},
    act: { openWorkbenchView: (view: string, options: unknown) => actions.push([view, options]) },
  })
  const entries: React.ReactElement<Record<string, unknown>>[] = []
  const collect = (node: React.ReactNode): void => {
    if (!React.isValidElement<Record<string, unknown>>(node)) return
    if (node.props['data-testid']) entries.push(node)
    React.Children.forEach(node.props.children as React.ReactNode, collect)
  }
  for (const node of element) collect(node)
  for (const manager of element.slice(1)) {
    manager.props.onClick()
  }
  const trigger = entries.find((entry) => entry.props['data-testid'] === 'composer-skill-add')!
  assert.equal(trigger.props.onClick, undefined)
  for (const id of ['composer-skill-upload', 'composer-skill-market']) {
    const entry = entries.find((candidate) => candidate.props['data-testid'] === id)
    assert.ok(entry)
    ;(entry.props.onSelect as () => void)()
  }
  assert.equal(
    JSON.stringify(actions),
    JSON.stringify([
      ['skills', { preserveProject: true, returnProjectId: 'origin-project' }],
      ['skills', { preserveProject: true, returnProjectId: 'origin-project' }],
      { skillUploadOpen: true },
      ['skills', { preserveProject: true, returnProjectId: 'origin-project' }],
    ])
  )
})

test('catalog keeps refreshing completed sessions until recovery settlement is authoritative', () => {
  const sessions = [{ id: 'active', status: 'done' as const }]
  assert.equal(
    sessionCatalogNeedsRefresh(sessions, 'active', { active: { recoveryPending: true } }),
    true
  )
  assert.equal(
    sessionCatalogNeedsRefresh(sessions, 'active', { active: { recoveryPending: false } }),
    false
  )
  assert.equal(sessionCatalogNeedsRefresh([], null, { detached: { recoveryPending: true } }), true)
})

test('catalog preserves background running and waiting refresh without polling ordinary idle sessions', () => {
  for (const status of ['running', 'waiting'] as const) {
    const sessions = [
      { id: 'active', status },
      { id: 'background', status },
    ]
    assert.equal(sessionCatalogNeedsRefresh(sessions, 'active', {}), true)
    assert.equal(sessionCatalogNeedsRefresh([sessions[0]], 'active', {}), false)
  }
  assert.equal(sessionCatalogNeedsRefresh([{ id: 'idle', status: 'done' }], 'active', {}), false)
})

test('catalog failures preserve a loaded workspace and retry only retryable failures', () => {
  assert.deepEqual(projectCatalogFailure('ready', true), {
    workspaceLoadState: 'ready',
    retry: true,
  })
  assert.deepEqual(projectCatalogFailure('loading', true), {
    workspaceLoadState: 'error',
    retry: true,
  })
  assert.deepEqual(projectCatalogFailure('error', false), {
    workspaceLoadState: 'error',
    retry: false,
  })
})

test('catalog retry backoff grows and caps at ten seconds', () => {
  assert.equal(sessionCatalogRetryDelay(0), 1_000)
  assert.equal(sessionCatalogRetryDelay(1), 2_000)
  assert.equal(sessionCatalogRetryDelay(2), 5_000)
  assert.equal(sessionCatalogRetryDelay(3), 10_000)
  assert.equal(sessionCatalogRetryDelay(99), 10_000)
})

function thread(id: string): Thread {
  return {
    id,
    title: id,
    conversation: [],
    sessionId: id,
    lastSeq: 0,
  }
}

function node(id: string, createdAt: number): SessionNode {
  return { id, title: id, status: 'running', createdAt }
}

test('active conversation survives a stale catalog after the appearance grace', () => {
  const active = thread('active-session')
  assert.equal(
    retainCatalogThread(
      active.id,
      active,
      [node(active.id, 1)],
      new Set(),
      active.id,
      NOW_SECONDS,
      APPEARANCE_GRACE_SECONDS
    ),
    true
  )

  assert.deepEqual(
    pruneMissingCatalogThreads(
      { [active.id]: active },
      [node(active.id, 1)],
      new Set(),
      active.id,
      NOW_SECONDS,
      APPEARANCE_GRACE_SECONDS
    ),
    { [active.id]: active }
  )
})

test('inactive missing conversation is pruned only after its appearance grace', () => {
  const recent = thread('recent-session')
  const stale = thread('stale-session')
  const threads = { [recent.id]: recent, [stale.id]: stale }

  assert.deepEqual(
    Object.keys(
      pruneMissingCatalogThreads(
        threads,
        [node(recent.id, NOW_SECONDS - 1), node(stale.id, 1)],
        new Set(),
        null,
        NOW_SECONDS,
        APPEARANCE_GRACE_SECONDS
      )
    ),
    [recent.id]
  )
})

test('transient workbench thread stays private while its result tab is open', () => {
  const search = { ...thread('search-session'), surface: 'workbench' as const }
  assert.equal(
    retainCatalogThread(
      search.id,
      search,
      [],
      new Set(),
      null,
      NOW_SECONDS,
      APPEARANCE_GRACE_SECONDS
    ),
    true
  )
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
    { key: 'text-only', image_input: false },
  ]

  assert.equal(requestModelSupportsImageInput(models, 'qwen3.8-max', active.id, threads), true)
  assert.equal(requestModelSupportsImageInput(models, 'text-only', null, threads), false)
  assert.equal(
    requestModelSupportsImageInput([{ key: 'undeclared' }], 'undeclared', null, {}),
    false
  )
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
  '// The HTTP listener is available before activation admits model operations.',
  "window.addEventListener('scholarseed:refresh-session-list'"
)

test('the model catalog reloads on logout as well as login, so built-in models grey out without a manual refresh', () => {
  // 重取复用冷启动同一个出口：getModels() → applyModelCatalog，不另抄一份置灰逻辑。
  assert.match(
    reloadEffect,
    /void getModels\(\)\.then\(\(catalog\) => \{\s*if \(request === revision\) act\.applyModelCatalog\(catalog\)/
  )
  // 登录成功（auth-restored）与登出/凭据失效（auth-required，任意 401）都必须触发重取。
  assert.match(
    reloadEffect,
    /window\.addEventListener\('scholarseed:auth-restored', reloadCatalog\)/
  )
  assert.match(
    reloadEffect,
    /window\.addEventListener\('scholarseed:auth-required', reloadCatalog\)/
  )
  // 加的监听要在 cleanup 里成对移除，否则 effect 重跑会叠加出重复重取。
  const added = [
    ...reloadEffect.matchAll(/window\.addEventListener\('([^']+)', reloadCatalog\)/g),
  ].map(([, name]) => name)
  const removed = [
    ...reloadEffect.matchAll(/window\.removeEventListener\('([^']+)', reloadCatalog\)/g),
  ].map(([, name]) => name)
  assert.deepEqual([...removed].sort(), [...added].sort())
  assert.deepEqual([...added].sort(), ['scholarseed:auth-required', 'scholarseed:auth-restored'])
})

test('model loading waits for workbench admission and reloads after service replacement', () => {
  assert.match(
    reloadEffect,
    /if \(!state.backendReady \|\| !state.workbenchReady \|\| state.runtimeQuiescing\) return/
  )
  assert.match(reloadEffect, /reloadCatalog\(\)/)
  assert.match(
    reloadEffect,
    /state.backendReady,\s*state.workbenchReady,\s*state.serviceInstanceId/
  )
  assert.match(reloadEffect, /return \(\) => \{\s*revision \+= 1/)
})

// Execute the production effect with controlled transport completion order.
// This is a deterministic lifecycle contract, not product acceptance.
function modelEffect(ready: boolean, runtimeQuiescing = false) {
  const listeners = new Map<string, () => void>()
  const pending: Array<(value: unknown) => void> = []
  const applied: unknown[] = []
  const parsed = ts.createSourceFile('live.ts', liveSource, ts.ScriptTarget.Latest, true)
  let source = ''
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'useEffect') {
      const callback = node.arguments[0]
      if (
        ts.isArrowFunction(callback) &&
        callback.body.getText(parsed).includes('const reloadCatalog =')
      )
        source = callback.body.getText(parsed).slice(1, -1)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(source)
  const script = ts.transpile(`(function () { ${source} })()`, {
    target: ts.ScriptTarget.ES2022,
  })
  const dispose = runInNewContext(script, {
    state: { backendReady: true, workbenchReady: ready, runtimeQuiescing },
    getModels: () => new Promise((resolve) => pending.push(resolve)),
    act: { applyModelCatalog: (value: unknown) => applied.push(value) },
    window: {
      addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    },
  }) as (() => void) | undefined
  return { listeners, pending, applied, dispose }
}

test('model effect does not request during activation, then hydrates on admission', async () => {
  const blocked = modelEffect(false)
  assert.equal(blocked.pending.length, 0)
  assert.equal(blocked.listeners.size, 0)
  const ready = modelEffect(true)
  assert.equal(ready.pending.length, 1)
  const catalog = { available_models: [{ key: 'enabled' }] }
  ready.pending[0](catalog)
  await Promise.resolve()
  assert.deepEqual(ready.applied, [catalog])
  ready.dispose?.()
})

test('shutdown suspends model catalog refresh and its auth listeners', () => {
  const suspended = modelEffect(true, true)
  assert.equal(suspended.pending.length, 0)
  assert.equal(suspended.listeners.size, 0)
})

test('identity reload discards the previous account response', async () => {
  const effect = modelEffect(true)
  effect.listeners.get('scholarseed:auth-required')?.()
  effect.pending[1]({ account: 'signed-out' })
  await Promise.resolve()
  effect.pending[0]({ account: 'old-account' })
  await Promise.resolve()
  assert.deepEqual(effect.applied, [{ account: 'signed-out' }])
  effect.dispose?.()
})

test('leaving the admitted service prevents pending catalog writes and removes listeners', async () => {
  const effect = modelEffect(true)
  effect.dispose?.()
  effect.pending[0]({ account: 'old-service' })
  await Promise.resolve()
  assert.deepEqual(effect.applied, [])
  assert.equal(effect.listeners.size, 0)
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
    { key: 'personal-fedcba9876543210fedcba9876543210:other-model', model_id: 'other-model' },
  ]

  assert.equal(selectableCatalogModelKey('qwen3.8-max', models), personalKey)
  assert.equal(selectableCatalogModelKey(personalKey, models), personalKey)
})

test('catalog selection preserves an enabled previous choice before using the first fallback', () => {
  const models = [
    { key: 'disabled-default', disabled: true },
    { key: 'personal-first:first', model_id: 'first' },
    { key: 'personal-previous:previous', model_id: 'previous' },
  ]

  assert.equal(
    selectableCatalogModelKey('disabled-default', models, 'personal-previous:previous'),
    'personal-previous:previous'
  )
  assert.equal(selectableCatalogModelKey('missing', models), 'personal-first:first')
  assert.equal(selectableCatalogModelKey('missing', []), 'missing')
})

test('an exact continuation draft never falls back to an available paid source', () => {
  const source = 'subscription/original'
  const paid = 'personal-account:original'
  for (const models of [[{ key: source, disabled: true }, { key: paid }], [{ key: paid }]]) {
    assert.equal(effectiveSessionModelKey(models, source, null, {}, source), source)
    assert.equal(effectiveSessionModelKey(models, paid, null, {}, source), source)
    const attached = thread('attachment-session')
    attached.runtime = { name: 'codex', model_id: source }
    assert.equal(
      effectiveSessionModelKey(models, paid, attached.id, { [attached.id]: attached }, source),
      source
    )
  }
  const models = [{ key: source, disabled: true }, { key: paid }]
  assert.equal(effectiveSessionModelKey(models, source, null, {}), paid)
})

test('composer blocks an unavailable exact draft while ordinary drafts retain catalog fallback', () => {
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
  let declaration: ts.VariableDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(syntax) === 'modelAvailable')
      declaration = node
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  assert.ok(declaration?.initializer)
  const script = ts.transpileModule(`result.value = ${declaration.initializer.getText(syntax)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  for (const exactDraftModelId of [null, 'subscription/original']) {
    const result: { value?: boolean } = {}
    runInNewContext(script, {
      result,
      exactDraftModelId,
      selectedModel: { key: 'subscription/original', disabled: true },
      state: {
        catalog: {
          models: [{ key: 'subscription/original', disabled: true }, { key: 'paid-model' }],
        },
      },
      hasSelectableModel,
    })
    assert.equal(result.value, exactDraftModelId === null)
  }
})

test('new-session and attachment admission reject a substituted model before executing anything', async () => {
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
  const guards: ts.IfStatement[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isIfStatement(node) &&
      node.expression.getText(syntax).includes('opened.runtime.model_id !== exactDraftModelId')
    )
      guards.push(node)
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  assert.equal(guards.length, 2)
  for (const guard of guards) {
    const script = ts.transpileModule(
      `(async () => { ${guard.getText(syntax)}; return 'admitted' })()`,
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }
    ).outputText
    for (const modelId of ['original-model', 'substituted-paid-model']) {
      const state = {
        draftModelId: 'original-model',
        draftGeneration: 2,
        modelSelectionGeneration: 3,
        catalog: { models: [{ key: 'original-model' }] },
      }
      const updates: unknown[] = []
      const result = await runInNewContext(script, {
        exactDraftModelId: 'original-model',
        opened: { runtime: { model_id: modelId } },
        state,
        getSnapshot: () => state,
        restoreDraft: () => {},
        set: (update: unknown) => updates.push(update),
        feedback: (_namespace: string, key: string) => key,
      })
      assert.equal(result === 'admitted', modelId === 'original-model')
      assert.equal(updates.length, modelId === 'original-model' ? 0 : 1)
    }
  }
})

test('reading actions resolve a stale preference against the current selectable catalog', () => {
  const models = [
    { key: 'qwen3.8-max', disabled: true, model_id: 'qwen3.8-max' },
    { key: 'personal-own:qwen3.8-max', model_id: 'qwen3.8-max' },
    { key: 'personal-other:other', model_id: 'other' },
  ]
  assert.equal(
    selectableActionModelKey('qwen3.8-max', models, 'personal-other:other'),
    'personal-other:other'
  )
  assert.equal(selectableActionModelKey('qwen3.8-max', models), 'personal-own:qwen3.8-max')
  assert.equal(
    selectableActionModelKey('personal-own:qwen3.8-max', models),
    'personal-own:qwen3.8-max'
  )
  assert.equal(selectableActionModelKey('qwen3.8-max', models.slice(0, 1)), '')
  assert.equal(selectableActionModelKey('', [], ''), '')
  assert.equal(
    selectableActionModelKey('chatgpt-disconnected', [
      { key: 'chatgpt-disconnected', disabled: true, model_id: 'gpt' },
      { key: 'qwen3.8-flash', model_id: 'qwen3.8-flash' },
    ]),
    'qwen3.8-flash'
  )
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
    { key: personalKey, model_id: 'qwen3.8-max' },
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

test('the no-model hint offers login only to anonymous users', () => {
  const composer = readFileSync(
    new URL('./components/business/Composer.tsx', import.meta.url),
    'utf8'
  )
  const start = '{!modelAvailable && showModelHint && ('
  const hint = block(composer, start, '{!selectedSkillsReady && (')
  const jsx = hint.slice(start.length, hint.lastIndexOf(')}'))
  const script = ts.transpile(`(${jsx})`, { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 })
  for (const authenticated of [false, true]) {
    const element = runInNewContext(script, {
      React,
      authenticated,
      t: (key: string) => key,
      NO_MODEL_HINT_CLASS: '',
      NO_MODEL_HINT_LINK_CLASS: '',
      Button: (props: { children: React.ReactNode; 'data-testid': string }) =>
        React.createElement('button', { 'data-testid': props['data-testid'] }, props.children),
    })
    const html = renderToStaticMarkup(element)
    assert.equal(html.includes('composer-no-model-login'), !authenticated)
    assert.equal(html.includes('composer.noModelOr'), !authenticated)
    assert.equal(html.includes('composer-no-model-configure'), true)
  }
})
