// project.ts — infrastructure awaiting first consumer.
// TODO(e2e): buildProject / buildScenario / loadScenario currently have no spec
// consumers (verified by `grep -rn 'buildProject\|buildScenario\|loadScenario' e2e/*.spec.ts`).
// Kept as the seeding backbone for upcoming scenario-driven specs; wire the first
// consumer or re-evaluate removal when the next e2e scenario spec lands.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { expect, type Page } from '@playwright/test'
import { apiBase, enterWorkbenchShell } from '../electron'
import type { RuntimePaths } from '../runtime'

const ACTION_TIMEOUT_MS = 15_000
const RESOURCES_DIRNAME = 'resources'
const TOPBAR_PROJECT_TEST_ID = 'topbar-project'
const ACTIVITY_RESOURCE_TEST_ID = 'activity-resource'
const RESOURCE_REFRESH_TEST_ID = 'resource-refresh'
const SCENARIO_FILE = 'scenario.json'

/** 标准测试数据集根目录；`FileEntry.contentFrom` 一律相对它解析。 */
export const DATA_ROOT = resolve(__dirname, '..', 'data')

/**
 * 项目级设置。当前产品还没有可由测试播种的项目设置面，先以开放记录占位；
 * builder 收到非空 settings 时会显式报错而不是静默忽略。
 */
export type ProjectSettings = Record<string, unknown>

export interface FileEntry {
  /** 相对项目 `resources/` 的路径，可含子目录。 */
  path: string
  /** 内联文本内容。与 `contentFrom` 二选一。 */
  content?: string
  /** `e2e/fixtures/data/` 下的 fixture 文件路径。与 `content` 二选一。 */
  contentFrom?: string
  /** 为 true 时 `contentFrom` 按二进制 Buffer 读取。 */
  binary?: boolean
}

export interface SessionMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface SessionDescriptor {
  title: string
  messages: SessionMessage[]
  /** 会话过程中产生的文件（相对项目 `resources/`）。 */
  artifacts?: string[]
}

export interface ProjectDescriptor {
  name: string
  files: FileEntry[]
  sessions?: SessionDescriptor[]
  settings?: Partial<ProjectSettings>
}

export interface ScenarioDescriptor {
  id: string
  description?: string
  project?: ProjectDescriptor
  auth?: 'none' | 'logged-in' | 'subscription'
  /** 相对 scenario 目录的 drive 指令文件。 */
  drive?: string
  expected?: Record<string, unknown>
}

export interface ProjectHandle {
  id: string
  name: string
  root: string
  /** 项目资料目录绝对路径，文件断言直接以它为根。 */
  resources: string
}

interface ProjectPayload {
  id: string
  name: string
  root: string
}

/** target 必须严格落在 root 内部（相对路径非空、不越级、不是绝对路径）。 */
function escapesRoot(root: string, target: string): boolean {
  const inside = relative(root, target)
  return !inside || inside.startsWith('..') || isAbsolute(inside)
}

function readFixture(entry: FileEntry): string | Buffer {
  const source = resolve(DATA_ROOT, entry.contentFrom ?? '')
  if (!entry.contentFrom || escapesRoot(DATA_ROOT, source)) {
    throw new Error(`FileEntry.contentFrom must stay under ${DATA_ROOT}: ${entry.path}`)
  }
  if (!existsSync(source)) throw new Error(`fixture file is missing: ${source}`)
  return entry.binary ? readFileSync(source) : readFileSync(source, 'utf8')
}

function writeFileEntry(resources: string, entry: FileEntry): void {
  const hasInline = entry.content !== undefined
  const hasFixture = entry.contentFrom !== undefined
  if (hasInline === hasFixture) {
    throw new Error(`FileEntry needs exactly one of content/contentFrom: ${entry.path}`)
  }
  const target = resolve(resources, entry.path)
  if (escapesRoot(resources, target)) {
    throw new Error(`FileEntry.path must stay under project resources/: ${entry.path}`)
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, hasInline ? entry.content! : readFixture(entry))
}

async function selectProjectByName(page: Page, name: string): Promise<void> {
  await page.getByTestId(TOPBAR_PROJECT_TEST_ID).click()
  await page.getByTestId(`project-menu-option-${name}`).click()
  await page.getByTestId(ACTIVITY_RESOURCE_TEST_ID).click()
}

/**
 * 按声明式 descriptor 构建项目：走真实的 `/api/content/projects` 创建接口，
 * 把文件物化进项目 `resources/`，再 reload → 进入工作台 → 选中项目 → 刷新资源，
 * 与 `seedProject()` 的时序一致，可直接替换。
 *
 * sessions/settings 的物化路径尚未接入产品 API；显式报错而不是静默丢弃，
 * 避免测试以为播了历史其实没播。
 */
export async function buildProject(
  page: Page,
  runtime: RuntimePaths,
  descriptor: ProjectDescriptor
): Promise<ProjectHandle> {
  if (descriptor.sessions?.length) {
    throw new Error('buildProject: session seeding is not supported yet; omit descriptor.sessions')
  }
  if (descriptor.settings && Object.keys(descriptor.settings).length > 0) {
    throw new Error('buildProject: project settings seeding is not supported yet; omit descriptor.settings')
  }
  page.setDefaultTimeout(ACTION_TIMEOUT_MS)
  const response = await page.request.post(`${await apiBase(page)}/api/content/projects`, {
    data: { name: descriptor.name }
  })
  expect(response.ok(), await response.text()).toBe(true)
  const project = (await response.json()) as ProjectPayload
  expect(relative(runtime.workspace, project.root).startsWith('..')).toBe(false)
  const resources = join(project.root, RESOURCES_DIRNAME)
  mkdirSync(resources, { recursive: true })
  for (const entry of descriptor.files) writeFileEntry(resources, entry)
  await page.reload()
  await enterWorkbenchShell(page)
  await selectProjectByName(page, descriptor.name)
  await page.getByTestId(RESOURCE_REFRESH_TEST_ID).click()
  return { id: project.id, name: project.name, root: project.root, resources }
}

/** 读取 `e2e/fixtures/data/<name>/scenario.json` 并做最小结构校验。 */
export function loadScenario(name: string): ScenarioDescriptor {
  const file = join(DATA_ROOT, name, SCENARIO_FILE)
  if (!existsSync(file)) throw new Error(`scenario descriptor is missing: ${file}`)
  const scenario = JSON.parse(readFileSync(file, 'utf8')) as ScenarioDescriptor
  if (typeof scenario.id !== 'string' || !scenario.id) {
    throw new Error(`scenario descriptor has no id: ${file}`)
  }
  if (scenario.project && !Array.isArray(scenario.project.files)) {
    throw new Error(`scenario project has no files array: ${file}`)
  }
  return scenario
}

/** `loadScenario` + `buildProject` 的组合入口；scenario 必须声明 project。 */
export async function buildScenario(
  page: Page,
  runtime: RuntimePaths,
  name: string
): Promise<ProjectHandle> {
  const scenario = loadScenario(name)
  if (!scenario.project) throw new Error(`scenario has no project to build: ${name}`)
  return buildProject(page, runtime, scenario.project)
}
