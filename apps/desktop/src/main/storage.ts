// storage.ts — 数据位置引导层（proposal 112）。
//
// SCHOLARSEED_HOME 是产品唯一的可重定位数据根：全局文献库、凭证、记忆、技能、日志、
// Codex/Trace home 与 runtime 组件仓库（<home>/runtime）全部派生自它。serve 侧
// `paths.py` 在 import 时冻结 home，故 home 必须在 spawn serve 之前、且在主进程任何
// `desktopHome()` 读取之前就解析并注入 `process.env.SCHOLARSEED_HOME`。
//
// 「指向 home 的指针必须存在 home 之外」：指针文件落在 Electron userData（独立于 home），
// Windows 安装期由 NSIS 写 HKCU\Environment\SCHOLARSEED_HOME（见 installer.nsh），mac/dev
// 由 userData 指针承载。解析优先级：显式 env > userData 指针 > 默认 ~/.scholarseed。
//
// 本模块不 import 业务路径常量：home 派生的一切产品路径归 serve `paths.py`，这里只负责
// 「home 是哪个目录」与「容器根默认落哪」两个桌面侧决策。

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { app } from 'electron'
import type { CommitDataHomeResult } from '../storage'

/** 产品家目录环境变量名（与 serve `brand.py:HOME_ENV` 同字面值）。 */
export const SCHOLARSEED_HOME_ENV = 'SCHOLARSEED_HOME'
/** 默认家目录名（~/.scholarseed）。 */
export const SCHOLARSEED_HOME_DIRNAME = '.scholarseed'
/** 容器根默认目录名（自定义 home 时落 <home 父目录>/Projects）。 */
export const PROJECTS_DIRNAME = 'Projects'
/** 默认 home 时容器根沿用「文档/ScholarSeed」（与既有打包默认一致）。 */
export const DEFAULT_HOME_WORKSPACE_DIRNAME = 'ScholarSeed'
/** 指针文件名，落 Electron userData（home 之外）。 */
export const STORAGE_CONFIG_FILENAME = 'storage-config.json'
/** 指针文件 schema 版本。 */
export const STORAGE_CONFIG_SCHEMA_VERSION = 1
/** 可写探针子目录名（建后即删，验证候选父目录可写）。 */
export const WRITE_PROBE_DIRNAME = '.scholarseed-write-probe'

/** userData 指针文件形状（home 之外，承载 mac/dev 选定的 home）。 */
export interface DataHomePointer {
  schemaVersion: number
  dataHome: string
}

/** 指针文件路径（userData 下，独立于 home）。 */
export function storageConfigPath(): string {
  return join(app.getPath('userData'), STORAGE_CONFIG_FILENAME)
}

/** 默认家目录 ~/.scholarseed。 */
export function defaultHome(): string {
  return join(homedir(), SCHOLARSEED_HOME_DIRNAME)
}

/** home 是否经用户配置（注册表 env / 指针），而非回落默认。供关于页只读展示。 */
export function isDataHomeConfigured(): boolean {
  return resolveDataHome() !== defaultHome()
}

/**
 * mac/dev 首启一次性「高级」入口门控（proposal 112 §6.C/D-mac，与 NSIS 门控语义一致）：
 * 仅当 打包版 ∧ 无显式 env ∧ 无 userData 指针 ∧ 默认 home 不存在或为空。
 * 已有用户数据就绝不引导改 home（orphan 文献/会话）；dev/CI 由 env 掌控，不弹。
 */
export function isFirstLaunchEligible(): boolean {
  if (!app.isPackaged) return false
  if ((process.env[SCHOLARSEED_HOME_ENV] || '').trim()) return false
  if (readStorageConfig()) return false
  const home = defaultHome()
  if (existsSync(home)) {
    try {
      if (readdirSync(home).length > 0) return false
    } catch {
      return false
    }
  }
  return true
}

/** 读指针文件；缺失/损坏/形状非法一律回 null（不抛，由解析口回落默认）。 */
export function readStorageConfig(): DataHomePointer | null {
  try {
    const raw = readFileSync(storageConfigPath(), 'utf8')
    const value = JSON.parse(raw) as Partial<DataHomePointer>
    if (
      value &&
      value.schemaVersion === STORAGE_CONFIG_SCHEMA_VERSION &&
      typeof value.dataHome === 'string' &&
      value.dataHome.length > 0
    ) {
      return { schemaVersion: STORAGE_CONFIG_SCHEMA_VERSION, dataHome: value.dataHome }
    }
    return null
  } catch {
    return null
  }
}

/** 写指针文件（mac 高级入口 / dev）。父目录即 userData，必然存在。 */
export function writeStorageConfig(dataHome: string): void {
  const config: DataHomePointer = { schemaVersion: STORAGE_CONFIG_SCHEMA_VERSION, dataHome }
  writeFileSync(storageConfigPath(), JSON.stringify(config, null, 2), 'utf8')
}

/**
 * home 解析口：显式 env > userData 指针 > 默认。
 * Windows 安装期/升级协调写 HKCU\Environment\SCHOLARSEED_HOME，launch 时已环境化进
 * process.env，故 env 档即覆盖；mac 走指针；都没有则默认。
 */
export function resolveDataHome(): string {
  const fromEnv = (process.env[SCHOLARSEED_HOME_ENV] || '').trim()
  if (fromEnv) return fromEnv
  const pointer = readStorageConfig()
  if (pointer) return pointer.dataHome
  return defaultHome()
}

/**
 * 把解析出的 home 注入 process.env，使其成为后续所有 desktopHome() 读取与 spawn 子进程
 * 继承的唯一值。必须是主进程入口的第一条副作用（早于任何 desktopHome() 消费者）。
 * 幂等：已注入则解析结果不变。
 */
export function applyDataHomeEnv(): string {
  const home = resolveDataHome()
  process.env[SCHOLARSEED_HOME_ENV] = home
  return home
}

/**
 * 容器根默认值（条件函数，非常量不变量）：
 * - 默认 home（~/.scholarseed）→ 沿用「文档/ScholarSeed」（与既有打包默认一致，不退化成 ~/Projects）；
 * - 自定义 home（注册表/指针/协调结果）→ 与 home 同父目录的 Projects。
 * 用户在设置里改过 workspace_root 后，serve 侧设置优先级最高，本默认不覆盖。
 */
export function deriveWorkspaceDefault(home: string): string {
  if (home === defaultHome()) {
    return join(app.getPath('documents'), DEFAULT_HOME_WORKSPACE_DIRNAME)
  }
  return join(dirname(home), PROJECTS_DIRNAME)
}

/**
 * 绝对根形状校验（吸收原组件仓库覆盖轴的判据）。
 * Windows 认盘符与 UNC，POSIX 认前导 /；其余一律拒，让「指针/env 被手改坏」在解析口
 * 显式失败，而不是半路写出个不存在的数据根。
 */
export function isValidAbsoluteRoot(value: string, platform: NodeJS.Platform): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)
  return value.startsWith('/')
}

/**
 * 校验并落定一个候选数据父目录 P：形状合法 + 可写（建探测子目录再删）。
 * 通过返回 { ok: true, home: P/.scholarseed }；失败返回原因码，调用方转 UI 文案。
 * 跨平台：用 node:path 构造，探测子目录建后即删（成功/失败两路都清理，不留残留）。
 */
export function validateDataParent(
  parent: string,
  platform: NodeJS.Platform
): { ok: true; home: string } | { ok: false; reason: 'invalid_shape' | 'not_writable' } {
  if (!isValidAbsoluteRoot(parent, platform)) return { ok: false, reason: 'invalid_shape' }
  const probe = join(parent, WRITE_PROBE_DIRNAME)
  try {
    mkdirSync(probe, { recursive: true })
    const writable = existsSync(probe)
    rmSync(probe, { recursive: true, force: true })
    if (!writable) return { ok: false, reason: 'not_writable' }
    return { ok: true, home: join(parent, SCHOLARSEED_HOME_DIRNAME) }
  } catch {
    rmSync(probe, { recursive: true, force: true })
    return { ok: false, reason: 'not_writable' }
  }
}

/**
 * 提交一个数据父目录 P（mac「高级」入口 / dev）：校验 → 建 home → 写 userData 指针。
 * home 在下次启动经 resolveDataHome() 生效（运行中的 serve 已冻结旧 home，故 restartRequired）。
 * 不在此处改 process.env：运行期改 home 会与已 import 的 serve 路径常量冲突（N3）。
 * Windows 不支持：home 由安装向导写 HKCU env，env 优先级高于指针，运行期改指针会被覆盖而
 * 静默无效，故直接回 unsupported（UI 据 canChangeDataHome 不在 Windows 暴露入口）。
 */
export function commitDataHome(parent: string, platform: NodeJS.Platform): CommitDataHomeResult {
  if (platform === 'win32') return { ok: false, reason: 'unsupported' }
  const validated = validateDataParent(parent, platform)
  if (!validated.ok) return validated
  mkdirSync(validated.home, { recursive: true })
  writeStorageConfig(validated.home)
  return { ok: true, home: validated.home, restartRequired: true }
}
