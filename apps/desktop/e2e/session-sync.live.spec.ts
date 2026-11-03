import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { apiBase, DesktopSession, liveStatus, waitForFinishedTurn } from './fixtures/electron'
import { createRuntime, seedLiveConfig } from './fixtures/runtime'
import { ONBOARDING_GROUPS } from '../src/onboarding'

const READY_TIMEOUT_MS = 90_000
const COMPLETION_TIMEOUT_MS = 240_000
const PRIMARY_MARKER = 'SESSION_SYNC_PRIMARY_DONE'
const QUEUED_MARKER = 'SESSION_SYNC_QUEUED_DONE'
const PRIMARY_PROMPT = `这是一次真实桌面会话恢复验收。请使用可用的计划工具创建两项计划：执行等待命令、完成交付。然后使用 shell 执行 python -c "import time; time.sleep(25)"，完成后把计划全部标记完成，并回复 ${PRIMARY_MARKER}。`
const QUEUED_PROMPT = `请确认收到这条排队消息，只回复 ${QUEUED_MARKER}。`

test('foreground recovery reconciles real completed plans and consumed queued turns', async ({ request }, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: Object.fromEntries(ONBOARDING_GROUPS.map((group) => [group, true])) }
  }))
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    const window = await desktop.browserWindow(page)
    await window.evaluate((nativeWindow) => nativeWindow.show())
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, { timeout: READY_TIMEOUT_MS }).toBe(true)
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-bypassPermissions').click()
    await page.getByTestId('mode-bypassPermissions-confirm').click()
    await page.getByTestId('composer-input').fill(PRIMARY_PROMPT)
    await page.getByTestId('composer-send').click()
    await expect(page.getByTestId('composer-stop')).toBeVisible({ timeout: READY_TIMEOUT_MS })
    await expect(page.getByTestId('todo-panel')).toBeVisible({ timeout: READY_TIMEOUT_MS })
    const sessionId = (await liveStatus(page))?.activeSession
    expect(sessionId).toBeTruthy()
    const base = await apiBase(page)
    await page.getByTestId('composer-input').fill(QUEUED_PROMPT)
    await page.getByTestId('composer-send').click()
    await expect.poll(async () => {
      const response = await request.get(`${base}/api/serve/sessions/${sessionId}/queue`)
      expect(response.ok()).toBe(true)
      const payload = await response.json()
      return payload.messages?.length ?? 0
    }, { timeout: READY_TIMEOUT_MS }).toBeGreaterThan(0)
    await window.evaluate((nativeWindow) => nativeWindow.minimize())
    await expect.poll(async () => {
      const response = await request.get(`${base}/api/serve/history/${sessionId}`)
      expect(response.ok()).toBe(true)
      const history = await response.json()
      return {
        completed: history.turn_activity?.filter((turn: { outcome: string }) => turn.outcome === 'completed').length,
        finishedPlan: history.todos?.length > 0 && history.todos.every((item: { status: string }) => item.status === 'completed')
      }
    }, { timeout: COMPLETION_TIMEOUT_MS }).toMatchObject({ completed: 2, finishedPlan: true })
    await window.evaluate((nativeWindow) => {
      nativeWindow.restore()
      nativeWindow.show()
      nativeWindow.focus()
    })
    await waitForFinishedTurn(page)
    await expect(page.getByTestId('todo-progress')).toHaveText('2 / 2')
    await expect(page.locator('.md-agent').filter({ hasText: PRIMARY_MARKER }).last()).toBeVisible()
    await expect(page.locator('.md-agent').filter({ hasText: QUEUED_MARKER }).last()).toBeVisible()
    await expect(page.locator('[data-testid^="queued-delete-"]')).toHaveCount(0)
    const lifecycle = join(runtime.home, 'logs', 'window.log')
    await expect.poll(() => readFileSync(lifecycle, 'utf8'), { timeout: READY_TIMEOUT_MS }).toContain('"reason":"foreground"')
    expect(readFileSync(lifecycle, 'utf8')).toContain('[session-recovery]')
    expect(readFileSync(lifecycle, 'utf8')).toContain('"stage":"restored"')
    await page.screenshot({ path: join(runtime.artifacts, 'session-sync-completed.png') })
    await testInfo.attach('session-sync-evidence', {
      body: JSON.stringify({ sessionId, home: runtime.home, screenshot: join(runtime.artifacts, 'session-sync-completed.png') }),
      contentType: 'application/json'
    })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
