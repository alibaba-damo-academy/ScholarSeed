import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { block, tail } from '../test-helpers/source-contract.ts'

/**
 * 这个模块在 `node --test` 里无法被 import，原因是加载期依赖而不是逻辑耦合：
 * - `import { desktopHome } from './storage'` 是无扩展名说明符，Node ESM 解析直接
 *   ERR_MODULE_NOT_FOUND；
 * - `storage.ts` 顶层 import Electron 的 `app`，脱离 Electron 运行时是 undefined；
 * - `safeStorage` 同样只在 Electron 里存在（Node 下 named import 得到 undefined）。
 * `mock.module` 需要 `--experimental-test-module-mocks`，不在 `npm test` 的 flag 里。
 * 按仓库既有做法（HomeOverview.test.ts、features/workbench/scope.test.ts 等把不可
 * import 的源当契约文本钉住），这里钉住续期状态机的时机、存储格式与失败语义；
 * 改实现必须同时改断言。真实 Electron 行为仍由 desktop harness / e2e 覆盖。
 */
const refreshSource = readFileSync(new URL('./auth-refresh.ts', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

/** 把 `24 * 3600` 这类因子表达式算出来，好对时机做真正的数值比较。 */
function product(expression: string): number {
  return expression
    .split('*')
    .map((factor) => Number(factor.trim()))
    .reduce((left, right) => left * right, 1)
}

function constant(source: string, pattern: RegExp): number {
  const match = pattern.exec(source)
  assert.ok(match, `missing constant: ${pattern}`)
  return product(match[1])
}

const saveBlock = block(
  refreshSource,
  'export function saveRefreshToken',
  'export function loadRefreshToken'
)
const loadBlock = block(
  refreshSource,
  'export function loadRefreshToken',
  'export function accessExpSeconds'
)
const expiryBlock = block(
  refreshSource,
  'export function accessExpSeconds',
  'export interface RefreshedTokens'
)
const refreshCallBlock = block(
  refreshSource,
  'export async function refreshTokens',
  'export async function revokeRefreshFamily'
)
const revokeBlock = tail(refreshSource, 'export async function revokeRefreshFamily')

test('refresh-ahead window and check cadence are ordered so a missed window still recovers', () => {
  const aheadSeconds = constant(
    refreshSource,
    /export const REFRESH_AHEAD_SECONDS = ([0-9]+(?: \* [0-9]+)*)/
  )
  const intervalMs = constant(
    refreshSource,
    /export const REFRESH_CHECK_INTERVAL_MS = ([0-9]+(?: \* [0-9]+)*)/
  )
  const timeoutMs = constant(
    refreshSource,
    /const REFRESH_HTTP_TIMEOUT_MS = ([0-9]+(?: \* [0-9]+)*)/
  )

  // access 7 天有效，提前 1 天续期：约 6 天轮转一次。
  assert.equal(aheadSeconds, 24 * 3600)
  assert.ok(aheadSeconds < 7 * 24 * 3600, 'refresh-ahead must stay inside the access lifetime')
  // 周期检查必须比续期窗口密：睡眠/断网错过一次，下一小时还能补上。
  assert.equal(intervalMs, 60 * 60 * 1000)
  assert.ok(
    intervalMs / 1000 < aheadSeconds,
    'the periodic check must fire inside the refresh-ahead window'
  )
  // 单次 HTTP 必须远短于检查周期，否则定时腿会叠在一起。
  assert.ok(timeoutMs < intervalMs)
  assert.match(
    refreshSource,
    /const timer = setTimeout\(\(\) => ctl\.abort\(\), REFRESH_HTTP_TIMEOUT_MS\)/
  )
})

test('the refresh token is stored encrypted, atomically and owner-readable only', () => {
  assert.match(refreshSource, /const REFRESH_FILE_PREFIX = 'auth-refresh'/)
  assert.match(refreshSource, /const REFRESH_FILE_SUFFIX = 'enc'/)
  assert.match(
    refreshSource,
    /join\(desktopHome\(\), `\$\{REFRESH_FILE_PREFIX\}\.\$\{namespace\}\.\$\{REFRESH_FILE_SUFFIX\}`\)/
  )
  // 先写 .tmp 再 rename：崩溃时不会留下半截密文当有效凭据。
  assert.match(saveBlock, /const tmp = `\$\{path\}\.tmp`/)
  assert.match(
    saveBlock,
    /writeFileSync\(tmp, safeStorage\.encryptString\(token\), \{ mode: 0o600 \}\)/
  )
  assert.match(saveBlock, /chmodSync\(tmp, 0o600\)/)
  assert.match(saveBlock, /renameSync\(tmp, path\)/)
  // 明文永不落盘：加密之外不允许出现直接写 token 的路径。
  assert.doesNotMatch(saveBlock, /writeFileSync\((path|tmp), token/)
})

test('an empty token deletes the credential and a missing file is not an error', () => {
  assert.match(saveBlock, /if \(!token\) \{\s*try \{\s*rmSync\(path\)/)
  // 登出/失败清理不能因为文件本来就不在而抛错。
  assert.match(saveBlock, /code !== 'ENOENT'\) throw error/)
})

test('unavailable encryption degrades to no persisted credential instead of plaintext', () => {
  assert.match(saveBlock, /if \(token && !safeStorage\.isEncryptionAvailable\(\)\) \{/)
  // 不落盘是有意的，但必须留痕，否则这台机器只会表现成「每 7 天要重登」。
  assert.match(
    saveBlock,
    /log\?\.\('\[shell\] WARN safeStorage unavailable; refresh token not persisted/
  )
  assert.match(saveBlock, /renewal disabled/)
  assert.match(
    loadBlock,
    /if \(!existsSync\(path\) \|\| !safeStorage\.isEncryptionAvailable\(\)\) return ''/
  )
})

test('an unreadable or corrupt credential reads back as absent rather than throwing', () => {
  assert.match(loadBlock, /return safeStorage\.decryptString\(readFileSync\(path\)\)/)
  assert.match(loadBlock, /catch \{\s*\/\/ 文件损坏\/解密失败 = 凭据不可用/)
  assert.match(loadBlock, /return ''/)
})

test('access expiry is read from the JWT payload without verifying the signature', () => {
  assert.match(expiryBlock, /const payload = token\.split\('\.'\)\[1\]/)
  // 少于两段的串（含空串）不是 JWT：直接 null，不参与续期。
  assert.match(expiryBlock, /if \(!payload\) return null/)
  assert.match(
    expiryBlock,
    /JSON\.parse\(Buffer\.from\(payload, 'base64url'\)\.toString\('utf-8'\)\)/
  )
  // exp 必须是数字；字符串 exp / 缺失 exp 都回 null，不能靠 Number() 猜。
  assert.match(expiryBlock, /return typeof claims\.exp === 'number' \? claims\.exp : null/)
  assert.match(expiryBlock, /catch \{\s*return null/)
  assert.doesNotMatch(expiryBlock, /verify|jose|jsonwebtoken|createPublicKey/)
})

test('token rotation accepts only a complete pair and classifies rejection by status', () => {
  assert.match(refreshCallBlock, /fetch\(`\$\{accountBaseUrl\}\/api\/token\/refresh`/)
  assert.match(refreshCallBlock, /method: 'POST'/)
  assert.match(refreshCallBlock, /headers: \{ 'content-type': 'application\/json' \}/)
  assert.match(refreshCallBlock, /body: JSON\.stringify\(\{ refresh_token: refreshToken \}\)/)
  assert.match(refreshCallBlock, /signal: ctl\.signal/)
  assert.match(refreshCallBlock, /clearTimeout\(timer\)/)
  // 半个响应（只回 token 或只回 refresh_token）也算失败：轮转必须原子。
  assert.match(
    refreshCallBlock,
    /if \(!resp\.ok \|\| !payload\.token \|\| !payload\.refresh_token\) \{/
  )
  // rejected 只在服务端明确拒绝时为真 —— 401 invalid_refresh 意味着族被吊销/重放/过期。
  assert.match(refreshCallBlock, /rejected: resp\.status === 401/)
  assert.match(refreshCallBlock, /error: `refresh rejected \(\$\{resp\.status\}\)`/)
  assert.match(
    refreshCallBlock,
    /return \{ ok: true, data: \{ token: payload\.token, refresh_token: payload\.refresh_token \} \}/
  )
  // 网络抖动/超时不是拒绝：rejected=false，下个周期重试，不能让用户为一次断网重登。
  assert.match(
    refreshCallBlock,
    /catch \(e\) \{\s*return \{ ok: false, rejected: false, error: String\(e\) \}/
  )
  // 响应体不是 JSON 时也要走完判定，而不是抛进调用方。
  assert.match(refreshCallBlock, /await resp\.json\(\)\.catch\(\(\) => \(\{\}\)\)/)
})

test('logout revocation is best effort and can never fail the local sign-out', () => {
  assert.match(revokeBlock, /fetch\(`\$\{accountBaseUrl\}\/api\/token\/logout`/)
  assert.match(revokeBlock, /body: JSON\.stringify\(\{ refresh_token: refreshToken \}\)/)
  assert.match(revokeBlock, /Promise<void>/)
  assert.match(revokeBlock, /catch \{\s*\/\/ 服务端不可达时登出仍然成功/)
  assert.doesNotMatch(revokeBlock, /throw /)
})

test('the main-process renewal loop is single-flight and gated on a readable expiry', () => {
  const loop = block(mainSource, 'function ensureFreshAuth(): void {', 'setInterval(')
  // 启动触发与每小时定时可能撞在一起；并发轮转会被服务端判成重放，把整个族掐断。
  assert.match(mainSource, /let refreshInflight: Promise<void> \| null = null/)
  assert.match(loop, /if \(refreshInflight\) return/)
  assert.match(loop, /refreshInflight = \(async \(\) => \{/)
  assert.match(loop, /if \(!win \|\| win\.isDestroyed\(\)\) return/)
  assert.match(loop, /const access = await readAuthCookie\(win\)\s*if \(!access\) return/)
  assert.match(loop, /const exp = accessExpSeconds\(access\)/)
  // 非 JWT（无 exp）不参与账号续期。
  assert.match(loop, /if \(exp == null\) return/)
  assert.match(loop, /if \(exp - Date\.now\(\) \/ 1000 > REFRESH_AHEAD_SECONDS\) return/)
  assert.match(
    loop,
    /const refreshToken = loadRefreshToken\(refreshNamespace\)\s*\/\/[\s\S]*?if \(!refreshToken\) return/
  )
  assert.match(
    loop,
    /const accountBase = await accountBaseUrlFromServe\(\)\s*if \(!accountBase\) return/
  )
})

test('a rotated pair is adopted, an explicit rejection clears credentials, a network error defers', () => {
  const loop = block(mainSource, 'function ensureFreshAuth(): void {', 'setInterval(')
  assert.match(loop, /const outcome = await refreshTokens\(accountBase, refreshToken\)/)
  assert.match(loop, /await setAuthCookie\(win, outcome\.data\.token\)/)
  assert.match(loop, /saveRefreshToken\(outcome\.data\.refresh_token, refreshNamespace, pushLog\)/)
  assert.match(loop, /access token renewed via refresh rotation/)
  // 只有服务端明确拒绝才清凭据：族已不可信（吊销/重放/超宽限期）。
  assert.match(loop, /\} else if \(outcome\.rejected\) \{/)
  assert.match(
    loop,
    /saveRefreshToken\('', refreshNamespace, pushLog\)\s*await setAuthCookie\(win, ''\)/
  )
  assert.match(loop, /credentials cleared/)
  // 网络抖动只记一条 deferred，绝不落进清凭据分支。
  assert.match(loop, /token refresh deferred/)
  assert.match(mainSource, /setInterval\(\(\) => ensureFreshAuth\(\), REFRESH_CHECK_INTERVAL_MS\)/)
  assert.match(mainSource, /let refreshTimerRegistered = false/)
})

test('the account base url comes from serve, never from a bundled default', () => {
  const resolver = block(mainSource, 'async function accountBaseUrlFromServe', '// 单飞闸')
  assert.match(resolver, /fetch\(`\$\{apiBase\}\/api\/auth\/status`/)
  assert.match(resolver, /String\(status\.account_base_url \|\| ''\)\.replace\(\/\\\/\+\$\/, ''\)/)
  // 取不到地址时回空串，续期腿据此静默跳过，不能猜一个账号服务地址。
  assert.match(resolver, /catch \{\s*return ''/)
  assert.doesNotMatch(refreshSource, /https?:\/\//)
})
