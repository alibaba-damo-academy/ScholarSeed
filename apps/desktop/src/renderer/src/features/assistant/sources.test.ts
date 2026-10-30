import assert from 'node:assert/strict'
import test from 'node:test'

import { answerProjectSource, projectSource, sharedTaskSources, taskSources } from './sources.ts'
import type { ConvItem } from '../../model.ts'

test('answer paths resolve only observed resources in the owning project', () => {
  const sources = taskSources(
    [
      {
        kind: 'tool',
        toolId: 'read',
        name: 'scholarseed_bridge',
        status: 'done',
        result: JSON.stringify({
          ok: true,
          source_url: '/api/resource/raw?project=p&path=resources/项目A/calibration.md',
        }),
      },
    ],
    'p'
  )
  const project = { id: 'p', path: 'D:\\work space\\项目A' }
  for (const href of [
    'resources/项目A/calibration.md#L5',
    './resources/项目A/calibration.md',
    'D:\\work space\\项目A\\resources\\项目A\\calibration.md',
    'd:/WORK SPACE/项目A/resources/项目A/calibration.md#L5-L7',
    'resources/%E9%A1%B9%E7%9B%AEA/calibration.md#L3',
  ]) {
    assert.deepEqual(
      answerProjectSource(href, project, sources),
      {
        kind: 'resource',
        path: 'resources/项目A/calibration.md',
      },
      href
    )
  }
  for (const href of [
    'resources/项目A/missing.md',
    'D:\\other\\项目A\\resources\\项目A\\calibration.md',
    'resources/../resources/项目A/calibration.md',
    'resources/项目A/calibration.md#unknown',
    'file:///D:/work%20space/项目A/resources/项目A/calibration.md',
    'https://example.com/resources/项目A/calibration.md',
    'resources/项目A/calibration.md?project=other',
    'resources/项目A/%00calibration.md',
  ])
    assert.equal(answerProjectSource(href, project, sources), null, href)
  assert.equal(
    answerProjectSource(
      'resources/项目A/calibration.md',
      { ...project, id: 'other' },
      taskSources([], 'other')
    ),
    null
  )
  const macProject = { id: 'p', path: '/Users/research/项目A' }
  assert.deepEqual(
    answerProjectSource(
      '/Users/research/项目A/resources/项目A/calibration.md',
      macProject,
      sources
    ),
    {
      kind: 'resource',
      path: 'resources/项目A/calibration.md',
    }
  )
  assert.equal(
    answerProjectSource(
      '/users/research/项目A/resources/项目A/calibration.md',
      macProject,
      sources
    ),
    null
  )
})

test('project source links preserve encoded identities and use the current project only', () => {
  const query = new URLSearchParams({ project: 'project', path: 'resources/资料 & notes.md' })
  assert.deepEqual(projectSource(`/api/resource/raw?${query}`, 'project'), {
    kind: 'resource',
    path: 'resources/资料 & notes.md',
  })
  assert.deepEqual(projectSource('/api/v1/literatures/paper%20one?project_id=project', 'project'), {
    kind: 'literature',
    id: 'paper one',
  })
})

test('task sources include a successful automatic project read without an attached input', () => {
  const tool: Extract<ConvItem, { kind: 'tool' }> = {
    kind: 'tool',
    toolId: 'read',
    name: 'scholarseed_bridge',
    status: 'done',
    result: JSON.stringify([
      {
        type: 'inputText',
        text: JSON.stringify({
          ok: true,
          source_url: '/api/resource/raw?project=p&path=resources/calibration.md',
        }),
      },
    ]),
  }
  const conversation: ConvItem[] = [tool]
  assert.equal(taskSources(conversation, 'p')[0].title, 'calibration.md')
  assert.equal(taskSources(conversation, 'other').length, 0)
  conversation[0] = { ...tool, status: 'error' }
  assert.equal(taskSources(conversation, 'p').length, 0)
})

test('task sources flatten supported observed source kinds without treating drafts as submissions', () => {
  const conversation: ConvItem[] = [
    {
      kind: 'user',
      text: 'https://example.org/note',
      refs: [{ id: 'a', title: 'input.md', type: 'file' }],
    },
    { kind: 'tool', toolId: 'mcp', name: 'mcp__coop__query_workitem_detail', status: 'done' },
    {
      kind: 'agent',
      text: 'answer',
      answerSources: [
        {
          number: 1,
          kind: 'searched',
          url: 'https://example.org/result',
          title: 'Result',
          search_kind: 'web',
          search_id: 'search',
          citation_urls: [],
        },
      ],
    },
    { kind: 'user', text: 'https://cancelled.example', cancelled: true },
  ]
  assert.deepEqual(
    new Set(taskSources(conversation, 'p').map((source) => source.kind)),
    new Set(['file', 'external-resource', 'tool', 'web'])
  )
  assert.equal(taskSources(conversation, 'p').length, 4)
})

test('source navigation rejects foreign projects, external URLs and malformed identities', () => {
  for (const href of [
    '/api/resource/raw?project=other&path=resources/a.md',
    '/api/resource/raw?project=project&project=other&path=resources/a.md',
    '/api/resource/raw?project=project&path=../secret',
    '/api/resource/raw?project=project&path=%2Fsecret',
    '/api/resource/raw?project=project&path=C%3A%5Csecret',
    '/api/resource/raw?project=project&path=resources/a&path=resources/b',
    '/api/v1/literatures/paper?project_id=other',
    '/api/v1/literatures/a%2Fb?project_id=project',
    '/api/v1/literatures/%ZZ?project_id=project',
    'https://example.com/api/resource/raw?project=project&path=resources/a.md',
    '//example.com/api/resource/raw?project=project&path=resources/a.md',
    'outputs/report.md',
  ])
    assert.equal(projectSource(href, 'project'), null, href)
})

test('submitted and observed project files share one source and failed tools add none', () => {
  const reference = {
    id: 'ref',
    title: 'calibration.md',
    type: 'assistant_context' as const,
    kind: 'resource' as const,
    sourceId: 'resources/calibration.md',
  }
  const tool: Extract<ConvItem, { kind: 'tool' }> = {
    kind: 'tool',
    toolId: 'read',
    name: 'scholarseed_bridge',
    status: 'done',
    result: JSON.stringify({
      ok: true,
      source_url: '/api/resource/raw?project=p&path=resources/calibration.md',
    }),
  }
  assert.equal(
    taskSources([{ kind: 'user', text: 'read', refs: [reference] }, tool], 'p').length,
    1
  )
  assert.deepEqual(
    taskSources(
      [
        { ...tool, exitCode: 1 },
        { ...tool, result: JSON.stringify({ ok: false, source_url: 'https://failed.example' }) },
      ],
      'p'
    ),
    []
  )
  assert.deepEqual(
    taskSources([{ kind: 'user', text: '', cancelled: true, refs: [reference] }], 'p'),
    []
  )
})

test('tool source URLs cannot carry credentials or unsafe schemes', () => {
  const sources = taskSources(
    [
      'javascript:alert(1)',
      'https://user:password@example.org',
      '/api/resource/raw?project=other&path=secret.md',
    ].map((source_url, index) => ({
      kind: 'tool',
      toolId: String(index),
      name: 'scholarseed_bridge',
      status: 'done',
      result: JSON.stringify({ ok: true, source_url }),
    })),
    'p'
  )
  assert.deepEqual(sources, [])
})

test('unchanged completed tool output is parsed once across consumers and streaming snapshots', (context) => {
  const tool: Extract<ConvItem, { kind: 'tool' }> = {
    kind: 'tool',
    toolId: 'read',
    name: 'scholarseed_bridge',
    status: 'done',
    result: JSON.stringify({
      ok: true,
      source_url: '/api/resource/raw?project=p&path=resources/review.md',
    }),
  }
  const parse = context.mock.method(JSON, 'parse')
  for (let index = 0; index < 100; index += 1) {
    const conversation: ConvItem[] = [tool, { kind: 'thinking', text: `delta ${index}` }]
    assert.equal(taskSources(conversation, 'p')[0].title, 'review.md')
  }
  assert.equal(parse.mock.callCount(), 1)
})

test('invalid tool output is not reparsed on each conversation update', (context) => {
  const tool: Extract<ConvItem, { kind: 'tool' }> = {
    kind: 'tool',
    toolId: 'shell',
    name: 'shell',
    status: 'done',
    result: 'plain command output, not JSON',
  }
  const parse = context.mock.method(JSON, 'parse')
  assert.deepEqual(taskSources([tool], 'p'), [])
  assert.deepEqual(taskSources([tool, { kind: 'thinking', text: 'next' }], 'p'), [])
  assert.equal(parse.mock.callCount(), 1)
})

test('all consumers share sources for the same immutable conversation snapshot and project', () => {
  const conversation: ConvItem[] = [{ kind: 'user', text: 'https://example.org/paper' }]
  const sources = sharedTaskSources(conversation, 'p')
  for (let index = 0; index < 100; index += 1) {
    assert.equal(sharedTaskSources(conversation, 'p'), sources)
  }
  assert.deepEqual(sources, taskSources(conversation, 'p'))
  assert.notEqual(sharedTaskSources(conversation, 'other'), sources)
  assert.notEqual(sharedTaskSources([...conversation], 'p'), sources)
})

test('source snapshots preserve project boundaries, tool revisions, failures and history rewind', () => {
  const running: Extract<ConvItem, { kind: 'tool' }> = {
    kind: 'tool',
    toolId: 'read',
    name: 'scholarseed_bridge',
    status: 'running',
  }
  const pending: ConvItem[] = [running]
  assert.deepEqual(sharedTaskSources(pending, 'p'), [])
  const done = {
    ...running,
    status: 'done' as const,
    result: JSON.stringify({
      ok: true,
      source_url: '/api/resource/raw?project=p&path=resources/first.md',
    }),
  }
  const completed: ConvItem[] = [done]
  const sources = sharedTaskSources(completed, 'p')
  assert.equal(sources[0].title, 'first.md')
  assert.deepEqual(sharedTaskSources(completed, 'other'), [])
  const revised: ConvItem[] = [
    {
      ...done,
      result: JSON.stringify({
        ok: true,
        source_url: '/api/resource/raw?project=p&path=resources/revised.md',
      }),
    },
  ]
  assert.equal(sharedTaskSources(revised, 'p')[0].title, 'revised.md')
  assert.deepEqual(sharedTaskSources([{ ...done, status: 'error' }], 'p'), [])
  assert.deepEqual(sharedTaskSources([{ ...done, exitCode: 1 }], 'p'), [])
  assert.deepEqual(sharedTaskSources([{ ...done, result: '{"ok":false}' }], 'p'), [])
  assert.deepEqual(sharedTaskSources(pending, 'p'), [])
  assert.equal(sharedTaskSources(completed, 'p'), sources)
  assert.deepEqual(sharedTaskSources([], 'p'), [])
})

test('tool parsing cache follows changed result bytes rather than tool ID', () => {
  const tool: Extract<ConvItem, { kind: 'tool' }> = {
    kind: 'tool',
    toolId: 'same-id',
    name: 'scholarseed_bridge',
    status: 'done',
    result: '{"source_url":"https://example.org/first"}',
  }
  assert.equal(taskSources([tool], 'p')[0].url, 'https://example.org/first')
  tool.result = '{"source_url":"https://example.org/changed"}'
  assert.equal(taskSources([tool], 'p')[0].url, 'https://example.org/changed')
  assert.equal(
    taskSources([{ ...tool, result: '{"source_url":"https://example.org/other-session"}' }], 'p')[0]
      .url,
    'https://example.org/other-session'
  )
})
