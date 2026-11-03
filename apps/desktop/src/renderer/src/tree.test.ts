import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  sessionTone,
  findSessionNode,
  upsertSessionNode,
  removeSessionNode,
  renameSessionNode,
  searchSessionTitles,
  appendSessionChildren,
  serveSessionNode,
} from './tree.ts'
import type { SessionNode } from './model.ts'
import type { ServeSession } from './api'

it('catalog projection preserves terminal failures and pauses after reload', () => {
  const row = { session_id: 'terminal', title: 'Task', mtime: 20 } as ServeSession
  assert.equal(serveSessionNode({ ...row, last_turn_status: 'failed' }, {}, null).status, 'failed')
  assert.equal(
    serveSessionNode({ ...row, last_turn_status: 'interrupted' }, {}, null).status,
    'abandon'
  )
  assert.equal(serveSessionNode({ ...row, recovery_blocked: true }, {}, null).status, 'abandon')
  assert.equal(serveSessionNode({ ...row, last_turn_status: 'completed' }, {}, null).status, 'done')
  assert.equal(serveSessionNode(row, { terminal: 20 }, null).status, 'dormant')
})

function makeNode(overrides: Partial<SessionNode> & { id: string }): SessionNode {
  return {
    title: overrides.title ?? `Session ${overrides.id}`,
    status: overrides.status ?? 'dormant',
    tone: overrides.tone ?? 'experience',
    meta: overrides.meta ?? 'test',
    createdAt: overrides.createdAt ?? 1000,
    activityAt: overrides.activityAt ?? 1000,
    openable: overrides.openable ?? true,
    children: overrides.children,
    container: overrides.container,
    ...overrides,
  }
}

describe('sessionTone', () => {
  it('returns tension for failed and abandon', () => {
    assert.equal(sessionTone('failed'), 'tension')
    assert.equal(sessionTone('abandon'), 'tension')
  })

  it('returns opinion for waiting', () => {
    assert.equal(sessionTone('waiting'), 'opinion')
  })

  it('returns experience for other statuses', () => {
    assert.equal(sessionTone('running'), 'experience')
    assert.equal(sessionTone('dormant'), 'experience')
    assert.equal(sessionTone('done'), 'experience')
  })
})

describe('findSessionNode', () => {
  const tree: SessionNode[] = [
    makeNode({ id: 'a' }),
    makeNode({ id: 'b', children: [makeNode({ id: 'c' })] }),
  ]

  it('finds top-level node', () => {
    assert.equal(findSessionNode(tree, 'a')?.id, 'a')
  })

  it('finds nested child', () => {
    assert.equal(findSessionNode(tree, 'c')?.id, 'c')
  })

  it('returns undefined for missing id', () => {
    assert.equal(findSessionNode(tree, 'z'), undefined)
  })
})

describe('upsertSessionNode', () => {
  it('prepends new node to head', () => {
    const nodes = [makeNode({ id: 'a' })]
    const result = upsertSessionNode(nodes, makeNode({ id: 'b' }))
    assert.equal(result.length, 2)
    assert.equal(result[0].id, 'b')
  })

  it('replaces existing node in place', () => {
    const nodes = [makeNode({ id: 'a', title: 'old' })]
    const result = upsertSessionNode(nodes, makeNode({ id: 'a', title: 'new' }))
    assert.equal(result.length, 1)
    assert.equal(result[0].title, 'new')
  })

  it('replaces nested child', () => {
    const nodes = [makeNode({ id: 'p', children: [makeNode({ id: 'c', title: 'old' })] })]
    const result = upsertSessionNode(nodes, makeNode({ id: 'c', title: 'updated' }))
    assert.equal(result[0].children?.[0].title, 'updated')
  })
})

describe('removeSessionNode', () => {
  it('removes top-level node', () => {
    const nodes = [makeNode({ id: 'a' }), makeNode({ id: 'b' })]
    const result = removeSessionNode(nodes, 'a')
    assert.equal(result.length, 1)
    assert.equal(result[0].id, 'b')
  })

  it('removes nested child', () => {
    const nodes = [makeNode({ id: 'p', children: [makeNode({ id: 'c' }), makeNode({ id: 'd' })] })]
    const result = removeSessionNode(nodes, 'c')
    assert.equal(result[0].children?.length, 1)
    assert.equal(result[0].children?.[0].id, 'd')
  })

  it('returns same structure when id not found', () => {
    const nodes = [makeNode({ id: 'a' })]
    const result = removeSessionNode(nodes, 'z')
    assert.equal(result.length, 1)
    assert.equal(result[0].id, 'a')
  })
})

describe('renameSessionNode', () => {
  it('renames top-level node', () => {
    const nodes = [makeNode({ id: 'old' })]
    const result = renameSessionNode(nodes, 'old', 'new')
    assert.equal(result[0].id, 'new')
  })

  it('renames nested child', () => {
    const nodes = [makeNode({ id: 'p', children: [makeNode({ id: 'old' })] })]
    const result = renameSessionNode(nodes, 'old', 'new')
    assert.equal(result[0].children?.[0].id, 'new')
  })
})

describe('searchSessionTitles', () => {
  const nodes: SessionNode[] = [
    makeNode({ id: 'a', title: 'Alpha Test', activityAt: 3000 }),
    makeNode({ id: 'b', title: 'Beta 测试', activityAt: 2000 }),
    makeNode({ id: 'c', title: 'Gamma', activityAt: 1000, container: true }),
    makeNode({ id: 'd', title: 'serve:internal', activityAt: 4000 }),
    makeNode({ id: 'e', title: '', activityAt: 5000 }),
    makeNode({
      id: 'f',
      title: 'Alpha Child',
      activityAt: 2500,
      children: [makeNode({ id: 'g', title: 'Nested Alpha', activityAt: 3500 })],
    }),
  ]

  it('returns all openable non-container sessions when query is empty', () => {
    const result = searchSessionTitles(nodes, '')
    const ids = result.map((n) => n.id)
    assert.ok(ids.includes('a'))
    assert.ok(ids.includes('b'))
    assert.ok(!ids.includes('c'), 'container excluded')
    assert.ok(!ids.includes('d'), 'serve: prefix excluded')
    assert.ok(!ids.includes('e'), 'empty title excluded')
    assert.ok(ids.includes('g'), 'nested child included')
  })

  it('filters by case-insensitive query', () => {
    const result = searchSessionTitles(nodes, 'alpha')
    assert.equal(result.length, 3)
    assert.ok(result.every((n) => n.title.toLowerCase().includes('alpha')))
  })

  it('sorts by activity descending', () => {
    const result = searchSessionTitles(nodes, '')
    for (let i = 1; i < result.length; i++) {
      assert.ok((result[i - 1].activityAt ?? 0) >= (result[i].activityAt ?? 0))
    }
  })

  it('de-duplicates by session id', () => {
    const dupes: SessionNode[] = [
      makeNode({ id: 'x', title: 'Dup', activityAt: 1000 }),
      makeNode({ id: 'x', title: 'Dup Newer', activityAt: 2000 }),
    ]
    const result = searchSessionTitles(dupes, '')
    assert.equal(result.length, 1)
    assert.equal(result[0].activityAt, 2000)
  })
})

describe('appendSessionChildren', () => {
  it('appends new children to parent', () => {
    const nodes = [makeNode({ id: 'p', children: [makeNode({ id: 'c1' })] })]
    const result = appendSessionChildren(nodes, 'p', [makeNode({ id: 'c2' })])
    assert.equal(result[0].children?.length, 2)
  })

  it('merges existing children by id', () => {
    const nodes = [makeNode({ id: 'p', children: [makeNode({ id: 'c1', title: 'old' })] })]
    const result = appendSessionChildren(nodes, 'p', [makeNode({ id: 'c1', title: 'new' })])
    assert.equal(result[0].children?.length, 1)
    assert.equal(result[0].children?.[0].title, 'new')
  })
})

describe('serveSessionNode', () => {
  it('preserves failed and interrupted outcomes regardless of read state', () => {
    for (const [outcome, expected] of [
      ['failed', 'failed'],
      ['interrupted', 'abandon'],
    ] as const) {
      const session = {
        session_id: 'terminal',
        title: 'Terminal',
        mtime: 10,
        last_turn_status: outcome,
      } as ServeSession
      assert.equal(serveSessionNode(session, {}, null).status, expected)
      assert.equal(serveSessionNode(session, { terminal: 10 }, 'terminal').status, expected)
      assert.equal(serveSessionNode({ ...session, running: true }, {}, null).status, 'running')
      assert.equal(serveSessionNode({ ...session, waiting: true }, {}, null).status, 'waiting')
    }
  })

  it('preserves a confirmed failure while recovery cleanup is blocked', () => {
    const session = {
      session_id: 'blocked',
      recovery_blocked: true,
      last_turn_status: 'failed',
      mtime: 10,
    } as ServeSession
    assert.equal(serveSessionNode(session, {}, null).status, 'failed')
  })

  it('projects running session correctly', () => {
    const session = {
      session_id: 'abc12345',
      title: 'Test Session',
      running: true,
      waiting: false,
      created_at: 1000,
      mtime: 2000,
      runtime: { model_id: 'qwen-max' },
      workdir: '/tmp/test',
    } as ServeSession
    const node = serveSessionNode(session, {}, null)
    assert.equal(node.id, 'abc12345')
    assert.equal(node.status, 'running')
    assert.equal(node.tone, 'experience')
    assert.equal(node.meta, 'qwen-max')
    assert.equal(node.pulse, 1.6)
  })

  it('marks unseen session as done', () => {
    const session = {
      session_id: 'xyz98765',
      title: 'Done Session',
      running: false,
      waiting: false,
      created_at: 1000,
      mtime: 3000,
    } as ServeSession
    const node = serveSessionNode(session, { xyz98765: 2000 }, null)
    assert.equal(node.status, 'done')
  })

  it('uses session_id prefix as fallback title', () => {
    const session = {
      session_id: 'abcdef12345',
      title: '',
      running: false,
      waiting: false,
      created_at: 1000,
    } as ServeSession
    const node = serveSessionNode(session, {}, null)
    assert.equal(node.title, 'abcdef12')
  })
})
