// ScholarSeed desktop update client. The main process is the single state owner;
// release identity comes from the immutable packaged product.json policy.

import { app, shell } from 'electron'
import { spawn, spawnSync } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import {
  accessSync,
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { basename, dirname, join } from 'path'

import { desktopHome, resolveProductConfig } from './backend'
import { systemCacheDir } from './cachedir.ts'
import { planUpdatePrune, stagedInstallerName, updateArtifactKind } from './staging.ts'
import type { UpdateArtifactEntry } from './staging.ts'
import {
  UPDATE_PATH_PREFIX,
  buildUpdateCheckUrl,
  desktopArchType,
  identityMismatches,
  parseDownloadInfo,
  parseUpdateCheckResult
} from './release.ts'
import type { DesktopUpdateConfig } from './release.ts'
import { LOCAL_RELEASE_LANE } from './product.ts'
import type {
  DownloadInfo,
  LatestVersionMeta,
  StartUpdateResult,
  UpdateCheckResult,
  UpdateDiagnosis,
  UpdateProgress,
  UpdateSnapshot
} from '../updates.ts'
import { isNewerRelease } from './version.ts'

export type LogSink = (line: string) => void

const UPDATE_CACHE_DIRNAME = 'scholarseed-update'
const UPDATE_STATE_DIRNAME = 'updates'
const ROLLBACK_STATE_FILE = 'rollback.json'
const REQUEST_TIMEOUT_MS = 8000
const MACOS_PLATFORM = 'darwin'
const MACOS_ARM64_ARCH_TYPE = 'darwin-arm64'
const MACOS_ARM64 = 'arm64'
const MACOS_X86_64 = 'x86_64'
const WINDOWS_PLATFORM = 'win32'
const WINDOWS_POWERSHELL = 'powershell.exe'
const WINDOWS_UPDATE_ARGUMENTS = ['--updated', '/S', '--force-run']
const WINDOWS_INSTALLER_ENV = 'SCHOLARSEED_UPDATE_INSTALLER'
const MACOS_DITTO = '/usr/bin/ditto'
const MACOS_HDIUTIL = '/usr/bin/hdiutil'
const PRODUCT_APPLICATION = 'ScholarSeed.app'
const INSTALL_STAGING_SUFFIX = '.scholarseed-new'
const INSTALL_PREVIOUS_SUFFIX = '.scholarseed-previous'
const INSTALL_FAILED_SUFFIX = '.scholarseed-failed'
const INSTALLER_EXIT_WAIT_ATTEMPTS = 300
const INSTALLER_EXIT_WAIT_SECONDS = 0.1
const INSTALL_CONFIRM_WAIT_ATTEMPTS = 120
const INSTALL_CONFIRM_WAIT_SECONDS = 0.5
const UPDATE_TOKEN_ARGUMENT = '--scholarseed-update-token='
const READY_STATE_FILE = 'ready.json'
const ANNOUNCED_STATE_FILE = 'announced.json'
const HTTP_OK = 200
const HTTP_PARTIAL_CONTENT = 206
// 部分文件比远端对象还大时服务端回这个；留着它只会每次都 416，必须删掉从头下。
const HTTP_RANGE_NOT_SATISFIABLE = 416
// 协议级诊断串，不是界面文案：渲染层把它们当错误详情透出，翻译归属在展示侧。
const DOWNLOAD_METADATA_FAILED = 'download metadata failed'
export const NO_STAGED_UPDATE = 'no staged update to install'

interface RollbackState {
  version: string
  reason: string
  at: number
}

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
    releaseLane: product.releaseLane
  }
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
  log(`[update] ignored non-monotonic candidate ${result.latest.version}-${result.latest.build_number}\n`)
  return { has_update: false, latest: null }
}

async function getJson(url: string, log: LogSink): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } catch (error) {
    log(`[update] request failed ${url}: ${String(error)}\n`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function updateStateDirectory(): string {
  return join(desktopHome(), UPDATE_STATE_DIRNAME)
}

export async function checkForUpdate(log: LogSink): Promise<UpdateCheckResult> {
  const targetArchType = archType()
  if (!targetArchType) throw new Error(`unsupported desktop target ${process.platform}/${process.arch}`)
  const config = resolveDesktopConfig(log)
  if (!config.baseUrl) throw new Error('packaged product policy has no update base URL')
  const version = app.getVersion()
  const raw = await getJson(buildUpdateCheckUrl(config, version, targetArchType), log)
  return monotonicUpdateResult(
    version,
    config,
    parseUpdateCheckResult(raw, config, targetArchType),
    log
  )
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
      channel: config.channel
    },
    server: null,
    mismatches: []
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
    sha512: text('sha512')
  }
  diagnosis.server = {
    version: meta.version,
    buildNumber: meta.build_number,
    productId: meta.product_id,
    bundleId: meta.bundle_id,
    teamId: meta.team_id ?? '',
    channel: meta.channel,
    archType: meta.arch_type
  }
  diagnosis.mismatches = identityMismatches(meta, config, targetArchType)
  return diagnosis
}

export async function getDownloadInfo(id: string, log: LogSink): Promise<DownloadInfo> {
  const targetArchType = archType()
  if (!targetArchType) throw new Error('unsupported desktop target')
  const config = resolveDesktopConfig(log)
  const raw = await getJson(
    `${config.baseUrl}${UPDATE_PATH_PREFIX}/packages/${encodeURIComponent(id)}/download`,
    log
  )
  return parseDownloadInfo(raw, config, targetArchType, id)
}

/**
 * 待装安装包、安装脚本与 DMG 挂载点所在的工作目录。
 *
 * 用系统缓存目录而不是 temp：暂存包要活到用户点「立即更新」，中间可能跨天、跨重启，
 * 而 temp 不承诺存活（macOS 清长期未访问项，Windows 存储感知扫 %TEMP%）。缓存目录
 * 本来就是系统与用户清理工具的管辖范围，要腾空间的用户找得到它。
 */
function updateCacheDir(): string {
  const directory = join(systemCacheDir(), UPDATE_CACHE_DIRNAME)
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
function pruneUpdateArtifacts(keepPayload: string, log: LogSink): void {
  const directory = updateCacheDir()
  try {
    const entries: UpdateArtifactEntry[] = readdirSync(directory, { withFileTypes: true }).map(
      (entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
        empty: entry.isDirectory() && readdirSync(join(directory, entry.name)).length === 0
      })
    )
    const plan = planUpdatePrune(entries, keepPayload)
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
  onProgress: (percent: number, receivedBytes: number) => void
): Promise<number> {
  const response = await fetch(
    url,
    resumeFrom > 0 ? { headers: { Range: `bytes=${resumeFrom}-` } } : {}
  )
  if (response.status === HTTP_RANGE_NOT_SATISFIABLE) return response.status
  if (!response.ok || !response.body) throw new Error(`download HTTP ${response.status}`)
  const partial = response.status === HTTP_PARTIAL_CONTENT
  const start = partial ? resumeFrom : 0
  const contentLength = response.headers.get('content-length')
  if (contentLength && Number(contentLength) !== expectedSize - start) {
    throw new Error('download Content-Length differs from release metadata')
  }
  const output = createWriteStream(destination, { flags: partial ? 'a' : 'w' })
  const reader = response.body.getReader()
  let received = start
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      received += value.length
      await new Promise<void>((resolve, reject) => {
        output.write(Buffer.from(value), (error) => (error ? reject(error) : resolve()))
      })
      onProgress(Math.min(100, Math.round((received / expectedSize) * 100)), received)
    }
  } finally {
    await new Promise<void>((resolve) => output.end(resolve))
  }
  if (received !== expectedSize || statSync(destination).size !== expectedSize) {
    throw new Error(`download size mismatch: got ${received}, expected ${expectedSize}`)
  }
  return response.status
}

async function downloadWithProgress(
  url: string,
  destination: string,
  expectedSize: number,
  onProgress: (percent: number, receivedBytes: number) => void
): Promise<void> {
  const resumeFrom = resumePointOf(destination, expectedSize)
  if (resumeFrom === expectedSize) {
    // 上一轮已经下完了（客户端在校验前被关掉）：不必再走一次网络。
    onProgress(100, expectedSize)
    return
  }
  onProgress(
    Math.min(100, Math.round((resumeFrom / expectedSize) * 100)),
    resumeFrom
  )
  const status = await streamToFile(url, destination, expectedSize, resumeFrom, onProgress)
  if (status === HTTP_RANGE_NOT_SATISFIABLE) {
    rmSync(destination, { force: true })
    const fresh = await streamToFile(url, destination, expectedSize, 0, onProgress)
    if (fresh !== HTTP_OK) throw new Error(`download HTTP ${fresh}`)
    return
  }
  if (status !== HTTP_OK && status !== HTTP_PARTIAL_CONTENT) {
    throw new Error(`download HTTP ${status}`)
  }
}

function sha512OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk: Buffer | string) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function runCommand(executable: string, args: string[]): { status: number | null; output: string } {
  const result = spawnSync(executable, args, { encoding: 'utf8' })
  return {
    status: result.status,
    output: `${result.stdout || ''}\n${result.stderr || ''}`.trim()
  }
}

function requireCommand(executable: string, args: string[], label: string): string {
  const result = runCommand(executable, args)
  if (result.status !== 0) throw new Error(`${label} failed: ${result.output}`)
  return result.output
}

interface WindowsSignature {
  Status: string
  Subject: string
}

export function verifyWindowsInstaller(installer: string, expectedPublisher: string): void {
  if (!expectedPublisher) throw new Error('packaged product policy has no Windows publisher')
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
    `$signature = Get-AuthenticodeSignature -LiteralPath $env:${WINDOWS_INSTALLER_ENV};`,
    '[PSCustomObject]@{ Status = [string]$signature.Status;',
    'Subject = [string]$signature.SignerCertificate.Subject } | ConvertTo-Json -Compress'
  ].join(' ')
  const result = spawnSync(
    WINDOWS_POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', env: { ...process.env, [WINDOWS_INSTALLER_ENV]: installer } }
  )
  if (result.status !== 0) {
    throw new Error(`Authenticode verification failed: ${result.stderr || result.stdout || result.status}`)
  }
  const raw = String(result.stdout || '').trim()
  const signature = JSON.parse(raw) as WindowsSignature
  if (signature.Status !== 'Valid' || signature.Subject !== expectedPublisher) {
    throw new Error('Windows installer signature differs from packaged product policy')
  }
}

export function installWindows(
  installer: string,
  meta: LatestVersionMeta,
  log: LogSink
): StartUpdateResult {
  try {
    if (!app.isPackaged) {
      throw new Error('automatic Windows update requires an installed packaged application')
    }
    const config = resolveDesktopConfig(log)
    verifyWindowsInstaller(installer, config.expectedWindowsPublisher)
    const child = spawn(installer, WINDOWS_UPDATE_ARGUMENTS, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.unref()
    if (!child.pid) throw new Error('Windows installer did not start')
    log(`[update] started verified Windows installer version=${meta.version}\n`)
    return { ok: true, mode: 'auto' }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

function currentAppBundlePath(): string | null {
  const marker = '.app/'
  const index = process.execPath.indexOf(marker)
  return index === -1 ? null : process.execPath.slice(0, index + marker.length - 1)
}

function isWritable(path: string): boolean {
  try {
    accessSync(path, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

function mountDmg(dmgPath: string): string {
  requireCommand(MACOS_HDIUTIL, ['verify', dmgPath], 'DMG verification')
  const mount = join(updateCacheDir(), `mount-${randomUUID()}`)
  mkdirSync(mount, { recursive: true })
  requireCommand(
    MACOS_HDIUTIL,
    ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmgPath],
    'DMG attach'
  )
  return mount
}

function plistValue(appPath: string, field: string): string {
  return requireCommand(
    '/usr/bin/plutil',
    ['-extract', field, 'raw', join(appPath, 'Contents/Info.plist')],
    `read ${field}`
  )
}

function signedTeamId(appPath: string): string {
  const output = requireCommand('codesign', ['-d', '--verbose=4', appPath], 'codesign metadata')
  const match = output.match(/^TeamIdentifier=(.+)$/m)
  return match ? match[1].trim() : ''
}

function verifyMountedApplication(
  appPath: string,
  meta: LatestVersionMeta,
  config: DesktopUpdateConfig
): void {
  if (plistValue(appPath, 'CFBundleIdentifier') !== config.bundleId) {
    throw new Error('downloaded app Bundle ID differs from packaged product policy')
  }
  if (plistValue(appPath, 'CFBundleShortVersionString') !== meta.version) {
    throw new Error('downloaded app version differs from release metadata')
  }
  const executable = plistValue(appPath, 'CFBundleExecutable')
  const architectures = requireCommand(
    '/usr/bin/lipo',
    ['-archs', join(appPath, 'Contents/MacOS', executable)],
    'application architecture check'
  ).split(/\s+/)
  const expectedArch = meta.arch_type === MACOS_ARM64_ARCH_TYPE ? MACOS_ARM64 : MACOS_X86_64
  if (!architectures.includes(expectedArch)) throw new Error('downloaded app architecture is incompatible')
  requireCommand('codesign', ['--verify', '--deep', '--strict', appPath], 'application signature')
  requireCommand('spctl', ['--assess', '--type', 'execute', appPath], 'Gatekeeper assessment')
  requireCommand('xcrun', ['stapler', 'validate', appPath], 'notarization ticket')
  if (signedTeamId(appPath) !== config.expectedTeamId || meta.team_id !== config.expectedTeamId) {
    throw new Error('downloaded app Apple Team ID differs from packaged product policy')
  }
}

async function openInstallerFallback(
  dmgPath: string,
  reason: string,
  log: LogSink
): Promise<StartUpdateResult> {
  log(`[update] ${reason}; opening verified installer for manual installation\n`)
  await shell.openPath(dmgPath)
  return { ok: true, mode: 'manual' }
}

function confirmationPath(token: string): string {
  return join(updateStateDirectory(), `confirmed-${token}`)
}

function rollbackPath(): string {
  return join(updateStateDirectory(), ROLLBACK_STATE_FILE)
}

export function pendingUpdateToken(argv: string[] = process.argv): string | null {
  const value = argv.find((argument) => argument.startsWith(UPDATE_TOKEN_ARGUMENT))
  return value ? value.slice(UPDATE_TOKEN_ARGUMENT.length) : null
}

export function confirmInstalledUpdate(token: string, log: LogSink): void {
  if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error('invalid update confirmation token')
  const path = confirmationPath(token)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${app.getVersion()}\n`, { flag: 'wx' })
  log(`[update] confirmed healthy relaunch version=${app.getVersion()}\n`)
}

export function consumeRollbackState(): RollbackState | null {
  try {
    const path = rollbackPath()
    const value = JSON.parse(readFileSync(path, 'utf8')) as RollbackState
    rmSync(path, { force: true })
    return value
  } catch {
    return null
  }
}

function installerScript(): string {
  return [
    '#!/bin/bash',
    'set -u',
    'APP_PID="$1"; MOUNT="$2"; STAGE="$3"; DEST="$4"; DMG="$5"; PREVIOUS="$6"; CONFIRM="$7"; ROLLBACK="$8"; TOKEN="$9"; VERSION="${10}"',
    `for _ in $(seq 1 ${INSTALLER_EXIT_WAIT_ATTEMPTS}); do kill -0 "$APP_PID" 2>/dev/null || break; sleep ${INSTALLER_EXIT_WAIT_SECONDS}; done`,
    'if kill -0 "$APP_PID" 2>/dev/null; then',
    `  ${MACOS_HDIUTIL} detach "$MOUNT" -force >/dev/null 2>&1 || true`,
    '  rm -rf "$STAGE"; rm -f "$DMG" "$0"',
    '  exit 1',
    'fi',
    'rm -rf "$PREVIOUS"',
    'if ! mv "$DEST" "$PREVIOUS" || ! mv "$STAGE" "$DEST"; then',
    '  [[ -e "$PREVIOUS" && ! -e "$DEST" ]] && mv "$PREVIOUS" "$DEST"',
    '  exit 1',
    'fi',
    '/usr/bin/open -n "$DEST" --args "' + UPDATE_TOKEN_ARGUMENT + '$TOKEN"',
    `for _ in $(seq 1 ${INSTALL_CONFIRM_WAIT_ATTEMPTS}); do [[ -f "$CONFIRM" ]] && break; sleep ${INSTALL_CONFIRM_WAIT_SECONDS}; done`,
    'if [[ -f "$CONFIRM" ]]; then',
    '  rm -rf "$PREVIOUS"; rm -f "$CONFIRM"',
    'else',
    '  FAILED="${DEST}' + INSTALL_FAILED_SUFFIX + '-$TOKEN"',
    '  rm -rf "$FAILED"; mv "$DEST" "$FAILED"; mv "$PREVIOUS" "$DEST"',
    '  mkdir -p "$(dirname "$ROLLBACK")"',
    '  printf \'{"version":"%s","reason":"health confirmation timeout","at":%s}\\n\' "$VERSION" "$(date +%s000)" > "$ROLLBACK"',
    '  /usr/bin/open -n "$DEST"',
    'fi',
    `${MACOS_HDIUTIL} detach "$MOUNT" -force >/dev/null 2>&1 || true`,
    'rm -f "$DMG" "$0"',
    ''
  ].join('\n')
}

async function installDmg(
  dmgPath: string,
  meta: LatestVersionMeta,
  onProgress: (progress: UpdateProgress) => void,
  log: LogSink
): Promise<StartUpdateResult> {
  const config = resolveDesktopConfig(log)
  let mount = ''
  try {
    mount = mountDmg(dmgPath)
    const sourceApp = join(mount, PRODUCT_APPLICATION)
    if (!existsSync(sourceApp)) throw new Error(`DMG does not contain exact ${PRODUCT_APPLICATION}`)
    verifyMountedApplication(sourceApp, meta, config)

    if (process.platform !== MACOS_PLATFORM || !app.isPackaged) {
      return openInstallerFallback(dmgPath, 'automatic replacement is available only to packaged macOS builds', log)
    }
    const destination = currentAppBundlePath()
    if (!destination || !isWritable(dirname(destination)) || !isWritable(destination)) {
      return openInstallerFallback(dmgPath, 'installed application is not writable', log)
    }
    const stage = `${destination}${INSTALL_STAGING_SUFFIX}`
    const previous = `${destination}${INSTALL_PREVIOUS_SUFFIX}`
    rmSync(stage, { recursive: true, force: true })
    onProgress({ phase: 'installing', install_stage: 'copying' })
    requireCommand(MACOS_DITTO, [sourceApp, stage], 'stage application')
    verifyMountedApplication(stage, meta, config)

    const token = randomUUID()
    const confirm = confirmationPath(token)
    const scriptPath = join(updateCacheDir(), `install-${token}.sh`)
    mkdirSync(dirname(confirm), { recursive: true })
    rmSync(confirm, { force: true })
    writeFileSync(scriptPath, installerScript(), { mode: 0o700, flag: 'wx' })
    onProgress({ phase: 'installing', install_stage: 'restarting' })
    const child = spawn('/bin/bash', [
      scriptPath,
      String(process.pid),
      mount,
      stage,
      destination,
      dmgPath,
      previous,
      confirm,
      rollbackPath(),
      token,
      meta.version
    ], { detached: true, stdio: 'ignore' })
    child.unref()
    mount = ''
    return { ok: true, mode: 'auto' }
  } catch (error) {
    return { ok: false, error: String(error) }
  } finally {
    if (mount) runCommand(MACOS_HDIUTIL, ['detach', mount, '-force'])
  }
}

function readyStatePath(): string {
  return join(updateStateDirectory(), READY_STATE_FILE)
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
    if (typeof value.path !== 'string' || !meta || typeof meta.sha512 !== 'string') return null
    if (typeof meta.file_size !== 'number' || meta.file_size <= 0) return null
    if (!existsSync(value.path) || statSync(value.path).size !== meta.file_size) return null
    return value
  } catch {
    return null
  }
}

function writeReadyState(ready: ReadyState): void {
  const path = readyStatePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(ready), 'utf8')
}

export function clearReadyState(): void {
  rmSync(readyStatePath(), { force: true })
}

/**
 * 「发现新版本」弹窗已经被用户收起过的候选身份。
 *
 * 归主进程持有而不是渲染层：渲染层的 origin 含后端随机端口，localStorage 按 origin
 * 分区，写在那里的确认每次启动都读不回来（bug 86968393）。落盘才跨客户端重启有效。
 *
 * 目录可注入，与本文件 `pendingUpdateToken(argv = process.argv)` 同一个写法：生产走
 * 默认值，测试用真实临时目录验落盘与读回。
 */
export function readAnnouncedKey(directory: string = updateStateDirectory()): string | null {
  try {
    const value = JSON.parse(readFileSync(join(directory, ANNOUNCED_STATE_FILE), 'utf8')) as AnnouncedState
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
 * 磁盘上。手动兜底安装（openInstallerFallback）留下的包走的正是这条路 —— 当时不删是因为
 * 用户还要拿它装，装完下次启动就该清掉。
 *
 * 只删文件名符合本模块命名的东西：ready.json 是磁盘上的可变状态，不能拿它当任意路径的
 * 删除授权。
 */
function removeStaleInstaller(path: string, log: LogSink): void {
  if (updateArtifactKind(basename(path)) !== 'payload') return
  rmSync(path, { force: true })
  log(`[update] pruned stale installer ${basename(path)}\n`)
}

/** stageUpdate 的结果：要么停在「已就绪」，要么带着「部分包是否保留」失败。 */
export type StageUpdateResult =
  | { ok: true; ready: ReadyState }
  | { ok: false; error: string; resumable: boolean }

/**
 * 下载并校验安装包，然后停在「已就绪」。
 *
 * 安装是独立的一步、由用户挑时间触发：下载完就自动换掉正在运行的客户端，等于替
 * 用户决定什么时候中断手头的科研工作（PRD 第 7/8 条）。
 */
export async function stageUpdate(
  id: string,
  onProgress: (progress: UpdateProgress) => void,
  log: LogSink
): Promise<StageUpdateResult> {
  let info: DownloadInfo
  try {
    info = await getDownloadInfo(id, log)
  } catch (error) {
    return {
      ok: false,
      error: `${DOWNLOAD_METADATA_FAILED}: ${String(error)}`,
      resumable: false
    }
  }
  const destination = stagedInstallerPath(info)
  pruneUpdateArtifacts(basename(destination), log)
  onProgress({ phase: 'downloading', percent: 0, receivedBytes: 0 })
  try {
    await downloadWithProgress(
      info.download_url,
      destination,
      info.file_size,
      (percent, receivedBytes) => onProgress({ phase: 'downloading', percent, receivedBytes })
    )
    onProgress({ phase: 'verifying' })
    const actual = await sha512OfFile(destination)
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
      resumable: downloadResumable(destination, info.file_size)
    }
  }
  // 签名下载链接是短期的、安装阶段也用不到，不落盘。
  const { download_url: _downloadUrl, ...meta } = info
  const ready: ReadyState = { at: Date.now(), path: destination, meta }
  writeReadyState(ready)
  log(`[update] staged ${meta.version}-${meta.build_number}\n`)
  return { ok: true, ready }
}

/**
 * 安装已暂存的更新包。
 *
 * 重新校验一次 SHA-512：暂存包可能是在上一次客户端运行时下载的，中间磁盘上的文件
 * 可以被任何东西改过，不能因为下载时验过就一路信到安装。
 */
export async function installStagedUpdate(
  onProgress: (progress: UpdateProgress) => void,
  log: LogSink
): Promise<StartUpdateResult> {
  const staged = readReadyState()
  if (!staged) return { ok: false, error: NO_STAGED_UPDATE }
  onProgress({ phase: 'verifying' })
  try {
    const actual = await sha512OfFile(staged.path)
    if (actual.toLowerCase() !== staged.meta.sha512.toLowerCase()) {
      rmSync(staged.path, { force: true })
      clearReadyState()
      throw new Error('staged installer no longer matches its release metadata')
    }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
  onProgress({ phase: 'installing', install_stage: 'preparing' })
  if (process.platform === WINDOWS_PLATFORM) {
    return installWindows(staged.path, staged.meta, log)
  }
  return await installDmg(staged.path, staged.meta, onProgress, log)
}

export function initialUpdateSnapshot(log: LogSink): UpdateSnapshot {
  const rollback = consumeRollbackState()
  if (rollback) {
    return {
      phase: 'rolled-back',
      currentVersion: app.getVersion(),
      rollbackVersion: rollback.version,
      error: rollback.reason,
      errorOrigin: 'install'
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
      log(`[update] dropped stale staged update ${staged.meta.version}-${staged.meta.build_number}\n`)
      clearReadyState()
      removeStaleInstaller(staged.path, log)
    } else {
      return {
        phase: 'ready',
        currentVersion,
        candidate: staged.meta,
        percent: 100,
        receivedBytes: staged.meta.file_size
      }
    }
  }
  return { phase: 'idle', currentVersion }
}
