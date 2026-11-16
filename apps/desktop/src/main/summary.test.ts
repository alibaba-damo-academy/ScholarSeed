import assert from 'node:assert/strict'
import test from 'node:test'
import { attentionSnapshot, type AttentionItem, type AttentionSnapshot } from '../attention.ts'
import { AttentionDelivery } from './attention.ts'
import { attentionPath, notificationText, reminderSummary, withoutMarkdown } from './summary.ts'

const item: AttentionItem = {
  id: 'reminder',
  session_id: 'session',
  kind: 'completed',
  turn_id: 'turn',
  request_id: null,
  item_id: 'answer',
  title: 'Task',
  body: '**truncated',
  created_at: 1,
  source_seq: 2,
  revision: 1,
}
const snapshot: AttentionSnapshot = {
  epoch: 'scope',
  revision: 1,
  unread_count: 1,
  by_session: { session: 1 },
  items: [item],
}

test('initial fetch has no source request; later fetches use the accepted scope and watermark', () => {
  assert.equal(attentionPath(null), '/api/serve/attention')
  const url = new URL(attentionPath(snapshot), 'http://localhost')
  assert.equal(url.pathname, '/api/serve/attention')
  assert.equal(url.searchParams.get('epoch'), 'scope')
  assert.equal(url.searchParams.get('after_revision'), '1')
})

test('full Markdown is parsed before truncation and secrets are redacted after parsing', () => {
  const markdown =
    '**' + 'word '.repeat(120).trimEnd() + '**\n\n[paper][ref]\n\n[ref]: https://example.com'
  const result = reminderSummary({ ...item, markdown })
  assert.equal(result, 'word '.repeat(120) + 'paper')
  assert.equal(notificationText(result), 'word '.repeat(99) + 'word…')
  assert.equal(
    reminderSummary({ ...item, markdown: '`**literal**` pass**word**=private' }),
    '**literal** [redacted]'
  )
  assert.equal(
    reminderSummary({ ...item, kind: 'failed', body: '**literal error**' }),
    '**literal error**'
  )
  assert.equal(item.body, '**truncated')
})

test('missing and over-budget originals never reinterpret the truncated body', () => {
  assert.throws(() => reminderSummary(item), /unavailable/)
  assert.throws(() => reminderSummary({ ...item, markdown: null }), /unavailable/)
  assert.equal(reminderSummary({ ...item, markdown: '' }), '')
})

test('snapshot originals are validated and discarded before renderer IPC or retention', () => {
  const incoming = { ...snapshot, items: [{ ...item, markdown: '**result**' }] }
  const parsed = attentionSnapshot(incoming)
  const retained = withoutMarkdown(parsed)
  assert.equal(parsed.items[0].markdown, '**result**')
  assert.equal(Object.hasOwn(retained.items[0], 'markdown'), false)
  assert.deepEqual(retained, snapshot)
  assert.throws(() => attentionSnapshot({ ...snapshot, items: [{ ...item, markdown: {} }] }))
  assert.throws(() =>
    attentionSnapshot({ ...snapshot, items: [{ ...item, kind: 'waiting', markdown: 'wrong' }] })
  )
})

test('the real delivery controller consumes incremental originals once, not on cold start or epoch reset', () => {
  const delivered: string[] = []
  const persisted: number[] = []
  const delivery = new AttentionDelivery({
    persist: (cursor) => {
      persisted.push(cursor.revision)
    },
    foreground: () => false,
    reconcile() {},
    show: (current) => {
      assert.ok(persisted.at(-1)! >= current.revision)
      delivered.push(reminderSummary(current))
    },
  })
  delivery.accept(snapshot)
  const fresh = { ...snapshot, revision: 2, items: [{ ...item, revision: 2, markdown: '**new**' }] }
  delivery.accept(fresh)
  delivery.accept(withoutMarkdown(fresh))
  delivery.accept({ ...fresh, epoch: 'another-owner' })
  assert.deepEqual(delivered, ['new'])
  delivery.reset()
  delivery.accept(fresh)
  assert.deepEqual(delivered, ['new'])
})

test('truncation preserves emoji and combining graphemes', () => {
  assert.equal(notificationText('abcd👨‍👩‍👧‍👦尾', 10), 'abcd…')
  assert.equal(notificationText('中文🙂尾', 5), '中文🙂尾')
  assert.equal(notificationText('abcd é tail', 7), 'abcd …')
})
