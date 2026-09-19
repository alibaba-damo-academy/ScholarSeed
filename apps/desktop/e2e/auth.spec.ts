import { readdirSync } from 'fs'
import { join } from 'path'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { DesktopSession, enterWorkbenchShell } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import {
  adoptSeededAuth,
  mockAccountApi,
  seedAuthTokens,
  type MockAccountConfig
} from './fixtures/builders/auth'

// auth.spec.ts — 账号双态验收：未登录（登录是可选增强，外壳照常可用）与已登录
// （身份 / 积分 / 登出回到未登录）。渲染层的账号取数用 page.route mock
// （fixtures/builders/auth.ts）；凭据播种走生产 IPC（veda:auth-token-set →
// safeStorage 加密 refresh + httpOnly cookie），不改任何生产代码。
//
// 注意：DesktopSession 以 --drive 启动（headless），主进程的首页认领闸
// （scholarseed:landing-claim = !headless && !landingResolved）恒关，所以冷启动
// Landing 不会自动弹出 —— 未登录态的 Landing 经真实产品入口（账户菜单「立即登录」
// → AccountLogin → Landing layer 变体）打开，这正是「登录不是门禁」设计下用户的
// 主要登录路径。该变体带 autoStart（挂载即发起浏览器登录），发起腿被
// pinLoginStartUnavailable 钉住，避免真开系统浏览器（见该函数注释）。

const WORKBENCH_SHELL_TEST_ID = 'workbench-shell'
const HOME_SPACE_TEST_ID = 'workbench-home-space'
const AI_PANEL_TEST_ID = 'ai-panel'
const COMPOSER_INPUT_TEST_ID = 'composer-input'
const COMPOSER_SEND_TEST_ID = 'composer-send'
const ACTIVITY_ACCOUNT_TEST_ID = 'activity-account'
const ACCOUNT_MENU_TEST_ID = 'account-menu'
const ACCOUNT_LOGIN_TEST_ID = 'account-login'
const MENU_ANONYMOUS_LOGIN_TEST_ID = 'account-menu-anonymous-login'
const MENU_NAME_TEST_ID = 'account-menu-name'
const MENU_CREDITS_TEST_ID = 'account-menu-credits'
const MENU_CREDITS_VALUE_TEST_ID = 'account-menu-credits-value'
const MENU_LOGOUT_TEST_ID = 'account-menu-logout'

// zh 界面文案（fixtures/runtime.ts 把隔离 userData 的语言固定为 zh）。
const LANDING_ARIA_LABEL = '未登录首页'
const LOGIN_BUTTON_LABEL = '登录/注册'
const SKIP_BUTTON_LABEL = '暂不登录，使用API Key'
const ANONYMOUS_LOGIN_LABEL = '立即登录'
const DEFAULT_DISPLAY_NAME = '书深用户'

/** 登录发起腿的 IPC 通道（src/main/index.ts 注册、preload 转发）。 */
const DESKTOP_LOGIN_START_CHANNEL = 'scholarseed:desktop-login-start'
const ACCOUNT_BASE_UNAVAILABLE = 'account_base_unavailable'

/** 主进程腿账号地址的环境变量名（src/main/backend.ts 与 serve 同源）。 */
const ACCOUNT_BASE_ENV = 'SCHOLARSEED_ACCOUNT_BASE_URL'
/**
 * 不可达 loopback（discard 端口）：把主进程腿（续期 / 整族吊销 / 交接）的 best-effort
 * 外呼钉在本地 fail-closed（连接拒绝 → 一条 WARN），绝不触达 product.json 里
 * 的真实账号服务。渲染层取数走 page.route，不读这个地址。
 */
const UNREACHABLE_ACCOUNT_BASE = 'http://127.0.0.1:9'

/** 与 src/main/auth-refresh.ts 的 REFRESH_FILE_PREFIX/SUFFIX 对齐（不 import 主进程模块）。 */
const REFRESH_FILE_PREFIX = 'auth-refresh'
const REFRESH_FILE_SUFFIX = 'enc'

const avatarLabel = (name: string): string => `${name} 的头像`

async function openAccountMenu(page: Page): Promise<void> {
  await page.getByTestId(ACTIVITY_ACCOUNT_TEST_ID).click()
  await expect(page.getByTestId(ACCOUNT_MENU_TEST_ID)).toBeVisible()
}

/**
 * 钉住登录发起腿：product.json 在所有环境都带真实账号服务地址，AccountLogin 的
 * autoStart 会真开系统浏览器走深链交接 —— macOS 进 waiting、无头 Linux 抛
 * open_browser_failed，机器相关即 flaky，还会给 CI 机器弹真浏览器。按
 * startup.spec.ts 替换订阅 IPC 的同款先例，把发起腿钉成 account_base_unavailable：
 * 不碰真浏览器与真账号服务，Landing 停在带错误提示的 idle/failed 分支，
 * 「登录/注册」与「暂不登录」两个动作都在（本用例验收的是登录层双动作，
 * 深链交接状态机由 main 侧单测覆盖）。
 */
async function pinLoginStartUnavailable(desktop: DesktopSession): Promise<void> {
  await desktop.app!.evaluate(({ ipcMain }, { channel, code }) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, () => ({
      ok: false,
      error: code,
      applicationFailure: { code }
    }))
  }, { channel: DESKTOP_LOGIN_START_CHANNEL, code: ACCOUNT_BASE_UNAVAILABLE })
}

function refreshFileNames(home: string): string[] {
  return readdirSync(home).filter(
    (name) => name.startsWith(`${REFRESH_FILE_PREFIX}.`) && name.endsWith(`.${REFRESH_FILE_SUFFIX}`)
  )
}

test.describe('unauthenticated', () => {
  test('landing page shows login and skip options', async ({}, testInfo) => {
    const desktop = new DesktopSession(createRuntime(testInfo), testInfo)
    try {
      const page = await desktop.launch()
      // 渲染层视角的 account 模式：serve 下发 account_base_url 且当前未登录。
      await mockAccountApi(page, 'anonymous')
      await pinLoginStartUnavailable(desktop)

      // 真实产品入口：账户菜单「立即登录」→ AccountLogin → Landing（layer 变体）。
      await openAccountMenu(page)
      await page.getByTestId(MENU_ANONYMOUS_LOGIN_TEST_ID).click()
      const landing = page.getByRole('dialog', { name: LANDING_ARIA_LABEL })
      await expect(landing).toBeVisible()
      await expect(landing.getByRole('button', { name: LOGIN_BUTTON_LABEL })).toBeVisible()
      const skip = landing.getByRole('button', { name: SKIP_BUTTON_LABEL })
      await expect(skip).toBeVisible()
      await page.screenshot({ path: join(desktop.runtime.artifacts, 'auth-landing-options.png') })

      // 「暂不登录」关掉登录层，直接回普通工作台（登录不是门禁）。
      await skip.click()
      await expect(page.getByTestId(ACCOUNT_LOGIN_TEST_ID)).toHaveCount(0)
      await expect(page.getByTestId(WORKBENCH_SHELL_TEST_ID)).toBeVisible()
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
    }
  })

  test('workbench is functional without login', async ({}, testInfo) => {
    const desktop = new DesktopSession(createRuntime(testInfo), testInfo)
    try {
      // 默认 runtime：不播种凭据、不路由 mock —— serve 以免鉴权模式真实运行。
      const page = await desktop.launch()
      await expect(page.getByTestId(WORKBENCH_SHELL_TEST_ID)).toBeVisible()
      await expect(page.getByTestId(HOME_SPACE_TEST_ID)).toHaveCount(0)
      await expect(page.getByRole('dialog', { name: LANDING_ARIA_LABEL })).toHaveCount(0)
      await expect(page.getByTestId(AI_PANEL_TEST_ID)).toBeVisible()
      await page.getByTestId(COMPOSER_INPUT_TEST_ID).fill('未登录也能正常使用工作台')
      await expect(page.getByTestId(COMPOSER_INPUT_TEST_ID)).toContainText('未登录也能正常使用工作台')
      await expect(page.getByTestId(COMPOSER_SEND_TEST_ID)).toBeVisible()
      await page.screenshot({ path: join(desktop.runtime.artifacts, 'auth-anonymous-workbench.png') })
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
    }
  })

  test('account menu shows generic avatar', async ({}, testInfo) => {
    const desktop = new DesktopSession(createRuntime(testInfo), testInfo)
    try {
      const page = await desktop.launch()
      const avatar = page.getByTestId(ACTIVITY_ACCOUNT_TEST_ID)
      await expect(avatar).toHaveAttribute('aria-label', avatarLabel(DEFAULT_DISPLAY_NAME))
      await openAccountMenu(page)
      await expect(page.getByTestId(MENU_ANONYMOUS_LOGIN_TEST_ID)).toContainText(ANONYMOUS_LOGIN_LABEL)
      // 未登录：没有身份头、积分行与退出登录（AccountMenu 的 user 分支全部不渲染）。
      await expect(page.getByTestId(MENU_NAME_TEST_ID)).toHaveCount(0)
      await expect(page.getByTestId(MENU_CREDITS_TEST_ID)).toHaveCount(0)
      await expect(page.getByTestId(MENU_LOGOUT_TEST_ID)).toHaveCount(0)
      await page.screenshot({ path: join(desktop.runtime.artifacts, 'auth-anonymous-menu.png') })
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
    }
  })
})

test.describe('authenticated', () => {
  /**
   * launch 前写 seed，launch 后经生产 IPC 采纳双 token（safeStorage + httpOnly cookie）。
   * launch 期间把主进程腿账号地址临时钉到不可达 loopback（env 在 spawn 时被读走，
   * launch 返回即还原），登出时的整族吊销等 best-effort 外呼不会触达真实服务。
   */
  async function launchAuthenticated(
    testInfo: TestInfo
  ): Promise<{ desktop: DesktopSession; page: Page; account: MockAccountConfig }> {
    const runtime = createRuntime(testInfo)
    await seedAuthTokens(runtime)
    const previousAccountBase = process.env[ACCOUNT_BASE_ENV]
    process.env[ACCOUNT_BASE_ENV] = UNREACHABLE_ACCOUNT_BASE
    const desktop = new DesktopSession(runtime, testInfo)
    let page: Page
    try {
      page = await desktop.launch()
    } finally {
      if (previousAccountBase === undefined) delete process.env[ACCOUNT_BASE_ENV]
      else process.env[ACCOUNT_BASE_ENV] = previousAccountBase
    }
    const account = await mockAccountApi(page, 'authenticated')
    await adoptSeededAuth(page, runtime)
    return { desktop, page, account }
  }

  test('landing page auto-dismisses', async ({}, testInfo) => {
    const { desktop, page, account } = await launchAuthenticated(testInfo)
    try {
      // 已登录：登录层 / 首页任何变体都不出现，外壳直达工作台。
      await expect(page.getByRole('dialog', { name: LANDING_ARIA_LABEL })).toHaveCount(0)
      await expect(page.getByTestId(ACCOUNT_LOGIN_TEST_ID)).toHaveCount(0)
      await expect(page.getByTestId(WORKBENCH_SHELL_TEST_ID)).toBeVisible()

      // 整页 reload 重跑一次挂载期的认领流程（路由在导航间保持注册），仍不弹首页。
      await page.reload()
      await enterWorkbenchShell(page)
      await expect(page.getByRole('dialog', { name: LANDING_ARIA_LABEL })).toHaveCount(0)

      // 身份在 reload 后照常恢复。
      await openAccountMenu(page)
      await expect(page.getByTestId(MENU_NAME_TEST_ID)).toHaveText(account.displayName)
      await page.screenshot({ path: join(desktop.runtime.artifacts, 'auth-no-landing.png') })
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
    }
  })

  test('account menu shows identity and credits', async ({}, testInfo) => {
    const { desktop, page, account } = await launchAuthenticated(testInfo)
    try {
      await expect(page.getByTestId(ACTIVITY_ACCOUNT_TEST_ID)).toHaveAttribute(
        'aria-label',
        avatarLabel(account.displayName)
      )
      await openAccountMenu(page)
      await expect(page.getByTestId(MENU_NAME_TEST_ID)).toHaveText(account.displayName)
      await expect(page.getByTestId(MENU_CREDITS_TEST_ID)).toBeVisible()
      // 与 AccountMenu 的 CreditsValue 同一格式化口径（zh、无小数位）。
      const formatted = new Intl.NumberFormat('zh', { maximumFractionDigits: 0 }).format(
        Math.floor(account.credits)
      )
      await expect(page.getByTestId(MENU_CREDITS_VALUE_TEST_ID)).toHaveText(formatted)
      await expect(page.getByTestId(MENU_LOGOUT_TEST_ID)).toBeVisible()
      await page.screenshot({ path: join(desktop.runtime.artifacts, 'auth-menu-identity.png') })
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
    }
  })

  test('logout returns to unauthenticated state', async ({}, testInfo) => {
    const { desktop, page } = await launchAuthenticated(testInfo)
    try {
      // 采纳时 refresh 已按生产路径加密落盘（个别无密钥环的 Linux 上 safeStorage
      // 不可用，生产语义即「不落盘」，此时跳过存在性断言、保留清除断言）。
      const encryptionAvailable = await desktop.app!.evaluate(({ safeStorage }) =>
        safeStorage.isEncryptionAvailable()
      )
      if (encryptionAvailable) {
        expect(refreshFileNames(desktop.runtime.home)).toHaveLength(1)
      }

      await openAccountMenu(page)
      await page.getByTestId(MENU_LOGOUT_TEST_ID).click()
      // 主进程的整族吊销是 best-effort 外呼；launchAuthenticated 已把它的目标钉到
      // 不可达 loopback（连接拒绝 → 一条 WARN），不触达真实账号服务。本地凭据清理
      // 才是主路径，本用例断言的就是它。

      // 身份随 scholarseed:auth-required 广播清空，菜单回到未登录形态。
      await expect(page.getByTestId(MENU_ANONYMOUS_LOGIN_TEST_ID)).toContainText(ANONYMOUS_LOGIN_LABEL)
      await expect(page.getByTestId(MENU_NAME_TEST_ID)).toHaveCount(0)
      await expect(page.getByTestId(MENU_CREDITS_TEST_ID)).toHaveCount(0)
      await expect(page.getByTestId(MENU_LOGOUT_TEST_ID)).toHaveCount(0)
      await expect(page.getByTestId(ACTIVITY_ACCOUNT_TEST_ID)).toHaveAttribute(
        'aria-label',
        avatarLabel(DEFAULT_DISPLAY_NAME)
      )

      // 本地凭据两条腿都被清掉：httpOnly cookie 与加密 refresh 文件。
      await expect
        .poll(() => page.evaluate(() => window.scholarseed.getAuthToken()))
        .toBe('')
      expect(refreshFileNames(desktop.runtime.home)).toHaveLength(0)
      await page.screenshot({ path: join(desktop.runtime.artifacts, 'auth-logged-out.png') })
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
    }
  })
})
