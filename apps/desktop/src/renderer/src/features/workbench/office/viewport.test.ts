import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const threadSource = readFileSync(new URL('./office-thread.js', import.meta.url), 'utf8')
const frameSource = readFileSync(new URL('./frame.ts', import.meta.url), 'utf8')

test('Writer load completion triggers paint even without a later layout event', () => {
  const source = threadSource.slice(threadSource.indexOf('function observeLayout('), threadSource.indexOf('function loadFile('))
  const messages: Record<string, unknown>[] = []
  let listener: { documentEventOccured: (event: { EventName: string }) => void }
  const context = {
    css: { frame: { GlobalEventBroadcaster: { create: () => ({ addDocumentEventListener: (value: typeof listener) => { listener = value } }) } }, document: { XDocumentEventListener: {} } },
    zetajs: { getUnoComponentContext: () => ({}), unoObject: (_types: unknown, value: typeof listener) => value },
    post: (message: Record<string, unknown>) => messages.push(message)
  }
  const events = threadSource.slice(threadSource.indexOf('const DOCUMENT_READY_EVENTS'), threadSource.indexOf('\n', threadSource.indexOf('const DOCUMENT_READY_EVENTS')))
  runInNewContext(events + '\n' + source + ';observeLayout("original-docx");', context)
  listener!.documentEventOccured({ EventName: 'OnLoadFinished' })
  assert.equal(messages.at(-1)?.cmd, 'layout_finished')
  assert.equal(messages.at(-1)?.bindingId, 'original-docx')
  listener!.documentEventOccured({ EventName: 'OnModifyChanged' })
  assert.equal(messages.at(-1)?.cmd, 'document_event')
})

test('viewport resize runs in the worker owning the canvas without reloading the model', async () => {
  const messages: unknown[] = []
  const port = {
    onmessage: null as null | ((event: { data: { cmd: string; bindingId?: string; requestId?: number } }) => void),
    postMessage: (message: unknown) => messages.push(message)
  }
  let redraws = 0
  const canvas = { width: 2048, height: 1536 }
  const module = {
    canvas,
    qtResizeAllScreens: () => { redraws++; canvas.width = 2880 },
    zetajs: Promise.resolve({
      mainPort: port,
      getUnoComponentContext: () => ({}),
      uno: { com: { sun: { star: { frame: { Desktop: { create: () => ({}) } } } } } }
    })
  }
  runInNewContext(threadSource, { Module: module, console })
  await module.zetajs
  port.onmessage!({ data: { cmd: 'resize_viewport', bindingId: 'binding-1', requestId: 7 } })
  assert.equal(redraws, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    cmd: 'viewport_resized', bindingId: 'binding-1', requestId: 7, width: 2880, height: 1536
  })
})

test('a native document exception returns a binding-scoped failure instead of hanging', async () => {
  const messages: Record<string, unknown>[] = []
  const port = { onmessage: null as null | ((event: { data: Record<string, unknown> }) => void), postMessage: (message: Record<string, unknown>) => messages.push(message) }
  const module = { zetajs: Promise.resolve({
    mainPort: port,
    getUnoComponentContext: () => ({}),
    unoObject: (_types: unknown, value: unknown) => value,
    uno: { com: { sun: { star: {
      beans: { PropertyValue: class {} },
      document: { XDocumentEventListener: {} },
      frame: {
        Desktop: { create: () => ({ loadComponentFromURL: () => { throw new Error('native document load failed') } }) },
        GlobalEventBroadcaster: { create: () => ({ addDocumentEventListener() {} }) }
      }
    } } } }
  }) }
  runInNewContext(threadSource, { Module: module, console })
  await module.zetajs
  port.onmessage!({ data: { cmd: 'upload', filename: 'generated.docx', bindingId: 'ai-artifact-1' } })
  assert.equal(messages.at(-1)?.cmd, 'document_failed')
  assert.equal(messages.at(-1)?.bindingId, 'ai-artifact-1')
  assert.match(String(messages.at(-1)?.detail), /native document load failed/)
})

test('viewport requests coalesce and use the Office worker port', () => {
  const source = frameSource.slice(frameSource.indexOf('function resizeViewport()'), frameSource.indexOf("window.addEventListener('error'"))
  const callbacks = new Map<number, () => void>()
  const messages: unknown[] = []
  let sequence = 0
  const context = {
    viewportResizeFrame: 0,
    viewportRequestSequence: 0,
    viewportResizeCommand: 'resize_viewport',
    bindingId: 'binding-1',
    disposed: false,
    port: { postMessage: (message: unknown) => messages.push(message) },
    requestAnimationFrame: (callback: () => void) => { callbacks.set(++sequence, callback); return sequence },
    cancelAnimationFrame: (id: number) => callbacks.delete(id)
  }
  runInNewContext(`${source};scheduleViewportResize();scheduleViewportResize();scheduleViewportResize();`, context)
  assert.equal(callbacks.size, 1)
  callbacks.values().next().value!()
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    cmd: 'resize_viewport', bindingId: 'binding-1', requestId: 1
  }])
})
