export const MODULE_PANEL_DEFAULT_WIDTH = 256
export const MODULE_PANEL_MAX_WIDTH = 462
export const MODULE_PANEL_WIDTH_STEP = 1
export const ACTIVITY_RAIL_WIDTH = 56
export const MODULE_PANEL_WIDTH_UNIT = 'px'

export function clampModulePanelWidth(width: number): number {
  const constrainedWidth = Math.min(Math.max(width, MODULE_PANEL_DEFAULT_WIDTH), MODULE_PANEL_MAX_WIDTH)
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
