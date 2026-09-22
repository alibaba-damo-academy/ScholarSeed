import assert from 'node:assert/strict'
import test from 'node:test'

import { hasDraggedFiles, resolveDraggedFilePaths } from './drag.ts'

interface TestFile {
  path?: string
  throws?: boolean
}

function fileList(files: TestFile[]): FileList {
  return files as unknown as FileList
}

test('drag payload detection accepts item and file-list representations', () => {
  assert.equal(hasDraggedFiles({
    files: fileList([]),
    items: [{ kind: 'file' }] as unknown as DataTransferItemList
  }), true)
  assert.equal(hasDraggedFiles({
    files: fileList([{ path: '/tmp/paper.pdf' }]),
    items: [] as unknown as DataTransferItemList
  }), true)
  assert.equal(hasDraggedFiles({
    files: fileList([]),
    items: [{ kind: 'string' }] as unknown as DataTransferItemList
  }), false)
})

test('dropped files resolve to unique OS paths without hiding failures', () => {
  const result = resolveDraggedFilePaths(
    fileList([
      { path: '/tmp/paper.pdf' },
      { path: '/tmp/paper.pdf' },
      { path: '/tmp/dataset' },
      {},
      { throws: true }
    ]),
    (file) => {
      const candidate = file as unknown as TestFile
      if (candidate.throws) throw new Error('unavailable')
      return candidate.path ?? ''
    }
  )

  assert.deepEqual(result, {
    paths: ['/tmp/paper.pdf', '/tmp/dataset'],
    unresolvedCount: 2
  })
})

test('dropped files fail closed when the Electron path bridge is unavailable', () => {
  assert.deepEqual(
    resolveDraggedFilePaths(fileList([{ path: '/tmp/paper.pdf' }]), undefined),
    { paths: [], unresolvedCount: 1 }
  )
})
