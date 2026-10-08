const CRASH_REPORT_MAX_LENGTH = 5000
const UNAVAILABLE_VALUE = 'unavailable'

export interface CrashEnvironment {
  devicePixelRatio: number
  language: string
  location: string
  userAgent: string
  viewportHeight: number
  viewportWidth: number
}

export function createCrashReport(
  error: Error,
  componentStack: string | null,
  environment: CrashEnvironment,
  occurredAt: Date
): string {
  const report = [
    'ScholarSeed renderer crash',
    `Occurred at: ${occurredAt.toISOString()}`,
    `Error name: ${error.name || UNAVAILABLE_VALUE}`,
    `Error message: ${error.message || UNAVAILABLE_VALUE}`,
    `Page: ${environment.location || UNAVAILABLE_VALUE}`,
    `Language: ${environment.language || UNAVAILABLE_VALUE}`,
    `Viewport: ${environment.viewportWidth}x${environment.viewportHeight} @ ${environment.devicePixelRatio}x`,
    `User agent: ${environment.userAgent || UNAVAILABLE_VALUE}`,
    '',
    'JavaScript stack:',
    error.stack || UNAVAILABLE_VALUE,
    '',
    'React component stack:',
    componentStack?.replace(/^\n/, '').trimEnd() || UNAVAILABLE_VALUE
  ].join('\n')

  return report.slice(0, CRASH_REPORT_MAX_LENGTH)
}
