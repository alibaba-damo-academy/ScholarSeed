import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import type { AssistantSelectionActionInput } from '../../contracts/assistant.ts'
import { nextSelectionAttempt, selectionActionKey } from './selection.ts'

const INPUT: AssistantSelectionActionInput = {
  action: 'interpret',
  source_id: 'notes/evidence.md',
  source_revision: 'sha256:revision',
  selection: {
    locator: {
      kind: 'markdown',
      start: 4,
      end: 21,
      source_map_version: 'md-source-v1',
    },
    selected_text_hash: 'sha256:selected',
    preview_text: 'selected evidence',
  },
  question: '为什么？',
}

test('selection action identity is owned and reused by AssistantIngress', () => {
  const ids = ['action-1', 'attempt-1', 'attempt-2']
  const createId = (): string => ids.shift() ?? 'unexpected'
  const first = nextSelectionAttempt(null, false, createId)
  const replay = nextSelectionAttempt(first, false, createId)
  const retry = nextSelectionAttempt(first, true, createId)

  assert.deepEqual(first, {
    clientActionId: 'action-1',
    clientAttemptId: 'attempt-1',
  })
  assert.equal(replay, first)
  assert.deepEqual(retry, {
    clientActionId: 'action-1',
    clientAttemptId: 'attempt-2',
    retryOfAttemptId: 'attempt-1',
  })
})

test('selection action key changes with evidence, action policy or question', () => {
  const base = selectionActionKey(INPUT)
  assert.equal(selectionActionKey({ ...INPUT }), base)
  assert.notEqual(selectionActionKey({ ...INPUT, question: '如何验证？' }), base)
  assert.notEqual(selectionActionKey({ ...INPUT, action: 'translate' }), base)
  assert.notEqual(
    selectionActionKey({
      ...INPUT,
      selection: { ...INPUT.selection, selected_text_hash: 'sha256:changed' },
    }),
    base
  )
  assert.notEqual(
    selectionActionKey({
      ...INPUT,
      draft: {
        change_version: 2,
        selected_text: 'unsaved selection',
        context_text: 'unsaved context',
        selected_text_hash: 'sha256:draft',
      },
    }),
    base
  )
})

test('answer selection actions follow the horizontal design order with a copy divider', () => {
  const source = readFileSync(new URL('./Annotations.tsx', import.meta.url), 'utf8')
  const menu = source.slice(
    source.indexOf('<FloatingToolbar'),
    source.indexOf("label={a('remaining.selectionActions')}")
  )
  const labels = [
    ...menu.matchAll(/a\('remaining\.(addConversation|importAnswer|copyText)'\)/g),
  ].map((match) => match[1])
  assert.deepEqual(labels, ['addConversation', 'importAnswer', 'copyText'])
  assert.doesNotMatch(menu, /flex-col/)
  assert.match(menu, /<Divider\s+orientation="vertical"/)
  assert.doesNotMatch(menu, /w-\[190px\]/)
})

test('answer selection menu items share one style without a default fill', () => {
  const annotations = readFileSync(new URL('./Annotations.tsx', import.meta.url), 'utf8')
  const menu = annotations.slice(
    annotations.indexOf('remaining.selectionActions') - 2000,
    annotations.indexOf('remaining.selectionActions')
  )
  const items = menu.match(/<Button\b/g) ?? []
  // 每项必须用同一个常量, 否则其中一项带默认底色会看起来已选中。
  assert.equal(items.length, 3)
  assert.equal((menu.match(/className=\{SELECTION_ACTION_CLASS\}/g) ?? []).length, 3)
  // 默认态不能上底色; hover 态的 hover:!bg-[...] 是正常高亮。
  assert.doesNotMatch(SELECTION_ACTION_SOURCE(annotations), /(?<!hover:)!bg-\[/)
})

function SELECTION_ACTION_SOURCE(source: string): string {
  const line = source.split('\n').find((entry) => entry.startsWith('const SELECTION_ACTION_CLASS'))
  assert.ok(line, 'SELECTION_ACTION_CLASS 应当集中定义在文件头部')
  return line
}

test('inline annotation marker matches the asymmetric design bubble without a drawn tail', () => {
  const notes = readFileSync(new URL('./Notes.tsx', import.meta.url), 'utf8')
  const badge = notes.slice(
    notes.indexOf('const ANNOTATION_BADGE_CLASS'),
    notes.indexOf('function AnnotationCommentEditor')
  )
  assert.match(badge, /size-\[var\(--vds-badge-height-sm\)\]/)
  assert.match(badge, /rounded-\[var\(--vds-radius-8\)\]/)
  assert.match(badge, /rounded-bl-\[var\(--vds-radius-1\)\]/)
  assert.match(badge, /bg-\[var\(--vds-text-primary\)\]/)
  assert.match(badge, /text-\[length:var\(--vds-font-body-lv1\)\]/)
  assert.doesNotMatch(badge, /<svg|<circle|<path|translate-/)
})

test('pending annotation removal deletes annotations and their context together', () => {
  const panel = readFileSync(new URL('./AiPanel.tsx', import.meta.url), 'utf8')
  const summary = panel.slice(
    panel.indexOf('<AnnotationSummary'),
    panel.indexOf('testId="ai-context-ref"')
  )
  assert.match(summary, /act\.deleteAnswerAnnotation\(annotationId\)/)
  assert.match(summary, /onClear=\{removeGroup\}/)
  assert.match(
    panel,
    /if \(canDeleteAnnotation\) void act\.deleteAnswerAnnotations\(annotationIds\)/
  )
  assert.match(panel, /else void act\.detachAnswerAnnotations\(annotationIds\)/)
  assert.match(summary, /else void act\.detachAnswerAnnotation\(annotationId\)/)
  assert.doesNotMatch(summary, /act\.detachAiContext/)
})

test('pending annotations reuse the same tag format as other context references', () => {
  const panel = readFileSync(new URL('./AiPanel.tsx', import.meta.url), 'utf8')
  const notes = readFileSync(new URL('./Notes.tsx', import.meta.url), 'utf8')
  const skillRefs = readFileSync(
    new URL('../../components/business/SkillRefs.tsx', import.meta.url),
    'utf8'
  )

  // 引入标签统一走 ReferenceAttachment: 注释汇总与资料/文件/选区/技能同一格式,
  // 托盘内不允许再出现第二套色系(brand Tag)。
  assert.match(panel, /<ReferenceAttachment/)
  assert.match(notes, /export function AnnotationSummary[\s\S]*?<ReferenceAttachment/)
  assert.match(skillRefs, /<ReferenceAttachment/)
  assert.match(panel, /<AnnotationSummary[\s\S]*?testId="ai-context-ref"/)
  assert.doesNotMatch(notes, /tone="brand"/)
  assert.doesNotMatch(panel, /tone="brand"/)
})
