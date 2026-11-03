import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createInstance } from 'i18next'
import ts from 'typescript'
import { withResourceChildren } from '../features/resources/state.ts'

import {
  taskProgressPresentation as presentProgress,
  taskTitleText,
  type ProductTask,
} from './tasks.ts'

const i18n = createInstance()
await i18n.init({
  lng: 'zh',
  fallbackLng: false,
  resources: {
    zh: {
      tasks: JSON.parse(
        readFileSync(
          new URL('../../../localization/locales/zh/tasks.json', import.meta.url),
          'utf8'
        )
      ),
    },
    en: {
      tasks: JSON.parse(
        readFileSync(
          new URL('../../../localization/locales/en/tasks.json', import.meta.url),
          'utf8'
        )
      ),
    },
  },
})
const taskProgressPresentation = (value: ProductTask) =>
  presentProgress(value, i18n.getFixedT('zh', 'tasks'))

const task = (overrides: Partial<ProductTask> = {}): ProductTask => ({
  id: 'job-1',
  sourceId: 'resource-imports',
  projectId: 'project-1',
  operation: 'link',
  title: { key: 'title.link', names: ['pressure_010k_100M'] },
  detail: '',
  sourceNames: ['pressure_010k_100M'],
  outcome: {
    available: true,
    total: 1,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    results: [
      { index: 0, name: 'pressure_010k_100M', status: 'pending', error: '', retryable: false },
    ],
  },
  status: 'running',
  phase: 'linking',
  discoveredItems: 0,
  completedItems: 1,
  totalItems: 1,
  completedBytes: 0,
  totalBytes: 0,
  versionCompletedItems: 0,
  versionDiscoveredItems: 0,
  versionTotalItems: 0,
  eventSeq: 1,
  error: '',
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
})

test('scanning and atomic linking report factual stage progress without fake percentages', () => {
  assert.deepEqual(taskProgressPresentation(task({ phase: 'scanning', discoveredItems: 326 })), {
    determinate: false,
    label: '扫描中（已发现 326 项）',
    value: 0,
  })
  assert.deepEqual(taskProgressPresentation(task()), {
    determinate: false,
    label: '正在建立关联（共 1 项）',
    value: 0,
  })
})

test('version initialization uses its own exact counter and completion is authoritative', () => {
  assert.deepEqual(
    taskProgressPresentation(
      task({ phase: 'versioning', versionDiscoveredItems: 326, versionTotalItems: 0 })
    ),
    { determinate: false, label: '统计版本文件（已发现 326 项）', value: 0 }
  )
  assert.deepEqual(
    taskProgressPresentation(
      task({ phase: 'versioning', versionCompletedItems: 120, versionTotalItems: 326 })
    ),
    { determinate: true, label: '初始化版本 120/326', value: 120 / 3.26 }
  )
  assert.deepEqual(taskProgressPresentation(task({ status: 'completed', phase: 'completed' })), {
    determinate: true,
    label: '已完成',
    value: 100,
  })
})

test('copy progress is the exact byte ratio for that stage', () => {
  assert.deepEqual(
    taskProgressPresentation(task({ phase: 'copying', completedBytes: 64, totalBytes: 128 })),
    { determinate: true, label: '复制中 50%', value: 50 }
  )
  assert.deepEqual(
    taskProgressPresentation(task({ phase: 'copying', completedBytes: 128, totalBytes: 128 })),
    { determinate: true, label: '复制中 100%', value: 100 }
  )
})

test('task snapshots are event-driven and fallback does not depend on the popover', () => {
  const center = readFileSync(new URL('../components/business/Tasks.tsx', import.meta.url), 'utf8')
  const imports = readFileSync(new URL('../features/resources/imports.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(center, /TASK_POLL_INTERVAL_MS/)
  assert.match(center, /if \(feed\.needsRefresh\(\)\) void feed\.refresh\(\)/)
  assert.doesNotMatch(center, /reloadResourceTree|pendingTerminals|settling/)
  assert.match(center, /TASK_FALLBACK_POLL_INTERVAL_MS/)
  assert.doesNotMatch(center, /<Spinner/)
  assert.match(center, /<ProgressBar/)
  assert.match(imports, /new EventSource\(/)
  assert.match(imports, /after_seq: String\(task\.eventSeq\)/)
})

// Execute the actual store action without mounting the unrelated application tree.
// AST selection deliberately ignores formatting and the order of adjacent actions.
function storeHandler(
  name: string,
  dependencies: Record<string, unknown>
): (...args: unknown[]) => Promise<unknown> {
  const source = ts.createSourceFile(
    'store.tsx',
    readFileSync(new URL('../store.tsx', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const matches: ts.ArrowFunction[] = []
  function visit(node: ts.Node): void {
    if (
      (ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer && ts.isArrowFunction(node.initializer)
    )
      matches.push(node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.equal(matches.length, 1, `expected one actual ${name} action`)
  const compiled = ts.transpileModule(`const handler = ${matches[0].getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  return new Function(...Object.keys(dependencies), compiled + '\nreturn handler;')(
    ...Object.values(dependencies)
  )
}

test('copy and link imports both enter the background task pipeline', async () => {
  for (const mode of ['copy', 'link']) {
    let state = {
      homeSelectedProjectId: 'project-1',
      resource: { importDialog: { targetDir: 'papers' } },
    }
    const sources = ['/input/article.pdf']
    const queued: unknown[][] = []
    const notices: unknown[][] = []
    const handler = storeHandler('importResourceFiles', {
      stateRef: { current: state },
      createResourceImport: async (...args: unknown[]) => {
        queued.push(args)
        return { ok: true }
      },
      importResources: () => assert.fail('imports must use the task pipeline'),
      setState: (update: (current: typeof state) => typeof state) => {
        state = update(state)
      },
      actRef: { current: { noticeResource: (...args: unknown[]) => notices.push(args) } },
    })
    await handler(mode, sources)
    assert.deepEqual(queued, [[mode, sources, 'papers', 'project-1']])
    assert.equal(state.resource.importDialog, null)
    assert.deepEqual(notices, [
      ['ok', { key: mode === 'copy' ? 'feedback.importQueued' : 'feedback.linkQueued' }],
    ])
  }
})

test('resource refresh settles imports only after current external roots reach Electron', async (t) => {
  for (const outcome of ['success', 'failed-sync', 'changed-project']) {
    await t.test(outcome, async () => {
      let resolveRoots!: (roots: unknown) => void
      const roots = new Promise((resolve) => {
        resolveRoots = resolve
      })
      const stateRef = {
        current: { homeSelectedProjectId: 'project-1', resource: { tree: [], expanded: {} } },
      }
      const synchronizedProjects: unknown[] = []
      const notices: unknown[][] = []
      let childReads = 0
      let settled = false
      let completed: unknown
      const handler = storeHandler('reloadResourceTree', {
        stateRef,
        resourceTreeReloadSeq: { current: 0 },
        setState: (update: (current: typeof stateRef.current) => typeof stateRef.current) => {
          stateRef.current = update(stateRef.current)
        },
        beginResourceTreeReload: (resource: unknown) => resource,
        finishResourceTreeReload: (resource: unknown, result: unknown) => {
          completed = result
          return resource
        },
        applyChildrenPatches: storeHandler('applyChildrenPatches', { withResourceChildren }),
        fetchResourceTree: async () => ({ nodes: [] }),
        listExternalRoots: (project: unknown) => {
          synchronizedProjects.push(project)
          return roots
        },
        fetchPendingChildren: async () => {
          childReads++
          return []
        },
        actRef: { current: { noticeResource: (...args: unknown[]) => notices.push(args) } },
      })
      const work = handler().then((result) => {
        settled = true
        return result
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(settled, false)
      assert.equal(childReads, 0)
      assert.deepEqual(synchronizedProjects, ['project-1'])
      if (outcome === 'changed-project') stateRef.current.homeSelectedProjectId = 'project-2'
      resolveRoots(outcome === 'failed-sync' ? null : { roots: [], writableRoots: [] })
      assert.equal(await work, outcome === 'success')
      assert.equal(childReads, outcome === 'success' ? 1 : 0)
      if (outcome === 'success') assert.deepEqual(completed, { nodes: [] })
      assert.deepEqual(
        notices,
        outcome === 'failed-sync' ? [['error', { key: 'panel.loadFailed' }]] : []
      )
    })
  }
})

test('resource refresh skips absent or superseded project context before any reads', async () => {
  const unexpected = (): never => assert.fail('inactive project must not start resource work')
  for (const project of [null, 'project-1']) {
    const handler = storeHandler('reloadResourceTree', {
      stateRef: { current: { homeSelectedProjectId: project } },
      resourceTreeReloadSeq: { current: 0 },
      setState: unexpected,
      fetchResourceTree: unexpected,
      listExternalRoots: unexpected,
      fetchPendingChildren: unexpected,
    })
    if (project === null) assert.equal(await handler(), false)
    assert.equal(await handler(undefined, 'previous-project'), false)
  }
})

test('English task progress uses singular and plural without changing progress values', () => {
  const translate = i18n.getFixedT('en', 'tasks')
  assert.equal(
    presentProgress(task({ phase: 'scanning', discoveredItems: 1 }), translate).label,
    'Scanning (1 item found)'
  )
  assert.equal(
    presentProgress(task({ phase: 'scanning', discoveredItems: 2 }), translate).label,
    'Scanning (2 items found)'
  )
  assert.deepEqual(
    presentProgress(task({ phase: 'copying', completedBytes: 64, totalBytes: 128 }), translate),
    { determinate: true, label: 'Copying 50%', value: 50 }
  )
})

test('task titles translate at presentation without changing source names or raw titles', () => {
  const title = { key: 'title.copy' as const, names: ['研究.md', 'notes.txt'] }
  assert.equal(
    taskTitleText(title, i18n.getFixedT('zh', 'tasks')),
    '复制资料到项目 · 研究.md 等 2 项'
  )
  assert.equal(
    taskTitleText(title, i18n.getFixedT('en', 'tasks')),
    'Copy resources to project · 研究.md (2 items)'
  )
  assert.deepEqual(title.names, ['研究.md', 'notes.txt'])
  assert.equal(taskTitleText('用户任务', i18n.getFixedT('en', 'tasks')), '用户任务')
})
