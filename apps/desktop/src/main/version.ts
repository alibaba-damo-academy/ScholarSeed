// version.ts — ordering rules for the desktop release identifiers.

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/
export const BUILD_NUMBER_PATTERN = /^\d{12}$/
const BUILD_NUMBER_TIME_ZONE = 'Asia/Shanghai'
const BUILD_NUMBER_PARTS = ['year', 'month', 'day', 'hour', 'minute'] as const
export const STARTUP_BUILD_NUMBER = startupBuildNumber(new Date())

export function clientVersion(version: string, buildNumber: string): string {
  return `${version}-${buildNumber || STARTUP_BUILD_NUMBER}`
}

/** Display identity for a source run without a packaged build number. */
export function startupBuildNumber(startedAt: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: BUILD_NUMBER_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(startedAt)
  return BUILD_NUMBER_PARTS.map((type) => parts.find((part) => part.type === type)!.value).join('')
}

/**
 * A release as the update service identifies it: a three-part SemVer plus the
 * Beijing `YYYYMMDDHHMM` build stamp. One version may carry several builds, so
 * neither half alone is enough to order two releases.
 */
export interface ReleaseIdentity {
  version: string
  buildNumber: string
}

interface ComparableRelease {
  core: number[]
  buildNumber: string
}

function comparable(identity: ReleaseIdentity): ComparableRelease | null {
  const matched = SEMVER_PATTERN.exec(identity.version.trim())
  if (!matched) return null
  const buildNumber = identity.buildNumber.trim()
  if (!BUILD_NUMBER_PATTERN.test(buildNumber)) return null
  return { core: matched.slice(1).map(Number), buildNumber }
}

function compareVersionCore(left: number[], right: number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index]
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Return `false` only when both identities are well formed and the candidate does
 * not outrank the current one. `null` means this client cannot rank the pair at
 * all, so the update service stays authoritative.
 *
 * Ordering matches the CICD contract: SemVer first, then the build stamp, so a
 * rebuild of the same version is still offered as an update.
 */
export function isNewerRelease(
  current: ReleaseIdentity,
  candidate: ReleaseIdentity
): boolean | null {
  const currentRelease = comparable(current)
  const candidateRelease = comparable(candidate)
  if (!currentRelease || !candidateRelease) return null
  const coreOrder = compareVersionCore(candidateRelease.core, currentRelease.core)
  if (coreOrder !== 0) return coreOrder > 0
  return candidateRelease.buildNumber > currentRelease.buildNumber
}
