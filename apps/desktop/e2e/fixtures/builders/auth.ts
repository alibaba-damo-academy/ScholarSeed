import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { expect, type Page, type Route } from '@playwright/test'
import type { RuntimePaths } from '../runtime'

// auth.ts — 账号双态（未登录 / 已登录）的确定性测试基建。
//
// 产品链路里有两条独立的取数腿（src/main/handoff.ts、src/main/auth-refresh.ts、
// src/renderer/src/account.ts）：
//
// 1. 渲染层腿：serve 的 /api/auth/status、/api/auth/me（身份投影）+ 账号服务的
//    /api/account/me、/api/account/credits（Bearer 直连）。这条腿用 `page.route`
//    拦截 —— e2e 的约束就是不起真 HTTP 服务，路由 mock 更快也更稳。
// 2. 主进程腿：token 交换 / 续期 / 登出吊销（Node fetch，不经过 page.route）。
//    需要它时把 `SCHOLARSEED_ACCOUNT_BASE_URL` 指向本地 mock 账号服务。
//
// 凭据播种走**生产同款路径**：seedAuthTokens 只在测试自有的 runtime.root 落一份
// seed 描述（safeStorage 只能在 Electron 主进程里用，launch 前无法加密）；launch 后
// adoptSeededAuth 经 `window.scholarseed.setAuthToken`（IPC `veda:auth-token-set`）
// 交给主进程 —— access 写 httpOnly session cookie、refresh 由 safeStorage 加密落
// 产品家目录，与真实登录采纳完全同一条实现（src/main/index.ts:adoptAuthTokens）。

/** 与 `/api/auth/status` 的 wire 形状对齐（src/renderer/src/api.ts:AuthStatus）。 */
export interface MockAuthStatus {
  enabled: boolean
  bootstrap: boolean
  mode: string
  account_base_url?: string
  methods?: string[]
}

/** 与 `/api/auth/me` 的 wire 形状对齐（src/renderer/src/api.ts:AuthUser）。 */
export interface MockAuthUser {
  user_id: string
  email: string
  auth: boolean
  display_name?: string
  nickname?: string
}

export interface MockAccountConfig {
  accessToken: string
  refreshToken: string
  userId: string
  displayName: string
  credits: number
}

export const DEFAULT_MOCK_ACCOUNT: MockAccountConfig = {
  accessToken: 'mock-access-token-test-only',
  refreshToken: 'mock-refresh-token-test-only',
  userId: 'test-user-001',
  displayName: '测试用户',
  credits: 1000
}

/**
 * 渲染层 mock 与主进程不可达地址共用本机 discard 端口。测试页的生产 CSP 只允许
 * 启动时的账号源与 loopback；用其他假域名即使 page.route 拦截也会被 CSP 阻断。
 */
export const MOCK_ACCOUNT_BASE = 'http://127.0.0.1:9'

/** seed 描述文件名；落在 runtime.root（测试自有目录），不进产品家目录。 */
const AUTH_SEED_FILE = 'auth-seed.json'

/** 与 src/renderer/src/account.ts 的账号服务端点对齐。 */
const AUTH_STATUS_PATH = '**/api/auth/status'
const AUTH_ME_PATH = '**/api/auth/me'
const AUTH_LOGOUT_PATH = '**/api/auth/logout'
const ACCOUNT_ME_PATH = '**/api/account/me'
const ACCOUNT_CREDITS_PATH = '**/api/account/credits'
const TOKEN_REFRESH_PATH = '**/api/token/refresh'
const TOKEN_LOGOUT_PATH = '**/api/token/logout'

const ACCOUNT_MODE = 'account'
const ACCOUNT_METHODS = ['code', 'password']
/** 续期轮转后的确定性后缀：断言「换过 token」时不需要再造一个常量值。 */
const ROTATED_TOKEN_SUFFIX = '-rotated'
const UNAUTHORIZED_CODE = 'unauthorized'

export type MockAuthState = 'authenticated' | 'anonymous'

// ── wire payload 构造（serve 投影 + 账号服务响应，两处 mock 共用同一份形状）──

export function authStatusPayload(state: MockAuthState): MockAuthStatus {
  // serve 即使 --auth-mode off 也会投影 account_base_url（apps/serve
  // service/identity/service/auth.py）；渲染层据此决定登录入口形态。
  return state === 'authenticated'
    ? { enabled: true, bootstrap: false, mode: ACCOUNT_MODE, account_base_url: MOCK_ACCOUNT_BASE, methods: ACCOUNT_METHODS }
    : { enabled: false, bootstrap: false, mode: 'off', account_base_url: MOCK_ACCOUNT_BASE, methods: ACCOUNT_METHODS }
}

export function authMePayload(config: MockAccountConfig, state: MockAuthState): MockAuthUser {
  // 未登录形状对齐 serve 免鉴权模式的 anonymous 投影（routes.py /api/auth/me）。
  return state === 'authenticated'
    ? {
        user_id: config.userId,
        email: '',
        auth: true,
        display_name: config.displayName,
        nickname: config.displayName
      }
    : { user_id: 'local', email: '', auth: false }
}

/** 账号服务 /api/account/me（account.ts:AccountProfile）。不带 phone：菜单主行才显示昵称。 */
export function accountMePayload(config: MockAccountConfig): Record<string, unknown> {
  return { user_id: config.userId, nickname: config.displayName }
}

/** 账号服务 /api/account/credits（account.ts:CreditsSummary）。 */
export function accountCreditsPayload(config: MockAccountConfig): Record<string, unknown> {
  return {
    balance_credits: config.credits,
    granted_credits: config.credits,
    used_credits: 0,
    unlimited: false,
    enforcing: true,
    earliest_expiry_at: null
  }
}

function bearerOf(headers: Record<string, string | string[] | undefined>): string {
  const header = headers['authorization']
  const value = Array.isArray(header) ? header[0] : header
  return String(value || '').replace(/^Bearer\s+/i, '')
}

// ── page.route mock（渲染层腿；spec 的默认选择）──

/**
 * 按登录态拦截渲染层的全部账号相关请求。响应形状与真实端点一一对齐；
 * 受保护端点校验 Bearer 是否为播种的 access token —— cookie 没被真实采纳时
 * 直接回 401，让 spec 失败在契约上而不是界面上。
 */
export async function mockAccountApi(
  page: Page,
  state: MockAuthState,
  config: Partial<MockAccountConfig> = {}
): Promise<MockAccountConfig> {
  const account = { ...DEFAULT_MOCK_ACCOUNT, ...config }
  const json = (route: Route, status: number, payload: unknown): Promise<void> =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) })
  const unauthorized = { code: UNAUTHORIZED_CODE, message: '登录状态已失效，请重新登录' }
  const guardBearer = (token: string): boolean =>
    state === 'authenticated' && token === account.accessToken

  await page.route(AUTH_STATUS_PATH, (route) => json(route, 200, authStatusPayload(state)))
  await page.route(AUTH_ME_PATH, (route) => json(route, 200, authMePayload(account, state)))
  await page.route(AUTH_LOGOUT_PATH, (route) => json(route, 200, { ok: true }))
  await page.route(ACCOUNT_ME_PATH, (route) =>
    guardBearer(bearerOf(route.request().headers()))
      ? json(route, 200, accountMePayload(account))
      : json(route, 401, unauthorized)
  )
  await page.route(ACCOUNT_CREDITS_PATH, (route) =>
    guardBearer(bearerOf(route.request().headers()))
      ? json(route, 200, accountCreditsPayload(account))
      : json(route, 401, unauthorized)
  )
  await page.route(TOKEN_REFRESH_PATH, (route) => json(route, 200, {
    token: account.accessToken + ROTATED_TOKEN_SUFFIX,
    refresh_token: account.refreshToken + ROTATED_TOKEN_SUFFIX
  }))
  await page.route(TOKEN_LOGOUT_PATH, (route) => json(route, 200, { ok: true }))
  return account
}

// ── 凭据播种（生产同款采纳路径）──

/**
 * launch **前**调用：把 mock 账号写成 seed 描述。safeStorage 加密与 httpOnly cookie
 * 只能由运行中的 Electron 主进程完成，所以真正的落盘发生在 `adoptSeededAuth`
 * （走生产 IPC `veda:auth-token-set`，与深链交接共用同一个 adoptAuthTokens）。
 */
export async function seedAuthTokens(
  runtime: RuntimePaths,
  config: Partial<MockAccountConfig> = {}
): Promise<void> {
  const account = { ...DEFAULT_MOCK_ACCOUNT, ...config }
  writeFileSync(join(runtime.root, AUTH_SEED_FILE), JSON.stringify(account, null, 2))
}

export function readAuthSeed(runtime: RuntimePaths): MockAccountConfig {
  return JSON.parse(readFileSync(join(runtime.root, AUTH_SEED_FILE), 'utf-8')) as MockAccountConfig
}

/**
 * launch **后**调用：把 seed 的双 token 交给主进程采纳（access 写 session cookie，
 * refresh 由 safeStorage 加密落盘），再广播 `scholarseed:auth-restored` —— 与真实
 * 登录成功后 App.tsx:handleAuthed 的事件契约一致，让所有表面的身份一起重取。
 * 调用前先注册 `mockAccountApi(page, 'authenticated')`。
 */
export async function adoptSeededAuth(page: Page, runtime: RuntimePaths): Promise<MockAccountConfig> {
  const account = readAuthSeed(runtime)
  const adopted = await page.evaluate(
    ([token, refreshToken]) => window.scholarseed.setAuthToken(token, refreshToken),
    [account.accessToken, account.refreshToken]
  )
  expect(adopted.ok, adopted.error || '').toBe(true)
  // cookie 真的写进去了才算采纳成功：受保护 mock 端点按同一个值校验 Bearer。
  await expect
    .poll(() => page.evaluate(() => window.scholarseed.getAuthToken()))
    .toBe(account.accessToken)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('scholarseed:auth-restored')))
  return account
}
