import { captureSourceBaseline, SOURCE_BASELINE_ENV } from './source.ts'
import { applicationResources } from './resources.ts'
import {
  drainProcessFamily,
  WINDOWS_BACKEND_BOOTSTRAP,
  FAMILY_START_BYTE,
  type ProcessFamily,
  type FamilyNative,
} from './family.ts'
import { desktopDirectoryMaintenance, desktopDirectoryWriter } from './writer'
import { BackendControl } from './backend-control.ts'
// backend.ts — spawn + supervise the Python agent backend (`service.cli.serve`).
//
// Single-launch full-stack: the Electron main process owns the FastAPI/uvicorn
// backend as a child process. We pick a free localhost port, spawn `scholarseed serve`
// (account auth in the packaged product, auth-off in dev), and wait for /api/healthz before
// showing the window.
// In a packaged .app the python env + repo live under Resources/backend; in dev
// we use the repo's own .venv. Everything stays on 127.0.0.1 (never exposed).

import { createHash, randomBytes, randomUUID } from 'crypto'
import type { ChildProcess } from 'child_process'
import { spawn } from 'child_process'
import { createServer } from 'net'
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve, toNamespacedPath } from 'path'
import { app } from 'electron'
import {
  TOOL_RESOURCES_ENV,
  TOOL_RESOURCES_REQUIRED_ENV,
  TOOL_PRINCIPAL_ENV,
  bundledToolResources,
} from './toolchain.ts'
import { browserEnvironment } from '../../runtime/browser.cjs'
import {
  inspectPythonAsync,
  verifyDevelopmentPythonAsync,
} from '../../../../scripts/shared/python.cjs'

import type { AuthMode, DesktopProductConfig } from './product'
import {
  parseDesktopProductConfig,
  BrowserFeatureReadinessError,
  validateBrowserFeatureReadiness,
  PRODUCT_CONFIG_FILE,
  resolveAccountBaseUrl,
  SECURE_PACKAGED_FALLBACK,
} from './product'
import {
  captureSeedSource,
  captureEnvironment,
  mergeExecutablePaths,
  pythonExecutableDirectories,
  standardExecutablePath,
} from './environment'
import { LineTimestamper, RotatingFileLog } from './logfile'
import type { BackendFailure } from './failure'
import { redactDiagnosticError } from './redaction.ts'
import { projectCodexRuntimeEnvironment } from './runtime'
import { bundledCodex, CACHE_VALIDATION, resolveVendoredCodex } from '../../runtime/codex.cjs'
import {
  PYLIBS_DIRNAME,
  bundledWindowsRuntime,
  readRuntimeManifest,
  runtimeStoreRoot as computeRuntimeStoreRoot,
} from '../../runtime/components.cjs'
import {
  SCHOLARSEED_HOME_ENV,
  SCHOLARSEED_DEFAULT_WORKSPACE_ENV,
  desktopStorage,
  desktopHome,
} from './storage'
import {
  pythonExecutablePath,
  skillPythonLauncherPath,
  writeSkillPythonLauncher,
} from '../../runtime/python.cjs'
import {
  bundledTexlive,
  resolveVendoredTexlive,
  vendoredTexliveLocation,
  texliveStateRoot,
  reviewedTexliveVersion,
  reviewedTexliveArchive,
  prepareTexliveEnvironment,
  rebuildTexliveEnvironment,
  texliveEnvironmentCurrent,
  type TexliveEnvironmentOptions,
  texliveExecutionResources,
} from '../../runtime/texlive.cjs'
import { isFirstRun, resolveStartupBudgetMs, writeStartupMarker } from './startupmarker'
import { clientVersion } from './version'
import { createAgentTransport, type AgentTransport } from './agenttransport'
import type { StorageLaunchProjection } from './vaultstorage'
import { stopChildProcess } from './subprocess'
import type { StorageSelection } from './storage'
import type { SeedSource } from './environment'
import { observeStorageBindings } from './storagebinding'
import type { StorageBinding, StorageBindingNative } from './storagebinding'

const SKILL_PYTHON_PROBE_MODULE = 'service.platform.executables'
// Includes cold admission of the probe interpreter plus Serve's 60s launcher
// budget (service.platform.executables); cancellation still stops the family.
const SKILL_PYTHON_PROBE_TIMEOUT_MS = 90_000
const SKILL_PYTHON_DIAGNOSTIC_BYTES = 8_192
const SKILL_PYTHON_DIAGNOSTIC_PREFIX = 'scholarseed-skill-probe-'
const SKILL_PYTHON_DIAGNOSTIC_FILE = 'stderr.log'
const SKILL_PYTHON_DIAGNOSTIC_MODE = 0o600
const BACKEND_STARTUP_DIAGNOSTIC = '[backend-startup]'
const BACKEND_STARTUP_PHASE = Object.freeze({
  port: 'port',
  paths: 'paths',
  source: 'source',
  pythonEntry: 'python-entry',
  runtimeEntries: 'runtime-entries',
  toolchain: 'toolchain-resources',
  pythonIdentity: 'python-identity',
  skillLauncher: 'skill-launcher',
  workspace: 'workspace',
  environment: 'environment',
  log: 'backend-log',
  agent: 'agent-transport',
  browser: 'browser-environment',
  texlive: 'texlive-environment',
  control: 'control-listen',
  spawn: 'spawn',
  health: 'health',
})

function openProcessFamily(pid: number): ProcessFamily {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Packaged native primitive.
  return (require('./lease.node') as FamilyNative).openFamily(pid)
}

export function probeSkillPython(
  python: string,
  directory: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  log: LogSink = () => {}
): Promise<boolean> {
  const started = Date.now()
  const report = (event: string, detail: Record<string, unknown> = {}): void => {
    log(`[shell] Skill Python probe ${JSON.stringify({ event, ...detail })}\n`)
  }
  const reportError = (event: string, error: unknown): void => {
    const detail = error as (NodeJS.ErrnoException & { systemCode?: number }) | null
    report(event, {
      error: String(error).slice(-SKILL_PYTHON_DIAGNOSTIC_BYTES),
      errorCode: detail?.code,
      systemCode: detail?.systemCode,
      errno: detail?.errno,
      syscall: detail?.syscall,
    })
  }
  if (signal.aborted) {
    report('cancelled-before-spawn')
    return Promise.resolve(false)
  }
  return new Promise((resolve, reject) => {
    let diagnosticDirectory: string | undefined
    let diagnosticDescriptor: number | undefined
    const finishDiagnostics = (): void => {
      if (diagnosticDescriptor !== undefined) {
        try {
          const size = fstatSync(diagnosticDescriptor).size
          const buffer = Buffer.alloc(Math.min(size, SKILL_PYTHON_DIAGNOSTIC_BYTES))
          const read = readSync(
            diagnosticDescriptor,
            buffer,
            0,
            buffer.length,
            Math.max(0, size - buffer.length)
          )
          report('stderr', {
            stderr: buffer.subarray(0, read).toString('utf8'),
            stderrBytes: size,
            stderrTruncated: size > buffer.length,
          })
        } catch (error) {
          reportError('diagnostic-read-error', error)
        } finally {
          try {
            closeSync(diagnosticDescriptor)
          } catch (error) {
            reportError('diagnostic-close-error', error)
          }
          diagnosticDescriptor = undefined
        }
      }
      if (diagnosticDirectory !== undefined) {
        try {
          rmSync(diagnosticDirectory, { recursive: true, force: true })
        } catch (error) {
          reportError('diagnostic-cleanup-error', error)
        }
        diagnosticDirectory = undefined
      }
    }
    try {
      diagnosticDirectory = mkdtempSync(join(tmpdir(), SKILL_PYTHON_DIAGNOSTIC_PREFIX))
      diagnosticDescriptor = openSync(
        join(diagnosticDirectory, SKILL_PYTHON_DIAGNOSTIC_FILE),
        'wx+',
        SKILL_PYTHON_DIAGNOSTIC_MODE
      )
    } catch (error) {
      reportError('diagnostic-capture-error', error)
      finishDiagnostics()
    }
    const windows = process.platform === 'win32'
    const args = windows
      ? ['-c', WINDOWS_BACKEND_BOOTSTRAP, SKILL_PYTHON_PROBE_MODULE, directory]
      : ['-m', SKILL_PYTHON_PROBE_MODULE, directory]
    report('started', {
      python: pythonExecutablePath(python),
      directory,
      cwd,
      timeoutMs: SKILL_PYTHON_PROBE_TIMEOUT_MS,
    })
    let probe: ChildProcess
    try {
      probe = spawn(pythonExecutablePath(python), args, {
        cwd,
        env,
        windowsHide: true,
        detached: !windows,
        stdio: ['pipe', 'ignore', diagnosticDescriptor ?? 'ignore'],
      })
    } catch (error) {
      reportError('spawn-error', error)
      finishDiagnostics()
      reject(error)
      return
    }
    report('spawn-returned', { pid: probe.pid })
    probe.once('spawn', () => report('spawned', { pid: probe.pid }))
    let family: ProcessFamily | null = null
    let failed = false
    let cleanupError: unknown = null
    const stop = (): void => {
      failed = true
      try {
        if (family) family.terminate()
        else if (probe.pid !== undefined) {
          if (windows) probe.kill('SIGKILL')
          else process.kill(-probe.pid, 'SIGKILL')
        }
      } catch (error) {
        reportError('termination-error', error)
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupError = error
        probe.kill('SIGKILL')
      }
    }
    const timer = setTimeout(() => {
      report('timed-out', { elapsedMs: Date.now() - started })
      stop()
    }, SKILL_PYTHON_PROBE_TIMEOUT_MS)
    const abort = (): void => {
      report('cancelled', { elapsedMs: Date.now() - started })
      stop()
    }
    signal.addEventListener('abort', abort, { once: true })
    probe.stdin!.on('error', (error) => {
      reportError('stdin-error', error)
      stop()
    })
    probe.once('error', (error) => {
      reportError('spawn-error', error)
      failed = true
    })
    probe.once('close', (code, exitSignal) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      report('exited', { code, signal: exitSignal, elapsedMs: Date.now() - started })
      const drained = family ? drainProcessFamily(family) : Promise.resolve(true)
      void drained.then(
        (clean) => {
          finishDiagnostics()
          const ready = !failed && code === 0 && clean
          report('finished', {
            ready,
            code,
            signal: exitSignal,
            familyClean: clean,
            elapsedMs: Date.now() - started,
          })
          if (cleanupError) reject(cleanupError)
          else resolve(ready)
        },
        (error: unknown) => {
          reportError('family-drain-error', error)
          finishDiagnostics()
          reject(error)
        }
      )
    })
    if (windows && probe.pid !== undefined) {
      try {
        family = openProcessFamily(probe.pid)
        report('family-attached', { pid: probe.pid })
        probe.stdin!.end(FAMILY_START_BYTE)
      } catch (error) {
        reportError('family-attach-error', error)
        stop()
        probe.stdin!.destroy()
      }
    } else probe.stdin!.end()
  })
}

export interface BackendLaunch {
  readonly storage: Readonly<StorageSelection>
  readonly bindings: readonly StorageBinding[] | null
  readonly cwd: string
  readonly seed: Readonly<SeedSource>
  readonly environment: Readonly<Record<string, string>>
}

// Environment can contain credentials. Keep it out of enumerable handles and diagnostics.
const backendFamilies = new WeakMap<BackendHandle, ProcessFamily>()
const backendLaunches = new WeakMap<ChildProcess, Readonly<BackendLaunch>>()
const backendDiagnosticWriters = new WeakMap<BackendHandle, (line: string) => boolean>()
let activeBackendLaunch: Readonly<BackendLaunch> | null = null
/** Exact spawned child only; this observation grants no data or activation authority. */
export function backendLaunch(handle: BackendHandle): Readonly<BackendLaunch> | null {
  return handle.proc ? (backendLaunches.get(handle.proc) ?? null) : null
}

export function writeBackendDiagnostic(handle: BackendHandle | null, line: string): boolean {
  return handle ? (backendDiagnosticWriters.get(handle)?.(line) ?? false) : false
}

export interface BackendHandle {
  python: string | null
  port: number
  baseUrl: string
  proc: ChildProcess | null
  ready: Promise<boolean>
  exited: Promise<BackendExit>
  error: BackendFailure | null
  stopping: boolean
  agentTransport: AgentTransport | null
  storageLaunch: StorageLaunchProjection | null
}

export type LogSink = (line: string) => void

export interface BackendStartOptions {
  toolPrincipal?: string
  accountBaseUrl?: string
  port?: number
  testHarness?: boolean
  /**
   * 启动诊断的持久化 sink（主进程注入 window.log）。pushLog 只进 stdout/渲染层 IPC，
   * 打包版无控制台即全丢 —— 真机 healthTimeout 只剩一行失败记录的根因。
   */
  lifecycleLog?: LogSink
  browserList?: () => unknown
  browserListAuthority?: () => number | null
  browserPrepareRead?: NonNullable<Parameters<typeof createAgentTransport>[1]>
  browserReadActions?: NonNullable<Parameters<typeof createAgentTransport>[2]>
  browserNavigateActions?: NonNullable<Parameters<typeof createAgentTransport>[4]>
  browserActionActions?: NonNullable<Parameters<typeof createAgentTransport>[5]>
  browserHistoryActions?: NonNullable<Parameters<typeof createAgentTransport>[6]>
  browserSearchAction?: NonNullable<Parameters<typeof createAgentTransport>[7]>
}

function pickPort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', rej)
    srv.listen(0, LOOPBACK_HOST, () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => res(port))
    })
  })
}

interface BackendPaths {
  python: string
  cwd: string
  hookBin: string | null
  skillBin: string
  toolResources?: string
  windowsRuntime?: ReturnType<typeof bundledWindowsRuntime>
}

// Prototype fallback for the packaged app on the build machine: if no relocatable
// python env is bundled under Resources/backend, boot from the dev repo + .venv.
// Production cross-machine distribution bundles a slim python-build-standalone env
// (fastapi/uvicorn/anthropic/httpx) into Resources/backend — set SCHOLARSEED_PYTHON/SCHOLARSEED_REPO
// to override either way.
const REPO_FALLBACK = resolve(app.getAppPath(), '..', '..')
const LOOPBACK_HOST = '127.0.0.1'
const CONFIG_FILE = 'config.json'
const CONFIG_RESOURCE_DIR = 'defaults'
// Product state belongs to Serve; Runtime contracts do not resolve user paths.
// home 名/env/默认工作区名由 ./storage 单一持有（proposal 112），此处不再重复定义。
// 统一家目录切换前, 打包版桌面端把状态落在 Electron userData/.veda; 迁移逻辑据此定位旧根。
const SCHOLARSEED_PROJECT_DIRNAME = '.scholarseed'
const SCHOLARSEED_PROJECT_DIRNAME_ENV = 'SCHOLARSEED_PROJECT_DIRNAME'
const SANDBOX_RECOVERY_HELPER_ENV = 'SCHOLARSEED_SANDBOX_RECOVERY_HELPER'
const SANDBOX_RECOVERY_HELPER_PARTS = ['handoff', 'handoff.exe']
const SCHOLARSEED_CONFIG_SEED_ENV = 'SCHOLARSEED_CONFIG_SEED_PATH'
const SCHOLARSEED_PRODUCT_MANIFEST_ENV = 'SCHOLARSEED_PRODUCT_MANIFEST'
const SCHOLARSEED_DESKTOP_ENV = 'SCHOLARSEED_DESKTOP'
const SCHOLARSEED_APP_VERSION_ENV = 'SCHOLARSEED_APP_VERSION'
const SCHOLARSEED_LOG_LEVEL_ENV = 'SCHOLARSEED_LOG_LEVEL'
const DESKTOP_DEFAULT_LOG_LEVEL = 'debug'
const QUIET_DESKTOP_POLL_ACCESS_FLAG = '--quiet-desktop-poll-access'
// /api/healthz includes the Codex version and login preflight. Each vendor command has a
// 10-second budget and the two commands run sequentially, so a desktop probe must outlive
// that readiness contract. A shorter HTTP timeout repeatedly cancels a healthy cold start.
const HEALTH_PROBE_TIMEOUT_MS = 25_000
const BACKEND_HEALTH_PATH = '/api/healthz/backend'
const RUNTIME_HEALTH_PATH = '/api/healthz'
// 后端在 spawn 后约 2 秒才开始监听, 所以第一次探活必然被 ECONNREFUSED 立即拒绝。
// 固定长间隔会把这次必然失败变成一整段白等 —— 用短起点 + 退避封顶: 就绪瞬间就能被
// 抓到, 长时间没起来时也不会一直高频重试。
const HEALTH_PROBE_INITIAL_INTERVAL_MS = 150
const HEALTH_PROBE_MAX_INTERVAL_MS = 1_000
const HEALTH_PROBE_BACKOFF_FACTOR = 2
const SHUTDOWN_SECONDS = 30
const SHUTDOWN_FINALIZATION_MS = 5_000
const SHUTDOWN_DEADLINE_MS = SHUTDOWN_SECONDS * 1_000 + SHUTDOWN_FINALIZATION_MS
const BACKEND_STARTUP_DIAGNOSTIC_CHARS = 1200
const BACKEND_LOG_FILE = 'backend.log'
// 后端日志必须落在产品家目录的 logs/ 下, 而不是 Electron 的 app.getPath('logs')
// (macOS 上是 ~/Library/Logs/<appName>/)。后者在 SCHOLARSEED_HOME 之外, 问题反馈的
// 日志打包只遍历家目录, 收不到它 —— 而它恰好是唯一一份实时后端日志。
// 导出给主进程其它模块（如 updater 的 update.log）复用同一个 logs/ 目录约定。
export const LOGS_DIRNAME = 'logs'
const BACKEND_DIR = 'backend'
const HOOK_BIN_DIR = 'bin'
const DEV_SKILL_BIN_DIRECTORY = ['tmp', 'desktop-backend', 'bin'] as const
const NODE_SHIM = process.platform === 'win32' ? 'node.cmd' : 'node'
const SCHOLARSEED_CODEX_EXECUTABLE_ENV = 'SCHOLARSEED_CODEX_EXECUTABLE'
const SCHOLARSEED_PYTHON_ENV = 'SCHOLARSEED_PYTHON'
const PYTHON_DONT_WRITE_BYTECODE_ENV = 'PYTHONDONTWRITEBYTECODE'
const PATH_ENV = 'PATH'
const PYTHONPATH_ENV = 'PYTHONPATH'
const ELECTRON_EXECUTABLE_ENV = 'SCHOLARSEED_ELECTRON_EXECUTABLE'
// Absolute path to the packaged product-shell directory (backend/bin/). serve
// composition_ prefers this over PATH scanning when spawning subprocess
// scopes that need to call `scholarseed-bridge`.
const SCHOLARSEED_BRIDGE_DIR_ENV = 'SCHOLARSEED_BRIDGE_DIR'
/**
 * 主进程独有的密钥（proposal 47 §6.6）。
 *
 * 「令牌换绝对路径」这一步只能由主进程做：渲染层只持有一次性删除令牌，绝对路径
 * 不经过它。密钥每次启动重新生成、只进 serve 子进程的 env，**不**经 preload 暴露
 * 给渲染层——暴露了就等于任何拿到令牌的本机进程都能换到用户文件的真实路径。
 */
const SCHOLARSEED_HOST_PROCESS_KEY_ENV = 'SCHOLARSEED_HOST_PROCESS_KEY'
const SCHOLARSEED_AGENT_BROWSER_PORT_ENV = 'SCHOLARSEED_AGENT_BROWSER_PORT'
const SCHOLARSEED_AGENT_BROWSER_KEY_ENV = 'SCHOLARSEED_AGENT_BROWSER_KEY'
const WINDOWS_PYTHON = ['python', 'python.exe'] as const
const WINDOWS_TEXLIVE_ENTRY = 'xelatex.exe'
const POSIX_PYTHON = ['python', 'bin', 'python3'] as const
const WINDOWS_VENV_PYTHON = ['.venv', 'Scripts', 'python.exe'] as const
const POSIX_VENV_PYTHON = ['.venv', 'bin', 'python'] as const
/** 兑换删除令牌时带的请求头（与后端 content 路由同名常量对齐）。 */
export const HOST_PROCESS_HEADER = 'X-ScholarSeed-Host-Key'
const hostProcessKey = randomBytes(24).toString('hex')

/** 主进程用于兑换删除令牌的密钥。只在主进程内使用。 */
export function backendHostProcessKey(): string {
  return hostProcessKey
}
// 托管账号服务地址 (serve 侧 service/identity/service/account.py 读同名变量)。子进程
// 通过 { ...process.env } 继承, 这里只用来在启动报告里把它显式说出来 —— 缺了它的表现
// 是「登录成功后立刻 401」, 不值得靠猜。
const SCHOLARSEED_ACCOUNT_BASE_URL_ENV = 'SCHOLARSEED_ACCOUNT_BASE_URL'

export function resolveStartupAccountBase(log: LogSink): string {
  return resolveAccountBaseUrl(
    process.env[SCHOLARSEED_ACCOUNT_BASE_URL_ENV] || '',
    resolveProductConfig(log).accountBaseUrl
  )
}
// 桌面产品线收敛（2026-09-09 定案）：未登录可用是产品默认，serve 恒以 off 拉起；
// 登录是可选增强（有 account_base_url 即可浏览器回跳登录）。serve 的启动期 auth-mode
// Runtime mode switching belongs to standalone deployments, not Desktop.
const DESKTOP_BACKEND_AUTH_MODE: AuthMode = 'off'
// 桌面端是单机产品: 本机会话与项目在各登录账号之间互通, 所以固定传 machine。serve 的
// 默认值是按账号隔离 —— 那是留给对外部署的, 桌面语义必须显式声明, 不能靠默认值。
const DESKTOP_OWNERSHIP_AXIS = 'machine'

export interface BackendExit {
  code: number | null
  signal: NodeJS.Signals | null
}

async function resolveBackendPaths(): Promise<BackendPaths> {
  const bundledPython = process.platform === 'win32' ? WINDOWS_PYTHON : POSIX_PYTHON
  const venvPython = process.platform === 'win32' ? WINDOWS_VENV_PYTHON : POSIX_VENV_PYTHON
  if (app.isPackaged) {
    // Bundled relocatable Python lives under resources/backend/python.
    // The scholarseed package is pip-installed into it, so cwd can be the bundle dir.
    const bundled = join(applicationResources(app), BACKEND_DIR)
    const bundledPy = join(bundled, ...bundledPython)
    const hookBin = join(bundled, HOOK_BIN_DIR)
    const bundledNode = join(hookBin, NODE_SHIM)
    if (process.platform === 'win32') {
      const windowsRuntime = bundledWindowsRuntime(dirname(applicationResources(app)))
      const python = process.env[SCHOLARSEED_PYTHON_ENV] || windowsRuntime.python
      return {
        python,
        cwd: process.env.SCHOLARSEED_REPO || bundled,
        hookBin: existsSync(bundledNode) ? hookBin : null,
        skillBin: hookBin,
        windowsRuntime,
        toolResources:
          !process.env[SCHOLARSEED_PYTHON_ENV] && !process.env.SCHOLARSEED_REPO
            ? bundledToolResources(
                process.platform,
                hookBin,
                python,
                join(bundled, PYLIBS_DIRNAME),
                windowsRuntime
              )
            : undefined,
      }
    }
    const hasBundled = existsSync(bundledPy)
    return {
      python:
        process.env[SCHOLARSEED_PYTHON_ENV] ||
        (hasBundled ? bundledPy : join(REPO_FALLBACK, ...venvPython)),
      cwd: process.env.SCHOLARSEED_REPO || (hasBundled ? bundled : REPO_FALLBACK),
      hookBin: existsSync(bundledNode) ? hookBin : null,
      skillBin: hookBin,
      toolResources:
        hasBundled && !process.env[SCHOLARSEED_PYTHON_ENV] && !process.env.SCHOLARSEED_REPO
          ? bundledToolResources(process.platform, hookBin, bundledPy)
          : undefined,
    }
  }
  // dev: app path is apps/desktop → repo root is two levels up
  const repoRoot = process.env.SCHOLARSEED_REPO || resolve(app.getAppPath(), '..', '..')
  return {
    python: process.env[SCHOLARSEED_PYTHON_ENV] || join(repoRoot, ...venvPython),
    cwd: repoRoot,
    hookBin: null,
    skillBin: join(repoRoot, ...DEV_SKILL_BIN_DIRECTORY),
  }
}

interface ResolvedProductConfig {
  config: DesktopProductConfig
  source: string | null
}

let startupProductConfig: ResolvedProductConfig | null = null

function readProductConfig(log: LogSink): ResolvedProductConfig {
  if (!startupProductConfig) {
    const resolved = loadProductConfig(log)
    startupProductConfig = Object.freeze({
      ...resolved,
      config: Object.freeze({
        ...resolved.config,
        features: Object.freeze({ ...resolved.config.features }),
      }),
    })
  }
  return startupProductConfig
}

function loadProductConfig(log: LogSink): ResolvedProductConfig {
  const candidates = app.isPackaged
    ? [join(applicationResources(app), PRODUCT_CONFIG_FILE)]
    : [
        join(app.getAppPath(), 'resources', PRODUCT_CONFIG_FILE),
        join(REPO_FALLBACK, 'apps', 'desktop', 'resources', PRODUCT_CONFIG_FILE),
      ]
  const source = candidates.find((candidate) => existsSync(candidate))
  if (!source) {
    log(
      `[shell] ERROR desktop product config missing: ${candidates.join(', ')}; authentication fails closed\n`
    )
    return { config: SECURE_PACKAGED_FALLBACK, source: null }
  }
  try {
    const raw = JSON.parse(readFileSync(source, 'utf-8')) as unknown
    return { config: parseDesktopProductConfig(raw), source }
  } catch (error) {
    log(
      `[shell] ERROR invalid desktop product config: ${String(error)}; authentication fails closed\n`
    )
    return { config: SECURE_PACKAGED_FALLBACK, source }
  }
}

export function resolveProductConfig(log: LogSink): DesktopProductConfig {
  return readProductConfig(log).config
}

function resolvePackagedConfigSeedPath(log: LogSink): string | null {
  // Development Serve loads its own settings/default.json. The frozen seed is
  // produced by packaging and is only used for installation's first-run setup.
  if (!app.isPackaged) return null
  const candidates = [join(applicationResources(app), CONFIG_RESOURCE_DIR, CONFIG_FILE)]
  const source = candidates.find((candidate) => existsSync(candidate))
  if (source) return source
  log(`[shell] WARN desktop default config missing: ${candidates.join(', ')}\n`)
  return null
}

function configureDesktopEnvironment(log: LogSink): void {
  const storage = desktopStorage()
  const activeHome = storage.home
  process.env[SCHOLARSEED_HOME_ENV] = activeHome
  process.env[SCHOLARSEED_DEFAULT_WORKSPACE_ENV] = storage.workspace
  if (storage.createWorkspace) {
    const writer = desktopDirectoryWriter(storage.workspace)
    writer.close()
  }
  log(`[shell] desktop workspace=${storage.workspace} (startup selection)\n`)
  // Per-project state belongs to Serve and remains a single directory name.
  if (!process.env[SCHOLARSEED_PROJECT_DIRNAME_ENV]) {
    process.env[SCHOLARSEED_PROJECT_DIRNAME_ENV] = SCHOLARSEED_PROJECT_DIRNAME
  }
  log(
    `[shell] desktop home=${activeHome} project-state=${process.env[SCHOLARSEED_PROJECT_DIRNAME_ENV]}\n`
  )
}

/** Runtime root shared by the storage overview and writable tool caches. */
export function runtimeStoreRoot(): string {
  return app.isPackaged && process.platform === 'win32'
    ? join(dirname(dirname(applicationResources(app))), 'runtime')
    : computeRuntimeStoreRoot(desktopHome())
}

export async function waitForHealth(
  baseUrl: string,
  timeoutMs: number,
  log: LogSink,
  mode: 'managed' | 'attach' = 'managed'
): Promise<boolean> {
  const browserEnabled = resolveProductConfig(log).features.browser
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  let interval = HEALTH_PROBE_INITIAL_INTERVAL_MS
  while (Date.now() < deadline) {
    attempt++
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), HEALTH_PROBE_TIMEOUT_MS)
      const r = await fetch(
        baseUrl + (mode === 'managed' ? BACKEND_HEALTH_PATH : RUNTIME_HEALTH_PATH),
        {
          signal: ctl.signal,
        }
      )
      clearTimeout(t)
      if (r.ok) {
        const j = (await r.json()) as { ok?: boolean }
        if (j.ok) {
          const remote = validateBrowserFeatureReadiness(j, browserEnabled, mode)
          if (remote === null)
            log(
              '[shell] legacy attach browser projection missing; remote unknown, local browser disabled\n'
            )
          log(`[shell] backend healthy after ${attempt} probe(s)\n`)
          return true
        }
      }
    } catch (error) {
      if (error instanceof BrowserFeatureReadinessError) throw error
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, interval))
    interval = Math.min(interval * HEALTH_PROBE_BACKOFF_FACTOR, HEALTH_PROBE_MAX_INTERVAL_MS)
  }
  return false
}

const backendDrains = new WeakMap<BackendHandle, Promise<void>>()
const backendControls = new WeakMap<BackendHandle, BackendControl>()
const backendStopLogs = new WeakMap<BackendHandle, LogSink>()
const backendPreparationStops = new WeakMap<BackendHandle, AbortController>()
export enum BackendStopKind {
  Clean = 'clean',
  FailedExit = 'failed-exit',
  NotStarted = 'not-started',
}

export interface BackendStopResult {
  readonly kind: BackendStopKind
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

const NO_BACKEND_STOP: BackendStopResult = Object.freeze({
  kind: BackendStopKind.NotStarted,
  code: null,
  signal: null,
})
const backendStops = new WeakMap<BackendHandle, Promise<BackendStopResult>>()
// A drained family has already closed its native handle. Retain its outcome if
// another shutdown step fails so a retry cannot certify a forced drain as clean.
const backendFamilyResults = new WeakMap<BackendHandle, boolean>()

export function requireCleanBackendStop(result: BackendStopResult): void {
  if (result.kind === BackendStopKind.FailedExit)
    throw new Error(`backend shutdown incomplete: code=${result.code} signal=${result.signal}`)
}

export function backendUpdateControl(handle: BackendHandle | null): BackendControl {
  const control = handle && backendControls.get(handle)
  if (!handle || handle.stopping || !handle.proc || handle.proc.exitCode !== null || !control)
    throw new Error('private backend update control unavailable')
  return control
}

export function startBackend(log: LogSink, options: BackendStartOptions = {}): BackendHandle {
  const persist: LogSink = (line) => {
    log(line)
    options.lifecycleLog?.(line)
  }
  let finishLog: () => Promise<void> = async () => {}
  let resolveDrain!: () => void
  let rejectDrain!: (error: unknown) => void
  const drained = new Promise<void>((resolve, reject) => {
    resolveDrain = resolve
    rejectDrain = reject
  })
  void drained.catch(() => {})
  let finishing: Promise<void> | null = null
  const preparations: Promise<unknown>[] = []
  let preparationFailure: unknown = null
  const preparationStop = new AbortController()
  const finish = (): Promise<void> => {
    preparationStop.abort()
    finishing ??= Promise.allSettled(preparations)
      .then(finishLog)
      .then(() => {
        if (preparationFailure) throw preparationFailure
      })
      .then(resolveDrain)
      .catch(rejectDrain)
    return finishing
  }
  let resolveExit: (exit: BackendExit) => void = () => undefined
  const handle: BackendHandle = {
    python: null,
    port: 0,
    baseUrl: '',
    proc: null,
    ready: Promise.resolve(false),
    exited: new Promise<BackendExit>((resolve) => {
      resolveExit = resolve
    }),
    error: null,
    stopping: false,
    agentTransport: null,
    storageLaunch: null,
  }

  backendDrains.set(handle, drained)
  backendPreparationStops.set(handle, preparationStop)
  const attemptId = randomUUID()
  const startedAt = performance.now()
  let phase: string = BACKEND_STARTUP_PHASE.port
  let phaseStartedAt = startedAt
  let startupError: unknown
  const diagnostic = (event: 'started' | 'failed' | 'ready'): void => {
    // Diagnostics cannot replace the original startup result, including when a sink fails.
    try {
      const now = performance.now()
      const line = `${BACKEND_STARTUP_DIAGNOSTIC} ${JSON.stringify({
        schema: 1,
        attemptId,
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
        version: app.getVersion(),
        phase,
        event,
        elapsedMs: Math.round(now - startedAt),
        phaseElapsedMs: Math.round(now - phaseStartedAt),
        backendPid: handle.proc?.pid ?? null,
        port: handle.port,
        failure: handle.error?.kind ?? null,
        ...(event === 'failed'
          ? { error: redactDiagnosticError(startupError ?? handle.error) }
          : {}),
      })}\n`
      // Call independently: unavailable stdout/renderer must not lose persistent evidence.
      try {
        log(line)
      } catch {
        /* best-effort diagnostic sink */
      }
      try {
        options.lifecycleLog?.(line)
      } catch {
        /* best-effort diagnostic sink */
      }
    } catch {
      /* diagnostics never affect startup */
    }
  }
  const enterPhase = (next: string): void => {
    phase = next
    phaseStartedAt = performance.now()
    diagnostic('started')
  }
  handle.ready = (async () => {
    diagnostic('started')
    const port = options.port ?? (await pickPort())
    const baseUrl = `http://${LOOPBACK_HOST}:${port}`
    handle.port = port
    handle.baseUrl = baseUrl

    enterPhase(BACKEND_STARTUP_PHASE.paths)
    const backendPaths = await resolveBackendPaths()
    const { cwd, hookBin, skillBin } = backendPaths
    enterPhase(BACKEND_STARTUP_PHASE.source)
    const sourceIdentity = await captureSourceBaseline(
      cwd,
      clientVersion(app.getVersion(), readProductConfig(log).config.buildNumber),
      app.isPackaged
    )
    enterPhase(BACKEND_STARTUP_PHASE.pythonEntry)
    const python = toNamespacedPath(backendPaths.python)
    if (!existsSync(python)) {
      handle.error = { kind: 'pythonMissing', path: python }
      log(`[shell] ERROR python not found: ${python}\n`)
      return false
    }
    enterPhase(BACKEND_STARTUP_PHASE.runtimeEntries)
    if (backendPaths.windowsRuntime) {
      accessSync(backendPaths.windowsRuntime.powershell, fsConstants.X_OK)
      accessSync(join(backendPaths.windowsRuntime.texlive, WINDOWS_TEXLIVE_ENTRY), fsConstants.X_OK)
    }
    enterPhase(BACKEND_STARTUP_PHASE.toolchain)
    const vendoredCodex = app.isPackaged
      ? null
      : resolveVendoredCodex(
          app.getAppPath(),
          process.platform,
          process.arch,
          (line) => log(`[shell] ${line}\n`),
          CACHE_VALIDATION.integrity
        )
    if (vendoredCodex) {
      preparations.push(vendoredCodex)
      void vendoredCodex.catch(() => undefined)
    }
    let texliveExecutableDirectory: string | null = null
    let texliveVersion = reviewedTexliveVersion()
    let texliveArchive = reviewedTexliveArchive()
    const texliveStartedAt = performance.now()
    persist('[shell] TeX preparation started\n')
    const texlivePreparation = (async () => {
      if (app.isPackaged) {
        if (backendPaths.windowsRuntime) {
          const component = readRuntimeManifest(dirname(applicationResources(app))).components.find(
            (entry) => entry.kind === 'texlive'
          )
          if (!component) throw new Error('TeX runtime component version missing')
          texliveVersion = component.version
          texliveArchive = component.archiveSha256
        }
        texliveExecutableDirectory =
          backendPaths.windowsRuntime?.texlive ?? bundledTexlive(applicationResources(app))
      } else {
        const location = vendoredTexliveLocation(app.getAppPath(), process.platform, process.arch)
        texliveExecutableDirectory = location.binDirectory
        const resolution = await resolveVendoredTexlive(
          app.getAppPath(),
          process.platform,
          process.arch,
          (line) => persist(`[shell] ${line}\n`),
          preparationStop.signal
        )
        if (
          resolution.binDirectory !== location.binDirectory ||
          resolution.sha256 !== location.sha256
        )
          throw new Error('TeX preparation identity changed')
      }
      persist(
        `[shell] TeX preparation finished elapsedMs=${Math.round(performance.now() - texliveStartedAt)}\n`
      )
      return true
    })().catch((error: unknown) => {
      if (preparationStop.signal.aborted) {
        persist('[shell] TeX preparation cancelled\n')
        return false
      }
      persist(
        `[shell] ERROR TeX preparation failed elapsedMs=${Math.round(performance.now() - texliveStartedAt)}: ${String(error)}\n`
      )
      return false
    })
    preparations.push(texlivePreparation)
    enterPhase(BACKEND_STARTUP_PHASE.pythonIdentity)
    let pythonIdentity
    const pythonStartedAt = performance.now()
    log('[shell] Python identity check started\n')
    try {
      pythonIdentity = await (app.isPackaged
        ? inspectPythonAsync(python)
        : verifyDevelopmentPythonAsync(cwd, python))
      log(
        `[shell] Python identity check finished elapsedMs=${Math.round(performance.now() - pythonStartedAt)}\n`
      )
      handle.python = python
      log(
        `[shell] Python ${pythonIdentity.python}, SQLite ${pythonIdentity.sqlite}, base=${pythonIdentity.base_prefix}\n`
      )
    } catch (error) {
      startupError = error
      const detail = error instanceof Error ? error.message : String(error)
      handle.error = { kind: 'pythonInvalid', detail }
      log(`[shell] ERROR ${detail}\n`)
      return false
    }
    enterPhase(BACKEND_STARTUP_PHASE.skillLauncher)
    try {
      if (app.isPackaged && !existsSync(skillPythonLauncherPath(skillBin))) {
        throw new Error(
          `packaged Skill Python launcher missing: ${skillPythonLauncherPath(skillBin)}`
        )
      }
      if (!app.isPackaged) writeSkillPythonLauncher(skillBin, python)
    } catch (error) {
      startupError = error
      const detail = error instanceof Error ? error.message : String(error)
      handle.error = { kind: 'startupFailed', detail }
      log(`[shell] ERROR Skill Python launcher setup failed: ${detail}\n`)
      return false
    }
    enterPhase(BACKEND_STARTUP_PHASE.workspace)
    configureDesktopEnvironment(log)
    enterPhase(BACKEND_STARTUP_PHASE.environment)
    const inheritedExecutablePath = process.env[PATH_ENV] || ''
    const standardPath = app.isPackaged ? standardExecutablePath() : ''
    const bundledCodexExecutable = app.isPackaged
      ? (backendPaths.windowsRuntime?.codex ?? bundledCodex(applicationResources(app)))
      : ''
    let codexExecutable = bundledCodexExecutable
    if (vendoredCodex) {
      const codexResolution = await vendoredCodex
      codexExecutable = codexResolution.path
    }
    log(
      `[shell] Codex source=${app.isPackaged ? 'bundled' : 'vendored'} executable=${codexExecutable}\n`
    )
    const codexExecutableDirectory = codexExecutable ? dirname(codexExecutable) : null
    const pythonDirectories = pythonExecutableDirectories(
      backendPaths.python,
      pythonIdentity.scripts
    )
    log(
      `[shell] TeX Live source=${app.isPackaged ? 'bundled' : 'vendored'} ` +
        `directory=${texliveExecutableDirectory}\n`
    )
    // skillBin and hookBin ahead of Python directories: the packaged env keeps the
    // uv/pip-generated console-script trampolines under python/Scripts (Win)
    // or python/bin (POSIX) because dependencies.py inventory covers them,
    // but those trampolines embed the build-machine Python path and fail
    // canonicalize_ after the bundle is relocated. hookBin is the product-owned
    // relocatable shell directory (backend/bin/); resolving it first hides the
    // broken shells from every process that inherits this PATH.
    const executablePath = mergeExecutablePaths(
      skillBin,
      hookBin,
      ...pythonDirectories,
      codexExecutableDirectory,
      texliveExecutableDirectory,
      backendPaths.windowsRuntime ? dirname(backendPaths.windowsRuntime.powershell) : null,
      inheritedExecutablePath,
      standardPath
    )
    const seedConfig = resolvePackagedConfigSeedPath(log)
    const resolvedProductConfig = readProductConfig(log)
    const productConfig = resolvedProductConfig.config
    const applicationIdentity = Object.freeze({
      version: app.getVersion(),
      buildNumber: productConfig.buildNumber,
    })
    const codexRuntime = projectCodexRuntimeEnvironment(
      process.env,
      productConfig.codexRuntime,
      app.isPackaged,
      codexExecutable,
      bundledCodexExecutable
    )
    if (codexRuntime.applied) {
      log(
        `[shell] bundled Codex policy profile=${productConfig.codexRuntime.profile}` +
          ` version=${productConfig.codexRuntime.reportedVersion}` +
          ' upstream=official\n'
      )
    }

    // 桌面产品线收敛（2026-09-09 定案）：未登录可用是产品默认，serve 恒以 off 拉起；
    // 登录是可选增强 —— 有 account_base_url 就能浏览器回跳登录，无需模式决议。
    const authMode = DESKTOP_BACKEND_AUTH_MODE
    const accountBase = options.accountBaseUrl ?? resolveStartupAccountBase(log)
    log(
      accountBase
        ? `[shell] auth-mode=${authMode} account-service=${accountBase}\n`
        : `[shell] auth-mode=${authMode} 无账号服务地址: 登录入口不显示\n`
    )
    const logLevel =
      process.env[SCHOLARSEED_LOG_LEVEL_ENV] ||
      (app.isPackaged ? DESKTOP_DEFAULT_LOG_LEVEL : 'info')

    const args = [
      '-m',
      'service.cli.serve',
      '--parent-stdin',
      '--host',
      LOOPBACK_HOST,
      '--port',
      String(port),
      '--auth-mode',
      authMode,
      '--ownership-axis',
      DESKTOP_OWNERSHIP_AXIS,
      '--log-level',
      logLevel,
      QUIET_DESKTOP_POLL_ACCESS_FLAG,
    ]

    enterPhase(BACKEND_STARTUP_PHASE.log)
    let logFile: RotatingFileLog | null = null
    try {
      logFile = new RotatingFileLog(join(desktopHome(), LOGS_DIRNAME, BACKEND_LOG_FILE), {
        acquireWriter: () => desktopDirectoryWriter(join(desktopHome(), LOGS_DIRNAME)),
        // Parent log writes qualify HOME ancestors. Startup must first finish
        // the child's exclusive configuration/database initialization.
        deferred: true,
      })
    } catch {
      /* logging to file is best-effort */
    }
    const stamper = logFile ? new LineTimestamper((line) => logFile?.write(line)) : null
    if (logFile) backendDiagnosticWriters.set(handle, (line) => logFile?.write(line) ?? false)
    finishLog = async () => {
      stamper?.flush()
      // Called only after the owned output pipes close (or no child was spawned).
      await logFile?.end()
      backendDiagnosticWriters.delete(handle)
    }
    if (sourceIdentity) persist(`[source-baseline] ${sourceIdentity}\n`)
    backendStopLogs.set(handle, persist)

    persist(`[shell] spawning backend: ${python} ${args.join(' ')}\n[shell] cwd=${cwd}\n`)
    enterPhase(BACKEND_STARTUP_PHASE.agent)
    const agentTransport = productConfig.features.browser
      ? await createAgentTransport(
          options.browserList ?? (() => []),
          options.browserPrepareRead,
          options.browserReadActions,
          options.browserListAuthority,
          options.browserNavigateActions,
          options.browserActionActions,
          options.browserHistoryActions,
          options.browserSearchAction
        )
      : null
    handle.agentTransport = agentTransport
    enterPhase(BACKEND_STARTUP_PHASE.browser)
    const env: NodeJS.ProcessEnv = {
      ...browserEnvironment(
        codexRuntime.environment,
        applicationResources(app),
        python,
        app.isPackaged
      ),
      ...(app.isPackaged ? { [PYTHON_DONT_WRITE_BYTECODE_ENV]: '1' } : {}),
      // Windows product wheels remain separate from the frozen interpreter tree.
      ...(backendPaths.windowsRuntime
        ? { [PYTHONPATH_ENV]: toNamespacedPath(join(cwd, PYLIBS_DIRNAME)) }
        : {}),
      [PATH_ENV]: executablePath,
      PYTHONUNBUFFERED: '1',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      [SCHOLARSEED_DESKTOP_ENV]: '1',
      [SOURCE_BASELINE_ENV]: sourceIdentity || '',
      [SCHOLARSEED_APP_VERSION_ENV]: clientVersion(
        applicationIdentity.version,
        applicationIdentity.buildNumber
      ),
      [SCHOLARSEED_LOG_LEVEL_ENV]: logLevel,
      [SCHOLARSEED_ACCOUNT_BASE_URL_ENV]: accountBase,
      [SCHOLARSEED_CODEX_EXECUTABLE_ENV]: codexExecutable,
      [SCHOLARSEED_PYTHON_ENV]: python,
      [SCHOLARSEED_BRIDGE_DIR_ENV]: skillBin ?? '',
      [SCHOLARSEED_HOST_PROCESS_KEY_ENV]: hostProcessKey,
      [TOOL_RESOURCES_ENV]: backendPaths.toolResources ?? '',
      [TOOL_RESOURCES_REQUIRED_ENV]: app.isPackaged && process.platform === 'win32' ? '1' : '',
      [TOOL_PRINCIPAL_ENV]: options.toolPrincipal ?? '',
      [SANDBOX_RECOVERY_HELPER_ENV]:
        app.isPackaged && process.platform === 'win32'
          ? join(applicationResources(app), ...SANDBOX_RECOVERY_HELPER_PARTS)
          : '',
    }
    enterPhase(BACKEND_STARTUP_PHASE.texlive)
    let texliveEnvironmentReady = false
    let texliveOptions: TexliveEnvironmentOptions | undefined
    if (texliveExecutableDirectory) {
      try {
        const writableRoot = texliveStateRoot(runtimeStoreRoot(), texliveVersion)
        texliveOptions = {
          binDirectory: texliveExecutableDirectory,
          version: texliveVersion,
          archiveSha256: texliveArchive,
          writableRoot,
          environment: env,
        }
        const rebuild = process.platform === 'darwin' && !texliveEnvironmentCurrent(texliveOptions)
        const writer = rebuild
          ? desktopDirectoryMaintenance(writableRoot)
          : desktopDirectoryWriter(writableRoot)
        try {
          // Recheck after qualification: another launch may have prepared it.
          if (rebuild && !texliveEnvironmentCurrent(texliveOptions)) {
            Object.assign(env, rebuildTexliveEnvironment(texliveOptions))
            persist(
              `[shell] TeX version cache rebuilt under exclusive maintenance cache=${writableRoot}\n`
            )
          } else {
            Object.assign(env, prepareTexliveEnvironment(texliveOptions))
          }
        } finally {
          // Serve acquires the long-lived ancestor domain. Verify the receipt
          // again after that handoff and before admitting any tool execution.
          writer.close()
        }
        texliveEnvironmentReady = true
        persist(
          `[shell] TeX environment prepared directory=${texliveExecutableDirectory} cache=${writableRoot}\n`
        )
      } catch (error) {
        persist(`[shell] ERROR TeX environment preparation failed: ${String(error)}\n`)
      }
    }
    delete env[SCHOLARSEED_AGENT_BROWSER_PORT_ENV]
    delete env[SCHOLARSEED_AGENT_BROWSER_KEY_ENV]
    if (agentTransport) {
      env[SCHOLARSEED_AGENT_BROWSER_PORT_ENV] = String(agentTransport.port)
      env[SCHOLARSEED_AGENT_BROWSER_KEY_ENV] = agentTransport.key
    }
    if (hookBin) {
      env[ELECTRON_EXECUTABLE_ENV] = process.execPath
    }
    const seed = captureSeedSource(env, seedConfig)
    if (seedConfig) env[SCHOLARSEED_CONFIG_SEED_ENV] = seedConfig
    if (resolvedProductConfig.source) {
      env[SCHOLARSEED_PRODUCT_MANIFEST_ENV] = resolvedProductConfig.source
    }
    // Provisioning and runtime probes await external work. A quit during that work
    // must not create a new backend after stopBackend has already returned.
    if (handle.stopping) return false
    let bindings: readonly StorageBinding[] | null = null
    if (app.isPackaged && process.platform === 'win32') {
      bindings = observeStorageBindings(
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- Native addon uses the packaged main directory.
        require('./lease.node') as StorageBindingNative,
        desktopStorage()
      )
    }
    const control = new BackendControl((event) =>
      persist(`[shell] backend_control ${JSON.stringify(event)}\n`)
    )
    backendControls.set(handle, control)
    enterPhase(BACKEND_STARTUP_PHASE.control)
    const bootstrap = await control.listen()
    if (handle.stopping) {
      bootstrap.fill(0)
      control.close()
      return false
    }
    args.push(
      '--parent-control',
      '--await-toolchain',
      '--await-skill-python',
      '--shutdown-timeout-seconds',
      String(SHUTDOWN_SECONDS)
    )
    const storageHome = env[SCHOLARSEED_HOME_ENV]
    handle.storageLaunch =
      productConfig.features.browser === true && storageHome
        ? Object.freeze({
            python,
            cwd,
            env: Object.freeze({ ...env }),
            profileId: createHash('sha256').update(resolve(storageHome)).digest('hex'),
          })
        : null
    const childArgs =
      process.platform === 'win32'
        ? ['-B', '-c', WINDOWS_BACKEND_BOOTSTRAP, ...args.slice(1)]
        : ['-B', ...args]
    const spawnStarted = performance.now()
    persist(`[startup] backend spawn requested parentPid=${process.pid} unixMs=${Date.now()}\n`)
    enterPhase(BACKEND_STARTUP_PHASE.spawn)
    const proc = spawn(pythonExecutablePath(python), childArgs, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    handle.proc = proc
    const checkpoint = (phase: string) => {
      persist(
        `[startup] backend checkpoint phase=${phase} parentPid=${process.pid} childPid=${proc.pid ?? 0}` +
          ` elapsedMs=${(performance.now() - spawnStarted).toFixed(3)} unixMs=${Date.now()}\n`
      )
    }
    checkpoint('spawn-returned')
    const launch = Object.freeze({
      storage: desktopStorage(),
      bindings,
      cwd,
      seed,
      environment: captureEnvironment(env),
    })
    proc.once('spawn', () => {
      checkpoint('spawn-event')
      backendLaunches.set(proc, launch)
      activeBackendLaunch = launch
    })
    // Only this parent's inherited pipe can request ordinary graceful shutdown.
    // Its failure does not certify exit; stopBackend still waits for the child.
    proc.stdin.on('error', () => persist('[shell] backend control pipe unavailable\n'))
    const spawnedAt = Date.now()

    let startupDiagnostic = ''
    let firstOutput = true
    const onData = (s: string) => {
      if (firstOutput) {
        firstOutput = false
        checkpoint('first-output-received')
      }
      startupDiagnostic = (startupDiagnostic + s).slice(-BACKEND_STARTUP_DIAGNOSTIC_CHARS)
      stamper?.push(s)
      log(s)
    }
    proc.stdout?.setEncoding('utf8').on('data', onData)
    proc.stderr?.setEncoding('utf8').on('data', onData)
    proc.once('error', (error) => {
      control.close()
      void agentTransport?.close()
      const detail = String(error)
      startupDiagnostic = (startupDiagnostic + detail).slice(-BACKEND_STARTUP_DIAGNOSTIC_CHARS)
      persist(`[shell] backend spawn error: ${detail}\n`)
      resolveExit({ code: null, signal: null })
    })
    proc.once('exit', (code, signal) => {
      control.close()
      if (activeBackendLaunch === launch) activeBackendLaunch = null
      void agentTransport?.close()
      persist(`[shell] backend exited code=${code} signal=${signal}\n`)
      resolveExit({ code, signal })
    })
    // exit can precede the final stdout/stderr data. close is the owned-pipe
    // barrier, and log end additionally joins buffered IO and compression.
    proc.once('close', () => {
      void finish()
    })

    if (process.platform === 'win32' && proc.pid !== undefined) {
      try {
        checkpoint('family-attach-started')
        backendFamilies.set(handle, openProcessFamily(proc.pid))
        checkpoint('family-attached')
        proc.stdin.write(FAMILY_START_BYTE)
        checkpoint('family-release-queued')
      } catch (error) {
        bootstrap.fill(0)
        proc.stdin.destroy()
        proc.kill('SIGKILL')
        control.close()
        throw error
      }
    }
    proc.stdin.write(bootstrap, () => bootstrap.fill(0))

    const skillPythonStarted = Date.now()
    persist('[shell] Skill Python probe started alongside backend imports\n')
    const skillPythonReceipt = probeSkillPython(
      python,
      skillBin,
      cwd,
      env,
      preparationStop.signal,
      persist
    )
      .catch((error: unknown) => {
        preparationFailure = error
        throw error
      })
      .then(async (ready) => {
        persist(
          `[shell] Skill Python probe ready=${ready} elapsed=${Date.now() - skillPythonStarted}ms\n`
        )
        if (handle.stopping || preparationStop.signal.aborted) return
        await control.skillPython(ready)
      })
      .catch((error: unknown) => {
        control.close()
        if (!handle.stopping)
          persist(`[shell] ERROR Skill Python preparation unavailable: ${String(error)}\n`)
      })
    preparations.push(skillPythonReceipt)

    const toolchainReceipt = texlivePreparation
      .then(async (ready) => {
        if (handle.stopping || preparationStop.signal.aborted) return
        if (process.platform === 'darwin' && texliveEnvironmentReady && texliveOptions) {
          if (!(await handle.ready) || handle.stopping) return
          texliveEnvironmentReady = texliveEnvironmentCurrent(texliveOptions)
          if (!texliveEnvironmentReady)
            persist(
              '[shell] ERROR TeX cache changed during backend startup; execution remains disabled\n'
            )
        }
        const resources =
          ready && texliveEnvironmentReady && texliveExecutableDirectory !== null
            ? texliveExecutionResources({
                binDirectory: texliveExecutableDirectory,
                version: texliveVersion,
                archiveSha256: texliveArchive,
                environment: env,
              })
            : null
        await control.toolchain(resources !== null, resources)
        persist(`[shell] TeX execution gate ready=${ready && texliveEnvironmentReady}\n`)
      })
      .catch((error: unknown) => {
        control.close()
        if (!handle.stopping)
          persist(`[shell] ERROR TeX execution gate unavailable: ${String(error)}\n`)
      })
    preparations.push(toolchainReceipt)

    enterPhase(BACKEND_STARTUP_PHASE.health)
    const firstRun = isFirstRun(desktopHome(), applicationIdentity)
    const healthBudget = resolveStartupBudgetMs(firstRun, false, SKILL_PYTHON_PROBE_TIMEOUT_MS)
    persist(`[shell] health budget=${healthBudget}ms (first-run=${firstRun})\n`)
    const startup = await Promise.race([
      waitForHealth(baseUrl, healthBudget, log).then((ok) => ({ kind: 'health' as const, ok })),
      handle.exited.then((exit) => ({ kind: 'exit' as const, exit })),
    ])
    if (startup.kind === 'exit') {
      const detail = startupDiagnostic.trim()
      handle.error = {
        kind: 'exited',
        code: startup.exit.code,
        signal: startup.exit.signal,
        detail,
      }
      return false
    }
    if (!startup.ok) {
      control.close('startup_timeout')
      // 活着的静默进程 = 还在 import/扫描里慢速前进；diagnosticChars=0 即「零输出」的
      // 直接证据（真机事故里打包版只有一行失败记录，无法区分卡死与慢）。
      persist(
        `[shell] backend health timeout pid=${proc.pid} budget=${healthBudget}ms` +
          ` elapsed=${Date.now() - spawnedAt}ms diagnosticChars=${startupDiagnostic.length}\n`
      )
      handle.error = { kind: 'healthTimeout' }
      return false
    }
    // Health closes the startup phase; any still-missing peer now has the
    // ordinary connection deadline. Authenticated requests keep their own deadline.
    control.launched()
    logFile?.resume()
    try {
      const writer = desktopDirectoryWriter(desktopHome())
      try {
        writeStartupMarker(desktopHome(), applicationIdentity)
      } finally {
        writer.close()
      }
    } catch (error) {
      log(`[shell] WARN startup marker not written: ${String(error)}\n`)
    }
    diagnostic('ready')
    return true
  })()
    .catch((error: unknown) => {
      startupError = error
      backendControls.get(handle)?.close()
      const detail = String(error)
      handle.error = { kind: 'startupFailed', detail }
      log(`[shell] ERROR backend startup failed: ${detail}\n`)
      return false
    })
    .finally(async () => {
      if (handle.error) diagnostic('failed')
      if (!handle.proc || handle.stopping) await handle.agentTransport?.close()
      if (!handle.proc) await finish()
    })

  return handle
}

export function stopBackend(handle: BackendHandle | null): Promise<BackendStopResult> {
  if (!handle) return Promise.resolve(NO_BACKEND_STOP)
  const pending = backendStops.get(handle)
  if (pending) return pending
  const stopping = finishBackendStop(handle).catch((error: unknown) => {
    // Only completed stops are durable. A timeout is not an exit acknowledgement;
    // the next request must recheck the process and finish the remaining drains.
    backendStops.delete(handle)
    throw error
  })
  backendStops.set(handle, stopping)
  return stopping
}

async function finishBackendStop(handle: BackendHandle): Promise<BackendStopResult> {
  handle.stopping = true
  backendPreparationStops.get(handle)?.abort()
  const startedAt = Date.now()
  const log = backendStopLogs.get(handle) ?? (() => {})
  log(
    `[shell] backend shutdown requested budgetMs=${SHUTDOWN_SECONDS * 1_000} deadlineMs=${SHUTDOWN_DEADLINE_MS}\n`
  )
  try {
    const proc = handle.proc
    let stopError: unknown
    try {
      if (proc)
        await stopChildProcess(proc, SHUTDOWN_DEADLINE_MS, () => {
          if (!proc.stdin) throw new Error('backend control pipe unavailable')
          proc.stdin.end()
        })
    } catch (error) {
      stopError = error
    }
    const family = backendFamilies.get(handle)
    const familyClean = family
      ? await drainProcessFamily(family)
      : (backendFamilyResults.get(handle) ?? true)
    if (family) {
      backendFamilyResults.set(handle, familyClean)
      backendFamilies.delete(handle)
    }
    if (stopError) throw stopError
    // Also join provisioning that was in flight when stop was requested. Its
    // stopping check forbids a late spawn, and its finally closes any early log.
    await handle.ready
    await backendDrains.get(handle)
    await handle.agentTransport?.close()
    if (!proc || proc.pid === undefined) return NO_BACKEND_STOP
    if (proc.exitCode === null && proc.signalCode === null)
      throw new Error('backend process exit was not observed')
    const result: BackendStopResult = Object.freeze({
      kind:
        familyClean && proc.exitCode === 0 && proc.signalCode === null
          ? BackendStopKind.Clean
          : BackendStopKind.FailedExit,
      code: proc.exitCode,
      signal: proc.signalCode,
    })
    log(
      `[shell] backend shutdown result=${result.kind} elapsedMs=${Date.now() - startedAt} code=${result.code} signal=${result.signal} logsDrained=true\n`
    )
    return result
  } catch (error) {
    log(
      `[shell] backend shutdown failed elapsedMs=${Date.now() - startedAt} code=${handle.proc?.exitCode ?? null} signal=${handle.proc?.signalCode ?? null} errorType=${error instanceof Error ? error.name : 'unknown'}\n`
    )
    throw error
  }
}
