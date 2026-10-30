/**
 * 设计系统复用门禁。
 *
 * 三条不变量:
 * 1. **意图索引不落后于代码** —— `registry.ts` 必须覆盖 `ui/index.ts` 的每一个值导出。
 *    加组件不加意图即红, 这样索引不可能像 README 清单那样悄悄过期。
 * 2. **禁令有出路** —— `reuse.policy.json` 里每个被禁的原生标签, 都必须至少有一个
 *    组件族在 `replaces` 里认领它, 否则等于禁了却没给替代品。
 * 3. **存量只降不升** —— 逐文件棘轮基线, 未登记文件额度为 0。
 *
 * 修红办法都在断言消息里, 不需要回来读这段注释。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  BASELINE_PATH,
  DESKTOP_DIR,
  NATIVE_TAGS,
  NON_COMPONENT_EXPORTS,
  PREVIEW_PATH,
  UI_REGISTRY,
  diffAgainstBaseline,
  loadBaseline,
  loadPolicy,
  readIndexValueExports,
  scan,
  suggestionsByTag
} from '../reuse.mjs'

const WRITE_BASELINE_HINT = 'node --experimental-transform-types scripts/ci/reuse.mjs --write-baseline'
const REPORT_HINT = 'node --experimental-transform-types scripts/ci/reuse.mjs --report'

test('registry 覆盖 ui/index.ts 的每一个值导出', () => {
  const byModule = readIndexValueExports()
  const indexExports = new Set(Object.values(byModule).flat())
  const registered = new Set(NON_COMPONENT_EXPORTS)
  for (const entry of Object.values(UI_REGISTRY)) {
    for (const name of entry.exports) registered.add(name)
  }
  const missing = [...indexExports].filter((name) => !registered.has(name)).sort()
  const extra = [...registered].filter((name) => !indexExports.has(name)).sort()
  assert.deepEqual(
    missing,
    [],
    `这些导出没有意图元数据, 请在 components/ui/registry.ts 里补 intents/use/replaces/avoid: ${missing.join(', ')}`
  )
  assert.deepEqual(
    extra,
    [],
    `registry 里登记了 index.ts 不再导出的名字, 请删除: ${extra.join(', ')}`
  )
})

test('registry 的族名与 index.ts 的来源模块一一对应', () => {
  const byModule = readIndexValueExports()
  const modules = Object.keys(byModule).filter((name) => byModule[name].length > 0)
  const nonComponentModules = modules.filter((name) =>
    byModule[name].every((exported) => NON_COMPONENT_EXPORTS.includes(exported))
  )
  const expected = modules.filter((name) => !nonComponentModules.includes(name)).sort()
  assert.deepEqual(
    Object.keys(UI_REGISTRY).sort(),
    expected,
    'registry 的键必须等于 index.ts 中承载组件的来源模块名(便于按文件定位实现)'
  )
  for (const [family, entry] of Object.entries(UI_REGISTRY)) {
    assert.deepEqual(
      [...entry.exports].sort(),
      [...byModule[family]].sort(),
      `${family} 的 exports 必须与 index.ts 中该模块的值导出完全一致`
    )
  }
})

test('每条意图元数据都可检索且有反模式', () => {
  for (const [family, entry] of Object.entries(UI_REGISTRY)) {
    assert.ok(entry.intents.length >= 3, `${family}.intents 至少 3 个关键词, 否则检索不到`)
    assert.ok(
      entry.intents.some((intent) => /[\u4e00-\u9fa5]/.test(intent)),
      `${family}.intents 需要至少一个中文关键词(开发者按中文意图检索)`
    )
    assert.ok(entry.use.length > 0, `${family}.use 不能为空`)
    assert.ok(entry.avoid.length > 0, `${family}.avoid 不能为空: 没有反模式就无法阻止误用`)
    for (const tag of entry.replaces) {
      assert.ok(NATIVE_TAGS.includes(tag), `${family}.replaces 含未登记标签 ${tag}, 请先加进 NATIVE_TAGS`)
    }
  }
})

test('每个被禁标签都有认领它的替代组件', () => {
  const policy = loadPolicy()
  const suggestions = suggestionsByTag()
  for (const tag of policy.bannedTags) {
    assert.ok(NATIVE_TAGS.includes(tag), `policy.bannedTags 含未登记标签 ${tag}`)
    assert.ok(
      suggestions[tag].length > 0,
      `禁用了 <${tag}> 却没有任何组件在 registry.replaces 里认领它 —— 禁令必须给出出路`
    )
  }
})

test('组件预览页覆盖全部组件族', () => {
  const preview = readFileSync(PREVIEW_PATH, 'utf8')
  const uncovered = Object.keys(UI_REGISTRY).filter((family) => !preview.includes(family))
  assert.deepEqual(
    uncovered,
    [],
    `这些组件族在 components/examples/ComponentsPage.tsx 里没有出现, 开发者无法在 ?dev=components 预览: ${uncovered.join(', ')}`
  )
})

test('存量原生控件棘轮: 只降不升', () => {
  const policy = loadPolicy()
  assert.ok(existsSync(BASELINE_PATH), `基线缺失, 请运行 ${WRITE_BASELINE_HINT}`)
  const { counts, files } = scan(policy)
  const baseline = loadBaseline()
  const { regressions, improvements, stale } = diffAgainstBaseline(counts, baseline, files)

  const regressionLines = regressions.map(
    ({ file, count, allowed }) => `  ${file}: ${count} 处 > 允许 ${allowed} 处`
  )
  assert.deepEqual(
    regressions,
    [],
    [
      `新增了原生 <${policy.bannedTags.join('> / <')}>:`,
      ...regressionLines,
      '',
      `请改用 components/ui 的组件。查候选: node .agents/skills/ui-component-reuse/scripts/find.mjs "<你的意图>"`,
      `确实缺组件 -> 加到 components/ui/ 并登记 registry.ts, 不要在页面里自造。`,
      `看逐处位置: ${REPORT_HINT}`
    ].join('\n')
  )

  assert.deepEqual(
    stale,
    [],
    `基线里的文件已不存在, 请运行 ${WRITE_BASELINE_HINT}: ${stale.map(({ file }) => file).join(', ')}`
  )

  const improvementLines = improvements.map(
    ({ file, count, allowed }) => `  ${file}: ${allowed} -> ${count}`
  )
  assert.deepEqual(
    improvements,
    [],
    [
      '存量债务减少了, 但基线还是旧额度 —— 必须收紧, 否则这些位置可以悄悄回退:',
      ...improvementLines,
      '',
      `请运行 ${WRITE_BASELINE_HINT}`
    ].join('\n')
  )
})

test('基线不覆盖设计系统自身与夹具', () => {
  const policy = loadPolicy()
  const baseline = loadBaseline()
  for (const file of Object.keys(baseline)) {
    for (const fragment of policy.excludePathFragments) {
      assert.ok(
        !`/${file}`.includes(fragment),
        `${file} 命中豁免规则 ${fragment}, 不应出现在基线里`
      )
    }
    assert.ok(
      existsSync(join(DESKTOP_DIR, policy.scanRoot, file)),
      `基线条目 ${file} 不存在, 请运行 ${WRITE_BASELINE_HINT}`
    )
  }
})
