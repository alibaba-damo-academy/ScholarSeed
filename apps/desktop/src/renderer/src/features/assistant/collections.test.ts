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
  const selected: string[] = []
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
      ScrollArea: ({ children }: { children: React.ReactNode }) =>
        React.createElement('section', null, children),
      EllipsisText: ({ children }: { children: React.ReactNode }) =>
        React.createElement('span', null, children),
      Spinner: 'span',
      Folder: () => null,
      Check: () => null,
      Inbox: () => null,
    }
  )
  const element = component({
    collections,
    projectId: 'project',
    projectName: '研究项目',
    value,
    disabled: false,
    failed,
    onValueChange: (next: string) => selected.push(next),
    onRetry: () => {
      retried = true
    },
  })
  const buttons: React.ReactElement<Record<string, unknown>>[] = []
  const visit = (node: React.ReactNode): void => {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return
      if (child.type === 'button')
        buttons.push(child as React.ReactElement<Record<string, unknown>>)
      visit(child.props.children)
    })
  }
  visit(element)
  return { html: renderToStaticMarkup(element), buttons, selected, retried: () => retried }
}

test('collection list preserves scoped IDs and full child paths without a dropdown', () => {
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
  assert.match(result.html, /研究项目/)
  assert.doesNotMatch(result.html, /combobox|不应出现/)
  assert.equal(result.buttons.length, 4)
  for (const button of result.buttons) (button.props.onClick as () => void)()
  assert.deepEqual(result.selected, ['', 'global', 'parent', 'child'])
  assert.equal(result.buttons[3].props['aria-pressed'], true)
  assert.equal(result.buttons[1].props['aria-pressed'], false)
})

for (const language of ['zh', 'en']) {
  test(`empty collections keep unfiled selectable and explain the scope: ${language}`, () => {
    const result = render([], '', language)
    assert.equal(result.buttons.length, 1)
    assert.equal(result.buttons[0].props['aria-pressed'], true)
    assert.doesNotMatch(result.html, /artifactEntry\.|save\./)
    assert.match(result.html, language === 'zh' ? /暂无分类/ : /No collections/)
  })
}

test('loading and failed collection queries cannot look like an empty list', () => {
  const loading = render(null)
  assert.equal(loading.buttons.length, 0)
  assert.match(loading.html, /正在加载分类/)
  const failed = render(null, '', 'zh', true)
  assert.equal(failed.buttons.length, 1)
  ;(failed.buttons[0].props.onClick as () => void)()
  assert.equal(failed.retried(), true)
})
