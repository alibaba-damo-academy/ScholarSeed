import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance } from 'i18next'
import zh from '../../../../localization/locales/zh/assistant.json' with { type: 'json' }
import en from '../../../../localization/locales/en/assistant.json' with { type: 'json' }
import zhComponents from '../../../../localization/locales/zh/components.json' with { type: 'json' }
import enComponents from '../../../../localization/locales/en/components.json' with { type: 'json' }
import { contextLabelFallback } from '../../contracts/assistant.ts'
import { renderFeedback } from '../../contracts/feedback.ts'
import { serviceErrorDetail } from '../../api.ts'
import { queuedMessageFromPayload, optimisticQueuedMessage } from '../../queue.ts'
import { queuedReferenceLabel, queuedReferenceSummary, turnAdmissionFeedback, describeTurnAdmissionFailure } from '../../input.ts'
import { projectHistory, upsertUserMessageEvent } from '../../transcript.ts'
import { candidateLabel, previewReferenceLabel, referenceBaseLabel, referenceLabel } from './text.ts'

async function localization() {
  const instance = createInstance()
  await instance.init({ lng: 'zh', fallbackLng: false, interpolation: { escapeValue: false }, resources: {
    zh: { assistant: zh, components: zhComponents }, en: { assistant: en, components: enComponents }
  } })
  return instance
}
const marked = { kind: 'session' as const, label: '未命名对话', label_fallback: 'untitled_session' as const }

test('only known session provenance translates; renamed, legacy and unknown labels remain literal', async () => {
  const locale = await localization()
  const t = locale.getFixedT(null, 'assistant')
  const renamed = { ...marked, label: '未命名对话', label_fallback: null }
  const legacy = { kind: 'session', label: '未命名对话' }
  const unknown = { ...marked, label_fallback: 'future_label' }
  const file = { ...marked, kind: 'file' }
  const original = JSON.stringify([marked, renamed, legacy, unknown, file])
  assert.equal(referenceLabel(marked, t), '未命名对话')
  await locale.changeLanguage('en')
  assert.equal(referenceLabel(marked, t), 'Untitled conversation')
  for (const ref of [renamed, legacy, unknown, file]) assert.equal(referenceLabel(ref, t), '未命名对话')
  assert.equal(referenceLabel({ ...legacy, label: 'User / & <中英>' }, t), 'User / & <中英>')
  assert.equal(referenceLabel({ ...legacy, label: '' }, t), '')
  assert.equal(contextLabelFallback('file', 'untitled_session'), null)
  assert.equal(contextLabelFallback('session', 'future_label'), null)
  assert.equal(candidateLabel({ kind: 'file', source_id: 'file', label: '未命名对话', labelFallback: 'untitledSession', origin: 'explicit' }, t), '未命名对话')
  assert.equal(JSON.stringify([marked, renamed, legacy, unknown, file]), original)
})

test('history, confirmed queue and optimistic queue retain provenance without rewriting titles or input', async () => {
  const locale = await localization()
  const t = locale.getFixedT(null, 'assistant')
  const input = [{ type: 'text' as const, text: 'Question / & <中英>' }]
  const reference = { ...marked, ref_id: 'ref', source_id: 'source', state: 'ready' }
  const queue = queuedMessageFromPayload({ queued_message_id: 'queued', enqueue_seq: 3, state: 'queued', input, assistant_references: [reference] })
  const optimistic = optimisticQueuedMessage([], 'optimistic', input, [reference])
  const history = projectHistory([{ kind: 'user', text: input[0].text, refs: [{ type: 'assistant_context', id: 'ref', title: marked.label, kind: 'session', label_fallback: marked.label_fallback, source_id: 'source', snapshot_id: 'snapshot' }] }])
  const message = history[0]
  assert.equal(message.kind, 'user')
  if (message.kind !== 'user') return
  const restored = message.refs![0]
  const original = JSON.stringify([queue, optimistic, restored])
  await locale.changeLanguage('en')
  assert.equal(referenceLabel(restored, t), 'Untitled conversation')
  assert.equal(queuedReferenceLabel(queue.assistantReferences[0], t), 'Untitled conversation')
  assert.equal(queuedReferenceSummary(input, optimistic.assistantReferences, t), 'Untitled conversation')
  assert.equal(restored.sourceId, 'source')
  assert.equal(restored.snapshotId, 'snapshot')
  assert.equal(restored.title, '未命名对话')
  assert.deepEqual(queue.input, input)
  assert.equal(JSON.stringify([queue, optimistic, restored]), original)
})

test('failure whitelist retains only valid session metadata and stored feedback redraws its reference name', async () => {
  const locale = await localization()
  const issue = { ...marked, ref_id: 'ref', state: 'missing', reason: 'source_missing' }
  const detail = await serviceErrorDetail(new Response(JSON.stringify({ code: 'assistant_context_unavailable', issues: [issue, { ...issue, kind: 'file' }, { ...issue, label_fallback: 'future_label' }] }), { status: 409 }))
  assert.equal(detail.issues![0].label_fallback, 'untitled_session')
  assert.equal(detail.issues![1].label_fallback, undefined)
  assert.equal(detail.issues![2].label_fallback, undefined)
  const failure = { code: detail.code, issues: detail.issues }
  const message = turnAdmissionFeedback(failure)
  const serialized = JSON.stringify(message)
  assert.ok(renderFeedback(locale, message).includes('未命名对话'))
  await locale.changeLanguage('en')
  assert.ok(renderFeedback(locale, message).includes('Untitled conversation'))
  assert.ok(describeTurnAdmissionFailure(locale.getFixedT(null, 'components'), failure).includes('Untitled conversation'))
  assert.equal(JSON.stringify(message), serialized)
  assert.equal(detail.issues![0].label, '未命名对话')
})

test('preview empty titles retain the frozen title while current metadata controls translation', async () => {
  const locale = await localization()
  await locale.changeLanguage('en')
  const t = locale.getFixedT(null, 'assistant')
  const reference = { kind: 'session', title: '未命名对话', label_fallback: 'untitled_session' }
  assert.equal(previewReferenceLabel(reference, { title: '' }, t), '未命名对话')
  assert.equal(previewReferenceLabel(reference, { title: '', label_fallback: 'untitled_session' }, t), 'Untitled conversation')
  assert.equal(previewReferenceLabel(reference, { title: '未命名对话', label_fallback: null }, t), '未命名对话')
  assert.equal(previewReferenceLabel(reference, { title: 'Renamed / & <中英>', label_fallback: null }, t), 'Renamed / & <中英>')
})

test('live user events preserve provenance and reconcile the same optimistic message identity', async () => {
  const locale = await localization()
  await locale.changeLanguage('en')
  const t = locale.getFixedT(null, 'assistant')
  const items = upsertUserMessageEvent([{ kind: 'user', text: 'Original question', turnId: 'client-turn' }], {
    v: 2, seq: 7, ts: 1, type: 'user_message', session_id: 'session', turn_id: 'server-turn', item_id: 'user-item',
    data: { binding: 'bound', text: 'Original question', client_turn_id: 'client-turn', refs: [{ type: 'assistant_context', id: 'ref', kind: 'session', title: marked.label, label_fallback: marked.label_fallback, source_id: 'source', snapshot_id: 'snapshot' }] }
  })
  assert.equal(items.length, 1)
  const item = items[0]
  assert.equal(item.kind, 'user')
  if (item.kind !== 'user') return
  assert.equal(item.itemId, 'user-item')
  assert.equal(item.text, 'Original question')
  assert.equal(item.refs![0].title, '未命名对话')
  assert.equal(referenceLabel(item.refs![0], t), 'Untitled conversation')
  const cleared = await serviceErrorDetail(new Response(JSON.stringify({ issues: [{ ...marked, ref_id: 'r', reason: 'source_missing', state: 'missing', label_fallback: null }] })))
  assert.equal(cleared.issues![0].label_fallback, null)
})

test('selection base and full labels preserve literal suffixes, empty titles and legacy values', async () => {
  const locale = await localization()
  const t = locale.getFixedT(null, 'assistant')
  const anchor = { locator: { kind: 'pdf', page: 1 }, preview_text: 'Original excerpt' }
  const markedSelection = { kind: 'literature', label: '原始组合 · 划词', selection_source_label: '论文 · 划词', anchor }
  const original = JSON.stringify(markedSelection)
  assert.equal(referenceBaseLabel(markedSelection, t), '论文 · 划词')
  assert.equal(referenceLabel(markedSelection, t), '论文 · 划词 · 选区')
  await locale.changeLanguage('en')
  assert.equal(referenceBaseLabel(markedSelection, t), '论文 · 划词')
  assert.equal(referenceLabel(markedSelection, t), '论文 · 划词 · Selection')
  assert.equal(queuedReferenceLabel(markedSelection, t), '论文 · 划词 · Selection')
  assert.equal(referenceBaseLabel({ ...markedSelection, selection_source_label: '' }, t), '')
  assert.equal(referenceLabel({ ...markedSelection, selection_source_label: '' }, t), ' · Selection')
  for (const metadata of [undefined, null]) {
    assert.equal(referenceBaseLabel({ ...markedSelection, selection_source_label: metadata }, t), markedSelection.label)
    assert.equal(referenceLabel({ ...markedSelection, selection_source_label: metadata }, t), markedSelection.label)
  }
  assert.equal(referenceLabel({ ...markedSelection, anchor: null }, t), markedSelection.label)
  assert.equal(referenceLabel({ ...markedSelection, kind: 'session' }, t), markedSelection.label)
  assert.equal(referenceLabel({ ...markedSelection, kind: 'selection', selection_source_label: '  File / & <中英>  ' }, t), '  File / & <中英>   · Selection')
  assert.equal(JSON.stringify(markedSelection), original)
})

test('selection metadata survives queued and live/history projections without changing canonical data', async () => {
  const locale = await localization()
  await locale.changeLanguage('en')
  const t = locale.getFixedT(null, 'assistant')
  const anchor = { locator: { kind: 'writer', start: 1, end: 2 }, preview_text: '原选区 / & <text>' }
  const input = [{ type: 'text' as const, text: '原问题' }]
  const reference = { kind: 'selection', ref_id: 'ref', label: '原组合 · 划词', selection_source_label: '', anchor }
  const queued = queuedMessageFromPayload({ queued_message_id: 'q', enqueue_seq: 2, state: 'queued', input, assistant_references: [reference] })
  const optimistic = optimisticQueuedMessage([], 'q', input, [reference])
  assert.deepEqual(queued.assistantReferences, optimistic.assistantReferences)
  assert.equal(queuedReferenceSummary(input, queued.assistantReferences, t), ' · Selection')
  const wire = { type: 'assistant_context', id: 'ref', kind: 'selection', title: reference.label, selection_source_label: '', anchor, source_id: 'resources/a.docx', snapshot_id: 'snapshot' }
  const history = projectHistory([{ kind: 'user', text: input[0].text, refs: [wire] }])
  const live = upsertUserMessageEvent([], { v: 2, seq: 1, ts: 1, type: 'user_message', session_id: 's', turn_id: 't', item_id: 'i', data: { text: input[0].text, client_turn_id: 'c', binding: 'bound', refs: [wire] } })
  for (const item of [history[0], live[0]]) {
    assert.equal(item.kind, 'user')
    if (item.kind !== 'user') continue
    const ref = item.refs![0]
    assert.equal(ref.selection_source_label, '')
    assert.equal(ref.title, reference.label)
    assert.equal(ref.anchor?.previewText, anchor.preview_text)
    assert.equal(referenceBaseLabel(ref, t), '')
  }
  assert.equal(queued.assistantReferences[0].label, reference.label)
  assert.deepEqual(queued.input, input)
})

test('failure selection titles are validated response provenance and redraw without exposing anchors', async () => {
  const locale = await localization()
  const issue = { kind: 'literature', label: 'Original canonical', selection_source_label: '论文 · 划词', ref_id: 'r', state: 'missing', reason: 'source_missing' }
  const detail = await serviceErrorDetail(new Response(JSON.stringify({ code: 'assistant_context_unavailable', issues: [issue, { ...issue, selection_source_label: '' }, { ...issue, kind: 'file' }, { ...issue, selection_source_label: null }] })))
  assert.equal(detail.issues![0].selection_source_label, '论文 · 划词')
  assert.equal(detail.issues![1].selection_source_label, '')
  assert.equal(detail.issues![2].selection_source_label, undefined)
  assert.equal(detail.issues![3].selection_source_label, undefined)
  assert.equal('anchor' in detail.issues![0], false)
  const message = turnAdmissionFeedback({ code: detail.code, issues: detail.issues })
  const original = JSON.stringify(message)
  assert.ok(renderFeedback(locale, message).includes('论文 · 划词 · 选区'))
  await locale.changeLanguage('en')
  assert.ok(renderFeedback(locale, message).includes('论文 · 划词 · Selection'))
  assert.ok(describeTurnAdmissionFailure(locale.getFixedT(null, 'components'), { code: detail.code, issues: detail.issues }).includes('论文 · 划词 · Selection'))
  assert.equal(JSON.stringify(message), original)
  assert.equal(detail.issues![0].label, 'Original canonical')
})

test('new-session reference provenance remains distinct through candidates, history, queue, preview and failure feedback', async () => {
  const locale = await localization()
  const t = locale.getFixedT(null, 'assistant')
  const source = { kind: 'session' as const, label: '新对话', label_fallback: 'new_session' as const }
  const candidate = { kind: 'session' as const, source_id: 'new-session', label: source.label, labelFallback: 'newSession' as const, origin: 'explicit' as const }
  const input = [{ type: 'text' as const, text: 'Keep canonical names / & <中英>' }]
  const queue = queuedMessageFromPayload({ queued_message_id: 'queued', enqueue_seq: 1, state: 'queued', input, assistant_references: [source] })
  const history = projectHistory([{ kind: 'user', text: input[0].text, refs: [{ type: 'assistant_context', id: 'ref', title: source.label, kind: 'session', label_fallback: source.label_fallback }] }])
  const message = history[0]
  assert.equal(message.kind, 'user')
  if (message.kind !== 'user') return
  const restored = message.refs![0]
  const detail = await serviceErrorDetail(new Response(JSON.stringify({ code: 'assistant_context_unavailable', issues: [
    { ...source, ref_id: 'ref', state: 'missing', reason: 'source_missing' }, { ...source, ref_id: 'file', state: 'missing', reason: 'source_missing', kind: 'file' }
  ] }), { status: 409 }))
  const failure = { code: detail.code, issues: detail.issues }
  const feedback = turnAdmissionFeedback(failure)
  const original = JSON.stringify([candidate, queue, restored, feedback])
  assert.equal(referenceLabel(source, t), '新对话')
  await locale.changeLanguage('en')
  assert.equal(candidateLabel(candidate, t), 'New conversation')
  assert.equal(referenceLabel(restored, t), 'New conversation')
  assert.equal(queuedReferenceLabel(queue.assistantReferences[0], t), 'New conversation')
  assert.equal(previewReferenceLabel(restored, { title: '新对话', label_fallback: 'new_session' }, t), 'New conversation')
  assert.equal(previewReferenceLabel(restored, { title: '新对话', label_fallback: null }, t), '新对话')
  assert.equal(referenceLabel(marked, t), 'Untitled conversation')
  assert.ok(renderFeedback(locale, feedback).includes('New conversation'))
  assert.ok(describeTurnAdmissionFailure(locale.getFixedT(null, 'components'), failure).includes('New conversation'))
  assert.equal(detail.issues![1].label_fallback, undefined)
  assert.equal(contextLabelFallback('literature', 'new_session'), null)
  assert.equal(JSON.stringify([candidate, queue, restored, feedback]), original)
})
