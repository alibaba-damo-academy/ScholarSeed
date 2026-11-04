import assert from 'node:assert/strict'
import test from 'node:test'
import { CsvModel } from './model.ts'

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)

const GBK_TODO = Uint8Array.from(
  Buffer.from(
    'c7ebc4e3b0efced2bfaab7a2d2bbb8f620546f646f2d6c697374a3acc2fad7e3d2d4cfc2d0e8c7f3a3ba0d0accedbcd32fc9beb3fdc8cecef10d0ab1eabcc7c8cecef1ceaacdeab3c90d0ab0b4d7b4ccacc9b8d1a1a3a8c8abb2bfa1a2bbeed4bea1a2d2d1cdeab3c9a3a90d0ac8cecef1bcc6cafdc6f70d0acafdbeddb3d6bec3bbafd4dae4afc0c0c6f7b4e6b4a2d6d0',
    'hex'
  )
)
const TODO_ROWS = [
  ['请你帮我开发一个 Todo-list，满足以下需求：'],
  ['添加/删除任务'],
  ['标记任务为完成'],
  ['按状态筛选（全部、活跃、已完成）'],
  ['任务计数器'],
  ['数据持久化在浏览器存储中'],
]

test('88482309 original GBK CSV reads six rows without dirtying or rewriting its encoding', () => {
  const original = GBK_TODO.slice()
  const model = new CsvModel(original, 'gbk-todo')
  assert.equal(model.state().sourceEncoding, 'gbk')
  assert.equal(model.dirty, false)
  assert.deepEqual(model.readWindow({ row: 0, column: 0, rows: 10, columns: 10 }).cells, TODO_ROWS)
  assert.deepEqual(original, GBK_TODO)
  assert.deepEqual(model.serialize().bytes, GBK_TODO)
  const reopened = new CsvModel(model.serialize().bytes, 'reopened')
  assert.equal(reopened.state().sourceEncoding, 'gbk')
  assert.deepEqual(
    reopened.readWindow({ row: 0, column: 0, rows: 10, columns: 10 }).cells,
    TODO_ROWS
  )
  assert.equal(model.copy({ top: 1, left: 0, bottom: 1, right: 0 }).text, TODO_ROWS[1][0])
  assert.equal(model.search('任务').total, 3)
})

test('GBK normalization precedes delimiter scanning and keeps quoted fields and mixed newlines', () => {
  const source = Uint8Array.of(
    0x22,
    0x81,
    0x7c,
    0x22,
    0x7c,
    0xc8,
    0xce,
    0xce,
    0xf1,
    0x0d,
    0x0a,
    0x32,
    0x7c,
    0x33,
    0x0a
  )
  const model = new CsvModel(source, 'gbk-pipe')
  assert.equal(model.dialect.delimiter, '|')
  assert.equal(model.columnCount, 2)
  assert.equal(model.value(0, 0), new TextDecoder('gbk').decode(Uint8Array.of(0x81, 0x7c)))
  assert.equal(model.value(0, 1), '任务')
  assert.deepEqual(model.serialize().bytes, source)
})

test('GBK model rejects every mutation and exposes only copies of its original bytes', () => {
  const source = GBK_TODO.slice()
  const model = new CsvModel(source, 'gbk-readonly')
  source.fill(0)
  assert.throws(() => model.edit([{ row: 1, column: 0, value: 'modified' }], 0), /csv_readonly/)
  assert.throws(() => model.paste(1, 0, 'modified', 0), /csv_readonly/)
  assert.throws(() => model.undo(0), /csv_readonly/)
  assert.throws(() => model.redo(0), /csv_readonly/)
  const snapshot = model.serialize()
  snapshot.bytes.fill(0)
  assert.deepEqual(model.serialize().bytes, GBK_TODO)
  assert.equal(model.version, 0)
  assert.equal(model.dirty, false)
  assert.equal(model.state().canUndo, false)
  assert.equal(model.state().canRedo, false)
})

test('valid UTF-8 takes precedence over GBK and remains byte-identical until edited', () => {
  for (const text of ['任务,001\r\n', '\ufeff任务;001\n', 'plain,ASCII\r']) {
    const source = encode(text)
    const model = new CsvModel(source, 'utf8')
    assert.equal(model.state().sourceEncoding, 'utf-8')
    assert.deepEqual(model.serialize().bytes, source)
    assert.equal(model.dirty, false)
  }
})

test('invalid GBK, malformed BOM-tagged UTF-8 and UTF-16 are not silently reinterpreted', () => {
  for (const bytes of [
    Uint8Array.of(0x81),
    Uint8Array.of(0xef, 0xbb, 0xbf, 0xff),
    Uint8Array.of(0xff, 0xfe, 0x61, 0x00),
  ]) {
    assert.throws(() => new CsvModel(bytes, 'invalid'), /csv_encoding_invalid/)
  }
})

test('CSV cells retain literal strings, ragged rows, multiline quotes and escaped quotes', () => {
  const source = encode('id,value,note\r\n001,1e3,"line one\r\nline two"\r\n2,"a,""b"""\r\n\r\n')
  const model = new CsvModel(source, 'sha256:source')
  assert.equal(model.rowCount, 4)
  assert.equal(model.columnCount, 3)
  assert.deepEqual(model.readWindow({ row: 1, column: 0, rows: 2, columns: 3 }).cells, [
    ['001', '1e3', 'line one\r\nline two'],
    ['2', 'a,"b"', ''],
  ])
  assert.deepEqual(model.serialize().bytes, source)
})

test('BOM and semicolon dialect survive editing; unrelated raw fields and records remain exact', () => {
  const source = encode('\ufeff"id";value;note\r\n001;1e3;"unchanged"\r\n002;7;keep\n')
  const model = new CsvModel(source, 'sha256:source')
  assert.equal(model.dialect.delimiter, ';')
  assert.equal(model.dialect.bom, true)
  model.edit([{ row: 1, column: 1, value: 'x;y\nz' }], model.version)
  assert.equal(
    decode(model.serialize().bytes),
    '\ufeff"id";value;note\r\n001;"x;y\nz";"unchanged"\r\n002;7;keep\n'
  )
})

test('empty file and a single empty record differ; adding a value extends ragged columns only', () => {
  assert.equal(new CsvModel(new Uint8Array(), 'empty').rowCount, 0)
  assert.equal(new CsvModel(encode('\r\n'), 'blank').rowCount, 1)
  const model = new CsvModel(encode('a,b\r\nc\r\n'), 'source')
  model.edit([{ row: 1, column: 3, value: 'd' }], 0)
  assert.equal(decode(model.serialize().bytes), 'a,b\r\nc,,,d\r\n')
  assert.equal(model.columnCount, 4)
})

test('edit, undo and redo advance versions and stale mutations fail without changing data', () => {
  const model = new CsvModel(encode('001,1e3\n'), 'source')
  model.edit([{ row: 0, column: 0, value: '002' }], 0)
  assert.throws(() => model.edit([{ row: 0, column: 0, value: '003' }], 0), /csv_version_conflict/)
  assert.equal(model.undo(model.version), true)
  assert.equal(decode(model.serialize().bytes), '001,1e3\n')
  assert.equal(model.redo(model.version), true)
  assert.equal(decode(model.serialize().bytes), '002,1e3\n')
  assert.equal(model.version, 3)
})

test('serialize snapshot owns version V and is immutable after a later edit', () => {
  const model = new CsvModel(encode('a,b\n'), 'source')
  model.edit([{ row: 0, column: 0, value: 'x' }], 0)
  const saved = model.serialize()
  model.edit([{ row: 0, column: 0, value: 'y' }], 1)
  assert.equal(saved.version, 1)
  assert.equal(decode(saved.bytes), 'x,b\n')
  assert.equal(decode(model.serialize().bytes), 'y,b\n')
  model.acknowledgeSaved(saved.version, 'revision-x')
  assert.equal(model.dirty, true)
  const newer = model.serialize()
  model.acknowledgeSaved(newer.version, 'revision-y')
  assert.equal(model.dirty, false)
  model.undo(model.version)
  assert.equal(model.dirty, true)
})

test('paste is one transaction, duplicate cells use last value, noop leaves version unchanged', () => {
  const model = new CsvModel(encode('a,b\nc,d\n'), 'source')
  model.edit(
    [
      { row: 0, column: 0, value: 'x' },
      { row: 1, column: 1, value: 'y' },
      { row: 0, column: 0, value: 'z' },
    ],
    0
  )
  assert.equal(model.version, 1)
  assert.equal(decode(model.serialize().bytes), 'z,b\nc,y\n')
  model.edit([{ row: 0, column: 0, value: 'z' }], 1)
  assert.equal(model.version, 1)
  model.undo(1)
  assert.equal(decode(model.serialize().bytes), 'a,b\nc,d\n')
  assert.equal(model.dirty, false)
  assert.throws(() =>
    model.edit(
      [
        { row: 0, column: 0, value: 'corrupt' },
        { row: 3, column: 0, value: 'bad' },
      ],
      2
    )
  )
  assert.equal(decode(model.serialize().bytes), 'a,b\nc,d\n')
})

test('search wraps in both directions and sees sparse edits without interpreting formulas', () => {
  const model = new CsvModel(encode('Alpha,beta\nalpha,=1+1\n'), 'source')
  assert.deepEqual(model.search('alpha').current, { row: 0, column: 0 })
  assert.deepEqual(model.search('alpha', { row: 0, column: 0 }).current, { row: 1, column: 0 })
  assert.deepEqual(model.search('alpha', { row: 1, column: 0 }).current, { row: 0, column: 0 })
  assert.deepEqual(model.search('alpha', { row: 0, column: 0 }, true).current, {
    row: 1,
    column: 0,
  })
  model.edit([{ row: 0, column: 1, value: 'ALPHA' }], 0)
  assert.equal(model.search('alpha').total, 3)
  assert.equal(model.value(1, 1), '=1+1')
})

test('bounded range yields source strings and reference mode without allocating the whole selection', () => {
  const model = new CsvModel(encode('id,value\n001,1e3\n'), 'source')
  assert.equal(
    model.getRange({ top: 1, left: 0, bottom: 1, right: 1 }, { cells: 100, chars: 100 }).text,
    '001\t1e3'
  )
  assert.equal(
    model.getRange({ top: 0, left: 0, bottom: 1, right: 1 }, { cells: 1, chars: 100 }).mode,
    'reference'
  )
})

test('range crops only unused trailing cells, keeps interior blanks, and sees patched clears', () => {
  const model = new CsvModel(encode('a,,b\n,,\n,,\n'), 'source')
  assert.deepEqual(
    model.getRange({ top: 0, left: 0, bottom: 2, right: 2 }, { cells: 100, chars: 100 }).range,
    { top: 0, left: 0, bottom: 0, right: 2 }
  )
  assert.equal(
    model.getRange({ top: 0, left: 0, bottom: 2, right: 2 }, { cells: 100, chars: 100 }).text,
    'a\t\tb'
  )
  model.edit([{ row: 0, column: 2, value: '' }], 0)
  assert.deepEqual(
    model.getRange({ top: 0, left: 0, bottom: 2, right: 2 }, { cells: 100, chars: 100 }).range,
    { top: 0, left: 0, bottom: 0, right: 0 }
  )
  assert.equal(
    model.getRange({ top: 1, left: 0, bottom: 2, right: 2 }, { cells: 100, chars: 100 }).text,
    ''
  )
})

test('malformed quotes and invalid UTF8 fail; no replacement-character round trip', () => {
  assert.throws(() => new CsvModel(Uint8Array.of(0xff), 'source'), /csv_encoding_invalid/)
  assert.throws(() => new CsvModel(encode('a,"unterminated'), 'source'), /csv_quotes_invalid/)
  assert.throws(() => new CsvModel(encode('a,"closed"junk\n'), 'source'), /csv_quotes_invalid/)
})

test('TSV copy preserves embedded tabs, multiline quotes and literal numeric source strings', () => {
  const source = encode('"a\tb","line one\nline two"\r\n001,"he said ""hi"""\r\n')
  const model = new CsvModel(source, 'source')
  const copied = model.copy({ top: 0, left: 0, bottom: 1, right: 1 })
  assert.equal(copied.text, '"a\tb"\t"line one\nline two"\n001\t"he said ""hi"""')
  assert.deepEqual(model.serialize().bytes, source)
  const destination = new CsvModel(encode('x,y\nx,y\n'), 'destination')
  destination.paste(0, 0, copied.text, 0)
  assert.deepEqual(destination.readWindow({ row: 0, column: 0, rows: 2, columns: 2 }).cells, [
    ['a\tb', 'line one\nline two'],
    ['001', 'he said "hi"'],
  ])
  assert.equal(destination.version, 1)
  destination.undo(1)
  assert.equal(decode(destination.serialize().bytes), 'x,y\nx,y\n')
})

test('ragged TSV paste pads a rectangle in one transaction and source CSV dialect remains intact', () => {
  const model = new CsvModel(encode('\ufeffa;b;c\r\nx;y;z\r\n'), 'source')
  model.paste(0, 0, '001\t1e3\n"x\ny"', 0)
  assert.deepEqual(model.readWindow({ row: 0, column: 0, rows: 2, columns: 3 }).cells, [
    ['001', '1e3', 'c'],
    ['x\ny', '', 'z'],
  ])
  assert.equal(decode(model.serialize().bytes), '\ufeff001;1e3;c\r\n"x\ny";;z\r\n')
  assert.equal(model.version, 1)
})

test('invalid and overflowing TSV paste is atomic; empty paste and literal quoted prose are safe', () => {
  const source = encode('a,b\n'),
    model = new CsvModel(source, 'source')
  assert.throws(() => model.paste(0, 0, 'x\ny', 0), /csv_paste_range_invalid/)
  assert.throws(() => model.paste(0, 0, '"unterminated\tfield', 0), /csv_quotes_invalid/)
  assert.deepEqual(model.serialize().bytes, source)
  assert.equal(model.paste(0, 0, '', 0).version, 0)
  model.paste(0, 0, 'He said "hi"', 0)
  assert.equal(model.value(0, 0), 'He said "hi"')
})
