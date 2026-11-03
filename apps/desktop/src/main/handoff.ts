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
// 日志只记录状态、原因与 state 的摘要指纹；不记录登录 URL、code 或 token。

import { performance } from 'node:perf_hooks'

import { type HandoffLocalCoordinator } from './handoff-local.ts'
import { handoffFingerprint, newHandoffState, parseCallbackUrl } from './handoff-url.ts'

const FAILURE_CODES = {
  handoffUnclaimed: 'handoff_unclaimed',
  stateMismatch: 'state_mismatch',
} as const

const LOGIN_PAGE_PATH = '/web/login.html'
const EXCHANGE_PATH = '/api/desktop/token'
const LOGIN_EXPIRED = 'login_expired'
const EXPIRED_STATE_MEMORY = 16
const LOGIN_CANCELLED = 'login_cancelled'
const LOGIN_VERIFY_FAILED = 'verify_failed'
export const STATE_TTL_MS = 10 * 60 * 1000
const EXPIRED_STATE_RETENTION_MS = STATE_TTL_MS
/** 已采纳 state 的记忆条数：够盖住「同一条回调被送达两次」的窗口即可，不做无限增长。 */
const ADOPTED_STATE_MEMORY = 8
const EXCHANGE_TIMEOUT_MS = 15_000
export const CONFIRMATION_TIMEOUT_MS = 45_000
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
  /** Binds renderer verification to this login attempt; never contains credentials. */
  confirmationId?: number
  error?: string
  /** 这次 failed 是不是终结型（state 已被清掉）。主进程据此决定要不要重新认领首页
   *  （proposal 73 §6.4）：可重试型不弹，那种情况成功页再点一次真能救回来。
   *  只在客户端可观测 —— 服务端唯一信号 `consumed` 对两类失败完全同形。 */
  terminal?: boolean
}

export interface HandoffDependencies {
  onLoginStarted: () => void
  log: (line: string) => void
  accountBaseUrl: () => Promise<string>
  deviceFields: () => { device_id: string; device_label: string }
  adoptTokens: (token: string, refreshToken: string, isCurrent: () => boolean) => Promise<boolean>
  publish: (snapshot: DesktopAuthSnapshot) => void
  revealWindow: (reason: string) => boolean
  openExternal: (url: string) => Promise<void>
  /** 本机协调腿（proposal 74）。它自己保证不抛：失败即降级成只靠内存 state。 */
  local: HandoffLocalCoordinator
  /** 本机实例身份账（87515374）：实例 id / app 路径 / home。只进日志，不进 UI 与网络。 */
  identity: () => string
  /** 本实例是否 scholarseed:// 的默认处理程序（87515374）：orphaned 时据此区分
   *  「回跳被另一份书深接收」与「发起方已退出 / 租约过期」。 */
  isDefaultProtocolHandler: () => boolean
  /** 采纳结果回报腿（proposal 73 §6.3）。实现必须自己吞掉错误：回报失败不改相位。 */
  reportOutcome: (
    state: string,
    outcome: AdoptOutcome,
    token: string,
    isCurrent: () => boolean
  ) => Promise<void>
}

export class DesktopHandoff {
  private snapshot: DesktopAuthSnapshot = { phase: 'idle' }
  private pendingState = ''
  /** Process-local evidence only; never infer expiry after restart or eviction. */
  private expiredStates = new Map<string, number>()
  /** 最近采纳过的 state：兜底收件箱可能把同一条回调再送一次，见 handleCallback 的去重。 */
  private adoptedStates: string[] = []
  private pendingStartedAt = 0
  private generation = 0
  private exchanging = false
  private activeOperations = 0
  private confirmation: { id: number; state: string; token: string; startedAt: number } | null =
    null
  private confirmationTimer: ReturnType<typeof setTimeout> | null = null
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: HandoffDependencies) {}

  current(): DesktopAuthSnapshot {
    if (this.stateExpired()) {
      // 过期回收对**所有**相位生效：可重试型失败（网络异常/超时）会把 state 留下，只有
      // 这里兜住它，否则一个 failed 相位下的旧 state 能无限期匹配后来的深链。
      this.pruneExpiredStates()
      this.expiredStates.set(this.pendingState, Date.now())
      while (this.expiredStates.size > EXPIRED_STATE_MEMORY) {
        this.expiredStates.delete(this.expiredStates.keys().next().value!)
      }
      this.generation += 1
      this.exchanging = false
      this.abandon(this.pendingState, 'expired')
      this.publish({ phase: 'failed', error: LOGIN_EXPIRED, terminal: true })
    }
    return this.snapshot
  }

  private pruneExpiredStates(): void {
    for (const [state, at] of this.expiredStates) {
      if (Date.now() - at > EXPIRED_STATE_RETENTION_MS) this.expiredStates.delete(state)
    }
  }

  private diagnose(event: string, state: string, detail = ''): void {
    const fingerprint = handoffFingerprint(state)
    this.deps.log(
      `[shell] desktop handoff event=${event} attempt=${fingerprint} generation=${this.generation} phase=${this.snapshot.phase} ${detail} ${this.deps.identity()}\n`
    )
  }

  private async measure<T>(event: string, state: string, operation: () => Promise<T>): Promise<T> {
    const started = performance.now()
    let result = 'failed'
    try {
      const value = await operation()
      result = 'completed'
      return value
    } finally {
      this.diagnose(
        event,
        state,
        `elapsed_ms=${(performance.now() - started).toFixed(3)} result=${result}`
      )
    }
  }

  /** UI phases are intent, not evidence that credential work has finished. */
  isBusy(): boolean {
    this.current()
    return Boolean(this.pendingState || this.confirmation) || this.activeOperations > 0
  }

  private async track<T>(operation: () => Promise<T>): Promise<T> {
    this.activeOperations += 1
    try {
      return await operation()
    } finally {
      this.activeOperations -= 1
    }
  }

  start(language: DesktopLoginLanguage = 'zh'): ReturnType<DesktopHandoff['startFlow']> {
    this.deps.onLoginStarted()
    this.clearConfirmation()
    const generation = ++this.generation
    return this.track(() => this.startFlow(language, generation))
  }

  private async startFlow(
    language: DesktopLoginLanguage,
    generation: number
  ): Promise<{
    ok: boolean
    error?: string
    applicationFailure?: { code: string; diagnostic?: string }
  }> {
    const base = await this.deps.accountBaseUrl()
    if (generation !== this.generation) return { ok: false, error: LOGIN_CANCELLED }
    if (!base)
      return {
        ok: false,
        error: 'account_base_unavailable',
        applicationFailure: { code: 'account_base_unavailable' },
      }
    const superseded = this.pendingState
    this.exchanging = false
    this.stopPolling()
    this.pendingState = newHandoffState()
    this.pendingStartedAt = Date.now()
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer)
    this.expiryTimer = setTimeout(() => this.current(), STATE_TTL_MS)
    if (superseded) {
      this.diagnose('release_requested', superseded, 'reason=superseded')
      void this.track(() => this.deps.local.release(superseded))
    }
    const claimed = this.pendingState
    const url = `${base}${LOGIN_PAGE_PATH}?desktop=1&state=${encodeURIComponent(this.pendingState)}&lang=${language}`
    this.diagnose('start', claimed, `ttl_ms=${STATE_TTL_MS}`)
    try {
      await this.deps.openExternal(url)
    } catch (e) {
      if (generation !== this.generation) return { ok: false, error: LOGIN_CANCELLED }
      this.abandon(this.pendingState, 'browser_failed')
      // 终结型：浏览器都开不出去，这条登录意图已经死了，成功页再点也救不回来。
      this.publish({ phase: 'failed', error: 'open_browser_failed', terminal: true })
      return {
        ok: false,
        error: String(e),
        applicationFailure: { code: 'open_browser_failed', diagnostic: String(e) },
      }
    }
    // 上一轮的 claim 明确放手，不等租约自己过期：否则本机库里会留一个无人续租却仍看似
    // 有效的槽位，那期间到达的深链会被转交进一个没人取走的 code 列。
    if (generation !== this.generation) return { ok: false, error: LOGIN_CANCELLED }
    this.publish({ phase: 'waiting' })
    void this.track(async () => {
      const granted = await this.deps.local.claim(claimed)
      this.diagnose('claim', claimed, `granted=${granted} request_generation=${generation}`)
      if (generation !== this.generation || claimed !== this.pendingState) {
        if (granted) {
          this.diagnose('release_requested', claimed, 'reason=stale_claim')
          await this.deps.local.release(claimed)
        }
        return
      }
      // claim 没拿到也照样轮询：协调层永不挡登录，内存命中那条路一个字没变。
      if (granted) this.startPolling(claimed, generation)
    })
    return { ok: true }
  }

  cancel(): void {
    this.clearConfirmation()
    this.generation += 1
    this.exchanging = false
    this.abandon(this.pendingState, 'cancelled')
    this.publish({ phase: 'idle' })
  }

  private clearConfirmation(): void {
    if (this.confirmationTimer !== null) clearTimeout(this.confirmationTimer)
    this.confirmationTimer = null
    this.confirmation = null
  }

  /** Only the renderer's cookie-authenticated local check can complete login. */
  resetAfterAdopted(id: number, confirmed: boolean): boolean {
    const pending = this.confirmation
    if (
      !pending ||
      pending.id !== id ||
      id !== this.generation ||
      this.snapshot.phase !== 'adopted'
    )
      return false
    this.clearConfirmation()
    this.diagnose(
      'renderer_confirmation',
      pending.state,
      `elapsed_ms=${(performance.now() - pending.startedAt).toFixed(3)} confirmed=${confirmed}`
    )
    this.reportOutcome(id, pending.state, confirmed ? 'adopted' : 'adopt_failed', pending.token)
    this.deps.log(`[shell] desktop login verification ${confirmed ? 'confirmed' : 'failed'}\n`)
    if (confirmed) this.publish({ phase: 'idle' })
    else this.settle(id, { phase: 'failed', error: LOGIN_VERIFY_FAILED }, true)
    return true
  }

  /** 深链回跳。内存命中走原路径；不命中先试本机转交（proposal 74），转不出去才报错。 */
  handleCallback(url: string): Promise<void> {
    return this.track(() => this.handleCallbackFlow(url))
  }

  private async handleCallbackFlow(url: string): Promise<void> {
    const parsed = parseCallbackUrl(url)
    if (!parsed) {
      // An unrelated malformed callback cannot replace an in-flight confirmation.
      if (this.confirmation) {
        this.deps.log('[shell] malformed callback ignored during local verification\n')
        return
      }
      this.publish({ phase: 'failed', error: 'bad_callback', terminal: true })
      return
    }
    this.diagnose('callback_received', parsed.state)
    this.deps.revealWindow('desktop login callback received')
    if (this.adoptedStates.includes(parsed.state)) {
      // 同一条回调可能被送达两次：单实例通知成功的机器上，二次实例取锁失败仍会把回调
      // 停进收件箱（87498884 的兜底腿），主实例于是先收 second-instance 再收 inbox 副本。
      // 已采纳的 state 再走一遍只会把终态失败弹窗盖在成功登录上，直接忽略。
      this.deps.log('[shell] desktop handoff callback ignored: state already adopted\n')
      return
    }
    this.current()
    this.pruneExpiredStates()
    if (this.expiredStates.has(parsed.state)) {
      const preserve =
        Boolean(this.pendingState || this.confirmation) || this.snapshot.error !== LOGIN_EXPIRED
      this.diagnose('callback_expired', parsed.state, `preserve_current=${preserve}`)
      if (!preserve) this.publish({ phase: 'failed', error: LOGIN_EXPIRED, terminal: true })
      return
    }
    if (this.exchanging || this.confirmation) {
      // 成功页每点一次按钮都申领一个新 code 打同一个 state 回来。放行第二次交换，先到的
      // 那次一收尾就把 state 清了，后到的那次必然自伤 —— 忽略即可，在飞那次仍会出结论。
      this.deps.log('[shell] desktop handoff callback ignored: exchange already in flight\n')
      return
    }
    if (!this.pendingState || parsed.state !== this.pendingState || this.stateExpired()) {
      // 内存不命中**不等于**这次登录无效：它可能属于本机另一个书深实例。深链归属由
      // OS 决定，所以接管方唯一能做的正确动作是把 code 转交给真正的发起方。
      const generation = this.generation
      const delivered = await this.measure('local_forward', parsed.state, () =>
        this.deps.local.deliver(parsed.state, parsed.code)
      )
      this.diagnose('forward', parsed.state, `result=${delivered} request_generation=${generation}`)
      if (
        generation !== this.generation ||
        this.pendingState ||
        this.confirmation ||
        this.snapshot.phase === 'adopted'
      ) {
        this.diagnose('callback_ignored', parsed.state, 'reason=current_attempt_preserved')
        return
      }
      if (delivered === 'delivered') {
        this.deps.log('[shell] desktop handoff code forwarded to the originating instance\n')
        return
      }
      // orphaned（无 claim / 租约过期 / 自投）与传输失败都退回既有行为：不交换，只报错。
      // 安全语义一个字没放宽 —— 无主的深链仍然终结型失败。
      if (delivered === 'failed') {
        this.deps.log(
          `[shell] WARN desktop handoff forwarding unavailable; reporting mismatch ${this.deps.identity()}\n`
        )
      }
      // 终结型：本机上没有任何实例认领这个 state，这条登录意图已死。首页若已被关掉，
      // 要靠这个 terminal 标记把它重新弹出来（proposal 73 §6.4），否则失败全程无声。
      if (delivered === 'orphaned') {
        // 87515374 真机：安装版/安装盘/本地开发版混用时，深链常被 LaunchServices 投给非
        // 发起副本，而两者 home 不同使本机协调结构性不可达。只含 state 的账分不清「回跳
        // 投错副本」与「发起方已退出」，补默认处理程序判定与实例身份（app/home）。
        this.deps.log(
          '[shell] desktop handoff rejected unclaimed callback ' +
            `defaultHandler=${this.deps.isDefaultProtocolHandler()} ${this.deps.identity()}\n`
        )
      }
      // orphaned 与其余不匹配分开报错：前者是「本机无人认领这个 state」，给用户多副本 /
      // 安装态的可操作指引；state_mismatch 保留给转交传输失败等情形。
      this.publish({
        phase: 'failed',
        error:
          delivered === 'orphaned' ? FAILURE_CODES.handoffUnclaimed : FAILURE_CODES.stateMismatch,
        terminal: true,
      })
      return
    }
    this.diagnose('received', parsed.state, 'source=callback')
    this.beginExchange(parsed.code, parsed.state, this.generation)
  }

  private stateExpired(): boolean {
    return Boolean(this.pendingState) && Date.now() - this.pendingStartedAt >= STATE_TTL_MS
  }

  private publish(next: DesktopAuthSnapshot): void {
    this.diagnose(
      'transition',
      this.pendingState,
      `next=${next.phase} terminal=${next.terminal ?? false}`
    )
    this.snapshot = next
    this.deps.publish(next)
  }

  /** 停轮询并放手本机 claim。终态、取消与过期回收都经这里，不漏任何一个出口。 */
  private abandon(state: string, reason = 'settled'): void {
    if (state)
      this.diagnose(
        'release_requested',
        state,
        `reason=${reason} age_ms=${Date.now() - this.pendingStartedAt} ttl_ms=${STATE_TTL_MS}`
      )
    this.stopPolling()
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer)
    this.expiryTimer = null
    this.pendingState = ''
    if (state) void this.track(() => this.deps.local.release(state))
  }

  private startPolling(state: string, generation: number): void {
    this.stopPolling()
    this.pollTimer = setInterval(() => {
      void this.track(() => this.poll(state, generation))
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
      this.diagnose('lease_lost', state, 'reason=orphaned')
      this.stopPolling()
      return
    }
    if (!result.code) return
    this.diagnose('received', state, 'source=local_coordination')
    this.beginExchange(result.code, state, generation)
  }

  private beginExchange(code: string, state: string, generation: number): void {
    this.exchanging = true
    this.stopPolling()
    this.publish({ phase: 'exchanging' })
    void this.track(() => this.exchange(code, state, generation))
  }

  /** 在飞交换的唯一收尾口：代次已变说明这次交接被新的发起/取消取代，结果一律丢弃。 */
  private settle(generation: number, next: DesktopAuthSnapshot, terminal: boolean): void {
    if (generation !== this.generation) {
      this.deps.log(`[shell] desktop handoff result discarded (stale): ${next.phase}\n`)
      return
    }
    // 失败相位此前只在 UI 露文案、不落日志（87498884 真机排查时只能看到 handoff failed
    // 而拿不到错误码）。只记错误码与终态标记，不记 token / code。
    if (next.phase === 'failed') {
      this.deps.log(
        `[shell] desktop handoff settled failed error=${next.error ?? 'unknown'} terminal=${terminal} ${this.deps.identity()}\n`
      )
    }
    this.diagnose(
      'settle',
      this.pendingState,
      `next=${next.phase} terminal=${terminal} age_ms=${Date.now() - this.pendingStartedAt}`
    )
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
    void this.track(() =>
      this.measure('receipt', state, () =>
        this.deps.reportOutcome(state, outcome, token, () => generation === this.generation)
      )
    )
  }

  private async exchange(code: string, state: string, generation: number): Promise<void> {
    const base = await this.measure('account_base', state, () => this.deps.accountBaseUrl())
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
      const { resp, body } = await this.measure('exchange_http', state, async () => {
        const resp = await fetch(base + EXCHANGE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code, state, ...this.deps.deviceFields() }),
          signal: ctl.signal,
        })
        clearTimeout(timer)
        const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>
        return { resp, body }
      })
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
      const isCurrent = (): boolean =>
        generation === this.generation && state === this.pendingState && !this.stateExpired()
      if (!isCurrent()) return
      const adopted = await this.measure('credential_adoption', state, () =>
        this.deps.adoptTokens(token, refreshToken, isCurrent)
      )
      if (!isCurrent()) return
      if (!adopted) {
        // adopt 失败时 token 仍在手且服务端签发的 access token 有效（refresh 已落盘、
        // cookie 已设过，只有 catch 才返回 false），所以这一路回报是可行的。
        this.reportOutcome(generation, state, 'adopt_failed', token)
        this.settle(generation, { phase: 'failed', error: 'adopt_failed' }, true)
        return
      }
      this.deps.log('[shell] desktop login credentials stored; awaiting local verification\n')
      this.adoptedStates = [...this.adoptedStates, state].slice(-ADOPTED_STATE_MEMORY)
      this.confirmation = { id: generation, state, token, startedAt: performance.now() }
      this.confirmationTimer = setTimeout(() => {
        this.deps.log('[shell] desktop login verification failed reason=confirmation_timeout\n')
        this.resetAfterAdopted(generation, false)
      }, CONFIRMATION_TIMEOUT_MS)
      this.settle(generation, { phase: 'adopted', confirmationId: generation }, true)
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
