import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import ts from 'typescript'
import { collectionNodes, flattenDestinations } from '../literature/hierarchy.ts'

const source = readFileSync(new URL('./Collections.tsx', import.meta.url), 'utf8')
const parsed = ts.createSourceFile(
  'Collections.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)
const implementation = parsed.statements
  .filter((statement) => !ts.isImportDeclaration(statement))
  .map((statement) => statement.getText(parsed))
  .join('\n')
  .replace(/export /g, '')

function render(collections: unknown, value = '', language = 'zh', failed = false) {
  const translations = createInstance()
  void translations.init({
    lng: language,
    initAsync: false,
    resources: {
      [language]: {
        translation: JSON.parse(
          readFileSync(
            new URL(`../../../../localization/locales/${language}/assistant.json`, import.meta.url),
            'utf8'
          )
        ),
      },
    },
  })
  let retried = false
  const component = runInNewContext(
    ts.transpile(`${implementation}\nLiteratureCollections`, {
      jsx: ts.JsxEmit.React,
      target: ts.ScriptTarget.ES2022,
    }),
    {
      React,
      collectionNodes,
      flattenDestinations,
      useTranslation: () => ({ t: translations.t.bind(translations) }),
      Button: 'button',
      Select: ({ children }: { children: React.ReactNode }) =>
        React.createElement('div', null, children),
      SelectContent: 'section',
      SelectGroup: 'section',
      SelectItem: 'option',
      SelectLabel: 'span',
      SelectTrigger: ({ children }: { children: React.ReactNode }) =>
        React.createElement('div', { role: 'combobox' }, children),
      SelectValue: ({ placeholder }: { placeholder: string }) => placeholder,
      Spinner: 'span',
    }
  )
  const element = component({
    collections,
    projectId: 'project',
    projectName: '研究项目',
    value,
    disabled: false,
    failed,
    onValueChange: () => undefined,
    onRetry: () => {
      retried = true
    },
  })
  const buttons: React.ReactElement<Record<string, unknown>>[] = []
  const options: string[] = []
  const visit = (node: React.ReactNode): void => {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return
      if (child.type === 'button')
        buttons.push(child as React.ReactElement<Record<string, unknown>>)
      if (child.type === 'option') options.push((child.props as { value: string }).value)
      visit(child.props.children)
    })
  }
  visit(element)
  return { html: renderToStaticMarkup(element), buttons, options, retried: () => retried }
}

test('collection dropdown preserves scoped IDs and full child paths', () => {
  const result = render(
    [
      { id: 'global', name: '同名', project_id: null },
      { id: 'parent', name: '父分类', project_id: 'project' },
      { id: 'child', name: '同名', parent_id: 'parent', project_id: 'project' },
      { id: 'foreign', name: '不应出现', project_id: 'other' },
    ],
    'child'
  )
  assert.match(result.html, /父分类 \/ 同名/)
  assert.match(result.html, /我的分类/)
  assert.match(result.html, /研究项目/)
  assert.match(result.html, /combobox/)
  assert.doesNotMatch(result.html, /不应出现|保存位置/)
  assert.deepEqual(result.options, ['', 'global', 'parent', 'child'])
})

for (const language of ['zh', 'en']) {
  test(`empty collections keep unfiled selectable without footer copy: ${language}`, () => {
    const result = render([], '', language)
    assert.deepEqual(result.options, [''])
    assert.doesNotMatch(result.html, /artifactEntry\.|save\./)
    assert.match(result.html, language === 'zh' ? /未整理/ : /Unorganized/)
    assert.doesNotMatch(result.html, /<section aria-label=/)
  })
}

test('each empty scope is hidden independently of the other scope', () => {
  const global = { id: 'global', name: '全局分类', project_id: null }
  const project = { id: 'local', name: '项目分类', project_id: 'project' }
  const globalOnly = render([global, { ...project, project_id: 'other' }])
  assert.match(globalOnly.html, /我的分类/)
  assert.doesNotMatch(globalOnly.html, /研究项目/)
  assert.deepEqual(globalOnly.options, ['', 'global'])
  const projectOnly = render([project])
  assert.match(projectOnly.html, /研究项目/)
  assert.doesNotMatch(projectOnly.html, /我的分类/)
  assert.deepEqual(projectOnly.options, ['', 'local'])
})

test('loading and failed collection queries cannot look like an empty list', () => {
  const loading = render(null)
  assert.equal(loading.buttons.length, 0)
  assert.match(loading.html, /正在加载分类/)
  const failed = render(null, '', 'zh', true)
  assert.equal(failed.buttons.length, 1)
  ;(failed.buttons[0].props.onClick as () => void)()
  assert.equal(failed.retried(), true)
})
