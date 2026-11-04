import { openAccountSettings } from './fixtures/menu'
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { ONBOARDING_GROUPS } from '../src/onboarding'
import { DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const ARTIFACTS = resolve('../../tmp/test_snapshot/desktop/browser-policy')
const SITE_ORIGIN = 'https://example.org'

test('real Desktop manages Agent-only site rules in Browser settings', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const runtime = createRuntime(testInfo)
  const preferencesPath = join(runtime.userData, 'renderer-preferences.json')
  const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'))
  writeFileSync(preferencesPath, JSON.stringify({
    ...preferences,
    onboarding: { seen: Object.fromEntries(ONBOARDING_GROUPS.map(group => [group, true])) }
  }))
  const desktop = new DesktopSession(runtime, testInfo, { browserEnabled: true })
  await mkdir(ARTIFACTS, { recursive: true })
  try {
    const page = await desktop.launch()
    await openAccountSettings(page)
    await page.getByTestId('account-settings-nav-browser').click()
    const card = page.getByTestId('browser-settings-agent-sites')
    await expect(card).toBeVisible()
    await expect(card.getByText('这些规则仅用于 Agent 读取或操作网站，不影响手动浏览或网站设备权限；普通点击、输入和提交等操作仍按现有审批流程执行。')).toBeVisible()
    await expect(card.getByText('此平台或数据位置不支持安全的 Agent 网站规则，无法保存或应用规则。')).toHaveCount(0)
    const agentUse = card.getByRole('switch', { name: 'Agent Browser Use' })
    if (await agentUse.isChecked()) await agentUse.click()
    await expect(agentUse).not.toBeChecked()
    await expect(card.getByText('Agent Browser Use 已关闭，以下站点规则不会授权 Agent 读取网页。')).toBeVisible()
    await agentUse.click()
    await expect(agentUse).toBeChecked()
    const rows = card.getByTestId('browser-agent-site-list').getByRole('listitem')
    const initialCount = await rows.count()
    await card.getByRole('textbox', { name: '精确网站来源地址' }).fill(SITE_ORIGIN)
    await card.getByRole('button', { name: '添加规则' }).click()
    const site = rows.filter({ hasText: SITE_ORIGIN })
    await expect(site).toContainText(SITE_ORIGIN)
    await expect(site.getByRole('combobox', { name: `${SITE_ORIGIN} · 读取` })).toHaveText('允许')
    await site.scrollIntoViewIfNeeded()
    await writeFile(join(ARTIFACTS, 'agent-site-rule.png'), await page.screenshot())
    await agentUse.click()
    await expect(agentUse).not.toBeChecked()
    await expect(card.getByText('Agent Browser Use 已关闭，以下站点规则不会授权 Agent 读取网页。')).toBeVisible()
    await writeFile(join(ARTIFACTS, 'agent-browser-use-off.png'), await page.screenshot())
    await site.getByRole('button', { name: /移除/ }).click()
    await expect(site).toHaveCount(0)
    await expect(rows).toHaveCount(initialCount)
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
