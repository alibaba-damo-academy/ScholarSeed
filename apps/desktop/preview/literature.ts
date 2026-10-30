import { randomUUID } from 'node:crypto'
import type { LiteratureAttachmentSummary, LiteratureCounts, LiteratureDetail, LiteratureFacet, LiteratureFacets, LiteratureNote, LiteraturePage, LiteratureProjects, LiteratureQuery, LiteratureSummary, LiteratureTagFacet, LiteratureTagFacets } from '../src/renderer/src/contracts/literature.ts'

export const PREVIEW_LITERATURE = {
  delayMs: 2_000,
  defaultPage: 1,
  pageSize: 50,
  maxPageSize: 200,
  facetLimit: 50,
  recentMs: 7 * 86400 * 1000,
  dayMs: 86400 * 1000,
  disposed: 'preview_literature_disposed',
  busy: 'preview_literature_write_pending',
  readFailure: 'preview_literature_read_unavailable',
  detailFailure: 'preview_literature_detail_unavailable',
  writeFailure: 'preview_literature_write_unavailable',
  invalidQuery: 'preview_literature_query_invalid',
  invalid: 'literature_library_invalid',
  notFound: 'LITERATURE_NOT_FOUND',
  projectNotFound: 'unknown_project',
  attachmentNotFound: 'literature_attachment_not_found',
  noteNotFound: 'literature_note_not_found',
  noteBodyRequired: 'literature_note_body_required',
  noteTitleRequired: 'literature_note_title_required',
  noteConflict: 'literature_note_version_conflict',
  notePrefix: '笔记',
  titles: ['模拟文献：可复现研究流程', '模拟文献：缺失全文附件', '模拟文献：协作设计笔记'],
} as const

export interface PreviewLiteraturePolicy {
  seed: 'sample' | 'empty'
  read: 'normal' | 'delayed' | 'failed'
  detail: 'normal' | 'delayed' | 'failed'
  write: 'normal' | 'delayed' | 'fail-once'
}
export interface PreviewLiteratureOptions {
  currentProjectId: string
  projects: () => readonly { id: string; name: string; archived_at?: number | null }[]
  pdf?: { path: string; name: string; size: number; revision: string; identity: string }
  policy?: PreviewLiteraturePolicy
}
export interface PreviewLiteratureAttachment {
  path: string
  availability: 'available' | 'missing'
  revision: string
  identity: string
  summary: LiteratureAttachmentSummary
}
export class PreviewLiteratureError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

const DEFAULT_POLICY: PreviewLiteraturePolicy = { seed: 'empty', read: 'normal', detail: 'normal', write: 'normal' }
const LIST_STRINGS = ['q', 'project_id', 'sort', 'order'] as const
const LIST_ARRAYS = ['collection_id', 'tag_id'] as const
const LIST_BOOLEANS = ['without_collection', 'without_project', 'recent'] as const
const TRUE_VALUES = ['1', 'true', 'on', 'yes']
const FALSE_VALUES = ['0', 'false', 'off', 'no']
const FIELD_NAMES = ['citation_key', 'item_type', 'title', 'subtitle', 'authors', 'publication', 'year', 'published_date', 'abstract', 'doi', 'arxiv', 'isbn', 'url', 'volume', 'number', 'pages', 'publisher', 'address']
const BIB_TYPES = ['article', 'book', 'booklet', 'conference', 'inbook', 'incollection', 'inproceedings', 'manual', 'mastersthesis', 'misc', 'phdthesis', 'proceedings', 'techreport', 'unpublished']
const UPDATE_KEYS = ['fields', 'bib_type', 'collection_ids', 'tag_ids', 'project_ids', 'project_collection_ids']
const RELATIONS = ['collection_ids', 'tag_ids', 'project_ids', 'project_collection_ids'] as const
const FIELD_MAP: Record<string, string> = { authors: 'creators_display', publication: 'publication_display' }
const SORT_MAP: Record<string, keyof LiteratureSummary> = { title: 'title', citation_key: 'citation_key', item_type: 'item_type', bib_type: 'bib_type', subtitle: 'subtitle', creator: 'creators_display', publication: 'publication_display', year: 'year', published_date: 'published_date', doi: 'doi', arxiv: 'arxiv', isbn: 'isbn', url: 'url', volume: 'volume', number: 'number', pages: 'pages', publisher: 'publisher', address: 'address', created_at: 'created_at', updated_at: 'updated_at' }
type Relations = { [Key in typeof RELATIONS[number]]: string[] }
type Entry = { summary: LiteratureSummary; relations: Relations; notes: LiteratureNote[] }
type Update = { fields: Record<string, string | number | null>; relations: Partial<Relations> }

function fail(status: number, code: string): never { throw new PreviewLiteratureError(status, code) }
function record(value: unknown, status = 400): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !('value' in descriptor))) fail(status, PREVIEW_LITERATURE.invalid)
  return value as Record<string, unknown>
}
function compare(left: unknown, right: unknown): number {
  if (left == null) return right == null ? 0 : -1
  if (right == null) return 1
  return left < right ? -1 : left > right ? 1 : 0
}
function queryNumber(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail(422, PREVIEW_LITERATURE.invalidQuery)
  return Math.min(Math.max(value, PREVIEW_LITERATURE.defaultPage), maximum)
}
function normalizeQuery(value: LiteratureQuery): LiteratureQuery {
  const raw = record(value, 422)
  for (const key of LIST_STRINGS) if (raw[key] !== undefined && typeof raw[key] !== 'string') fail(422, PREVIEW_LITERATURE.invalidQuery)
  for (const key of LIST_ARRAYS) if (raw[key] !== undefined && (!Array.isArray(raw[key]) || (raw[key] as unknown[]).some(item => typeof item !== 'string'))) fail(422, PREVIEW_LITERATURE.invalidQuery)
  for (const key of LIST_BOOLEANS) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') fail(422, PREVIEW_LITERATURE.invalidQuery)
  return structuredClone({ ...value, page: queryNumber(value.page, PREVIEW_LITERATURE.defaultPage), page_size: queryNumber(value.page_size, PREVIEW_LITERATURE.pageSize, PREVIEW_LITERATURE.maxPageSize) })
}
export function parsePreviewLiteratureQuery(params: URLSearchParams): LiteratureQuery {
  const query: Record<string, unknown> = {}
  for (const key of LIST_STRINGS) if (params.has(key)) query[key] = params.getAll(key).at(-1)
  for (const key of LIST_ARRAYS) if (params.has(key)) query[key] = params.getAll(key)
  for (const key of LIST_BOOLEANS) if (params.has(key)) {
    const value = params.getAll(key).at(-1)!.toLowerCase()
    if (![...TRUE_VALUES, ...FALSE_VALUES].includes(value)) fail(422, PREVIEW_LITERATURE.invalidQuery)
    query[key] = TRUE_VALUES.includes(value)
  }
  for (const key of ['page', 'page_size'] as const) if (params.has(key)) {
    const value = params.getAll(key).at(-1)!.trim()
    if (!/^[+-]?\d+(?:\.0+)?$/.test(value)) fail(422, PREVIEW_LITERATURE.invalidQuery)
    query[key] = queryNumber(Number(value), PREVIEW_LITERATURE.defaultPage, key === 'page_size' ? PREVIEW_LITERATURE.maxPageSize : undefined)
  }
  return query as LiteratureQuery
}

export class PreviewLiterature {
  private readonly policy: Readonly<PreviewLiteraturePolicy>
  private readonly items = new Map<string, Entry>()
  private readonly collectionRows: LiteratureFacet[] = []
  private readonly tagRows: LiteratureFacet[] = []
  private readonly pdf: PreviewLiteratureOptions['pdf']
  private readonly pending = new Set<() => void>()
  private readonly resolveProjects: PreviewLiteratureOptions['projects']
  private readonly currentProjectId: string
  private disposed = false
  private writing = false
  private failedWrite = false

  constructor(options: PreviewLiteratureOptions) {
    this.policy = { ...(options.policy ?? DEFAULT_POLICY) }
    if (options.pdf) this.pdf = { path: options.pdf.path, name: options.pdf.name, size: options.pdf.size, revision: options.pdf.revision, identity: options.pdf.identity }
    if (this.policy.seed === 'sample' && (!this.pdf || !Number.isSafeInteger(this.pdf.size) || this.pdf.size < 0 || [this.pdf.path, this.pdf.name, this.pdf.revision, this.pdf.identity].some(value => typeof value !== 'string' || !value))) fail(422, PREVIEW_LITERATURE.invalid)
    this.resolveProjects = options.projects
    this.currentProjectId = options.currentProjectId
    if (this.policy.seed === 'sample') this.seed()
  }

  private seed(): void {
    const pdf = this.pdf!
    const now = Date.now()
    const parent = randomUUID()
    this.collectionRows.push({ id: parent, name: '模拟研究', count: 0, parent_id: null, project_id: null }, { id: randomUUID(), name: '模拟复现', count: 0, parent_id: parent, project_id: null }, { id: randomUUID(), name: '模拟项目资料', count: 0, parent_id: null, project_id: this.currentProjectId })
    for (const name of ['模拟复现', '模拟协作', '模拟待整理']) this.tagRows.push({ id: randomUUID(), name, count: 0, color: null })
    for (const [index, title] of PREVIEW_LITERATURE.titles.entries()) {
      const id = randomUUID()
      const created = new Date(now - [1 / 24, 10, 2][index] * PREVIEW_LITERATURE.dayMs).toISOString()
      const attachments: LiteratureAttachmentSummary[] = index < 2 ? [{ id: randomUUID(), name: index === 0 ? pdf.name : 'missing-sample.pdf', kind: 'pdf', availability: index === 0 ? 'available' : 'missing', role: 'primary', media_type: 'application/pdf', size: index === 0 ? pdf.size : null, annotation_count: 0, created_at: created, record_target: { owner: 'literature_attachment', scope_id: id, subject_id: '' } }] : []
      for (const attachment of attachments) attachment.record_target.subject_id = attachment.id
      const summary: LiteratureSummary = { id, item_type: index === 2 ? 'book' : 'article', bib_type: index === 2 ? 'book' : 'article', title, creators_display: ['Preview Research Team', 'Preview Archive Team', 'Preview Design Team'][index], citation_key: `Preview${index + 1}`, publication_display: ['Mock Research Collection', 'Mock Archive Collection', 'Mock Design Collection'][index], year: [2026, 2025, 2023][index], abstract: '明确模拟的受审题录，只用于共享界面验证，不代表真实发表成果。', created_at: created, updated_at: created, published_date: null, last_read_at: null, read_progress: 0, is_unread: true, primary_attachment: null, attachments, collections: [], project_collections: [], tags: [], projects: [], version: 1 }
      const notes: LiteratureNote[] = index === 0 ? [{ id: randomUUID(), title: '模拟阅读笔记', text: '这是可编辑的模拟笔记，不是用户资料。', created_at: now / 1000, updated_at: now / 1000, position: 1, version: 1 }] : []
      this.items.set(id, { summary, relations: { collection_ids: index < 2 ? [this.collectionRows[index].id] : [], project_collection_ids: index === 0 ? [this.collectionRows[2].id] : [], tag_ids: index === 0 ? [this.tagRows[0].id, this.tagRows[1].id] : [this.tagRows[index === 1 ? 0 : 1].id], project_ids: index < 2 ? [this.currentProjectId] : [] }, notes })
    }
  }

  private active(signal?: AbortSignal): void { if (this.disposed || signal?.aborted) fail(410, PREVIEW_LITERATURE.disposed) }
  private async wait(delayed: boolean, signal?: AbortSignal): Promise<void> {
    this.active(signal)
    if (!delayed) return
    await new Promise<void>((resolve, reject) => {
      const finish = (cancelled: boolean): void => {
        clearTimeout(timer)
        this.pending.delete(cancel)
        signal?.removeEventListener('abort', cancel)
        if (cancelled) reject(new PreviewLiteratureError(410, PREVIEW_LITERATURE.disposed))
        else resolve()
      }
      const cancel = (): void => finish(true)
      const timer = setTimeout(() => finish(false), PREVIEW_LITERATURE.delayMs)
      this.pending.add(cancel)
      signal?.addEventListener('abort', cancel, { once: true })
    })
    this.active(signal)
  }
  private async read<Result>(detail: boolean, action: () => Result, signal?: AbortSignal): Promise<Result> {
    this.active(signal)
    const mode = detail ? this.policy.detail : this.policy.read
    if (mode === 'failed') fail(503, detail ? PREVIEW_LITERATURE.detailFailure : PREVIEW_LITERATURE.readFailure)
    await this.wait(mode === 'delayed', signal)
    this.active(signal)
    return structuredClone(action())
  }
  private async mutate<Result>(validate: () => void, action: () => Result, signal?: AbortSignal): Promise<Result> {
    this.active(signal)
    if (this.writing) fail(409, PREVIEW_LITERATURE.busy)
    validate()
    if (this.policy.write === 'fail-once' && !this.failedWrite) { this.failedWrite = true; fail(503, PREVIEW_LITERATURE.writeFailure) }
    this.writing = true
    try {
      await this.wait(this.policy.write === 'delayed', signal)
      this.active(signal)
      validate()
      return structuredClone(action())
    } finally { this.writing = false }
  }
  private scope(projectId = ''): string {
    if (typeof projectId !== 'string') fail(422, PREVIEW_LITERATURE.invalidQuery)
    if (projectId && !this.resolveProjects().some(project => project.id === projectId && project.archived_at == null)) fail(400, PREVIEW_LITERATURE.projectNotFound)
    return projectId
  }
  private entry(id: string, projectId = ''): Entry {
    this.scope(projectId)
    const entry = this.items.get(id)
    if (!entry || (projectId && !entry.relations.project_ids.includes(projectId))) fail(404, PREVIEW_LITERATURE.notFound)
    return entry
  }
  private linked(entry: Entry): string[] { return entry.relations.project_ids.filter(id => this.resolveProjects().some(project => project.id === id)) }
  private collectionsFor(entry: Entry): string[] {
    return [...entry.relations.collection_ids, ...entry.relations.project_collection_ids.filter(id => this.collectionRows.some(row => row.id === id && this.resolveProjects().some(project => project.id === row.project_id)))]
  }
  private collectionProjection(projectId = ''): LiteratureFacet[] {
    return this.collectionRows.filter(row => (row.project_id ?? '') === projectId).map(row => ({ ...row, count: [...this.items.values()].filter(entry => this.collectionsFor(entry).includes(row.id)).length }))
  }
  private tagProjection(entries: Entry[]): LiteratureTagFacet[] {
    return [...this.tagRows].reverse().map(row => ({ ...row, count: entries.filter(entry => entry.relations.tag_ids.includes(row.id)).length, total: [...this.items.values()].filter(entry => entry.relations.tag_ids.includes(row.id)).length }))
  }
  private summary(entry: Entry, projectId = ''): LiteratureSummary {
    const primary = entry.summary.attachments.find(attachment => attachment.role === 'primary')
    const primarySummary = primary ? { ...primary } : null
    if (primarySummary) delete primarySummary.created_at
    const activeProjects = this.resolveProjects().filter(project => project.archived_at == null)
    const projectCollections = this.collectionRows.filter(row => row.project_id && (!projectId || row.project_id === projectId) && this.resolveProjects().some(project => project.id === row.project_id))
    return { ...entry.summary, primary_attachment: primarySummary, collections: this.collectionProjection().filter(row => entry.relations.collection_ids.includes(row.id)), project_collections: projectCollections.filter(row => entry.relations.project_collection_ids.includes(row.id)).map(row => ({ ...row, count: 0 })), tags: this.tagRows.filter(row => entry.relations.tag_ids.includes(row.id)).map(row => ({ ...row, count: [...this.items.values()].filter(item => item.relations.tag_ids.includes(row.id)).length })), projects: activeProjects.filter(project => entry.relations.project_ids.includes(project.id)).map(project => ({ id: project.id, name: project.name, count: 1 })) }
  }
  private selected(query: LiteratureQuery): Entry[] {
    const scope = this.scope(query.project_id)
    const descendants = new Set(query.collection_id ?? [])
    for (const row of this.collectionRows) if (row.parent_id && descendants.has(row.parent_id)) descendants.add(row.id)
    const needle = (query.q ?? '').trim().replace(/[A-Z]/g, char => char.toLowerCase())
    const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.'), 's')
    return [...this.items.values()].filter(entry => {
      const collections = this.collectionsFor(entry).filter(id => this.collectionRows.some(row => row.id === id && (row.project_id ?? '') === scope))
      return (!scope || this.linked(entry).includes(scope)) && (!query.without_project || this.linked(entry).length === 0)
        && (descendants.size ? collections.some(id => descendants.has(id)) : !query.without_collection || (query.without_project ? this.collectionsFor(entry).length === 0 : collections.length === 0))
        && (!query.tag_id?.length || new Set(entry.relations.tag_ids.filter(id => query.tag_id!.includes(id))).size === query.tag_id.length)
        && (!query.recent || Date.parse(entry.summary.created_at) >= Date.now() - PREVIEW_LITERATURE.recentMs)
        && (!needle || [entry.summary.title, entry.summary.creators_display, entry.summary.publication_display, entry.summary.doi, entry.summary.year].some(value => value != null && pattern.test(String(value).replace(/[A-Z]/g, char => char.toLowerCase()))))
    })
  }

  async list(query: LiteratureQuery = {}, signal?: AbortSignal): Promise<LiteraturePage> {
    this.active(signal)
    const normalized = normalizeQuery(query)
    return this.read(false, () => {
      const entries = this.selected(normalized)
      const direction = normalized.order === 'asc' ? 1 : -1
      const field = Object.prototype.hasOwnProperty.call(SORT_MAP, normalized.sort ?? '') ? SORT_MAP[normalized.sort!] : 'created_at'
      entries.sort((left, right) => (normalized.sort === 'attachment' ? direction * compare(left.summary.attachments.length ? 0 : 1, right.summary.attachments.length ? 0 : 1) || -compare(left.summary.created_at, right.summary.created_at) : direction * compare(left.summary[field], right.summary[field])) || compare(left.summary.id, right.summary.id))
      const page = normalized.page!
      const size = normalized.page_size!
      const items = entries.slice((page - 1) * size, page * size).map(entry => this.summary(entry, normalized.project_id))
      return { items, page, page_size: size, total: entries.length, next_cursor: items.length === size ? String(page + 1) : null }
    }, signal)
  }
  counts(projectId = '', signal?: AbortSignal): Promise<LiteratureCounts> {
    return this.read(false, () => {
      const entries = this.selected({ project_id: projectId })
      return { all: entries.length, recent: this.selected({ project_id: projectId, recent: true }).length, without_collection: this.selected({ project_id: projectId, without_collection: true, without_project: !projectId }).length, unread: entries.length, without_fulltext: entries.filter(entry => entry.summary.attachments.length === 0).length }
    }, signal)
  }
  facets(query: LiteratureQuery = {}, signal?: AbortSignal): Promise<LiteratureFacets> {
    const projectId = query.project_id ?? ''
    return this.read(false, () => {
      const entries = this.selected({ project_id: projectId })
      const aggregate = <Value extends string | number>(values: (Value | null | undefined)[], descending = false, omitEmpty = false) => {
        const counts = new Map<Value, number>()
        for (const value of values) if (value != null && (!omitEmpty || value !== '')) counts.set(value, (counts.get(value) ?? 0) + 1)
        const rows = [...counts].sort(([left, leftCount], [right, rightCount]) => rightCount - leftCount || (descending ? -1 : 1) * compare(left, right))
        return { total: rows.length, rows: rows.slice(0, PREVIEW_LITERATURE.facetLimit), truncated: rows.length > PREVIEW_LITERATURE.facetLimit }
      }
      const itemTypes = aggregate(entries.map(entry => entry.summary.item_type))
      const publications = aggregate(entries.map(entry => entry.summary.publication_display), false, true)
      const years = aggregate(entries.map(entry => entry.summary.year), true)
      return { collections: this.collectionProjection(projectId), tags: this.tagProjection(entries), item_types: { total: itemTypes.total, truncated: itemTypes.truncated, entries: itemTypes.rows.map(([id, count]) => ({ id, name: id, count })) }, publications: { total: publications.total, truncated: publications.truncated, entries: publications.rows.map(([id, count]) => ({ id, name: id, count })) }, years: { total: years.total, truncated: years.truncated, entries: years.rows.map(([value, count]) => ({ value, count })) } }
    }, signal)
  }
  async tagFacets(query: LiteratureQuery = {}, signal?: AbortSignal): Promise<LiteratureTagFacets> {
    this.active(signal)
    const { collection_id, project_id, recent, without_collection, without_project } = normalizeQuery(query)
    return this.read(false, () => ({ tags: this.tagProjection(this.selected({ collection_id, project_id, recent, without_collection, without_project })).sort((left, right) => right.count - left.count) }), signal)
  }
  projects(signal?: AbortSignal): Promise<LiteratureProjects> {
    return this.read(false, () => {
      const projects = this.resolveProjects().filter(project => project.archived_at == null).map(project => ({ id: project.id, name: project.name, count: this.selected({ project_id: project.id }).length, collections: this.collectionProjection(project.id) }))
      return { projects, current: projects.some(project => project.id === this.currentProjectId) ? this.currentProjectId : '' }
    }, signal)
  }
  collections(projectId = '', signal?: AbortSignal): Promise<LiteratureFacet[]> { return this.read(false, () => this.collectionProjection(this.scope(projectId)), signal) }
  tags(signal?: AbortSignal): Promise<LiteratureTagFacet[]> { return this.read(false, () => this.tagProjection([...this.items.values()]), signal) }
  private detailValue(id: string, projectId = ''): LiteratureDetail {
    const entry = this.entry(id, projectId)
    return this.detailProjection(entry, projectId)
  }
  private detailProjection(entry: Entry, projectId = ''): LiteratureDetail { return { ...this.summary(entry, projectId), issn: null, attachment_count: entry.summary.attachments.length, note_count: entry.notes.length, notes: entry.notes } }
  detail(id: string, projectId = '', signal?: AbortSignal): Promise<LiteratureDetail> { return this.read(true, () => this.detailValue(id, projectId), signal) }
  notes(id: string, signal?: AbortSignal): Promise<{ items: LiteratureNote[] }> { return this.read(true, () => ({ items: this.entry(id).notes }), signal) }
  attachment(itemId: string, attachmentId: string): PreviewLiteratureAttachment {
    this.active()
    const attachment = this.items.get(itemId)?.summary.attachments.find(attachment => attachment.id === attachmentId)
    if (!attachment) fail(404, PREVIEW_LITERATURE.attachmentNotFound)
    return structuredClone({ path: this.pdf!.path, availability: attachment.availability, revision: this.pdf!.revision, identity: this.pdf!.identity, summary: attachment })
  }

  private updateValue(value: unknown): Update {
    const body = record(value)
    if (Object.keys(body).some(key => !UPDATE_KEYS.includes(key))) fail(400, PREVIEW_LITERATURE.invalid)
    const fields = { ...record(body.fields ?? {}) } as Record<string, string | number | null>
    for (const [key, value] of Object.entries(fields)) if (!FIELD_NAMES.includes(key) || (key === 'year' ? value !== null && value !== '' && (typeof value !== 'number' || !Number.isSafeInteger(value)) : typeof value !== 'string')) fail(400, PREVIEW_LITERATURE.invalid)
    if (fields.year === '') fields.year = null
    if (body.bib_type !== undefined) {
      if (typeof body.bib_type !== 'string' || !BIB_TYPES.includes(body.bib_type)) fail(400, PREVIEW_LITERATURE.invalid)
      fields.bib_type = body.bib_type
    }
    const relations: Partial<Relations> = {}
    for (const key of RELATIONS) if (body[key] != null) {
      if (!Array.isArray(body[key]) || (body[key] as unknown[]).some(id => typeof id !== 'string')) fail(400, PREVIEW_LITERATURE.invalid)
      relations[key] = [...new Set(body[key] as string[])]
    }
    return { fields, relations }
  }
  async update(id: string, body: unknown, projectId = '', signal?: AbortSignal): Promise<LiteratureDetail> {
    this.active(signal)
    const update = this.updateValue(body)
    const validate = (): void => {
      this.entry(id)
      this.scope(projectId)
      for (const key of RELATIONS) for (const identity of update.relations[key] ?? []) {
        const valid = key === 'tag_ids' ? this.tagRows.some(row => row.id === identity) : key === 'project_ids' ? this.resolveProjects().some(project => project.id === identity && project.archived_at == null) : this.collectionRows.some(row => row.id === identity && (key === 'collection_ids' ? !row.project_id : !!row.project_id && (!projectId || row.project_id === projectId) && this.resolveProjects().some(project => project.id === row.project_id)))
        if (!valid) fail(400, PREVIEW_LITERATURE.invalid)
      }
    }
    return this.mutate(validate, () => {
      const entry = this.entry(id)
      for (const [key, value] of Object.entries(update.fields)) (entry.summary as unknown as Record<string, unknown>)[FIELD_MAP[key] ?? key] = value
      for (const key of RELATIONS) if (update.relations[key]) entry.relations[key] = key === 'project_collection_ids' && projectId ? [...entry.relations[key].filter(identity => this.collectionRows.some(row => row.id === identity && row.project_id !== projectId)), ...update.relations[key]!] : update.relations[key]!
      if (Object.keys(update.fields).length || update.relations.collection_ids || update.relations.tag_ids) this.touch(entry)
      return this.detailProjection(entry, projectId)
    }, signal)
  }
  private touch(entry: Entry): void { entry.summary.version += 1; entry.summary.updated_at = new Date().toISOString() }
  private noteBody(value: unknown, update = false): { title: string; text: string; version?: number } {
    const body = record(value, 422)
    if (Object.keys(body).some(key => !['title', 'text', ...(update ? ['version'] : [])].includes(key)) || (body.title !== undefined && typeof body.title !== 'string') || (body.text !== undefined && typeof body.text !== 'string')) fail(422, PREVIEW_LITERATURE.invalid)
    const title = ((body.title ?? '') as string).trim()
    const text = ((body.text ?? '') as string).trim()
    if (update && (typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1)) fail(422, PREVIEW_LITERATURE.invalid)
    if (update && !title) fail(422, PREVIEW_LITERATURE.noteTitleRequired)
    if (!text) fail(422, PREVIEW_LITERATURE.noteBodyRequired)
    return { title, text, ...(update ? { version: body.version as number } : {}) }
  }
  async createNote(id: string, body: unknown, signal?: AbortSignal): Promise<LiteratureNote> {
    this.active(signal)
    const payload = this.noteBody(body)
    return this.mutate(() => { if (!this.items.has(id)) fail(404, PREVIEW_LITERATURE.noteNotFound) }, () => {
      const entry = this.entry(id)
      let sequence = 1
      while (entry.notes.some(note => note.title === `${PREVIEW_LITERATURE.notePrefix} ${sequence}`)) sequence += 1
      const now = Date.now() / 1000
      const note: LiteratureNote = { id: randomUUID(), title: payload.title || `${PREVIEW_LITERATURE.notePrefix} ${sequence}`, text: payload.text, version: 1, created_at: now, updated_at: now, position: Math.max(0, ...entry.notes.map(note => note.position)) + 1 }
      entry.notes.push(note); this.touch(entry)
      return note
    }, signal)
  }
  async updateNote(id: string, noteId: string, body: unknown, signal?: AbortSignal): Promise<LiteratureNote> {
    this.active(signal)
    const payload = this.noteBody(body, true)
    const find = (): LiteratureNote => {
      const note = this.items.get(id)?.notes.find(note => note.id === noteId)
      if (!note) fail(404, PREVIEW_LITERATURE.noteNotFound)
      if (note.version !== payload.version) fail(409, PREVIEW_LITERATURE.noteConflict)
      return note
    }
    return this.mutate(() => { find() }, () => {
      const note = find()
      Object.assign(note, { title: payload.title, text: payload.text, version: note.version + 1, updated_at: Date.now() / 1000 })
      this.touch(this.entry(id)); return note
    }, signal)
  }
  deleteNote(id: string, noteId: string, signal?: AbortSignal): Promise<{ deleted: string }> {
    return this.mutate(() => { if (!this.items.get(id)?.notes.some(note => note.id === noteId)) fail(404, PREVIEW_LITERATURE.noteNotFound) }, () => {
      const entry = this.entry(id)
      entry.notes = entry.notes.filter(note => note.id !== noteId)
      this.touch(entry); return { deleted: noteId }
    }, signal)
  }
  dispose(): void {
    this.disposed = true
    for (const cancel of this.pending) cancel()
    this.items.clear()
    this.collectionRows.length = 0
    this.tagRows.length = 0
  }
}
