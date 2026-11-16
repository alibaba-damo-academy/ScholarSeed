import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import { transformSync } from 'esbuild'

const compiled = transformSync(readFileSync(new URL('./NewTab.tsx', import.meta.url), 'utf8'), {
  loader: 'tsx',
  format: 'cjs',
  jsx: 'transform',
}).code

for (const browserEnabled of [true, false]) {
  test(`new tab selections preserve pane scope and product availability: ${browserEnabled}`, () => {
    const calls: unknown[][] = []
    const tabs: unknown[] = []
    const updates: unknown[] = []
    const paneTabIds = ['new-tab', 'same-pane-tab']
    const paneRequests: string[] = []
    const dependencies: Record<string, unknown> = {
      react: React,
      'react-i18next': { useTranslation: () => ({ t: (key: string) => key }) },
      'lucide-react': {
        ChevronRight: 'chevron',
        FolderTree: 'tree',
        Folders: 'folders',
        Globe: 'globe',
      },
      '../../components/ui': { Button: 'button' },
      '../../app/policy': { availabilityPolicy: { browserEnabled } },
      '../../store': {
        useApp: () => ({
          set: (update: (current: { tabs: unknown[] }) => unknown) =>
            updates.push(update({ tabs })),
          act: {
            openWorkbenchView: () => assert.fail('project tab must not replace the global view'),
          },
        }),
      },
      '../workbench/tabs': {
        resolveProjectTabSelection: (...args: unknown[]) => {
          calls.push(args)
          return { tabs }
        },
      },
      '../workbench/workspace': {
        useWorkspaceController: () => ({
          pageTabsInLeaf: (tabId: string) => {
            paneRequests.push(tabId)
            return paneTabIds
          },
        }),
      },
    }
    const loaded = { exports: {} as { NewTab: (props: { tabId?: string }) => React.ReactNode } }
    runInNewContext(compiled, {
      module: loaded,
      exports: loaded.exports,
      require: (name: string) => {
        assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
        return dependencies[name]
      },
    })
    const buttons: React.ReactElement<{ children?: React.ReactNode; onClick: () => void }>[] = []
    const visit = (node: React.ReactNode): void => {
      React.Children.forEach(node, (child) => {
        if (!React.isValidElement<{ children?: React.ReactNode; onClick: () => void }>(child))
          return
        if (child.type === 'button') buttons.push(child)
        visit(child.props.children)
      })
    }
    visit(loaded.exports.NewTab({ tabId: 'new-tab' }))
    assert.equal(buttons.length, browserEnabled ? 3 : 2)
    const kinds = browserEnabled ? ['library', 'explorer', 'browser'] : ['library', 'explorer']
    for (const [index, kind] of kinds.entries()) {
      buttons[index].props.onClick()
      assert.equal(calls.length, index + 1)
      assert.equal(calls[index][0], tabs)
      assert.equal(calls[index][1], 'new-tab')
      assert.equal(calls[index][2], kind)
      assert.equal(calls[index][3], paneTabIds)
      assert.equal(paneRequests[index], 'new-tab')
      assert.equal(updates.length, index + 1)
      assert.equal((updates[index] as { tabs: unknown[] }).tabs, tabs)
    }
    assert.equal(paneRequests.length, kinds.length)
    calls.length = 0
    updates.length = 0
    paneRequests.length = 0
    buttons.length = 0
    visit(loaded.exports.NewTab({}))
    assert.equal(buttons.length, kinds.length)
    for (const button of buttons) button.props.onClick()
    assert.deepEqual(calls, [])
    assert.deepEqual(updates, [])
    assert.deepEqual(paneRequests, [])
  })
}
