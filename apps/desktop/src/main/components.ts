// Windows 组件仓库的运行时存储（proposal 108 §7.2，P2a）。
//
// 职责：按已冻结的 app-components.json 把 python / texlive 组件 provision 到
// `$SCHOLARSEED_HOME/runtime/`，命中即跳过展开；未命中走「校验压缩载荷 → 同卷 staging
// 展开 → 运行探测 → rename 发布不可变目录 → 提交 store 清单」的完整流程。崩溃遗留的
// staging 永远不算命中；发布后目录不可变（缓存/pycache 写别处，见提案）。
//
// 本模块不 import electron：storeRoot / backendDirectory / 日志 sink 全部由调用方注入，
// 逻辑可被 node --test 直测（解压器与探测器同样可注入，mac 上无需真 zip/tar.exe）。
// 生产解压原语是 System32 bsdtar 的绝对路径（避开 PATH 上 Git GNU tar 的 C: 歧义）。

import { spawn } from 'child_process'
import { createHash } from 'crypto'
import {
  appendFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { join } from 'path'

import {
  COMPONENTS_DIRNAME,
  APP_COMPONENTS_FILENAME,
  PYTHON_KIND,
  TEXLIVE_KIND,
  parseAppComponents,
  storeComponentDirectory,
  storeLockPath,
  storeLocksDirectory,
  storeManifestPath,
  storeManifestsDirectory,
  storeStagingDirectory
} from '../../runtime/components.cjs'
import type { AppComponentEntry, AppComponentsManifest } from '../../runtime/components.cjs'

export type ComponentLog = (line: string) => void

/** 注入点：把 archive 解到 destination（生产 = bsdtar；测试 = 目录拷贝）。 */
export type ComponentExtractor = (archive: string, destination: string) => Promise<void>

/** 注入点：组件发布前的运行探测（生产 = 真跑解释器/查引擎；测试 = 直通过）。 */
export type ComponentProbe = (component: AppComponentEntry, componentDirectory: string) => Promise<void>

export interface ProvisionedComponents {
  manifest: AppComponentsManifest
  pythonExecutable: string
  pythonComponentDirectory: string
  texliveBinDirectory: string
  texliveComponentDirectory: string
}

export interface EnsureComponentsOptions {
  /** resources/backend（含 components/ 载荷目录）。 */
  backendDirectory: string
  /** `<SCHOLARSEED_HOME>/runtime`。 */
  storeRoot: string
  log: ComponentLog
  extractor?: ComponentExtractor
  probe?: ComponentProbe
  now?: () => number
}

const COMPONENTS_LOG_CONTEXT = '[components]'
const LOCK_STALE_MS = 30 * 60 * 1000
const PUBLISHED_WAIT_INTERVAL_MS = 500
const PUBLISHED_WAIT_TIMEOUT_MS = 30 * 60 * 1000
const STAGING_SWEEP_AGE_MS = 6 * 60 * 60 * 1000
const PUBLISH_RENAME_ATTEMPTS = 5
const PUBLISH_RENAME_RETRY_DELAY_MS = 200
const TRANSIENT_RENAME_ERROR_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const WINDOWS_SYSTEM_ROOT_ENV = 'SystemRoot'
const WINDOWS_SYSTEM_ROOT_FALLBACK = 'C:\\Windows'
const TAR_EXECUTABLE_NAME = 'tar.exe'
const PYTHON_PROBE_ARGS = ['-I', '-B', '-c', 'import sqlite3, sys; print(sys.version); print(sqlite3.sqlite_version)'] as const

export function windowsTarExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return join(env[WINDOWS_SYSTEM_ROOT_ENV] || WINDOWS_SYSTEM_ROOT_FALLBACK, 'System32', TAR_EXECUTABLE_NAME)
}

export function defaultExtractor(tarExecutable = windowsTarExecutable()): ComponentExtractor {
  return (archive, destination) =>
    new Promise<void>((resolve, reject) => {
      // zip 归档按扩展名由 bsdtar 自动识别；-C 目标是同卷 staging 目录。
      const child = spawn(tarExecutable, ['-xf', archive, '-C', destination], { windowsHide: true })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', reject)
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`component extraction failed (${code}): ${stderr.slice(0, 500)}`))
      )
    })
}

function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk: Buffer | string) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Windows 上刚执行过探测的 staging 目录可能被 AV/系统短暂持有句柄，导致 rename
// 立即报 EPERM/EACCES/EBUSY。仅对这类瞬时锁错误按线性退避重试；其它错误立即抛出，
// 超过尝试上限也抛出，保持「探测通过才发布、否则 fail-closed」的语义不变。
async function renameWithRetry(
  from: string,
  to: string,
  log: (message: string) => void
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (
        attempt >= PUBLISH_RENAME_ATTEMPTS ||
        code === undefined ||
        !TRANSIENT_RENAME_ERROR_CODES.has(code)
      ) {
        throw error
      }
      log(
        `${COMPONENTS_LOG_CONTEXT} publish rename retry ${attempt}/${PUBLISH_RENAME_ATTEMPTS} after ${code}\n`
      )
      await delay(PUBLISH_RENAME_RETRY_DELAY_MS * attempt)
    }
  }
}

function isDirectoryEntry(path: string): boolean {
  try {
    // lstat 不跟随链接：组件目录与入口必须都是真实目录/文件，reparse/symlink 即拒。
    const stats = lstatSync(path)
    return stats.isDirectory()
  } catch {
    return false
  }
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

/** store 清单是「已发布」的唯一凭据：内容必须与本轮期望逐项一致才算命中。 */
function readStoreManifest(storeRoot: string, component: AppComponentEntry): boolean {
  try {
    const value = JSON.parse(readFileSync(storeManifestPath(storeRoot, component.contentId), 'utf8')) as Record<string, unknown>
    return (
      value.kind === component.kind &&
      value.contentId === component.contentId &&
      value.archiveSha256 === component.archiveSha256 &&
      value.entry === component.entry &&
      typeof value.publishedAt === 'number'
    )
  } catch {
    return false
  }
}

function entryPathOf(componentDirectory: string, component: AppComponentEntry): string {
  // entry 在清单校验里已拒绝绝对路径；再按段拒绝 `..`，防清单被本地篡改后穿越。
  const segments = component.entry.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`component entry is not a safe relative path: ${component.entry}`)
  }
  return join(componentDirectory, ...segments)
}

function componentHit(storeRoot: string, target: string, component: AppComponentEntry): boolean {
  if (!readStoreManifest(storeRoot, component)) return false
  const directory = storeComponentDirectory(storeRoot, component.kind, target, component.contentId)
  return isDirectoryEntry(directory) && existsSync(entryPathOf(directory, component))
}

interface LockState {
  path: string
  acquired: boolean
}

/**
 * O_EXCL 锁：多实例不得同时发布同一组件（提案 §7.2）。拿不到锁 = 别的实例正在
 * provision，本实例等待其发布结果而不是并发解压。
 */
function acquireComponentLock(storeRoot: string, contentId: string, pid: number, now: () => number): LockState {
  const lockPath = storeLockPath(storeRoot, contentId)
  mkdirSync(storeLocksDirectory(storeRoot), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, `${JSON.stringify({ pid, at: now() })}\n`, { flag: 'wx' })
      return { path: lockPath, acquired: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const holder = JSON.parse(readFileSync(lockPath, 'utf8')) as { at?: number }
        if (typeof holder.at === 'number' && now() - holder.at > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true })
          continue
        }
      } catch {
        // 锁文件损坏：按陈旧处理，下一轮重建。
        rmSync(lockPath, { force: true })
        continue
      }
      return { path: lockPath, acquired: false }
    }
  }
  return { path: lockPath, acquired: false }
}

function releaseComponentLock(lock: LockState): void {
  if (!lock.acquired) return
  try {
    rmSync(lock.path, { force: true })
  } catch {
    // 锁清理失败不影响安装结果，只会让下一轮等到陈旧阈值。
  }
}

async function waitForPublishedComponent(
  storeRoot: string,
  target: string,
  component: AppComponentEntry,
  log: ComponentLog,
  now: () => number
): Promise<void> {
  const deadline = now() + PUBLISHED_WAIT_TIMEOUT_MS
  while (now() < deadline) {
    if (componentHit(storeRoot, target, component)) return
    await delay(PUBLISHED_WAIT_INTERVAL_MS)
  }
  throw new Error(`timed out waiting for another instance to publish ${component.kind} ${component.contentId}`)
}

async function publishComponent(
  options: EnsureComponentsOptions,
  target: string,
  component: AppComponentEntry,
  extractor: ComponentExtractor,
  probe: ComponentProbe,
  now: () => number
): Promise<void> {
  const { backendDirectory, storeRoot, log } = options
  const archive = join(backendDirectory, COMPONENTS_DIRNAME, component.archive)
  if (!isRegularFile(archive)) throw new Error(`component archive is missing: ${component.archive}`)
  const startedAt = now()
  const digest = await sha256OfFile(archive)
  if (digest.toLowerCase() !== component.archiveSha256.toLowerCase()) {
    // 载荷不可信：不展开、不发布，直接失败（fail-closed，绝不回落宿主运行时）。
    throw new Error(`component archive SHA-256 differs from manifest: ${component.archive}`)
  }
  const stagingRoot = storeStagingDirectory(storeRoot)
  mkdirSync(stagingRoot, { recursive: true })
  const staging = join(stagingRoot, `${component.contentId}-${process.pid}-${now()}`)
  mkdirSync(staging)
  try {
    await extractor(archive, staging)
    const finalDirectory = storeComponentDirectory(storeRoot, component.kind, target, component.contentId)
    if (!existsSync(join(staging, ...component.entry.split('/')))) {
      throw new Error(`extracted component does not contain its entry: ${component.entry}`)
    }
    await probe(component, staging)
    if (existsSync(finalDirectory)) {
      // 崩溃遗留的半发布目录：没有 store 清单就不是有效命中，清掉重新发布。
      rmSync(finalDirectory, { recursive: true, force: true })
    }
    mkdirSync(join(storeRoot, component.kind), { recursive: true })
    await renameWithRetry(staging, finalDirectory, log)
    mkdirSync(storeManifestsDirectory(storeRoot), { recursive: true })
    writeFileSync(
      storeManifestPath(storeRoot, component.contentId),
      `${JSON.stringify({ ...component, publishedAt: now() })}\n`
    )
    log(`${COMPONENTS_LOG_CONTEXT} published ${component.kind} ${component.contentId} in ${now() - startedAt}ms\n`)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

let cachedManifest: { backendDirectory: string; manifest: AppComponentsManifest } | null = null

export function readAppComponents(options: Pick<EnsureComponentsOptions, 'backendDirectory'>): AppComponentsManifest {
  if (cachedManifest && cachedManifest.backendDirectory === options.backendDirectory) return cachedManifest.manifest
  const path = join(options.backendDirectory, COMPONENTS_DIRNAME, APP_COMPONENTS_FILENAME)
  const manifest = parseAppComponents(readFileSync(path, 'utf8'))
  if (manifest === null) throw new Error(`app components manifest is unusable: ${path}`)
  cachedManifest = { backendDirectory: options.backendDirectory, manifest }
  return manifest
}

export function defaultProbe(): ComponentProbe {
  return async (component, componentDirectory) => {
    const entry = join(componentDirectory, ...component.entry.split('/'))
    if (component.kind === PYTHON_KIND) {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(entry, [...PYTHON_PROBE_ARGS], { windowsHide: true })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        child.on('error', reject)
        child.on('close', (code) =>
          code === 0
            ? resolve(stdout.trim())
            : reject(new Error(`python component probe failed (${code}): ${stderr.slice(0, 300)}`))
        )
      })
      if (!output.includes('.')) throw new Error('python component probe returned no version')
      return
    }
    if (component.kind === TEXLIVE_KIND) {
      for (const executable of component.executables ?? []) {
        const engine = join(entry, `${executable}.exe`)
        if (!isRegularFile(engine)) throw new Error(`texlive component is missing engine ${executable}`)
      }
      return
    }
    throw new Error(`unsupported component kind: ${component.kind}`)
  }
}

/**
 * provision 全部组件并返回解析好的运行路径。命中路径不遍历组件树（提案 §7.2：
 * store 清单 + 入口存在即命中）；任何失败都抛错，由调用方按启动失败处理。
 */
export async function ensureComponents(options: EnsureComponentsOptions): Promise<ProvisionedComponents> {
  const now = options.now ?? (() => Date.now())
  const manifest = readAppComponents(options)
  const extractor = options.extractor ?? defaultExtractor()
  const probe = options.probe ?? defaultProbe()
  const { storeRoot, log } = options
  sweepStaleStaging(storeRoot, now, log)
  const directories = new Map<string, string>()
  for (const component of manifest.components) {
    const startedAt = now()
    const lock = acquireComponentLock(storeRoot, component.contentId, process.pid, now)
    try {
      if (componentHit(storeRoot, manifest.target, component)) {
        log(`${COMPONENTS_LOG_CONTEXT} hit ${component.kind} ${component.contentId}\n`)
      } else if (lock.acquired) {
        log(`${COMPONENTS_LOG_CONTEXT} provisioning ${component.kind} ${component.contentId}\n`)
        await publishComponent(options, manifest.target, component, extractor, probe, now)
      } else {
        await waitForPublishedComponent(storeRoot, manifest.target, component, log, now)
      }
      const directory = storeComponentDirectory(storeRoot, component.kind, manifest.target, component.contentId)
      if (!componentHit(storeRoot, manifest.target, component)) {
        throw new Error(`component ${component.kind} ${component.contentId} is not usable after provisioning`)
      }
      directories.set(component.kind, directory)
      log(`${COMPONENTS_LOG_CONTEXT} ready ${component.kind} in ${now() - startedAt}ms\n`)
    } finally {
      releaseComponentLock(lock)
    }
  }
  const pythonDirectory = directories.get(PYTHON_KIND)
  const texliveDirectory = directories.get(TEXLIVE_KIND)
  if (!pythonDirectory || !texliveDirectory) throw new Error('app components manifest did not resolve both kinds')
  const python = manifest.components.find((component) => component.kind === PYTHON_KIND)
  const texlive = manifest.components.find((component) => component.kind === TEXLIVE_KIND)
  return {
    manifest,
    pythonExecutable: join(pythonDirectory, ...(python?.entry ?? '').split('/')),
    pythonComponentDirectory: pythonDirectory,
    texliveBinDirectory: join(texliveDirectory, ...(texlive?.entry ?? '').split('/')),
    texliveComponentDirectory: texliveDirectory
  }
}

/** 崩溃遗留 staging 回收：只清「无锁且超龄」的目录，正在发布的不碰。 */
export function sweepStaleStaging(storeRoot: string, now: () => number, log: ComponentLog): void {
  const stagingRoot = storeStagingDirectory(storeRoot)
  try {
    if (!existsSync(stagingRoot)) return
    for (const entry of readdirSync(stagingRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = join(stagingRoot, entry.name)
      try {
        const age = now() - statSync(full).mtimeMs
        if (age < STAGING_SWEEP_AGE_MS) continue
        rmSync(full, { recursive: true, force: true })
        log(`${COMPONENTS_LOG_CONTEXT} swept stale staging ${entry.name}\n`)
      } catch {
        // 单个目录清理失败不影响本轮 provision。
      }
    }
  } catch {
    // staging 根都读不了：留给发布路径自己去 mkdir。
  }
}

/**
 * 未被当前 app 清单引用的组件回收（提案 §7.3：至少保留当前引用；Windows 无旧版回滚，
 * 恢复引用 = 当前引用）。更新关键路径之外调用，best-effort。
 */
export function sweepUnreferencedComponents(storeRoot: string, referenced: Iterable<string>, log: ComponentLog): void {
  const keep = new Set(referenced)
  for (const kind of [PYTHON_KIND, TEXLIVE_KIND]) {
    const root = join(storeRoot, kind)
    try {
      if (!existsSync(root)) continue
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const contentId = entry.name.slice(entry.name.lastIndexOf('-') + 1)
        if (keep.has(contentId)) continue
        const lock = acquireComponentLock(storeRoot, contentId, process.pid, () => Date.now())
        try {
          if (!lock.acquired) continue
          rmSync(join(root, entry.name), { recursive: true, force: true })
          rmSync(storeManifestPath(storeRoot, contentId), { force: true })
          log(`${COMPONENTS_LOG_CONTEXT} collected unreferenced ${kind} ${contentId}\n`)
        } finally {
          releaseComponentLock(lock)
        }
      }
    } catch {
      // GC 是附带动作，失败只影响磁盘占用。
    }
  }
}

/** 把一行组件事件追加到 logs/components.log（best-effort，写失败不影响启动）。 */
export function persistComponentLog(logsDirectory: string, line: string): void {
  try {
    mkdirSync(logsDirectory, { recursive: true })
    appendFileSync(join(logsDirectory, 'components.log'), line)
  } catch {
    // 日志落盘失败不阻断 provision。
  }
}
