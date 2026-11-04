import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder } from 'lucide-react'

import { featureRegistry } from '../../app/composition'
import { LibrarySelectionChange, LibraryToolbarTarget } from '../../components/business/Library'
import { IconButton, Tabs, TabsContent, TabsList, TabsTrigger, Tooltip } from '../../components/ui'
import { useApp } from '../../store'
import { newProjectTab, projectExplorerTab } from '../workbench/tabs'
import { useWorkspaceController } from '../workbench/workspace'
import { PROJECT_GUIDE_ANCHORS } from '../../contracts/onboarding'

export function Library({ tabId }: { tabId?: string }): React.JSX.Element {
  const { t } = useTranslation('layout')
  const { state, set } = useApp()
  const workspace = useWorkspaceController()
  const targetTabId = tabId ?? state.activeTab
  const category = state.tabs.find((tab) => tab.id === targetTabId)?.libraryCategory ?? 'materials'
  const [visited, setVisited] = useState(() => new Set(['materials']))
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null)
  const [selectionActive, setSelectionActive] = useState(false)
  const selectCategory = (value: string): void => {
    if (value !== 'materials' && value !== 'literature' && value !== 'outputs') return
    setVisited((current) => new Set([...current, value]))
    setSelectionActive(false)
    set((current) => ({
      tabs: current.tabs.map((tab) =>
        tab.id === targetTabId ? { ...tab, libraryCategory: value } : tab
      ),
    }))
  }
  const openExplorer = (): void => {
    const localIds = workspace.pageTabsInLeaf(targetTabId)
    const existing = state.tabs.find((tab) => tab.kind === 'explorer' && localIds.includes(tab.id))
    if (existing) {
      set({ activeTab: existing.id })
      return
    }
    const tab = {
      ...projectExplorerTab(state.homeSelectedProjectId, t('explorer')),
      id: newProjectTab(state.homeSelectedProjectId).id,
    }
    if (!workspace.openPageTab(tab.id, workspace.tabLocation(targetTabId)?.leafId)) return
    set((current) => ({ activeTab: tab.id, tabs: [...current.tabs, tab] }))
  }
  return (
    <Tabs
      value={category}
      onValueChange={selectCategory}
      className="!flex h-full min-h-0 flex-col !gap-0"
      data-testid="project-library-content"
    >
      <div
        data-testid="project-library-toolbar-actions"
        data-library-toolbar-viewport
        className="min-h-[var(--vds-library-toolbar-height)] w-full shrink-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden border-b border-[var(--vds-divider-default)] bg-transparent px-[var(--vds-space-4)] py-[var(--vds-space-2)]"
      >
        <div className="flex w-full min-w-max items-center gap-[var(--vds-space-2)]">
          <TabsList data-ob={PROJECT_GUIDE_ANCHORS.categories} className="shrink-0">
            <TabsTrigger data-ob={PROJECT_GUIDE_ANCHORS.materialsTab} value="materials">
              {t('materials')}
            </TabsTrigger>
            <TabsTrigger data-ob={PROJECT_GUIDE_ANCHORS.literatureTab} value="literature">
              {t('papers')}
            </TabsTrigger>
            <TabsTrigger data-ob={PROJECT_GUIDE_ANCHORS.outputsTab} value="outputs">
              {t('outputs')}
            </TabsTrigger>
          </TabsList>
          <div className="flex min-w-max flex-1 items-center gap-[var(--vds-space-1)]">
            <div ref={setToolbarTarget} className="flex min-w-max flex-1 justify-end" />
            {!selectionActive && (
              <Tooltip content={t('explorer')} portalled side="bottom">
                <IconButton
                  data-testid="project-library-explorer"
                  variant="ghost"
                  size="md"
                  className="!text-[var(--vds-icon-outline-default)]"
                  label={t('explorer')}
                  title={undefined}
                  icon={<Folder />}
                  onClick={openExplorer}
                />
              </Tooltip>
            )}
          </div>
        </div>
      </div>
      {[...new Set([...visited, category])].map((value) => (
        <TabsContent
          key={value}
          value={value}
          data-ob={
            value === 'materials'
              ? PROJECT_GUIDE_ANCHORS.materials
              : value === 'literature'
                ? PROJECT_GUIDE_ANCHORS.literature
                : undefined
          }
          className={category === value ? 'min-h-0 flex-1 overflow-hidden' : 'hidden'}
        >
          <LibraryToolbarTarget.Provider value={category === value ? toolbarTarget : null}>
            <LibrarySelectionChange.Provider value={category === value ? setSelectionActive : null}>
              {featureRegistry.viewers
                .get(
                  value === 'materials'
                    ? 'material-list'
                    : value === 'literature'
                      ? 'project-literature'
                      : 'outputs'
                )
                ?.render({ active: category === value, path: value })}
            </LibrarySelectionChange.Provider>
          </LibraryToolbarTarget.Provider>
        </TabsContent>
      ))}
    </Tabs>
  )
}
