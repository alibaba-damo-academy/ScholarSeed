import { retryUpdate, transientUpdateFailure, UpdateTransportError } from './retry.ts'
import { assertDownloadSpace, assertUpdateSpace, downloadWithProgress } from './download.ts'
import {
  archiveApplicationArguments,
  MACOS_ARCHIVE_TIMEOUT_MS,
  MACOS_DITTO,
  preflightApplicationArchive,
  UpdateArchiveLimitError,
} from './archive.ts'
import { desktopDirectoryMaintenance, desktopDirectoryWriter } from './writer'
import {
  captureRecord,
  sameRecord,
  TERMINAL_RECORD_LIMITS,
  type CapturedRecord,
} from './terminal.ts'
// ScholarSeed desktop update client. The main process is the single state owner;
// release identity comes from the immutable packaged product.json policy.

import { app, autoUpdater, shell } from 'electron'
import { createHash, randomUUID } from 'crypto'
import {
  ActivationCandidateChanged,
  ActivationExpired,
  requestActivationGrant,
  commitWithActivation,
} from './update-authorization.ts'
export { ActivationCandidateChanged } from './update-authorization.ts'
import {
  accessSync,
  constants as fsConstants,
  createReadStream,
  existsSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { removeUpdateArtifact } from './update-files'

import { InstallationProgress } from './installation.ts'
import type { ObservedUpdateLaunch, UpdateLaunchContext } from './relaunch.ts'
import {
  SquirrelInstallation,
  discardOnTerminalSquirrelFailure,
  readSquirrelHandoff,
  decodeSquirrelHandoff,
  abandonedSquirrelRequest,
  type SquirrelArchive,
  type SquirrelHandoff,
  type SquirrelNativeCapture,
  type SquirrelLaunchCleanup,
  shipItDiagnostics,
  squirrelHandoffRecordPath,
  UPDATE_STATE_DIRECTORY,
} from './squirrel.ts'
import {
  bindSquirrelRequest,
  inspectSquirrelStartup,
  settleSquirrelStartup,
  inspectSquirrelIdle,
  inspectCancelledSquirrelPreparation,
  inspectLegacySquirrelPublisher,
  squirrelPreparedDevice,
  squirrelNativeRequestAbsent,
  verifySquirrelReplacement,
  squirrelLaunchSuperseded,
  squirrelAdmission,
  type SquirrelAdmission,
  type SquirrelStartupStatus,
} from './squirrelstartup.ts'
import { retryMacCleanup } from './squirrelcleanup.ts'
import { RotatingFileLog } from './logfile'
import { redactUpdateLog } from './redaction.ts'
import { readRecord, writeJson } from './journal.ts'
import {
  appendPreviewContext,
  previewAllows,
  previewContext,
  previewLine,
  previewScope,
  restorePreviewPolicy,
  samePreviewArtifact,
  PREVIEW_STATE_FILE,
  PREVIEW_STATE_LIMIT,
  PREVIEW_STATE_SCHEMA,
} from './preview.ts'
import type { PreviewContext } from './preview.ts'
import { isPreviewUpdateChannel } from '../updates.ts'
import type { PreviewUpdatePolicy, PreviewUpdateLine } from '../updates.ts'
import type { PreparationCheckpoint } from './preparation.ts'

import { LOGS_DIRNAME, resolveProductConfig } from './backend'
import { desktopHome, desktopStorage } from './storage'
import { classifyMacosTrust, parseCodesignIdentity } from './codesign.ts'
import {
  NotarizationError,
  notarizationHash,
  verifyNotarization,
  type OfflineNotarization,
} from './notarization.ts'
import { readMachArchitectures } from './macho.ts'
import { PreparedArchive, PreparedArtifactChangedError, preparedIdentity } from './prepared.ts'
import { systemCacheDir } from './cachedir.ts'
import {
  MACOS_HDIUTIL,
  mountPointsOfImage,
  readHdiutilInfoPlist,
  withDmgCleanup,
} from './mounts.ts'
import { planUpdatePrune, stagedInstallerName, updateArtifactKind } from './staging.ts'
import type { UpdateArtifactEntry } from './staging.ts'
import { requireCommandAsync, runCommandAsync, type CommandOptions } from './subprocess.ts'
import {
  UPDATE_PATH_PREFIX,
  buildUpdateCheckUrl,
  desktopArchType,
  identityMismatches,
  parseDownloadInfo,
  parseUpdateCheckResult,
} from './release.ts'
import type { DesktopUpdateConfig } from './release.ts'
import { LOCAL_RELEASE_LANE } from './product.ts'
import type {
  DownloadInfo,
  LatestVersionMeta,
  StartUpdateResult,
  UpdateCheckResult,
  UpdateDiagnosis,
  UpdateInstallFallback,
  UpdateProgress,
  UpdateSnapshot,
} from '../updates.ts'
import { isNewerRelease } from './version.ts'

export type LogSink = (line: string) => void

const UPDATE_CACHE_DIRNAME = 'scholarseed-update'
const SQUIRREL_HANDOFF_LOCK = 'squirrel-handoff.lock'
const UPDATE_CACHE_PROFILE_DIRNAME = 'profiles'
const INACTIVE_UPDATE_CACHE_RETENTION_MS = 7 * 24 * 60 * 60_000
const PREVIEW_CANDIDATE_DIRNAME = 'preview'
// 计时/结果日志额外落一份到 $SCHOLARSEED_HOME/logs/update.log（见 persistUpdateLog）。
export const UPDATE_LOG_FILE = 'update.log'
const UPDATE_LOG_MAX_BYTES = 4 * 1024 * 1024
let updateLog: RotatingFileLog | null = null
const REQUEST_TIMEOUT_MS = 8000
const MACOS_PLATFORM = 'darwin'
const MACOS_ARM64_ARCH_TYPE = 'darwin-arm64'
const MACOS_ARM64 = 'arm64'
const MACOS_X86_64 = 'x86_64'
const WINDOWS_PLATFORM = 'win32'
const PRODUCT_APPLICATION = 'ScholarSeed.app'
// 同一镜像已经挂着时 hdiutil attach 恒报 resource busy（报错文案还随系统语言本地化，不能
// 拿错误串当判据）：陈旧挂载可能来自崩掉的上一轮、手动安装兜底在 Finder 里留下的卷。attach
// 前按 image-path 清扫是自己的挂载态恢复；重试一次覆盖 detach 尚未落定的瞬态忙。
const DMG_ATTACH_ATTEMPTS = 2
const DMG_ATTACH_RETRY_DELAY_MS = 1500
const nativeNotarization: OfflineNotarization | undefined =
  process.platform === 'darwin' ? require('./notarization.node') : undefined

// macOS 安装准备链的外部命令上限（bug 87253073）：hdiutil/codesign 任一条挂起
// （本地校验、diskarbitration 忙）都不会自己退出，没有上限遮罩就永久转圈、用户只能
// 强杀。挂载类命令给 2 分钟；签名/公证校验在慢盘上 codesign --deep 本来就要几十秒，给 3 分钟；
// ditto 整包拷贝按最慢机械盘估 10 分钟。超时即失败并回到可重试态，绝不无限等。
const MACOS_MOUNT_COMMAND_TIMEOUT_MS = 120_000
const MACOS_SIGNATURE_COMMAND_TIMEOUT_MS = 180_000
// 结构化事件行的 schema 版本（提案 §5.1 字段契约）。
const UPDATE_EVENT_SCHEMA_VERSION = 1
const READY_STATE_FILE = 'ready.json'
const ANNOUNCED_STATE_FILE = 'announced.json'
// 部分文件比远端对象还大时服务端回这个；留着它只会每次都 416，必须删掉从头下。
// 协议级诊断串，不是界面文案：渲染层把它们当错误详情透出，翻译归属在展示侧。
const DOWNLOAD_METADATA_FAILED = 'download metadata failed'
export const NO_STAGED_UPDATE = 'no staged update to install'

/**
 * 一个已下载并通过 SHA-512 校验、等用户挑时间重启的安装包。
 *
 * 必须跨客户端重启保留：PRD 要求「已完成的下载」不因用户关闭更新卡、选择「稍后」
 * 或重启客户端而作废。只存磁盘路径与安装/校验所需的发布身份，不存 download_url ——
 * 那是短期签名链接，安装阶段用不到它。
 */
interface ReadyState {
  at: number
  path: string
  meta: LatestVersionMeta
  archive?: SquirrelArchive
}

/** 弹窗收起确认；key 是 `updateCandidateKey` 算出来的候选身份。 */
interface AnnouncedState {
  at: number
  key: string
}

export function resolveDesktopConfig(log: LogSink): DesktopUpdateConfig {
  const product = resolveProductConfig(log)
  return {
    baseUrl: product.updateBaseUrl,
    channel: product.updateChannel,
    buildNumber: product.buildNumber,
    productId: product.productId,
    bundleId: product.bundleId,
    expectedTeamId: product.expectedTeamId,
    expectedWindowsPublisher: product.expectedWindowsPublisher,
    releaseLane: product.releaseLane,
  }
}

let previewPolicy: PreviewUpdatePolicy | null = null
let previewRevision = 0
let previewLines: PreviewUpdateLine[] = []
const validatedPreviewCandidates = new Map<string, LatestVersionMeta>()

export function previewUpdatesEnabled(log: LogSink): boolean {
  return isPreviewUpdateChannel(resolveDesktopConfig(log).channel)
}

function previewSource(log: LogSink): string {
  const config = resolveDesktopConfig(log)
  return JSON.stringify([
    config.productId,
    config.bundleId,
    archType(),
    app.getVersion(),
    config.buildNumber,
  ])
}

export function getPreviewUpdatePolicy(log: LogSink): PreviewUpdatePolicy {
  if (!previewUpdatesEnabled(log)) throw new Error('Preview update controls are unavailable')
  if (!previewPolicy) {
    const config = resolveDesktopConfig(log)
    const path = join(updateStateDirectory(), PREVIEW_STATE_FILE)
    try {
      const record = JSON.parse(readRecord(path, PREVIEW_STATE_LIMIT).toString('utf8'))
      const source = previewSource(log)
      previewPolicy = restorePreviewPolicy(
        record,
        source,
        (candidate) =>
          parseUpdateCheckResult({ has_update: true, latest: candidate }, config, archType() || '')
            .latest!
      )
      if (record.source !== source) {
        const restored = previewPolicy
        // Consume old source consent durably, so reinstalling it cannot revive the target.
        previewPolicy = null
        writePreviewUpdatePolicy(restored, log)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      previewPolicy = { scope: 'current-line' }
    }
  }
  if (!previewPolicy) throw new Error('Preview policy could not be restored')
  return structuredClone(previewPolicy)
}

export function previewPolicyRevision(): number {
  return previewRevision
}

export function writePreviewUpdatePolicy(policy: PreviewUpdatePolicy, log: LogSink): void {
  if (!previewUpdatesEnabled(log)) throw new Error('Preview update controls are unavailable')
  previewScope(policy.scope)
  const writer = desktopDirectoryWriter(updateStateDirectory())
  try {
    writeJson(join(updateStateDirectory(), PREVIEW_STATE_FILE), {
      ...policy,
      schema: PREVIEW_STATE_SCHEMA,
      source: previewSource(log),
    })
    previewPolicy = structuredClone(policy)
    previewRevision += 1
    previewLines = []
    validatedPreviewCandidates.clear()
  } finally {
    writer.close()
  }
}

export function previewCandidateAllowed(candidate: LatestVersionMeta, log: LogSink): boolean {
  if (!previewUpdatesEnabled(log)) return true
  const config = resolveDesktopConfig(log)
  return previewAllows(getPreviewUpdatePolicy(log), app.getVersion(), config.buildNumber, candidate)
}

export function isCurrentPreviewResult(result: UpdateCheckResult): boolean {
  return result.previewRevision === undefined || result.previewRevision === previewRevision
}

function currentPreviewContext(log: LogSink): PreviewContext {
  const config = resolveDesktopConfig(log)
  return previewContext(
    getPreviewUpdatePolicy(log),
    app.getVersion(),
    config.buildNumber,
    archType() === 'windows-amd64' && config.releaseLane === 'distribution' ? 'velopack' : undefined
  )
}

export async function listPreviewUpdateLines(log: LogSink): Promise<PreviewUpdateLine[]> {
  const config = resolveDesktopConfig(log)
  const context = currentPreviewContext(log)
  const revision = previewRevision
  const url = new URL(buildUpdateCheckUrl(config, app.getVersion(), archType() || ''))
  url.pathname = `${UPDATE_PATH_PREFIX}/preview/lines`
  url.searchParams.delete('channel')
  appendPreviewContext(url, context)
  url.searchParams.delete('target_id')
  url.searchParams.delete('target_line')
  const raw = (await getJson(url.toString(), log)) as { lines?: unknown }
  if (revision !== previewRevision) throw new Error('Preview policy changed during discovery')
  if (!Array.isArray(raw?.lines) || raw.lines.length > 100) throw new Error('Invalid preview lines')
  const seen = new Set<string>()
  previewLines = raw.lines.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid preview line')
    const latest = parseUpdateCheckResult(
      { has_update: true, latest: item.latest },
      config,
      archType() || ''
    ).latest!
    if (
      item.line !== previewLine(latest.version) ||
      item.line === previewLine(app.getVersion()) ||
      isNewerRelease(
        { version: app.getVersion(), buildNumber: config.buildNumber },
        { version: latest.version, buildNumber: latest.build_number }
      ) !== true ||
      seen.has(item.line)
    )
      throw new Error('Invalid preview target line')
    seen.add(item.line)
    return { line: item.line, latest }
  })
  return structuredClone(previewLines)
}

export function previewTarget(id: unknown, log: LogSink): LatestVersionMeta {
  getPreviewUpdatePolicy(log)
  if (typeof id !== 'string') throw new Error('Invalid preview target')
  const line = previewLines.find((entry) => entry.latest.id === id)
  if (!line) throw new Error('Preview target is no longer listed')
  return structuredClone(line.latest)
}

/** Online eligibility is checked even when the archive is already cached. */
export async function validatePreviewCandidate(
  candidate: LatestVersionMeta,
  log: LogSink,
  signal?: AbortSignal
): Promise<void> {
  if (!previewUpdatesEnabled(log)) return
  if (!previewCandidateAllowed(candidate, log))
    throw new Error('Preview candidate is outside the selected range')
  const revision = previewRevision
  const fresh = await getDownloadInfo(candidate.id, log, signal)
  if (revision !== previewRevision || !samePreviewArtifact(candidate, fresh))
    throw new Error('Preview candidate changed during validation')
  validatedPreviewCandidates.set(candidate.id, structuredClone(fresh))
}

export function previewCandidateValidated(candidate: LatestVersionMeta, log: LogSink): boolean {
  if (!previewUpdatesEnabled(log)) return true
  const validated = validatedPreviewCandidates.get(candidate.id)
  return (
    !!validated &&
    samePreviewArtifact(validated, candidate) &&
    previewCandidateAllowed(candidate, log)
  )
}

export function archType(platform = process.platform, arch = process.arch): string | null {
  return desktopArchType(platform, arch)
}

function monotonicUpdateResult(
  currentVersion: string,
  config: DesktopUpdateConfig,
  result: UpdateCheckResult,
  log: LogSink
): UpdateCheckResult {
  if (!result.has_update || !result.latest) return result
  const newer = isNewerRelease(
    { version: currentVersion, buildNumber: config.buildNumber },
    { version: result.latest.version, buildNumber: result.latest.build_number }
  )
  if (newer !== false) return result
  log(
    `[update] ignored non-monotonic candidate ${result.latest.version}-${result.latest.build_number}\n`
  )
  return { has_update: false, latest: null }
}

async function getJson(url: string, log: LogSink, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const response = await fetch(url, {
      signal: requestSignal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new UpdateTransportError(response.status)
    }
    return await response.json()
  } catch (error) {
    log(`[update] request failed ${url}: ${String(error)}\n`)
    throw error
  }
}

export async function authorizeActivation(
  candidate: LatestVersionMeta,
  log: LogSink,
  signal: AbortSignal
): Promise<() => void> {
  const product = resolveProductConfig(log)
  if (!Object.keys(product.updateActivationKeys).length) {
    throw new Error('update activation trust roots are not configured')
  }
  const config = resolveDesktopConfig(log)
  parseUpdateCheckResult({ has_update: true, latest: candidate }, config, archType() || '')
  if (
    isNewerRelease(
      { version: app.getVersion(), buildNumber: config.buildNumber },
      { version: candidate.version, buildNumber: candidate.build_number }
    ) !== true
  )
    throw new Error('prepared update is not newer than the running release')
  await validatePreviewCandidate(candidate, log, signal)
  const revision = previewRevision
  const context = previewUpdatesEnabled(log) ? currentPreviewContext(log) : undefined
  const grant = await requestActivationGrant(
    `${product.updateBaseUrl}${UPDATE_PATH_PREFIX}/authorize-activation`,
    product.updateActivationKeys,
    candidate,
    signal,
    REQUEST_TIMEOUT_MS,
    context
  )
  logUpdateLine(
    log,
    `[update] activation authorized candidate=${candidate.id} revision=${grant.revision}\n`
  )
  return () => {
    if (context && (revision !== previewRevision || !previewCandidateAllowed(candidate, log)))
      throw new Error('Preview policy changed before activation')
    grant.assertValid()
  }
}

function updateStateDirectory(): string {
  return join(desktopHome(), UPDATE_STATE_DIRECTORY)
}

// Candidate records and payloads may be revoked independently of release.
// Keep installation/recovery journals at their existing paths.
function candidateStateDirectory(): string {
  const base = updateStateDirectory()
  const directory =
    process.platform === MACOS_PLATFORM
      ? join(base, UPDATE_CACHE_PROFILE_DIRNAME, updateProfileKey())
      : base
  return previewUpdatesEnabled(() => {}) ? join(directory, PREVIEW_CANDIDATE_DIRNAME) : directory
}

const PREPARATION_STATE_FILE = 'preparation.json'
const REJECTED_STATE_FILE = 'rejected.json'
const REJECTED_STATE_LOCK = 'rejected.lock'
const REJECTED_STATE_LIMIT = 4096

function rejectedUpdatePath(): string {
  const directory = updateStateDirectory()
  // Rejections predate profile-scoped preparation and remain shared by channel.
  return previewUpdatesEnabled(() => {})
    ? join(directory, PREVIEW_CANDIDATE_DIRNAME, REJECTED_STATE_FILE)
    : join(directory, REJECTED_STATE_FILE)
}

function readRejectedUpdate(path = rejectedUpdatePath()): { id: string; revision: string } | null {
  try {
    const record = JSON.parse(readRecord(path, REJECTED_STATE_LIMIT).toString('utf8'))
    if (
      typeof record.id !== 'string' ||
      !record.id ||
      typeof record.revision !== 'string' ||
      !record.revision
    )
      throw new Error('Invalid rejected update record')
    return record
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function withRejectedRecordLock(path: string, mutate: () => void): void {
  const writer = desktopDirectoryWriter(dirname(path))
  try {
    writer.withRecordLock(REJECTED_STATE_LOCK, mutate)
  } finally {
    writer.close()
  }
}

async function persistRejectedUpdate(candidate: LatestVersionMeta): Promise<void> {
  const path = rejectedUpdatePath()
  await retryUpdate(async () => {
    try {
      withRejectedRecordLock(path, () =>
        writeJson(path, { id: candidate.id, revision: randomUUID() })
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_LEASE_BUSY')
        throw Object.assign(new Error('Update rejection record is busy', { cause: error }), {
          code: 'EBUSY',
        })
      throw error
    }
  })
  validatedPreviewCandidates.delete(candidate.id)
}

/** Persist revocation before cleanup so a crash cannot restore installation readiness. */
export async function discardRejectedUpdate(
  candidate: LatestVersionMeta,
  log: LogSink
): Promise<void> {
  await persistRejectedUpdate(candidate)
  const staged = readReadyState()
  if (staged?.meta.id === candidate.id) dropStagedUpdate(staged, log)
  const checkpoint = readPreparationCheckpoint()
  if (checkpoint?.desiredRelease.id === candidate.id)
    rmSync(join(candidateStateDirectory(), PREPARATION_STATE_FILE), { force: true })
  logUpdateEvent(log, { phase: 'activation', event: 'candidate-revoked', updateId: candidate.id })
}

export function readPreparationCheckpoint(): PreparationCheckpoint | null {
  try {
    const value = JSON.parse(
      readFileSync(join(candidateStateDirectory(), PREPARATION_STATE_FILE), 'utf8')
    )
    return Number.isSafeInteger(value?.generation) &&
      value.generation >= 0 &&
      typeof value.desiredRelease?.id === 'string'
      ? value
      : null
  } catch {
    return null
  }
}

export function writePreparationCheckpoint(value: PreparationCheckpoint): void {
  writeJson(join(candidateStateDirectory(), PREPARATION_STATE_FILE), value)
}

export async function checkForUpdate(
  log: LogSink,
  signal?: AbortSignal
): Promise<UpdateCheckResult> {
  const targetArchType = archType()
  if (!targetArchType)
    throw new Error(`unsupported desktop target ${process.platform}/${process.arch}`)
  const config = resolveDesktopConfig(log)
  if (!config.baseUrl) throw new Error('packaged product policy has no update base URL')
  const version = app.getVersion()
  const policy = previewUpdatesEnabled(log) ? getPreviewUpdatePolicy(log) : null
  const revision = previewRevision
  const url = new URL(buildUpdateCheckUrl(config, version, targetArchType))
  if (policy) appendPreviewContext(url, currentPreviewContext(log))
  const raw = await getJson(url.toString(), log, signal)
  const result = monotonicUpdateResult(
    version,
    config,
    parseUpdateCheckResult(raw, config, targetArchType),
    log
  )
  if (policy && result.latest && !previewAllows(policy, version, config.buildNumber, result.latest))
    throw new Error('Server returned a preview candidate outside the selected range')
  // A publication response alone cannot undo an activation rejection. Revalidate
  // that same candidate online; this short-lived grant is never reused for installation.
  const rejectedPath = rejectedUpdatePath()
  const rejected = readRejectedUpdate(rejectedPath)
  if (result.latest && rejected?.id === result.latest.id) {
    const assertValid = await authorizeActivation(
      result.latest,
      log,
      signal ?? new AbortController().signal
    )
    withRejectedRecordLock(rejectedPath, () => {
      assertValid()
      if (readRejectedUpdate(rejectedPath)?.revision !== rejected.revision)
        throw new ActivationCandidateChanged('candidate rejection changed during revalidation')
      rmSync(rejectedPath)
    })
  }
  return policy ? { ...result, previewRevision: revision } : result
}

// Local-lane builds carry no signing expectation (product.ts only mandates
// expected_team_id for distribution + darwin), so they are not update targets:
// a check from such a build can only end in the identity gate rejecting a
// signed row, or in an unhandled rejection on identity-less rows.
export function updateLaneUnsupported(log: LogSink): boolean {
  return resolveDesktopConfig(log).releaseLane === LOCAL_RELEASE_LANE
}

// Read-only diagnosis for exactly that case: fetch /check and line the server
// identity up against the packaged policy, without downloading, installing or
// writing any check state. Reports the same field list the check rejects on.
export async function diagnoseUpdate(log: LogSink): Promise<UpdateDiagnosis> {
  const config = resolveDesktopConfig(log)
  const targetArchType = archType()
  const diagnosis: UpdateDiagnosis = {
    url: '',
    releaseLane: config.releaseLane,
    policy: {
      productId: config.productId,
      bundleId: config.bundleId,
      expectedTeamId: config.expectedTeamId,
      channel: config.channel,
    },
    server: null,
    mismatches: [],
  }
  if (!targetArchType) {
    diagnosis.error = `unsupported desktop target ${process.platform}/${process.arch}`
    return diagnosis
  }
  if (!config.baseUrl) {
    diagnosis.error = 'packaged product policy has no update base URL'
    return diagnosis
  }
  diagnosis.url = buildUpdateCheckUrl(config, app.getVersion(), targetArchType)
  let raw: unknown
  try {
    raw = await getJson(diagnosis.url, log)
  } catch (error) {
    diagnosis.error = String(error)
    return diagnosis
  }
  const source = (raw as { latest?: unknown }).latest
  if (typeof source !== 'object' || source === null) return diagnosis
  const row = source as Record<string, unknown>
  const text = (field: string): string =>
    typeof row[field] === 'string' ? (row[field] as string).trim() : ''
  const meta: LatestVersionMeta = {
    id: text('id'),
    version: text('version'),
    build_number: text('build_number'),
    product_id: text('product_id'),
    bundle_id: text('bundle_id'),
    arch_type: text('arch_type'),
    ...(text('team_id') ? { team_id: text('team_id') } : {}),
    channel: text('channel'),
    file_size: typeof row.file_size === 'number' ? row.file_size : 0,
    sha512: text('sha512'),
  }
  diagnosis.server = {
    version: meta.version,
    buildNumber: meta.build_number,
    productId: meta.product_id,
    bundleId: meta.bundle_id,
    teamId: meta.team_id ?? '',
    channel: meta.channel,
    archType: meta.arch_type,
  }
  diagnosis.mismatches = identityMismatches(meta, config, targetArchType)
  return diagnosis
}

export async function getDownloadInfo(
  id: string,
  log: LogSink,
  signal?: AbortSignal
): Promise<DownloadInfo> {
  const targetArchType = archType()
  if (!targetArchType) throw new Error('unsupported desktop target')
  const config = resolveDesktopConfig(log)
  const preview = previewUpdatesEnabled(log)
  const url = new URL(
    `${config.baseUrl}${UPDATE_PATH_PREFIX}/packages/${encodeURIComponent(id)}/download`
  )
  if (preview) appendPreviewContext(url, currentPreviewContext(log))
  const revision = previewRevision
  const raw = await retryUpdate(() => getJson(url.toString(), log, signal), signal)
  const info = parseDownloadInfo(raw, config, targetArchType, id)
  if (preview && (revision !== previewRevision || !previewCandidateAllowed(info, log)))
    throw new Error('Preview download is outside the selected range')
  return info
}

/**
 * 待装安装包、安装脚本与 DMG 挂载点所在的工作目录。
 *
 * 用系统缓存目录而不是 temp：暂存包要活到用户点「立即更新」，中间可能跨天、跨重启，
 * 而 temp 不承诺存活（macOS 清长期未访问项，Windows 存储感知扫 %TEMP%）。缓存目录
 * 本来就是系统与用户清理工具的管辖范围，要腾空间的用户找得到它。
 */
function updateProfileKey(): string {
  const { home, userData } = desktopStorage()
  return createHash('sha256')
    .update(JSON.stringify([home, userData]))
    .digest('hex')
}

function updateCacheRoot(): string {
  const root = join(systemCacheDir(), UPDATE_CACHE_DIRNAME)
  return process.platform === MACOS_PLATFORM
    ? join(root, UPDATE_CACHE_PROFILE_DIRNAME, updateProfileKey())
    : root
}

function updateCacheDir(): string {
  const root = updateCacheRoot()
  const directory = previewUpdatesEnabled(() => {}) ? join(root, PREVIEW_CANDIDATE_DIRNAME) : root
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return directory
}

async function pruneInactiveMacCache(log: LogSink): Promise<void> {
  if (process.platform !== MACOS_PLATFORM || macHandoffCommitted()) return
  const root = updateCacheRoot()
  const active = updateCacheDir()
  const inactive = active === root ? join(root, PREVIEW_CANDIDATE_DIRNAME) : root
  try {
    if (!existsSync(inactive)) return
    const location = lstatSync(inactive)
    if (!location.isDirectory() || realpathSync(inactive) !== inactive) return
    const cutoff = Date.now() - INACTIVE_UPDATE_CACHE_RETENTION_MS
    const entries = readdirSync(inactive, { withFileTypes: true })
    if (
      entries.some(
        (entry) =>
          entry.isDirectory() &&
          updateArtifactKind(entry.name) === 'mount' &&
          readdirSync(join(inactive, entry.name)).length > 0
      )
    )
      return
    for (const entry of entries) {
      const kind = updateArtifactKind(entry.name)
      if (!(kind === 'payload' && entry.isFile()) && !(kind === 'prepared' && entry.isDirectory()))
        continue
      const path = join(inactive, entry.name)
      const info = lstatSync(path)
      if (info.dev !== location.dev || info.mtimeMs > cutoff) continue
      if ((kind === 'payload' && info.isFile()) || (kind === 'prepared' && info.isDirectory()))
        await removeUpdateArtifact(path)
    }
  } catch (error) {
    log(`[update] inactive cache cleanup deferred: ${String(error)}\n`)
  }
}

function stagedInstallerPath(meta: LatestVersionMeta): string {
  return join(updateCacheDir(), stagedInstallerName(meta.version, meta.build_number))
}

/**
 * 回收更新工作目录里不可能再被用到的东西：身份不是 `keepPayload` 的暂存包，以及卸载后
 * 没人 rmdir 的空挂载点。判定规则在 staging.ts，这里只做文件系统动作。
 *
 * 挂载点用 rmdirSync 而不是递归删：rmdir 只对空目录成立，仍挂着的卷会以
 * ENOTEMPTY/EBUSY 失败，绝不会顺着挂载点删掉卷内内容（rmSync 加 recursive 就会）。
 * 清理失败只记日志：它是省磁盘的附带动作，不该把一次更新变成失败。
 */
function pruneUpdateArtifacts(
  keepPayload: string | null,
  log: LogSink,
  retainedPayloads: readonly string[] = []
): void {
  const directory = updateCacheDir()
  try {
    const entries: UpdateArtifactEntry[] = readdirSync(directory, { withFileTypes: true }).map(
      (entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
        empty: entry.isDirectory() && readdirSync(join(directory, entry.name)).length === 0,
      })
    )
    const plan = planUpdatePrune(entries, keepPayload, retainedPayloads)
    for (const name of plan.files) {
      rmSync(join(directory, name), { force: true })
      log(`[update] pruned superseded installer ${name}\n`)
    }
    for (const name of plan.directories) {
      rmdirSync(join(directory, name))
      log(`[update] pruned detached mount point ${name}\n`)
    }
  } catch (error) {
    log(`[update] prune skipped: ${String(error)}\n`)
  }
}

/** 失败态要如实说明「已下载内容是否保留」：留着且不完整才有续传可言。 */
function downloadResumable(destination: string, expectedSize: number): boolean {
  if (!existsSync(destination)) return false
  const size = statSync(destination).size
  return size > 0 && size < expectedSize
}

function sha512OfFile(path: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(path, { signal })
    stream.on('error', reject)
    stream.on('data', (chunk: Buffer | string) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * 把一行更新诊断额外落到 `$SCHOLARSEED_HOME/logs/update.log`。
 *
 * 主进程的 log sink（index.ts pushLog）只写 stdout 与一条渲染层 IPC：Windows 安装包是 GUI
 * 子系统、没有控制台，stdout 无处可看；那条 IPC 渲染层没有消费者；而且安装一旦发起，app 立刻
 * quit()，内存缓冲也没了。要在真机上定位更新各阶段耗时，这些行必须自己落盘。放在 logs/ 下
 * 还能被问题反馈的日志打包一并收走。写失败只吞掉——日志是附带动作，绝不能把一次更新搞砸。
 */
export async function closeUpdateLog(): Promise<void> {
  await updateLog?.end()
}

function persistUpdateLog(line: string): void {
  try {
    const directory = join(desktopHome(), LOGS_DIRNAME)
    // 行内带时间戳：反馈包里的 update.log 是唯一真机现场，没有时刻就无法回答「卡了多久、
    // 和截图/反馈提交时刻怎么对齐」（bug 87253073 的定位正是止步于此）。
    updateLog ??= new RotatingFileLog(join(directory, UPDATE_LOG_FILE), {
      maxBytes: UPDATE_LOG_MAX_BYTES,
      acquireWriter: () => desktopDirectoryWriter(directory),
    })
    updateLog.write(`[${new Date().toISOString()}] ${redactUpdateLog(line)}`)
  } catch {
    // 落盘失败不影响更新本身。
  }
}

/**
 * 把一段耗时打进日志。更新链路里下载、两次 SHA-512、Windows 签名校验都是「用户干等、
 * 界面看不出在做什么」的重活；出问题时（例如 Win10 报的「等 2 分钟才开始安装」）只有
 * 这些毫秒数能说明时间到底花在哪一步，所以每一步都留一条，并落盘（见 persistUpdateLog）。
 */
function logTiming(log: LogSink, label: string, startedAt: number): void {
  const line = `[update] ${label} took ${Date.now() - startedAt}ms\n`
  log(line)
  persistUpdateLog(line)
}

/** 一行更新诊断同时进主进程 log sink 与 update.log 落盘。 */
function logUpdateLine(log: LogSink, line: string): void {
  log(line)
  persistUpdateLog(line)
}

/**
 * 跑准备链的一步并留下「开始 / 耗时 / 失败」三类落盘日志（bug 87253073）。
 *
 * 准备阶段此前只有清理残留挂载和 attach 失败会落盘，真机卡住时日志里看不出卡在哪一步；
 * 有了 start 行，下一次反馈即使再次挂起，也能从「最后一条 start 没有对应 took」直接指认步骤。
 */
async function runLoggedCommand(
  log: LogSink,
  label: string,
  executable: string,
  args: string[],
  options: CommandOptions = {}
): Promise<string> {
  logUpdateLine(log, `[update] step start ${label}\n`)
  const startedAt = Date.now()
  try {
    const output = await requireCommandAsync(executable, args, label, options)
    logTiming(log, label, startedAt)
    return output
  } catch (error) {
    logUpdateLine(log, `[update] step failed ${label}: ${String(error)}\n`)
    throw error
  }
}

/**
 * 签名校验失败的类别，决定 Windows native owner / Squirrel.Mac 回报哪种 errorFallback（见 updates.ts）。
 * 平台中立：Windows(Authenticode) 与 macOS(codesign 离线信任锚) 共用同一套分类与文案映射。
 */
type UpdateVerifyFailure =
  'verify-env-unavailable' | 'signature-untrusted' | 'notarization-indeterminate'

/**
 * Classification for macOS verification. Detailed diagnostics stay in update.log.
 */
class UpdateVerifyError extends Error {
  constructor(
    message: string,
    readonly kind: UpdateVerifyFailure
  ) {
    super(message)
  }
}

/** 把校验/安装异常映射成结构化 errorFallback；原始文本只落日志，不进用户文案（Windows/macOS 共用）。 */
function updateInstallFallback(error: unknown): UpdateInstallFallback {
  if (error instanceof UpdateVerifyError) {
    if (error.kind === 'verify-env-unavailable') return 'install_verify_unavailable'
    if (error.kind === 'notarization-indeterminate') return 'install_notarization_indeterminate'
    return 'install_signature_untrusted'
  }
  // 校验工具本身缺失（codesign ENOENT）＝本机无法执行校验，不是签名不可信（bug 87435837）。
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return 'install_verify_unavailable'
  }
  return 'install_failed'
}

/**
 * 结构化更新事件行（提案 108 §5.1 字段契约）：JSON 单行，同时进 log sink 与 update.log。
 * Correlate events by updateId and use elapsedMs for durations.
 */
interface UpdateEventFields {
  phase: string
  event: string
  result?: string
  errorCode?: string
  stage?: string
  diagnostic?: unknown
  httpStatus?: number
  expectedBytes?: number
  receivedBytes?: number
  writtenBytes?: number
  updateId?: string
  fromVersion?: string
  toVersion?: string
  elapsedMs?: number
  generation?: number
  reclaimedBytes?: number
  remainingBytes?: number
  nextAttemptAt?: number
  payloadBytes?: number
  archiveBytes?: number
  attempt?: number
}

export function logUpdateEvent(log: LogSink, fields: UpdateEventFields): void {
  const line = `${JSON.stringify({
    schemaVersion: UPDATE_EVENT_SCHEMA_VERSION,
    timestampUtc: new Date().toISOString(),
    processId: process.pid,
    ...fields,
  })}\n`
  log(line)
  persistUpdateLog(line)
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 卸载这个镜像当前所有挂载点：attach 同一份已挂载的镜像恒报 resource busy（真机复现过），
 * 而陈旧挂载有自己的来源 —— 崩掉的上一轮漏掉的 mount-<uuid>、手动安装兜底在 Finder 里留下
 * 的卷、用户自己双击过暂存包。卷是只读安装介质，没有任何合法持有者能横跨一次安装，force
 * 卸载是根因恢复而不是重试碰运气。探针失败只降级为不清扫：恢复手段不能变成安装前置条件。
 */
async function detachStaleMountsOf(
  dmgPath: string,
  log: LogSink,
  installation: InstallationProgress
): Promise<void> {
  installation.step('mounts')
  let points: string[]
  try {
    const info = await readHdiutilInfoPlist({
      timeoutMs: MACOS_MOUNT_COMMAND_TIMEOUT_MS,
      signal: installation.signal,
    })
    points = mountPointsOfImage(info, [dmgPath, realpathOrSelf(dmgPath)])
  } catch (error) {
    installation.signal?.throwIfAborted()
    log(`[update] stale mount probe skipped: ${String(error)}\n`)
    return
  }
  for (const point of points) {
    installation.step('mounts', MACOS_MOUNT_COMMAND_TIMEOUT_MS)
    logUpdateLine(log, `[update] detaching stale mount ${point} of staged installer\n`)
    const result = await runCommandAsync(MACOS_HDIUTIL, ['detach', point, '-force'], {
      signal: installation.signal,
      timeoutMs: MACOS_MOUNT_COMMAND_TIMEOUT_MS,
    })
    if (result.status !== 0) {
      logUpdateLine(
        log,
        `[update] stale mount detach failed ${point}: ${result.stderr || result.stdout}\n`
      )
    }
  }
}

async function mountDmg(
  dmgPath: string,
  log: LogSink,
  installation: InstallationProgress
): Promise<string> {
  const { signal } = installation
  // 安装期不再对 DMG 做 hdiutil 完整性预校验（bug 87435837 性能）：整包字节已由 SHA-512 对着
  // HTTPS 发布元数据在下载与安装前各钉死一次，打包期 verify.cjs 也已 hdiutil 校验过，attach 对
  // 结构损坏自身会失败；此处省掉一次全量只读校验（真机 ~37s）。
  const mount = join(updateCacheDir(), `mount-${randomUUID()}`)
  mkdirSync(mount, { recursive: true })
  const attachArgs = [
    'attach',
    '-readonly',
    '-nobrowse',
    '-noautoopen',
    '-mountpoint',
    mount,
    dmgPath,
  ]
  let transferred = false
  try {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= DMG_ATTACH_ATTEMPTS; attempt++) {
      signal?.throwIfAborted()
      if (attempt > 1) await delayMs(DMG_ATTACH_RETRY_DELAY_MS)
      await detachStaleMountsOf(dmgPath, log, installation)
      installation.step('mounting', MACOS_MOUNT_COMMAND_TIMEOUT_MS)
      try {
        await runLoggedCommand(log, `DMG attach attempt ${attempt}`, MACOS_HDIUTIL, attachArgs, {
          timeoutMs: MACOS_MOUNT_COMMAND_TIMEOUT_MS,
          signal,
        })
        signal?.throwIfAborted()
        transferred = true
        return mount
      } catch (error) {
        lastError = error
        signal?.throwIfAborted()
      }
    }
    throw lastError
  } finally {
    if (!transferred) {
      // Even an interrupted attach can have mounted the volume before exiting.
      await runCommandAsync(MACOS_HDIUTIL, ['detach', mount, '-force'], {
        timeoutMs: MACOS_MOUNT_COMMAND_TIMEOUT_MS,
      })
      try {
        rmdirSync(mount)
      } catch {
        /* Never recursively remove a mounted volume. */
      }
    }
  }
}

async function plistValue(
  appPath: string,
  field: string,
  log: LogSink,
  installation: InstallationProgress,
  application: 'source' | 'staged'
): Promise<string> {
  const { signal } = installation
  installation.step('identity', MACOS_SIGNATURE_COMMAND_TIMEOUT_MS, application)
  return await runLoggedCommand(
    log,
    `read ${field}`,
    '/usr/bin/plutil',
    ['-extract', field, 'raw', join(appPath, 'Contents/Info.plist')],
    { timeoutMs: MACOS_SIGNATURE_COMMAND_TIMEOUT_MS, signal }
  )
}

async function verifyMountedApplication(
  appPath: string,
  meta: LatestVersionMeta,
  config: DesktopUpdateConfig,
  log: LogSink,
  installation: InstallationProgress,
  application: 'source' | 'staged'
): Promise<void> {
  const { signal } = installation
  // Local identity, integrity and the attached Apple-signed ticket are all required.
  // Ticket verification never queries Apple or accepts a previous cached verdict.
  try {
    if (
      (await plistValue(appPath, 'CFBundleIdentifier', log, installation, application)) !==
      config.bundleId
    ) {
      throw new UpdateVerifyError(
        'downloaded app Bundle ID differs from packaged product policy',
        'signature-untrusted'
      )
    }
    if (
      (await plistValue(appPath, 'CFBundleShortVersionString', log, installation, application)) !==
      meta.version
    ) {
      throw new UpdateVerifyError(
        'downloaded app version differs from release metadata',
        'signature-untrusted'
      )
    }
    const bundledPolicy = JSON.parse(
      readFileSync(join(appPath, 'Contents/Resources/product.json'), 'utf8')
    ) as Record<string, unknown>
    if (
      bundledPolicy.build_number !== meta.build_number ||
      bundledPolicy.product_id !== meta.product_id
    ) {
      throw new UpdateVerifyError(
        'downloaded app build identity differs from release metadata',
        'signature-untrusted'
      )
    }
    const executable = await plistValue(
      appPath,
      'CFBundleExecutable',
      log,
      installation,
      application
    )
    installation.step('identity', MACOS_SIGNATURE_COMMAND_TIMEOUT_MS, application)
    const architectures = await readMachArchitectures(
      join(appPath, 'Contents/MacOS', executable),
      signal
    )
    logUpdateLine(log, `[update] application architecture check: ${architectures.join(' ')}\n`)
    const expectedArch = meta.arch_type === MACOS_ARM64_ARCH_TYPE ? MACOS_ARM64 : MACOS_X86_64
    if (!architectures.includes(expectedArch))
      throw new UpdateVerifyError(
        'downloaded app architecture is incompatible',
        'signature-untrusted'
      )
    // 身份锚：一次 `codesign -d --verbose=4` 解析出 Developer ID 链 / TeamID / 硬化运行时 / 安全时间戳 /
    // Identifier，交纯模块 classifyMacosTrust 离线判定（可 node --test 直接跑）。承重判据是
    // TeamIdentifier==expectedTeamId：Authority 行是自报文本、可被伪造链拼出，TeamID 来自真实证书 OU
    // 且受随后的原生离线严格签名校验保护，故空 / not set 一律拒（见 codesign.ts）。
    installation.step('publisher', MACOS_SIGNATURE_COMMAND_TIMEOUT_MS, application)
    const identityOutput = await runLoggedCommand(
      log,
      'codesign metadata',
      '/usr/bin/codesign',
      ['-d', '--verbose=4', appPath],
      { timeoutMs: MACOS_SIGNATURE_COMMAND_TIMEOUT_MS, signal }
    )
    const identity = parseCodesignIdentity(identityOutput)
    const verdict = classifyMacosTrust(identity, {
      expectedTeamId: config.expectedTeamId,
      expectedBundleId: config.bundleId,
      metaTeamId: meta.team_id ?? '',
    })
    if (!verdict.trusted) {
      // 拒绝原因只落 update.log 与错误诊断，不进用户文案（用户文案由 errorFallback 分类决定）。
      persistUpdateLog(
        `[update] macOS offline trust anchor rejected (${application}): ${verdict.reason}\n`
      )
      throw new UpdateVerifyError(
        `downloaded app failed the macOS offline trust anchor: ${verdict.reason}`,
        'signature-untrusted'
      )
    }
    await verifyMountedNotarization(appPath, log, installation, application)
    // 离线锚明细落盘供审计（含 cdhash，便于事后吊销核对）。
    persistUpdateLog(
      `[update] macOS offline trust anchor passed (${application}): ` +
        `developerId="${identity.developerIdAuthority}" teamId=${identity.teamIdentifier} ` +
        `hardenedRuntime=${identity.hardenedRuntime} secureTimestamp=${identity.hasSecureTimestamp} ` +
        `identifier=${identity.identifier} cdhash=${identity.cdhash}\n`
    )
  } catch (error) {
    if (error instanceof UpdateVerifyError) throw error
    // 取消必须原样向上传播：绝不把 abort 误判成签名失败后继续 ditto/重启。
    if (signal?.aborted) throw error
    // 校验工具缺失（codesign ENOENT）＝本机无法执行校验，非签名不可信（引导手动下载而非官方渠道重取）。
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      throw new UpdateVerifyError(
        'macOS code signing verification tool is unavailable',
        'verify-env-unavailable'
      )
    }
    // Other local identity/integrity failures remain a security rejection.
    throw new UpdateVerifyError(
      `downloaded app failed macOS signature verification: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'signature-untrusted'
    )
  }
}

/** Attached ticket authenticity is independent of archive integrity. Native Squirrel
 * performs the final nested/strict signature check on the actual extracted ZIP.
 */
async function verifyMountedNotarization(
  appPath: string,
  log: LogSink,
  installation: InstallationProgress,
  application: 'source' | 'staged'
): Promise<void> {
  const { signal } = installation
  try {
    installation.step('notarization', MACOS_SIGNATURE_COMMAND_TIMEOUT_MS, application)
    const ticketStartedAt = Date.now()
    logUpdateLine(log, '[update] step start notarization ticket\n')
    const executable = await plistValue(
      appPath,
      'CFBundleExecutable',
      log,
      installation,
      application
    )
    const architectures = await readMachArchitectures(
      join(appPath, 'Contents/MacOS', executable),
      signal
    )
    const hashes: Buffer[] = []
    for (const arch of architectures) {
      const metadata = await runLoggedCommand(
        log,
        `ticket code directory ${arch}`,
        '/usr/bin/codesign',
        ['-d', '--verbose=4', '--arch', arch, appPath],
        { timeoutMs: MACOS_SIGNATURE_COMMAND_TIMEOUT_MS, signal }
      )
      hashes.push(notarizationHash(metadata))
    }
    await verifyNotarization({
      appPath,
      hashes,
      native: nativeNotarization,
      timeoutMs: MACOS_SIGNATURE_COMMAND_TIMEOUT_MS,
      signal,
    })
    logUpdateLine(
      log,
      `[update] offline Apple ticket passed: architectures=${architectures.join(',')} cdhashes=${hashes.map((hash) => hash.toString('hex')).join(',')}\n`
    )
    logTiming(log, 'notarization ticket', ticketStartedAt)
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof NotarizationError) {
      const kind: UpdateVerifyFailure =
        error.verdict === 'untrusted'
          ? 'signature-untrusted'
          : error.verdict === 'unavailable' || error.verdict === 'unsupported-code-directory'
            ? 'verify-env-unavailable'
            : 'notarization-indeterminate'
      throw new UpdateVerifyError(error.message, kind)
    }
    throw error
  }
}

let squirrel: SquirrelInstallation | null = null
let macPrepared: { receipt: PreparedArchive; workspace: string } | null = null
let macLaunchCleanup: SquirrelLaunchCleanup | undefined
let macPreparationEpoch = 0

function macArchiveReady(ready: ReadyState, meta: LatestVersionMeta): boolean {
  return (
    !!ready.archive &&
    preparedIdentity(ready.meta) === preparedIdentity(meta) &&
    !!macPrepared?.receipt.matches(meta, ready.archive)
  )
}

function macNativePreparationMatches(staged: ReadyState): boolean {
  return (
    !!staged.archive &&
    squirrel?.matches(staged.archive, {
      candidate: staged.meta.id,
      version: staged.meta.version,
      buildNumber: staged.meta.build_number,
    }) === true
  )
}

export function macPreparationReady(meta: LatestVersionMeta): boolean {
  const ready = readReadyState()
  try {
    return !!ready && macArchiveReady(ready, meta) && macNativePreparationMatches(ready)
  } catch {
    // A changed or unreadable handoff cannot release the native readiness gate.
    return false
  }
}

function assertSquirrelInstallSpace(
  archive: SquirrelArchive,
  expandedBytes: number,
  nativePrepared: boolean,
  prepared?: SquirrelNativeCapture
): void {
  const application = resolve(dirname(process.execPath), '..', '..')
  const expanded = BigInt(expandedBytes)
  if (nativePrepared) {
    const preparedDevice = squirrelPreparedDevice(prepared)
    if (preparedDevice === undefined || preparedDevice !== statSync(dirname(application)).dev)
      assertUpdateSpace(application, expanded)
    return
  }
  const cache = systemCacheDir()
  const sameVolume = statSync(cache).dev === statSync(application).dev
  assertUpdateSpace(cache, BigInt(archive.size) + expanded + (sameVolume ? expanded : 0n))
  if (!sameVolume) assertUpdateSpace(application, expanded)
}

/** Mount lifetime is owned here, including failures and cancellation. The caller
 * can only operate on the exact application in this read-only source volume.
 */
async function withMountedDmg<T>(
  dmgPath: string,
  installation: InstallationProgress,
  log: LogSink,
  operation: (source: string) => Promise<T>
): Promise<T> {
  const mount = await mountDmg(dmgPath, log, installation)
  return withDmgCleanup(
    async () => {
      const source = join(mount, PRODUCT_APPLICATION)
      if (
        !lstatSync(source).isDirectory() ||
        realpathSync(source) !== join(realpathSync(mount), PRODUCT_APPLICATION)
      )
        throw new Error('DMG application must be an exact directory inside the mounted image')
      installation.signal?.throwIfAborted()
      return operation(source)
    },
    async () => {
      // Cleanup must not inherit an already-aborted operation signal.
      await runLoggedCommand(
        log,
        'detach update image',
        MACOS_HDIUTIL,
        ['detach', mount, '-force'],
        {
          timeoutMs: MACOS_MOUNT_COMMAND_TIMEOUT_MS,
        }
      )
      rmdirSync(mount)
    },
    (error) => logUpdateLine(log, `[update] secondary DMG cleanup failure: ${String(error)}\n`)
  )
}

function squirrelHandoffPath(home = desktopHome()): string {
  return squirrelHandoffRecordPath(home)
}

export interface MacStartupAdmission {
  readonly admission: SquirrelAdmission
  readonly status?: SquirrelStartupStatus
  readonly preparationCancelled?: boolean
  readonly cause?: unknown
  readonly evidence?: {
    readonly home: string
    readonly version: string
    readonly buildNumber: string
    readonly handoff: string
    readonly record: CapturedRecord | null
    readonly launch: string | null
  }
}

export async function macStartupAdmission(
  home: string,
  log: LogSink,
  expected?: Readonly<UpdateLaunchContext>
): Promise<MacStartupAdmission> {
  if (process.platform !== MACOS_PLATFORM || !app.isPackaged) return { admission: 'allow' }
  try {
    const path = squirrelHandoffPath(home)
    const handoff = readSquirrelHandoff(path)
    const record = handoff
      ? captureRecord(path, TERMINAL_RECORD_LIMITS.handoff, [process.getuid!()])
      : null
    if (record && JSON.stringify(decodeSquirrelHandoff(record.bytes)) !== JSON.stringify(handoff))
      throw new Error('Mac handoff changed during startup observation')
    if (
      expected &&
      (!handoff ||
        handoff.candidate !== expected.candidate ||
        handoff.buildNumber !== expected.targetBuild)
    )
      throw new Error('Mac launch context does not match the pending handoff')
    const config = resolveDesktopConfig(log)
    const current = { version: app.getVersion(), buildNumber: config.buildNumber }
    const admitted = (admission: SquirrelAdmission): MacStartupAdmission => ({
      admission,
      evidence: {
        home,
        ...current,
        handoff: JSON.stringify(handoff),
        record,
        launch: expected ? JSON.stringify(expected) : null,
      },
    })
    if (squirrelAdmission(current, handoff, 'unconfirmed') === 'allow') {
      if (!handoff) return admitted('allow')
      const application = realpathSync(resolve(dirname(process.execPath), '..', '..'))
      if (!expected && handoff.nativeRequest?.target.path !== application)
        throw new Error(
          'Pending Mac update belongs to another or unbound installation; independent repair is required'
        )
      if (!expected || !squirrelLaunchSuperseded(config.buildNumber, expected))
        return admitted('allow')
      if (
        !(await inspectSquirrelIdle(
          systemCacheDir(),
          config.bundleId,
          application,
          handoff,
          (application) =>
            verifySquirrelReplacement(
              application,
              config.bundleId,
              config.expectedTeamId,
              config.buildNumber
            )
        ))
      )
        throw new Error(
          'Superseded Mac launch still has native update activity or uncertain evidence'
        )
      if (
        JSON.stringify(readSquirrelHandoff(squirrelHandoffPath(home))) !== JSON.stringify(handoff)
      )
        throw new Error('Mac handoff changed during superseded startup admission')
      log(`[update] startup admission=superseded candidate=${handoff!.candidate}\n`)
      return admitted('superseded')
    }
    const status = await settleSquirrelStartup(() =>
      inspectSquirrelStartup(
        handoff!,
        systemCacheDir(),
        config.bundleId,
        resolve(dirname(process.execPath), '..', '..')
      )
    )
    const admission = squirrelAdmission(current, handoff, status)
    const preparationCancelled =
      admission === 'failed' &&
      !expected &&
      !!handoff &&
      (handoff.state === 'requested' || handoff.state === 'downloaded') &&
      !!(await inspectCancelledSquirrelPreparation(
        systemCacheDir(),
        config.bundleId,
        realpathSync(resolve(dirname(process.execPath), '..', '..')),
        handoff
      ))
    if (JSON.stringify(readSquirrelHandoff(squirrelHandoffPath(home))) !== JSON.stringify(handoff))
      throw new Error('Mac handoff changed during startup admission')
    log(
      `[update] startup admission=${admission} status=${status} candidate=${handoff!.candidate}\n`
    )
    return { ...admitted(admission), status, preparationCancelled }
  } catch (error) {
    log(`[update] startup admission=exit evidence unavailable: ${String(error)}\n`)
    return { admission: 'exit', status: 'unconfirmed', cause: error }
  }
}

function readAdmittedMacHandoff(
  log: LogSink,
  startup?: MacStartupAdmission
): SquirrelHandoff | null {
  if (process.platform !== MACOS_PLATFORM || !app.isPackaged) return null
  const handoff = readSquirrelHandoff(squirrelHandoffPath())
  const evidence = startup?.evidence
  if (
    !evidence ||
    !['allow', 'failed', 'superseded'].includes(startup?.admission ?? '') ||
    evidence.home !== desktopHome() ||
    evidence.version !== app.getVersion() ||
    evidence.buildNumber !== resolveDesktopConfig(log).buildNumber ||
    evidence.handoff !== JSON.stringify(handoff)
  )
    throw new Error('Mac startup admission evidence changed or is unavailable')
  return handoff
}

export async function completeMacStartupAdmission(
  log: LogSink,
  startup?: MacStartupAdmission,
  launch?: ObservedUpdateLaunch | null
): Promise<void> {
  let handoff = readAdmittedMacHandoff(log, startup)
  if (startup?.admission === 'superseded') {
    const refreshed = await macStartupAdmission(desktopHome(), log, launch?.context)
    if (refreshed.admission !== 'superseded')
      throw new Error('Mac superseded recovery evidence changed or is unavailable')
  }
  if (handoff?.state === 'installing' && startup?.admission === 'failed') {
    const refreshed = await macStartupAdmission(desktopHome(), log)
    if (refreshed.admission !== 'failed')
      throw new Error('Mac native restoration evidence changed or is unavailable')
  }
  if (
    startup?.evidence &&
    startup.evidence.launch !== (launch ? JSON.stringify(launch.context) : null)
  )
    throw new Error('Mac startup launch context differs from admission')
  launch?.verify()
  handoff = readAdmittedMacHandoff(log, startup)
  if (!handoff || startup?.admission === 'failed') return
  const record = startup?.evidence?.record
  if (!record) throw new Error('Mac startup handoff file identity is unavailable')
  const path = squirrelHandoffPath()
  const maintenance = desktopDirectoryMaintenance(dirname(path))
  try {
    maintenance.consume(basename(path), record.bytes, record.snapshot.device, record.snapshot.inode)
  } finally {
    maintenance.close()
  }
  logUpdateEvent(log, {
    phase: 'macos-install',
    event:
      startup?.admission === 'superseded'
        ? 'superseded-build-observed'
        : 'installed-build-observed',
    updateId: handoff.candidate,
    toVersion: handoff.version,
    result: 'success',
  })
}

export function macHandoffCommitted(): boolean {
  return process.platform === MACOS_PLATFORM && !!squirrel?.committed
}

export function macHandoffReady(): boolean {
  return process.platform === MACOS_PLATFORM && !!squirrel?.ready
}

/** Only selects a startup notice. The consumed handoff still forbids backend startup. */
export async function macStartupStatus(log: LogSink): Promise<SquirrelStartupStatus> {
  try {
    const handoff = readSquirrelHandoff(squirrelHandoffPath())
    if (!handoff) return 'unconfirmed'
    const status = await inspectSquirrelStartup(
      handoff,
      systemCacheDir(),
      resolveDesktopConfig(log).bundleId,
      resolve(dirname(process.execPath), '..', '..')
    )
    logUpdateEvent(log, {
      phase: 'macos-install',
      event: `startup-${status}`,
      updateId: handoff.candidate,
    })
    return status
  } catch {
    return 'unconfirmed'
  }
}

export async function syncMacUpdateDiagnostics(log: LogSink): Promise<void> {
  if (process.platform !== MACOS_PLATFORM) return
  const config = resolveDesktopConfig(log)
  try {
    for (const item of await shipItDiagnostics(systemCacheDir(), config.bundleId))
      persistUpdateLog(`[update] ShipIt ${item.name}\n${item.text}\n`)
    await updateLog?.flush()
  } catch (error) {
    logUpdateLine(log, `[update] ShipIt diagnostics unavailable: ${String(error)}\n`)
  }
}

let macCleanupStarted = false
export function startMacDeferredCleanup(log: LogSink): void {
  if (macCleanupStarted || process.platform !== MACOS_PLATFORM || !app.isPackaged) return
  macCleanupStarted = true
  void retryMacCleanup(
    {
      platform: process.platform,
      packaged: app.isPackaged,
      application: resolve(dirname(process.execPath), '..', '..'),
      bundle: resolveDesktopConfig(log).bundleId,
    },
    (line) => logUpdateLine(log, line)
  ).catch(() => {
    logUpdateLine(log, '[update-cleanup] event=scheduling-failed\n')
  })
}

export function macHandoffRetryable(error: unknown): boolean {
  return (
    macHandoffReady() &&
    (error instanceof ActivationExpired ||
      (error as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC' ||
      transientUpdateFailure(error))
  )
}

export async function quitMacUpdate(log: LogSink, beforeCommit: () => void): Promise<void> {
  const staged = readReadyState()
  const receipt = macPrepared?.receipt
  if (!squirrel?.ready || !staged?.archive || !receipt?.matches(staged.meta, staged.archive))
    throw new Error('Squirrel installation unavailable')
  const signal = new AbortController().signal
  await commitWithActivation(
    async () => {
      try {
        return await retryUpdate(() => authorizeActivation(staged.meta, log, signal), signal)
      } catch (error) {
        if (error instanceof ActivationCandidateChanged) await persistRejectedUpdate(staged.meta)
        throw error
      }
    },
    (guard) => {
      beforeCommit()
      if (
        !squirrel?.matches(staged.archive!, {
          candidate: staged.meta.id,
          version: staged.meta.version,
          buildNumber: staged.meta.build_number,
        })
      )
        throw new Error('Squirrel candidate changed before installation authorization')
      assertSquirrelInstallSpace(
        staged.archive!,
        receipt.expandedBytes,
        true,
        squirrel.preparedCandidate()
      )
      guard()
      squirrel.quitAndInstall()
    }
  )
}

function preparedApplicationDirectory(meta: LatestVersionMeta): string {
  return join(updateCacheDir(), `${stagedInstallerName(meta.version, meta.build_number)}.prepared`)
}

async function prepareDmg(
  dmgPath: string,
  meta: LatestVersionMeta,
  installation: InstallationProgress,
  log: LogSink,
  cached?: SquirrelArchive
): Promise<NonNullable<typeof macPrepared>> {
  if (process.platform !== MACOS_PLATFORM || !app.isPackaged)
    throw new Error('automatic update requires a packaged macOS application')
  meta = Object.freeze({ ...meta })
  const { signal } = installation
  const epoch = macPreparationEpoch
  const directory = preparedApplicationDirectory(meta)
  const archive = join(directory, 'application.zip')
  const startedAt = Date.now()
  if (cached?.path === archive) {
    let receipt: PreparedArchive | undefined
    try {
      receipt = await PreparedArchive.reattach(
        meta,
        dmgPath,
        cached,
        (verify) =>
          withMountedDmg(dmgPath, installation, log, async (source) => {
            await verifyMountedApplication(
              source,
              meta,
              resolveDesktopConfig(log),
              log,
              installation,
              'source'
            )
            const attributes = await runLoggedCommand(
              log,
              'inspect source extended attributes for ZIP reuse',
              '/usr/bin/xattr',
              ['-rs', source],
              { timeoutMs: MACOS_SIGNATURE_COMMAND_TIMEOUT_MS, signal }
            )
            if (attributes.trim())
              throw new PreparedArtifactChangedError('Source extended attributes need a fresh ZIP')
            return verify(source)
          }),
        signal
      )
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof UpdateVerifyError) throw error
      logUpdateLine(log, `[update] cached ZIP needs conversion: ${String(error)}\n`)
    }
    if (receipt) {
      signal?.throwIfAborted()
      if (epoch !== macPreparationEpoch) throw new Error('macOS preparation was superseded')
      logTiming(log, 'cached ZIP source proof', startedAt)
      return { receipt, workspace: directory }
    }
  }
  await removeUpdateArtifact(directory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    const receipt = await PreparedArchive.create(
      meta,
      dmgPath,
      archive,
      () =>
        withMountedDmg(dmgPath, installation, log, async (source) => {
          await verifyMountedApplication(
            source,
            meta,
            resolveDesktopConfig(log),
            log,
            installation,
            'source'
          )
          const budget = await preflightApplicationArchive(source, signal)
          assertUpdateSpace(directory, BigInt(Math.max(budget.expanded, budget.metadata)))
          installation.step('copying', MACOS_ARCHIVE_TIMEOUT_MS)
          await runLoggedCommand(
            log,
            'archive mounted application',
            MACOS_DITTO,
            archiveApplicationArguments(source, archive),
            { timeoutMs: MACOS_ARCHIVE_TIMEOUT_MS, signal }
          )
        }),
      signal
    )
    signal?.throwIfAborted()
    if (epoch !== macPreparationEpoch) throw new Error('macOS preparation was superseded')
    logTiming(log, 'final ZIP preparation', startedAt)
    return { receipt, workspace: directory }
  } catch (error) {
    await removeUpdateArtifact(directory)
    throw error
  }
}

function readyStatePath(): string {
  return join(candidateStateDirectory(), READY_STATE_FILE)
}

/**
 * 读回一个仍然成立的「已就绪」暂存态。
 *
 * 暂存包必须还在磁盘上且大小与发布元数据一致 —— 系统会清理 temp 目录，用户也可能
 * 手删，少了这道校验就会报一个假的「已就绪」，等用户点重启才失败。
 */
export function readReadyState(): ReadyState | null {
  try {
    const value = JSON.parse(readFileSync(readyStatePath(), 'utf8')) as ReadyState
    const meta = value.meta
    if (meta && readRejectedUpdate()?.id === meta.id) return null
    if (typeof value.path !== 'string' || !meta || typeof meta.sha512 !== 'string') return null
    if (value.path !== stagedInstallerPath(meta)) return null
    if (typeof meta.file_size !== 'number' || meta.file_size <= 0) return null
    if (!existsSync(value.path) || statSync(value.path).size !== meta.file_size) return null
    if (process.platform === MACOS_PLATFORM) {
      const archive = value.archive
      if (
        !archive ||
        archive.path !== join(preparedApplicationDirectory(meta), 'application.zip') ||
        !/^[a-f0-9]{128}$/i.test(archive.sha512) ||
        !Number.isSafeInteger(archive.size) ||
        archive.size <= 0 ||
        statSync(archive.path).size !== archive.size
      )
        return null
    }
    return value
  } catch {
    return null
  }
}

function writeReadyState(ready: ReadyState): void {
  const path = readyStatePath()
  writeJson(path, ready)
}

export function clearReadyState(): void {
  macPreparationEpoch += 1
  macPrepared = null
  rmSync(readyStatePath(), { force: true })
}

/**
 * 「发现新版本」弹窗已经被用户收起过的候选身份。
 *
 * 归主进程持有而不是渲染层：渲染层的 origin 含后端随机端口，localStorage 按 origin
 * 分区，写在那里的确认每次启动都读不回来（bug 86968393）。落盘才跨客户端重启有效。
 *
 * 目录可注入：生产走
 * 默认值，测试用真实临时目录验落盘与读回。
 */
export function readAnnouncedKey(directory: string = updateStateDirectory()): string | null {
  try {
    const value = JSON.parse(
      readFileSync(join(directory, ANNOUNCED_STATE_FILE), 'utf8')
    ) as AnnouncedState
    return typeof value.key === 'string' && value.key ? value.key : null
  } catch {
    return null
  }
}

export function writeAnnouncedKey(key: string, directory: string = updateStateDirectory()): void {
  const path = join(directory, ANNOUNCED_STATE_FILE)
  mkdirSync(directory, { recursive: true })
  const state: AnnouncedState = { key, at: Date.now() }
  writeFileSync(path, JSON.stringify(state), 'utf8')
}

/**
 * 过期暂存包本体也要回收：清掉 ready 记录只解决「别再报已就绪」，几百 MB 的文件还躺在
 * 磁盘上。旧候选的安装包在实际安装完成或被更新候选替代后回收。
 *
 * 只删文件名符合本模块命名的东西：ready.json 是磁盘上的可变状态，不能拿它当任意路径的
 * 删除授权。
 */
function removeStaleInstaller(path: string, log: LogSink): void {
  if (dirname(path) !== updateCacheDir() || updateArtifactKind(basename(path)) !== 'payload') return
  try {
    rmSync(path, { force: true })
    log(`[update] pruned stale installer ${basename(path)}\n`)
  } catch (error) {
    // A locked obsolete payload is cleanup debt, not a failed new candidate.
    // Later cache pruning retries it; never keep ready permission for its sake.
    log(`[update] stale installer cleanup deferred ${basename(path)}: ${String(error)}\n`)
  }
}

/**
 * 一个已经用不上的暂存包，记录和包体一起回收。
 *
 * 两件事必须同时做：只清记录，几百 MB 会一直躺在磁盘上；只删包体，下一次启动
 * `initialUpdateSnapshot` 又会因为记录还在而重新认领它（然后因为文件缺失报不出「已就绪」，
 * 白占一轮状态）。启动时发现暂存包不再比运行版本新、运行期发现线上有更新的发布，走的都是
 * 这一条。
 */
function dropStagedUpdate(staged: ReadyState, log: LogSink): void {
  clearReadyState()
  removeStaleInstaller(staged.path, log)
  if (process.platform === MACOS_PLATFORM && !macHandoffCommitted()) {
    try {
      rmSync(preparedApplicationDirectory(staged.meta), { recursive: true, force: true })
    } catch (error) {
      log(`[update] prepared archive cleanup deferred: ${String(error)}\n`)
    }
  }
}

/**
 * 线上候选是否已经取代当前暂存的「已就绪」包；取代时把旧包回收掉。
 *
 * 「已就绪」是**等用户挑时间**的等待态，不是下载/安装那种进行中态：等待期间线上还会继续
 * 发布，一次检查发现更新的构建就必须能推进过去，否则界面被钉死在当初暂存的那一个包上 ——
 * 用户看到的是「更新完还不是最新、得级一级升」。
 *
 * 反过来，候选不比暂存包新时一律不动：既不能把用户从一个已校验可安装的包上拽下来，也不能
 * 丢掉安装失败留在 ready 相位上的唯一结果表面（bug 86968393）。排不出先后（身份串不合契约）
 * 时同样不动，让已经下载好的那一个继续有效。
 */
/** Revoke only this updater's candidate records after its workers have stopped. */
export function discardPreviewPreparation(log: LogSink): void {
  if (!previewUpdatesEnabled(log)) return
  if (macHandoffCommitted()) throw new Error('Update handoff already committed')
  validatedPreviewCandidates.clear()
  const writer = desktopDirectoryWriter(updateStateDirectory())
  try {
    const staged = readReadyState()
    if (staged) dropStagedUpdate(staged, log)
    else clearReadyState()
    rmSync(join(candidateStateDirectory(), PREPARATION_STATE_FILE), { force: true })
    // A cancelled download has no ready record yet. Its resumable payload must
    // also be reclaimed after the preparation worker has drained.
    pruneUpdateArtifacts(null, log)
  } finally {
    writer.close()
  }
}

export function supersedeStagedUpdate(candidate: LatestVersionMeta | null, log: LogSink): boolean {
  if (!candidate || macHandoffCommitted()) return false
  const staged = readReadyState()
  if (!staged) return false
  const newer = isNewerRelease(
    { version: staged.meta.version, buildNumber: staged.meta.build_number },
    { version: candidate.version, buildNumber: candidate.build_number }
  )
  if (newer !== true) return false
  log(
    `[update] staged ${staged.meta.version}-${staged.meta.build_number} superseded by ` +
      `${candidate.version}-${candidate.build_number}\n`
  )
  dropStagedUpdate(staged, log)
  return true
}

async function discardPreparedApplications(
  log: LogSink,
  keep: string,
  retained: readonly string[] = []
): Promise<void> {
  if (process.platform !== MACOS_PLATFORM) return
  if (macHandoffCommitted()) throw new Error('Squirrel handoff requires recovery')
  for (const entry of readdirSync(updateCacheDir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || updateArtifactKind(entry.name) !== 'prepared') continue
    if (entry.name === keep || retained.includes(entry.name)) continue
    await removeUpdateArtifact(join(updateCacheDir(), entry.name))
  }
  logUpdateEvent(log, { phase: 'gc', event: 'discard-prepared-archives', result: 'ok' })
}

/** stageUpdate 的结果：要么停在「已就绪」，要么带着「部分包是否保留」失败。 */
export type StageUpdateResult =
  | { ok: true; ready: ReadyState }
  | {
      ok: false
      error?: string
      errorFallback?: UpdateInstallFallback
      errorOrigin: 'download' | 'preparation'
      resumable: boolean
    }

/**
 * 下载并校验安装包，然后停在「已就绪」。
 *
 * 安装是独立的一步、由用户挑时间触发：下载完就自动换掉正在运行的客户端，等于替
 * 用户决定什么时候中断手头的科研工作（PRD 第 7/8 条）。
 */
export async function stageUpdate(
  id: string,
  onProgress: (progress: UpdateProgress) => void,
  log: LogSink,
  signal?: AbortSignal
): Promise<StageUpdateResult> {
  const previousPreparation = macPrepared
  const previousReady = process.platform === MACOS_PLATFORM ? readReadyState() : null
  if (previousReady?.meta.id === id && macArchiveReady(previousReady, previousReady.meta))
    return { ok: true, ready: previousReady }
  try {
    // Only the preparation owner calls this after its previous worker has drained.
    if (macHandoffCommitted())
      return {
        ok: false,
        errorFallback: 'activation_recovery_required',
        errorOrigin: 'preparation',
        resumable: false,
      }
    if (process.platform !== MACOS_PLATFORM) clearReadyState()
    signal?.throwIfAborted()
  } catch (error) {
    return { ok: false, error: String(error), errorOrigin: 'preparation', resumable: false }
  }
  let info: DownloadInfo
  try {
    info = await getDownloadInfo(id, log, signal)
    signal?.throwIfAborted()
  } catch (error) {
    return {
      ok: false,
      error: `${DOWNLOAD_METADATA_FAILED}: ${String(error)}`,
      errorOrigin: 'download',
      resumable: false,
    }
  }
  const destination = stagedInstallerPath(info)
  try {
    await discardPreparedApplications(
      log,
      basename(preparedApplicationDirectory(info)),
      previousReady ? [basename(preparedApplicationDirectory(previousReady.meta))] : []
    )
    await pruneInactiveMacCache(log)
    signal?.throwIfAborted()
  } catch (error) {
    return { ok: false, error: String(error), errorOrigin: 'preparation', resumable: false }
  }
  pruneUpdateArtifacts(
    basename(destination),
    log,
    previousReady ? [basename(previousReady.path)] : []
  )
  onProgress({ phase: 'downloading', percent: 0, receivedBytes: 0 })
  try {
    if (process.platform === MACOS_PLATFORM) assertDownloadSpace(destination, info.file_size)
    const downloadStartedAt = Date.now()
    await retryUpdate(
      () =>
        downloadWithProgress(
          info.download_url,
          destination,
          info.file_size,
          (percent, receivedBytes) => onProgress({ phase: 'downloading', percent, receivedBytes }),
          signal
        ),
      signal,
      (attempt) => logUpdateEvent(log, { phase: 'download', event: 'transient-retry', attempt })
    )
    logTiming(log, `downloaded installer (${info.file_size} bytes)`, downloadStartedAt)
    onProgress({ phase: 'verifying' })
    const verifyStartedAt = Date.now()
    const actual = await sha512OfFile(destination, signal)
    logTiming(log, `downloaded installer SHA-512 (${info.file_size} bytes)`, verifyStartedAt)
    if (actual.toLowerCase() !== info.sha512.toLowerCase()) {
      // 完整但哈希不对：续传救不了它，删掉让下一次从头下。
      rmSync(destination, { force: true })
      throw new Error('SHA-512 differs from release metadata')
    }
  } catch (error) {
    // 下载失败保留部分文件，「重试下载」才是真的从断点继续而不是从头再来。
    return {
      ok: false,
      error: String(error),
      errorOrigin: 'download',
      resumable: downloadResumable(destination, info.file_size),
    }
  }
  // 签名下载链接是短期的、安装阶段也用不到，不落盘。
  const { download_url: _downloadUrl, ...meta } = info
  let archive: SquirrelArchive | undefined
  let prepared: NonNullable<typeof macPrepared> | null = null
  if (process.platform === MACOS_PLATFORM) {
    const preparation = new InstallationProgress(
      (progress) => onProgress({ ...progress, phase: 'preparing' }),
      signal,
      (event) =>
        logUpdateEvent(log, { ...event, fromVersion: app.getVersion(), toVersion: meta.version })
    )
    try {
      const cached =
        previousReady?.archive && preparedIdentity(previousReady.meta) === preparedIdentity(meta)
          ? previousReady.archive
          : undefined
      prepared = await prepareDmg(destination, meta, preparation, log, cached)
      archive = prepared.receipt.archive
      signal?.throwIfAborted()
    } catch (error) {
      if (prepared) await removeUpdateArtifact(prepared.workspace)
      persistUpdateLog(`[update] macOS preparation failed: ${String(error)}\n`)
      if (!signal?.aborted && error instanceof UpdateArchiveLimitError) {
        return {
          ok: false,
          errorFallback: 'install_archive_limit',
          errorOrigin: 'preparation',
          resumable: false,
        }
      }
      if (!signal?.aborted && error instanceof UpdateVerifyError) {
        return {
          ok: false,
          errorFallback: updateInstallFallback(error),
          errorOrigin: 'preparation',
          resumable: error.kind === 'notarization-indeterminate',
        }
      }
      return { ok: false, error: String(error), errorOrigin: 'preparation', resumable: true }
    } finally {
      preparation.dispose()
    }
  }
  const ready: ReadyState = { at: Date.now(), path: destination, meta, archive }
  try {
    signal?.throwIfAborted()
    writeReadyState(ready)
    if (prepared) macPrepared = prepared
  } catch (error) {
    const published = readReadyState()
    if (
      prepared &&
      published?.archive &&
      prepared.receipt.matches(published.meta, published.archive)
    ) {
      macPrepared = prepared
    } else {
      macPrepared = previousPreparation
      if (prepared) await removeUpdateArtifact(prepared.workspace)
    }
    return { ok: false, error: String(error), errorOrigin: 'preparation', resumable: true }
  }
  if (previousReady && previousReady.meta.id !== ready.meta.id) {
    removeStaleInstaller(previousReady.path, log)
    try {
      await removeUpdateArtifact(preparedApplicationDirectory(previousReady.meta))
    } catch (error) {
      log(`[update] previous prepared archive cleanup deferred: ${String(error)}\n`)
    }
  }
  log(`[update] staged ${meta.version}-${meta.build_number}\n`)
  logUpdateEvent(log, {
    phase: 'preparation',
    event: 'artifacts-published',
    result: 'ok',
    updateId: meta.id,
    payloadBytes: meta.file_size,
    archiveBytes: archive?.size,
  })
  return { ok: true, ready }
}

function canPrepareMacUpdateWithoutInteraction(): boolean {
  try {
    const application = realpathSync(resolve(dirname(process.execPath), '..', '..'))
    accessSync(application, fsConstants.W_OK)
    accessSync(dirname(application), fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

/** Verify the staged candidate and obtain the bound, unauthorized native receipt. */
export async function prepareMacUpdate(
  expectedId: string,
  onProgress: (progress: UpdateProgress) => void,
  log: LogSink,
  signal: AbortSignal,
  startup?: MacStartupAdmission,
  allowInteraction = false
): Promise<StartUpdateResult> {
  if (process.platform !== MACOS_PLATFORM) return { ok: false, error: NO_STAGED_UPDATE }
  const staged = readReadyState()
  if (!staged?.archive || staged.meta.id !== expectedId)
    return { ok: false, error: NO_STAGED_UPDATE }
  if (signal.aborted) return { ok: false, cancelled: true }
  if (macPreparationReady(staged.meta)) return { ok: true, mode: 'auto' }
  if (macHandoffCommitted()) return { ok: false, errorFallback: 'activation_recovery_required' }
  if (!allowInteraction && !canPrepareMacUpdateWithoutInteraction()) {
    logUpdateLine(log, '[update] macOS native preparation needs an explicit user action\n')
    return { ok: false, errorFallback: 'preparation_failed' }
  }
  const prepared = macPrepared
  if (!prepared?.receipt.matches(staged.meta, staged.archive))
    return { ok: false, error: NO_STAGED_UPDATE }
  const installation = new InstallationProgress(
    (progress) => onProgress({ ...progress, phase: 'preparing' }),
    signal,
    (event) =>
      logUpdateEvent(log, {
        ...event,
        fromVersion: app.getVersion(),
        toVersion: `${staged.meta.version}-${staged.meta.build_number}`,
      })
  )
  try {
    installation.step('package')
    const startedAt = Date.now()
    const frozen = await retryUpdate(
      () =>
        prepared.receipt.revalidate(
          () =>
            withMountedDmg(staged.path, installation, log, (source) =>
              verifyMountedNotarization(source, log, installation, 'source')
            ),
          signal
        ),
      signal
    )
    const handoffIdentity = {
      version: staged.meta.version,
      buildNumber: staged.meta.build_number,
      candidate: staged.meta.id,
    }
    assertSquirrelInstallSpace(frozen, prepared.receipt.expandedBytes, false)
    logTiming(log, 'final ZIP and current source trust recheck', startedAt)
    logUpdateEvent(log, {
      phase: 'macos-install',
      event: 'reuse-prepared-archive',
      updateId: staged.meta.id,
    })
    // Background identity is byte-bound; native Squirrel must validate the actual
    // extracted ZIP before emitting update-downloaded. Never quit on this receipt.
    // The pinned feed verifies the full final ZIP before and during every transfer.
    // A receipt grants no installation authorization.
    signal?.throwIfAborted()
    const failureRecord = startup?.admission === 'failed' ? startup.evidence?.record : null
    const prior = failureRecord ? decodeSquirrelHandoff(failureRecord.bytes) : null
    const legacyPublisherAbsent = () =>
      app.hasSingleInstanceLock() && inspectLegacySquirrelPublisher()
    const recoveryCache =
      prior && abandonedSquirrelRequest(prior, legacyPublisherAbsent) ? systemCacheDir() : null
    const recoveryBundle = recoveryCache ? resolveDesktopConfig(log).bundleId : null
    const unstarted =
      recoveryCache && recoveryBundle
        ? await inspectSquirrelIdle(
            recoveryCache,
            recoveryBundle,
            realpathSync(resolve(dirname(process.execPath), '..', '..')),
            prior
          )
        : false
    const cancelled =
      prior && (prior.state === 'requested' || prior.state === 'downloaded')
        ? await inspectCancelledSquirrelPreparation(
            systemCacheDir(),
            resolveDesktopConfig(log).bundleId,
            realpathSync(resolve(dirname(process.execPath), '..', '..')),
            prior
          )
        : null
    signal?.throwIfAborted()
    squirrel ??= new SquirrelInstallation(
      autoUpdater,
      squirrelHandoffPath(),
      (event, errorCode) => {
        logUpdateEvent(log, {
          phase: 'macos-install',
          event,
          errorCode,
          updateId: staged.meta.id,
          toVersion: staged.meta.version,
        })
        // A committed handoff whose native installer terminally fails will never relaunch
        // the target; drop the launch context so this live session recovers storage and
        // future updates instead of carrying a dead transaction.
        macLaunchCleanup = discardOnTerminalSquirrelFailure(event, macLaunchCleanup)
      },
      undefined,
      (identity) =>
        bindSquirrelRequest(
          systemCacheDir(),
          resolveDesktopConfig(log).bundleId,
          resolve(dirname(process.execPath), '..', '..'),
          identity,
          app.getPath('appData')
        ),
      (operation) => {
        const path = squirrelHandoffPath()
        const writer = desktopDirectoryWriter(dirname(path))
        try {
          writer.withRecordLock(SQUIRREL_HANDOFF_LOCK, () =>
            operation((handoff) =>
              writer.replace(basename(path), Buffer.from(`${JSON.stringify(handoff)}\n`))
            )
          )
        } finally {
          writer.close()
        }
      },
      (current) => {
        const evidence = startup?.evidence
        return (
          startup?.admission === 'failed' &&
          (current.state === 'failed' ||
            ((current.state === 'requested' || current.state === 'downloaded') &&
              cancelled?.() === true) ||
            (unstarted &&
              !!recoveryCache &&
              !!recoveryBundle &&
              abandonedSquirrelRequest(current, legacyPublisherAbsent) &&
              squirrelNativeRequestAbsent(recoveryCache, recoveryBundle))) &&
          evidence?.home === desktopHome() &&
          !!evidence.record &&
          sameRecord(squirrelHandoffPath(), evidence.record, TERMINAL_RECORD_LIMITS.handoff, [
            process.getuid!(),
          ])
        )
      }
    )
    installation.step('helper')
    await squirrel.prepare(
      frozen,
      {
        ...handoffIdentity,
        at: Date.now(),
        state: 'requested',
      },
      async () => {
        const guard = await retryUpdate(() => authorizeActivation(staged.meta, log, signal), signal)
        return () => {
          signal.throwIfAborted()
          const current = readReadyState()
          if (!current || !macArchiveReady(current, staged.meta))
            throw new Error('Staged artifact changed before native preparation')
          if (!allowInteraction && !canPrepareMacUpdateWithoutInteraction())
            throw new Error('Mac native preparation requires user interaction')
          guard()
        }
      },
      allowInteraction
    )
    if (!macPreparationReady(staged.meta))
      throw new Error('Mac update native readiness is required')
    installation.finish('handoff')
    return { ok: true, mode: 'auto' }
  } catch (error) {
    installation.finish(
      signal?.aborted && (!macHandoffCommitted() || macHandoffReady()) ? 'cancelled' : 'failed'
    )
    persistUpdateLog(`[update] native preparation failed: ${String(error)}\n`)
    if (error instanceof ActivationCandidateChanged)
      return await revokeMacCandidate(staged.meta, log)
    if (error instanceof PreparedArtifactChangedError) macPrepared = null
    if (signal?.aborted && (!macHandoffCommitted() || macHandoffReady()))
      return { ok: false, cancelled: true }
    if (error instanceof UpdateVerifyError)
      return { ok: false, errorFallback: updateInstallFallback(error) }
    if (error instanceof UpdateArchiveLimitError)
      return { ok: false, errorFallback: 'install_archive_limit' }
    if (macHandoffCommitted() && !macHandoffReady())
      return { ok: false, errorFallback: 'activation_recovery_required' }
    return { ok: false, error: String(error) }
  } finally {
    installation.dispose()
    if (squirrel && !squirrel.committed) {
      squirrel.dispose()
      squirrel = null
    }
    await updateLog?.flush()
  }
}

async function revokeMacCandidate(
  candidate: LatestVersionMeta,
  log: LogSink
): Promise<StartUpdateResult> {
  try {
    await discardRejectedUpdate(candidate, log)
    return { ok: false, errorFallback: 'activation_candidate_changed' }
  } catch (error) {
    log(`[update] candidate revocation failed: ${String(error)}\n`)
    return { ok: false, errorFallback: 'activation_recovery_required' }
  }
}

/** Prepare the current workbench for exit after the user confirms an already verified update. */
export async function installStagedUpdate(
  onProgress: (progress: UpdateProgress) => void,
  log: LogSink,
  signal?: AbortSignal,
  authorize?: (candidate: LatestVersionMeta) => Promise<() => void>,
  prepareLaunch?: (candidate: LatestVersionMeta) => Promise<SquirrelLaunchCleanup>
): Promise<StartUpdateResult> {
  if (process.platform !== MACOS_PLATFORM) return { ok: false, error: NO_STAGED_UPDATE }
  if (!authorize || !prepareLaunch) {
    log('[update] activation authorization and launch preparation are required\n')
    return { ok: false, errorFallback: 'activation_authorization_required' }
  }
  const staged = readReadyState()
  const receipt = macPrepared?.receipt
  if (!staged?.archive || !receipt || !macPreparationReady(staged.meta))
    return { ok: false, error: NO_STAGED_UPDATE }
  const installation = new InstallationProgress(onProgress, signal, (event) =>
    logUpdateEvent(log, {
      ...event,
      fromVersion: app.getVersion(),
      toVersion: `${staged.meta.version}-${staged.meta.build_number}`,
    })
  )
  let handoffReady = false
  try {
    assertSquirrelInstallSpace(
      staged.archive,
      receipt.expandedBytes,
      true,
      squirrel?.preparedCandidate()
    )
    installation.step('saving')
    macLaunchCleanup = await prepareLaunch(staged.meta)
    await commitWithActivation(
      () => authorize(staged.meta),
      (guard) => {
        signal?.throwIfAborted()
        guard()
        if (!macPreparationReady(staged.meta))
          throw new Error('Mac update native readiness was revoked')
      }
    )
    handoffReady = true
    installation.finish('handoff')
    return { ok: true, mode: 'auto' }
  } catch (error) {
    installation.finish(signal?.aborted && macHandoffReady() ? 'cancelled' : 'failed')
    persistUpdateLog(`[update] installation failed: ${String(error)}\n`)
    if (error instanceof ActivationCandidateChanged)
      return await revokeMacCandidate(staged.meta, log)
    if (!macHandoffReady()) return { ok: false, errorFallback: 'activation_recovery_required' }
    if (signal?.aborted) return { ok: false, cancelled: true }
    return { ok: false, error: String(error) }
  } finally {
    installation.dispose()
    if (!handoffReady) {
      macLaunchCleanup?.()
      macLaunchCleanup = undefined
    }
    await updateLog?.flush()
  }
}

export function initialUpdateSnapshot(log: LogSink, startup?: MacStartupAdmission): UpdateSnapshot {
  if (process.platform === MACOS_PLATFORM && app.isPackaged) {
    try {
      readAdmittedMacHandoff(log, startup)
      if (startup?.admission === 'failed' && !startup.preparationCancelled)
        return {
          phase: 'failed',
          currentVersion: app.getVersion(),
          errorFallback: 'install_failed',
          errorOrigin: 'install',
        }
    } catch (error) {
      return {
        phase: 'failed',
        currentVersion: app.getVersion(),
        error: String(error),
        errorFallback: 'activation_recovery_required',
        errorOrigin: 'install',
      }
    }
  }
  const currentVersion = app.getVersion()
  const staged = readReadyState()
  if (staged) {
    const { buildNumber } = resolveDesktopConfig(log)
    // 暂存包必须仍然比正在运行的版本新：用户可能已经手动装了更新的构建，这时候再报
    // 「已就绪」就是在引导降级。过期的记录直接清掉，别让它一直躺在磁盘上。
    const newer = isNewerRelease(
      { version: currentVersion, buildNumber },
      { version: staged.meta.version, buildNumber: staged.meta.build_number }
    )
    if (newer === false) {
      log(
        `[update] dropped stale staged update ${staged.meta.version}-${staged.meta.build_number}\n`
      )
      dropStagedUpdate(staged, log)
    }
  }
  // Disk state is only a reusable payload. A fresh check/preparation must select
  // it before the UI offers installation, including after an older client failed.
  return { phase: 'idle', currentVersion }
}
