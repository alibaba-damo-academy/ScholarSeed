/** Static visual debt identities. Design values belong to design/, never page literals. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import postcss from 'postcss'
import { readGitBlobs } from './git.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const PREFIX = 'apps/desktop/src/renderer/src/'
// Audited before the Page migration; never HEAD (committing must not forgive new debt).
export const VISUAL_BASE = 'a0e89c828949f83168fcf3687e21380238b42565'
const MAX_GIT_OUTPUT = 64 * 1024 * 1024
const EXCLUDED = /(?:\/design\/|\/assets\/|\/components\/examples\/|\/components\/primitive\/Iconfont\/download\/|\.test\.|\.fixture\.|\.d\.ts$)/
const VISUAL_PROPERTY = /^(?:zIndex|z-index|gap|rowGap|columnGap|(?:row|column)-gap|padding(?:[A-Z][a-z]+|-[a-z]+)*|margin(?:[A-Z][a-z]+|-[a-z]+)*|(?:min|max)?(?:Width|Height)|(?:min-|max-)?(?:width|height)|font(?:Size|Weight|Family)|font-(?:size|weight|family)|lineHeight|line-height|letterSpacing|letter-spacing|border(?:TopLeft|TopRight|BottomLeft|BottomRight|StartStart|StartEnd|EndStart|EndEnd)?Radius|border-(?:(?:top|bottom)-(?:left|right)-|(?:start|end)-(?:start|end)-)?radius|boxShadow|box-shadow|opacity)$/
const STRUCTURAL = /^(?:0(?:px|rem|em|%)?|auto|none|full|screen|svh|dvh|lvh|min|max|fit|100%|inherit|initial|unset|min-content|max-content|fit-content|\d+\/\d+)$/
const FIXED_UNIT = /(?:^|[^\w-])-?(?:\d*\.)?\d+(?:px|r?em|ch|vw|vh|vmin|vmax|pt|%)\b/
const GEOMETRY = /^(?:(?:min-|max-)?[wh]|size|basis|[mp][xytrblse]?|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left|start|end)-(.+)$/
const TYPE = /^(?:text|leading|tracking|font)-(.+)$/
const TYPE_SCALE = /^(?:xs|sm|base|lg|xl|[2-9]xl|thin|extralight|light|normal|medium|semibold|bold|extrabold|black|tight|tighter|wide|wider|widest|snug|relaxed|loose|sans|serif|mono|\d+(?:\.\d+)?)$/
const LAYER_TOKEN = /--vds-z-[\w-]+/g
const LAYER_TOKEN_SOURCE = resolve(ROOT, PREFIX, 'design/zindex.css')

function git(args, root = ROOT) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT })
}
function candidates(paths) {
  return [...new Set(paths)].filter((path) => path.startsWith(PREFIX) && /\.(?:tsx?|css)$/.test(path) && !EXCLUDED.test(path)).sort()
}

/** Split variants without splitting colons in arbitrary selectors/properties. */
function utilityOf(token) {
  let depth = 0
  let start = 0
  for (let index = 0; index < token.length; index++) {
    const char = token[index]
    if (char === '[' || char === '(') depth++
    if (char === ']' || char === ')') depth--
    if (char === ':' && depth === 0) start = index + 1
  }
  return token.slice(start).replace(/^!/, '').replace(/!$/, '').replace(/^-/, '')
}
function fixedValue(value) {
  const plain = value.trim().replaceAll('_', ' ')
  if (STRUCTURAL.test(plain)) return false
  if (FIXED_UNIT.test(plain)) return true // includes literals hidden in calc() / fallback
  if (/var\(|^--vds-/.test(plain)) return false
  return /\d/.test(plain)
}
export function isFixedVisualClass(token) {
  const utility = utilityOf(token)
  const property = /^\[([^:]+):(.+)\]$/.exec(utility)
  if (property) return VISUAL_PROPERTY.test(property[1]) && fixedValue(property[2])
  if (/^z-/.test(utility)) return utility !== 'z-auto' && !/^z-(?:\[var\(--vds-|\(--vds-)/.test(utility)
  const geometry = GEOMETRY.exec(utility)
  if (geometry) return fixedValue(geometry[1].replace(/^\[|\]$/g, '')) || geometry[1] === 'px'
  const radiusShadow = /^(?:rounded(?:-[trblse]{1,2})?|shadow)(?:-(.+))?$/.exec(utility)
  if (radiusShadow) {
    const value = radiusShadow[1] ?? 'default'
    return !STRUCTURAL.test(value) && !/^(?:\[var\(--vds-|\(--vds-)/.test(value)
  }
  const type = TYPE.exec(utility)
  if (type) return TYPE_SCALE.test(type[1]) || (type[1].startsWith('[') && fixedValue(type[1].slice(1, -1)))
  if (/^opacity-/.test(utility)) return fixedValue(utility.slice('opacity-'.length))
  return false
}
function ownerOf(node, file) {
  const owners = []
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ((ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name) {
      owners.unshift(parent.name.getText(file))
    }
  }
  return owners.join('/') || '<module>'
}
export function visualFindings(source, filename = 'source.tsx') {
  const hits = []
  const add = (owner, kind, value, line) => hits.push({ identity: JSON.stringify([owner, kind, value]), kind, value, line })
  if (filename.endsWith('.css')) {
    postcss.parse(source, { from: filename }).walkDecls((decl) => {
      if (!VISUAL_PROPERTY.test(decl.prop)) return
      const forbidden = decl.prop === 'z-index'
        ? decl.value !== 'auto' && !/^var\(--vds-[\w-]+\)$/.test(decl.value)
        : fixedValue(decl.value)
      if (!forbidden) return
      const parents = []
      for (let parent = decl.parent; parent?.type !== 'root'; parent = parent.parent) {
        parents.unshift(parent.selector ?? `@${parent.name} ${parent.params}`)
      }
      add(parents.join(' / '), decl.prop, decl.value, decl.source.start.line)
    })
    return hits
  }
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const lineOf = (node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
  const declarations = new Map()
  const isScope = (node) => ts.isSourceFile(node) || ts.isFunctionLike(node) || ts.isBlock(node) || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isCatchClause(node)
  function scopeOf(node, functionScoped = false) {
    return ts.findAncestor(node.parent, (parent) => functionScoped
      ? ts.isSourceFile(parent) || ts.isFunctionLike(parent)
      : isScope(parent))
  }
  function bind(name, scope, value) {
    if (ts.isIdentifier(name)) {
      const entries = declarations.get(name.text) ?? []
      entries.push({ scope, value })
      declarations.set(name.text, entries)
    } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name, scope, undefined)
    }
  }
  function collect(node) {
    if (ts.isVariableDeclaration(node)) {
      const list = node.parent
      const functionScoped = ts.isVariableDeclarationList(list) && !(list.flags & ts.NodeFlags.BlockScoped)
      bind(node.name, scopeOf(node, functionScoped), node.initializer)
    }
    // Parameters/destructuring shadow outer names; their runtime value is unknown.
    if (ts.isParameter(node)) bind(node.name, scopeOf(node), undefined)
    if (ts.isFunctionDeclaration(node) && node.name) bind(node.name, scopeOf(node), undefined)
    ts.forEachChild(node, collect)
  }
  collect(file)
  function initializer(node) {
    const entries = declarations.get(node.text) ?? []
    for (let scope = node.parent; scope; scope = scope.parent) {
      const match = entries.find((entry) => entry.scope === scope)
      if (match) return match.value
    }
  }
  function unwrap(node) {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression
    return node
  }
  function staticValue(node, seen = new Set()) {
    node = unwrap(node)
    if (!node || seen.has(node)) return undefined
    seen = new Set(seen).add(node)
    if (ts.isStringLiteralLike(node)) return node.text
    if (ts.isNumericLiteral(node)) return Number(node.text)
    if (ts.isIdentifier(node)) return staticValue(initializer(node), seen)
    if (ts.isPrefixUnaryExpression(node)) {
      const value = staticValue(node.operand, seen)
      if (typeof value !== 'number') return undefined
      if (node.operator === ts.SyntaxKind.MinusToken) return -value
      if (node.operator === ts.SyntaxKind.PlusToken) return value
    }
    if (ts.isBinaryExpression(node)) {
      const left = staticValue(node.left, seen)
      const right = staticValue(node.right, seen)
      if (typeof left === 'number' && typeof right === 'number') {
        switch (node.operatorToken.kind) {
          case ts.SyntaxKind.PlusToken: return left + right
          case ts.SyntaxKind.MinusToken: return left - right
          case ts.SyntaxKind.AsteriskToken: return left * right
          case ts.SyntaxKind.SlashToken: return right === 0 ? undefined : left / right
        }
      }
    }
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'Number' && node.arguments.length === 1) {
      const value = staticValue(node.arguments[0], seen)
      if (value !== undefined && Number.isFinite(Number(value))) return Number(value)
    }
    return undefined
  }
  const visitedClasses = new Set()
  function scanClass(node) {
    node = unwrap(node)
    if (!node || visitedClasses.has(node)) return
    visitedClasses.add(node)
    if (ts.isIdentifier(node)) { scanClass(initializer(node)); return }
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const token of node.text.split(/\s+/)) {
        if (isFixedVisualClass(token)) add(ownerOf(node, file), 'class', token, lineOf(node))
      }
      return
    }
    // Resolve literal arrays, template fragments, conditional classes, cx and .join.
    ts.forEachChild(node, scanClass)
  }
  const visitedStyles = new Set()
  function scanStyle(node) {
    node = unwrap(node)
    if (!node || visitedStyles.has(node)) return
    visitedStyles.add(node)
    if (ts.isIdentifier(node)) { scanStyle(initializer(node)); return }
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const name = ts.isComputedPropertyName(node.name) && ts.isStringLiteral(node.name.expression)
        ? node.name.expression.text : node.name.getText(file).replace(/^['"]|['"]$/g, '')
      if (VISUAL_PROPERTY.test(name)) {
        const value = staticValue(ts.isShorthandPropertyAssignment(node) ? node.name : node.initializer)
        if (value !== undefined) {
          const raw = String(value)
          const forbidden = name === 'zIndex' || name === 'z-index'
            ? raw !== 'auto' && !/^var\(--vds-[\w-]+\)$/.test(raw)
            : fixedValue(raw)
          if (forbidden) add(ownerOf(node, file), name, raw, lineOf(node))
        }
      }
      return
    }
    ts.forEachChild(node, scanStyle)
  }
  function visit(node) {
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(file)
      const value = node.initializer && (ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer)
      if (name === 'className') scanClass(value)
      if (name === 'style') scanStyle(value)
    }
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(file).replace(/^['"]|['"]$/g, '')
      if (name === 'className') scanClass(node.initializer)
      if (name === 'style') scanStyle(node.initializer)
    }
    if (ts.isVariableDeclaration(node) && /(?:CLASS(?:_NAME|ES|_NAMES)?|ClassNames?|Classes)$/.test(node.name.getText(file))) scanClass(node.initializer)
    if (ts.isCallExpression(node) && ['cx', 'clsx', 'cva', 'twMerge'].includes(node.expression.getText(file))) node.arguments.forEach(scanClass)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return hits
}

/** Core UI has no historical allowance for non-token stacking levels. */
export function layerTokenFindings(source, filename = 'source.tsx') {
  return visualFindings(source, filename).filter((hit) =>
    hit.kind === 'z-index' || hit.kind === 'zIndex' ||
    (hit.kind === 'class' && /(?:^|:)!?z-/.test(hit.value))
  )
}
function knownLayerTokens() {
  return new Set(readFileSync(LAYER_TOKEN_SOURCE, 'utf8').match(LAYER_TOKEN) ?? [])
}
/** A semantic-looking layer reference must resolve to a token owned by zindex.css. */
export function unknownLayerTokenFindings(source, filename = 'source.tsx') {
  const known = knownLayerTokens()
  const hits = []
  for (const match of source.matchAll(LAYER_TOKEN)) {
    if (known.has(match[0])) continue
    const line = source.slice(0, match.index).split('\n').length
    hits.push({ identity: JSON.stringify(['<layer-token>', 'z-index-token', match[0]]), kind: 'z-index-token', value: match[0], line, filename })
  }
  return hits
}
export function newVisualFindings(current, previous) {
  const remaining = new Map()
  for (const hit of previous) remaining.set(hit.identity, (remaining.get(hit.identity) ?? 0) + 1)
  return current.filter((hit) => {
    const count = remaining.get(hit.identity) ?? 0
    if (!count) return true
    remaining.set(hit.identity, count - 1)
    return false
  })
}

/** Inspect worktree AND index against an immutable origin; missing history fails closed. */
export function visualErrors({ root = ROOT, base = VISUAL_BASE } = {}) {
  const errors = []
  const bases = [...new Set([VISUAL_BASE, base])]
  const current = candidates(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', PREFIX], root).split('\0').filter(Boolean))
  const indexed = new Set(git(['ls-files', '-z', '--', PREFIX], root).split('\0').filter(Boolean))
  for (const ref of bases) {
    const commit = git(['rev-parse', '--verify', `${ref}^{commit}`], root).trim()
    const previousFiles = new Set(git(['ls-tree', '-r', '--name-only', '-z', commit, '--', PREFIX], root).split('\0').filter(Boolean))
    // Read only changed files. Untracked source files still have a zero budget.
    const changed = new Set(git(['diff', '--name-only', '-z', commit, '--', PREFIX], root).split('\0').filter(Boolean))
    const staged = new Set(git(['diff', '--cached', '--name-only', '-z', commit, '--', PREFIX], root).split('\0').filter(Boolean))
    const paths = current.filter((path) => changed.has(path) || staged.has(path) || !indexed.has(path))
    const blobs = readGitBlobs(paths.flatMap((path) => [
      ...(previousFiles.has(path) ? [`${commit}:${path}`] : []),
      ...(indexed.has(path) && staged.has(path) ? [`:${path}`] : []),
    ]), { root })
    for (const path of paths) {
      const previous = previousFiles.has(path) ? visualFindings(blobs.get(`${commit}:${path}`), path) : []
      const snapshots = []
      if (existsSync(resolve(root, path))) snapshots.push(['worktree', readFileSync(resolve(root, path), 'utf8')])
      if (indexed.has(path) && staged.has(path)) snapshots.push(['index', blobs.get(`:${path}`)])
      for (const [surface, source] of snapshots) {
        for (const hit of unknownLayerTokenFindings(source, path)) {
          errors.push(`${path}:${hit.line}: unknown z-index token ${hit.value} [${surface}]; define it in design/zindex.css or reuse an existing semantic token`)
        }
        for (const hit of newVisualFindings(visualFindings(source, path), previous)) {
          errors.push(`${path}:${hit.line}: fixed visual ${hit.kind} ${hit.value} [${surface}]; reuse UI props or --vds-* (${ref})`)
        }
      }
    }
  }
  return [...new Set(errors)]
}
