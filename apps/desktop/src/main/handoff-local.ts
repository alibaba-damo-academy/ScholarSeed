// handoff-local.ts — 桌面登录交接的本机协调腿（proposal 74）。
//
// 与 handoff.ts 的分工：handoff.ts 是状态机，本模块只是「和自家 serve 说话」的一条
// 传输腿。四个端点都在 `/api/auth/handoff/` 下 —— 那个前缀在 serve 的 `_PUBLIC_PREFIXES`
// 里，任何鉴权模式下都免鉴权，所以每个请求都带宿主头（Host-Key），那是 serve 认「只有
// 桌面主进程可达」的唯一凭据。头的**名字**不在这里出现：由 index.ts 拼好整张头表传进来，
// 于是本模块不必 import backend.ts（它带 electron，会让 node --test 加载不了整条链，
// 这正是 handoff-url.ts 当初被拆出来的同一个理由）。
//
// 纪律：**协调层永不挡住登录**。任何一次调用失败都降级成「只靠内存 state」的既有行为 ——
// 深链归属投错是低频事件，而登录被一个新组件挡住是高频灾难。所以 renew 把「传输失败」
// 与「服务端明确判无主」分成两种结论：前者继续重试（一次 serve 抖动或 SQLite BUSY 不该
// 让正在进行的登录作废），后者才停。
//
// 日志纪律：code 是凭据，只打状态与错误码，绝不打原值。

const COORDINATION_PREFIX = '/api/auth/handoff'
const COORDINATION_TIMEOUT_MS = 5_000
/** 投递的重试次数。接管方投不出去时不能静默丢弃（proposal 74 §8.4），但也没有理由
 *  对着一个已经死掉的 serve 重试到 code 过期 —— code 寿命是服务端常量，客户端看不见，
 *  所以这里用一个与它无关的、纯粹覆盖瞬态抖动的小预算，耗尽即显式记账。 */
const DELIVERY_ATTEMPTS = 3
const DELIVERY_RETRY_DELAY_MS = 500

const CLAIM_PATH = '/claim'
const RENEW_PATH = '/renew'
const DELIVER_PATH = '/deliver'
const RELEASE_PATH = '/release'

const STATUS_CLAIMED = 'claimed'
const STATUS_RENEWED = 'renewed'
const STATUS_DELIVERED = 'delivered'
const STATUS_ORPHANED = 'orphaned'
const SERVE_UNAVAILABLE_ERROR = 'serve_unavailable'

function httpError(status: number): string {
  return ['http', status].join('_')
}

export type RenewResult =
  | { kind: 'renewed'; leaseExpiresAt: number; code?: string }
  /** 服务端明确判无主：租约过期或 claim 不存在。发起方据此停止轮询。 */
  | { kind: 'orphaned' }
  /** 传输层失败。与 orphaned 必须分开：这种情况要重试，不是登录作废。 */
  | { kind: 'failed'; error: string }

export type DeliveryResult = 'delivered' | 'orphaned' | 'failed'

export interface HandoffLocalCoordinator {
  /** 登记 claim。失败不抛：调用方降级成只靠内存 state。 */
  claim(state: string): Promise<boolean>
  renew(state: string): Promise<RenewResult>
  deliver(state: string, code: string): Promise<DeliveryResult>
  release(state: string): Promise<void>
}

export interface LocalCoordinationDependencies {
  log: (line: string) => void
  /** 自家 serve 的 loopback 地址。取函数而不是值：apiBase 在 backend 就绪时才定。 */
  baseUrl: () => string
  /** 进程实例 id。刻意不用 pid —— pid 会被复用，重启后的新进程可能拿到同一个 pid
   *  从而意外接管前身的 claim，那恰好违反「重启后重新登录」的裁决。 */
  instanceId: string
  /** 宿主头整张表（Host-Key）。由 index.ts 拼，本模块不认识头名。 */
  hostHeaders: () => Record<string, string>
}

interface CoordinationReply {
  status?: string
  lease_expires_at?: number
  code?: string
}

async function post(
  deps: LocalCoordinationDependencies,
  path: string,
  body: Record<string, string>
): Promise<{ ok: boolean; reply: CoordinationReply; error: string }> {
  const base = deps.baseUrl().replace(/\/+$/, '')
  if (!base) return { ok: false, reply: {}, error: SERVE_UNAVAILABLE_ERROR }
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), COORDINATION_TIMEOUT_MS)
    const resp = await fetch(base + COORDINATION_PREFIX + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...deps.hostHeaders() },
      body: JSON.stringify(body),
      signal: ctl.signal
    })
    clearTimeout(timer)
    const reply = (await resp.json().catch(() => ({}))) as CoordinationReply
    if (!resp.ok) return { ok: false, reply, error: httpError(resp.status) }
    return { ok: true, reply, error: '' }
  } catch (e) {
    return { ok: false, reply: {}, error: e instanceof Error ? e.message : String(e) }
  }
}

function leaseExpiresAt(reply: CoordinationReply): number {
  return Number(reply.lease_expires_at || 0)
}

export function createHandoffCoordinator(
  deps: LocalCoordinationDependencies
): HandoffLocalCoordinator {
  return {
    async claim(state: string): Promise<boolean> {
      const { ok, reply, error } = await post(deps, CLAIM_PATH, {
        state,
        owner_id: deps.instanceId
      })
      if (!ok) {
        deps.log(`[shell] WARN handoff claim unavailable (${error}); falling back to memory-only\n`)
        return false
      }
      if (reply.status !== STATUS_CLAIMED) {
        // 同 state 已被本机另一个实例持有。随机 43 字符的 nonce 撞车近乎不可能，
        // 真撞上也只是退回内存路径，不值得当成错误。
        deps.log(`[shell] handoff claim not granted (${String(reply.status)}); memory-only\n`)
        return false
      }
      return true
    },

    async renew(state: string): Promise<RenewResult> {
      const { ok, reply, error } = await post(deps, RENEW_PATH, {
        state,
        owner_id: deps.instanceId
      })
      if (!ok) return { kind: 'failed', error }
      if (reply.status === STATUS_ORPHANED) return { kind: 'orphaned' }
      if (reply.status !== STATUS_RENEWED) return { kind: 'failed', error: String(reply.status) }
      // 租约到期时刻由服务端给出：客户端据此自适应，不硬编码租约时长。
      const leaseExpiresAtValue = leaseExpiresAt(reply)
      return reply.code
        ? { kind: 'renewed', leaseExpiresAt: leaseExpiresAtValue, code: reply.code }
        : { kind: 'renewed', leaseExpiresAt: leaseExpiresAtValue }
    },

    async deliver(state: string, code: string): Promise<DeliveryResult> {
      let lastError = ''
      for (let attempt = 1; attempt <= DELIVERY_ATTEMPTS; attempt += 1) {
        const { ok, reply, error } = await post(deps, DELIVER_PATH, {
          state,
          code,
          delivered_by: deps.instanceId
        })
        if (ok) return reply.status === STATUS_DELIVERED ? 'delivered' : 'orphaned'
        lastError = error
        if (attempt < DELIVERY_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, DELIVERY_RETRY_DELAY_MS))
        }
      }
      // 显式记账，不静默丢弃：接管方投不出去意味着这次登录对发起方彻底无声。
      deps.log(
        `[shell] WARN handoff delivery failed after ${DELIVERY_ATTEMPTS} attempts` +
          ` (${lastError}); the originating instance will not receive this login\n`
      )
      return 'failed'
    },

    async release(state: string): Promise<void> {
      const { ok, error } = await post(deps, RELEASE_PATH, { state, owner_id: deps.instanceId })
      if (!ok) deps.log(`[shell] handoff release skipped (${error})\n`)
    }
  }
}
