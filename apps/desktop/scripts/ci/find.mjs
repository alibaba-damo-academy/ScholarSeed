/**
 * 按意图查可复用组件。
 *
 * 存在理由: `components/ui/README.md` 是字母序清单, 从「做一个可多选的筛选栏」映射不到
 * 组件名, 于是手写 `<button>` 比查文档便宜。本脚本把检索成本压到一条命令。
 *
 * 真源是 `apps/desktop/src/renderer/src/components/ui/registry.ts` 与
 * `apps/desktop/scripts/ci/reuse.mjs`, 本脚本不另存组件清单, 因此不会过期。
 *
 * 用法(仓库根目录):
 *   node --experimental-transform-types apps/desktop/scripts/ci/find.mjs "多选 筛选"
 *   ... find.mjs "筛选" --from apps/desktop/src/renderer/src/features/literature/LiteratureList.tsx
 *   ... find.mjs --tag button
 *   ... find.mjs --check apps/desktop/src/renderer/src/features/literature/LiteratureList.tsx
 *   ... find.mjs --list
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DESKTOP_DIR,
  NATIVE_TAGS,
  PREVIEW_PATH,
  UI_REGISTRY,
  loadPolicy,
  scan,
  suggestionsByTag
} from './reuse.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '../../../..')

const UI_DIR = resolve(DESKTOP_DIR, 'src/renderer/src/components/ui')
const DEFAULT_LIMIT = 5
const CJK_PATTERN = /[\u4e00-\u9fa5]/
const TOKEN_SPLIT = /[\s,，、/|]+/

const SCORE_FAMILY_NAME = 100
const SCORE_EXPORT_NAME = 80
const SCORE_INTENT_EXACT = 40
const SCORE_INTENT_PARTIAL = 20
const SCORE_BIGRAM = 12
const SCORE_PROSE = 4
const CHECK_SUGGESTION_LIMIT = 4

const ARG_TAG = '--tag'
const ARG_FROM = '--from'
const ARG_CHECK = '--check'
const ARG_LIST = '--list'
const ARG_LIMIT = '--limit'

function bigrams(text) {
  const out = new Set()
  for (let index = 0; index + 1 < text.length; index += 1) {
    const pair = text.slice(index, index + 2)
    if (CJK_PATTERN.test(pair)) out.add(pair)
  }
  return [...out]
}

function score(family, entry, tokens, grams) {
  let total = 0
  const matched = new Set()
  const familyLower = family.toLowerCase()
  const prose = `${entry.use} ${entry.avoid}`.toLowerCase()

  for (const token of tokens) {
    if (familyLower === token) total += SCORE_FAMILY_NAME
    else if (familyLower.includes(token)) total += SCORE_EXPORT_NAME / 2
    if (entry.exports.some((name) => name.toLowerCase() === token)) total += SCORE_EXPORT_NAME
    for (const intent of entry.intents) {
      const intentLower = intent.toLowerCase()
      if (intentLower === token) {
        total += SCORE_INTENT_EXACT
        matched.add(intent)
      } else if (intentLower.includes(token) || token.includes(intentLower)) {
        total += SCORE_INTENT_PARTIAL
        matched.add(intent)
      }
    }
    if (prose.includes(token)) total += SCORE_PROSE
  }

  for (const gram of grams) {
    for (const intent of entry.intents) {
      if (intent.includes(gram)) {
        total += SCORE_BIGRAM
        matched.add(intent)
      }
    }
    if (prose.includes(gram)) total += SCORE_PROSE
  }

  return { total, matched: [...matched] }
}

function importLine(entry, fromPath) {
  const names = entry.exports.join(', ')
  if (fromPath === null) {
    return `import { ${names} } from '<相对路径>/components/ui'   // 传 --from <你的文件> 可得到确切路径`
  }
  const fromDir = dirname(resolve(REPO_ROOT, fromPath))
  let specifier = relative(fromDir, UI_DIR).split(/[\\/]/).join('/')
  if (!specifier.startsWith('.')) specifier = `./${specifier}`
  return `import { ${names} } from '${specifier}'`
}

function previewLocation(family) {
  if (!existsSync(PREVIEW_PATH)) return null
  const lines = readFileSync(PREVIEW_PATH, 'utf8').split('\n')
  // 优先定位真正的 JSX 用法而不是顶部 import 列表, 否则所有组件都指向同一段。
  const usage = lines.findIndex((line) => line.includes(`<${family}`))
  const offset = usage >= 0 ? usage : lines.findIndex((line) => line.includes(family))
  if (offset < 0) return null
  return `${relative(REPO_ROOT, PREVIEW_PATH)}:${offset + 1}`
}

function print(text) {
  process.stdout.write(`${text}\n`)
}

function describe(family, entry, fromPath, matched) {
  const suffix = matched.length > 0 ? `  ← 命中: ${matched.join(' / ')}` : ''
  print(`\n▎${family}${suffix}`)
  print(`  用途   ${entry.use}`)
  if (entry.replaces.length > 0) print(`  替代   <${entry.replaces.join('> <')}>`)
  print(`  慎用   ${entry.avoid}`)
  print(`  引入   ${importLine(entry, fromPath)}`)
  const source = resolve(UI_DIR, `${family}.tsx`)
  if (existsSync(source)) print(`  实现   ${relative(REPO_ROOT, source)}`)
  const preview = previewLocation(family)
  if (preview !== null) print(`  预览   ${preview}   (pnpm ops dev browser 后开 http://localhost:5173/?dev=components)`)
}

function runSearch(query, fromPath, limit) {
  const tokens = query.toLowerCase().split(TOKEN_SPLIT).filter((token) => token.length > 0)
  const grams = bigrams(query)
  const ranked = Object.entries(UI_REGISTRY)
    .map(([family, entry]) => ({ family, entry, ...score(family, entry, tokens, grams) }))
    .filter((candidate) => candidate.total > 0)
    .sort((left, right) => right.total - left.total || left.family.localeCompare(right.family))

  if (ranked.length === 0) {
    print(`没有命中 "${query}"。`)
    print('')
    print('下一步(按顺序):')
    print(`  1. 换个说法再查, 或 ${ARG_LIST} 通读全部 ${Object.keys(UI_REGISTRY).length} 个组件族;`)
    print('  2. 看能不能用现有组件组合出来(浮层 Popover + 列表 Command + 勾选 Checkbox 之类);')
    print('  3. 确认缺件 -> 先分类: 设计系统基础控件进 components/ui/ 并登记 registry.ts,')
    print('     业务组件进 components/business/, 通用非设计系统组件进 components/primitive/。')
    print('     **不要在页面里自造**。')
    return 1
  }

  print(`"${query}" 的候选(共 ${ranked.length} 个, 显示前 ${Math.min(limit, ranked.length)} 个):`)
  for (const candidate of ranked.slice(0, limit)) {
    describe(candidate.family, candidate.entry, fromPath, candidate.matched)
  }
  return 0
}

function runTag(tag) {
  if (!NATIVE_TAGS.includes(tag)) {
    print(`<${tag}> 未登记。已登记: ${NATIVE_TAGS.join(', ')}`)
    return 1
  }
  const families = suggestionsByTag()[tag]
  const policy = loadPolicy()
  const banned = policy.bannedTags.includes(tag)
  print(`<${tag}> ${banned ? '**门禁禁用**' : '(未纳入门禁, 但仍应优先用组件)'}, 替代品:`)
  for (const family of families) describe(family, UI_REGISTRY[family], null, [])
  return 0
}

function runCheck(target) {
  const policy = loadPolicy()
  const absolute = resolve(REPO_ROOT, target)
  const key = relative(resolve(DESKTOP_DIR, policy.scanRoot), absolute).split(/[\\/]/).join('/')
  const { hits } = scan(policy)
  const own = hits.filter((hit) => hit.file === key)
  if (own.length === 0) {
    print(`${key}: 没有被禁用的原生控件。`)
    return 0
  }
  const suggestions = suggestionsByTag()
  print(`${key}: ${own.length} 处原生控件`)
  for (const hit of own) {
    const candidates = suggestions[hit.tag]
    const shown = candidates.slice(0, CHECK_SUGGESTION_LIMIT).join(' / ')
    const rest = candidates.length > CHECK_SUGGESTION_LIMIT ? ` (+${candidates.length - CHECK_SUGGESTION_LIMIT})` : ''
    print(`  ${relative(REPO_ROOT, absolute)}:${hit.line}  <${hit.tag}>  ->  ${shown}${rest}`)
  }
  print('')
  print(`挑组件: find.mjs "<意图>" ${ARG_FROM} ${target}`)
  return 0
}

function runList() {
  const suggestions = suggestionsByTag()
  print(`${Object.keys(UI_REGISTRY).length} 个组件族:`)
  for (const [family, entry] of Object.entries(UI_REGISTRY)) {
    print(`  ${family.padEnd(16)} ${entry.intents.slice(0, 4).join(' / ')}`)
  }
  print('')
  const policy = loadPolicy()
  print('门禁禁用的原生标签及替代品:')
  for (const tag of policy.bannedTags) print(`  <${tag}> -> ${suggestions[tag].join(', ')}`)
  return 0
}

function valueOf(args, flag) {
  const index = args.indexOf(flag)
  if (index < 0 || index + 1 >= args.length) return null
  return args[index + 1]
}

const args = process.argv.slice(2)
const fromPath = valueOf(args, ARG_FROM)
const limitRaw = valueOf(args, ARG_LIMIT)
const limit = limitRaw === null ? DEFAULT_LIMIT : Number.parseInt(limitRaw, 10)
const flagValues = new Set([fromPath, limitRaw].filter((value) => value !== null))
const positional = args.filter(
  (arg) => !arg.startsWith('--') && !flagValues.has(arg)
)

if (args.includes(ARG_LIST)) {
  process.exitCode = runList()
} else if (args.includes(ARG_TAG)) {
  process.exitCode = runTag(valueOf(args, ARG_TAG) ?? '')
} else if (args.includes(ARG_CHECK)) {
  process.exitCode = runCheck(valueOf(args, ARG_CHECK) ?? '')
} else if (positional.length > 0) {
  process.exitCode = runSearch(positional.join(' '), fromPath, limit)
} else {
  print('用法:')
  print('  find.mjs "<意图>" [--from <文件>] [--limit N]   按意图找组件')
  print(`  find.mjs ${ARG_TAG} <button|input|select|table|textarea>  查某个原生标签的替代品`)
  print(`  find.mjs ${ARG_CHECK} <文件>                     列出该文件的原生控件与替代建议`)
  print(`  find.mjs ${ARG_LIST}                             通读全部组件族`)
  process.exitCode = 1
}
