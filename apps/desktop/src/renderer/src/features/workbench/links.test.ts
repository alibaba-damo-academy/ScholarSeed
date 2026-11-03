import assert from 'node:assert/strict'
import test from 'node:test'
import type { CitationResolution } from '../../contracts/citations.ts'
import { savedCitationUrl } from '../../contracts/citations.ts'
import {
  citationFailureMessage,
  documentLinkTarget,
  navigateDocumentLink,
  savedCitationError,
} from './links.ts'

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

test('saved citation byte and preview routes bind the exact resource receipt without answer identity', () => {
  const receipt = { project_id: 'project/one', path: 'resources/a b.md', handle: 'receipt' }
  assert.equal(
    savedCitationUrl(receipt, 'raw'),
    '/api/assistant/resources/citation/raw?project=project%2Fone&path=resources%2Fa+b.md&handle=receipt'
  )
  assert.equal(
    savedCitationUrl(receipt, 'preview', 2),
    '/api/assistant/resources/citation/preview?project=project%2Fone&path=resources%2Fa+b.md&handle=receipt&page=2'
  )
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

test('failed citations show only an error while source-only citations retain the preview', async () => {
  for (const state of ['changed', 'source_only', 'unavailable'] as const) {
    const source = { ...CITATION, state, matches: [] }
    const previewed: CitationResolution[] = []
    const navigation = navigateDocumentLink(documentLinkTarget('scholarseed-cite:receipt'), {
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
    if (state === 'source_only') await navigation
    else
      await assert.rejects(
        navigation,
        (error) =>
          citationFailureMessage(error) ===
          (state === 'changed'
            ? 'markdown.citationSourceChanged'
            : 'markdown.citationSourceUnavailable')
      )
    assert.deepEqual(previewed, state === 'source_only' ? [source] : [])
  }
})

test('saved citation failures explain known reasons without exposing unknown server details', () => {
  assert.equal(
    citationFailureMessage(savedCitationError('citation_evidence_unavailable')),
    'markdown.citationRecordMissing'
  )
  assert.equal(citationFailureMessage(savedCitationError('private diagnostic')), undefined)
  assert.equal(citationFailureMessage(savedCitationError(null)), undefined)
  assert.equal(citationFailureMessage(new Error('browser failed')), undefined)
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
