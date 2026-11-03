import type { ViewerKind } from '../../contracts/workbench.ts'
import { usesOfficePreview } from './preview/routing.ts'

export const OFFICE_EXCLUSIVE_GROUP = 'office' as const

export interface ViewerPolicy {
  defaultViewKind: 'preview' | 'edit'
  exclusiveGroup: typeof OFFICE_EXCLUSIVE_GROUP | null
  canMove: boolean
  canSplit: boolean
  canCompareInParallel: boolean
}

const DEFAULT_VIEWER_POLICY: ViewerPolicy = {
  defaultViewKind: 'preview',
  exclusiveGroup: null,
  canMove: true,
  canSplit: true,
  canCompareInParallel: true,
}

const OFFICE_VIEWER_POLICY: ViewerPolicy = {
  defaultViewKind: 'preview',
  exclusiveGroup: OFFICE_EXCLUSIVE_GROUP,
  canMove: false,
  canSplit: false,
  canCompareInParallel: false,
}

const VIEWER_POLICIES: Partial<Record<ViewerKind, ViewerPolicy>> = {
  markdown: { ...DEFAULT_VIEWER_POLICY, defaultViewKind: 'edit' },
  office: OFFICE_VIEWER_POLICY,
  spreadsheet: OFFICE_VIEWER_POLICY,
}

export function viewerPolicy(viewer: ViewerKind): ViewerPolicy {
  return VIEWER_POLICIES[viewer] ?? DEFAULT_VIEWER_POLICY
}

export function viewerExclusiveGroup(
  viewer: ViewerKind,
  path: string,
  viewKind: string
): ViewerPolicy['exclusiveGroup'] {
  return usesOfficePreview(path, viewKind) ? null : viewerPolicy(viewer).exclusiveGroup
}
