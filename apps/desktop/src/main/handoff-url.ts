// handoff-url.ts — 桌面登录交接深链的 URL 解析与 state 生成（纯函数，node 可测）。
//
// 从 handoff.ts 拆出：handoff.ts 要 import electron 的 shell（开系统浏览器），
// node --test 环境下 electron 包不提供具名导出，整模块不可加载；解析与生成是
// 这条链上唯一值得单测的部分，因此住在不碰 electron 的这一层。

import { randomBytes } from 'crypto'

/** Callback prefix owned by the hosted-account desktop handoff. */
export const DESKTOP_AUTH_CALLBACK_PREFIX = 'scholarseed://auth/callback'
const STATE_BYTES = 32

export interface ParsedCallback {
  code: string
  state: string
}

export function parseCallbackUrl(url: string): ParsedCallback | null {
  if (!url.startsWith(DESKTOP_AUTH_CALLBACK_PREFIX)) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const code = parsed.searchParams.get('code') || ''
  const state = parsed.searchParams.get('state') || ''
  if (!code || !state) return null
  return { code, state }
}

export function newHandoffState(): string {
  return randomBytes(STATE_BYTES).toString('base64url')
}
