const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const desktopRequire = createRequire(path.resolve(__dirname, '../../apps/desktop/package.json'))
const { build } = desktopRequire('esbuild')
const postcss = desktopRequire('postcss')
const tailwind = desktopRequire('@tailwindcss/postcss')
const { zipSync } = desktopRequire('fflate')
const manifest = require('./manifest.json')
const exampleManifest = require('./example/plugin.json')

const DESKTOP = path.resolve(__dirname, '../../apps/desktop')
const HOST_CLIPBOARD = path.join(DESKTOP, 'src/renderer/src/components/primitive/clipboard.ts')
const SDK_CLIPBOARD = path.join(__dirname, 'clipboard.ts')
const HOST_BIBLIOGRAPHY_EXPORT = path.join(DESKTOP, 'src/renderer/src/features/literature/export.ts')
const SDK_BIBLIOGRAPHY_EXPORT = path.join(__dirname, 'saving.ts')
const PACKAGE_MANIFEST = '.scholarseed-package.json'
const UI_MANIFEST = '.scholarseed-ui.json'
const DECLARATIVE_CATALOG = 'conversation.json'
const SKILL_UI_REFERENCE = path.resolve(__dirname, '../../skills/community/scholarseed-product-operations/references/scholarseed-chat-ui')
const FILE_MODE = 0o644
const TAILWIND_IMPORT = /(['"])tailwindcss\1/
const TAILWIND_STYLESHEET = desktopRequire.resolve('tailwindcss/index.css').replaceAll('\\', '/')
const ARCHIVE_MTIME = new Date(1980, 0, 1, 0, 0, 0)
const ARCHIVE_COMPRESSION_LEVEL = 6
const CATALOG_EVALUATION_TIMEOUT_MS = 1000
const FORBIDDEN_INPUTS = [/\/store\//, /\/store\.tsx?$/, /\/api\.tsx?$/, /\/literature\/catalog\.ts$/, /\/fileOpen\.ts$/, /\/components\/primitive\/clipboard\.ts$/, /\/features\/literature\/export\.ts$/]
const options = {
  absWorkingDir: __dirname, bundle: true, minify: true, format: 'iife', platform: 'browser', jsx: 'transform',
  tsconfigRaw: { compilerOptions: { jsx: 'react' } },
  nodePaths: [path.join(DESKTOP, 'node_modules')],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false', 'window.open': 'denyUINavigation' },
  inject: [path.join(__dirname, 'navigation.ts')], metafile: true,
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'dataurl', '.webp': 'dataurl', '.gif': 'dataurl' },
}

async function inventory(directory, relative = '') {
  const files = []
  for (const entry of (await fs.readdir(path.join(directory, relative), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const name = path.posix.join(relative, entry.name)
    if (name === PACKAGE_MANIFEST) continue
    if (entry.isDirectory()) files.push(...await inventory(directory, name))
    else if (entry.isFile()) {
      const bytes = await fs.readFile(path.join(directory, name))
      files.push({ path: name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), mode: FILE_MODE })
    } else throw new Error(`unsupported package entry: ${name}`)
  }
  return files
}

async function openUICatalogs() {
  const registration = await build({ ...options, entryPoints: ['canvases.tsx'], platform: 'node', format: 'cjs',
    packages: 'external', write: false, inject: [], loader: {},
    jsx: 'automatic', tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } } })
  const imports = new Map(Object.values(registration.metafile.outputs).flatMap(output =>
    output.imports.filter(entry => entry.external).map(entry => [entry.path, desktopRequire(entry.path)])))
  const libraryContext = { module: { exports: {} }, require: name => {
    if (!imports.has(name)) throw new Error(`undeclared registry dependency: ${name}`)
    return imports.get(name)
  } }
  vm.runInNewContext(registration.outputFiles[0].text, libraryContext, { timeout: CATALOG_EVALUATION_TIMEOUT_MS })
  const library = libraryContext.module.exports.conversationLibrary
  const canvasLibrary = libraryContext.module.exports.canvasLibrary
  const declarative = {
    format: 'openui-lang', version: 1, host_revision: library.id, root: library.root, schema: library.toJSONSchema(),
    groups: library.componentGroups, prompt: library.prompt({ toolCalls: false, bindings: false, builtinFunctions: false,
      additionalRules: ['Only literal registered display components are admitted.',
        'Do not generate URLs, regular expressions, scripts, queries, mutations, reactive variables or built-in actions.',
        'Source citations and artifact navigation belong to native product flows, not generated display components.',
        'Use component/display with slot conversation.ui and data {format: "openui-lang", version: 1, source: program}. Reuse request_id and increment revision by one to update the same surface; identical retries retain the revision.',
        'This slot is display-only. Use native product tools for input, progress, confirmation, clarification and recovery. Local resource opening never advances the Agent.'] }),
  }
  const canvas = { format: 'openui-lang', version: 1, host_revision: 'host-canvas-v1', root: canvasLibrary.root, groups: canvasLibrary.componentGroups ?? [] }
  return {
    declarative,
    canvas: { ...canvas, prompt: libraryContext.module.exports.canvasPrompt },
    canvasSchema: { ...canvas, schema: canvasLibrary.toJSONSchema() },
  }
}

async function syncSkillReference(directory, { declarative, canvas, canvasSchema }, { write = false } = {}) {
  for (const [name, catalog] of Object.entries({ conversation: declarative, canvas: { ...canvas, schema: canvasSchema.schema } })) {
    const filename = path.join(directory, `${name}.md`)
    const digest = crypto.createHash('sha256').update(JSON.stringify(catalog.schema)).digest('hex')
    const content = `# ${name === 'conversation' ? 'Conversation' : 'Canvas'} OpenUI signatures\n\nGenerated from the official Agent registry (${catalog.host_revision}). Do not edit.\nSchema SHA-256: ${digest}\n\n${catalog.prompt.trim()}\n`
    if (write) {
      await fs.writeFile(filename, content, 'utf8')
    } else {
      const existing = await fs.readFile(filename, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (existing !== content)
        throw new Error(`Chat UI reference drift: ${filename}; regenerate with --write-skill-reference`)
    }
  }
}

async function buildOfficialUI(output) {
  const catalogs = await openUICatalogs()
  await syncSkillReference(SKILL_UI_REFERENCE, catalogs)
  const result = await build({ ...options, jsx: 'automatic', tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } }, entryPoints: { ui: 'runtime.tsx' }, outdir: output,
    define: { ...options.define, 'import.meta.url': '__scholarseedUIBase' },
    banner: { js: 'var __scholarseedUIBase = document.currentScript?.src || document.baseURI;' },
    plugins: [{ name: 'official-ui-styles', setup(builder) {
      builder.onResolve({ filter: /^mermaid$/ }, () => ({ path: path.join(__dirname, 'diagram.ts') }))
      builder.onResolve({ filter: /(?:^|\/)export(?:\.ts)?$/ }, args => {
        const resolved = path.resolve(args.resolveDir, args.path)
        if (resolved === HOST_BIBLIOGRAPHY_EXPORT || `${resolved}.ts` === HOST_BIBLIOGRAPHY_EXPORT)
          return { path: SDK_BIBLIOGRAPHY_EXPORT }
        return undefined
      })
      builder.onResolve({ filter: /(?:^|\/)clipboard(?:\.ts)?$/ }, args => {
        const resolved = path.resolve(args.resolveDir, args.path)
        if (resolved === HOST_CLIPBOARD || `${resolved}.ts` === HOST_CLIPBOARD)
          return { path: SDK_CLIPBOARD }
        return undefined
      })
      builder.onResolve({ filter: /^\/src\// }, args => ({ path: path.resolve(DESKTOP, 'src/renderer', args.path.slice(1)) }))
      builder.onLoad({ filter: /ui\.css$/ }, async args => {
        const source = (await fs.readFile(args.path, 'utf8')).replace(TAILWIND_IMPORT, JSON.stringify(TAILWIND_STYLESHEET))
        const compiled = await postcss([tailwind({ base: DESKTOP })]).process(source, { from: args.path })
        return { contents: compiled.css, loader: 'css', resolveDir: path.dirname(args.path) }
      })
    } }],
  })
  const diagrams = await build({ ...options, entryPoints: { mermaid: desktopRequire.resolve('mermaid') }, outdir: output, globalName: '__scholarseedDiagram' })
  result.metafile.inputs = { ...result.metafile.inputs, ...diagrams.metafile.inputs }
  result.metafile.outputs = { ...result.metafile.outputs, ...diagrams.metafile.outputs }
  await build({ ...options, entryPoints: { 'canvas.worker': 'canvas.worker.ts' }, outdir: output, format: 'esm', inject: [] })
  const runtimeFile = path.join(output, 'ui.js')
  await fs.writeFile(runtimeFile, (await fs.readFile(runtimeFile, 'utf8')).replaceAll('./canvas.worker.ts', './canvas.worker.js'))
  const research = await build({ ...options, entryPoints: { research: 'research.tsx' }, outdir: output })
  result.metafile.inputs = { ...result.metafile.inputs, ...research.metafile.inputs }
  result.metafile.outputs = { ...result.metafile.outputs, ...research.metafile.outputs }
  const emitted = Object.values(result.metafile.outputs).flatMap(entry => Object.entries(entry.inputs).filter(([, contribution]) => contribution.bytesInOutput > 0).map(([input]) => input))
  const forbidden = emitted.filter(input => FORBIDDEN_INPUTS.some(pattern => pattern.test(`/${input.replaceAll('\\', '/')}`)))
  if (forbidden.length) throw new Error(`official UI includes host implementation: ${forbidden.join(', ')}`)
  const discovery = await build({ ...options, loader: {}, entryPoints: ['catalog.ts'], format: 'cjs', write: false })
  const context = { module: { exports: {} } }
  vm.runInNewContext(discovery.outputFiles[0].text, context, { timeout: CATALOG_EVALUATION_TIMEOUT_MS })
  await fs.writeFile(path.join(output, 'catalog.json'), `${JSON.stringify(context.module.exports.catalog, null, 2)}\n`)
  await fs.writeFile(path.join(output, DECLARATIVE_CATALOG), `${JSON.stringify(catalogs.declarative, null, 2)}\n`)
  await fs.writeFile(path.join(output, 'canvas.json'), `${JSON.stringify(catalogs.canvas)}\n`)
  await fs.writeFile(path.join(output, 'canvas.schema.json'), `${JSON.stringify(catalogs.canvasSchema)}\n`)
  const dependency = createRequire(desktopRequire.resolve('echarts/package.json'))
  const table = createRequire(desktopRequire.resolve('@tanstack/react-table/package.json'))
  const openui = path.resolve(path.dirname(desktopRequire.resolve('@openuidev/react-ui')), '../package.json')
  const headless = createRequire(openui)
  const licenses = {
    echarts: desktopRequire.resolve('echarts/package.json'),
    zrender: dependency.resolve('zrender/package.json'),
    'tanstack-react-table': desktopRequire.resolve('@tanstack/react-table/package.json'),
    'tanstack-table-core': table.resolve('@tanstack/table-core/package.json'),
    'openui-react-ui': openui,
    'openui-react-lang': path.resolve(path.dirname(desktopRequire.resolve('@openuidev/react-lang')), '../package.json'),
    'openui-lang-core': path.resolve(path.dirname(desktopRequire.resolve('@openuidev/lang-core')), '../package.json'),
    'openui-react-headless': path.resolve(path.dirname(headless.resolve('@openuidev/react-headless')), '../package.json'),
  }
  await fs.mkdir(path.join(output, 'licenses'), { recursive: true })
  for (const [name, filename] of Object.entries(licenses)) await fs.copyFile(path.join(path.dirname(filename), 'LICENSE'), path.join(output, 'licenses', `${name}.txt`))
  await fs.writeFile(path.join(output, UI_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
  await fs.writeFile(path.join(output, PACKAGE_MANIFEST), `${JSON.stringify({ schema: 1, name: manifest.id, version: manifest.version, dependencies: {}, files: await inventory(output) }, null, 2)}\n`)
  return result
}

async function buildExample(output) {
  const result = await build({ ...options, entryPoints: { custom: 'example/custom.tsx' }, outdir: output })
  for (const name of ['SKILL.md', 'preview.json']) await fs.copyFile(path.join(__dirname, 'example', name), path.join(output, name))
  await fs.writeFile(path.join(output, '.scholarseed-plugin.json'), `${JSON.stringify(exampleManifest, null, 2)}\n`)
  await fs.writeFile(path.join(output, PACKAGE_MANIFEST), `${JSON.stringify({ schema: 1, name: exampleManifest.id, version: exampleManifest.version, dependencies: {}, files: await inventory(output) }, null, 2)}\n`)
  return result
}

async function buildArchive(output, { example = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarseed-ui-'))
  try {
    await (example ? buildExample(directory) : buildOfficialUI(directory))
    const entries = {}
    for (const resource of [...await inventory(directory), { path: PACKAGE_MANIFEST }]) {
      entries[resource.path] = [new Uint8Array(await fs.readFile(path.join(directory, resource.path))), { mtime: ARCHIVE_MTIME }]
    }
    const archive = zipSync(entries, { level: ARCHIVE_COMPRESSION_LEVEL })
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true })
    await fs.writeFile(output, archive)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

async function main(mode, argument) {
  if (mode === '--write-skill-reference' || mode === '--check-skill-reference') {
    await syncSkillReference(argument ? path.resolve(argument) : SKILL_UI_REFERENCE,
      await openUICatalogs(), { write: mode === '--write-skill-reference' })
    return
  }
  const archive = mode === '--archive' || mode === '--example'
  const output = archive ? argument : mode
  if (!output) throw new Error('official UI output directory is required')
  await (archive ? buildArchive(path.resolve(output), { example: mode === '--example' }) : buildOfficialUI(path.resolve(output)))
  console.log('UI package built independently')
}

if (require.main === module) {
  main(...process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1 })
}

module.exports = { buildOfficialUI, buildExample, buildArchive }
