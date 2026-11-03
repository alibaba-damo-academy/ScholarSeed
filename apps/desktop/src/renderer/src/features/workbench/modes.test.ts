import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import { transformSync } from 'esbuild'

type Element = React.ReactElement<
  React.PropsWithChildren<Record<string, unknown>> & {
    className: string
    onValueChange: (value: string) => void
  }
>

test('Markdown retains only the visited source runtime across mode switches', () => {
  const source = readFileSync(new URL('./MarkdownDocument.tsx', import.meta.url), 'utf8')
  const document = source.slice(source.indexOf('export function MarkdownDocument('))
  const compiled = transformSync(`${document}\nmodule.exports = MarkdownDocument`, {
    loader: 'tsx',
    format: 'cjs',
    jsx: 'transform',
  }).code
  const state: unknown[] = []
  let cursor = 0
  let effects: (() => void)[] = []
  const session = { loadState: 'ready', text: '# Content', capabilities: { can_edit: true } }
  const loaded = { exports: undefined as unknown as (props: Record<string, unknown>) => Element }
  runInNewContext(compiled, {
    React,
    module: loaded,
    useState: (initial: unknown) => {
      const index = cursor++
      if (!(index in state)) state[index] = initial
      return [
        state[index],
        (value: unknown) => {
          state[index] = value
        },
      ]
    },
    useEffect: (effect: () => void) => effects.push(effect),
    useTranslation: () => ({ t: (key: string) => key }),
    useApp: () => ({ state: { editorRuntimeRevision: 0 } }),
    useDocumentWorkspace: () => ({ sessions: { document: session, other: session } }),
    useWorkspaceController: () => ({ setTabView: () => undefined }),
    MarkdownHeader: 'MarkdownHeader',
    MonacoDocument: 'MonacoDocument',
    MarkdownVisualEditor: 'MarkdownVisualEditor',
  })
  const render = (viewKind: string, sessionId = 'document'): Element[] => {
    cursor = 0
    effects = []
    const result = descendants(loaded.exports({ sessionId, tabId: 'tab', viewKind }))
    for (const effect of effects) effect()
    return result
  }
  assert.equal(
    render('preview').some((element) => element.type === 'MonacoDocument'),
    false
  )
  const first = render('source').find((element) => element.type === 'MonacoDocument')!
  for (const mode of ['preview', 'edit']) {
    const result = render(mode)
    const retained = result.find((element) => element.type === 'MonacoDocument')!
    assert.ok(retained, 'mode switches must not destroy the loaded Monaco iframe')
    assert.equal(retained.key, first.key)
    assert.equal(retained.props.active, false)
    assert.equal(
      result.find((element) => element.props['data-testid'] === 'markdown-source-editor')!.props
        .hidden,
      true
    )
  }
  assert.equal(
    render('source').find((element) => element.type === 'MonacoDocument')!.props.active,
    true
  )
  assert.equal(
    render('preview', 'other').some((element) => element.type === 'MonacoDocument'),
    false
  )
})

function descendants(element: Element): Element[] {
  return [
    element,
    ...React.Children.toArray(element.props.children).flatMap((child) =>
      React.isValidElement(child) ? descendants(child as Element) : []
    ),
  ]
}

test('Markdown mode Select preserves mode values, option order and editing restrictions', () => {
  const source = readFileSync(new URL('./MarkdownDocument.tsx', import.meta.url), 'utf8')
  const header = source.slice(
    source.indexOf('function MarkdownHeader('),
    source.indexOf('function MarkdownVisualEditor(')
  )
  const compiled = transformSync(`${header}\nmodule.exports = MarkdownHeader`, {
    loader: 'tsx',
    format: 'cjs',
    jsx: 'transform',
  }).code
  const labels = JSON.parse(
    readFileSync(
      new URL('../../../../localization/locales/zh/workbench.json', import.meta.url),
      'utf8'
    )
  ).markdown
  const session = { lightweightText: false, saveState: 'clean' }
  const switched: string[] = []
  const portalled: { control: Element; host: unknown }[] = []
  const loaded = { exports: undefined as unknown as (props: Record<string, unknown>) => Element }
  const controls = [
    'Select',
    'SelectTrigger',
    'SelectValue',
    'SelectContent',
    'SelectItem',
    'Tabs',
    'TabsList',
    'TabsTrigger',
  ]
  runInNewContext(compiled, {
    React,
    module: loaded,
    createPortal: (control: Element, host: unknown) => {
      portalled.push({ control, host })
      return null
    },
    ...Object.fromEntries(controls.map((name) => [name, name])),
    useTranslation: () => ({ t: (key: string) => labels[key.split('.').at(-1)!] ?? key }),
    useDocumentWorkspace: () => ({ sessions: { document: session } }),
    useWorkspaceController: () => ({
      setTabView: (_tab: string, mode: string) => switched.push(mode),
    }),
  })
  const render = (viewKind: string, visualDisabled = false): Element[] =>
    descendants(
      loaded.exports({
        sessionId: 'document',
        tabId: 'tab',
        viewKind,
        visualDisabled,
        editorActions: null,
      })
    )
  for (const mode of ['source', 'edit', 'preview']) {
    const rendered = render(mode)
    const select = rendered.find((child) => child.type === 'Select')!
    assert.ok(select)
    assert.equal(select.props.value, mode)
    assert.equal(select.props.size, 'md')
    const trigger = rendered.find((child) => child.type === 'SelectTrigger')!
    assert.equal(rendered.find((child) => child.type === 'SelectContent')!.props.align, 'end')
    for (const token of [
      '--vds-control-height-md',
      '--vds-control-label-line-height',
      '--vds-text-tertiary',
      '--vds-divider-default',
    ])
      assert.ok(trigger.props.className.includes(token))
    const options = rendered.filter((child) => child.type === 'SelectItem')
    assert.deepEqual(
      options.map((option) => option.props.value),
      ['preview', 'edit', 'source']
    )
    assert.deepEqual(
      options.map((option) => option.props.children),
      ['只读模式', '编辑模式', '源码']
    )
    select.props.onValueChange(mode)
  }
  assert.deepEqual(switched, ['source', 'edit', 'preview'])
  const restricted = render('preview', true)
  assert.equal(restricted.find((child) => child.props.value === 'edit')!.props.disabled, true)
  restricted.find((child) => child.type === 'Select')!.props.onValueChange('edit')
  assert.equal(switched.length, 3)
  const modeControlHost = {}
  const hosted = descendants(
    loaded.exports({
      sessionId: 'document',
      tabId: 'tab',
      viewKind: 'preview',
      visualDisabled: false,
      editorActions: null,
      modeControlHost,
    })
  )
  assert.equal(
    hosted.some((child) => child.type === 'Select'),
    false
  )
  assert.equal(portalled.length, 1)
  assert.equal(portalled[0].host, modeControlHost)
  assert.equal(portalled[0].control.type, 'Select')
  assert.equal(portalled[0].control.props.value, 'preview')
  session.lightweightText = true
  assert.equal(
    render('source', true).find((child) => child.props.value === 'preview')!.props.disabled,
    true
  )
})
