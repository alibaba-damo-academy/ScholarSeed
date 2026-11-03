import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from 'electron-vite'
import { build } from 'vite'
import { createHash } from 'node:crypto'

const DESKTOP_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CANDIDATE_PREFIX = 'scholarseed-development-'
const BUILD_TARGETS = ['main', 'preload']
const CONFIGURATION_ENVIRONMENT = ['NODE_ENV', 'VITE_USER_NODE_ENV', 'BROWSER', 'BROWSER_ARGS', 'ELECTRON_MAJOR_VER', 'ELECTRON_EXEC_PATH']
const candidates = new WeakMap()
const publications = new Set()

export class DevelopmentPublicationRejected extends Error {
  constructor(cause) {
    super(`development publication rejected; previous outputs restored: ${cause.message}`, { cause })
    this.name = 'DevelopmentPublicationRejected'
    this.previousOutputsIntact = true
  }
}

async function inventory(directory) {
  const files = {}
  async function visit(relative) {
    const filename = path.join(directory, relative)
    const stat = await fs.lstat(filename)
    if (stat.isSymbolicLink()) throw new Error(`development output contains link: ${filename}`)
    if (stat.isDirectory()) {
      files[relative] = 'directory'
      for (const name of (await fs.readdir(filename)).sort()) await visit(path.join(relative, name))
    } else if (stat.isFile()) {
      files[relative] = createHash('sha256').update(await fs.readFile(filename)).digest('hex')
    } else throw new Error(`development output is not a regular file: ${filename}`)
  }
  await visit('')
  return files
}

async function directoryOrMissing(directory) {
  try {
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`development output is not an owned directory: ${directory}`)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function ownership(directory) {
  const files = await inventory(directory)
  const entries = []
  for (const name of Object.keys(files)) {
    const stat = await fs.lstat(path.join(directory, name), { bigint: true })
    entries.push([name, files[name], String(stat.dev), String(stat.ino), String(stat.birthtimeNs)])
  }
  return serializeOwnership(entries)
}

function serializeOwnership(entries) {
  return JSON.stringify(entries.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
}

async function directoryIdentity(directory) {
  const stat = await fs.lstat(directory, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`development output is not an owned directory: ${directory}`)
  return JSON.stringify([String(stat.dev), String(stat.ino), String(stat.birthtimeNs)])
}

function subtreeOwnership(tree, relative) {
  if (!relative) return tree
  const entries = JSON.parse(tree).filter(entry => entry[0] === relative || entry[0].startsWith(relative + path.sep))
  return entries.length ? serializeOwnership(entries.map(([name, ...identity]) => [path.relative(relative, name), ...identity])) : null
}

function replaceOwnership(tree, relative, replacement) {
  if (!relative) return replacement
  const retained = JSON.parse(tree).filter(entry => entry[0] !== relative && !entry[0].startsWith(relative + path.sep))
  return serializeOwnership([...retained, ...(replacement === null ? [] : JSON.parse(replacement).map(([name, ...identity]) => [path.join(relative, name), ...identity]))])
}

async function requireOwnership(directory, expected) {
  if (await ownership(directory) !== expected) throw new Error(`development output ownership changed; preserve ${directory}`)
}

async function outputOwnership(output) {
  const snapshot = {}
  for (const target of [...BUILD_TARGETS, 'protected']) {
    const directory = path.join(output, target)
    snapshot[target] = await directoryOrMissing(directory) ? await ownership(directory) : null
  }
  return JSON.stringify(snapshot)
}

export async function compileCandidate({ desktopRoot = DESKTOP_ROOT, parentDirectory = os.tmpdir() } = {}) {
  const root = await fs.realpath(desktopRoot)
  await fs.mkdir(parentDirectory, { recursive: true })
  const parent = await fs.realpath(parentDirectory)
  const directory = await fs.mkdtemp(path.join(parent, CANDIDATE_PREFIX))
  const protectedDirectory = path.join(directory, 'protected')
  const configFile = path.join(directory, 'candidate.config.mjs')
  const previousEnvironment = new Map(CONFIGURATION_ENVIRONMENT.map(name => [name, process.env[name]]))
  try {
    await fs.writeFile(configFile,
      `import { desktopConfiguration } from ${JSON.stringify(path.join(root, 'electron.vite.config.ts'))}\n` +
      `export default ({ command, mode }) => desktopConfiguration({ command, mode, protectedOutputRoot: ${JSON.stringify(protectedDirectory)} })\n`,
      { flag: 'wx', mode: 0o600 })
    const resolved = await resolveConfig({ root, configFile, mode: 'development' }, 'serve', 'development')
    if (!resolved.config?.main || !resolved.config.preload) throw new Error('development candidate requires main and preload configurations')
    for (const target of BUILD_TARGETS) {
      const configuration = resolved.config[target]
      await build({ ...configuration, build: {
        ...configuration.build, outDir: path.join(directory, target), emptyOutDir: true, watch: null
      } })
    }
    await fs.unlink(configFile)
    const candidate = { directory, main: path.join(directory, 'main'), preload: path.join(directory, 'preload'),
      protected: protectedDirectory, published: false,
      rendererConfig: resolved.config.renderer ? { ...resolved.config.renderer, configFile: false } : undefined }
    const files = await inventory(directory)
    for (const target of [...BUILD_TARGETS, 'protected']) {
      if (files[target] !== 'directory' || !Object.keys(files).some(name => name.startsWith(target + path.sep) && files[name] !== 'directory')) {
        throw new Error(`development candidate requires nonempty ${target} outputs`)
      }
    }
    candidates.set(candidate, { root, files, directory, state: 'ready' })
    return candidate
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  } finally {
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

export async function publishCandidate(candidate, desktopRoot = DESKTOP_ROOT, { previousStopped = false } = {}) {
  if (!previousStopped) throw new Error('development publication requires the previous instance to be stopped')
  const record = candidates.get(candidate)
  if (!record || record.state !== 'ready') throw new Error('development candidate is not ready or owned by this compiler')
  if (publications.has(record.root)) throw new Error('development root already has a pending publication')
  publications.add(record.root)
  try {
    const publication = await publishOwnedCandidate(candidate, desktopRoot, record)
    return {
      directory: publication.directory,
      async rollback(options) {
        await publication.rollback(options)
        publications.delete(record.root)
      },
      async commit() {
        await publication.commit()
        publications.delete(record.root)
      }
    }
  } catch (error) {
    if (record.state === 'ready') publications.delete(record.root)
    throw error
  }
}

async function validateCandidate(candidate, desktopRoot) {
  const record = candidates.get(candidate)
  if (!record || record.state !== 'ready') throw new Error('development candidate is not ready or owned by this compiler')
  desktopRoot ??= record.root
  const root = await fs.realpath(desktopRoot)
  if (root !== record.root || await fs.realpath(record.directory) !== record.directory || candidate.directory !== record.directory ||
      BUILD_TARGETS.some(target => candidate[target] !== path.join(record.directory, target)) ||
      candidate.protected !== path.join(record.directory, 'protected') ||
      JSON.stringify(await inventory(record.directory)) !== JSON.stringify(record.files)) {
    throw new Error('development candidate identity or contents changed')
  }
  return record
}

export async function candidateNative(candidate) {
  const record = await validateCandidate(candidate)
  const relative = path.join('main', 'lease.node')
  const expected = record.files[relative]
  if (!expected || expected === 'directory') throw new Error('development candidate requires native lease output')
  const bytes = await fs.readFile(path.join(record.directory, relative))
  if (createHash('sha256').update(bytes).digest('hex') !== expected || record.state !== 'ready') {
    throw new Error('development candidate native contents changed')
  }
  return bytes
}

async function publishOwnedCandidate(candidate, desktopRoot, record) {
  await validateCandidate(candidate, desktopRoot)
  const root = record.root
  const output = path.join(root, 'out')
  if (!await directoryOrMissing(output)) await fs.mkdir(output)
  const protectedRoot = path.join(output, 'protected')
  const protectedExists = await directoryOrMissing(protectedRoot)
  for (const target of BUILD_TARGETS) await directoryOrMissing(path.join(output, target))
  const outputIdentity = await directoryIdentity(output)
  const previousOwnership = await outputOwnership(output)
  const transaction = await fs.mkdtemp(path.join(output, '.development-'))
  const transactionIdentity = await directoryIdentity(transaction)
  const operations = []
  const states = new Map(Object.entries(JSON.parse(previousOwnership)).map(([target, identity]) => [path.join(output, target), identity]))
  states.set(transaction, await ownership(transaction))
  let createdProtectedOwnership
  record.state = 'publishing'
  async function requireRoots() {
    if (await directoryIdentity(output) !== outputIdentity || await directoryIdentity(transaction) !== transactionIdentity) {
      throw new Error(`development publication root ownership changed; preserve ${transaction}`)
    }
  }
  async function requireStates() {
    await requireRoots()
    for (const [directory, expected] of states) {
      if (expected === null) {
        if (await directoryOrMissing(directory)) throw new Error(`development output appeared; preserve ${directory}`)
      } else await requireOwnership(directory, expected)
    }
    await requireRoots()
  }
  function location(filename) {
    for (const directory of states.keys()) {
      const relative = path.relative(directory, filename)
      if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) return { directory, relative }
    }
    throw new Error(`development move is outside owned outputs: ${filename}`)
  }
  function expectedAt(filename) {
    const { directory, relative } = location(filename)
    const tree = states.get(directory)
    return tree === null ? null : subtreeOwnership(tree, relative)
  }
  function replaceAt(filename, identity) {
    const { directory, relative } = location(filename)
    states.set(directory, replaceOwnership(states.get(directory), relative, identity))
  }
  async function transfer(source, destination, identity, completed) {
    await requireStates()
    if (expectedAt(source) !== identity || identity === null || expectedAt(destination) !== null) {
      throw new Error(`development move ownership changed; preserve ${source}`)
    }
    await fs.rename(source, destination)
    replaceAt(source, null)
    replaceAt(destination, identity)
    completed()
    await requireStates()
  }
  async function move(source, destination) {
    const identity = expectedAt(source)
    await transfer(source, destination, identity, () => operations.push({ source, destination, identity }))
  }
  async function restore() {
    await requireStates()
    while (operations.length) {
      const operation = operations.at(-1)
      await transfer(operation.destination, operation.source, operation.identity, () => operations.pop())
    }
    if (createdProtectedOwnership) {
      await requireStates()
      await requireOwnership(protectedRoot, createdProtectedOwnership)
      await fs.rmdir(protectedRoot)
      states.set(protectedRoot, null)
      createdProtectedOwnership = undefined
    }
    if (await outputOwnership(output) !== previousOwnership) throw new Error('development previous output ownership was not restored')
    await requireStates()
    await fs.rm(transaction, { recursive: true })
    record.state = 'ready'
    candidate.published = false
  }
  try {
    for (const target of [...BUILD_TARGETS, 'protected']) {
      await requireStates()
      await fs.cp(path.join(record.directory, target), path.join(transaction, target), { recursive: true, errorOnExist: true, force: false })
      await requireRoots()
      const destination = path.join(transaction, target)
      const expected = await inventory(path.join(record.directory, target))
      if (JSON.stringify(await inventory(destination)) !== JSON.stringify(expected)) throw new Error('development candidate copy changed')
      replaceAt(destination, await ownership(destination))
      await requireStates()
    }
    if (JSON.stringify(await inventory(record.directory)) !== JSON.stringify(record.files)) throw new Error('development candidate changed during publication')
    for (const target of [...BUILD_TARGETS, 'protected']) {
      const expected = await inventory(path.join(record.directory, target))
      if (JSON.stringify(await inventory(path.join(transaction, target))) !== JSON.stringify(expected)) throw new Error('development candidate copy changed')
    }
    if (!protectedExists) {
      await requireStates()
      await fs.mkdir(protectedRoot)
      createdProtectedOwnership = await ownership(protectedRoot)
      states.set(protectedRoot, createdProtectedOwnership)
      await requireStates()
    }
    for (const generation of await fs.readdir(path.join(transaction, 'protected'))) {
      const source = path.join(transaction, 'protected', generation)
      const destination = path.join(protectedRoot, generation)
      const stat = await fs.lstat(source)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('development protected output requires generation directories')
      if (await directoryOrMissing(destination)) {
        if (JSON.stringify(await inventory(source)) !== JSON.stringify(await inventory(destination))) throw new Error(`protected generation collision: ${generation}`)
      } else await move(source, destination)
    }
    for (const target of BUILD_TARGETS) {
      const destination = path.join(output, target)
      if (expectedAt(destination) !== null) await move(destination, path.join(transaction, `${target}.previous`))
      await move(path.join(transaction, target), destination)
    }
    record.state = 'published'
    candidate.published = true
  } catch (error) {
    try { await restore() } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `development publication rollback incomplete; preserve ${transaction}`)
    }
    throw new DevelopmentPublicationRejected(error)
  }
  return {
    directory: transaction,
    async rollback({ previousStopped: stopped = false } = {}) {
      if (!stopped) throw new Error('development rollback requires the new instance to be stopped')
      if (record.state !== 'published') throw new Error('development publication is no longer pending')
      await restore()
    },
    async commit() {
      if (record.state !== 'published') throw new Error('development publication is no longer pending')
      await requireStates()
      await fs.rm(transaction, { recursive: true })
      operations.length = 0
      record.state = 'committed'
    }
  }
}
