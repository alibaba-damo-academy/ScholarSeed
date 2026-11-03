import { createHash } from 'node:crypto'
import ts from 'typescript'

const VISIBLE_ATTRIBUTES = new Set(['title', 'label', 'description', 'placeholder', 'aria-label', 'alt', 'closeLabel', 'emptyLabel', 'caption', 'message', 'error', 'text'])
const FEEDBACK_CALLS = new Set(['alert', 'confirm', 'prompt', 'toast', 'setError', 'setCreateError', 'setSearchError'])
const LITERAL = (node) => ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)
const propertyName = (node) => node.name && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) ? node.name.text : undefined
const legacyModule = (node) => ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && /(?:^|\/)i18n(?:\.ts)?$/.test(node.moduleSpecifier.text)

function constructsKey(node) {
  if (ts.isTemplateExpression(node)) return true
  if (ts.isBinaryExpression(node)) return node.operatorToken.kind === ts.SyntaxKind.PlusToken || constructsKey(node.left) || constructsKey(node.right)
  if (ts.isConditionalExpression(node)) return constructsKey(node.whenTrue) || constructsKey(node.whenFalse)
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) return constructsKey(node.expression)
  return false
}

/** Nodes carry source context and exact literal identity, never line numbers as identity. */
export function scanSource(source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, filename.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  // Bind this snapshot only. Never resolve imports from a different Git surface.
  const options = { noLib: true, noResolve: true, allowJs: true, jsx: ts.JsxEmit.Preserve }
  const host = ts.createCompilerHost(options)
  host.getSourceFile = (name) => name === filename ? file : undefined
  const checker = ts.createProgram([filename], options, host).getTypeChecker()
  const findings = []
  function isTooltip(tag) {
    const declaration = checker.getSymbolAtLocation(tag)?.declarations?.[0]
    if (declaration && ts.isImportSpecifier(declaration)) return (declaration.propertyName ?? declaration.name).text === 'Tooltip'
    if (ts.isPropertyAccessExpression(tag) && tag.name.text === 'Tooltip') {
      return checker.getSymbolAtLocation(tag.expression)?.declarations?.some(ts.isNamespaceImport) ?? false
    }
    return ts.isIdentifier(tag) && tag.text === 'Tooltip'
  }
  function owner(node) {
    let cursor = node.parent
    const names = []
    while (cursor) {
      if ((ts.isFunctionDeclaration(cursor) || ts.isClassDeclaration(cursor) || ts.isVariableDeclaration(cursor)) && cursor.name) names.push(cursor.name.getText(file))
      cursor = cursor.parent
    }
    return names.reverse().join('/')
  }
  function add(node, kind, text) {
    const normalized = text.replace(/\s+/g, ' ').trim()
    if (!normalized || !/[\p{L}\p{N}]/u.test(normalized)) return
    if (/^(?:https?:\/\/|mailto:|file:\/\/)\S+$/.test(normalized) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return
    const context = owner(node)
    const identity = createHash('sha256').update(JSON.stringify([kind, context, normalized])).digest('hex')
    const position = file.getLineAndCharacterOfPosition(node.getStart(file))
    findings.push({ identity, kind, owner: context, text: normalized, line: position.line + 1 })
  }
  function visibleExpression(node, kind, origin = node, seen = new Set()) {
    if (seen.has(node)) return
    const visited = new Set(seen).add(node)
    if (LITERAL(node)) add(origin, kind, node.text)
    else if (ts.isTemplateExpression(node)) {
      const staticText = node.head.text + node.templateSpans.map((span) => span.literal.text).join('')
      if (/[\p{L}\p{N}]/u.test(staticText)) add(origin, kind, node.getText(file))
      else for (const span of node.templateSpans) visibleExpression(span.expression, kind, origin, visited)
    }
    else if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) visibleExpression(node.expression, kind, origin, visited)
    else if (ts.isConditionalExpression(node)) {
      visibleExpression(node.whenTrue, kind, origin, visited); visibleExpression(node.whenFalse, kind, origin, visited)
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      visibleExpression(node.left, kind, origin, visited); visibleExpression(node.right, kind, origin, visited)
    } else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) {
      if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) visibleExpression(node.left, kind, origin, visited)
      visibleExpression(node.right, kind, origin, visited)
    } else if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      // Generic object `error`/`message` fields also carry wire codes. Resolve
      // references only at rendering/feedback sinks; protocol ownership stays explicit.
      if (kind.startsWith('property:')) return
      const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node)
      const declaration = symbol?.valueDeclaration
      if (declaration && (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) && declaration.initializer) {
        visibleExpression(declaration.initializer, kind, origin, visited)
      } else {
        // Finite const maps remain checkable even when selected by a union key.
        const type = checker.getTypeAtLocation(node)
        const values = type.isUnion() ? type.types : [type]
        for (const value of values) if (value.isStringLiteral()) add(origin, kind, value.value)
      }
    }
  }
  function visit(node) {
    if (ts.isIdentifier(node)) {
      const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0]
      if (declaration && ts.isImportSpecifier(declaration) && node !== declaration.name && node !== declaration.propertyName) {
        const imported = declaration.parent.parent.parent
        if ((declaration.propertyName ?? declaration.name).text === 'I18N' && legacyModule(imported)) add(node, 'legacy-reference', imported.moduleSpecifier.text + ':I18N')
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'I18N') {
      const declaration = checker.getSymbolAtLocation(node.expression)?.declarations?.[0]
      if (declaration && ts.isNamespaceImport(declaration)) {
        const imported = declaration.parent.parent
        if (legacyModule(imported)) add(node, 'legacy-reference', imported.moduleSpecifier.text + ':I18N')
      }
    }
    if (ts.isJsxText(node)) add(node, 'jsx-text', node.text)
    if (ts.isJsxAttribute(node) && (VISIBLE_ATTRIBUTES.has(node.name.getText(file)) || (node.name.getText(file) === 'content' && isTooltip(node.parent.parent.tagName))) && node.initializer) {
      const expression = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer
      if (expression) visibleExpression(expression, `attribute:${node.name.getText(file)}`)
    }
    if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) visibleExpression(node.expression, 'jsx-expression')
    if (ts.isPropertyAssignment(node) && VISIBLE_ATTRIBUTES.has(propertyName(node))) visibleExpression(node.initializer, `property:${propertyName(node)}`)
    if (ts.isCallExpression(node)) {
      const called = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ''
      if (FEEDBACK_CALLS.has(called) && node.arguments[0]) visibleExpression(node.arguments[0], `feedback:${called}`)
      if ((called === 't' || called === 'getFixedT') && node.arguments[0] && called === 't') {
        const key = node.arguments[0]
        // Identifiers and property access are permitted for typechecked explicit maps.
        if (constructsKey(key)) add(key, 'dynamic-key', key.getText(file))
      }
    }
    if (legacyModule(node)) {
      for (const item of node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) ? node.importClause.namedBindings.elements : []) {
        if ((item.propertyName ?? item.name).text === 'I18N') add(item, 'legacy-consumer', node.moduleSpecifier.text + ':' + item.name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return findings
}

export function newFindings(current, previous, debt) {
  const counts = (rows) => rows.reduce((result, row) => result.set(row.identity, (result.get(row.identity) ?? 0) + 1), new Map())
  const before = counts(previous)
  const budget = counts(debt)
  return current.filter((row) => {
    const allowed = Math.min(before.get(row.identity) ?? 0, budget.get(row.identity) ?? 0)
    before.set(row.identity, Math.max(0, (before.get(row.identity) ?? 0) - 1))
    budget.set(row.identity, Math.max(0, (budget.get(row.identity) ?? 0) - 1))
    return allowed === 0
  })
}
