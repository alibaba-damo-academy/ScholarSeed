/** CSV owns byte-preserving parsing and cell transactions; no DOM or Office runtime. */
export interface CsvWindow {
  row: number
  column: number
  rows: number
  columns: number
}
export interface CsvRange {
  top: number
  left: number
  bottom: number
  right: number
}
export interface CsvPatch {
  row: number
  column: number
  value: string
}
export interface CsvDialect {
  delimiter: ',' | ';' | '\t' | '|'
  bom: boolean
  newline: '\r\n' | '\n' | '\r'
}
export interface CsvState {
  identity: string
  version: number
  rowCount: number
  columnCount: number
  dirty: boolean
  revision: string
  dialect: CsvDialect
  canUndo: boolean
  canRedo: boolean
}
export interface CsvRangeResult {
  identity: string
  version: number
  range: CsvRange
  mode: 'inline' | 'reference'
  text?: string
}
export interface CsvSearch {
  identity: string
  version: number
  query: string
  total: number
  current: { row: number; column: number } | null
}
interface Token {
  start: number
  end: number
  value: string
}
interface RecordIndex {
  start: number
  end: number
  next: number
  count: number
}
interface Mutation {
  row: number
  column: number
  before: string
  after: string
}
const DELIMITERS = [',', ';', '\t', '|'] as const
const DIALECT_SAMPLE_BYTES = 65_536
const DIALECT_SAMPLE_RECORDS = 32
const ROW_CACHE_RECORDS = 256
const QUOTE_BYTE = 34
const LF_BYTE = 10
const CR_BYTE = 13
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function ordinal(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}
function fail(code: string): never {
  throw new Error(code)
}

function scan(
  bytes: Uint8Array,
  start: number,
  delimiter: number,
  strict: boolean,
  sample = false
): RecordIndex[] {
  const result: RecordIndex[] = []
  let record = start,
    field = start,
    count = 1,
    quoted = false,
    closed = false
  const limit = sample ? Math.min(bytes.length, start + DIALECT_SAMPLE_BYTES) : bytes.length
  for (let at = start; at < limit; at++) {
    const byte = bytes[at]
    if (quoted) {
      if (byte === QUOTE_BYTE) {
        if (bytes[at + 1] === QUOTE_BYTE) at++
        else {
          quoted = false
          closed = true
        }
      }
      continue
    }
    if (byte === delimiter) {
      count++
      field = at + 1
      closed = false
      continue
    }
    if (byte === LF_BYTE || byte === CR_BYTE) {
      const next = byte === CR_BYTE && bytes[at + 1] === LF_BYTE ? at + 2 : at + 1
      result.push({ start: record, end: at, next, count })
      record = next
      field = next
      count = 1
      closed = false
      at = next - 1
      if (sample && result.length >= DIALECT_SAMPLE_RECORDS) return result
      continue
    }
    if (closed && strict) fail('csv_quotes_invalid')
    if (byte === QUOTE_BYTE) {
      if (at === field) quoted = true
      else if (strict) fail('csv_quotes_invalid')
    }
  }
  if (quoted && !sample) fail('csv_quotes_invalid')
  if (record < limit && (!sample || limit === bytes.length) && !quoted)
    result.push({ start: record, end: limit, next: limit, count })
  return result
}

function detect(bytes: Uint8Array, start: number): CsvDialect['delimiter'] {
  let selected: CsvDialect['delimiter'] = ',',
    best = 0
  for (const delimiter of DELIMITERS) {
    const records = scan(bytes, start, delimiter.charCodeAt(0), false, true)
    const counts = new Map<number, number>()
    for (const record of records)
      if (record.count > 1) counts.set(record.count, (counts.get(record.count) ?? 0) + 1)
    for (const [columns, frequency] of counts) {
      // Stable record width dominates arbitrary separator occurrences inside free text.
      const score = ((frequency * frequency) / Math.max(records.length, 1)) * columns
      if (score > best) {
        best = score
        selected = delimiter
      }
    }
  }
  return selected
}

function fieldTokens(bytes: Uint8Array, start: number, end: number, delimiter: number): Token[] {
  const tokens: Token[] = []
  let field = start,
    quoted = false
  const append = (stop: number): void => {
    let value = decoder.decode(bytes.subarray(field, stop))
    if (bytes[field] === QUOTE_BYTE && stop > field) value = value.slice(1, -1).replace(/""/g, '"')
    tokens.push({ start: field, end: stop, value })
  }
  for (let at = start; at < end; at++) {
    if (bytes[at] === QUOTE_BYTE) {
      if (quoted && bytes[at + 1] === QUOTE_BYTE) at++
      else if (quoted || at === field) quoted = !quoted
    } else if (bytes[at] === delimiter && !quoted) {
      append(at)
      field = at + 1
    }
  }
  append(end)
  return tokens
}

function encoded(value: string, delimiter: string): Uint8Array {
  return encoder.encode(
    value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
  )
}

export class CsvModel {
  readonly identity: string
  readonly dialect: CsvDialect
  readonly rowCount: number
  private readonly bytes: Uint8Array
  private readonly starts: Uint32Array
  private readonly ends: Uint32Array
  private readonly next: Uint32Array
  private readonly counts: Uint32Array
  private readonly cache = new Map<number, Token[]>()
  private readonly patches = new Map<number, Map<number, string>>()
  private readonly undoStack: Mutation[][] = []
  private readonly redoStack: Mutation[][] = []
  private savedPatches = new Map<number, Map<number, string>>()
  private serialized = new Map<number, Map<number, Map<number, string>>>()
  private readonly originalColumns: number
  private sourceRevision: string
  version = 0

  constructor(
    bytes: Uint8Array,
    identity: string,
    delimiter?: CsvDialect['delimiter'],
    revision = identity
  ) {
    if (delimiter !== undefined && !DELIMITERS.includes(delimiter)) fail('csv_delimiter_invalid')
    try {
      decoder.decode(bytes)
    } catch {
      fail('csv_encoding_invalid')
    }
    this.bytes = bytes.slice()
    this.identity = identity
    this.sourceRevision = revision
    const bom = UTF8_BOM.every((byte, index) => bytes[index] === byte)
    const start = bom ? UTF8_BOM.length : 0
    const separator = delimiter ?? detect(bytes, start)
    const records = scan(bytes, start, separator.charCodeAt(0), true)
    this.rowCount = records.length
    this.starts = Uint32Array.from(records.map((record) => record.start))
    this.ends = Uint32Array.from(records.map((record) => record.end))
    this.next = Uint32Array.from(records.map((record) => record.next))
    this.counts = Uint32Array.from(records.map((record) => record.count))
    this.originalColumns = records.reduce((maximum, record) => Math.max(maximum, record.count), 0)
    const terminated = records.find((record) => record.next > record.end)
    const newline = terminated
      ? (decoder.decode(bytes.subarray(terminated.end, terminated.next)) as CsvDialect['newline'])
      : '\r\n'
    this.dialect = { delimiter: separator, bom, newline }
  }

  get columnCount(): number {
    let maximum = this.originalColumns
    for (const columns of this.patches.values())
      for (const column of columns.keys()) maximum = Math.max(maximum, column + 1)
    return maximum
  }

  get dirty(): boolean {
    if (this.patches.size !== this.savedPatches.size) return true
    for (const [row, columns] of this.patches) {
      const saved = this.savedPatches.get(row)
      if (saved?.size !== columns.size) return true
      for (const [column, value] of columns) if (saved.get(column) !== value) return true
    }
    return false
  }

  state(): CsvState {
    return {
      identity: this.identity,
      version: this.version,
      rowCount: this.rowCount,
      columnCount: this.columnCount,
      dirty: this.dirty,
      revision: this.sourceRevision,
      dialect: this.dialect,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    }
  }

  private tokens(row: number): Token[] {
    if (!ordinal(row) || row >= this.rowCount) fail('csv_cell_invalid')
    let tokens = this.cache.get(row)
    if (!tokens) {
      tokens = fieldTokens(
        this.bytes,
        this.starts[row],
        this.ends[row],
        this.dialect.delimiter.charCodeAt(0)
      )
      this.cache.set(row, tokens)
      if (this.cache.size > ROW_CACHE_RECORDS) this.cache.delete(this.cache.keys().next().value!)
    }
    return tokens
  }

  value(row: number, column: number): string {
    if (!ordinal(column)) fail('csv_cell_invalid')
    return this.patches.get(row)?.get(column) ?? this.tokens(row)[column]?.value ?? ''
  }

  readWindow(window: CsvWindow): {
    identity: string
    version: number
    window: CsvWindow
    cells: string[][]
  } {
    if (![window.row, window.column, window.rows, window.columns].every(ordinal))
      fail('csv_window_invalid')
    const rows = Math.min(window.rows, Math.max(0, this.rowCount - window.row))
    const columns = Math.min(window.columns, Math.max(0, this.columnCount - window.column))
    return {
      identity: this.identity,
      version: this.version,
      window,
      cells: Array.from({ length: rows }, (_, row) =>
        Array.from({ length: columns }, (_, column) =>
          this.value(window.row + row, window.column + column)
        )
      ),
    }
  }

  getRange(range: CsvRange, limits: { cells: number; chars: number }): CsvRangeResult {
    if (
      ![range.top, range.left, range.bottom, range.right, limits.cells, limits.chars].every(
        ordinal
      ) ||
      range.top > range.bottom ||
      range.left > range.right
    )
      fail('csv_range_invalid')
    const selected = {
      ...range,
      bottom: Math.min(range.bottom, this.rowCount - 1),
      right: Math.min(range.right, this.columnCount - 1),
    }
    // Match Calc selection: retain the user's start and crop only unused trailing rows/columns.
    let populatedBottom = selected.top - 1,
      populatedRight = selected.left - 1
    for (let row = selected.top; row <= selected.bottom; row++) {
      const tokens = this.tokens(row)
      for (
        let column = selected.left;
        column <= Math.min(selected.right, tokens.length - 1);
        column++
      ) {
        if (this.value(row, column)) {
          populatedBottom = row
          populatedRight = Math.max(populatedRight, column)
        }
      }
      for (const [column, value] of this.patches.get(row) ?? []) {
        if (column >= selected.left && column <= selected.right && value) {
          populatedBottom = row
          populatedRight = Math.max(populatedRight, column)
        }
      }
    }
    selected.bottom = populatedBottom
    selected.right = populatedRight
    const result = { identity: this.identity, version: this.version, range: selected }
    if (selected.bottom < selected.top || selected.right < selected.left)
      return { ...result, mode: 'inline', text: '' }
    if ((selected.bottom - selected.top + 1) * (selected.right - selected.left + 1) > limits.cells)
      return { ...result, mode: 'reference' }
    const lines: string[] = []
    let size = 0
    for (let row = selected.top; row <= selected.bottom; row++) {
      const line = Array.from({ length: selected.right - selected.left + 1 }, (_, column) =>
        this.value(row, selected.left + column)
      ).join('\t')
      size += line.length + (lines.length ? 1 : 0)
      if (size > limits.chars) return { ...result, mode: 'reference' }
      lines.push(line)
    }
    return { ...result, mode: 'inline', text: lines.join('\n') }
  }

  private expect(version: number): void {
    if (version !== this.version) fail('csv_version_conflict')
  }
  private apply(row: number, column: number, value: string): void {
    const original = this.tokens(row)[column]?.value ?? ''
    if (value === original) {
      const columns = this.patches.get(row)
      columns?.delete(column)
      if (columns?.size === 0) this.patches.delete(row)
    } else {
      let columns = this.patches.get(row)
      if (!columns) {
        columns = new Map()
        this.patches.set(row, columns)
      }
      columns.set(column, value)
    }
  }

  edit(patches: CsvPatch[], expectedVersion: number): CsvState {
    this.expect(expectedVersion)
    const deduplicated = new Map<string, CsvPatch>()
    for (const patch of patches) {
      if (
        !ordinal(patch.row) ||
        patch.row >= this.rowCount ||
        !ordinal(patch.column) ||
        typeof patch.value !== 'string'
      )
        fail('csv_cell_invalid')
      deduplicated.set(`${patch.row}:${patch.column}`, patch)
    }
    const transaction = [...deduplicated.values()]
      .map((patch) => ({
        ...patch,
        before: this.value(patch.row, patch.column),
        after: patch.value,
      }))
      .filter((mutation) => mutation.before !== mutation.after)
    if (transaction.length) {
      for (const mutation of transaction) this.apply(mutation.row, mutation.column, mutation.after)
      this.undoStack.push(transaction)
      this.redoStack.length = 0
      this.version++
    }
    return this.state()
  }

  undo(expectedVersion: number): boolean {
    this.expect(expectedVersion)
    const transaction = this.undoStack.pop()
    if (!transaction) return false
    for (const mutation of transaction) this.apply(mutation.row, mutation.column, mutation.before)
    this.redoStack.push(transaction)
    this.version++
    return true
  }

  redo(expectedVersion: number): boolean {
    this.expect(expectedVersion)
    const transaction = this.redoStack.pop()
    if (!transaction) return false
    for (const mutation of transaction) this.apply(mutation.row, mutation.column, mutation.after)
    this.undoStack.push(transaction)
    this.version++
    return true
  }

  paste(row: number, column: number, text: string, expectedVersion: number): CsvState {
    this.expect(expectedVersion)
    if (!ordinal(row) || row >= this.rowCount || !ordinal(column)) fail('csv_cell_invalid')
    if (!text) return this.state()
    // Clipboard is a TSV interchange format, never the file's CSV dialect.
    // Plain single-field prose may contain literal quotes without TSV escaping.
    if (!/[\t\r\n]/.test(text) && !text.startsWith('"'))
      return this.edit([{ row, column, value: text }], expectedVersion)
    const pasted = new CsvModel(encoder.encode(text), `${this.identity}:clipboard`, '\t')
    if (row + pasted.rowCount > this.rowCount) fail('csv_paste_range_invalid')
    const patches: CsvPatch[] = []
    for (let offsetRow = 0; offsetRow < pasted.rowCount; offsetRow++) {
      for (let offsetColumn = 0; offsetColumn < pasted.columnCount; offsetColumn++) {
        patches.push({
          row: row + offsetRow,
          column: column + offsetColumn,
          value: pasted.value(offsetRow, offsetColumn),
        })
      }
    }
    return this.edit(patches, expectedVersion)
  }

  copy(range: CsvRange): { identity: string; version: number; range: CsvRange; text: string } {
    const selected = this.getRange(range, { cells: 0, chars: 0 })
    const lines: string[] = []
    for (let row = selected.range.top; row <= selected.range.bottom; row++) {
      const cells: string[] = []
      for (let column = selected.range.left; column <= selected.range.right; column++) {
        cells.push(decoder.decode(encoded(this.value(row, column), '\t')))
      }
      lines.push(cells.join('\t'))
    }
    return {
      identity: this.identity,
      version: this.version,
      range: selected.range,
      text: lines.join('\n'),
    }
  }

  serialize(): { identity: string; version: number; bytes: Uint8Array } {
    const snapshot = new Map([...this.patches].map(([row, columns]) => [row, new Map(columns)]))
    this.serialized.set(this.version, snapshot)
    if (!snapshot.size)
      return { identity: this.identity, version: this.version, bytes: this.bytes.slice() }
    const chunks: Uint8Array[] = []
    let cursor = 0
    for (const [row, columns] of [...snapshot].sort(([left], [right]) => left - right)) {
      chunks.push(this.bytes.subarray(cursor, this.starts[row]))
      const tokens = this.tokens(row)
      let count = this.counts[row]
      for (const column of columns.keys()) count = Math.max(count, column + 1)
      for (let column = 0; column < count; column++) {
        if (column) chunks.push(encoder.encode(this.dialect.delimiter))
        const value = columns.get(column),
          token = tokens[column]
        chunks.push(
          value === undefined
            ? token
              ? this.bytes.subarray(token.start, token.end)
              : new Uint8Array()
            : encoded(value, this.dialect.delimiter)
        )
      }
      chunks.push(this.bytes.subarray(this.ends[row], this.next[row]))
      cursor = this.next[row]
    }
    chunks.push(this.bytes.subarray(cursor))
    const length = chunks.reduce((size, chunk) => size + chunk.length, 0)
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return { identity: this.identity, version: this.version, bytes }
  }

  acknowledgeSaved(version: number, revision: string): CsvState {
    const saved = this.serialized.get(version)
    if (!saved) fail('csv_save_snapshot_missing')
    this.savedPatches = saved
    this.sourceRevision = revision
    this.serialized.delete(version)
    for (const older of this.serialized.keys()) if (older < version) this.serialized.delete(older)
    return this.state()
  }

  search(
    query: string,
    after: { row: number; column: number } | null = null,
    backwards = false
  ): CsvSearch {
    const needle = query.toLocaleLowerCase()
    if (!needle)
      return { identity: this.identity, version: this.version, query, total: 0, current: null }
    let total = 0,
      first: CsvSearch['current'] = null,
      last: CsvSearch['current'] = null,
      next: CsvSearch['current'] = null
    for (let row = 0; row < this.rowCount; row++) {
      let columns = this.counts[row]
      for (const column of this.patches.get(row)?.keys() ?? [])
        columns = Math.max(columns, column + 1)
      for (let column = 0; column < columns; column++)
        if (this.value(row, column).toLocaleLowerCase().includes(needle)) {
          const hit = { row, column }
          total++
          first ??= hit
          last = hit
          if (!after) {
            if (!backwards && !next) next = hit
            if (backwards) next = hit
          } else if (
            backwards
              ? row < after.row || (row === after.row && column < after.column)
              : row > after.row || (row === after.row && column > after.column)
          ) {
            if (backwards || !next) next = hit
          }
        }
    }
    return {
      identity: this.identity,
      version: this.version,
      query,
      total,
      current: next ?? (backwards ? last : first),
    }
  }
}
