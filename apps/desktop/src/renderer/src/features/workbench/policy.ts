import type { ViewerKind } from '../../contracts/workbench.ts'
import { usesCsvDocument } from './preview/routing.ts'

export interface ViewerPolicy {
  defaultViewKind: 'preview' | 'edit'
  canRelocate: boolean
  canDuplicate: boolean
}

const DEFAULT_VIEWER_POLICY: ViewerPolicy = {
  defaultViewKind: 'preview',
  canRelocate: true,
  canDuplicate: true,
}
// The native CSV worker is view-owned; relocating or duplicating its unsaved
// model requires a separate session-lifetime implementation.
const CSV_VIEWER_POLICY: ViewerPolicy = {
  defaultViewKind: 'edit',
  canRelocate: false,
  canDuplicate: false,
}
const VIEWER_POLICIES: Partial<Record<ViewerKind, ViewerPolicy>> = {
  markdown: { ...DEFAULT_VIEWER_POLICY, defaultViewKind: 'edit' },
}

export function viewerPolicy(viewer: ViewerKind, path = ''): ViewerPolicy {
  if (usesCsvDocument(path)) return CSV_VIEWER_POLICY
  return VIEWER_POLICIES[viewer] ?? DEFAULT_VIEWER_POLICY
}
