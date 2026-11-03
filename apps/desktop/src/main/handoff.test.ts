import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { AuthenticationOwner } from './authentication.ts'

import {
  type DesktopAuthSnapshot,
  DesktopHandoff,
  LOCAL_POLL_INTERVAL_MS,
  STATE_TTL_MS,
  CONFIRMATION_TIMEOUT_MS,
} from './handoff.ts'
import type { DeliveryResult, HandoffLocalCoordinator, RenewResult } from './handoff-local.ts'
import {
  DESKTOP_AUTH_CALLBACK_PREFIX,
  findCallbackUrl,
  newHandoffState,
  parseCallbackUrl,
} from './handoff-url.ts'
import {
  CALLBACK_TIMING_FLAG,
  callbackTimingLine,
  findCallbackTiming,
  validateCallbackTiming,
} from './handoff-timing.ts'

test('absent timing is rejected before parsing its callback URL', (context) => {
  const OriginalURL = URL
  let constructions = 0
  context.mock.method(
    globalThis,
    'URL',
    class extends OriginalURL {
      constructor(input: string | URL, base?: string | URL) {
        constructions++
        super(input, base)
      }
    }
  )
  for (const value of [null, undefined, 0, 'invalid', []])
    assert.equal(
      validateCallbackTiming(value, `${DESKTOP_AUTH_CALLBACK_PREFIX}?code=secret&state=xyz`),
      null
    )
  assert.equal(constructions, 0)
})

test('callback timing validates keys once and reuses one callback parse when formatting', (context) => {
  const url = `${DESKTOP_AUTH_CALLBACK_PREFIX}?code=secret&state=xyz`
  const timing = {
    schema: 1,
    attempt: '3608bca1e44ea6c4',
    launcher_pid: 12,
    started_at_ms: 1000,
    activate_ms: 1,
    bootstrap_ms: 20,
    signature_ms: 12,
    readiness_ms: 4,
    pre_engine_ms: 25,
  }
  let enumerations = 0
  const observed = new Proxy(timing, {
    ownKeys(target) {
      enumerations++
      return Reflect.ownKeys(target)
    },
  })
  assert.equal(validateCallbackTiming(observed, url), observed)
  assert.equal(enumerations, 1)
  const OriginalURL = URL
  let constructions = 0
  context.mock.method(
    globalThis,
    'URL',
    class extends OriginalURL {
      constructor(input: string | URL, base?: string | URL) {
        constructions++
        super(input, base)
      }
    }
  )
  assert.ok(parseCallbackUrl(url))
  const singleParse = constructions
  constructions = 0
  const line = callbackTimingLine(url, 'open_url', observed, 1100)
  assert.equal(constructions, singleParse)
  assert.doesNotMatch(line, /secret|state=|code=/)
})

test('callback timing accepts only bounded matching diagnostics without exposing credentials', () => {
  const url = `${DESKTOP_AUTH_CALLBACK_PREFIX}?code=SECRET_CODE&state=xyz`
  const timing = {
    schema: 1,
    attempt: '3608bca1e44ea6c4',
    launcher_pid: 12,
    started_at_ms: 1000,
    activate_ms: 1,
    bootstrap_ms: 20,
    signature_ms: 12,
    readiness_ms: 4,
    pre_engine_ms: 25,
  }
  const argument = (value: unknown): string =>
    CALLBACK_TIMING_FLAG + Buffer.from(JSON.stringify(value)).toString('base64url')
  assert.deepEqual(findCallbackTiming([argument(timing)], url), timing)
  const line = callbackTimingLine(url, 'second_instance', timing, 1100)
  assert.match(line, /"delivery_ms":75/)
  assert.match(line, /"attempt":"3608bca1e44ea6c4"/)
  assert.doesNotMatch(line, /SECRET_CODE|xyz|scholarseed:\/\//)
  for (const value of [
    { ...timing, attempt: '0000000000000000' },
    { ...timing, signature_ms: -1 },
    { ...timing, bootstrap_ms: null },
    { ...timing, pre_engine_ms: Infinity },
    { ...timing, launcher_pid: 0 },
    { ...timing, extra: 'SECRET' },
  ])
    assert.equal(findCallbackTiming([argument(value)], url), null)
  assert.equal(findCallbackTiming([argument(timing), argument(timing)], url), null)
  assert.equal(findCallbackTiming([CALLBACK_TIMING_FLAG + '!'], url), null)
  assert.equal(findCallbackTiming([CALLBACK_TIMING_FLAG + 'a'.repeat(8192)], url), null)
  assert.equal(findCallbackTiming([argument(timing)], null), null)
})

test('callback url parses code and state only for the desktop handoff prefix', () => {
  const parsed = parseCallbackUrl(`${DESKTOP_AUTH_CALLBACK_PREFIX}?code=abc&state=xyz`)
  assert.deepEqual(parsed, { code: 'abc', state: 'xyz' })
})

test('callback url matching tolerates URL casing and finds the protocol argv', () => {
  const callbackUrl = 'SCHOLARSEED://AUTH/callback?code=abc&state=xyz'
  assert.deepEqual(parseCallbackUrl(callbackUrl), { code: 'abc', state: 'xyz' })
  assert.equal(findCallbackUrl(['--hidden', callbackUrl]), callbackUrl)
  assert.equal(findCallbackUrl(['--hidden', `"${callbackUrl}"`]), callbackUrl)
  assert.equal(findCallbackUrl(['--hidden', 'https://example.test/callback']), null)
})

test('callback url rejects missing credentials, foreign prefixes and malformed input', () => {
  assert.equal(parseCallbackUrl(`${DESKTOP_AUTH_CALLBACK_PREFIX}?code=abc`), null)
  assert.equal(parseCallbackUrl(`${DESKTOP_AUTH_CALLBACK_PREFIX}?state=xyz`), null)
  // Retired auth paths must not enter the account handoff, even with credentials.
  assert.equal(parseCallbackUrl('scholarseed://auth/complete?token=t'), null)
  assert.equal(parseCallbackUrl('scholarseed://auth/done?code=abc&state=xyz'), null)
  assert.equal(
    parseCallbackUrl('https://example.test/scholarseed://auth/callback?code=a&state=b'),
    null
  )
  assert.equal(parseCallbackUrl('not a url at all'), null)
})

test('handoff state is high-entropy and never repeats', () => {
  const first = newHandoffState()
  const second = newHandoffState()
  assert.ok(first.length >= 43, `state too short: ${first.length}`)
  assert.notEqual(first, second)
})

const ACCOUNT_BASE = 'https://account.test'

test('phase timing separates HTTP, adoption, renderer confirmation and receipt without credentials', async () => {
  let finishReceipt!: () => void
  const receipt = new Promise<void>((resolve) => {
    finishReceipt = resolve
  })
  const host = harness(async () => tokenResponse(), { report: () => receipt })
  try {
    await host.handoff.start()
    const state = stateOf(host.openedUrls[0])
    await host.handoff.handleCallback(callback(state, 'PRIVATE_CODE'))
    await tick()
    const id = host.handoff.current().confirmationId!
    assert.equal(host.handoff.resetAfterAdopted(id, true), true)
    for (const event of [
      'account_base',
      'exchange_http',
      'credential_adoption',
      'renderer_confirmation',
    ]) {
      assert.match(
        host.logs.find((line) => line.includes(`event=${event} `)) ?? '',
        /elapsed_ms=\d+(\.\d+)?/
      )
    }
    assert.equal(
      host.logs.some((line) => line.includes('event=receipt ')),
      false
    )
    finishReceipt()
    await tick()
    assert.match(
      host.logs.find((line) => line.includes('event=receipt ')) ?? '',
      /result=completed/
    )
    assert.doesNotMatch(host.logs.join(''), new RegExp(`PRIVATE_CODE|${state}|refresh_token`))
  } finally {
    finishReceipt()
    host.restore()
  }
})

test('cancelled exchange never calls adoption after its HTTP response arrives', async () => {
  let complete!: (response: Response) => void
  let adoptions = 0
  const response = new Promise<Response>((resolve) => {
    complete = resolve
  })
  const host = harness(() => response, {
    adopt: async () => {
      adoptions += 1
      return true
    },
  })
  try {
    await host.handoff.start()
    await host.handoff.handleCallback(callback(stateOf(host.openedUrls[0])))
    await tick()
    host.handoff.cancel()
    complete(tokenResponse())
    await tick()
    assert.equal(adoptions, 0)
    assert.deepEqual(host.reports, [])
  } finally {
    host.handoff.cancel()
    host.restore()
  }
})

test('handoff producer predicate survives queueing and cancels before owner commit', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const authority = Object.freeze({
    cookieUrl: 'http://serve.test/',
    serveBase: 'http://serve.test',
    namespace: 'test',
  })
  let access = 'A'
  const owner = new AuthenticationOwner({
    authority: () => authority,
    readAccess: async () => {
      await gate
      return access
    },
    setAccess: async (_authority, token) => {
      access = token
    },
    removeAccess: async () => {
      access = ''
    },
    persistence: {
      read: () => ({ status: 'absent' }),
      write: () => ({ status: 'persisted' }),
      remove: () => ({ status: 'absent' }),
    },
    fetch: async () => Response.json({ ok: false }),
    revoke: async () => undefined,
  })
  const intent = await owner.intent()
  assert.ok(!('ok' in intent))
  if ('ok' in intent) return
  const pendingRead = owner.snapshot()
  const host = harness(async () => tokenResponse(), {
    adopt: async (token, refresh, isCurrent) => {
      const adopted = await owner.replace(token, refresh, { ...intent, isCurrent })
      return adopted.ok
    },
  })
  try {
    await host.handoff.start()
    await host.handoff.handleCallback(callback(stateOf(host.openedUrls[0])))
    await tick()
    host.handoff.cancel()
    release()
    await pendingRead
    await tick()
    assert.equal(access, 'A')
    assert.deepEqual(host.reports, [])
  } finally {
    release()
    host.handoff.cancel()
    host.restore()
  }
})

/** 本机协调腿的固件。默认形状是「协调层对本机无话可说」：renew 立刻判无主、deliver 回
 *  orphaned —— 于是既有用例观察到的行为与没有协调层时逐字一致，安全语义没有被放宽。 */
function fakeLocal(): {
  coordinator: HandoffLocalCoordinator
  calls: {
    claim: string[]
    renew: string[]
    deliver: Array<{ state: string; code: string }>
    release: string[]
  }
  setRenew: (result: RenewResult) => void
  setRenewResolver: (resolve: (state: string) => RenewResult) => void
  gateRenew: (gate: Promise<void>) => void
  setDeliver: (result: DeliveryResult) => void
} {
  const calls = {
    claim: [] as string[],
    renew: [] as string[],
    deliver: [] as Array<{ state: string; code: string }>,
    release: [] as string[],
  }
  let renewResolver: (state: string) => RenewResult = () => ({ kind: 'orphaned' })
  let renewGate: Promise<void> | null = null
  let deliverResult: DeliveryResult = 'orphaned'
  return {
    calls,
    setRenew: (result) => {
      renewResolver = () => result
    },
    setRenewResolver: (resolve) => {
      renewResolver = resolve
    },
    gateRenew: (gate) => {
      renewGate = gate
    },
    setDeliver: (result) => {
      deliverResult = result
    },
    coordinator: {
      claim: async (state) => {
        calls.claim.push(state)
        return true
      },
      renew: async (state) => {
        calls.renew.push(state)
        if (renewGate) await renewGate
        return renewResolver(state)
      },
      deliver: async (state, code) => {
        calls.deliver.push({ state, code })
        return deliverResult
      },
      release: async (state) => {
        calls.release.push(state)
      },
    },
  }
}

function tokenResponse(): Response {
  return new Response(JSON.stringify({ token: 't', refresh_token: 'r' }), { status: 200 })
}

interface HarnessOptions {
  accountBase?: () => Promise<string>
  open?: (url: string) => Promise<void>
  report?: (isCurrent: () => boolean) => Promise<void>
  onLoginStarted?: () => void
  defaultHandler?: boolean
  local?: ReturnType<typeof fakeLocal>
  adopt?: (token: string, refreshToken: string, isCurrent: () => boolean) => Promise<boolean>
}

/** 状态机固件：注入全部依赖 + 一个可编程的 fetch 替身，返回观测到的相位序列。 */
function harness(
  exchange: (attempt: number) => Promise<Response>,
  options: HarnessOptions = {}
): {
  handoff: DesktopHandoff
  phases: DesktopAuthSnapshot[]
  logs: string[]
  openedUrls: string[]
  attempts: () => number
  reports: Array<{ state: string; outcome: string; token: string }>
  local: ReturnType<typeof fakeLocal>
  restore: () => void
} {
  const phases: DesktopAuthSnapshot[] = []
  const openedUrls: string[] = []
  const logs: string[] = []
  const reports: Array<{ state: string; outcome: string; token: string }> = []
  const local = options.local ?? fakeLocal()
  let attempt = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    attempt += 1
    return await exchange(attempt)
  }) as typeof globalThis.fetch
  const handoff = new DesktopHandoff({
    onLoginStarted: options.onLoginStarted ?? (() => {}),
    log: (line) => logs.push(line),
    accountBaseUrl: options.accountBase ?? (async () => ACCOUNT_BASE),
    deviceFields: () => ({ device_id: 'd', device_label: 'l' }),
    adoptTokens: options.adopt ?? (async () => true),
    publish: (snapshot) => phases.push(snapshot),
    revealWindow: () => true,
    identity: () => 'instance=test app=/test/ScholarSeed.app home=/test/home',
    isDefaultProtocolHandler: () => options.defaultHandler ?? false,
    openExternal: async (url) => {
      openedUrls.push(url)
      await options.open?.(url)
    },
    local: local.coordinator,
    reportOutcome: async (state, outcome, token, isCurrent) => {
      reports.push({ state, outcome, token })
      await options.report?.(isCurrent)
    },
  })
  return {
    handoff,
    phases,
    logs,
    openedUrls,
    attempts: () => attempt,
    reports,
    local,
    restore: () => {
      handoff.cancel()
      globalThis.fetch = originalFetch
    },
  }
}

function stateOf(url: string): string {
  return new URL(url).searchParams.get('state') || ''
}

function callback(state: string, code = 'c'): string {
  return `${DESKTOP_AUTH_CALLBACK_PREFIX}?code=${code}&state=${encodeURIComponent(state)}`
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

test('desktop login URL carries the selected interface language', async () => {
  const h = harness(async () => tokenResponse())
  try {
    await h.handoff.start('en')
    const opened = new URL(h.openedUrls[0])
    assert.equal(opened.searchParams.get('desktop'), '1')
    assert.equal(opened.searchParams.get('lang'), 'en')
    assert.ok(opened.searchParams.get('state'))
  } finally {
    h.handoff.cancel()
    h.restore()
  }
})

test('a second callback during an in-flight exchange is ignored, not failed', async () => {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = harness(async () => {
    await gate
    return tokenResponse()
  })
  try {
    await h.handoff.start()
    const state = stateOf(h.openedUrls[0])
    await h.handoff.handleCallback(callback(state))
    // 成功页被连点：同一个 state 又回来一次。放行它就会让先到的那次收尾自伤。
    await h.handoff.handleCallback(callback(state, 'c2'))
    release()
    await tick()
    assert.equal(h.attempts(), 1, 'only one exchange may be in flight')
    assert.deepEqual(
      h.phases.map((p) => p.phase),
      ['waiting', 'exchanging', 'adopted']
    )
  } finally {
    h.restore()
  }
})

test('a stale exchange result cannot clobber a newly started handoff', async () => {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = harness(async (attempt) => {
    if (attempt === 1) {
      await gate
      return new Response(JSON.stringify({ code: 'handoff_invalid' }), { status: 400 })
    }
    return tokenResponse()
  })
  try {
    await h.handoff.start()
    await h.handoff.handleCallback(callback(stateOf(h.openedUrls[0])))
    // 用户不等旧交接出结论，回客户端重新发起登录 —— 旧交换的收尾不得动新 state。
    await h.handoff.start()
    const freshState = stateOf(h.openedUrls[1])
    release()
    await tick()
    assert.equal(
      h.phases.at(-1)?.phase,
      'waiting',
      'stale terminal failure must not publish over the new handoff'
    )
    await h.handoff.handleCallback(callback(freshState))
    await tick()
    assert.equal(h.phases.at(-1)?.phase, 'adopted', 'the new handoff must still be exchangeable')
  } finally {
    h.restore()
  }
})

test('network-class exchange failure keeps the state retryable', async () => {
  const h = harness(async (attempt) => {
    if (attempt === 1) throw new Error('socket hang up')
    return tokenResponse()
  })
  try {
    await h.handoff.start()
    const state = stateOf(h.openedUrls[0])
    await h.handoff.handleCallback(callback(state))
    await tick()
    assert.deepEqual(h.phases.at(-1), { phase: 'failed', error: 'exchange_error', terminal: false })
    // 这一次没有答复，code 可能根本没被消费：同一个 state 再回来一次必须还能成。
    await h.handoff.handleCallback(callback(state, 'c2'))
    await tick()
    assert.equal(h.phases.at(-1)?.phase, 'adopted')
  } finally {
    h.restore()
  }
})

test('terminal exchange failure ends the handoff for good', async () => {
  const h = harness(
    async () => new Response(JSON.stringify({ code: 'handoff_invalid' }), { status: 400 })
  )
  try {
    await h.handoff.start()
    const state = stateOf(h.openedUrls[0])
    await h.handoff.handleCallback(callback(state))
    await tick()
    assert.deepEqual(h.phases.at(-1), { phase: 'failed', error: 'handoff_invalid', terminal: true })
    await h.handoff.handleCallback(callback(state, 'c2'))
    assert.deepEqual(h.phases.at(-1), {
      phase: 'failed',
      error: 'handoff_unclaimed',
      terminal: true,
    })
    assert.equal(h.attempts(), 1, 'an ended handoff must not reach the exchange endpoint again')
  } finally {
    h.restore()
  }
})

test('expired state is reclaimed in every phase, not just while waiting', async () => {
  // 不变式 4 此前零覆盖：STATE_TTL_MS 配裸 Date.now()，没有假时钟就不可确定性测试。
  // 这里用 node:test 的 mock.timers 推进 Date，不给产品代码开注入口子。
  mock.timers.enable({ apis: ['Date'] })
  const h = harness(async () => {
    throw new Error('socket hang up')
  })
  try {
    await h.handoff.start()
    const state = stateOf(h.openedUrls[0])
    await h.handoff.handleCallback(callback(state))
    await tick()
    assert.equal(h.phases.at(-1)?.error, 'exchange_error', '可重试型失败会把 state 留下')
    // 留下的 state 若不过期回收，一个 failed 相位下的旧 state 能无限期匹配后来的深链。
    mock.timers.tick(STATE_TTL_MS + 1)
    assert.equal(h.handoff.current().error, 'login_expired')
    h.local.setDeliver('orphaned')
    await h.handoff.handleCallback(callback(state, 'late'))
    await tick()
    assert.equal(h.attempts(), 1, '过期 state 不得再触发交换')
    assert.deepEqual(h.phases.at(-1), {
      phase: 'failed',
      error: 'login_expired',
      terminal: true,
    })
    assert.ok(h.local.calls.release.includes(state), '过期回收要放手本机 claim')
  } finally {
    h.handoff.cancel()
    mock.timers.reset()
    h.restore()
  }
})

test('a memory hit never touches the local coordination leg', async () => {
  const local = fakeLocal()
  const h = harness(async () => tokenResponse(), { local })
  try {
    await h.handoff.start()
    const state = stateOf(h.openedUrls[0])
    assert.deepEqual(local.calls.claim, [state], 'start 要在本机登记 claim')
    await h.handoff.handleCallback(callback(state))
    await tick()
    assert.equal(h.phases.at(-1)?.phase, 'adopted')
    assert.deepEqual(local.calls.deliver, [], '内存命中就是发起方自己，没有转交可言')
    assert.ok(local.calls.release.includes(state), '终结态要 release')
  } finally {
    h.restore()
  }
})

test('a deep link landing on another instance is forwarded, not failed', async () => {
  const local = fakeLocal()
  local.setDeliver('delivered')
  const h = harness(async () => tokenResponse(), { local })
  try {
    // 接管方：本进程从没 start() 过，内存里没有这个 state。
    await h.handoff.handleCallback(callback(newHandoffState(), 'forwarded-code'))
    await tick()
    assert.equal(local.calls.deliver.length, 1, '不命中必须先试转交')
    assert.equal(local.calls.deliver[0]?.code, 'forwarded-code')
    assert.equal(h.attempts(), 0, '接管方绝不拿别人的 code 去交换')
    assert.deepEqual(h.phases, [], '转交成功不进 failed，也不动任何相位')
  } finally {
    h.restore()
  }
})

test('an unclaimed deep link reports handoff_unclaimed with identity', async () => {
  const local = fakeLocal()
  local.setDeliver('orphaned')
  const h = harness(async () => tokenResponse(), { local })
  try {
    await h.handoff.handleCallback(callback(newHandoffState()))
    await tick()
    // 安全回退没有被放宽：无主（无 claim / 租约过期 / 自投）仍然终结型失败；87515374 起
    // 单独报 handoff_unclaimed，给用户多副本 / 安装态的可操作指引。
    assert.deepEqual(h.phases.at(-1), {
      phase: 'failed',
      error: 'handoff_unclaimed',
      terminal: true,
    })
    assert.equal(h.attempts(), 0)
    // 身份账要能自诊：默认处理程序判定 + 实例 / app / home 都落进日志。
    assert.ok(
      h.logs.some(
        (line) =>
          line.includes('rejected unclaimed callback') &&
          line.includes('defaultHandler=false') &&
          line.includes('instance=test') &&
          line.includes('home=/test/home')
      ),
      'orphaned 相位必须落身份账'
    )
  } finally {
    h.restore()
  }
})

test('a forwarding failure keeps state_mismatch and logs identity', async () => {
  const local = fakeLocal()
  local.setDeliver('failed')
  const h = harness(async () => tokenResponse(), { local })
  try {
    await h.handoff.handleCallback(callback(newHandoffState()))
    await tick()
    assert.deepEqual(h.phases.at(-1), { phase: 'failed', error: 'state_mismatch', terminal: true })
    assert.ok(
      h.logs.some(
        (line) => line.includes('forwarding unavailable') && line.includes('instance=test')
      ),
      '转交传输失败要落身份账'
    )
  } finally {
    h.restore()
  }
})

test('a forwarded code reaches the same exchange once the originator polls it', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  const local = fakeLocal()
  const h = harness(async () => tokenResponse(), { local })
  try {
    await h.handoff.start()
    const state = stateOf(h.openedUrls[0])
    // 深链被投给了另一个实例，它已把 code 写进本机 claim 的投递位。
    local.setRenew({ kind: 'renewed', leaseExpiresAt: 1, code: 'forwarded-code' })
    mock.timers.tick(LOCAL_POLL_INTERVAL_MS)
    await tick()
    await tick()
    assert.equal(h.attempts(), 1, '取到的 code 必须走同一个 exchange()')
    assert.equal(h.phases.at(-1)?.phase, 'adopted')
    assert.ok(local.calls.renew.includes(state))
    h.handoff.resetAfterAdopted(h.handoff.current().confirmationId!, true)
    assert.deepEqual(h.reports, [{ state, outcome: 'adopted', token: 't' }])
  } finally {
    h.handoff.cancel()
    mock.timers.reset()
    h.restore()
  }
})

test('a stale poll result cannot start an exchange for a superseded handoff', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  const local = fakeLocal()
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  local.gateRenew(gate)
  const h = harness(async () => tokenResponse(), { local })
  try {
    await h.handoff.start()
    const stale = stateOf(h.openedUrls[0])
    local.setRenewResolver((state) =>
      state === stale
        ? { kind: 'renewed', leaseExpiresAt: 1, code: 'stale-code' }
        : { kind: 'orphaned' }
    )
    // 第一轮 poll 起飞并卡在闸门上（此刻它持有的是代次 1）。
    mock.timers.tick(LOCAL_POLL_INTERVAL_MS)
    await tick()
    // 用户不等它出结论，回客户端重新发起登录 —— 代次推到 2，state 换成新的。
    await h.handoff.start()
    release()
    await tick()
    await tick()
    // 不变式 2：旧 poll 的 renew 此刻才回来，那把 code 属于上一轮，必须被丢弃。
    assert.equal(h.attempts(), 0, '上一轮取到的 code 不得触发交换')
    assert.equal(h.phases.at(-1)?.phase, 'waiting')
  } finally {
    h.handoff.cancel()
    mock.timers.reset()
    h.restore()
  }
})

test('a transient renewal failure keeps the login alive instead of ending it', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  const local = fakeLocal()
  const h = harness(async () => tokenResponse(), { local })
  try {
    await h.handoff.start()
    // 一次 serve 抖动或 SQLite BUSY 不该让正在进行的登录作废：失败要继续重试。
    local.setRenew({ kind: 'failed', error: 'socket hang up' })
    mock.timers.tick(LOCAL_POLL_INTERVAL_MS)
    await tick()
    assert.equal(h.phases.at(-1)?.phase, 'waiting', '续租失败不改相位')
    local.setRenew({ kind: 'renewed', leaseExpiresAt: 1, code: 'late-code' })
    mock.timers.tick(LOCAL_POLL_INTERVAL_MS)
    await tick()
    await tick()
    assert.equal(h.attempts(), 1, '抖动过去之后仍要能取到转交的 code')
  } finally {
    h.handoff.cancel()
    mock.timers.reset()
    h.restore()
  }
})

test('the originator never takes a forwarded code while an exchange is in flight', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  const local = fakeLocal()
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = harness(
    async () => {
      await gate
      return tokenResponse()
    },
    { local }
  )
  try {
    await h.handoff.start()
    const state = stateOf(h.openedUrls[0])
    await h.handoff.handleCallback(callback(state, 'direct-code'))
    local.setRenew({ kind: 'renewed', leaseExpiresAt: 1, code: 'forwarded-code' })
    mock.timers.tick(LOCAL_POLL_INTERVAL_MS)
    await tick()
    // renew 是**原子取走**：在飞期间取下来的 code 会因为「已有交换在飞」被丢掉，
    // 而它此刻已经没了，于是这次登录永久失去那把 code。
    assert.deepEqual(local.calls.renew, [], '在飞交换期间不得 renew')
    release()
    await tick()
    assert.equal(h.attempts(), 1)
  } finally {
    h.handoff.cancel()
    mock.timers.reset()
    h.restore()
  }
})

test('adoption outcome is reported once, with the token that was just exchanged', async () => {
  const h = harness(async () => tokenResponse(), { adopt: async () => false })
  try {
    await h.handoff.start()
    const state = stateOf(h.openedUrls[0])
    await h.handoff.handleCallback(callback(state))
    await tick()
    // adopt 失败时 token 仍在手（refresh 已落盘、cookie 已设过），所以这一路回报可行。
    assert.deepEqual(h.reports, [{ state, outcome: 'adopt_failed', token: 't' }])
    assert.deepEqual(h.phases.at(-1), { phase: 'failed', error: 'adopt_failed', terminal: true })
  } finally {
    h.restore()
  }
})

test('exchange failures are never reported: there is no token to authenticate with', async () => {
  const h = harness(
    async () => new Response(JSON.stringify({ code: 'handoff_invalid' }), { status: 400 })
  )
  try {
    await h.handoff.start()
    await h.handoff.handleCallback(callback(stateOf(h.openedUrls[0])))
    await tick()
    // 硬约束不是遗漏：要让这两类可回报就得开一个免鉴权的写入面。
    assert.deepEqual(h.reports, [])
  } finally {
    h.restore()
  }

  const retryable = harness(async () => {
    throw new Error('socket hang up')
  })
  try {
    await retryable.handoff.start()
    await retryable.handoff.handleCallback(callback(stateOf(retryable.openedUrls[0])))
    await tick()
    assert.deepEqual(retryable.reports, [])
  } finally {
    retryable.restore()
  }
})

test('a discarded stale result is not reported either', async () => {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = harness(
    async (attempt) => {
      if (attempt === 1) {
        await gate
        return tokenResponse()
      }
      return tokenResponse()
    },
    { adopt: async () => false }
  )
  try {
    await h.handoff.start()
    await h.handoff.handleCallback(callback(stateOf(h.openedUrls[0])))
    // 交换在飞时用户重新发起登录：旧交换的收尾会被代次守卫丢弃，回报也必须一起丢 ——
    // 否则会把一个过期结果写到一行不相干的记录上。
    await h.handoff.start()
    release()
    await tick()
    assert.deepEqual(h.reports, [])
    assert.equal(h.phases.at(-1)?.phase, 'waiting')
  } finally {
    h.restore()
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('cancelled exchange remains busy until response completes and never adopts stale credentials', async () => {
  const response = deferred<Response>()
  let adopted = 0
  const h = harness(() => response.promise, {
    adopt: async () => {
      adopted++
      return true
    },
  })
  try {
    await h.handoff.start()
    await h.handoff.handleCallback(callback(stateOf(h.openedUrls[0])))
    h.handoff.cancel()
    assert.equal(h.handoff.current().phase, 'idle')
    assert.equal(h.handoff.isBusy(), true)
    response.resolve(tokenResponse())
    await tick()
    assert.equal(adopted, 0)
    assert.equal(h.handoff.isBusy(), false)
  } finally {
    response.resolve(tokenResponse())
    h.restore()
  }
})

test('cancelling during credential adoption does not release its execution ownership', async () => {
  const adoption = deferred<boolean>()
  let started = false
  const h = harness(async () => tokenResponse(), {
    adopt: async () => {
      started = true
      return adoption.promise
    },
  })
  try {
    await h.handoff.start()
    await h.handoff.handleCallback(callback(stateOf(h.openedUrls[0])))
    await tick()
    assert.equal(started, true)
    h.handoff.cancel()
    assert.equal(h.handoff.isBusy(), true)
    adoption.resolve(true)
    await tick()
    assert.equal(h.handoff.isBusy(), false)
    assert.equal(h.handoff.current().phase, 'idle')
    assert.deepEqual(h.reports, [])
  } finally {
    adoption.resolve(true)
    h.restore()
  }
})

test('a late claim is released after cancellation and cleanup remains busy', async () => {
  const claim = deferred<boolean>()
  const release = deferred<void>()
  const local = fakeLocal()
  let releases = 0
  local.coordinator.claim = () => claim.promise
  local.coordinator.release = async () => {
    releases++
    await release.promise
  }
  const h = harness(async () => tokenResponse(), { local })
  try {
    await h.handoff.start()
    h.handoff.cancel()
    assert.equal(h.handoff.isBusy(), true)
    claim.resolve(true)
    await tick()
    assert.equal(releases, 2, 'late claim must be cleaned even when an earlier release raced ahead')
    assert.equal(h.handoff.isBusy(), true)
    release.resolve()
    await tick()
    assert.equal(h.handoff.isBusy(), false)
    assert.equal(h.handoff.current().phase, 'idle')
  } finally {
    claim.resolve(true)
    release.resolve()
    h.restore()
  }
})

test('memory-only login remains busy until the user cancels it', async () => {
  const local = fakeLocal()
  local.coordinator.claim = async () => false
  const h = harness(async () => tokenResponse(), { local })
  try {
    await h.handoff.start()
    await tick()
    assert.equal(h.handoff.isBusy(), true)
    h.handoff.cancel()
    await tick()
    assert.equal(h.handoff.isBusy(), false)
  } finally {
    h.handoff.cancel()
    h.restore()
  }
})

test('callback forwarding remains busy without a local pending login', async () => {
  const delivery = deferred<DeliveryResult>()
  const local = fakeLocal()
  local.coordinator.deliver = () => delivery.promise
  const h = harness(async () => tokenResponse(), { local })
  try {
    const callbackResult = h.handoff.handleCallback(callback('other-instance'))
    assert.equal(h.handoff.isBusy(), true)
    h.handoff.cancel()
    assert.equal(h.handoff.isBusy(), true)
    delivery.resolve('delivered')
    await callbackResult
    assert.equal(h.handoff.isBusy(), false)
  } finally {
    delivery.resolve('delivered')
    h.restore()
  }
})

test('start cancels restart intent synchronously and cancellation cannot resurrect a pending URL lookup', async () => {
  const base = deferred<string>()
  const intent = new AbortController()
  const h = harness(async () => tokenResponse(), {
    accountBase: () => base.promise,
    onLoginStarted: () => intent.abort(),
  })
  try {
    const starting = h.handoff.start()
    assert.equal(intent.signal.aborted, true)
    assert.equal(h.handoff.isBusy(), true)
    h.handoff.cancel()
    base.resolve(ACCOUNT_BASE)
    assert.deepEqual(await starting, { ok: false, error: 'login_cancelled' })
    assert.deepEqual(h.openedUrls, [])
    assert.equal(h.handoff.isBusy(), false)
  } finally {
    base.resolve(ACCOUNT_BASE)
    h.restore()
  }
})

test('a browser launch completing after cancel cannot publish waiting or claim a login', async () => {
  const browser = deferred<void>()
  const h = harness(async () => tokenResponse(), { open: () => browser.promise })
  try {
    const starting = h.handoff.start()
    await tick()
    h.handoff.cancel()
    assert.equal(h.handoff.isBusy(), true)
    browser.resolve()
    assert.deepEqual(await starting, { ok: false, error: 'login_cancelled' })
    await tick()
    assert.equal(h.handoff.isBusy(), false)
    assert.equal(h.handoff.current().phase, 'idle')
    assert.deepEqual(h.local.calls.claim, [])
  } finally {
    browser.resolve()
    h.restore()
  }
})

test('adoption outcome reporting keeps the owner busy after terminal success', async () => {
  const reporting = deferred<void>()
  const h = harness(async () => tokenResponse(), { report: () => reporting.promise })
  try {
    await h.handoff.start()
    await h.handoff.handleCallback(callback(stateOf(h.openedUrls[0])))
    await tick()
    assert.equal(h.handoff.current().phase, 'adopted')
    assert.equal(h.handoff.isBusy(), true)
    h.handoff.resetAfterAdopted(h.handoff.current().confirmationId!, true)
    reporting.resolve()
    await tick()
    assert.equal(h.handoff.isBusy(), false)
  } finally {
    reporting.resolve()
    h.restore()
  }
})

test('已采纳 state 的重复回调被忽略，不再盖终态失败弹窗', async () => {
  const h = harness(async () => tokenResponse())
  try {
    await h.handoff.start()
    const state = stateOf(h.openedUrls[0])
    await h.handoff.handleCallback(callback(state))
    await tick()
    assert.equal(h.phases.at(-1)?.phase, 'adopted')
    const published = h.phases.length
    // 兜底收件箱把同一条回调再送一次（单实例通知与 inbox 双送达，87498884 真机实测）。
    await h.handoff.handleCallback(callback(state, 'c2'))
    await tick()
    assert.equal(h.phases.length, published, 'duplicate callback must not publish')
    assert.ok(h.logs.some((line) => line.includes('state already adopted')))
  } finally {
    h.restore()
  }
})

test('失败相位落日志带错误码，不含 token', async () => {
  const h = harness(async () => new Response(JSON.stringify({ code: 'consumed' }), { status: 400 }))
  try {
    await h.handoff.start()
    const state = stateOf(h.openedUrls[0])
    await h.handoff.handleCallback(callback(state, 'SECRET_TOKEN_VALUE'))
    await tick()
    assert.equal(h.phases.at(-1)?.phase, 'failed')
    assert.equal(h.phases.at(-1)?.error, 'consumed')
    const settled = h.logs.filter((line) => line.includes('settled failed'))
    assert.equal(settled.length, 1)
    assert.ok(settled[0]?.includes('error=consumed'))
    assert.ok(!settled[0]?.includes('SECRET_TOKEN_VALUE'))
  } finally {
    h.restore()
  }
})

test('stored credentials do not report success until local verification acknowledges the same attempt', async () => {
  const h = harness(async () => tokenResponse())
  try {
    await h.handoff.start()
    const state = stateOf(h.openedUrls[0])
    await h.handoff.handleCallback(callback(state))
    await tick()
    assert.deepEqual(h.reports, [])
    const id = h.handoff.current().confirmationId!
    assert.equal(h.handoff.resetAfterAdopted(id, true), true)
    assert.deepEqual(h.reports, [{ state, outcome: 'adopted', token: 't' }])
    assert.equal(h.handoff.resetAfterAdopted(id, true), false)
    assert.equal(h.reports.length, 1)
  } finally {
    h.handoff.cancel()
    h.restore()
  }
})

for (const action of ['cancel', 'restart'] as const) {
  test(`late verification after ${action} cannot report success or overwrite the current attempt`, async () => {
    const h = harness(async () => tokenResponse())
    try {
      await h.handoff.start()
      await h.handoff.handleCallback(callback(stateOf(h.openedUrls[0])))
      await tick()
      const id = h.handoff.current().confirmationId!
      if (action === 'cancel') h.handoff.cancel()
      else await h.handoff.start()
      assert.equal(h.handoff.resetAfterAdopted(id, true), false)
      assert.deepEqual(h.reports, [])
      assert.equal(h.handoff.current().phase, action === 'cancel' ? 'idle' : 'waiting')
    } finally {
      h.restore()
    }
  })
}

test('failed local verification reports failure exactly once and leaves login retryable by a new attempt', async () => {
  const h = harness(async () => tokenResponse())
  try {
    await h.handoff.start()
    const state = stateOf(h.openedUrls[0])
    await h.handoff.handleCallback(callback(state))
    await tick()
    const id = h.handoff.current().confirmationId!
    assert.equal(h.handoff.resetAfterAdopted(id + 1, true), false)
    assert.equal(h.handoff.resetAfterAdopted(id, false), true)
    assert.deepEqual(h.reports, [{ state, outcome: 'adopt_failed', token: 't' }])
    assert.deepEqual(h.handoff.current(), {
      phase: 'failed',
      error: 'verify_failed',
      terminal: true,
    })
    assert.equal(h.handoff.resetAfterAdopted(id, true), false)
    await h.handoff.start()
    assert.equal(h.handoff.current().phase, 'waiting')
  } finally {
    h.restore()
  }
})

test('missing renderer confirmation expires and releases the held credentials', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(async () => tokenResponse())
  try {
    await h.handoff.start()
    const state = stateOf(h.openedUrls[0])
    await h.handoff.handleCallback(callback(state))
    await tick()
    const id = h.handoff.current().confirmationId!
    assert.equal(h.handoff.isBusy(), true)
    mock.timers.tick(CONFIRMATION_TIMEOUT_MS)
    await tick()
    assert.deepEqual(h.reports, [{ state, outcome: 'adopt_failed', token: 't' }])
    assert.equal(h.handoff.isBusy(), false)
    assert.equal(h.handoff.resetAfterAdopted(id, true), false)
    assert.ok(h.logs.some((line) => line.includes('reason=confirmation_timeout')))
  } finally {
    h.restore()
    mock.timers.reset()
  }
})

test('malformed callbacks cannot strand an in-flight local confirmation', async () => {
  const h = harness(async () => tokenResponse())
  try {
    await h.handoff.start()
    const state = stateOf(h.openedUrls[0])
    await h.handoff.handleCallback(callback(state))
    await tick()
    const id = h.handoff.current().confirmationId!
    await h.handoff.handleCallback('scholarseed://auth/callback')
    assert.equal(h.handoff.current().confirmationId, id)
    assert.equal(h.handoff.resetAfterAdopted(id, true), true)
    assert.deepEqual(h.reports, [{ state, outcome: 'adopted', token: 't' }])
    await tick()
    assert.equal(h.handoff.isBusy(), false)
  } finally {
    h.restore()
  }
})

test('local success settles before outcome delivery and cancellation invalidates queued retries', async () => {
  const reporting = deferred<void>()
  let isCurrent!: () => boolean
  const h = harness(async () => tokenResponse(), {
    report: (current) => {
      isCurrent = current
      return reporting.promise
    },
  })
  try {
    await h.handoff.start()
    const state = stateOf(h.openedUrls[0])
    await h.handoff.handleCallback(callback(state))
    await tick()
    const id = h.handoff.current().confirmationId!
    assert.equal(h.handoff.resetAfterAdopted(id, true), true)
    assert.equal(h.handoff.current().phase, 'idle')
    assert.equal(isCurrent(), true)
    h.handoff.cancel()
    assert.equal(isCurrent(), false)
    reporting.resolve()
    await tick()
    assert.equal(h.handoff.current().phase, 'idle')
  } finally {
    reporting.resolve()
    h.restore()
  }
})

test('expired callbacks cannot overwrite a new login and diagnostics omit credentials', async () => {
  mock.timers.enable({ apis: ['Date'] })
  const h = harness(async () => tokenResponse())
  try {
    await h.handoff.start()
    const old = stateOf(h.openedUrls[0])
    mock.timers.tick(STATE_TTL_MS + 1)
    assert.equal(h.handoff.current().error, 'login_expired')
    await tick()
    await h.handoff.start()
    await h.handoff.handleCallback(callback(old, 'SECRET_CALLBACK_CODE'))
    assert.equal(h.handoff.current().phase, 'waiting')
    assert.equal(h.attempts(), 0)
    await h.handoff.handleCallback(callback(stateOf(h.openedUrls[1])))
    await tick()
    assert.equal(h.handoff.current().phase, 'adopted')
    await h.handoff.handleCallback(callback(old, 'SECRET_CALLBACK_CODE'))
    assert.equal(h.handoff.current().phase, 'adopted')
    h.handoff.resetAfterAdopted(h.handoff.current().confirmationId!, true)
    await h.handoff.handleCallback(callback(old))
    assert.equal(h.handoff.current().phase, 'idle')
    const logs = h.logs.join('')
    assert.match(logs, /reason=expired/)
    assert.match(logs, /age_ms=600001/)
    assert.match(logs, /event=callback_expired/)
    assert.doesNotMatch(logs, /SECRET_CALLBACK_CODE|refresh_token|token=/)
    assert.ok(!logs.includes(old), 'diagnostics use a fingerprint rather than the raw state')
    assert.ok(!logs.includes(h.openedUrls[0]), 'diagnostics omit the full login URL')
  } finally {
    h.restore()
    mock.timers.reset()
  }
})

test('waiting expires without renderer polling even when no local claim is granted', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const local = fakeLocal()
  local.coordinator.claim = async () => false
  const h = harness(async () => tokenResponse(), { local })
  try {
    await h.handoff.start()
    mock.timers.tick(STATE_TTL_MS)
    assert.deepEqual(h.phases.at(-1), { phase: 'failed', error: 'login_expired', terminal: true })
    assert.equal(h.attempts(), 0)
  } finally {
    h.restore()
    mock.timers.reset()
  }
})

test('expired memory is bounded in time and unknown old callbacks retain a neutral failure', async () => {
  mock.timers.enable({ apis: ['Date'] })
  const h = harness(async () => tokenResponse())
  try {
    await h.handoff.start()
    const old = stateOf(h.openedUrls[0])
    mock.timers.tick(STATE_TTL_MS)
    h.handoff.current()
    mock.timers.tick(STATE_TTL_MS + 1)
    await h.handoff.handleCallback(callback(old))
    assert.equal(h.handoff.current().error, 'handoff_unclaimed')
    assert.equal(h.attempts(), 0)
  } finally {
    h.restore()
    mock.timers.reset()
  }
})

test('a forwarding result arriving after a new login cannot replace its snapshot', async () => {
  let complete!: (result: DeliveryResult) => void
  const local = fakeLocal()
  local.coordinator.deliver = () =>
    new Promise((resolve) => {
      complete = resolve
    })
  const h = harness(async () => tokenResponse(), { local })
  try {
    const forwarded = h.handoff.handleCallback(callback(newHandoffState()))
    await h.handoff.start()
    complete('orphaned')
    await forwarded
    assert.equal(h.handoff.current().phase, 'waiting')
    assert.equal(h.attempts(), 0)
  } finally {
    h.restore()
  }
})

test('expiration invalidates an in-flight exchange before credentials can be adopted', async () => {
  mock.timers.enable({ apis: ['Date'] })
  let complete!: (response: Response) => void
  let adoptions = 0
  const h = harness(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
    {
      adopt: async () => {
        adoptions += 1
        return true
      },
    }
  )
  try {
    await h.handoff.start()
    await h.handoff.handleCallback(callback(stateOf(h.openedUrls[0])))
    await tick()
    mock.timers.tick(STATE_TTL_MS)
    assert.equal(h.handoff.current().error, 'login_expired')
    complete(tokenResponse())
    await tick()
    assert.equal(adoptions, 0)
    assert.equal(h.handoff.current().error, 'login_expired')
  } finally {
    h.restore()
    mock.timers.reset()
  }
})

test('a late callback itself detects expiry before exchanging or forwarding credentials', async () => {
  mock.timers.enable({ apis: ['Date'] })
  const h = harness(async () => tokenResponse())
  try {
    await h.handoff.start()
    const state = stateOf(h.openedUrls[0])
    mock.timers.tick(STATE_TTL_MS)
    await h.handoff.handleCallback(callback(state))
    assert.equal(h.handoff.current().error, 'login_expired')
    assert.equal(h.attempts(), 0)
    assert.deepEqual(h.local.calls.deliver, [])
    assert.ok(h.local.calls.release.includes(state))
  } finally {
    h.restore()
    mock.timers.reset()
  }
})
