import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DesktopProductConfig } from './product.ts'
import { clientReleaseForLogin } from './release-report.ts'

test('a local build only reports to the configured test account origin', () => {
  const config = {
    accountBaseUrl: 'https://account.example',
    buildNumber: '202611231430',
    clientReleaseChannel: 'dev',
  } as DesktopProductConfig
  const key = 'SCHOLARSEED_CLIENT_RELEASE_TEST_ACCOUNT_ORIGIN'
  const previous = process.env[key]
  try {
    process.env[key] = 'https://test.example'
    assert.equal(clientReleaseForLogin(config, '0.3.2', 'https://account.example'), undefined)
    assert.equal(clientReleaseForLogin(config, '0.3.2', 'https://test.example.other'), undefined)
    assert.deepEqual(clientReleaseForLogin(config, '0.3.2', 'https://test.example'), {
      client_version: '0.3.2',
      client_build_number: '202611231430',
      client_channel: 'dev',
    })
    assert.equal(
      clientReleaseForLogin({ ...config, buildNumber: '' }, '0.3.2', 'https://test.example'),
      undefined
    )
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
})

test('eligible distribution metadata reports to the packaged account origin', () => {
  const config = {
    accountBaseUrl: 'https://account.example',
    buildNumber: '202611231430',
    clientReleaseChannel: 'release',
    clientReleaseProduction: true,
  } as DesktopProductConfig
  assert.equal(
    clientReleaseForLogin(config, '0.3.2', 'https://account.example')?.client_channel,
    'release'
  )
})
