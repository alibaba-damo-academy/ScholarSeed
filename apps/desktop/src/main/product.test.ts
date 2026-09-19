import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ACCOUNT_AUTH_MODE,
  isAuthMode,
  parseDesktopProductConfig,
  resolveAccountBaseUrl,
  SECURE_PACKAGED_FALLBACK
} from './product.ts'

test('packaged product config enables account authentication', () => {
  const config = parseDesktopProductConfig({
    product_id: 'scholarseed',
    product_name: '书深',
    bundle_id: 'com.scholarseed.desktop',
    release_lane: 'local',
    update_channel: 'release',
    update_base_url: 'http://updates.example.test',
    expected_team_id: '',
    expected_windows_publisher: '',
    auth_mode: 'account',
    account_base_url: 'http://account.example.test/',
    credential_profiles: {
      local: {
        key_provider: 'mock_keychain',
        refresh_namespace: 'local',
        session_namespace: 'local'
      },
      distribution: {
        key_provider: 'system_keychain',
        refresh_namespace: 'distribution',
        session_namespace: 'distribution'
      }
    },
    default_runtime: 'codex',
    runtimes: {
      codex: {
        adapter: 'scholarseed-codex',
        module: 'scholarseed_codex',
        enabled: true,
        profile: 'official',
        executable_sha256: 'a'.repeat(64),
        reported_version: '0.147.0'
      }
    }
  })
  assert.equal(config.authMode, ACCOUNT_AUTH_MODE)
  assert.equal(config.accountBaseUrl, 'http://account.example.test')
  assert.equal(config.productId, 'scholarseed')
  assert.equal(config.bundleId, 'com.scholarseed.desktop')
  assert.equal(config.updateBaseUrl, 'http://updates.example.test')
  assert.equal(config.buildNumber, '')
  assert.equal(config.codexRuntime.profile, 'official')
  assert.equal(config.credentialProfile.keyProvider, 'mock_keychain')
  assert.equal(config.features.feedbackRecorder, false)
})

test('feedback recorder requires an explicit boolean when feature policy is present', () => {
  const minimal = {
    product_id: 'scholarseed', product_name: '书深', bundle_id: 'com.scholarseed.desktop',
    release_lane: 'local', update_channel: 'release', update_base_url: '',
    expected_team_id: '', expected_windows_publisher: '', auth_mode: 'off', account_base_url: '',
    credential_profiles: {
      local: { key_provider: 'mock_keychain', refresh_namespace: 'local', session_namespace: 'local' },
      distribution: { key_provider: 'system_keychain', refresh_namespace: 'distribution', session_namespace: 'distribution' }
    },
    default_runtime: 'codex',
    runtimes: { codex: { adapter: 'scholarseed-codex', module: 'scholarseed_codex', enabled: true,
      profile: 'official', executable_sha256: 'a'.repeat(64), reported_version: '0.147.0' } }
  }
  assert.equal(
    parseDesktopProductConfig({ ...minimal, features: { feedback_recorder: true } }).features.feedbackRecorder,
    true
  )
  assert.throws(
    () => parseDesktopProductConfig({ ...minimal, features: { feedback_recorder: 'yes' } }),
    /features.feedback_recorder/
  )
})

test('account service environment override is normalized', () => {
  assert.equal(
    resolveAccountBaseUrl('https://override.example.test/', 'http://configured.example.test'),
    'https://override.example.test'
  )
})

test('invalid packaged policy fails closed instead of disabling authentication', () => {
  assert.throws(() => parseDesktopProductConfig({ auth_mode: 'off', account_base_url: 'file:///tmp/auth' }))
  assert.equal(SECURE_PACKAGED_FALLBACK.authMode, ACCOUNT_AUTH_MODE)
  assert.equal(SECURE_PACKAGED_FALLBACK.accountBaseUrl, '')
})

test('removed enterprise authentication modes are rejected on supported platforms', () => {
  assert.equal(isAuthMode('sso'), false)
  for (const platform of ['darwin', 'win32'] as const) {
    assert.throws(
      () => parseDesktopProductConfig({ auth_mode: 'sso' }, platform),
      /auth_mode is invalid/
    )
  }
})

test('distribution update policy is immutable, product-scoped and HTTPS-only', () => {
  const base = {
    product_id: 'scholarseed',
    product_name: '书深',
    bundle_id: 'com.scholarseed.desktop',
    release_lane: 'distribution',
    update_channel: 'release',
    update_base_url: 'https://updates.example.test/',
    build_number: '202608271200',
    expected_team_id: 'A1B2C3D4E5',
    expected_windows_publisher: 'CN=ScholarSeed Test Publisher',
    auth_mode: 'account',
    account_base_url: 'https://account.example.test',
    credential_profiles: {
      local: {
        key_provider: 'mock_keychain',
        refresh_namespace: 'local',
        session_namespace: 'local'
      },
      distribution: {
        key_provider: 'system_keychain',
        refresh_namespace: 'distribution',
        session_namespace: 'distribution'
      }
    },
    default_runtime: 'codex',
    runtimes: {
      codex: {
        adapter: 'scholarseed-codex',
        module: 'scholarseed_codex',
        enabled: true,
        profile: 'official',
        executable_sha256: 'a'.repeat(64),
        reported_version: '0.147.0'
      }
    }
  }
  const config = parseDesktopProductConfig(base, 'darwin')
  assert.equal(config.releaseLane, 'distribution')
  assert.equal(config.updateBaseUrl, 'https://updates.example.test')
  assert.equal(config.expectedTeamId, 'A1B2C3D4E5')
  assert.equal(config.expectedWindowsPublisher, 'CN=ScholarSeed Test Publisher')
  assert.equal(config.buildNumber, '202608271200')
  assert.equal(config.credentialProfile.keyProvider, 'system_keychain')
  assert.throws(() => parseDesktopProductConfig({ ...base, update_base_url: 'http://updates.example.test' }), /https/)
  assert.throws(() => parseDesktopProductConfig({ ...base, product_id: 'veda' }), /product_id/)
  assert.throws(() => parseDesktopProductConfig({ ...base, build_number: '' }), /build_number/)
  assert.throws(() => parseDesktopProductConfig({ ...base, build_number: '2026082712' }), /build_number/)
  assert.throws(
    () => parseDesktopProductConfig({ ...base, build_number: 'v0.2_202608271200' }),
    /build_number/
  )
  assert.throws(
    () => parseDesktopProductConfig({ ...base, expected_team_id: '' }, 'darwin'),
    /expected_team_id/
  )
  assert.throws(
    () => parseDesktopProductConfig({
      ...base,
      runtimes: { codex: { ...base.runtimes.codex, executable_sha256: 'wrong' } }
    }),
    /executable_sha256/
  )
  assert.throws(
    () => parseDesktopProductConfig({
      ...base,
      credential_profiles: {
        local: base.credential_profiles.local,
        distribution: {
          key_provider: 'mock_keychain',
          refresh_namespace: 'distribution',
          session_namespace: 'distribution'
        }
      }
    }),
    /system_keychain/
  )
})

test('Windows distribution policy does not require an Apple Team ID', () => {
  const base = {
    product_id: 'scholarseed', product_name: '书深', bundle_id: 'com.scholarseed.desktop',
    release_lane: 'distribution', update_channel: 'release',
    update_base_url: 'https://updates.example.test', expected_team_id: '',
    build_number: '202608271200',
    expected_windows_publisher: 'CN=ScholarSeed Test Publisher', auth_mode: 'account',
    account_base_url: 'https://account.example.test',
    credential_profiles: {
      local: { key_provider: 'mock_keychain', refresh_namespace: 'local', session_namespace: 'local' },
      distribution: { key_provider: 'system_keychain', refresh_namespace: 'distribution', session_namespace: 'distribution' }
    },
    default_runtime: 'codex',
    runtimes: { codex: { adapter: 'scholarseed-codex', module: 'scholarseed_codex', enabled: true,
      profile: 'official', executable_sha256: 'a'.repeat(64), reported_version: '0.147.0' } }
  }
  const config = parseDesktopProductConfig(base, 'win32')
  assert.equal(config.expectedTeamId, '')
  assert.equal(config.expectedWindowsPublisher, 'CN=ScholarSeed Test Publisher')
  assert.throws(
    () => parseDesktopProductConfig({ ...base, expected_windows_publisher: '' }, 'win32'),
    /expected_windows_publisher/
  )
})
