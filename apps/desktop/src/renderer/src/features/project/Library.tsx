import React, { useLayoutEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderTree } from 'lucide-react'

import { featureRegistry } from '../../app/composition'
import {
  LibraryAction,
  LibrarySelectionChange,
  LibraryToolbarTarget,
  LibraryToolbarTrailing,
} from '../../components/business/Library'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../components/ui'
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
  const [toolbarViewport, setToolbarViewport] = useState<HTMLDivElement | null>(null)
  const [compactNavigation, setCompactNavigation] = useState(true)
  useLayoutEffect(() => {
    if (!toolbarViewport) return
    const measure = (): void => {
      const style = getComputedStyle(toolbarViewport)
      const width = toolbarViewport.clientWidth
      setCompactNavigation(
        width < parseFloat(style.getPropertyValue('--vds-library-toolbar-tabs-min-width'))
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(toolbarViewport)
    measure()
    return () => observer.disconnect()
  }, [toolbarViewport])
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
  const explorer = selectionActive ? null : (
    <>
      <span
        aria-hidden="true"
        data-testid="project-library-explorer-divider"
        className="h-[var(--vds-space-4)] w-[var(--vds-border-width-1)] bg-[var(--vds-divider-default)]"
      />
      <LibraryAction
        data-testid="project-library-explorer"
        variant="outline"
        size="md"
        label={t('explorer')}
        showChevron={false}
        icon={<FolderTree aria-hidden="true" />}
        onClick={openExplorer}
      />
    </>
  )
  return (
    <Tabs
      value={category}
      onValueChange={selectCategory}
      className="!flex h-full min-h-0 flex-col !gap-0"
      data-testid="project-library-content"
    >
      <div
        ref={setToolbarViewport}
        data-testid="project-library-toolbar-actions"
        className="flex min-h-[var(--vds-library-toolbar-height)] w-full min-w-0 shrink-0 items-center gap-[var(--vds-space-1)] border-b border-[var(--vds-divider-default)] bg-transparent px-[var(--vds-library-toolbar-padding-inline)] py-[var(--vds-space-2)]"
      >
        <div className="flex min-w-0 flex-1 items-center gap-[var(--vds-space-1)]">
          <div data-ob={PROJECT_GUIDE_ANCHORS.categories} className="flex shrink-0 items-center">
            {compactNavigation && (
              <Select value={category} onValueChange={selectCategory} size="md">
                <SelectTrigger
                  aria-label={t('fileCategory')}
                  title={t(
                    category === 'materials'
                      ? 'materials'
                      : category === 'literature'
                        ? 'papers'
                        : 'outputs'
                  )}
                  className="!h-[var(--vds-control-height-md)] !min-h-0 !min-w-0 !w-auto max-w-[var(--vds-library-toolbar-category-width)] !gap-[var(--vds-space-1)] ![padding:0_var(--vds-space-2)]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="materials">{t('materials')}</SelectItem>
                  <SelectItem value="literature">{t('papers')}</SelectItem>
                  <SelectItem value="outputs">{t('outputs')}</SelectItem>
                </SelectContent>
              </Select>
            )}
            <div className={compactNavigation ? 'hidden' : undefined}>
              <TabsList className="w-max shrink-0">
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
            </div>
          </div>
          <div
            ref={setToolbarTarget}
            className="ml-auto flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          />
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
              <LibraryToolbarTrailing.Provider value={explorer}>
                {featureRegistry.viewers
                  .get(
                    value === 'materials'
                      ? 'material-list'
                      : value === 'literature'
                        ? 'project-literature'
                        : 'outputs'
                  )
                  ?.render({ active: category === value, path: value })}
              </LibraryToolbarTrailing.Provider>
            </LibrarySelectionChange.Provider>
          </LibraryToolbarTarget.Provider>
        </TabsContent>
      ))}
    </Tabs>
  )
}
