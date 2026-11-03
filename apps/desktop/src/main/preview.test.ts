import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendPreviewContext,
  previewAllows,
  previewContext,
  previewLine,
  previewScope,
  restorePreviewPolicy,
  samePreviewArtifact,
  PREVIEW_STATE_SCHEMA,
} from './preview.ts'
import type { LatestVersionMeta } from '../updates.ts'

const source = { version: '0.2.0', build: '202610201000' }
function candidate(version = '0.2.0', build = '202610201001'): LatestVersionMeta {
  return {
    id: `${version}-${build}`,
    version,
    build_number: build,
    channel: 'preview',
    product_id: 'scholarseed',
    bundle_id: 'com.scholarseed.desktop',
    arch_type: 'darwin-arm64',
    team_id: 'TEAM',
    file_size: 100,
    sha512: 'a'.repeat(128),
  }
}

test('preview default range permits same-build-number patch releases but never crosses the line', () => {
  const policy = { scope: 'current-line' } as const
  assert.equal(previewAllows(policy, source.version, source.build, candidate()), true)
  assert.equal(
    previewAllows(policy, source.version, source.build, candidate('0.2.1', source.build)),
    true
  )
  assert.equal(previewAllows(policy, source.version, source.build, candidate('0.3.0')), false)
  assert.equal(previewAllows(policy, source.version, source.build, candidate('1.0.0')), false)
})

test('version lock admits only newer builds of the exact version', () => {
  const policy = { scope: 'current-version' } as const
  assert.equal(previewAllows(policy, source.version, source.build, candidate()), true)
  assert.equal(previewAllows(policy, source.version, source.build, candidate('0.2.1')), false)
  assert.equal(
    previewAllows(policy, source.version, source.build, candidate('0.2.0', source.build)),
    false
  )
  assert.equal(previewAllows(policy, source.version, source.build, candidate('0.1.9')), false)
  assert.equal(
    previewAllows(policy, source.version, source.build, { ...candidate(), channel: 'release' }),
    false
  )
})

test('manual consent pins the full artifact; a new publication or modified digest is not consent', () => {
  const target = candidate('0.3.0')
  const policy = { scope: 'current-version', target } as const
  assert.equal(previewAllows(policy, source.version, source.build, target), true)
  assert.equal(previewAllows(policy, source.version, source.build, candidate('0.3.1')), false)
  assert.equal(
    previewAllows(policy, source.version, source.build, { ...target, sha512: 'b'.repeat(128) }),
    false
  )
  assert.equal(previewAllows(policy, source.version, source.build, candidate()), false)
  assert.equal(samePreviewArtifact(target, { ...target, release_notes: 'Edited notes' }), true)
})

test('source replacement consumes manual target while preserving version lock', () => {
  const target = candidate('0.3.0')
  const record = {
    schema: PREVIEW_STATE_SCHEMA,
    source: 'installed-A',
    scope: 'current-version',
    target,
  }
  const parse = (value: unknown) => value as LatestVersionMeta
  assert.deepEqual(restorePreviewPolicy(record, 'installed-A', parse), {
    scope: 'current-version',
    target,
  })
  assert.deepEqual(restorePreviewPolicy(record, 'installed-B', parse), { scope: 'current-version' })
  assert.throws(() => restorePreviewPolicy({ ...record, scope: 'latest' }, 'installed-A', parse))
  assert.throws(() => restorePreviewPolicy({ ...record, schema: 99 }, 'installed-A', parse))
})

test('check, download and activation share exact preview context including Windows engine', () => {
  const target = candidate('0.3.0')
  const context = previewContext(
    { scope: 'current-version', target },
    source.version,
    source.build,
    'velopack'
  )
  const url = new URL('https://updates.example/api/v1/updates/check?product=scholarseed')
  appendPreviewContext(url, context)
  assert.equal(url.searchParams.get('version'), source.version)
  assert.equal(url.searchParams.get('preview_scope'), 'current-version')
  assert.equal(url.searchParams.get('target_line'), '0.3')
  assert.equal(url.searchParams.get('target_id'), target.id)
  assert.equal(url.searchParams.get('update_engine'), 'velopack')
  assert.equal(url.searchParams.get('product'), 'scholarseed')
  assert.deepEqual(previewContext({ scope: 'current-line' }, source.version, source.build), {
    version: source.version,
    build_number: source.build,
    preview_scope: 'current-line',
  })
})

test('invalid versions and unknown scopes fail closed', () => {
  for (const version of ['0.2', '0.2.0-beta', '00.2.0', '0.2.0.1', 'latest'])
    assert.throws(() => previewLine(version))
  for (const scope of [null, undefined, 'all', 'release', {}])
    assert.throws(() => previewScope(scope))
})
