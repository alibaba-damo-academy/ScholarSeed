// startupmarker.ts — record of the last successful backend startup, keyed by app version.
//
// The first launch of a build (fresh install or update) pays one-time costs that
// steady-state launches never see: Windows Defender's on-access scan reads the bundled
// Python environment file by file on first exec, so a perfectly live backend can need
// minutes before it binds its port. The marker lets the startup budget and the splash
// copy follow that cost model instead of one fixed number.
//
// The marker is keyed by semver only, so it cannot see cold component provisioning
// inside one semver (a re-extracted python tree pays the same one-time compile/scan
// cost). resolveStartupBudgetMs therefore also takes the per-launch cold flag from
// ensureComponents: either signal means "this launch pays one-time costs".

import { randomUUID } from 'crypto'
import { readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

const STARTUP_MARKER_FILENAME = 'startup-marker.json'
// Steady-state budget: the /api/healthz readiness contract plus spawn latency, with margin.
export const STARTUP_BUDGET_STEADY_MS = 45_000
// One-time-cost budget (first run of a build, or any launch that cold-provisioned
// components): fresh Python trees compile bytecode and get on-access scanned file by
// file before the backend binds.
export const STARTUP_BUDGET_ONE_TIME_MS = 300_000

interface StartupMarker {
  schema: 1
  appVersion: string
}

export function startupMarkerPath(home: string): string {
  return join(home, STARTUP_MARKER_FILENAME)
}

export function readStartupMarkerVersion(home: string): string | null {
  try {
    const marker = JSON.parse(
      readFileSync(startupMarkerPath(home), 'utf8')
    ) as Partial<StartupMarker>
    return typeof marker.appVersion === 'string' ? marker.appVersion : null
  } catch {
    return null
  }
}

export function isFirstRun(home: string, currentVersion: string): boolean {
  return readStartupMarkerVersion(home) !== currentVersion
}

/** 首启或冷组件展开都付一次性成本，二者任一即给一次性预算。 */
export function resolveStartupBudgetMs(firstRun: boolean, coldProvisioned: boolean): number {
  return firstRun || coldProvisioned ? STARTUP_BUDGET_ONE_TIME_MS : STARTUP_BUDGET_STEADY_MS
}

export function writeStartupMarker(home: string, appVersion: string): void {
  const target = startupMarkerPath(home)
  const temporary = join(dirname(target), `.startup-marker-${randomUUID()}.tmp`)
  const marker: StartupMarker = { schema: 1, appVersion }
  writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' })
  renameSync(temporary, target)
}
