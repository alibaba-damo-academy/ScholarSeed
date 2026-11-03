import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

import { ONBOARDING_GROUPS } from '../src/onboarding'
import { DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'

const PREFERENCES_FILE = 'renderer-preferences.json'
const BLOCKED_URL = 'https://csp-probe.invalid/'
const CSP_EVENT_TIMEOUT_MS = 5_000
const EXPECTED_SCRIPT_POLICY =
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:"
const QUIT_TIMEOUT_MS = 15_000
const DESTROYED_OBJECT_ERROR =
  /Object has been destroyed|Uncaught Exception|A JavaScript error occurred/

test('CSP survives real renderer reloads and Desktop quits without a main-process exception', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const preferences = join(runtime.userData, PREFERENCES_FILE)
  writeFileSync(
    preferences,
    JSON.stringify({
      ...JSON.parse(readFileSync(preferences, 'utf8')),
      onboarding: { seen: Object.fromEntries(ONBOARDING_GROUPS.map((group) => [group, true])) },
    })
  )
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const response = await page.reload({ waitUntil: 'load' })
    expect(response).not.toBeNull()
    const violation = await page.evaluate(
      async ({ url, timeoutMs }) => {
        const violation = new Promise<{
          directive: string
          blockedURI: string
          policy: string
        } | null>((resolve) => {
          const timeout = setTimeout(() => resolve(null), timeoutMs)
          document.addEventListener(
            'securitypolicyviolation',
            (event) => {
              clearTimeout(timeout)
              resolve({
                directive: event.effectiveDirective,
                blockedURI: event.blockedURI,
                policy: event.originalPolicy,
              })
            },
            { once: true }
          )
        })
        await fetch(url).catch(() => undefined)
        return violation
      },
      { url: BLOCKED_URL, timeoutMs: CSP_EVENT_TIMEOUT_MS }
    )
    await testInfo.attach('csp-enforcement', {
      body: JSON.stringify(violation),
      contentType: 'application/json',
    })
    expect(violation).toMatchObject({ directive: 'connect-src', blockedURI: BLOCKED_URL })
    expect(violation?.policy).toContain(EXPECTED_SCRIPT_POLICY)
    await expect(page.getByTestId('workbench-shell')).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'csp-desktop.png') })
    desktop.assertNoPageErrors()

    const proc = desktop.app!.process()
    await desktop.close()
    await expect.poll(() => proc.exitCode, { timeout: QUIT_TIMEOUT_MS }).toBe(0)
    expect(proc.signalCode).toBeNull()
    expect(readFileSync(join(runtime.artifacts, 'desktop.log'), 'utf8')).not.toMatch(
      DESTROYED_OBJECT_ERROR
    )
    const lifecycle = readFileSync(join(runtime.home, 'logs', 'window.log'), 'utf8')
    expect(lifecycle).toContain('main window destroyed')
    expect(lifecycle).toContain('will quit')
    await testInfo.attach('window-lifecycle', { body: lifecycle, contentType: 'text/plain' })
  } finally {
    await desktop.attachArtifacts()
  }
})
