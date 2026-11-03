import assert from 'node:assert/strict'
import test from 'node:test'

import { artifactCardVisible } from '../../activity.ts'
import type { ConvItem, SessionArtifact } from '../../model.ts'
import { overviewArtifacts, submittedReferences } from '../../model.ts'

const artifact = (
  path: string,
  role: SessionArtifact['role'] = 'intermediate'
): SessionArtifact => ({
  artifact_id: path,
  path,
  name: path.split(/[\\/]/).at(-1)!,
  role,
  publication_id: `published-${path}`,
  change: 'update',
  status: 'available',
})

test('overview separates final and supporting publications from process files', () => {
  const working = { ...artifact('helper.py'), publication_id: undefined }
  const deleted = { ...artifact('deleted.md'), status: 'deleted' as const }
  const result = overviewArtifacts([
    artifact('data.json', 'supporting'),
    artifact('tool.py', 'final'),
    working,
    deleted,
    artifact('draft.md'),
  ])
  assert.deepEqual(
    result.outputs.map((item) => item.name),
    ['data.json', 'tool.py']
  )
  assert.deepEqual(
    result.process.map((group) => group.artifacts.map((item) => item.name)),
    [['helper.py', 'draft.md']]
  )
})

test('overview outputs match conversation cards for three delivered files', () => {
  const artifacts = [
    artifact('final_report.md', 'final'),
    artifact('paper_summaries.md', 'supporting'),
    artifact('read_report.md', 'supporting'),
    artifact('search_report.md'),
    { ...artifact('unpublished.md', 'supporting'), publication_id: undefined },
    { ...artifact('deleted.md', 'supporting'), status: 'deleted' as const },
    { ...artifact('removed.md', 'final'), change: 'delete' as const },
    { ...artifact('unclassified.md'), role: undefined },
  ]
  const result = overviewArtifacts(artifacts)
  assert.deepEqual(result.outputs, artifacts.filter(artifactCardVisible))
  assert.deepEqual(
    result.outputs.map((item) => item.name),
    ['final_report.md', 'paper_summaries.md', 'read_report.md']
  )
  assert.deepEqual(
    result.process.flatMap((group) => group.artifacts.map((item) => item.name)),
    ['search_report.md', 'unpublished.md', 'unclassified.md']
  )
})

test('overview keeps supporting publications once when merging events and file listings', () => {
  const published = artifact('analysis/read_report.md', 'supporting')
  const working = { ...published, publication_id: undefined, role: undefined }
  for (const artifacts of [
    [working, published, published],
    [published, working, published],
  ]) {
    const result = overviewArtifacts(artifacts)
    assert.deepEqual(result.outputs, [published])
    assert.deepEqual(result.process, [])
  }
})

test('process groups preserve actual directories and filenames on either platform', () => {
  const result = overviewArtifacts([
    artifact('analysis/a.md'),
    artifact('analysis/b.md'),
    artifact('data\\sample.csv'),
    artifact('draft.md'),
  ])
  assert.deepEqual(
    result.process.map((group) => group.path),
    ['analysis', 'data', '']
  )
  assert.equal(result.process[0].artifacts.length, 2)
  assert.equal(result.process[2].artifacts[0].name, 'draft.md')
})

test('empty overview keeps both collections empty', () => {
  assert.deepEqual(overviewArtifacts([]), { outputs: [], process: [] })
})

test('process display is relative to the server session workdir, without changing identity', () => {
  for (const workdir of ['/projects/p/sessions/s', 'C:\\projects\\p\\sessions\\s']) {
    const draft = {
      ...artifact('sessions/s/analysis/draft.md'),
      absolute_path: `${workdir}/analysis/draft.md`,
    }
    const result = overviewArtifacts([draft], workdir)
    assert.equal(result.process[0].path, 'analysis')
    assert.equal(result.process[0].artifacts[0], draft)
  }
})

test('references come only from submitted user messages, excluding skills and cancelled messages', () => {
  const file = { id: 'file-1', type: 'file', title: 'input.csv', kind: 'file' }
  const session = { id: 'session-1', type: 'context', title: 'Earlier task', kind: 'session' }
  const conversation: ConvItem[] = [
    { kind: 'user', text: 'one', refs: [file, { id: 'skill', type: 'skill', title: 'Skill' }] },
    { kind: 'user', text: 'cancelled', cancelled: true, refs: [session] },
    { kind: 'agent', text: 'done' },
    { kind: 'user', text: 'two', refs: [file, session] },
  ]
  assert.deepEqual(submittedReferences(conversation), [file, session])
  assert.deepEqual(submittedReferences([]), [])
})

test('submitted inputs deduplicate an object across snapshots without grouping', () => {
  const first = {
    type: 'assistant_context',
    kind: 'resource',
    sourceId: 'resources/a.md',
    id: 'a1',
    title: 'A',
    snapshotId: 'old',
  }
  const latest = { ...first, id: 'a2', snapshotId: 'new' }
  const uploaded = { type: 'file', id: 'upload', path: 'input.md', title: 'Input' }
  const literature = {
    type: 'assistant_context',
    kind: 'literature',
    id: 'paper',
    sourceId: 'paper',
    title: 'Paper',
  }
  const session = {
    type: 'assistant_context',
    kind: 'session',
    id: 'task',
    sourceId: 'task',
    title: 'Task',
  }
  const conversation: ConvItem[] = [
    { kind: 'user', text: 'first', refs: [first, uploaded, literature, session] },
    {
      kind: 'user',
      text: 'second',
      refs: [latest, { ...first, sourceId: 'resources/b.md', id: 'b', title: 'B' }],
    },
  ]
  const result = submittedReferences(conversation)
  assert.deepEqual(
    result.map((reference) => reference.title),
    ['A', 'Input', 'Paper', 'Task', 'B']
  )
  assert.equal(result[0], latest)
  assert.deepEqual(submittedReferences([]), [])
})
