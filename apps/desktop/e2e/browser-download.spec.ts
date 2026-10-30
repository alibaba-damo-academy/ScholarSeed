import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const HOME_URL = 'https://httpbingo.org/'
const HOME_ORIGIN = new URL(HOME_URL).origin
const DOWNLOAD_URL = 'https://httpbingo.org/bytes/4096?seed=0'
const DOWNLOAD_FILENAME = '4096'
const DOWNLOAD_BYTES = 4096
const ARTIFACTS = resolve('../../tmp/test_snapshot/desktop/browser-download')
const NATIVE_CHOOSER_E2E_ENV = 'SCHOLARSEED_NATIVE_CHOOSER_E2E'
const APPLE_SCRIPT_TIMEOUT_MS = 10_000

const runAppleScript = (...lines: string[]) => execFileSync('osascript', lines.flatMap(line => ['-e', line]), { timeout: APPLE_SCRIPT_TIMEOUT_MS })

test('real Desktop asks where to save an embedded browser download', async ({}, testInfo) => {
  test.skip(process.platform !== 'darwin', 'native Save As dialog acceptance needs the target OS')
  test.setTimeout(120_000)
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo, { browserEnabled: true, nativeWindowLifecycle: true })
  await mkdir(ARTIFACTS, { recursive: true })
  try {
    const launching = desktop.launch()
    await expect.poll(() => desktop.app?.windows().find(candidate => candidate.url().startsWith('http:'))?.url(), { timeout: 45_000 }).toBeTruthy()
    const startupPage = desktop.app!.windows().find(candidate => candidate.url().startsWith('http:'))!
    for (const name of ['先随便看看', '跳过']) {
      await startupPage.addLocatorHandler(startupPage.getByRole('button', { name, exact: true }), async button => { await button.click() })
    }
    const page = await launching
    await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByTestId('activity-browser').click()
    const address = page.getByRole('textbox', { name: '网址', exact: true })
    await address.fill(HOME_URL)
    await address.press('Enter')
    await expect.poll(async () => {
      const reply = await page.evaluate(() => window.scholarseed.browser.snapshot())
      return reply.ok ? reply.snapshot.tabs.find(tab => tab.tabId === reply.snapshot.activeTabId)?.url : null
    }, { timeout: 30_000 }).toBe(HOME_URL)
    await expect(page.getByTestId('browser-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 45_000 })
    await expect.poll(async () => desktop.app!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().startsWith('http:'))!
      const view = window.contentView.children.find(child => 'webContents' in child) as Electron.WebContentsView
      return view.webContents.executeJavaScript('location.origin')
    }), { timeout: 30_000 }).toBe(HOME_ORIGIN)
    await desktop.app!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().startsWith('http:'))!
      const view = window.contentView.children.find(child => 'webContents' in child) as Electron.WebContentsView
      const state = { filename: '', url: '', chain: [] as string[], result: '' }
      ;(globalThis as typeof globalThis & { __browserDownloadProbe?: typeof state }).__browserDownloadProbe = state
      view.webContents.session.once('will-download', (_event, item) => {
        state.filename = item.getFilename()
        state.url = item.getURL()
        state.chain = item.getURLChain()
        item.once('done', (_done, result) => { state.result = result })
      })
    })
    await address.fill(DOWNLOAD_URL)
    await address.press('Enter')
    const probe = () => desktop.app!.evaluate(() => (globalThis as typeof globalThis & { __browserDownloadProbe?: { filename: string; url: string; chain: string[]; result: string } }).__browserDownloadProbe)
    await expect.poll(async () => (await probe())?.filename, { timeout: 30_000 }).toBe(DOWNLOAD_FILENAME)
    const screenshot = await desktop.app!.evaluate(async ({ desktopCapturer }) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1600, height: 1000 } })
      return sources[0]?.thumbnail.toPNG().toString('base64')
    })
    expect(screenshot).toBeTruthy()
    await writeFile(join(ARTIFACTS, 'save-as-dialog.png'), Buffer.from(screenshot!, 'base64'))
    const electronPid = desktop.app!.process().pid
    expect(electronPid).toBeTruthy()
    runAppleScript('tell application "System Events"',
      `click button "取消" of sheet 1 of window 1 of (first process whose unix id is ${electronPid})`,
      'end tell')
    await expect.poll(async () => (await probe())?.result, { timeout: 10_000 }).toBe('cancelled')
    await writeFile(join(ARTIFACTS, 'download-probe.json'), JSON.stringify(await probe(), null, 2))
    await expect(page.getByText('网页加载失败，请检查网址或重试。')).toHaveCount(0)
    await expect(address).toHaveValue(HOME_URL)
    const afterCancel = await desktop.app!.evaluate(async ({ desktopCapturer }) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1600, height: 1000 } })
      return sources[0]?.thumbnail.toPNG().toString('base64')
    })
    expect(afterCancel).toBeTruthy()
    await writeFile(join(ARTIFACTS, 'after-cancel.png'), Buffer.from(afterCancel!, 'base64'))
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('real Desktop chooser persists a custom browser download directory across restart', async ({}, testInfo) => {
  test.skip(process.platform !== 'darwin', 'native folder chooser acceptance needs the target OS')
  test.skip(process.env[NATIVE_CHOOSER_E2E_ENV] !== '1', 'native folder chooser acceptance requires an unlocked macOS desktop without system prompts')
  test.setTimeout(120_000)
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, { browserEnabled: true, nativeWindowLifecycle: true, preserveRuntime: true })
  const directory = mkdtempSync(join(homedir(), '.codex', 'browser-dl-ui-'))
  await mkdir(ARTIFACTS, { recursive: true })
  const openSettings = async () => {
    const launching = desktop.launch()
    await expect.poll(() => desktop.app?.windows().find(candidate => candidate.url().startsWith('http:'))?.url(), { timeout: 45_000 }).toBeTruthy()
    const startupPage = desktop.app!.windows().find(candidate => candidate.url().startsWith('http:'))!
    for (const name of ['先随便看看', '跳过']) {
      await startupPage.addLocatorHandler(startupPage.getByRole('button', { name, exact: true }), async button => { await button.click() })
    }
    const page = await launching
    await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByTestId('activity-account').click()
    await page.getByTestId('account-menu-settings').click()
    await page.getByTestId('account-settings-nav-browser').click()
    return page
  }
  try {
    const page = await openSettings()
    const downloads = page.getByTestId('browser-settings-downloads')
    await downloads.getByRole('button', { name: '选择下载文件夹' }).click()
    const captureScreen = async (name: string) => {
      const screenshot = await desktop.app!.evaluate(async ({ desktopCapturer }) => {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1600, height: 1000 } })
        return sources[0]?.thumbnail.toPNG().toString('base64') ?? null
      })
      if (screenshot) await writeFile(join(ARTIFACTS, name), Buffer.from(screenshot, 'base64'))
    }
    await captureScreen('chooser-before-keys.png')
    await writeFile(join(ARTIFACTS, 'chooser-frontmost.txt'), runAppleScript('tell application "System Events" to get name of first process whose frontmost is true'))
    const electronPid = desktop.app!.process().pid
    expect(electronPid).toBeTruthy()
    const electronProcess = `(first process whose unix id is ${electronPid})`
    const sendChooserKey = (keyCommand: string, delaySeconds: number) => runAppleScript(
      `delay ${delaySeconds}`, 'tell application "System Events"',
      `if unix id of (first process whose frontmost is true) is not ${electronPid} then error "target Electron lost focus"`,
      `if not (exists button "打开" of sheet 1 of window 1 of ${electronProcess}) then error "target folder chooser is absent"`,
      keyCommand, 'end tell')
    runAppleScript(`tell application "System Events" to set frontmost of ${electronProcess} to true`)
    sendChooserKey('keystroke "g" using {command down, shift down}', 1)
    sendChooserKey(`keystroke ${JSON.stringify(directory)}`, 0.3)
    sendChooserKey('key code 36', 1.5)
    sendChooserKey('key code 36', 0.5)
    await captureScreen('chooser-after-keys.png')
    runAppleScript(`tell application "System Events" to tell ${electronProcess} to click button "打开" of sheet 1 of window 1`)
    try { await expect(downloads.getByTestId('browser-download-directory')).toHaveText(directory, { timeout: 15_000 }) }
    catch (error) { await captureScreen('chooser-timeout.png'); throw error }
    await writeFile(join(ARTIFACTS, 'chosen-directory.png'), await page.screenshot())
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭', exact: true }).click()
    await desktop.close()
    const restarted = await openSettings()
    await expect(restarted.getByTestId('browser-download-directory')).toHaveText(directory)
    await writeFile(join(ARTIFACTS, 'chosen-directory-restarted.png'), await restarted.screenshot())
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
    await rm(directory, { recursive: true, force: true })
    await rm(runtime.home, { recursive: true, force: true })
  }
})

test('real Desktop automatically saves without overwriting an earlier download', async ({}, testInfo) => {
  test.skip(process.platform !== 'darwin', 'safe automatic publication is currently available only on macOS')
  test.setTimeout(120_000)
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, { browserEnabled: true, nativeWindowLifecycle: true })
  const directory = mkdtempSync(join(homedir(), '.codex', 'browser-dl-'))
  await mkdir(ARTIFACTS, { recursive: true })
  await mkdir(join(runtime.home, 'browser'), { recursive: true })
  await writeFile(join(runtime.home, 'browser', 'downloads.json'), JSON.stringify({ directoryOverride: directory, askEveryTime: false }))
  try {
    const launching = desktop.launch()
    await expect.poll(() => desktop.app?.windows().find(candidate => candidate.url().startsWith('http:'))?.url(), { timeout: 45_000 }).toBeTruthy()
    const startupPage = desktop.app!.windows().find(candidate => candidate.url().startsWith('http:'))!
    for (const name of ['先随便看看', '跳过']) {
      await startupPage.addLocatorHandler(startupPage.getByRole('button', { name, exact: true }), async button => { await button.click() })
    }
    const page = await launching
    await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByTestId('activity-account').click()
    await page.getByTestId('account-menu-settings').click()
    await page.getByTestId('account-settings-nav-browser').click()
    const downloads = page.getByTestId('browser-settings-downloads')
    await expect(downloads.getByTestId('browser-download-directory')).toHaveText(directory)
    await expect(downloads.getByRole('switch', { name: '每次下载时询问保存位置' })).not.toBeChecked()
    await writeFile(join(ARTIFACTS, 'automatic-settings.png'), await page.screenshot())
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByTestId('activity-browser').click()
    const address = page.getByRole('textbox', { name: '网址', exact: true })
    await address.fill(HOME_URL)
    await address.press('Enter')
    await expect.poll(async () => {
      const reply = await page.evaluate(() => window.scholarseed.browser.snapshot())
      return reply.ok ? reply.snapshot.tabs.find(tab => tab.tabId === reply.snapshot.activeTabId)?.url : null
    }, { timeout: 30_000 }).toBe(HOME_URL)
    await expect(page.getByTestId('browser-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 45_000 })
    await expect.poll(async () => desktop.app!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().startsWith('http:'))!
      const view = window.contentView.children.find(child => 'webContents' in child) as Electron.WebContentsView
      return view.webContents.executeJavaScript('location.origin')
    }), { timeout: 30_000 }).toBe(HOME_ORIGIN)
    const firstPath = join(directory, DOWNLOAD_FILENAME)
    const secondPath = join(directory, `${DOWNLOAD_FILENAME} (1)`)
    await desktop.app!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().startsWith('http:'))!
      const view = window.contentView.children.find(child => 'webContents' in child) as Electron.WebContentsView
      const state = { filename: '', savePath: '', result: '' }
      ;(globalThis as typeof globalThis & { __browserAutoDownloadProbe?: typeof state }).__browserAutoDownloadProbe = state
      view.webContents.session.once('will-download', (_event, item) => {
        state.filename = item.getFilename()
        state.savePath = item.getSavePath()
        item.once('done', (_done, result) => { state.result = result })
      })
    })
    const probe = () => desktop.app!.evaluate(() => (globalThis as typeof globalThis & { __browserAutoDownloadProbe?: { filename: string; savePath: string; result: string } }).__browserAutoDownloadProbe)
    for (const target of [firstPath, secondPath]) {
      await address.fill(DOWNLOAD_URL)
      await address.press('Enter')
      await expect.poll(async () => (await probe())?.result, { timeout: 30_000 }).toBe('completed')
      await writeFile(join(ARTIFACTS, 'automatic-probe.json'), JSON.stringify(await probe(), null, 2))
      try { await expect.poll(async () => (await readFile(target).catch(() => Buffer.alloc(0))).byteLength, { timeout: 30_000 }).toBe(DOWNLOAD_BYTES) }
      catch (error) {
        await writeFile(join(ARTIFACTS, 'automatic-failure.json'), JSON.stringify({ directory, files: await readdir(directory), probe: await probe(), snapshot: await page.evaluate(() => window.scholarseed.browser.snapshot()) }, null, 2))
        throw error
      }
      await expect(address).toHaveValue(HOME_URL)
    }
    const first = await readFile(firstPath)
    const second = await readFile(secondPath)
    expect(first.equals(Buffer.alloc(DOWNLOAD_BYTES))).toBe(false)
    expect(second.equals(first)).toBe(true)
    const blobPath = join(directory, 'scholarseed-blob.txt')
    await desktop.app!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().startsWith('http:'))!
      const view = window.contentView.children.find(child => 'webContents' in child) as Electron.WebContentsView
      const state = { chain: [] as string[], result: '' }
      ;(globalThis as typeof globalThis & { __browserBlobProbe?: typeof state }).__browserBlobProbe = state
      view.webContents.session.once('will-download', (_event, item) => {
        state.chain = item.getURLChain()
        item.once('done', (_done, result) => { state.result = result })
      })
      return view.webContents.executeJavaScript(`(() => {
        const url = URL.createObjectURL(new Blob(['ScholarSeed blob download'], { type: 'text/plain' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'scholarseed-blob.txt';
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      })()`)
    })
    await expect.poll(() => desktop.app!.evaluate(() => (globalThis as typeof globalThis & { __browserBlobProbe?: { chain: string[]; result: string } }).__browserBlobProbe?.result)).toBe('completed')
    await expect.poll(async () => (await readFile(blobPath).catch(() => Buffer.alloc(0))).toString('utf8'), { timeout: 30_000 }).toBe('ScholarSeed blob download')
    const completedBlob = await desktop.app!.evaluate(() => {
      const state = (globalThis as typeof globalThis & { __browserBlobProbe?: { chain: string[]; result: string } }).__browserBlobProbe
      return state ?? null
    })
    expect(completedBlob?.chain).toHaveLength(1)
    expect(completedBlob?.chain[0]).toMatch(/^blob:https:\/\/httpbingo\.org\//)
    expect(completedBlob?.result).toBe('completed')
    await writeFile(join(ARTIFACTS, 'blob-probe.json'), JSON.stringify(completedBlob, null, 2))
    const resultScreenshot = await desktop.app!.evaluate(async ({ desktopCapturer }) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1600, height: 1000 } })
      return sources[0]?.thumbnail.toPNG().toString('base64')
    })
    expect(resultScreenshot).toBeTruthy()
    await writeFile(join(ARTIFACTS, 'automatic-result.png'), Buffer.from(resultScreenshot!, 'base64'))
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts(); await rm(directory, { recursive: true, force: true }) }
})
