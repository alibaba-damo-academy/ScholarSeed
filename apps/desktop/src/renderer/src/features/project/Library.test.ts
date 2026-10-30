import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import { transformSync } from 'esbuild'
import { DEFAULT_PROJECT_LAYOUT } from '../../../../layout.ts'
import { PROJECT_GUIDE_ANCHORS } from '../../contracts/onboarding.ts'
import type { WorkbenchTab } from '../workbench/tabs.ts'

const compiled = transformSync(readFileSync(new URL('./Library.tsx', import.meta.url), 'utf8'), {
  loader: 'tsx',
  format: 'cjs',
  jsx: 'transform',
}).code

for (const modulePanelOpen of [false, true]) {
  for (const full of [false, true]) {
    test(`category navigation preserves layout with sidebar=${modulePanelOpen}, full=${full}`, () => {
      const initial = {
        activeTab: 'files',
        tabs: [{ id: 'files', kind: 'library', title: 'Files', closable: true }] as WorkbenchTab[],
        modulePanelOpen,
        workbenchLayout: {
          ...DEFAULT_PROJECT_LAYOUT,
          open: true,
          full,
          swapped: true,
          floating: 'expanded',
          conversationWidth: 420,
        },
      }
      let state = structuredClone(initial)
      let hook = 0
      const hooks: unknown[] = []
      let viewer = ''
      const dependencies: Record<string, unknown> = {
        react: {
          ...React,
          useState: (initialValue: unknown) => {
            const index = hook++
            if (!(index in hooks))
              hooks[index] = typeof initialValue === 'function' ? initialValue() : initialValue
            return [
              hooks[index],
              (value: unknown) => {
                hooks[index] = typeof value === 'function' ? value(hooks[index]) : value
              },
            ]
          },
        },
        'react-i18next': { useTranslation: () => ({ t: (key: string) => key }) },
        'lucide-react': { Folder: 'folder' },
        '../../contracts/onboarding': { PROJECT_GUIDE_ANCHORS },
        '../../app/composition': {
          featureRegistry: {
            viewers: {
              get: (kind: string) => {
                return {
                  render: ({ active }: { active: boolean }) => {
                    if (active) viewer = kind
                    return null
                  },
                }
              },
            },
          },
        },
        '../../components/business/Library': {
          LibraryToolbarTarget: React.createContext(null),
          LibrarySelectionChange: React.createContext(null),
        },
        '../../components/ui': Object.fromEntries(
          ['IconButton', 'Tabs', 'TabsContent', 'TabsList', 'TabsTrigger', 'Tooltip'].map(
            (name) => [name, name]
          )
        ),
        '../../store': {
          useApp: () => ({
            state,
            set: (patch: (current: typeof state) => Partial<typeof state>) => {
              state = { ...state, ...patch(state) }
            },
          }),
        },
        '../workbench/tabs': {
          openWorkbenchTab: () => [],
          projectExplorerTab: () => ({ id: 'explorer' }),
        },
      }
      const loaded = {
        exports: {} as {
          Library: (props: {
            tabId: string
          }) => React.ReactElement<{ onValueChange: (value: string) => void }>
        },
      }
      runInNewContext(compiled, {
        module: loaded,
        exports: loaded.exports,
        require: (name: string) => {
          assert.ok(name in dependencies, `Unexpected component dependency: ${name}`)
          return dependencies[name]
        },
      })
      for (const [nextCategory, expectedViewer] of [
        ['outputs', 'outputs'],
        ['literature', 'project-literature'],
        ['materials', 'material-list'],
        ['outputs', 'outputs'],
      ]) {
        hook = 0
        loaded.exports.Library({ tabId: 'files' }).props.onValueChange(nextCategory)
        hook = 0
        loaded.exports.Library({ tabId: 'files' })
        assert.equal(viewer, expectedViewer)
        assert.deepEqual(state.workbenchLayout, initial.workbenchLayout)
        assert.equal(state.modulePanelOpen, initial.modulePanelOpen)
        assert.equal(state.tabs[0].libraryCategory, nextCategory)
      }
    })
  }
}
