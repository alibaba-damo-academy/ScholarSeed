import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewScenario, previewSurface, expect, test, type Page } from './testing'
import { PREVIEW_CATALOG } from './catalog'
import { previewConsumption } from './coverage'
import { PREVIEW_BROWSER } from './browser'
import { WORKSPACE_WINDOW_MINIMUM } from '../src/window'
import { PREVIEW_ORIGIN } from './constants'

const PAGE_ID = 'settings-browser'
const ORIGIN = 'https://research.example.org'
const RULES = 'browser-settings-agent-sites'
const HISTORY = 'browser-settings-history'

async function openBrowser(page: Page, sceneId: string): Promise<void> {
  const entry = PREVIEW_CATALOG.find(candidate => candidate.id === PAGE_ID)!
  const scene = entry.scenarios.find(candidate => candidate.id === sceneId)!
  await page.goto(`/?previewInstance=${randomUUID()}&scene=page-home`)
  await page.keyboard.press('F8')
  await openPreviewScenario(page, entry.id, scene.id)
  await expect(previewSurface(page).getByTestId('account-settings-browser')).toBeVisible()
  await expect(previewSurface(page).getByTestId('browser-settings-cdp').getByRole('switch')).toBeDisabled()
  await expect(previewSurface(page).getByTestId('browser-settings-downloads').getByRole('button', { name: '选择下载文件夹', exact: true })).toBeDisabled()
  await expect(previewSurface(page).getByTestId('browser-settings-vault').getByRole('button').first()).toBeDisabled()
}

test('browser settings preserve policy edits, search, pagination, deletion, clear confirmation and reentry', {
  annotation: previewConsumption(PAGE_ID, 'settings-browser-states', ['loaded', 'editing', 'error', 'searched', 'paged', 'deleted', 'cleared', 'reloaded']),
}, async ({ page }, testInfo) => {
  const externalOrigins = new Set<string>()
  const pageErrors: string[] = []
  const browserRequests: { path: string; body: unknown }[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.protocol.startsWith('http') && url.origin !== PREVIEW_ORIGIN) externalOrigins.add(url.origin)
    if (url.pathname.startsWith(PREVIEW_BROWSER.path)) browserRequests.push({ path: url.pathname, body: request.postDataJSON() })
  })
  try {
    await openBrowser(page, 'settings-browser-states')
    const rules = previewSurface(page).getByTestId(RULES)
    await expect(rules.getByTestId('browser-agent-site-list').locator('li')).toHaveCount(1)
    await rules.getByRole('textbox', { name: '精确网站来源地址', exact: true }).fill(ORIGIN)
    const saved = page.waitForResponse(response => response.url().includes(`${PREVIEW_BROWSER.path}/policy`) && response.request().postDataJSON().kind === 'set')
    await rules.getByRole('button', { name: '添加规则', exact: true }).click()
    expect((await (await saved).json()).ok).toBe(true)
    await expect(rules.getByTestId('browser-agent-site-list').locator('li')).toHaveCount(2)
    await rules.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('browser-policy-added.png') })
    await page.reload()
    await expect(previewSurface(page).getByRole('button', { name: `移除 ${ORIGIN} 的规则`, exact: true })).toBeVisible()
    const history = previewSurface(page).getByTestId(HISTORY)
    await expect(history.getByTestId('browser-history-list').locator('li')).toHaveCount(20)
    await history.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(history.getByTestId('browser-history-list').locator('li')).toHaveCount(4)
    await history.getByRole('searchbox', { name: '搜索标题或网址', exact: true }).fill('notes/24')
    await expect(history.getByTestId('browser-history-list').locator('li')).toHaveCount(1)
    await history.getByRole('button', { name: '重新打开', exact: true }).click()
    await expect(history.getByRole('alert')).toHaveText('内置浏览器仅在桌面端可用。')
    await history.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('browser-history-filtered-native-unavailable.png') })
    await history.getByRole('button', { name: '删除记录', exact: true }).click()
    await expect(history.getByText('没有浏览记录。', { exact: true })).toBeVisible()
    await history.getByRole('searchbox', { name: '搜索标题或网址', exact: true }).fill('')
    await expect(history.getByTestId('browser-history-list').locator('li')).toHaveCount(20)
    const data = previewSurface(page).getByTestId('browser-settings-data')
    await data.getByRole('combobox', { name: '清除范围', exact: true }).click()
    await previewSurface(page).getByRole('option', { name: '全部历史', exact: true }).click()
    await data.getByRole('button', { name: '清除', exact: true }).click()
    const confirmation = previewSurface(page).getByRole('alertdialog')
    await expect(confirmation).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('browser-history-clear-confirm.png') })
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    expect(browserRequests.filter(request => request.path.endsWith('/data'))).toHaveLength(0)
    await data.getByRole('button', { name: '清除', exact: true }).click()
    await previewSurface(page).getByRole('alertdialog').getByRole('button', { name: '清除', exact: true }).click()
    await expect(history.getByText('没有浏览记录。', { exact: true })).toBeVisible()
    await page.reload()
    await expect(history.getByText('没有浏览记录。', { exact: true })).toBeVisible()
    await expect(previewSurface(page).getByRole('button', { name: `移除 ${ORIGIN} 的规则`, exact: true })).toBeVisible()
    await previewSurface(page).getByRole('button', { name: `移除 ${ORIGIN} 的规则`, exact: true }).click()
    await expect(previewSurface(page).getByRole('button', { name: `移除 ${ORIGIN} 的规则`, exact: true })).toHaveCount(0)
    await page.setViewportSize(WORKSPACE_WINDOW_MINIMUM)
    await history.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('browser-history-cleared-minimum.png') })
    expect(externalOrigins.size).toBe(0)
    expect(pageErrors).toEqual([])
  } finally {
    await writeFile(testInfo.outputPath('browser-consumption.json'), JSON.stringify({ externalOrigins: [...externalOrigins], pageErrors, browserRequests }, null, 2))
  }
})

for (const mode of ['empty', 'pending', 'failed', 'retry'] as const) {
  const sceneId = `settings-browser-${mode}`
  const states = mode === 'empty' ? ['empty'] : mode === 'pending' ? ['loading', 'loaded'] : mode === 'failed' ? ['error', 'retry-failed'] : ['error', 'retried', 'loaded']
  test(`browser ${mode} uses the original loading, empty or retry controls`, { annotation: previewConsumption(PAGE_ID, sceneId, states) }, async ({ page }, testInfo) => {
    await openBrowser(page, sceneId)
    const rules = previewSurface(page).getByTestId(RULES)
    const history = previewSurface(page).getByTestId(HISTORY)
    if (mode === 'pending') {
      await expect(rules.getByText('正在读取 Agent 网站规则…', { exact: true })).toBeVisible()
      await expect(history.getByText('正在加载浏览记录…', { exact: true })).toBeVisible()
      await rules.scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath('browser-loading.png') })
    }
    if (mode === 'empty') {
      await expect(rules.getByText('暂无 Agent 网站规则。', { exact: true })).toBeVisible()
      await expect(history.getByText('没有浏览记录。', { exact: true })).toBeVisible()
    } else if (mode === 'failed' || mode === 'retry') {
      await expect(rules.getByRole('alert')).toBeVisible()
      await rules.scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath('browser-policy-read-error.png') })
      if (mode === 'retry') {
        await page.keyboard.press('F8')
        const recovered = page.waitForResponse(response => response.url().includes(PREVIEW_BROWSER.recoveryPath) && response.request().method() === 'POST')
        await page.getByTestId('preview-browser-recover').click()
        expect((await recovered).status()).toBe(200)
        await page.getByRole('button', { name: '关闭预览控制台', exact: true }).click()
        await expect(rules.getByRole('alert')).toBeVisible()
      }
      const reread = page.waitForResponse(response => response.url().includes(`${PREVIEW_BROWSER.path}/policy`) && response.request().postDataJSON().kind === 'read')
      await rules.getByRole('button', { name: '重新读取网站规则', exact: true }).click()
      expect((await reread).status()).toBe(200)
      if (mode === 'failed') {
        await expect(rules.getByRole('alert')).toBeVisible()
        await expect(history.getByRole('alert')).toHaveText('浏览器操作失败，请重试。')
        const queried = page.waitForResponse(response => response.url().includes(`${PREVIEW_BROWSER.path}/history`) && response.request().postDataJSON().kind === 'query')
        await history.getByRole('searchbox', { name: '搜索标题或网址', exact: true }).fill('notes')
        expect((await queried).status()).toBe(200)
        await expect(history.getByRole('alert')).toHaveText('浏览器操作失败，请重试。')
      } else await expect(rules.getByTestId('browser-agent-site-list').locator('li')).toHaveCount(1)
    } else {
      await expect(rules.getByTestId('browser-agent-site-list').locator('li')).toHaveCount(1)
      await expect(history.getByTestId('browser-history-list').locator('li')).toHaveCount(20)
    }
    await rules.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`browser-${mode}-settled.png`) })
  })
}

for (const mode of ['pending', 'failed'] as const) {
  const sceneId = `settings-browser-write-${mode}`
  const states = mode === 'pending' ? ['saving', 'saved'] : ['error', 'retried', 'saved']
  test(`browser policy write ${mode} keeps state until a successful receipt`, { annotation: previewConsumption(PAGE_ID, sceneId, states) }, async ({ page }, testInfo) => {
    await openBrowser(page, sceneId)
    const rules = previewSurface(page).getByTestId(RULES)
    await expect(rules.getByTestId('browser-agent-site-list').locator('li')).toHaveCount(1)
    await rules.getByRole('textbox', { name: '精确网站来源地址', exact: true }).fill(ORIGIN)
    const add = rules.getByRole('button', { name: '添加规则', exact: true })
    const response = page.waitForResponse(reply => reply.url().includes(`${PREVIEW_BROWSER.path}/policy`) && reply.request().postDataJSON().kind === 'set')
    await add.click()
    if (mode === 'pending') {
      await expect(add).toBeDisabled()
      await expect(rules.getByRole('textbox', { name: '精确网站来源地址', exact: true })).toBeDisabled()
      await expect(rules.getByTestId('browser-agent-site-list').locator('li')).toHaveCount(1)
      await page.screenshot({ path: testInfo.outputPath('browser-policy-write-pending.png') })
    }
    const receipt = await (await response).json()
    expect(receipt.ok).toBe(mode !== 'failed')
    if (mode === 'failed') {
      await expect(rules.getByRole('alert')).toHaveText('此平台或数据位置不支持安全的 Agent 网站规则，无法保存或应用规则。')
      await page.screenshot({ path: testInfo.outputPath('browser-policy-write-error.png') })
      await rules.getByRole('button', { name: '重新读取网站规则', exact: true }).click()
      await expect(rules.getByTestId('browser-agent-site-list').locator('li')).toHaveCount(1)
      await expect(rules.getByRole('textbox', { name: '精确网站来源地址', exact: true })).toHaveValue(ORIGIN)
      await add.click()
    }
    await expect(rules.getByTestId('browser-agent-site-list').locator('li')).toHaveCount(2)
    await page.screenshot({ path: testInfo.outputPath('browser-policy-write-saved.png') })
  })
}
