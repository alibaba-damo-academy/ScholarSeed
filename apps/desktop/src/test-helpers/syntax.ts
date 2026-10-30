import assert from 'node:assert/strict'
import ts from 'typescript'

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.Preserve,
}

function parse(source: string): ts.SourceFile {
  const result = ts.transpileModule(source, {
    fileName: 'contract.tsx',
    compilerOptions: OPTIONS,
    reportDiagnostics: true,
  })
  const errors = (result.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  assert.deepEqual(errors, [], 'source contract requires syntactically valid input')
  return ts.createSourceFile(
    'contract.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
}

function children(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = []
  ts.forEachChild(node, (child) => {
    result.push(child)
  })
  return result
}

function same(actual: ts.Node, expected: ts.Node): boolean {
  if (actual.kind !== expected.kind) return false
  const actualChildren = children(actual)
  const expectedChildren = children(expected)
  if (actualChildren.length !== expectedChildren.length) return false
  if (!actualChildren.length) {
    const value = (node: ts.Node) =>
      ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)
        ? node.text
        : node.getText()
    return value(actual) === value(expected)
  }
  return actualChildren.every((child, index) => same(child, expectedChildren[index]))
}

export function expressions(source: string) {
  const root = parse(source)
  return (expected: string, owner?: string | { attribute: string }): void => {
    const statement = parse(expected).statements
    assert.equal(statement.length, 1, 'expected exactly one expression')
    assert.ok(ts.isExpressionStatement(statement[0]), 'expected an expression, not a declaration')
    const expression = statement[0].expression
    let scope: ts.Node = root
    if (owner) {
      const label =
        typeof owner === 'string' ? `variable: ${owner}` : `attribute: ${owner.attribute}`
      const initializers: Array<ts.Node | undefined> = []
      const locate = (node: ts.Node): void => {
        if (
          typeof owner === 'string' &&
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === owner
        )
          initializers.push(node.initializer)
        if (
          typeof owner !== 'string' &&
          ts.isJsxAttribute(node) &&
          node.name.getText() === owner.attribute
        )
          initializers.push(node.initializer)
        ts.forEachChild(node, locate)
      }
      locate(root)
      assert.equal(initializers.length, 1, `expected one owner: ${label}`)
      assert.ok(initializers[0], `missing initializer: ${label}`)
      scope = initializers[0]
    }
    const contains = (node: ts.Node): boolean =>
      same(node, expression) || children(node).some(contains)
    assert.ok(contains(scope), `missing expression: ${expected}`)
  }
}
