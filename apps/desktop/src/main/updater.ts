import { applicationExecutable } from './resources.ts'
import { desktopDirectoryWriter } from './writer'
// ScholarSeed desktop update client. The main process is the single state owner;
// release identity comes from the immutable packaged product.json policy.

import { app, autoUpdater, shell } from 'electron'
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { ActivationCandidateChanged, requestActivationGrant } from './update-authorization.ts'
export { ActivationCandidateChanged } from './update-authorization.ts'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { removeUpdateArtifact } from './update-files'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { InstallationProgress } from './installation.ts'
import {
  SquirrelInstallation,
  discardOnTerminalSquirrelFailure,
  readSquirrelHandoff,
  type SquirrelArchive,
  type SquirrelLaunchCleanup,
  shipItDiagnostics,
} from './squirrel.ts'
import {
  bindSquirrelRequest,
  inspectSquirrelStartup,
  settleSquirrelStartup,
  inspectSquirrelIdle,
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

import {
  AUTHENTICODE_REPORT_KEYS,
  classifyAuthenticodeStatus,
  parseAuthenticodeReport,
  publisherSubjectsMatch,
} from './authenticode.ts'
import { LOGS_DIRNAME, resolveProductConfig } from './backend'
import { desktopHome } from './storage'
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
  DECISION_CANCEL,
  DECISION_COMMIT,
  DECISION_FILE,
  DECISION_KEYS,
  ELEVATION_FILE,
  HANDSHAKE_HOME_ENV,
  HANDSHAKE_NONCE_ENV,
  HANDSHAKE_PID_ENV,
  HANDSHAKE_SCHEMA_VERSION,
  INSTALL_SUBDIRNAME,
  READY_FILE,
  READY_POLL_INTERVAL_MS,
  InstallerReadiness,
  REQUEST_FILE,
  REQUEST_KEYS,
  UPDATE_ID_ARGUMENT_PREFIX,
  encodeRecord,
  handshakeDirectory,
  isValidUpdateId,
  newNonce,
  newUpdateId,
  parseReady,
  readyPointsToLiveProcess,
  serializeRecord,
  splitFiletime,
} from './handshake.ts'
import type { HandshakeDecision, HandshakeRequest, ReadyRecord, ReadyOutcome } from './handshake.ts'
import { MACOS_HDIUTIL, mountPointsOfImage, readHdiutilInfoPlist } from './mounts.ts'
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
const PREVIEW_CANDIDATE_DIRNAME = 'preview'
const UPDATE_STATE_DIRNAME = 'updates'
// 计时/结果日志额外落一份到 $SCHOLARSEED_HOME/logs/update.log（见 persistUpdateLog）。
const UPDATE_LOG_FILE = 'update.log'
const UPDATE_LOG_MAX_BYTES = 4 * 1024 * 1024
let updateLog: RotatingFileLog | null = null
const REQUEST_TIMEOUT_MS = 8000
const MACOS_PLATFORM = 'darwin'
const MACOS_ARM64_ARCH_TYPE = 'darwin-arm64'
const MACOS_ARM64 = 'arm64'
const MACOS_X86_64 = 'x86_64'
const WINDOWS_PLATFORM = 'win32'
const WINDOWS_POWERSHELL = 'powershell.exe'
const WINDOWS_WHOAMI = 'whoami.exe'
// 新协议不传 /S 与 --force-run：/S 会连进度页一起抑制，--force-run 会让 installSection 的
// ${isForceRun}&&${Silent} 分支成为第二个拉起者。「更新仅进度窗」靠 installer.nsh 的
// customInstallMode 钩子实现（协议模式跳掉 assisted 必弹的安装模式选择页），而不是靠 /S——
// 2026-09-22 真机事故：只不传 /S 而不跳页时，自动更新停在该页等人工点击，安装始终没发生。
// 旧 0.2.0 客户端仍会带 /S --force-run 调新安装器，兼容路径在 installer.nsh（legacy 模式）。
const WINDOWS_UPDATE_ARGUMENT = '--updated'
const WINDOWS_INSTALLER_ENV = 'SCHOLARSEED_UPDATE_INSTALLER'
// 校验脚本把 JSON 报告写进这个 env 指定的文件（而不是 stdout）：stdout 按控制台代码页编码，
// 承载不了证书 DN 里的中文属地属性；文件编码由 `Set-Content -Encoding UTF8` 显式决定。
const WINDOWS_VERIFY_REPORT_ENV = 'SCHOLARSEED_UPDATE_VERIFY_REPORT'
const VERIFY_REPORT_SUFFIX = '.verify.json'
// Status 的三档语义（valid / 确证坏 / 本机不可判定）与发布者 DN 的同发布者判定在
// authenticode.ts：纯判定、可单测。用内置 cmdlet 而非内联 WinVerifyTrust，是因为后者依赖
// Add-Type / [PSCustomObject] / 静态属性赋值，在 PowerShell 受限语言模式下全部被禁（bug 87042987）。
const MACOS_DITTO = '/usr/bin/ditto'
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
const MACOS_STAGE_COPY_TIMEOUT_MS = 600_000
// Fast compression keeps Squirrel's whole-download NSData below its native limit.
const MACOS_ZIP_COMPRESSION_LEVEL = '1'
// 更新后拉起的新实例用它在启动期把 app-started / health-confirmed 绑回本轮 updateId。
const UPDATE_ID_ARGUMENT = '--scholarseed-update-id='
// 结构化事件行的 schema 版本（提案 §5.1 字段契约）。
const UPDATE_EVENT_SCHEMA_VERSION = 1
const READY_STATE_FILE = 'ready.json'
const ANNOUNCED_STATE_FILE = 'announced.json'
const HTTP_OK = 200
const HTTP_PARTIAL_CONTENT = 206
// 部分文件比远端对象还大时服务端回这个；留着它只会每次都 416，必须删掉从头下。
const HTTP_RANGE_NOT_SATISFIABLE = 416
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
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } catch (error) {
    log(`[update] request failed ${url}: ${String(error)}\n`)
    throw error
  } finally {
    clearTimeout(timer)
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
  return join(desktopHome(), UPDATE_STATE_DIRNAME)
}

// Candidate records and payloads may be revoked independently of release.
// Keep installation/recovery journals at their existing paths.
function candidateStateDirectory(): string {
  const directory = updateStateDirectory()
  return previewUpdatesEnabled(() => {}) ? join(directory, PREVIEW_CANDIDATE_DIRNAME) : directory
}

const PREPARATION_STATE_FILE = 'preparation.json'
const REJECTED_STATE_FILE = 'rejected.json'
const REJECTED_STATE_LIMIT = 4096

function rejectedUpdatePath(): string {
  return join(candidateStateDirectory(), REJECTED_STATE_FILE)
}

function readRejectedUpdate(): { id: string; revision: string } | null {
  try {
    const record = JSON.parse(
      readRecord(rejectedUpdatePath(), REJECTED_STATE_LIMIT).toString('utf8')
    )
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

/** Persist revocation before cleanup so a crash cannot restore installation readiness. */
export function discardRejectedUpdate(candidate: LatestVersionMeta, log: LogSink): void {
  const staged = readReadyState()
  writeJson(rejectedUpdatePath(), { id: candidate.id, revision: randomUUID() })
  validatedPreviewCandidates.delete(candidate.id)
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
  const rejected = readRejectedUpdate()
  if (result.latest && rejected?.id === result.latest.id) {
    const assertValid = await authorizeActivation(
      result.latest,
      log,
      signal ?? new AbortController().signal
    )
    assertValid()
    if (readRejectedUpdate()?.revision !== rejected.revision)
      throw new ActivationCandidateChanged('candidate rejection changed during revalidation')
    rmSync(rejectedUpdatePath(), { force: true })
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
  const raw = await getJson(url.toString(), log, signal)
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
function updateCacheDir(): string {
  const root = join(systemCacheDir(), UPDATE_CACHE_DIRNAME)
  const directory = previewUpdatesEnabled(() => {}) ? join(root, PREVIEW_CANDIDATE_DIRNAME) : root
  mkdirSync(directory, { recursive: true })
  return directory
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

/** 已落盘的部分就是续传起点；完整或超长的文件各有自己的处置。 */
function resumePointOf(destination: string, expectedSize: number): number {
  if (!existsSync(destination)) return 0
  const size = statSync(destination).size
  if (size === expectedSize) return expectedSize
  if (size > expectedSize) {
    // 比发布元数据还大，不是同一个包：不能拿它当续传起点。
    rmSync(destination, { force: true })
    return 0
  }
  return size
}

/** 失败态要如实说明「已下载内容是否保留」：留着且不完整才有续传可言。 */
function downloadResumable(destination: string, expectedSize: number): boolean {
  if (!existsSync(destination)) return false
  const size = statSync(destination).size
  return size > 0 && size < expectedSize
}

/**
 * 拉一段字节写到 destination，返回 HTTP 状态码而不抛网络语义之外的错。
 *
 * resumeFrom > 0 时发 Range 请求：206 追加、200 表示服务端没理会 Range（签名链接
 * 换了对象之类），此时必须截断重写 —— 把两段不同来源的字节拼在一起只会得到一个
 * 哈希永远对不上的文件。
 */
async function streamToFile(
  url: string,
  destination: string,
  expectedSize: number,
  resumeFrom: number,
  onProgress: (percent: number, receivedBytes: number) => void,
  signal?: AbortSignal
): Promise<number> {
  const response = await fetch(url, {
    signal,
    ...(resumeFrom > 0 ? { headers: { Range: `bytes=${resumeFrom}-` } } : {}),
  })
  if (response.status === HTTP_RANGE_NOT_SATISFIABLE) return response.status
  if (!response.ok || !response.body) throw new Error(`download HTTP ${response.status}`)
  const partial = response.status === HTTP_PARTIAL_CONTENT
  const start = partial ? resumeFrom : 0
  const contentLength = response.headers.get('content-length')
  if (contentLength && Number(contentLength) !== expectedSize - start) {
    throw new Error('download Content-Length differs from release metadata')
  }
  const output = createWriteStream(destination, { flags: partial ? 'a' : 'w' })
  let received = start
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length
      if (received > expectedSize) {
        callback(new Error('download exceeds release size'))
        return
      }
      onProgress(Math.min(100, Math.round((received / expectedSize) * 100)), received)
      callback(null, chunk)
    },
  })
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    counter,
    output,
    { signal }
  )
  if (received !== expectedSize || statSync(destination).size !== expectedSize) {
    throw new Error(`download size mismatch: got ${received}, expected ${expectedSize}`)
  }
  return response.status
}

async function downloadWithProgress(
  url: string,
  destination: string,
  expectedSize: number,
  onProgress: (percent: number, receivedBytes: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const resumeFrom = resumePointOf(destination, expectedSize)
  if (resumeFrom === expectedSize) {
    // 上一轮已经下完了（客户端在校验前被关掉）：不必再走一次网络。
    onProgress(100, expectedSize)
    return
  }
  onProgress(Math.min(100, Math.round((resumeFrom / expectedSize) * 100)), resumeFrom)
  const status = await streamToFile(url, destination, expectedSize, resumeFrom, onProgress, signal)
  if (status === HTTP_RANGE_NOT_SATISFIABLE) {
    rmSync(destination, { force: true })
    const fresh = await streamToFile(url, destination, expectedSize, 0, onProgress, signal)
    if (fresh !== HTTP_OK) throw new Error(`download HTTP ${fresh}`)
    return
  }
  if (status !== HTTP_OK && status !== HTTP_PARTIAL_CONTENT) {
    throw new Error(`download HTTP ${status}`)
  }
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
 * quit()，内存缓冲也没了。更新又必须在 packaged 应用里跑（installWindows 对 !app.isPackaged
 * 直接抛错）。所以要在真机上按日志定位「2 分钟花在哪一步」，这些行必须自己落盘。放在 logs/ 下
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
  | 'verify-env-unavailable'
  | 'signature-untrusted'
  | 'signature-indeterminate'
  | 'notarization-indeterminate'
  | 'publisher-mismatch'

/**
 * 带类别的校验失败。installWindows / macOS 准备与安装据此把「校验环境不可用」与「签名不可信」分开上报；
 * 原始诊断（可能含代码页乱码的 PowerShell stderr）只落 update.log，不进用户文案。
 */
class UpdateVerifyError extends Error {
  constructor(
    message: string,
    readonly kind: UpdateVerifyFailure
  ) {
    super(message)
  }
}

/**
 * 读回校验脚本写出的报告文件，读完即删。任何失败都返回空串 —— 调用方按「校验没能执行」fail-closed，
 * 不会因为读不到报告而放行安装。
 */
function readVerifyReport(reportPath: string): string {
  try {
    return readFileSync(reportPath, 'utf8')
  } catch {
    return ''
  } finally {
    try {
      rmSync(reportPath, { force: true })
    } catch {
      // 删不掉也只是留一个一次性 UUID 文件名的残留，下一次校验不会读到它。
    }
  }
}

/**
 * 校验待装 Windows 安装包的 Authenticode 签名，要求签名可信且发布者与打包策略一致。
 *
 * 用 PowerShell 内置 cmdlet `Get-AuthenticodeSignature`，而不是内联 C# 调 WinVerifyTrust：后者依赖
 * `Add-Type -TypeDefinition`、`[PSCustomObject]@{}` 类型转换和 `[Console]::OutputEncoding` 静态属性
 * 赋值，这三类构造在 PowerShell **受限语言模式**（WDAC/AppLocker/Device Guard 企业终端管控强制）下
 * 全部被禁，脚本必然非零退出，签名校验 fail-closed 永久阻断安装（bug 87042987）。微软文档明确：受限
 * 模式下「native commands and PowerShell cmdlets」照常运行，被禁的是 Add-Type、类型转换与非 core 类型的
 * 静态成员访问。`Get-AuthenticodeSignature` 是签名模块 cmdlet，读取返回对象的 `.Status` /
 * `.SignerCertificate.Subject` 是属性 get，不涉及被禁的方法调用或类型转换。
 *
 * 脚本刻意只用受限模式安全的构造：不 Add-Type、不 [Console]::、不 [PSCustomObject]、不 [uint32]/[Convert]::
 * 静态调用；事实经 `ConvertTo-Json -Compress` 汇成一份 JSON 报告后由 `Set-Content -Encoding UTF8` 写进
 * 一次性文件，Node 按 UTF-8 读回 —— **判定输入完全不经 stdout**。证书 DN 含本地化中文属地属性，而
 * powershell.exe 的 stdout 按本机控制台代码页编码（中文 Windows 是 936/GBK），Node 侧解码一旦与实际
 * 代码页不一致就把 DN 打成 U+FFFD，进而被误判成「发布者不符」的安全拦截、更新永久阻断（bug
 * 87108457）。真机实测已排除两条更省事的出路：本机 chcp 探测（现场客户端已含该探测却仍回退 UTF-8，
 * 且回退不落日志）、以及靠 `ConvertTo-Json` 把非 ASCII 转义成 `\uXXXX`（PS 5.1.17763 实测不转义）。
 * 文件编码由 cmdlet 参数显式决定，与代码页和序列化器实现都无关。报告不合规即按「校验没能执行」处理
 * —— 传输/解码降级永远不落成「发布者不符」的安全拦截（见 authenticode.ts parseAuthenticodeReport）。
 * 任一步不通过都抛 UpdateVerifyError（fail-closed），绝不放行未验证的包。
 *
 * 代价：cmdlet 走系统默认验签策略（可能联网抓 AIA / 做吊销检查），不像 WinVerifyTrust 能显式关联网。
 * 上一轮真机实测该校验约 1990ms；用户报的「≥2min 才安装」已定位在退出后 NSIS 静默解压、与验签无关，故
 * 此处以「在所有终端（含受限模式）都能完成校验」优先于「极致离线提速」。安装包字节仍由 SHA-512 对着
 * HTTPS 下发的发布元数据钉死（下载时一次、安装前再一次），发布者身份由下面的 Subject 比对强制。
 *
 * 结果三分而非二分：非 Valid 的 Status 里，NotSigned / HashMismatch / NotSupportedFileFormat 是
 * 包级确证坏；NotTrusted / UnknownError / Incompatible 往往是本机链/吊销/兼容状态。后者在签名者与
 * 打包策略一致时单独成一类 fallback（见 authenticode.ts）—— 文案不再引导「重新下载」那条必然复现
 * 的死路，而是引导修复本机环境后重试安装。任何一档都不放行安装（fail-closed 不变）。
 */
export async function verifyWindowsInstaller(
  installer: string,
  expectedPublisher: string,
  log: LogSink
): Promise<void> {
  if (!expectedPublisher) throw new Error('packaged product policy has no Windows publisher')
  const startedAt = Date.now()
  // 报告文件与暂存包同目录（updateCacheDir，我们自己创建并已证明可写），文件名带一次性 UUID：
  // 上一轮的残留不可能被冒充成本轮结果，也不给同机其他进程留一个可预测的替换目标。
  const reportPath = join(
    dirname(installer),
    `${basename(installer)}.${randomUUID()}${VERIFY_REPORT_SUFFIX}`
  )
  // 整段作为 PowerShell -Command 传入。除下面插值的常量外不含任何 ${，避免 JS 模板误插值。
  // 只用受限语言模式允许的构造：cmdlet 调用 + 属性 get + [string] 转换（core 类型）+ hashtable
  // 字面量，无 Add-Type / [PSCustomObject] / [Console]:: 静态赋值 / [Convert]:: 静态调用。
  //
  // 脚本刻意**什么都不往 stdout 写**：stdout 按控制台代码页编码，承载不了 DN 里的中文属地属性，
  // 而真机实测 ConvertTo-Json 也不会把它转义成 ASCII（PS 5.1.17763）。报告一律走 -Encoding UTF8
  // 的文件，编码由 cmdlet 参数决定（bug 87108457）。
  const script = `
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -FilePath $env:${WINDOWS_INSTALLER_ENV}
$subject = ''
if ($signature.SignerCertificate) { $subject = [string]$signature.SignerCertificate.Subject }
$report = @{ ${AUTHENTICODE_REPORT_KEYS.languageMode} = [string]$ExecutionContext.SessionState.LanguageMode; ${AUTHENTICODE_REPORT_KEYS.status} = [string]$signature.Status; ${AUTHENTICODE_REPORT_KEYS.subject} = $subject } | ConvertTo-Json -Compress
Set-Content -LiteralPath $env:${WINDOWS_VERIFY_REPORT_ENV} -Value $report -Encoding UTF8
`
  const result = await runCommandAsync(
    WINDOWS_POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      env: {
        ...process.env,
        [WINDOWS_INSTALLER_ENV]: installer,
        [WINDOWS_VERIFY_REPORT_ENV]: reportPath,
      },
      windowsHide: true,
    }
  )
  // stdout 只作诊断，绝不参与判定。
  const report = parseAuthenticodeReport(readVerifyReport(reportPath))
  // 两类情况都归「校验**没能执行**」而不是「签名不可信」：命令没跑成（PowerShell 缺失/被策略
  // 拦截/非零退出），或跑成了但报告读不到、不满足 JSON 契约、或仍带着 U+FFFD 编码降级指纹。
  // 传输/解码降级绝不能变成一次发布者不符的安全拦截（bug 87108457）。原始输出与实际选用的解码
  // 编码一并落盘供定位，界面给手动安装引导（见 updateInstallFallback）。
  if (result.status !== 0 || report === null) {
    persistUpdateLog(
      result.status === 0
        ? `[update] Windows verification report is unusable: path=${reportPath} stdoutEncoding=${result.encoding} stdout=${result.stdout}\n`
        : `[update] Windows verification command failed: exit=${result.status} stdoutEncoding=${result.encoding} stderr=${result.stderr} stdout=${result.stdout}\n`
    )
    throw new UpdateVerifyError(
      'Windows Authenticode verification could not be performed',
      'verify-env-unavailable'
    )
  }
  const { status, subject, languageMode } = report
  // LanguageMode 一并落盘：受限语言模式(FullLanguage/ConstrainedLanguage)是这类验签失败的关键背景，
  // 出问题时只有这行能说明当时 PowerShell 处于哪种模式（bug 87042987 的回归验证要求）。
  logTiming(log, `Authenticode status=${status} langMode=${languageMode}`, startedAt)
  // 判定输入与解码编码原样落盘：这两行是区分「确证不可信」与「本机不可判定」、以及发布者 DN 形态
  // 差异的唯一证据；反馈日志包会收走 update.log（feedback.py UPDATE_LOG），下一次同类工单才能定论。
  persistUpdateLog(
    `[update] Windows Authenticode verdict input: status=${status} subject=${subject} stdoutEncoding=${result.encoding}\n`
  )
  const verdict = classifyAuthenticodeStatus(status)
  if (verdict !== 'valid') {
    // 不可判定且签名者与打包策略一致：缺的是本机的链/吊销状态，不是包的身份 —— 单独上报，
    // 文案引导修复环境后重试。不可判定但签名者不符、或包级确证坏：按不可信安全拦截。
    if (verdict === 'indeterminate' && publisherSubjectsMatch(subject, expectedPublisher)) {
      persistUpdateLog(
        `[update] Windows installer signature trust undecidable on this machine: status=${status}\n`
      )
      throw new UpdateVerifyError(
        `Windows installer signature trust could not be determined on this machine: ${status}`,
        'signature-indeterminate'
      )
    }
    persistUpdateLog(`[update] Windows installer signature not trusted: status=${status}\n`)
    throw new UpdateVerifyError(
      `Windows installer signature is not trusted: ${status}`,
      'signature-untrusted'
    )
  }
  if (!publisherSubjectsMatch(subject, expectedPublisher)) {
    // 把「实际 vs 期望」的发布者 DN 落盘：换验证原语后若 Subject 字符串格式有出入，只有这行能说明是
    // 格式差异还是真的换了签名者。界面只走 errorFallback 笼统文案，不呈现 DN。
    persistUpdateLog(
      `[update] Windows publisher mismatch: got "${subject}" expected "${expectedPublisher}"\n`
    )
    throw new UpdateVerifyError(
      'Windows installer signature differs from packaged product policy',
      'publisher-mismatch'
    )
  }
}

/** 把校验/安装异常映射成结构化 errorFallback；原始文本只落日志，不进用户文案（Windows/macOS 共用）。 */
function updateInstallFallback(error: unknown): UpdateInstallFallback {
  if (error instanceof UpdateVerifyError) {
    if (error.kind === 'verify-env-unavailable') return 'install_verify_unavailable'
    if (error.kind === 'signature-indeterminate') return 'install_signature_indeterminate'
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
 * 跨进程（NSIS 侧 install.log）用 timestampUtc + updateId 关联；进程内耗时用 elapsedMs。
 */
interface UpdateEventFields {
  phase: string
  event: string
  result?: string
  errorCode?: string
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

/**
 * 当前用户 SID（whoami 是原生 exe，不经 PowerShell、不受受限语言模式影响，同 chcp.com 的
 * 选择理由）。取不到返回 null：调用方 fail-closed 走手动流程，不猜一个身份继续握手。
 */
async function windowsUserSid(): Promise<string | null> {
  try {
    const result = await runCommandAsync(WINDOWS_WHOAMI, ['/user', '/nh'])
    if (result.status !== 0) {
      persistUpdateLog(`[update] whoami failed: exit=${result.status} stderr=${result.stderr}\n`)
      return null
    }
    const match = result.stdout.match(/S-\d+(?:-\d+)+/)
    if (!match) persistUpdateLog(`[update] whoami output has no SID: stdout=${result.stdout}\n`)
    return match ? match[0] : null
  } catch (error) {
    persistUpdateLog(`[update] whoami could not run: ${String(error)}\n`)
    return null
  }
}

/**
 * 指定进程的创建时刻（Windows FILETIME，uint64 十进制串）。用 PowerShell 而非 wmic：
 * wmic 在 Win11 24H2+ 已移除。脚本只用受限语言模式允许的构造（cmdlet + 属性 get +
 * DateTime 这一 core 类型的方法调用），同 verifyWindowsInstaller 的纪律（bug 87042987）。
 */
async function windowsProcessCreationFiletime(pid: number): Promise<string | null> {
  const script =
    `$target = Get-Process -Id $env:${HANDSHAKE_PID_ENV} -ErrorAction Stop\n` +
    'Write-Output ([string]$target.StartTime.ToFileTimeUtc())'
  try {
    const result = await runCommandAsync(
      WINDOWS_POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, [HANDSHAKE_PID_ENV]: String(pid) } }
    )
    const text = result.stdout.trim()
    if (result.status !== 0 || !/^\d{1,20}$/.test(text)) {
      persistUpdateLog(
        `[update] process creation filetime unavailable: exit=${result.status} stdout=${text} stderr=${result.stderr}\n`
      )
      return null
    }
    return text
  } catch (error) {
    persistUpdateLog(`[update] process creation filetime probe failed: ${String(error)}\n`)
    return null
  }
}

/**
 * 上一轮协议安装器是否仍活着：扫握手目录里的 ready.ini，用 installerPid + 创建时刻双重比对。
 *
 * 没有这道闸时，重拉的客户端会对还挂着的安装器再 spawn 一个：模板的
 * ALLOW_ONLY_ONE_INSTALLER_INSTANCE 互斥量命中后直接 Abort（退出码 2），新实例把失败卡甩给
 * 用户，而真正挂着的那个安装器窗口还在等点击（2026-09-22 真机事故形态）。创建时刻一致才算
 * 同一进程，PID 被复用即视为已退（见 handshake.ts readyPointsToLiveProcess）。
 */
async function findRunningProtocolInstaller(): Promise<ReadyRecord | null> {
  let entries: string[]
  try {
    entries = readdirSync(join(updateStateDirectory(), INSTALL_SUBDIRNAME))
  } catch {
    return null // 握手目录还没建过：不可能有挂着的安装器。
  }
  for (const entry of entries) {
    if (!isValidUpdateId(entry)) continue
    let record: ReadyRecord | null = null
    try {
      record = readInstallerRecord(join(updateStateDirectory(), INSTALL_SUBDIRNAME, entry))
    } catch {
      continue // 没有 ready.ini 或写到一半：本轮握手没成立过，不构成并发安装器。
    }
    if (record === null) continue
    const creation = await windowsProcessCreationFiletime(Number(record.installerPid))
    if (creation === null) continue
    const { low, high } = splitFiletime(creation)
    if (readyPointsToLiveProcess(record, Number(record.installerPid), low, high)) return record
  }
  return null
}

function readInstallerRecord(directory: string): ReadyRecord | null {
  for (const filename of [READY_FILE, ELEVATION_FILE]) {
    try {
      const record = parseReady(readFileSync(join(directory, filename)))
      if (record !== null) return record
    } catch {
      continue
    }
  }
  return null
}

/**
 * 轮询 ready.ini 直到有效 ready、超时或安装器先行退出。
 *
 * 三种非 ready 结局语义不同：文件存在且解析成功但身份不符（updateId/nonce 对不上）是
 * **协议失败**，立即返回，不等超时——目录里有别的写者；解析不成立（尚未写完/还没创建）
 * 继续轮询；安装器退出（exit/error）说明握手对端没了，立即返回。
 */
function waitForInstallerReady(
  directory: string,
  request: HandshakeRequest,
  child: ChildProcess,
  signal?: AbortSignal
): Promise<ReadyOutcome | 'cancelled'> {
  return new Promise((resolve) => {
    let settled = false
    const readiness = new InstallerReadiness(request, child.pid!, Date.now())
    function finish(outcome: ReadyOutcome | 'cancelled'): void {
      if (settled) return
      settled = true
      clearInterval(timer)
      child.off('exit', onExit)
      child.off('error', onError)
      signal?.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    function onExit(code: number | null): void {
      persistUpdateLog(`[update] installer exited during handshake with code ${code}\n`)
      finish('installer-exited')
    }
    function onError(error: Error): void {
      persistUpdateLog(`[update] installer spawn error during handshake: ${String(error)}\n`)
      finish('installer-exited')
    }
    const onAbort = (): void => finish('cancelled')
    const timer = setInterval(() => {
      if (settled) return
      let record: ReadyRecord | null = null
      try {
        record = readInstallerRecord(directory)
      } catch {
        record = null
      }
      const outcome = readiness.observe(record, Date.now())
      if (outcome !== null) finish(outcome)
    }, READY_POLL_INTERVAL_MS)
    child.once('exit', onExit)
    child.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

/**
 * 决策单写者：commit/cancel 一经发布不得改变（提案 §5.2 第 3 条）。
 * 临时文件 + 同目录 rename 保证安装器读到的要么是缺失、要么是完整记录。
 * 发布失败只落日志——cancel 发布失败时安装器会等满自己的 60s 决策超时后退出，
 * 语义仍是安全侧。
 */
function publishHandshakeDecision(
  directory: string,
  request: HandshakeRequest,
  decision: HandshakeDecision,
  log: LogSink,
  assertAuthorized?: () => void
): boolean {
  const temporary = join(directory, `decision-${randomUUID()}.tmp`)
  try {
    writeFileSync(
      temporary,
      encodeRecord(
        serializeRecord(DECISION_KEYS, {
          schemaVersion: HANDSHAKE_SCHEMA_VERSION,
          updateId: request.updateId,
          nonce: request.nonce,
          decision,
        })
      )
    )
    if (decision === DECISION_COMMIT && !assertAuthorized)
      throw new Error('activation authorization is required')
    assertAuthorized?.()
    renameSync(temporary, join(directory, DECISION_FILE))
    logUpdateEvent(log, {
      phase: 'handoff',
      event: 'decision',
      result: decision,
      updateId: request.updateId,
    })
    return true
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch (cleanupError) {
      persistUpdateLog(`[update] decision temporary cleanup failed: ${String(cleanupError)}\n`)
    }
    persistUpdateLog(`[update] decision publish failed (${decision}): ${String(error)}\n`)
    return false
  }
}

export async function installWindows(
  installer: string,
  meta: LatestVersionMeta,
  log: LogSink,
  authorize?: (candidate: LatestVersionMeta) => Promise<() => void>,
  signal?: AbortSignal
): Promise<StartUpdateResult> {
  const fromVersion = app.getVersion()
  const toVersion = `${meta.version}-${meta.build_number}`
  const updateId = newUpdateId()
  let child: ChildProcess | null = null
  let directory: string | null = null
  let request: HandshakeRequest | null = null
  try {
    if (!app.isPackaged) {
      throw new Error('automatic Windows update requires an installed packaged application')
    }
    const running = await findRunningProtocolInstaller()
    if (running !== null) {
      // 上一轮安装器还活着（停在进度窗或等人点向导）：再 spawn 只会被模板互斥量 Abort 成
      // 一次「安装失败」。不退出 app、不动暂存包，把结局标成独立分类让界面说清在等什么。
      logUpdateEvent(log, {
        phase: 'installer-start',
        event: 'concurrent-installer',
        result: 'blocked',
        errorCode: 'installer-alive',
        updateId: running.updateId,
        fromVersion,
        toVersion,
      })
      return { ok: false, errorFallback: 'install_already_running' }
    }
    const config = resolveDesktopConfig(log)
    await verifyWindowsInstaller(installer, config.expectedWindowsPublisher, log)

    // 握手上下文（SID + 进程创建时刻）任一取不到就不做自动交接：不退出 app，
    // 打开完整安装包走手动流程；自动握手要求原用户上下文完整。
    const sid = await windowsUserSid()
    const filetime = await windowsProcessCreationFiletime(process.pid)
    if (sid === null || filetime === null) {
      logUpdateEvent(log, {
        phase: 'installer-start',
        event: 'handoff-context-unavailable',
        result: 'manual',
        errorCode: sid === null ? 'caller-sid-unavailable' : 'caller-creation-time-unavailable',
        updateId,
        fromVersion,
        toVersion,
      })
      const assertAuthorized = await authorize?.(meta)
      signal?.throwIfAborted()
      if (!assertAuthorized) throw new Error('activation authorization is required')
      assertAuthorized()
      await shell.openPath(installer)
      return { ok: true, mode: 'manual' }
    }

    const { low, high } = splitFiletime(filetime)
    request = {
      schemaVersion: HANDSHAKE_SCHEMA_VERSION,
      updateId,
      nonce: newNonce(),
      callerSid: sid,
      callerPid: String(process.pid),
      callerCreationLow: low,
      callerCreationHigh: high,
      fromVersion,
      toVersion,
      installDir: resolve(dirname(applicationExecutable(app))),
    }
    directory = handshakeDirectory(join(updateStateDirectory(), 'install'), updateId)
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, REQUEST_FILE),
      encodeRecord(serializeRecord(REQUEST_KEYS, request))
    )

    signal?.throwIfAborted()
    const spawnStartedAt = Date.now()
    // spawn 选项不带窗口隐藏旗标：GUI 子系统无控制台可藏，而该旗标的 SW_HIDE 会隐掉安装器
    // 第一个窗口——任何「等用户」状态（fail-closed 弹窗、模板交互页）都会变成看不见的模态
    // 挂死（2026-09-23 真机：安装模式页被隐 → 安装器永生 → B 闸永久拦死后续更新）。
    child = spawn(installer, [WINDOWS_UPDATE_ARGUMENT, `${UPDATE_ID_ARGUMENT_PREFIX}${updateId}`], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        [HANDSHAKE_HOME_ENV]: desktopHome(),
        [HANDSHAKE_NONCE_ENV]: request.nonce,
      },
    })
    if (!child.pid) throw new Error('Windows installer did not start')
    logUpdateEvent(log, {
      phase: 'installer-start',
      event: 'spawn',
      result: 'ok',
      updateId,
      fromVersion,
      toVersion,
    })

    const outcome = await waitForInstallerReady(directory, request, child, signal)
    const elapsedMs = Date.now() - spawnStartedAt
    if (outcome !== 'ready') {
      publishHandshakeDecision(directory, request, DECISION_CANCEL, log)
      child.unref()
      logUpdateEvent(log, {
        phase: 'installer-ready',
        event: 'wait',
        result: outcome,
        errorCode: outcome,
        updateId,
        fromVersion,
        toVersion,
        elapsedMs,
      })
      return outcome === 'cancelled'
        ? { ok: false, cancelled: true }
        : { ok: false, errorFallback: 'install_failed' }
    }
    const assertAuthorized = await authorize?.(meta)
    signal?.throwIfAborted()
    if (!assertAuthorized) throw new Error('activation authorization is required')
    assertAuthorized()
    if (!publishHandshakeDecision(directory, request, DECISION_COMMIT, log, assertAuthorized)) {
      throw new Error('Windows update commit could not be persisted')
    }
    logUpdateEvent(log, {
      phase: 'installer-ready',
      event: 'wait',
      result: 'ok',
      updateId,
      fromVersion,
      toVersion,
      elapsedMs,
    })
    // commit 已发布才 unref：安装器接下来等本进程退出（≤60s），随后卸载/安装/拉起。
    child.unref()
    child = null
    return { ok: true, mode: 'auto' }
  } catch (error) {
    // 原始诊断（含可能的代码页乱码 stderr）只落 update.log；回报结构化分类，界面给本地化文案。
    if (child && directory && request) {
      publishHandshakeDecision(directory, request, DECISION_CANCEL, log)
      child.unref()
    }
    persistUpdateLog(`[update] Windows install failed: ${String(error)}\n`)
    return signal?.aborted
      ? { ok: false, cancelled: true }
      : { ok: false, errorFallback: updateInstallFallback(error) }
  }
}

/** 新实例启动参数里的本轮 updateId；形状不合法一律视为没有（防路径/日志注入）。 */
export function pendingUpdateId(argv: string[] = process.argv): string | null {
  const value = argv.find((argument) => argument.startsWith(UPDATE_ID_ARGUMENT))
  if (!value) return null
  const candidate = value.slice(UPDATE_ID_ARGUMENT.length)
  return isValidUpdateId(candidate) ? candidate : null
}

/**
 * 更新后新实例的启动闭环事件（提案 §5.2）：app-started 在窗口就绪后、health-confirmed
 * 在 bootstrap 已等到 /api/healthz 之后（index.ts 调用点保证该顺序）。Shell 拉起成功
 * 不等于健康成功，两条事件分开落，install.log 的 launch 结果只覆盖前者。
 */
export function logUpdateLifecycleEvent(
  event: 'app-started' | 'health-confirmed',
  updateId: string,
  log: LogSink
): void {
  logUpdateEvent(log, {
    phase: event === 'app-started' ? 'launch' : 'health-confirmed',
    event,
    result: 'ok',
    updateId,
    fromVersion: app.getVersion(),
  })
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
      'codesign',
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
          : error.verdict === 'unavailable'
            ? 'verify-env-unavailable'
            : 'notarization-indeterminate'
      throw new UpdateVerifyError(error.message, kind)
    }
    throw error
  }
}

const SQUIRREL_HANDOFF_FILE = 'squirrel.json'
let squirrel: SquirrelInstallation | null = null
let squirrelRecoveryRequired = false
let macPrepared: { receipt: PreparedArchive; workspace: string } | null = null
let macPreparationEpoch = 0
export function macPreparationReady(meta: LatestVersionMeta): boolean {
  const ready = readReadyState()
  return (
    !!ready?.archive &&
    preparedIdentity(ready.meta) === preparedIdentity(meta) &&
    !!macPrepared?.receipt.matches(meta, ready.archive)
  )
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
  try {
    const source = join(mount, PRODUCT_APPLICATION)
    if (
      !lstatSync(source).isDirectory() ||
      realpathSync(source) !== join(realpathSync(mount), PRODUCT_APPLICATION)
    )
      throw new Error('DMG application must be an exact directory inside the mounted image')
    installation.signal?.throwIfAborted()
    return await operation(source)
  } finally {
    // Cleanup must not inherit an already-aborted operation signal.
    await runLoggedCommand(log, 'detach update image', MACOS_HDIUTIL, ['detach', mount, '-force'], {
      timeoutMs: MACOS_MOUNT_COMMAND_TIMEOUT_MS,
    })
    rmdirSync(mount)
  }
}

function squirrelHandoffPath(home = desktopHome()): string {
  return join(home, UPDATE_STATE_DIRNAME, SQUIRREL_HANDOFF_FILE)
}

export async function macStartupAdmission(
  home: string,
  log: LogSink,
  expected?: { candidate: string; targetBuild: string; sourceBuild?: string }
): Promise<SquirrelAdmission> {
  if (process.platform !== MACOS_PLATFORM || !app.isPackaged) return 'allow'
  try {
    const handoff = readSquirrelHandoff(squirrelHandoffPath(home))
    if (
      expected &&
      (!handoff ||
        handoff.candidate !== expected.candidate ||
        handoff.buildNumber !== expected.targetBuild)
    )
      throw new Error('Mac launch context does not match the pending handoff')
    const config = resolveDesktopConfig(log)
    const current = { version: app.getVersion(), buildNumber: config.buildNumber }
    if (squirrelAdmission(current, handoff, 'unconfirmed') === 'allow') {
      if (!expected || !squirrelLaunchSuperseded(config.buildNumber, expected)) return 'allow'
      if (!(await inspectSquirrelIdle(systemCacheDir(), config.bundleId)))
        throw new Error(
          'Superseded Mac launch still has native update activity or uncertain evidence'
        )
      if (
        JSON.stringify(readSquirrelHandoff(squirrelHandoffPath(home))) !== JSON.stringify(handoff)
      )
        throw new Error('Mac handoff changed during superseded startup admission')
      log(`[update] startup admission=superseded candidate=${handoff!.candidate}\n`)
      return 'superseded'
    }
    const status = await settleSquirrelStartup(() =>
      inspectSquirrelStartup(
        handoff!,
        systemCacheDir(),
        config.bundleId,
        resolve(dirname(process.execPath), '..', '..')
      )
    )
    if (JSON.stringify(readSquirrelHandoff(squirrelHandoffPath(home))) !== JSON.stringify(handoff))
      throw new Error('Mac handoff changed during startup admission')
    const admission = squirrelAdmission(current, handoff, status)
    log(
      `[update] startup admission=${admission} status=${status} candidate=${handoff!.candidate}\n`
    )
    return admission
  } catch (error) {
    log(`[update] startup admission=exit evidence unavailable: ${String(error)}\n`)
    return 'exit'
  }
}

export function macHandoffCommitted(): boolean {
  return process.platform === MACOS_PLATFORM && (squirrelRecoveryRequired || !!squirrel?.committed)
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

export function quitMacUpdate(): void {
  if (!squirrel) throw new Error('Squirrel installation unavailable')
  squirrel.quitAndInstall()
}

function preparedApplicationDirectory(meta: LatestVersionMeta): string {
  return join(updateCacheDir(), `${stagedInstallerName(meta.version, meta.build_number)}.prepared`)
}

async function prepareDmg(
  dmgPath: string,
  meta: LatestVersionMeta,
  installation: InstallationProgress,
  log: LogSink
): Promise<NonNullable<typeof macPrepared>> {
  if (process.platform !== MACOS_PLATFORM || !app.isPackaged)
    throw new Error('automatic update requires a packaged macOS application')
  meta = Object.freeze({ ...meta })
  const { signal } = installation
  const epoch = macPreparationEpoch
  const directory = preparedApplicationDirectory(meta)
  const archive = join(directory, 'application.zip')
  const startedAt = Date.now()
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
          installation.step('copying', MACOS_STAGE_COPY_TIMEOUT_MS)
          await runLoggedCommand(
            log,
            'archive mounted application',
            MACOS_DITTO,
            [
              '-c',
              '-k',
              '--zlibCompressionLevel',
              MACOS_ZIP_COMPRESSION_LEVEL,
              '--sequesterRsrc',
              '--keepParent',
              source,
              archive,
            ],
            { timeoutMs: MACOS_STAGE_COPY_TIMEOUT_MS, signal }
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
    if (!entry.name.endsWith('.dmg.prepared') || !entry.name.startsWith('scholarseed-')) continue
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
  if (previousReady?.meta.id === id && macPreparationReady(previousReady.meta))
    return { ok: true, ready: previousReady }
  try {
    // Only the preparation owner calls this after its previous worker has drained.
    if (macHandoffCommitted()) throw new Error('Squirrel handoff requires recovery')
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
    const downloadStartedAt = Date.now()
    await downloadWithProgress(
      info.download_url,
      destination,
      info.file_size,
      (percent, receivedBytes) => onProgress({ phase: 'downloading', percent, receivedBytes }),
      signal
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
      // Cold state always reconstructs the trusted DMG -> ZIP relationship.
      prepared = await prepareDmg(destination, meta, preparation, log)
      archive = prepared.receipt.archive
      signal?.throwIfAborted()
    } catch (error) {
      if (prepared) await removeUpdateArtifact(prepared.workspace)
      persistUpdateLog(`[update] macOS preparation failed: ${String(error)}\n`)
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

/**
 * 安装已暂存的更新包。
 *
 * A live macOS receipt reuses only the final ZIP; source identity and current
 * trust are refreshed from the digest-bound read-only DMG before handoff. Restored state and Windows still
 * recheck the installer. The native feed always verifies the actual ZIP bytes.
 */
export async function installStagedUpdate(
  onProgress: (progress: UpdateProgress) => void,
  log: LogSink,
  signal?: AbortSignal,
  authorize?: (candidate: LatestVersionMeta) => Promise<() => void>,
  prepareLaunch?: (candidate: LatestVersionMeta) => SquirrelLaunchCleanup
): Promise<StartUpdateResult> {
  if (!authorize) {
    log('[update] activation authorization is required\n')
    return { ok: false, errorFallback: 'activation_authorization_required' }
  }
  const staged = readReadyState()
  if (!staged) return { ok: false, error: NO_STAGED_UPDATE }
  const installation =
    process.platform === WINDOWS_PLATFORM
      ? undefined
      : new InstallationProgress(onProgress, signal, (event) =>
          logUpdateEvent(log, {
            ...event,
            fromVersion: app.getVersion(),
            // 带上 build_number（与 Windows 路径对齐）：日志才看得出装的是哪个构建，同一 version
            // 可有多个 build（bug 87435837 现场正因缺它无法从日志定位目标产物）。
            toVersion: `${staged.meta.version}-${staged.meta.build_number}`,
          })
        )
  let discardLaunch: SquirrelLaunchCleanup | undefined
  try {
    if (installation) installation.step('package')
    else onProgress({ phase: 'verifying' })
    // A live receipt binds the previously checked DMG to the verified final ZIP.
    // Windows and restored/mismatched macOS state still require installer recheck.
    if (
      !installation ||
      !staged.archive ||
      !macPrepared?.receipt.matches(staged.meta, staged.archive)
    ) {
      const startedAt = Date.now()
      const actual = await sha512OfFile(staged.path, signal)
      logTiming(
        log,
        `staged installer SHA-512 re-verify (${staged.meta.file_size} bytes)`,
        startedAt
      )
      if (actual.toLowerCase() !== staged.meta.sha512.toLowerCase()) {
        rmSync(staged.path, { force: true })
        clearReadyState()
        throw new Error('staged installer no longer matches its release metadata')
      }
    }
    if (installation) {
      if (macHandoffCommitted()) throw new Error('Squirrel handoff already consumed')
      if (!staged.archive) throw new Error('Squirrel archive is not prepared')
      let prepared = macPrepared
      if (!prepared?.receipt.matches(staged.meta, staged.archive)) {
        if (prepared) await removeUpdateArtifact(prepared.workspace)
        macPrepared = null
        prepared = await prepareDmg(staged.path, staged.meta, installation, log)
        macPrepared = prepared
        // Replace stale disk hints only with this process's verified conversion.
        writeReadyState({ ...staged, archive: prepared.receipt.archive })
      }
      const startedAt = Date.now()
      const frozen = await prepared.receipt.revalidate(
        () =>
          withMountedDmg(staged.path, installation, log, (source) =>
            verifyMountedNotarization(source, log, installation, 'source')
          ),
        signal
      )
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
      squirrel = new SquirrelInstallation(
        autoUpdater,
        squirrelHandoffPath(),
        (event) => {
          logUpdateEvent(log, {
            phase: 'macos-install',
            event,
            updateId: staged.meta.id,
            toVersion: staged.meta.version,
          })
          // A committed handoff whose native installer terminally fails will never relaunch
          // the target; drop the launch context so this live session recovers storage and
          // future updates instead of carrying a dead transaction.
          discardLaunch = discardOnTerminalSquirrelFailure(event, discardLaunch)
        },
        undefined,
        (identity) =>
          bindSquirrelRequest(
            systemCacheDir(),
            resolveDesktopConfig(log).bundleId,
            resolve(dirname(process.execPath), '..', '..'),
            identity
          )
      )
      await squirrel.prepare(
        frozen,
        {
          version: staged.meta.version,
          buildNumber: staged.meta.build_number,
          candidate: staged.meta.id,
          at: Date.now(),
          state: 'requested',
        },
        async () => {
          signal?.throwIfAborted()
          const guard = await authorize(staged.meta)
          return () => {
            signal?.throwIfAborted()
            guard()
            if (!prepareLaunch) throw new Error('Mac update launch context is required')
            discardLaunch = prepareLaunch(staged.meta)
            installation.step('restarting')
          }
        }
      )
      installation.finish('handoff')
      return { ok: true, mode: 'auto' }
    }
    onProgress({ phase: 'installing', install_stage: 'preparing' })
    return await installWindows(staged.path, staged.meta, log, authorize, signal)
  } catch (error) {
    installation?.finish(signal?.aborted && !macHandoffCommitted() ? 'cancelled' : 'failed')
    persistUpdateLog(`[update] installation failed: ${String(error)}\n`)
    if (error instanceof ActivationCandidateChanged) {
      try {
        discardRejectedUpdate(staged.meta, log)
        return { ok: false, errorFallback: 'activation_candidate_changed' }
      } catch (recovery) {
        log(`[update] candidate revocation failed: ${String(recovery)}\n`)
        return { ok: false, errorFallback: 'activation_recovery_required' }
      }
    }
    if (error instanceof PreparedArtifactChangedError) macPrepared = null
    if (installation && signal?.aborted && !macHandoffCommitted())
      return { ok: false, cancelled: true }
    if (error instanceof UpdateVerifyError)
      return { ok: false, errorFallback: updateInstallFallback(error) }
    return { ok: false, error: String(error) }
  } finally {
    installation?.dispose()
    if (!macHandoffCommitted()) discardLaunch?.()
    if (squirrel && !squirrel.committed) {
      squirrel.dispose()
      squirrel = null
    }
    await updateLog?.flush()
  }
}

export function initialUpdateSnapshot(log: LogSink): UpdateSnapshot {
  if (process.platform === MACOS_PLATFORM) {
    try {
      const handoff = readSquirrelHandoff(squirrelHandoffPath())
      if (handoff) {
        const newer = isNewerRelease(
          { version: app.getVersion(), buildNumber: resolveDesktopConfig(log).buildNumber },
          { version: handoff.version, buildNumber: handoff.buildNumber }
        )
        if (newer !== false) throw new Error('Squirrel installation requires recovery')
        logUpdateEvent(log, {
          phase: 'macos-install',
          event: 'installed-build-observed',
          updateId: handoff.candidate,
          toVersion: handoff.version,
          result: 'success',
        })
        rmSync(squirrelHandoffPath(), { force: true })
      }
    } catch (error) {
      squirrelRecoveryRequired = true
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
