// handoff.ts — 桌面登录交接：官网浏览器登录 + scholarseed:// 深链一次性 code 交换。
//
// 桌面端在这条链路里是一个状态机：start（生成 state、开系统浏览器）→ waiting →
// （深链回跳且 state 匹配）exchanging →（code 换双 token 并采纳）adopted；任一环节
// 不成立即 failed 留在首页可重试。渲染层挂载时用 `scholarseed:desktop-auth-state` 取回
// 当前快照 —— 深链早于渲染层到达也不会丢。
//
// **归属真值不在内存里**（proposal 74）：`scholarseed://` 的归属由 macOS LaunchServices
// 决定，不由「谁发起了这次登录」决定，所以深链可能落到一个内存里没有该 state 的实例上。
// `pendingState` 因此只是**快取**，真值是本机 serve 里一条带租约的 claim：内存不命中时
// 先查本机协调层，能把 code 转交给发起方就转交，转不出去才判 state_mismatch。进程崩溃
// 或退出即不再续租，租约到期 claim 无主 —— 「重启后重新登录」由租约表达，不靠进程探活，
// fail-closed 的性质与之前一致。
//
// 四条不变式约束并发（旧的成功页可以反复申领新 code 打同一个 state 回来）：
//
// 1. **一次交接只允许一次在飞交换**：`exchanging` 期间再到的回跳一律忽略。放行第二次，
//    先到的那次收尾就会把 state 清掉，后到的那次必然自伤成 state_mismatch。
// 2. **交换收尾按代次守卫**：`start` / `cancel` 都推进 `generation`，在飞交换只在代次
//    未变时才允许改 state 与相位。否则「交换在飞时用户回客户端重新发起登录」会被旧交换
//    的收尾抹掉刚建好的新 state。**轮询结果走同一条守卫**：renew 回来时若已 start 过
//    新一轮，那个 code 属于上一轮，一律丢弃。
// 3. 清空 state 只发生在**终结型**结论上（交换有了明确答复：成功 / 非 2xx / 缺 token /
//    采纳失败）。网络异常、超时、账号服务地址暂不可得属于**可重试型**，state 保留到 TTL
//    到期为止 —— 那种情况下成功页再点一次是真能救回来的，不该逼用户回客户端重走。
// 4. **过期回收覆盖所有相位**：可重试型失败会把 state 留下，只有 `current()` 兜住它。
//
// 轮询节奏与租约的分工：轮询间隔是客户端行为（本文件持有），租约时长是服务端不变式
// （持久层持有）。客户端**不硬编码租约**，只按 claim/renew 回的 `lease_expires_at`
// 自适应 —— 两个值分散在两种语言里时，耦合约束只能靠这种单向真源守住。
//
// 日志纪律：code 是凭据，pushLog 只打相位与错误码，绝不打原值；state 只是随 URL 明文
// 传递的 nonce（浏览器历史本来就会留下），登录 URL 整条入日志供排障与验收定位。

import { type HandoffLocalCoordinator } from './handoff-local.ts'
import { newHandoffState, parseCallbackUrl } from './handoff-url.ts'

const LOGIN_PAGE_PATH = '/web/login.html'
const EXCHANGE_PATH = '/api/desktop/token'
export const STATE_TTL_MS = 10 * 60 * 1000
const EXCHANGE_TIMEOUT_MS = 15_000
/** 本机协调轮询间隔。它就是「接管方投递完成 → 发起方取走」这段延迟的直接上界，而这段
 *  延迟叠加在用户已经在等待的链路末端：更密没有收益（本机 SQLite 单行读成本可忽略，
 *  但也没必要），更疏则直接变成可感知的卡顿。 */
export const LOCAL_POLL_INTERVAL_MS = 500

export type DesktopAuthPhase = 'idle' | 'waiting' | 'exchanging' | 'adopted' | 'failed'
export type DesktopLoginLanguage = 'zh' | 'en'

/** 采纳结果回报（proposal 73 §6.3）。exchange 失败的两类不在此列：那两种情况下客户端
 *  根本没换到 token，拿不出 Bearer 凭据回报。 */
export type AdoptOutcome = 'adopted' | 'adopt_failed'

export interface DesktopAuthSnapshot {
  phase: DesktopAuthPhase
  error?: string
  /** 这次 failed 是不是终结型（state 已被清掉）。主进程据此决定要不要重新认领首页
   *  （proposal 73 §6.4）：可重试型不弹，那种情况成功页再点一次真能救回来。
   *  只在客户端可观测 —— 服务端唯一信号 `consumed` 对两类失败完全同形。 */
  terminal?: boolean
}

export interface HandoffDependencies {
  log: (line: string) => void
  accountBaseUrl: () => Promise<string>
  deviceFields: () => { device_id: string; device_label: string }
  adoptTokens: (token: string, refreshToken: string) => Promise<boolean>
  publish: (snapshot: DesktopAuthSnapshot) => void
  revealWindow: (reason: string) => boolean
  openExternal: (url: string) => Promise<void>
  /** 本机协调腿（proposal 74）。它自己保证不抛：失败即降级成只靠内存 state。 */
  local: HandoffLocalCoordinator
  /** 采纳结果回报腿（proposal 73 §6.3）。实现必须自己吞掉错误：回报失败不改相位。 */
  reportOutcome: (state: string, outcome: AdoptOutcome, token: string) => Promise<void>
}

export class DesktopHandoff {
  private snapshot: DesktopAuthSnapshot = { phase: 'idle' }
  private pendingState = ''
  private pendingStartedAt = 0
  private generation = 0
  private exchanging = false
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: HandoffDependencies) {}

  current(): DesktopAuthSnapshot {
    if (this.stateExpired()) {
      // 过期回收对**所有**相位生效：可重试型失败（网络异常/超时）会把 state 留下，只有
      // 这里兜住它，否则一个 failed 相位下的旧 state 能无限期匹配后来的深链。
      this.abandon(this.pendingState)
      if (this.snapshot.phase === 'waiting') this.publish({ phase: 'idle' })
    }
    return this.snapshot
  }

  async start(language: DesktopLoginLanguage = 'zh'): Promise<{ ok: boolean; error?: string; applicationFailure?: { code: string; diagnostic?: string } }> {
    const base = await this.deps.accountBaseUrl()
    if (!base) return { ok: false, error: 'account_base_unavailable', applicationFailure: { code: 'account_base_unavailable' } }
    const superseded = this.pendingState
    this.generation += 1
    this.exchanging = false
    this.stopPolling()
    this.pendingState = newHandoffState()
    this.pendingStartedAt = Date.now()
    const url = `${base}${LOGIN_PAGE_PATH}?desktop=1&state=${encodeURIComponent(this.pendingState)}&lang=${language}`
    this.deps.log(`[shell] opening system browser for account login (desktop handoff): ${url}\n`)
    try {
      await this.deps.openExternal(url)
    } catch (e) {
      this.pendingState = ''
      // 终结型：浏览器都开不出去，这条登录意图已经死了，成功页再点也救不回来。
      this.publish({ phase: 'failed', error: 'open_browser_failed', terminal: true })
      return { ok: false, error: String(e), applicationFailure: { code: 'open_browser_failed', diagnostic: String(e) } }
    }
    // 上一轮的 claim 明确放手，不等租约自己过期：否则本机库里会留一个无人续租却仍看似
    // 有效的槽位，那期间到达的深链会被转交进一个没人取走的 code 列。
    if (superseded) void this.deps.local.release(superseded)
    this.publish({ phase: 'waiting' })
    const claimed = this.pendingState
    void this.deps.local.claim(claimed).then((granted) => {
      // claim 没拿到也照样轮询：协调层永不挡登录，内存命中那条路一个字没变。
      if (granted) this.startPolling(claimed, this.generation)
    })
    return { ok: true }
  }

  cancel(): void {
    this.generation += 1
    this.exchanging = false
    this.abandon(this.pendingState)
    this.publish({ phase: 'idle' })
  }

  /** 渲染层关首页、跑完采纳后置链路后调用：把 adopted 收回 idle，快照不粘住。 */
  resetAfterAdopted(): void {
    if (this.snapshot.phase === 'adopted') this.publish({ phase: 'idle' })
  }

  /** 深链回跳。内存命中走原路径；不命中先试本机转交（proposal 74），转不出去才报错。 */
  async handleCallback(url: string): Promise<void> {
    const parsed = parseCallbackUrl(url)
    if (!parsed) {
      this.publish({ phase: 'failed', error: 'bad_callback', terminal: true })
      return
    }
    this.deps.revealWindow('desktop login callback received')
    if (this.exchanging) {
      // 成功页每点一次按钮都申领一个新 code 打同一个 state 回来。放行第二次交换，先到的
      // 那次一收尾就把 state 清了，后到的那次必然自伤 —— 忽略即可，在飞那次仍会出结论。
      this.deps.log('[shell] desktop handoff callback ignored: exchange already in flight\n')
      return
    }
    if (!this.pendingState || parsed.state !== this.pendingState || this.stateExpired()) {
      // 内存不命中**不等于**这次登录无效：它可能属于本机另一个书深实例。深链归属由
      // OS 决定，所以接管方唯一能做的正确动作是把 code 转交给真正的发起方。
      const delivered = await this.deps.local.deliver(parsed.state, parsed.code)
      if (delivered === 'delivered') {
        this.deps.log('[shell] desktop handoff code forwarded to the originating instance\n')
        return
      }
      // orphaned（无 claim / 租约过期 / 自投）与传输失败都退回既有行为：不交换，只报错。
      // 安全语义一个字没放宽 —— 无主的深链仍然判 state_mismatch。
      if (delivered === 'failed') {
        this.deps.log('[shell] WARN desktop handoff forwarding unavailable; reporting mismatch\n')
      }
      // 终结型：本机上没有任何实例认领这个 state，这条登录意图已死。首页若已被关掉，
      // 要靠这个 terminal 标记把它重新弹出来（proposal 73 §6.4），否则失败全程无声。
      this.publish({ phase: 'failed', error: 'state_mismatch', terminal: true })
      return
    }
    this.beginExchange(parsed.code, parsed.state, this.generation)
  }

  private stateExpired(): boolean {
    return Boolean(this.pendingState) && Date.now() - this.pendingStartedAt > STATE_TTL_MS
  }

  private publish(next: DesktopAuthSnapshot): void {
    this.snapshot = next
    this.deps.publish(next)
  }

  /** 停轮询并放手本机 claim。终态、取消与过期回收都经这里，不漏任何一个出口。 */
  private abandon(state: string): void {
    this.stopPolling()
    this.pendingState = ''
    if (state) void this.deps.local.release(state)
  }

  private startPolling(state: string, generation: number): void {
    this.stopPolling()
    this.pollTimer = setInterval(() => {
      void this.poll(state, generation)
    }, LOCAL_POLL_INTERVAL_MS)
  }

  private stopPolling(): void {
    if (this.pollTimer === null) return
    clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  /** 续租 + 查转交 + 原子取走（服务端三合一）。取到的 code 走同一个 exchange()。 */
  private async poll(state: string, generation: number): Promise<void> {
    // 过期回收（不变式 4）不能依赖渲染层来拉快照：首页被关掉之后没人再调 current()，
    // 这个循环就会对着一个已过期的 state 一直空转到进程退出。轮询自己每轮走一次。
    this.current()
    if (generation !== this.generation || state !== this.pendingState) {
      this.stopPolling()
      return
    }
    // 在飞交换期间**绝不**取 code：renew 是原子取走，取下来的 code 若因为「已有交换在飞」
    // 被丢掉，就永久消失了（它在那一刻已被服务端消费掉的可能也在）。
    if (this.exchanging) return
    const result = await this.deps.local.renew(state)
    // 代次守卫（不变式 2）：结果回来时用户可能已经回客户端重新发起登录，这个 code 属于
    // 上一轮，用它去交换只会把一个过期结果写到不相干的记录上。
    if (generation !== this.generation || state !== this.pendingState) return
    if (result.kind === 'failed') {
      // 续租失败必须重试，不得一次失败就终止登录：一次 serve 抖动或 SQLite BUSY 不该让
      // 用户正在进行的登录作废。轮询本身就是重试预算，耗尽由 state TTL 兜底。
      this.deps.log(`[shell] WARN handoff lease renewal failed: ${result.error}\n`)
      return
    }
    if (result.kind === 'orphaned') {
      // 租约没了 = 本机协调对这次登录已无话可说。内存 state 仍在，深链直接命中那条路
      // 一个字没变，所以只停轮询，不改相位、不报错。
      this.deps.log('[shell] handoff claim no longer leased; stopping local coordination\n')
      this.stopPolling()
      return
    }
    if (!result.code) return
    this.deps.log('[shell] desktop handoff code received via local coordination\n')
    this.beginExchange(result.code, state, generation)
  }

  private beginExchange(code: string, state: string, generation: number): void {
    this.exchanging = true
    this.stopPolling()
    this.publish({ phase: 'exchanging' })
    void this.exchange(code, state, generation)
  }

  /** 在飞交换的唯一收尾口：代次已变说明这次交接被新的发起/取消取代，结果一律丢弃。 */
  private settle(generation: number, next: DesktopAuthSnapshot, terminal: boolean): void {
    if (generation !== this.generation) {
      this.deps.log(`[shell] desktop handoff result discarded (stale): ${next.phase}\n`)
      return
    }
    this.exchanging = false
    if (terminal) {
      this.abandon(this.pendingState)
    } else {
      // 可重试型：state 留着，本机 claim 也留着继续续租 —— 成功页再点一次可能又被别的
      // 实例接管，那条转交路必须还活着。
      const state = this.pendingState
      if (state) this.startPolling(state, generation)
    }
    this.publish(next.phase === 'failed' ? { ...next, terminal } : next)
  }

  /** 回报采纳结果。代次不符时**不回报**：那次交接已被新的发起取代，回报它只会把一个
   *  过期结果写到一行不相干的记录上（与 settle 的早退同一条理由）。 */
  private reportOutcome(
    generation: number,
    state: string,
    outcome: AdoptOutcome,
    token: string
  ): void {
    if (generation !== this.generation) return
    void this.deps.reportOutcome(state, outcome, token)
  }

  private async exchange(code: string, state: string, generation: number): Promise<void> {
    const base = await this.deps.accountBaseUrl()
    if (!base) {
      this.settle(generation, { phase: 'failed', error: 'account_base_unavailable' }, false)
      return
    }
    // abort 定时器必须在 finally 里清：fetch 一抛，紧跟其后的 clearTimeout 就到不了，
    // 定时器会一直吊到 15 秒后自己触发 —— 每次可重试型失败都漏一个（实测把单测套件
    // 拖长 15 秒）。fetch 成功后的那次早清保留，免得 adoptTokens 期间还白吊着。
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), EXCHANGE_TIMEOUT_MS)
    try {
      const resp = await fetch(base + EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, state, ...this.deps.deviceFields() }),
        signal: ctl.signal
      })
      clearTimeout(timer)
      const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>
      if (!resp.ok) {
        // 非 2xx：没有 token，无法回报（proposal 73 §6.3 的硬约束，不是遗漏）。
        this.settle(
          generation,
          { phase: 'failed', error: String(body.code || 'handoff_invalid') },
          true
        )
        return
      }
      // token 只存在于这个词法作用域：settle 的签名不含它，所以回报必须写在这里的两个
      // 调用点上，不能挪进 settle。
      const token = String(body.token || '')
      const refreshToken = String(body.refresh_token || '')
      if (!token || !refreshToken) {
        this.settle(generation, { phase: 'failed', error: 'handoff_invalid' }, true)
        return
      }
      const adopted = await this.deps.adoptTokens(token, refreshToken)
      if (!adopted) {
        // adopt 失败时 token 仍在手且服务端签发的 access token 有效（refresh 已落盘、
        // cookie 已设过，只有 catch 才返回 false），所以这一路回报是可行的。
        this.reportOutcome(generation, state, 'adopt_failed', token)
        this.settle(generation, { phase: 'failed', error: 'adopt_failed' }, true)
        return
      }
      this.deps.log('[shell] desktop login handoff completed; session adopted\n')
      this.reportOutcome(generation, state, 'adopted', token)
      this.settle(generation, { phase: 'adopted' }, true)
    } catch (e) {
      // 网络异常 / 超时：这一次没有答复，code 也可能根本没被消费。state 留着，成功页
      // 再点一次是能救回来的（终结型失败才断掉这条退路）。
      this.deps.log(`[shell] WARN desktop handoff exchange error: ${String(e)}\n`)
      this.settle(generation, { phase: 'failed', error: 'exchange_error' }, false)
    } finally {
      clearTimeout(timer)
    }
  }
}
