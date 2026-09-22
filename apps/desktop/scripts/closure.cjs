// Built Electron entrypoints must be self-contained, apart from host modules.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { isBuiltin } = require('node:module')
const ts = require('typescript')
const asar = require('@electron/asar')

const ENTRY_DIRECTORIES = ['out/main/', 'out/preload/']
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs'])
const RELATIVE_EXTENSIONS = new Set([...JAVASCRIPT_EXTENSIONS, '.json'])
const HOST_MODULES = new Set(['electron'])
const DYNAMIC_HOST_MODULES = new Set(['module', 'node:module', 'vm', 'node:vm'])
const FORBIDDEN_DIRECTORIES = ['node_modules', 'out/renderer']
const ASAR_NAME = 'app.asar'
const DYNAMIC_LOADERS = new Set(['createRequire', 'eval', 'Function'])
const MODULE_NAME = 'module'
const CJS_MODULE_MEMBERS = new Set(['exports', 'require'])
const FUNCTION_VAR_MODULES = new WeakMap()

function isModuleBindingName(name) {
  return !!name && ts.isIdentifier(name) && name.text === MODULE_NAME
}

function isBindingPosition(id) {
  const parent = id.parent
  if (ts.isVariableDeclaration(parent) && parent.name === id) return true
  if (ts.isParameter(parent) && parent.name === id) return true
  if ((ts.isFunctionLike(parent) || ts.isClassLike(parent) || ts.isModuleDeclaration(parent)) && parent.name === id) return true
  if (ts.isCatchClause(parent) && parent.variableDeclaration === id) return true
  if (ts.isBindingElement(parent) && parent.name === id) return true
  if (ts.isImportClause(parent) && parent.name === id) return true
  if (ts.isImportSpecifier(parent) && parent.name === id) return true
  if (ts.isNamespaceImport(parent) && parent.name === id) return true
  return false
}

function functionVarsDeclareModule(fn) {
  let cached = FUNCTION_VAR_MODULES.get(fn)
  if (cached === undefined) {
    let found = false
    const walk = node => {
      if (found) return
      if (node !== fn && (ts.isFunctionLike(node) || ts.isClassLike(node))) return
      if (ts.isVariableDeclarationList(node) && (ts.getCombinedNodeFlags(node) & ts.NodeFlags.BlockScoped) === 0
        && node.declarations.some(declaration => isModuleBindingName(declaration.name))) found = true
      ts.forEachChild(node, walk)
    }
    walk(fn)
    cached = found
    FUNCTION_VAR_MODULES.set(fn, cached)
  }
  return cached
}

function functionScopeDeclaresModule(fn) {
  if (fn.parameters.some(parameter => isModuleBindingName(parameter.name))) return true
  if (isModuleBindingName(fn.name)) return true
  return functionVarsDeclareModule(fn)
}

function isBlockScopeContainer(node) {
  return ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node)
}

function statementsOf(container) {
  if (ts.isBlock(container) || ts.isSourceFile(container) || ts.isModuleBlock(container)) return container.statements
  if (ts.isCaseBlock(container)) return container.clauses.flatMap(clause => clause.statements)
  return []
}

function containerDeclaresModule(container, includeVar) {
  for (const statement of statementsOf(container)) {
    if (ts.isVariableStatement(statement)) {
      const list = statement.declarationList
      const blockScoped = (ts.getCombinedNodeFlags(list) & ts.NodeFlags.BlockScoped) !== 0
      if ((includeVar || blockScoped) && list.declarations.some(declaration => isModuleBindingName(declaration.name))) return true
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && isModuleBindingName(statement.name)) {
      return true
    } else if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (clause) {
        if (isModuleBindingName(clause.name)) return true
        const bindings = clause.namedBindings
        if (bindings) {
          if (ts.isNamespaceImport(bindings) && isModuleBindingName(bindings.name)) return true
          if (bindings.elements.some(specifier => isModuleBindingName(specifier.name))) return true
        }
      }
    }
  }
  return false
}

function listDeclaresModule(list) {
  return ts.isVariableDeclarationList(list)
    && list.declarations.some(declaration => isModuleBindingName(declaration.name))
}

function isModuleShadowed(id) {
  let node = id.parent
  while (node) {
    if (ts.isFunctionLike(node)) {
      if (functionScopeDeclaresModule(node)) return true
    } else if (ts.isClassLike(node) && isModuleBindingName(node.name)) {
      return true
    } else if (ts.isModuleDeclaration(node) && isModuleBindingName(node.name)) {
      return true
    } else if (isBlockScopeContainer(node)) {
      if (containerDeclaresModule(node, ts.isSourceFile(node))) return true
    } else if (ts.isCatchClause(node) && isModuleBindingName(node.variableDeclaration && node.variableDeclaration.name)) {
      return true
    } else if (ts.isForStatement(node) && listDeclaresModule(node.initializer)) {
      return true
    } else if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && listDeclaresModule(node.initializer)) {
      return true
    }
    node = node.parent
  }
  return false
}

function verifyClosure(files) {
  const entries = [...files.keys()].filter(name => ENTRY_DIRECTORIES.some(prefix => name.startsWith(prefix))
    && JAVASCRIPT_EXTENSIONS.has(path.posix.extname(name)))
  for (const directory of ENTRY_DIRECTORIES) {
    if (!entries.some(name => name.startsWith(directory))) throw new Error(`missing compiled entry directory: ${directory}`)
  }
  const hostModules = new Set()
  const inventory = new Set(entries)
  for (const filename of entries) {
    const source = ts.createSourceFile(filename, files.get(filename).toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    if (source.parseDiagnostics.length) throw new Error(`invalid compiled JavaScript: ${filename}`)
    const check = specifier => {
      if (!specifier || !ts.isStringLiteralLike(specifier)) throw new Error(`non-literal module loading: ${filename}`)
      const name = specifier.text
      if (DYNAMIC_HOST_MODULES.has(name)) throw new Error(`dynamic module loading capability: ${filename}: ${name}`)
      if (isBuiltin(name) || HOST_MODULES.has(name)) { hostModules.add(name); return }
      if (!name.startsWith('.')) throw new Error(`external npm module in compiled entry: ${filename}: ${name}`)
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(filename), name))
      const target = files.has(base) && RELATIVE_EXTENSIONS.has(path.posix.extname(base)) ? base : null
      if (!target || !ENTRY_DIRECTORIES.some(prefix => target.startsWith(prefix))) {
        throw new Error(`missing or escaped compiled module: ${filename}: ${name}`)
      }
      inventory.add(target)
    }
    const visit = node => {
      if (ts.isIdentifier(node) && DYNAMIC_LOADERS.has(node.text)) {
        throw new Error(`dynamic code or module loader in compiled entry: ${filename}: ${node.text}`)
      }
      if (ts.isIdentifier(node) && node.text === 'require') {
        const parent = node.parent
        const direct = ts.isCallExpression(parent) && parent.expression === node
        const mainProperty = ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === 'main'
        const member = ts.isPropertyAccessExpression(parent) && parent.name === node
          && ts.isIdentifier(parent.expression) && parent.expression.text === 'module'
          && ts.isCallExpression(parent.parent) && parent.parent.expression === parent
if (!direct && !mainProperty && !member) throw new Error(`aliased module loader in compiled entry: ${filename}`)
      }
      if (ts.isIdentifier(node) && node.text === MODULE_NAME) {
        const parent = node.parent
        const nested = isBindingPosition(node) || isModuleShadowed(node)
        const elementAccess = ts.isElementAccessExpression(parent) && parent.expression === node
        const propertyAccess = ts.isPropertyAccessExpression(parent) && parent.expression === node
          && !CJS_MODULE_MEMBERS.has(parent.name.text)
        if (!nested && (elementAccess || propertyAccess)) {
          throw new Error(`indirect module access in compiled entry: ${filename}`)
        }
      }
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) check(node.moduleSpecifier)
      }
      if (ts.isCallExpression(node)) {
        const loader = node.expression
        if (loader.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(loader) && loader.text === 'require')
          || (ts.isPropertyAccessExpression(loader) && ts.isIdentifier(loader.expression)
            && loader.expression.text === 'module' && loader.name.text === 'require')) check(node.arguments[0])
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { entries: entries.sort(), host_modules: [...hostModules].sort(), external_modules: [],
    files: [...inventory].sort().map(name => ({ path: name, sha256: crypto.createHash('sha256').update(files.get(name)).digest('hex') })) }
}

function readTree(root, relative = '') {
  const files = new Map()
  for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, item.name)
    if (item.isDirectory()) {
      for (const entry of readTree(root, name)) files.set(...entry)
    } else if (item.isFile()) files.set(name, fs.readFileSync(path.join(root, name)))
    else throw new Error(`unexpected link in compiled entry: ${name}`)
  }
  return files
}

function verifyBuiltClosure(desktop) {
  const files = new Map()
  for (const directory of ENTRY_DIRECTORIES) {
    for (const [name, content] of readTree(path.join(desktop, directory))) files.set(directory + name, content)
  }
  return verifyClosure(files)
}

function verifyAsarClosure(resources) {
  const archive = path.join(resources, ASAR_NAME)
  const names = asar.listPackage(archive).map(name => {
    const actual = name.startsWith(path.sep) ? name.slice(path.sep.length) : name
    return { actual, normalized: actual.split(path.sep).join('/') }
  })
  for (const directory of FORBIDDEN_DIRECTORIES) {
    if (names.some(({ normalized }) => normalized === directory || normalized.startsWith(directory + '/'))) {
      throw new Error(`duplicate build dependency in asar: ${directory}`)
    }
  }
  const unpacked = archive + '.unpacked'
  if (fs.existsSync(unpacked) && readTree(unpacked).size) throw new Error('unexpected unpacked Electron dependencies')
  const files = new Map(names.filter(({ actual }) => !asar.statFile(archive, actual).files)
    .map(({ actual, normalized }) => [normalized, asar.extractFile(archive, actual)]))
  const manifest = JSON.parse(files.get('package.json'))
  if (Object.keys(manifest.dependencies || {}).length) throw new Error('self-contained Electron entrypoints declare runtime npm dependencies')
  const closure = verifyClosure(files)
  if (!closure.entries.includes(manifest.main)) throw new Error('asar main is outside the verified entry closure')
  return { ...closure, asar_bytes: fs.statSync(archive).size }
}

module.exports = { verifyClosure, verifyBuiltClosure, verifyAsarClosure }
