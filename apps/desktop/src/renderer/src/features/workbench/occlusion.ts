export function findMatchNeedsTopSpace(
  matchTop: number,
  widgetHeight: number,
  paddingTop: number,
  spaceEnabled: boolean
): boolean {
  const viewZoneHeight = spaceEnabled ? Math.max(widgetHeight - paddingTop, 0) : 0
  return matchTop - viewZoneHeight < widgetHeight
}
