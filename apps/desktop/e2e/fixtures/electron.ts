import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { delimiter, join, resolve } from 'path'
import { _electron as electron, expect, type ConsoleMessage, type ElectronApplication, type JSHandle, type Page, type TestInfo } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import type { RuntimePaths } from './runtime'
import { createProductAppRoot } from './application.cjs'

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')
const DESKTOP_ROOT = resolve(REPO_ROOT, 'apps', 'desktop')
const CODEX_CACHE_DIRECTORY = join(REPO_ROOT, 'tmp', 'e2e-codex')
const PYTHON = process.platform === 'win32'
  ? resolve(REPO_ROOT, '.venv', 'Scripts', 'python.exe')
  : resolve(REPO_ROOT, '.venv', 'bin', 'python')
const TEST_PYTHON_PATH = [
  resolve(REPO_ROOT, 'apps', 'serve'),
  resolve(REPO_ROOT, 'packages', 'runtime'),
  resolve(REPO_ROOT, 'packages', 'damoatrace'),
  resolve(REPO_ROOT, 'packages', 'adapters', 'codex'),
  process.env.PYTHONPATH
].filter((entry): entry is string => Boolean(entry)).join(delimiter)
const PRODUCT_SHELL_TEST_ID = 'workbench-shell'
const HOME_SPACE_TEST_ID = 'workbench-home-space'
const LANDING_DIALOG_TEST_ID = 'landing-dialog'
const LANDING_SKIP_TEST_ID = 'landing-skip'
const ONBOARDING_DISMISS_SELECTOR = '.ob-dismiss'
// 全局文献库不要求先选中项目，适合作为通用工作台夹具的初始视图。
const HOME_ESCAPE_ACTIVITY_TEST_ID = 'activity-literature'
const AI_PANEL_TEST_ID = 'ai-panel'
const AI_TOGGLE_TEST_ID = 'topbar-ai'
const PRODUCT_WINDOW_TIMEOUT_MS = 45_000
const STARTUP_WINDOW_URL_PREFIX = 'data:text/html'
const TURN_COMPLETE_TIMEOUT_MS = 180_000
const CLEANUP_MAX_RETRIES = 5
const CLEANUP_RETRY_DELAY_MS = 100
const applications = new WeakMap<Page, ElectronApplication>()

export async function productWindow(page: Page): Promise<JSHandle<Electron.BrowserWindow>> {
  const application = applications.get(page)
  if (!application) throw new Error('product window is not owned by this DesktopSession')
  return application.browserWindow(page)
}

/** Bind a custom-launched test window to its actual owning Electron application. */
export function registerProductWindow(page: Page, application: ElectronApplication): void {
  if (!application.windows().includes(page)) throw new Error('Product page is not owned by the application')
  applications.set(page, application)
}

/** Native menu eligibility requires a visible, focused product window. */
export async function showProductWindow(page: Page): Promise<void> {
  const application = applications.get(page)
  if (!application) throw new Error('product window is not owned by this DesktopSession')
  const handle = await application.browserWindow(page)
  await handle.evaluate(window => {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  await application.evaluate(({ app }) => app.focus({ steal: true }))
  await page.bringToFront()
}

export async function enterWorkbenchShell(page: Page): Promise<void> {
  await expect(page.getByTestId(PRODUCT_SHELL_TEST_ID)).toBeVisible({ timeout: PRODUCT_WINDOW_TIMEOUT_MS })
  const landing = page.getByTestId(LANDING_DIALOG_TEST_ID)
  if (await landing.isVisible().catch(() => false)) {
    await page.getByTestId(LANDING_SKIP_TEST_ID).click()
    await expect(landing).toHaveCount(0)
  }
  const onboardingDismiss = page.locator(ONBOARDING_DISMISS_SELECTOR).first()
  if (await onboardingDismiss.isVisible().catch(() => false)) {
    await onboardingDismiss.click()
  }
  if (await page.getByTestId(HOME_SPACE_TEST_ID).isVisible().catch(() => false)) {
    await page.getByTestId(HOME_ESCAPE_ACTIVITY_TEST_ID).click()
    await expect(page.getByTestId(HOME_SPACE_TEST_ID)).toHaveCount(0)
  }
  if (await onboardingDismiss.isVisible().catch(() => false)) {
    await onboardingDismiss.click()
  }
}

export interface LiveStatus {
  activeSession: string | null
  runtimeId: string | null
  running: boolean
  status: string | null
  conversationLength: number
  lastSeq: number
  runtimeReady: boolean
}

export interface DesktopSessionOptions {
  browserEnabled?: boolean
  preserveNavigation?: boolean
  preserveRuntime?: boolean
  nativeWindowLifecycle?: boolean
  homeFromPointer?: boolean
  /** Functional acceptance records by default; timing runs can omit tracing overhead. */
  recordTrace?: boolean
}

export class DesktopSession {
  app: ElectronApplication | null = null
  page: Page | null = null
  private readonly desktopLog: string
  private readonly rendererLog: string
  private readonly pageErrors: string[] = []
  private traceIndex = 0
  private processListeners: { process: ChildProcess; append: (chunk: Buffer) => void } | null = null
  private pageListeners: { page: Page; console: (message: ConsoleMessage) => void; error: (error: Error) => void } | null = null
  private lifecycleListeners: Array<() => void> = []

  constructor(
    readonly runtime: RuntimePaths,
    private readonly testInfo: TestInfo,
    private readonly options: DesktopSessionOptions = {}
  ) {
    this.desktopLog = join(runtime.artifacts, 'desktop.log')
    this.rendererLog = join(runtime.artifacts, 'renderer.log')
  }

  async browserWindow(page: Page): Promise<JSHandle<Electron.BrowserWindow>> {
    if (!this.app) throw new Error('Desktop application has not launched')
    const handle: JSHandle<Electron.BrowserWindow | null> = await this.app.browserWindow(page)
    try {
      if (!await handle.evaluate(nativeWindow => nativeWindow !== null)) {
        throw new Error('Product page does not have a native BrowserWindow')
      }
      return handle as JSHandle<Electron.BrowserWindow>
    } catch (error) {
      await handle.dispose()
      throw error
    }
  }

  async launch(): Promise<Page> {
    this.traceIndex += 1
    const appRoot = this.options.browserEnabled === undefined ? DESKTOP_ROOT
      : createProductAppRoot(this.runtime.artifacts, DESKTOP_ROOT, this.options.browserEnabled)
    this.app = await electron.launch({
      args: ['.', ...(this.options.nativeWindowLifecycle ? [] : ['--drive', this.runtime.drive]), `--user-data-dir=${this.runtime.userData}`],
      cwd: appRoot,
      env: Object.fromEntries(Object.entries({
        ...process.env,
        SCHOLARSEED_HOME: this.options.homeFromPointer ? undefined : this.runtime.home,
        DAMOAGENT_PROJECT_DIRNAME: '.scholarseed',
        SCHOLARSEED_DEFAULT_WORKSPACE: this.runtime.workspace,
        SCHOLARSEED_REPO: REPO_ROOT,
        SCHOLARSEED_PYTHON: PYTHON,
        SCHOLARSEED_CODEX_RUNTIME_CACHE: process.env.SCHOLARSEED_CODEX_RUNTIME_CACHE ?? CODEX_CACHE_DIRECTORY,
        SCHOLARSEED_LOG_LEVEL: 'debug',
        PYTHONPATH: TEST_PYTHON_PATH
      }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    })
    const launchedApp = this.app
    const proc = launchedApp.process()
    const appendDesktopLog = (chunk: Buffer) => appendFileSync(this.desktopLog, chunk)
    const recordLifecycle = (event: string, details: Record<string, unknown> = {}) => {
      appendFileSync(this.desktopLog, `[e2e-lifecycle] ${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`)
    }
    proc.stdout?.on('data', appendDesktopLog)
    proc.stderr?.on('data', appendDesktopLog)
    this.processListeners = { process: proc, append: appendDesktopLog }
    const onAppClose = () => recordLifecycle('app-close')
    const onProcessExit = (code: number | null, signal: NodeJS.Signals | null) => recordLifecycle('process-exit', { code, signal })
    const onProcessError = (error: Error) => recordLifecycle('process-error', { message: error.message })
    launchedApp.on('close', onAppClose)
    proc.on('exit', onProcessExit)
    proc.on('error', onProcessError)
    this.lifecycleListeners.push(() => launchedApp.off('close', onAppClose),
      () => proc.off('exit', onProcessExit), () => proc.off('error', onProcessError))
    recordLifecycle('app-launched', { pid: proc.pid })
    await expect.poll(
      () => this.app?.windows().find((candidate) => candidate.url().startsWith('http://'))?.url() ?? '',
      { timeout: PRODUCT_WINDOW_TIMEOUT_MS }
    ).not.toBe('')
    this.page = this.app.windows().find((candidate) => candidate.url().startsWith('http://')) ?? null
    if (!this.page) throw new Error('ScholarSeed product window did not open')
    applications.set(this.page, launchedApp)
    const selectedPage = this.page
    const onPageClose = () => recordLifecycle('page-close', { url: selectedPage.url() })
    const onPageCrash = () => recordLifecycle('page-crash', { url: selectedPage.url() })
    selectedPage.on('close', onPageClose)
    selectedPage.on('crash', onPageCrash)
    this.lifecycleListeners.push(() => selectedPage.off('close', onPageClose), () => selectedPage.off('crash', onPageCrash))
    recordLifecycle('page-selected', { url: selectedPage.url(), closed: selectedPage.isClosed() })
    const appendRendererLog = (message: ConsoleMessage) => {
      appendFileSync(this.rendererLog, `[${message.type()}] ${message.text()}\n`)
    }
    const appendPageError = (error: Error) => {
      this.pageErrors.push(error.message)
      appendFileSync(this.rendererLog, `[pageerror] ${error.stack ?? error.message}\n`)
    }
    this.page.on('console', appendRendererLog)
    this.page.on('pageerror', appendPageError)
    this.pageListeners = { page: this.page, console: appendRendererLog, error: appendPageError }
    if (this.options.nativeWindowLifecycle) {
      const window = await this.browserWindow(this.page)
      await expect.poll(() => window.evaluate((nativeWindow) => nativeWindow.isVisible()), {
        timeout: PRODUCT_WINDOW_TIMEOUT_MS
      }).toBe(true)
      // Tracing installs scripts in every page in the context. Wait for the
      // native startup surface to close before recording the product window.
      await expect.poll(() => this.app!.windows().filter((candidate) => (
        candidate.url().startsWith(STARTUP_WINDOW_URL_PREFIX)
      )).length, { timeout: PRODUCT_WINDOW_TIMEOUT_MS }).toBe(0)
    }
    if (this.options.recordTrace !== false) {
      try {
        await this.page.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
      } catch (error) {
        let windows: Array<{ url: string; closed: boolean }> | string
        try { windows = this.app.windows().map(candidate => ({ url: candidate.url(), closed: candidate.isClosed() })) }
        catch (windowError) { windows = String(windowError) }
        recordLifecycle('tracing-start-failed', {
          pageClosed: selectedPage.isClosed(), windows, processExitCode: proc.exitCode,
          processSignalCode: proc.signalCode, processKilled: proc.killed, error: String(error)
        })
        throw error
      }
    }
    await showProductWindow(this.page)
    if (this.options.preserveNavigation || await this.page.getByTestId('account-settings-shell').isVisible()) {
      await expect(this.page.getByTestId(PRODUCT_SHELL_TEST_ID)).toBeVisible({ timeout: PRODUCT_WINDOW_TIMEOUT_MS })
      return this.page
    }
    await enterWorkbenchShell(this.page)
    // Live suites exercise the conversation surface. The 0.2 workbench keeps that
    // surface in a user-toggleable panel, so enter it through the real product control.
    if (!await this.page.getByTestId(AI_PANEL_TEST_ID).isVisible().catch(() => false)) {
      await this.page.getByTestId(AI_TOGGLE_TEST_ID).click()
      await expect(this.page.getByTestId(AI_PANEL_TEST_ID)).toBeVisible()
    }
    return this.page
  }

  async close(): Promise<void> {
    const page = this.page
    const app = this.app
    this.page = null
    this.app = null
    if (!app) return
    const tracePath = join(this.runtime.artifacts, `trace-${this.traceIndex}.zip`)
    if (this.options.recordTrace !== false) {
      try {
        await page?.context().tracing.stop({ path: tracePath })
      } catch {
        // A crashed renderer is already captured by desktop/page-error logs.
      }
    }
    await app.close().catch(() => undefined)
    if (this.pageListeners?.page === page) {
      page.off('console', this.pageListeners.console)
      page.off('pageerror', this.pageListeners.error)
      this.pageListeners = null
    }
    if (this.processListeners) {
      this.processListeners.process.stdout?.off('data', this.processListeners.append)
      this.processListeners.process.stderr?.off('data', this.processListeners.append)
      this.processListeners = null
    }
    for (const removeListener of this.lifecycleListeners.splice(0)) removeListener()
  }

  async attachArtifacts(): Promise<void> {
    if (this.testInfo.status !== this.testInfo.expectedStatus && this.page) {
      await this.page.screenshot({ path: join(this.runtime.artifacts, 'failure.png'), fullPage: true }).catch(() => undefined)
    }
    await this.close()
    for (const [name, path, contentType] of [
      ['desktop-log', this.desktopLog, 'text/plain'],
      ['renderer-log', this.rendererLog, 'text/plain'],
      // home 在短根下（见 fixtures/runtime.ts），不在 test-results 里；serve 的启动
      // 失败只写在它的 backend.log，不附上来失败时就只剩窗口超时这一个表象。
      ['backend-log', join(this.runtime.home, 'logs', 'backend.log'), 'text/plain']
    ] as const) {
      if (existsSync(path)) await this.testInfo.attach(name, { body: readFileSync(path), contentType })
    }
    const tracePath = join(this.runtime.artifacts, `trace-${this.traceIndex}.zip`)
    if (existsSync(tracePath)) await this.testInfo.attach('playwright-trace', { path: tracePath })
    if (!this.options.preserveRuntime) {
      rmSync(this.runtime.home, {
        recursive: true,
        force: true,
        maxRetries: CLEANUP_MAX_RETRIES,
        retryDelay: CLEANUP_RETRY_DELAY_MS
      })
    }
  }

  assertNoPageErrors(): void {
    expect(this.pageErrors, this.pageErrors.join('\n')).toEqual([])
  }
}

export async function apiBase(page: Page): Promise<string> {
  return page.evaluate(() => (
    window as typeof window & { scholarseed: { getApiBase(): string } }
  ).scholarseed.getApiBase())
}

export async function liveStatus(page: Page): Promise<LiveStatus | null> {
  return page.evaluate(() => (
    window as typeof window & { __scholarseedLiveTurnStatus?: () => LiveStatus }
  ).__scholarseedLiveTurnStatus?.() ?? null)
}

export async function waitForFinishedTurn(page: Page, afterSeq = -1): Promise<LiveStatus> {
  await expect.poll(async () => {
    const status = await liveStatus(page)
    return Boolean(
      status?.activeSession &&
      !status.running &&
      status.conversationLength >= 2 &&
      (afterSeq < 0 || status.lastSeq > afterSeq)
    )
  }, { timeout: TURN_COMPLETE_TIMEOUT_MS }).toBe(true)
  return (await liveStatus(page)) as LiveStatus
}
