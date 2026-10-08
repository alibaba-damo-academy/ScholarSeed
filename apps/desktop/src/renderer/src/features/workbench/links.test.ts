import assert from 'node:assert/strict'
import test from 'node:test'
import type { CitationResolution } from '../../contracts/citations.ts'
import { documentLinkTarget, navigateDocumentLink } from './links.ts'

const CITATION: CitationResolution = {
  handle: 'receipt',
  pages: [{ page: 2, quads: [] }],
  source_kind: 'project',
  source_id: 'paper',
  content_level: 'fulltext',
  project_id: 'project',
  path: 'paper.pdf',
  title: 'Paper',
  revision: 'revision',
  quote: 'Quoted evidence',
  version_bound: true,
  state: 'exact',
  can_open_pdf: true,
  matches: [{ pages: [{ page: 2, quads: [] }] }],
  presentation: {
    version: 1,
    mode: 'structured_text',
    precision: 'region',
    page: 2,
    text: 'Quoted evidence',
    quality_reasons: [],
    manual_check: false,
  },
}

test('document links distinguish browser, citation, and fragment targets', () => {
  assert.deepEqual(documentLinkTarget('https://example.org/paper?q=1#section'), {
    kind: 'external',
    href: 'https://example.org/paper?q=1#section',
  })
  assert.deepEqual(documentLinkTarget('http://example.org/'), {
    kind: 'external',
    href: 'http://example.org/',
  })
  assert.deepEqual(documentLinkTarget('scholarseed-cite:receipt-123'), {
    kind: 'citation',
    href: 'scholarseed-cite:receipt-123',
    handle: 'receipt-123',
  })
  assert.deepEqual(documentLinkTarget('#ref-paper'), { kind: 'fragment', href: '#ref-paper' })
})

test('unsupported and empty link targets cannot launch the browser', () => {
  for (const href of [
    '',
    '#',
    'scholarseed-cite:',
    'javascript:alert(1)',
    'data:text/html,hi',
    'file:///tmp/secret',
    '//example.org',
    'notes.md',
    'https://',
  ]) {
    assert.equal(documentLinkTarget(href).kind, 'unavailable', href)
  }
})

test('external navigation opens the complete original URL exactly once', async () => {
  const opened: string[] = []
  const href = 'https://example.org/paper?q=1#section'
  await navigateDocumentLink(documentLinkTarget(href), {
    openExternal: async (url) => {
      opened.push(url)
    },
    navigateFragment: () => {
      throw new Error('not a fragment')
    },
    resolveCitation: async () => {
      throw new Error('not a citation')
    },
    revealCitation: async () => {
      throw new Error('not a citation')
    },
    previewCitation: () => {
      throw new Error('not a citation')
    },
  })
  assert.deepEqual(opened, [href])
})

test('exact citations reveal the matching source without an intermediate dialog', async () => {
  const source = CITATION
  const revealed: CitationResolution[] = []
  await navigateDocumentLink(documentLinkTarget('scholarseed-cite:receipt'), {
    openExternal: async () => {
      throw new Error('internal links never open externally')
    },
    navigateFragment: () => false,
    resolveCitation: async (handle) => {
      assert.equal(handle, 'receipt')
      return source
    },
    revealCitation: async (value) => {
      revealed.push(value)
    },
    previewCitation: () => {
      throw new Error('exact citation does not need a dialog')
    },
  })
  assert.deepEqual(revealed, [source])
})

test('non-exact citations retain the explanatory preview instead of false positioning', async () => {
  for (const state of ['changed', 'source_only', 'unavailable'] as const) {
    const source = { ...CITATION, state, matches: [] }
    const previewed: CitationResolution[] = []
    await navigateDocumentLink(documentLinkTarget('scholarseed-cite:receipt'), {
      openExternal: async () => {
        throw new Error('internal link')
      },
      navigateFragment: () => false,
      resolveCitation: async () => source,
      revealCitation: async () => {
        throw new Error('not an exact match')
      },
      previewCitation: (value) => {
        previewed.push(value)
      },
    })
    assert.deepEqual(previewed, [source])
  }
})

test('missing fragments and failed browser requests surface errors without fallthrough', async () => {
  const actions = {
    openExternal: async () => {
      throw new Error('browser failed')
    },
    navigateFragment: () => false,
    resolveCitation: async () => {
      throw new Error('receipt unavailable')
    },
    revealCitation: async () => {},
    previewCitation: () => {},
  }
  await assert.rejects(
    navigateDocumentLink(documentLinkTarget('#missing'), actions),
    /target_unavailable/
  )
  await assert.rejects(
    navigateDocumentLink(documentLinkTarget('https://example.org'), actions),
    /browser failed/
  )
  await assert.rejects(
    navigateDocumentLink(documentLinkTarget('scholarseed-cite:missing'), actions),
    /receipt unavailable/
  )
  await assert.rejects(
    navigateDocumentLink(documentLinkTarget('javascript:alert(1)'), actions),
    /target_unavailable/
  )
})
