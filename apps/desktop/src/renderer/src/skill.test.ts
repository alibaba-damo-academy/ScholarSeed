import assert from 'node:assert/strict'
import test from 'node:test'

import {
  productSkillGroup,
  skillActivationControl,
  skillDocumentBody,
  skillIcon,
  skillDescription,
  skillCallable,
  SKILL_GROUPS,
  skillMutationMessage,
  SKILL_ICON_FALLBACK
} from './skill.ts'

test('callability separates local preference from current account and dependency availability', () => {
  const skill = { enabled: true, active: true, requires_login: true }
  assert.equal(skillCallable(skill, false), false)
  assert.equal(skillCallable(skill, true), true)
  assert.equal(skillCallable({ ...skill, enabled: false }, true), false)
  assert.equal(skillCallable({ ...skill, active: false }, true), false)
  assert.equal(skillCallable({ ...skill, dependency_status: 'missing' }, true), false)
  assert.equal(skillCallable({ ...skill, requires_login: false }, false), true)
  assert.equal(skill.enabled, true)
})

test('maps controlled Service skill icon tokens and falls back safely', () => {
  assert.equal(skillIcon('doc'), 'doc')
  assert.equal(skillIcon('search'), 'search')
  assert.equal(skillIcon('play'), 'play')
  assert.equal(skillIcon('untrusted-component-name'), SKILL_ICON_FALLBACK)
  assert.equal(skillIcon(undefined), SKILL_ICON_FALLBACK)
})

test('localizes product skill descriptions without changing their canonical names', () => {
  const skill = {
    name: 'literature-review',
    description: 'Produce a complete systematic literature review from a precise research intent.',
    descriptions: {
      zh: '根据明确研究意图，生成完整的系统性文献综述。'
    },
    blurb: 'Build and verify a complete research survey'
  }
  assert.equal(skillDescription(skill, 'zh-CN'), skill.descriptions.zh)
  assert.equal(skillDescription(skill, 'en-US'), skill.description)
  assert.equal(skillDescription({ blurb: 'fallback' }, 'fr-FR'), 'fallback')
  assert.equal(skill.name, 'literature-review')
})

test('keeps ScholarSeed skills enabled and locks only their activation control', () => {
  assert.deepEqual(
    skillActivationControl({ enabled: true, toggleable: false }),
    { checked: true, disabled: true }
  )
  assert.deepEqual(
    skillActivationControl({ enabled: true, toggleable: true }),
    { checked: true, disabled: false }
  )
  assert.deepEqual(
    skillActivationControl({ enabled: false, toggleable: true }),
    { checked: false, disabled: false }
  )
})

test('keeps the MVP skill catalog on the two product-owned groups', () => {
  assert.deepEqual(SKILL_GROUPS, [
    { id: 'scholarseed', labelKey: 'groups.scholarseed' },
    { id: 'user', labelKey: 'groups.user' }
  ])
  assert.equal(productSkillGroup('scholarseed'), 'scholarseed')
  assert.equal(productSkillGroup('user'), 'user')
  assert.equal(productSkillGroup('project'), null)
  assert.equal(productSkillGroup(undefined), null)
})

test('skill details render the body without treating YAML frontmatter as headings', () => {
  assert.equal(skillDocumentBody('---\nname: example\nversion: 1\n---\n\n# Example\nInstructions'), '# Example\nInstructions')
  assert.equal(skillDocumentBody('# Plain document'), '# Plain document')
  assert.equal(skillDocumentBody('---\nnot closed'), '---\nnot closed')
})


test('skill mutation errors use stable identities while preserving unknown diagnostics', () => {
  assert.deepEqual(skillMutationMessage('duplicate_name', '原始重名提示', 'upload.failed'), { key: 'errors.duplicate' })
  assert.deepEqual(skillMutationMessage('immutable_skill', '原始内置提示', 'deleteFailed'), { key: 'errors.immutable' })
  assert.deepEqual(skillMutationMessage('invalid_package', 'SKILL.md: malformed metadata', 'upload.failed'), { key: 'errors.invalid', detail: 'SKILL.md: malformed metadata' })
  for (const code of ['vendor_error', '__proto__', 'toString', undefined]) {
    assert.deepEqual(skillMutationMessage(code, '原始 diagnostic', 'upload.failed'), { key: 'upload.failed', detail: '原始 diagnostic' })
  }
  assert.deepEqual(skillMutationMessage(undefined, '', 'deleteFailed'), { key: 'deleteFailed' })
})
