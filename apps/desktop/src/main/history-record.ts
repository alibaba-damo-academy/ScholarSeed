import type { BrowserVisit } from '../browser.ts'

export const HISTORY_FILE = 'history.sqlite3'
export const HISTORY_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS browser_visits (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      origin TEXT NOT NULL,
      title TEXT NOT NULL,
      visited_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS browser_visits_time ON browser_visits(visited_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS browser_visits_origin ON browser_visits(origin);
  `
export const HISTORY_ROWS_SQL =
  'SELECT id, url, origin, title, visited_at AS visitedAt FROM browser_visits'
export const HISTORY_OBJECTS_SQL =
  "SELECT type AS kind, name, tbl_name AS tableName, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"

const normalized = (sql: string): string =>
  sql
    .trim()
    .replace(/;$/, '')
    .replace(/\s+/g, ' ')
    .replace(/ IF NOT EXISTS /gi, ' ')
    .toLowerCase()
const statements = HISTORY_SCHEMA_SQL.split(';')
  .map((sql) => sql.trim())
  .filter(Boolean)
const objects = new Map([
  ['browser_visits', { kind: 'table', sql: statements[0] }],
  ['browser_visits_time', { kind: 'index', sql: statements[1] }],
  ['browser_visits_origin', { kind: 'index', sql: statements[2] }],
])

/** Actual history owner schema contract, shared by live startup and private preview. */
export function inspectHistorySchema(value: unknown): {
  needsWrite: boolean
  statements: string[]
} {
  if (!Array.isArray(value) || value.length > objects.size)
    throw new Error('browser_history_schema_invalid')
  const seen = new Set<string>()
  for (const row of value) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).sort().join(',') !== 'kind,name,sql,tableName'
    )
      throw new Error('browser_history_schema_invalid')
    const expected = objects.get(row.name)
    if (
      !expected ||
      seen.has(row.name) ||
      row.kind !== expected.kind ||
      row.tableName !== 'browser_visits' ||
      typeof row.sql !== 'string' ||
      normalized(row.sql) !== normalized(expected.sql)
    )
      throw new Error('browser_history_schema_invalid')
    seen.add(row.name)
  }
  if (seen.size && !seen.has('browser_visits')) throw new Error('browser_history_schema_invalid')
  return { needsWrite: seen.size !== objects.size, statements }
}

export function decodeHistoryVisit(value: unknown): BrowserVisit {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('browser_history_row_invalid')
  const row = value as Record<string, unknown>
  if (
    typeof row.id !== 'string' ||
    !row.id ||
    typeof row.url !== 'string' ||
    typeof row.title !== 'string' ||
    typeof row.visitedAt !== 'number' ||
    !Number.isFinite(row.visitedAt)
  )
    throw new Error('browser_history_row_invalid')
  const origin = new URL(row.url).origin
  if ('origin' in row && row.origin !== origin) throw new Error('browser_history_row_invalid')
  return { id: row.id, url: row.url, title: row.title, visitedAt: row.visitedAt }
}

export function inspectHistoryRequest(value: unknown): object {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('browser_history_request_invalid')
  const request = value as Record<string, unknown>
  if (
    request.version !== 1 ||
    request.owner !== 'browser-history' ||
    Object.keys(request).sort().join(',') !== 'mode,owner,value,version'
  )
    throw new Error('browser_history_request_invalid')
  if (request.mode === 'schema')
    return { version: 1, ...inspectHistorySchema(request.value), rowsQuery: HISTORY_ROWS_SQL }
  if (request.mode !== 'rows' || !Array.isArray(request.value) || request.value.length > 1024)
    throw new Error('browser_history_request_invalid')
  for (const row of request.value) {
    if (
      !row ||
      typeof row !== 'object' ||
      Object.keys(row).sort().join(',') !== 'id,origin,title,url,visitedAt'
    )
      throw new Error('browser_history_row_invalid')
    decodeHistoryVisit(row)
  }
  return { version: 1, count: request.value.length }
}
