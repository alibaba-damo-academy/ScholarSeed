import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conversationEntries, conversationSections } from './navigation.ts'

test('conversation directory merges permission and literature confirmation into one entry', () => {
  assert.deepEqual(
    conversationSections.map((section) => section.id),
    ['input', 'dialogue', 'charts', 'workbench', 'a2ui']
  )
  assert.deepEqual(
    conversationEntries.map((entry) => entry.id),
    [
      'prototype-overview',
      'conversation-messages',
      'conversation-context',
      'conversation-artifacts',
      'conversation-citations',
      'conversation-body',
      'conversation-confirmation',
      'conversation-clarify',
      'conversation-processing',
      'conversation-chart',
      'conversation-results',
      'conversation-review',
      'conversation-canvas',
      'conversation-openui',
    ]
  )
  assert.deepEqual(
    conversationEntries.slice(1).map((entry) => entry.number),
    ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13']
  )
})

test('A2UI follows workbench with the existing Canvas and OpenUI directory', () => {
  const a2ui = conversationSections.find((section) => section.id === 'a2ui')
  assert.deepEqual(a2ui?.items, [
    {
      id: 'conversation-canvas',
      labelKey: 'a2uiPreview.canvas',
      number: '12',
      status: 'available',
      preview: 'Canvas',
    },
    {
      id: 'conversation-openui',
      labelKey: 'a2uiPreview.components',
      number: '13',
      status: 'available',
      directory: 'openui',
    },
  ])
})

test('workbench follows charts and reuses the Results and Review previews', () => {
  const workbench = conversationSections.find((section) => section.id === 'workbench')
  assert.deepEqual(
    workbench?.items.map((item) => ({ id: item.id, preview: item.preview })),
    [
      { id: 'conversation-results', preview: 'Results' },
      { id: 'conversation-review', preview: 'Review' },
    ]
  )
})

test('charts is a separate category reusing the official Plot preview', () => {
  const charts = conversationSections.find((section) => section.id === 'charts')
  assert.deepEqual(charts?.items, [
    {
      id: 'conversation-chart',
      labelKey: 'chartPreview.general',
      number: '09',
      status: 'available',
      preview: 'Plot',
    },
  ])
})

test('dialogue components keep artifacts, citations, body, confirmation and clarification in order', () => {
  assert.deepEqual(
    conversationSections[1].items.map(({ id, number }) => ({ id, number })),
    [
      { id: 'conversation-artifacts', number: '03' },
      { id: 'conversation-citations', number: '04' },
      { id: 'conversation-body', number: '05' },
      { id: 'conversation-confirmation', number: '06' },
      { id: 'conversation-clarify', number: '07' },
      { id: 'conversation-processing', number: '08' },
    ]
  )
})

test('user input groups attachments under reference context', () => {
  assert.deepEqual(
    conversationSections[0].items.map((entry) => entry.id),
    ['conversation-messages', 'conversation-context']
  )
})
