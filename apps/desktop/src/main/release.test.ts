import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildUpdateCheckUrl,
  desktopArchType,
  identityMismatches,
  parseDownloadInfo,
  parseUpdateCheckResult
} from './release.ts'
import type { DesktopUpdateConfig } from './release.ts'

const CONFIG: DesktopUpdateConfig = {
  baseUrl: 'https://updates.example.test',
  channel: 'release',
  buildNumber: '202608270900',
  productId: 'scholarseed',
  bundleId: 'com.scholarseed.desktop',
  expectedTeamId: 'A1B2C3D4E5',
  expectedWindowsPublisher: 'CN=ScholarSeed Test Publisher',
  releaseLane: 'distribution'
}

const LATEST = {
  id: 'package-1',
  version: '0.2.0',
  build_number: '202608271200',
  product_id: 'scholarseed',
  bundle_id: 'com.scholarseed.desktop',
  arch_type: 'darwin-arm64',
  team_id: 'A1B2C3D4E5',
  channel: 'release',
  file_size: 4096,
  sha512: 'a'.repeat(128)
}

test('update check URL scopes product, version, build, architecture, and channel', () => {
  const url = new URL(buildUpdateCheckUrl(CONFIG, '0.1.1', 'darwin-arm64'))
  assert.equal(url.searchParams.get('product'), 'scholarseed')
  assert.equal(url.searchParams.get('version'), '0.1.1')
  assert.equal(url.searchParams.get('build_number'), '202608270900')
  assert.equal(url.searchParams.get('arch_type'), 'darwin-arm64')
  assert.equal(url.searchParams.get('channel'), 'release')
})

test('an unpackaged source run reports no build stamp instead of an empty one', () => {
  const url = new URL(buildUpdateCheckUrl({ ...CONFIG, buildNumber: '' }, '0.1.1', 'darwin-arm64'))
  assert.equal(url.searchParams.has('build_number'), false)
})

test('desktop update targets map only supported native architectures', () => {
  assert.equal(desktopArchType('win32', 'x64'), 'windows-amd64')
  assert.equal(desktopArchType('win32', 'ia32'), null)
  assert.equal(desktopArchType('win32', 'arm64'), null)
  assert.equal(desktopArchType('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(desktopArchType('darwin', 'x64'), 'darwin-x86_64')
  assert.equal(desktopArchType('linux', 'x64'), null)
})

test('release metadata is accepted only when every immutable identity field matches', () => {
  const result = parseUpdateCheckResult({ has_update: true, latest: LATEST }, CONFIG, 'darwin-arm64')
  assert.equal(result.latest?.id, 'package-1')
  assert.throws(
    () => parseUpdateCheckResult({ has_update: true, latest: { ...LATEST, product_id: 'veda' } }, CONFIG, 'darwin-arm64'),
    /identity/
  )
  assert.throws(
    () => parseUpdateCheckResult({ has_update: true, latest: { ...LATEST, sha512: null } }, CONFIG, 'darwin-arm64'),
    /sha512/
  )
  assert.throws(
    () => parseUpdateCheckResult({ has_update: true, latest: { ...LATEST, file_size: 0 } }, CONFIG, 'darwin-arm64'),
    /file_size/
  )
})

test('identityMismatches names exactly the fields the check rejects on', () => {
  assert.deepEqual(identityMismatches(LATEST, CONFIG, 'darwin-arm64'), [])
  assert.deepEqual(
    identityMismatches({ ...LATEST, team_id: 'KYG3VP6NVH' }, CONFIG, 'darwin-arm64'),
    ['team_id']
  )
  // An identity-less row fails the macOS gate too: a missing team_id is not the
  // same as the policy's empty expectation. This is the case local-lane builds
  // hit, and the diagnosis channel must report it rather than silently pass.
  assert.deepEqual(
    identityMismatches(
      { ...LATEST, team_id: undefined },
      { ...CONFIG, expectedTeamId: '' },
      'darwin-arm64'
    ),
    ['team_id']
  )
  // Windows installers carry no Apple Team id, so the field is not compared there.
  assert.deepEqual(
    identityMismatches(
      { ...LATEST, arch_type: 'windows-amd64', team_id: undefined },
      CONFIG,
      'windows-amd64'
    ),
    []
  )
  assert.deepEqual(
    identityMismatches({ ...LATEST, product_id: 'veda', channel: 'preview' }, CONFIG, 'darwin-arm64'),
    ['product_id', 'channel']
  )
})

test('a candidate without a usable build stamp cannot be ranked and is refused', () => {
  for (const build_number of [undefined, '', '2026082712', 'v0.2_202608271200']) {
    assert.throws(
      () => parseUpdateCheckResult(
        { has_update: true, latest: { ...LATEST, build_number } },
        CONFIG,
        'darwin-arm64'
      ),
      /build_number/
    )
  }
})

test('distribution download metadata requires the requested id and HTTPS', () => {
  const result = parseDownloadInfo(
    { ...LATEST, download_url: 'https://oss.example.test/package.dmg?signature=short-lived' },
    CONFIG,
    'darwin-arm64',
    'package-1'
  )
  assert.match(result.download_url, /^https:/)
  assert.throws(
    () => parseDownloadInfo({ ...LATEST, download_url: 'http://oss.example.test/package.dmg' }, CONFIG, 'darwin-arm64', 'package-1'),
    /HTTPS/
  )
  assert.throws(
    () => parseDownloadInfo({ ...LATEST, id: 'other', download_url: 'https://oss.example.test/package.dmg' }, CONFIG, 'darwin-arm64', 'package-1'),
    /requested/
  )
})

test('no-update response is explicit and cannot smuggle a candidate', () => {
  assert.deepEqual(
    parseUpdateCheckResult({ has_update: false, latest: null }, CONFIG, 'darwin-arm64'),
    { has_update: false, latest: null }
  )
  assert.throws(
    () => parseUpdateCheckResult({ has_update: false, latest: LATEST }, CONFIG, 'darwin-arm64'),
    /must not contain/
  )
})

test('release notes are optional and only a non-blank string counts as a summary', () => {
  const parse = (latest: Record<string, unknown>): string | undefined =>
    parseUpdateCheckResult({ has_update: true, latest }, CONFIG, 'darwin-arm64').latest?.release_notes

  assert.equal(parse({ ...LATEST, release_notes: '检索式回看、入库选分类' }), '检索式回看、入库选分类')
  // 管理台没填时服务端根本不给这个键，界面要按「无摘要」渲染。
  assert.equal(parse(LATEST), undefined)
  assert.equal(parse({ ...LATEST, release_notes: '   \n ' }), undefined)
  assert.equal(parse({ ...LATEST, release_notes: '' }), undefined)
  assert.equal(parse({ ...LATEST, release_notes: '  已裁剪  ' }), '已裁剪')
  // 非字符串不能悄悄变成 "null" / "[object Object]" 之类的假摘要。
  assert.equal(parse({ ...LATEST, release_notes: 42 }), undefined)
  assert.equal(parse({ ...LATEST, release_notes: null }), undefined)
})

test('Windows x64 metadata uses platform identity without an Apple Team ID', () => {
  const { team_id: _teamId, ...metadata } = LATEST
  const latest = { ...metadata, arch_type: 'windows-amd64' }
  const result = parseUpdateCheckResult(
    { has_update: true, latest },
    CONFIG,
    'windows-amd64'
  )
  assert.equal(result.latest?.arch_type, 'windows-amd64')
  assert.equal(result.latest?.team_id, undefined)
  assert.throws(
    () => parseUpdateCheckResult(
      { has_update: true, latest },
      { ...CONFIG, expectedWindowsPublisher: '' },
      'windows-amd64'
    ),
    /Windows publisher/
  )
})
