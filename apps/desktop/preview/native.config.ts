import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-')

export default defineConfig({
  testDir: '.',
  testMatch: 'native.spec.mjs',
  outputDir: resolve(__dirname, '../test-results/pdfe-native-ui', RUN_ID),
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list'], ['json', { outputFile: resolve(__dirname, '../test-results/pdfe-native-ui', RUN_ID, 'report.json') }]],
  projects: [{ name: 'pdfe' }],
})
