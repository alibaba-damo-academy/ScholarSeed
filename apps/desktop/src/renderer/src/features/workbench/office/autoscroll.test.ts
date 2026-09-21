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
  velocity: (point: { x: number; y: number }, bounds: Bounds) => { x: number; y: number }
  create: (options: { element: Record<string, unknown>; onSelectionStep?: (step: { x: number; y: number }) => void }) => {
    start: (event: Record<string, unknown>) => void
    move: (event: Record<string, unknown>) => void
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
    JSON.parse(JSON.stringify(subject.velocity(
      { x: 400, y: 300 },
      { left: 0, top: 0, right: 800, bottom: 600 }
    ))),
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

test('Writer selection autoscroll caps its speed for distant pointers', () => {
  const subject = policy()
  const result = subject.velocity(
    { x: -10_000, y: 10_000 },
    { left: 100, top: 100, right: 900, bottom: 700 }
  )

  assert.equal(result.x, -subject.MAXIMUM_SPEED_PX_PER_FRAME)
  assert.equal(result.y, subject.MAXIMUM_SPEED_PX_PER_FRAME)
})

test('Writer selection autoscroll captures the pointer, emits wheel frames, and stops on release', () => {
  const expectedSelectionLineFrames = 20
  const callbacks = new Map<number, () => void>()
  const cancelled: number[] = []
  const dispatched: Array<{ kind: string; deltaX?: number; deltaY?: number }> = []
  const selectionSteps: Array<{ x: number; y: number }> = []
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
    cancelAnimationFrame: (frame: number) => { cancelled.push(frame); callbacks.delete(frame) },
    requestAnimationFrame: (callback: () => void) => { callbacks.set(++sequence, callback); return sequence },
  }
  runInNewContext(readFileSync(new URL('./autoscroll.js', import.meta.url), 'utf8'), context)
  const subject = (context as unknown as { ScholarSeedOfficeAutoscroll: AutoscrollPolicy })
    .ScholarSeedOfficeAutoscroll
  const capturedPointers = new Set<number>()
  const controller = subject.create({
    element: {
      dispatchEvent: (event: { kind: string; deltaX?: number; deltaY?: number }) => { dispatched.push(event); return true },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
      hasPointerCapture: (pointerId: number) => capturedPointers.has(pointerId),
      releasePointerCapture: (pointerId: number) => { released.push(pointerId); capturedPointers.delete(pointerId) },
      setPointerCapture: (pointerId: number) => { captured.push(pointerId); capturedPointers.add(pointerId) },
    },
    onSelectionStep: (step) => selectionSteps.push(step),
  })

  controller.start({ pointerId: 7, clientX: 400, clientY: 300 })
  controller.move({ pointerId: 7, clientX: 400, clientY: 10_000 })
  assert.deepEqual(captured, [7])
  assert.equal(callbacks.size, 1)
  for (let index = 0; index < expectedSelectionLineFrames; index += 1) {
    const [frame, callback] = callbacks.entries().next().value!
    callbacks.delete(frame)
    callback()
  }
  assert.equal(dispatched.length, expectedSelectionLineFrames)
  assert.equal(dispatched[0].kind, 'wheel')
  assert.equal(dispatched[0].deltaX, 0)
  assert.ok((dispatched[0].deltaY ?? 0) > 0)
  assert.deepEqual(JSON.parse(JSON.stringify(selectionSteps)), [{ x: 0, y: 1 }])
  assert.equal(callbacks.size, 1)

  controller.stop({ pointerId: 7 })
  assert.deepEqual(released, [7])
  assert.equal(callbacks.size, 0)
  assert.ok(cancelled.length > 0)
})

test('Office frame enables autoscroll only for matching Writer and Calc selection drags', () => {
  const source = readFileSync(new URL('./frame.ts', import.meta.url), 'utf8')

  assert.match(source, /ScholarSeedOfficeAutoscroll\.create/)
  assert.match(source, /autoscrollKind\(filename\)/)
  assert.match(source, /documentKind===selectionAutoscrollKind/)
  assert.match(source, /event\.isPrimary&&event\.button===primaryPointerButton/)
  assert.match(source, /selectionAutoscroll\.start\(event\)/)
  assert.match(source, /selectionAutoscrollKind==='writer'\)port\?\.postMessage\(\{cmd:selectionAutoscrollCommand,x:step\.x,y:step\.y\}/)
  assert.match(source, /document\.addEventListener\('pointermove',event=>\{selectionPoint=\{x:event\.clientX,y:event\.clientY\};selectionAutoscroll\.move\(event\)\},true\)/)
  assert.match(source, /selectionAutoscroll\.stop\(event\)/)
  assert.match(source, /canvas\.addEventListener\('lostpointercapture',finishSelectionDrag,true\)/)
  assert.match(source, /hostDocument\.addEventListener\('pointerup',finishSelectionDrag,true\)/)
  assert.match(source, /selectionAutoscroll\.destroy\(\)/)
})
