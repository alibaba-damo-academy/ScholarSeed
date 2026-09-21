import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { block, tail } from '../../test-helpers/source-contract.ts'

import { CREDITS_LOW_WARNING_THRESHOLD, creditsWarningBucket } from './account.ts'

/**
 * credits.ts 只导出一个 React hook（useCreditsLowWarning），在 node:test 里无法 import：
 * 它顶层 import React / react-i18next，并且 `from './account'`、`from './components/ui'`
 * 都是 Node ESM 解析不了的说明符（无扩展名 / 目录）。所以这里分两段：
 * - 分桶阈值用 account.ts 的真实纯函数跑行为断言（这是 hook 唯一的判定输入）；
 * - hook 的去重、降级、重取节律用源码契约钉住，与仓库既有 .tsx/.hook 契约测试同做法。
 */
const creditsSource = readFileSync(new URL('./credits.ts', import.meta.url), 'utf8')
const accountSource = readFileSync(new URL('./account.ts', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

const checkEffect = tail(creditsSource, 'React.useEffect(() => {\n    if (!loggedIn) {')
const loginEffect = block(
  creditsSource,
  'React.useEffect(() => {\n    if (!backendReady) {',
  'React.useEffect(() => {\n    if (wasRunning.current'
)

test('the warning hook judges the balance with the shared bucket, never a local threshold', () => {
  assert.match(
    creditsSource,
    /import \{\n\s*INITIAL_CREDITS_STATE,\n\s*accountCredits,\n\s*creditsWarningBucket,\n\s*setAccountBase,\n\s*type CreditsWarningBucket\n\} from '\.\/account'/
  )
  // hook 收三个输入：后端就绪、本轮是否在跑、当前活动会话；积分态经 useApp().set 写进全局 store。
  assert.match(
    creditsSource,
    /export function useCreditsLowWarning\(\n\s*backendReady: boolean,\n\s*running: boolean,\n\s*activeSession: string \| null\n\): void \{/
  )
  assert.match(creditsSource, /import \{ useApp \} from '\.\/store'/)
  assert.match(creditsSource, /const \{ set \} = useApp\(\)/)
  assert.match(creditsSource, /set\(\{ credits: INITIAL_CREDITS_STATE \}\)/)
  assert.match(creditsSource, /const bucket = creditsWarningBucket\(result\.data\.balance_credits\)/)
  // 阈值只能在 account.ts 有一份：这里再写一个数字，两条线就会各自漂移。
  assert.doesNotMatch(creditsSource, /CREDITS_LOW_WARNING_THRESHOLD/)
  assert.doesNotMatch(creditsSource, /balance_credits *[<>]=?/)
  assert.equal(CREDITS_LOW_WARNING_THRESHOLD, 100)
  assert.equal(creditsWarningBucket(CREDITS_LOW_WARNING_THRESHOLD + 0.5), null)
  assert.equal(creditsWarningBucket(CREDITS_LOW_WARNING_THRESHOLD), 'low')
  assert.equal(creditsWarningBucket(0.5), 'low')
  assert.equal(creditsWarningBucket(0), 'exhausted')
  assert.equal(creditsWarningBucket(-12), 'exhausted')
})

test('the toast fires on a bucket transition only, so one balance cannot warn every turn', () => {
  assert.match(creditsSource, /const warned = React\.useRef<CreditsWarningBucket>\(null\)/)
  // 同桶不重复弹；跃迁才弹。exhausted 改由 Composer 常驻卡承载，toast 只负责 low 桶。
  assert.match(checkEffect, /if \(bucket === warned\.current\) return/)
  assert.match(checkEffect, /warned\.current = bucket\s*if \(bucket !== 'low'\) return/)
  assert.match(
    checkEffect,
    /toast\(\{\s*title: t\('accountMenu\.creditsLow', \{\s*balance: Math\.floor\(result\.data\.balance_credits\)\s*\}\),\s*tone: 'warning'\s*\}\)/
  )
  // 余额显示取整：不把 0.7 积分渲染成一位小数假精度。
  assert.match(checkEffect, /balance: Math\.floor\(result\.data\.balance_credits\)/)
})

test('a recharge, an exempt account or a sign-out re-arms the warning', () => {
  // 回到阈值以上 = 桶变回 null，warned 记下 null，下次再跌进 low 才会重新弹。
  assert.match(checkEffect, /warned\.current = bucket\s*if \(bucket !== 'low'\) return/)
  // 不计量账号 / 撤闸只算不拒 / 上游没给余额：解除武装，不能把「不知道」当成低余额。
  assert.match(
    checkEffect,
    /if \(\s*result\.data\.unlimited \|\|\s*!result\.data\.enforcing \|\|\s*result\.data\.balance_credits === null\s*\) \{\s*warned\.current = null\s*return\s*\}/
  )
  // 退出登录后清掉记忆并把积分态复位，换账号登录不会被上一个账号的桶压住。
  assert.match(
    checkEffect,
    /if \(!loggedIn\) \{\s*warned\.current = null\s*set\(\{ credits: INITIAL_CREDITS_STATE \}\)\s*return undefined\s*\}/
  )
})

test('a credits fetch failure never presents itself as an exhausted balance', () => {
  // 失败走 error phase 占位，不合成 summary、不弹 toast。
  assert.match(checkEffect, /if \(cancelled\) return\s*if \(!result\.ok\) \{\s*set\(\(current\) => \(\{\s*credits: \{ \.\.\.current\.credits, phase: 'error' \}\s*\}\)\)\s*return\s*\}/)
  assert.match(accountSource, /balance_credits: number \| null/)
  assert.doesNotMatch(creditsSource, /balance_credits \?\? 0/)
  assert.doesNotMatch(checkEffect, /toast\(\{[\s\S]*?!result\.ok/)
})

test('the balance is refetched after every turn finishes, on window refocus and whenever login state changes', () => {
  // running 落沿（true → false）才 bump 序号：turn 中途不打扰网关。
  assert.match(creditsSource, /if \(wasRunning\.current && !running\) setCheckSeq\(\(seq\) => seq \+ 1\)/)
  assert.match(creditsSource, /wasRunning\.current = running/)
  assert.match(creditsSource, /\}, \[running\]\)/)
  // 重取 effect 的依赖含活动会话和 store 的 set：进入会话也要重取。
  assert.match(creditsSource, /\}, \[loggedIn, checkSeq, activeSession, set, toast, t\]\)/)
  // 窗口重新聚焦也 bump 序号：去网页充值后切回来立即重取。
  assert.match(
    creditsSource,
    /const refresh = \(\): void => setCheckSeq\(\(seq\) => seq \+ 1\)\s*window\.addEventListener\('focus', refresh\)\s*return \(\) => window\.removeEventListener\('focus', refresh\)/
  )
  // 后端没起来时一律按未登录处理并复位积分态，不发积分请求。
  assert.match(
    loginEffect,
    /if \(!backendReady\) \{\s*setLoggedIn\(false\)\s*set\(\{ credits: INITIAL_CREDITS_STATE \}\)\s*return undefined\s*\}/
  )
  // 登录态取数同时拉网关状态（account base）和本人信息。
  assert.match(
    loginEffect,
    /void Promise\.all\(\[getAuthStatus\(\), getAuthMe\(\)\]\)\.then\(\(\[status, me\]\) => \{\s*if \(cancelled\) return\s*setAccountBase\(status\?\.account_base_url \?\? ''\)\s*setLoggedIn\(Boolean\(me\?\.auth\)\)\s*\}\)/
  )
  // auth-required 清登录态并复位积分态；auth-restored 重取登录态。
  assert.match(
    loginEffect,
    /const cleared = \(\): void => \{\s*if \(!cancelled\) \{\s*setLoggedIn\(false\)\s*set\(\{ credits: INITIAL_CREDITS_STATE \}\)\s*\}\s*\}/
  )
  assert.match(loginEffect, /window\.addEventListener\('scholarseed:auth-restored', refresh\)/)
  assert.match(loginEffect, /window\.addEventListener\('scholarseed:auth-required', cleared\)/)
  assert.match(creditsSource, /\}, \[backendReady, set\]\)/)
})

test('every window listener the hook adds is removed again and late responses are dropped', () => {
  const added = [...creditsSource.matchAll(/window\.addEventListener\('([^']+)'/g)].map(([, name]) => name)
  const removed = [...creditsSource.matchAll(/window\.removeEventListener\('([^']+)'/g)].map(([, name]) => name)
  assert.ok(added.length >= 3, 'the hook must react to the auth lifecycle and window focus')
  assert.deepEqual([...removed].sort(), [...added].sort())
  // 消费者侧订阅的必须是 scholarseed: 前缀的事件名。
  assert.ok(added.includes('scholarseed:auth-restored'))
  assert.ok(added.includes('scholarseed:auth-required'))
  assert.ok(added.includes('focus'))
  // 两个异步 effect 都要认「已卸载」，否则卸载后的响应会去 setState。
  assert.equal(creditsSource.match(/if \(cancelled\) return/g)?.length, 2)
  assert.equal(creditsSource.match(/if \(!cancelled\)/g)?.length, 1)
  assert.equal(creditsSource.match(/cancelled = true/g)?.length, 2)
})

test('the auth lifecycle event names the renderer broadcasts are the scholarseed ones', () => {
  // 生产者侧的约定：登录失效 / 恢复都走 scholarseed: 前缀（App.tsx、account.ts、api.ts、
  // invocation.ts 全部一致）。消费者必须订同一组名字，否则事件发了没人接。
  const dispatched = new Set(
    [...appSource.matchAll(/dispatchEvent\(new CustomEvent\('([^']+)'\)\)/g)].map(([, name]) => name)
  )
  assert.ok(dispatched.has('scholarseed:auth-required'))
  assert.ok(dispatched.has('scholarseed:auth-restored'))
  assert.match(accountSource, /window\.dispatchEvent\(new CustomEvent\('scholarseed:auth-required'\)\)/)
  assert.doesNotMatch(appSource, /CustomEvent\('shushen:/)
  assert.doesNotMatch(accountSource, /CustomEvent\('shushen:/)
})
