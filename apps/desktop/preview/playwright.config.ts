import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'
import { PREVIEW_ORIGIN } from './constants'
import { WORKSPACE_WINDOW_SIZE } from '../src/window.ts'

const TEST_TIMEOUT_MS = 45_000
const STARTUP_TIMEOUT_MS = 120_000
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-')

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: resolve(__dirname, '../test-results/preview', RUN_ID),
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: TEST_TIMEOUT_MS,
  use: { baseURL: PREVIEW_ORIGIN, browserName: 'chromium', channel: process.env.SCHOLARSEED_PREVIEW_BROWSER_CHANNEL || 'chrome', viewport: WORKSPACE_WINDOW_SIZE, screenshot: 'only-on-failure', trace: 'retain-on-failure', locale: 'zh-CN', timezoneId: 'Asia/Shanghai' },
  projects: [{ name: 'preview' }],
  webServer: {
    command: 'node ../../scripts/ops-cli.cjs dev browser --mock',
    cwd: resolve(__dirname, '..'),
    url: PREVIEW_ORIGIN,
    timeout: STARTUP_TIMEOUT_MS,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
