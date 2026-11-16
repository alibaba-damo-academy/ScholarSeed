import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { resolveExample } from '../../../scripts/shared/examples.cjs'

const DESKTOP_ROOT = fileURLToPath(new URL('../', import.meta.url))
const REPOSITORY_ROOT = resolve(DESKTOP_ROOT, '../..')
const DEVELOPMENT_ROOTS = [resolve(REPOSITORY_ROOT, 'examples'), ...['examples.cjs', 'examples.d.cts', 'preparation.cjs', 'preparation.d.cts'].map(name => resolve(REPOSITORY_ROOT, 'scripts/shared', name))]
const OUTPUT_DIRECTORIES = ['main', 'preload', 'renderer'] as const
const OUTPUT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.html', '.css'])
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const PREVIEW_MARKERS = ['/__preview/', 'scholarseed-preview-console', 'preview_unimplemented', '/preview/entry.tsx', '/preview/service.ts', '/preview/Console.tsx'] as const
const PRODUCTION_ENTRIES = [
  'src/main/index.ts', 'src/main/data-inspection.ts',
  'src/preload/index.ts', 'src/preload/overlay.ts', 'src/preload/menu.ts',
  'src/renderer/index.html', 'src/renderer/overlay.html', 'src/renderer/menu.html', 'src/renderer/monaco.html',
] as const

export interface PreviewExclusionOptions {
  readonly outputRoot?: string
  readonly sourceEntries?: readonly string[]
  readonly previewRoot?: string
  readonly developmentRoots?: readonly string[]
  readonly sampleFiles?: readonly string[]
}

export interface PreviewExclusionReport {
  readonly outputDirectories: readonly string[]
  readonly artifacts: readonly string[]
  readonly sourceModules: readonly string[]
  readonly unresolvedDynamicImports: readonly string[]
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix))
}

function scanDirectory(directory: string, artifacts: string[], samples: ReadonlyMap<number, ReadonlySet<string>>): void {
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) throw new Error(`Missing production output directory: ${directory}`)
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Production output symlink is outside verification scope: ${path}`)
    if (entry.isDirectory()) scanDirectory(path, artifacts, samples)
    else if (entry.isFile()) {
      const digests = samples.get(lstatSync(path).size)
      if (digests && digests.has(createHash('sha256').update(readFileSync(path)).digest('hex'))) throw new Error(`Example sample in production artifact: ${path}`)
      if (!OUTPUT_EXTENSIONS.has(extname(path))) continue
      const content = readFileSync(path, 'utf8')
      for (const marker of PREVIEW_MARKERS) {
        if (content.includes(marker)) throw new Error(`Preview marker ${marker} in production artifact: ${path}`)
      }
      artifacts.push(path)
    }
  }
}

function sourcePath(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const path = resolve(dirname(importer), specifier.split('?')[0])
  const candidates = [path, ...SOURCE_EXTENSIONS.map(extension => path + extension), ...SOURCE_EXTENSIONS.map(extension => resolve(path, 'index' + extension))]
  const found = candidates.find(candidate => existsSync(candidate) && lstatSync(candidate).isFile())
  if (found) return found
  if (SOURCE_EXTENSIONS.some(extension => path.endsWith(extension)) || !extname(path)) throw new Error(`Unresolved production source import ${specifier} from ${importer}`)
  return null
}

function sourceClosure(entries: readonly string[], previewRoot: string, developmentRoots: readonly string[]): Pick<PreviewExclusionReport, 'sourceModules' | 'unresolvedDynamicImports'> {
  const canonicalPreviewRoot = existsSync(previewRoot) ? realpathSync(previewRoot) : previewRoot
  const modules = new Set<string>()
  const unresolved = new Set<string>()
  function visit(path: string): void {
    if (!existsSync(path)) throw new Error(`Missing production source entry: ${path}`)
    const canonical = realpathSync(path)
    if (inside(canonicalPreviewRoot, canonical)) throw new Error(`Production source imports preview module: ${canonical}`)
    if (developmentRoots.some(root => inside(existsSync(root) ? realpathSync(root) : resolve(root), canonical))) throw new Error(`Production source imports development module: ${canonical}`)
    if (modules.has(canonical)) return
    modules.add(canonical)
    const extension = extname(canonical)
    const content = readFileSync(canonical, 'utf8')
    function follow(specifier: string): void {
      const child = sourcePath(canonical, specifier)
      if (child) visit(child)
    }
    if (extension === '.html') {
      for (const match of content.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)) follow(match[1].startsWith('/') ? '.' + match[1] : match[1])
      return
    }
    if (!SOURCE_EXTENSIONS.includes(extension)) return
    const syntax = ts.createSourceFile(canonical, content, ts.ScriptTarget.Latest, true, extension === '.tsx' || extension === '.jsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    function walk(node: ts.Node): void {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) follow(node.moduleSpecifier.text)
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        const argument = node.arguments[0]
        if (argument && ts.isStringLiteralLike(argument)) follow(argument.text)
        else unresolved.add(`${canonical}:${syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1}`)
      }
      ts.forEachChild(node, walk)
    }
    walk(syntax)
  }
  for (const entry of entries) visit(resolve(entry))
  return { sourceModules: [...modules].sort(), unresolvedDynamicImports: [...unresolved].sort() }
}

export function verifyProductionPreviewExclusion(options: PreviewExclusionOptions = {}): PreviewExclusionReport {
  const outputRoot = resolve(options.outputRoot ?? resolve(DESKTOP_ROOT, 'out'))
  const directories = OUTPUT_DIRECTORIES.map(directory => resolve(outputRoot, directory))
  const artifacts: string[] = []
  const samples = new Map<number, Set<string>>()
  const sampleFiles = options.sampleFiles ?? resolveExample().projects.flatMap(project => project.files.map(file => file.sourcePath))
  for (const sample of sampleFiles) {
    const bytes = readFileSync(sample)
    const hashes = samples.get(bytes.byteLength) ?? new Set<string>()
    hashes.add(createHash('sha256').update(bytes).digest('hex'))
    samples.set(bytes.byteLength, hashes)
  }
  for (const directory of directories) {
    const before = artifacts.length
    scanDirectory(directory, artifacts, samples)
    if (artifacts.length === before) throw new Error(`No JS/HTML/CSS artifacts in production output: ${directory}`)
  }
  const closure = sourceClosure(
    options.sourceEntries ?? PRODUCTION_ENTRIES.map(entry => resolve(DESKTOP_ROOT, entry)),
    resolve(options.previewRoot ?? resolve(DESKTOP_ROOT, 'preview')),
    options.developmentRoots ?? DEVELOPMENT_ROOTS,
  )
  return { outputDirectories: directories, artifacts: artifacts.sort(), ...closure }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const report = verifyProductionPreviewExclusion()
  process.stdout.write(JSON.stringify({ ...report, scope: 'Exact build output and static relative source-import closure; not signed package, plugin-resolved graph or runtime acceptance.' }, null, 2) + '\n')
}
