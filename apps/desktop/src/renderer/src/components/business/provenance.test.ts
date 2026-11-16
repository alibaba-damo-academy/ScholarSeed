import test from 'node:test'
import assert from 'node:assert/strict'
import { readingCitations } from './provenance.ts'

const first = { page: 1, quote: 'Full evidence with its experimental condition.', fragment_id: 'a' }
const second = { page: 2, quote: 'Continuation of the same evidence.', fragment_id: 'b' }
test('selected source markers render only selected evidence and remain hidden in text-only views', () => {
  const item = {
    text: 'Selected finding.[[S7]]',
    evidence: [first],
    citations: [{ marker: 'S7', evidence: [first] }],
  }
  assert.equal(
    readingCitations(item, new Map()).text,
    'Selected finding [1](scholarseed-cite:reading-1).'
  )
  assert.deepEqual(readingCitations(item, new Map(), false), {
    text: 'Selected finding.',
    citations: [],
  })
  assert.equal(
    readingCitations({ text: 'Unknown.[[S99]]', citations: [] }, new Map()).text,
    'Unknown.'
  )
})
test('sentence markers keep all evidence with one navigable source per number', () => {
  const numbers = new Map<string, number>()
  const result = readingCitations(
    {
      text: 'Claim A.[[F1]] Explanation. Claim B.[[F2]] Closing.',
      evidence: [first, second],
      citations: [
        { marker: 'F1', evidence: [first, second] },
        { marker: 'F2', evidence: [second] },
      ],
    },
    numbers
  )
  assert.equal(
    result.text,
    'Claim A [1](scholarseed-cite:reading-1) [2](scholarseed-cite:reading-2). Explanation. Claim B [2](scholarseed-cite:reading-2). Closing.'
  )
  assert.deepEqual(
    result.citations.map((citation) => citation.source),
    [first, second, second]
  )
  assert.equal(
    readingCitations(
      { text: 'Again.[[F3]]', citations: [{ marker: 'F3', evidence: [second, first] }] },
      numbers
    ).text,
    'Again [1](scholarseed-cite:reading-1) [2](scholarseed-cite:reading-2).'
  )
})
test('legacy items keep evidence, summaries need no source and unknown IDs never become links', () => {
  assert.match(
    readingCitations({ text: 'Old result.', evidence: [first] }, new Map()).text,
    /Old result \[1\]/
  )
  assert.equal(
    readingCitations({ text: 'Summary without citation.' }, new Map()).text,
    'Summary without citation.'
  )
  assert.equal(
    readingCitations({ text: 'Unknown.[[F99]] Formula $F_1=1$.', citations: [] }, new Map()).text,
    'Unknown. Formula $F_1=1$.'
  )
})
test('library text view hides citations without changing saved evidence or PDF citations', () => {
  const item = {
    text: 'A finding.[[F1]] Formula $F_1=1$.',
    evidence: [first, second],
    citations: [{ marker: 'F1', evidence: [first, second] }],
  }
  const original = JSON.stringify(item)
  assert.deepEqual(readingCitations(item, new Map(), false), {
    text: 'A finding. Formula $F_1=1$.',
    citations: [],
  })
  assert.equal(JSON.stringify(item), original)
  assert.deepEqual(
    readingCitations(item, new Map()).citations.map((citation) => citation.source),
    [first, second]
  )
  assert.deepEqual(readingCitations({ text: 'Legacy.', evidence: [first] }, new Map(), false), {
    text: 'Legacy.',
    citations: [],
  })
})

test('repeated evidence is deduplicated and different PDF locations retain separate targets', () => {
  const shifted = { ...first, quads: [[0.1, 0.2, 0.3, 0.4]] }
  const result = readingCitations(
    { text: 'Claim.[[F1]]', citations: [{ marker: 'F1', evidence: [first, first, shifted] }] },
    new Map()
  )
  assert.equal(
    result.text,
    'Claim [1](scholarseed-cite:reading-1) [2](scholarseed-cite:reading-2).'
  )
  assert.deepEqual(
    result.citations.map((citation) => citation.source),
    [first, shifted]
  )
})

test('adjacent facts sharing evidence display each source once without removing later references', () => {
  const result = readingCitations(
    {
      text: 'Claim.[[F1]] [[F2]] Next.[[F2]]',
      citations: [
        { marker: 'F1', evidence: [first, second] },
        { marker: 'F2', evidence: [second] },
      ],
    },
    new Map()
  )
  assert.equal(
    result.text,
    'Claim [1](scholarseed-cite:reading-1) [2](scholarseed-cite:reading-2). Next [2](scholarseed-cite:reading-2).'
  )
})

test('numbers follow visible references, not metadata order, and unused sources take no number', () => {
  const numbers = new Map<string, number>()
  const result = readingCitations(
    {
      text: 'First[[S2]]. Second[[S1]].',
      citations: [
        { marker: 'S99', evidence: [{ page: 9, quote: 'Unused' }] },
        { marker: 'S1', evidence: [first] },
        { marker: 'S2', evidence: [second] },
      ],
    },
    numbers
  )
  assert.equal(
    result.text,
    'First [1](scholarseed-cite:reading-1). Second [2](scholarseed-cite:reading-2).'
  )
  assert.deepEqual(
    result.citations.map((value) => value.source),
    [second, first]
  )
  assert.equal(numbers.size, 2)
})
test('saved post-punctuation groups and live canonical groups have identical links and targets', () => {
  const citations = [
    { marker: 'S1', evidence: [first] },
    { marker: 'S2', evidence: [second] },
  ]
  assert.deepEqual(
    readingCitations({ text: '结果。\n[[S1]] [[S2]]', citations }, new Map()),
    readingCitations({ text: '结果[[S1]][[S2]]。', citations }, new Map())
  )
})
