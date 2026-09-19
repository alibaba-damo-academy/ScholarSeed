import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance } from 'i18next'
import zh from '../../localization/locales/zh/conversation.json' with { type: 'json' }
import en from '../../localization/locales/en/conversation.json' with { type: 'json' }
import { projectDelivery, projectHistory } from './transcript.ts'
import { deliveryLabel, deliveryMemberTitle } from './delivery.ts'

test('delivery fallbacks redraw without translating explicit empty or user titles', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, resources: { zh: { conversation: zh }, en: { conversation: en } } })
  const t = locale.getFixedT(null, 'conversation')
  const card = projectDelivery({ members: [{ material_id: 'material', revision: 'r1', preview_available: true }] }).delivery
  assert.equal(deliveryLabel(card, t), '本次交付')
  assert.equal(deliveryMemberTitle(card.members[0], t), '未命名产物')
  await locale.changeLanguage('en')
  assert.equal(deliveryLabel(card, t), 'This delivery')
  assert.equal(deliveryMemberTitle(card.members[0], t), 'Untitled artifact')
  assert.equal(card.members[0].materialId, 'material')
  assert.equal(card.members[0].revision, 'r1')
  const empty = projectDelivery({ label: '', members: [{ title: '', preview_available: false }] }).delivery
  assert.equal(deliveryLabel(empty, t), '')
  assert.equal(deliveryMemberTitle(empty.members[0], t), '')
  assert.equal(deliveryMemberTitle({ ...empty.members[0], title: '用户报告' }, t), '用户报告')
})

test('legacy preview fallback retains its original delivery identity', () => {
  const items = projectHistory([{ kind: 'preview', preview: {} }])
  const card = items.find((item) => item.kind === 'delivery')
  assert.equal(card?.kind, 'delivery')
  if (card?.kind !== 'delivery') return
  assert.equal(card.delivery.deliveryId, 'legacy-preview:未命名产物:')
  assert.equal(card.delivery.labelFallback, 'legacy')
  assert.equal(card.delivery.members[0].titleFallback, true)
})
