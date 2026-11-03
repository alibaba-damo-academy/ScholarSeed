import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRecord, writeJson } from './journal.ts'
import * as fs from 'node:fs'
import * as pathModule from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

test('bounded record reads preserve bytes and reject oversized or non-file inputs', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'record-reader-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'record.json')
  const bytes = Buffer.from('{"value":"中文"}\r\n')
  fs.writeFileSync(file, bytes)
  assert.deepEqual(readRecord(file, bytes.length), bytes)
  assert.throws(() => readRecord(file, bytes.length - 1), /oversized/)
  assert.throws(() => readRecord(root, 1024))
  assert.throws(() => readRecord(file, -1), RangeError)
  assert.throws(() => readRecord(file, Infinity), RangeError)
  assert.deepEqual(readFileSync(file), bytes)
  fs.writeFileSync(file, '')
  assert.equal(readRecord(file, 0).length, 0)
})

test('a failed receipt write preserves the last complete record and removes its temporary file', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'update-receipt-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'preparation.json')
  writeJson(path, { generation: 1 })
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.throws(() => writeJson(path, cyclic))
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { generation: 1 })
  assert.deepEqual(readdirSync(root), ['preparation.json'])
  writeJson(path, { generation: 2 })
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { generation: 2 })
})

function controlledWriter(overrides: Record<string, unknown>) {
  const exports: Record<string, (path: string, value: unknown) => void> = {}
  const source = readFileSync(new URL('./journal.ts', import.meta.url), 'utf8')
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports,
      process,
      require: (name: string) => {
        if (name === 'node:fs') return { ...fs, ...overrides }
        if (name === 'node:path') return pathModule
        if (name === 'node:crypto') return { randomUUID: () => 'controlled' }
        throw new Error(`unexpected import ${name}`)
      },
    }
  )
  return exports.writeJson
}

test('exclusive temporary creation failure must preserve a pre-existing file', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'journal-collision-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'storage-config.json')
  fs.writeFileSync(path, '{"schemaVersion":1,"dataHome":"/old"}')
  const temporary = `${path}.controlled.tmp`
  fs.writeFileSync(temporary, 'another writer owns this')
  assert.throws(() => controlledWriter({})(path, { dataHome: '/new' }), { code: 'EEXIST' })
  assert.equal(readFileSync(temporary, 'utf8'), 'another writer owns this')
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).dataHome, '/old')
})

for (const operation of ['writeFileSync', 'fsyncSync', 'renameSync'] as const) {
  test(`failure in ${operation} preserves the previous pointer and removes only its temporary`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'journal-failure-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const path = join(root, 'storage-config.json')
    const old = '{"schemaVersion":1,"dataHome":"/old"}'
    fs.writeFileSync(path, old)
    const failure = new Error(operation)
    const write = controlledWriter({
      [operation]: () => {
        throw failure
      },
    })
    assert.throws(
      () => write(path, { schemaVersion: 1, dataHome: '/new' }),
      (error) => error === failure
    )
    assert.equal(readFileSync(path, 'utf8'), old)
    assert.deepEqual(readdirSync(root), ['storage-config.json'])
  })
}

test('readers observe the old complete pointer until the replacement is published', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'journal-publication-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'storage-config.json')
  const old = { schemaVersion: 1, dataHome: '/old' }
  const next = { schemaVersion: 1, dataHome: '/new' }
  fs.writeFileSync(path, JSON.stringify(old))
  let observed = false
  const write = controlledWriter({
    renameSync: (source: string, destination: string) => {
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), old)
      assert.deepEqual(JSON.parse(readFileSync(source, 'utf8')), next)
      observed = true
      fs.renameSync(source, destination)
    },
  })
  write(path, next)
  assert.equal(observed, true)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), next)
  assert.deepEqual(readdirSync(root), ['storage-config.json'])
})

test('an uncertain close is not retried and the previous record remains published', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'journal-close-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'state.json')
  fs.writeFileSync(path, '{"generation":1}')
  let closes = 0
  const failure = new Error('close receipt lost')
  const write = controlledWriter({
    closeSync: (descriptor: number) => {
      closes++
      fs.closeSync(descriptor)
      throw failure
    },
  })
  assert.throws(
    () => write(path, { generation: 2 }),
    (error) => error === failure
  )
  assert.equal(closes, 1)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { generation: 1 })
})

test('publication relinquishes ownership of the temporary name', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'journal-transfer-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'state.json')
  const write = controlledWriter({
    renameSync: (source: string, destination: string) => {
      fs.renameSync(source, destination)
      fs.writeFileSync(source, 'next owner')
    },
  })
  write(path, { generation: 2 })
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { generation: 2 })
  assert.equal(readFileSync(`${path}.controlled.tmp`, 'utf8'), 'next owner')
})

if (process.platform !== 'win32') {
  test('directory flush failure reports failure after publishing a complete record', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'journal-directory-flush-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const path = join(root, 'state.json')
    fs.writeFileSync(path, '{"generation":1}')
    const failure = new Error('directory flush failed')
    const write = controlledWriter({
      fsyncSync: (descriptor: number) => {
        if (fs.fstatSync(descriptor).isDirectory()) throw failure
        fs.fsyncSync(descriptor)
      },
    })
    assert.throws(
      () => write(path, { generation: 2 }),
      (error) => error === failure
    )
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { generation: 2 })
    assert.deepEqual(readdirSync(root), ['state.json'])
  })
}
