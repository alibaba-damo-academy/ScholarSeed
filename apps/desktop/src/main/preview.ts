import { PREVIEW_UPDATE_SCOPES } from '../updates.ts'
import type { LatestVersionMeta, PreviewUpdatePolicy, PreviewUpdateScope } from '../updates.ts'
import { isNewerRelease } from './version.ts'

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const PREVIEW_STATE_FILE = 'preview.json'
export const PREVIEW_STATE_LIMIT = 64 * 1024
export const PREVIEW_STATE_SCHEMA = 1

export interface PreviewContext {
  version: string
  build_number?: string
  preview_scope: PreviewUpdateScope
  target_line?: string
  target_id?: string
  update_engine?: 'velopack'
}
export interface PreviewRecord extends PreviewUpdatePolicy {
  schema: number
  source: string
}

export function previewLine(version: string): string {
  const match = VERSION_PATTERN.exec(version)
  if (!match) throw new Error('Invalid preview version')
  return `${match[1]}.${match[2]}`
}

export function previewScope(value: unknown): PreviewUpdateScope {
  if (!PREVIEW_UPDATE_SCOPES.includes(value as PreviewUpdateScope))
    throw new Error('Invalid preview update scope')
  return value as PreviewUpdateScope
}

/** Exact immutable artifact identity, excluding administrator-authored release notes. */
export function samePreviewArtifact(left: LatestVersionMeta, right: LatestVersionMeta): boolean {
  return (
    left.id === right.id &&
    left.version === right.version &&
    left.build_number === right.build_number &&
    left.sha512 === right.sha512 &&
    left.file_size === right.file_size &&
    left.channel === right.channel &&
    left.product_id === right.product_id &&
    left.bundle_id === right.bundle_id &&
    left.arch_type === right.arch_type &&
    left.team_id === right.team_id
  )
}

export function previewAllows(
  policy: PreviewUpdatePolicy,
  version: string,
  build: string,
  candidate: LatestVersionMeta
): boolean {
  if (candidate.channel !== 'preview') return false
  if (
    isNewerRelease(
      { version, buildNumber: build },
      { version: candidate.version, buildNumber: candidate.build_number }
    ) !== true
  )
    return false
  if (policy.target) return samePreviewArtifact(policy.target, candidate)
  return policy.scope === 'current-version'
    ? candidate.version === version
    : previewLine(candidate.version) === previewLine(version)
}

/** Consent belongs to the source installation; installing any new build consumes it. */
export function restorePreviewPolicy(
  value: unknown,
  source: string,
  parseCandidate: (value: unknown) => LatestVersionMeta
): PreviewUpdatePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid preview policy record')
  const record = value as PreviewRecord
  if (record.schema !== PREVIEW_STATE_SCHEMA || typeof record.source !== 'string')
    throw new Error('Invalid preview policy schema')
  const scope = previewScope(record.scope)
  return {
    scope,
    ...(record.source === source && record.target ? { target: parseCandidate(record.target) } : {}),
  }
}

export function previewContext(
  policy: PreviewUpdatePolicy,
  version: string,
  build: string,
  engine?: 'velopack'
): PreviewContext {
  previewLine(version)
  return {
    version,
    ...(build ? { build_number: build } : {}),
    preview_scope: policy.scope,
    ...(policy.target
      ? { target_line: previewLine(policy.target.version), target_id: policy.target.id }
      : {}),
    ...(engine ? { update_engine: engine } : {}),
  }
}

export function appendPreviewContext(url: URL, context: PreviewContext): void {
  for (const [key, value] of Object.entries(context)) url.searchParams.set(key, value)
}
