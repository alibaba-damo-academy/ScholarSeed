import type { ViewerKind } from '../../contracts/workbench.ts'

export const OFFICE_EXCLUSIVE_GROUP = 'office' as const

export interface ViewerPolicy {
  exclusiveGroup: typeof OFFICE_EXCLUSIVE_GROUP | null
  canMove: boolean
  canSplit: boolean
  canCompareInParallel: boolean
}

const DEFAULT_VIEWER_POLICY: ViewerPolicy = {
  exclusiveGroup: null,
  canMove: true,
  canSplit: true,
  canCompareInParallel: true
}

const OFFICE_VIEWER_POLICY: ViewerPolicy = {
  exclusiveGroup: OFFICE_EXCLUSIVE_GROUP,
  canMove: false,
  canSplit: false,
  canCompareInParallel: false
}

const VIEWER_POLICIES: Partial<Record<ViewerKind, ViewerPolicy>> = {
  office: OFFICE_VIEWER_POLICY,
  spreadsheet: OFFICE_VIEWER_POLICY
}

export function viewerPolicy(viewer: ViewerKind): ViewerPolicy {
  return VIEWER_POLICIES[viewer] ?? DEFAULT_VIEWER_POLICY
}
