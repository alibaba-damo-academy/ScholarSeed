import assert from 'node:assert/strict'
import test from 'node:test'
import type { Project, ServeSession } from '../../api'
import { activityLabel, orderedProjects, projectActivity, recentTasks } from './catalog.ts'

test('activity labels use the prototype relative time and retain missing activity', () => {
  const format = {
    relative: (
      value: number,
      unit: Intl.RelativeTimeFormatUnit,
      options?: Intl.RelativeTimeFormatOptions
    ) => new Intl.RelativeTimeFormat('en', options).format(value, unit),
  }
  const now = 1000000000
  assert.equal(activityLabel(0, format, now), '—')
  assert.equal(activityLabel(now / 1000 - 120, format, now), '2 minutes ago')
  assert.equal(activityLabel(now / 1000 - 7200, format, now), '2 hours ago')
  assert.equal(activityLabel(now / 1000 - 172800, format, now), '2 days ago')
})

const projects: Project[] = [
  { id: 'first', name: 'First', path: '/first', added_at: 1 },
  { id: 'pinned', name: 'Pinned', path: '/pinned', pinned: true, description: 'Research' },
]
const task = (session_id: string, project_path: string, mtime: number): ServeSession =>
  ({
    session_id,
    project_path,
    mtime,
    last_agent_reply_at: mtime,
    title: session_id,
  }) as ServeSession

test('recent tasks retain old tasks and exclude unrelated tasks', () => {
  const rows = [task('old', '/first', 9), task('recent', '/first', 11), task('other', '/other', 20)]
  assert.deepEqual(
    recentTasks(projects, rows, '').map((row) => row.session_id),
    ['recent', 'old']
  )
  assert.deepEqual(recentTasks(projects, rows, 'missing'), [])
})

test('recent tasks include unanswered tasks and continued conversations in activity order', () => {
  const unanswered = {
    ...task('unanswered', '/first', 0),
    last_agent_reply_at: null,
    mtime: 100,
    created_at: 30,
  }
  const laterUser = { ...task('later-user', '/first', 50), last_agent_reply_at: 10 }
  const rows = [laterUser, unanswered, task('later-agent', '/pinned', 40)]
  assert.deepEqual(
    recentTasks(projects, rows, '').map((row) => row.session_id),
    ['unanswered', 'later-user', 'later-agent']
  )
  assert.deepEqual(
    rows.map((row) => row.session_id),
    ['later-user', 'unanswered', 'later-agent']
  )
  assert.deepEqual(
    recentTasks(projects, rows, ' FIRST ').map((row) => row.session_id),
    ['unanswered', 'later-user']
  )
})

test('recent tasks fall back to creation time and use it to break activity ties', () => {
  const rows = [
    { ...task('older', '/first', 40), created_at: 10 },
    { ...task('newer', '/first', 40), created_at: 20 },
    { ...task('created', '/first', 0), mtime: undefined, created_at: 50 },
    { ...task('missing', '/first', 0), mtime: undefined },
  ]
  assert.deepEqual(
    recentTasks(projects, rows, '').map((row) => row.session_id),
    ['created', 'newer', 'older', 'missing']
  )
})

test('project pinning precedes activity and description remains searchable', () => {
  const rows = [task('active', '/first', 100)]
  const activity = projectActivity(rows)
  assert.deepEqual(
    orderedProjects(projects, '', activity).map((project) => project.id),
    ['pinned', 'first']
  )
  assert.deepEqual(
    orderedProjects(projects, 'research', activity).map((project) => project.id),
    ['pinned']
  )
  assert.equal(activity.get('/first'), 100)
})

test('project activity uses the latest task activity with creation fallback', () => {
  const rows = [
    task('latest', '/older', 100),
    task('earlier', '/older', 10),
    { ...task('created', '/newer', 0), mtime: undefined, created_at: 50 },
  ]
  const activity = projectActivity(rows)
  assert.equal(activity.get('/older'), 100)
  assert.equal(activity.get('/newer'), 50)
  const listing = [
    { id: 'newer', name: 'Newer', path: '/newer', added_at: 20 },
    { id: 'older', name: 'Older', path: '/older', added_at: 10 },
  ]
  assert.deepEqual(
    orderedProjects(listing, '', activity).map((project) => project.id),
    ['older', 'newer']
  )
  assert.deepEqual(
    listing.map((project) => project.id),
    ['newer', 'older']
  )
  assert.deepEqual(
    orderedProjects(
      listing,
      '',
      new Map([
        ['/older', 100],
        ['/newer', 100],
      ])
    ).map((project) => project.id),
    ['newer', 'older']
  )
  assert.equal(
    orderedProjects([{ ...listing[0], pinned: true }, listing[1]], '', activity)[0].id,
    'newer'
  )
  assert.equal(orderedProjects(listing, 'OLDER', activity)[0].id, 'older')
})

test('unpinning every project restores creation order without activity regardless of unpin sequence', () => {
  const older = { id: 'older', name: 'Older', path: '/older', added_at: 10, pinned: true }
  const newer = { id: 'newer', name: 'Newer', path: '/newer', added_at: 20, pinned: true }
  for (const sequence of [
    [older.id, newer.id],
    [newer.id, older.id],
  ]) {
    let listing = [older, newer]
    for (const id of sequence) {
      listing = listing.map((project) =>
        project.id === id ? { ...project, pinned: false } : project
      )
      const remaining = listing.find((project) => project.pinned)
      if (remaining) assert.equal(orderedProjects(listing, '', new Map())[0].id, remaining.id)
    }
    assert.deepEqual(
      orderedProjects(listing, '', new Map()).map((project) => project.id),
      ['newer', 'older']
    )
    assert.deepEqual(
      listing.map((project) => project.id),
      ['older', 'newer']
    )
    assert.deepEqual(
      listing.map((project) => project.added_at),
      [10, 20]
    )
  }
})
