// handoff-url.ts — 桌面登录交接深链的 URL 解析与 state 生成（纯函数，node 可测）。
//
// 从 handoff.ts 拆出：handoff.ts 要 import electron 的 shell（开系统浏览器），
// node --test 环境下 electron 包不提供具名导出，整模块不可加载；解析与生成是
// 这条链上唯一值得单测的部分，因此住在不碰 electron 的这一层。

import { createHash, randomBytes } from 'crypto'

/** Callback prefix owned by the hosted-account desktop handoff. */
export const DESKTOP_AUTH_CALLBACK_PREFIX = 'scholarseed://auth/callback'
const STATE_BYTES = 32
const DIAGNOSTIC_STATE_LENGTH = 16

export function handoffFingerprint(state: string): string {
  return state
    ? createHash('sha256').update(state).digest('hex').slice(0, DIAGNOSTIC_STATE_LENGTH)
    : 'none'
}

export interface ParsedCallback {
  code: string
  state: string
}

function isDesktopCallbackUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    parsed.protocol.toLowerCase() === 'scholarseed:' &&
    parsed.hostname.toLowerCase() === 'auth' &&
    parsed.pathname === '/callback'
  )
}

function unquoteArgument(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? value.slice(1, -1)
    : value
}

export function parseCallbackUrl(url: string): ParsedCallback | null {
  if (!isDesktopCallbackUrl(url)) return null
  const parsed = new URL(url)
  const code = parsed.searchParams.get('code') || ''
  const state = parsed.searchParams.get('state') || ''
  if (!code || !state) return null
  return { code, state }
}

export function findCallbackUrl(args: readonly string[]): string | null {
  return args.map(unquoteArgument).find((arg) => isDesktopCallbackUrl(arg)) ?? null
}

export function newHandoffState(): string {
  return randomBytes(STATE_BYTES).toString('base64url')
}
