/**
 * 设计系统复用扫描器 (renderer 侧原生控件禁令 + 棘轮基线)。
 *
 * 单一实现, 三个消费者共用, 保证扫描口径完全一致:
 * - `scripts/reuse.test.mjs`  门禁 (npm test)
 * - `.agents/skills/ui-component-reuse/scripts/find.mjs`  意图检索 / 自查
 * - 本文件 CLI                 报告与基线重写
 *
 * 策略是数据: 禁用标签、扫描根、豁免路径都在 `reuse.policy.json`;
 * 意图与替代关系在 `../src/renderer/src/components/ui/registry.ts`。
 *
 * CLI:
 *   node --experimental-transform-types scripts/reuse.mjs --report
 *   node --experimental-transform-types scripts/reuse.mjs --write-baseline
 *
 * 棘轮语义: 逐文件计数只允许降不允许升; 未登记的文件额度为 0; 计数下降后必须
 * 重写基线(所以归零的文件会被移出基线, 之后任何一处新增都是红)。
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NATIVE_TAGS, NON_COMPONENT_EXPORTS, UI_REGISTRY } from '../src/renderer/src/components/ui/registry.ts'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))

export const DESKTOP_DIR = resolve(SCRIPTS_DIR, '..')
export const POLICY_PATH = join(SCRIPTS_DIR, 'reuse.policy.json')
export const BASELINE_PATH = join(SCRIPTS_DIR, 'reuse.baseline.json')
export const INDEX_PATH = join(DESKTOP_DIR, 'src/renderer/src/components/ui/index.ts')
export const PREVIEW_PATH = join(DESKTOP_DIR, 'src/renderer/src/components/examples/ComponentsPage.tsx')

const BASELINE_COMMENT_KEY = '$comment'
const TYPE_EXPORT_PREFIX = 'type '
const POSIX_SEPARATOR = '/'

export function loadPolicy() {
  return JSON.parse(readFileSync(POLICY_PATH, 'utf8'))
}

export function loadBaseline() {
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  const counts = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === BASELINE_COMMENT_KEY) continue
    counts[key] = value
  }
  return counts
}

/** 相对 scanRoot 的 posix 路径, 用作基线的键。 */
function toKey(policy, absolutePath) {
  return relative(join(DESKTOP_DIR, policy.scanRoot), absolutePath).split(/[\\/]/).join(POSIX_SEPARATOR)
}

function isExcluded(policy, absolutePath) {
  const unified = absolutePath.split(/[\\/]/).join(POSIX_SEPARATOR)
  return policy.excludePathFragments.some((fragment) => unified.includes(fragment))
}

function collectFiles(policy, dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectFiles(policy, full, out)
      continue
    }
    if (!policy.extensions.some((extension) => entry.name.endsWith(extension))) continue
    if (isExcluded(policy, full)) continue
    out.push(full)
  }
  return out
}

function tagPattern(policy) {
  return new RegExp(`<(${policy.bannedTags.join('|')})(?=[\\s/>])`, 'g')
}

/**
 * 扫描全树。返回逐文件计数(仅含非零)与逐处命中(带行号与标签), 供报告与门禁复用。
 *
 * 必须整文件匹配而不是逐行匹配: JSX 常写成 `<button\n  type="button"`, 逐行时
 * `(?=[\s/>])` 前视会落在行尾之外从而漏计。
 */
export function scan(policy = loadPolicy()) {
  const root = join(DESKTOP_DIR, policy.scanRoot)
  const files = collectFiles(policy, root, []).sort()
  const pattern = tagPattern(policy)
  const counts = {}
  const hits = []
  for (const file of files) {
    const key = toKey(policy, file)
    const source = readFileSync(file, 'utf8')
    const lineStarts = [0]
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === '\n') lineStarts.push(index + 1)
    }
    pattern.lastIndex = 0
    let match = pattern.exec(source)
    while (match !== null) {
      let line = lineStarts.length
      while (line > 1 && lineStarts[line - 1] > match.index) line -= 1
      hits.push({ file: key, line, tag: match[1] })
      counts[key] = (counts[key] ?? 0) + 1
      match = pattern.exec(source)
    }
  }
  return { files: files.map((file) => toKey(policy, file)), counts, hits }
}

/**
 * 棘轮比对。
 * - `regressions`: 超出基线额度(含未登记文件的 0 额度)
 * - `improvements`: 低于基线额度, 必须重写基线把额度收紧
 * - `stale`: 基线里的文件已不存在
 */
export function diffAgainstBaseline(counts, baseline, existingFiles) {
  const regressions = []
  const improvements = []
  const stale = []
  const present = new Set(existingFiles)
  for (const [file, count] of Object.entries(counts)) {
    const allowed = baseline[file] ?? 0
    if (count > allowed) regressions.push({ file, count, allowed })
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    if (!present.has(file)) {
      stale.push({ file, allowed })
      continue
    }
    const count = counts[file] ?? 0
    if (count < allowed) improvements.push({ file, count, allowed })
  }
  return { regressions, improvements, stale }
}

/** `index.ts` 的值导出(排除 type-only)。门禁据此校验 registry 覆盖率。 */
export function readIndexValueExports() {
  const source = readFileSync(INDEX_PATH, 'utf8')
  const blocks = source.matchAll(/export\s*\{([^}]*)\}\s*from\s*'\.\/([A-Za-z]+)'/g)
  const byModule = {}
  for (const block of blocks) {
    const [, body, moduleName] = block
    const exports = body
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && !entry.startsWith(TYPE_EXPORT_PREFIX))
    byModule[moduleName] = [...(byModule[moduleName] ?? []), ...exports]
  }
  return byModule
}

/**
 * 由 registry 推导「原生标签 → 建议组件族」, 不另建第二份映射。
 *
 * 排序 = 最直接的替代品在前: 同名族(Button/Input/Table...) 优先, 其次是 `replaces`
 * 越窄越专一的族。否则 `<button>` 会抛出十六个候选, 使用者无法取舍。
 */
export function suggestionsByTag() {
  const byTag = {}
  for (const tag of NATIVE_TAGS) {
    byTag[tag] = Object.entries(UI_REGISTRY)
      .filter(([, entry]) => entry.replaces.includes(tag))
      .sort(([leftName, left], [rightName, right]) => {
        const leftExact = leftName.toLowerCase() === tag ? 0 : 1
        const rightExact = rightName.toLowerCase() === tag ? 0 : 1
        if (leftExact !== rightExact) return leftExact - rightExact
        if (left.replaces.length !== right.replaces.length) return left.replaces.length - right.replaces.length
        return leftName.localeCompare(rightName)
      })
      .map(([name]) => name)
  }
  return byTag
}

function writeBaseline(counts) {
  const ordered = { [BASELINE_COMMENT_KEY]: baselineComment() }
  for (const file of Object.keys(counts).sort()) ordered[file] = counts[file]
  writeFileSync(BASELINE_PATH, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8')
  return ordered
}

function baselineComment() {
  return '存量原生控件债务的棘轮基线: 逐文件额度只允许降不允许升, 未登记文件额度为 0。请用 `node --experimental-transform-types scripts/reuse.mjs --write-baseline` 重写, 不要手改。'
}

function report() {
  const policy = loadPolicy()
  const { counts, hits, files } = scan(policy)
  const total = hits.length
  const byTag = {}
  for (const hit of hits) byTag[hit.tag] = (byTag[hit.tag] ?? 0) + 1
  process.stdout.write(`scanned=${files.length} files, violations=${total}\n`)
  process.stdout.write(`by tag: ${JSON.stringify(byTag)}\n`)
  const suggestions = suggestionsByTag()
  for (const tag of policy.bannedTags) {
    process.stdout.write(`  ${tag} -> ${suggestions[tag].join(', ')}\n`)
  }
  for (const file of Object.keys(counts).sort()) {
    process.stdout.write(`${counts[file]}\t${file}\n`)
  }
  return total
}

const ARG_REPORT = '--report'
const ARG_WRITE_BASELINE = '--write-baseline'

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.includes(ARG_WRITE_BASELINE)) {
    const { counts } = scan()
    const written = writeBaseline(counts)
    const total = Object.entries(written)
      .filter(([key]) => key !== BASELINE_COMMENT_KEY)
      .reduce((sum, [, value]) => sum + value, 0)
    process.stdout.write(`baseline written: ${Object.keys(written).length - 1} files, ${total} violations\n`)
  } else if (args.includes(ARG_REPORT) || args.length === 0) {
    report()
  } else {
    process.stdout.write(`usage: reuse.mjs [${ARG_REPORT}|${ARG_WRITE_BASELINE}]\n`)
    process.exitCode = 1
  }
}

export { NATIVE_TAGS, NON_COMPONENT_EXPORTS, UI_REGISTRY }
