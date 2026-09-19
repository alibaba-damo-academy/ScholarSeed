import type { DocumentPanelContext } from '../../contracts/features'
import { recordTargetFor } from './api.ts'
import type { DocumentSession, DocumentTab } from './workspace.ts'

export function documentPanelContext(
  session: DocumentSession,
  tab: DocumentTab
): DocumentPanelContext {
  return {
    path: session.source.path,
    viewer: session.viewer,
    sourceKind: session.source.kind,
    recordTarget: recordTargetFor(session.source),
    documentSessionId: session.id,
    tabId: tab.id
  }
}
