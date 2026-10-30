import assert from 'node:assert/strict'
import test from 'node:test'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  groupPdfRegions,
  paintedGraphics,
  pdfRegionText,
  visualRegionRect,
  type Bounds,
  type RegionText,
} from './regions.ts'

const text = (value: string, quad: Bounds, size = 10): RegionText => ({ text: value, quad, size })
const graphics: Bounds[] = [[0.2, 0.2, 0.7, 0.5]]

test('plot owns axis titles, ticks and legend but not its caption or following body', () => {
  const regions = groupPdfRegions(6, 600, 800, graphics, [
    text('Altitude (km)', [180, 411, 350, 423]),
    text('10', [102, 160, 115, 170]),
    text('Probability', [80, 200, 92, 290]),
    text('Measured', [330, 140, 400, 150]),
    text('Fig. 1: Optical transmission', [100, 450, 420, 462]),
    text('The optical system operates over these channels.', [100, 480, 420, 490]),
  ])
  assert.equal(regions.length, 1)
  assert.deepEqual(regions[0].quad, [80 / 600, 140 / 800, 0.7, 423 / 800])
  assert.deepEqual(visualRegionRect(regions[0]), [
    80 / 600,
    140 / 800,
    0.7 - 80 / 600,
    423 / 800 - 140 / 800,
  ])
})

test('card border includes all interior text without absorbing prose outside the card', () => {
  const regions = groupPdfRegions(
    19,
    600,
    800,
    [[0.1, 0.1, 0.9, 0.6]],
    [
      text('STAT1', [70, 90, 130, 104]),
      text('A long evidence row describing findings across the entire card', [80, 130, 530, 144]),
      text('The following paragraph is not part of the card.', [60, 510, 530, 524]),
    ]
  )
  assert.equal(regions.length, 1)
  assert.deepEqual(regions[0].quad, [0.1, 0.1, 0.9, 0.6])
})

test('neighboring plots retain distinct label ownership across a column gutter', () => {
  const regions = groupPdfRegions(
    1,
    600,
    800,
    [
      [0.1, 0.2, 0.4, 0.5],
      [0.6, 0.2, 0.9, 0.5],
    ],
    [text('(a)', [100, 410, 120, 420]), text('(b)', [400, 410, 420, 420])]
  )
  assert.equal(regions.length, 2)
  assert.ok(regions[0].quad[2] < regions[1].quad[0])
  assert.equal(regions[0].quad[3], 420 / 800)
})

test('formula includes superscript and subscript but excludes nearby prose', () => {
  const regions = groupPdfRegions(
    1,
    600,
    800,
    [],
    [
      text('E = mc', [200, 200, 300, 212], 12),
      text('2', [294, 190, 302, 198], 8),
      text('i', [270, 215, 274, 223], 8),
      text('(1)', [320, 200, 340, 212], 12),
      text('This equation describes the energy of the system.', [60, 240, 500, 252], 12),
    ]
  )
  assert.equal(regions.length, 1)
  assert.equal(regions[0].kind, 'formula')
  assert.deepEqual(regions[0].quad, [200 / 600, 190 / 800, 340 / 600, 223 / 800])
})

test('path geometry restores affine transforms and excludes nonpainting clipping paths', () => {
  const result = paintedGraphics(
    {
      fnArray: [
        OPS.save,
        OPS.transform,
        OPS.constructPath,
        OPS.restore,
        OPS.constructPath,
        OPS.constructPath,
      ],
      argsArray: [
        [],
        [2, 0, 0, 2, 10, 20],
        [OPS.fill, [], [0, 0, 10, 10]],
        [],
        [OPS.endPath, [], [0, 0, 100, 100]],
        [OPS.fill, [], [50, 50, 60, 60]],
      ],
    },
    null,
    { width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0] },
    OPS
  )
  assert.deepEqual(result, [
    [0.1, 0.2, 0.3, 0.4],
    [0.5, 0.5, 0.6, 0.6],
  ])
})

test('rendered image instances remain separate and include all four rotated corners', () => {
  assert.deepEqual(
    paintedGraphics(
      { fnArray: [], argsArray: [] },
      [0.2, 0.1, 0.1, 0.3, 0.4, 0.2, 0.6, 0.5, 0.6, 0.7, 0.8, 0.5],
      { width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0] },
      OPS
    ),
    [
      [0.1, 0.1, 0.4, 0.4],
      [0.6, 0.5, 0.8, 0.7],
    ]
  )
})

test('repeated colored row cells own the full card including its shaded heading', () => {
  const regions = groupPdfRegions(
    1,
    600,
    800,
    [
      [0.2, 0.16, 0.6, 0.18],
      [0.1, 0.19, 0.25, 0.21],
      [0.1, 0.21, 0.25, 0.23],
      [0.1, 0.23, 0.25, 0.25],
      [0.1, 0.25, 0.25, 0.27],
    ],
    [
      text('Data card 1: Target', [125, 130, 350, 142]),
      text('First long evidence row with several words', [65, 154, 530, 166]),
      text('Second row with substantial evidence across the card', [65, 170, 530, 182]),
      text('Third long row describing many experimental findings', [65, 186, 530, 198]),
      text('Fourth row containing more experimental evidence', [65, 202, 530, 214]),
      text('This following paragraph must not be included in the card', [60, 235, 540, 247]),
    ]
  )
  assert.equal(regions.length, 1)
  assert.equal(regions[0].kind, 'table')
  assert.equal(regions[0].quad[2], 530 / 600)
  assert.equal(regions[0].quad[3], 0.27)
})

test('full page scan and background are not interactive chart regions', () => {
  assert.deepEqual(groupPdfRegions(1, 600, 800, [[0, 0, 1, 1]], []), [])
})

test('table row ownership stops at the next prose column even without another graphic seed', () => {
  const regions = groupPdfRegions(
    1,
    600,
    800,
    [
      [0.1, 0.2, 0.25, 0.22],
      [0.1, 0.22, 0.25, 0.24],
      [0.1, 0.24, 0.25, 0.26],
    ],
    [
      text('Row one', [65, 162, 120, 172]),
      text('Cell one', [160, 162, 270, 172]),
      text('Row two', [65, 178, 120, 188]),
      text('Cell two', [160, 178, 270, 188]),
      text('An unrelated paragraph in the right column', [350, 162, 550, 172]),
    ]
  )
  assert.equal(regions.length, 1)
  assert.equal(regions[0].quad[2], 270 / 600)
})

test('CropBox-style translation and page rotation transform vector bounds once', () => {
  assert.deepEqual(
    paintedGraphics(
      { fnArray: [OPS.constructPath], argsArray: [[OPS.fill, [], [10, 20, 30, 40]]] },
      null,
      { width: 100, height: 200, transform: [0, 1, 1, 0, -20, -10] },
      OPS
    ),
    [[0, 0, 0.2, 0.1]]
  )
})

test('optional-content paths are conservative and form clipping restores on exit', () => {
  const regions = paintedGraphics(
    {
      fnArray: [
        OPS.beginMarkedContentProps,
        OPS.constructPath,
        OPS.endMarkedContent,
        OPS.paintFormXObjectBegin,
        OPS.constructPath,
        OPS.paintFormXObjectEnd,
        OPS.constructPath,
      ],
      argsArray: [
        ['OC', {}],
        [OPS.fill, [], [0, 0, 100, 100]],
        [],
        [
          [1, 0, 0, 1, 10, 20],
          [0, 0, 20, 20],
        ],
        [OPS.fill, [], [-5, -5, 30, 30]],
        [],
        [OPS.fill, [], [60, 60, 80, 80]],
      ],
    },
    null,
    { width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0] },
    OPS
  )
  assert.deepEqual(regions, [
    [0.1, 0.2, 0.3, 0.4],
    [0.6, 0.6, 0.8, 0.8],
  ])
})

test('text geometry uses viewport units rather than losing PDF userUnit scaling', () => {
  const result = pdfRegionText(
    {
      items: [
        {
          str: 'Axis',
          dir: 'ltr',
          transform: [10, 0, 0, 10, 20, 30],
          width: 30,
          height: 10,
          fontName: 'font',
          hasEOL: false,
        },
      ],
      styles: { font: { fontFamily: 'sans', ascent: 0.8, descent: -0.2, vertical: false } },
      lang: null,
    },
    {
      scale: 1,
      convertToViewportPoint: (horizontal, vertical) => [horizontal * 2, 200 - vertical * 2],
    }
  )
  assert.deepEqual(result[0].quad, [40, 124, 100, 144])
})

test('numbered fragmented equations retain all math tokens, fractions and distant equation numbers', () => {
  const result = groupPdfRegions(
    7,
    600,
    800,
    [],
    [
      text('The variance is defined using the following expression.', [60, 350, 540, 365], 12),
      text('σ', [220, 390, 230, 403], 12),
      text('2', [231, 383, 238, 391], 8),
      text('Var [ P ] = ⟨ P 2 ⟩', [245, 385, 320, 398], 12),
      text('E [ P ] 2', [245, 405, 290, 418], 12),
      text('= − 1 .', [325, 395, 370, 408], 12),
      text('(13)', [520, 395, 540, 407], 12),
      text('In the weak turbulence regime this approximation holds.', [60, 445, 540, 460], 12),
    ]
  )
  assert.equal(result.length, 1)
  assert.equal(result[0].kind, 'formula')
  assert.deepEqual(result[0].quad, [220 / 600, 383 / 800, 540 / 600, 418 / 800])
})

test('unanchored numeric prose with negative powers is not a display equation', () => {
  assert.deepEqual(
    groupPdfRegions(
      1,
      600,
      800,
      [],
      [text('typically taken as 1 7 10 − 14 m − 2 / 3', [60, 390, 280, 405], 12)]
    ),
    []
  )
})

test('aligned table row bands reconnect across right-hand prose without merging the next card', () => {
  const rows: Bounds[] = Array.from({ length: 6 }, (_, index) => [
    0.1,
    0.2 + index * 0.02,
    0.25,
    0.22 + index * 0.02,
  ])
  const regions = groupPdfRegions(
    1,
    600,
    800,
    [[0.2, 0.17, 0.6, 0.19], ...rows, [0.2, 0.35, 0.6, 0.37]],
    [
      text('An evidence row with several significant findings', [180, 193, 500, 205], 12),
      text('Another evidence row with several significant findings', [180, 225, 500, 237], 12),
    ]
  )
  const table = regions.find((region) => region.kind === 'table')!
  assert.ok(table)
  assert.ok(table.quad[3] < 0.35)
  assert.ok(table.quad[2] >= 500 / 600)
})

test('non-finite font metrics cannot poison a complete diagram or create ghost formulas', () => {
  const items = pdfRegionText(
    {
      items: [
        {
          str: '→',
          dir: 'ltr',
          transform: [10, 0, 0, 10, 200, 500],
          width: 10,
          height: 10,
          fontName: 'symbol',
          hasEOL: false,
        },
      ],
      styles: { symbol: { fontFamily: 'mono', ascent: NaN, descent: NaN, vertical: false } },
      lang: null,
    },
    { scale: 1, convertToViewportPoint: (horizontal, vertical) => [horizontal, 800 - vertical] }
  )
  assert.ok(items.every((item) => item.quad.every(Number.isFinite)))
  const result = groupPdfRegions(1, 600, 800, graphics, [
    ...items,
    text('bad', [NaN, 100, 200, 120]),
  ])
  assert.equal(result.length, 1)
  assert.ok(result[0].quad.every(Number.isFinite))
})

const ruledTable = (caption = 'Table A1: Comparison') => ({
  graphics: [100, 130, 260].map((top) => [0.15, top / 800, 0.85, (top + 0.6) / 800] as Bounds),
  text: [
    text(caption, [90, 70, 480, 82]),
    ...Array.from({ length: 5 }, (_, row) => [
      text(`Model ${row}`, [90, 110 + row * 30, 170, 120 + row * 30]),
      text(`Value ${row}`, [240, 110 + row * 30, 300, 120 + row * 30]),
      text(`${row}`, [450, 110 + row * 30, 460, 120 + row * 30]),
    ]).flat(),
    text('This following paragraph must stay outside the table.', [90, 290, 510, 302]),
  ],
})

test('captioned three-line tables use repeated columns and complete ruled bounds', () => {
  const sample = ruledTable()
  const result = groupPdfRegions(1, 600, 800, sample.graphics, [
    ...sample.text,
    text('3 System Architecture', [70, 275, 360, 287]),
    text('A caption continuation.', [90, 84, 300, 94]),
  ])
  assert.equal(result.length, 1)
  assert.equal(result[0].kind, 'table')
  assert.deepEqual(result[0].quad, [0.15, 100 / 800, 0.85, 260.6 / 800])
})

test('rules without a table caption and captioned prose without columns are not tables', () => {
  const sample = ruledTable('A section about the following observations')
  assert.equal(
    groupPdfRegions(1, 600, 800, sample.graphics, sample.text).filter(
      (region) => region.kind === 'table'
    ).length,
    0
  )
  assert.deepEqual(
    groupPdfRegions(1, 600, 800, sample.graphics, [
      text('Table 1: Observations', [90, 70, 480, 82]),
      ...Array.from({ length: 5 }, (_, row) =>
        text('This is a full prose paragraph without separate aligned columns.', [
          90,
          140 + row * 20,
          510,
          152 + row * 20,
        ])
      ),
    ]),
    []
  )
})

test('a list with inline mathematics cannot seed or expand a formula', () => {
  assert.deepEqual(
    groupPdfRegions(
      1,
      600,
      800,
      [],
      [
        text('● Weak turbulence regime (σ < 1),', [60, 200, 280, 213]),
        text('● Link lengths of several dozen kilometers', [60, 215, 420, 228]),
        text('● Constant or slowly varying along the path', [60, 230, 420, 243]),
        text('(∆ = − 0.1). Exploration in Round 2 introduced R', [60, 300, 440, 313]),
      ]
    ),
    []
  )
})

test('short standalone centered mathematical relation is allowed but inline and code are not', () => {
  const equation = text('E[I] = 1,', [280, 200, 320, 212], 12)
  const result = groupPdfRegions(
    1,
    600,
    800,
    [],
    [
      equation,
      text('The following paragraph explains the expected intensity.', [60, 250, 540, 262], 12),
    ]
  )
  assert.equal(result.length, 1)
  assert.equal(result[0].kind, 'formula')
  assert.deepEqual(
    groupPdfRegions(
      1,
      600,
      800,
      [],
      [
        text('E[I] = 1,', [60, 200, 100, 212], 12),
        text('is the expected normalized intensity in this model.', [110, 200, 540, 212], 12),
      ]
    ),
    []
  )
  assert.deepEqual(
    groupPdfRegions(1, 600, 800, [], [text('const value = 1;', [200, 200, 400, 212])]),
    []
  )
})

test('uncertain orphan symbols next to a formula reject the whole incomplete candidate', () => {
  assert.deepEqual(
    groupPdfRegions(
      1,
      600,
      800,
      [],
      [text('E = mc', [200, 200, 300, 212], 12), text('unrelated label', [310, 218, 420, 230], 12)]
    ),
    []
  )
})

test('flowchart boxes with arrow labels remain figures rather than colored-row tables', () => {
  const result = groupPdfRegions(
    1,
    600,
    800,
    [
      [0.1, 0.1, 0.9, 0.5],
      [0.2, 0.2, 0.4, 0.22],
      [0.2, 0.22, 0.4, 0.24],
      [0.2, 0.24, 0.4, 0.26],
    ],
    [text('Input → Worker', [140, 180, 240, 192])]
  )
  assert.equal(result.length, 1)
  assert.equal(result[0].kind, 'figure')
})

test('standard function names and acronym subscripts in numbered equations are mathematical', () => {
  const result = groupPdfRegions(
    1,
    600,
    800,
    [],
    [
      text('σ = sec(ζ) H OGS / v rms', [160, 200, 420, 215], 12),
      text('(14)', [520, 200, 540, 215], 12),
    ]
  )
  assert.equal(result.length, 1)
  assert.equal(result[0].kind, 'formula')
})

test('bibliography identifiers and bare arithmetic cannot become display formulas', () => {
  assert.deepEqual(
    groupPdfRegions(
      1,
      600,
      800,
      [],
      [
        text('10.1038/s41586-024-07487-w', [150, 200, 420, 212]),
        text('3 / 4 - 1', [180, 250, 400, 262]),
      ]
    ),
    []
  )
})

test('table and short-formula decisions are invariant across viewport scales', () => {
  const sample = ruledTable()
  const items = [...sample.text, text('E[I] = 1', [280, 400, 320, 412], 12)]
  const expected = groupPdfRegions(1, 600, 800, sample.graphics, items)
  assert.deepEqual(
    expected.map((region) => region.kind),
    ['table', 'formula']
  )
  for (const scale of [0.5, 1.85, 2.51]) {
    const actual = groupPdfRegions(
      1,
      600 * scale,
      800 * scale,
      sample.graphics,
      items.map((item) => ({
        ...item,
        size: item.size * scale,
        quad: item.quad.map((coordinate) => coordinate * scale) as Bounds,
      })),
      scale
    )
    assert.deepEqual(
      actual.map((region) => region.kind),
      expected.map((region) => region.kind)
    )
    actual.forEach((region, index) =>
      region.quad.forEach((coordinate, corner) =>
        assert.ok(Math.abs(coordinate - expected[index].quad[corner]) < 1e-12)
      )
    )
  }
})
