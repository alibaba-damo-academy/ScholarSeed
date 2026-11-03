import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { build as buildRenderer, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { build as buildPreload, version as esbuildVersion, type Plugin as EsbuildPlugin, type Loader } from 'esbuild'
import { supportedFontSources } from './renderer.ts'
import { PROTECTED_ASSETS, protectedDigest, verifyProtectedAssets, type ProtectedManifest } from './src/main/vaultipc.ts'
import { VAULT_ERROR } from './src/vault.ts'

const BUILD_FILES = ['electron.vite.config.ts', 'protected.ts', 'renderer.ts', 'endpoints.ts', 'package-lock.json', 'package.json', '../../scripts/vendor/texlive/manifest.json']
const SCRIPT_DOMAINS = ['pre', 'dev', 'ci', 'cd', 'shared']
const COMPILATION_DIRECTORIES = ['runtime', 'scripts', 'native', ...SCRIPT_DOMAINS.map(domain => `scripts/${domain}`)]
const SOURCE_LOADERS: Record<string, Loader> = { '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.cjs': 'js', '.mjs': 'js', '.json': 'json' }
const GENERATED_CODE_QUERIES = new Set(['commonjs-proxy', 'commonjs-entry', 'commonjs-es-import'])
const FORBIDDEN = /(?:\/src\/renderer\/src\/(?:api|store|browser|live)\.(?:ts|tsx)$|\/src\/preload\/index\.ts$|\/src\/renderer\/src\/app\/|\/vite\/.*client|(?:^|\/)@vite\/client)/
const OUTPUT_PARENT = 'out/protected'
export const PROTECTED_DEFINE = { generation: '__VAULT_PROTECTED_GENERATION__', digest: '__VAULT_PROTECTED_MANIFEST_DIGEST__', binding: '__VAULT_PROTECTED_BINDING__', watch: '__VAULT_PROTECTED_WATCH_UNSUPPORTED__' } as const
export function protectedWatchPolicy(): Plugin {
  return { name: 'protected-watch-admission', config(config) { return { define: { [PROTECTED_DEFINE.watch]: JSON.stringify(Boolean(config.build?.watch)) } } } }
}
function tree(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...tree(name))
    else if (entry.isFile()) files.push(name)
    else throw new Error(VAULT_ERROR.assets)
  }
  return files.sort()
}
function sourceInventory(root: string): string[] {
  const repositoryScripts = resolve(root, '../../scripts')
  const directories = [...COMPILATION_DIRECTORIES.map(name => join(root, name)), repositoryScripts,
    ...SCRIPT_DOMAINS.map(domain => join(repositoryScripts, domain))]
  const owned = directories.flatMap(directory => readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && SOURCE_LOADERS[extname(entry.name)]).map(entry => join(directory, entry.name)))
  return [...tree(join(root, 'src')), ...BUILD_FILES.map(name => join(root, name)), ...owned].sort()
}
export interface ProtectedCompilation {
  vitePlugins(): Plugin[]
  esbuildPlugin(watching: () => boolean): EsbuildPlugin
}
interface ProtectedBundle { generation: string; manifestDigest: string; directory: string; compilation: ProtectedCompilation }
function compilation(root: string, inventory: readonly string[], hashes: ReadonlyMap<string, string>, frozen: ReadonlyMap<string, Buffer>): ProtectedCompilation {
  const reject = (): never => { throw new Error(VAULT_ERROR.assets) }
  const checkFile = (filename: string): void => { if (protectedDigest(readFileSync(filename)) !== hashes.get(filename)) reject() }
  const check = (): void => {
    if (JSON.stringify(sourceInventory(root)) !== JSON.stringify(inventory)) reject()
    for (const filename of hashes.keys()) checkFile(filename)
  }
  const source = (id: string): { filename: string; bytes: Buffer } | null => {
    if (!isAbsolute(id)) return null
    const [path, query] = id.split('?')
    if (!existsSync(path)) return null
    const filename = realpathSync(path)
    if (query !== undefined) {
      if (frozen.has(filename) && SOURCE_LOADERS[extname(filename)] && !GENERATED_CODE_QUERIES.has(query)) reject()
      return null
    }
    const bytes = frozen.get(filename)
    if (bytes) { checkFile(filename); return SOURCE_LOADERS[extname(filename)] ? { filename, bytes } : null }
    if (!filename.split(/[\\/]/).includes('node_modules')) reject()
    return null
  }
  return {
    vitePlugins() {
      let watching = false
      const admitted = new Set<string>()
      const validate = (): void => { if (!watching) check() }
      return [{ name: 'protected-compilation-source', enforce: 'pre',
        configResolved(config) { watching = Boolean(config.build.watch) },
        buildStart() { admitted.clear(); validate() },
        load(id) {
          if (watching) return null
          const loaded = source(id)
          return loaded ? loaded.bytes.toString('utf8') : null
        },
        transform(code, id) {
          if (watching) return null
          const loaded = source(id)
          if (loaded) {
            if (code !== loaded.bytes.toString('utf8')) reject()
            admitted.add(loaded.filename)
          }
          return null
        }
      }, { name: 'protected-compilation-output', enforce: 'post',
        generateBundle: { order: 'post', handler() {
          validate()
          if (!watching) for (const id of this.getModuleIds()) {
            const loaded = source(id)
            if (loaded && !admitted.has(loaded.filename)) reject()
          }
        } },
        writeBundle: { order: 'post', handler: validate }
      }]
    },
    esbuildPlugin(watching) {
      return { name: 'protected-preload-source', setup(build) {
        build.onStart(() => { if (!watching()) check() })
        build.onLoad({ filter: /.*/, namespace: 'file' }, args => {
          if (watching()) return undefined
          const loaded = source(args.path)
          if (!loaded) return undefined
          const loader = SOURCE_LOADERS[extname(loaded.filename)]
          if (!loader) reject()
          return { contents: loaded.bytes, loader, resolveDir: resolve(loaded.filename, '..') }
        })
        build.onEnd(() => { if (!watching()) check() })
      } }
    }
  }
}
export async function buildProtected(options: { desktopRoot: string; command: 'serve' | 'build'; mode: string; outputRoot?: string }): Promise<ProtectedBundle> {
  const root = realpathSync(resolve(options.desktopRoot))
  const output = options.outputRoot ? resolve(options.outputRoot) : join(root, OUTPUT_PARENT)
  const staging = join(output, `staging-${randomUUID()}`)
  const sourceNames = sourceInventory(root)
  const frozen = new Map(sourceNames.map(name => [name, readFileSync(name)]))
  const sourceHashes = new Map([...frozen].map(([name, bytes]) => [name, protectedDigest(bytes)]))
  const closedCompilation = compilation(root, sourceNames, sourceHashes, frozen)
  const modules = new Set<string>()
  const moduleHash = (id: string): void => {
    const filename = id.split('?')[0]
    if (!isAbsolute(filename) || !existsSync(filename)) return
    if (FORBIDDEN.test(filename.replaceAll('\\', '/'))) throw new Error(VAULT_ERROR.assets)
    modules.add(filename)
    if (!sourceHashes.has(filename)) sourceHashes.set(filename, protectedDigest(readFileSync(filename)))
  }
  const inventory: Plugin = { name: 'protected-dependency-inventory', enforce: 'pre',
    resolveId(source) { if (/^(?:https?|wss?|data|blob):/i.test(source)) throw new Error(VAULT_ERROR.assets); return null },
    load(id) { moduleHash(id); return null }, transform(_code, id) { moduleHash(id); return null },
    generateBundle() { for (const id of this.getModuleIds()) moduleHash(id) } }
  const previousEnvironment = process.env.NODE_ENV
  const mode = options.command === 'serve' ? 'development' : options.mode
  try {
    process.env.NODE_ENV = mode === 'production' ? 'production' : 'development'
    mkdirSync(staging, { recursive: true })
    await buildRenderer({ configFile: false, mode, root: join(root, 'src/renderer'), base: './', publicDir: false,
      plugins: [...closedCompilation.vitePlugins(), react(), supportedFontSources(), inventory], logLevel: 'error',
      build: { outDir: join(staging, 'renderer'), emptyOutDir: true, watch: null, manifest: true, sourcemap: false, assetsInlineLimit: 0,
        rollupOptions: { input: join(root, 'src/renderer/vault.html') } } })
    const preload = await buildPreload({ absWorkingDir: root, entryPoints: ['src/preload/vault.ts'], outfile: join(staging, PROTECTED_ASSETS.preload),
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], metafile: true,
      plugins: [closedCompilation.esbuildPlugin(() => false)] })
    for (const filename of Object.keys(preload.metafile!.inputs)) moduleHash(resolve(root, filename))
    const viteManifest = join(staging, 'renderer/.vite/manifest.json')
    const graph = JSON.parse(readFileSync(viteManifest, 'utf8')) as Record<string, { file: string; imports?: string[]; css?: string[]; assets?: string[] }>
    const closure = new Set<string>([PROTECTED_ASSETS.entry, PROTECTED_ASSETS.preload])
    const collect = (entry: string): void => {
      const chunk = graph[entry]
      if (!chunk) throw new Error(VAULT_ERROR.assets)
      if (closure.has(`renderer/${chunk.file}`)) return
      closure.add(`renderer/${chunk.file}`)
      for (const name of [...(chunk.css ?? []), ...(chunk.assets ?? [])]) closure.add(`renderer/${name}`)
      for (const name of chunk.imports ?? []) collect(name)
    }
    for (const entry of Object.keys(graph)) collect(entry)
    rmSync(join(staging, 'renderer/.vite'), { recursive: true })
    const files = tree(staging).map(filename => {
      const path = relative(staging, filename).replaceAll('\\', '/')
      const bytes = readFileSync(filename)
      if (!closure.has(path)) throw new Error(VAULT_ERROR.assets)
      return { path, bytes: bytes.length, sha256: protectedDigest(bytes) }
    })
    const sources = [...sourceHashes].map(([filename, hash]) => {
      if (protectedDigest(readFileSync(filename)) !== hash) throw new Error(VAULT_ERROR.assets)
      return { path: relative(root, filename).replaceAll('\\', '/'), sha256: hash }
    }).sort((left, right) => left.path.localeCompare(right.path))
    if (JSON.stringify(sourceInventory(root)) !== JSON.stringify(sourceNames)) throw new Error(VAULT_ERROR.assets)
    const tools = { vite: JSON.parse(readFileSync(join(root, 'node_modules/vite/package.json'), 'utf8')).version, esbuild: esbuildVersion,
      command: options.command, mode, config: 'protected-v1' }
    const moduleNames = [...modules].map(filename => relative(root, filename).replaceAll('\\', '/')).sort()
    const generation = protectedDigest(JSON.stringify({ tools, sources, modules: moduleNames, files }))
    const manifest: ProtectedManifest = { version: PROTECTED_ASSETS.version, generation, tools, sources, modules: moduleNames, files }
    const bytes = Buffer.from(JSON.stringify(manifest))
    const manifestDigest = protectedDigest(bytes)
    writeFileSync(join(staging, PROTECTED_ASSETS.manifest), bytes)
    verifyProtectedAssets(staging, generation, manifestDigest)
    const directory = join(output, generation)
    if (existsSync(directory)) { verifyProtectedAssets(directory, generation, manifestDigest); rmSync(staging, { recursive: true }) }
    else renameSync(staging, directory)
    return { generation, manifestDigest, directory, compilation: closedCompilation }
  } finally {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousEnvironment
    if (existsSync(staging)) rmSync(staging, { recursive: true })
  }
}
