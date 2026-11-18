import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { statfsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertDownloadSpace, downloadWithProgress } from './download.ts'
import { retryUpdate, transientUpdateFailure } from './retry.ts'

test('download free-space preflight accounts for bytes already present on disk', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'update-space-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const destination = join(directory, 'installer')
  await writeFile(destination, 'abc')
  const { bavail, bsize } = statfsSync(directory, { bigint: true })
  assert.doesNotThrow(() => assertDownloadSpace(destination, 3))
  assert.throws(
    () => assertDownloadSpace(destination, Number(bavail * bsize) + 1024 ** 3),
    /ENOSPC/
  )
})

test('update download retries a stalled body and resumes from bytes on disk', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'update-download-'))
  const destination = join(directory, 'installer')
  const ranges: Array<string | undefined> = []
  const server = createServer((request, response) => {
    ranges.push(request.headers.range)
    if (ranges.length === 1) {
      response.writeHead(200, { 'Content-Length': '6' })
      response.write('abc')
      return
    }
    response.writeHead(206, { 'Content-Length': '3', 'Content-Range': 'bytes 3-5/6' })
    response.write('d')
    const middle = setTimeout(() => response.write('e'), 300)
    const end = setTimeout(() => response.end('f'), 600)
    response.once('close', () => {
      clearTimeout(middle)
      clearTimeout(end)
    })
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  await retryUpdate(() =>
    downloadWithProgress(
      `http://127.0.0.1:${address.port}`,
      destination,
      6,
      () => {},
      undefined,
      500
    )
  )
  assert.deepEqual(ranges, [undefined, 'bytes=3-'])
  assert.equal(await readFile(destination, 'utf8'), 'abcdef')
})

test('update download distinguishes missing headers from cancellation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'update-download-'))
  const server = createServer(() => {})
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const download = (signal?: AbortSignal) =>
    downloadWithProgress(
      `http://127.0.0.1:${address.port}`,
      join(directory, 'installer'),
      6,
      () => {},
      signal,
      150
    )
  await assert.rejects(download(), transientUpdateFailure)
  const controller = new AbortController()
  const cancelled = download(controller.signal)
  controller.abort()
  await assert.rejects(cancelled, (error) => error === controller.signal.reason)
})
