import { lstat, readdir } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_LIMIT = 40
const MAX_LIMIT = 200
const RECORDS_ROOTS = ['.ai/work-records/', 'work-records/']
const EXCLUDED_DIRECTORY = 'reflections'
const MARKDOWN_EXTENSION = '.md'
const ERROR_EXIT_CODE = 1
const comparePaths = (left, right) => left < right ? -1 : left > right ? 1 : 0

async function checkedPath(absolutePath) {
  const parsed = parse(absolutePath)
  let current = parsed.root
  for (const component of absolutePath.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = join(current, component)
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink()) throw new Error(`Symbolic link is not allowed: ${current}`)
  }
  return lstat(absolutePath)
}

function validateScope(scope) {
  if (typeof scope !== 'string' || isAbsolute(scope) || scope.includes('\\')) {
    throw new Error('Scopes must be relative .ai/work-records or historical work-records paths using / separators')
  }
  const components = scope.split('/')
  if (!RECORDS_ROOTS.some(root => scope.startsWith(root)) || components.some(component => !component || component === '.' || component === '..' || component === EXCLUDED_DIRECTORY)) {
    throw new Error(`Invalid or excluded scope: ${scope}`)
  }
}

export async function inventory({ root, scopes, limit = DEFAULT_LIMIT } = {}) {
  if (typeof root !== 'string' || !root) throw new Error('--root is required')
  if (!Array.isArray(scopes) || !scopes.length) throw new Error('At least one explicit task scope is required')
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`--limit must be an integer from 1 to ${MAX_LIMIT}`)
  const repository = resolve(root)
  if (!(await checkedPath(repository)).isDirectory()) throw new Error('Root must be a directory')
  const selected = []
  for (const scope of scopes) {
    validateScope(scope)
    const absolutePath = resolve(repository, scope)
    const metadata = await checkedPath(absolutePath)
    if (!metadata.isFile() && !metadata.isDirectory()) throw new Error(`Unsupported scope: ${scope}`)
    selected.push(absolutePath)
  }
  const files = new Map()
  const exclusions = new Map()
  const visited = new Set()
  const displayPath = absolutePath => relative(repository, absolutePath).split(sep).join('/')
  async function visit(absolutePath) {
    if (visited.has(absolutePath)) return
    visited.add(absolutePath)
    const metadata = await lstat(absolutePath)
    const path = displayPath(absolutePath)
    if (metadata.isSymbolicLink()) {
      exclusions.set(path, { path, reason: 'symlink' })
    } else if (parse(absolutePath).base === EXCLUDED_DIRECTORY && metadata.isDirectory()) {
      exclusions.set(path, { path, reason: 'reflections' })
    } else if (metadata.isDirectory()) {
      for (const name of (await readdir(absolutePath)).sort(comparePaths)) await visit(join(absolutePath, name))
    } else if (metadata.isFile() && absolutePath.endsWith(MARKDOWN_EXTENSION)) {
      files.set(path, { path, size: metadata.size })
    }
  }
  for (const absolutePath of selected.sort(comparePaths)) await visit(absolutePath)
  const orderedFiles = [...files.values()].sort((left, right) => comparePaths(left.path, right.path))
  const orderedExclusions = [...exclusions.values()].sort((left, right) => comparePaths(left.path, right.path))
  return {
    files: orderedFiles.slice(0, limit),
    truncated: orderedFiles.length > limit,
    exclusions: orderedExclusions.slice(0, limit),
    exclusionsTruncated: orderedExclusions.length > limit
  }
}

function argumentsForCLI(args) {
  const options = { scopes: [] }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--root' || argument === '--limit') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`)
      const key = argument.slice(2)
      if (key in options) throw new Error(`Duplicate option: ${argument}`)
      if (argument === '--limit' && !/^[1-9][0-9]*$/.test(value)) throw new Error('Invalid --limit')
      options[key] = argument === '--limit' ? Number(value) : value
      index += 1
    } else if (argument.startsWith('--')) {
      throw new Error(`Unknown option: ${argument}`)
    } else {
      options.scopes.push(argument)
    }
  }
  return options
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await inventory(argumentsForCLI(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = ERROR_EXIT_CODE
  }
}
