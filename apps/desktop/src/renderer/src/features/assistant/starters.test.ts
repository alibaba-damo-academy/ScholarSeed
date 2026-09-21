import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import type { SkillInfo } from '../../api.ts'
import {
  AI_TASK_STARTERS,
  AI_TASK_STARTER_SKILL_NAMES,
  resolveTaskStarterSkill
} from './starters.ts'

function skill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name: 'precise-literature-search',
    enabled: true,
    active: true,
    group: 'scholarseed',
    removable: false,
    toggleable: false,
    path: '/tmp/skills/precise-literature-search/SKILL.md',
    ...overrides
  }
}

test('task starters map three product prompts to their conversation skills', () => {
  assert.deepEqual(
    AI_TASK_STARTERS.map(({ skillName }) => skillName),
    [
      'precise-literature-search',
      'literature-review',
      'research-idea-partner'
    ]
  )
  assert.deepEqual(
    AI_TASK_STARTERS.map(({ taskType }) => taskType),
    ['precise_search', 'literature_review', 'research_idea']
  )
  assert.equal(AI_TASK_STARTER_SKILL_NAMES.size, 3)
})

test('ready task starter skill becomes a typed composer reference', () => {
  assert.deepEqual(resolveTaskStarterSkill([skill()], 'precise-literature-search'), {
    reference: {
      type: 'skill',
      id: 'precise-literature-search',
      title: 'precise-literature-search',
      path: '/tmp/skills/precise-literature-search/SKILL.md',
      version: undefined
    }
  })
})

test('every research starter is login-gated by the product catalog', () => {
  const catalog = JSON.parse(readFileSync(new URL('../../../../../../serve/service/capabilities/catalog.json', import.meta.url), 'utf8'))
  for (const starter of AI_TASK_STARTERS) {
    assert.ok(catalog.requires_login.includes(starter.skillName), starter.skillName)
    const restricted = skill({
      name: starter.skillName,
      requires_login: true,
      active: false,
      unavailable_reason: 'login_required'
    })
    assert.deepEqual(resolveTaskStarterSkill([restricted], starter.skillName), { failure: 'login_required' })
  }
})

test('task starter skill failures stay explicit', () => {
  assert.deepEqual(
    resolveTaskStarterSkill([skill({ requires_login: true, active: false, unavailable_reason: 'login_required' })], 'precise-literature-search'),
    { failure: 'login_required' }
  )
  assert.deepEqual(resolveTaskStarterSkill([], 'precise-literature-search'), {
    failure: 'missing'
  })
  assert.deepEqual(
    resolveTaskStarterSkill([skill({ active: false })], 'precise-literature-search'),
    { failure: 'disabled' }
  )
  assert.deepEqual(
    resolveTaskStarterSkill(
      [skill({ dependency_status: 'missing' })],
      'precise-literature-search'
    ),
    { failure: 'dependencies' }
  )
  assert.deepEqual(
    resolveTaskStarterSkill([skill({ path: 'relative/SKILL.md' })], 'precise-literature-search'),
    { failure: 'path' }
  )
})
