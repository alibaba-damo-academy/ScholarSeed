import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NOTE_SOURCE_PREFIX,
  NOTE_PARAGRAPH_PREFIX,
  noteSourceKey,
  noteSourceLink,
  noteSourceLinks,
  parseNoteSourceLink,
  noteProvenancePreview,
  notePreviewSourceGroup,
  noteUnreferencedGroups,
  type NoteSource,
} from './sources.ts'

const source: NoteSource = {
  record_target: { owner: 'literature_attachment', scope_id: 'paper', subject_id: 'attachment' },
  source_revision: 'sha256:one',
  mark_id: 'mark',
  comment_id: null,
  kind: 'text',
  page: 2,
  text: '原文 [link](javascript:alert(1)) <script>unsafe</script>',
  attachment_name: 'paper.pdf',
}

test('opening bibliographic references stay indexed without preview navigation', () => {
  const display = '**Paper title**  \n*Ravuri et al.* · Nature · 2021'
  const raw = display + ' [[hint:paper_summary|B001]]'
  const body = 'Body [[mixed:A001,B001]]'
  const paper = {
    id: 'B001',
    page: 1,
    text: 'Paper title',
    record_target: source.record_target,
    source_revision: source.source_revision,
    attachment_name: source.attachment_name,
  }
  const provenance = {
    version: 1 as const,
    status: 'indexed' as const,
    paragraphs: [
      { id: 'p1', text: raw, display_text: display, sources: [], paper_sources: [paper] },
      { id: 'p2', text: body, display_text: 'Body', sources: [source], paper_sources: [paper] },
    ],
  }
  const saved = JSON.stringify(provenance)
  for (const heading of ['# Note', '##### Note']) {
    const preview = noteProvenancePreview(
      `${heading}\n\n${raw}\n\n#### Section\n\n${body}`,
      provenance
    )
    assert.equal(preview.stale, false)
    assert.ok(preview.text.startsWith(`${heading}\n\n${display}\n\n#### Section`))
    assert.equal(preview.text.includes('#scholarseed-note-paper-'), false)
    assert.equal(Object.keys(preview.groups).length, 1)
  }
  assert.equal(JSON.stringify(provenance), saved)
  // Bibliographic-looking text later in a note does not suppress body references.
  const moved = noteProvenancePreview(`${body}\n\n${raw}`, provenance)
  assert.equal(moved.text.includes('#scholarseed-note-paper-'), false)
  const bodyOnly = noteProvenancePreview(body, {
    ...provenance,
    paragraphs: [provenance.paragraphs[1]],
  })
  assert.equal(bodyOnly.text.includes('#scholarseed-note-paper-'), false)
  assert.equal(Object.keys(bodyOnly.groups).length, 1)
})

test('indexed references replace transport markers only in the matching preview paragraph', () => {
  const raw = 'Body [[mixed:A001,B001,A999]]'
  const paper = {
    id: 'B00001',
    page: 2,
    text: 'Evidence',
    record_target: source.record_target,
    source_revision: source.source_revision,
    attachment_name: source.attachment_name,
  }
  const provenance = {
    version: 1 as const,
    status: 'indexed' as const,
    paragraphs: [
      {
        id: 'p1',
        text: raw,
        display_text: 'Body [A999]',
        sources: [source],
        paper_sources: [paper],
      },
    ],
  }
  const preview = noteProvenancePreview(raw, provenance)
  assert.equal(preview.stale, false)
  assert.match(preview.text, /^Body \[A999\]/)
  assert.equal(preview.text.includes('[[mixed:'), false)
  assert.equal(preview.text.includes('#scholarseed-note-paper-'), false)
  assert.equal(provenance.paragraphs[0].paper_sources[0], paper)
  assert.equal(noteProvenancePreview('Edited ' + raw, provenance).stale, true)
  assert.equal(noteProvenancePreview(raw + '\n\n' + raw, provenance).text, raw + '\n\n' + raw)
  assert.equal(raw, 'Body [[mixed:A001,B001,A999]]')
})

test('location sources keep anchor identity without pretending to contain text or comments', () => {
  const location: NoteSource = { ...source, kind: 'location', text: '' }
  assert.deepEqual(parseNoteSourceLink(noteSourceLink([location]))?.sources, [location])
  assert.throws(() => noteSourceLink([{ ...location, text: 'invented quote' }]))
  assert.throws(() => noteSourceLink([{ ...location, comment_id: 'comment' }]))
  assert.throws(() => noteSourceLink([{ ...source, text: '' }]))
})

test('unreferenced marks stay separate from paragraph bindings and retain all identities', () => {
  const missing = Array.from({ length: 125 }, (_, i) => ({ ...source, mark_id: `missing-${i}` }))
  const provenance = { version: 1 as const, paragraphs: [], unreferenced_sources: missing }
  const groups = noteUnreferencedGroups(provenance)
  assert.deepEqual(
    Object.values(groups).map((group) => group.sources.length),
    [100, 25]
  )
  assert.deepEqual(
    Object.values(groups).flatMap((group) => group.sources),
    missing
  )
  assert.equal(noteProvenancePreview('Clean prose.', provenance).text, 'Clean prose.')
  assert.deepEqual(noteUnreferencedGroups({ version: 1, paragraphs: [] }), {})
  assert.deepEqual(
    noteUnreferencedGroups({ ...provenance, unreferenced_sources: [{ ...source, page: -1 }] }),
    {}
  )
})

test('separate provenance follows unique Markdown paragraphs without changing saved text', () => {
  const text = '# Title\n\nFirst paragraph.\n\nSecond paragraph.'
  const provenance = {
    version: 1 as const,
    paragraphs: [
      { id: 'p01', text: 'First paragraph.', sources: [source] },
      { id: 'p02', text: 'Second paragraph.', sources: [source, { ...source, mark_id: 'two' }] },
    ],
  }
  const preview = noteProvenancePreview(text, provenance)
  assert.match(preview.text, /First paragraph\.\n\n\[\]\(#scholarseed-note-paragraph-/)
  assert.equal(Object.keys(preview.groups).length, 2)
  assert.equal(preview.stale, false)
  assert.equal(text.includes('scholarseed'), false)
  const moved = noteProvenancePreview('Second paragraph.\n\nFirst paragraph.', provenance)
  assert.equal(Object.keys(moved.groups).length, 2)
  for (const body of [
    'Edited paragraph.\n\nSecond paragraph.',
    'First paragraph.\n\nFirst paragraph.\n\nSecond paragraph.',
    '```\nFirst paragraph.\n```\n\nSecond paragraph.',
  ]) {
    const changed = noteProvenancePreview(body, provenance)
    assert.equal(changed.stale, true)
    assert.equal(Object.keys(changed.groups).length, 1)
  }
})

test('versioned sources survive Markdown round trips and retain separate same-page comments', () => {
  const sources = [
    source,
    { ...source, kind: 'user_comment' as const, comment_id: 'comment-one' },
    { ...source, kind: 'user_comment' as const, comment_id: 'comment-two' },
  ]
  const href = noteSourceLink(sources)
  assert.deepEqual(parseNoteSourceLink(href)?.sources, sources)
  assert.equal(new Set(sources.map(noteSourceKey)).size, 3)
  assert.deepEqual(noteSourceLinks(`Body\n\n[Sources](${href})`), [href])
  assert.deepEqual(
    noteSourceLinks(`\`[Sources](${href})\`\n\n\`\`\`\n[Sources](${href})\n\`\`\``),
    []
  )
})

test('malformed, hostile, oversized and cross-version links never become navigable sources', () => {
  for (const payload of [
    { version: 2, sources: [source] },
    { version: true, sources: [source] },
    { version: 1, sources: [] },
    { version: 1, sources: Array(101).fill(source) },
    { version: 1, sources: [{ ...source, page: true }] },
    {
      version: 1,
      sources: [{ ...source, record_target: { ...source.record_target, owner: 'project_asset' } }],
    },
    { version: 1, sources: [{ ...source, text: 'x'.repeat(16385) }] },
    { version: 1, sources: [{ ...source, kind: 'user_comment' }] },
    { version: 1, sources: [{ ...source, injected: 'data' }] },
  ])
    assert.equal(
      parseNoteSourceLink(NOTE_SOURCE_PREFIX + encodeURIComponent(JSON.stringify(payload))),
      null
    )
  for (const href of [
    'javascript:alert(1)',
    'https://example.com',
    NOTE_SOURCE_PREFIX + '%broken',
    NOTE_SOURCE_PREFIX + 'x'.repeat(4 * 1024 * 1024),
  ])
    assert.equal(parseNoteSourceLink(href), null)
})

test('source punctuation cannot terminate the Markdown destination', () => {
  const href = noteSourceLink([
    { ...source, text: "An unmatched closing ) and an opening ( quote ' * !" },
  ])
  assert.deepEqual(noteSourceLinks(`[Sources](${href})`), [href])
  assert.equal(
    parseNoteSourceLink(noteSourceLinks(`[Sources](${href})`)[0])?.sources[0].text,
    "An unmatched closing ) and an opening ( quote ' * !"
  )
})

test('paragraph groups keep large metadata out of hrefs and split resolve requests safely', () => {
  for (const href of ['constructor', 'toString', '__proto__'])
    assert.equal(notePreviewSourceGroup(href, {}), null)
  const sources = Array.from({ length: 102 }, (_, i) => ({
    ...source,
    mark_id: `m${i}`,
    text: '文'.repeat(16000),
  }))
  const preview = noteProvenancePreview('Body.', {
    version: 1,
    paragraphs: [{ id: 'p1', text: 'Body.', sources }],
  })
  assert.equal(preview.stale, false)
  assert.equal(preview.text.length < 200, true)
  assert.deepEqual(
    Object.values(preview.groups).map((group) => group.sources.length),
    [100, 2]
  )
  assert.equal(
    Object.keys(preview.groups).every((href) => href.startsWith(NOTE_PARAGRAPH_PREFIX)),
    true
  )
  for (const sources of [[], [null], [{ invalid: true }]]) {
    const invalid = noteProvenancePreview('Body.', {
      version: 1,
      paragraphs: [{ id: 'p1', text: 'Body.', sources }],
    } as never)
    assert.deepEqual(invalid.groups, {})
    assert.equal(invalid.stale, true)
  }
})
