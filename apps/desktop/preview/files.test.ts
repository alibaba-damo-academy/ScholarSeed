import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PREVIEW_FILE_ERROR, PreviewFileError, PreviewFiles } from './files.ts'
import { PREVIEW_DOCUMENTS } from './documents.ts'
import { previewDocumentFormat, verifyReviewedSample } from './samples.ts'

const text = (value: string): Uint8Array => new TextEncoder().encode(value)

test('reviewed samples preserve exact bytes and content-derived revisions', () => {
  const files = new PreviewFiles()
  assert.deepEqual(files.list().map(file => file.path), PREVIEW_DOCUMENTS.map(document => document.path).sort())
  for (const file of files.manifest()) {
    const document = PREVIEW_DOCUMENTS.find(document => document.path === file.path)!
    const original = readFileSync(new URL(document.source, import.meta.url))
    assert.deepEqual(files.read(file.path).bytes, new Uint8Array(original))
    assert.equal(file.revision, `sha256:${createHash('sha256').update(original).digest('hex')}`)
    assert.equal(file.size, original.byteLength)
  }
})

test('reviewed manifest rejects altered sample bytes', () => {
  const document = PREVIEW_DOCUMENTS[0]
  assert.throws(() => verifyReviewedSample(document, text('unreviewed replacement')), /hash mismatch/)
})

test('format projection follows current bytes and reused CSV parser rather than fixture identity', () => {
  const files = new PreviewFiles()
  assert.equal(previewDocumentFormat('renamed.bin', files.read('sample.pdf').bytes).contentKind, 'binary')
  assert.equal(previewDocumentFormat('renamed.bin', files.read('sample.pdf').bytes).viewer, 'unsupported')
  assert.equal(previewDocumentFormat('renamed.md', files.read('sample.pdf').bytes).viewer, 'unsupported')
  assert.equal(previewDocumentFormat('note.unknown', text('plain text')).viewer, 'code')
  assert.equal(previewDocumentFormat('measurements.csv', text('Label,Value\n"unclosed,42')).editable, false)
  assert.deepEqual(previewDocumentFormat('measurements.csv', text('Label,Value\n"unclosed,42')).pending, ['spreadsheet_unsafe_roundtrip'])
  assert.equal(previewDocumentFormat('measurements.csv', text('Label,Value\n"quoted, label",42\n')).editable, true)
})

test('saving and reopening share bytes, revision, identity and monotonic mtime without leaking mutable buffers', () => {
  const files = new PreviewFiles()
  const before = files.fileInfo('readme.md')
  const bytes = text('saved markdown')
  const saved = files.write('./readme.md', bytes)
  bytes.fill(0)
  const opened = files.read('readme.md')
  assert.deepEqual(opened.bytes, text('saved markdown'))
  assert.equal(opened.revision, saved.revision)
  assert.equal(opened.identity, before.identity)
  assert.ok(opened.mtime > before.mtime)
  opened.bytes.fill(0)
  assert.deepEqual(files.read('readme.md').bytes, text('saved markdown'))
  assert.deepEqual(files.write('empty.md', new Uint8Array()).size, 0)
})

test('instances and reset isolate mutations from each other and original fixture bytes', () => {
  const first = new PreviewFiles()
  const second = new PreviewFiles()
  const original = second.read('readme.md')
  first.write('readme.md', text('first instance only'))
  first.delete('hello.py')
  first.write('nested/note.md', text('new'))
  assert.deepEqual(second.read('readme.md'), original)
  first.reset()
  assert.deepEqual(first.manifest(), second.manifest())
  assert.deepEqual(first.read('readme.md'), original)
})

test('relative virtual directories support atomic recursive rename and deletion', () => {
  const files = new PreviewFiles()
  const original = files.write('notes//draft.md', text('draft'))
  assert.equal(files.list('notes/')[0].path, 'notes/draft.md')
  files.rename('notes', 'renamed')
  assert.equal(files.read('renamed/draft.md').identity, original.identity)
  assert.equal(files.read('renamed/draft.md').revision, original.revision)
  assert.throws(() => files.rename('renamed', 'readme.md'), PreviewFileError)
  assert.ok(files.read('renamed/draft.md'))
  assert.throws(() => files.rename('renamed', 'renamed/nested'), PreviewFileError)
  files.write('existing/other.md', text('other'))
  assert.throws(() => files.rename('renamed', 'existing'), { code: PREVIEW_FILE_ERROR.conflict })
  files.delete('renamed')
  assert.throws(() => files.read('renamed/draft.md'), { code: PREVIEW_FILE_ERROR.notFound })
})

test('all operations reject traversal, absolute host paths, Windows aliases and NUL on every platform', () => {
  const files = new PreviewFiles()
  for (const path of ['../outside', 'safe/../outside', '/Users/private', 'C:/Users/private', 'C:\\Users\\private', '\\\\server\\share', '//server/share', 'bad\0name']) {
    for (const operation of [() => files.read(path), () => files.write(path, text('bad')), () => files.list(path), () => files.delete(path), () => files.rename('readme.md', path)]) {
      assert.throws(operation, { code: PREVIEW_FILE_ERROR.invalidPath }, path)
    }
  }
  assert.throws(() => files.read('missing.md'), { code: PREVIEW_FILE_ERROR.notFound })
  assert.throws(() => files.list('readme.md'), { code: PREVIEW_FILE_ERROR.notDirectory })
  assert.throws(() => files.write('readme.md/child', text('invalid')), { code: PREVIEW_FILE_ERROR.conflict })
  assert.throws(() => files.write('invalid.md', null as unknown as Uint8Array), { code: PREVIEW_FILE_ERROR.invalidBytes })
})
