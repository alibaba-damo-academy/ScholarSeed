// startupmarker.ts — record of the last successful backend startup, keyed by app version.
//
// The first launch of a build (fresh install or update) pays one-time costs that
// steady-state launches never see: Windows Defender's on-access scan reads the bundled
// Python environment file by file on first exec, so a perfectly live backend can need
// minutes before it binds its port. The marker lets the startup budget and the splash
// copy follow that cost model instead of one fixed number.

import { randomUUID } from 'crypto'
import { readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

const STARTUP_MARKER_FILENAME = 'startup-marker.json'

interface StartupMarker {
  schema: 1
  appVersion: string
}

export function startupMarkerPath(home: string): string {
  return join(home, STARTUP_MARKER_FILENAME)
}

export function readStartupMarkerVersion(home: string): string | null {
  try {
    const marker = JSON.parse(readFileSync(startupMarkerPath(home), 'utf8')) as Partial<StartupMarker>
    return typeof marker.appVersion === 'string' ? marker.appVersion : null
  } catch {
    return null
  }
}

export function isFirstRun(home: string, currentVersion: string): boolean {
  return readStartupMarkerVersion(home) !== currentVersion
}

export function writeStartupMarker(home: string, appVersion: string): void {
  const target = startupMarkerPath(home)
  const temporary = join(dirname(target), `.startup-marker-${randomUUID()}.tmp`)
  const marker: StartupMarker = { schema: 1, appVersion }
  writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' })
  renameSync(temporary, target)
}
