import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import { transformSync } from 'esbuild'

const compiled = transformSync(readFileSync(new URL('./Explorer.tsx', import.meta.url), 'utf8'), {
  loader: 'tsx',
  format: 'cjs',
  jsx: 'transform',
}).code

interface ElementProps {
  [name: string]: unknown
  children: React.ReactNode
  className: string
  leftPanel: Element
  rightPanel: Element
  creation: { row: Element; parent: string }
  expanded: Set<string>
  icon: Element
  onChange: (event: { target: { value: string } }) => void
  onKeyDown: (event: {
    key: string
    nativeEvent: { isComposing: boolean }
    preventDefault: () => void
  }) => void | Promise<void>
  onBlur: () => void | Promise<void>
  onClick: () => void | Promise<void>
  onSelect: (item?: Record<string, unknown>) => void | Promise<void>
  onMenu: (item: Record<string, unknown>, left: number, top: number) => void
}

type Element = React.ReactElement<ElementProps>

function descendants(element: Element): Element[] {
  return [
    element,
    ...React.Children.toArray(element.props.children).flatMap((child) =>
      React.isValidElement<ElementProps>(child) ? descendants(child as Element) : []
    ),
  ]
}

test('explorer creates entries on blur or Enter and cancels only empty drafts or Escape', async () => {
  let cursor = 0
  let refCursor = 0
  const hooks: unknown[] = []
  const refs: { current: unknown }[] = []
  const opened: string[] = []
  const previews: unknown[][] = []
  const revealed: string[] = []
  const mutations: { action: string; payload: unknown }[] = []
  const toasts: { title: string; description?: string; tone: string }[] = []
  let failMutation = false
  const imports: { project: string; sources: string[]; target: string }[] = []
  const pickerTargets: string[] = []
  let pickedSources = ['/fixture/import.md']
  const project = { id: 'toolbar-project', name: 'Research', path: '/research' }
  const documents = {
    tabs: { document: { id: 'document', sessionId: 'session' } },
    sessions: { session: { source: { kind: 'project', path: 'tasks/report.md' } } },
  }
  const dependencies: Record<string, unknown> = {
    react: {
      ...React,
      useCallback: (callback: unknown) => callback,
      useEffect: () => undefined,
      useLayoutEffect: () => undefined,
      useRef: (current: unknown) => {
        const index = refCursor++
        refs[index] ??= { current }
        return refs[index]
      },
      useState: (initial: unknown) => {
        const index = cursor++
        if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
        if (index === 5) hooks[index] = 'document'
        return [
          hooks[index],
          (value: unknown) => {
            hooks[index] = typeof value === 'function' ? value(hooks[index]) : value
          },
        ]
      },
    },
    'react-i18next': { useTranslation: () => ({ t: (key: string) => key }) },
    'lucide-react': new Proxy({}, { get: (_target, name) => String(name) }),
    '../../assets/finder.svg': { default: 'finder.svg' },
    '../../api': {
      revealSystemPath: async (path: string) => {
        revealed.push(path)
        return { ok: true }
      },
    },
    '../../../../picker': { IMPORT_PICKER_TARGET: { FILE: 'file' } },
    '../../components/ui': new Proxy(
      { useToast: () => ({ toast: (value: (typeof toasts)[number]) => toasts.push(value) }) },
      {
        get: (target, name) =>
          name in target ? target[name as keyof typeof target] : String(name),
      }
    ),
    '../../fileOpen': { revealLabelKey: () => 'reveal' },
    '../../store': {
      selectedProject: () => project,
      useApp: () => ({
        state: { resource: {} },
        act: { activateTab: (id: string) => opened.push(id) },
      }),
    },
    '../resources/api': {
      resolveRevealTarget: async (path: string, projectId: string) => {
        assert.equal(projectId, project.id)
        return { ok: true, absolute: `${project.path}/${path}` }
      },
    },
    '../resources/icons': {},
    '../resources/state': { resourceNameError: () => null },
    '../../drag': {},
    '../workbench/feature': { DocumentView: 'DocumentView' },
    '../workbench/workspace': {
      useDocumentWorkspace: () => documents,
      useWorkspaceController: () => ({
        open: async (...args: unknown[]) => {
          previews.push(args)
          return 'document'
        },
        setTabEmbedded: (id: string, embedded: boolean) => {
          assert.equal(id, 'document')
          assert.equal(embedded, false)
        },
      }),
    },
    './events': {},
    './api': {
      importProjectFiles: async (project: string, sources: string[], target: string) => {
        imports.push({ project, sources, target })
        return { ok: true }
      },
      mutateProjectNode: async (_project: string, action: string, payload: unknown) => {
        mutations.push({ action, payload: structuredClone(payload) })
        if (failMutation) return { ok: false, error: 'already_exists' }
        return { ok: true, node: { path: 'tasks/new-folder', name: 'new-folder', kind: 'dir' } }
      },
    },
  }
  const loaded = { exports: {} as { Explorer: () => Element } }
  runInNewContext(compiled, {
    module: loaded,
    exports: loaded.exports,
    window: {
      scholarseed: {
        platform: 'darwin',
        pickImport: async (target: string) => {
          pickerTargets.push(target)
          return pickedSources
        },
      },
    },
    require: (name: string) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
      return dependencies[name]
    },
  })
  const render = (): Element => {
    cursor = 0
    refCursor = 0
    return loaded.exports.Explorer()
  }
  for (const collapsed of [false, true, false]) {
    const surface = render()
    const toolbar = React.Children.toArray(surface.props.children).find(
      (child) => React.isValidElement<ElementProps>(child) && child.type === 'header'
    ) as Element | undefined
    assert.ok(toolbar, 'toolbar must be a direct child above the split panels')
    const controls = descendants(toolbar)
    const toggle = controls.find((child) => child.props['data-testid'] === 'explorer-toggle-tree')!
    assert.ok(toggle, 'tree toggle belongs in the top toolbar')
    const tooltip = controls.find((child) => child.type === 'Tooltip')
    assert.ok(tooltip, 'tree toggle exposes a tooltip')
    assert.equal(tooltip.props.content, collapsed ? 'explorerExpandTree' : 'explorerHideTree')
    assert.equal((tooltip.props.children as Element).props, toggle.props)
    assert.equal(toggle.props.title, '')
    assert.equal(toggle.props['aria-expanded'], !collapsed)
    assert.equal(toggle.props['aria-pressed'], !collapsed)
    const split = descendants(surface).find((child) => child.type === 'ResizablePanel')!
    const tree = split.props.leftPanel as Element
    assert.ok(tree.props.className.includes('bg-[var(--vds-bg-gray-default)]'))
    assert.equal(tree.props.className.split(' ').includes('border-r'), false)
    assert.ok(tree.props.className.includes('px-[var(--vds-space-3)]'))
    assert.ok(tree.props.className.includes('py-[var(--vds-space-4)]'))
    const treeHeader = descendants(tree).find((child) => child.type === 'header')!
    assert.equal(treeHeader.props.className.split(' ').includes('border-b'), false)
    const root = descendants(tree).find((child) => child.props['data-testid'] === 'explorer-root')!
    assert.equal(
      descendants(root).some((child) => child.type === 'FolderOpen'),
      true
    )
    assert.equal(split.props.isLeftCollapsed, collapsed)
    assert.equal(
      descendants(split.props.rightPanel).some((child) => child.type === 'header'),
      false
    )
    assert.ok(descendants(split.props.rightPanel).some((child) => child.type === 'DocumentView'))
    assert.equal(
      descendants(split.props.rightPanel).find((child) => child.type === 'DocumentView')!.props
        .showBreadcrumb,
      false
    )
    assert.deepEqual(
      controls
        .filter((child) => child.type === 'BreadcrumbPage')
        .map((child) => child.props.children),
      ['report.md', 'report.md']
    )
    for (const action of ['explorer-open-tab', 'explorer-reveal-file'])
      assert.ok(controls.some((child) => child.props['data-testid'] === action))
    const primary = controls.find(
      (child) => child.props['data-testid'] === 'explorer-open-primary'
    )!
    assert.ok(primary, 'opening uses a primary action and a separate menu trigger')
    assert.equal(primary.props.size, 'sm')
    assert.equal(primary.props.className, '[--vds-icon-button-glyph:var(--vds-icon-7)]')
    const openMenu = controls.find((child) => child.props['data-testid'] === 'explorer-open-menu')!
    assert.equal(openMenu.props.size, 'sm')
    assert.equal(openMenu.props.className, primary.props.className)
    assert.equal(primary.props.label, 'reveal')
    const choices = controls.filter((child) => child.props.role === 'menuitemradio')
    assert.deepEqual(
      choices.map((child) => child.props['aria-checked']),
      [true, false]
    )
    const openedBeforeSelection = opened.length
    choices[1].props.onSelect()
    const savedExplorerState = refs.find(
      (reference) =>
        reference.current !== null &&
        typeof reference.current === 'object' &&
        'openInTab' in reference.current
    )!
    assert.equal((savedExplorerState.current as { openInTab: boolean }).openInTab, true)
    assert.equal(opened.length, openedBeforeSelection + 1)
    assert.equal(opened.at(-1), 'document')
    const updated = descendants(render())
    assert.equal(
      updated.find((child) => child.props['data-testid'] === 'explorer-open-primary')!.props.label,
      'explorerOpenInTab'
    )
    const openedBefore = opened.length
    updated.find((child) => child.props['data-testid'] === 'explorer-open-primary')!.props.onClick()
    assert.equal(opened.length, openedBefore + 1)
    assert.equal(opened.at(-1), 'document')
    const revealedBefore = revealed.length
    updated.find((child) => child.props['data-testid'] === 'explorer-reveal-file')!.props.onSelect()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(revealed.length, revealedBefore + 1)
    assert.equal(revealed.at(-1), '/research/tasks/report.md')
    toggle.props.onClick()
  }
  const treeControls = (): Element[] => {
    const split = descendants(render()).find((child) => child.type === 'ResizablePanel')!
    return descendants(split.props.leftPanel)
  }
  const start = (kind: string): void => {
    treeControls()
      .find((child) => child.props['data-testid'] === kind)!
      .props.onClick()
  }
  const directory = (): Element =>
    treeControls().find((child) => child.props.project === project.id && child.props.path === '')!
  const editor = (): Element =>
    descendants(directory().props.creation.row).find((child) => child.type === 'Input')!
  directory().props.onSelect({
    path: 'tasks/report.md',
    name: 'report.md',
    kind: 'file',
    available: true,
  })
  await Promise.resolve()
  assert.equal(previews.length, 1)
  assert.equal(
    JSON.stringify(previews[0]),
    JSON.stringify([
      { kind: 'project', project: project.id, path: 'tasks/report.md' },
      'preview',
      'report.md',
      undefined,
      undefined,
      { embedded: true },
    ])
  )
  directory().props.onSelect({ path: 'tasks', name: 'tasks', kind: 'dir', available: true })
  const breadcrumb = descendants(render()).find((child) => child.type === 'Breadcrumb')!
  assert.equal(breadcrumb.props.title, 'tasks/report.md')
  assert.ok(
    descendants(breadcrumb).some(
      (child) => child.type === 'BreadcrumbPage' && child.props.children === 'report.md'
    )
  )
  start('explorer-new-folder')
  assert.equal(directory().props.creation.parent, '')
  assert.equal(editor().props.autoFocus, true)
  assert.equal(descendants(render()).find((child) => child.type === 'Dialog')!.props.open, false)
  editor().props.onChange({ target: { value: 'new-folder' } })
  await editor().props.onKeyDown({
    key: 'Enter',
    nativeEvent: { isComposing: true },
    preventDefault() {},
  })
  assert.equal(mutations.length, 0)
  const escaped = editor()
  escaped.props.onKeyDown({
    key: 'Escape',
    nativeEvent: { isComposing: false },
    preventDefault() {},
  })
  await escaped.props.onBlur()
  assert.equal(directory().props.creation, undefined)
  assert.equal(mutations.length, 0)
  start('explorer-new-markdown')
  await editor().props.onBlur()
  assert.equal(directory().props.creation, undefined)
  assert.equal(mutations.length, 0)
  start('explorer-new-folder')
  editor().props.onChange({ target: { value: 'new-folder' } })
  const folderEntry = editor()
  await Promise.all([folderEntry.props.onBlur(), folderEntry.props.onBlur()])
  await folderEntry.props.onBlur()
  assert.deepEqual(mutations, [
    { action: 'create_folder', payload: { parent: '', name: 'new-folder' } },
  ])
  assert.equal(directory().props.creation, undefined)
  directory().props.onMenu(
    { path: 'tasks/report.md', name: 'report.md', kind: 'file', available: true },
    0,
    0
  )
  start('explorer-new-markdown')
  assert.equal(directory().props.creation.parent, '')
  editor().props.onChange({ target: { value: 'report' } })
  const entry = editor()
  const enter = { key: 'Enter', nativeEvent: { isComposing: false }, preventDefault() {} }
  await Promise.all([entry.props.onKeyDown(enter), entry.props.onBlur()])
  await entry.props.onBlur()
  assert.equal(mutations.length, 2)
  assert.deepEqual(mutations[1], {
    action: 'create_document',
    payload: { parent: '', name: 'report.md' },
  })
  start('explorer-new-folder')
  editor().props.onChange({ target: { value: 'retry-folder' } })
  failMutation = true
  await editor().props.onBlur()
  assert.equal(editor().props.value, 'retry-folder')
  assert.equal(toasts.at(-1)?.tone, 'error')
  assert.equal(toasts.at(-1)?.description, 'already_exists')
  failMutation = false
  await editor().props.onKeyDown(enter)
  assert.equal(directory().props.creation, undefined)
  assert.equal(mutations.length, 4)
  start('explorer-new-markdown')
  editor().props.onChange({ target: { value: 'blur-note' } })
  await editor().props.onBlur()
  assert.equal(directory().props.creation, undefined)
  assert.deepEqual(mutations[4], {
    action: 'create_document',
    payload: { parent: '', name: 'blur-note.md' },
  })
  for (const [label, action, name] of [
    ['explorerNewFolder', 'create_folder', 'nested-folder'],
    ['explorerNewMarkdown', 'create_document', 'nested-note.md'],
  ]) {
    directory().props.onMenu(
      { path: 'tasks/nested', name: 'nested', kind: 'dir', available: true },
      0,
      0
    )
    const menu = descendants(render()).find(
      (child) => child.props['data-testid'] === 'explorer-menu'
    )!
    const create = descendants(menu).find(
      (child) =>
        child.type === 'DropdownMenuItem' &&
        React.Children.toArray(child.props.children).includes(label)
    )!
    create.props.onSelect()
    assert.equal(directory().props.creation.parent, 'tasks/nested')
    assert.equal(directory().props.expanded.has('tasks/nested'), true)
    editor().props.onChange({ target: { value: name } })
    await editor().props.onBlur()
    assert.deepEqual(mutations.at(-1), { action, payload: { parent: 'tasks/nested', name } })
  }
  const importButton = (): Element =>
    treeControls().find((child) => child.props['data-testid'] === 'explorer-import')!
  assert.equal(importButton().props.icon.type, 'ArrowDownToLine')
  assert.equal(importButton().props.icon.props.strokeWidth, 1.5)
  directory().props.onMenu(
    { path: 'tasks/report.md', name: 'report.md', kind: 'file', available: true },
    0,
    0
  )
  const upload = importButton()
  await Promise.all([upload.props.onClick(), upload.props.onClick()])
  assert.deepEqual(imports, [{ project: project.id, sources: pickedSources, target: '' }])
  assert.deepEqual(pickerTargets, ['file'])
  assert.equal(
    descendants(render()).some((child) => child.props['data-testid'] === 'explorer-import-dialog'),
    false
  )
  const folder = { path: 'tasks/nested', name: 'nested', kind: 'dir', available: true }
  directory().props.onMenu(folder, 0, 0)
  const menu = descendants(render()).find(
    (child) => child.props['data-testid'] === 'explorer-menu'
  )!
  const menuImport = descendants(menu).find(
    (child) =>
      child.type === 'DropdownMenuItem' &&
      React.Children.toArray(child.props.children).includes('explorerImport')
  )!
  const menuIcon = React.Children.toArray(menuImport.props.children)[0] as Element
  assert.equal(menuIcon.type, 'ArrowDownToLine')
  assert.equal(menuIcon.props.strokeWidth, 1.5)
  await menuImport.props.onSelect()
  assert.equal(imports.at(-1)?.target, 'tasks/nested')
  await importButton().props.onClick()
  assert.equal(imports.at(-1)?.target, '')
  pickedSources = []
  await importButton().props.onClick()
  assert.equal(imports.length, 3)
})
