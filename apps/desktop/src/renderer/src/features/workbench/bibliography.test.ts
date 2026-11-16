import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bibliographyAnchor,
  bibliographyPreview,
  bibliographyUrl,
  parseBibliography,
} from './bibliography.ts'
import { markdownAnchorDom, mergeMarkdownAnchors } from './anchors.ts'

const metadata = {
  version: 1 as const,
  title: 'Title <script>alert(1)</script> & 中文',
  authors: 'Ada Author; 李明',
  year: '2025',
  publication: 'Journal, Volume 2',
  url: 'https://example.org/paper?q=1&language=zh',
  doi: '',
}
const anchor = `<a id="ref-Smith2025" data-scholarseed-reference="${encodeURIComponent(JSON.stringify(metadata))}"></a>`

test('bibliography metadata is explicit, versioned and preserves text without parsing names', () => {
  assert.deepEqual(bibliographyAnchor(anchor), { id: 'ref-Smith2025', metadata })
  assert.deepEqual(markdownAnchorDom(anchor)?.[1]['data-value'], anchor)
  const tree = {
    type: 'paragraph',
    children: [
      { type: 'html', value: anchor.replace('</a>', '') },
      { type: 'html', value: '</a>' },
    ],
  }
  mergeMarkdownAnchors(tree)
  assert.equal(tree.children.length, 1)
  assert.equal(tree.children[0].value, anchor)
  const source = `正文 [[1]](#ref-Smith2025)\n\n## References\n\n${anchor}\n[1] Original formatted reference.\n`
  assert.deepEqual(bibliographyPreview(source, '#ref-Smith2025'), {
    metadata,
    reference: '[1] Original formatted reference.',
  })
  assert.equal(bibliographyPreview(`\`\`\`html\n${anchor}\n\`\`\``, '#ref-Smith2025'), null)
  const second = anchor.replace('ref-Smith2025', 'ref-second')
  assert.equal(
    bibliographyPreview(`${anchor}\nFirst\n\n${second}\nSecond`, '#ref-second')?.reference,
    'Second'
  )
})

test('invalid metadata never fabricates fields or changes reference fallback', () => {
  for (const value of [
    { ...metadata, version: 2 },
    { ...metadata, authors: ['Ada'] },
    { ...metadata, title: 'x'.repeat(20001) },
    null,
  ])
    assert.equal(parseBibliography(value), null)
  assert.equal(
    bibliographyAnchor('<a id="ref-a" data-scholarseed-reference="%invalid"></a>')?.metadata,
    null
  )
  assert.deepEqual(bibliographyPreview('## References\n\n[1] A. Raw reference.', '#ref-1'), {
    metadata: null,
    reference: '[1] A. Raw reference.',
  })
  assert.equal(bibliographyPreview('## Other\n\n[1] Ordinary text.', '#ref-1'), null)
})

test('bibliography links allow only explicit safe originals and DOI fallback', () => {
  assert.equal(bibliographyUrl(metadata), metadata.url)
  assert.equal(bibliographyUrl({ ...metadata, url: 'javascript:alert(1)', doi: '' }), '')
  assert.equal(
    bibliographyUrl({ ...metadata, url: '', doi: '10.1000/example' }),
    'https://doi.org/10.1000/example'
  )
  assert.equal(bibliographyUrl({ ...metadata, url: '', doi: 'not-a-doi' }), '')
})
