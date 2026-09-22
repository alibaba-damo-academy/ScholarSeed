import { BUILD_NUMBER_PATTERN } from './version.ts'

export const AUTH_MODES = ['off', 'local', 'account', 'auto'] as const
export type AuthMode = (typeof AUTH_MODES)[number]
export const RELEASE_LANES = ['local', 'distribution'] as const
export type ReleaseLane = (typeof RELEASE_LANES)[number]
export const UPDATE_CHANNELS = ['preview', 'release'] as const
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number]
export const CODEX_RUNTIME_PROFILES = ['official'] as const
export type CodexRuntimeProfile = (typeof CODEX_RUNTIME_PROFILES)[number]
export const CREDENTIAL_KEY_PROVIDERS = ['mock_keychain', 'system_keychain'] as const
export type CredentialKeyProvider = (typeof CREDENTIAL_KEY_PROVIDERS)[number]

export const SCHOLARSEED_PRODUCT_ID = 'scholarseed'
export const SCHOLARSEED_PRODUCT_NAME = '书深'
export const SCHOLARSEED_BUNDLE_ID = 'com.scholarseed.desktop'
export const LOCAL_RELEASE_LANE: ReleaseLane = 'local'
export const DISTRIBUTION_RELEASE_LANE: ReleaseLane = 'distribution'

export interface DesktopProductConfig {
  authMode: AuthMode
  accountBaseUrl: string
  productId: string
  productName: string
  bundleId: string
  releaseLane: ReleaseLane
  updateChannel: UpdateChannel
  updateBaseUrl: string
  buildNumber: string
  expectedTeamId: string
  expectedWindowsPublisher: string
  codexRuntime: CodexRuntimePolicy
  credentialProfile: CredentialProfile
  features: DesktopFeaturePolicy
}

export interface DesktopFeaturePolicy {
  feedbackRecorder: boolean
}

export interface CredentialProfile {
  keyProvider: CredentialKeyProvider
  refreshNamespace: string
  sessionNamespace: string
}

export interface CodexRuntimePolicy {
  profile: CodexRuntimeProfile
  executableSha256: string
  reportedVersion: string
}

export const ACCOUNT_AUTH_MODE: AuthMode = 'account'
export const DEVELOPMENT_AUTH_MODE: AuthMode = 'off'
export const PRODUCT_CONFIG_FILE = 'product.json'
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SEMANTIC_VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const CREDENTIAL_NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/

const SECURE_CREDENTIAL_FALLBACK: CredentialProfile = Object.freeze({
  keyProvider: 'system_keychain',
  refreshNamespace: 'distribution',
  sessionNamespace: 'distribution'
})

const SECURE_CODEX_RUNTIME_FALLBACK: CodexRuntimePolicy = Object.freeze({
  profile: 'official',
  executableSha256: '',
  reportedVersion: ''
})

const SECURE_FEATURE_FALLBACK: DesktopFeaturePolicy = Object.freeze({
  feedbackRecorder: false
})

// A broken or missing packaged policy must never make the product anonymous.
export const SECURE_PACKAGED_FALLBACK: DesktopProductConfig = Object.freeze({
  authMode: ACCOUNT_AUTH_MODE,
  accountBaseUrl: '',
  productId: SCHOLARSEED_PRODUCT_ID,
  productName: SCHOLARSEED_PRODUCT_NAME,
  bundleId: SCHOLARSEED_BUNDLE_ID,
  releaseLane: DISTRIBUTION_RELEASE_LANE,
  updateChannel: 'release',
  updateBaseUrl: '',
  buildNumber: '',
  expectedTeamId: '',
  expectedWindowsPublisher: '',
  codexRuntime: SECURE_CODEX_RUNTIME_FALLBACK,
  credentialProfile: SECURE_CREDENTIAL_FALLBACK,
  features: SECURE_FEATURE_FALLBACK
})

export function isAuthMode(value: string): value is AuthMode {
  return AUTH_MODES.some((mode) => mode === value)
}

function normalizeAccountBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return ''
  const parsed = new URL(value.trim())
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('account_base_url must use http or https')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('account_base_url must not contain credentials, query, or fragment')
  }
  return parsed.toString().replace(/\/$/, '')
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string
): T {
  if (typeof value !== 'string' || !allowed.some((candidate) => candidate === value)) {
    throw new Error(`product config ${field} is invalid`)
  }
  return value as T
}

function exactString(value: unknown, expected: string, field: string): string {
  if (value !== expected) throw new Error(`product config ${field} must be ${expected}`)
  return expected
}

function exactBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`product config ${field} must be boolean`)
  return value
}

function patternedString(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`product config ${field} is invalid`)
  }
  return value
}

function parseCodexRuntimePolicy(value: unknown): CodexRuntimePolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('product config runtime policy must be an object')
  }
  const source = value as Record<string, unknown>
  if (source.distribution === 'official-vendored' &&
      source.executable_sha256 === undefined && source.reported_version === undefined) {
    return {
      profile: oneOf(source.profile, CODEX_RUNTIME_PROFILES, 'runtimes.codex.profile'),
      executableSha256: '',
      reportedVersion: 'vendored'
    }
  }
  return {
    profile: oneOf(source.profile, CODEX_RUNTIME_PROFILES, 'runtimes.codex.profile'),
    executableSha256: patternedString(
      source.executable_sha256,
      SHA256_PATTERN,
      'runtimes.codex.executable_sha256'
    ),
    reportedVersion: patternedString(
      source.reported_version,
      SEMANTIC_VERSION_PATTERN,
      'runtimes.codex.reported_version'
    )
  }
}

/**
 * 从多 runtime manifest 里取出默认 runtime 的策略。
 *
 * 开源方案 §5: product.json 从单一 codex_runtime 改为 default_runtime + runtimes
 * 表。主进程只需要当前生效的那一个 runtime 的进程策略, 因此在这里按
 * default_runtime 定位; 它必须存在且已启用, 否则显式失败而不静默回落。
 */
function parseDefaultRuntimePolicy(source: Record<string, unknown>): CodexRuntimePolicy {
  const runtimes = source.runtimes
  if (typeof runtimes !== 'object' || runtimes === null || Array.isArray(runtimes)) {
    throw new Error('product config runtimes must be an object')
  }
  const selected = source.default_runtime
  if (typeof selected !== 'string' || !selected) {
    throw new Error('product config default_runtime is required')
  }
  const policy = (runtimes as Record<string, unknown>)[selected]
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    throw new Error(`product config runtimes.${selected} must be an object`)
  }
  if ((policy as Record<string, unknown>).enabled !== true) {
    throw new Error(`product config default runtime ${selected} is not enabled`)
  }
  return parseCodexRuntimePolicy(policy)
}

function parseCredentialEntry(value: unknown, releaseLane: ReleaseLane): CredentialProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`product config credential_profiles.${releaseLane} must be an object`)
  }
  const source = value as Record<string, unknown>
  const profile = {
    keyProvider: oneOf(
      source.key_provider,
      CREDENTIAL_KEY_PROVIDERS,
      `credential_profiles.${releaseLane}.key_provider`
    ),
    refreshNamespace: patternedString(
      source.refresh_namespace,
      CREDENTIAL_NAMESPACE_PATTERN,
      `credential_profiles.${releaseLane}.refresh_namespace`
    ),
    sessionNamespace: patternedString(
      source.session_namespace,
      CREDENTIAL_NAMESPACE_PATTERN,
      `credential_profiles.${releaseLane}.session_namespace`
    )
  }
  const requiredProvider = releaseLane === LOCAL_RELEASE_LANE ? 'mock_keychain' : 'system_keychain'
  if (profile.keyProvider !== requiredProvider) {
    throw new Error(`product config ${releaseLane} credential key provider must be ${requiredProvider}`)
  }
  return profile
}

function parseCredentialProfile(value: unknown, releaseLane: ReleaseLane): CredentialProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('product config credential_profiles must be an object')
  }
  const profiles = value as Record<string, unknown>
  const local = parseCredentialEntry(profiles.local, LOCAL_RELEASE_LANE)
  const distribution = parseCredentialEntry(profiles.distribution, DISTRIBUTION_RELEASE_LANE)
  if (
    local.refreshNamespace === distribution.refreshNamespace ||
    local.sessionNamespace === distribution.sessionNamespace
  ) {
    throw new Error('local and distribution credential namespaces must be distinct')
  }
  return releaseLane === LOCAL_RELEASE_LANE ? local : distribution
}

function parseFeaturePolicy(value: unknown): DesktopFeaturePolicy {
  if (value === undefined) return { ...SECURE_FEATURE_FALLBACK }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('product config features must be an object')
  }
  const source = value as Record<string, unknown>
  return {
    feedbackRecorder: exactBoolean(source.feedback_recorder, 'features.feedback_recorder')
  }
}

function normalizeUpdateBaseUrl(value: unknown, releaseLane: ReleaseLane): string {
  if (typeof value !== 'string' || !value.trim()) {
    if (releaseLane === DISTRIBUTION_RELEASE_LANE) {
      throw new Error('distribution product config requires update_base_url')
    }
    return ''
  }
  const parsed = new URL(value.trim())
  const allowedProtocols = releaseLane === DISTRIBUTION_RELEASE_LANE
    ? ['https:']
    : ['http:', 'https:']
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new Error('distribution update_base_url must use https')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('update_base_url must not contain credentials, query, or fragment')
  }
  return parsed.toString().replace(/\/$/, '')
}

function normalizeTeamId(value: unknown): string {
  const teamId = typeof value === 'string' ? value.trim() : ''
  if (teamId && !/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error('expected_team_id must be a 10-character Apple Team ID')
  }
  return teamId
}

function normalizeBuildNumber(value: unknown, releaseLane: ReleaseLane): string {
  const buildNumber = typeof value === 'string' ? value.trim() : ''
  if (buildNumber && !BUILD_NUMBER_PATTERN.test(buildNumber)) {
    throw new Error('build_number must be a 12-digit YYYYMMDDHHMM Beijing stamp')
  }
  // A distributed package that cannot rank builds would have to accept whatever the
  // update service calls latest. Unpackaged source runs have no frozen stamp.
  if (releaseLane === DISTRIBUTION_RELEASE_LANE && !buildNumber) {
    throw new Error('distribution product config requires build_number')
  }
  return buildNumber
}

function normalizeWindowsPublisher(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function parseDesktopProductConfig(
  raw: unknown,
  platform: NodeJS.Platform = process.platform
): DesktopProductConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('product config must be an object')
  }
  const source = raw as Record<string, unknown>
  if (typeof source.auth_mode !== 'string' || !isAuthMode(source.auth_mode)) {
    throw new Error('product config auth_mode is invalid')
  }
  const releaseLane = oneOf(source.release_lane, RELEASE_LANES, 'release_lane')
  const accountBaseUrl = normalizeAccountBaseUrl(source.account_base_url)
  if (source.auth_mode === ACCOUNT_AUTH_MODE && !accountBaseUrl) {
    throw new Error('account mode requires account_base_url')
  }
  const expectedTeamId = normalizeTeamId(source.expected_team_id)
  const expectedWindowsPublisher = normalizeWindowsPublisher(source.expected_windows_publisher)
  const buildNumber = normalizeBuildNumber(source.build_number, releaseLane)
  if (releaseLane === DISTRIBUTION_RELEASE_LANE) {
    if (platform === 'darwin' && !expectedTeamId) {
      throw new Error('macOS distribution product config requires expected_team_id')
    }
    if (platform === 'win32' && !expectedWindowsPublisher) {
      throw new Error('Windows distribution product config requires expected_windows_publisher')
    }
  }
  return {
    authMode: source.auth_mode,
    accountBaseUrl,
    productId: exactString(source.product_id, SCHOLARSEED_PRODUCT_ID, 'product_id'),
    productName: exactString(source.product_name, SCHOLARSEED_PRODUCT_NAME, 'product_name'),
    bundleId: exactString(source.bundle_id, SCHOLARSEED_BUNDLE_ID, 'bundle_id'),
    releaseLane,
    updateChannel: oneOf(source.update_channel, UPDATE_CHANNELS, 'update_channel'),
    updateBaseUrl: normalizeUpdateBaseUrl(source.update_base_url, releaseLane),
    buildNumber,
    expectedTeamId,
    expectedWindowsPublisher,
    codexRuntime: parseDefaultRuntimePolicy(source),
    credentialProfile: parseCredentialProfile(source.credential_profiles, releaseLane),
    features: parseFeaturePolicy(source.features)
  }
}

export function resolveAccountBaseUrl(override: string, configuredBaseUrl: string): string {
  if (!override.trim()) return configuredBaseUrl
  return normalizeAccountBaseUrl(override)
}
