import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as images from '../images.ts'
import * as picker from '../picker.ts'

function selection(
  options: {
    sender?: boolean
    canceled?: boolean
    lostSender?: boolean
    lostDuringRead?: boolean
    platform?: string
  } = {}
) {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const start = source.search(
    /ipcMain.handle\((?:'scholarseed:pick-import'|IMPORT_PICKER_CHANNEL),/
  )
  assert.ok(start >= 0)
  const handler = source.slice(start, source.indexOf('\n  })', start) + 5)
  let invoke: (...args: unknown[]) => Promise<unknown>
  const state = { dialogs: 0, reads: [] as string[] }
  const context = {
    ...picker,
    OfficeImageError: images.OfficeImageError,
    ipcMain: {
      handle: (_channel: string, callback: typeof invoke) => {
        invoke = callback
      },
    },
    aliveMainWindow: () => ({}),
    isMainWindowSender: () =>
      options.sender !== false &&
      !(options.lostSender && state.dialogs > 0) &&
      !(options.lostDuringRead && state.reads.length > 0),
    process: { platform: options.platform ?? 'darwin' },
    IMPORT_PICKER_DIALOGS: { file: { options: {}, titleKey: 'file' } },
    mainLocalization: () => ({ getFixedT: () => () => 'file' }),
    dialog: {
      showOpenDialog: async () => {
        state.dialogs++
        return {
          canceled: Boolean(options.canceled),
          filePaths: ['/chosen/image.png', '/chosen/notes.txt', '/chosen/failed.png'],
        }
      },
    },
    readSelectedImage: async (path: string) => {
      state.reads.push(path)
      if (path.endsWith('failed.png'))
        throw new images.OfficeImageError({
          code: 'pixel_limit',
          maxPixels: images.OFFICE_IMAGE_MAX_PIXELS,
        })
      return path.endsWith('.png')
        ? { status: 'image', bytes: new Uint8Array([1, 2]) }
        : { status: 'empty' }
    },
  }
  runInNewContext(
    ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    context
  )
  return {
    state,
    run: async (target: unknown = 'file', preview?: unknown) =>
      structuredClone(await invoke({}, target, preview, '/not-selected/secret.png')),
  }
}

test('import previews read only the native selection and retain failed and non-image paths', async () => {
  const fixture = selection()
  const result = (await fixture.run('file', 'images')) as {
    path: string
    imagePreview: images.OfficeImageResult
  }[]
  assert.deepEqual(
    result.map((item) => item.path),
    ['/chosen/image.png', '/chosen/notes.txt', '/chosen/failed.png']
  )
  assert.deepEqual(
    fixture.state.reads,
    result.map((item) => item.path)
  )
  assert.deepEqual(result[2].imagePreview, {
    status: 'error',
    code: 'pixel_limit',
    maxPixels: images.OFFICE_IMAGE_MAX_PIXELS,
  })
  const legacy = selection()
  assert.deepEqual(await legacy.run(), [
    '/chosen/image.png',
    '/chosen/notes.txt',
    '/chosen/failed.png',
  ])
  assert.deepEqual(legacy.state.reads, [])
})

test('import previews reject invalid sender, target, mode and canceled dialogs without reading', async () => {
  for (const [options, target, preview] of [
    [{ sender: false }, 'file', 'images'],
    [{}, '/arbitrary/path', 'images'],
    [{}, 'file', { path: '/arbitrary/path' }],
    [{ canceled: true }, 'file', 'images'],
    [{ lostSender: true }, 'file', 'images'],
  ] as const) {
    const fixture = selection(options)
    assert.deepEqual(await fixture.run(target, preview), [])
    assert.deepEqual(fixture.state.reads, [])
    assert.equal(fixture.state.dialogs, 'canceled' in options || 'lostSender' in options ? 1 : 0)
  }
})

test('import previews retain platform admission and discard results after their sender closes', async () => {
  const windows = selection({ platform: 'win32' })
  assert.deepEqual(await windows.run('resource', 'images'), [])
  assert.deepEqual(windows.state.reads, [])
  assert.equal(((await windows.run('file', 'images')) as unknown[]).length, 3)
  const closed = selection({ lostDuringRead: true })
  assert.deepEqual(await closed.run('file', 'images'), [])
  assert.equal(closed.state.reads.length, 3)
})
