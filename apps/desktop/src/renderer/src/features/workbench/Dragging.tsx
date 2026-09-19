import React, { useCallback, useContext, useMemo, useState } from 'react'

import {
  NavigationTabs,
  type NavigationTabElementProps,
  type NavigationTabItem,
  type NavigationTabsProps
} from '../../components/ui'
import { DocumentDragContext } from './documentDragContext'
import type { DockLeaf, DropEdge, TabInsertion } from './layout'
import { useDocumentWorkspace, useWorkspaceController } from './workspace'

export const DOCUMENT_TAB_MIME = 'application/x-scholarseed-document-tab'
const DOCUMENT_DRAG_PROVIDER_MISSING = 'document_drag_provider_missing'

export interface DocumentDropPreview {
  edge: DropEdge
  left: number
  top: number
  width: number
  height: number
}

interface DocumentTabInsertionTarget {
  insertion: TabInsertion
  tabId: string
}

export interface DocumentDragContextValue {
  begin: (tabId: string) => void
  draggingTabId: string | null
  finish: () => void
  insertionTarget: DocumentTabInsertionTarget | null
  preview: DocumentDropPreview | null
  setInsertionTarget: (target: DocumentTabInsertionTarget | null) => void
  setPreview: (preview: DocumentDropPreview | null) => void
}

export function DocumentDragProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [insertionTarget, setInsertionTarget] = useState<DocumentTabInsertionTarget | null>(null)
  const [preview, setPreview] = useState<DocumentDropPreview | null>(null)
  const begin = useCallback((tabId: string): void => {
    setDraggingTabId(tabId)
    setInsertionTarget(null)
    setPreview(null)
  }, [])
  const finish = useCallback((): void => {
    setDraggingTabId(null)
    setInsertionTarget(null)
    setPreview(null)
  }, [])
  const value = useMemo<DocumentDragContextValue>(() => ({
    begin,
    draggingTabId,
    finish,
    insertionTarget,
    preview,
    setInsertionTarget,
    setPreview
  }), [begin, draggingTabId, finish, insertionTarget, preview])
  return <DocumentDragContext.Provider value={value}>{children}</DocumentDragContext.Provider>
}

export function useDocumentDrag(): DocumentDragContextValue {
  const context = useContext(DocumentDragContext)
  if (!context) throw new Error(DOCUMENT_DRAG_PROVIDER_MISSING)
  return context
}

interface DocumentNavigationTabsProps extends Omit<NavigationTabsProps, 'getTabProps' | 'tabs'> {
  leaf: DockLeaf
  tabs: readonly NavigationTabItem[]
}

export function DocumentNavigationTabs({
  leaf,
  tabs,
  ...props
}: DocumentNavigationTabsProps): React.JSX.Element {
  const workspace = useWorkspaceController()
  const documentWorkspace = useDocumentWorkspace()
  const drag = useDocumentDrag()
  const documentTabIds = new Set(leaf.tabIds)
  const displayedTabs = tabs.map((tab) => ({
    ...tab,
    dropIndicator: drag.insertionTarget?.tabId === tab.id
      ? drag.insertionTarget.insertion
      : undefined
  }))
  const tabProps = (item: NavigationTabItem): NavigationTabElementProps => {
    if (!documentTabIds.has(item.id)) return {}
    const tab = documentWorkspace.tabs[item.id]
    if (!tab || !workspace.canRelocateTab(tab.id)) {
      return { 'data-testid': `document-tab-${item.id}` }
    }
    return {
      draggable: true,
      'data-testid': `document-tab-${item.id}`,
      onDragStart: (event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(DOCUMENT_TAB_MIME, item.id)
        drag.begin(item.id)
      },
      onDragEnd: drag.finish,
      onDragOver: (event) => {
        if (!drag.draggingTabId || drag.draggingTabId === item.id) {
          drag.setInsertionTarget(null)
          return
        }
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        const rect = event.currentTarget.getBoundingClientRect()
        drag.setPreview(null)
        drag.setInsertionTarget({
          tabId: item.id,
          insertion: event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
        })
      },
      onDragLeave: (event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        if (drag.insertionTarget?.tabId === item.id) drag.setInsertionTarget(null)
      },
      onDrop: (event) => {
        event.preventDefault()
        event.stopPropagation()
        const tabId = event.dataTransfer.getData(DOCUMENT_TAB_MIME) || drag.draggingTabId
        const rect = event.currentTarget.getBoundingClientRect()
        const insertion = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
        drag.finish()
        if (tabId && tabId !== item.id) void workspace.moveTabToTab(tabId, item.id, insertion)
      }
    }
  }

  return <NavigationTabs {...props} getTabProps={tabProps} tabs={displayedTabs} />
}
