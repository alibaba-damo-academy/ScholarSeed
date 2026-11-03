import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasDraggedFiles,
  resolveDraggedFilePaths,
  hasDraggedLiterature,
  writeLiteratureDrag,
  readLiteratureDrag,
  LITERATURE_DRAG_TYPE,
  PROJECT_ENTRY_DRAG_TYPE,
  hasDraggedProjectEntry,
  writeProjectEntryDrag,
  readProjectEntryDrag,
} from './drag.ts'

interface TestFile {
  path?: string
  throws?: boolean
}

function transfer(): DataTransfer {
  const values = new Map<string, string>()
  return {
    get types() {
      return [...values.keys()]
    },
    setData: (type: string, value: string) => values.set(type, value),
    getData: (type: string) => values.get(type) ?? '',
  } as unknown as DataTransfer
}

const first = { id: 'paper-1', title: 'First paper' }
const second = { id: 'paper-2', title: 'Second paper' }

test('project files and whole directories retain owner-relative identity without file upload data', () => {
  for (const kind of ['file', 'dir'] as const) {
    const data = transfer()
    const entry = { kind, path: 'resources/研究资料', name: '研究资料' }
    writeProjectEntryDrag(data, 'project-1', {
      ...entry,
      ...{ absolutePath: '/private/source', children: ['not part of the reference'] },
    })
    assert.equal(hasDraggedProjectEntry(data), true)
    assert.equal(data.effectAllowed, 'copy')
    assert.deepEqual(readProjectEntryDrag(data, 'project-1'), entry)
    assert.equal(readProjectEntryDrag(data, 'project-2'), null)
    assert.equal(readProjectEntryDrag(data, null), null)
    assert.equal(data.getData('text/plain'), '')
    assert.equal(data.getData(PROJECT_ENTRY_DRAG_TYPE).includes('/private/source'), false)
    assert.equal(hasDraggedLiterature(data), false)
  }
})

test('protected and malformed project drags reject invalid paths and identities', () => {
  const data = transfer()
  assert.equal(hasDraggedProjectEntry(data), false)
  for (const raw of ['', 'null', '{}', 'not json']) {
    data.setData(PROJECT_ENTRY_DRAG_TYPE, raw)
    assert.equal(hasDraggedProjectEntry(data), true)
    assert.equal(readProjectEntryDrag(data, 'project-1'), null)
  }
  for (const path of [
    '',
    '/tmp/file',
    '../file',
    'resources/../file',
    'C:/file',
    'C:\\file',
    '\\\\server\\file',
    'a\u0000b',
    './file',
    'a//file',
  ]) {
    writeProjectEntryDrag(data, 'project-1', { kind: 'file', path, name: 'file' })
    assert.equal(readProjectEntryDrag(data, 'project-1'), null, path)
  }
  for (const entry of [
    { kind: 'file', path: 'file' },
    { kind: 'resource', path: 'file', name: 'file' },
  ]) {
    data.setData(PROJECT_ENTRY_DRAG_TYPE, JSON.stringify({ projectId: 'project-1', entry }))
    assert.equal(readProjectEntryDrag(data, 'project-1'), null)
  }
})

test('a project paper drag preserves identity and copies a reference, not a file', () => {
  const data = transfer()
  writeLiteratureDrag(data, 'project-1', first, [])
  assert.equal(data.effectAllowed, 'copy')
  assert.equal(hasDraggedLiterature(data), true)
  assert.deepEqual(readLiteratureDrag(data, 'project-1'), [first])
  assert.equal(data.getData('text/plain'), '')
})

test('dragging a selected row carries the selection; an unselected row carries only itself', () => {
  const data = transfer()
  writeLiteratureDrag(data, 'project-1', first, [first, second])
  assert.deepEqual(readLiteratureDrag(data, 'project-1'), [first, second])
  writeLiteratureDrag(data, 'project-1', second, [first])
  assert.deepEqual(readLiteratureDrag(data, 'project-1'), [second])
})

test('project paper drags cannot cross projects or target an unscoped composer', () => {
  const data = transfer()
  writeLiteratureDrag(data, 'project-1', first, [])
  assert.equal(readLiteratureDrag(data, 'project-2'), null)
  assert.equal(readLiteratureDrag(data, null), null)
})

test('drag type detection works while browser protects the drag data until drop', () => {
  const data = transfer()
  data.setData(LITERATURE_DRAG_TYPE, '')
  assert.equal(hasDraggedLiterature(data), true)
  assert.equal(readLiteratureDrag(data, 'project-1'), null)
  assert.equal(hasDraggedLiterature(transfer()), false)
})

test('malformed paper payloads fail closed without accepting a partial selection', () => {
  const data = transfer()
  for (const value of [
    'not json',
    'null',
    '[]',
    JSON.stringify({ projectId: 'project-1', items: [] }),
    JSON.stringify({ projectId: 'project-1', items: [first, { id: '', title: 'Invalid' }] }),
    JSON.stringify({ projectId: 'project-1', items: [{ id: 'paper-1' }] }),
  ]) {
    data.setData(LITERATURE_DRAG_TYPE, value)
    assert.equal(readLiteratureDrag(data, 'project-1'), null)
  }
})

function fileList(files: TestFile[]): FileList {
  return files as unknown as FileList
}

test('drag payload detection accepts item and file-list representations', () => {
  assert.equal(
    hasDraggedFiles({
      files: fileList([]),
      items: [{ kind: 'file' }] as unknown as DataTransferItemList,
    }),
    true
  )
  assert.equal(
    hasDraggedFiles({
      files: fileList([{ path: '/tmp/paper.pdf' }]),
      items: [] as unknown as DataTransferItemList,
    }),
    true
  )
  assert.equal(
    hasDraggedFiles({
      files: fileList([]),
      items: [{ kind: 'string' }] as unknown as DataTransferItemList,
    }),
    false
  )
})

test('dropped files resolve to unique OS paths without hiding failures', () => {
  const result = resolveDraggedFilePaths(
    fileList([
      { path: '/tmp/paper.pdf' },
      { path: '/tmp/paper.pdf' },
      { path: '/tmp/dataset' },
      {},
      { throws: true },
    ]),
    (file) => {
      const candidate = file as unknown as TestFile
      if (candidate.throws) throw new Error('unavailable')
      return candidate.path ?? ''
    }
  )

  assert.deepEqual(result, {
    paths: ['/tmp/paper.pdf', '/tmp/dataset'],
    unresolvedCount: 2,
  })
})

test('dropped files fail closed when the Electron path bridge is unavailable', () => {
  assert.deepEqual(resolveDraggedFilePaths(fileList([{ path: '/tmp/paper.pdf' }]), undefined), {
    paths: [],
    unresolvedCount: 1,
  })
})
