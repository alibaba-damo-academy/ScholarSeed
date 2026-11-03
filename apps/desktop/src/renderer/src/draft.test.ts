import assert from 'node:assert/strict'
import test from 'node:test'

import { createComposerDraftStore, restoreComposerDraft } from './draft.ts'

test('composer draft updates notify only draft subscribers', () => {
  const draft = createComposerDraftStore('seed')
  const snapshots: string[] = []
  const unsubscribe = draft.subscribe(() => snapshots.push(draft.getSnapshot()))

  draft.set('你为什么')
  draft.set((current) => `${current}卡顿`)
  draft.set('你为什么卡顿')
  unsubscribe()
  draft.set('ignored after unsubscribe')

  assert.deepEqual(snapshots, ['你为什么', '你为什么卡顿'])
})

test('failed submissions restore before any draft typed while sending', () => {
  assert.equal(restoreComposerDraft('原问题', ''), '原问题')
  assert.equal(restoreComposerDraft('原问题', '后续草稿'), '原问题\n后续草稿')
})

test('draft revisions distinguish edits that return to the submitted text', () => {
  const draft = createComposerDraftStore('submitted')
  const revision = draft.getRevision()
  draft.set('submitted')
  assert.equal(draft.getRevision(), revision)
  draft.set('')
  draft.set('submitted')
  assert.equal(draft.getSnapshot(), 'submitted')
  assert.equal(draft.getRevision(), revision + 2)
})
