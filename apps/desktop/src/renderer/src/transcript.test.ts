import assert from 'node:assert/strict'
import test from 'node:test'

import type { ConvItem } from './model.ts'
import type { ProductEvent } from './api.ts'
import type { AssistantContextRef } from './contracts/assistant.ts'
import {
  appendOptimisticUserMessage,
  bindSubmittedTurn,
  latestDisplayCardItems,
  projectActivityEvents,
  projectAnswerSources,
  projectArtifactSnapshot,
  projectArtifactFailure,
  projectHistory,
  projectHistorySnapshot,
  projectHistoryWithRuntime,
  projectDisplayCardEvent,
  projectReviewReadyEvent,
  projectNativeActivityEvent,
  projectPaperSearchEvent,
  projectSkillActivityEvent,
  projectSubagentActivity,
  placeFinalAssistantLast,
  projectAssistantContextRefs,
  projectStreamDelta,
  projectWebSearchEvent,
  removeOptimisticUserMessage,
  streamItemIdentity,
  upsertUserMessageEvent,
  upsertConversationArtifact
} from './transcript.ts'

test('binds verified answer sources to the matching agent item only', () => {
  const items: ConvItem[] = [
    { kind: 'agent', text: 'earlier', turnId: 'turn-1', itemId: 'answer-1' },
    { kind: 'agent', text: 'final', turnId: 'turn-1', itemId: 'answer-2' }
  ]
  const projected = projectAnswerSources(items, {
    v: 2,
    seq: 3,
    ts: 1,
    type: 'answer_sources',
    session_id: 'session-1',
    turn_id: 'turn-1',
    item_id: 'answer-2',
    data: {
      answer_revision: 'sha256:answer',
      sources: [{
        number: 1,
        kind: 'searched',
        url: 'https://example.test/source',
        title: 'Source',
        search_kind: 'web',
        search_id: 'search-1',
        citation_urls: ['https://example.test/source']
      }]
    }
  })
  assert.equal(projected[0].kind === 'agent' ? projected[0].answerSources : undefined, undefined)
  assert.equal(projected[1].kind === 'agent' ? projected[1].answerSources?.[0]?.number : 0, 1)
})

test('rebinds answer sources through the durable assistant anchor after item ids drift', () => {
  const sources = [{
    number: 1,
    kind: 'searched' as const,
    url: 'https://example.test/source',
    title: 'Source',
    search_kind: 'web' as const,
    search_id: 'search-1',
    citation_urls: ['https://example.test/source']
  }]
  const projected = projectActivityEvents(
    [{ kind: 'agent', text: 'answer', turnId: 'turn-1', itemId: 'resume-item' }],
    [{
      v: 2, seq: 2, ts: 1, type: 'message_delta', session_id: 'session-1',
      turn_id: 'turn-1', item_id: 'event-item',
      data: { delta: 'answer', phase: 'final_answer' }
    }, {
      v: 2, seq: 3, ts: 2, type: 'answer_sources', session_id: 'session-1',
      turn_id: 'turn-1', item_id: 'event-item',
      data: { answer_revision: 'sha256:answer', sources }
    }]
  )

  assert.equal(projected.length, 1)
  assert.equal(projected[0].itemId, 'event-item')
  assert.equal(projected[0].kind === 'agent' ? projected[0].answerSources?.length : 0, 1)
})

test('binds an unaddressed answer source event only to the final agent item in its turn', () => {
  const items: ConvItem[] = [
    { kind: 'agent', text: 'earlier', turnId: 'turn-1' },
    { kind: 'agent', text: 'final', turnId: 'turn-1' }
  ]
  const projected = projectAnswerSources(items, {
    v: 2,
    seq: 3,
    ts: 1,
    type: 'answer_sources',
    session_id: 'session-1',
    turn_id: 'turn-1',
    data: {
      answer_revision: 'sha256:answer',
      sources: [{
        number: 1,
        kind: 'searched',
        url: 'https://example.test/source',
        title: 'Source',
        search_kind: 'web',
        search_id: 'search-1',
        citation_urls: ['https://example.test/source']
      }]
    }
  })

  assert.equal(projected[0].kind === 'agent' ? projected[0].answerSources : undefined, undefined)
  assert.equal(projected[1].kind === 'agent' ? projected[1].answerSources?.length : 0, 1)
})

test('keeps a durable historical skill estimate through completion updates', () => {
  const base = {
    v: 2 as const,
    session_id: 'session-estimate',
    turn_id: 'turn-estimate',
    item_id: 'skill-estimate',
    ts: 10
  }
  const started = projectSkillActivityEvent([], {
    ...base,
    seq: 1,
    type: 'skill_started',
    data: {
      skill_id: 'skill-estimate', skill: 'survey', path: '/skills/survey/SKILL.md',
      status: 'running', model_id: 'gpt-test', reasoning_effort: 'low',
      estimate: {
        lower_seconds: 1_800, upper_seconds: 2_700, sample_count: 3,
        confidence: 'low', basis: 'historical_skill_turns'
      }
    }
  })
  const completed = projectSkillActivityEvent(started, {
    ...base,
    seq: 2,
    ts: 20,
    type: 'skill_completed',
    data: {
      skill_id: 'skill-estimate', skill: 'survey', path: '/skills/survey/SKILL.md',
      status: 'completed', success: true
    }
  })

  assert.equal(completed[0].kind, 'skill')
  if (completed[0].kind === 'skill') {
    assert.equal(completed[0].status, 'done')
    assert.deepEqual(completed[0].estimate, {
      lowerSeconds: 1_800,
      upperSeconds: 2_700,
      sampleCount: 3,
      confidence: 'low',
      basis: 'historical_skill_turns',
      modelId: 'gpt-test',
      reasoningEffort: 'low'
    })
  }
})

test('uses one stable activity identity for every subagent lifecycle update', () => {
  const base = {
    v: 2 as const,
    session_id: 'session-agent',
    turn_id: 'turn-agent',
    data: {
      subagent_id: 'agent-1', parent_agent_id: 'root', root_turn_id: 'turn-agent',
      actor_kind: 'subagent' as const, actor_id: 'agent-1', parent_actor_id: 'root'
    }
  }
  const started = projectSubagentActivity({
    ...base, seq: 1, ts: 10, item_id: 'spawn-event', type: 'subagent_started'
  })
  const completed = projectSubagentActivity({
    ...base, seq: 2, ts: 20, item_id: 'completion-event', type: 'subagent_completed'
  })

  assert.equal(started.data.activity_id, 'agent-1')
  assert.equal(completed.data.activity_id, 'agent-1')
  assert.equal(started.type, 'native_activity_started')
  assert.equal(completed.type, 'native_activity_completed')
})

test('projects one durable review-ready card per batch', () => {
  const event = {
    v: 2 as const,
    seq: 17,
    ts: 4,
    type: 'review_ready' as const,
    session_id: 'session-review',
    turn_id: 'turn-review',
    item_id: 'review-card',
    data: {
      batch_id: 'batch-1',
      project_id: 'project-1',
      file_ids: ['file-1', 'file-2'],
      review_ids: ['review-1', 'review-2'],
      paths: ['reports/a.md', 'reports/b.docx']
    }
  }
  const projected = projectReviewReadyEvent([
    { kind: 'agent', text: '修改完成', turnId: 'turn-review' }
  ], event)
  const replayed = projectReviewReadyEvent(projected, event)

  assert.deepEqual(replayed.map((item) => item.kind), ['agent', 'review'])
  const review = replayed[1]
  assert.equal(review.kind, 'review')
  if (review.kind === 'review') {
    assert.equal(review.review.batchId, 'batch-1')
    assert.equal(review.review.fileIds.length, 2)
  }
})

test('keeps distinct display cards in one turn and de-duplicates replay', () => {
  const base: ConvItem[] = [{ kind: 'agent', text: '完成', turnId: 'turn-card' }]
  const first = {
    v: 2 as const,
    seq: 5,
    ts: 2,
    type: 'display_card' as const,
    session_id: 'session',
    turn_id: 'turn-card',
    data: { card_id: 'card-1', type: 'literature-references', content: {} }
  }
  const second = {
    ...first,
    seq: 6,
    data: { card_id: 'card-2', type: 'literature-references', content: {} }
  }
  const projected = projectDisplayCardEvent(projectDisplayCardEvent(base, first), second)
  const replayed = projectDisplayCardEvent(projected, first)
  assert.deepEqual(replayed.map((item) => item.kind), ['agent', 'display_card', 'display_card'])
  assert.equal(replayed.filter((item) => item.kind === 'display_card').length, 2)
})

test('projects the latest feature-owned card snapshot without deleting durable history', () => {
  const cards: ConvItem[] = [
    { kind: 'display_card', card: { cardId: 'outline', type: 'review', content: { workspace: 'one', checkpoint: 'outline' } } },
    { kind: 'display_card', card: { cardId: 'failed', type: 'review', content: { workspace: 'one', checkpoint: 'result', status: 'failed' } } },
    { kind: 'agent', text: 'recovered' },
    { kind: 'display_card', card: { cardId: 'partial', type: 'review', content: { workspace: 'one', checkpoint: 'result', status: 'partial' } } },
    { kind: 'display_card', card: { cardId: 'other', type: 'review', content: { workspace: 'two', checkpoint: 'result' } } }
  ]
  const visible = latestDisplayCardItems(cards, card => {
    const workspace = card.content.workspace
    const checkpoint = card.content.checkpoint
    return typeof workspace === 'string' && typeof checkpoint === 'string'
      ? `${workspace}:${checkpoint}`
      : null
  })
  assert.deepEqual(
    visible.filter((item) => item.kind === 'display_card').map((item) => item.kind === 'display_card' ? item.card.cardId : ''),
    ['outline', 'partial', 'other']
  )
  assert.equal(cards.length, 5)
})

test('first-position cards update content and detail identity without moving the display anchor', () => {
  const first: ConvItem = {
    kind: 'display_card', itemId: 'first-item', turnId: 'first-turn', eventSeq: 1,
    card: { cardId: 'search', type: 'search', content: { run: 'one' } }
  }
  const message: ConvItem = { kind: 'agent', text: 'Preparing authorization' }
  const latest: ConvItem = {
    kind: 'display_card', itemId: 'latest-item', turnId: 'next-turn', eventSeq: 3,
    card: { cardId: 'selection', type: 'search', content: { run: 'one', selection: 'selected' } }
  }
  const cards = [first, message, latest]
  const original = structuredClone(cards)
  const visible = latestDisplayCardItems(cards, card => String(card.content.run), () => 'first')
  assert.deepEqual(visible, [{ ...first, card: latest.card }, message])
  assert.deepEqual(cards, original)
  assert.deepEqual(latestDisplayCardItems(cards, card => String(card.content.run)), [message, latest])
})

test('restores display card below the final answer from activity history', () => {
  const projected = projectActivityEvents(
    [{ kind: 'agent', text: '结论', turnId: 'turn-card' }],
    [{
      v: 2,
      seq: 9,
      ts: 3,
      type: 'display_card',
      session_id: 'session',
      turn_id: 'turn-card',
      data: {
        card_id: 'card-1',
        type: 'literature-references',
        content: { schema_version: '1.0', project: 'demo', references: [] }
      }
    }]
  )
  assert.deepEqual(projected.map((item) => item.kind), ['agent', 'display_card'])
})

test('restores a confirmed AskUserQuestion reply from activity history', () => {
  const base = [
    { kind: 'user' as const, text: '询问午餐', turnId: 'turn-question' },
    {
      kind: 'status' as const,
      text: '正在等待你的回答',
      turnId: 'turn-question',
      eventSeq: 8
    },
    {
      kind: 'agent' as const,
      text: '已记录午餐：牛肉面',
      turnId: 'turn-question',
      eventSeq: 11
    }
  ]
  const common = {
    v: 2 as const,
    ts: 3,
    session_id: 'session',
    turn_id: 'turn-question',
    item_id: 'question-item'
  }
  const projected = projectActivityEvents(base, [
    {
      ...common,
      seq: 9,
      type: 'hil_requested',
      data: {
        request_id: 'question-1',
        kind: 'question',
        questions: [{ name: '午餐选择', question: '今天午餐你想吃什么？', options: [] }]
      }
    },
    {
      ...common,
      seq: 10,
      type: 'hil_resolved',
      data: {
        request_id: 'question-1',
        kind: 'question',
        questions: [{ name: '午餐选择', question: '今天午餐你想吃什么？', options: [] }],
        state: 'resolved',
        answers: { 午餐选择: '牛肉面' }
      }
    }
  ])

  assert.deepEqual(projected.map((item) => item.kind), ['user', 'status', 'hil', 'agent'])
  const answer = projected[2]
  assert.equal(answer.kind, 'hil')
  if (answer.kind !== 'hil') return
  assert.equal(answer.hilState, 'resolved')
  assert.equal(answer.eventSeq, 9)
  assert.deepEqual(answer.answers, { 午餐选择: '牛肉面' })
})

test('adds the durable event position to a recovered AskUserQuestion card', () => {
  const recovered: ConvItem[] = [{
    kind: 'hil',
    requestId: 'question-1',
    hilKind: 'question',
    hilState: 'pending',
    questions: [{ question: '今天午餐你想吃什么？', options: [] }]
  }]
  const projected = projectActivityEvents(recovered, [{
    v: 2,
    seq: 9,
    ts: 3,
    type: 'hil_requested',
    session_id: 'session',
    turn_id: 'turn-question',
    item_id: 'question-item',
    data: {
      request_id: 'question-1',
      kind: 'question',
      questions: [{ question: '今天午餐你想吃什么？', options: [] }]
    }
  }])

  assert.equal(projected.length, 1)
  assert.equal(projected[0].kind, 'hil')
  assert.equal(projected[0].turnId, 'turn-question')
  assert.equal(projected[0].itemId, 'question-item')
  assert.equal(projected[0].eventSeq, 9)
})

test('history restores a pre-runtime failure once even when SSE was missed', () => {
  const event = {
    v: 2 as const, seq: 5, ts: 2, type: 'turn_failed' as const,
    session_id: 'session', turn_id: 'client-turn',
    data: { code: 'review_pending', message: '请先完成文档审阅。' }
  }
  const initial: ConvItem[] = [{ kind: 'user', text: '继续', turnId: 'client-turn' }]
  const projected = projectActivityEvents(initial, [event])
  assert.equal(projected.length, 2)
  assert.equal(projected[1].kind, 'error')
  assert.equal(projected[1].turnId, 'client-turn')
  assert.deepEqual(projectActivityEvents(projected, [event]), projected)
})

test('artifact failure replay is scoped, idempotent and does not expose internal errors', () => {
  const event = {
    v: 2 as const, seq: 12, ts: 2, type: 'artifact_failed' as const,
    session_id: 'session', turn_id: 'turn', item_id: 'message',
    data: { declaration_id: 'declaration', code: '/private/secret: permission denied' }
  }
  const initial: ConvItem[] = [{ kind: 'agent', text: '已完成其余工作', turnId: 'turn' }]
  const projected = projectArtifactFailure(initial, event)
  assert.equal(projected.length, 2)
  const status = projected.find((item) => item.kind === 'status')
  assert.equal(status?.turnId, 'turn')
  assert.equal(status?.itemId, 'message')
  assert.equal(status?.kind === 'status' ? status.tone : null, 'tension')
  assert.deepEqual(status?.kind === 'status' ? status.text : null, { key: 'artifactFailure.invalid' })
  assert.doesNotMatch(JSON.stringify(status), /private|permission denied/)
  assert.deepEqual(projectArtifactFailure(projected, event), projected)
  assert.deepEqual(projectActivityEvents(initial, [event]), projected)
  assert.equal(projected.filter((item) => item.kind === 'error').length, 0)
})

test('ignores legacy review events without losing the surrounding transcript', () => {
  const turnId = 'turn-review'
  const projected = projectHistorySnapshot({
    turns: [],
    todos: [],
    todo_turn_id: null,
    turn_activity: [{ turn_id: turnId, outcome: 'completed', started_at: 1 }],
    activity_events: [JSON.parse(JSON.stringify({
      v: 2,
      seq: 9,
      ts: 2,
      type: 'change_set_ready',
      session_id: 'session-review',
      turn_id: turnId,
      item_id: 'review-1',
      data: {
        change_set_id: 'change-1',
        project_id: 'project-1',
        state: 'pending',
        file_count: 2,
        added: 8,
        removed: 3,
        decided: 0,
        revision: 0,
        task: '修改两份报告'
      }
    }))],
    artifacts: []
  }, [
    { kind: 'user', text: '修改报告', turnId, itemId: 'user-1' },
    { kind: 'agent', text: '修改完成。', turnId, itemId: 'answer-1' }
  ])

  assert.deepEqual(projected.map((item) => item.kind), ['user', 'agent'])
})


test('keeps commentary in the thinking stream and final answers in the agent stream', () => {
  const turnId = 'turn-phases'
  let live: ConvItem[] = [{ kind: 'user', text: 'inspect', turnId }]
  live = projectStreamDelta(live, 'thinking', '检查', turnId, 'commentary-1', true)
  live = projectStreamDelta(live, 'thinking', '检查工具返回。', turnId, 'commentary-1', true)
  assert.equal(live[1].kind === 'thinking' ? live[1].text : '', '检查工具返回。')

  const restored = projectActivityEvents([
    { kind: 'user', text: 'inspect', turnId, itemId: 'user-1' },
    { kind: 'tool', toolId: 'tool-1', name: 'shell', status: 'done', turnId, itemId: 'tool-1' },
    { kind: 'agent', text: '最终结论。', turnId, itemId: 'final-1' }
  ], [
    {
      v: 2,
      seq: 1,
      ts: 1,
      type: 'message_delta',
      session_id: 'session-phases',
      turn_id: turnId,
      item_id: 'commentary-1',
      data: { delta: '检查工具返回。', phase: 'commentary' }
    },
    {
      v: 2,
      seq: 2,
      ts: 1,
      type: 'tool_started',
      session_id: 'session-phases',
      turn_id: turnId,
      item_id: 'tool-1',
      data: { tool_id: 'tool-1', name: 'shell' }
    },
    {
      v: 2,
      seq: 3,
      ts: 1,
      type: 'tool_completed',
      session_id: 'session-phases',
      turn_id: turnId,
      item_id: 'tool-1',
      data: { tool_id: 'tool-1', name: 'shell', success: true }
    },
    {
      v: 2,
      seq: 4,
      ts: 1,
      type: 'message_delta',
      session_id: 'session-phases',
      turn_id: turnId,
      item_id: 'final-1',
      data: { delta: '最终结论。', phase: 'final_answer' }
    }
  ])
  assert.deepEqual(restored.map((item) => item.kind), ['user', 'thinking', 'tool', 'agent'])
})

test('migrates one live assistant item when its authoritative phase arrives', () => {
  const turnId = 'turn-late-phase'
  let live = projectStreamDelta([], 'agent', '正在检查。', turnId, 'message-1', true, 7)
  live = projectStreamDelta(live, 'thinking', '正在检查。', turnId, 'message-1', true, 8)

  assert.deepEqual(live, [{
    kind: 'thinking',
    text: '正在检查。',
    turnId,
    itemId: 'message-1',
    eventSeq: 7,
    commentary: true
  }])
})

test('uses the latest explicit phase when restoring cumulative assistant events', () => {
  const turnId = 'turn-restored-late-phase'
  const restored = projectActivityEvents([], [{
    v: 2,
    seq: 1,
    ts: 1,
    type: 'message_delta',
    session_id: 'session-late-phase',
    turn_id: turnId,
    item_id: 'message-1',
    data: { delta: '正在检查。' }
  }, {
    v: 2,
    seq: 2,
    ts: 2,
    type: 'message_delta',
    session_id: 'session-late-phase',
    turn_id: turnId,
    item_id: 'message-1',
    data: { delta: '正在检查。', phase: 'commentary' }
  }])

  assert.deepEqual(restored.map((item) => [item.kind, item.itemId]), [
    ['thinking', 'message-1']
  ])
})

test('keeps history classification when replay only has an unphased assistant event', () => {
  const turnId = 'turn-history-phase'
  const restored = projectActivityEvents([{
    kind: 'thinking',
    text: '正在检查。',
    turnId,
    itemId: 'message-1',
    commentary: true
  }], [{
    v: 2,
    seq: 1,
    ts: 1,
    type: 'message_delta',
    session_id: 'session-history-phase',
    turn_id: turnId,
    item_id: 'message-1',
    data: { delta: '正在检查。' }
  }])

  assert.deepEqual(restored.map((item) => [item.kind, item.itemId]), [
    ['thinking', 'message-1']
  ])
})

test('live assistant messages retain their first event sequence for answer actions', () => {
  const turnId = 'turn-live-answer'
  let live: ConvItem[] = []
  live = projectStreamDelta(live, 'agent', '第一段', turnId, 'answer-1', true, 41)
  live = projectStreamDelta(live, 'agent', '第一段和第二段', turnId, 'answer-1', true, 42)

  assert.deepEqual(live, [{
    kind: 'agent',
    text: '第一段和第二段',
    turnId,
    itemId: 'answer-1',
    eventSeq: 41
  }])
})

test('keeps a completed turn summary below late activity and artifacts', () => {
  const turnId = 'turn-summary-last'
  const nextTurnId = 'turn-next'
  const rows = placeFinalAssistantLast([
    { kind: 'user', text: 'write a review', turnId, itemId: 'user-1' },
    { kind: 'thinking', text: 'drafting', turnId, itemId: 'thinking-1' },
    { kind: 'agent', text: '摘要级综述已完成。', turnId, itemId: 'final-1' },
    {
      kind: 'artifact',
      turnId,
      itemId: 'artifact-1',
      artifact: {
        artifact_id: 'artifact-1',
        path: 'output_spec.json',
        name: 'output_spec.json',
        role: 'intermediate',
        vendor_turn_id: turnId
      }
    },
    {
      kind: 'native_activity',
      activityId: 'subagent-1',
      activityType: 'subagent_activity',
      category: 'collaboration',
      status: 'done',
      nativeStatus: 'completed',
      details: {},
      turnId,
      itemId: 'subagent-1'
    },
    {
      kind: 'hil',
      requestId: 'permission-1',
      hilKind: 'permission',
      hilState: 'resolved',
      turnId,
      itemId: 'permission-1'
    },
    { kind: 'user', text: 'next question', turnId: nextTurnId, itemId: 'user-2' },
    { kind: 'agent', text: 'next answer', turnId: nextTurnId, itemId: 'final-2' }
  ], [turnId])

  assert.deepEqual(rows.map((item) => [item.turnId, item.kind]), [
    [turnId, 'user'],
    [turnId, 'thinking'],
    [turnId, 'artifact'],
    [turnId, 'native_activity'],
    [turnId, 'hil'],
    [turnId, 'agent'],
    [nextTurnId, 'user'],
    [nextTurnId, 'agent']
  ])
  assert.equal(rows[5].kind === 'agent' ? rows[5].text : '', '摘要级综述已完成。')
})

test('does not reorder a running turn or disturb assistant messages around activity', () => {
  const turnId = 'turn-still-running'
  const rows: ConvItem[] = [
    { kind: 'user', text: 'inspect', turnId },
    { kind: 'agent', text: '我先检查。', turnId, itemId: 'message-before' },
    {
      kind: 'native_activity',
      activityId: 'activity-1',
      activityType: 'image_view',
      category: 'media',
      status: 'done',
      nativeStatus: 'completed',
      details: {},
      turnId,
      itemId: 'activity-1'
    },
    { kind: 'agent', text: '检查完成。', turnId, itemId: 'message-final' }
  ]

  assert.deepEqual(placeFinalAssistantLast(rows, []), rows)
  assert.deepEqual(placeFinalAssistantLast(rows, [turnId]), rows)
})

test('does not duplicate commentary when durable history refreshes after event replay', () => {
  const turnId = 'turn-commentary-refresh'
  const turns = [
    { kind: 'user', text: 'inspect', turn_id: turnId, item_id: 'history-user' },
    {
      kind: 'thinking',
      role: 'assistant',
      text: 'Checking.',
      turn_id: turnId,
      item_id: 'history-commentary',
      phase: 'commentary' as const
    },
    {
      kind: 'text',
      role: 'assistant',
      text: 'Done.',
      turn_id: turnId,
      item_id: 'history-final',
      phase: 'final_answer' as const
    }
  ]
  const events = [{
    v: 2 as const,
    seq: 1,
    ts: 1,
    type: 'message_delta' as const,
    session_id: 'session-commentary-refresh',
    turn_id: turnId,
    item_id: 'live-commentary',
    data: { delta: 'Checking.', phase: 'commentary' as const }
  }]
  const first = projectActivityEvents(projectHistoryWithRuntime(turns, []), events)
  const refreshed = projectActivityEvents(projectHistoryWithRuntime(turns, first), events)
  assert.deepEqual(refreshed.map((item) => item.kind), ['user', 'thinking', 'agent'])
  assert.equal(refreshed.filter((item) => item.kind === 'thinking').length, 1)
})

test('restores the assistant reply from durable history before runtime resume enriches turns', () => {
  const turnId = 'turn-cold-history'
  const restored = projectHistorySnapshot({
    turns: [{
      kind: 'user',
      role: 'user',
      text: '历史问题',
      turn_id: turnId,
      item_id: 'user-cold-history'
    }],
    todos: [],
    todo_turn_id: null,
    artifacts: [],
    activity_events: [{
      v: 2,
      seq: 2,
      ts: 1,
      type: 'message_delta',
      session_id: 'session-cold-history',
      turn_id: turnId,
      item_id: 'assistant-cold-history',
      data: { delta: '历史回答', phase: 'final_answer' }
    }],
    turn_activity: [{ turn_id: turnId, started_at: 1, completed_at: 2, outcome: 'completed' }]
  }, [])

  assert.deepEqual(restored.map((item) => [
    item.kind,
    item.kind === 'user' || item.kind === 'agent' ? item.text : ''
  ]), [
    ['user', '历史问题'],
    ['agent', '历史回答']
  ])
})

test('keeps assistant messages on both sides of web search as distinct live items', () => {
  const turnId = 'turn-search'
  let rows: ConvItem[] = [{ kind: 'user', text: 'search it', turnId }]
  rows = projectStreamDelta(rows, 'agent', '我先查一下。', turnId, 'message-before')
  rows = projectWebSearchEvent(rows, {
    v: 2,
    seq: 2,
    ts: 1,
    type: 'web_search_started',
    session_id: 'session-search',
    turn_id: turnId,
    item_id: 'search-1',
    data: {
      search_id: 'search-1',
      query: '',
      action: { type: 'other' }
    }
  }, 'live')
  assert.equal(rows[2].kind, 'web_search')
  assert.equal(rows[2].kind === 'web_search' ? rows[2].status : '', 'running')
  rows = projectWebSearchEvent(rows, {
    v: 2,
    seq: 3,
    ts: 2,
    type: 'web_search_completed',
    session_id: 'session-search',
    turn_id: turnId,
    item_id: 'search-1',
    data: {
      search_id: 'search-1',
      query: 'Codex events',
      action: { type: 'search', query: 'Codex events' },
      results: [{ title: 'Codex', url: 'https://example.test/codex' }],
      result_count: 1
    }
  }, 'live')
  rows = projectStreamDelta(rows, 'agent', '这是', turnId, 'message-after')
  rows = projectStreamDelta(rows, 'agent', '这是结果。', turnId, 'message-after')

  assert.deepEqual(rows.map((item) => [item.kind, item.itemId]), [
    ['user', undefined],
    ['agent', 'message-before'],
    ['web_search', 'search-1'],
    ['agent', 'message-after']
  ])
  assert.deepEqual(
    rows.filter((item) => item.kind === 'agent').map((item) => item.text),
    ['我先查一下。', '这是结果。']
  )
  assert.equal(rows[2].kind === 'web_search' ? rows[2].query : '', 'Codex events')
  assert.equal(rows[2].kind === 'web_search' ? rows[2].status : '', 'done')
  assert.notEqual(
    streamItemIdentity('thread-1', 'agent', turnId, 'message-before'),
    streamItemIdentity('thread-1', 'agent', turnId, 'message-after')
  )
})

test('resume preserves a completed web search card and its assistant messages', () => {
  const turnId = 'turn-resume-search'
  const rows = projectHistoryWithRuntime(
    [
      { kind: 'user', role: 'user', text: 'search it', turn_id: turnId, item_id: 'user-1' },
      { kind: 'text', role: 'assistant', text: '我先查一下。', turn_id: turnId, item_id: 'message-before' },
      { kind: 'text', role: 'assistant', text: '这是结果。', turn_id: turnId, item_id: 'message-after' }
    ],
    [{
      kind: 'web_search',
      searchId: 'search-1',
      status: 'done',
      query: 'Codex events',
      action: { type: 'search', query: 'Codex events' },
      results: [],
      resultCount: 0,
      turnId,
      itemId: 'search-1'
    }]
  )

  assert.deepEqual(rows.map((item) => [item.kind, item.itemId]), [
    ['user', 'user-1'],
    ['agent', 'message-before'],
    ['web_search', 'search-1'],
    ['agent', 'message-after']
  ])
})

test('keeps assistant messages on both sides of paper search as distinct live items', () => {
  const turnId = 'turn-paper-search'
  let rows: ConvItem[] = [{ kind: 'user', text: 'find papers', turnId }]
  rows = projectStreamDelta(rows, 'agent', '我先检索论文。', turnId, 'message-before')
  rows = projectPaperSearchEvent(rows, {
    v: 2,
    seq: 2,
    ts: 1,
    type: 'paper_search_started',
    session_id: 'session-paper-search',
    turn_id: turnId,
    item_id: 'paper-search-1',
    data: { search_id: 'paper-search-1', query: '' }
  }, 'live')
  assert.equal(rows[2].kind, 'paper_search')
  assert.equal(rows[2].kind === 'paper_search' ? rows[2].status : '', 'running')
  rows = projectPaperSearchEvent(rows, {
    v: 2,
    seq: 3,
    ts: 2,
    type: 'paper_search_completed',
    session_id: 'session-paper-search',
    turn_id: turnId,
    item_id: 'paper-search-1',
    data: { search_id: 'paper-search-1', query: 'agent memory' }
  }, 'live')
  rows = projectStreamDelta(rows, 'agent', '检索完成。', turnId, 'message-after')

  assert.deepEqual(rows.map((item) => [item.kind, item.itemId]), [
    ['user', undefined],
    ['agent', 'message-before'],
    ['paper_search', 'paper-search-1'],
    ['agent', 'message-after']
  ])
  assert.deepEqual(
    rows.filter((item) => item.kind === 'agent').map((item) => item.text),
    ['我先检索论文。', '检索完成。']
  )
  assert.equal(rows[2].kind === 'paper_search' ? rows[2].query : '', 'agent memory')
  assert.equal(rows[2].kind === 'paper_search' ? rows[2].status : '', 'done')
})

test('keeps assistant messages on both sides of a native activity as distinct live items', () => {
  const turnId = 'turn-native'
  let rows: ConvItem[] = [{ kind: 'user', text: 'delegate it', turnId }]
  rows = projectStreamDelta(rows, 'agent', '我先交给子代理检查。', turnId, 'message-before')
  rows = projectNativeActivityEvent(rows, {
    v: 2,
    seq: 2,
    ts: 1,
    type: 'native_activity_started',
    session_id: 'session-native',
    turn_id: turnId,
    item_id: 'native-1',
    data: {
      activity_id: 'native-1',
      activity_type: 'agent_collaboration',
      category: 'collaboration',
      details: { operation: 'spawn_agent' },
      status: 'running'
    }
  }, 'live')
  rows = projectNativeActivityEvent(rows, {
    v: 2,
    seq: 3,
    ts: 2,
    type: 'native_activity_completed',
    session_id: 'session-native',
    turn_id: turnId,
    item_id: 'native-1',
    data: {
      activity_id: 'native-1',
      activity_type: 'agent_collaboration',
      category: 'collaboration',
      details: { receiver_thread_ids: ['agent-1'] },
      status: 'completed',
      success: true
    }
  }, 'live')
  rows = projectStreamDelta(rows, 'agent', '子代理检查完成。', turnId, 'message-after')

  assert.deepEqual(rows.map((item) => [item.kind, item.itemId]), [
    ['user', undefined],
    ['agent', 'message-before'],
    ['native_activity', 'native-1'],
    ['agent', 'message-after']
  ])
  assert.deepEqual(
    rows.filter((item) => item.kind === 'agent').map((item) => item.text),
    ['我先交给子代理检查。', '子代理检查完成。']
  )
  const activity = rows.find((item) => item.kind === 'native_activity')
  assert.equal(activity?.kind === 'native_activity' ? activity.status : '', 'done')
})

test('does not reopen a terminal native activity when an older start event arrives late', () => {
  const turnId = 'turn-native-out-of-order'
  let rows: ConvItem[] = []
  rows = projectNativeActivityEvent(rows, {
    v: 2,
    seq: 2,
    ts: 2,
    type: 'native_activity_completed',
    session_id: 'session-native',
    turn_id: turnId,
    item_id: 'subagent-1',
    data: {
      activity_id: 'subagent-1',
      activity_type: 'subagent_activity',
      category: 'collaboration',
      details: { result: 'done' },
      status: 'completed',
      success: true
    }
  }, 'live')
  rows = projectNativeActivityEvent(rows, {
    v: 2,
    seq: 3,
    ts: 3,
    type: 'native_activity_started',
    session_id: 'session-native',
    turn_id: turnId,
    item_id: 'subagent-1',
    data: {
      activity_id: 'subagent-1',
      activity_type: 'subagent_activity',
      category: 'collaboration',
      details: { operation: 'spawn_agent' },
      status: 'running'
    }
  }, 'live')

  const activity = rows[0]
  assert.equal(activity?.kind === 'native_activity' ? activity.status : '', 'done')
  assert.equal(activity?.kind === 'native_activity' ? activity.nativeStatus : '', 'completed')
  assert.equal(activity?.kind === 'native_activity' ? activity.completedAt : 0, 2000)
  assert.deepEqual(activity?.kind === 'native_activity' ? activity.details : {}, {
    result: 'done',
    operation: 'spawn_agent'
  })
})

test('resume restores native activity between two durable assistant items', () => {
  const turnId = 'turn-resume-native'
  const base = projectHistory([
    { kind: 'user', role: 'user', text: 'delegate it', turn_id: turnId, item_id: 'user-1' },
    { kind: 'text', role: 'assistant', text: '我先检查。', turn_id: turnId, item_id: 'message-before' },
    { kind: 'text', role: 'assistant', text: '检查完成。', turn_id: turnId, item_id: 'message-after' }
  ])
  const rows = projectActivityEvents(base, [{
    v: 2,
    seq: 3,
    ts: 2,
    type: 'native_activity_completed',
    session_id: 'session-native',
    turn_id: turnId,
    item_id: 'native-1',
    data: {
      activity_id: 'native-1',
      activity_type: 'image_view',
      category: 'media',
      details: { path: '/tmp/chart.png' },
      status: 'completed',
      success: true
    }
  }])

  assert.deepEqual(rows.map((item) => [item.kind, item.itemId]), [
    ['user', 'user-1'],
    ['agent', 'message-before'],
    ['native_activity', 'native-1'],
    ['agent', 'message-after']
  ])
})

test('restores durable activity including completed search cards', () => {
  const base: ConvItem[] = [
    { kind: 'user', text: '分析', turnId: 'turn-1' },
    { kind: 'agent', text: '结论', turnId: 'turn-1' }
  ]
  const envelope = {
    v: 2 as const,
    session_id: 'session-1',
    turn_id: 'turn-1',
    ts: 1
  }
  const projected = projectActivityEvents(base, [
    { ...envelope, seq: 1, type: 'reasoning_delta', item_id: 'reason-1', data: { delta: '检查' } },
    { ...envelope, seq: 2, type: 'reasoning_delta', item_id: 'reason-1', data: { delta: '数据' } },
    { ...envelope, seq: 3, type: 'tool_started', item_id: 'item-1', data: { tool_id: 'tool-1', name: 'shell', input: { cmd: 'run' } } },
    { ...envelope, seq: 4, type: 'tool_output_delta', item_id: 'item-1', data: { tool_id: 'tool-1', delta: 'ok' } },
    { ...envelope, seq: 5, ts: 2, type: 'tool_completed', item_id: 'item-1', data: { tool_id: 'tool-1', name: 'shell', output: 'done', success: true } },
    { ...envelope, seq: 6, type: 'web_search_started', item_id: 'search-1', data: { search_id: 'search-1', query: 'Codex events', action: { type: 'search', query: 'Codex events' } } },
    { ...envelope, seq: 7, type: 'web_search_completed', item_id: 'search-1', data: { search_id: 'search-1', query: 'Codex events', action: { type: 'search', query: 'Codex events' }, results: [{ title: 'Codex', url: 'https://example.test/codex' }], result_count: 1 } },
    { ...envelope, seq: 8, type: 'paper_search_started', item_id: 'paper-search-1', data: { search_id: 'paper-search-1', query: '' } },
    { ...envelope, seq: 9, type: 'paper_search_completed', item_id: 'paper-search-1', data: { search_id: 'paper-search-1', query: 'agent memory' } },
    { ...envelope, seq: 10, type: 'skill_started', item_id: 'skill-1', data: { skill_id: 'skill-1', skill: 'literature-search', path: '/skills/literature-search/SKILL.md', status: 'running' } },
    { ...envelope, seq: 11, type: 'skill_completed', item_id: 'skill-1', data: { skill_id: 'skill-1', skill: 'literature-search', path: '/skills/literature-search/SKILL.md', status: 'completed', success: true } },
    { ...envelope, seq: 12, type: 'native_activity_started', item_id: 'native-1', data: { activity_id: 'native-1', activity_type: 'wait', category: 'wait', details: { duration_ms: 500 }, status: 'running' } },
    { ...envelope, seq: 13, type: 'native_activity_completed', item_id: 'native-1', data: { activity_id: 'native-1', activity_type: 'wait', category: 'wait', details: { duration_ms: 500 }, status: 'completed', success: true } }
  ])
  assert.deepEqual(projected.map((item) => item.kind), ['user', 'thinking', 'tool', 'web_search', 'paper_search', 'skill', 'native_activity', 'agent'])
  assert.equal(projected[1].kind === 'thinking' ? projected[1].text : '', '检查数据')
  assert.equal(projected[2].kind === 'tool' ? projected[2].status : '', 'done')
  assert.equal(projected[2].kind === 'tool' ? projected[2].startedAt : 0, 1000)
  assert.equal(projected[2].kind === 'tool' ? projected[2].completedAt : 0, 2000)
  assert.equal(projected[3].kind === 'web_search' ? projected[3].status : '', 'done')
  assert.equal(projected[4].kind === 'paper_search' ? projected[4].status : '', 'done')
  assert.equal(projected[5].kind === 'skill' ? projected[5].status : '', 'done')
  assert.equal(projected[5].kind === 'skill' ? projected[5].name : '', 'literature-search')
  assert.equal(projected[6].kind === 'native_activity' ? projected[6].status : '', 'done')
})

test('thinking keeps the wall clock of its first and last reasoning delta', () => {
  const envelope = { v: 2 as const, session_id: 'session-1', turn_id: 'turn-think', ts: 3 }
  const projected = projectActivityEvents([
    { kind: 'user', text: 'think', turnId: 'turn-think' }
  ], [
    { ...envelope, seq: 1, type: 'reasoning_delta', item_id: 'reason-1', data: { delta: '先' } },
    { ...envelope, seq: 2, ts: 5, type: 'reasoning_delta', item_id: 'reason-1', data: { delta: '后' } }
  ])
  const thinking = projected.find((item) => item.kind === 'thinking')
  assert.equal(thinking?.kind, 'thinking')
  if (thinking?.kind === 'thinking') {
    assert.equal(thinking.startedAt, 3000)
    assert.equal(thinking.completedAt, 5000)
  }
})

test('live thinking deltas carry the first and last delta wall clock', () => {
  let rows = projectStreamDelta([], 'thinking', '先', 'turn-live', 'reason-1', false, 1, undefined, 3000)
  rows = projectStreamDelta(rows, 'thinking', '后', 'turn-live', 'reason-1', false, 2, undefined, 5000)
  const thinking = rows.find((item) => item.kind === 'thinking')
  assert.equal(thinking?.kind, 'thinking')
  if (thinking?.kind === 'thinking') {
    assert.equal(thinking.startedAt, 3000)
    assert.equal(thinking.completedAt, 5000)
  }
})

test('restores search cards between the exact assistant items that surrounded them', () => {
  const turnId = 'turn-ordered-search'
  const base: ConvItem[] = [
    { kind: 'user', text: 'search', turnId, itemId: 'user-1' },
    { kind: 'agent', text: 'first', turnId, itemId: 'item-3' },
    { kind: 'agent', text: 'second', turnId, itemId: 'item-5' },
    { kind: 'agent', text: 'final', turnId, itemId: 'item-9' },
    { kind: 'web_search', searchId: 'search-1', status: 'done', query: 'stale', action: {}, results: [], resultCount: 0, turnId, itemId: 'search-1' },
    { kind: 'paper_search', searchId: 'paper-1', status: 'done', query: 'stale', turnId, itemId: 'paper-1' }
  ]
  const envelope = {
    v: 2 as const,
    session_id: 'session-ordered-search',
    turn_id: turnId,
    ts: 1
  }
  const projected = projectActivityEvents(base, [
    { ...envelope, seq: 7, type: 'message_delta', item_id: 'message-3', data: { delta: 'final' } },
    { ...envelope, seq: 3, type: 'web_search_completed', item_id: 'search-1', data: { search_id: 'search-1', query: 'Codex', action: { type: 'search', query: 'Codex' }, results: [], result_count: 0 } },
    { ...envelope, seq: 1, type: 'message_delta', item_id: 'message-1', data: { delta: 'first' } },
    { ...envelope, seq: 5, type: 'paper_search_started', item_id: 'paper-1', data: { search_id: 'paper-1', query: '' } },
    { ...envelope, seq: 2, type: 'web_search_started', item_id: 'search-1', data: { search_id: 'search-1', query: '', action: { type: 'other' } } },
    { ...envelope, seq: 6, type: 'paper_search_completed', item_id: 'paper-1', data: { search_id: 'paper-1', query: 'agent memory' } },
    { ...envelope, seq: 4, type: 'message_delta', item_id: 'message-2', data: { delta: 'second' } }
  ])

  assert.deepEqual(projected.map((item) => [item.kind, item.itemId]), [
    ['user', 'user-1'],
    ['agent', 'message-1'],
    ['web_search', 'search-1'],
    ['agent', 'message-2'],
    ['paper_search', 'paper-1'],
    ['agent', 'message-3']
  ])
  assert.equal(projected[2].kind === 'web_search' ? projected[2].query : '', 'Codex')
  assert.equal(projected[4].kind === 'paper_search' ? projected[4].query : '', 'agent memory')
})

test('preserves history turn and item identities on every projected row', () => {
  const rows = projectHistory([
    { kind: 'user', text: 'question', turn_id: 'turn-1', item_id: 'item-user' },
    { kind: 'thinking', text: 'reasoning', turn_id: 'turn-1', item_id: 'item-reasoning' },
    { kind: 'text', role: 'assistant', text: 'answer', turn_id: 'turn-1', item_id: 'item-answer' }
  ])
  assert.deepEqual(rows.map((row) => [row.turnId, row.itemId]), [
    ['turn-1', 'item-user'],
    ['turn-1', 'item-reasoning'],
    ['turn-1', 'item-answer']
  ])
})

test('restores durable file metadata on the user message after history refresh', () => {
  const rows = projectHistory([
    {
      kind: 'user',
      role: 'user',
      text: 'read this file',
      turn_id: 'turn-file',
      refs: [{
        type: 'file',
        id: '/tmp/invoice.pdf',
        title: 'invoice.pdf',
        path: '/tmp/invoice.pdf',
        media_type: 'application/pdf',
        sha256: 'abc',
        size: 42
      }]
    }
  ])
  const reference = rows[0].kind === 'user' ? rows[0].refs?.[0] : undefined
  assert.deepEqual(reference, {
    type: 'file',
    id: '/tmp/invoice.pdf',
    title: 'invoice.pdf',
    status: undefined,
    path: '/tmp/invoice.pdf',
    mediaType: 'application/pdf',
    sha256: 'abc',
    size: 42
  })
})

test('preserves answer annotation identity for the sent user-message summary', () => {
  const rows = projectHistory([{
    kind: 'user',
    role: 'user',
    text: 'use this note',
    refs: [{
      type: 'assistant_context',
      id: 'evidence-1',
      title: 'selected answer text',
      kind: 'note',
      source_id: 'annotation-1'
    }]
  }])
  const reference = rows[0].kind === 'user' ? rows[0].refs?.[0] : undefined
  assert.equal(reference?.kind, 'note')
  assert.equal(reference?.sourceId, 'annotation-1')
})

test('preserves Assistant snapshot, revision and selection locator for sent reference review', () => {
  const rows = projectHistory([{
    kind: 'user',
    role: 'user',
    text: 'review this excerpt',
    refs: [{
      type: 'assistant_context',
      id: 'selection-1',
      title: 'report.md · 划词',
      kind: 'selection',
      source_id: 'resources/report.md',
      snapshot_id: 'snapshot-1',
      source_revision: 'sha256:revision-1',
      anchor: {
        preview_text: '发送时的完整片段',
        locator: { kind: 'text', start: 3, end: 12 }
      }
    }]
  }])
  const reference = rows[0].kind === 'user' ? rows[0].refs?.[0] : undefined
  assert.deepEqual(reference?.anchor, {
    previewText: '发送时的完整片段',
    locator: { kind: 'text', start: 3, end: 12 }
  })
  assert.equal(reference?.snapshotId, 'snapshot-1')
  assert.equal(reference?.sourceRevision, 'sha256:revision-1')
})

test('restores a skill estimate from the durable sent-message reference', () => {
  const rows = projectHistory([{
    kind: 'user',
    role: 'user',
    text: 'write a review',
    turn_id: 'turn-skill',
    refs: [{
      type: 'skill',
      id: 'literature-review',
      title: 'literature-review',
      estimate: {
        lower_seconds: 1_800,
        upper_seconds: 2_700,
        sample_count: 0,
        confidence: 'low',
        basis: 'product_baseline'
      },
      model_id: 'gpt-5.6-sol',
      reasoning_effort: 'low'
    }]
  }])

  const reference = rows[0].kind === 'user' ? rows[0].refs?.[0] : undefined
  assert.deepEqual(reference?.estimate, {
    lowerSeconds: 1_800,
    upperSeconds: 2_700,
    sampleCount: 0,
    confidence: 'low',
    basis: 'product_baseline',
    modelId: 'gpt-5.6-sol',
    reasoningEffort: 'low'
  })
})

test('binds a durable user-message event without duplicating the optimistic bubble', () => {
  const rows = upsertUserMessageEvent(
    [{ kind: 'user', text: 'read this file' }],
    {
      v: 2,
      seq: 2,
      ts: 1,
      type: 'user_message',
      session_id: 'session-file',
      turn_id: 'vendor-turn',
      item_id: 'client-turn',
      data: {
        text: 'read this file',
        client_turn_id: 'client-turn',
        binding: 'bound',
        refs: [{
          type: 'file',
          id: '/tmp/invoice.pdf',
          title: 'invoice.pdf',
          path: '/tmp/invoice.pdf',
          media_type: 'application/pdf'
        }]
      }
    }
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].turnId, 'vendor-turn')
  assert.equal(rows[0].kind === 'user' ? rows[0].refs?.[0]?.path : '', '/tmp/invoice.pdf')
})

test('adds an optimistic user message once and rolls back only while unbound', () => {
  const optimistic = {
    kind: 'user' as const,
    text: '立即显示这条消息',
    itemId: 'client-optimistic'
  }
  const once = appendOptimisticUserMessage([], optimistic)
  const twice = appendOptimisticUserMessage(once, optimistic)

  assert.equal(twice.length, 1)
  assert.deepEqual(removeOptimisticUserMessage(twice, 'client-optimistic'), [])
  assert.deepEqual(
    removeOptimisticUserMessage(
      [{ ...optimistic, turnId: 'vendor-turn' }],
      'client-optimistic'
    ),
    [{ ...optimistic, turnId: 'vendor-turn' }]
  )
})

test('collapses admitted and vendor-bound copies of one steered user message', () => {
  const rows = upsertUserMessageEvent(
    [
      { kind: 'user', text: 'send now', turnId: 'client-turn', itemId: 'client-turn' },
      { kind: 'user', text: 'send now', turnId: 'vendor-turn', itemId: 'client-turn' }
    ],
    {
      v: 2,
      seq: 3,
      ts: 1,
      type: 'user_message',
      session_id: 'session-steer',
      turn_id: 'vendor-turn',
      item_id: 'client-turn',
      data: {
        text: 'send now',
        client_turn_id: 'client-turn',
        binding: 'bound',
        origin: 'steer',
        refs: []
      }
    }
  )
  assert.deepEqual(rows, [
    {
      kind: 'user',
      text: 'send now',
      turnId: 'vendor-turn',
      itemId: 'client-turn',
      refs: undefined,
      steer: true,
      steerLabel: '已用于当前任务'
    }
  ])
})

test('restores a steered user message from durable history with its current-task identity', () => {
  assert.deepEqual(projectHistory([{
    kind: 'user',
    role: 'user',
    text: 'change the remaining steps',
    turn_id: 'active-turn',
    item_id: 'steer-client',
    origin: 'steer'
  }]), [{
    kind: 'user',
    text: 'change the remaining steps',
    turnId: 'active-turn',
    itemId: 'steer-client',
    refs: undefined,
    rewindAnchor: undefined,
    steer: true,
    steerLabel: '已用于当前任务'
  }])
})

test('restores HIL before its own final assistant reply instead of at session bottom', () => {
  const turns = [
    { kind: 'user', text: 'first', turn_id: 'turn-1' },
    { kind: 'text', role: 'assistant', text: 'first answer', turn_id: 'turn-1' },
    { kind: 'user', text: 'second', turn_id: 'turn-2' },
    { kind: 'text', role: 'assistant', text: 'second answer', turn_id: 'turn-2' }
  ]
  const hil: ConvItem = {
    kind: 'hil',
    requestId: 'request-1',
    hilKind: 'permission',
    hilState: 'pending',
    turnId: 'turn-1'
  }
  const rows = projectHistoryWithRuntime(turns, [hil])
  assert.deepEqual(rows.map((row) => `${row.turnId}:${row.kind}`), [
    'turn-1:user',
    'turn-1:hil',
    'turn-1:agent',
    'turn-2:user',
    'turn-2:agent'
  ])
})

test('keeps completed turn activity at its durable turn anchor', () => {
  const rows = projectHistoryWithRuntime(
    [
      { kind: 'user', role: 'user', text: 'run it', turn_id: 'turn-activity' },
      { kind: 'text', role: 'assistant', text: 'done', turn_id: 'turn-activity' }
    ],
    [
      { kind: 'thinking', text: 'checking', turnId: 'turn-activity', itemId: 'reasoning-1' },
      {
        kind: 'tool',
        toolId: 'tool-1',
        name: 'artifact.publish',
        status: 'done',
        turnId: 'turn-activity',
        itemId: 'tool-1'
      }
    ]
  )
  assert.deepEqual(rows.map((item) => item.kind), ['user', 'thinking', 'tool', 'agent'])
})

test('an idle history refresh never deletes a live assistant item around activity', () => {
  const turnId = 'turn-history-race'
  const current: ConvItem[] = [
    { kind: 'user', text: 'search it', turnId, itemId: 'user-live' },
    { kind: 'agent', text: '我先查一下。', turnId, itemId: 'message-before' },
    {
      kind: 'web_search',
      searchId: 'search-1',
      status: 'done',
      query: 'Codex events',
      action: { type: 'search', query: 'Codex events' },
      results: [],
      resultCount: 0,
      turnId,
      itemId: 'search-1'
    },
    { kind: 'agent', text: '这是结果。', turnId, itemId: 'message-after' }
  ]
  const rows = projectHistoryWithRuntime(
    [
      { kind: 'user', role: 'user', text: 'search it', turn_id: turnId, item_id: 'user-durable' },
      { kind: 'text', role: 'assistant', text: '这是结果。', turn_id: turnId, item_id: 'message-after' }
    ],
    current
  )

  assert.deepEqual(rows.map((item) => [item.kind, item.itemId]), [
    ['user', 'user-live'],
    ['agent', 'message-before'],
    ['web_search', 'search-1'],
    ['agent', 'message-after']
  ])
  assert.deepEqual(
    rows.filter((item) => item.kind === 'agent').map((item) => item.text),
    ['我先查一下。', '这是结果。']
  )
})

test('keeps a typed terminal runtime outcome across the idle history refresh', () => {
  const rows = projectHistoryWithRuntime(
    [
      { kind: 'user', role: 'user', text: 'keep working', turn_id: 'turn-interrupted' }
    ],
    [
      {
        kind: 'status',
        text: '本轮因 Codex App Server 退出而中断，书深未自动重放；可以继续下一轮。',
        tone: 'tension',
        retainOnHistoryRefresh: true,
        turnId: 'turn-interrupted'
      }
    ]
  )

  assert.deepEqual(rows.map((item) => item.kind), ['user', 'status'])
  assert.equal(rows[1]?.kind === 'status' ? rows[1].retainOnHistoryRefresh : false, true)
})

test('keeps an interrupted turn status below its replayed tool activity', () => {
  const turnId = 'turn-interrupted'
  const rows = projectActivityEvents(
    [
      { kind: 'user', text: 'read it', turnId },
      {
        kind: 'status',
        text: '已停止',
        retainOnHistoryRefresh: true,
        turnId,
        eventSeq: 3
      }
    ],
    [
      {
        v: 2,
        seq: 1,
        ts: 1,
        type: 'tool_started',
        session_id: 'session',
        turn_id: turnId,
        item_id: 'tool-item',
        data: { tool_id: 'tool-1', name: 'read', input: { path: 'report.md' } }
      },
      {
        v: 2,
        seq: 2,
        ts: 2,
        type: 'tool_completed',
        session_id: 'session',
        turn_id: turnId,
        item_id: 'tool-item',
        data: { tool_id: 'tool-1', name: 'read', output: 'done', success: true }
      }
    ]
  )

  assert.deepEqual(rows.map((item) => item.kind), ['user', 'tool', 'status'])
})

test('keeps an abandoned permission turn before the next completed turn', () => {
  const permissionUser: ConvItem = {
    kind: 'user',
    text: 'run outside workspace',
    turnId: 'client-permission',
    itemId: 'client-permission'
  }
  const followupUser: ConvItem = {
    kind: 'user',
    text: 'continue',
    turnId: 'client-followup',
    itemId: 'client-followup'
  }
  const followupAnswer: ConvItem = {
    kind: 'agent',
    text: 'continued',
    turnId: 'vendor-followup'
  }
  const rows = projectHistoryWithRuntime(
    [
      { kind: 'user', role: 'user', text: permissionUser.text, turn_id: permissionUser.turnId, item_id: permissionUser.itemId },
      { kind: 'user', role: 'user', text: followupUser.text, turn_id: followupUser.turnId, item_id: followupUser.itemId },
      { kind: 'text', role: 'assistant', text: followupAnswer.text, turn_id: followupAnswer.turnId }
    ],
    [
      permissionUser,
      { kind: 'tool', toolId: 'tool-1', name: 'bash', status: 'error', turnId: 'vendor-permission' },
      {
        kind: 'hil',
        requestId: 'request-1',
        hilKind: 'permission',
        hilState: 'resolved',
        resolved: '已拒绝',
        turnId: 'vendor-permission'
      },
      followupUser,
      followupAnswer
    ]
  )
  assert.deepEqual(rows.map((item) => `${item.kind}:${item.turnId}`), [
    'user:client-permission',
    'tool:vendor-permission',
    'hil:vendor-permission',
    'user:client-followup',
    'agent:vendor-followup'
  ])
})

test('binds only the causally matched latest optimistic user bubble', () => {
  const current: ConvItem[] = [
    { kind: 'user', text: 'old', turnId: 'turn-old' },
    { kind: 'agent', text: 'old answer', turnId: 'turn-old' },
    { kind: 'user', text: 'new' }
  ]
  const bound = bindSubmittedTurn(current, 'turn-new')
  assert.equal(bound[0].turnId, 'turn-old')
  assert.equal(bound[2].turnId, 'turn-new')
})

test('binds the submitted turn to its client message instead of a later draft', () => {
  const current: ConvItem[] = [
    { kind: 'user', text: 'submitted', itemId: 'client-submitted' },
    { kind: 'user', text: 'later', itemId: 'client-later' }
  ]
  const bound = bindSubmittedTurn(current, 'turn-submitted', 'client-submitted')

  assert.equal(bound[0].turnId, 'turn-submitted')
  assert.equal(bound[1].turnId, undefined)
})

test('places a published artifact after its final answer and de-duplicates replays', () => {
  const conversation: ConvItem[] = [
    { kind: 'user', text: 'make report', turnId: 'turn-1' },
    { kind: 'tool', toolId: 'tool-1', name: 'artifact.publish', status: 'done', turnId: 'turn-1' },
    { kind: 'agent', text: 'finished', turnId: 'turn-1' }
  ]
  const artifact = {
    artifact_id: 'artifact-1',
    path: 'report.md',
    name: 'report.md',
    role: 'final' as const,
    vendor_turn_id: 'turn-1',
    vendor_item_id: 'tool-1'
  }
  const once = upsertConversationArtifact(conversation, artifact)
  const replayed = upsertConversationArtifact(once, artifact)
  assert.deepEqual(replayed.map((item) => item.kind), ['user', 'tool', 'agent', 'artifact'])
  assert.equal(replayed.filter((item) => item.kind === 'artifact').length, 1)
})

test('same-path publications and working files retain independent identities on replay', () => {
  const base: ConvItem[] = [
    { kind: 'agent', text: 'first', turnId: 'turn-1' },
    { kind: 'agent', text: 'second', turnId: 'turn-2' }
  ]
  const shared = { path: 'report.md', name: 'report.md' }
  const restored = projectArtifactSnapshot(base, [
    { ...shared, artifact_id: 'v1', role: 'final', vendor_turn_id: 'turn-1' },
    { ...shared, artifact_id: 'v2', role: 'supporting', vendor_turn_id: 'turn-2' },
    { ...shared, artifact_id: 'working', role: 'intermediate', vendor_turn_id: 'turn-2' }
  ])
  const updated = upsertConversationArtifact(restored, {
    ...shared, artifact_id: 'working', role: 'intermediate', vendor_turn_id: 'turn-2', size: 30
  })
  const files = updated.filter((item) => item.kind === 'artifact')
  assert.deepEqual(files.map((item) => item.artifact.artifact_id), ['v1', 'v2', 'working'])
  assert.equal(files[0].turnId, 'turn-1')
})

test('restores authoritative artifact snapshot into its durable turn after restart', () => {
  const history = projectHistory([
    { kind: 'user', role: 'user', text: 'build files', turn_id: 'turn-2' },
    { kind: 'text', role: 'assistant', text: 'done', turn_id: 'turn-2' }
  ])
  const restored = projectArtifactSnapshot(history, [{
    artifact_id: 'artifact-2',
    path: 'result.csv',
    name: 'result.csv',
    saved_to: 'resources/results/result.csv',
    role: 'final',
    vendor_turn_id: 'turn-2',
    vendor_item_id: 'tool-2'
  }])
  assert.deepEqual(restored.map((item) => item.kind), ['user', 'agent', 'artifact'])
  const artifact = restored.find((item) => item.kind === 'artifact')
  assert.equal(artifact?.kind === 'artifact' ? artifact.artifact.saved_to : undefined,
    'resources/results/result.csv')
})


test('answer model snapshots survive history and remain scoped to each live item', () => {
  const first = { provider_id: 'one', provider_label: 'Service One', provider_preset_id: 'dashscope', model_id: 'selected', actual_model_id: 'actual' }
  const second = { provider_id: 'two', provider_label: 'Service Two', model_id: 'fallback', actual_model_id: '' }
  const live = projectStreamDelta([], 'agent', 'A', 'turn-a', 'item-a', true, 1, first)
  const both = projectStreamDelta(live, 'agent', 'B', 'turn-b', 'item-b', true, 2, second)
  assert.deepEqual(both.filter((row) => row.kind === 'agent').map((row) => row.modelRun), [first, second])
  const restored = projectHistory([
    { kind: 'text', role: 'assistant', text: 'A', turn_id: 'turn-a', item_id: 'item-a', model_run: first },
    { kind: 'text', role: 'assistant', text: 'B', turn_id: 'turn-b', item_id: 'item-b', model_run: second },
    { kind: 'text', role: 'assistant', text: 'Legacy', turn_id: 'old', item_id: 'old' }
  ])
  assert.deepEqual(restored.filter((row) => row.kind === 'agent').map((row) => row.modelRun), [first, second, undefined])
})


test('durable message anchors restore answer models when native history omits or renumbers the answer', () => {
  const model = { provider_id: 'provider-a', provider_label: 'Provider A', provider_preset_id: 'openai', model_id: 'selected-a', actual_model_id: 'actual-a' }
  const events: ProductEvent[] = [{ v: 2, seq: 2, ts: 1, type: 'message_delta', session_id: 's', turn_id: 't', item_id: 'original', data: { delta: 'answer', phase: 'final_answer', model_run: model } }]
  const recreated = projectActivityEvents([], events)
  assert.equal(recreated[0].kind, 'agent')
  if (recreated[0].kind === 'agent') assert.deepEqual(recreated[0].modelRun, model)
  const rebound = projectActivityEvents([{ kind: 'agent', text: 'answer', turnId: 't', itemId: 'renumbered' }], events)
  assert.equal(rebound.length, 1)
  if (rebound[0].kind === 'agent') assert.deepEqual(rebound[0].modelRun, model)
})

test('provider failure replay deduplicates reconstructed descriptors and legacy cards', () => {
  const event = {
    v: 2 as const, seq: 12, ts: 2, type: 'turn_failed' as const,
    session_id: 'session', turn_id: 'quota-turn',
    data: { code: 'insufficient_quota', message: 'quota exhausted', retryable: true }
  }
  const projected = projectActivityEvents([], [event])
  const restored = JSON.parse(JSON.stringify(projected)) as ConvItem[]
  assert.deepEqual(projectActivityEvents(restored, [event]), restored)
  const legacy: ConvItem[] = [{ kind: 'error', turnId: 'quota-turn', title: '回答生成失败', message: '模型分配额度已用完。', action: '旧建议' }]
  assert.deepEqual(projectActivityEvents(legacy, [event]), legacy)
  const nextTurn = { ...event, turn_id: 'other-turn' }
  assert.equal(projectActivityEvents(restored, [nextTurn]).length, 2)
})

test('projectAssistantContextRefs maps panel refs for the optimistic bubble', () => {
  const refs: AssistantContextRef[] = [
    {
      ref_id: 'session-ref',
      kind: 'session',
      source_id: 'source-session',
      label: '会话 A',
      label_fallback: 'untitled_session',
      retention: 'session',
      origin: 'explicit'
    },
    {
      ref_id: 'submitted-ref',
      kind: 'selection',
      source_id: 'resources/a.docx',
      label: 'a.docx',
      selection_source_label: '原文标题',
      source_revision: 'rev-1',
      retention: 'next_turn',
      origin: 'explicit',
      anchor: {
        locator: { kind: 'text', start_line: 1, start_column: 0, end_line: 1, end_column: 4 },
        selected_text_hash: 'hash',
        preview_text: '片段'
      }
    }
  ]
  assert.deepEqual(projectAssistantContextRefs(refs, ['submitted-ref']), [
    {
      type: 'assistant_context',
      id: 'session-ref',
      title: '会话 A',
      kind: 'session',
      sourceId: 'source-session',
      label_fallback: 'untitled_session'
    }
  ])
  assert.deepEqual(projectAssistantContextRefs(refs, []), [
    {
      type: 'assistant_context',
      id: 'session-ref',
      title: '会话 A',
      kind: 'session',
      sourceId: 'source-session',
      label_fallback: 'untitled_session'
    },
    {
      type: 'assistant_context',
      id: 'submitted-ref',
      title: 'a.docx',
      kind: 'selection',
      sourceId: 'resources/a.docx',
      selection_source_label: '原文标题',
      sourceRevision: 'rev-1',
      anchor: {
        previewText: '片段',
        locator: { kind: 'text', start_line: 1, start_column: 0, end_line: 1, end_column: 4 }
      }
    }
  ])
})
