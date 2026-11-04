import assert from 'node:assert/strict'
import test from 'node:test'
import { createLocalization } from '../../localization/engine.ts'
import chineseSkills from '../../localization/locales/zh/skills.json' with { type: 'json' }
import englishSkills from '../../localization/locales/en/skills.json' with { type: 'json' }
import type { SkillInfo } from './api'

import {
  productSkillGroup,
  resolveTaskStarterSkill,
  skillActivationControl,
  skillDocumentBody,
  skillIcon,
  skillDescription,
  skillCategory,
  skillName,
  skillCallable,
  SKILL_GROUPS,
  skillMutationMessage,
  SKILL_ICON_FALLBACK,
  skillUseFailureMessage,
  type TaskStarterSkillFailure,
} from './skill.ts'

test('library task references preserve Windows paths without bypassing availability gates', () => {
  for (const path of [
    'C:\\科研资料\\agentic-search\\SKILL.md',
    '\\\\?\\C:\\科研资料\\agentic-search\\SKILL.md',
    '\\\\server\\share\\agentic-search\\SKILL.md',
    '\\\\?\\UNC\\server\\share\\agentic-search\\SKILL.md',
  ]) {
    const selected: SkillInfo = {
      name: 'agentic-search',
      display_name: '分档学术检索',
      enabled: true,
      active: true,
      group: 'scholarseed',
      removable: false,
      toggleable: false,
      requires_login: true,
      dependency_status: 'ready',
      path,
      version: '1.0.0',
    }
    assert.deepEqual(resolveTaskStarterSkill([selected], selected.name), {
      reference: {
        type: 'skill',
        id: selected.name,
        title: selected.display_name,
        path,
        version: selected.version,
      },
    })
    for (const overrides of [{ enabled: false }, { active: false }]) {
      assert.deepEqual(resolveTaskStarterSkill([{ ...selected, ...overrides }], selected.name), {
        failure: 'disabled',
      })
    }
    assert.deepEqual(
      resolveTaskStarterSkill(
        [{ ...selected, unavailable_reason: 'login_required' }],
        selected.name
      ),
      { failure: 'login_required' }
    )
    assert.deepEqual(
      resolveTaskStarterSkill([{ ...selected, dependency_status: 'missing' }], selected.name),
      { failure: 'dependencies' }
    )
  }
})

test('skill use failures have distinct localized guidance with the selected skill name', () => {
  const localization = createLocalization(
    'zh',
    {
      zh: { skills: chineseSkills },
      en: { skills: englishSkills },
    },
    { report() {} }
  )
  const failures: TaskStarterSkillFailure[] = [
    'login_required',
    'missing',
    'disabled',
    'dependencies',
    'path',
  ]
  for (const language of ['zh', 'en'] as const) {
    const translate = localization.getFixedT(language, 'skills')
    const messages = failures.map((failure) =>
      skillUseFailureMessage(translate, failure, '学术检索')
    )
    assert.equal(new Set(messages).size, failures.length)
    for (const message of messages) {
      assert.ok(message.includes('学术检索'))
      assert.ok(!message.includes('try.failures.'))
    }
  }
  assert.equal(
    skillUseFailureMessage(localization.getFixedT('zh', 'skills'), 'missing', '学术检索'),
    '未找到技能“学术检索”。请刷新技能库，确认该技能仍已安装。'
  )
  assert.equal(
    skillUseFailureMessage(localization.getFixedT('en', 'skills'), 'missing', '学术检索'),
    'Skill “学术检索” was not found. Refresh the skill library and confirm that it is still installed.'
  )
})

test('skill labels prefer display names and fall back without changing identity', () => {
  const skill = { name: 'agentic-search', display_name: 'Tiered Academic Search' }
  assert.equal(skillName(skill), 'Tiered Academic Search')
  assert.equal(skillName({ ...skill, display_name: '' }), 'agentic-search')
  assert.equal(skillName({ name: skill.name }), 'agentic-search')
  assert.equal(skill.name, 'agentic-search')
})

test('skill categories translate only explicit defaults and preserve same-name custom content', async () => {
  const localization = createLocalization(
    'en',
    {
      zh: { skills: chineseSkills },
      en: { skills: englishSkills },
    },
    { report() {} }
  )
  const defaults = [
    { category: '系统预置', category_source: 'builtin' as const },
    { category: '用户安装', category_source: 'user' as const },
  ]
  const original = structuredClone(defaults)
  for (const language of ['en', 'zh', 'en'] as const) {
    await localization.changeLanguage(language)
    const translate = localization.getFixedT(null, 'skills')
    assert.deepEqual(
      defaults.map((skill) => skillCategory(skill, translate)),
      language === 'en' ? ['System preset', 'User installed'] : ['系统预置', '用户安装']
    )
    for (const category of ['系统预置', '用户安装', 'Research', '']) {
      assert.equal(skillCategory({ category }, translate), category)
      assert.equal(skillCategory({ category, category_source: null }, translate), category)
      assert.equal(skillCategory({ category, category_source: 'unknown' }, translate), category)
    }
    assert.equal(skillCategory({}, translate), '')
    assert.deepEqual(defaults, original)
  }
})

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
      zh: '根据明确研究意图，生成完整的系统性文献综述。',
    },
    blurb: 'Build and verify a complete research survey',
  }
  assert.equal(skillDescription(skill, 'zh-CN'), skill.descriptions.zh)
  assert.equal(skillDescription(skill, 'en-US'), skill.description)
  assert.equal(skillDescription({ blurb: 'fallback' }, 'fr-FR'), 'fallback')
  assert.equal(skill.name, 'literature-review')
})

test('keeps ScholarSeed skills enabled and locks only their activation control', () => {
  assert.deepEqual(skillActivationControl({ enabled: true, toggleable: false }), {
    checked: true,
    disabled: true,
  })
  assert.deepEqual(skillActivationControl({ enabled: true, toggleable: true }), {
    checked: true,
    disabled: false,
  })
  assert.deepEqual(skillActivationControl({ enabled: false, toggleable: true }), {
    checked: false,
    disabled: false,
  })
})

test('keeps the MVP skill catalog on the two product-owned groups', () => {
  assert.deepEqual(SKILL_GROUPS, [
    { id: 'scholarseed', labelKey: 'groups.scholarseed' },
    { id: 'user', labelKey: 'groups.user' },
  ])
  assert.equal(productSkillGroup('scholarseed'), 'scholarseed')
  assert.equal(productSkillGroup('user'), 'user')
  assert.equal(productSkillGroup('project'), null)
  assert.equal(productSkillGroup(undefined), null)
})

test('skill details render the body without treating YAML frontmatter as headings', () => {
  assert.equal(
    skillDocumentBody('---\nname: example\nversion: 1\n---\n\n# Example\nInstructions'),
    '# Example\nInstructions'
  )
  assert.equal(skillDocumentBody('# Plain document'), '# Plain document')
  assert.equal(skillDocumentBody('---\nnot closed'), '---\nnot closed')
})

test('skill mutation errors use stable identities while preserving unknown diagnostics', () => {
  assert.deepEqual(skillMutationMessage('duplicate_name', '原始重名提示', 'upload.failed'), {
    key: 'errors.duplicate',
  })
  assert.deepEqual(skillMutationMessage('immutable_skill', '原始内置提示', 'deleteFailed'), {
    key: 'errors.immutable',
  })
  assert.deepEqual(
    skillMutationMessage('invalid_package', 'SKILL.md: malformed metadata', 'upload.failed'),
    { key: 'errors.invalid', detail: 'SKILL.md: malformed metadata' }
  )
  for (const code of ['vendor_error', '__proto__', 'toString', undefined]) {
    assert.deepEqual(skillMutationMessage(code, '原始 diagnostic', 'upload.failed'), {
      key: 'upload.failed',
      detail: '原始 diagnostic',
    })
  }
  assert.deepEqual(skillMutationMessage(undefined, '', 'deleteFailed'), { key: 'deleteFailed' })
})
