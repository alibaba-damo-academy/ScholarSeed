import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import * as contract from '../images.ts'

function acquisition(options: { width?: number; height?: number; fileSize?: number; failure?: unknown } = {}) {
  const state = { reads: 0 }
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: options.width ?? 10_000, height: options.height ?? 4_000 }),
    toPNG: () => new Uint8Array([1, 2, 3])
  }
  const dependencies: Record<string, unknown> = {
    electron: {
      clipboard: { read: async () => [], readText: async () => '' },
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/sample.png'] }) },
      nativeImage: { createFromBuffer: () => image }
    },
    'node:fs/promises': {
      stat: async () => { if (options.failure) throw options.failure; return { isFile: () => true, size: options.fileSize ?? contract.OFFICE_IMAGE_MAX_BYTES } },
      readFile: async () => { state.reads++; return new Uint8Array([1]) }
    },
    'node:path': { extname },
    'node:url': { fileURLToPath },
    './localization': { mainLocalization: () => ({ getFixedT: () => (key: string) => key }) },
    '../images': contract
  }
  const exports: { acquireOfficeImage?: (window: unknown, source: contract.OfficeImageSource) => Promise<contract.OfficeImageResult> } = {}
  const output = ts.transpileModule(readFileSync(new URL('./images.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  runInNewContext(output, { exports, require: (name: string) => {
    assert.ok(Object.prototype.hasOwnProperty.call(dependencies, name), `unexpected import: ${name}`)
    return dependencies[name]
  }, Uint8Array, Buffer, Blob, URL, Error, process })
  return { run: () => exports.acquireOfficeImage!({}, 'file').then(result => structuredClone(result)), state }
}

test('image pixel limit remains inclusive and errors carry the enforced limit across IPC', async () => {
  const boundary = acquisition()
  const accepted = await boundary.run()
  assert.equal(accepted.status, 'image')
  assert.equal(boundary.state.reads, 1)
  const oversized = acquisition({ height: 4_001 })
  assert.deepEqual(await oversized.run(), { status: 'error', code: 'pixel_limit', maxPixels: contract.OFFICE_IMAGE_MAX_PIXELS })
})

test('file size rejection prevents reading bytes and retains the exact IPC limit', async () => {
  const oversized = acquisition({ fileSize: contract.OFFICE_IMAGE_MAX_BYTES + 1 })
  const result = await oversized.run()
  assert.deepEqual(result, { status: 'error', code: 'invalid_file', maxBytes: contract.OFFICE_IMAGE_MAX_BYTES })
  assert.equal(oversized.state.reads, 0)
  assert.deepEqual(structuredClone(result), result)
})

test('unknown image read errors preserve diagnostics while supplying a stable display code', async () => {
  const failure = acquisition({ failure: new Error('EACCES: source file') })
  assert.deepEqual(await failure.run(), { status: 'error', code: 'read_failed', message: 'EACCES: source file' })
})
