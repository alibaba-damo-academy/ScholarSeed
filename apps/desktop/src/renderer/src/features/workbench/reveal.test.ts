import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { selectionLocator, textSelectionRange } from './reveal.ts'

test('selection locator accepts each supported viewer and rejects malformed coordinates', () => {
  const valid = [
    { kind: 'markdown', start: 0, end: 4, source_map_version: 'md-source-v1' },
    { kind: 'text', start_line: 0, start_column: 0, end_line: 1, end_column: 3 },
    { kind: 'pdf', page: 2, quads: [[0, 0, 0.5, 0.1]] },
    { kind: 'writer', format: 'doc', paragraph: 'paragraph-1', start: 0, end: 3 },
    { kind: 'writer', format: 'docx', paragraph: 'paragraph-2', start: 0, end: 3 },
    { kind: 'writer', paragraph: 'paragraph-2', start: 0, end: 3 },
    { kind: 'calc', sheet: 'Sheet 2', range: 'A1:B3' },
    { kind: 'impress', slide: 2, shape: 'shape-1', start: 0, end: 3 },
  ]
  for (const locator of valid) assert.equal(selectionLocator(locator), locator)
  for (const invalid of [
    null,
    {},
    { kind: 'unknown' },
    { ...valid[0], end: -1 },
    { ...valid[1], start_line: -1 },
    { ...valid[2], quads: [[NaN]] },
    { ...valid[3], format: 'exe' },
  ])
    assert.equal(selectionLocator(invalid), undefined)
})

test('text navigation converts persisted zero-based UTF-16 positions to editor coordinates', () => {
  assert.deepEqual(
    textSelectionRange({
      kind: 'text',
      start_line: 0,
      start_column: 0,
      end_line: 2,
      end_column: 7,
    }),
    { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 8 }
  )
})

function nativeSelection(): {
  pulse: (
    controller: unknown,
    target: unknown,
    collapsed: unknown,
    kind: string,
    expanded: boolean
  ) => number | undefined
  locate: (
    model: unknown,
    locator: unknown,
    text: string
  ) => { target: unknown; collapsed: unknown }
} {
  const context: Record<string, unknown> = {}
  runInNewContext(readFileSync(new URL('./office/selection.js', import.meta.url), 'utf8'), context)
  return context.ScholarSeedOfficeSelection as ReturnType<typeof nativeSelection>
}

test('native Writer pulse collapses the live view cursor and restores both exact endpoints', () => {
  const calls: unknown[] = []
  const cursor = {
    collapseToStart: () => calls.push('collapse'),
    gotoRange: (point: number, expand: boolean) => calls.push([point, expand]),
    getString: () => '',
  }
  const controller = { getViewCursor: () => cursor }
  const target = { getStart: () => 3, getEnd: () => 9 }
  nativeSelection().pulse(controller, target, null, 'writer', false)
  nativeSelection().pulse(controller, target, null, 'writer', true)
  assert.deepEqual(calls, ['collapse', [3, false], [9, true]])
})

function textBody(text: string) {
  function cursor(point: { offset: number }) {
    let start = point.offset
    let end = start
    return {
      goRight(count: number, expand: boolean) {
        if (end + count > text.length) return false
        end += count
        if (!expand) start = end
        return true
      },
      gotoStart() {
        start = 0
        end = 0
      },
      gotoRange(target: { offset?: number; getStart?: () => { offset: number } }, expand: boolean) {
        end = target.offset ?? target.getStart!().offset
        if (!expand) start = end
      },
      getStart: () => ({ offset: start }),
      getEnd: () => ({ offset: end }),
      getString: () => text.slice(start, end),
    }
  }
  const paragraphs = text.split('\n').map((value, index, lines) => {
    const offset = lines.slice(0, index).reduce((sum, line) => sum + line.length + 1, 0)
    return { getStart: () => ({ offset }), getEnd: () => ({ offset: offset + value.length }) }
  })
  return {
    createTextCursor: () => cursor({ offset: 0 }),
    createTextCursorByRange: cursor,
    createEnumeration: () => {
      let index = 0
      return {
        hasMoreElements: () => index < paragraphs.length,
        nextElement: () => paragraphs[index++],
      }
    },
  }
}

test('native Writer restores exact paragraph offsets for DOC and DOCX without editing bytes', () => {
  const body = textBody('first\nselected words')
  const selected: unknown[] = []
  const model = {
    getText: () => body,
    getCurrentController: () => ({
      select: (target: unknown) => {
        selected.push(target)
        return true
      },
    }),
  }
  for (const format of ['doc', 'docx']) {
    const locator = { kind: 'writer', format, paragraph: 'paragraph-2', start: 0, end: 8 }
    const result = nativeSelection().locate(model, locator, 'selected')
    assert.equal((result.target as { getString: () => string }).getString(), 'selected')
    assert.throws(
      () => nativeSelection().locate(model, locator, 'changed'),
      /selection_content_changed/
    )
  }
  assert.equal(selected.length, 2)
})

test('native Calc selects the recorded sheet and range, and rejects changed cell contents', () => {
  const emptyRanges = {}
  const range = {
    getDataArray: () => [['A', 'B']],
    getCellByPosition: (column: number) => ({ getString: () => ['A', 'B'][column] }),
  }
  const sheet = {
    getCellRangeByName: (address: string) => {
      assert.equal(address, 'A1:B1')
      return range
    },
  }
  const selected: unknown[] = []
  const controller = {
    setActiveSheet: (target: unknown) => assert.equal(target, sheet),
    select: (target: unknown) => {
      selected.push(target)
      return true
    },
  }
  const model = {
    getCurrentController: () => controller,
    createInstance: (service: string) => {
      assert.equal(service, 'com.sun.star.sheet.SheetCellRanges')
      return emptyRanges
    },
    getSheets: () => ({
      getByName: (name: string) => {
        assert.equal(name, 'Second')
        return sheet
      },
    }),
  }
  const locator = { kind: 'calc', sheet: 'Second', range: 'A1:B1' }
  const located = nativeSelection().locate(model, locator, 'A\tB')
  assert.equal(located.target, range)
  assert.equal(located.collapsed, emptyRanges)
  nativeSelection().pulse(controller, located.target, located.collapsed, 'calc', false)
  assert.equal(selected.at(-1), emptyRanges)
  nativeSelection().pulse(controller, located.target, located.collapsed, 'calc', true)
  assert.equal(selected.at(-1), range)
  assert.throws(
    () => nativeSelection().locate(model, locator, 'changed'),
    /selection_content_changed/
  )
  assert.equal(selected.length, 3)
})

test('native Impress restores the recorded slide and shape text interval', () => {
  const shape = {
    ...textBody('selected words'),
    getName: () => 'Title',
    getString: () => 'selected words',
  }
  const page = { getCount: () => 1, getByIndex: () => shape }
  const controller = {
    setCurrentPage: (target: unknown) => assert.equal(target, page),
    select: () => true,
  }
  const model = {
    getCurrentController: () => controller,
    getDrawPages: () => ({
      getByIndex: (index: number) => {
        assert.equal(index, 1)
        return page
      },
    }),
  }
  const result = nativeSelection().locate(
    model,
    { kind: 'impress', slide: 2, shape: 'Title', start: 0, end: 8 },
    'selected'
  )
  assert.equal((result.target as { getString: () => string }).getString(), 'selected')
})
