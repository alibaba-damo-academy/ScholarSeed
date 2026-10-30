import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { block } from '../../../../test-helpers/source-contract.ts'
import { highlightRanges } from './highlight.ts'

/**
 * JSX components cannot be imported directly by node's type transform. Execute
 * selected production expressions through TypeScript for filtering/grouping,
 * and inspect syntax for UI imports. Remaining text contracts cover wiring;
 * backend request behavior is tested in ./api.test.ts.
 */
const searchSource = readFileSync(new URL('./GlobalSearch.tsx', import.meta.url), 'utf8')
const navigationSource = readFileSync(new URL('../project/Navigation.tsx', import.meta.url), 'utf8')

test('project header opens the shared all-domain search without changing project scope', () => {
  const parsed = ts.createSourceFile(
    'Navigation.tsx',
    navigationSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const handlers: ts.Expression[] = []
  function visit(node: ts.Node): void {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute)
      const search = attributes.some(
        (attribute) =>
          attribute.name.getText(parsed) === 'data-testid' &&
          attribute.initializer &&
          ts.isStringLiteral(attribute.initializer) &&
          attribute.initializer.text === 'project-search'
      )
      if (search) {
        const handler = attributes.find((attribute) => attribute.name.getText(parsed) === 'onClick')
        if (
          handler?.initializer &&
          ts.isJsxExpression(handler.initializer) &&
          handler.initializer.expression
        )
          handlers.push(handler.initializer.expression)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.equal(handlers.length, 1, 'project header must expose one shared-search trigger')
  const initial = {
    homeSelectedProjectId: 'project-alpha',
    globalSearchOpen: false,
    globalSearchMode: 'files',
  }
  let state = initial
  const javascript = ts.transpileModule(`const handler = ${handlers[0].getText(parsed)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const handler = new Function('set', javascript + '\nreturn handler;')(
    (patch: Partial<typeof initial>) => {
      state = { ...state, ...patch }
    }
  )
  handler()
  assert.deepEqual(state, { ...initial, globalSearchOpen: true, globalSearchMode: 'all' })
})

const parsedSearch = ts.createSourceFile(
  'GlobalSearch.tsx',
  searchSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)

test('search and recent rows own their block layout instead of inheriting button flex styles', () => {
  const rows: ts.JsxOpeningElement[] = []
  function visit(node: ts.Node): void {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(parsedSearch) === 'Button') {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute)
      if (
        attributes.some(
          (attribute) =>
            attribute.name.getText(parsedSearch) === 'className' &&
            attribute.initializer?.getText(parsedSearch) === '{SEARCH_ROW_CLASS}'
        )
      ) {
        rows.push(node)
        assert.ok(
          attributes.some(
            (attribute) =>
              attribute.name.getText(parsedSearch) === 'unstyled' && !attribute.initializer
          ),
          'result rows must opt out of centered button layout'
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parsedSearch)
  assert.equal(rows.length, 2)
})

function evaluateExpression(
  select: (node: ts.Node) => ts.Expression | undefined,
  bindings: Record<string, unknown>
): unknown {
  const expressions: ts.Expression[] = []
  function visit(node: ts.Node): void {
    const expression = select(node)
    if (expression) expressions.push(expression)
    ts.forEachChild(node, visit)
  }
  visit(parsedSearch)
  assert.equal(expressions.length, 1, 'expected one production expression')
  const js = ts.transpileModule(`const value = ${expressions[0].getText(parsedSearch)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  return new Function(...Object.keys(bindings), js + '\nreturn value;')(...Object.values(bindings))
}

test('typing is debounced and every superseded request is cancelled', () => {
  assert.match(searchSource, /const SEARCH_DEBOUNCE_MS = 240/)
  const effect = block(
    searchSource,
    'useEffect(() => {\n    const keyword = query.trim()',
    'const openHit = '
  )
  assert.match(effect, /const controller = new AbortController\(\)/)
  assert.match(effect, /const generation = \+\+requestGeneration\.current/)
  assert.match(effect, /\}, SEARCH_DEBOUNCE_MS\)/)
  assert.match(effect, /window\.clearTimeout\(timer\)\s*controller\.abort\(\)/)
  // 成功腿与失败腿都必须认「已被取代」，否则慢响应会把新关键词的结果覆盖掉。
  assert.equal(effect.match(/generation !== requestGeneration\.current/g)?.length, 2)
  assert.equal(effect.match(/controller\.signal\.aborted \|\|/g)?.length, 2)
})

test('an empty query returns to the recent view instead of showing stale hits', () => {
  const effect = block(
    searchSource,
    'useEffect(() => {\n    const keyword = query.trim()',
    'const openHit = '
  )
  // 关键词变化先清掉各组展开量，再决定是回最近打开还是发请求。
  assert.match(effect, /setExpanded\(\{\}\)/)
  assert.match(
    effect,
    /if \(!keyword\) \{\s*setHits\(null\)\s*setCounts\(\{\}\)\s*setLoading\(false\)\s*return\s*\}/
  )
  // hits === null 是「还没搜」的语义，与「搜了没命中」的 [] 必须分开。
  assert.match(searchSource, /hits === null \?/)
})

test('files-only mode narrows rows, counts and rendered groups together', () => {
  assert.match(searchSource, /const filesOnly = state\.globalSearchMode === 'files'/)
  const result = {
    hits: [
      { domain: 'resource', id: 'file' },
      { domain: 'session', id: 'chat' },
    ],
    groups: { resource: { total: 12, truncated: true }, session: { total: 1, truncated: false } },
  }
  for (const filesOnly of [true, false]) {
    for (const response of [result, undefined]) {
      const argument = (name: string) => (node: ts.Node) =>
        ts.isCallExpression(node) &&
        node.expression.getText(parsedSearch) === name &&
        node.arguments[0] &&
        ts.isConditionalExpression(node.arguments[0])
          ? node.arguments[0]
          : undefined
      const hits = evaluateExpression(argument('setHits'), { filesOnly, result: response })
      const counts = evaluateExpression(argument('setCounts'), { filesOnly, result: response })
      assert.deepEqual(hits, response ? (filesOnly ? [result.hits[0]] : result.hits) : [])
      assert.deepEqual(
        counts,
        filesOnly
          ? { resource: response?.groups.resource ?? { total: 0, truncated: false } }
          : (response?.groups ?? {})
      )
      const grouped = evaluateExpression(
        (node) =>
          ts.isVariableDeclaration(node) && node.name.getText(parsedSearch) === 'grouped'
            ? node.initializer
            : undefined,
        { filesOnly, hits, DOMAIN_ORDER: ['resource', 'literature', 'session'] }
      )
      assert.deepEqual(
        grouped,
        (filesOnly ? ['resource'] : ['resource', 'literature', 'session'])
          .map((domain) => ({
            domain,
            rows: (response?.hits ?? []).filter((hit) => hit.domain === domain),
          }))
          .filter((group) => group.rows.length > 0)
      )
    }
  }
  // 关闭面板要把模式复位，否则下次打开仍是「仅文件」这个隐形过滤。
  assert.match(searchSource, /set\(\{ globalSearchOpen: false, globalSearchMode: 'all' \}\)/)
})

test('group counts come from the backend window and a truncated window reads as N-plus', () => {
  const render = block(searchSource, 'grouped.map((group) => {', 'hasMore && (')
  assert.match(render, /const count = counts\[group\.domain\]/)
  assert.match(render, /const total = count\?\.total \?\? group\.rows\.length/)
  assert.match(render, /const truncated = count\?\.truncated === true/)
  assert.match(searchSource, /truncated \? `\$\{total\}\+` : total/)
  assert.match(searchSource, /data-testid=\{`search-count-\$\{group\.domain\}`\}/)
})

test('each group paginates from three rows and expands by ten', () => {
  assert.match(searchSource, /const GROUP_INITIAL_ROWS = 3/)
  assert.match(searchSource, /const GROUP_EXPAND_STEP = 10/)
  assert.match(
    searchSource,
    /const shown = Math\.min\(\s*expanded\[group\.domain\] \?\? GROUP_INITIAL_ROWS,\s*group\.rows\.length\s*\)/
  )
  assert.match(searchSource, /const hasMore = shown < group\.rows\.length/)
  assert.match(searchSource, /\[group\.domain\]: shown \+ GROUP_EXPAND_STEP/)
  assert.match(searchSource, /group\.rows\.slice\(0, shown\)/)
  // 已经全展开才提示「后端还有更多」；还能点「更多」时提示会自相矛盾。
  assert.match(searchSource, /!hasMore && truncated &&/)
})

test('empty results use one compact message rather than empty domain sections', () => {
  assert.doesNotMatch(searchSource, /data-testid=\{`search-empty-\$\{group\.domain\}`\}/)
  assert.match(searchSource, /grouped\.length === 0/)
  assert.match(searchSource, /data-testid="search-empty"/)
})

test('a resource hit reveals the matched text, a session hit jumps to the located turn', () => {
  const openHit = block(searchSource, 'const openHit = (hit: GlobalHit)', 'const grouped = ')
  assert.match(
    openHit,
    /if \(hit\.domain === 'resource'\) \{\s*act\.openWorkbenchView\('resource'\)/
  )
  assert.match(
    openHit,
    /if \(hit\.reveal\) act\.revealResourceFile\(hit\.id, hit\.reveal\)\s*else act\.openResourceFile\(hit\.id\)/
  )
  // 命中可能来自尚未加载进树的会话：先在现有树里找，找不到再按命中合成一个可打开节点。
  assert.match(openHit, /const existing = findSessionNode\(state\.sessions, hit\.id\)/)
  assert.match(openHit, /hit\.title \|\| t\('search\.project\.untitledSession'\)/)
  assert.match(
    openHit,
    /act\.openPanelSession\(node, \{\s*turnId: hit\.locator\?\.turn_id,\s*itemId: hit\.locator\?\.item_id,?\s*\}\)/
  )
})

test('a literature hit carries the search scope across the jump and focuses after scoping', () => {
  const openHit = block(searchSource, 'const openHit = (hit: GlobalHit)', 'const grouped = ')
  assert.match(openHit, /act\.openWorkbenchView\('literature', \{ preserveProject: true \}\)/)
  // 顺序是硬约束：先 scope 再 focus，否则 scope() 恢复存档会冲掉刚设的 focusedId。
  assert.match(
    openHit,
    /if \(projectId\) catalogue\.scope\(projectId\)\s*catalogue\.focus\(hit\.id\)/
  )
  assert.match(
    searchSource,
    /state\.mainView === 'literature'\s*\? \(literatureQuery\.project_id \?\? null\)\s*: state\.homeSelectedProjectId/
  )
})

test('every occurrence of the keyword is marked without rewriting the hit text', () => {
  const highlight = block(searchSource, 'function Highlight({', 'function resourceFileName(')
  // 区间计算下沉到 ./highlight.ts 的纯函数（行为测试见下），组件只按区间切片插标记。
  assert.match(highlight, /const ranges = highlightRanges\(text, keyword\)/)
  assert.match(highlight, /if \(ranges\.length === 0\) return <>\{text\}<\/>/)
  // 插标记用的是原文切片，不能把命中的大小写改掉。
  assert.match(highlight, /text\.slice\(range\.start, range\.end\)/)
  assert.match(
    highlight,
    /className="vds-search-mark bg-transparent text-\[var\(--vds-text-highlight\)\]"/
  )
  assert.match(highlight, /if \(cursor < text\.length\) parts\.push\(text\.slice\(cursor\)\)/)
  assert.equal(searchSource.match(/<Highlight text=/g)?.length, 2)
  assert.match(searchSource, /<Highlight text=\{hit\.title\} keyword=\{query\} \/>/)
  assert.match(searchSource, /<Highlight text=\{hit\.subtitle\} keyword=\{query\} \/>/)
})

test('highlightRanges finds every case-insensitive occurrence in source order', () => {
  assert.deepEqual(highlightRanges('Alpha beta ALPHA', 'alpha'), [
    { start: 0, end: 5 },
    { start: 11, end: 16 },
  ])
  // 关键词先 trim；命中区间对应原文切片，大小写保持原样。
  assert.deepEqual(highlightRanges('x Abc y', '  abc '), [{ start: 2, end: 5 }])
  assert.equal('x Abc y'.slice(2, 5), 'Abc')
})

test('highlightRanges returns empty for blank keyword or blank text', () => {
  assert.deepEqual(highlightRanges('anything', '   '), [])
  assert.deepEqual(highlightRanges('', 'key'), [])
  assert.deepEqual(highlightRanges('no match here', 'absent'), [])
})

test('highlightRanges never overlaps or stalls on adjacent occurrences', () => {
  // 游标越过本次命中：连续出现时逐个报告，不重叠、不死循环。
  assert.deepEqual(highlightRanges('aaa', 'a'), [
    { start: 0, end: 1 },
    { start: 1, end: 2 },
    { start: 2, end: 3 },
  ])
  // 多字符关键词同样不重叠：'aa' 在 'aaaa' 里只报两次。
  assert.deepEqual(highlightRanges('aaaa', 'aa'), [
    { start: 0, end: 2 },
    { start: 2, end: 4 },
  ])
})

test('recent-file rows show the bare file name and a project-relative path', () => {
  assert.match(searchSource, /const RESOURCE_PATH_PREFIX = 'resources\/'/)
  assert.match(searchSource, /path\.slice\(path\.lastIndexOf\('\/'\) \+ 1\)/)
  assert.match(
    searchSource,
    /path\.startsWith\(RESOURCE_PATH_PREFIX\)\s*\? path\.slice\(RESOURCE_PATH_PREFIX\.length\)\s*: path/
  )
})

test('the panel is dismissible from the backdrop, the escape key and its stable test ids', () => {
  assert.match(searchSource, /className="vds-modal-backdrop" onClick=\{close\}/)
  assert.match(searchSource, /if \(event\.key === 'Escape'\) close\(\)/)
  assert.match(searchSource, /data-testid="global-search"/)
  assert.match(searchSource, /data-testid="global-search-input"/)
  assert.match(searchSource, /data-testid="global-search-results"/)
  // 输入框必须走设计系统组件，不能是原生 input（reuse 棘轮的口径）。
  const imports = parsedSearch.statements
    .filter(ts.isImportDeclaration)
    .filter(
      (node) =>
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === '../../components/ui'
    )
    .flatMap((node) =>
      node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
        ? node.importClause.namedBindings.elements
            .filter((element) => !element.isTypeOnly && !node.importClause?.isTypeOnly)
            .map((element) => [element.propertyName?.text ?? element.name.text, element.name.text])
        : []
    )
  for (const name of ['Button', 'EmptyState', 'Input'])
    assert.ok(imports.some(([exported, local]) => exported === name && local === name))
  assert.doesNotMatch(searchSource, /<input[\s>]/)
})
