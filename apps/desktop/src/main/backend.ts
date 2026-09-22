// backend.ts — spawn + supervise the Python agent backend (`service.cli.serve`).
//
// Single-launch full-stack: the Electron main process owns the FastAPI/uvicorn
// backend as a child process. We pick a free localhost port, spawn `scholarseed serve`
// (account auth in the packaged product, auth-off in dev), and wait for /api/healthz before
// showing the window.
// In a packaged .app the python env + repo live under Resources/backend; in dev
// we use the repo's own .venv. Everything stays on 127.0.0.1 (never exposed).

import { randomBytes } from 'crypto'
import { spawn, ChildProcess } from 'child_process'
import { createServer } from 'net'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { app } from 'electron'
import { browserEnvironment } from '../../runtime/browser.cjs'
import { inspectPython, verifyDevelopmentPython } from '../../../../scripts/python.cjs'

import {
  AuthMode,
  DesktopProductConfig,
  parseDesktopProductConfig,
  PRODUCT_CONFIG_FILE,
  resolveAccountBaseUrl,
  SECURE_PACKAGED_FALLBACK
} from './product'
import {
  mergeExecutablePaths,
  standardExecutablePath
} from './environment'
import { LineTimestamper, RotatingFileLog } from './logfile'
import type { BackendFailure } from './failure'
import { projectCodexRuntimeEnvironment } from './runtime'
import { bundledCodex, resolveVendoredCodex } from '../../runtime/codex.cjs'
import {
  APP_COMPONENTS_FILENAME,
  COMPONENTS_DIRNAME,
  PYLIBS_DIRNAME,
  PYTHON_KIND,
  RUNTIME_DIRNAME,
  parseAppComponents,
  storeComponentDirectory
} from '../../runtime/components.cjs'
import { skillPythonLauncherPath, writeSkillPythonLauncher } from '../../runtime/python.cjs'
import { bundledTexlive, resolveVendoredTexlive } from '../../runtime/texlive.cjs'
import {
  ensureComponents,
  persistComponentLog,
  sweepUnreferencedComponents
} from './components'
import type { ProvisionedComponents } from './components'
import { isFirstRun, writeStartupMarker } from './startupmarker'

export interface BackendHandle {
  port: number
  baseUrl: string
  proc: ChildProcess | null
  ready: Promise<boolean>
  exited: Promise<BackendExit>
  error: BackendFailure | null
  stopping: boolean
}

export type LogSink = (line: string) => void

export interface BackendStartOptions {
  port?: number
  testHarness?: boolean
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
  rendererDist: string | null
  hookBin: string | null
  skillBin: string
  /**
   * win32 组件化布局（proposal 108 §7）：包内没有松散 python/texlive 树，解释器与
   * TeX 引擎在启动前由组件存储 provision 到 `<SCHOLARSEED_HOME>/runtime/`。此字段
   * 非空时 python 指向组件仓库的期望路径，`startBackend` 必须先 ensureComponents。
   */
  componentProvision?: { backendDirectory: string; storeRoot: string }
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
const SCHOLARSEED_HOME_DIRNAME = '.scholarseed'
const SCHOLARSEED_HOME_ENV = 'SCHOLARSEED_HOME'
// 统一家目录切换前, 打包版桌面端把状态落在 Electron userData/.veda; 迁移逻辑据此定位旧根。
const LEGACY_VEDA_HOME_DIRNAME = '.veda'
const SCHOLARSEED_PROJECT_DIRNAME = '.scholarseed'
const SCHOLARSEED_PROJECT_DIRNAME_ENV = 'SCHOLARSEED_PROJECT_DIRNAME'
const SCHOLARSEED_CONFIG_SEED_ENV = 'SCHOLARSEED_CONFIG_SEED_PATH'
const SCHOLARSEED_PRODUCT_MANIFEST_ENV = 'SCHOLARSEED_PRODUCT_MANIFEST'
const SCHOLARSEED_DEFAULT_WORKSPACE_ENV = 'SCHOLARSEED_DEFAULT_WORKSPACE'
const SCHOLARSEED_DESKTOP_ENV = 'SCHOLARSEED_DESKTOP'
const SCHOLARSEED_APP_VERSION_ENV = 'SCHOLARSEED_APP_VERSION'
const SCHOLARSEED_LOG_LEVEL_ENV = 'SCHOLARSEED_LOG_LEVEL'
const DESKTOP_DEFAULT_LOG_LEVEL = 'debug'
const PACKAGED_DEFAULT_WORKSPACE_NAME = 'ScholarSeed'
// dev 启动 (electron-vite dev) 时后端 cwd 是仓库根, 若不注入默认工作区, serve 的
// resolve_workspace_root 会兜底成 cwd —— 整个仓库被当成 project workspace (仓库根下
// 生成 .scholarseed、内容库 seed 整棵仓库树)。dev 默认隔离到仓库内 tmp/ (scratch 约定,
// 已 gitignore), 既不污染仓库本体也不碰打包版的真实用户数据。
const DEV_DEFAULT_WORKSPACE_SUBPATH = ['tmp', 'desktop-workspace'] as const
// Steady-state budget: the /api/healthz readiness contract (see HEALTH_PROBE_TIMEOUT_MS)
// plus spawn latency, with margin.
const HEALTH_TIMEOUT_MS = 45_000
// First launch of a build (install or update): Windows Defender's on-access scan reads the
// bundled Python environment file by file on first exec, so a *live* backend can need minutes
// before it binds. A dead backend still fails fast — the health wait races process exit, and
// the marker (see startupmarker.ts) keeps this budget off steady-state launches.
const HEALTH_TIMEOUT_FIRST_RUN_MS = 300_000
// /api/healthz includes the Codex version and login preflight. Each vendor command has a
// 10-second budget and the two commands run sequentially, so a desktop probe must outlive
// that readiness contract. A shorter HTTP timeout repeatedly cancels a healthy cold start.
const HEALTH_PROBE_TIMEOUT_MS = 25_000
// 后端在 spawn 后约 2 秒才开始监听, 所以第一次探活必然被 ECONNREFUSED 立即拒绝。
// 固定长间隔会把这次必然失败变成一整段白等 —— 用短起点 + 退避封顶: 就绪瞬间就能被
// 抓到, 长时间没起来时也不会一直高频重试。
const HEALTH_PROBE_INITIAL_INTERVAL_MS = 150
const HEALTH_PROBE_MAX_INTERVAL_MS = 1_000
const HEALTH_PROBE_BACKOFF_FACTOR = 2
const FORCE_KILL_DELAY_MS = 4_000
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
const WINDOWS_PYTHON = ['python', 'python.exe'] as const
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

function resolveBackendPaths(): BackendPaths {
  const bundledPython = process.platform === 'win32' ? WINDOWS_PYTHON : POSIX_PYTHON
  const venvPython = process.platform === 'win32' ? WINDOWS_VENV_PYTHON : POSIX_VENV_PYTHON
  if (app.isPackaged) {
    // Bundled relocatable Python lives under resources/backend/python.
    // The scholarseed package is pip-installed into it, so cwd can be the bundle dir.
    const bundled = join(process.resourcesPath, BACKEND_DIR)
    const bundledPy = join(bundled, ...bundledPython)
    const hookBin = join(bundled, HOOK_BIN_DIR)
    const bundledNode = join(hookBin, NODE_SHIM)
    // win32 组件化载荷：backend/components/app-components.json 存在即走组件仓库寻址；
    // SCHOLARSEED_PYTHON 显式覆盖时保持原语义（不 provision，直接用它）。
    const manifestPath = join(bundled, COMPONENTS_DIRNAME, APP_COMPONENTS_FILENAME)
    if (process.platform === 'win32' && !process.env[SCHOLARSEED_PYTHON_ENV] && existsSync(manifestPath)) {
      const manifest = parseAppComponents(readFileSync(manifestPath, 'utf8'))
      if (manifest) {
        const storeRoot = join(desktopHome(), RUNTIME_DIRNAME)
        const pythonComponent = manifest.components.find((component) => component.kind === PYTHON_KIND)
        if (pythonComponent) {
          const componentRoot = storeComponentDirectory(
            storeRoot, pythonComponent.kind, manifest.target, pythonComponent.contentId)
          return {
            python: join(componentRoot, ...pythonComponent.entry.split('/')),
            cwd: process.env.SCHOLARSEED_REPO || bundled,
            rendererDist: process.env.SCHOLARSEED_RENDERER_DIST || join(process.resourcesPath, 'renderer'),
            hookBin: existsSync(bundledNode) ? hookBin : null,
            skillBin: hookBin,
            componentProvision: { backendDirectory: bundled, storeRoot }
          }
        }
      }
      // 清单缺失/非法不在这里静默兜底：落到下方松散树检查（必然 miss）→ REPO_FALLBACK →
      // 打包机上不存在 → inspectPython/existsSync 用明确错误暴露构建缺陷。
    }
    const hasBundled = existsSync(bundledPy)
    return {
      python: process.env[SCHOLARSEED_PYTHON_ENV] || (hasBundled ? bundledPy : join(REPO_FALLBACK, ...venvPython)),
      cwd: process.env.SCHOLARSEED_REPO || (hasBundled ? bundled : REPO_FALLBACK),
      rendererDist: process.env.SCHOLARSEED_RENDERER_DIST || join(process.resourcesPath, 'renderer'),
      hookBin: existsSync(bundledNode) ? hookBin : null,
      skillBin: hookBin
    }
  }
  // dev: app path is apps/desktop → repo root is two levels up
  const repoRoot = process.env.SCHOLARSEED_REPO || resolve(app.getAppPath(), '..', '..')
  // when there is no Vite dev server (shoot / --say / `electron .`), have the
  // backend serve the built renderer so it loads same-origin (live, CORS-free)
  const built = join(app.getAppPath(), 'out', 'renderer')
  return {
    python: process.env[SCHOLARSEED_PYTHON_ENV] || join(repoRoot, ...venvPython),
    cwd: repoRoot,
    rendererDist: process.env['ELECTRON_RENDERER_URL'] ? null : built,
    hookBin: null,
    skillBin: join(repoRoot, ...DEV_SKILL_BIN_DIRECTORY)
  }
}

interface ResolvedProductConfig {
  config: DesktopProductConfig
  source: string | null
}

function readProductConfig(log: LogSink): ResolvedProductConfig {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, PRODUCT_CONFIG_FILE)]
    : [
        join(app.getAppPath(), 'resources', PRODUCT_CONFIG_FILE),
        join(REPO_FALLBACK, 'apps', 'desktop', 'resources', PRODUCT_CONFIG_FILE)
      ]
  const source = candidates.find((candidate) => existsSync(candidate))
  if (!source) {
    log(`[shell] ERROR desktop product config missing: ${candidates.join(', ')}; authentication fails closed\n`)
    return { config: SECURE_PACKAGED_FALLBACK, source: null }
  }
  try {
    const raw = JSON.parse(readFileSync(source, 'utf-8')) as unknown
    return { config: parseDesktopProductConfig(raw), source }
  } catch (error) {
    log(`[shell] ERROR invalid desktop product config: ${String(error)}; authentication fails closed\n`)
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
  const candidates = [join(process.resourcesPath, CONFIG_RESOURCE_DIR, CONFIG_FILE)]
  const source = candidates.find((candidate) => existsSync(candidate))
  if (source) return source
  log(`[shell] WARN desktop default config missing: ${candidates.join(', ')}\n`)
  return null
}

function mergeLegacyDirectory(source: string, target: string): number {
  mkdirSync(target, { recursive: true })
  let moved = 0
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory() && existsSync(to) && lstatSync(to).isDirectory()) {
      moved += mergeLegacyDirectory(from, to)
      continue
    }
    if (existsSync(to)) rmSync(to, { recursive: true, force: true })
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
    moved += 1
  }
  return moved
}

function migrateLegacyDesktopHome(log: LogSink, activeHome: string): void {
  // Packaged desktop versions before the unified-home cutover persisted under
  // Electron userData/.veda. CLI and every current desktop launch now share
  // ~/.scholarseed. On cutover, merge the whole old root and let legacy entries replace
  // same-named canonical entries; the old root is removed only after the merge.
  const legacyHome = join(app.getPath('userData'), LEGACY_VEDA_HOME_DIRNAME)
  if (!existsSync(legacyHome) || resolve(legacyHome) === resolve(activeHome)) return
  try {
    if (!existsSync(activeHome)) {
      mkdirSync(dirname(activeHome), { recursive: true })
      renameSync(legacyHome, activeHome)
      log(`[shell] migrated legacy desktop home ${legacyHome} → ${activeHome}\n`)
      return
    }
    const moved = mergeLegacyDirectory(legacyHome, activeHome)
    rmSync(legacyHome, { recursive: true, force: true })
    log(`[shell] merged ${moved} legacy desktop entries into ${activeHome} and removed ${legacyHome}\n`)
  } catch (error) {
    log(`[shell] WARN legacy desktop-home migration skipped: ${String(error)}\n`)
  }
}

function configureDesktopEnvironment(log: LogSink): void {
  const hasExplicitHome = Boolean(process.env[SCHOLARSEED_HOME_ENV])
  if (!process.env[SCHOLARSEED_DEFAULT_WORKSPACE_ENV]) {
    if (app.isPackaged) {
      const packagedDefault = join(app.getPath('documents'), PACKAGED_DEFAULT_WORKSPACE_NAME)
      process.env[SCHOLARSEED_DEFAULT_WORKSPACE_ENV] = packagedDefault
      mkdirSync(packagedDefault, { recursive: true })
      log(`[shell] desktop workspace=${packagedDefault} (packaged first-launch default)\n`)
    } else {
      const repoRoot = process.env.SCHOLARSEED_REPO || REPO_FALLBACK
      const devDefault = join(repoRoot, ...DEV_DEFAULT_WORKSPACE_SUBPATH)
      process.env[SCHOLARSEED_DEFAULT_WORKSPACE_ENV] = devDefault
      mkdirSync(devDefault, { recursive: true })
      log(`[shell] desktop workspace=${devDefault} (dev default, not launch dir)\n`)
    }
  }
  const activeHome = process.env[SCHOLARSEED_HOME_ENV] || join(homedir(), SCHOLARSEED_HOME_DIRNAME)
  process.env[SCHOLARSEED_HOME_ENV] = activeHome
  // Per-project state belongs to Serve and remains a single directory name.
  if (!process.env[SCHOLARSEED_PROJECT_DIRNAME_ENV]) {
    process.env[SCHOLARSEED_PROJECT_DIRNAME_ENV] = SCHOLARSEED_PROJECT_DIRNAME
  }
  if (!hasExplicitHome && app.isPackaged) migrateLegacyDesktopHome(log, activeHome)
  log(`[shell] desktop home=${activeHome} project-state=${process.env[SCHOLARSEED_PROJECT_DIRNAME_ENV]}\n`)
}

/** 产品家目录 (~/.scholarseed, $SCHOLARSEED_HOME 覆盖) —— 桌面端一切落盘状态的唯一解析口。 */
export function desktopHome(): string {
  return process.env[SCHOLARSEED_HOME_ENV] || join(homedir(), SCHOLARSEED_HOME_DIRNAME)
}

async function waitForHealth(baseUrl: string, timeoutMs: number, log: LogSink): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  let interval = HEALTH_PROBE_INITIAL_INTERVAL_MS
  while (Date.now() < deadline) {
    attempt++
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), HEALTH_PROBE_TIMEOUT_MS)
      const r = await fetch(baseUrl + '/api/healthz', { signal: ctl.signal })
      clearTimeout(t)
      if (r.ok) {
        const j = (await r.json()) as { ok?: boolean }
        if (j.ok) {
          log(`[shell] backend healthy after ${attempt} probe(s)\n`)
          return true
        }
      }
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, interval))
    interval = Math.min(interval * HEALTH_PROBE_BACKOFF_FACTOR, HEALTH_PROBE_MAX_INTERVAL_MS)
  }
  return false
}

export function startBackend(log: LogSink, options: BackendStartOptions = {}): BackendHandle {
  let resolveExit: (exit: BackendExit) => void = () => undefined
  const handle: BackendHandle = {
    port: 0,
    baseUrl: '',
    proc: null,
    ready: Promise.resolve(false),
    exited: new Promise<BackendExit>((resolve) => {
      resolveExit = resolve
    }),
    error: null,
    stopping: false
  }

  handle.ready = (async () => {
    const port = options.port ?? await pickPort()
    const baseUrl = `http://${LOOPBACK_HOST}:${port}`
    handle.port = port
    handle.baseUrl = baseUrl

    const backendPaths = resolveBackendPaths()
    const { python, cwd, rendererDist, hookBin, skillBin } = backendPaths
    // 组件化布局：解释器/TeX 在组件仓库里，启动前 provision（命中即毫秒级返回；
    // 首启展开以分钟计，事件落 logs/components.log）。失败 = 启动失败，fail-closed，
    // 绝不回落宿主 Python（AGENTS.md 硬约束）。
    let provisionedComponents: ProvisionedComponents | null = null
    if (backendPaths.componentProvision) {
      const { backendDirectory, storeRoot } = backendPaths.componentProvision
      const componentLog = (line: string): void => {
        log(`[shell] ${line}`)
        persistComponentLog(join(desktopHome(), LOGS_DIRNAME), line)
      }
      try {
        provisionedComponents = await ensureComponents({
          backendDirectory,
          storeRoot,
          log: componentLog
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        handle.error = { kind: 'startupFailed', detail: `component provisioning failed: ${detail}` }
        log(`[shell] ERROR component provisioning failed: ${detail}\n`)
        return false
      }
      // GC 在关键路径之外：只回收未被本轮清单引用的组件，best-effort。
      const referenced = provisionedComponents.manifest.components.map((component) => component.contentId)
      setTimeout(() => {
        try {
          sweepUnreferencedComponents(storeRoot, referenced, componentLog)
        } catch {
          /* GC 失败只影响磁盘占用 */
        }
      }, 0)
    }
    if (!existsSync(python)) {
      handle.error = { kind: 'pythonMissing', path: python }
      log(`[shell] ERROR python not found: ${python}\n`)
      return false
    }
    // Vendored runtime resolution ends in subprocess probes and is independent
    // of the Python identity check, so both resolves start here and are awaited
    // after the check: the probes overlap each other and the Python subprocess.
    const vendoredRuntimes = app.isPackaged
      ? null
      : Promise.all([
        resolveVendoredCodex(app.getAppPath(), process.platform, process.arch,
          line => log(`[shell] ${line}\n`)),
        resolveVendoredTexlive(app.getAppPath(), process.platform, process.arch,
          line => log(`[shell] ${line}\n`))
          .catch((error: Error) => {
            log(`[shell] WARN bundled TeX Live unavailable: ${error.message}\n`)
            return null
          })
      ])
    let pythonIdentity
    try {
      pythonIdentity = app.isPackaged
        ? inspectPython(python)
        : verifyDevelopmentPython(cwd, python)
      log(`[shell] Python ${pythonIdentity.python}, SQLite ${pythonIdentity.sqlite}, base=${pythonIdentity.base_prefix}\n`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      handle.error = { kind: 'pythonInvalid', detail }
      log(`[shell] ERROR ${detail}\n`)
      return false
    }
    try {
      if (app.isPackaged && !existsSync(skillPythonLauncherPath(skillBin))) {
        throw new Error(`packaged Skill Python launcher missing: ${skillPythonLauncherPath(skillBin)}`)
      }
      if (!app.isPackaged) writeSkillPythonLauncher(skillBin, python)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      handle.error = { kind: 'startupFailed', detail }
      log(`[shell] ERROR Skill Python launcher setup failed: ${detail}\n`)
      return false
    }
    configureDesktopEnvironment(log)
    const inheritedExecutablePath = process.env[PATH_ENV] || ''
    const standardPath = app.isPackaged ? standardExecutablePath() : ''
    // Bundled TeX Live: the literature-review skill compiles survey PDFs with
    // xelatex/pdflatex/bibtex and finds them through PATH, so the shipped
    // toolchain has to precede any host TeX installation. A packaged app treats
    // a missing tree as a build defect and fails; a development launch only
    // warns, because a cold vendor cache must not block unrelated work.
    const bundledCodexExecutable = app.isPackaged
      ? bundledCodex(process.resourcesPath)
      : ''
    let codexExecutable = bundledCodexExecutable
    let texliveExecutableDirectory: string | null = app.isPackaged
      ? (provisionedComponents
        ? provisionedComponents.texliveBinDirectory
        : bundledTexlive(process.resourcesPath))
      : null
    if (vendoredRuntimes) {
      const [codexResolution, texliveResolution] = await vendoredRuntimes
      codexExecutable = codexResolution.path
      texliveExecutableDirectory = texliveResolution ? texliveResolution.binDirectory : null
    }
    log(`[shell] Codex source=${app.isPackaged ? 'bundled' : 'vendored'} executable=${codexExecutable}\n`)
    const codexExecutableDirectory = codexExecutable ? dirname(codexExecutable) : null
    const pythonExecutableDirectory = pythonIdentity.scripts
    log(`[shell] TeX Live source=${app.isPackaged ? 'bundled' : 'vendored'} ` +
      `directory=${texliveExecutableDirectory}\n`)
    // skillBin and hookBin ahead of pythonExecutableDirectory: the packaged env keeps the
    // uv/pip-generated console-script trampolines under python/Scripts (Win)
    // or python/bin (POSIX) because dependencies.py inventory covers them,
    // but those trampolines embed the build-machine Python path and fail
    // canonicalize_ after the bundle is relocated. hookBin is the product-owned
    // relocatable shell directory (backend/bin/); resolving it first hides the
    // broken shells from every process that inherits this PATH.
    const executablePath = mergeExecutablePaths(
      skillBin,
      hookBin,
      pythonExecutableDirectory,
      codexExecutableDirectory,
      texliveExecutableDirectory,
      inheritedExecutablePath,
      standardPath
    )
    const seedConfig = resolvePackagedConfigSeedPath(log)
    const resolvedProductConfig = readProductConfig(log)
    const productConfig = resolvedProductConfig.config
    const codexRuntime = projectCodexRuntimeEnvironment(
      process.env,
      productConfig.codexRuntime,
      app.isPackaged,
      codexExecutable,
      bundledCodexExecutable
    )
    if (codexRuntime.applied) {
      log(
        `[shell] bundled Codex policy profile=${productConfig.codexRuntime.profile}`
        + ` version=${productConfig.codexRuntime.reportedVersion}`
        + ' upstream=official\n'
      )
    }

    // 桌面产品线收敛（2026-09-09 定案）：未登录可用是产品默认，serve 恒以 off 拉起；
    // 登录是可选增强 —— 有 account_base_url 就能浏览器回跳登录，无需模式决议。
    const authMode = DESKTOP_BACKEND_AUTH_MODE
    let accountBase = productConfig.accountBaseUrl
    try {
      accountBase = resolveAccountBaseUrl(
        process.env[SCHOLARSEED_ACCOUNT_BASE_URL_ENV] || '',
        productConfig.accountBaseUrl
      )
    } catch (error) {
      accountBase = ''
      log(`[shell] ERROR invalid ${SCHOLARSEED_ACCOUNT_BASE_URL_ENV}: ${String(error)}\n`)
    }
    log(
      accountBase
        ? `[shell] auth-mode=${authMode} account-service=${accountBase}\n`
        : `[shell] auth-mode=${authMode} 无账号服务地址: 登录入口不显示\n`
    )
    const logLevel = process.env[SCHOLARSEED_LOG_LEVEL_ENV] || (app.isPackaged ? DESKTOP_DEFAULT_LOG_LEVEL : 'info')

    const args = [
      '-m', 'service.cli.serve',
      '--host', LOOPBACK_HOST,
      '--port', String(port),
      '--auth-mode', authMode,
      '--ownership-axis', DESKTOP_OWNERSHIP_AXIS,
      '--log-level', logLevel
    ]
    if (rendererDist && existsSync(rendererDist)) {
      args.push('--renderer-dist', rendererDist)
    }

    let logFile: RotatingFileLog | null = null
    try {
      logFile = new RotatingFileLog(join(desktopHome(), LOGS_DIRNAME, BACKEND_LOG_FILE))
    } catch {
      /* logging to file is best-effort */
    }
    const stamper = logFile ? new LineTimestamper((line) => logFile?.write(line)) : null

    log(`[shell] spawning backend: ${python} ${args.join(' ')}\n[shell] cwd=${cwd}\n`)
    const env: NodeJS.ProcessEnv = {
      ...browserEnvironment(codexRuntime.environment, process.resourcesPath, python, app.isPackaged),
      ...(app.isPackaged ? { [PYTHON_DONT_WRITE_BYTECODE_ENV]: '1' } : {}),
      // 组件化布局：产品代码在 backend/pylibs（随应用版本走），解释器/第三方依赖在组件仓库
      // （随锁文件走）。serve 及其子进程经 PYTHONPATH 解析产品模块。
      ...(provisionedComponents ? { [PYTHONPATH_ENV]: join(cwd, PYLIBS_DIRNAME) } : {}),
      [PATH_ENV]: executablePath,
      PYTHONUNBUFFERED: '1',
      [SCHOLARSEED_DESKTOP_ENV]: '1',
      [SCHOLARSEED_APP_VERSION_ENV]: app.getVersion(),
      [SCHOLARSEED_LOG_LEVEL_ENV]: logLevel,
      [SCHOLARSEED_ACCOUNT_BASE_URL_ENV]: accountBase,
      [SCHOLARSEED_CODEX_EXECUTABLE_ENV]: codexExecutable,
      [SCHOLARSEED_PYTHON_ENV]: python,
      [SCHOLARSEED_HOST_PROCESS_KEY_ENV]: hostProcessKey
    }
    if (hookBin) {
      env[ELECTRON_EXECUTABLE_ENV] = process.execPath
      env[SCHOLARSEED_BRIDGE_DIR_ENV] = hookBin
    }
    if (seedConfig) env[SCHOLARSEED_CONFIG_SEED_ENV] = seedConfig
    if (resolvedProductConfig.source) {
      env[SCHOLARSEED_PRODUCT_MANIFEST_ENV] = resolvedProductConfig.source
    }
    const proc = spawn(python, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    handle.proc = proc

    let startupDiagnostic = ''
    const onData = (buf: Buffer) => {
      const s = buf.toString()
      startupDiagnostic = (startupDiagnostic + s).slice(-BACKEND_STARTUP_DIAGNOSTIC_CHARS)
      stamper?.push(s)
      log(s)
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.once('error', (error) => {
      const detail = String(error)
      startupDiagnostic = (startupDiagnostic + detail).slice(-BACKEND_STARTUP_DIAGNOSTIC_CHARS)
      log(`[shell] backend spawn error: ${detail}\n`)
      resolveExit({ code: null, signal: null })
    })
    proc.once('exit', (code, signal) => {
      log(`[shell] backend exited code=${code} signal=${signal}\n`)
      stamper?.flush()
      logFile?.end()
      resolveExit({ code, signal })
    })

    const firstRun = isFirstRun(desktopHome(), app.getVersion())
    const healthBudget = firstRun ? HEALTH_TIMEOUT_FIRST_RUN_MS : HEALTH_TIMEOUT_MS
    log(`[shell] health budget=${healthBudget}ms (first-run=${firstRun})\n`)
    const startup = await Promise.race([
      waitForHealth(baseUrl, healthBudget, log).then((ok) => ({ kind: 'health' as const, ok })),
      handle.exited.then((exit) => ({ kind: 'exit' as const, exit }))
    ])
    if (startup.kind === 'exit') {
      const detail = startupDiagnostic.trim()
      handle.error = { kind: 'exited', code: startup.exit.code, signal: startup.exit.signal, detail }
      return false
    }
    if (!startup.ok) {
      handle.error = { kind: 'healthTimeout' }
      return false
    }
    try {
      writeStartupMarker(desktopHome(), app.getVersion())
    } catch (error) {
      log(`[shell] WARN startup marker not written: ${String(error)}\n`)
    }
    return true
  })().catch((error: unknown) => {
    const detail = String(error)
    handle.error = { kind: 'startupFailed', detail }
    log(`[shell] ERROR backend startup failed: ${detail}\n`)
    return false
  })

  return handle
}

export function stopBackend(handle: BackendHandle | null): void {
  if (!handle) return
  handle.stopping = true
  if (!handle.proc || handle.proc.killed) return
  try {
    handle.proc.kill('SIGTERM')
    const proc = handle.proc
    setTimeout(() => {
      if (proc && !proc.killed) {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }, FORCE_KILL_DELAY_MS)
  } catch {
    /* ignore */
  }
}
