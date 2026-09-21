import { appendFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { delimiter, join, resolve } from 'path'
import { _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import type { RuntimePaths } from './runtime'

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')
const DESKTOP_ROOT = resolve(REPO_ROOT, 'apps', 'desktop')
const PYTHON = resolve(REPO_ROOT, '.venv', 'bin', 'python')
const TEST_PYTHON_PATH = [
  resolve(REPO_ROOT, 'apps', 'serve'),
  resolve(REPO_ROOT, 'packages', 'runtime'),
  resolve(REPO_ROOT, 'packages', 'damoatrace'),
  resolve(REPO_ROOT, 'packages', 'adapters', 'codex'),
  process.env.PYTHONPATH
].filter((entry): entry is string => Boolean(entry)).join(delimiter)
const PRODUCT_SHELL_TEST_ID = 'workbench-shell'
const HOME_SPACE_TEST_ID = 'workbench-home-space'
// 离开首页空间用的活动栏入口。挑文献库是因为它不要求先选中项目 —— 而顶栏的项目切换
// 恰恰要在离开首页之后才存在, 用一个需要项目的入口会形成死循环。
const HOME_ESCAPE_ACTIVITY_TEST_ID = 'activity-literature'
const AI_PANEL_TEST_ID = 'ai-panel'
const AI_TOGGLE_TEST_ID = 'topbar-ai'
const PRODUCT_WINDOW_TIMEOUT_MS = 45_000
const TURN_COMPLETE_TIMEOUT_MS = 180_000
const CLEANUP_MAX_RETRIES = 5
const CLEANUP_RETRY_DELAY_MS = 100

/**
 * 等工作台外壳挂载, 并保证当前不在首页空间。
 *
 * 首页空间是全局面, 刻意不挂顶栏 / 标签 / 模块面板（`WorkbenchShell` 只在
 * `mainView !== 'home'` 时挂 `TopBar`）, 而 `mainView` 的初值就是 `'home'` ——
 * 于是**每次 `page.reload()` 都会退回首页, 顶栏随之消失**。用例在 reload 之后
 * 直接点 `topbar-*` 只会等到超时。凡是重新加载过页面的用例都要再走一遍这一步;
 * 已经离开首页时它是空操作。
 */
export async function enterWorkbenchShell(page: Page): Promise<void> {
  await expect(page.getByTestId(PRODUCT_SHELL_TEST_ID)).toBeVisible()
  if (await page.getByTestId(HOME_SPACE_TEST_ID).isVisible().catch(() => false)) {
    await page.getByTestId(HOME_ESCAPE_ACTIVITY_TEST_ID).click()
    await expect(page.getByTestId(HOME_SPACE_TEST_ID)).toHaveCount(0)
  }
}

export interface LiveStatus {
  activeSession: string | null
  runtimeId: string | null
  running: boolean
  status: string | null
  conversationLength: number
  runtimeReady: boolean
}

export interface DesktopSessionOptions {
  preserveRuntime?: boolean
}

export class DesktopSession {
  app: ElectronApplication | null = null
  page: Page | null = null
  private readonly desktopLog: string
  private readonly rendererLog: string
  private readonly pageErrors: string[] = []
  private traceIndex = 0

  constructor(
    readonly runtime: RuntimePaths,
    private readonly testInfo: TestInfo,
    private readonly options: DesktopSessionOptions = {}
  ) {
    this.desktopLog = join(runtime.artifacts, 'desktop.log')
    this.rendererLog = join(runtime.artifacts, 'renderer.log')
  }

  async launch(): Promise<Page> {
    this.traceIndex += 1
    this.app = await electron.launch({
      args: ['.', '--drive', this.runtime.drive, `--user-data-dir=${this.runtime.userData}`],
      cwd: DESKTOP_ROOT,
      env: {
        ...process.env,
        SCHOLARSEED_HOME: this.runtime.home,
        DAMOAGENT_PROJECT_DIRNAME: '.scholarseed',
        SCHOLARSEED_DEFAULT_WORKSPACE: this.runtime.workspace,
        SCHOLARSEED_REPO: REPO_ROOT,
        SCHOLARSEED_PYTHON: PYTHON,
        SCHOLARSEED_LOG_LEVEL: 'debug',
        PYTHONPATH: TEST_PYTHON_PATH
      }
    })
    const proc = this.app.process()
    proc.stdout?.on('data', (chunk) => appendFileSync(this.desktopLog, chunk))
    proc.stderr?.on('data', (chunk) => appendFileSync(this.desktopLog, chunk))
    await expect.poll(
      () => this.app?.windows().find((candidate) => candidate.url().startsWith('http://'))?.url() ?? '',
      { timeout: PRODUCT_WINDOW_TIMEOUT_MS }
    ).not.toBe('')
    this.page = this.app.windows().find((candidate) => candidate.url().startsWith('http://')) ?? null
    if (!this.page) throw new Error('ScholarSeed product window did not open')
    this.page.on('console', (message) => {
      appendFileSync(this.rendererLog, `[${message.type()}] ${message.text()}\n`)
    })
    this.page.on('pageerror', (error) => {
      this.pageErrors.push(error.message)
      appendFileSync(this.rendererLog, `[pageerror] ${error.stack ?? error.message}\n`)
    })
    await this.page.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
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
    try {
      await page?.context().tracing.stop({ path: tracePath })
    } catch {
      // A crashed renderer is already captured by desktop/page-error logs.
    }
    await app.close().catch(() => undefined)
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
  return page.evaluate(() => window.scholarseed.getApiBase())
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
