import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import type { TestInfo } from '@playwright/test'
import { ONBOARDING_GROUPS } from '../../src/onboarding.ts'

const CONFIG_FILE = 'config.json'
const MODEL_PROFILES_FILE = 'model_profiles.json'
const SERVICE_SETTINGS_FILE = 'settings.json'

/**
 * 界面语言偏好的落盘文件名，与 `src/main/preferences.ts` 里的同名常量保持一致。
 * 刻意不 import 那个模块：它 import electron，会把主进程依赖拉进 Playwright fixture。
 */
const RENDERER_PREFERENCES_FILE = 'renderer-preferences.json'

/**
 * e2e 固定跑的界面语言。隔离出来的 userData 是全新空目录，偏好文件必然缺失，产品的
 * 「首次运行按环境检测默认语言」就会跑在 CI 机器的时区/locale 上；而多处 spec 直接断言
 * 中文界面文案（`assistant.spec.ts` 的「引用对话」、`update.spec.ts` 的「软件更新」等），
 * 语言一漂整套就红。用例测试目标不是首次引导时，播种已完成引导的测试用户状态；
 * 专门测试引导的用例可覆盖此文件。只改测试侧初始状态，不动生产代码。
 */
const E2E_INTERFACE_LANGUAGE = 'zh'

/** macOS 的 AF_UNIX sun_path 上限；serve 的 bridge socket 必须落在它之内。 */
const AF_UNIX_PATH_LIMIT = 104

/** home 下 bridge socket 相对 home 的深度（service/bridge/endpoint-XXXXXXXX/api.sock）。 */
const BRIDGE_SOCKET_DEPTH = 48

/** mkdtemp 短根的前缀。 */
const SHORT_HOME_PREFIX = 'scholarseed-e2e-'

/**
 * home 的短根。serve 会在 `<home>/service/bridge/endpoint-XXXXXXXX/api.sock` 绑
 * AF_UNIX socket，macOS 的 sun_path 只有 104 字符；Playwright 的
 * `test-results/<slug>/runtime` 本身约 118 字符，home 放那儿 serve 必然
 * `OSError: AF_UNIX path too long` 起不来，而表象只是产品窗口超时，极难归因。
 * 因此 home 单独 mkdtemp 到短根下。`os.tmpdir()` 在 macOS 上就是
 * `/var/folders/...` 长路径，只有当它本身够短时才能用。
 */
export function runtimeHomeRoot(platform = process.platform, candidate = tmpdir()): string {
  if (platform === 'win32') return candidate
  const budget = AF_UNIX_PATH_LIMIT - BRIDGE_SOCKET_DEPTH - SHORT_HOME_PREFIX.length - 8
  return candidate.length <= budget ? candidate : '/tmp'
}

export interface RuntimePaths {
  root: string
  home: string
  workspace: string
  userData: string
  drive: string
  artifacts: string
}

/**
 * 把固定的界面语言播进隔离 userData。导出给不用 `createRuntime` 的 spec 复用
 * （`e2e/update.spec.ts` 自建 userData），避免文件名与语言两处各写一份而漂移。
 */
export function seedRendererPreferences(userData: string): void {
  writeFileSync(
    join(userData, RENDERER_PREFERENCES_FILE),
    JSON.stringify({ language: E2E_INTERFACE_LANGUAGE,
      onboarding: { seen: Object.fromEntries(ONBOARDING_GROUPS.map((group) => [group, true])) } })
  )
}

export function createRuntime(testInfo: TestInfo): RuntimePaths {
  const root = testInfo.outputPath('runtime')
  const home = realpathSync.native(mkdtempSync(join(runtimeHomeRoot(), SHORT_HOME_PREFIX)))
  const paths = {
    root,
    home,
    // Keep native directory-family leases outside the developer's checkout ancestors.
    workspace: join(home, 'workspace'),
    userData: join(root, 'electron-user-data'),
    drive: join(root, 'drive'),
    artifacts: join(root, 'artifacts'),
  }
  Object.values(paths).forEach((path) => mkdirSync(path, { recursive: true }))
  // The public desktop migration treats this marker as an already initialized home.
  // Pre-seeding runtime state avoids reading or adopting the developer's real ~/.scholarseed.
  writeFileSync(join(paths.home, '.adopted-from-veda'), 'isolated Playwright runtime\n')
  seedRendererPreferences(paths.userData)
  return paths
}

export async function withIsolatedRuntime<T>(testInfo: TestInfo,
  operation: (runtime: RuntimePaths) => Promise<T>): Promise<T> {
  const runtime = createRuntime(testInfo)
  try {
    return await operation(runtime)
  } finally {
    rmSync(runtime.home, { recursive: true, force: true })
  }
}

export function seedLiveConfig(paths: RuntimePaths): string | null {
  const configured = process.env.SCHOLARSEED_REAL_HOME
  if (!configured) return 'SCHOLARSEED_REAL_HOME is not set'
  const source = join(resolve(configured), CONFIG_FILE)
  if (!existsSync(source)) return `real LLM config is missing: ${source}`
  // Copy the real endpoint configuration into isolated runtime state.
  const config = JSON.parse(readFileSync(source, 'utf8')) as Record<string, unknown>
  const model =
    process.env.SCHOLARSEED_ACTION_MODEL ?? config.selected_model_key ?? config.model_name
  if (typeof model !== 'string' || !model.trim()) return 'real model connection is not configured'
  writeFileSync(join(paths.home, CONFIG_FILE), JSON.stringify(config, null, 2))
  const profiles = join(resolve(configured), MODEL_PROFILES_FILE)
  if (existsSync(profiles)) copyFileSync(profiles, join(paths.home, MODEL_PROFILES_FILE))
  const service = join(paths.home, 'service')
  mkdirSync(service, { recursive: true })
  writeFileSync(
    join(service, SERVICE_SETTINGS_FILE),
    JSON.stringify({ codex_model: model }, null, 2)
  )
  return null
}
