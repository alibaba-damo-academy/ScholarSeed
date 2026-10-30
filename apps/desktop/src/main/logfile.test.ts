import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import { API_DIAGNOSTIC_PREFIX } from '../requests.ts'

import {
  LOG_BACKUPS,
  LOG_BACKUP_SUFFIX,
  LOG_MAX_BYTES,
  LineTimestamper,
  RotatingFileLog,
  isRendererDiagnostic,
} from './logfile.ts'

test('registered renderer diagnostics persist even at info level without capturing arbitrary console text', () => {
  for (const prefix of [
    '[login-confirmation]',
    '[preferences]',
    '[office-runtime]',
    '[session-stream]',
    '[navigation]',
    '[session-recovery]',
    '[notification]',
    '[account-menu]',
    API_DIAGNOSTIC_PREFIX,
  ]) {
    assert.equal(isRendererDiagnostic(`${prefix} {"stage":"live"}`), true)
  }
  assert.equal(isRendererDiagnostic('unregistered private text'), false)
  assert.equal(isRendererDiagnostic('private [session-stream] text'), false)
})

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'scholarseed-logfile-'))
}

test('log ownership is released while idle and retained through queued archives', async (t) => {
  const dir = workdir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'activity.log')
  let acquired = 0
  let closed = 0
  const log = new RotatingFileLog(path, {
    maxBytes: 4,
    acquireWriter: () => {
      acquired++
      return {
        close() {
          closed++
        },
      }
    },
  })
  assert.equal(acquired, 0)
  log.write('first')
  assert.equal(acquired, 1)
  assert.equal(closed, 1)
  log.write('next')
  assert.equal(acquired, 2)
  assert.equal(closed, 1)
  const ending = log.end()
  log.write('must not write after end')
  await ending
  await log.end()
  assert.equal(closed, 2)
  assert.equal(readFileSync(path, 'utf8'), 'next')
  assert.equal(gunzipSync(readFileSync(`${path}.1.gz`)).toString(), 'first')
})

test('failed directory admission never creates or appends a log', async (t) => {
  const dir = workdir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'denied.log')
  const log = new RotatingFileLog(path, {
    acquireWriter: () => {
      throw new Error('maintenance owns directory')
    },
  })
  log.write('denied')
  await log.end()
  assert.equal(existsSync(path), false)
})

test('logging resumes after temporary maintenance releases admission', async (t) => {
  const dir = workdir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'resume.log')
  let busy = true
  let released = 0
  const log = new RotatingFileLog(path, {
    acquireWriter: () => {
      if (busy) throw new Error('maintenance owns directory')
      return {
        close() {
          released++
        },
      }
    },
  })
  log.write('blocked')
  assert.equal(existsSync(path), false)
  busy = false
  log.write('resumed')
  assert.equal(released, 1)
  await log.end()
  assert.equal(readFileSync(path, 'utf8'), 'resumed')
})

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

test('deferred diagnostics never qualify storage until startup readiness and replay in order', async (t) => {
  const dir = workdir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'startup.log')
  let acquired = 0
  let maintenance = true
  const log = new RotatingFileLog(path, {
    deferred: true,
    acquireWriter: () => {
      acquired++
      assert.equal(maintenance, false, 'startup diagnostics must not compete with maintenance')
      return { close() {} }
    },
  })
  log.write('before initialization\n')
  log.write('maintenance started\n')
  await log.flush()
  assert.equal(acquired, 0)
  assert.equal(existsSync(path), false)
  maintenance = false
  log.resume()
  log.resume()
  log.write('ready\n')
  await log.end()
  assert.equal(acquired, 2)
  assert.equal(readFileSync(path, 'utf8'), 'before initialization\nmaintenance started\nready\n')
})

test('failed startup replays all buffered lines when the caller drains and ends diagnostics', async (t) => {
  const dir = workdir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'failed.log')
  const log = new RotatingFileLog(path, { deferred: true })
  log.write('startup error\n')
  assert.equal(existsSync(path), false)
  await log.end()
  await log.end()
  log.write('late output must be ignored')
  assert.equal(readFileSync(path, 'utf8'), 'startup error\n')
})

test('deferred diagnostics bound retained bytes and report overflow instead of silently dropping it', async (t) => {
  const dir = workdir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'bounded.log')
  const log = new RotatingFileLog(path, { deferred: true, maxBytes: 8 })
  log.write('older\n')
  log.write('newer\n')
  assert.equal(existsSync(path), false)
  await log.end()
  assert.equal(readFileSync(path, 'utf8'), 'newer\n')
  assert.match(gunzipSync(readFileSync(`${path}.1.gz`)).toString(), /6 bytes omitted/)
})
