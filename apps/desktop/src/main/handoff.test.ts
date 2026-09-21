import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

import {
  type DesktopAuthSnapshot,
  DesktopHandoff,
  LOCAL_POLL_INTERVAL_MS,
  STATE_TTL_MS
} from './handoff.ts'
import type { DeliveryResult, HandoffLocalCoordinator, RenewResult } from './handoff-local.ts'
import {
  DESKTOP_AUTH_CALLBACK_PREFIX,
  findCallbackUrl,
  newHandoffState,
  parseCallbackUrl
} from './handoff-url.ts'

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
  assert.equal(parseCallbackUrl('https://example.test/scholarseed://auth/callback?code=a&state=b'), null)
  assert.equal(parseCallbackUrl('not a url at all'), null)
})

test('handoff state is high-entropy and never repeats', () => {
  const first = newHandoffState()
  const second = newHandoffState()
  assert.ok(first.length >= 43, `state too short: ${first.length}`)
  assert.notEqual(first, second)
})

const ACCOUNT_BASE = 'https://account.test'

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
    release: [] as string[]
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
      }
    }
  }
}

function tokenResponse(): Response {
  return new Response(JSON.stringify({ token: 't', refresh_token: 'r' }), { status: 200 })
}

interface HarnessOptions {
  local?: ReturnType<typeof fakeLocal>
  adopt?: (token: string, refreshToken: string) => Promise<boolean>
}

/** 状态机固件：注入全部依赖 + 一个可编程的 fetch 替身，返回观测到的相位序列。 */
function harness(
  exchange: (attempt: number) => Promise<Response>,
  options: HarnessOptions = {}
): {
  handoff: DesktopHandoff
  phases: DesktopAuthSnapshot[]
  openedUrls: string[]
  attempts: () => number
  reports: Array<{ state: string; outcome: string; token: string }>
  local: ReturnType<typeof fakeLocal>
  restore: () => void
} {
  const phases: DesktopAuthSnapshot[] = []
  const openedUrls: string[] = []
  const reports: Array<{ state: string; outcome: string; token: string }> = []
  const local = options.local ?? fakeLocal()
  let attempt = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    attempt += 1
    return await exchange(attempt)
  }) as typeof globalThis.fetch
  const handoff = new DesktopHandoff({
    log: () => {},
    accountBaseUrl: async () => ACCOUNT_BASE,
    deviceFields: () => ({ device_id: 'd', device_label: 'l' }),
    adoptTokens: options.adopt ?? (async () => true),
    publish: (snapshot) => phases.push(snapshot),
    revealWindow: () => true,
    openExternal: async (url) => {
      openedUrls.push(url)
    },
    local: local.coordinator,
    reportOutcome: async (state, outcome, token) => {
      reports.push({ state, outcome, token })
    }
  })
  return {
    handoff,
    phases,
    openedUrls,
    attempts: () => attempt,
    reports,
    local,
    restore: () => {
      globalThis.fetch = originalFetch
    }
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
  const h = harness(async () => new Response(JSON.stringify({ code: 'handoff_invalid' }), { status: 400 }))
  try {
    await h.handoff.start()
    const state = stateOf(h.openedUrls[0])
    await h.handoff.handleCallback(callback(state))
    await tick()
    assert.deepEqual(h.phases.at(-1), { phase: 'failed', error: 'handoff_invalid', terminal: true })
    await h.handoff.handleCallback(callback(state, 'c2'))
    assert.deepEqual(h.phases.at(-1), { phase: 'failed', error: 'state_mismatch', terminal: true })
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
    assert.equal(h.handoff.current().phase, 'failed')
    h.local.setDeliver('orphaned')
    await h.handoff.handleCallback(callback(state, 'late'))
    await tick()
    assert.equal(h.attempts(), 1, '过期 state 不得再触发交换')
    assert.deepEqual(h.phases.at(-1), { phase: 'failed', error: 'state_mismatch', terminal: true })
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

test('an unclaimed deep link still reports state_mismatch', async () => {
  const local = fakeLocal()
  local.setDeliver('orphaned')
  const h = harness(async () => tokenResponse(), { local })
  try {
    await h.handoff.handleCallback(callback(newHandoffState()))
    await tick()
    // 安全回退没有被放宽：无主（无 claim / 租约过期 / 自投）仍然判 state_mismatch。
    assert.deepEqual(h.phases.at(-1), { phase: 'failed', error: 'state_mismatch', terminal: true })
    assert.equal(h.attempts(), 0)
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
  const h = harness(async () => {
    await gate
    return tokenResponse()
  }, { local })
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
  const h = harness(async () => new Response(JSON.stringify({ code: 'handoff_invalid' }), { status: 400 }))
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
  const h = harness(async (attempt) => {
    if (attempt === 1) {
      await gate
      return tokenResponse()
    }
    return tokenResponse()
  }, { adopt: async () => false })
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
