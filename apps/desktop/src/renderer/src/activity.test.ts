import assert from 'node:assert/strict'
import test from 'node:test'

import type { ConvItem, SessionArtifact } from './model.ts'
import type { ActivityRow } from './activity.ts'
import {
  answerInteractionCapabilities,
  subagentActivityItem,
  visibleThinkingItem,
  activityDisclosureOpen,
  activityIdentity,
  activityRows,
  activityRunState,
  artifactCardVisible,
  cardArtifactIds,
  hasVisibleTurnProgress,
  workingIndicatorVisible,
} from './activity.ts'

const childActivity: Extract<ConvItem, { kind: 'native_activity' }> = {
  kind: 'native_activity',
  activityId: 'child',
  activityType: 'subagent_activity',
  category: 'collaboration',
  status: 'running',
  nativeStatus: 'running',
  details: {},
  turnId: 'parent-turn',
}
const childCommand = {
  itemId: 'command',
  activity: 'command',
  phase: 'started',
  observedAt: 1000,
  eventSeq: 1,
  tool: { name: 'bash', input: { command: 'pwd' } },
}

test('child tools share main activity shape, identity and explicit result status', () => {
  const running = subagentActivityItem(childCommand, childActivity)
  assert.equal(running?.kind, 'tool')
  if (running?.kind !== 'tool') return
  assert.equal(running.toolId, 'child:command')
  assert.equal(running.status, 'running')
  assert.deepEqual(running.input, { command: 'pwd' })
  for (const ok of [true, false]) {
    const completed = subagentActivityItem(
      {
        ...childCommand,
        phase: 'completed',
        completedAt: 2500,
        tool: { ...childCommand.tool, ok, output: 'result', status: ok ? 'completed' : 'failed' },
      },
      childActivity
    )
    assert.equal(completed?.kind, 'tool')
    if (completed?.kind !== 'tool') return
    assert.equal(completed.status, ok ? 'done' : 'error')
    assert.equal(completed.result, 'result')
    assert.equal(completed.completedAt, 2500)
  }
})

test('parent completion never fabricates child tool success', () => {
  const abandoned = subagentActivityItem(childCommand, {
    ...childActivity,
    status: 'done',
    completedAt: 3000,
  })
  assert.equal(abandoned?.kind, 'tool')
  if (abandoned?.kind !== 'tool') return
  assert.equal(abandoned.status, 'cancelled')
  assert.equal(abandoned.completedAt, 3000)
})

test('child reasoning exposes only supplied public summary and empty markers stay absent', () => {
  const reasoning = {
    ...childCommand,
    tool: undefined,
    activity: 'reasoning',
    summary: '**Public** summary',
  }
  const item = subagentActivityItem(reasoning, childActivity)
  assert.equal(item?.kind, 'thinking')
  if (item?.kind !== 'thinking') return
  assert.equal(item.text, '**Public** summary')
  assert.equal(item.completed, false)
  assert.equal(subagentActivityItem({ ...reasoning, summary: undefined }, childActivity), null)
  assert.equal(
    subagentActivityItem({ ...reasoning, activity: 'message', summary: undefined }, childActivity),
    null
  )
})

test('legacy combined command summaries are not reinterpreted as structured tools', () => {
  assert.equal(
    subagentActivityItem(
      { ...childCommand, tool: undefined, summary: 'pwd\n\n/workspace\n\nexit_code=0' },
      childActivity
    ),
    null
  )
})

test('answered HIL restores working until a live activity or answer arrives', () => {
  const turnId = 'active-turn'
  const outcomes = { [turnId]: 'running' as const }
  const history: ConvItem[] = [
    { kind: 'tool', toolId: 'read', name: 'read', status: 'done', turnId },
    { kind: 'hil', requestId: 'question', hilKind: 'user_input', resolved: 'answered', turnId },
  ]
  const visible = (items: ConvItem[]) =>
    hasVisibleTurnProgress(activityRows(items, outcomes), turnId)
  assert.equal(visible(history), false)
  assert.equal(workingIndicatorVisible(true, false, 0, visible(history)), true)
  assert.equal(workingIndicatorVisible(true, false, 1, visible(history)), false)
  assert.equal(workingIndicatorVisible(false, false, 0, visible(history)), false)
  assert.equal(
    visible([...history, { kind: 'thinking', text: 'Considering options', turnId }]),
    true
  )
  assert.equal(
    visible([
      ...history,
      { kind: 'tool', toolId: 'next', name: 'read', status: 'running', turnId },
    ]),
    true
  )
  assert.equal(visible([...history, { kind: 'agent', text: 'Answer', turnId }]), true)
  assert.equal(visible([...history, { kind: 'agent', text: '', turnId }]), false)
  assert.equal(
    visible([...history, { kind: 'thinking', text: 'Another turn', turnId: 'old-turn' }]),
    false
  )
  assert.equal(hasVisibleTurnProgress(activityRows(history, outcomes)), false)
})

test('all card snapshots retain their evidence identities after a later card supersedes them', () => {
  const items: ConvItem[] = [
    {
      kind: 'display_card',
      card: {
        cardId: 'search',
        type: 'literature-search',
        content: { report: { artifact_id: 'search-report' } },
      },
      turnId: 'search-turn',
    },
    {
      kind: 'artifact',
      artifact: publishedArtifact({
        artifact_id: 'search-report',
        path: 'search/round-001/report.md',
        name: 'report.md',
      }),
      turnId: 'search-turn',
    },
    {
      kind: 'display_card',
      card: {
        cardId: 'selection',
        type: 'literature-search',
        content: { report: { artifact_id: 'selection-report' } },
      },
      turnId: 'selection-turn',
    },
    {
      kind: 'artifact',
      artifact: publishedArtifact({
        artifact_id: 'selection-report',
        path: 'search/round-001/report.md',
        name: 'report.md',
      }),
      turnId: 'selection-turn',
    },
    {
      kind: 'artifact',
      artifact: publishedArtifact({
        artifact_id: 'final-report',
        path: 'final_report.md',
        name: 'final_report.md',
      }),
      turnId: 'final-turn',
    },
  ]
  const referenced = cardArtifactIds(items, (card) => {
    const report = card.content.report
    return report &&
      typeof report === 'object' &&
      'artifact_id' in report &&
      typeof report.artifact_id === 'string'
      ? [report.artifact_id]
      : []
  })
  assert.deepEqual([...referenced], ['search-report', 'selection-report'])
  const visible = activityRows(
    items.filter((item) => item.kind !== 'artifact' || !referenced.has(item.artifact.artifact_id))
  )
  assert.deepEqual(
    visible.flatMap((row) =>
      row.kind === 'artifacts' ? row.items.map((item) => item.artifact.artifact_id) : []
    ),
    ['final-report']
  )
})

test('the latest reasoning stays visible after item completion until execution advances', () => {
  const thinking = { kind: 'thinking', text: 'Checking evidence', itemId: 'reasoning-1' } as const
  assert.equal(visibleThinkingItem([thinking], true, true), thinking)
  const completed = { ...thinking, completed: true }
  assert.equal(visibleThinkingItem([completed], true, true), completed)
  assert.equal(visibleThinkingItem([completed], false, true), undefined)
  assert.equal(visibleThinkingItem([completed], true, false), undefined)
  assert.equal(visibleThinkingItem([], true, true), undefined)
  const tool = { kind: 'tool', toolId: 'tool-1', name: 'search', status: 'running' } as const
  assert.equal(visibleThinkingItem([completed, tool], true, true), undefined)
  const continuation = { ...thinking, itemId: 'reasoning-2', text: 'Comparing results' }
  assert.equal(
    visibleThinkingItem([completed, { ...tool, status: 'done' }, continuation], true, true),
    continuation
  )
})

test('reasoning disclosure follows activity unless the user explicitly chooses', () => {
  assert.equal(activityDisclosureOpen(null, true), true)
  assert.equal(activityDisclosureOpen(null, false), false)
  for (const active of [true, false]) {
    assert.equal(activityDisclosureOpen(false, active), false)
    assert.equal(activityDisclosureOpen(true, active), true)
  }
})

test('reasoning identity stays stable as streamed text grows', () => {
  const thinking = { kind: 'thinking', text: 'Checking', eventSeq: 7 } as const
  assert.equal(activityIdentity(thinking, 0), 7)
  assert.equal(activityIdentity({ ...thinking, text: 'Checking evidence' }, 0), 7)
  assert.equal(activityIdentity({ ...thinking, itemId: 'reasoning-1' }, 0), 'reasoning-1')
  assert.equal(activityIdentity({ kind: 'thinking', text: 'Legacy' }, 2), 2)
})

function publishedArtifact(artifact: SessionArtifact): SessionArtifact {
  return {
    role: 'final',
    publication_id: artifact.artifact_id,
    ...artifact,
  }
}

test('keeps answer selection available while limiting citations to settled turns', () => {
  assert.deepEqual(answerInteractionCapabilities(undefined), {
    citationEnabled: true,
    selectionEnabled: true,
  })
  assert.deepEqual(answerInteractionCapabilities('completed'), {
    citationEnabled: true,
    selectionEnabled: true,
  })
  for (const outcome of ['failed', 'interrupted', 'unknown'] as const) {
    assert.deepEqual(answerInteractionCapabilities(outcome), {
      citationEnabled: true,
      selectionEnabled: true,
    })
  }
  assert.deepEqual(answerInteractionCapabilities('running'), {
    citationEnabled: false,
    selectionEnabled: true,
  })
})

test('keeps the working indicator visible through admission and execution', () => {
  assert.equal(workingIndicatorVisible(false, true, 0), true)
  assert.equal(workingIndicatorVisible(true, false, 0), true)
  assert.equal(workingIndicatorVisible(false, false, 0), false)
  assert.equal(workingIndicatorVisible(true, true, 1), false)
  assert.equal(workingIndicatorVisible(true, false, 0, true), false)
})

test('an individual tool failure does not become a turn failure', () => {
  assert.equal(activityRunState('completed', false), 'completed')
  assert.equal(activityRunState(undefined, false), 'completed')
  assert.equal(activityRunState('failed', false), 'failed')
  assert.equal(activityRunState('failed', false, true), 'completed')
  assert.equal(activityRunState('interrupted', false, true), 'completed')
  assert.equal(activityRunState('interrupted', false), 'interrupted')
})

test('a running turn keeps only its live tail group running', () => {
  // Settled groups earlier in the same running turn freeze on their own result.
  assert.equal(activityRunState('running', false, true, false), 'completed')
  assert.equal(activityRunState('running', false, false, false), 'completed')
  // The tail group stays live while the turn runs, even without item status.
  assert.equal(activityRunState('running', false, false, true), 'running')
  assert.equal(activityRunState('running', false, true, true), 'running')
  // A group whose own item is still running stays live even when not the tail.
  assert.equal(activityRunState('running', true, false, false), 'running')
})

test('marks only the turn group that can still receive activity as live tail', () => {
  const isActivity = (row: ActivityRow): row is Extract<ActivityRow, { kind: 'activity' }> =>
    row.kind === 'activity'
  const rows = activityRows(
    [
      { kind: 'user', text: 'two stages', turnId: 'turn-1' },
      { kind: 'thinking', text: 'stage one', turnId: 'turn-1' },
      { kind: 'tool', toolId: 'tool-1', name: 'shell', status: 'done', turnId: 'turn-1' },
      { kind: 'agent', text: 'stage one done', turnId: 'turn-1' },
      { kind: 'thinking', text: 'stage two', turnId: 'turn-1' },
      { kind: 'tool', toolId: 'tool-2', name: 'write', status: 'running', turnId: 'turn-1' },
    ],
    { 'turn-1': 'running' }
  )
  const groups = rows.filter(isActivity)
  assert.deepEqual(
    groups.map((group) => group.tail),
    [false, true]
  )

  // A group closed by the turn's final answer can no longer receive activity.
  const closed = activityRows(
    [
      { kind: 'tool', toolId: 'tool-3', name: 'shell', status: 'done', turnId: 'turn-2' },
      { kind: 'agent', text: 'final answer', turnId: 'turn-2' },
    ],
    { 'turn-2': 'running' }
  )
  assert.deepEqual(
    closed.filter(isActivity).map((group) => group.tail),
    [false]
  )
})

test('groups internal thinking with tools while preserving user-facing commentary', () => {
  const items: ConvItem[] = [
    { kind: 'user', text: 'run', turnId: 'turn-1' },
    { kind: 'thinking', text: 'plan', turnId: 'turn-1' },
    { kind: 'tool', toolId: 'tool-1', name: 'shell', status: 'done', turnId: 'turn-1' },
    {
      kind: 'web_search',
      searchId: 'search-1',
      status: 'done',
      query: 'Codex',
      action: { type: 'search' },
      results: [],
      resultCount: 0,
      turnId: 'turn-1',
    },
    {
      kind: 'paper_search',
      searchId: 'paper-search-1',
      status: 'done',
      query: 'agent memory',
      turnId: 'turn-1',
    },
    {
      kind: 'skill',
      skillId: 'skill-1',
      name: 'literature-search',
      path: '/skills/literature-search/SKILL.md',
      status: 'done',
      nativeStatus: 'completed',
      turnId: 'turn-1',
    },
    {
      kind: 'native_activity',
      activityId: 'native-1',
      activityType: 'subagent_activity',
      category: 'collaboration',
      status: 'done',
      nativeStatus: 'completed',
      details: { agent_path: 'worker' },
      turnId: 'turn-1',
    },
    {
      kind: 'hil',
      requestId: 'hil-1',
      hilKind: 'permission',
      hilState: 'resolved',
      turnId: 'turn-1',
    },
    { kind: 'thinking', text: '向用户说明下一步', commentary: true, turnId: 'turn-1' },
    { kind: 'thinking', text: 'continue', turnId: 'turn-1' },
    { kind: 'tool', toolId: 'tool-2', name: 'write', status: 'done', turnId: 'turn-1' },
    { kind: 'agent', text: 'done', turnId: 'turn-1' },
  ]
  const rows = activityRows(items)
  assert.deepEqual(
    rows.map((row) => row.kind),
    ['item', 'activity', 'item', 'item', 'activity', 'item']
  )
  const firstActivity = rows[1]
  assert.equal(firstActivity.kind, 'activity')
  if (firstActivity.kind === 'activity') {
    assert.deepEqual(
      firstActivity.items.map((item) => item.kind),
      ['thinking', 'tool', 'web_search', 'paper_search', 'skill', 'native_activity']
    )
  }
  assert.equal(rows[2].kind === 'item' ? rows[2].item.kind : '', 'hil')
  assert.equal(rows[3].kind === 'item' ? rows[3].item.kind : '', 'thinking')
  const secondActivity = rows[4]
  assert.equal(secondActivity.kind, 'activity')
  if (secondActivity.kind === 'activity') {
    assert.deepEqual(
      secondActivity.items.map((item) => item.kind),
      ['thinking', 'tool']
    )
  }
  assert.equal(rows[5].kind === 'item' ? rows[5].item.kind : '', 'agent')
})

test('places a terminal failure below late same-turn reasoning', () => {
  const rows = activityRows(
    [
      { kind: 'user', text: 'answer exactly', turnId: 'failed-turn' },
      {
        kind: 'error',
        title: 'failed',
        message: 'blocked',
        action: 'retry',
        turnId: 'failed-turn',
      },
      { kind: 'thinking', text: 'provider retry', turnId: 'failed-turn', itemId: 'reasoning-1' },
      { kind: 'user', text: 'next question', turnId: 'next-turn' },
    ],
    { 'failed-turn': 'failed' }
  )

  assert.deepEqual(
    rows.map((row) =>
      row.kind === 'item' ? [row.item.turnId, row.item.kind] : [row.turnId, row.kind]
    ),
    [
      ['failed-turn', 'user'],
      ['failed-turn', 'activity'],
      ['failed-turn', 'error'],
      ['next-turn', 'user'],
    ]
  )
})

test('keeps final artifacts visible as one turn-owned group outside collapsed activity', () => {
  const items: ConvItem[] = [
    { kind: 'user', text: 'analyze', turnId: 'turn-artifact' },
    { kind: 'thinking', text: 'checking', turnId: 'turn-artifact' },
    { kind: 'tool', toolId: 'tool-1', name: 'shell', status: 'done', turnId: 'turn-artifact' },
    { kind: 'agent', text: 'complete', turnId: 'turn-artifact' },
    {
      kind: 'artifact',
      turnId: 'turn-artifact',
      artifact: publishedArtifact({
        artifact_id: 'artifact-1',
        path: 'report.md',
        name: 'report.md',
        vendor_turn_id: 'turn-artifact',
      }),
    },
    {
      kind: 'artifact',
      turnId: 'turn-artifact',
      artifact: publishedArtifact({
        artifact_id: 'artifact-2',
        path: 'data.csv',
        name: 'data.csv',
        vendor_turn_id: 'turn-artifact',
      }),
    },
  ]
  const rows = activityRows(items)
  assert.deepEqual(
    rows.map((row) => row.kind),
    ['item', 'activity', 'item', 'artifacts']
  )
  const artifacts = rows[3]
  assert.equal(artifacts.kind, 'artifacts')
  if (artifacts.kind === 'artifacts') assert.equal(artifacts.items.length, 2)
})

test('shows only the latest card for duplicate normalized artifact paths', () => {
  const rows = activityRows([
    { kind: 'agent', text: 'complete', turnId: 'turn-artifact' },
    {
      kind: 'artifact',
      turnId: 'turn-artifact',
      artifact: publishedArtifact({
        artifact_id: 'old-summary',
        path: './output/summary.md',
        name: 'summary.md',
        source_event_seq: 4,
        sha256: 'same-content',
      }),
    },
    {
      kind: 'artifact',
      turnId: 'turn-artifact',
      artifact: publishedArtifact({
        artifact_id: 'new-summary',
        path: 'output\\summary.md',
        name: 'summary.md',
        source_event_seq: 8,
        sha256: 'same-content',
      }),
    },
  ])
  const artifacts = rows.find((row) => row.kind === 'artifacts')
  assert.equal(artifacts?.kind, 'artifacts')
  if (artifacts?.kind === 'artifacts') {
    assert.deepEqual(
      artifacts.items.map((item) => item.artifact.artifact_id),
      ['new-summary']
    )
  }
})

test('shows generic Agent artifact cards only for published deliverables with configured suffixes', () => {
  assert.equal(
    artifactCardVisible(
      publishedArtifact({ artifact_id: 'markdown', path: 'REPORT.MD', name: 'REPORT.MD' })
    ),
    true
  )
  assert.equal(
    artifactCardVisible({
      artifact_id: 'working',
      path: 'working.md',
      name: 'working.md',
      role: 'intermediate',
    }),
    false
  )
  assert.equal(
    artifactCardVisible({
      artifact_id: 'unpublished',
      path: 'report.md',
      name: 'report.md',
      role: 'final',
    }),
    false
  )
  assert.equal(
    artifactCardVisible(
      publishedArtifact({ artifact_id: 'json', path: 'references.json', name: 'references.json' })
    ),
    false
  )
  assert.equal(
    artifactCardVisible(
      publishedArtifact({ artifact_id: 'unknown', path: 'result.custom', name: 'result.custom' })
    ),
    false
  )
  assert.equal(
    artifactCardVisible(
      publishedArtifact({ artifact_id: 'extensionless', path: 'RESULT', name: 'RESULT' })
    ),
    false
  )
  assert.equal(
    artifactCardVisible(
      publishedArtifact({ artifact_id: 'empty', path: '01_err.txt', name: '01_err.txt', size: 0 })
    ),
    false
  )
  assert.equal(
    artifactCardVisible(
      publishedArtifact({ artifact_id: 'sized', path: 'report.md', name: 'report.md', size: 12 })
    ),
    true
  )
  assert.equal(
    artifactCardVisible(
      publishedArtifact({
        artifact_id: 'supporting',
        path: 'data.csv',
        name: 'data.csv',
        role: 'supporting',
      })
    ),
    true
  )

  const rows = activityRows([
    { kind: 'agent', text: 'complete', turnId: 'turn-artifact-filter' },
    {
      kind: 'artifact',
      turnId: 'turn-artifact-filter',
      artifact: {
        artifact_id: 'card-source',
        path: 'references.card1.json',
        name: 'references.card1.json',
        role: 'intermediate',
      },
    },
    {
      kind: 'artifact',
      turnId: 'turn-artifact-filter',
      artifact: publishedArtifact({
        artifact_id: 'report',
        path: 'report.md',
        name: 'report.md',
      }),
    },
  ])

  assert.deepEqual(
    rows.map((row) => row.kind),
    ['item', 'artifacts']
  )
  const artifacts = rows[1]
  assert.equal(artifacts.kind, 'artifacts')
  if (artifacts.kind === 'artifacts') {
    assert.deepEqual(
      artifacts.items.map((item) => item.artifact.artifact_id),
      ['report']
    )
  }
})

test('keeps published deliverables from every turn after their owning turn', () => {
  const items: ConvItem[] = [
    { kind: 'user', text: 'first', turnId: 'turn-1' },
    { kind: 'agent', text: 'first done', turnId: 'turn-1' },
    {
      kind: 'artifact',
      turnId: 'turn-1',
      artifact: publishedArtifact({
        artifact_id: 'old-final',
        path: 'old.md',
        name: 'old.md',
        source_event_seq: 2,
      }),
    },
    { kind: 'user', text: 'second', turnId: 'turn-2' },
    {
      kind: 'artifact',
      turnId: 'turn-2',
      artifact: {
        artifact_id: 'latest-change',
        path: 'latest.md',
        name: 'latest.md',
        role: 'intermediate',
        source_event_seq: 9,
      },
    },
    {
      kind: 'artifact',
      turnId: 'turn-2',
      artifact: publishedArtifact({
        artifact_id: 'latest-final',
        path: 'final.md',
        name: 'final.md',
        source_event_seq: 8,
      }),
    },
    {
      kind: 'artifact',
      turnId: 'turn-2',
      artifact: {
        artifact_id: 'latest-csv',
        path: 'data.csv',
        name: 'data.csv',
        source_event_seq: 10,
      },
    },
    { kind: 'agent', text: 'second done', turnId: 'turn-2' },
    { kind: 'user', text: 'still running', turnId: 'turn-3' },
  ]

  const rows = activityRows(items, {
    'turn-1': 'completed',
    'turn-2': 'completed',
    'turn-3': 'running',
  })
  const artifactRows = rows.filter((row) => row.kind === 'artifacts')

  assert.equal(artifactRows.length, 2)
  assert.equal(artifactRows[0].turnId, 'turn-1')
  assert.equal(rows[2], artifactRows[0])
  const artifactRow = artifactRows[1]
  assert.equal(artifactRow.kind, 'artifacts')
  if (artifactRow.kind === 'artifacts') {
    assert.equal(artifactRow.turnId, 'turn-2')
    assert.deepEqual(
      artifactRow.items.map((item) => item.artifact.artifact_id),
      ['latest-final']
    )
  }
  assert.equal(rows.at(-2)?.kind, 'artifacts')
  const last = rows.at(-1)
  assert.equal(last?.kind === 'item' ? last.item.kind : '', 'user')
})

test('defers published files until their owning turn settles', () => {
  const items: ConvItem[] = [
    { kind: 'agent', text: 'partial work', turnId: 'turn' },
    {
      kind: 'artifact',
      turnId: 'turn',
      artifact: publishedArtifact({
        artifact_id: 'publication',
        path: 'report.md',
        name: 'report.md',
      }),
    },
  ]

  const running = activityRows(items, { turn: 'running' })
  assert.equal(
    running.some((row) => row.kind === 'artifacts'),
    false
  )

  for (const outcome of ['completed', 'failed', 'interrupted', 'unknown'] as const) {
    const rows = activityRows(items, { turn: outcome })
    assert.equal(rows.at(-1)?.kind, 'artifacts')
  }
})

test('does not merge same-path versions or guess ownership for turnless files', () => {
  const rows = activityRows(
    [
      {
        kind: 'artifact',
        artifact: { artifact_id: 'legacy', path: 'legacy.csv', name: 'legacy.csv' },
      },
      { kind: 'agent', text: 'done', turnId: 'turn' },
      ...['version-1', 'version-2'].map((artifact_id): ConvItem => ({
        kind: 'artifact',
        turnId: 'turn',
        artifact: publishedArtifact({
          artifact_id,
          path: 'report.md',
          name: 'report.md',
        }),
      })),
      {
        kind: 'artifact',
        turnId: 'turn',
        artifact: {
          artifact_id: 'working',
          path: 'report.md',
          name: 'report.md',
          change: 'delete',
          status: 'deleted',
        },
      },
    ],
    { turn: 'completed' }
  )
  assert.equal(rows[0].kind, 'item')
  const group = rows.at(-1)
  assert.equal(group?.kind, 'artifacts')
  if (group?.kind === 'artifacts') {
    assert.deepEqual(
      group.items.map((item) => item.artifact.artifact_id),
      ['version-1', 'version-2']
    )
  }
})

test('replaces reviewed resource artifacts with the batch card while preserving other outputs', () => {
  const rows = activityRows([
    { kind: 'agent', text: 'done', turnId: 'turn-review' },
    {
      kind: 'artifact',
      turnId: 'turn-review',
      artifact: publishedArtifact({
        artifact_id: 'managed',
        path: 'reports/managed.md',
        name: 'managed.md',
      }),
    },
    {
      kind: 'artifact',
      turnId: 'turn-review',
      artifact: publishedArtifact({
        artifact_id: 'output',
        path: 'tmp/output.xlsx',
        name: 'output.xlsx',
      }),
    },
    {
      kind: 'review',
      turnId: 'turn-review',
      review: {
        batchId: 'batch-1',
        projectId: 'project-1',
        fileIds: ['file-1'],
        reviewIds: ['review-1'],
        paths: ['reports/managed.md'],
      },
    },
  ])

  assert.deepEqual(
    rows.map((row) => row.kind),
    ['item', 'artifacts', 'item']
  )
  const artifacts = rows[1]
  assert.equal(artifacts.kind, 'artifacts')
  if (artifacts.kind === 'artifacts') {
    assert.deepEqual(
      artifacts.items.map((item) => item.artifact.artifact_id),
      ['output']
    )
  }
  assert.equal(rows[2].kind === 'item' ? rows[2].item.kind : '', 'review')
})

test('keeps same-turn resource artifacts that are outside the review batch', () => {
  const rows = activityRows([
    { kind: 'agent', text: 'done', turnId: 'turn-review-scope' },
    {
      kind: 'artifact',
      turnId: 'turn-review-scope',
      artifact: publishedArtifact({
        artifact_id: 'reviewed',
        path: 'reviewed.md',
        name: 'reviewed.md',
        saved_to: 'library/reviewed.md',
      }),
    },
    {
      kind: 'artifact',
      turnId: 'turn-review-scope',
      artifact: publishedArtifact({
        artifact_id: 'unreviewed',
        path: 'unsupported.xlsx',
        name: 'unsupported.xlsx',
        saved_to: 'library/unsupported.xlsx',
      }),
    },
    {
      kind: 'review',
      turnId: 'turn-review-scope',
      review: {
        batchId: 'batch-scoped',
        projectId: 'project',
        fileIds: ['file-reviewed'],
        reviewIds: ['review-reviewed'],
        paths: ['library/reviewed.md'],
      },
    },
  ])
  const artifacts = rows.find((row) => row.kind === 'artifacts')
  assert.equal(artifacts?.kind, 'artifacts')
  if (artifacts?.kind === 'artifacts') {
    assert.deepEqual(
      artifacts.items.map((item) => item.artifact.artifact_id),
      ['unreviewed']
    )
  }
})

test('keeps Markdown and non-Markdown publications from earlier turns', () => {
  const items: ConvItem[] = [
    { kind: 'agent', text: 'old', turnId: 'turn-1' },
    {
      kind: 'artifact',
      turnId: 'turn-1',
      artifact: publishedArtifact({ artifact_id: 'old', path: 'old.md', name: 'old.md' }),
    },
    { kind: 'agent', text: 'latest', turnId: 'turn-2' },
    {
      kind: 'artifact',
      turnId: 'turn-2',
      artifact: publishedArtifact({ artifact_id: 'csv', path: 'latest.csv', name: 'latest.csv' }),
    },
  ]

  const rows = activityRows(items, { 'turn-1': 'completed', 'turn-2': 'completed' })
  const artifactRows = rows.filter((row) => row.kind === 'artifacts')
  assert.equal(artifactRows.length, 2)
  assert.equal(artifactRows[0].kind, 'artifacts')
  if (artifactRows[0].kind === 'artifacts') {
    assert.equal(artifactRows[0].items[0].artifact.artifact_id, 'old')
    assert.equal(artifactRows[1].items[0].artifact.artifact_id, 'csv')
  }
})
