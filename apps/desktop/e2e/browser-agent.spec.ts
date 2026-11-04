import { restoreBrowser } from './fixtures/browser'
import { openAccountSettings } from './fixtures/menu'
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { apiBase, DesktopSession, waitForFinishedTurn } from './fixtures/electron'
import { createRuntime, seedLiveConfig } from './fixtures/runtime'

const BROWSER_LIST_PROMPT = '请只调用一次 scholarseed_bridge 工具，capability 为 browser，operation 为 list，request 为空对象 {}，列出我在产品内打开的浏览器标签。不要用 shell、外部浏览器或其他工具代替。然后简短回复标签的站点。'
const PUBLIC_PAGE = 'https://www.iana.org/'

test('real Agent lists a page hosted inside the Desktop browser', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const blocker = seedLiveConfig(runtime)
  test.skip(Boolean(blocker), blocker ?? '')
  const desktop = new DesktopSession(runtime, testInfo, { browserEnabled: true, nativeWindowLifecycle: true })
  try {
    const launching = desktop.launch()
    await expect.poll(() => desktop.app?.windows().find(candidate => candidate.url().startsWith('http:'))?.url(), { timeout: 45_000 }).toBeTruthy()
    const startupPage = desktop.app!.windows().find(candidate => candidate.url().startsWith('http:'))!
    for (const name of ['先随便看看', '跳过']) {
      await startupPage.addLocatorHandler(startupPage.getByRole('button', { name, exact: true }), async button => { await button.click() })
    }
    const page = await launching
    await restoreBrowser(page)
    const address = page.getByRole('textbox', { name: '网址', exact: true })
    await address.fill(PUBLIC_PAGE)
    await address.press('Enter')
    await expect.poll(async () => {
      const result = await page.evaluate(() => window.scholarseed.browser.snapshot())
      return result.ok && result.snapshot.tabs.some(tab => tab.url.startsWith(PUBLIC_PAGE))
    }, { timeout: 45_000 }).toBe(true)
    await openAccountSettings(page)
    await page.getByTestId('account-settings-nav-browser').click()
    const agentUse = page.getByTestId('browser-settings-agent-sites').getByRole('switch', { name: 'Agent Browser Use' })
    await expect(agentUse).not.toBeChecked()
    await agentUse.click()
    await expect(agentUse).toBeChecked()
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByTestId('composer-input').fill(BROWSER_LIST_PROMPT)
    await expect(page.getByTestId('composer-send')).toBeEnabled({ timeout: 45_000 })
    await page.getByTestId('composer-send').click()
    const turn = await waitForFinishedTurn(page)
    expect(turn.activeSession).toBeTruthy()
    const python = process.platform === 'win32'
      ? resolve('../../.venv/Scripts/python.exe')
      : resolve('../../.venv/bin/python')
    const database = join(runtime.home, 'service', 'sessions.sqlite3')
    const count = Number(execFileSync(python, [
      '-c',
      'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(db.execute("SELECT count(*) FROM product_event WHERE kind = ?", ("browser_action",)).fetchone()[0])',
      database
    ], { encoding: 'utf8' }).trim())
    expect(count).toBe(1)
    const screen = await desktop.app!.evaluate(async ({ desktopCapturer }) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1600, height: 1000 } })
      return sources[0]?.thumbnail.toPNG().toString('base64')
    })
    expect(screen).toBeTruthy()
    await writeFile(join(runtime.artifacts, 'browser-agent-list.png'), Buffer.from(screen!, 'base64'))
    const history = await page.evaluate(async ({ base, sessionId }) => {
      const response = await fetch(`${base}/api/serve/history/${sessionId}`)
      return response.json()
    }, { base: await apiBase(page), sessionId: turn.activeSession })
    expect(JSON.stringify(history)).toContain('www.iana.org')
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
