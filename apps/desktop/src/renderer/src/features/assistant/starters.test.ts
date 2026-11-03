import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import type { SkillInfo } from '../../api.ts'
import {
  AI_TASK_STARTERS,
  AI_TASK_STARTER_SKILL_NAMES,
  resolveTaskStarterSkill,
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
    ...overrides,
  }
}

test('task starters map three product prompts to their conversation skills', () => {
  assert.deepEqual(
    AI_TASK_STARTERS.map(({ skillName }) => skillName),
    ['precise-literature-search', 'literature-review', 'research-idea-partner']
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
      version: undefined,
    },
  })
})

test('skill references display friendly titles while retaining invocation identity and path', () => {
  for (const display_name of ['Academic Search', '', undefined]) {
    const selected = skill({ display_name, version: '1.0.0' })
    assert.deepEqual(resolveTaskStarterSkill([selected], selected.name), {
      reference: {
        type: 'skill',
        id: selected.name,
        title: display_name || selected.name,
        path: selected.path,
        version: selected.version,
      },
    })
  }
})

test('all research starters preserve Windows absolute skill paths', () => {
  for (const starter of AI_TASK_STARTERS) {
    for (const root of [
      'C:\\Research Files\\skills',
      '\\\\?\\C:\\Research Files\\skills',
      '\\\\server\\share\\skills',
      '\\\\?\\UNC\\server\\share\\skills',
    ]) {
      const path = `${root}\\${starter.skillName}\\SKILL.md`
      const selected = skill({ name: starter.skillName, path, version: '1.0.0' })
      assert.deepEqual(resolveTaskStarterSkill([selected], starter.skillName), {
        reference: {
          type: 'skill',
          id: starter.skillName,
          title: starter.skillName,
          path,
          version: selected.version,
        },
      })
    }
  }
})

test('Windows skill paths do not bypass research starter availability checks', () => {
  for (const starter of AI_TASK_STARTERS) {
    for (const [restriction, failure] of [
      [{ enabled: false }, 'disabled'],
      [{ active: false }, 'disabled'],
      [{ dependency_status: 'missing' }, 'dependencies'],
      [
        { requires_login: true, active: false, unavailable_reason: 'login_required' },
        'login_required',
      ],
    ] as const) {
      const selected = skill({
        name: starter.skillName,
        path: '\\\\?\\C:\\skills\\SKILL.md',
        ...restriction,
      })
      assert.deepEqual(resolveTaskStarterSkill([selected], starter.skillName), { failure })
    }
  }
})

test('every research starter is login-gated by the product catalog', () => {
  const catalog = JSON.parse(
    readFileSync(
      new URL('../../../../../../serve/service/capabilities/catalog.json', import.meta.url),
      'utf8'
    )
  )
  for (const starter of AI_TASK_STARTERS) {
    assert.ok(catalog.requires_login.includes(starter.skillName), starter.skillName)
    const restricted = skill({
      name: starter.skillName,
      requires_login: true,
      active: false,
      unavailable_reason: 'login_required',
    })
    assert.deepEqual(resolveTaskStarterSkill([restricted], starter.skillName), {
      failure: 'login_required',
    })
  }
})

test('task starter skill failures stay explicit', () => {
  assert.deepEqual(
    resolveTaskStarterSkill(
      [skill({ requires_login: true, active: false, unavailable_reason: 'login_required' })],
      'precise-literature-search'
    ),
    { failure: 'login_required' }
  )
  assert.deepEqual(resolveTaskStarterSkill([], 'precise-literature-search'), {
    failure: 'missing',
  })
  assert.deepEqual(
    resolveTaskStarterSkill([skill({ active: false })], 'precise-literature-search'),
    { failure: 'disabled' }
  )
  assert.deepEqual(
    resolveTaskStarterSkill([skill({ dependency_status: 'missing' })], 'precise-literature-search'),
    { failure: 'dependencies' }
  )
  assert.deepEqual(
    resolveTaskStarterSkill([skill({ path: 'relative/SKILL.md' })], 'precise-literature-search'),
    { failure: 'path' }
  )
})

test('task starter interaction shares the composer width and hands focus to the composer', () => {
  const panel = readFileSync(new URL('./AiPanel.tsx', import.meta.url), 'utf8')

  assert.match(panel, /setTaskStarterPending\(starter\.skillName\)/)
  assert.match(panel, /loading=\{taskStarterPending === starter\.skillName\}/)
  assert.match(panel, /aria-busy=\{taskStarterPending === starter\.skillName\}/)
  assert.match(panel, /data-testid=\{`ai-task-starter-\$\{starter\.taskType\}`\}/)
  assert.ok(
    panel.indexOf('focusComposer({ selectionStart: 0, selectionEnd: 0 })') >
      panel.indexOf('act.askAiFromPanel(')
  )
  assert.match(
    panel,
    /floatingContent \? '[^']*' : embedded \? '!w-\[calc\(100%-2\*\(var\(--vds-conversation-inline-gutter\)\+var\(--vds-conversation-scrollbar-width\)\)\)\] min-h-full max-w-\[var\(--vds-conversation-content-width\)\][^']*'/
  )
  assert.doesNotMatch(panel, /max-w-\[var\(--vds-project-(?:welcome|starters)-width\)\]/)
  assert.ok(
    panel.includes(
      'vds-ai-stream-empty mx-auto w-[calc(100%-2*(var(--vds-conversation-inline-gutter)+var(--vds-conversation-scrollbar-width)))]'
    )
  )
})
