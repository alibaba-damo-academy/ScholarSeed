import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PREVIEW_CATALOG } from './catalog.ts'
import { PDFE_ROLES, PDFE_ROLE_KNOWLEDGE, PDFE_TASK_SCOPES, pdfeFeatureTarget, pdfeGuidance, pdfePageMatches, pdfeTaskContext, type PdfeTranslate } from './collaboration.ts'
import { createLocalization } from '../src/localization/engine.ts'
import zh from './locales/zh.json' with { type: 'json' }
import en from './locales/en.json' with { type: 'json' }

test('every project center scenario has bilingual guidance from one resource source', () => {
  const home = PREVIEW_CATALOG.find(page => page.id === 'page-home')!
  const before = JSON.stringify(home)
  for (const language of ['zh', 'en'] as const) {
    const dictionary = language === 'zh' ? zh : en
    const translate = createLocalization(language, { zh: { preview: zh }, en: { preview: en } }).getFixedT(null, 'preview' as never) as unknown as PdfeTranslate
    for (const scene of home.scenarios) {
      assert.ok(scene.expectedKeys?.length, scene.id)
      assert.ok(scene.limitationKeys?.length, scene.id)
      assert.deepEqual(scene.expected, scene.expectedKeys.map(key => zh[key]))
      assert.deepEqual(scene.limitations, scene.limitationKeys.map(key => zh[key]))
      const guidance = pdfeGuidance(home, scene, translate)
      assert.deepEqual(guidance.entry, [dictionary.homeEntry])
      assert.deepEqual(guidance.expected, scene.expectedKeys.map(key => dictionary[key]))
      assert.deepEqual(guidance.limitations, scene.limitationKeys.map(key => dictionary[key]))
      if (language === 'en') assert.doesNotMatch([...guidance.entry, ...guidance.expected, ...guidance.limitations].join('\n'), /[\u3400-\u9fff]/u, scene.id)
    }
  }
  assert.equal(JSON.stringify(home), before)
})

test('guidance preserves unmodified catalog text for pages outside this milestone', () => {
  const page = PREVIEW_CATALOG.find(page => page.id === 'page-conversation')!
  const scene = page.scenarios[0]
  const guidance = pdfeGuidance(page, scene, () => { throw new Error('Unexpected translation of legacy guidance') })
  assert.deepEqual(guidance.entry, page.entryInstructions ?? [])
  assert.equal(guidance.expected, scene.expected)
  assert.equal(guidance.limitations, scene.limitations)
})

test('UI assets return navigation restores only a known available feature scene', () => {
  const target = { pageId: 'page-projects', sceneId: 'projects-browse' }
  assert.deepEqual(pdfeFeatureTarget(JSON.stringify(target)), target)
  const fallback = pdfeFeatureTarget(null)
  for (const value of ['{', 'null', '[]', '"foreign"', '{"pageId":"unknown","sceneId":"unknown"}', '{"pageId":"page-projects","sceneId":"foreign"}', '{"pageId":"development-components","sceneId":"components-states"}']) assert.deepEqual(pdfeFeatureTarget(value), fallback)
})

test('every declared Mock state has readable Chinese and English capability labels', () => {
  const states = (language: string): Record<string, string> => Object.fromEntries(Object.entries(JSON.parse(readFileSync(new URL('./locales/' + language + '.json', import.meta.url), 'utf8'))).filter(([key]) => key.startsWith('state_')).map(([key, value]) => [key.slice('state_'.length), value as string]))
  const zh = states('zh')
  const en = states('en')
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const page of PREVIEW_CATALOG) for (const scene of page.scenarios) for (const state of scene.states) {
    assert.ok(typeof zh[state] === 'string' && zh[state].trim(), scene.id + '/' + state)
    assert.ok(typeof en[state] === 'string' && en[state].trim(), scene.id + '/' + state)
  }
})

test('role knowledge points to real Owner sources without creating role-specific product targets or permissions', () => {
  const root = new URL('../../../', import.meta.url)
  const page = PREVIEW_CATALOG.find(entry => entry.id === 'page-conversation')!
  const scene = page.scenarios[0]
  const source = JSON.stringify(page)
  const contexts = PDFE_ROLES.map(role => pdfeTaskContext(role.id, 'presentation', ' 调整当前页面 ', page, scene))
  assert.deepEqual(PDFE_ROLES.map(role => role.id), ['product', 'design', 'frontend'])
  for (const context of contexts) {
    assert.equal(context.task, '调整当前页面')
    assert.equal(context.pageId, page.id)
    assert.equal(context.sceneId, scene.id)
    assert.equal(context.authorization, 'not-granted-by-context')
    assert.equal(context.sourceBaseline, 'capture-before-edit')
    assert.equal(context.requiresSemanticReview, true)
    assert.deepEqual(context.candidateFiles, [`apps/desktop/${page.source}`])
    assert.ok(context.knowledge.includes(PDFE_ROLE_KNOWLEDGE))
    for (const path of context.knowledge) assert.equal(existsSync(fileURLToPath(new URL(path, root))), true, path)
  }
  assert.equal(JSON.stringify(page), source)
  assert.notDeepEqual(contexts[0].knowledge, contexts[1].knowledge)
  assert.deepEqual(contexts[0].requiresScopeReview, contexts[2].requiresScopeReview)
})

test('task scope never promotes an alias or placeholder to a product page and keeps mock candidates distinct', () => {
  assert.deepEqual(PDFE_TASK_SCOPES.map(scope => scope.id), ['mock', 'presentation'])
  for (const page of PREVIEW_CATALOG.filter(entry => entry.implementation !== 'surface')) {
    const context = pdfeTaskContext('frontend', 'presentation', 'task', page, page.scenarios[0])
    assert.deepEqual(context.candidateFiles, [])
  }
  const page = PREVIEW_CATALOG[0]
  const context = pdfeTaskContext('product', 'mock', 'samples', page, page.scenarios[0])
  assert.deepEqual(context.candidateFiles, ['apps/desktop/preview/catalog.ts', 'apps/desktop/preview/fixtures/'])
  assert.ok(context.requiresScopeReview.includes('mock-engine'))
})

test('discovery searches stable page, scenario and state identities and respects categories', () => {
  const conversation = PREVIEW_CATALOG.find(page => page.id === 'page-conversation')!
  const components = PREVIEW_CATALOG.find(page => page.id === 'development-components')!
  assert.equal(pdfePageMatches(conversation, ' CONVERSATION-STREAM '), true)
  assert.equal(pdfePageMatches(conversation, 'streaming'), true)
  assert.equal(pdfePageMatches(conversation, '', 'settings'), false)
  assert.equal(pdfePageMatches(components, '组件', 'development'), true)
  assert.equal(pdfePageMatches(components, 'no-matching-pdfe-page-or-state'), false)
})
