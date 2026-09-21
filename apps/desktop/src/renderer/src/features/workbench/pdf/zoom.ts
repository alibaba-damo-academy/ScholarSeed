const WHEEL_DELTA_PIXEL = 0
const WHEEL_DELTA_LINE = 1
const WHEEL_DELTA_PAGE = 2
const WHEEL_LINE_HEIGHT_PX = 16
const MAX_WHEEL_DELTA_PX = 240
const WHEEL_ZOOM_SENSITIVITY = 0.002

interface PdfWheelScaleInput {
  scale: number
  minScale: number
  maxScale: number
  deltaY: number
  deltaMode: number
  viewportHeight: number
  ctrlKey: boolean
  metaKey: boolean
}

function wheelDeltaPixels(deltaY: number, deltaMode: number, viewportHeight: number): number | null {
  if (deltaMode === WHEEL_DELTA_PIXEL) return deltaY
  if (deltaMode === WHEEL_DELTA_LINE) return deltaY * WHEEL_LINE_HEIGHT_PX
  if (deltaMode === WHEEL_DELTA_PAGE) return deltaY * viewportHeight
  return null
}

export function pdfWheelScale(input: PdfWheelScaleInput): number | null {
  if ((!input.ctrlKey && !input.metaKey) || !Number.isFinite(input.deltaY) || input.deltaY === 0) return null
  const deltaPixels = wheelDeltaPixels(input.deltaY, input.deltaMode, input.viewportHeight)
  if (deltaPixels === null) return null
  const boundedDelta = Math.max(-MAX_WHEEL_DELTA_PX, Math.min(MAX_WHEEL_DELTA_PX, deltaPixels))
  const requestedScale = input.scale * Math.exp(-boundedDelta * WHEEL_ZOOM_SENSITIVITY)
  return Math.max(input.minScale, Math.min(input.maxScale, requestedScale))
}
