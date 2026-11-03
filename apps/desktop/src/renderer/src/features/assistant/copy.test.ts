import assert from 'node:assert/strict'
import test from 'node:test'
import i18next from 'i18next'
import en from '../../../../localization/locales/en/assistant.json' with { type: 'json' }
import type { CitationResolution } from '../../contracts/citations'
import type { ConvItem } from '../../model'
import { copyAnswer } from './copy.ts'

await i18next.init({ lng: 'en', resources: { en: { assistant: en } } })

const item: Extract<ConvItem, { kind: 'agent' }> = {
  kind: 'agent',
  itemId: 'message',
  text: 'Observed[1](scholarseed-cite:evidence).',
  answerSources: [
    {
      number: 4,
      kind: 'receipt',
      handle: 'evidence',
      citation_urls: ['scholarseed-cite:evidence'],
    },
  ],
}
const source: CitationResolution = {
  handle: 'evidence',
  title: 'Paper',
  quote: 'The full observed result.',
  state: 'exact',
  pages: [{ page: 3, quads: [] }],
  path: 'paper.pdf',
  source_kind: 'literature',
  source_id: 'paper',
  content_level: 'fulltext',
  project_id: 'project',
  revision: 'sha256:source',
  version_bound: true,
  matches: [],
  presentation: {
    version: 1,
    mode: 'structured_text',
    precision: 'page',
    page: 3,
    text: 'The full observed result.',
    quality_reasons: [],
    manual_check: false,
  },
}

test('answer copy resolves actual receipts against the exact answer revision', async () => {
  const copied = await copyAnswer(
    item,
    'session',
    async (sessionId, answerId, revision) => {
      assert.equal(sessionId, 'session')
      assert.equal(answerId, 'item:message')
      assert.match(revision, /^sha256:[a-f0-9]{64}$/)
      return { count: 1, sources: [source] }
    },
    () => 'https://service.test/evidence?page=3'
  )
  assert.match(copied, /Observed\[4\]/)
  assert.match(copied, /\[4\] Paper/)
  assert.match(copied, /The full observed result\./)
  assert.match(copied, /https:\/\/service.test\/evidence\?page=3/)
  assert.doesNotMatch(copied, /scholarseed-cite:/)
})

test('unavailable receipt content fails instead of silently copying bare numbers', async () => {
  await assert.rejects(
    copyAnswer(item, 'session', async () => ({ count: 0, sources: [] })),
    /citation_sources_unavailable/
  )
  await assert.rejects(
    copyAnswer(item, 'session', async () => {
      throw new Error('offline')
    }),
    /offline/
  )
})

test('unavailable previews retain the actual receipt text and do not invent a working link', async () => {
  const copied = await copyAnswer(
    item,
    'session',
    async () => ({ count: 1, sources: [{ ...source, state: 'unavailable' }] }),
    () => {
      throw new Error('unavailable preview')
    }
  )
  assert.match(copied, /The full observed result\./)
  assert.doesNotMatch(copied, /paper\.pdf/)
  assert.match(copied, /unavailable/)
})

test('non-receipt answers do not request source resolution', async () => {
  assert.equal(
    await copyAnswer({ kind: 'agent', text: 'Answer' }, '', async () => {
      throw new Error('unexpected')
    }),
    'Answer'
  )
  const copied = await copyAnswer(
    { ...item, itemId: undefined, eventSeq: 42 },
    'session',
    async (_session, answerId) => {
      assert.equal(answerId, 'answer:42')
      return { count: 1, sources: [source] }
    },
    () => ''
  )
  assert.match(copied, /The full observed result\./)
  assert.doesNotMatch(copied, /paper\.pdf/)
})
