import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyMacosTrust, parseCodesignIdentity } from './codesign.ts'
import type { CodesignIdentity, ExpectedMacosIdentity } from './codesign.ts'

const EXPECTED_TEAM_ID = 'KYG3VP6NVH'
const EXPECTED_BUNDLE_ID = 'com.scholarseed.desktop'

const EXPECTED: ExpectedMacosIdentity = {
  expectedTeamId: EXPECTED_TEAM_ID,
  expectedBundleId: EXPECTED_BUNDLE_ID,
  metaTeamId: EXPECTED_TEAM_ID,
}

// 真实 `codesign -d --verbose=4` 形态（据现场 Chrome/ScholarSeed 输出）。
function developerIdOutput(overrides: Partial<Record<string, string>> = {}): string {
  const lines: Record<string, string> = {
    Executable: 'Executable=/Volumes/ScholarSeed/ScholarSeed.app/Contents/MacOS/ScholarSeed',
    Identifier: `Identifier=${EXPECTED_BUNDLE_ID}`,
    Format: 'Format=app bundle with Mach-O thin (arm64)',
    CodeDirectory:
      'CodeDirectory v=20500 size=12345 flags=0x12a00(kill,restrict,library-validation,runtime) hashes=380+7',
    CDHash: 'CDHash=0123456789abcdef0123456789abcdef01234567',
    Signature: 'Signature size=9108',
    AuthorityLeaf:
      'Authority=Developer ID Application: Alibaba Damo (Hangzhou) Technology Co., Ltd. (KYG3VP6NVH)',
    AuthorityCa: 'Authority=Developer ID Certification Authority',
    AuthorityRoot: 'Authority=Apple Root CA',
    Timestamp: 'Timestamp=Oct 9, 2026 at 14:53:58',
    TeamIdentifier: `TeamIdentifier=${EXPECTED_TEAM_ID}`,
    ...overrides,
  }
  return Object.values(lines).join('\n')
}

// 第二轮安全评审实测的伪造形态：自造 CA 拼出三级 Authority 链，但 TeamIdentifier=not set、flags=adhoc、无 Timestamp。
const ADHOC_OUTPUT = [
  'Executable=/Volumes/ScholarSeed/ScholarSeed.app/Contents/MacOS/ScholarSeed',
  `Identifier=${EXPECTED_BUNDLE_ID}`,
  'Format=Mach-O thin (arm64)',
  'CodeDirectory v=20500 size=1234 flags=0x2(adhoc) hashes=40+2',
  'CDHash=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  'Signature=adhoc',
  'TeamIdentifier=not set',
].join('\n')

test('a genuine Developer ID bundle is trusted', () => {
  const identity = parseCodesignIdentity(developerIdOutput())
  assert.equal(identity.hardenedRuntime, true)
  assert.equal(identity.hasSecureTimestamp, true)
  assert.equal(identity.hasDeveloperIdCa, true)
  assert.equal(identity.hasAppleRootCa, true)
  assert.equal(identity.teamIdentifier, EXPECTED_TEAM_ID)
  assert.equal(identity.identifier, EXPECTED_BUNDLE_ID)
  assert.deepEqual(classifyMacosTrust(identity, EXPECTED), { trusted: true })
})

test('Identifier= is not confused with TeamIdentifier=', () => {
  const identity = parseCodesignIdentity(developerIdOutput())
  assert.equal(identity.identifier, EXPECTED_BUNDLE_ID)
  assert.equal(identity.teamIdentifier, EXPECTED_TEAM_ID)
})

test('CRLF output parses identically', () => {
  const identity = parseCodesignIdentity(developerIdOutput().replace(/\n/g, '\r\n'))
  assert.deepEqual(classifyMacosTrust(identity, EXPECTED), { trusted: true })
})

test('ad-hoc signature (no Developer ID authority) is rejected', () => {
  const identity = parseCodesignIdentity(ADHOC_OUTPUT)
  assert.equal(identity.developerIdAuthority, '')
  assert.equal(identity.hardenedRuntime, false)
  assert.equal(identity.hasSecureTimestamp, false)
  const verdict = classifyMacosTrust(identity, EXPECTED)
  assert.equal(verdict.trusted, false)
})

test('forged authority chain with TeamIdentifier=not set is rejected (load-bearing check)', () => {
  // Authority 三行可伪造，但伪造证书产不出真实 TeamID → 承重判据 TeamIdentifier 相等必须挡下。
  const identity = parseCodesignIdentity(
    developerIdOutput({ TeamIdentifier: 'TeamIdentifier=not set' })
  )
  assert.notEqual(identity.developerIdAuthority, '')
  const verdict = classifyMacosTrust(identity, EXPECTED)
  assert.equal(verdict.trusted, false)
  assert.match((verdict as { reason: string }).reason, /Team Identifier/)
})

test('mismatched Team Identifier is rejected', () => {
  const identity = parseCodesignIdentity(
    developerIdOutput({ TeamIdentifier: 'TeamIdentifier=ABCDE12345' })
  )
  const verdict = classifyMacosTrust(identity, EXPECTED)
  assert.equal(verdict.trusted, false)
  assert.match((verdict as { reason: string }).reason, /Team Identifier/)
})

test('release metadata team_id differing from policy is rejected', () => {
  const identity = parseCodesignIdentity(developerIdOutput())
  const verdict = classifyMacosTrust(identity, { ...EXPECTED, metaTeamId: 'ZZZZZ99999' })
  assert.equal(verdict.trusted, false)
  assert.match((verdict as { reason: string }).reason, /release metadata team_id/)
})

test('Timestamp=none is rejected (inherited verify.cjs hole closed)', () => {
  const identity = parseCodesignIdentity(developerIdOutput({ Timestamp: 'Timestamp=none' }))
  assert.equal(identity.hasSecureTimestamp, false)
  const verdict = classifyMacosTrust(identity, EXPECTED)
  assert.equal(verdict.trusted, false)
  assert.match((verdict as { reason: string }).reason, /timestamp/i)
})

test('missing Timestamp line is rejected', () => {
  const identity = parseCodesignIdentity(developerIdOutput({ Timestamp: 'Format=extra' }))
  assert.equal(identity.hasSecureTimestamp, false)
  assert.equal(classifyMacosTrust(identity, EXPECTED).trusted, false)
})

test('missing hardened runtime flag is rejected', () => {
  const identity = parseCodesignIdentity(
    developerIdOutput({
      CodeDirectory:
        'CodeDirectory v=20500 size=12345 flags=0x10000(library-validation) hashes=380+7',
    })
  )
  assert.equal(identity.hardenedRuntime, false)
  const verdict = classifyMacosTrust(identity, EXPECTED)
  assert.equal(verdict.trusted, false)
  assert.match((verdict as { reason: string }).reason, /hardened runtime/i)
})

test('signed Identifier differing from bundle id is rejected', () => {
  const identity = parseCodesignIdentity(
    developerIdOutput({ Identifier: 'Identifier=com.attacker.other' })
  )
  const verdict = classifyMacosTrust(identity, EXPECTED)
  assert.equal(verdict.trusted, false)
  assert.match((verdict as { reason: string }).reason, /Identifier/)
})

test('certificate chain not reaching Apple Root CA is rejected', () => {
  const identity = parseCodesignIdentity(
    developerIdOutput({ AuthorityRoot: 'Authority=Some Other Root' })
  )
  assert.equal(identity.hasAppleRootCa, false)
  const verdict = classifyMacosTrust(identity, EXPECTED)
  assert.equal(verdict.trusted, false)
  assert.match((verdict as { reason: string }).reason, /Apple Root CA/)
})

test('cdhash is captured for audit logging when present', () => {
  const identity: CodesignIdentity = parseCodesignIdentity(developerIdOutput())
  assert.equal(identity.cdhash, '0123456789abcdef0123456789abcdef01234567')
})
