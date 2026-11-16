import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PreviewAuthorization, PREVIEW_AUTHORIZATION } from './authorization.ts'

test('review authorization uses its real question identity and preserves the full scope on renewal', () => {
  const owner = new PreviewAuthorization('review-session', 'review')
  const question = owner.current()
  assert.ok(question.request_id.startsWith('literature-review-fulltext:'))
  assert.equal(question.questions![0].header, '综述检索授权')
  assert.equal(
    question.questions![0].question,
    '是否允许读取已展示文献的全文，用于继续生成文献综述？'
  )
  assert.equal(owner.result().origin, 'literature-review')
  const selected = question.questions![0].papers!.map((paper) => paper.id)
  assert.throws(
    () =>
      owner.resolve(question.request_id, {
        answers: { [question.request_id]: PREVIEW_AUTHORIZATION.allow },
        values: { selected_paper_ids: selected.slice(0, 1) },
      }),
    /preview_invalid_selection/
  )
  owner.resolve(question.request_id, {
    answers: { [question.request_id]: PREVIEW_AUTHORIZATION.deny },
  })
  owner.retry(question.request_id)
  const renewed = owner.current()
  assert.ok(renewed.request_id.startsWith('literature-review-fulltext:'))
  assert.deepEqual(renewed.questions![0].papers, question.questions![0].papers)
  assert.deepEqual(
    owner.resolve(renewed.request_id, {
      answers: { [renewed.request_id]: PREVIEW_AUTHORIZATION.allow },
    }).selected_paper_ids,
    selected
  )
})

for (const answer of [PREVIEW_AUTHORIZATION.allow, PREVIEW_AUTHORIZATION.deny]) {
  test(`explicit preview answer records server-owned user provenance: ${answer}`, () => {
    const owner = new PreviewAuthorization('source-session', 'precise')
    const question = owner.current()
    assert.equal(question.decision_source, undefined)
    const resolved = owner.resolve(question.request_id, {
      answers: { [question.request_id]: answer },
      decision_source: 'auto',
    })
    assert.equal(resolved.decision_source, 'user_explicit')
    assert.equal(owner.current().decision_source, 'user_explicit')
  })
}
