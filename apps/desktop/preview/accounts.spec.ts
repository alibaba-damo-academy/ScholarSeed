import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewScenario, previewSurface, expect, test, type Page } from './testing'
import { PREVIEW_CATALOG } from './catalog'
import { previewConsumption } from './coverage'

const PAGE_ID = 'settings-account'
const SIMULATED_NICKNAME = '模拟协作账号（非真实用户）'
const PROFILE_PATH = '/api/account/me'
const SCENES = [
  { id: 'settings-account-states', mode: 'no-base', states: ['error'] },
  { id: 'settings-account-ready', mode: 'ready', states: ['loaded'] },
  { id: 'settings-account-pending', mode: 'delayed', states: ['loading', 'loaded'] },
  { id: 'settings-account-failed', mode: 'failed', states: ['error', 'retry-failed'] },
  { id: 'settings-account-anonymous', mode: 'anonymous', states: ['loaded', 'unauthorized'] },
] as const
const IDENTITY_ACTIONS = ['account-edit-nickname', 'account-change-phone-open', 'account-reset-password-open', 'account-switch', 'account-logout', 'account-nickname-save'] as const

async function openAccount(page: Page, sceneId: string): Promise<void> {
  const entry = PREVIEW_CATALOG.find(candidate => candidate.id === PAGE_ID)!
  const scene = entry.scenarios.find(candidate => candidate.id === sceneId)!
  await page.goto(`/?previewInstance=${randomUUID()}&scene=page-home`)
  await page.keyboard.press('F8')

  await openPreviewScenario(page, entry.id, scene.id, true)
  await expect(page.getByRole('heading', { name: 'PDFE 工作台', exact: true })).toBeVisible()
  await expect(previewSurface(page).getByTestId('account-settings-account')).toBeVisible()
}

async function expectUnconfirmed(page: Page): Promise<void> {
  const content = previewSurface(page).getByTestId('account-settings-account')
  await expect(content).not.toContainText('已登录')
  for (const action of IDENTITY_ACTIONS) await expect(previewSurface(page).getByTestId(action)).toHaveCount(0)
}

for (const scene of SCENES) {
  test(`${scene.id} consumes the real account client through its selected mock scene`, { annotation: previewConsumption(PAGE_ID, scene.id, scene.states) }, async ({ page }, testInfo) => {
    const profiles: { path: string; status: number }[] = []
    const failures: { path: string; status: number }[] = []
    page.on('response', response => {
      const path = new URL(response.url()).pathname
      if (path === PROFILE_PATH) profiles.push({ path, status: response.status() })
      if (path.startsWith('/api/') && response.status() >= 400) failures.push({ path, status: response.status() })
    })
    try {
      await openAccount(page, scene.id)
      const content = previewSurface(page).getByTestId('account-settings-account')
      if (scene.mode === 'delayed') {
        await expect(content.getByRole('status')).toHaveText('正在确认账号状态…')
        await expectUnconfirmed(page)
        await page.screenshot({ path: testInfo.outputPath('account-loading.png'), fullPage: true })
      }
      if (scene.mode === 'ready' || scene.mode === 'delayed') {
        await expect(previewSurface(page).getByTestId('account-edit-nickname')).toHaveText(SIMULATED_NICKNAME)
        await expect(previewSurface(page).getByTestId('account-reset-password-open')).toBeEnabled()
        await expect(content.getByRole('alert')).toHaveCount(0)
        expect(profiles.length).toBeGreaterThan(0)
        expect(profiles.every(response => response.status === 200)).toBe(true)
        await page.screenshot({ path: testInfo.outputPath('account-simulated-profile.png'), fullPage: true })
        await page.reload()
        await expect(previewSurface(page).getByTestId('account-edit-nickname')).toHaveText(SIMULATED_NICKNAME)
        await page.screenshot({ path: testInfo.outputPath('account-profile-reloaded.png'), fullPage: true })
      } else {
        await expectUnconfirmed(page)
        if (scene.mode === 'anonymous') {
          await expect(previewSurface(page).getByTestId('account-login-open')).toBeEnabled()
          await expect(previewSurface(page).getByTestId('account-profile-retry')).toHaveCount(0)
          expect(profiles).toEqual([])
        } else {
          const retry = previewSurface(page).getByTestId('account-profile-retry')
          await expect(retry).toBeEnabled()
          await expect(content.getByRole('alert')).toContainText(scene.mode === 'no-base' ? '账号服务地址未配置' : '请求失败（503）')
          const before = profiles.length
          await retry.click()
          await expect(retry).toBeEnabled()
          if (scene.mode === 'failed') await expect.poll(() => profiles.length).toBeGreaterThan(before)
          else expect(profiles).toEqual([])
          await expect(content.getByRole('alert')).toContainText(scene.mode === 'no-base' ? '账号服务地址未配置' : '请求失败（503）')
          await expectUnconfirmed(page)
        }
        await page.screenshot({ path: testInfo.outputPath(`account-${scene.mode}.png`), fullPage: true })
      }
      if (scene.mode === 'failed') {
        expect(failures.length).toBeGreaterThan(0)
        expect(failures.every(response => response.path === PROFILE_PATH && response.status === 503)).toBe(true)
      } else expect(failures).toEqual([])
    } finally {
      const path = testInfo.outputPath('account-http-summary.json')
      await writeFile(path, JSON.stringify({ profiles, failures }, null, 2))
      await testInfo.attach('account-http-summary', { path, contentType: 'application/json' })
    }
  })
}
