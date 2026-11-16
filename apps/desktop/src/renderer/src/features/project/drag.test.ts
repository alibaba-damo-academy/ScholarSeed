import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canDetachSession,
  canOrderSession,
  canRestoreSession,
  isSessionRestorePosition,
} from './drag.ts'

test('returning accepts only the previous root parent without carrying children', () => {
  const parent = { session_id: 'parent', project_path: '/project' }
  const child = {
    session_id: 'child',
    project_path: '/project',
    detached_parent_session_id: 'parent',
  }
  const other = { ...parent, session_id: 'other' }
  assert.equal(canRestoreSession(child, parent, '/project', [parent, child]), true)
  assert.equal(canRestoreSession(child, other, '/project', [parent, child, other]), false)
  assert.equal(canRestoreSession(child, parent, '/other', [parent, child]), false)
  assert.equal(
    canRestoreSession(child, { ...parent, display_parent_session_id: 'other' }, '/project', [
      parent,
      child,
    ]),
    false
  )
  assert.equal(
    canRestoreSession(child, parent, '/project', [
      parent,
      child,
      { ...other, display_parent_session_id: 'child' },
    ]),
    false
  )
  assert.equal(
    canRestoreSession({ ...child, pinned: true }, parent, '/project', [parent, child]),
    false
  )
  assert.equal(isSessionRestorePosition(20, { top: 10, height: 40 }), true)
  assert.equal(isSessionRestorePosition(11, { top: 10, height: 40 }), false)
  assert.equal(isSessionRestorePosition(49, { top: 10, height: 40 }), false)
})

test('detachment accepts only a displayed child in the current project', () => {
  const child = { project_path: '/project', display_parent_session_id: 'parent' }
  assert.equal(canDetachSession(child, '/project'), true)
  assert.equal(canDetachSession(child, '/other'), false)
  assert.equal(canDetachSession(child, undefined), false)
  assert.equal(canDetachSession({ ...child, project_path: null }, '/project'), false)
  assert.equal(canDetachSession({ ...child, display_parent_session_id: null }, '/project'), false)
  assert.equal(canDetachSession({ ...child, display_parent_session_id: '' }, '/project'), false)
})

test('ordering accepts only same-project siblings in the same effective pinned section', () => {
  const parent = { session_id: 'parent', project_path: '/project' }
  const other = { session_id: 'other', project_path: '/project' }
  const child = {
    session_id: 'child',
    project_path: '/project',
    display_parent_session_id: 'parent',
    pinned: true,
  }
  const sibling = { ...child, session_id: 'sibling', pinned: false }
  const foreignGroup = { ...child, session_id: 'foreign-group', display_parent_session_id: 'other' }
  const rows = [parent, other, child, sibling, foreignGroup]
  assert.equal(canOrderSession(child, sibling, '/project', rows), true)
  assert.equal(canOrderSession(child, foreignGroup, '/project', rows), false)
  assert.equal(canOrderSession(parent, child, '/project', rows), false)
  assert.equal(canOrderSession(parent, other, '/project', rows), true)
  assert.equal(canOrderSession(parent, other, '/project', [parent, other, child]), false)
  assert.equal(
    canOrderSession(parent, { ...other, project_path: '/other' }, '/project', rows),
    false
  )
  assert.equal(canOrderSession(parent, parent, '/project', rows), false)
})
