/* SPDX-License-Identifier: MIT */

'use strict'

globalThis.ScholarSeedOfficeAutoscroll = (() => {
  const MAXIMUM_DISTANCE_PX = 160
  const MAXIMUM_SPEED_PX_PER_FRAME = 1
  const PIXEL_DELTA_MODE = 0
  const SELECTION_COLUMN_STEP_PX = 8
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

  function velocity(point, bounds) {
    return {
      x: axisVelocity(point.x, bounds.left, bounds.right),
      y: axisVelocity(point.y, bounds.top, bounds.bottom),
    }
  }

  function create({ element, onSelectionStep }) {
    let active = false
    let frame = 0
    let point
    let pointerId
    let selectionDistanceX = 0
    let selectionDistanceY = 0

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
      const speed = velocity(point, bounds)
      if (!speed.x && !speed.y) return
      element.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaMode: PIXEL_DELTA_MODE,
        deltaX: speed.x,
        deltaY: speed.y,
      }))
      selectionDistanceX += Math.abs(speed.x)
      selectionDistanceY += Math.abs(speed.y)
      const step = {
        x: selectionDistanceX >= SELECTION_COLUMN_STEP_PX ? Math.sign(speed.x) : 0,
        y: selectionDistanceY >= SELECTION_LINE_STEP_PX ? Math.sign(speed.y) : 0,
      }
      if (step.x) selectionDistanceX -= SELECTION_COLUMN_STEP_PX
      if (step.y) selectionDistanceY -= SELECTION_LINE_STEP_PX
      if (step.x || step.y) onSelectionStep?.(step)
      schedule()
    }

    function start(event) {
      active = true
      pointerId = event.pointerId
      point = { x: event.clientX, y: event.clientY }
      selectionDistanceX = 0
      selectionDistanceY = 0
      if (typeof element.setPointerCapture === 'function') element.setPointerCapture(pointerId)
    }

    function move(event) {
      if (!active || event.pointerId !== pointerId) return
      point = { x: event.clientX, y: event.clientY }
      const speed = velocity(point, element.getBoundingClientRect())
      if (speed.x || speed.y) schedule()
      else {
        selectionDistanceX = 0
        selectionDistanceY = 0
        cancel()
      }
    }

    function stop(event) {
      if (!active || (event && event.pointerId !== pointerId)) return
      active = false
      point = undefined
      selectionDistanceX = 0
      selectionDistanceY = 0
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
    create,
    velocity,
  })
})()
