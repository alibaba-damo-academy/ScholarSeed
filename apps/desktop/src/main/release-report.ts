import type { DesktopProductConfig } from './product.ts'

const TEST_ACCOUNT_ORIGIN = 'SCHOLARSEED_CLIENT_RELEASE_TEST_ACCOUNT_ORIGIN'
const TEST_GATEWAY = 'SCHOLARSEED_CLIENT_RELEASE_TEST_GATEWAY'
const REPORT_ENV = 'SCHOLARSEED_CLIENT_RELEASE'

function origin(value: string | undefined): string {
  try {
    const url = new URL(value ?? '')
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : ''
  } catch {
    return ''
  }
}

export function clientReleaseFields(config: DesktopProductConfig, version: string) {
  if (!config.buildNumber || !config.clientReleaseChannel) return undefined
  return {
    client_version: version,
    client_build_number: config.buildNumber,
    client_channel: config.clientReleaseChannel,
  }
}

export function clientReleaseForLogin(config: DesktopProductConfig, version: string, base: string) {
  const target = origin(base)
  const packagedAccount = origin(config.accountBaseUrl)
  const testAccount = origin(process.env[TEST_ACCOUNT_ORIGIN])
  const productionAllowed = config.clientReleaseProduction && target === packagedAccount
  const testAllowed = target === testAccount && target !== packagedAccount
  if (!target || (!productionAllowed && !testAllowed)) return undefined
  return clientReleaseFields(config, version)
}

export function clientReleaseEnvironment(config: DesktopProductConfig, version: string) {
  const release = clientReleaseFields(config, version)
  return {
    [REPORT_ENV]: release
      ? JSON.stringify({
          ...release,
          production: config.clientReleaseProduction === true,
          test_gateway: process.env[TEST_GATEWAY] ?? '',
        })
      : '',
  }
}
