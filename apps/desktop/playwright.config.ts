import { defineConfig } from '@playwright/test'

const CI_RETRIES = 1
const LIVE_TIMEOUT_MS = 600_000
const SMOKE_TIMEOUT_MS = 90_000
const UPDATE_TIMEOUT_MS = 90_000
const PACKAGE_TIMEOUT_MS = 1_800_000

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? CI_RETRIES : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  projects: [
    {
      name: 'smoke',
      testMatch: /(electron-compat|startup|selection|auth|settings|close|csp|navigation|browser-feature)\.spec\.ts/,
      timeout: SMOKE_TIMEOUT_MS,
    },
    {
      name: 'live',
      testMatch: /(live|assistant|lifecycle|browser-agent)\.spec\.ts/,
      timeout: LIVE_TIMEOUT_MS,
    },
    {
      name: 'workbench',
      testMatch: /(workbench|office|browser-cdp|browser-history|browser-download|browser-policy|browser-address)\.spec\.ts/,
      timeout: LIVE_TIMEOUT_MS,
    },
    {
      name: 'update',
      testMatch: /update\.spec\.ts/,
      timeout: UPDATE_TIMEOUT_MS,
    },
    ...(process.env.SCHOLARSEED_CI_INSTALLER ? [{
      name: 'package',
      testMatch: /package\.spec\.ts/,
      timeout: PACKAGE_TIMEOUT_MS,
      use: { trace: 'on' as const },
    }] : []),
  ],
})
