import assert from 'node:assert/strict'
import test from 'node:test'

import { deliveryPath, parseDeliveryRequest, parseDeliverySave } from './delivery.ts'

test('native directory selection accepts only a bound session and delivery, never a path', () => {
  assert.deepEqual(parseDeliveryRequest({ sessionId: 'session', deliveryId: 'batch' }), {
    sessionId: 'session',
    deliveryId: 'batch',
  })
  assert.throws(() =>
    parseDeliveryRequest({ sessionId: 'session', deliveryId: 'batch', path: '/chosen' })
  )
  assert.throws(() => parseDeliveryRequest({ sessionId: '', deliveryId: 'batch' }))
  assert.throws(() => parseDeliveryRequest(null))
})

test('native product URLs escape session and batch identity', () => {
  assert.equal(
    deliveryPath({ sessionId: 'a/b', deliveryId: 'c/d' }, 'directory'),
    '/api/sessions/a%2Fb/literature/deliveries/c%2Fd/directory'
  )
})

test('save confirmation accepts product choice but rejects arbitrary filesystem paths', () => {
  const request = {
    sessionId: 'session',
    deliveryId: 'batch',
    choice: {
      target: 'project',
      parent: 'papers',
      ticket: '',
      add_to_library: true,
      collection_id: '',
    },
  }
  assert.deepEqual(parseDeliverySave(request), request)
  assert.throws(() => parseDeliverySave({ ...request, absolute: '/chosen' }))
  const selected = { ...request, choice: { ...request.choice, project_id: 'chosen-project' } }
  assert.deepEqual(parseDeliverySave(selected), selected)
  for (const project_id of [null, 12, 'x'.repeat(129)])
    assert.throws(() =>
      parseDeliverySave({ ...request, choice: { ...request.choice, project_id } })
    )
  assert.throws(() =>
    parseDeliverySave({ ...request, choice: { ...request.choice, absolute: '/chosen' } })
  )
  assert.throws(() =>
    parseDeliverySave({ ...request, choice: { ...request.choice, target: 'elsewhere' } })
  )
})

test('version decisions accept only bounded paper identities and supported actions', () => {
  const request = {
    sessionId: 'session',
    deliveryId: 'batch',
    choice: {
      target: 'project',
      parent: '',
      ticket: '',
      add_to_library: true,
      collection_id: '',
      versions: { paper: 'keep_both', another: 'skip' },
    },
  }
  assert.deepEqual(parseDeliverySave(request), request)
  for (const versions of [
    { paper: 'overwrite' },
    { '': 'skip' },
    [],
    null,
    { ['x'.repeat(129)]: 'skip' },
  ])
    assert.throws(() => parseDeliverySave({ ...request, choice: { ...request.choice, versions } }))
})
