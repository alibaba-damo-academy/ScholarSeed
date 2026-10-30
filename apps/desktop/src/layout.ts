export interface ProjectLayout {
  open: boolean
  full: boolean
  swapped: boolean
  taskTab: boolean
  floating: 'compact' | 'expanded' | 'minimized'
  floatingRestore: 'compact' | 'expanded'
  conversationFull: boolean
  conversationWidth: number
}

export const DEFAULT_PROJECT_LAYOUT: ProjectLayout = {
  open: false,
  full: false,
  swapped: false,
  taskTab: false,
  floating: 'compact',
  floatingRestore: 'expanded',
  conversationFull: false,
  conversationWidth: 360,
}

export type ProjectLayouts = Record<string, ProjectLayout>

export function changeProjectLayout(
  layout: ProjectLayout,
  action:
    | 'toggleWorkspace'
    | 'toggleFull'
    | 'pinConversation'
    | 'moveConversationRight'
    | 'moveConversationLeft'
    | 'toggleConversationFull'
    | 'toggleFloating'
    | 'minimizeConversation'
    | 'restoreConversation'
    | 'showTask'
): ProjectLayout {
  switch (action) {
    case 'showTask':
      return {
        ...layout,
        taskTab: layout.full,
        floating: layout.floating === 'minimized' ? layout.floatingRestore : layout.floating,
      }
    case 'moveConversationRight':
    case 'moveConversationLeft':
      return {
        ...layout,
        swapped: action === 'moveConversationRight',
        full: false,
        taskTab: false,
        conversationFull: false,
      }
    case 'toggleWorkspace':
      return { ...layout, open: !layout.open, full: false, taskTab: false, conversationFull: false }
    case 'toggleFull':
      return { ...layout, open: true, full: !layout.full, taskTab: false, conversationFull: false }
    case 'toggleConversationFull':
      return { ...layout, conversationFull: !layout.conversationFull }
    case 'toggleFloating':
      return { ...layout, floating: layout.floating === 'expanded' ? 'compact' : 'expanded' }
    case 'minimizeConversation':
      return {
        ...layout,
        open: true,
        full: true,
        taskTab: false,
        conversationFull: false,
        floatingRestore: layout.floating === 'minimized' ? layout.floatingRestore : layout.floating,
        floating: 'minimized',
      }
    case 'restoreConversation':
      return { ...layout, floating: layout.floatingRestore }
    case 'pinConversation':
      if (layout.full && !layout.taskTab) {
        return { ...layout, full: false, taskTab: false, conversationFull: false }
      }
      return {
        ...layout,
        open: true,
        full: true,
        taskTab: false,
        conversationFull: false,
        floating: 'compact',
      }
  }
}

export function sanitizeProjectLayouts(value: unknown): ProjectLayouts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([projectId, entry]) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const layout = entry as Partial<ProjectLayout>
      const conversationWidth =
        typeof layout.conversationWidth === 'number' &&
        Number.isFinite(layout.conversationWidth) &&
        layout.conversationWidth > 0
          ? layout.conversationWidth
          : DEFAULT_PROJECT_LAYOUT.conversationWidth
      return [
        [
          projectId,
          {
            open: layout.open === true,
            full: layout.full === true,
            swapped: layout.swapped === true,
            taskTab: layout.taskTab === true,
            conversationFull: layout.conversationFull === true,
            floatingRestore: layout.floatingRestore === 'compact' ? 'compact' : 'expanded',
            floating:
              layout.floating === 'expanded' || layout.floating === 'minimized'
                ? layout.floating
                : DEFAULT_PROJECT_LAYOUT.floating,
            conversationWidth,
          },
        ],
      ]
    })
  )
}

export function projectLayoutsEqual(
  left: ProjectLayouts = {},
  right: ProjectLayouts = {}
): boolean {
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => {
      const other = Object.prototype.hasOwnProperty.call(right, key) ? right[key] : undefined
      return (
        other !== undefined &&
        Object.keys(DEFAULT_PROJECT_LAYOUT).every(
          (field) => left[key][field as keyof ProjectLayout] === other[field as keyof ProjectLayout]
        )
      )
    })
  )
}

export function projectLayoutTransition<
  State extends {
    homeSelectedProjectId: string | null
    workbenchLayout: ProjectLayout
    projectLayouts: ProjectLayouts
  },
>(current: State, next: State): State {
  const projectId = next.homeSelectedProjectId
  if (projectId !== current.homeSelectedProjectId) {
    const saved =
      projectId && Object.prototype.hasOwnProperty.call(next.projectLayouts, projectId)
        ? next.projectLayouts[projectId]
        : DEFAULT_PROJECT_LAYOUT
    return { ...next, workbenchLayout: { ...saved } }
  }
  if (
    !projectId ||
    projectLayoutsEqual(
      { [projectId]: current.workbenchLayout },
      { [projectId]: next.workbenchLayout }
    )
  )
    return next
  return {
    ...next,
    projectLayouts: { ...next.projectLayouts, [projectId]: { ...next.workbenchLayout } },
  }
}
