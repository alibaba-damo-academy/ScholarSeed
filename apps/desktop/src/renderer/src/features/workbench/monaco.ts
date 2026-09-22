import type { editor } from 'monaco-editor/editor/editor.api'

import { registerDocumentResourceReclaimer } from './reclaim'

const views = new Map<string, editor.ICodeEditorViewState | null>()

export function saveView(tabId: string, state: editor.ICodeEditorViewState | null): void {
  views.set(tabId, state)
}

export function restoreView(tabId: string): editor.ICodeEditorViewState | null {
  return views.get(tabId) ?? null
}

function sweepViews(_activeSessionIds: ReadonlySet<string>, activeTabIds: ReadonlySet<string>): void {
  for (const tabId of views.keys()) {
    if (!activeTabIds.has(tabId)) views.delete(tabId)
  }
}

registerDocumentResourceReclaimer(sweepViews)
