import type { DesktopProductConfig } from './product.ts'
import { BUILD_NUMBER_PATTERN } from './version.ts'
import type {
  DownloadInfo,
  LatestVersionMeta,
  UpdateCheckResult,
  UpdateIdentityField
} from '../updates.ts'

export const UPDATE_PATH_PREFIX = '/api/v1/updates'
const SHA512_PATTERN = /^[a-f0-9]{128}$/i
// Canonical published architecture names. Lowercase end to end — the update
// service, the OSS layout and the installer file name all spell it this way.
const TARGET_ARCH_TYPES: Readonly<Record<string, string>> = Object.freeze({
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x86_64',
  'win32-x64': 'windows-amd64'
})
const MACOS_ARCH_TYPE_PREFIX = 'darwin-'
const WINDOWS_ARCH_TYPE = 'windows-amd64'

export interface DesktopUpdateConfig {
  baseUrl: string
  channel: string
  buildNumber: string
  productId: string
  bundleId: string
  expectedTeamId: string
  expectedWindowsPublisher: string
  releaseLane: DesktopProductConfig['releaseLane']
}

export function desktopArchType(platform: NodeJS.Platform, arch: string): string | null {
  return TARGET_ARCH_TYPES[`${platform}-${arch}`] ?? null
}

function requiredString(source: Record<string, unknown>, field: string): string {
  const value = source[field]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`update response requires ${field}`)
  return value.trim()
}

function requiredSize(source: Record<string, unknown>): number {
  const value = source.file_size
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('update response requires positive file_size')
  }
  return value
}

function requiredBuildNumber(source: Record<string, unknown>): string {
  const value = source.build_number
  if (typeof value !== 'string' || !BUILD_NUMBER_PATTERN.test(value.trim())) {
    throw new Error('update response requires a 12-digit build_number')
  }
  return value.trim()
}

// The identity gate as one pure rule: the update check rejects exactly the fields
// this reports, and the read-only diagnosis channel surfaces exactly the same
// list, so the two can never drift apart.
export function identityMismatches(
  latest: LatestVersionMeta,
  config: DesktopUpdateConfig,
  expectedArchType: string
): UpdateIdentityField[] {
  const mismatches: UpdateIdentityField[] = []
  if (latest.product_id !== config.productId) mismatches.push('product_id')
  if (latest.bundle_id !== config.bundleId) mismatches.push('bundle_id')
  if (latest.arch_type !== expectedArchType) mismatches.push('arch_type')
  if (latest.channel !== config.channel) mismatches.push('channel')
  // macOS installers are notarized per Apple Team; other platforms carry no team id.
  if (
    expectedArchType.startsWith(MACOS_ARCH_TYPE_PREFIX) &&
    latest.team_id !== config.expectedTeamId
  ) {
    mismatches.push('team_id')
  }
  return mismatches
}

function parseLatest(
  value: unknown,
  config: DesktopUpdateConfig,
  expectedArchType: string
): LatestVersionMeta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('update response latest must be an object')
  }
  const source = value as Record<string, unknown>
  if (expectedArchType === WINDOWS_ARCH_TYPE && config.releaseLane === 'distribution' &&
      !config.expectedWindowsPublisher) {
    throw new Error('packaged product policy has no Windows publisher')
  }
  const sha512 = requiredString(source, 'sha512')
  if (!SHA512_PATTERN.test(sha512)) throw new Error('update response sha512 is invalid')
  const latest: LatestVersionMeta = {
    id: requiredString(source, 'id'),
    version: requiredString(source, 'version'),
    build_number: requiredBuildNumber(source),
    product_id: requiredString(source, 'product_id'),
    bundle_id: requiredString(source, 'bundle_id'),
    arch_type: requiredString(source, 'arch_type'),
    ...(typeof source.team_id === 'string' && source.team_id.trim()
      ? { team_id: source.team_id.trim() }
      : {}),
    channel: requiredString(source, 'channel'),
    file_size: requiredSize(source),
    sha512,
    ...(typeof source.version_built_at === 'string'
      ? { version_built_at: source.version_built_at }
      : {}),
    // Authored in the admin console, so absence is the normal state: only a
    // non-blank string counts as a summary, anything else means "no notes yet".
    ...(typeof source.release_notes === 'string' && source.release_notes.trim()
      ? { release_notes: source.release_notes.trim() }
      : {})
  }
  if (identityMismatches(latest, config, expectedArchType).length) {
    throw new Error('update response identity differs from packaged product policy')
  }
  return latest
}

export function parseUpdateCheckResult(
  value: unknown,
  config: DesktopUpdateConfig,
  expectedArchType: string
): UpdateCheckResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('update response must be an object')
  }
  const source = value as Record<string, unknown>
  if (typeof source.has_update !== 'boolean') throw new Error('update response requires has_update')
  if (!source.has_update) {
    if (source.latest !== null && source.latest !== undefined) {
      throw new Error('no-update response must not contain latest')
    }
    return { has_update: false, latest: null }
  }
  return { has_update: true, latest: parseLatest(source.latest, config, expectedArchType) }
}

export function parseDownloadInfo(
  value: unknown,
  config: DesktopUpdateConfig,
  expectedArchType: string,
  expectedId: string
): DownloadInfo {
  const latest = parseLatest(value, config, expectedArchType)
  if (latest.id !== expectedId) throw new Error('download response id differs from the requested package')
  const source = value as Record<string, unknown>
  const downloadUrl = requiredString(source, 'download_url')
  const parsed = new URL(downloadUrl)
  if (config.releaseLane === 'distribution' && parsed.protocol !== 'https:') {
    throw new Error('distribution download URL must use HTTPS')
  }
  return { ...latest, download_url: downloadUrl }
}

export function buildUpdateCheckUrl(
  config: DesktopUpdateConfig,
  version: string,
  targetArchType: string
): string {
  const url = new URL(`${config.baseUrl}${UPDATE_PATH_PREFIX}/check`)
  url.searchParams.set('product', config.productId)
  url.searchParams.set('version', version)
  // Without a build stamp the service can only rank this client as the oldest
  // build of its version; that happens for unpackaged source runs.
  if (config.buildNumber) url.searchParams.set('build_number', config.buildNumber)
  url.searchParams.set('arch_type', targetArchType)
  url.searchParams.set('channel', config.channel)
  return url.toString()
}
