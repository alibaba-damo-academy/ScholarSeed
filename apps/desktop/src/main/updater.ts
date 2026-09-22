// ScholarSeed desktop update client. The main process is the single state owner;
// release identity comes from the immutable packaged product.json policy.

import { app, shell } from 'electron'
import { spawn } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import {
  accessSync,
  appendFileSync,
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { basename, dirname, join } from 'path'

import {
  AUTHENTICODE_REPORT_KEYS,
  classifyAuthenticodeStatus,
  parseAuthenticodeReport,
  publisherSubjectsMatch
} from './authenticode.ts'
import { desktopHome, LOGS_DIRNAME, resolveProductConfig } from './backend'
import { systemCacheDir } from './cachedir.ts'
import { MACOS_HDIUTIL, mountPointsOfImage, readHdiutilInfoPlist } from './mounts.ts'
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
  UpdateInstallFallback,
  UpdateProgress,
  UpdateSnapshot
} from '../updates.ts'
import { isNewerRelease } from './version.ts'

export type LogSink = (line: string) => void

const UPDATE_CACHE_DIRNAME = 'scholarseed-update'
const UPDATE_STATE_DIRNAME = 'updates'
// 计时/结果日志额外落一份到 $SCHOLARSEED_HOME/logs/update.log（见 persistUpdateLog）。
const UPDATE_LOG_FILE = 'update.log'
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
// 校验脚本把 JSON 报告写进这个 env 指定的文件（而不是 stdout）：stdout 按控制台代码页编码，
// 承载不了证书 DN 里的中文属地属性；文件编码由 `Set-Content -Encoding UTF8` 显式决定。
const WINDOWS_VERIFY_REPORT_ENV = 'SCHOLARSEED_UPDATE_VERIFY_REPORT'
const VERIFY_REPORT_SUFFIX = '.verify.json'
// Status 的三档语义（valid / 确证坏 / 本机不可判定）与发布者 DN 的同发布者判定在
// authenticode.ts：纯判定、可单测。用内置 cmdlet 而非内联 WinVerifyTrust，是因为后者依赖
// Add-Type / [PSCustomObject] / 静态属性赋值，在 PowerShell 受限语言模式下全部被禁（bug 87042987）。
// chcp.com 报的活动控制台代码页 → TextDecoder 标签。中文 Windows 是 936(GBK)；不在表里或探测
// 失败都退回 UTF-8。**这只影响日志/stderr 的可读性**：签名校验的判定输入走 `Set-Content -Encoding
// UTF8` 写出的报告文件（见 authenticode.ts parseAuthenticodeReport），与这里的探测结果无关，探测
// 失败不会再变成一次安全拦截。
const WINDOWS_CODE_PAGE_ENCODINGS: Readonly<Record<string, string>> = {
  '932': 'shift_jis',
  '936': 'gbk',
  '949': 'euc-kr',
  '950': 'big5',
  '1251': 'windows-1251',
  '1252': 'windows-1252',
  '65001': 'utf-8'
}
const FALLBACK_CONSOLE_ENCODING = 'utf-8'
const MACOS_DITTO = '/usr/bin/ditto'
const PRODUCT_APPLICATION = 'ScholarSeed.app'
const INSTALL_STAGING_SUFFIX = '.scholarseed-new'
const INSTALL_PREVIOUS_SUFFIX = '.scholarseed-previous'
const INSTALL_FAILED_SUFFIX = '.scholarseed-failed'
const INSTALLER_EXIT_WAIT_ATTEMPTS = 300
const INSTALLER_EXIT_WAIT_SECONDS = 0.1
const INSTALL_CONFIRM_WAIT_ATTEMPTS = 120
const INSTALL_CONFIRM_WAIT_SECONDS = 0.5
// 同一镜像已经挂着时 hdiutil attach 恒报 resource busy（报错文案还随系统语言本地化，不能
// 拿错误串当判据）：陈旧挂载可能来自崩掉的上一轮、手动安装兜底在 Finder 里留下的卷。attach
// 前按 image-path 清扫是自己的挂载态恢复；重试一次覆盖 detach 尚未落定的瞬态忙。
const DMG_ATTACH_ATTEMPTS = 2
const DMG_ATTACH_RETRY_DELAY_MS = 1500
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

/**
 * 子进程输出该按哪种编码解码（带缓存）。
 *
 * Windows 控制台程序（powershell.exe 等）按 OEM 代码页输出，中文系统是 936(GBK)。Node 一律
 * `toString('utf8')` 会把 GBK 字节解成乱码——更新失败时的 PowerShell 中文报错进日志/弹窗就不可读
 * （bug 87042987）。这里探测一次活动代码页并缓存。`chcp.com` 是原生可执行、不经 PowerShell，
 * 因此不受受限语言模式影响。非 Windows 一律 UTF-8。
 */
let cachedConsoleEncoding: Promise<string> | null = null

function consoleOutputEncoding(): Promise<string> {
  if (process.platform !== WINDOWS_PLATFORM) return Promise.resolve(FALLBACK_CONSOLE_ENCODING)
  if (!cachedConsoleEncoding) cachedConsoleEncoding = detectConsoleEncoding()
  return cachedConsoleEncoding
}

function detectConsoleEncoding(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('chcp.com', [], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('ascii')
    })
    child.on('error', () => resolve(FALLBACK_CONSOLE_ENCODING))
    // chcp 输出形如 "Active code page: 936"（纯 ASCII），取第一个数字查表。
    child.on('close', () => {
      const match = out.match(/\d+/)
      resolve(match ? WINDOWS_CODE_PAGE_ENCODINGS[match[0]] ?? FALLBACK_CONSOLE_ENCODING : FALLBACK_CONSOLE_ENCODING)
    })
  })
}

function decodeConsoleOutput(buffer: Buffer, encoding: string): string {
  try {
    return new TextDecoder(encoding).decode(buffer).trim()
  } catch {
    // 极少数 ICU 不识别的代码页标签退回 UTF-8，至少 ASCII 部分仍可读。
    return buffer.toString('utf8').trim()
  }
}

/**
 * 异步跑一条命令，绝不阻塞主进程事件循环。
 *
 * Electron 主进程与 macOS 的 AppKit 主线程是同一个：任何 spawnSync 都会把整条事件循环冻住，
 * 期间原生窗口控件（红绿灯）收不到点击——macOS 安装链的 ditto 拷贝整包 + codesign --deep /
 * spctl / stapler 校验动辄十几到几十秒，用户就点不动最小化/关闭（本次 bug）。改成异步 spawn 后，
 * 等命令期间事件循环照常转，窗口保持可响应。Windows 侧的签名校验同理由它承载。
 *
 * 输出按 consoleOutputEncoding() 解码、且**收齐字节再整体解码**：逐块 toString 会把跨块的多字节
 * 字符（UTF-8 中文、GBK 双字节）截断成乱码。
 */
function runCommandAsync(
  executable: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; windowsHide?: boolean } = {}
): Promise<AsyncCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, ...options })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    child.on('error', reject)
    child.on('close', (status) => {
      void consoleOutputEncoding().then((encoding) => {
        resolve({
          status,
          stdout: decodeConsoleOutput(Buffer.concat(stdoutChunks), encoding),
          stderr: decodeConsoleOutput(Buffer.concat(stderrChunks), encoding),
          encoding
        })
      })
    })
  })
}

/**
 * requireCommand 的异步版：非 0 退出抛错（fail-closed 语义不变），返回 stdout+stderr 合并文本 ——
 * 与旧同步版逐字一致，因为 codesign -d 把元数据写到 stderr、plutil 写到 stdout，调用方依赖合并结果。
 */
async function requireCommandAsync(
  executable: string,
  args: string[],
  label: string
): Promise<string> {
  const result = await runCommandAsync(executable, args)
  const output = `${result.stdout}\n${result.stderr}`.trim()
  if (result.status !== 0) throw new Error(`${label} failed: ${output}`)
  return output
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
function persistUpdateLog(line: string): void {
  try {
    const directory = join(desktopHome(), LOGS_DIRNAME)
    mkdirSync(directory, { recursive: true })
    appendFileSync(join(directory, UPDATE_LOG_FILE), line)
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

interface AsyncCommandResult {
  status: number | null
  stdout: string
  stderr: string
  /** 实际用来解码 stdout/stderr 的编码标签。落日志用：探测静默回退时这是唯一的现场证据。 */
  encoding: string
}

/** 签名校验失败的类别，决定 installWindows 回报哪种 errorFallback（见 updates.ts）。 */
type WindowsVerifyFailure =
  | 'verify-env-unavailable'
  | 'signature-untrusted'
  | 'signature-indeterminate'
  | 'publisher-mismatch'

/**
 * 带类别的校验失败。installWindows 据此把「校验环境不可用」与「签名不可信」分开上报；原始诊断
 * （可能含代码页乱码的 PowerShell stderr）只落 update.log，不进用户文案。
 */
class WindowsVerifyError extends Error {
  constructor(message: string, readonly kind: WindowsVerifyFailure) {
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
 * 任一步不通过都抛 WindowsVerifyError（fail-closed），绝不放行未验证的包。
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
        [WINDOWS_VERIFY_REPORT_ENV]: reportPath
      },
      windowsHide: true
    }
  )
  // stdout 只作诊断，绝不参与判定。
  const report = parseAuthenticodeReport(readVerifyReport(reportPath))
  // 两类情况都归「校验**没能执行**」而不是「签名不可信」：命令没跑成（PowerShell 缺失/被策略
  // 拦截/非零退出），或跑成了但报告读不到、不满足 JSON 契约、或仍带着 U+FFFD 编码降级指纹。
  // 传输/解码降级绝不能变成一次发布者不符的安全拦截（bug 87108457）。原始输出与实际选用的解码
  // 编码一并落盘供定位，界面给手动安装引导（见 windowsInstallFallback）。
  if (result.status !== 0 || report === null) {
    persistUpdateLog(
      result.status === 0
        ? `[update] Windows verification report is unusable: path=${reportPath} stdoutEncoding=${result.encoding} stdout=${result.stdout}\n`
        : `[update] Windows verification command failed: exit=${result.status} stdoutEncoding=${result.encoding} stderr=${result.stderr} stdout=${result.stdout}\n`
    )
    throw new WindowsVerifyError(
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
      throw new WindowsVerifyError(
        `Windows installer signature trust could not be determined on this machine: ${status}`,
        'signature-indeterminate'
      )
    }
    persistUpdateLog(`[update] Windows installer signature not trusted: status=${status}\n`)
    throw new WindowsVerifyError(
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
    throw new WindowsVerifyError(
      'Windows installer signature differs from packaged product policy',
      'publisher-mismatch'
    )
  }
}

/** 把校验/安装异常映射成结构化 errorFallback；原始文本只落日志，不进用户文案。 */
function windowsInstallFallback(error: unknown): UpdateInstallFallback {
  if (error instanceof WindowsVerifyError) {
    if (error.kind === 'verify-env-unavailable') return 'install_verify_unavailable'
    if (error.kind === 'signature-indeterminate') return 'install_signature_indeterminate'
    return 'install_signature_untrusted'
  }
  return 'install_failed'
}

export async function installWindows(
  installer: string,
  meta: LatestVersionMeta,
  log: LogSink
): Promise<StartUpdateResult> {
  try {
    if (!app.isPackaged) {
      throw new Error('automatic Windows update requires an installed packaged application')
    }
    const config = resolveDesktopConfig(log)
    await verifyWindowsInstaller(installer, config.expectedWindowsPublisher, log)
    const child = spawn(installer, WINDOWS_UPDATE_ARGUMENTS, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.unref()
    if (!child.pid) throw new Error('Windows installer did not start')
    const started = `[update] started verified Windows installer version=${meta.version}\n`
    log(started)
    persistUpdateLog(started)
    return { ok: true, mode: 'auto' }
  } catch (error) {
    // 原始诊断（含可能的代码页乱码 stderr）只落 update.log；回报结构化分类，界面给本地化文案。
    persistUpdateLog(`[update] Windows install failed: ${String(error)}\n`)
    return { ok: false, errorFallback: windowsInstallFallback(error) }
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
async function detachStaleMountsOf(dmgPath: string, log: LogSink): Promise<void> {
  let points: string[]
  try {
    const info = await readHdiutilInfoPlist()
    points = mountPointsOfImage(info, [dmgPath, realpathOrSelf(dmgPath)])
  } catch (error) {
    log(`[update] stale mount probe skipped: ${String(error)}\n`)
    return
  }
  for (const point of points) {
    const line = `[update] detaching stale mount ${point} of staged installer\n`
    log(line)
    persistUpdateLog(line)
    const result = await runCommandAsync(MACOS_HDIUTIL, ['detach', point, '-force'])
    if (result.status !== 0) {
      log(`[update] stale mount detach failed ${point}: ${result.stderr || result.stdout}\n`)
    }
  }
}

async function mountDmg(dmgPath: string, log: LogSink): Promise<string> {
  await requireCommandAsync(MACOS_HDIUTIL, ['verify', dmgPath], 'DMG verification')
  const mount = join(updateCacheDir(), `mount-${randomUUID()}`)
  mkdirSync(mount, { recursive: true })
  const attachArgs = [
    'attach',
    '-readonly',
    '-nobrowse',
    '-noautoopen',
    '-mountpoint',
    mount,
    dmgPath
  ]
  let lastError: unknown = null
  for (let attempt = 1; attempt <= DMG_ATTACH_ATTEMPTS; attempt++) {
    if (attempt > 1) await delayMs(DMG_ATTACH_RETRY_DELAY_MS)
    await detachStaleMountsOf(dmgPath, log)
    try {
      await requireCommandAsync(MACOS_HDIUTIL, attachArgs, 'DMG attach')
      return mount
    } catch (error) {
      lastError = error
      persistUpdateLog(`[update] DMG attach attempt ${attempt} failed: ${String(error)}\n`)
    }
  }
  throw lastError
}

async function plistValue(appPath: string, field: string): Promise<string> {
  return await requireCommandAsync(
    '/usr/bin/plutil',
    ['-extract', field, 'raw', join(appPath, 'Contents/Info.plist')],
    `read ${field}`
  )
}

async function signedTeamId(appPath: string): Promise<string> {
  const output = await requireCommandAsync('codesign', ['-d', '--verbose=4', appPath], 'codesign metadata')
  const match = output.match(/^TeamIdentifier=(.+)$/m)
  return match ? match[1].trim() : ''
}

async function verifyMountedApplication(
  appPath: string,
  meta: LatestVersionMeta,
  config: DesktopUpdateConfig
): Promise<void> {
  // 每一步都 await：校验命令非 0 退出会抛错、在安装推进前中断（fail-closed）。漏掉任何一个
  // await 都会让 codesign/spctl/stapler 变成后台即发即忘、安装先于校验完成 —— 那是安全洞。
  if ((await plistValue(appPath, 'CFBundleIdentifier')) !== config.bundleId) {
    throw new Error('downloaded app Bundle ID differs from packaged product policy')
  }
  if ((await plistValue(appPath, 'CFBundleShortVersionString')) !== meta.version) {
    throw new Error('downloaded app version differs from release metadata')
  }
  const executable = await plistValue(appPath, 'CFBundleExecutable')
  const architectures = (
    await requireCommandAsync(
      '/usr/bin/lipo',
      ['-archs', join(appPath, 'Contents/MacOS', executable)],
      'application architecture check'
    )
  ).split(/\s+/)
  const expectedArch = meta.arch_type === MACOS_ARM64_ARCH_TYPE ? MACOS_ARM64 : MACOS_X86_64
  if (!architectures.includes(expectedArch)) throw new Error('downloaded app architecture is incompatible')
  await requireCommandAsync('codesign', ['--verify', '--deep', '--strict', appPath], 'application signature')
  await requireCommandAsync('spctl', ['--assess', '--type', 'execute', appPath], 'Gatekeeper assessment')
  await requireCommandAsync('xcrun', ['stapler', 'validate', appPath], 'notarization ticket')
  if ((await signedTeamId(appPath)) !== config.expectedTeamId || meta.team_id !== config.expectedTeamId) {
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
    mount = await mountDmg(dmgPath, log)
    const sourceApp = join(mount, PRODUCT_APPLICATION)
    if (!existsSync(sourceApp)) throw new Error(`DMG does not contain exact ${PRODUCT_APPLICATION}`)
    await verifyMountedApplication(sourceApp, meta, config)

    if (process.platform !== MACOS_PLATFORM || !app.isPackaged) {
      return await openInstallerFallback(dmgPath, 'automatic replacement is available only to packaged macOS builds', log)
    }
    const destination = currentAppBundlePath()
    if (!destination || !isWritable(dirname(destination)) || !isWritable(destination)) {
      return await openInstallerFallback(dmgPath, 'installed application is not writable', log)
    }
    const stage = `${destination}${INSTALL_STAGING_SUFFIX}`
    const previous = `${destination}${INSTALL_PREVIOUS_SUFFIX}`
    rmSync(stage, { recursive: true, force: true })
    onProgress({ phase: 'installing', install_stage: 'copying' })
    await requireCommandAsync(MACOS_DITTO, [sourceApp, stage], 'stage application')
    await verifyMountedApplication(stage, meta, config)

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
    // 卸载挂载点：best-effort，失败不该把一次安装判成失败；异步化以免再冻主线程。
    if (mount) await runCommandAsync(MACOS_HDIUTIL, ['detach', mount, '-force']).catch(() => {})
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
export function supersedeStagedUpdate(
  candidate: LatestVersionMeta | null,
  log: LogSink
): boolean {
  if (!candidate) return false
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
    const downloadStartedAt = Date.now()
    await downloadWithProgress(
      info.download_url,
      destination,
      info.file_size,
      (percent, receivedBytes) => onProgress({ phase: 'downloading', percent, receivedBytes })
    )
    logTiming(log, `downloaded installer (${info.file_size} bytes)`, downloadStartedAt)
    onProgress({ phase: 'verifying' })
    const verifyStartedAt = Date.now()
    const actual = await sha512OfFile(destination)
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
    const startedAt = Date.now()
    const actual = await sha512OfFile(staged.path)
    logTiming(log, `staged installer SHA-512 re-verify (${staged.meta.file_size} bytes)`, startedAt)
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
    return await installWindows(staged.path, staged.meta, log)
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
      dropStagedUpdate(staged, log)
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
