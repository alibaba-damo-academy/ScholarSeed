import ts from 'typescript'
import { resolve } from 'node:path'
import { DESKTOP, flatten, parameters } from './resources.mjs'

function stringValues(type) {
  if (type.isStringLiteral()) return [type.value]
  if (type.isUnion()) {
    const values = type.types.flatMap(stringValues)
    return values.length === type.types.length ? values : []
  }
  return []
}

function checkedParameter(type, numeric = false) {
  if (!type || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.Never)) return false
  if (type.isUnion()) return type.types.every((member) => checkedParameter(member, numeric))
  return !numeric || Boolean(type.flags & ts.TypeFlags.NumberLike)
}

/** Type-aware validation supplements i18next's optional options argument. No runtime wrapper. */
export function checkMessageCalls(program, resources) {
  const checker = program.getTypeChecker()
  const catalog = Object.fromEntries(Object.entries(resources.zh).map(([ns, value]) => [ns, flatten(value)]))
  const errors = []
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || file.fileName.includes('/node_modules/') || /\.(test|fixture)\./.test(file.fileName)) continue
    function fail(node, message) {
      const position = file.getLineAndCharacterOfPosition(node.getStart(file))
      errors.push(`${file.fileName}:${position.line + 1}: ${message}`)
    }
    const transTags = new Set()
    const elementFactories = new Set()
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement)) continue
      const bindings = statement.importClause?.namedBindings
      if (statement.moduleSpecifier.text === 'react') {
        if (statement.importClause?.name) elementFactories.add(statement.importClause.name.text + '.createElement')
        if (bindings && ts.isNamespaceImport(bindings)) elementFactories.add(bindings.name.text + '.createElement')
        if (bindings && ts.isNamedImports(bindings)) {
          for (const item of bindings.elements) if ((item.propertyName ?? item.name).text === 'createElement') elementFactories.add(item.name.text)
        }
      }
      if (statement.moduleSpecifier.text !== 'react-i18next') continue
      if (bindings && ts.isNamedImports(bindings)) {
        for (const item of bindings.elements) if ((item.propertyName ?? item.name).text === 'Trans') transTags.add(item.name.text)
      } else if (bindings && ts.isNamespaceImport(bindings)) transTags.add(bindings.name.text + '.Trans')
    }
    function attributeExpression(attribute) {
      return attribute?.initializer && ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : attribute?.initializer
    }
    function literalValues(node) {
      return ts.isStringLiteralLike(node) ? [node.text] : stringValues(checker.getTypeAtLocation(node))
    }
    function checkTrans(node, attrs) {
      const keyNode = attrs.get('i18nKey')
      const keys = keyNode ? literalValues(keyNode) : []
      if (!keys.length) { fail(node, 'Trans requires a finite explicit i18nKey'); return }
      const nsNode = attrs.get('ns')
      const namespace = nsNode ? literalValues(nsNode)[0] : 'foundation'
      const valuesNode = attrs.get('values')
      const values = valuesNode ? checker.getTypeAtLocation(valuesNode) : undefined
      for (const key of keys) {
        const [ns, message] = key.includes(':') ? key.split(':') : [namespace, key]
        const entries = catalog[ns]
        const text = entries?.[message] ?? entries?.[`${message}_other`]
        if (text === undefined) { fail(node, `Unknown Trans message ${ns}:${message}`); continue }
        const required = new Set(parameters(text))
        if (entries[`${message}_other`]) required.add('count')
        for (const parameter of required) {
          if (parameter === 'count' && attrs.has('count')) {
            const count = attrs.get('count')
            if (!count || !checkedParameter(checker.getTypeAtLocation(count), true)) fail(node, `${ns}:${message}: missing or unchecked Trans parameter count`)
            continue
          }
          let current = values
          for (const part of parameter.split('.')) {
            const property = current?.getProperty(part)
            current = property && !(property.flags & ts.SymbolFlags.Optional) ? checker.getTypeOfSymbolAtLocation(property, valuesNode) : undefined
          }
          if (!checkedParameter(current, parameter === 'count')) fail(node, `${ns}:${message}: missing Trans parameter ${parameter}`)
        }
      }
    }
    function visit(node) {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && transTags.has(node.tagName.getText(file))) {
        checkTrans(node, new Map(node.attributes.properties.filter(ts.isJsxAttribute).map((item) => [item.name.getText(file), attributeExpression(item)])))
      }
      if (ts.isCallExpression(node)) {
        if (elementFactories.has(node.expression.getText(file)) && node.arguments[0] && transTags.has(node.arguments[0].getText(file))) {
          const props = node.arguments[1]
          if (!props || !ts.isObjectLiteralExpression(props)) fail(node, 'Trans createElement requires explicit checked props')
          else checkTrans(node, new Map(props.properties.filter(ts.isPropertyAssignment).map((item) => [ts.isStringLiteralLike(item.name) ? item.name.text : item.name.getText(file), item.initializer])))
        }
        const type = checker.getTypeAtLocation(node.expression)
        const brand = type.getProperty('$TFunctionBrand')
        if (brand && node.arguments[0]) {
          const namespaces = stringValues(checker.getTypeOfSymbolAtLocation(brand, node.expression))
          const keys = stringValues(checker.getTypeAtLocation(node.arguments[0]))
          if (!keys.length) fail(node, 'Message key must have a finite literal type; use a typed explicit map')
          const options = node.arguments[1] && !ts.isStringLiteralLike(node.arguments[1]) ? node.arguments[1] : node.arguments[2]
          const optionType = options ? checker.getTypeAtLocation(options) : undefined
          const nsOption = optionType?.getProperty('ns')
          const nsValues = nsOption ? stringValues(checker.getTypeOfSymbolAtLocation(nsOption, options)) : namespaces
          for (const key of keys) {
            const [namespace, message] = key.includes(':') ? key.split(':') : [nsValues[0], key]
            const entries = catalog[namespace]
            const text = entries?.[message] ?? entries?.[`${message}_other`]
            if (text === undefined) { fail(node, `Unknown message ${namespace}:${message}`); continue }
            const required = new Set(parameters(text))
            if (entries[`${message}_other`]) required.add('count')
            for (const parameter of required) {
              let current = optionType
              for (const part of parameter.split('.')) {
                const property = current?.getProperty(part)
                current = property && !(property.flags & ts.SymbolFlags.Optional) ? checker.getTypeOfSymbolAtLocation(property, options) : undefined
              }
              if (!checkedParameter(current, parameter === 'count')) fail(node, `${namespace}:${message}: missing or unchecked parameter ${parameter}`)
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return errors
}

export function checkProjectCalls(resources, { desktop = DESKTOP, diagnostics = false } = {}) {
  const errors = []
  for (const project of ['tsconfig.web.json', 'tsconfig.node.json']) {
    const config = ts.readConfigFile(resolve(desktop, project), ts.sys.readFile)
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, desktop, undefined, resolve(desktop, project))
    const program = ts.createProgram(parsed.fileNames, parsed.options)
    if (diagnostics) {
      for (const error of [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]) {
        const line = error.file && error.start !== undefined ? error.file.getLineAndCharacterOfPosition(error.start).line + 1 : undefined
        errors.push(`${error.file?.fileName ?? project}${line ? ':' + line : ''}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`)
      }
    }
    errors.push(...checkMessageCalls(program, resources))
  }
  return [...new Set(errors)]
}
