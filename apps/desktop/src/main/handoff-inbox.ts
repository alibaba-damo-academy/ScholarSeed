// handoff-inbox.ts — 桌面登录交接深链送达失败时的兜底投递腿（proposal 74 的延伸，87498884）。
//
// 背景：Windows 上主实例以提权（High 完整性）运行时，浏览器拉起的二次实例是 Medium
// 完整性，单实例通知被 UIPI 拦截，second-instance 永不触发；二次实例取锁失败后直接
// app.quit()，argv 里的回调被静默丢弃。本模块给二次实例一条「退出前把回调停进磁盘收件
// 箱」的退路，主实例定时取回：通道只依赖文件系统，与单实例 IPC、serve 的 Host-Key、
// 进程完整性级别都无关 —— 这三者恰好都是预引导进程拿不到或被挡的东西。
//
// 形状：一条入口一个 JSON 文件（并发 park 不互踩），同目录 tmp + rename 原子落盘；消费
// 方只有持单实例锁的主实例（drain 只在锁持有者里启动），故读后即删即可，不存在双消费。
// 入口随手交接 state 的 TTL 过期：过期只记账，不触发登录。
//
// 日志纪律同 handoff-local.ts：code 是凭据，只打 state 与错误码，绝不打原值。

import { randomUUID } from 'crypto'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'

import { STATE_TTL_MS } from './handoff.ts'
import { handoffFingerprint, parseCallbackUrl } from './handoff-url.ts'
import { validateCallbackTiming, type CallbackTiming } from './handoff-timing.ts'

export const INBOX_DIRNAME = 'handoff-inbox'
/** 主实例的消费节拍。深链回调的寿命以分钟计，秒级节拍足够且 readdir 成本可忽略。 */
export const INBOX_DRAIN_INTERVAL_MS = 1_000

const ENTRY_SUFFIX = '.json'
const TMP_SUFFIX = '.tmp'
const ENTRY_SCHEMA = 1

export interface HandoffInboxDependencies {
  home: () => string
  log: (line: string) => void
  now?: () => number
}

export type ParkResult = 'parked' | 'failed'

interface InboxEntry {
  schema?: number
  url?: string
  written_at_ms?: number
  launch_timing?: CallbackTiming
}

function inboxDir(deps: HandoffInboxDependencies): string {
  return join(deps.home(), INBOX_DIRNAME)
}

function nowOf(deps: HandoffInboxDependencies): number {
  return deps.now ? deps.now() : Date.now()
}

function stateOf(url: string): string {
  return handoffFingerprint(parseCallbackUrl(url)?.state ?? '')
}

/** 二次实例退出前调用。失败不抛：兜底腿自己坏了不能把退出路径也拖下水。 */
export function parkCallbackUrl(
  deps: HandoffInboxDependencies,
  url: string,
  timing?: CallbackTiming | null
): ParkResult {
  const name = `${randomUUID()}${ENTRY_SUFFIX}`
  try {
    const dir = inboxDir(deps)
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `${name}${TMP_SUFFIX}`)
    const payload: InboxEntry = { schema: ENTRY_SCHEMA, url, written_at_ms: nowOf(deps) }
    const validated = validateCallbackTiming(timing, url)
    if (validated) payload.launch_timing = validated
    writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8' })
    renameSync(tmp, join(dir, name))
    return 'parked'
  } catch (e) {
    deps.log(
      `[shell] WARN handoff inbox park failed (${e instanceof Error ? e.message : String(e)});` +
        ` this login callback will be dropped (state=${stateOf(url)})\n`
    )
    return 'failed'
  }
}

/** 主实例消费收件箱。返回本轮真正投递出去的条目数。 */
export function drainInbox(
  deps: HandoffInboxDependencies,
  onUrl: (url: string, timing: CallbackTiming | null) => void
): number {
  const dir = inboxDir(deps)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  const deadline = nowOf(deps)
  let delivered = 0
  for (const name of names.sort()) {
    const file = join(dir, name)
    if (name.endsWith(TMP_SUFFIX)) {
      // 写了一半的残留：过了 TTL 还没被 rename 走，说明写方已死，清掉。
      pruneIfStale(file, deadline)
      continue
    }
    if (!name.endsWith(ENTRY_SUFFIX)) continue
    let raw = ''
    try {
      raw = readFileSync(file, { encoding: 'utf8' })
      rmSync(file)
    } catch {
      continue
    }
    let entry: InboxEntry
    try {
      entry = JSON.parse(raw) as InboxEntry
    } catch {
      deps.log(`[shell] WARN handoff inbox entry ${name} is not valid json; dropped\n`)
      continue
    }
    if (entry.schema !== ENTRY_SCHEMA || typeof entry.url !== 'string') {
      deps.log(`[shell] WARN handoff inbox entry ${name} has unknown shape; dropped\n`)
      continue
    }
    const writtenAt = Number(entry.written_at_ms || 0)
    if (deadline - writtenAt > STATE_TTL_MS) {
      deps.log(`[shell] handoff inbox entry expired (state=${stateOf(entry.url)}); dropped\n`)
      continue
    }
    delivered += 1
    deps.log(`[shell] handoff inbox entry consumed (state=${stateOf(entry.url)})\n`)
    onUrl(entry.url, validateCallbackTiming(entry.launch_timing, entry.url))
  }
  return delivered
}

function pruneIfStale(file: string, deadline: number): void {
  try {
    const { mtimeMs } = statSync(file)
    if (deadline - mtimeMs > STATE_TTL_MS) rmSync(file)
  } catch {
    // 残留清不掉无所谓，下一轮还会再试。
  }
}
