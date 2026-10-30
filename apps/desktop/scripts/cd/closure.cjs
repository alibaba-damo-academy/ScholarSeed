// Built Electron entrypoints must be self-contained, apart from host modules.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { isBuiltin } = require('node:module')
const ts = require('typescript')
const asar = require('@electron/asar')
const { BUNDLED_LIBRARIES } = require('../../native/libraries.cjs')

const ENTRY_DIRECTORIES = ['out/main/', 'out/preload/']
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs'])
const RELATIVE_EXTENSIONS = new Set([...JAVASCRIPT_EXTENSIONS, '.json'])
const HOST_MODULES = new Set(['electron', 'original-fs'])
const DYNAMIC_HOST_MODULES = new Set(['module', 'node:module', 'vm', 'node:vm'])
const FORBIDDEN_DIRECTORIES = ['node_modules', 'out/renderer']
const ASAR_NAME = 'app.asar'
const DYNAMIC_LOADERS = new Set(['createRequire', 'eval', 'Function'])
const MODULE_NAME = 'module'
const CJS_MODULE_MEMBERS = new Set(['exports', 'require'])
const FUNCTION_VAR_MODULES = new WeakMap()
const DESKTOP_INSPECTION_ENTRY = 'out/main/data-inspection.js'
const INSPECTION_FORBIDDEN_MODULES = new Set([
  'electron',
  'child_process',
  'node:child_process',
  'worker_threads',
  'node:worker_threads',
])
const SHA256 = /^[a-f0-9]{64}$/

function nativeInventory(files, native) {
  const libraries = [...files.keys()].filter((name) => path.posix.extname(name) === '.node')
  if (!native) {
    if (libraries.length) throw new Error('native library requires a frozen build digest')
    return
  }
  if (
    !Array.isArray(native.libraries) ||
    native.libraries.length !== BUNDLED_LIBRARIES.length ||
    native.libraries.some((item, index) => item?.path !== BUNDLED_LIBRARIES[index] || !SHA256.test(item.sha256)) ||
    libraries.length !== BUNDLED_LIBRARIES.length ||
    BUNDLED_LIBRARIES.some(name => !libraries.includes(name))
  ) {
    throw new Error('unexpected native library inventory')
  }
  if (native.libraries.some(item =>
    crypto.createHash('sha256').update(files.get(item.path)).digest('hex') !== item.sha256
  )) {
    throw new Error('native library differs from the frozen build digest')
  }
}

const PROTECTED_PREFIX = 'out/protected/'
const PROTECTED_BINDING = /^scholarseed-protected-v1:([a-f0-9]{64}):([a-f0-9]{64})$/
const PROTECTED_FILE_LIMIT = 4096
const PROTECTED_TOTAL_LIMIT = 64 * 1024 * 1024
const PROTECTED_MANIFEST_LIMIT = 4 * 1024 * 1024
const PROTECTED_MANIFEST = 'manifest.json'

function protectedBinding(files) {
  const bindings = []
  for (const [filename, bytes] of files) {
    if (!filename.startsWith('out/main/') || !JAVASCRIPT_EXTENSIONS.has(path.posix.extname(filename))) continue
    const source = ts.createSourceFile(filename, bytes.toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const walk = node => {
      if (ts.isStringLiteralLike(node)) {
        const binding = PROTECTED_BINDING.exec(node.text)
        if (binding) bindings.push({ generation: binding[1], manifestDigest: binding[2] })
      }
      ts.forEachChild(node, walk)
    }
    walk(source)
  }
  if (bindings.length !== 1) throw new Error('protected release requires exactly one compiled binding')
  return bindings[0]
}
function verifyProtectedClosure(files) {
  const binding = protectedBinding(files)
  const prefix = `${PROTECTED_PREFIX}${binding.generation}/`
  const bytes = files.get(prefix + PROTECTED_MANIFEST)
  if (!bytes || bytes.length > PROTECTED_MANIFEST_LIMIT || crypto.createHash('sha256').update(bytes).digest('hex') !== binding.manifestDigest) {
    throw new Error('protected manifest missing or mismatched')
  }
  const manifest = JSON.parse(bytes.toString('utf8'))
  if (manifest.version !== 1 || manifest.generation !== binding.generation || !Array.isArray(manifest.files)
    || manifest.files.length > PROTECTED_FILE_LIMIT) throw new Error('invalid protected release manifest')
  const expected = new Set([prefix + PROTECTED_MANIFEST])
  let total = 0
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !/^(?:renderer|preload)\/[A-Za-z0-9_./-]+$/.test(file.path)
      || file.path.split('/').some(part => !part || part === '.' || part === '..') || expected.has(prefix + file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('invalid protected file record')
    const bytes = files.get(prefix + file.path)
    total += bytes?.length ?? 0
    if (!bytes || total > PROTECTED_TOTAL_LIMIT || bytes.length !== file.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new Error('protected file missing or mismatched')
    }
    expected.add(prefix + file.path)
  }
  if (!expected.has(prefix + 'renderer/vault.html') || !expected.has(prefix + 'preload/vault.js')
    || [...files.keys()].some(name => name.startsWith(PROTECTED_PREFIX) && !expected.has(name))) throw new Error('protected release has missing entry, extra or stale generation')
  return { ...binding, prefix, files: [...expected].sort() }
}

function isModuleBindingName(name) {
  return !!name && ts.isIdentifier(name) && name.text === MODULE_NAME
}

function isBindingPosition(id) {
  const parent = id.parent
  if (ts.isVariableDeclaration(parent) && parent.name === id) return true
  if (ts.isParameter(parent) && parent.name === id) return true
  if (
    (ts.isFunctionLike(parent) || ts.isClassLike(parent) || ts.isModuleDeclaration(parent)) &&
    parent.name === id
  )
    return true
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
    const walk = (node) => {
      if (found) return
      if (node !== fn && (ts.isFunctionLike(node) || ts.isClassLike(node))) return
      if (
        ts.isVariableDeclarationList(node) &&
        (ts.getCombinedNodeFlags(node) & ts.NodeFlags.BlockScoped) === 0 &&
        node.declarations.some((declaration) => isModuleBindingName(declaration.name))
      )
        found = true
      ts.forEachChild(node, walk)
    }
    walk(fn)
    cached = found
    FUNCTION_VAR_MODULES.set(fn, cached)
  }
  return cached
}

function functionScopeDeclaresModule(fn) {
  if (fn.parameters.some((parameter) => isModuleBindingName(parameter.name))) return true
  if (isModuleBindingName(fn.name)) return true
  return functionVarsDeclareModule(fn)
}

function isBlockScopeContainer(node) {
  return ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node)
}

function statementsOf(container) {
  if (ts.isBlock(container) || ts.isSourceFile(container) || ts.isModuleBlock(container))
    return container.statements
  if (ts.isCaseBlock(container)) return container.clauses.flatMap((clause) => clause.statements)
  return []
}

function containerDeclaresModule(container, includeVar) {
  for (const statement of statementsOf(container)) {
    if (ts.isVariableStatement(statement)) {
      const list = statement.declarationList
      const blockScoped = (ts.getCombinedNodeFlags(list) & ts.NodeFlags.BlockScoped) !== 0
      if (
        (includeVar || blockScoped) &&
        list.declarations.some((declaration) => isModuleBindingName(declaration.name))
      )
        return true
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      isModuleBindingName(statement.name)
    ) {
      return true
    } else if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (clause) {
        if (isModuleBindingName(clause.name)) return true
        const bindings = clause.namedBindings
        if (bindings) {
          if (ts.isNamespaceImport(bindings) && isModuleBindingName(bindings.name)) return true
          if (bindings.elements.some((specifier) => isModuleBindingName(specifier.name)))
            return true
        }
      }
    }
  }
  return false
}

function listDeclaresModule(list) {
  return (
    ts.isVariableDeclarationList(list) &&
    list.declarations.some((declaration) => isModuleBindingName(declaration.name))
  )
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
    } else if (
      ts.isCatchClause(node) &&
      isModuleBindingName(node.variableDeclaration && node.variableDeclaration.name)
    ) {
      return true
    } else if (ts.isForStatement(node) && listDeclaresModule(node.initializer)) {
      return true
    } else if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      listDeclaresModule(node.initializer)
    ) {
      return true
    }
    node = node.parent
  }
  return false
}

function verifyClosure(files, native, protectedPreload = null) {
  nativeInventory(files, native)
  const entries = [...files.keys()].filter(name => (ENTRY_DIRECTORIES.some(prefix => name.startsWith(prefix)) || name === protectedPreload)
    && JAVASCRIPT_EXTENSIONS.has(path.posix.extname(name)))
  for (const directory of ENTRY_DIRECTORIES) {
    if (!entries.some((name) => name.startsWith(directory)))
      throw new Error(`missing compiled entry directory: ${directory}`)
  }
  const hostModules = new Set()
  const inventory = new Set(entries)
  const dependencies = new Map()
  const hostsByFile = new Map()
  for (const filename of entries) {
    const imports = new Set()
    dependencies.set(filename, imports)
    const localHosts = new Set()
    hostsByFile.set(filename, localHosts)
    const source = ts.createSourceFile(
      filename,
      files.get(filename).toString(),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    )
    if (source.parseDiagnostics.length) throw new Error(`invalid compiled JavaScript: ${filename}`)
    const check = (specifier) => {
      if (!specifier || !ts.isStringLiteralLike(specifier))
        throw new Error(`non-literal module loading: ${filename}`)
      const name = specifier.text
      if (DYNAMIC_HOST_MODULES.has(name))
        throw new Error(`dynamic module loading capability: ${filename}: ${name}`)
      if (isBuiltin(name) || HOST_MODULES.has(name)) {
        hostModules.add(name)
        localHosts.add(name)
        return
      }
      if (!name.startsWith('.'))
        throw new Error(`external npm module in compiled entry: ${filename}: ${name}`)
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(filename), name))
      const target =
        files.has(base) &&
        (RELATIVE_EXTENSIONS.has(path.posix.extname(base)) || (native && BUNDLED_LIBRARIES.includes(base)))
          ? base
          : null
      if (!target || !ENTRY_DIRECTORIES.some((prefix) => target.startsWith(prefix))) {
        throw new Error(`missing or escaped compiled module: ${filename}: ${name}`)
      }
      inventory.add(target)
      imports.add(target)
    }
    const visit = (node) => {
      if (ts.isIdentifier(node) && DYNAMIC_LOADERS.has(node.text)) {
        throw new Error(
          `dynamic code or module loader in compiled entry: ${filename}: ${node.text}`
        )
      }
      if (ts.isIdentifier(node) && node.text === 'require') {
        const parent = node.parent
        const direct = ts.isCallExpression(parent) && parent.expression === node
        const mainProperty =
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node &&
          parent.name.text === 'main'
        const member =
          ts.isPropertyAccessExpression(parent) &&
          parent.name === node &&
          ts.isIdentifier(parent.expression) &&
          parent.expression.text === 'module' &&
          ts.isCallExpression(parent.parent) &&
          parent.parent.expression === parent
        if (!direct && !mainProperty && !member)
          throw new Error(`aliased module loader in compiled entry: ${filename}`)
      }
      if (ts.isIdentifier(node) && node.text === MODULE_NAME) {
        const parent = node.parent
        const nested = isBindingPosition(node) || isModuleShadowed(node)
        const elementAccess = ts.isElementAccessExpression(parent) && parent.expression === node
        const propertyAccess =
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node &&
          !CJS_MODULE_MEMBERS.has(parent.name.text)
        if (!nested && (elementAccess || propertyAccess)) {
          throw new Error(`indirect module access in compiled entry: ${filename}`)
        }
      }
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) check(node.moduleSpecifier)
      }
      if (ts.isCallExpression(node)) {
        const loader = node.expression
        if (
          loader.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(loader) && loader.text === 'require') ||
          (ts.isPropertyAccessExpression(loader) &&
            ts.isIdentifier(loader.expression) &&
            loader.expression.text === 'module' &&
            loader.name.text === 'require')
        )
          check(node.arguments[0])
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  if (!entries.includes(DESKTOP_INSPECTION_ENTRY))
    throw new Error('missing compiled Desktop inspection entry')
  const inspected = new Set()
  const inspecting = [DESKTOP_INSPECTION_ENTRY]
  while (inspecting.length) {
    const name = inspecting.pop()
    if (inspected.has(name)) continue
    inspected.add(name)
    if (BUNDLED_LIBRARIES.includes(name) || name === 'out/main/index.js' || (name.startsWith('out/preload/') || name === protectedPreload))
      throw new Error(`Desktop inspection depends on application startup: ${name}`)
    for (const host of hostsByFile.get(name) || []) {
      if (INSPECTION_FORBIDDEN_MODULES.has(host))
        throw new Error(
          `Desktop inspection has application or process capability: ${name}: ${host}`
        )
    }
    inspecting.push(...(dependencies.get(name) || []))
  }
  if (native) {
    if (BUNDLED_LIBRARIES.some(name => !inventory.has(name))) throw new Error('unreferenced native library')
    const visited = new Set()
    const pending = entries.filter((name) => (name.startsWith('out/preload/') || name === protectedPreload))
    while (pending.length) {
      const name = pending.pop()
      if (BUNDLED_LIBRARIES.includes(name))
        throw new Error('preload cannot depend on the native libraries')
      if (visited.has(name)) continue
      visited.add(name)
      pending.push(...(dependencies.get(name) || []))
    }
  }
  return {
    entries: entries.sort(),
    host_modules: [...hostModules].sort(),
    external_modules: [],
    files: [...inventory].sort().map((name) => ({
      path: name,
      sha256: crypto.createHash('sha256').update(files.get(name)).digest('hex'),
    })),
  }
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

function verifyBuiltClosure(desktop, native) {
  const files = new Map()
  for (const directory of ENTRY_DIRECTORIES) {
    for (const [name, content] of readTree(path.join(desktop, directory)))
      files.set(directory + name, content)
  }
  const binding = protectedBinding(files)
  const prefix = `${PROTECTED_PREFIX}${binding.generation}/`
  for (const [name, bytes] of readTree(path.join(desktop, prefix))) files.set(prefix + name, bytes)
  const protectedBundle = verifyProtectedClosure(files)
  return { ...verifyClosure(files, native, prefix + 'preload/vault.js'), protected: protectedBundle }
}

function verifyAsarClosure(resources, native) {
  const archive = path.join(resources, ASAR_NAME)
  const names = asar.listPackage(archive).map((name) => {
    const actual = name.startsWith(path.sep) ? name.slice(path.sep.length) : name
    return { actual, normalized: actual.split(path.sep).join('/') }
  })
  for (const directory of FORBIDDEN_DIRECTORIES) {
    if (
      names.some(
        ({ normalized }) => normalized === directory || normalized.startsWith(directory + '/')
      )
    ) {
      throw new Error(`duplicate build dependency in asar: ${directory}`)
    }
  }
  const unpacked = archive + '.unpacked'
  let loose = new Map()
  if (fs.existsSync(unpacked)) {
    if (!fs.lstatSync(unpacked).isDirectory()) throw new Error('unexpected unpacked Electron root')
    loose = readTree(unpacked)
  }
  if (loose.size !== (native ? BUNDLED_LIBRARIES.length : 0) || (native && BUNDLED_LIBRARIES.some(name => !loose.has(name)))) {
    throw new Error('unexpected unpacked Electron dependencies')
  }
  for (const { actual, normalized } of names) {
    const stat = asar.statFile(archive, actual, false)
    if (stat.files) continue
    if (stat.link || Boolean(stat.unpacked) !== Boolean(native && BUNDLED_LIBRARIES.includes(normalized))) {
      throw new Error(`unexpected asar link or unpacked entry: ${normalized}`)
    }
    if (native && BUNDLED_LIBRARIES.includes(normalized)) {
      const identity = fs.lstatSync(path.join(unpacked, normalized))
      if (!identity.isFile() || identity.nlink !== 1 || stat.size !== identity.size) {
        throw new Error('unexpected native library file identity')
      }
    }
  }
  const files = new Map(
    names
      .filter(({ actual }) => !asar.statFile(archive, actual, false).files)
      .map(({ actual, normalized }) => [normalized, asar.extractFile(archive, actual)])
  )
  const manifest = JSON.parse(files.get('package.json'))
  if (Object.keys(manifest.dependencies || {}).length) throw new Error('self-contained Electron entrypoints declare runtime npm dependencies')
  const protectedBundle = verifyProtectedClosure(files)
  const closure = { ...verifyClosure(files, native, protectedBundle.prefix + 'preload/vault.js'), protected: protectedBundle }
  if (!closure.entries.includes(manifest.main)) throw new Error('asar main is outside the verified entry closure')
  return { ...closure, asar_bytes: fs.statSync(archive).size }
}

module.exports = { verifyClosure, verifyBuiltClosure, verifyAsarClosure, verifyProtectedClosure }
