import assert from 'node:assert/strict'
import test from 'node:test'

import {
  invalidateResourceProject,
  resourceProjectRevision,
  subscribeResourceRevisions,
} from './revision.ts'

test('background task invalidations retain only their own project revision', () => {
  let notifications = 0
  const stop = subscribeResourceRevisions(() => {
    notifications += 1
  })
  const before = resourceProjectRevision('project-a')
  invalidateResourceProject('project-a')
  invalidateResourceProject('project-a')
  assert.equal(resourceProjectRevision('project-a'), before + 2)
  assert.equal(resourceProjectRevision('project-b'), 0)
  assert.equal(resourceProjectRevision(null), 0)
  assert.equal(notifications, 2)
  stop()
  invalidateResourceProject('project-a')
  assert.equal(notifications, 2)
})
