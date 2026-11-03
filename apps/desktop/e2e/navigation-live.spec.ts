import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

import { ONBOARDING_GROUPS } from '../src/onboarding'
import { DesktopSession, enterWorkbenchShell, liveStatus, waitForFinishedTurn } from './fixtures/electron'
import { createRuntime, seedLiveConfig } from './fixtures/runtime'

const RESPONSE = '页面恢复验证完成。'
const MESSAGE = `仅回答：${RESPONSE}`
const MODEL_READY_TIMEOUT_MS = 45_000
const PREFERENCES_FILE = 'renderer-preferences.json'

test('真实对话退出重开后自动恢复会话与历史消息，无需重新选择会话', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  writeFileSync(join(runtime.userData, PREFERENCES_FILE), JSON.stringify({
    language: 'zh', storageFirstLaunchSeen: true,
    onboarding: { seen: Object.fromEntries(ONBOARDING_GROUPS.map((group) => [group, true])) }
  }))
  const desktop = new DesktopSession(runtime, testInfo, { preserveNavigation: true, nativeWindowLifecycle: true })
  try {
    let page = await desktop.launch()
    const skip = page.getByTestId('landing-skip')
    if (await skip.isVisible()) await skip.click()
    await enterWorkbenchShell(page)
    await page.getByTestId('topbar-ai').click()
    await page.getByTestId('composer-input').fill(MESSAGE)
    try {
      await expect(page.getByTestId('composer-send')).toBeEnabled({ timeout: MODEL_READY_TIMEOUT_MS })
    } catch (error) {
      await page.screenshot({ path: join(runtime.artifacts, 'model-submit-blocker.png') })
      throw error
    }
    await page.getByTestId('composer-send').click()
    const completed = await waitForFinishedTurn(page)
    await expect(page.getByTestId('ai-panel').getByText(RESPONSE, { exact: true })).toBeVisible()
    await desktop.close()
    page = await desktop.launch()
    if (await page.getByTestId('landing-skip').isVisible()) await page.getByTestId('landing-skip').click()
    await expect.poll(async () => (await liveStatus(page))?.activeSession, { timeout: MODEL_READY_TIMEOUT_MS }).toBe(completed.activeSession)
    await expect(page.getByTestId('user-bubble').getByText(MESSAGE, { exact: true })).toBeVisible()
    await expect(page.getByTestId('ai-panel').getByText(RESPONSE, { exact: true })).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'restored-real-conversation.png'), animations: 'disabled' })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
