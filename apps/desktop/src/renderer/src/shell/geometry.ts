export const MODULE_PANEL_DEFAULT_WIDTH = 256
export const MODULE_PANEL_MAX_WIDTH = 462
export const MODULE_PANEL_WIDTH_STEP = 1
export const ACTIVITY_RAIL_WIDTH = 56
export const MODULE_PANEL_WIDTH_UNIT = 'px'

export function clampModulePanelWidth(width: number): number {
  const constrainedWidth = Math.min(
    Math.max(width, MODULE_PANEL_DEFAULT_WIDTH),
    MODULE_PANEL_MAX_WIDTH
  )
  return Math.round(constrainedWidth / MODULE_PANEL_WIDTH_STEP) * MODULE_PANEL_WIDTH_STEP
}

export function parseModulePanelWidth(width: string): number {
  const parsed = Number.parseFloat(width.replace(MODULE_PANEL_WIDTH_UNIT, ''))
  return Number.isFinite(parsed) ? clampModulePanelWidth(parsed) : MODULE_PANEL_DEFAULT_WIDTH
}

export function modulePanelWidthCss(width: number): string {
  return `${width}${MODULE_PANEL_WIDTH_UNIT}`
}

export function topBarLeftWidth(modulePanelWidth: number, modulePanelVisible: boolean): string {
  const occupiedWidth = modulePanelWidth + ACTIVITY_RAIL_WIDTH
  return modulePanelVisible
    ? `calc(${occupiedWidth}${MODULE_PANEL_WIDTH_UNIT} + var(--vds-resizable-handle-size) / 2 + var(--vds-border-width-1))`
    : modulePanelWidthCss(occupiedWidth)
}

export function constrainFloatingPanel(
  position: { left: number; top: number },
  hostWidth: number,
  hostHeight: number,
  panelWidth: number,
  panelHeight: number,
  minimumTop = 0
): { left: number; top: number } {
  return {
    left: Math.max(0, Math.min(position.left, hostWidth - panelWidth)),
    top: Math.max(minimumTop, Math.min(position.top, hostHeight - panelHeight)),
  }
}

export function resizeFloatingPanel(
  panel: { left: number; width: number },
  edge: 'left' | 'right',
  delta: number,
  hostWidth: number,
  minimumWidth: number,
  inset: number
): { left: number; width: number } {
  const fixedEdge = edge === 'left' ? panel.left + panel.width : panel.left
  const available = Math.max(0, edge === 'left' ? fixedEdge - inset : hostWidth - inset - fixedEdge)
  const width = Math.min(
    available,
    Math.max(Math.min(minimumWidth, available), panel.width + (edge === 'left' ? -delta : delta))
  )
  return { left: edge === 'left' ? fixedEdge - width : fixedEdge, width }
}

const FLOATING_PANEL_DOCKS = {
  topLeft: { horizontal: 0, vertical: 0 },
  topRight: { horizontal: 1, vertical: 0 },
  bottomLeft: { horizontal: 0, vertical: 1 },
  bottomRight: { horizontal: 1, vertical: 1 },
  bottomCenter: { horizontal: 0.5, vertical: 1 },
} as const

export type FloatingPanelDock = keyof typeof FLOATING_PANEL_DOCKS

export interface FloatingPanelBounds {
  hostWidth: number
  hostHeight: number
  panelWidth: number
  panelHeight: number
  minimumTop: number
  inset: number
}

export function floatingPanelDockPosition(
  dock: FloatingPanelDock,
  bounds: FloatingPanelBounds
): { left: number; top: number } {
  const anchor = FLOATING_PANEL_DOCKS[dock]
  const left = Math.min(bounds.inset, Math.max(0, bounds.hostWidth - bounds.panelWidth))
  const right = Math.max(left, bounds.hostWidth - bounds.panelWidth - bounds.inset)
  const bottom = Math.max(bounds.minimumTop, bounds.hostHeight - bounds.panelHeight - bounds.inset)
  return {
    left: left + (right - left) * anchor.horizontal,
    top: bounds.minimumTop + (bottom - bounds.minimumTop) * anchor.vertical,
  }
}

export function nearestFloatingPanelDock(
  position: { left: number; top: number },
  bounds: FloatingPanelBounds
): FloatingPanelDock {
  const docks = Object.keys(FLOATING_PANEL_DOCKS) as FloatingPanelDock[]
  return docks.reduce((nearest, dock) => {
    const candidate = floatingPanelDockPosition(dock, bounds)
    const current = floatingPanelDockPosition(nearest, bounds)
    return Math.hypot(position.left - candidate.left, position.top - candidate.top) <
      Math.hypot(position.left - current.left, position.top - current.top)
      ? dock
      : nearest
  })
}
