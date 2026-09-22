import type { TFunction } from 'i18next'
import type { AuthUser } from './api.ts'
import { ensureSkillCredential, getAuthMe } from './api.ts'

// account.ts — 托管账号服务 (veda-account) 客户端。
//
// 这条线**直连账号服务**，不经 serve 转发：账号服务是独立部署的远端服务，serve 只做
// 「离线验签 + 吊销」(service/identity/service/account.py)。地址由 /api/auth/status 的
// account_base_url 下发，前端不自带配置。
//
// 凭据由主进程持有：登录拿到的 JWT 交给 window.scholarseed.setAuthToken() 写进 session
// cookie（serve 的 fetch/SSE 靠它过鉴权），需要 bearer 时再用 getAuthToken() 取回 —— cookie
// 是 httpOnly，渲染层读不到，所以受保护端点一律走这个取回口。

const PURPOSE_LOGIN = 'login'
const PURPOSE_REGISTER = 'register'
const PURPOSE_RESET = 'reset'
const PURPOSE_CHANGE = 'change'
export const CODE_PURPOSES = {
  login: PURPOSE_LOGIN,
  register: PURPOSE_REGISTER,
  reset: PURPOSE_RESET,
  change: PURPOSE_CHANGE
} as const
export type CodePurpose = (typeof CODE_PURPOSES)[keyof typeof CODE_PURPOSES]

// 与服务端 RATE_COOLDOWN_SECONDS 对齐: 同号码同目的 60s 冷却, 前端倒计时按这个值。
export const CODE_COOLDOWN_SECONDS = 60
// 与服务端 PASSWORD_MIN_LENGTH 对齐 (提前拦住必定 400 的提交)。
export const PASSWORD_MIN_LENGTH = 8
const REQUEST_TIMEOUT_MS = 10_000

// 需要界面按码分支的错误码在这里具名，其余只经 ERROR_TEXT 出文案。未注册要在登录页
// 上引出注册入口，那条分支必须认码 —— 比对中文文案的话，改一次文案就静默失效。
export const ERR_NOT_REGISTERED = 'not_registered'

// 本机没有凭据、或凭据被账号服务判死时统一的码。登录不是启动门禁, 所以「未登录」是
// 界面的正常状态而不是故障 —— 要按码分支就得名它, 比对中文文案改一次就静默失效。
export const ERR_UNAUTHENTICATED = 'unauthorized'

// Preserve the existing AccountResult.error contract; presentation uses explicit provenance below.
const ERROR_TEXT: Record<string, string> = {
  invalid_phone: '手机号格式不正确',
  invalid_purpose: '验证码用途不支持',
  rate_cooldown: '发送太频繁，请稍后再试',
  rate_daily_phone: '该手机号今日发送次数已用完',
  rate_daily_ip: '当前网络今日发送次数已用完',
  sms_not_configured: '短信通道未配置，请联系管理员',
  sms_send_failed: '短信发送失败，请稍后再试',
  [ERR_NOT_REGISTERED]: '该手机号未注册',
  account_disabled: '账号已被停用',
  invalid_code: '验证码不正确',
  code_expired: '验证码已过期',
  code_exhausted: '验证码错误次数过多，请重新获取',
  invalid_password: '手机号或密码不正确',
  invalid_nickname: '昵称需为 1–64 个字符',
  password_too_short: `密码至少 ${PASSWORD_MIN_LENGTH} 位`,
  phone_taken: '该手机号已被注册',
  invite_required: '需要邀请码',
  invite_invalid: '邀请码无效或已用完',
  unauthorized: '登录状态已失效，请重新登录',
  invalid_refresh: '登录状态已失效，请重新登录',
  forbidden: '没有权限',
  not_found: '资源不存在',
  invalid_api_key: 'API 密钥无效或已吊销',
  invalid_api_key_name: '密钥名称过长',
  api_key_limit: '活跃密钥数已达上限，请先吊销一个',
  api_key_managed: '这把密钥由书深自动管理，所有设备共用；只能轮换，不能吊销。轮换后所有设备下次开会话获取新密钥'
}

const NETWORK_ERROR_TEXT = '无法连接账号服务'
const NO_BASE_URL_TEXT = '账号服务地址未配置'
const NO_TOKEN_TEXT = '本地登录凭据丢失，请重新登录'
const INVALID_RESPONSE_TEXT = '账号服务返回了无法识别的数据，请稍后重试'
const LOCAL_LOGOUT_ERROR_TEXT = '本地登录凭据未能清除，请重试'
// 脱敏遮罩：固定 4 颗星，不随被遮位数变化 —— 星号个数泄露长度，且长度可变会让
// 界面上一列手机号对不齐。
const PHONE_MASK = '****'
const DEFAULT_ACCOUNT_NAME = '书深用户'

const ACCOUNT_FAILURE_KEYS = {
  invalid_phone: 'failure.invalid_phone', invalid_purpose: 'failure.invalid_purpose',
  rate_cooldown: 'failure.rate_cooldown', rate_daily_phone: 'failure.rate_daily_phone',
  rate_daily_ip: 'failure.rate_daily_ip', sms_not_configured: 'failure.sms_not_configured',
  sms_send_failed: 'failure.sms_send_failed', not_registered: 'failure.not_registered',
  account_disabled: 'failure.account_disabled', invalid_code: 'failure.invalid_code',
  code_expired: 'failure.code_expired', code_exhausted: 'failure.code_exhausted',
  invalid_password: 'failure.invalid_password', invalid_nickname: 'failure.invalid_nickname',
  password_too_short: 'failure.password_too_short', phone_taken: 'failure.phone_taken',
  invite_required: 'failure.invite_required', invite_invalid: 'failure.invite_invalid',
  unauthorized: 'failure.unauthorized', invalid_refresh: 'failure.invalid_refresh',
  forbidden: 'failure.forbidden', not_found: 'failure.not_found',
  invalid_api_key: 'failure.invalid_api_key', invalid_api_key_name: 'failure.invalid_api_key_name',
  api_key_limit: 'failure.api_key_limit', api_key_managed: 'failure.api_key_managed',
  network: 'failure.network', no_base_url: 'failure.no_base_url',
  invalid_response: 'failure.invalid_response', local_logout_failed: 'failure.local_logout_failed',
  logout_revocation_failed: 'failure.logout_revocation_failed', http_failure: 'failure.http_failure'
} as const

export interface AccountSession {
  token: string
  refresh_token: string
  user_id: string
  nickname: string
  expires_in: number
  refresh_expires_in: number
}
export interface AccountProfile {
  user_id: string
  nickname: string
  phone?: string
}
/** 一把长期凭据的可见面。明文不在里面 —— 它只在 createApiKey 的响应中出现一次。 */
export interface ApiKeySummary {
  key_id: string
  name: string
  /** `ssk-` + 明文前 8 字符，用于掩码展示与排障对号。 */
  prefix: string
  /** true = 书深自动为会话备的那把：不占配额，只能轮换、不能吊销。 */
  managed: boolean
  created_at: number
  last_used_at: number | null
}
export interface ApiKeyCreated extends ApiKeySummary {
  /** 完整明文，**仅此一次**。关闭弹层后账号服务也取不回（库里只有 sha256）。 */
  token: string
}

/** Only the explicit managed provenance identifies the product-owned credential name. */
export function apiKeyDisplayName(key: Pick<ApiKeySummary, 'name' | 'managed'>, t: TFunction<'account'>): string {
  return key.managed ? t('accountExtra.managedName') : key.name || t('accountExtra.unnamed')
}
export interface AccountFailure {
  ok: false
  code: string
  error: string
  applicationFailure?: { code: string; status?: number; diagnostic?: string }
}
export type AccountResult<T> = { ok: true; data: T } | AccountFailure
export type AccountLogoutResult = AccountResult<{ local_cleared: true }>

/** Translate only product-generated explanations; raw diagnostics never imply an error identity. */
export function accountFailureText(failure: AccountFailure, t: TFunction<'account'>): string {
  const descriptor = failure.applicationFailure
  if (!descriptor || !Object.prototype.hasOwnProperty.call(ACCOUNT_FAILURE_KEYS, descriptor.code)) return failure.error
  const message = t(ACCOUNT_FAILURE_KEYS[descriptor.code as keyof typeof ACCOUNT_FAILURE_KEYS], {
    count: PASSWORD_MIN_LENGTH, status: descriptor.status ?? 0
  })
  return descriptor.diagnostic ? t('failure.diagnostic', { message, detail: descriptor.diagnostic }) : message
}

export function parseAccountProfile(payload: Record<string, unknown>): AccountResult<AccountProfile> {
  const userId = String(payload.user_id || '').trim()
  const nickname = String(payload.nickname || '').trim()
  if (!userId || !nickname) {
    return { ok: false, code: 'invalid_response', error: INVALID_RESPONSE_TEXT, applicationFailure: { code: 'invalid_response' } }
  }
  const phone = String(payload.phone || '').trim()
  return { ok: true, data: { user_id: userId, nickname, ...(phone ? { phone } : {}) } }
}

/**
 * 所有产品界面的账号显示名都走这一条优先级：账号服务中的用户昵称是用户可见真值，
 * serve 的认证投影只在账号服务暂不可用时兜底。禁止直接把内部 user_id 当首选昵称。
 */
export function accountDisplayName(
  user: AuthUser | null,
  profile: AccountProfile | null = null
): string {
  return accountNameCandidate(user, profile) ?? DEFAULT_ACCOUNT_NAME
}

/** Localize only the application fallback; a real nickname with the same text is user content. */
export function accountDisplayText(
  user: AuthUser | null,
  profile: AccountProfile | null,
  t: TFunction<'account'>
): string {
  return accountNameCandidate(user, profile) ?? t('identity.defaultName')
}

function accountNameCandidate(user: AuthUser | null, profile: AccountProfile | null): string | null {
  const candidates = [
    profile?.nickname,
    user?.nickname,
    user?.display_name,
    user?.email
  ]
  return candidates
    .map((value) => String(value || '').trim())
    .find((value) => Boolean(value) && !/^u-[0-9a-f]{16,}$/i.test(value)) ?? null
}

/**
 * 手机号展示脱敏：只留前 3 后 4（138****8001）。
 *
 * **只用于展示**。发码 / 重置密码 / 改号这三条流向账号服务的路必须传原值 —— 服务端按
 * ^1[3-9]\d{9}$ 校验，把带星号的串发过去只会得到 invalid_phone，而且那种失败长得像
 * 「验证码发出去了却收不到」，最难查。
 *
 * 短于 8 位的一律整串打码而不是原样回显：这种输入不该出现（服务端只存 11 位），
 * 真出现了也宁可少露一点。
 */
export function maskPhone(phone: string): string {
  const value = String(phone || '').trim()
  if (!value) return ''
  if (value.length < 8) return PHONE_MASK
  return value.slice(0, 3) + PHONE_MASK + value.slice(-4)
}

let baseUrl = ''
let deviceCache: { device_id: string; device_label: string } | null = null

/** 由登录页在拿到 /api/auth/status 后调用（account_base_url）。 */
export function setAccountBase(url: string): void {
  baseUrl = (url || '').replace(/\/+$/, '')
}

export function accountBase(): string {
  return baseUrl
}

function failure(code: string, fallback: string, fallbackFailure?: AccountFailure['applicationFailure'], diagnostic?: string): AccountFailure {
  const known = Object.prototype.hasOwnProperty.call(ERROR_TEXT, code)
  const applicationFailure = known ? { code, ...(diagnostic ? { diagnostic } : {}) } : fallbackFailure
  return { ok: false, code, error: known ? ERROR_TEXT[code] : fallback, ...(applicationFailure ? { applicationFailure } : {}) }
}

async function request<T>(
  method: string,
  path: string,
  body: unknown,
  withAuth: boolean
): Promise<AccountResult<T>> {
  if (!baseUrl) return { ok: false, code: '', error: NO_BASE_URL_TEXT, applicationFailure: { code: 'no_base_url' } }
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (withAuth) {
    const token = await window.scholarseed.getAuthToken()
    if (!token) return failure(ERR_UNAUTHENTICATED, NO_TOKEN_TEXT)
    headers['authorization'] = `Bearer ${token}`
  }
  const ctl = new AbortController()
  const timer = window.setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const r = await fetch(baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal
    })
    const payload = (await r.json().catch(() => ({}))) as Record<string, unknown>
    if (!r.ok) {
      const code = String(payload.code || '')
      if (r.status === 401 || code === ERR_UNAUTHENTICATED) {
        window.dispatchEvent(new CustomEvent('scholarseed:auth-required'))
      }
      const diagnostic = String(payload.message || '')
      return failure(code, diagnostic || `请求失败（${r.status}）`, diagnostic ? undefined : { code: 'http_failure', status: r.status }, diagnostic)
    }
    return { ok: true, data: payload as T }
  } catch (error) {
    return { ok: false, code: '', error: NETWORK_ERROR_TEXT, applicationFailure: {
      code: 'network', ...(error == null ? {} : { diagnostic: error instanceof Error ? error.message : String(error) })
    } }
  } finally {
    window.clearTimeout(timer)
  }
}

/** 设备身份来自主进程（跳重启稳定），登录/注册随请求上报，后台设备列表与远程登出靠它。 */
async function deviceFields(): Promise<{ device_id: string; device_label: string }> {
  if (deviceCache) return deviceCache
  try {
    deviceCache = await window.scholarseed.getDeviceInfo()
  } catch {
    deviceCache = { device_id: '', device_label: '' }
  }
  return deviceCache
}

export async function sendCode(phone: string, purpose: CodePurpose): Promise<AccountResult<{ sent: boolean }>> {
  return request('POST', '/api/phone/code', { phone, purpose }, false)
}

// 登录/注册的桌面客户端函数已随应用内旧表单移除：登录统一走「浏览器官网登录 +
// scholarseed:// 一次性 code 回跳」（main/handoff.ts），桌面端不再直连手机号登录端点。
// 换绑/重置密码仍是登录态内的自助动作，保留 sendCode / resetPassword。

export async function resetPassword(
  phone: string,
  code: string,
  newPassword: string
): Promise<AccountResult<{ reset: boolean }>> {
  return request('POST', '/api/phone/reset-password', { phone, code, new_password: newPassword }, false)
}

export async function accountMe(): Promise<AccountResult<AccountProfile>> {
  const result = await request<Record<string, unknown>>('GET', '/api/account/me', undefined, true)
  if (!result.ok) return result
  return parseAccountProfile(result.data)
}

/** 本人积分余额（网关 /v1/me/quota 的余额口径透传：100 积分 == 1 元）。 */
export interface CreditsSummary {
  /** 当前可用积分。null = 上游没给这个数, 界面显示占位而不是编一个 0。 */
  balance_credits: number | null
  /** 累计发放（注册赠送 + 运维按需补发）。 */
  granted_credits: number | null
  /** 累计已核销。 */
  used_credits: number | null
  /** true = 该账号不计量。null / 缺失一律按 false 读, 不能反过来当成豁免。 */
  unlimited: boolean
  /** true = 余额耗尽真拒; false = 撤闸的「只算不拒」态。 */
  enforcing: boolean
  /** 最早一笔会到期且仍有剩余的发放行; null = 没有会到期的行（长期有效）。 */
  earliest_expiry_at: string | null
}

export interface CreditsState {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  summary: CreditsSummary | null
}

export const INITIAL_CREDITS_STATE: CreditsState = {
  phase: 'idle',
  summary: null
}

export function creditsAreExhausted(summary: CreditsSummary | null): boolean {
  return Boolean(
    summary &&
    summary.enforcing &&
    !summary.unlimited &&
    summary.balance_credits !== null &&
    summary.balance_credits <= 0
  )
}

export function creditsBlockBuiltInModel(
  credits: CreditsState,
  model: { source?: string } | undefined
): boolean {
  return model?.source === 'builtin' && creditsAreExhausted(credits.summary)
}

export function markCreditsExhausted(state: CreditsState): CreditsState {
  return {
    phase: 'ready',
    summary: {
      balance_credits: 0,
      granted_credits: state.summary?.granted_credits ?? null,
      used_credits: state.summary?.used_credits ?? null,
      unlimited: false,
      enforcing: true,
      earliest_expiry_at: state.summary?.earliest_expiry_at ?? null
    }
  }
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 到期时间归一。**不能交给 toFiniteNumber**: Number(null) === 0, 那会把「没有到期日」
 * 压成 1970-01-01 并渲染成一个真的日期。null / 空串 / 解析不出日期的串统一回 null,
 * 让界面据此隐去到期行而不是显示一个编出来的时间。
 */
function toTimestamp(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  return text && !Number.isNaN(Date.parse(text)) ? text : null
}

/** 余额口径归一。与 parseAccountProfile 同形的纯函数: 契约测试直接钉它, 不发请求。 */
export function parseCreditsSummary(payload: Record<string, unknown>): CreditsSummary {
  return {
    balance_credits: toFiniteNumber(payload.balance_credits),
    granted_credits: toFiniteNumber(payload.granted_credits),
    used_credits: toFiniteNumber(payload.used_credits),
    unlimited: payload.unlimited === true,
    enforcing: payload.enforcing === true,
    earliest_expiry_at: toTimestamp(payload.earliest_expiry_at)
  }
}

/** 低余额预警阈值（积分）：余额落入 (0, 阈值] 记低余额，<= 0 记耗尽。 */
export const CREDITS_LOW_WARNING_THRESHOLD = 100

export type CreditsWarningBucket = 'exhausted' | 'low' | null

/** 余额的预警分桶。null = 正常，不需要预警。纯函数，契约测试直接钉它。 */
export function creditsWarningBucket(balance: number): CreditsWarningBucket {
  if (balance <= 0) return 'exhausted'
  return balance <= CREDITS_LOW_WARNING_THRESHOLD ? 'low' : null
}

/**
 * 头像菜单「剩余积分」的取数口：账号服务 Bearer 腿，与云端网页 /api/web/credits 同源。
 *
 * 降级路径按状态码分两语义, 都由 request() 统一给: 401 广播 scholarseed:auth-required
 * （身份被清, 积分行随之消失, 用户去重登）; 网关未配置 / 不可达时账号服务原样回
 * 503 / 502, 走 ok:false, 界面显示占位而不是编一个 0。
 */
export async function accountCredits(): Promise<AccountResult<CreditsSummary>> {
  const result = await request<Record<string, unknown>>('GET', '/api/account/credits', undefined, true)
  if (!result.ok) return result
  return { ok: true, data: parseCreditsSummary(result.data) }
}

// 云端网页（账号服务 /web 多页挂载）里桌面端要跳的两个页面。登录页不在此列：
// 桌面端登录走「浏览器官网登录 + scholarseed:// 一次性 code 回跳」（main/handoff.ts）。
const CLOUD_PAGES = {
  profile: '/web/account.html',
  credits: '/web/credits.html'
} as const
export type CloudPage = keyof typeof CLOUD_PAGES

/**
 * 云端页内的定位锚点。积分页的「获取更多积分」区域由官网侧提供
 * （`ui/account-web/credits.html` 的 `<section id="credit-more">`）, 桌面端只拼锚点,
 * 不在本地复刻那个区域。
 */
export const CLOUD_PAGE_ANCHORS = {
  creditsMore: 'credit-more'
} as const
export type CloudPageAnchor = (typeof CLOUD_PAGE_ANCHORS)[keyof typeof CLOUD_PAGE_ANCHORS]

/** 云端页完整 URL（可带页内锚点）；账号服务地址未下发时返回空串（调用方据此隐藏跳转 affordance）。 */
export function cloudPageUrl(page: CloudPage, anchor?: CloudPageAnchor): string {
  if (!baseUrl) return ''
  const url = baseUrl + CLOUD_PAGES[page]
  return anchor ? `${url}#${anchor}` : url
}

export async function updateNickname(nickname: string): Promise<AccountResult<{ nickname: string }>> {
  return request('PATCH', '/api/account/profile', { nickname }, true)
}

export async function changePhone(newPhone: string, code: string): Promise<AccountResult<{ phone: string }>> {
  return request('POST', '/api/account/phone/change', { new_phone: newPhone, code }, true)
}

// ── API Key（长期凭据）。签发/吊销一律由**用户 JWT** 鉴权，不能拿 API Key 自己去签
// 发下一把 —— 否则一把泄露的 key 就能无限续命，吊销永远追不上。
//
// 列表刻意返回全部活跃 key 而不是「你的那一把」：改密只吊销 JWT 会话、不连带吊销 key，
// 所以会话被窃时攻击者可以静默建一把当后门，界面必须能把它显示出来。

export async function listApiKeys(): Promise<AccountResult<{ keys: ApiKeySummary[] }>> {
  return request('GET', '/api/account/api-keys', undefined, true)
}

export async function createApiKey(name: string): Promise<AccountResult<ApiKeyCreated>> {
  return request('POST', '/api/account/api-keys', { name }, true)
}

export async function revokeApiKey(keyId: string): Promise<AccountResult<{ revoked: boolean }>> {
  return request('DELETE', `/api/account/api-keys/${encodeURIComponent(keyId)}`, undefined, true)
}

// 书深自动备的那把（managed）走轮换而非吊销：删掉它只会在下次开会话时被重新签发，所以
// 「删除」对用户永远不成立。轮换只让当前这把立刻失效，新的由 serve 下次开会话时签发 ——
// 明文因此不经过界面，这个响应里没有 token。
export async function rotateApiKey(keyId: string): Promise<AccountResult<{ rotated: boolean }>> {
  return request(
    'POST',
    `/api/account/api-keys/${encodeURIComponent(keyId)}/rotate`,
    undefined,
    true
  )
}

/** 登录成功后把双令牌交给主进程：access 写 session cookie（serve 的 fetch 与 SSE 靠它），
 * refresh 由主进程加密落盘供到期前静默续期（渲染层此后永远碰不到 refresh）。 */
export async function adoptSession(token: string, refreshToken: string): Promise<boolean> {
  const result = await window.scholarseed.setAuthToken(token, refreshToken)
  return result.ok
}

/**
 * 凭据采纳后的确认链：回问宿主 /api/auth/me 确认 serve 真能验通这份凭据（cookie 属性、
 * 跨源策略、账号服务地址配错都会卡在这一段），顺带把技能用的密钥备好（幂等）。
 *
 * 应用内登录（AccountAuth）与深链交接（Landing）共用它 —— 两条登录线不允许在「凭据
 * 是否真可用」上各自漂移：拿到 token 只证明账号服务认了凭据，不证明宿主验得通。
 */
export async function confirmAdoptedSession(): Promise<boolean> {
  const me = await getAuthMe()
  if (me?.auth !== true) return false
  void ensureSkillCredential()
  return true
}

/** 本地登出：清双凭据。主进程会顺带 best-effort 通知账号服务整族吊销（refresh 一并失效）。 */
export async function dropSession(): Promise<AccountLogoutResult> {
  const result = await window.scholarseed.setAuthToken('')
  return result.ok
    ? { ok: true, data: { local_cleared: true } }
    : { ok: false, code: 'local_logout_failed', error: result.error || LOCAL_LOGOUT_ERROR_TEXT,
      ...(!result.error ? { applicationFailure: { code: 'local_logout_failed' } } : {}) }
}
