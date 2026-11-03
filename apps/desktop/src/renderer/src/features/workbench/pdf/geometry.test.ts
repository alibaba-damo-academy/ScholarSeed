import assert from 'node:assert/strict'
import test from 'node:test'
import { matchReadingText } from './geometry.ts'
import {
  citationRegions,
  clipQuads,
  enclosingRectangle,
  fittedScale,
  matchText,
  mostVisiblePage,
  nearestRectangle,
  nextFitMode,
  pageInSelectionSpan,
  pageNumber,
  pdfSelectionShape,
  percentScale,
  projectVisibleMarks,
  selectionPageText,
  normalizeHighlightQuads,
  normalizeQuads,
} from './geometry.ts'
import { internalLink, outlineTree, resolveDestination } from './navigation.ts'
import { PDF_MARK_PALETTE } from './records.ts'

test('mark geometry merges duplicate and overlapping fragments without crossing lines or columns', () => {
  const quads = [
    [0.1, 0.2, 0.4, 0.22],
    [0.1, 0.2, 0.4, 0.22],
    [0.3, 0.2, 0.5, 0.22],
    [0.6, 0.2, 0.8, 0.22],
    [0.1, 0.23, 0.5, 0.25],
  ]
  assert.deepEqual(normalizeQuads(quads), [
    [0.1, 0.2, 0.5, 0.22],
    [0.6, 0.2, 0.8, 0.22],
    [0.1, 0.23, 0.5, 0.25],
  ])
  assert.equal(quads.length, 5)
})

test('geometry retains separate superscripts and rejects empty or non-finite rectangles', () => {
  const quads = [
    [0.1, 0.2, 0.4, 0.22],
    [0.4, 0.195, 0.42, 0.205],
  ]
  assert.deepEqual(normalizeQuads([...quads, [0, 0, 0, 1], [0, NaN, 1, 1]]), [quads[1], quads[0]])
  assert.deepEqual(normalizeQuads(normalizeQuads(quads)), [quads[1], quads[0]])
})

test('highlight projection separates adjacent lines with overlapping glyph bounds', () => {
  const quads = [
    [0.1, 0.2, 0.8, 0.21822],
    [0.1, 0.21609, 0.8, 0.23431],
    [0.1, 0.23218, 0.8, 0.2504],
  ]
  const firstBoundary = (0.21822 + 0.21609) / 2
  const secondBoundary = (0.23431 + 0.23218) / 2
  const expected = [
    [0.1, 0.2, 0.8, firstBoundary],
    [0.1, firstBoundary, 0.8, secondBoundary],
    [0.1, secondBoundary, 0.8, 0.2504],
  ]
  assert.deepEqual(normalizeHighlightQuads(quads), expected)
  assert.deepEqual(
    projectVisibleMarks([{ id: 'old', style: 'highlight', created_at: 1, quads }])[0]?.quads,
    expected
  )
  assert.deepEqual(quads, [
    [0.1, 0.2, 0.8, 0.21822],
    [0.1, 0.21609, 0.8, 0.23431],
    [0.1, 0.23218, 0.8, 0.2504],
  ])
})

test('highlight projection separates neighboring lines from different saved marks', () => {
  const projected = projectVisibleMarks([
    { id: 'upper', style: 'highlight', created_at: 1, quads: [[0.1, 0.2, 0.8, 0.21822]] },
    { id: 'lower', style: 'highlight', created_at: 2, quads: [[0.1, 0.21609, 0.8, 0.23431]] },
  ])
  assert.deepEqual(
    projected.map(({ mark, quads }) => [mark.id, quads]),
    [
      ['lower', [[0.1, 0.217155, 0.8, 0.23431]]],
      ['upper', [[0.1, 0.2, 0.8, 0.217155]]],
    ]
  )
})

test('highlight line separation leaves other styles, columns and superscripts unchanged', () => {
  const columns = [
    [0.1, 0.2, 0.4, 0.22],
    [0.6, 0.217, 0.9, 0.237],
  ]
  assert.deepEqual(normalizeHighlightQuads(columns), columns)
  const superscript = [
    [0.1, 0.2, 0.4, 0.22],
    [0.4, 0.195, 0.42, 0.205],
  ]
  assert.deepEqual(normalizeHighlightQuads(superscript), [superscript[1], superscript[0]])
  const overhangingSuperscript = [
    [0.1, 0.2, 0.4, 0.22],
    [0.395, 0.195, 0.42, 0.205],
  ]
  assert.deepEqual(normalizeHighlightQuads(overhangingSuperscript), [
    overhangingSuperscript[1],
    overhangingSuperscript[0],
  ])
  const nestedSuperscript = [
    [0.1, 0.2, 0.4, 0.22],
    [0.3, 0.195, 0.33, 0.205],
  ]
  assert.deepEqual(normalizeHighlightQuads(nestedSuperscript), [
    nestedSuperscript[1],
    nestedSuperscript[0],
  ])
  const overlapping = [
    [0.1, 0.2, 0.8, 0.21822],
    [0.1, 0.21609, 0.8, 0.23431],
  ]
  assert.deepEqual(
    projectVisibleMarks([{ id: 'line', style: 'underline', created_at: 1, quads: overlapping }])[0]
      ?.quads,
    overlapping
  )
})

test('newer marks of the same style own fully overlapping text geometry', () => {
  const projected = projectVisibleMarks([
    { id: 'old', style: 'underline', created_at: 1, quads: [[0.1, 0.2, 0.8, 0.22]] },
    { id: 'middle', style: 'underline', created_at: 2, quads: [[0.1, 0.2, 0.8, 0.22]] },
    { id: 'new', style: 'underline', created_at: 3, quads: [[0.1, 0.2, 0.8, 0.22]] },
  ])

  assert.deepEqual(
    projected.map(({ mark, quads }) => [mark.id, quads]),
    [['new', [[0.1, 0.2, 0.8, 0.22]]]]
  )
})

test('same-style overlap is split only in the visual projection and restores after deletion', () => {
  const old = { id: 'old', style: 'highlight', created_at: 1, quads: [[0.1, 0.2, 0.8, 0.22]] }
  const middle = {
    id: 'middle',
    style: 'highlight',
    created_at: 2,
    quads: [[0.3, 0.201, 0.6, 0.221]],
  }
  const newest = { id: 'new', style: 'highlight', created_at: 3, quads: [[0.5, 0.199, 0.9, 0.223]] }

  assert.deepEqual(
    projectVisibleMarks([old, middle, newest]).map(({ mark, quads }) => [mark.id, quads]),
    [
      ['new', [[0.5, 0.199, 0.9, 0.223]]],
      ['middle', [[0.3, 0.201, 0.5, 0.221]]],
      ['old', [[0.1, 0.2, 0.3, 0.22]]],
    ]
  )
  assert.deepEqual(
    projectVisibleMarks([old, middle]).map(({ mark, quads }) => [mark.id, quads]),
    [
      ['middle', [[0.3, 0.201, 0.6, 0.221]]],
      [
        'old',
        [
          [0.1, 0.2, 0.3, 0.22],
          [0.6, 0.2, 0.8, 0.22],
        ],
      ],
    ]
  )
})

test('overlap projection keeps different styles and different lines independent', () => {
  const projected = projectVisibleMarks([
    { id: 'highlight', style: 'highlight', created_at: 1, quads: [[0.1, 0.2, 0.8, 0.22]] },
    { id: 'underline', style: 'underline', created_at: 2, quads: [[0.1, 0.2, 0.8, 0.22]] },
    { id: 'next-line', style: 'highlight', created_at: 3, quads: [[0.1, 0.24, 0.8, 0.26]] },
  ])

  assert.deepEqual(
    projected.map(({ mark, quads }) => [mark.id, quads]),
    [
      ['next-line', [[0.1, 0.24, 0.8, 0.26]]],
      ['underline', [[0.1, 0.2, 0.8, 0.22]]],
      ['highlight', [[0.1, 0.2, 0.8, 0.22]]],
    ]
  )
})

test('overlap projection has a deterministic id fallback for equal insertion times', () => {
  const projected = projectVisibleMarks([
    { id: 'a', style: 'strikethrough', created_at: 1, quads: [[0.1, 0.2, 0.8, 0.22]] },
    { id: 'z', style: 'strikethrough', created_at: 1, quads: [[0.1, 0.2, 0.8, 0.22]] },
  ])

  assert.deepEqual(
    projected.map(({ mark }) => mark.id),
    ['z']
  )
})
test('citation view encompasses both columns and exposes disjoint regions in reading order', () => {
  const quads = [
    [0.1, 0.8, 0.4, 0.82],
    [0.1, 0.83, 0.4, 0.85],
    [0.6, 0.1, 0.9, 0.12],
  ]
  assert.deepEqual(citationRegions(quads), [quads.slice(0, 2), quads.slice(2)])
  assert.deepEqual(
    enclosingRectangle(quads.map(([left, top, right, bottom]) => ({ left, top, right, bottom }))),
    { left: 0.1, top: 0.1, right: 0.9, bottom: 0.85 }
  )
  assert.equal(enclosingRectangle([]), undefined)
})

test('PDF destination emphasis selects the nearest valid text rectangle', () => {
  const heading = { left: 70, top: 540, right: 160, bottom: 558 }
  const reference = { left: 73, top: 581, right: 130, bottom: 592 }
  const invalid = { left: 0, top: 0, right: 0, bottom: 0 }
  assert.equal(nearestRectangle([heading, reference, invalid], { x: 73.49, y: 574.72 }), reference)
  assert.equal(nearestRectangle([invalid], { x: 0, y: 0 }), undefined)
})

test('PDF outline navigation preserves nesting and resolves named and explicit destinations', async () => {
  const nodes = [
    { title: 'Introduction', dest: 'intro', items: [] },
    {
      title: 'Methods',
      dest: [{ num: 12, gen: 0 }],
      items: [{ title: 'Experiment', dest: null, items: [] }],
    },
  ]
  const rows = await outlineTree(nodes, {
    namedDestination: async (name: string) => (name === 'intro' ? [{ num: 4, gen: 0 }] : null),
    pageIndex: async (reference: unknown) => (reference as { num: number }).num - 4,
  })
  assert.deepEqual(rows, [
    { title: 'Introduction', page: 1, children: [] },
    { title: 'Methods', page: 9, children: [{ title: 'Experiment', page: null, children: [] }] },
  ])
  assert.deepEqual(
    await outlineTree(null as unknown as [], {
      namedDestination: async () => null,
      pageIndex: async () => 0,
    }),
    []
  )
})

test('PDF outline preserves every depth when one named destination fails', async () => {
  const rows = await outlineTree(
    [
      {
        title: 'Level 1',
        dest: [0],
        items: [
          {
            title: 'Level 2 unavailable',
            dest: 'broken',
            items: [
              {
                title: 'Level 3',
                dest: [2],
                items: [],
              },
            ],
          },
        ],
      },
    ],
    {
      namedDestination: async () => {
        throw new Error('bad destination')
      },
      pageIndex: async () => 0,
    }
  )
  assert.deepEqual(rows, [
    {
      title: 'Level 1',
      page: 1,
      children: [
        {
          title: 'Level 2 unavailable',
          page: null,
          children: [
            {
              title: 'Level 3',
              page: 3,
              children: [],
            },
          ],
        },
      ],
    },
  ])
})

test('PDF internal links resolve named XYZ destinations to normalized page coordinates', async () => {
  const target = await resolveDestination('cite.paper', {
    namedDestination: async () => [{ num: 190, gen: 0 }, { name: 'XYZ' }, 73.49, 267.17, null],
    pageIndex: async () => 12,
    pageViewport: async () => ({
      width: 595.28,
      height: 841.89,
      convertToViewportPoint: (x: number, y: number) => [x, 841.89 - y],
    }),
  })
  assert.deepEqual(target, {
    page: 13,
    left: 73.49 / 595.28,
    top: 574.72 / 841.89,
  })
})

test('PDF internal links interpret FitH destinations as vertical coordinates', async () => {
  const target = await resolveDestination([0, { name: 'FitH' }, 700], {
    namedDestination: async () => null,
    pageIndex: async () => 0,
    pageViewport: async () => ({
      width: 600,
      height: 800,
      convertToViewportPoint: (x: number, y: number) => [x, 800 - y],
    }),
  })
  assert.deepEqual(target, { page: 1, left: 0, top: 0.125 })
})

test('PDF internal links normalize annotation rectangles and reject missing destinations', () => {
  const viewport = {
    width: 595.28,
    height: 841.89,
    convertToViewportPoint: (x: number, y: number) => [x, 841.89 - y],
  }
  assert.deepEqual(
    internalLink(
      {
        id: '15R',
        subtype: 'Link',
        rect: [269.201, 170.552, 274.656, 186.01],
        dest: 'cite.paper',
        overlaidText: '1',
      },
      viewport
    ),
    {
      id: '15R',
      destination: 'cite.paper',
      label: '1',
      rect: [
        269.201 / 595.28,
        (841.89 - 186.01) / 841.89,
        274.656 / 595.28,
        (841.89 - 170.552) / 841.89,
      ],
    }
  )
  assert.equal(internalLink({ id: 'uri', subtype: 'Link', rect: [0, 0, 10, 10] }, viewport), null)
})

test('PDF mark categories are mutually exclusive and comments take precedence', async () => {
  const records = await import('./records.ts')
  const markCategory = Reflect.get(records, 'markCategory')
  const filterMarks = Reflect.get(records, 'filterMarks')
  assert.equal(typeof markCategory, 'function')
  assert.equal(typeof filterMarks, 'function')
  const marks: Array<{ id: string; style: 'highlight' | 'underline' | 'strikethrough' }> = [
    { id: 'highlight', style: 'highlight' },
    { id: 'underline', style: 'underline' },
    { id: 'strikethrough', style: 'strikethrough' },
    { id: 'commented', style: 'underline' },
  ]
  const comments = [{ mark_id: 'commented' }]
  assert.equal(markCategory(marks[3], comments), 'comment')
  assert.deepEqual(
    filterMarks(marks, comments, 'highlight').map((mark: { id: string }) => mark.id),
    ['highlight']
  )
  assert.deepEqual(
    filterMarks(marks, comments, 'underline').map((mark: { id: string }) => mark.id),
    ['underline']
  )
  assert.deepEqual(
    filterMarks(marks, comments, 'strikethrough').map((mark: { id: string }) => mark.id),
    ['strikethrough']
  )
  assert.deepEqual(
    filterMarks(marks, comments, 'comment').map((mark: { id: string }) => mark.id),
    ['commented']
  )
})

test('PDF mark palette exposes the approved eight colors from one ordered source', () => {
  assert.deepEqual(
    PDF_MARK_PALETTE.map((color) => color.name),
    ['yellow', 'orange', 'green', 'teal', 'blue', 'purple', 'red', 'gray']
  )
})

test('page navigation clamps invalid and out-of-range user input', () => {
  assert.equal(pageNumber('99', 8), 8)
  assert.equal(pageNumber('-1', 8), 1)
  assert.equal(pageNumber('', 8), 1)
  assert.equal(pageNumber('2.8', 8), 2)
})
test('fit modes respect the available viewport and page orientation', () => {
  assert.equal(fittedScale('page', { width: 600, height: 800 }, { width: 900, height: 400 }), 0.5)
  assert.equal(fittedScale('width', { width: 600, height: 800 }, { width: 900, height: 400 }), 1.5)
})
test('percentage control cycles fit modes and clamps editable values', () => {
  assert.equal(nextFitMode('width'), 'page')
  assert.equal(nextFitMode('page'), 'width')
  assert.equal(nextFitMode('custom'), 'width')
  assert.equal(percentScale('125', 1), 1.25)
  assert.equal(percentScale('600%', 1), 5)
  assert.equal(percentScale('5', 1), 0.1)
  assert.equal(percentScale('invalid', 1.5), 1.5)
})
test('search treats metacharacters literally and matches whitespace across lines', () => {
  assert.deepEqual(
    matchText('Value a+b. VALUE a+b.', 'a+b').map((m) => m.start),
    [6, 17]
  )
  assert.equal(matchText('alpha\nbeta and alpha   beta', 'alpha beta').length, 2)
  assert.equal(matchText('something', '   ').length, 0)
})
test('reading locates PDF discretionary hyphens while preserving original offsets', () => {
  const source =
    'Prefix. SciForge supports multi-role, collaborative research where\nreviewer/approver roles, IM-based coordination channels (Zulip, Discord, WeChat,\nFeishu), and shared review surfaces enable cross-session handoffs and team-level deci-\nsion governance. Next.'
  const query =
    'SciForge supports multi-role, collaborative research where\nreviewer/approver roles, IM-based coordination channels (Zulip, Discord, WeChat,\nFeishu), and shared review surfaces enable cross-session handoffs and team-level deci\u0002sion governance.'
  assert.deepEqual(matchReadingText(source, query), [
    { start: source.indexOf('SciForge'), end: source.indexOf(' Next.') },
  ])
  assert.deepEqual(matchReadingText(query, 'deci-\nsion governance.'), [
    { start: query.indexOf('deci'), end: query.length },
  ])
  assert.deepEqual(matchText(source, query), [])
})

test('reading tolerates extractor whitespace without discarding punctuation or inventing matches', () => {
  const source = '😀 prefix\nAlpha beta.\nAlpha\tbeta.'
  assert.deepEqual(matchReadingText(source, 'ALPHABETA.'), [
    { start: source.indexOf('Alpha'), end: source.indexOf('Alpha') + 'Alpha beta.'.length },
    { start: source.lastIndexOf('Alpha'), end: source.length },
  ])
  assert.deepEqual(matchReadingText('multi-role governance', 'multirole governance'), [])
  assert.deepEqual(matchReadingText('decision governance', 'deci\u0002sion governance'), [])
  assert.deepEqual(matchReadingText('decision governance', 'decision invents governance'), [])
  assert.deepEqual(matchReadingText('decision governance', ' \n\t'), [])
})

test('selection rectangles are clipped to each page without leaking adjacent page coordinates', () => {
  const bounds = { left: 100, top: 200, right: 300, bottom: 600 }
  assert.deepEqual(
    clipQuads(
      [
        { left: 120, top: 180, right: 220, bottom: 220 },
        { left: 120, top: 650, right: 220, bottom: 700 },
      ],
      bounds
    ),
    [[0.1, 0, 0.6, 0.05]]
  )
  assert.deepEqual(clipQuads([], bounds), [])
})

test('single-page PDF selection preserves the visual line breaks exposed by Selection', () => {
  assert.equal(
    selectionPageText('first visual line\nsecond line', 'first visual linesecond line', true),
    'first visual line\nsecond line'
  )
  assert.equal(
    selectionPageText('cross-page text', 'clipped page text', false),
    'clipped page text'
  )
})

test('PDF selection shape preserves structure across CJK extractor aliases', () => {
  const browserText = '民⽣福祉，⼈⼜⽼龄化 2026\n第 2 行。'
  const serverText = '民生福祉，人口老龄化 2026\n第 2 行。'
  assert.equal(pdfSelectionShape(browserText), pdfSelectionShape(serverText))
  assert.notEqual(
    pdfSelectionShape(browserText),
    pdfSelectionShape(serverText.replace('2026', '2025'))
  )
  assert.notEqual(pdfSelectionShape(browserText), pdfSelectionShape(serverText.replace('\n', ' ')))
})

test('current page follows the largest visible page, not the preceding page sliver', () => {
  assert.equal(
    mostVisiblePage(
      [
        { page: 1, top: -300, bottom: 100 },
        { page: 2, top: 116, bottom: 516 },
      ],
      { top: 0, bottom: 500 }
    ),
    2
  )
  assert.equal(
    mostVisiblePage(
      [
        { page: 1, top: -50, bottom: 450 },
        { page: 2, top: 466, bottom: 966 },
      ],
      { top: 0, bottom: 500 }
    ),
    1
  )
  assert.equal(mostVisiblePage([], { top: 0, bottom: 500 }), undefined)
})

test('PDF selection span includes every page between anchor and focus in either direction', () => {
  assert.deepEqual(
    [1, 2, 3, 4].filter((page) => pageInSelectionSpan(page, 1, 3)),
    [1, 2, 3]
  )
  assert.deepEqual(
    [1, 2, 3, 4].filter((page) => pageInSelectionSpan(page, 3, 1)),
    [1, 2, 3]
  )
})

test('mixed font metrics on one text line share a single mark baseline across word spaces', () => {
  assert.deepEqual(
    normalizeQuads([
      [0.1, 0.2, 0.3, 0.22],
      [0.301, 0.201, 0.5, 0.218],
    ]),
    [[0.1, 0.2, 0.5, 0.22]]
  )
})
