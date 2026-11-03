// integrity.ts — Windows 进程完整性级别自检（87498884 的诊断腿）。
//
// 提权运行是「浏览器回调送不到主实例」的前提条件，但主进程此前对此一无所知：既不落盘
// 也不提示。这里用 whoami /groups 的强制标签 SID 判一次并缓存：High=12288、Medium=8192。
// 非 Windows 返回 'n/a'，调用方据此决定要不要提示用户。
//
// whoami 显式走 SystemRoot\System32：Git 等工具会往 PATH 前面塞同名程序（仓库 Windows 约定）。

import { execFileSync } from 'child_process'
import { join } from 'path'

export type IntegrityLevel = 'high' | 'medium' | 'unknown' | 'n/a'

const HIGH_MANDATORY_SID = 'S-1-16-12288'
const MEDIUM_MANDATORY_SID = 'S-1-16-8192'
const WHOAMI_TIMEOUT_MS = 5_000

let cached: IntegrityLevel | null = null

/** 纯函数：谁都能测。输入 whoami /groups 的输出文本。 */
export function classifyIntegrityOutput(output: string): IntegrityLevel {
  if (output.includes(HIGH_MANDATORY_SID)) return 'high'
  if (output.includes(MEDIUM_MANDATORY_SID)) return 'medium'
  return 'unknown'
}

export function processIntegrityLevel(
  platform: NodeJS.Platform = process.platform
): IntegrityLevel {
  if (platform !== 'win32') return 'n/a'
  if (cached !== null) return cached
  try {
    const systemRoot = process.env['SystemRoot'] || 'C:\\Windows'
    const output = execFileSync(join(systemRoot, 'System32', 'whoami.exe'), ['/groups'], {
      encoding: 'utf8',
      timeout: WHOAMI_TIMEOUT_MS,
      windowsHide: true,
    })
    cached = classifyIntegrityOutput(output)
  } catch {
    cached = 'unknown'
  }
  return cached
}

/** 单测重置缓存用。 */
export function resetIntegrityCacheForTest(): void {
  cached = null
}
