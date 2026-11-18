import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import * as contract from '../images.ts'

function acquisition(
  options: {
    width?: number
    height?: number
    fileSize?: number
    failure?: unknown
    empty?: boolean
    outputSize?: number
  } = {}
) {
  const state = { reads: 0 }
  const image = {
    isEmpty: () => options.empty ?? false,
    getSize: () => ({ width: options.width ?? 10_000, height: options.height ?? 4_000 }),
    toPNG: () => new Uint8Array(options.outputSize ?? 3),
  }
  const dependencies: Record<string, unknown> = {
    electron: {
      nativeImage: { createFromBuffer: () => image },
    },
    'node:fs/promises': {
      stat: async () => {
        if (options.failure) throw options.failure
        return { isFile: () => true, size: options.fileSize ?? contract.OFFICE_IMAGE_MAX_BYTES }
      },
      readFile: async () => {
        state.reads++
        return new Uint8Array([1])
      },
    },
    'node:path': { extname },
    './remote': { readRemoteImage: async () => new Uint8Array([1]) },
    '../images': contract,
  }
  const exports: {
    readSelectedImage?: (path: string) => Promise<contract.OfficeImageResult>
    acquireRemoteImage?: (source: unknown) => Promise<contract.RemoteImageResult>
  } = {}
  const output = ts.transpileModule(readFileSync(new URL('./images.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(output, {
    exports,
    require: (name: string) => {
      assert.ok(
        Object.prototype.hasOwnProperty.call(dependencies, name),
        `unexpected import: ${name}`
      )
      return dependencies[name]
    },
    Uint8Array,
    Buffer,
    Blob,
    URL,
    Error,
    process,
  })
  return {
    run: () => exports.readSelectedImage!('/sample.png').then((result) => structuredClone(result)),
    remote: () =>
      exports.acquireRemoteImage!('https://example.test/image').then((result) =>
        structuredClone(result)
      ),
    state,
  }
}

test('remote bytes use the existing decoder, pixel and normalized output limits', async () => {
  assert.equal((await acquisition().remote()).status, 'image')
  assert.deepEqual(await acquisition({ empty: true }).remote(), {
    status: 'error',
    code: 'unreadable',
  })
  assert.deepEqual(await acquisition({ height: 4_001 }).remote(), {
    status: 'error',
    code: 'pixel_limit',
  })
  assert.deepEqual(
    await acquisition({ outputSize: contract.OFFICE_IMAGE_MAX_BYTES + 1 }).remote(),
    { status: 'error', code: 'byte_limit' }
  )
})

test('image pixel limit remains inclusive and errors carry the enforced limit across IPC', async () => {
  const boundary = acquisition()
  const accepted = await boundary.run()
  assert.equal(accepted.status, 'image')
  assert.equal(boundary.state.reads, 1)
  const oversized = acquisition({ height: 4_001 })
  await assert.rejects(oversized.run(), (error: unknown) => {
    assert.ok(error instanceof contract.OfficeImageError)
    assert.deepEqual(structuredClone(error.failure), {
      code: 'pixel_limit',
      maxPixels: contract.OFFICE_IMAGE_MAX_PIXELS,
    })
    return true
  })
})

test('file size rejection prevents reading bytes and retains the exact IPC limit', async () => {
  const oversized = acquisition({ fileSize: contract.OFFICE_IMAGE_MAX_BYTES + 1 })
  await assert.rejects(oversized.run(), (error: unknown) => {
    assert.ok(error instanceof contract.OfficeImageError)
    assert.deepEqual(structuredClone(error.failure), {
      code: 'invalid_file',
      maxBytes: contract.OFFICE_IMAGE_MAX_BYTES,
    })
    return true
  })
  assert.equal(oversized.state.reads, 0)
})

test('unknown selected-image read errors preserve the original diagnostics', async () => {
  const failure = acquisition({ failure: new Error('EACCES: source file') })
  await assert.rejects(failure.run(), { message: 'EACCES: source file' })
})
