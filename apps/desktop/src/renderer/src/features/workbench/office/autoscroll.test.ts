import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
}

interface AutoscrollPolicy {
  MAXIMUM_DISTANCE_PX: number
  MAXIMUM_SPEED_PX_PER_FRAME: number
  SELECTION_COLUMN_STEP_PX: number
  SELECTION_LINE_STEP_PX: number
  velocity: (
    point: { x: number; y: number },
    bounds: Bounds,
    bottomInset?: number
  ) => { x: number; y: number }
  create: (options: {
    bottomInset?: () => number
    element: Record<string, unknown>
    onSelectionFrame?: (speed: { x: number; y: number }) => boolean | void
  }) => {
    start: (event: Record<string, unknown>) => void
    move: (event: Record<string, unknown>) => boolean
    stop: (event?: Record<string, unknown>) => void
    destroy: () => void
  }
}

function policy(): AutoscrollPolicy {
  const context: Record<string, unknown> = {}
  runInNewContext(readFileSync(new URL('./autoscroll.js', import.meta.url), 'utf8'), context)
  return context.ScholarSeedOfficeAutoscroll as AutoscrollPolicy
}

test('Writer selection autoscroll stays idle inside the workspace', () => {
  const subject = policy()
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        subject.velocity({ x: 400, y: 300 }, { left: 0, top: 0, right: 800, bottom: 600 })
      )
    ),
    { x: 0, y: 0 }
  )
})

test('Writer selection autoscroll follows relative overflow distance in every direction', () => {
  const subject = policy()
  const bounds = { left: 100, top: 100, right: 900, bottom: 700 }

  const near = subject.velocity({ x: 90, y: 720 }, bounds)
  const far = subject.velocity({ x: -20, y: 860 }, bounds)
  assert.ok(near.x < 0)
  assert.ok(near.y > 0)
  assert.ok(Math.abs(far.x) > Math.abs(near.x))
  assert.ok(Math.abs(far.y) > Math.abs(near.y))
})

test('Office selection autoscroll uses one pixel per frame at 160 pixels overflow', () => {
  const subject = policy()
  const bounds = { left: 100, top: 100, right: 900, bottom: 700 }

  assert.equal(subject.velocity({ x: 20, y: 780 }, bounds).x, -0.5)
  assert.equal(subject.velocity({ x: 20, y: 780 }, bounds).y, 0.5)
  assert.equal(subject.velocity({ x: -60, y: 860 }, bounds).x, -1)
  assert.equal(subject.velocity({ x: -60, y: 860 }, bounds).y, 1)
})

test('Writer maps its bottom line inside the canvas to the shared full speed curve', () => {
  const subject = policy()
  const bounds = { left: 100, top: 100, right: 900, bottom: 700 }
  const inset = subject.SELECTION_LINE_STEP_PX

  assert.equal(subject.velocity({ x: 400, y: bounds.bottom - inset }, bounds, inset).y, 0)
  assert.equal(subject.velocity({ x: 400, y: bounds.bottom - inset / 2 }, bounds, inset).y, 0.5)
  assert.equal(subject.velocity({ x: 400, y: bounds.bottom }, bounds, inset).y, 1)
  assert.equal(subject.velocity({ x: 400, y: bounds.bottom - inset / 2 }, bounds).y, 0)
})

test('Writer controller starts scrolling before the pointer leaves the canvas', () => {
  const callbacks = new Map<number, () => void>()
  const dispatched: Array<{ deltaY?: number }> = []
  let sequence = 0
  class TestWheelEvent {
    deltaY: number

    constructor(_type: string, options: { deltaY: number }) {
      this.deltaY = options.deltaY
    }
  }
  const context = {
    WheelEvent: TestWheelEvent,
    cancelAnimationFrame: (frame: number) => {
      callbacks.delete(frame)
    },
    requestAnimationFrame: (callback: () => void) => {
      callbacks.set(++sequence, callback)
      return sequence
    },
  }
  runInNewContext(readFileSync(new URL('./autoscroll.js', import.meta.url), 'utf8'), context)
  const subject = (context as unknown as { ScholarSeedOfficeAutoscroll: AutoscrollPolicy })
    .ScholarSeedOfficeAutoscroll
  const controller = subject.create({
    bottomInset: () => subject.SELECTION_LINE_STEP_PX,
    element: {
      dispatchEvent: (event: { deltaY?: number }) => {
        dispatched.push(event)
        return true
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
      setPointerCapture: () => {},
    },
  })

  controller.start({ pointerId: 7, clientX: 400, clientY: 300 })
  assert.equal(controller.move({ pointerId: 7, clientX: 400, clientY: 590 }), true)
  assert.equal(callbacks.size, 1)
  const [frame, callback] = callbacks.entries().next().value!
  callbacks.delete(frame)
  callback()
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].deltaY, 0.5)
})

test('Writer selection autoscroll caps its speed for distant pointers', () => {
  const subject = policy()
  const result = subject.velocity(
    { x: -10_000, y: 10_000 },
    { left: 100, top: 100, right: 900, bottom: 700 }
  )

  assert.equal(result.x, -subject.MAXIMUM_SPEED_PX_PER_FRAME)
  assert.equal(result.y, subject.MAXIMUM_SPEED_PX_PER_FRAME)
})

test('Writer selection autoscroll keeps only the latest pointer position', () => {
  const callbacks = new Map<number, () => void>()
  const selectionFrames: Array<{ x: number; y: number }> = []
  let sequence = 0
  const context = {
    WheelEvent: class {},
    cancelAnimationFrame: (frame: number) => {
      callbacks.delete(frame)
    },
    requestAnimationFrame: (callback: () => void) => {
      callbacks.set(++sequence, callback)
      return sequence
    },
  }
  runInNewContext(readFileSync(new URL('./autoscroll.js', import.meta.url), 'utf8'), context)
  const subject = (context as unknown as { ScholarSeedOfficeAutoscroll: AutoscrollPolicy })
    .ScholarSeedOfficeAutoscroll
  const controller = subject.create({
    element: {
      dispatchEvent: () => true,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
      setPointerCapture: () => {},
    },
    onSelectionFrame: (speed) => {
      selectionFrames.push(speed)
      return false
    },
  })

  controller.start({ pointerId: 7, clientX: 400, clientY: 300 })
  controller.move({ pointerId: 7, clientX: 400, clientY: 620 })
  controller.move({ pointerId: 7, clientX: 400, clientY: 760 })
  assert.equal(callbacks.size, 1)
  const [frame, callback] = callbacks.entries().next().value!
  callbacks.delete(frame)
  callback()

  assert.deepEqual(JSON.parse(JSON.stringify(selectionFrames)), [{ x: 0, y: 1 }])
})

test('Writer alternates accepted selection updates with canvas scroll frames', () => {
  const callbacks = new Map<number, () => void>()
  const cancelled: number[] = []
  const dispatched: Array<{ kind: string; deltaX?: number; deltaY?: number }> = []
  const selectionFrames: Array<{ x: number; y: number }> = []
  const order: string[] = []
  const acceptedFrames = [true, false, true]
  const captured: number[] = []
  const released: number[] = []
  let sequence = 0
  class TestWheelEvent {
    kind = 'wheel'
    deltaX: number
    deltaY: number

    constructor(_type: string, options: { deltaX: number; deltaY: number }) {
      this.deltaX = options.deltaX
      this.deltaY = options.deltaY
    }
  }
  const context = {
    WheelEvent: TestWheelEvent,
    cancelAnimationFrame: (frame: number) => {
      cancelled.push(frame)
      callbacks.delete(frame)
    },
    requestAnimationFrame: (callback: () => void) => {
      callbacks.set(++sequence, callback)
      return sequence
    },
  }
  runInNewContext(readFileSync(new URL('./autoscroll.js', import.meta.url), 'utf8'), context)
  const subject = (context as unknown as { ScholarSeedOfficeAutoscroll: AutoscrollPolicy })
    .ScholarSeedOfficeAutoscroll
  const capturedPointers = new Set<number>()
  const controller = subject.create({
    element: {
      dispatchEvent: (event: { kind: string; deltaX?: number; deltaY?: number }) => {
        order.push('canvas')
        dispatched.push(event)
        return true
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
      hasPointerCapture: (pointerId: number) => capturedPointers.has(pointerId),
      releasePointerCapture: (pointerId: number) => {
        released.push(pointerId)
        capturedPointers.delete(pointerId)
      },
      setPointerCapture: (pointerId: number) => {
        captured.push(pointerId)
        capturedPointers.add(pointerId)
      },
    },
    onSelectionFrame: (speed) => {
      order.push('selection')
      selectionFrames.push(speed)
      return acceptedFrames[selectionFrames.length - 1]
    },
  })

  controller.start({ pointerId: 7, clientX: 400, clientY: 300 })
  controller.move({ pointerId: 7, clientX: 400, clientY: 10_000 })
  assert.deepEqual(captured, [7])
  assert.equal(callbacks.size, 1)
  for (let index = 0; index < acceptedFrames.length; index += 1) {
    const [frame, callback] = callbacks.entries().next().value!
    callbacks.delete(frame)
    callback()
  }
  assert.equal(dispatched.length, 2)
  assert.equal(dispatched[0].kind, 'wheel')
  assert.equal(dispatched[0].deltaX, 0)
  assert.ok((dispatched[0].deltaY ?? 0) > 0)
  assert.deepEqual(JSON.parse(JSON.stringify(selectionFrames)), [
    { x: 0, y: 1 },
    { x: 0, y: 1 },
    { x: 0, y: 1 },
  ])
  assert.deepEqual(order, ['selection', 'canvas', 'selection', 'selection', 'canvas'])
  assert.equal(callbacks.size, 1)

  controller.stop({ pointerId: 7 })
  assert.deepEqual(released, [7])
  assert.equal(callbacks.size, 0)
  assert.ok(cancelled.length > 0)
})

test('Office frame runs Writer autoscroll as a serial one-line transaction', () => {
  const source = readFileSync(new URL('./frame.ts', import.meta.url), 'utf8')
  const worker = readFileSync(new URL('./office-thread.js', import.meta.url), 'utf8')

  assert.match(source, /ScholarSeedOfficeAutoscroll\.create/)
  assert.match(
    source,
    /bottomInset:\(\)=>selectionAutoscrollKind==='writer'\?ScholarSeedOfficeAutoscroll\.SELECTION_LINE_STEP_PX:0/
  )
  assert.match(source, /autoscrollKind\(filename\)/)
  assert.match(source, /documentKind===selectionAutoscrollKind/)
  assert.match(source, /event\.isPrimary&&event\.button===primaryPointerButton/)
  assert.match(source, /selectionAutoscroll\.start\(event\)/)
  assert.match(source, /selectionAutoscrollAppliedCommand='selection_autoscroll_applied'/)
  assert.match(source, /function advanceWriterAutoscroll\(speed\)/)
  assert.match(source, /writerAutoscrollPendingRequest/)
  assert.match(source, /writerAutoscrollEngaged/)
  assert.match(source, /writerAutoscrollSelectionY/)
  assert.match(source, /writerAutoscrollTargetY/)
  assert.match(source, /function scheduleWriterPointerSelection\(\)/)
  assert.match(source, /requestWriterAutoscroll\(\{x:0,y:Math\.sign\(distance\)\},false\)/)
  assert.doesNotMatch(source, /dispatchWriterLineScroll/)
  assert.match(source, /port\?\.postMessage\(\{cmd:selectionAutoscrollCommitCommand,requestId\}\)/)
  assert.match(
    source,
    /writerAutoscrollNextAt=performance\.now\(\)\+ScholarSeedOfficeAutoscroll\.SELECTION_LINE_INTERVAL_MS/
  )
  assert.match(source, /performance\.now\(\)<writerAutoscrollNextAt/)
  assert.match(
    source,
    /message\.cmd===selectionAutoscrollReadyCommand[\s\S]*writerAutoscrollCommitFrame=requestAnimationFrame\(\(\)=>commitWriterAutoscroll\(message\.requestId\)\)/
  )
  assert.match(
    source,
    /message\.cmd===selectionAutoscrollAppliedCommand[\s\S]*paintWriterAutoscroll\(message\.requestId\)/
  )
  assert.match(
    source,
    /writerAutoscrollPaintFrame=requestAnimationFrame\(\(\)=>finishWriterAutoscroll\(requestId\)\)/
  )
  assert.match(
    source,
    /function finishWriterAutoscroll\(requestId\)[\s\S]*writerAutoscrollPendingRequest=0/
  )
  assert.match(
    source,
    /cancelAnimationFrame\(writerAutoscrollCommitFrame\);cancelAnimationFrame\(writerAutoscrollPaintFrame\)/
  )
  assert.doesNotMatch(source, /dispatchWriterAutoscroll/)
  assert.match(
    source,
    /selectionDragging&&message\.requestId===writerAutoscrollPendingRequest&&!writerAutoscrollCommitFrame/
  )
  assert.match(
    source,
    /selectionAutoscrollKind==='writer'\)return advanceWriterAutoscroll\(speed\)/
  )
  assert.match(source, /message\.cmd===selectionAutoscrollAppliedCommand/)
  assert.doesNotMatch(
    source,
    /writerFrameDistance|writerAutoscrollDistance|writerAutoscrollSelectionApplied/
  )
  assert.match(source, /const edgeActive=selectionAutoscroll\.move\(event\)/)
  assert.match(source, /event\.preventDefault\(\);event\.stopImmediatePropagation\(\)/)
  assert.match(
    source,
    /if\(selectionAutoscrollKind==='writer'\)updateWriterPointerSelection\(event,edgeActive\)/
  )
  assert.match(source, /if\(speed\.x\|\|speed\.y\|\|writerAutoscrollEngaged\)/)
  assert.match(source, /document\.addEventListener\('mousemove',suppressWriterEdgeMousemove,true\)/)
  assert.match(source, /selectionAutoscroll\.stop\(event\)/)
  assert.match(source, /canvas\.addEventListener\('lostpointercapture',finishSelectionDrag,true\)/)
  assert.match(source, /hostDocument\.addEventListener\('pointerup',finishSelectionDrag,true\)/)
  assert.match(source, /selectionAutoscroll\.destroy\(\)/)
  assert.match(worker, /function prepareWriterAutoscroll\(message\)/)
  assert.match(worker, /let writerAutoscrollCursor/)
  assert.match(
    worker,
    /writerAutoscrollCursor \?\?= readonlyWriterSelectionCursor\(controller, Math\.sign\(vertical \|\| horizontal\)\)/
  )
  assert.match(
    worker,
    /selectionDragging = Boolean\(event\.data\.active\)\s*writerAutoscrollCursor = undefined/
  )
  assert.match(
    worker,
    /pendingWriterAutoscroll = \{ requestId: message\.requestId, cursor, horizontal, vertical \}/
  )
  assert.match(worker, /pending\.cursor\.goDown\(SELECTION_STEP_COUNT, true\)/)
  assert.doesNotMatch(worker, /WRITER_SELECTION_COMMANDS/)
})
