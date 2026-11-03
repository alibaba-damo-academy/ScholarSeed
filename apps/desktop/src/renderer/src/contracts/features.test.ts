import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import type { TFunction } from 'i18next'

import {
  composeFeatures,
  taskDetailText,
  taskErrorContent,
  taskErrorText,
  type DocumentPanelContext,
  type TaskSourceContribution
} from './features.ts'

const source = (id: string): TaskSourceContribution => ({
  id,
  list: async () => [],
  cancel: async () => { throw new Error('unused') },
  retry: async () => { throw new Error('unused') },
  present: () => ({ title: '', detail: '', announcement: '', error: '', failures: [] })
})

test('public component slots retain their host implementation and reject duplicate owners', () => {
  const question = { slot: 'interaction.question', render: () => null }
  const references = { slot: 'display.literature-references', render: () => null }
  const registry = composeFeatures([
    { id: 'questions', publicComponents: [question] },
    { id: 'literature', publicComponents: [references] }
  ])
  assert.equal(registry.publicComponents.get(question.slot), question)
  assert.equal(registry.publicComponents.get(references.slot), references)
  assert.throws(() => composeFeatures([
    { id: 'questions', publicComponents: [question] },
    { id: 'override', publicComponents: [{ ...question }] }
  ]), /Duplicate public component: interaction.question/)
  assert.equal(registry.publicComponents.get(question.slot), question)
})

test('task source contributions aggregate without shell domain branches', () => {
  const first = source('imports')
  const duplicate = source('imports')
  const other = source('exports')
  const warnings: unknown[][] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args)
  try {
    const registry = composeFeatures([
      { id: 'resources', taskSources: [first] },
      { id: 'duplicate', taskSources: [duplicate] },
      { id: 'exports', taskSources: [other] }
    ])
    assert.deepEqual(registry.taskSources, [first, other])
    assert.equal(warnings.length, 1)
  } finally {
    console.warn = original
  }
})

test('interaction policies aggregate by identity without changing unrelated features', () => {
  const first = {
    id: 'review-output', title: 'Review output', matches: () => true,
    complete: () => true, defaults: () => ({}), defaultLabel: 'Default'
  }
  const duplicate = { ...first }
  const warnings: unknown[][] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args)
  try {
    const registry = composeFeatures([
      { id: 'literature', interactionPolicies: [first] },
      { id: 'duplicate', interactionPolicies: [duplicate] },
      { id: 'unrelated' }
    ])
    assert.deepEqual(registry.interactionPolicies, [first])
    assert.equal(warnings.length, 1)
  } finally {
    console.warn = original
  }
})

test('document panels aggregate by identity and keep their business matcher', () => {
  const context = {
    path: 'paper.pdf',
    viewer: 'pdf' as const,
    sourceKind: 'literature',
    recordTarget: {
      owner: 'literature_attachment' as const,
      scope_id: 'paper-1',
      subject_id: 'attachment-1'
    },
    documentSessionId: 'document-1',
    tabId: 'tab-1'
  }
  const first = {
    id: 'literature-notes',
    label: () => 'Notes',
    title: 'Notes',
    matches: (_context: DocumentPanelContext) => true,
    render: () => null
  }
  const warnings: unknown[][] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args)
  try {
    const registry = composeFeatures([
      { id: 'literature', documentPanels: [first] },
      { id: 'duplicate', documentPanels: [{ ...first }] }
    ])

    assert.deepEqual(registry.documentPanels, [first])
    assert.equal(registry.documentPanels[0]?.matches(context), true)
    assert.equal(warnings.length, 1)
  } finally {
    console.warn = original
  }
})

test('global surfaces aggregate by identity for removable product-level features', () => {
  const first = { id: 'feedback-recorder', render: () => null }
  const warnings: unknown[][] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args)
  try {
    const registry = composeFeatures([
      { id: 'feedback', globalSurfaces: [first] },
      { id: 'duplicate', globalSurfaces: [{ ...first }] },
      { id: 'unrelated' }
    ])
    assert.deepEqual(registry.globalSurfaces, [first])
    assert.equal(warnings.length, 1)
  } finally {
    console.warn = original
  }
})

test('task error presentation follows the registered owner and preserves deferred elements', () => {
  const seen: string[] = []
  const raw = 'vendor_failure: 原始诊断 /tmp/资料'
  const element = createElement('span', null, raw)
  const renderer = { ...source('custom-owner'), renderError: (error: string) => { seen.push(error); return element } }
  const sources = [renderer, source('raw-owner')]
  const task = { sourceId: 'custom-owner', error: raw }
  assert.equal(taskErrorContent(task, sources), element)
  assert.deepEqual(seen, [raw])
  assert.deepEqual(task, { sourceId: 'custom-owner', error: raw })
  assert.equal(taskErrorContent({ sourceId: 'raw-owner', error: raw }, sources), raw)
  assert.equal(taskErrorContent({ sourceId: 'unknown-owner', error: raw }, sources), raw)
  assert.equal(taskErrorContent({ sourceId: 'custom-owner', error: '' }, sources), null)
  assert.deepEqual(seen, [raw])
})

test('task center text follows the source-owned presentation contract', () => {
  const raw = 'disk_full'
  const translated = '磁盘空间不足，请清理空间后重试。'
  const renderer = {
    ...source('resource-imports'),
    present: () => ({ title: '', detail: '', announcement: '', error: translated, failures: [] })
  }
  const task = { sourceId: 'resource-imports', error: raw } as Parameters<typeof taskErrorText>[0]
  const t = ((key: string) => key) as TFunction<'tasks'>

  assert.equal(taskErrorText(task, [renderer], t), translated)
  assert.equal(taskErrorText({ ...task, sourceId: 'unknown' }, [renderer], t), raw)
})

test('task center detail follows the source-owned presentation contract', () => {
  const translated = '接入方式：复制到项目；已导入 1 项，未导入 0 项'
  const renderer = {
    ...source('resource-imports'),
    present: () => ({ title: '', detail: translated, announcement: '', error: '', failures: [] })
  }
  const task = {
    sourceId: 'resource-imports',
    detail: 'stale generic detail'
  } as Parameters<typeof taskDetailText>[0]
  const t = ((key: string) => key) as TFunction<'tasks'>

  assert.equal(taskDetailText(task, [renderer], t), translated)
  assert.equal(
    taskDetailText({ ...task, sourceId: 'unknown' }, [renderer], t),
    'stale generic detail'
  )
})
