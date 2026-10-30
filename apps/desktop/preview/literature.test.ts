import assert from 'node:assert/strict'
import test from 'node:test'
import { PREVIEW_LITERATURE, PreviewLiterature, parsePreviewLiteratureQuery } from './literature.ts'
import type { PreviewLiteraturePolicy } from './literature.ts'

const PROJECT = { id: 'project-one', name: '模拟当前项目', archived_at: null as number | null }
const PDF = { path: 'sample.pdf', name: 'sample.pdf', size: 123, revision: 'sha256:reviewed', identity: 'file-reviewed' }
const POLICY: PreviewLiteraturePolicy = { seed: 'sample', read: 'normal', detail: 'normal', write: 'normal' }
const options = (policy: Partial<PreviewLiteraturePolicy> = {}) => ({ currentProjectId: PROJECT.id, projects: () => [PROJECT], pdf: PDF, policy: { ...POLICY, ...policy } })

test('default empty catalogue and explicit sample are independent live DTO projections', async () => {
  const empty = new PreviewLiterature({ ...options(), policy: undefined })
  assert.equal((await empty.list()).total, 0)
  assert.deepEqual(await empty.counts(), { all: 0, recent: 0, without_collection: 0, unread: 0, without_fulltext: 0 })
  const owner = new PreviewLiterature(options())
  const page = await owner.list()
  assert.equal(page.total, 3)
  assert.equal(page.page, 1)
  assert.equal(page.page_size, 50)
  assert.equal(page.next_cursor, null)
  assert.ok(page.items.every(item => item.title.startsWith('模拟文献：') && item.is_unread && item.last_read_at === null && item.read_progress === 0))
  page.items[0].title = 'consumer mutation'
  assert.ok((await owner.list()).items.every(item => item.title.startsWith('模拟文献：')))
  const next = new PreviewLiterature(options())
  assert.ok((await next.list()).items.every(item => !page.items.some(previous => previous.id === item.id)))
  empty.dispose(); owner.dispose(); next.dispose()
})

test('empty policy needs no PDF or project VFS while sample requires reviewed summary metadata', async () => {
  const empty = new PreviewLiterature({ currentProjectId: '', projects: () => [] })
  assert.equal((await empty.list()).total, 0)
  assert.deepEqual(await empty.projects(), { projects: [], current: '' })
  assert.throws(() => new PreviewLiterature({ ...options(), pdf: undefined }), { status: 422 })
  assert.throws(() => new PreviewLiterature({ ...options(), pdf: { ...PDF, size: NaN } }), { status: 422 })
  const input = { ...options(), pdf: { ...PDF }, policy: { ...POLICY } }
  const owner = new PreviewLiterature(input)
  input.policy.read = 'failed'
  input.pdf.identity = 'changed by caller'
  const item = (await owner.list()).items.find(item => item.primary_attachment?.availability === 'available')!
  assert.equal(owner.attachment(item.id, item.primary_attachment!.id).identity, PDF.identity)
  assert.equal((await owner.detail(item.id)).notes?.length, 1)
  empty.dispose(); owner.dispose()
})

test('available, missing and absent attachments share one metadata source without holding byte copies', async () => {
  const owner = new PreviewLiterature(options())
  const items = (await owner.list()).items
  const available = items.find(item => item.primary_attachment?.availability === 'available')!
  const missing = items.find(item => item.primary_attachment?.availability === 'missing')!
  assert.ok(items.some(item => item.primary_attachment === null && item.attachments.length === 0))
  const attachment = owner.attachment(available.id, available.primary_attachment!.id)
  assert.equal(attachment.path, PDF.path)
  assert.equal(attachment.revision, PDF.revision)
  assert.equal(attachment.identity, PDF.identity)
  assert.equal(attachment.summary.size, PDF.size)
  assert.deepEqual(attachment.summary.record_target, { owner: 'literature_attachment', scope_id: available.id, subject_id: attachment.summary.id })
  assert.equal('bytes' in attachment, false)
  assert.equal(owner.attachment(missing.id, missing.primary_attachment!.id).availability, 'missing')
  assert.equal(missing.primary_attachment!.size, null)
  assert.throws(() => owner.attachment(available.id, missing.primary_attachment!.id), { status: 404, code: 'literature_attachment_not_found' })
  owner.dispose()
})

test('query parsing follows declared repeated fields, ignores undeclared filters, clamps pages and rejects malformed scalars', async () => {
  const query = parsePreviewLiteratureQuery(new URLSearchParams('q=first&q=last&tag_id=a&tag_id=b&page=-2&page_size=400&recent=yes&year_from=2026&previewInstance=private'))
  assert.deepEqual(query, { q: 'last', tag_id: ['a', 'b'], page: 1, page_size: 200, recent: true })
  for (const source of ['page=bad', 'page_size=2.5', 'recent=maybe']) assert.throws(() => parsePreviewLiteratureQuery(new URLSearchParams(source)), { status: 422 })
  const owner = new PreviewLiterature(options())
  const regular = await owner.list()
  assert.deepEqual(await owner.list({ year_from: 9999, attachment: 'without_pdf', is_unread: false, item_type: ['unknown'] }), regular)
  assert.deepEqual((await owner.list({ sort: 'last_read_at', order: 'asc' })).items.map(item => item.id), [...regular.items].reverse().map(item => item.id))
  owner.dispose()
})

test('list combines descendant collection OR, tag intersection and SQL LIKE search with stable pages', async () => {
  const owner = new PreviewLiterature(options())
  const facets = await owner.facets()
  const parent = facets.collections.find(collection => collection.parent_id === null)!
  const child = facets.collections.find(collection => collection.parent_id === parent.id)!
  assert.equal((await owner.list({ collection_id: [parent.id] })).total, 2)
  assert.equal((await owner.list({ collection_id: [child.id] })).total, 1)
  const tags = facets.tags.filter(tag => tag.count > 0)
  assert.equal((await owner.list({ tag_id: tags.map(tag => tag.id) })).total, 1)
  assert.equal((await owner.list({ tag_id: [tags[0].id, tags[0].id] })).total, 0)
  assert.equal((await owner.list({ q: 'Preview%' })).total, 3)
  const first = await owner.list({ page_size: 1, sort: 'year', order: 'asc' })
  const second = await owner.list({ page: 2, page_size: 1, sort: 'year', order: 'asc' })
  assert.equal(first.total, 3)
  assert.equal(first.next_cursor, '2')
  assert.notEqual(first.items[0].id, second.items[0].id)
  assert.ok(first.items[0].year! < second.items[0].year!)
  assert.equal((await owner.list({ page: 4, page_size: 1 })).items.length, 0)
  assert.equal((await owner.list({ attachment: 'with_pdf', without_collection: true, without_project: true })).total, 1)
  owner.dispose()
})

test('counts and scoped facets use backend scope rules rather than the visible page or search text', async () => {
  const owner = new PreviewLiterature(options())
  assert.deepEqual(await owner.counts(), { all: 3, recent: 2, without_collection: 1, unread: 3, without_fulltext: 1 })
  assert.equal((await owner.counts(PROJECT.id)).all, 2)
  const facets = await owner.facets({ q: 'no result', page_size: 1 })
  assert.equal(facets.years.total, 3)
  assert.equal(facets.years.truncated, false)
  assert.equal(facets.years.entries.reduce((count, value) => count + value.count, 0), 3)
  const child = facets.collections.find(collection => collection.parent_id)!
  const scoped = await owner.tagFacets({ collection_id: [child.id], q: 'ignored', tag_id: ['ignored'] })
  assert.equal(scoped.tags.reduce((count, tag) => count + tag.count, 0), 1)
  assert.ok(scoped.tags.some(tag => tag.count === 0 && tag.total > 0))
  const projects = await owner.projects()
  assert.equal(projects.current, PROJECT.id)
  assert.equal(projects.projects[0].count, 2)
  assert.equal(projects.projects[0].collections.length, 1)
  owner.dispose()
})

test('metadata and existing relationships update the same projections without changing PDF identity', async () => {
  const owner = new PreviewLiterature(options())
  const item = (await owner.list()).items.find(item => item.primary_attachment?.availability === 'available')!
  const before = owner.attachment(item.id, item.primary_attachment!.id)
  const updated = await owner.update(item.id, { fields: { title: '模拟修改标题', authors: 'Preview Editor', year: 2020 }, collection_ids: [], tag_ids: [], project_collection_ids: [], project_ids: [] })
  assert.equal(updated.title, '模拟修改标题')
  assert.equal(updated.creators_display, 'Preview Editor')
  assert.equal(updated.year, 2020)
  assert.ok(updated.version > item.version)
  assert.deepEqual(updated.projects, [])
  assert.deepEqual(updated.collections, [])
  assert.deepEqual(updated.tags, [])
  assert.deepEqual(owner.attachment(item.id, item.primary_attachment!.id), before)
  assert.equal((await owner.projects()).projects[0].count, 1)
  assert.equal((await owner.list({ project_id: PROJECT.id })).items.some(value => value.id === item.id), false)
  await assert.rejects(owner.update(item.id, { fields: { year: '2024' } }), { status: 400, code: 'literature_library_invalid' })
  await assert.rejects(owner.update(item.id, { version: updated.version }), { status: 400 })
  await assert.rejects(owner.update(item.id, { tag_ids: ['unknown'] }), { status: 400 })
  owner.dispose()
})

test('notes have backend defaults, trimmed bodies and version CAS across the same item', async () => {
  const owner = new PreviewLiterature(options())
  const item = (await owner.list()).items.find(item => item.attachments.length === 0)!
  const note = await owner.createNote(item.id, { text: '  模拟笔记正文  ' })
  assert.equal(note.title, '笔记 1')
  assert.equal(note.text, '模拟笔记正文')
  assert.equal(note.version, 1)
  const revised = await owner.updateNote(item.id, note.id, { title: '新标题', text: '新正文', version: note.version })
  assert.equal(revised.version, 2)
  await assert.rejects(owner.updateNote(item.id, note.id, { title: '旧修改', text: '不可覆盖', version: note.version }), { status: 409, code: 'literature_note_version_conflict' })
  assert.equal((await owner.detail(item.id)).note_count, 1)
  assert.deepEqual((await owner.notes(item.id)).items, [revised])
  await assert.rejects(owner.createNote(item.id, { text: ' ' }), { status: 422, code: 'literature_note_body_required' })
  await assert.rejects(owner.updateNote(item.id, note.id, { title: ' ', text: 'body', version: 2 }), { status: 422, code: 'literature_note_title_required' })
  assert.deepEqual(await owner.deleteNote(item.id, note.id), { deleted: note.id })
  assert.deepEqual((await owner.notes(item.id)).items, [])
  await assert.rejects(owner.deleteNote(item.id, note.id), { status: 404, code: 'literature_note_not_found' })
  owner.dispose()
})

test('unknown IDs, cross-instance IDs and archived project scopes are never optimistic successes', async () => {
  const projects = [{ ...PROJECT }]
  const owner = new PreviewLiterature({ ...options(), projects: () => projects })
  const other = new PreviewLiterature(options())
  const foreign = (await other.list()).items[0]
  await assert.rejects(owner.detail(foreign.id), { status: 404, code: 'LITERATURE_NOT_FOUND' })
  await assert.rejects(owner.list({ project_id: 'foreign' }), { status: 400, code: 'unknown_project' })
  projects[0].archived_at = 1
  assert.deepEqual((await owner.projects()).projects, [])
  assert.ok((await owner.list()).items.every(item => item.projects.length === 0))
  await assert.rejects(owner.counts(PROJECT.id), { status: 400, code: 'unknown_project' })
  projects[0].archived_at = null
  assert.equal((await owner.projects()).projects[0].count, 2)
  owner.dispose(); other.dispose()
})

test('delayed overview and detail policies are independent, cancellable and bounded', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewLiterature(options({ read: 'delayed' }))
  let loaded = false
  const reading = owner.list().then(value => { loaded = true; return value })
  context.mock.timers.tick(PREVIEW_LITERATURE.delayMs - 1)
  await Promise.resolve()
  assert.equal(loaded, false)
  context.mock.timers.tick(1)
  const page = await reading
  assert.equal((await owner.detail(page.items[0].id)).id, page.items[0].id)
  const controller = new AbortController()
  const cancelled = assert.rejects(owner.counts('', controller.signal), { status: 410, code: PREVIEW_LITERATURE.disposed })
  controller.abort()
  await cancelled
  const pending = assert.rejects(owner.facets(), { status: 410 })
  owner.dispose()
  await pending
})

test('persistent read/detail failures are not fake empty data and do not prevent a valid write', async () => {
  const owner = new PreviewLiterature(options({ read: 'failed' }))
  await assert.rejects(owner.list(), { status: 503 })
  await assert.rejects(owner.counts(), { status: 503 })
  await assert.rejects(owner.projects(), { status: 503 })
  owner.dispose()
  const details = new PreviewLiterature(options({ detail: 'failed' }))
  const item = (await details.list()).items[0]
  await assert.rejects(details.detail(item.id), { status: 503 })
  await assert.rejects(details.notes(item.id), { status: 503 })
  assert.equal((await details.update(item.id, { fields: { title: '模拟保存仍可用' } })).title, '模拟保存仍可用')
  details.dispose()
})

test('write fail-once is consumed only after validation and delay cannot mutate after abort or dispose', async context => {
  const failed = new PreviewLiterature(options({ write: 'fail-once' }))
  const item = (await failed.list()).items[0]
  await assert.rejects(failed.update('unknown', { fields: { title: 'invalid' } }), { status: 404 })
  await assert.rejects(failed.update(item.id, { fields: { title: '模拟失败写入' } }), { status: 503 })
  assert.notEqual((await failed.detail(item.id)).title, '模拟失败写入')
  assert.equal((await failed.update(item.id, { fields: { title: '模拟成功重试' } })).title, '模拟成功重试')
  failed.dispose()
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewLiterature(options({ write: 'delayed' }))
  const original = (await owner.list()).items[0]
  const controller = new AbortController()
  const payload = { fields: { title: 'original captured input' } }
  const cancelled = assert.rejects(owner.update(original.id, payload, '', controller.signal), { status: 410 })
  await assert.rejects(owner.createNote(original.id, { text: 'parallel write' }), { status: 409, code: PREVIEW_LITERATURE.busy })
  payload.fields.title = 'must not leak'
  controller.abort()
  await cancelled
  assert.equal((await owner.detail(original.id)).title, original.title)
  const closing = assert.rejects(owner.createNote(original.id, { text: 'never committed' }), { status: 410 })
  owner.dispose()
  await closing
  context.mock.timers.tick(PREVIEW_LITERATURE.delayMs)
  await assert.rejects(owner.list(), { status: 410 })
})

test('delayed detail uses its own policy and aborting a note read does not cancel another reader', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewLiterature(options({ detail: 'delayed' }))
  const item = (await owner.list()).items[0]
  const controller = new AbortController()
  const aborted = assert.rejects(owner.notes(item.id, controller.signal), { status: 410, code: PREVIEW_LITERATURE.disposed })
  let completed = false
  const detail = owner.detail(item.id).then(value => { completed = true; return value })
  context.mock.timers.tick(PREVIEW_LITERATURE.delayMs - 1)
  controller.abort('do not echo this reason')
  await aborted
  assert.equal(completed, false)
  context.mock.timers.tick(1)
  assert.equal((await detail).id, item.id)
  owner.dispose()
})

test('delayed writes capture caller data and revalidate live project identity before any commit', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const projects = [{ ...PROJECT }]
  const owner = new PreviewLiterature({ ...options({ write: 'delayed' }), projects: () => projects })
  const item = (await owner.list()).items[0]
  const body = { fields: { title: 'captured title' }, project_ids: [PROJECT.id] }
  const writing = owner.update(item.id, body)
  body.fields.title = 'mutated caller title'
  body.project_ids.length = 0
  context.mock.timers.tick(PREVIEW_LITERATURE.delayMs)
  const updated = await writing
  assert.equal(updated.title, 'captured title')
  assert.equal(updated.projects.length, 1)
  const invalidated = assert.rejects(owner.update(item.id, { fields: { title: 'must not commit' }, project_ids: [PROJECT.id] }), { status: 400 })
  projects.length = 0
  context.mock.timers.tick(PREVIEW_LITERATURE.delayMs)
  await invalidated
  assert.equal((await owner.detail(item.id)).title, 'captured title')
  assert.equal((await owner.counts()).without_collection, 1)
  owner.dispose()
  await assert.rejects(owner.update(item.id, null), { status: 410 })
})
