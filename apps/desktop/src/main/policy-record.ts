export type BrowserAgentAction = 'read' | 'interact' | 'submit'
export type BrowserAgentDecision = 'ask' | 'allow' | 'block'
export type BrowserAgentPersistentAction = Exclude<BrowserAgentAction, 'submit'>

export interface SiteRule {
  read: BrowserAgentDecision
  interact: BrowserAgentDecision
}
export interface StoredPolicy {
  schemaVersion: number
  revision: number
  agentBrowserUseEnabled: boolean
  sites: Record<string, SiteRule>
}

export const POLICY_SCHEMA_VERSION = 2
const DEFAULT_AGENT_BROWSER_USE_ENABLED = true
const DEFAULT_SEARCH_ORIGINS = ['https://www.bing.com', 'https://cn.bing.com'] as const
const LEGACY_POLICY_SCHEMA_VERSION = 1
const POLICY_INVALID_ERROR = 'browser_policy_invalid'
const POLICY_CORRUPT_ERROR = 'browser_policy_corrupt'

export function normalizePolicyOrigin(input: string): string {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error(POLICY_INVALID_ERROR)
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.origin === 'null'
  ) {
    throw new Error(POLICY_INVALID_ERROR)
  }
  return url.origin
}

export function emptyPolicy(): StoredPolicy {
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    revision: 0,
    agentBrowserUseEnabled: DEFAULT_AGENT_BROWSER_USE_ENABLED,
    sites: Object.fromEntries(
      DEFAULT_SEARCH_ORIGINS.map((origin) => [origin, { read: 'allow', interact: 'allow' }])
    ),
  }
}

export function parsePolicy(raw: string): StoredPolicy {
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(POLICY_CORRUPT_ERROR)
  const record = value as Record<string, unknown>
  const legacy = record.schemaVersion === LEGACY_POLICY_SCHEMA_VERSION
  if (
    Object.keys(record).sort().join(',') !==
      (legacy
        ? 'revision,schemaVersion,sites'
        : 'agentBrowserUseEnabled,revision,schemaVersion,sites') ||
    (record.schemaVersion !== LEGACY_POLICY_SCHEMA_VERSION &&
      record.schemaVersion !== POLICY_SCHEMA_VERSION) ||
    (!legacy && typeof record.agentBrowserUseEnabled !== 'boolean') ||
    !Number.isSafeInteger(record.revision) ||
    Number(record.revision) < 0 ||
    Number(record.revision) >= Number.MAX_SAFE_INTEGER ||
    !record.sites ||
    typeof record.sites !== 'object' ||
    Array.isArray(record.sites)
  )
    throw new Error(POLICY_CORRUPT_ERROR)
  const sites = record.sites as Record<string, unknown>
  for (const [origin, rule] of Object.entries(sites)) {
    if (
      normalizePolicyOrigin(origin) !== origin ||
      !rule ||
      typeof rule !== 'object' ||
      Array.isArray(rule)
    )
      throw new Error(POLICY_CORRUPT_ERROR)
    const actions = rule as Record<string, unknown>
    if (
      Object.keys(actions).sort().join(',') !== 'interact,read' ||
      !['ask', 'allow', 'block'].includes(String(actions.read)) ||
      !['ask', 'allow', 'block'].includes(String(actions.interact))
    )
      throw new Error(POLICY_CORRUPT_ERROR)
  }
  return {
    ...record,
    schemaVersion: POLICY_SCHEMA_VERSION,
    agentBrowserUseEnabled: legacy ? false : record.agentBrowserUseEnabled,
  } as StoredPolicy
}
