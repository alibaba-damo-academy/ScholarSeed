import assert from 'node:assert/strict'
import test from 'node:test'
import type { FilesResp, ServeSession } from '../../api'
import { createOutputSearch, loadOutputPages, searchOutputPages } from './search.ts'

const sessions = [
  { session_id: 'first', title: '生成大模型报告' },
  { session_id: 'second', title: 'Other task' },
] as ServeSession[]
const directory = (path: string, names: string[], total = names.length): FilesResp => ({
  root: '/task',
  path,
  crumbs: path.split('/').filter(Boolean),
  total,
  items: names.map((name) => ({ name: name.replace(/\/$/, ''), dir: name.endsWith('/'), size: 0 })),
})

test('empty queries and task-name matches retain only groups with matching files', () => {
  const pages = new Map([
    ['first:', directory('', ['papers/'])],
    ['first:papers', directory('papers', ['report.pdf'])],
    ['second:', directory('', ['empty/'])],
    ['second:empty', directory('empty', [])],
  ])
  assert.deepEqual(searchOutputPages(sessions, pages, '').sessions, [sessions[0]])
  assert.equal(searchOutputPages(sessions, pages, '', () => false).sessions.length, 0)
  assert.equal(searchOutputPages(sessions, pages, '生成', () => false).sessions.length, 0)
  assert.deepEqual(
    searchOutputPages(sessions, pages, '', (item) => item.name.endsWith('.pdf')).sessions,
    [sessions[0]]
  )
  assert.equal(searchOutputPages(sessions, pages, 'Other task').sessions.length, 0)
})

test('search publishes all known roots before slow traversal and keeps progress snapshots immutable', async () => {
  let release!: (page: FilesResp | null) => void
  const pending = new Promise<FilesResp | null>((resolve) => {
    release = resolve
  })
  const updates: Parameters<Parameters<typeof createOutputSearch>[1]>[0][] = []
  const loader = createOutputSearch(
    () => pending,
    (result) => updates.push(result)
  )
  loader.load(
    sessions,
    new Map([
      ['first:', directory('', ['slow/', 'early.md'])],
      ['second:', directory('', ['other.md'])],
    ])
  )
  const initial = updates.at(-1)!
  assert.equal(initial.complete, false)
  assert.equal(searchOutputPages(sessions, initial.pages, 'md').sessions.length, 2)
  assert.equal(initial.pages.has('first:slow'), false)
  release(directory('slow', ['nested.md']))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(updates.at(-1)!.complete, true)
  assert.equal(updates.at(-1)!.pages.get('first:slow')!.items[0].name, 'nested.md')
  assert.equal(initial.pages.has('first:slow'), false)
  loader.cancel()
})

test('search exposes completed directory pages before later pagination and suppresses cancelled progress', async () => {
  let release!: (page: FilesResp | null) => void
  const pending = new Promise<FilesResp | null>((resolve) => {
    release = resolve
  })
  const updates: Parameters<Parameters<typeof createOutputSearch>[1]>[0][] = []
  const loader = createOutputSearch(
    () => pending,
    (result) => updates.push(result)
  )
  loader.load(sessions.slice(0, 1), new Map([['first:', directory('', ['first.md'], 2)]]))
  assert.equal(updates.at(-1)!.complete, false)
  assert.equal(searchOutputPages(sessions, updates.at(-1)!.pages, 'md').sessions.length, 1)
  const published = updates.length
  loader.cancel()
  release(directory('', ['last.md'], 2))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(updates.length, published)
})

test('search loads folded nested directories and all pages, preserving matching ancestors', async () => {
  const calls: string[] = []
  const roots = new Map([
    ['first:', directory('', ['notes.txt', 'results/'], 3)],
    ['second:', directory('', ['other.txt'])],
  ])
  const loaded = await loadOutputPages(
    sessions,
    roots,
    async (session, path, offset) => {
      calls.push(`${session}:${path}:${offset}`)
      if (!path) return directory('', ['last.csv'], 3)
      if (path === 'results') return directory(path, ['nested/', 'irrelevant.txt'])
      return directory(path, ['Pool.csv'])
    },
    () => false
  )
  assert.ok(loaded)
  assert.equal(loaded.failed, false)
  assert.deepEqual(calls, ['first::2', 'first:results:0', 'first:results/nested:0'])
  assert.equal(roots.get('first:')!.items.length, 2)
  const result = searchOutputPages(sessions, loaded.pages, ' POOL ')
  assert.deepEqual(
    result.sessions.map((session) => session.session_id),
    ['first']
  )
  assert.deepEqual([...result.pages.keys()].sort(), [
    'first:',
    'first:results',
    'first:results/nested',
  ])
  assert.deepEqual(
    result.pages.get('first:results')!.items.map((item) => item.name),
    ['nested']
  )
  assert.deepEqual(searchOutputPages(sessions, loaded.pages, '生成大模型').sessions, [sessions[0]])
  assert.equal(searchOutputPages(sessions, loaded.pages, 'absent').sessions.length, 0)
  assert.equal(
    searchOutputPages(sessions, loaded.pages, 'pool', (item) => item.name.endsWith('.pdf')).sessions
      .length,
    0
  )
})

test('unreadable directories and stalled pagination report incomplete results without hiding known matches', async () => {
  const loaded = await loadOutputPages(
    sessions,
    new Map([
      ['first:', directory('', ['pool.csv', 'denied/'], 3)],
      ['second:', directory('', ['pool.txt'])],
    ]),
    async (_session, path) => (path ? null : directory('', [], 3)),
    () => false
  )
  assert.ok(loaded?.failed)
  assert.equal(searchOutputPages(sessions, loaded.pages, 'pool').sessions.length, 2)
})

test('canonical ancestor cycles terminate and cancelled loads never publish partial results', async () => {
  let calls = 0
  const loaded = await loadOutputPages(
    sessions.slice(0, 1),
    new Map([['first:', directory('', ['loop/'])]]),
    async () => {
      calls += 1
      return directory('', ['loop/'])
    },
    () => false
  )
  assert.equal(calls, 1)
  assert.ok(loaded)
  assert.equal(loaded.pages.size, 1)
  let cancelled = false
  assert.equal(
    await loadOutputPages(
      sessions,
      new Map(),
      async () => {
        cancelled = true
        return directory('', ['pool.txt'])
      },
      () => cancelled
    ),
    null
  )
})

test('downloaded literature matches its title and remains available on task-name search', () => {
  const page = directory('', [])
  page.literature = [
    { id: 'paper', title: 'Pool paper', literature_id: 'paper', attachment_id: null },
  ]
  const pages = new Map([['first:', page]])
  assert.equal(
    searchOutputPages(sessions, pages, 'pool').pages.get('first:')!.literature!.length,
    1
  )
  assert.equal(
    searchOutputPages(sessions, pages, '生成').pages.get('first:')!.literature!.length,
    1
  )
})
