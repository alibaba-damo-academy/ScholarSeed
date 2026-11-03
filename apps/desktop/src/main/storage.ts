// storage.ts — 数据位置引导层（proposal 112）。
//
// SCHOLARSEED_HOME 是产品唯一的可重定位数据根：全局文献库、凭证、记忆、技能、日志、
// Codex/Trace home 与 runtime 组件仓库（<home>/runtime）全部派生自它。serve 侧
// `paths.py` 在 import 时冻结 home，故 home 必须在 spawn serve 之前、且在主进程任何
// `desktopHome()` 读取之前就解析并注入 `process.env.SCHOLARSEED_HOME`。
//
// 「指向 home 的指针必须存在 home 之外」：指针文件落在 Electron userData（独立于 home），
// 各平台沿用 userData 指针；兼容已有安装的 SCHOLARSEED_HOME 环境变量。
// 解析优先级：显式 env > userData 指针 > 默认 ~/.scholarseed。
//
// 本模块不 import 业务路径常量：home 派生的一切产品路径归 serve `paths.py`，这里只负责
// Desktop 启动目录的选择；不解析 Serve 内部的数据布局。

import { Buffer } from 'node:buffer'
import {
  decodeStoragePointer,
  isValidAbsoluteRoot,
  STORAGE_CONFIG_MAX_BYTES,
  STORAGE_CONFIG_SCHEMA_VERSION,
} from './storage-record.ts'
import type { DataHomePointer } from './storage-record.ts'
export { isValidAbsoluteRoot, STORAGE_CONFIG_SCHEMA_VERSION } from './storage-record.ts'
export type { DataHomePointer } from './storage-record.ts'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmdirSync } from 'fs'
import { homedir, userInfo } from 'os'
import { dirname, join, resolve } from 'path'
import { app } from 'electron'
import type { CommitDataHomeResult } from '../storage'
import { writeJson } from './journal.ts'
import { desktopDirectoryWriter } from './writer'

/** 产品家目录环境变量名（与 serve `brand.py:HOME_ENV` 同字面值）。 */
export const SCHOLARSEED_HOME_ENV = 'SCHOLARSEED_HOME'
export const SCHOLARSEED_DEFAULT_WORKSPACE_ENV = 'SCHOLARSEED_DEFAULT_WORKSPACE'
const SESSION_DATA_PREFIX = 'scholarseed-desktop-session'
const LEGACY_HOME_DIRNAME = '.veda'
const DEV_DEFAULT_WORKSPACE_SUBPATH = ['tmp', 'desktop-workspace'] as const
/** 默认家目录名（~/.scholarseed）。 */
export const SCHOLARSEED_HOME_DIRNAME = '.scholarseed'
/** Permanent OS-account namespace shared with Serve's paths owner. */
export const COORDINATION_DIRNAME = '.scholarseed-coordination'
/** 容器根默认目录名（自定义 home 时落 <home 父目录>/Projects）。 */
export const PROJECTS_DIRNAME = 'Projects'
/** 默认 home 时容器根沿用「文档/ScholarSeed」（与既有打包默认一致）。 */
export const DEFAULT_HOME_WORKSPACE_DIRNAME = 'ScholarSeed'
/** 指针文件名，落 Electron userData（home 之外）。 */
export const STORAGE_CONFIG_FILENAME = 'storage-config.json'
/** 指针文件 schema 版本。 */
/** 可写探针目录名前缀；原子创建独占目录，不能清理用户已有的同名路径。 */
export const WRITE_PROBE_PREFIX = '.scholarseed-write-probe-'

/** The startup owner must supply the real process-owned native filesystem capability. */
export interface StorageNative {
  pin(path: string, create: boolean): unknown
  readAt(pin: unknown, name: string, maxBytes: number): Buffer | null
  release(pin: unknown): void
}

/** userData 指针文件形状（home 之外，承载 mac/dev 选定的 home）。 */

/** 当前进程的启动选择；不会因下一次启动的配置提交而改变。 */
export type StorageSource =
  | { readonly kind: 'environment'; readonly value: string }
  | { readonly kind: 'pointer'; readonly bytes: string }
  | { readonly kind: 'default' }

export interface StorageSelection {
  /** Initial observation only, never directory admission; pointer bytes are base64. */
  readonly source: Readonly<StorageSource>
  readonly home: string
  readonly userData: string
  readonly sessionData: string
  readonly workspace: string
  /** Only implicit defaults are created by Desktop; explicit roots remain caller-owned. */
  readonly createWorkspace: boolean
  readonly legacyHome: string | null
  readonly configured: boolean
  readonly firstLaunchEligible: boolean
}

let startup: Readonly<StorageSelection> | undefined
let pending: Readonly<StorageSelection> | undefined
let dataHomeChoiceConsumed = false

/** 指针文件路径，初始化后固定在本进程选择的 userData 下。 */
export function storageConfigPath(userData = startup?.userData ?? app.getPath('userData')): string {
  return join(userData, STORAGE_CONFIG_FILENAME)
}

/** 默认家目录 ~/.scholarseed。 */
export function defaultHome(): string {
  return join(homedir(), SCHOLARSEED_HOME_DIRNAME)
}

/** Query the effective OS account; do not use environment-selected product homes. */
export function coordinationRoot(): string {
  const account = userInfo().homedir
  if (!isValidAbsoluteRoot(account, process.platform))
    throw new Error('OS account directory is not an absolute supported root')
  return join(account, COORDINATION_DIRNAME)
}

function profileIdentity(directory: string): string {
  try {
    return realpathSync.native(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return resolve(directory)
  }
}

function chromiumSessionData(userData: string, namespace: string): string {
  const appData = app.getPath('appData')
  const defaultProfile = join(appData, app.getName())
  const root = profileIdentity(userData) === profileIdentity(defaultProfile) ? appData : userData
  return join(root, `${SESSION_DATA_PREFIX}-${namespace}`)
}

/**
 * mac/dev 首启一次性「高级」入口门控（proposal 112 §6.C/D-mac，与 NSIS 门控语义一致）：
 * 仅当 打包版 ∧ 无显式 env ∧ 无 userData 指针 ∧ 默认与旧 home 都不存在或为空。
 * 已有用户数据就绝不引导改 home（orphan 文献/会话）；dev/CI 由 env 掌控，不弹。
 */
function isFirstLaunchEligible(
  fromEnv: string,
  pointer: DataHomePointer | null,
  home: string,
  legacyHome: string | null
): boolean {
  if (!app.isPackaged || fromEnv || pointer) return false
  for (const directory of legacyHome ? [home, legacyHome] : [home]) {
    try {
      if (!lstatSync(directory).isDirectory()) return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      return false
    }
    try {
      if (readdirSync(directory).length > 0) return false
    } catch {
      return false
    }
  }
  return true
}

/** Selection failures must not silently redirect existing data to the default home. */
export class StorageConfigError extends Error {
  readonly code = 'ERR_STORAGE_CONFIG'
  constructor(
    readonly path: string,
    cause: unknown
  ) {
    super(`Cannot read storage pointer: ${path}`, { cause })
    this.name = 'StorageConfigError'
  }
}

/** Parse one bounded observation; native initial reads and qualified rereads share this owner. */
export function parseStorageConfig(bytes: Buffer | null, path: string): DataHomePointer | null {
  if (bytes === null) return null
  try {
    return decodeStoragePointer(bytes, process.platform)
  } catch (error) {
    throw new StorageConfigError(path, error)
  }
}

/** Initial observation only: directory binding is not writer admission or a final pointer recheck. */
function readStorageConfigBytes(native: StorageNative, userData?: string): Buffer | null {
  const directory = userData ?? startup?.userData ?? app.getPath('userData')
  const path = storageConfigPath(directory)
  let pin: unknown
  try {
    pin = native.pin(directory, false)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_LEASE_MISSING') return null
    throw new StorageConfigError(path, error)
  }
  let bytes: Buffer | null
  try {
    const observed = native.readAt(pin, STORAGE_CONFIG_FILENAME, STORAGE_CONFIG_MAX_BYTES)
    bytes = observed === null ? null : Buffer.from(observed)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_LEASE_RELEASE') {
      try {
        native.release(pin)
      } catch (releaseError) {
        throw new StorageConfigError(
          path,
          new AggregateError([error, releaseError], 'Uncertain storage directory release')
        )
      }
    }
    throw new StorageConfigError(path, error)
  }
  try {
    native.release(pin)
  } catch (error) {
    throw new StorageConfigError(path, error)
  }
  return bytes
}

export function readStorageConfig(
  native: StorageNative,
  userData?: string
): DataHomePointer | null {
  const directory = userData ?? startup?.userData ?? app.getPath('userData')
  return parseStorageConfig(readStorageConfigBytes(native, directory), storageConfigPath(directory))
}

/** 写指针文件（mac 高级入口 / dev）。父目录即 userData，必然存在。 */
export function writeStorageConfig(dataHome: string): void {
  const config: DataHomePointer = { schemaVersion: STORAGE_CONFIG_SCHEMA_VERSION, dataHome }
  const path = storageConfigPath()
  const writer = desktopDirectoryWriter(dirname(path))
  try {
    writeJson(path, config)
  } finally {
    writer.close()
  }
}

/**
 * 选择 home（显式 env > userData 指针 > 默认），只冻结候选，不发布 env 或消费者快照。
 * 发布前可重新选择，但任何重选（包括失败）都会作废旧候选；发布后禁止重选。
 * 指针和首启资格来自同一次读取，后续自己的日志/协调文件不能改变首启判据。
 * 这仅冻结路径选择，不代表已取得跨进程的数据域准入或迁移资格。
 */
export function selectStorage(
  sessionNamespace: string,
  native: StorageNative
): Readonly<StorageSelection> {
  if (startup) throw new Error('Desktop storage is already initialized')
  pending = undefined
  const userData = app.getPath('userData')
  const fromEnv = (process.env[SCHOLARSEED_HOME_ENV] || '').trim()
  const explicitWorkspace = process.env[SCHOLARSEED_DEFAULT_WORKSPACE_ENV]
  for (const [variable, value] of [
    [SCHOLARSEED_HOME_ENV, fromEnv],
    [SCHOLARSEED_DEFAULT_WORKSPACE_ENV, explicitWorkspace],
  ] as const) {
    if (value && !isValidAbsoluteRoot(value, process.platform))
      throw new Error(`${variable} must be an absolute supported root`)
  }
  const bytes = fromEnv ? null : readStorageConfigBytes(native, userData)
  const pointer = parseStorageConfig(bytes, storageConfigPath(userData))
  const source: Readonly<StorageSource> = Object.freeze(
    fromEnv
      ? { kind: 'environment', value: fromEnv }
      : bytes === null
        ? { kind: 'default' }
        : { kind: 'pointer', bytes: bytes.toString('base64') }
  )
  const defaultPath = defaultHome()
  const home = fromEnv || pointer?.dataHome || defaultPath
  const workspace =
    explicitWorkspace ||
    (app.isPackaged
      ? deriveWorkspaceDefault(home)
      : join(
          process.env.SCHOLARSEED_REPO || resolve(app.getAppPath(), '..', '..'),
          ...DEV_DEFAULT_WORKSPACE_SUBPATH
        ))
  const legacyHome = app.isPackaged ? join(userData, LEGACY_HOME_DIRNAME) : null
  const selected = Object.freeze({
    source,
    home,
    userData,
    sessionData: chromiumSessionData(userData, sessionNamespace),
    workspace,
    createWorkspace: !explicitWorkspace,
    legacyHome,
    configured: home !== defaultPath,
    firstLaunchEligible: isFirstLaunchEligible(fromEnv, pointer, defaultPath, legacyHome),
  })
  pending = selected
  return selected
}

/** Publish only the current immutable selection, after the startup owner finishes its checks. */
export function publishStorage(selected: Readonly<StorageSelection>): Readonly<StorageSelection> {
  if (startup) throw new Error('Desktop storage is already initialized')
  if (!pending || selected !== pending)
    throw new Error('Desktop storage selection is no longer current')
  // Consume before publishing: a failed environment write cannot be retried with
  // the same candidate, and consumers must not see a half-published startup.
  pending = undefined
  process.env[SCHOLARSEED_HOME_ENV] = selected.home
  startup = selected
  return selected
}

/** 启动时选定的 Desktop 目录；消费者不得在 backend 重启时重新解析。 */
export function desktopStorage(): Readonly<StorageSelection> {
  if (!startup) throw new Error('Desktop storage must be initialized before accessing directories')
  return startup
}

/** 当前进程唯一数据根；不能通过运行期 env/指针变更切换已启动的 writer。 */
export function desktopHome(): string {
  if (!startup) throw new Error('Desktop storage must be initialized before accessing home')
  return startup.home
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

/**
 * 校验并落定一个候选数据父目录 P：形状合法 + 可写（建探测子目录再删）。
 * 通过返回 { ok: true, home: P/.scholarseed }；失败返回原因码，调用方转 UI 文案。
 * 只删除本次原子创建的空探针。创建失败不清理其它路径；若探针意外非空则保留内容并失败。
 */
export function validateDataParent(
  parent: string,
  platform: NodeJS.Platform
): { ok: true; home: string } | { ok: false; reason: 'invalid_shape' | 'not_writable' } {
  if (!isValidAbsoluteRoot(parent, platform)) return { ok: false, reason: 'invalid_shape' }
  try {
    const probe = mkdtempSync(join(parent, WRITE_PROBE_PREFIX))
    rmdirSync(probe)
    return { ok: true, home: join(parent, SCHOLARSEED_HOME_DIRNAME) }
  } catch {
    return { ok: false, reason: 'not_writable' }
  }
}

/** One startup-owned choice; UI and the actual writer share the same eligibility. */
export function canCommitDataHome(native: StorageNative, platform = process.platform): boolean {
  return (
    platform !== 'win32' &&
    !!startup?.firstLaunchEligible &&
    !dataHomeChoiceConsumed &&
    readStorageConfig(native) === null
  )
}

/**
 * 提交一个数据父目录 P（mac「高级」入口 / dev）：校验 → 建 home → 写 userData 指针。
 * home 在下次启动经 selectStorage()/publishStorage() 生效（运行中的 serve 已冻结旧 home，故 restartRequired）。
 * 不在此处改 process.env：运行期改 home 会与已 import 的 serve 路径常量冲突（N3）。
 * Windows 不支持：home 由安装向导写 HKCU env，env 优先级高于指针，运行期改指针会被覆盖而
 * 静默无效，故直接回 unsupported（UI 据 canChangeDataHome 不在 Windows 暴露入口）。
 */
export function commitDataHome(
  parent: string,
  platform: NodeJS.Platform,
  native: StorageNative
): CommitDataHomeResult {
  if (!canCommitDataHome(native, platform)) return { ok: false, reason: 'unsupported' }
  const validated = validateDataParent(parent, platform)
  if (!validated.ok) return validated
  // Consume before effects: publication may succeed even when its durability
  // receipt fails. A later request must not redirect this startup a second time.
  dataHomeChoiceConsumed = true
  mkdirSync(validated.home, { recursive: true })
  writeStorageConfig(validated.home)
  return { ok: true, home: validated.home, restartRequired: true }
}
