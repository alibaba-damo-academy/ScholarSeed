// auth-refresh.ts — 双 token 续期的持久化与 HTTP 原语。
//
// refresh token 是 90 天期长凭据，落点必须渲染层读不到、也不以明文存在：用 Electron
// safeStorage 加密落产品家目录；底层密钥提供器由不可变产品策略在 ready 前选择。
// 权限 0600。加密不可用的机器（个别 Linux 场景）宁可不存 —— 续期静默失效退化成
// 7 天重登，也好过明文落盘一个 90 天凭据。
//
// 本文件只管存储与交换：令牌内容的合法性全部由服务端验签把关，这里不解析、不校验，
// 唯一的例外是本地读 access 的 exp 决定「到没到续期窗口」（签名真伪不影响续期时机，
// 错了最多是白续一次或晚续一次，服务端都会兜住）。

import { safeStorage } from 'electron'
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { desktopHome } from './backend'

const REFRESH_FILE_PREFIX = 'auth-refresh'
const REFRESH_FILE_SUFFIX = 'enc'
// 提前续期窗口：access 剩余有效期低于该值时静默换新（access 7 天，约 6 天轮转一次）。
export const REFRESH_AHEAD_SECONDS = 24 * 3600
// 周期检查节律：每小时查一次，覆盖睡眠/断网错过的窗口。
export const REFRESH_CHECK_INTERVAL_MS = 60 * 60 * 1000
const REFRESH_HTTP_TIMEOUT_MS = 8000

/** 日志出口由调用方注入（主进程的 pushLog），本模块不自己持有 logger。 */
export type LogFn = (line: string) => void

function refreshFilePath(namespace: string): string {
  return join(desktopHome(), `${REFRESH_FILE_PREFIX}.${namespace}.${REFRESH_FILE_SUFFIX}`)
}

/** 存 refresh token；空串 = 删除。加密不可用时不落盘（见文件头）。 */
export function saveRefreshToken(token: string, namespace: string, log?: LogFn): void {
  const path = refreshFilePath(namespace)
  if (!token) {
    try {
      rmSync(path)
    } catch {
      // 文件不在即已清空，登出/失败清理都不该因此报错
    }
    return
  }
  if (!safeStorage.isEncryptionAvailable()) {
    // 不落盘是有意的，但必须留痕: 否则这台机器表现成「每 7 天要重登一次」而无从排查。
    log?.('[shell] WARN safeStorage unavailable; refresh token not persisted (renewal disabled)\n')
    return
  }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, safeStorage.encryptString(token), { mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // 个别文件系统 write 时 mode 已生效，chmod 失败不拦原子换写
  }
  renameSync(tmp, path)
}

export function loadRefreshToken(namespace: string): string {
  try {
    const path = refreshFilePath(namespace)
    if (!existsSync(path) || !safeStorage.isEncryptionAvailable()) return ''
    return safeStorage.decryptString(readFileSync(path))
  } catch {
    // 文件损坏/解密失败 = 凭据不可用：当作没有，退化成到期重登
    return ''
  }
}

/** Read the access-token expiry without verifying its signature; non-JWT tokens return null. */
export function accessExpSeconds(token: string): number | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      exp?: unknown
    }
    return typeof claims.exp === 'number' ? claims.exp : null
  } catch {
    return null
  }
}

export interface RefreshedTokens {
  token: string
  refresh_token: string
}

export type RefreshOutcome =
  | { ok: true; data: RefreshedTokens }
  | { ok: false; rejected: boolean; error: string }

/**
 * POST /api/token/refresh（轮转）。rejected 只在服务端明确拒绝（401 invalid_refresh，
 * 意味着族被吊销/重放/过期）时为 true —— 调用方据此清凭据回登录页；网络抖动/超时
 * rejected=false，下个检查周期重试即可，不该让用户为一个网络错误重登。
 */
export async function refreshTokens(
  accountBaseUrl: string,
  refreshToken: string
): Promise<RefreshOutcome> {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), REFRESH_HTTP_TIMEOUT_MS)
    const resp = await fetch(`${accountBaseUrl}/api/token/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: ctl.signal
    })
    clearTimeout(timer)
    const payload = (await resp.json().catch(() => ({}))) as Partial<RefreshedTokens>
    if (!resp.ok || !payload.token || !payload.refresh_token) {
      return { ok: false, rejected: resp.status === 401, error: `refresh rejected (${resp.status})` }
    }
    return { ok: true, data: { token: payload.token, refresh_token: payload.refresh_token } }
  } catch (e) {
    return { ok: false, rejected: false, error: String(e) }
  }
}

/** 登出时通知账号服务整族吊销。best-effort，永不抛错：本地清理才是主路径。 */
export async function revokeRefreshFamily(
  accountBaseUrl: string,
  refreshToken: string
): Promise<void> {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), REFRESH_HTTP_TIMEOUT_MS)
    await fetch(`${accountBaseUrl}/api/token/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: ctl.signal
    })
    clearTimeout(timer)
  } catch {
    // 服务端不可达时登出仍然成功（本地凭据已清），族会随 refresh 90 天过期自然死亡
  }
}
