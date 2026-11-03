import { basename } from 'node:path'
import { test, type TestInfo } from '@playwright/test'
import policy from '../../../../scripts/ci/quarantine.json'

const QUARANTINE_ENVIRONMENT = 'SCHOLARSEED_CI_QUARANTINE'
const ENABLED_VALUE = '1'

export function skipQuarantined(testInfo: TestInfo): void {
  if (process.env[QUARANTINE_ENVIRONMENT] !== ENABLED_VALUE) return
  const entry = policy.playwright.find(item => item.project === testInfo.project.name &&
    item.file === basename(testInfo.file) && item.title === testInfo.title)
  if (entry) test.skip(true, entry.reason)
}
