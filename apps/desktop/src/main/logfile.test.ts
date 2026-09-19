import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'

import { LOG_BACKUPS, LOG_BACKUP_SUFFIX, LOG_MAX_BYTES, LineTimestamper, RotatingFileLog } from './logfile.ts'

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'scholarseed-logfile-'))
}

// A write stream flushes asynchronously and a rotated generation is compressed off
// the critical path, so assertions wait for the expected file to appear.
async function waitFor(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(path)) return
    await new Promise((res) => setTimeout(res, 20))
  }
  assert.fail(`timed out waiting for ${path}`)
}

async function settle(): Promise<void> {
  await new Promise((res) => setTimeout(res, 20))
}

function gunzipped(path: string): string {
  return gunzipSync(readFileSync(path)).toString('utf-8')
}

test('defaults cap the live file and keep a bounded number of gzipped generations', () => {
  assert.equal(LOG_MAX_BYTES, 50 * 1024 * 1024)
  assert.equal(LOG_BACKUPS, 3)
  assert.equal(LOG_BACKUP_SUFFIX, '.gz')
})

test('appends to an existing log without rotating below the cap', async () => {
  const dir = workdir()
  const path = join(dir, 'backend.log')
  writeFileSync(path, 'old\n')
  const logFile = new RotatingFileLog(path, { maxBytes: 1024, backups: 2 })
  logFile.write('new\n')
  logFile.end()
  await settle()
  assert.equal(readFileSync(path, 'utf-8'), 'old\nnew\n')
  assert.deepEqual(readdirSync(dir), ['backend.log'])
  rmSync(dir, { recursive: true, force: true })
})

test('rotates the live file into a gzipped generation once the cap is exceeded', async () => {
  const dir = workdir()
  const path = join(dir, 'backend.log')
  const logFile = new RotatingFileLog(path, { maxBytes: 8, backups: 2 })
  logFile.write('aaaaa\n')
  logFile.write('bbbbb\n')
  logFile.end()
  await waitFor(`${path}.1.gz`)
  assert.equal(readFileSync(path, 'utf-8'), 'bbbbb\n')
  assert.equal(gunzipped(`${path}.1.gz`), 'aaaaa\n')
  // the pre-compression copy must not survive as a second, uncompressed copy
  assert.deepEqual(readdirSync(dir).sort(), ['backend.log', 'backend.log.1.gz'])
  rmSync(dir, { recursive: true, force: true })
})

test('a single oversized write still lands instead of being dropped', async () => {
  const dir = workdir()
  const path = join(dir, 'backend.log')
  const logFile = new RotatingFileLog(path, { maxBytes: 4, backups: 1 })
  logFile.write('long line beyond the cap\n')
  logFile.end()
  await settle()
  assert.equal(readFileSync(path, 'utf-8'), 'long line beyond the cap\n')
  assert.deepEqual(readdirSync(dir), ['backend.log'])
  rmSync(dir, { recursive: true, force: true })
})

test('disk usage stays bounded: the oldest generation is dropped', async () => {
  const dir = workdir()
  const path = join(dir, 'backend.log')
  const logFile = new RotatingFileLog(path, { maxBytes: 8, backups: 2 })
  for (const line of ['one\n', 'two\n', 'three\n', 'four\n', 'five\n', 'six\n']) {
    logFile.write(line)
    logFile.write('pad-to-cap\n')
  }
  logFile.end()
  // 一次 archive 内是先把 .1.gz 移成 .2.gz、再压出新的 .1.gz。只等 .2.gz 会在这
  // 两步之间返回, 那一刻 .1.gz 还不存在 —— 两代都等到, 才是这轮滚动真的收尾。
  await waitFor(`${path}.2.gz`)
  await waitFor(`${path}.1.gz`)
  assert.equal(existsSync(`${path}.3.gz`), false)
  rmSync(dir, { recursive: true, force: true })
})

test('an uncompressed generation left by a failed compression is still shifted', async () => {
  const dir = workdir()
  const path = join(dir, 'backend.log')
  writeFileSync(`${path}.1`, 'raw generation\n')
  const logFile = new RotatingFileLog(path, { maxBytes: 8, backups: 3 })
  logFile.write('aaaaa\n')
  logFile.write('bbbbb\n')
  logFile.end()
  await waitFor(`${path}.1.gz`)
  assert.equal(readFileSync(`${path}.2`, 'utf-8'), 'raw generation\n')
  assert.equal(existsSync(`${path}.1`), false)
  rmSync(dir, { recursive: true, force: true })
})

test('creates the log directory when it does not exist yet', async () => {
  const dir = workdir()
  const path = join(dir, 'logs', 'backend.log')
  const logFile = new RotatingFileLog(path, { maxBytes: 1024 })
  logFile.write('hello\n')
  logFile.end()
  await settle()
  assert.equal(readFileSync(path, 'utf-8'), 'hello\n')
  rmSync(dir, { recursive: true, force: true })
})

// A fixed local-time clock keeps the stamped prefix deterministic across timezones.
const FIXED_STAMP = '2026-09-16 14:03:22.512'
function fixedClock(): () => Date {
  return () => new Date(2026, 8, 16, 14, 3, 22, 512)
}

test('prefixes each complete line with a timestamp', () => {
  const out: string[] = []
  const stamper = new LineTimestamper((line) => out.push(line), fixedClock())
  stamper.push('one\ntwo\n')
  assert.deepEqual(out, [`${FIXED_STAMP} one\n`, `${FIXED_STAMP} two\n`])
})

test('buffers a partial line across chunks and emits whole lines from one chunk', () => {
  const out: string[] = []
  const stamper = new LineTimestamper((line) => out.push(line), fixedClock())
  stamper.push('par')
  assert.deepEqual(out, [])
  stamper.push('tial\nsecond\n')
  assert.deepEqual(out, [`${FIXED_STAMP} partial\n`, `${FIXED_STAMP} second\n`])
})

test('an empty line carries only the timestamp', () => {
  const out: string[] = []
  const stamper = new LineTimestamper((line) => out.push(line), fixedClock())
  stamper.push('\n')
  assert.deepEqual(out, [`${FIXED_STAMP}\n`])
})

test('flush releases a trailing partial line with a newline', () => {
  const out: string[] = []
  const stamper = new LineTimestamper((line) => out.push(line), fixedClock())
  stamper.push('no-newline-tail')
  assert.deepEqual(out, [])
  stamper.flush()
  assert.deepEqual(out, [`${FIXED_STAMP} no-newline-tail\n`])
  // a second flush with an empty buffer emits nothing
  stamper.flush()
  assert.deepEqual(out, [`${FIXED_STAMP} no-newline-tail\n`])
})
