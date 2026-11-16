import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import ts from 'typescript'
import zh from '../../localization/locales/zh/conversation.json' with { type: 'json' }
import en from '../../localization/locales/en/conversation.json' with { type: 'json' }
import type { ProductEvent } from './api.ts'
import type { ConvItem } from './model.ts'
import * as transcript from './transcript.ts'

type PreviewEvent = Extract<ProductEvent, { type: 'generation_preview' }>

function event(data: Record<string, unknown> = {}, revision = 1): PreviewEvent {
  return {
    v: 2,
    seq: revision,
    ts: revision,
    type: 'generation_preview',
    session_id: 'session',
    turn_id: 'parent',
    item_id: 'generation',
    data: {
      preview_id: 'generation',
      revision,
      status: 'streaming',
      verified: false,
      blocks: [{ id: '$.body[0]', kind: 'paragraph', text: 'First paragraph' }],
      ...data,
    },
  } as PreviewEvent
}

function project(items: ConvItem[], update: PreviewEvent): ConvItem[] {
  const helper = (transcript as unknown as Record<string, unknown>).projectGenerationPreview
  assert.equal(typeof helper, 'function', 'The live and replay preview projector is exported')
  return (helper as (items: ConvItem[], update: PreviewEvent) => ConvItem[])(items, update)
}

test('malformed preview snapshots leave the existing transcript unchanged', () => {
  const initial: ConvItem[] = [{ kind: 'user', text: 'Read this paper', turnId: 'parent' }]
  const malformed = [
    { verified: true },
    { revision: 0 },
    { revision: 1.5 },
    { preview_id: '' },
    { status: 'accepted' },
    { blocks: null },
    { blocks: [{ id: 'a', kind: 'reasoning', text: 'Private reasoning' }] },
    { blocks: [{ id: 'a', kind: 'paragraph', text: { source_ids: ['A004'] } }] },
  ]
  for (const data of malformed) {
    assert.deepEqual(project(initial, event(data)), initial, JSON.stringify(data))
  }
})

test('duplicate block identities cannot create ambiguous or duplicated preview prose', () => {
  const before = project([], event())
  const duplicate = event(
    {
      blocks: [
        { id: 'same', kind: 'heading1', text: 'Title' },
        { id: 'same', kind: 'paragraph', text: 'Duplicate paragraph' },
      ],
    },
    2
  )
  assert.deepEqual(project(before, duplicate), before)
})

test('a newer complete snapshot replaces removed blocks and never mutates older state', () => {
  const first = project(
    [],
    event({
      blocks: [
        { id: 'title', kind: 'heading1', text: 'Title' },
        { id: 'body', kind: 'paragraph', text: 'Partial sentence' },
      ],
    })
  )
  const original = JSON.stringify(first)
  const replacement = event(
    { blocks: [{ id: 'body', kind: 'paragraph', text: 'Replacement paragraph' }] },
    2
  )
  const next = project(first, replacement)
  assert.equal(JSON.stringify(first), original)
  assert.equal(next.length, 1)
  const preview = next[0] as unknown as { preview: { blocks: { id: string; text: string }[] } }
  assert.deepEqual(preview.preview.blocks, [
    { id: 'body', kind: 'paragraph', text: 'Replacement paragraph' },
  ])
  assert.equal(
    next.some((item) => item.kind === 'agent' || item.kind === 'artifact'),
    false
  )
  assert.deepEqual(project(next, replacement), next)
})

test('all preview terminal states retain the visible draft and refuse late streaming', () => {
  for (const status of ['generated', 'unavailable', 'failed', 'cancelled', 'timeout']) {
    const streaming = project([], event())
    const terminal = project(streaming, event({ status }, 2))
    const snapshot = terminal[0] as unknown as {
      preview: { status: string; verified: boolean; blocks: { text: string }[] }
    }
    assert.equal(snapshot.preview.status, status)
    assert.equal(snapshot.preview.verified, false)
    assert.equal(snapshot.preview.blocks[0].text, 'First paragraph')
    assert.deepEqual(project(terminal, event({}, 3)), terminal)
  }
})

test('replayed parent interruption settles its preview without disturbing another turn', () => {
  const own = event()
  const other = {
    ...event(),
    turn_id: 'other',
    item_id: 'other-generation',
    data: {
      ...event().data,
      preview_id: 'other-generation',
    },
  } as PreviewEvent
  const interrupted = {
    v: 2,
    seq: 3,
    ts: 3,
    session_id: 'session',
    turn_id: 'parent',
    type: 'turn_interrupted',
    data: {},
  } as ProductEvent
  const recovered = transcript.projectActivityEvents([], [own, other, interrupted])
  const previews = recovered.filter((item) => item.kind === 'generation_preview') as unknown as {
    turnId: string
    preview: { status: string }
  }[]
  assert.equal(previews.find((item) => item.turnId === 'parent')?.preview.status, 'cancelled')
  assert.equal(previews.find((item) => item.turnId === 'other')?.preview.status, 'streaming')
  assert.deepEqual(transcript.projectActivityEvents(recovered, [event({}, 4)]), recovered)
  assert.deepEqual(
    transcript.projectActivityEvents(recovered, [own, other, interrupted]),
    recovered
  )
})

function renderPreview(item: ConvItem, conversation: (key: string) => string): string {
  const source = readFileSync(new URL('./components/business/Stream.tsx', import.meta.url), 'utf8')
  const syntax = ts.createSourceFile(
    'Stream.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  let branch: ts.CaseClause | undefined
  let statusKeys: ts.VariableDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isCaseClause(node) &&
      ts.isStringLiteral(node.expression) &&
      node.expression.text === 'generation_preview'
    ) {
      branch = node
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'GENERATION_PREVIEW_STATUS_KEYS'
    ) {
      statusKeys = node
    }
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  assert.ok(branch, 'Stream has a preview rendering branch')
  assert.ok(statusKeys, 'Stream maps preview lifecycle statuses to localized messages')
  const script = ts.transpileModule(
    `const ${statusKeys.getText(syntax)}; (() => { ${branch.statements.map((statement) => statement.getText(syntax)).join('\n')} return null })()`,
    { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }
  ).outputText
  const element = runInNewContext(script, {
    React,
    item,
    conversation,
    Tag: ({ children }: { children: React.ReactNode }) => React.createElement('span', {}, children),
    Markdown: ({ text }: { text: string }) =>
      React.createElement('div', { 'data-prose': true }, text),
  })
  return renderToStaticMarkup(element)
}

test('the preview surface renders only prose with unverified lifecycle labels in both languages', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    resources: { zh: { conversation: zh }, en: { conversation: en } },
    interpolation: { escapeValue: false },
  })
  for (const language of ['zh', 'en']) {
    await locale.changeLanguage(language)
    const messages = language === 'zh' ? zh.generationPreview : en.generationPreview
    for (const status of [
      'streaming',
      'generated',
      'unavailable',
      'failed',
      'cancelled',
      'timeout',
    ] as const) {
      const items = project(
        [],
        event({
          status,
          source_ids: ['PRIVATE-A004'],
          reasoning: 'PRIVATE-REASONING',
          blocks: [
            { id: 'title', kind: 'heading1', text: 'Public title' },
            { id: 'section', kind: 'heading2', text: 'Public heading' },
            { id: 'body', kind: 'paragraph', text: 'Public paragraph' },
          ],
        })
      )
      const html = renderPreview(items[0], locale.getFixedT(null, 'conversation'))
      assert.ok(html.includes('data-testid="generation-preview"'))
      assert.ok(html.includes(`data-preview-status="${status}"`))
      assert.ok(html.includes(messages[status]))
      assert.ok(html.includes(messages.unverified))
      assert.ok(html.includes('# Public title'))
      assert.ok(html.includes('## Public heading'))
      assert.ok(html.includes('Public paragraph'))
      assert.ok(!html.includes('PRIVATE-A004'))
      assert.ok(!html.includes('PRIVATE-REASONING'))
    }
  }
})

test('an empty preview displays a localized waiting message instead of an answer or saved artifact', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    resources: { zh: { conversation: zh }, en: { conversation: en } },
  })
  const items = project([], event({ blocks: [] }))
  for (const language of ['zh', 'en']) {
    await locale.changeLanguage(language)
    const html = renderPreview(items[0], locale.getFixedT(null, 'conversation'))
    const messages = language === 'zh' ? zh.generationPreview : en.generationPreview
    assert.ok(html.includes(messages.waiting))
    assert.ok(html.includes(messages.unverified))
    assert.ok(!html.includes('data-prose'))
  }
  assert.equal(
    items.some((item) => item.kind === 'agent' || item.kind === 'artifact'),
    false
  )
})
