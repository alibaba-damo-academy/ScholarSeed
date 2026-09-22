import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance } from 'i18next'
import zh from '../../../../localization/locales/zh/resources.json' with { type: 'json' }
import en from '../../../../localization/locales/en/resources.json' with { type: 'json' }

import type { AssistantContextRef } from '../../contracts/assistant.ts'
import {
  beginResourceTreeReload,
  finishResourceTreeReload,
  isResourcePathAtOrBelow,
  deriveLinkOverlapTarget,
  deriveCoveredLinkRoots,
  linkMountNameFromSource,
  refreshesResourceTree,
  relocateExpandedResourcePaths,
  RESOURCE_ROOT_DIRECTORY,
  RESOURCE_TREE_ROOT,
  resourceNameParts,
  resourceDefaultName,
  resourceDropDirectory,
  resourceParentDirectory,
  transformResourceContextRefs,
  validateResourceMove
} from './lifecycle.ts'
import { INITIAL_RESOURCE_STATE, resourceStateForProjectSwitch, type ResourceLinkRoot, type ResourceNode } from './state.ts'

test('initial resource load and retry keep the foreground loading state', () => {
  const loading = beginResourceTreeReload(INITIAL_RESOURCE_STATE)
  assert.equal(loading.loadState, 'loading')
  const failed = finishResourceTreeReload(loading, null)
  assert.equal(failed.loadState, 'error')
  assert.equal(beginResourceTreeReload(failed).loadState, 'loading')
})

test('an already loaded empty tree refreshes without returning to foreground loading', () => {
  const ready = finishResourceTreeReload(INITIAL_RESOURCE_STATE, { nodes: [], total: 0, root: '/project' })
  const refreshing = beginResourceTreeReload(ready)
  assert.equal(refreshing.loadState, 'refreshing')
  assert.equal(refreshing.tree, ready.tree)
  assert.equal(beginResourceTreeReload(refreshing).loadState, 'refreshing')
  const complete = finishResourceTreeReload(refreshing, { nodes: [], total: 0, root: '/project' })
  assert.equal(complete.loadState, 'ready')
  assert.equal(complete.tree.length, 0)
})

test('failed background refresh retains the last successful snapshot and retries silently', () => {
  const nodes: ResourceNode[] = [{ path: 'note.md', name: 'note.md', kind: 'file' }]
  const ready = finishResourceTreeReload(INITIAL_RESOURCE_STATE, { nodes, total: 1, root: '/project' })
  const failed = finishResourceTreeReload(beginResourceTreeReload(ready), null)
  assert.equal(failed.loadState, 'ready')
  assert.equal(failed.tree, nodes)
  assert.equal(failed.rootTotal, 1)
  assert.equal(failed.root, '/project')
  assert.equal(beginResourceTreeReload(failed).loadState, 'refreshing')
  assert.equal(beginResourceTreeReload(resourceStateForProjectSwitch(failed)).loadState, 'loading')
})

test('background refresh publishes new data while preserving selection and expansion', () => {
  const ready = { ...INITIAL_RESOURCE_STATE, loadState: 'ready' as const, selected: 'folder', expanded: { folder: true } }
  const nodes: ResourceNode[] = [{ path: 'folder', name: 'folder', kind: 'dir' }]
  const complete = finishResourceTreeReload(beginResourceTreeReload(ready), { nodes, total: 1, root: '/project' })
  assert.equal(complete.loadState, 'ready')
  assert.equal(complete.tree, nodes)
  assert.equal(complete.selected, ready.selected)
  assert.equal(complete.expanded, ready.expanded)
})

const linkedRoot: ResourceLinkRoot = {
  rootId: 'root-1',
  mountPath: 'resources/关联资料',
  sourcePath: '/authorized/关联资料'
}

const otherLinkedRoot: ResourceLinkRoot = {
  rootId: 'root-2',
  mountPath: 'resources/另一个关联',
  sourcePath: '/authorized/另一个关联'
}

const tree: ResourceNode[] = [
  {
    path: 'resources/本地目录',
    name: '本地目录',
    kind: 'dir',
    children: [
      { path: 'resources/本地目录/报告.final.PDF', name: '报告.final.PDF', kind: 'file' },
      {
        path: 'resources/本地目录/子目录',
        name: '子目录',
        kind: 'dir',
        children: [{ path: 'resources/本地目录/子目录/深层.md', name: '深层.md', kind: 'file' }]
      }
    ]
  },
  { path: 'resources/目标', name: '目标', kind: 'dir' },
  {
    path: linkedRoot.mountPath,
    name: '关联资料',
    kind: 'dir',
    origin: 'link',
    linkRoot: linkedRoot,
    children: [
      {
        path: `${linkedRoot.mountPath}/文件.md`,
        name: '文件.md',
        kind: 'file',
        origin: 'link',
        linkRoot: linkedRoot
      },
      {
        path: `${linkedRoot.mountPath}/目录`,
        name: '目录',
        kind: 'dir',
        origin: 'link',
        linkRoot: linkedRoot
      }
    ]
  },
  {
    path: otherLinkedRoot.mountPath,
    name: '另一个关联',
    kind: 'dir',
    origin: 'link',
    linkRoot: otherLinkedRoot
  }
]

test('rename locks the final real suffix while directories and dotfiles remain whole', () => {
  assert.deepEqual(resourceNameParts('note.md', 'file'), { basename: 'note', suffix: '.md' })
  assert.deepEqual(resourceNameParts('report.final.PDF', 'file'), {
    basename: 'report.final',
    suffix: '.PDF'
  })
  assert.deepEqual(resourceNameParts('archive.tar.gz', 'file'), {
    basename: 'archive.tar',
    suffix: '.gz'
  })
  assert.deepEqual(resourceNameParts('.gitignore', 'file'), { basename: '.gitignore', suffix: '' })
  assert.deepEqual(resourceNameParts('name.', 'file'), { basename: 'name.', suffix: '' })
  assert.deepEqual(resourceNameParts('目录.with.dot', 'dir'), {
    basename: '目录.with.dot',
    suffix: ''
  })
})

test('move validation enforces roots, descendants and visible parents', () => {
  assert.deepEqual(validateResourceMove(tree, 'resources/本地目录/报告.final.PDF', 'resources/目标'), { ok: true })
  assert.deepEqual(
    validateResourceMove(tree, 'resources/本地目录/报告.final.PDF', RESOURCE_ROOT_DIRECTORY),
    { ok: true }
  )
  assert.deepEqual(
    validateResourceMove(tree, 'resources/目标', RESOURCE_ROOT_DIRECTORY),
    { ok: false, error: 'same_parent' }
  )
  assert.equal(validateResourceMove(tree, linkedRoot.mountPath, '').ok, false)
  assert.equal(validateResourceMove(tree, `${linkedRoot.mountPath}/文件.md`, 'resources/目标').ok, false)
  assert.equal(validateResourceMove(tree, `${linkedRoot.mountPath}/文件.md`, otherLinkedRoot.mountPath).ok, false)
  assert.deepEqual(
    validateResourceMove(tree, `${linkedRoot.mountPath}/文件.md`, `${linkedRoot.mountPath}/目录`),
    { ok: true }
  )
  assert.equal(
    validateResourceMove(tree, 'resources/本地目录', 'resources/本地目录/子目录').ok,
    false
  )
  assert.deepEqual(resourceParentDirectory(tree, 'resources/本地目录/子目录/深层.md'), 'resources/本地目录/子目录')
  assert.equal(resourceDropDirectory(tree, 'resources/目标', 'dir'), 'resources/目标')
  assert.equal(resourceDropDirectory(tree, 'resources/本地目录/报告.final.PDF', 'file'), 'resources/本地目录')
})

test('path transforms cover exact descendants without touching same-prefix siblings', () => {
  assert.equal(isResourcePathAtOrBelow('folder/file.md', 'folder'), true)
  assert.equal(isResourcePathAtOrBelow('folder-copy/file.md', 'folder'), false)
  assert.deepEqual(
    relocateExpandedResourcePaths(
      { folder: true, 'folder/child': true, 'folder-copy': true },
      'folder',
      'archive/folder'
    ),
    { 'archive/folder': true, 'archive/folder/child': true, 'folder-copy': true }
  )
})

test('current path refs relocate or clear while submitted and non-path refs stay immutable', () => {
  const refs: AssistantContextRef[] = [
    {
      ref_id: 'file',
      kind: 'file',
      source_id: 'folder/file.md',
      source_revision: 'old-sha',
      label: 'file.md',
      retention: 'session',
      origin: 'explicit'
    },
    {
      ref_id: 'child',
      kind: 'selection',
      source_id: 'folder/child.md',
      source_revision: 'old-sha',
      label: 'child.md',
      retention: 'next_turn',
      origin: 'current_document'
    },
    {
      ref_id: 'submitted',
      kind: 'dir',
      source_id: 'folder/submitted',
      label: 'submitted',
      retention: 'next_turn',
      origin: 'explicit'
    },
    {
      ref_id: 'resource',
      kind: 'resource',
      source_id: 'stable-resource-id',
      label: 'resource',
      retention: 'session',
      origin: 'explicit'
    }
  ]
  const moved = transformResourceContextRefs(refs, ['submitted'], 'folder', 'archive/folder')
  assert.equal(moved[0].source_id, 'archive/folder/file.md')
  assert.equal(moved[0].source_revision, null)
  assert.equal(moved[1].source_id, 'archive/folder/child.md')
  assert.equal(moved[2], refs[2])
  assert.equal(moved[3], refs[3])

  const removed = transformResourceContextRefs(refs, ['submitted'], 'folder', null)
  assert.deepEqual(removed.map((ref) => ref.ref_id), ['submitted', 'resource'])
})


test('new resource names use the creation language while existing drafts and rename names retain their bytes', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, resources: { zh: { resources: zh }, en: { resources: en } } })
  const t = locale.getFixedT(null, 'resources')
  const draft = { value: resourceDefaultName('create_document', t), suffix: '.md' }
  assert.equal(draft.value, '未命名')
  assert.equal(resourceDefaultName('create_folder', t), '未命名文件夹')
  draft.value = '用户修改 <original> & title'
  await locale.changeLanguage('en')
  assert.equal(resourceDefaultName('create_document', t), 'Untitled')
  assert.equal(resourceDefaultName('create_folder', t), 'Untitled folder')
  assert.deepEqual(draft, { value: '用户修改 <original> & title', suffix: '.md' })
  assert.deepEqual(resourceNameParts('未命名.final.MD', 'file'), { basename: '未命名.final', suffix: '.MD' })
  assert.deepEqual(resourceNameParts('未命名文件夹', 'dir'), { basename: '未命名文件夹', suffix: '' })
})

test('only resources-root content events refresh the resource tree', () => {
  assert.equal(RESOURCE_TREE_ROOT, 'resources')
  // The watcher broadcasts every watched root over one stream; sessions/ churn —
  // an Agent's private per-turn output dir — must not reload the resource panel.
  assert.equal(refreshesResourceTree({ root: 'resources' }), true)
  assert.equal(refreshesResourceTree({ root: 'sessions' }), false)
  assert.equal(refreshesResourceTree({ root: 'literature' }), false)
  assert.equal(refreshesResourceTree({ root: 'artifacts' }), false)
})

test('deriveLinkOverlapTarget maps a rejected source back to its covering link root', () => {
  // 源落在已生效关联根子树内 → 还原它在该挂载点下的相对位置。
  assert.equal(
    deriveLinkOverlapTarget(tree, ['/authorized/关联资料/子文件夹']),
    'resources/关联资料/子文件夹'
  )
  // 源正好等于关联根本身 → 定位到挂载点。
  assert.equal(deriveLinkOverlapTarget(tree, ['/authorized/关联资料']), 'resources/关联资料')
  // 源反过来包含了已生效关联根 → 定位到被包含的那个根 (按树序取第一个)。
  assert.equal(deriveLinkOverlapTarget(tree, ['/authorized']), 'resources/关联资料')
  // Windows 反斜杠来源同样能匹配 (规范化成正斜杠后比较)。
  assert.equal(
    deriveLinkOverlapTarget(tree, ['\\authorized\\关联资料\\子文件夹']),
    'resources/关联资料/子文件夹'
  )
  // 同前缀但不在子树内 (边界) → 不算覆盖。
  assert.equal(deriveLinkOverlapTarget(tree, ['/authorized/关联资料2']), null)
  // 完全不相交 → 推导不出, 调用方只弹提示不定位。
  assert.equal(deriveLinkOverlapTarget(tree, ['/elsewhere/x']), null)
  // 没有任何关联根时无从推导。
  assert.equal(deriveLinkOverlapTarget([], ['/authorized/关联资料/子文件夹']), null)
})

test('deriveCoveredLinkRoots finds child links strictly under a new parent source', () => {
  // 反方向: 新源 /authorized 是两个已生效关联根的父目录 → 两个子关联都被覆盖, 按树序去重。
  const covered = deriveCoveredLinkRoots(tree, ['/authorized'])
  assert.deepEqual(
    covered.map((item) => item.rootId),
    ['root-1', 'root-2']
  )
  assert.deepEqual(covered[0], {
    rootId: 'root-1',
    mountPath: 'resources/关联资料',
    sourcePath: '/authorized/关联资料',
    name: '关联资料'
  })
  // 同一关联根挂在父节点与其子节点上, seen 去重后只出现一次 (不是 4 条)。
  assert.equal(covered.length, 2)

  // 新源正好等于某个关联根 → 相等不算覆盖 (后端兜成 root_exists), 另一根也不在子树内。
  assert.deepEqual(deriveCoveredLinkRoots(tree, ['/authorized/关联资料']), [])
  // 正方向: 新源是关联根的子目录 → 关联根不是它的后代, 不算被覆盖。
  assert.deepEqual(deriveCoveredLinkRoots(tree, ['/authorized/关联资料/子文件夹']), [])
  // 同前缀但跨段边界 (关联 vs 关联资料) → 不算覆盖。
  assert.deepEqual(deriveCoveredLinkRoots(tree, ['/authorized/关联']), [])
  // Windows 反斜杠来源规范化后同样命中。
  assert.deepEqual(
    deriveCoveredLinkRoots(tree, ['\\authorized']).map((item) => item.rootId),
    ['root-1', 'root-2']
  )
  // 没有源 / 没有关联根 → 空数组, 调用方退回普通报错。
  assert.deepEqual(deriveCoveredLinkRoots(tree, []), [])
  assert.deepEqual(deriveCoveredLinkRoots([], ['/authorized']), [])
})

test('linkMountNameFromSource takes the last path segment regardless of separator', () => {
  assert.equal(linkMountNameFromSource('/authorized/关联资料'), '关联资料')
  assert.equal(linkMountNameFromSource('\\authorized\\关联资料'), '关联资料')
  assert.equal(linkMountNameFromSource('/authorized/关联资料/'), '关联资料')
  assert.equal(linkMountNameFromSource('关联资料'), '关联资料')
  assert.equal(linkMountNameFromSource(''), '')
})
