import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectDesktopRecords } from './desktop-records.ts'
import { startupMarkerPath, writeStartupMarker } from './startupmarker.ts'

function request() {
  return {
    version: 1,
    documents: [
      {
        owner: 'renderer-preferences',
        bytes: Buffer.from('{"language":"en","autoDownloadUpdates":false}').toString('base64'),
      },
      {
        owner: 'window-close-state',
        bytes: Buffer.from('{"askOnClose":false}').toString('base64'),
      },
      {
        owner: 'device',
        bytes: Buffer.from('{"device_id":"private-device-marker"}').toString('base64'),
      },
      {
        owner: 'startup-marker',
        bytes: Buffer.from('{"schema":1,"appVersion":"0.2.0-202610080900"}').toString('base64'),
      },
      {
        owner: 'storage-pointer',
        bytes: Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            dataHome: process.platform === 'win32' ? 'C:\\ScholarSeed' : '/private/scholarseed',
          })
        ).toString('base64'),
      },
      {
        owner: 'browser-policy',
        bytes: Buffer.from(
          '{"schemaVersion":2,"revision":0,"agentBrowserUseEnabled":false,"sites":{}}'
        ).toString('base64'),
      },
      {
        owner: 'browser-downloads',
        bytes: Buffer.from('{"directoryOverride":null,"askEveryTime":true}').toString('base64'),
      },
    ],
  }
}

test('compiled Desktop readers produce stable private evidence without exposing record contents', () => {
  const input = request()
  const before = structuredClone(input)
  const result = inspectDesktopRecords(input)
  assert.deepEqual(inspectDesktopRecords(input), result)
  assert.deepEqual(input, before)
  assert.equal(JSON.stringify(result).includes('private-device-marker'), false)
  input.documents.reverse()
  assert.deepEqual(inspectDesktopRecords(input), result)
  input.documents.find((row) => row.owner === 'startup-marker')!.bytes = Buffer.from(
    '{"schema":1,"appVersion":"0.2.0-202610081000"}'
  ).toString('base64')
  assert.notDeepEqual(inspectDesktopRecords(input), result)
})

test('every compiled owner must appear once and arbitrary path or script fields are rejected', () => {
  const missing = request()
  missing.documents.pop()
  assert.throws(() => inspectDesktopRecords(missing))
  const duplicate = request()
  duplicate.documents[1] = duplicate.documents[0]
  assert.throws(() => inspectDesktopRecords(duplicate))
  const foreign = request()
  foreign.documents[0].owner = 'unknown'
  assert.throws(() => inspectDesktopRecords(foreign))
  assert.throws(() => inspectDesktopRecords({ ...request(), path: '/private' }))
  assert.throws(() => inspectDesktopRecords({ ...request(), script: 'ignored' }))
})

test('absent records have explicit evidence and malformed encodings fail', () => {
  const absent = {
    version: 1,
    documents: request().documents.map(({ owner }) => ({ owner, bytes: null })),
  }
  assert.deepEqual(inspectDesktopRecords(absent), inspectDesktopRecords(absent))
  for (const bytes of [
    '@@@',
    'e30',
    Buffer.from('{broken').toString('base64'),
    Buffer.from([255]).toString('base64'),
  ]) {
    const input = request()
    input.documents[0].bytes = bytes
    assert.throws(() => inspectDesktopRecords(input))
  }
})

test('candidate marker projection is byte-identical to the actual startup writer', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-marker-projection-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const release = { version: '0.2.1', buildNumber: '202610091215' }
  const input = request()
  const result = inspectDesktopRecords({ ...input, release }) as { preparedMarker: string }
  writeStartupMarker(root, release)
  assert.deepEqual(
    Buffer.from(result.preparedMarker, 'base64'),
    readFileSync(startupMarkerPath(root))
  )
  const candidate = request()
  candidate.documents.find((row) => row.owner === 'startup-marker')!.bytes = result.preparedMarker
  assert.doesNotThrow(() => inspectDesktopRecords(candidate))
  for (const invalid of [
    null,
    {},
    { version: '0.2.1', buildNumber: '' },
    { ...release, path: '/elsewhere' },
  ])
    assert.throws(() => inspectDesktopRecords({ ...input, release: invalid }))
})

test('browser documents use the current policy and download readers without touching their paths', () => {
  const input = request()
  const policy = input.documents.find((row) => row.owner === 'browser-policy')!
  const downloads = input.documents.find((row) => row.owner === 'browser-downloads')!
  policy.bytes = Buffer.from('{"schemaVersion":1,"revision":3,"sites":{}}').toString('base64')
  downloads.bytes = Buffer.from(
    JSON.stringify({
      directoryOverride: join(tmpdir(), 'absent-private-download-directory'),
      askEveryTime: false,
    })
  ).toString('base64')
  assert.doesNotThrow(() => inspectDesktopRecords(input))
  policy.bytes = Buffer.from('{"schemaVersion":3,"revision":3,"sites":{}}').toString('base64')
  assert.throws(() => inspectDesktopRecords(input), /browser_policy_corrupt/)
})
