import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  drainInbox,
  INBOX_DIRNAME,
  parkCallbackUrl,
  type HandoffInboxDependencies,
} from './handoff-inbox.ts'
import { STATE_TTL_MS } from './handoff.ts'
import { handoffFingerprint, parseCallbackUrl } from './handoff-url.ts'
import type { CallbackTiming } from './handoff-timing.ts'

const CALLBACK =
  'scholarseed://auth/callback?state=abcdefghijklmnopqrstuvwxyz0123456789ABCDE&code=SECRET_CODE_VALUE'

test('inbox preserves only validated native timing and never lets diagnostics block callback delivery', () => {
  const logs: string[] = []
  const home = mkdtempSync(join(tmpdir(), 'handoff-inbox-test-'))
  const timing: CallbackTiming = {
    schema: 1,
    attempt: handoffFingerprint(parseCallbackUrl(CALLBACK)!.state),
    launcher_pid: 10,
    started_at_ms: 1,
    activate_ms: 1,
    bootstrap_ms: 3,
    signature_ms: 2,
    readiness_ms: 1,
    pre_engine_ms: 5,
  }
  const received: Array<{ url: string; timing: CallbackTiming | null }> = []
  const receive = (url: string, timing: CallbackTiming | null): void => {
    received.push({ url, timing })
  }
  assert.equal(parkCallbackUrl(deps(logs, home), CALLBACK, timing), 'parked')
  assert.equal(drainInbox(deps(logs, home), receive), 1)
  assert.deepEqual(received.pop(), { url: CALLBACK, timing })
  assert.equal(
    parkCallbackUrl(deps(logs, home), CALLBACK, { ...timing, attempt: 'invalid' }),
    'parked'
  )
  assert.equal(drainInbox(deps(logs, home), receive), 1)
  assert.deepEqual(received.pop(), { url: CALLBACK, timing: null })
  assert.doesNotMatch(logs.join(''), /SECRET_CODE_VALUE|abcdefghijklmnopqrstuvwxyz0123456789ABCDE/)
})

function deps(logs: string[], home?: string, now?: number): HandoffInboxDependencies {
  return {
    home: () => home ?? mkdtempSync(join(tmpdir(), 'handoff-inbox-test-')),
    log: (line) => logs.push(line),
    now: now === undefined ? undefined : () => now,
  }
}

test('park 落盘一条入口，drain 投递一次并清空收件箱', () => {
  const logs: string[] = []
  const home = mkdtempSync(join(tmpdir(), 'handoff-inbox-test-'))
  assert.equal(parkCallbackUrl(deps(logs, home), CALLBACK), 'parked')
  const entries = readdirSync(join(home, INBOX_DIRNAME))
  assert.equal(entries.length, 1)
  const payload = JSON.parse(readFileSync(join(home, INBOX_DIRNAME, entries[0]!), 'utf8')) as {
    url?: string
    schema?: number
  }
  assert.equal(payload.url, CALLBACK)
  assert.equal(payload.schema, 1)

  const received: string[] = []
  assert.equal(
    drainInbox(deps(logs, home), (url) => received.push(url)),
    1
  )
  assert.deepEqual(received, [CALLBACK])
  assert.deepEqual(readdirSync(join(home, INBOX_DIRNAME)), [])
  assert.equal(
    drainInbox(deps(logs, home), (url) => received.push(url)),
    0
  )
  assert.equal(received.length, 1)
})

test('收件箱不存在时 drain 返回 0 且不抛', () => {
  const logs: string[] = []
  assert.equal(
    drainInbox(deps(logs), () => assert.fail('不应投递')),
    0
  )
})

test('过期入口只记账不投递', () => {
  const logs: string[] = []
  const home = mkdtempSync(join(tmpdir(), 'handoff-inbox-test-'))
  const writtenAt = 1_000_000
  assert.equal(parkCallbackUrl(deps(logs, home, writtenAt), CALLBACK), 'parked')
  const received: string[] = []
  const drained = drainInbox(deps(logs, home, writtenAt + STATE_TTL_MS + 1), (url) =>
    received.push(url)
  )
  assert.equal(drained, 0)
  assert.deepEqual(received, [])
  assert.deepEqual(readdirSync(join(home, INBOX_DIRNAME)), [])
  assert.ok(logs.some((line) => line.includes('expired')))
})

test('坏 JSON 与未知形状被丢弃且不抛', () => {
  const logs: string[] = []
  const home = mkdtempSync(join(tmpdir(), 'handoff-inbox-test-'))
  const dir = join(home, INBOX_DIRNAME)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'bad.json'), '{not json', 'utf8')
  writeFileSync(join(dir, 'shape.json'), JSON.stringify({ schema: 99 }), 'utf8')
  const received: string[] = []
  assert.equal(
    drainInbox(deps(logs, home), (url) => received.push(url)),
    0
  )
  assert.deepEqual(received, [])
  assert.deepEqual(readdirSync(dir), [])
})

test('park 失败返回 failed 且日志不含 code 原值', () => {
  const logs: string[] = []
  const home = mkdtempSync(join(tmpdir(), 'handoff-inbox-test-'))
  const blocker = join(home, 'blocker')
  writeFileSync(blocker, 'x', 'utf8')
  assert.equal(parkCallbackUrl(deps(logs, blocker), CALLBACK), 'failed')
  assert.ok(logs.some((line) => line.includes('park failed')))
  for (const line of logs) assert.ok(!line.includes('SECRET_CODE_VALUE'))
})

test('park 与 drain 的全部日志都不含 code 原值', () => {
  const logs: string[] = []
  const home = mkdtempSync(join(tmpdir(), 'handoff-inbox-test-'))
  assert.equal(parkCallbackUrl(deps(logs, home), CALLBACK), 'parked')
  drainInbox(deps(logs, home), () => {})
  for (const line of logs) assert.ok(!line.includes('SECRET_CODE_VALUE'))
  assert.ok(logs.some((line) => line.includes('state=')))
})
