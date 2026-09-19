import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createInstance } from 'i18next'

import { taskProgressPresentation as presentProgress, taskTitleText, type ProductTask } from './tasks.ts'

const i18n = createInstance()
await i18n.init({
  lng: 'zh',
  fallbackLng: false,
  resources: {
    zh: { tasks: JSON.parse(readFileSync(new URL('../../../localization/locales/zh/tasks.json', import.meta.url), 'utf8')) },
    en: { tasks: JSON.parse(readFileSync(new URL('../../../localization/locales/en/tasks.json', import.meta.url), 'utf8')) }
  }
})
const taskProgressPresentation = (value: ProductTask) => presentProgress(value, i18n.getFixedT('zh', 'tasks'))

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
    results: [{ index: 0, name: 'pressure_010k_100M', status: 'pending', error: '', retryable: false }]
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
  ...overrides
})

test('scanning and atomic linking report factual stage progress without fake percentages', () => {
  assert.deepEqual(taskProgressPresentation(task({ phase: 'scanning', discoveredItems: 326 })), {
    determinate: false,
    label: '扫描中（已发现 326 项）',
    value: 0
  })
  assert.deepEqual(taskProgressPresentation(task()), {
    determinate: false,
    label: '正在建立关联（共 1 项）',
    value: 0
  })
})

test('version initialization uses its own exact counter and refresh is a completion barrier', () => {
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
  assert.deepEqual(taskProgressPresentation(task({ status: 'settling', phase: 'refreshing' })), {
    determinate: false,
    label: '正在刷新资料树',
    value: 0
  })
  assert.deepEqual(taskProgressPresentation(task({ status: 'completed', phase: 'completed' })), {
    determinate: true,
    label: '已完成',
    value: 100
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

test('task snapshots are event-driven and polling exists only as an open disconnected fallback', () => {
  const center = readFileSync(new URL('../components/business/Tasks.tsx', import.meta.url), 'utf8')
  const imports = readFileSync(new URL('../features/resources/imports.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(center, /TASK_POLL_INTERVAL_MS/)
  assert.match(center, /if \(!open \|\| disconnected\.size === 0\) return/)
  assert.match(center, /TASK_FALLBACK_POLL_INTERVAL_MS/)
  assert.doesNotMatch(center, /<Spinner/)
  assert.match(center, /<ProgressBar/)
  assert.match(imports, /new EventSource\(/)
  assert.match(imports, /after_seq: String\(task\.eventSeq\)/)
})

test('copy and link imports both enter the background task pipeline', () => {
  const store = readFileSync(new URL('../store.tsx', import.meta.url), 'utf8')
  const handler = store.match(
    /importResourceFiles: async \(mode, sources\) => \{([\s\S]*?)\n    \},\n    resolveResourceImport:/
  )?.[1]
  assert.ok(handler)
  assert.match(handler, /createResourceImport\(mode, sources, targetDir, homeSelectedProjectId\)/)
  assert.doesNotMatch(handler, /importResources\(/)
})

test('resource refresh settles imports only after current external roots reach Electron', () => {
  const store = readFileSync(new URL('../store.tsx', import.meta.url), 'utf8')
  const handler = store.match(
    /reloadResourceTree: async \(expandedOverride\) => \{([\s\S]*?)\n    \},\n    toggleResourceDir:/
  )?.[1]
  assert.ok(handler)
  assert.match(handler, /Promise\.all\(\[/)
  assert.match(handler, /project \? listExternalRoots\(project\) : Promise\.resolve\(null\)/)
  assert.match(handler, /if \(!result \|\| \(project && !roots\)\) return false/)
})

test('English task progress uses singular and plural without changing progress values', () => {
  const translate = i18n.getFixedT('en', 'tasks')
  assert.equal(presentProgress(task({ phase: 'scanning', discoveredItems: 1 }), translate).label,
    'Scanning (1 item found)')
  assert.equal(presentProgress(task({ phase: 'scanning', discoveredItems: 2 }), translate).label,
    'Scanning (2 items found)')
  assert.deepEqual(presentProgress(task({ phase: 'copying', completedBytes: 64, totalBytes: 128 }), translate),
    { determinate: true, label: 'Copying 50%', value: 50 })
})

test('task titles translate at presentation without changing source names or raw titles', () => {
  const title = { key: 'title.copy' as const, names: ['研究.md', 'notes.txt'] }
  assert.equal(taskTitleText(title, i18n.getFixedT('zh', 'tasks')), '复制资料到项目 · 研究.md 等 2 项')
  assert.equal(taskTitleText(title, i18n.getFixedT('en', 'tasks')), 'Copy resources to project · 研究.md (2 items)')
  assert.deepEqual(title.names, ['研究.md', 'notes.txt'])
  assert.equal(taskTitleText('用户任务', i18n.getFixedT('en', 'tasks')), '用户任务')
})
