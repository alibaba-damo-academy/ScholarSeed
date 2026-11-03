// Successful backend startup identity: SemVer and build number travel together.
// A prepared component tree may already exist for a new build, while Defender
// and Python still pay first-execution costs. The marker therefore compares the
// full client version; cold component preparation independently grants the same
// one-time budget. This is a timeout hint, never update activation health proof.

import { join } from 'path'
import { readRecord, writeJson } from './journal.ts'
import { clientVersion } from './version.ts'
import type { ReleaseIdentity } from './version.ts'

const STARTUP_MARKER_FILENAME = 'startup-marker.json'
const STARTUP_MARKER_SCHEMA = 1
export const STARTUP_MARKER_MAX_BYTES = 64 * 1024
// Steady-state budget: the /api/healthz readiness contract plus spawn latency, with margin.
export const STARTUP_BUDGET_STEADY_MS = 45_000
// One-time-cost budget (first run of a build, or any launch that cold-provisioned
// components): fresh Python trees compile bytecode and get on-access scanned file by
// file before the backend binds.
export const STARTUP_BUDGET_ONE_TIME_MS = 300_000

interface StartupMarker {
  schema: typeof STARTUP_MARKER_SCHEMA
  appVersion: string
}

export function startupMarkerPath(home: string): string {
  return join(home, STARTUP_MARKER_FILENAME)
}

export function readStartupMarkerVersion(home: string): string | null {
  try {
    return decodeStartupMarkerVersion(readRecord(startupMarkerPath(home), STARTUP_MARKER_MAX_BYTES))
  } catch {
    return null
  }
}

export function decodeStartupMarkerVersion(bytes: Uint8Array): string | null {
  if (bytes.byteLength > STARTUP_MARKER_MAX_BYTES)
    throw new Error('Startup marker exceeds size limit')
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const marker = value as Partial<StartupMarker>
  return marker.schema === STARTUP_MARKER_SCHEMA && typeof marker.appVersion === 'string'
    ? marker.appVersion
    : null
}

export function isFirstRun(home: string, release: ReleaseIdentity): boolean {
  return readStartupMarkerVersion(home) !== clientVersion(release.version, release.buildNumber)
}

/** 准备阶段结束后仍保留普通就绪余量；首启或冷组件展开维持一次性预算下限。 */
export function resolveStartupBudgetMs(
  firstRun: boolean,
  coldProvisioned: boolean,
  preparationBudgetMs = 0
): number {
  const baseline = firstRun || coldProvisioned
    ? STARTUP_BUDGET_ONE_TIME_MS
    : STARTUP_BUDGET_STEADY_MS
  return Math.max(baseline, preparationBudgetMs + STARTUP_BUDGET_STEADY_MS)
}

export function writeStartupMarker(home: string, release: ReleaseIdentity): void {
  const target = startupMarkerPath(home)
  writeJson(target, startupMarkerRecord(release))
}

export function startupMarkerRecord(release: ReleaseIdentity): StartupMarker {
  return {
    schema: STARTUP_MARKER_SCHEMA,
    appVersion: clientVersion(release.version, release.buildNumber),
  }
}
