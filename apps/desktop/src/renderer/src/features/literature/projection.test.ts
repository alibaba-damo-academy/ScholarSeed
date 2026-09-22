import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import type { ConvItem } from '../../model.ts'
import type { ProductEvent } from '../../api.ts'
import { latestDisplayCardItems, projectActivityEvents, projectDisplayCardEvent } from '../../transcript.ts'
import { searchSupersessionKey } from './projection.ts'

const content = { origin: 'precise-search', session_id: 'session', run_id: 'run', round: 1, retained: 17 }
const search: Extract<ProductEvent, { type: 'display_card' }> = {
  v: 2, seq: 1, ts: 1, type: 'display_card', session_id: 'session', turn_id: 'turn', item_id: 'search-item',
  data: { card_id: 'search-card', type: 'literature-search', content }
}
const selection: typeof search = {
  ...search, seq: 2, ts: 2, item_id: 'selection-item',
  data: { ...search.data, card_id: 'selection-card', content: { ...content, selection: { artifact_id: 'selection' } } }
}

function visible(items: ConvItem[]): ConvItem[] {
  return latestDisplayCardItems(items, card => searchSupersessionKey(card.content), () => 'first')
}

test('precise search and authorization share one display slot with the current detail receipt', () => {
  const searched = projectDisplayCardEvent([], search)
  const message: ConvItem = { kind: 'agent', text: 'Preparing selected literature', turnId: 'turn' }
  const selected = projectDisplayCardEvent([...searched, message], selection)
  const before = structuredClone(selected)
  const shown = visible(selected)
  assert.equal(shown.length, 2)
  assert.deepEqual(shown[0], { ...searched[0], card: {
    cardId: 'selection-card', type: 'literature-search', content: selection.data.content
  } })
  assert.equal(shown[1], message)
  assert.deepEqual(selected, before)
  assert.deepEqual(visible(projectDisplayCardEvent(selected, search)), shown)
})

test('search stays visible until a selection is actually published; selection-only history also works', () => {
  const searched = projectDisplayCardEvent([], search)
  assert.deepEqual(visible(searched), searched)
  const selected = projectDisplayCardEvent([], selection)
  assert.deepEqual(visible(selected), selected)
})

test('live and restored search rounds have the same single-card projection', () => {
  const live = projectDisplayCardEvent(projectDisplayCardEvent([], search), selection)
  const restored = projectActivityEvents([], [search, selection])
  assert.deepEqual(visible(restored), visible(live))
  assert.equal(restored.length, 2)
})

test('search round keys isolate sessions, runs and rounds and exclude other literature origins', () => {
  const variants = [content, { ...content, round: 2 }, { ...content, run_id: 'other' }, { ...content, session_id: 'other' }]
  assert.equal(new Set(variants.map(searchSupersessionKey)).size, variants.length)
  const cards: ConvItem[] = [...variants, { ...content, origin: 'literature-review' }, { ...content, origin: 'agentic-search' }]
    .map((value, index) => ({ kind: 'display_card', card: { cardId: String(index), type: 'literature-search', content: value } }))
  assert.deepEqual(visible(cards), cards)
  for (const origin of ['literature-review', 'slr-codex', 'agentic-search', undefined]) {
    assert.equal(searchSupersessionKey({ ...content, origin }), null)
  }
})

test('incomplete or invalid search identities never hide other cards', () => {
  const invalid = [
    { session_id: '' }, { session_id: ' ' }, { session_id: null }, { run_id: '' }, { run_id: ' ' },
    { run_id: null }, { round: 0 }, { round: -1 }, { round: 1.5 }, { round: '1' },
    { round: NaN }, { round: Infinity }, { round: Number.MAX_SAFE_INTEGER + 1 }
  ]
  for (const change of invalid) assert.equal(searchSupersessionKey({ ...content, ...change }), null)
  assert.notEqual(
    searchSupersessionKey({ ...content, session_id: 'a:b', run_id: 'c' }),
    searchSupersessionKey({ ...content, session_id: 'a', run_id: 'b:c' })
  )
})

test('the literature contribution opts search into first-position projection without changing review policy', () => {
  const feature = readFileSync(new URL('./feature.tsx', import.meta.url), 'utf8')
  assert.match(feature, /type: 'literature-search',\s*supersessionKey: searchSupersessionKey,\s*supersessionPosition: 'first'/)
  const cards = readFileSync(new URL('../../components/business/Cards.tsx', import.meta.url), 'utf8')
  assert.match(cards, /card => cards\.get\(card\.type\)\?\.supersessionPosition/)
})
