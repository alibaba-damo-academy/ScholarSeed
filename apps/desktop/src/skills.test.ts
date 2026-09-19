import assert from 'node:assert/strict'
import test from 'node:test'

import { SKILLS_PATH, SKILL_SURFACE_CONVERSATION, SKILL_SURFACE_SETTINGS, skillRequest } from './skills.ts'

test('requests the conversation skill surface without changing the base management route', () => {
  assert.deepEqual(skillRequest({ operation: 'list' }), {
    path: SKILLS_PATH,
    init: { method: 'GET' }
  })
  assert.deepEqual(
    skillRequest({ operation: 'list', surface: SKILL_SURFACE_CONVERSATION }),
    {
      path: `${SKILLS_PATH}?surface=conversation`,
      init: { method: 'GET' }
    }
  )
  assert.deepEqual(
    skillRequest({ operation: 'list', surface: SKILL_SURFACE_SETTINGS }),
    {
      path: `${SKILLS_PATH}?surface=settings`,
      init: { method: 'GET' }
    }
  )
})
