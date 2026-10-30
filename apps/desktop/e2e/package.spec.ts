import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { apiBase, enterWorkbenchShell, liveStatus, waitForFinishedTurn } from './fixtures/electron'
import { createInstallRoot, installFromArtifact } from './fixtures/installer'
import { seedLiveConfig, withIsolatedRuntime, type RuntimePaths } from './fixtures/runtime'

const PROJECT_NAME = 'CI 安装包项目'
const DOCUMENT_NAME = '安装包走查记录'
const MODEL_PROMPT = '请用一句话确认已经收到安装包端到端测试消息。'
const WINDOW_TIMEOUT_MS = 60_000
const MODEL_TIMEOUT_MS = 180_000
const CLOSE_TIMEOUT_MS = 30_000

async function stopInstalled(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close', { timeout: CLOSE_TIMEOUT_MS })
  await app.evaluate(({ app: electronApp }) => { setImmediate(() => electronApp.quit()) })
  await closed
}

async function startInstalled(executable: string, runtime: RuntimePaths): Promise<{ app: ElectronApplication; page: Page }> {
  const appData = join(runtime.home, 'AppData', 'Roaming')
  const localAppData = join(runtime.home, 'AppData', 'Local')
  if (process.platform === 'win32') {
    mkdirSync(appData, { recursive: true })
    mkdirSync(localAppData, { recursive: true })
  }
  const env: NodeJS.ProcessEnv = { ...process.env, SCHOLARSEED_HOME: runtime.home,
    SCHOLARSEED_DEFAULT_WORKSPACE: runtime.workspace, HOME: runtime.home,
    USERPROFILE: runtime.home, APPDATA: appData, LOCALAPPDATA: localAppData }
  for (const name of ['SCHOLARSEED_PYTHON', 'SCHOLARSEED_REPO', 'SCHOLARSEED_SERVE_URL',
    'PYTHONPATH', 'SCHOLARSEED_CODEX_HOME', 'DAMOATRACE_HOME', 'DAMOATRACE_LEDGER_ROOT']) {
    delete env[name]
  }
  const app = await electron.launch({ executablePath: executable,
    args: [`--user-data-dir=${runtime.userData}`], cwd: runtime.workspace,
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] =>
      typeof entry[1] === 'string')) })
  expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true)
  await expect.poll(() => app.windows().find(candidate => candidate.url().startsWith('http://'))?.url() ?? '',
    { timeout: WINDOW_TIMEOUT_MS }).not.toBe('')
  const page = app.windows().find(candidate => candidate.url().startsWith('http://'))
  if (!page) throw new Error('installed application did not open a product window')
  await enterWorkbenchShell(page)
  return { app, page }
}

test('installed package creates a project and document, completes a real model turn, and restarts', async ({}, testInfo) => {
  const installer = process.env.SCHOLARSEED_CI_INSTALLER
  const expectedSha256 = process.env.SCHOLARSEED_CI_INSTALLER_SHA256
  expect(installer, 'ci:package must provide this run installer').toBeTruthy()
  expect(expectedSha256, 'ci:package must provide this run installer SHA-256').toMatch(/^[a-f0-9]{64}$/)
  await withIsolatedRuntime(testInfo, async runtime => {
    const blocker = seedLiveConfig(runtime)
    expect(blocker, blocker || '').toBeNull()
    writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
      language: 'zh', onboarding: { seen: { home: true, project: true, globalLib: true, pdf: true } }
    }))
    const installRoot = createInstallRoot()
    let app: ElectronApplication | null = null
    let installed: ReturnType<typeof installFromArtifact> | null = null
    try {
      installed = installFromArtifact(installer!, installRoot, expectedSha256!)
      let session = await startInstalled(installed.executable, runtime)
      app = session.app
      const page = session.page
      await page.getByTestId('topbar-project').click()
      await page.getByTestId('project-menu-create').click()
      const dialog = page.getByTestId('project-new-modal')
      await dialog.getByRole('textbox').fill(PROJECT_NAME)
      await dialog.getByTestId('project-create').click()
      await expect(dialog).toHaveCount(0)
      const base = await apiBase(page)
      const response = await page.request.get(`${base}/api/content/projects`)
      expect(response.ok()).toBe(true)
      const projects = await response.json() as { projects: Array<{ name: string; root: string }> }
      const project = projects.projects.find(item => item.name === PROJECT_NAME)
      expect(project).toBeTruthy()
      await page.getByTestId('topbar-project').click()
      await page.getByTestId(`project-menu-option-${PROJECT_NAME}`).click()
      if (!await page.getByTestId('resource-panel').isVisible().catch(() => false)) {
        await page.getByTestId('activity-resource').click()
      }
      await page.getByTestId('resource-add').click()
      await page.getByTestId('resource-new-doc').click()
      await page.getByTestId('resource-name-input').fill(DOCUMENT_NAME)
      await page.getByTestId('resource-name-input').press('Enter')
      const documentPath = join(project!.root, 'resources', `${DOCUMENT_NAME}.md`)
      await expect.poll(() => existsSync(documentPath)).toBe(true)
      expect(readFileSync(documentPath, 'utf8')).toContain(DOCUMENT_NAME)

      if (!await page.getByTestId('ai-panel').isVisible().catch(() => false)) {
        await page.getByTestId('topbar-ai').click()
      }
      await expect(page.getByTestId('ai-panel')).toBeVisible()
      await expect.poll(async () => (await liveStatus(page))?.runtimeReady, { timeout: WINDOW_TIMEOUT_MS }).toBe(true)
      await page.getByTestId('composer-input').fill(MODEL_PROMPT)
      await page.getByTestId('composer-send').click()
      const turn = await waitForFinishedTurn(page)
      expect(turn.activeSession).toBeTruthy()
      expect(turn.status).toBe('done')
      await page.screenshot({ path: testInfo.outputPath('installed-main-flow.png') })

      await stopInstalled(app)
      app = null
      session = await startInstalled(installed.executable, runtime)
      app = session.app
      const restarted = session.page
      await restarted.getByTestId('topbar-project').click()
      await expect(restarted.getByTestId(`project-menu-option-${PROJECT_NAME}`)).toBeVisible()
      expect(readFileSync(documentPath, 'utf8')).toContain(DOCUMENT_NAME)
      if (!await restarted.getByTestId('ai-panel').isVisible().catch(() => false)) {
        await restarted.getByTestId('topbar-ai').click()
      }
      await expect.poll(async () => (await liveStatus(restarted))?.runtimeReady,
        { timeout: MODEL_TIMEOUT_MS }).toBe(true)
      await restarted.getByTestId('ai-session-toggle').click()
      await expect(restarted.getByTestId(`ai-session-${turn.activeSession}`)).toBeVisible()
      await restarted.getByTestId(`ai-session-${turn.activeSession}`).click()
      await expect.poll(async () => (await liveStatus(restarted))?.activeSession,
        { timeout: MODEL_TIMEOUT_MS }).toBe(turn.activeSession)
      await restarted.screenshot({ path: testInfo.outputPath('installed-restart.png') })
    } finally {
      if (app) await stopInstalled(app).catch(() => undefined)
      installed?.cleanup()
      rmSync(installRoot, { recursive: true, force: true })
    }
  })
})
