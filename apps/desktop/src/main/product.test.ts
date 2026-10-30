import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  ACCOUNT_AUTH_MODE,
  BrowserFeatureReadinessError,
  validateBrowserFeatureReadiness,
  isAuthMode,
  parseDesktopProductConfig,
  resolveAccountBaseUrl,
  normalizeFeedbackBaseUrl,
  SECURE_PACKAGED_FALLBACK,
} from './product.ts'

test('browser readiness checks strict startup policy with a narrow legacy off-attach exception', () => {
  for (const mode of ['managed', 'attach'] as const) {
    for (const enabled of [false, true]) {
      assert.equal(
        validateBrowserFeatureReadiness({ features: { browser: enabled } }, enabled, mode),
        enabled
      )
      assert.throws(
        () => validateBrowserFeatureReadiness({ features: { browser: !enabled } }, enabled, mode),
        /browser_feature_policy_mismatch/
      )
      for (const value of [null, 1, 'false', {}, []]) {
        assert.throws(
          () => validateBrowserFeatureReadiness({ features: { browser: value } }, enabled, mode),
          /browser_feature_policy_invalid/
        )
      }
      for (const features of [null, 1, 'false', []]) {
        assert.throws(
          () => validateBrowserFeatureReadiness({ features }, enabled, mode),
          BrowserFeatureReadinessError
        )
      }
      for (const payload of [{}, { features: {} }]) {
        if (mode === 'attach' && !enabled)
          assert.equal(validateBrowserFeatureReadiness(payload, enabled, mode), null)
        else
          assert.throws(
            () => validateBrowserFeatureReadiness(payload, enabled, mode),
            /browser_feature_policy_missing/
          )
      }
    }
  }
})

test('shipped browser feature is enabled, explicit off and missing policy remain closed', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../resources/product.json', import.meta.url), 'utf8')
  )
  const sourceManifest = JSON.parse(
    readFileSync(new URL('../../../../product.json', import.meta.url), 'utf8')
  )
  assert.equal(sourceManifest.features.browser, true)
  for (const platform of ['darwin', 'win32'] as const) {
    assert.equal(
      parseDesktopProductConfig({ ...manifest, features: undefined }, platform).features.browser,
      false
    )
    assert.equal(
      parseDesktopProductConfig({ ...manifest, features: { feedback_recorder: true } }, platform)
        .features.browser,
      false
    )
    assert.equal(
      parseDesktopProductConfig(
        { ...manifest, features: { feedback_recorder: true, browser: true } },
        platform
      ).features.browser,
      true
    )
    assert.equal(parseDesktopProductConfig(manifest, platform).features.browser, true)
    assert.equal(
      parseDesktopProductConfig(
        { ...manifest, features: { ...manifest.features, browser: false } },
        platform
      ).features.browser,
      false
    )
    for (const browser of [null, 'true', 1, {}, []]) {
      assert.throws(
        () =>
          parseDesktopProductConfig(
            { ...manifest, features: { feedback_recorder: true, browser } },
            platform
          ),
        /features.browser/
      )
    }
    assert.throws(
      () => parseDesktopProductConfig({ ...manifest, features: { browser: true } }, platform),
      /features.feedback_recorder/
    )
  }
  assert.equal(SECURE_PACKAGED_FALLBACK.features.browser, false)
})

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
        session_namespace: 'local',
      },
      distribution: {
        key_provider: 'system_keychain',
        refresh_namespace: 'distribution',
        session_namespace: 'distribution',
      },
    },
    default_runtime: 'codex',
    runtimes: {
      codex: {
        adapter: 'scholarseed-codex',
        module: 'scholarseed_codex',
        enabled: true,
        profile: 'official',
        executable_sha256: 'a'.repeat(64),
        reported_version: '0.147.0',
      },
    },
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
    product_id: 'scholarseed',
    product_name: '书深',
    bundle_id: 'com.scholarseed.desktop',
    release_lane: 'local',
    update_channel: 'release',
    update_base_url: '',
    expected_team_id: '',
    expected_windows_publisher: '',
    auth_mode: 'off',
    account_base_url: '',
    credential_profiles: {
      local: {
        key_provider: 'mock_keychain',
        refresh_namespace: 'local',
        session_namespace: 'local',
      },
      distribution: {
        key_provider: 'system_keychain',
        refresh_namespace: 'distribution',
        session_namespace: 'distribution',
      },
    },
    default_runtime: 'codex',
    runtimes: {
      codex: {
        adapter: 'scholarseed-codex',
        module: 'scholarseed_codex',
        enabled: true,
        profile: 'official',
        executable_sha256: 'a'.repeat(64),
        reported_version: '0.147.0',
      },
    },
  }
  assert.equal(
    parseDesktopProductConfig({ ...minimal, features: { feedback_recorder: true } }).features
      .feedbackRecorder,
    true
  )
  assert.throws(
    () => parseDesktopProductConfig({ ...minimal, features: { feedback_recorder: 'yes' } }),
    /features.feedback_recorder/
  )
})

test('feedback endpoints are product-owned, HTTPS-only in distribution and reject credential-bearing URLs', () => {
  assert.equal(
    normalizeFeedbackBaseUrl('https://feedback.example.test/', 'distribution'),
    'https://feedback.example.test'
  )
  assert.equal(
    normalizeFeedbackBaseUrl('http://127.0.0.1:12345', 'local'),
    'http://127.0.0.1:12345'
  )
  for (const value of [
    'http://feedback.example.test',
    'https://user:secret@feedback.example.test',
    'https://feedback.example.test/?key=secret',
    'https://feedback.example.test/#secret',
    'file:///private/report',
  ]) {
    assert.throws(() => normalizeFeedbackBaseUrl(value, 'distribution'))
  }
  assert.equal(SECURE_PACKAGED_FALLBACK.feedbackBaseUrl, '')
})

test('account service environment override is normalized', () => {
  assert.equal(
    resolveAccountBaseUrl('https://override.example.test/', 'http://configured.example.test'),
    'https://override.example.test'
  )
})

test('invalid packaged policy fails closed instead of disabling authentication', () => {
  assert.throws(() =>
    parseDesktopProductConfig({ auth_mode: 'off', account_base_url: 'file:///tmp/auth' })
  )
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
        session_namespace: 'local',
      },
      distribution: {
        key_provider: 'system_keychain',
        refresh_namespace: 'distribution',
        session_namespace: 'distribution',
      },
    },
    default_runtime: 'codex',
    runtimes: {
      codex: {
        adapter: 'scholarseed-codex',
        module: 'scholarseed_codex',
        enabled: true,
        profile: 'official',
        executable_sha256: 'a'.repeat(64),
        reported_version: '0.147.0',
      },
    },
  }
  const config = parseDesktopProductConfig(base, 'darwin')
  assert.equal(config.releaseLane, 'distribution')
  assert.equal(config.updateBaseUrl, 'https://updates.example.test')
  assert.equal(config.expectedTeamId, 'A1B2C3D4E5')
  assert.equal(config.expectedWindowsPublisher, 'CN=ScholarSeed Test Publisher')
  assert.equal(config.buildNumber, '202608271200')
  assert.equal(config.credentialProfile.keyProvider, 'system_keychain')
  assert.throws(
    () => parseDesktopProductConfig({ ...base, update_base_url: 'http://updates.example.test' }),
    /https/
  )
  assert.throws(() => parseDesktopProductConfig({ ...base, product_id: 'veda' }), /product_id/)
  assert.throws(() => parseDesktopProductConfig({ ...base, build_number: '' }), /build_number/)
  assert.throws(
    () => parseDesktopProductConfig({ ...base, build_number: '2026082712' }),
    /build_number/
  )
  assert.throws(
    () => parseDesktopProductConfig({ ...base, build_number: 'v0.2_202608271200' }),
    /build_number/
  )
  assert.throws(
    () => parseDesktopProductConfig({ ...base, expected_team_id: '' }, 'darwin'),
    /expected_team_id/
  )
  assert.throws(
    () =>
      parseDesktopProductConfig({
        ...base,
        runtimes: { codex: { ...base.runtimes.codex, executable_sha256: 'wrong' } },
      }),
    /executable_sha256/
  )
  assert.throws(
    () =>
      parseDesktopProductConfig({
        ...base,
        credential_profiles: {
          local: base.credential_profiles.local,
          distribution: {
            key_provider: 'mock_keychain',
            refresh_namespace: 'distribution',
            session_namespace: 'distribution',
          },
        },
      }),
    /system_keychain/
  )
})

test('Windows distribution policy does not require an Apple Team ID', () => {
  const base = {
    product_id: 'scholarseed',
    product_name: '书深',
    bundle_id: 'com.scholarseed.desktop',
    release_lane: 'distribution',
    update_channel: 'release',
    update_base_url: 'https://updates.example.test',
    expected_team_id: '',
    build_number: '202608271200',
    expected_windows_publisher: 'CN=ScholarSeed Test Publisher',
    auth_mode: 'account',
    account_base_url: 'https://account.example.test',
    credential_profiles: {
      local: {
        key_provider: 'mock_keychain',
        refresh_namespace: 'local',
        session_namespace: 'local',
      },
      distribution: {
        key_provider: 'system_keychain',
        refresh_namespace: 'distribution',
        session_namespace: 'distribution',
      },
    },
    default_runtime: 'codex',
    runtimes: {
      codex: {
        adapter: 'scholarseed-codex',
        module: 'scholarseed_codex',
        enabled: true,
        profile: 'official',
        executable_sha256: 'a'.repeat(64),
        reported_version: '0.147.0',
      },
    },
  }
  const config = parseDesktopProductConfig(base, 'win32')
  assert.equal(config.expectedTeamId, '')
  assert.equal(config.expectedWindowsPublisher, 'CN=ScholarSeed Test Publisher')
  assert.throws(
    () => parseDesktopProductConfig({ ...base, expected_windows_publisher: '' }, 'win32'),
    /expected_windows_publisher/
  )
})

test('frozen runtime digest is optional for other platforms and strictly validated when present', () => {
  const source = JSON.parse(
    readFileSync(new URL('../../resources/product.json', import.meta.url), 'utf8')
  )
  assert.equal(parseDesktopProductConfig(source, 'darwin').runtimeManifestSha256, undefined)
  assert.equal(
    parseDesktopProductConfig({ ...source, runtime_manifest_sha256: 'a'.repeat(64) }, 'win32')
      .runtimeManifestSha256,
    'a'.repeat(64)
  )
  for (const invalid of ['', 'a'.repeat(63), 'A'.repeat(64), 1, null]) {
    assert.throws(
      () => parseDesktopProductConfig({ ...source, runtime_manifest_sha256: invalid }, 'win32'),
      /runtime_manifest_sha256/
    )
  }
})

test('Codex reports its exact reviewed build version without impersonating the baseline', () => {
  const source = JSON.parse(
    readFileSync(new URL('../../resources/product.json', import.meta.url), 'utf8')
  )
  source.runtimes.codex.executable_sha256 = 'a'.repeat(64)
  for (const platform of ['darwin', 'win32'] as const) {
    for (const reportedVersion of ['0.159.0', '0.159.0+ss-native.1']) {
      const config = parseDesktopProductConfig(
        {
          ...source,
          runtimes: {
            ...source.runtimes,
            codex: { ...source.runtimes.codex, reported_version: reportedVersion },
          },
        },
        platform
      )
      assert.equal(config.codexRuntime.reportedVersion, reportedVersion)
    }
    for (const reportedVersion of [
      '0.159.0+',
      '0.159.0+ss native.1',
      '0.159.0+SS-native.1',
      'codex-cli 0.159.0',
      '0.159.0\nclaimed',
      '0.159.0+ss-native.1\n',
    ]) {
      assert.throws(
        () =>
          parseDesktopProductConfig(
            {
              ...source,
              runtimes: {
                ...source.runtimes,
                codex: { ...source.runtimes.codex, reported_version: reportedVersion },
              },
            },
            platform
          ),
        /reported_version/
      )
    }
  }
})
