import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

interface CalcRange {
  StartColumn: number
  StartRow: number
  EndColumn: number
  EndRow: number
}

interface CalcSelection {
  getDataArray: () => unknown[][]
  getCellByPosition: (column: number, row: number) => { getString: () => string }
  queryContentCells: (flags: number) => { getRangeAddresses: () => CalcRange[] }
}

interface CalcSelectionPolicy {
  MAXIMUM_INLINE_CELLS: number
  REFERENCE_MODE: string
  autoscrollKind: (filename: string) => 'writer' | 'calc' | undefined
  writerFormat: (filename: string) => 'doc' | 'docx' | undefined
  captureImpress: (selection: {
    getCount: () => number
    getByIndex: (index: number) => { getName: () => string; getString: () => string }
  }) => { name: string; text: string } | undefined
  describeImpress: (
    model: {
      getDrawPages: () => {
        getCount: () => number
        getByIndex: (index: number) => unknown
      }
    },
    controller: {
      getCurrentPage: () => unknown
      getTransferable?: () => {
        getTransferDataFlavors: () => Array<{ MimeType: string }>
        getTransferData: (flavor: { MimeType: string }) => unknown
      }
    },
    shape: { name: string; text: string } | undefined,
    transferableSupplier?: {
      getTransferable: () => {
        getTransferDataFlavors: () => Array<{ MimeType: string }>
        getTransferData: (flavor: { MimeType: string }) => unknown
      }
    }
  ) => Record<string, unknown> | undefined
  describe: (
    selection: CalcSelection,
    sheet: {
      getName: () => string
      getCellRangeByPosition: (
        startColumn: number,
        startRow: number,
        endColumn: number,
        endRow: number
      ) => CalcSelection
    },
    range: CalcRange,
    contentFlags: number
  ) => Record<string, unknown>
}

interface WriterSelectionProcessor {
  FORMAT: 'doc' | 'docx'
  MAXIMUM_CONTEXT_CHARS: number
  createInspector: (sameObject: (left: unknown, right: unknown) => boolean) => {
    describe: (selection: unknown) =>
      | {
          writerRange?: unknown
          selection: Record<string, unknown>
        }
      | undefined
    prepare: (body: unknown) => void
    invalidate: () => void
  }
}

interface WriterPoint {
  offset: number
}

interface WriterParagraph {
  getEnd: () => WriterPoint
  getStart: () => WriterPoint
  getString: () => string
}

function writerBody(paragraphLengths: number[], calls: string[]) {
  const paragraphs: WriterParagraph[] = []
  let offset = 0
  for (const length of paragraphLengths) {
    const start = offset
    const end = start + length
    paragraphs.push({
      getEnd: () => ({ offset: end }),
      getStart: () => ({ offset: start }),
      getString: () => 'x'.repeat(length),
    })
    offset = end + 1
  }
  return {
    compareRegionEnds: (left: WriterParagraph, right: WriterPoint) =>
      Math.sign(right.offset - left.getEnd().offset),
    compareRegionStarts: (
      left: WriterParagraph | WriterPoint,
      right: WriterParagraph | WriterPoint
    ) => {
      const leftOffset = 'getStart' in left ? left.getStart().offset : left.offset
      const rightOffset = 'getStart' in right ? right.getStart().offset : right.offset
      return Math.sign(rightOffset - leftOffset)
    },
    createEnumeration: () => {
      calls.push('createEnumeration')
      let index = 0
      return {
        hasMoreElements: () => index < paragraphs.length,
        nextElement: () => paragraphs[index++],
      }
    },
    createTextCursorByRange: (start: WriterPoint) => {
      let end = start.offset
      return {
        getString: () => 'x'.repeat(Math.max(0, end - start.offset)),
        gotoRange: (point: WriterPoint) => {
          end = point.offset
        },
      }
    },
    getString: () => {
      calls.push('getString')
      throw new Error('whole Writer body must not be copied for menu presentation')
    },
  }
}

function writerRange(
  body: ReturnType<typeof writerBody>,
  start: number,
  end: number,
  text: string
) {
  return {
    getEnd: () => ({ offset: end }),
    getStart: () => ({ offset: start }),
    getString: () => text,
    getText: () => body,
  }
}

function policy(): CalcSelectionPolicy {
  const context: Record<string, unknown> = {}
  runInNewContext(readFileSync(new URL('./selection.js', import.meta.url), 'utf8'), context)
  return context.ScholarSeedOfficeSelection as CalcSelectionPolicy
}

function writerPolicy(format: 'doc' | 'docx'): WriterSelectionProcessor {
  const context: Record<string, unknown> = {}
  runInNewContext(readFileSync(new URL(`./${format}.js`, import.meta.url), 'utf8'), context)
  return context[
    format === 'doc' ? 'ScholarSeedOfficeDocSelection' : 'ScholarSeedOfficeDocxSelection'
  ] as WriterSelectionProcessor
}

const CONTENT_CELL_FLAGS = 1 | 2 | 4 | 16

function selection(
  rows: number,
  columns: number,
  calls: string[],
  contentRanges: CalcRange[]
): CalcSelection {
  return {
    getDataArray: () => {
      calls.push('getDataArray')
      return Array.from({ length: rows }, () => Array.from({ length: columns }))
    },
    getCellByPosition: (column, row) => {
      calls.push(`getCellByPosition:${column}:${row}`)
      return { getString: () => `R${row + 1}C${column + 1}` }
    },
    queryContentCells: (flags) => {
      calls.push(`queryContentCells:${flags}`)
      return { getRangeAddresses: () => contentRanges }
    },
  }
}

function sheet(name: string, calls: string[], contentRanges: CalcRange[]) {
  return {
    getName: () => name,
    getCellRangeByPosition: (
      startColumn: number,
      startRow: number,
      endColumn: number,
      endRow: number
    ) => {
      calls.push(`getCellRangeByPosition:${startColumn}:${startRow}:${endColumn}:${endRow}`)
      return selection(endRow - startRow + 1, endColumn - startColumn + 1, calls, contentRanges)
    },
  }
}

test('Calc selection reads at most 150 cells and preserves tabular text', () => {
  const subject = policy()
  const calls: string[] = []
  const result = subject.describe(
    selection(15, 10, calls, [{ StartColumn: 0, StartRow: 0, EndColumn: 9, EndRow: 14 }]),
    sheet('Evidence', calls, []),
    { StartColumn: 0, StartRow: 0, EndColumn: 9, EndRow: 14 },
    CONTENT_CELL_FLAGS
  )

  assert.equal(subject.MAXIMUM_INLINE_CELLS, 150)
  assert.equal(result.kind, 'calc')
  assert.equal(result.sheet, 'Evidence')
  assert.equal(result.content_mode, undefined)
  assert.equal(String(result.text).split('\n').length, 15)
  assert.deepEqual(calls.slice(0, 2), [`queryContentCells:${CONTENT_CELL_FLAGS}`, 'getDataArray'])
  assert.equal(calls.filter((call) => call.startsWith('getCellByPosition:')).length, 150)
})

test('Calc selection above 150 cells becomes a reference without reading any cell', () => {
  const subject = policy()
  for (const range of [
    { StartColumn: 0, StartRow: 0, EndColumn: 0, EndRow: 150 },
    { StartColumn: 0, StartRow: 0, EndColumn: 16_383, EndRow: 0 },
    { StartColumn: 0, StartRow: 0, EndColumn: 0, EndRow: 1_048_575 },
  ]) {
    const calls: string[] = []
    const result = subject.describe(
      selection(1, 1, calls, [range]),
      sheet('Evidence', calls, []),
      range,
      CONTENT_CELL_FLAGS
    )
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      kind: 'calc',
      sheet: 'Evidence',
      range,
      content_mode: subject.REFERENCE_MODE,
    })
    assert.deepEqual(calls, [`queryContentCells:${CONTENT_CELL_FLAGS}`])
  }
})

test('Impress selection reports the exact native text range and current slide', () => {
  const subject = policy()
  const firstPage = {}
  const currentPage = {}
  const selectedText = '😀 selected'
  const fullText = `prefix ${selectedText} suffix`
  const result = subject.describeImpress(
    {
      getDrawPages: () => ({
        getCount: () => 2,
        getByIndex: (index) => (index === 0 ? firstPage : currentPage),
      }),
    },
    {
      getCurrentPage: () => currentPage,
    },
    { name: 'EvidenceShape', text: fullText },
    {
      getTransferable: () => ({
        getTransferDataFlavors: () => [{ MimeType: 'text/plain;charset=utf-16' }],
        getTransferData: () => selectedText,
      }),
    }
  )

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    kind: 'impress',
    slide: 2,
    shape: 'EvidenceShape',
    start: 7,
    end: 18,
    text: selectedText,
    context_text: fullText,
  })
})

test('Impress selection fails closed when selected text is ambiguous within the shape', () => {
  const subject = policy()
  const page = {}
  const result = subject.describeImpress(
    {
      getDrawPages: () => ({ getCount: () => 1, getByIndex: () => page }),
    },
    {
      getCurrentPage: () => page,
      getTransferable: () => ({
        getTransferDataFlavors: () => [{ MimeType: 'text/plain;charset=utf-16' }],
        getTransferData: () => 'repeat',
      }),
    },
    { name: 'RepeatedShape', text: 'repeat then repeat' }
  )

  assert.equal(result, undefined)
})

test('Impress selection resolves a legacy PPT text-edit selection from the current page', () => {
  const subject = policy()
  const selectedText = 'test'
  const shape = { getName: () => 'Title 1', getString: () => 'This is a test title' }
  const page = { getCount: () => 1, getByIndex: () => shape }
  const result = subject.describeImpress(
    { getDrawPages: () => ({ getCount: () => 1, getByIndex: () => page }) },
    {
      getCurrentPage: () => page,
      getTransferable: () => ({
        getTransferDataFlavors: () => [{ MimeType: 'text/plain;charset=utf-16' }],
        getTransferData: () => selectedText,
      }),
    },
    undefined
  )

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    kind: 'impress',
    slide: 1,
    shape: 'Title 1',
    start: 10,
    end: 14,
    text: selectedText,
    context_text: 'This is a test title',
  })
})

test('Calc whole-column selection stops at its last content cell before applying the inline limit', () => {
  const subject = policy()
  const calls: string[] = []
  const fullColumn = { StartColumn: 2, StartRow: 0, EndColumn: 2, EndRow: 1_048_575 }
  const content = { StartColumn: 2, StartRow: 0, EndColumn: 2, EndRow: 10 }
  const result = subject.describe(
    selection(1_048_576, 1, calls, [content]),
    sheet('Data', calls, [content]),
    fullColumn,
    CONTENT_CELL_FLAGS
  )

  assert.deepEqual(JSON.parse(JSON.stringify(result.range)), content)
  assert.equal(result.content_mode, undefined)
  assert.equal(String(result.text).split('\n').length, 11)
  assert.deepEqual(calls.slice(0, 2), [
    `queryContentCells:${CONTENT_CELL_FLAGS}`,
    'getCellRangeByPosition:2:0:2:10',
  ])
  assert.equal(calls.filter((call) => call.startsWith('getCellByPosition:')).length, 11)
})

test('Calc empty whole-column selection does not create a synthetic reference', () => {
  const subject = policy()
  const calls: string[] = []
  const fullColumn = { StartColumn: 3, StartRow: 0, EndColumn: 3, EndRow: 1_048_575 }
  const result = subject.describe(
    selection(1_048_576, 1, calls, []),
    sheet('Data', calls, []),
    fullColumn,
    CONTENT_CELL_FLAGS
  )

  assert.equal(result.text, '')
  assert.equal(result.content_mode, undefined)
  assert.deepEqual(calls, [`queryContentCells:${CONTENT_CELL_FLAGS}`])
})

test('Writer selection reuses its prepared paragraph index without copying the whole document', () => {
  const calls: string[] = []
  const body = writerBody([5, 5, 5], calls)
  const subject = writerPolicy('docx')
  const inspector = subject.createInspector((left, right) => left === right)
  inspector.prepare(body)

  const first = inspector.describe(writerRange(body, 2, 13, 'rst\nsecond\nth'))
  const second = inspector.describe(writerRange(body, 7, 10, 'econ'))

  assert.equal(subject.MAXIMUM_CONTEXT_CHARS, 36_000)
  assert.deepEqual(JSON.parse(JSON.stringify(first?.selection)), {
    kind: 'writer',
    format: 'docx',
    paragraph: 'paragraph-1',
    end_paragraph: 'paragraph-3',
    start: 2,
    end: 1,
    text: 'rst\nsecond\nth',
    context_text: 'rst\nsecond\nth',
  })
  assert.equal(second?.selection.paragraph, 'paragraph-2')
  assert.deepEqual(calls, ['createEnumeration'])
})

test('Writer selection normalizes legacy multi-range order before building its locator', () => {
  const calls: string[] = []
  const body = writerBody([5, 5, 5], calls)
  const inspector = writerPolicy('doc').createInspector((left, right) => left === right)
  inspector.prepare(body)
  const later = writerRange(body, 12, 14, 'th')
  const earlier = writerRange(body, 2, 5, 'rst')

  const result = inspector.describe({
    getByIndex: (index: number) => [later, earlier][index],
    getCount: () => 2,
  })

  assert.equal(result?.selection.text, 'rst\nth')
  assert.equal(result?.selection.format, 'doc')
  assert.equal(result?.selection.paragraph, 'paragraph-1')
  assert.equal(result?.selection.end_paragraph, 'paragraph-3')
  assert.equal(result?.writerRange, undefined)
})

test('legacy DOC prefers its cross-page range collection over the truncated direct range', () => {
  const calls: string[] = []
  const body = writerBody([5, 5, 5], calls)
  const inspector = writerPolicy('doc').createInspector((left, right) => left === right)
  inspector.prepare(body)
  const later = writerRange(body, 12, 14, 'th')
  const earlier = writerRange(body, 2, 5, 'rst')
  const direct = writerRange(body, 2, 5, 'rst')

  const result = inspector.describe({
    ...direct,
    getByIndex: (index: number) => [later, earlier][index],
    getCount: () => 2,
  })

  assert.equal(result?.selection.text, 'rst\nth')
  assert.equal(result?.selection.end_paragraph, 'paragraph-3')
  assert.equal(result?.writerRange, undefined)
})

test('DOCX retains its direct Writer range when a collection is also exposed', () => {
  const calls: string[] = []
  const body = writerBody([5, 5, 5], calls)
  const inspector = writerPolicy('docx').createInspector((left, right) => left === right)
  inspector.prepare(body)
  const direct = writerRange(body, 2, 5, 'rst')
  const hybrid = {
    ...direct,
    getByIndex: (index: number) =>
      [writerRange(body, 12, 14, 'th'), writerRange(body, 2, 5, 'rst')][index],
    getCount: () => 2,
  }

  const result = inspector.describe(hybrid)

  assert.equal(result?.selection.text, 'rst')
  assert.equal(result?.selection.end_paragraph, 'paragraph-1')
  assert.equal(result?.writerRange, hybrid)
})

test('Writer paragraph indexes invalidate after document edits', () => {
  const calls: string[] = []
  const body = writerBody([5], calls)
  const inspector = writerPolicy('docx').createInspector((left, right) => left === right)
  inspector.prepare(body)
  inspector.invalidate()
  inspector.describe(writerRange(body, 0, 3, 'abc'))

  assert.deepEqual(calls, ['createEnumeration', 'createEnumeration'])
})

test('Writer selection locates paragraph endpoints logarithmically', () => {
  const calls: string[] = []
  const body = writerBody(
    Array.from({ length: 1_024 }, () => 5),
    calls
  )
  const compareStarts = body.compareRegionStarts
  const compareEnds = body.compareRegionEnds
  let comparisons = 0
  body.compareRegionStarts = (left, right) => {
    comparisons += 1
    return compareStarts(left, right)
  }
  body.compareRegionEnds = (left, right) => {
    comparisons += 1
    return compareEnds(left, right)
  }
  const inspector = writerPolicy('docx').createInspector((left, right) => left === right)
  inspector.prepare(body)

  const result = inspector.describe(writerRange(body, 6_138, 6_140, 'xy'))

  assert.equal(result?.selection.paragraph, 'paragraph-1024')
  assert.ok(comparisons < 80, `expected logarithmic lookup, received ${comparisons} comparisons`)
})

test('Writer formats resolve legacy DOC and OOXML DOCX through distinct profiles', () => {
  const subject = policy()

  assert.equal(subject.writerFormat('legacy.DOC'), 'doc')
  assert.equal(subject.writerFormat('modern.docx'), 'docx')
  assert.equal(subject.writerFormat('notes.odt'), undefined)
  assert.equal(writerPolicy('doc').FORMAT, 'doc')
  assert.equal(writerPolicy('docx').FORMAT, 'docx')
})

test('Office selection autoscroll recognizes Writer and Calc formats', () => {
  const subject = policy()

  assert.equal(subject.autoscrollKind('report.doc'), 'writer')
  assert.equal(subject.autoscrollKind('REPORT.DOCX'), 'writer')
  assert.equal(subject.autoscrollKind('data.csv'), 'calc')
  assert.equal(subject.autoscrollKind('legacy.XLS'), 'calc')
  assert.equal(subject.autoscrollKind('table.xlsx'), 'calc')
  assert.equal(subject.autoscrollKind('slides.pptx'), undefined)
})

test('explicit Writer selection commit reports immediately instead of restarting debounce', async () => {
  const source = readFileSync(new URL('./office-thread.js', import.meta.url), 'utf8')
  const messages: Array<{ cmd: string; selection?: { text: string } }> = []
  const timers = new Map<number, () => void>()
  let nextTimer = 0
  const port: {
    onmessage: null | ((event: { data: { cmd: string } }) => void)
    postMessage: (message: { cmd: string; selection?: { text: string } }) => void
  } = {
    onmessage: null,
    postMessage: (message) => messages.push(message),
  }
  const module = {
    zetajs: Promise.resolve({
      mainPort: port,
      getUnoComponentContext: () => ({}),
      uno: { com: { sun: { star: { frame: { Desktop: { create: () => ({}) } } } } } },
    }),
  }
  const model = { getCurrentController: () => ({ getSelection: () => ({}) }) }
  const inspector = {
    describe: () => ({ selection: { kind: 'writer', format: 'docx', text: 'selected' } }),
  }
  runInNewContext(
    `${source}\nxModel = model; documentKind = 'writer'; writerSelection = inspector; scheduleSelectionReport()`,
    {
      Module: module,
      model,
      inspector,
      console,
      performance: { now: () => 0 },
      setTimeout: (callback: () => void) => {
        timers.set(++nextTimer, callback)
        return nextTimer
      },
      clearTimeout: (timer: number) => {
        timers.delete(timer)
      },
    }
  )
  await module.zetajs
  port.onmessage!({ data: { cmd: 'selection_commit' } })
  assert.equal(timers.size, 0)
  assert.equal(messages.at(-1)?.selection?.text, 'selected')
})
