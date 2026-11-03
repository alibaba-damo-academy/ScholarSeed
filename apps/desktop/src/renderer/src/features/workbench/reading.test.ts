import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { type TestContext } from 'node:test'
import type { EditorView } from '@milkdown/kit/prose/view'
import { EditorView as CodeEditorView } from '@codemirror/view'

import { preserveMarkdownReadingPosition } from './reading.ts'

test('workbench fills the split panel so documents own their scrolling', () => {
  const shell = readFileSync(new URL('../../shell/WorkbenchShell.tsx', import.meta.url), 'utf8')
  assert.match(shell, /<main\s+className="vds-workbench-main h-full min-h-0"(?:\s+[^>]*)?>/)
})

function fixture(context: TestContext) {
  let resize = (): void => {}
  let mutate = (): void => {}
  let scroll = (): void => {}
  let disconnected = 0
  let removed = false
  let contentTop = 510
  let selectedPosition = 10
  let measuredPosition = 0
  const codeElements: HTMLElement[] = []
  const styles = new Map<string, string>([['overflow-anchor', 'auto']])
  const previousResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
  const previousMutationObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')
  context.after(() => {
    if (previousResizeObserver)
      Object.defineProperty(globalThis, 'ResizeObserver', previousResizeObserver)
    else Reflect.deleteProperty(globalThis, 'ResizeObserver')
    if (previousMutationObserver)
      Object.defineProperty(globalThis, 'MutationObserver', previousMutationObserver)
    else Reflect.deleteProperty(globalThis, 'MutationObserver')
  })
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe() {}
      disconnect() {
        disconnected += 1
      }
    },
  })
  Object.defineProperty(globalThis, 'MutationObserver', {
    configurable: true,
    value: class {
      constructor(callback: () => void) {
        mutate = callback
      }
      observe() {}
      disconnect() {
        disconnected += 1
      }
    },
  })
  const scroller = {
    clientWidth: 600,
    clientHeight: 800,
    scrollTop: 500,
    getBoundingClientRect: () => ({ top: 48, left: 0 }),
    addEventListener: (_event: string, listener: () => void) => {
      scroll = listener
    },
    removeEventListener: () => {
      removed = true
    },
    style: {
      getPropertyValue: (name: string) => styles.get(name) ?? '',
      getPropertyPriority: () => '',
      setProperty: (name: string, value: string) => {
        styles.set(name, value)
      },
      removeProperty: (name: string) => {
        styles.delete(name)
      },
    },
  }
  const view = {
    dom: {
      getBoundingClientRect: () => ({ left: 64, top: 0 }),
      querySelectorAll: () => codeElements,
    },
    posAtCoords: () => ({ pos: selectedPosition }),
    coordsAtPos: (position: number) => {
      measuredPosition = position
      return { top: 48 + contentTop - scroller.scrollTop }
    },
    state: { doc: { content: { size: 100 } } },
  }
  const dispose = preserveMarkdownReadingPosition(
    scroller as unknown as HTMLElement,
    view as unknown as EditorView
  )
  return {
    scroller,
    view,
    styles,
    dispose,
    codeElements,
    resize: () => resize(),
    mutate: () => mutate(),
    scroll: () => scroll(),
    moveContent: (top: number) => {
      contentTop = top
    },
    selectPosition: (position: number) => {
      selectedPosition = position
    },
    measuredPosition: () => measuredPosition,
    disconnected: () => disconnected,
    removed: () => removed,
  }
}

test('width reflow preserves the visible document position in both directions', (context) => {
  const state = fixture(context)
  state.scroller.clientWidth = 900
  state.moveContent(390)
  state.resize()
  assert.equal(state.scroller.scrollTop, 380)
  state.scroller.clientWidth = 600
  state.moveContent(510)
  state.resize()
  assert.equal(state.scroller.scrollTop, 500)
  state.dispose()
})

test('scroll and mutation events after width changes cannot overwrite the old anchor', (context) => {
  const state = fixture(context)
  state.scroller.clientWidth = 900
  state.selectPosition(30)
  state.moveContent(390)
  state.scroll()
  state.mutate()
  assert.equal(state.measuredPosition(), 10)
  state.resize()
  assert.equal(state.scroller.scrollTop, 380)
  state.dispose()
})

test('ordinary user scrolling refreshes the anchor without correction', (context) => {
  const state = fixture(context)
  state.scroller.scrollTop = 300
  state.selectPosition(5)
  state.scroll()
  assert.equal(state.measuredPosition(), 5)
  state.resize()
  assert.equal(state.scroller.scrollTop, 300)
  state.dispose()
})

test('the top of the document stays at the top', (context) => {
  const state = fixture(context)
  state.scroller.scrollTop = 0
  state.scroll()
  state.scroller.clientWidth = 900
  state.moveContent(100)
  state.resize()
  assert.equal(state.scroller.scrollTop, 0)
  state.dispose()
})

test('hidden views and removed document positions are not restored', (context) => {
  const state = fixture(context)
  state.scroller.clientWidth = 0
  state.resize()
  assert.equal(state.scroller.scrollTop, 500)
  state.view.state.doc.content.size = 1
  state.selectPosition(1)
  state.scroller.clientWidth = 900
  state.resize()
  assert.equal(state.scroller.scrollTop, 500)
  state.dispose()
})

test('cleanup removes observers without changing native scroll anchoring', (context) => {
  const state = fixture(context)
  assert.equal(state.styles.get('overflow-anchor'), 'auto')
  state.dispose()
  assert.equal(state.styles.get('overflow-anchor'), 'auto')
  assert.equal(state.disconnected(), 2)
  assert.equal(state.removed(), true)
})

test('native anchoring that already preserved the position is not applied twice', (context) => {
  const state = fixture(context)
  state.scroller.clientWidth = 900
  state.moveContent(390)
  state.scroller.scrollTop = 380
  state.scroll()
  state.resize()
  assert.equal(state.scroller.scrollTop, 380)
  state.dispose()
})

test('a visible code line uses the embedded editor position instead of the entire code block', (context) => {
  const state = fixture(context)
  let lineTop = 506
  const code = {
    dom: { isConnected: true },
    contentDOM: { getBoundingClientRect: () => ({ left: 100 }) },
    state: { doc: { length: 200 } },
    posAtCoords: () => 80,
    coordsAtPos: (position: number) => {
      assert.equal(position, 80)
      return { top: 48 + lineTop - state.scroller.scrollTop }
    },
  }
  context.mock.method(CodeEditorView, 'findFromDOM', () => code as unknown as CodeEditorView)
  state.codeElements.push({ getBoundingClientRect: () => ({ top: 0, bottom: 200 }) } as HTMLElement)
  state.scroll()
  state.scroller.clientWidth = 900
  lineTop = 406
  state.resize()
  assert.equal(state.scroller.scrollTop, 400)
  state.dispose()
})
