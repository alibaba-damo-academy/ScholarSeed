/* SPDX-License-Identifier: MIT */

'use strict'

globalThis.ScholarSeedOfficeAutoscroll = (() => {
  const MAXIMUM_DISTANCE_PX = 160
  const MAXIMUM_SPEED_PX_PER_FRAME = 1
  const PIXEL_DELTA_MODE = 0
  const SCROLLBAR_ARROW_INSET_PX = 2
  const SELECTION_COLUMN_STEP_PX = 8
  const SELECTION_LINE_INTERVAL_MS = 120
  const SELECTION_LINE_STEP_PX = 20

  function axisVelocity(position, start, end) {
    const overflow = position < start
      ? position - start
      : position > end
        ? position - end
        : 0
    if (!overflow) return 0
    const ratio = Math.min(Math.abs(overflow) / MAXIMUM_DISTANCE_PX, 1)
    return Math.sign(overflow) * ratio * MAXIMUM_SPEED_PX_PER_FRAME
  }

  function verticalVelocity(position, start, end, bottomInset) {
    const inset = Math.max(0, Math.min(bottomInset, end - start))
    if (!inset || position <= end - inset) return axisVelocity(position, start, end)
    const ratio = Math.min((position - (end - inset)) / inset, 1)
    return ratio * MAXIMUM_SPEED_PX_PER_FRAME
  }

  function velocity(point, bounds, bottomInset = 0) {
    return {
      x: axisVelocity(point.x, bounds.left, bounds.right),
      y: verticalVelocity(point.y, bounds.top, bounds.bottom, bottomInset),
    }
  }

  function create({ bottomInset = () => 0, element, onSelectionFrame }) {
    let active = false
    let frame = 0
    let point
    let pointerId

    function cancel() {
      cancelAnimationFrame(frame)
      frame = 0
    }

    function schedule() {
      if (!frame) frame = requestAnimationFrame(scroll)
    }

    function scroll() {
      frame = 0
      if (!active || !point) return
      const bounds = element.getBoundingClientRect()
      const speed = velocity(point, bounds, bottomInset())
      if (!speed.x && !speed.y) return
      const accepted = onSelectionFrame?.(speed) !== false
      if (accepted) {
        element.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaMode: PIXEL_DELTA_MODE,
          deltaX: speed.x,
          deltaY: speed.y,
        }))
      }
      schedule()
    }

    function start(event) {
      active = true
      pointerId = event.pointerId
      point = { x: event.clientX, y: event.clientY }
      if (typeof element.setPointerCapture === 'function') element.setPointerCapture(pointerId)
    }

    function move(event) {
      if (!active || event.pointerId !== pointerId) return false
      point = { x: event.clientX, y: event.clientY }
      const speed = velocity(point, element.getBoundingClientRect(), bottomInset())
      if (speed.x || speed.y) schedule()
      else {
        cancel()
      }
      return Boolean(speed.x || speed.y)
    }

    function stop(event) {
      if (!active || (event && event.pointerId !== pointerId)) return
      active = false
      point = undefined
      cancel()
      try {
        if (
          pointerId !== undefined
          && typeof element.hasPointerCapture === 'function'
          && element.hasPointerCapture(pointerId)
        ) element.releasePointerCapture(pointerId)
      } catch (_error) {}
      pointerId = undefined
    }

    return Object.freeze({
      destroy: stop,
      move,
      start,
      stop,
    })
  }

  return Object.freeze({
    MAXIMUM_DISTANCE_PX,
    MAXIMUM_SPEED_PX_PER_FRAME,
    SCROLLBAR_ARROW_INSET_PX,
    SELECTION_COLUMN_STEP_PX,
    SELECTION_LINE_INTERVAL_MS,
    SELECTION_LINE_STEP_PX,
    create,
    velocity,
  })
})()
