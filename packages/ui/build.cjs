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
const PACKAGE_MANIFEST = '.scholarseed-package.json'
const UI_MANIFEST = '.scholarseed-ui.json'
const FILE_MODE = 0o644
const TAILWIND_IMPORT = "'tailwindcss'"
const TAILWIND_STYLESHEET = desktopRequire.resolve('tailwindcss/index.css').replaceAll('\\', '/')
// ZIP stores local-time fields and starts at 1980-01-01 00:00. Build the date from local components so the encoded
// bytes are identical in every timezone; a UTC literal falls in 1979 west of UTC and fflate rejects it.
const ARCHIVE_MTIME = new Date(1980, 0, 1, 0, 0, 0)
const ARCHIVE_COMPRESSION_LEVEL = 6
const CATALOG_EVALUATION_TIMEOUT_MS = 1000
const FORBIDDEN_INPUTS = [/\/store\//, /\/store\.tsx?$/, /\/api\.tsx?$/, /\/literature\/catalog\.ts$/, /\/fileOpen\.ts$/]
const options = {
  absWorkingDir: __dirname, bundle: true, minify: true, format: 'iife', platform: 'browser', jsx: 'transform',
  tsconfigRaw: { compilerOptions: { jsx: 'react' } },
  nodePaths: [path.join(DESKTOP, 'node_modules')],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' }, metafile: true,
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

async function buildOfficialUI(output) {
  const result = await build({ ...options, jsx: 'automatic', tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } }, entryPoints: { ui: 'runtime.tsx' }, outdir: output,
    plugins: [{ name: 'official-ui-styles', setup(builder) {
      builder.onResolve({ filter: /^\/src\// }, args => ({ path: path.resolve(DESKTOP, 'src/renderer', args.path.slice(1)) }))
      builder.onLoad({ filter: /ui\.css$/ }, async args => {
        const source = (await fs.readFile(args.path, 'utf8')).replace(TAILWIND_IMPORT, JSON.stringify(TAILWIND_STYLESHEET))
        const compiled = await postcss([tailwind({ base: DESKTOP })]).process(source, { from: args.path })
        return { contents: compiled.css, loader: 'css', resolveDir: path.dirname(args.path) }
      })
    } }],
  })
  const selection = await build({ ...options, entryPoints: { selection: 'selection.tsx', choices: 'choices.tsx', research: 'research.tsx' }, outdir: output })
  result.metafile.inputs = { ...result.metafile.inputs, ...selection.metafile.inputs }
  result.metafile.outputs = { ...result.metafile.outputs, ...selection.metafile.outputs }
  const emitted = Object.values(result.metafile.outputs).flatMap(entry => Object.entries(entry.inputs).filter(([, contribution]) => contribution.bytesInOutput > 0).map(([input]) => input))
  const forbidden = emitted.filter(input => FORBIDDEN_INPUTS.some(pattern => pattern.test(`/${input.replaceAll('\\', '/')}`)))
  if (forbidden.length) throw new Error(`official UI includes host implementation: ${forbidden.join(', ')}`)
  const discovery = await build({ ...options, loader: {}, entryPoints: ['catalog.ts'], format: 'cjs', write: false })
  const context = { module: { exports: {} } }
  vm.runInNewContext(discovery.outputFiles[0].text, context, { timeout: CATALOG_EVALUATION_TIMEOUT_MS })
  await fs.writeFile(path.join(output, 'catalog.json'), `${JSON.stringify(context.module.exports.catalog, null, 2)}\n`)
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

if (require.main === module) {
  const mode = process.argv[2]
  const archive = mode === '--archive' || mode === '--example'
  const output = archive ? process.argv[3] : mode
  if (!output) throw new Error('official UI output directory is required')
  const operation = archive ? buildArchive(path.resolve(output), { example: mode === '--example' }) : buildOfficialUI(path.resolve(output))
  operation.then(() => console.log('UI package built independently')).catch(error => { console.error(error); process.exitCode = 1 })
}

module.exports = { buildOfficialUI, buildExample, buildArchive }
