const { createHash } = require('node:crypto')
const { lstatSync, readFileSync, realpathSync } = require('node:fs')
const { isAbsolute, join, relative, resolve, sep } = require('node:path')

const SCHEMA_VERSION = 1
const EXAMPLE_ROOT = resolve(__dirname, '../../examples')
const ID_PATTERN = /^[a-z][a-z0-9-]*$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const ERROR = Object.freeze({ schema: 'example_schema', path: 'example_path', link: 'example_link', integrity: 'example_integrity', selection: 'example_selection', reference: 'example_reference', revision: 'example_revision', unknown: 'example_unknown' })

class ExampleError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`)
    this.name = 'ExampleError'
    this.code = code
  }
}

function fail(code, detail) { throw new ExampleError(code, detail) }

function shape(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(ERROR.schema, 'object required')
  for (const key of required) if (!Object.hasOwn(value, key)) fail(ERROR.schema, `missing ${key}`)
  for (const key of Object.keys(value)) if (![...required, ...optional].includes(key)) fail(ERROR.unknown, key)
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(ERROR.schema, label)
  return value
}

function identity(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail(ERROR.reference, 'invalid identity')
  return value
}

function version(value) {
  if (value !== SCHEMA_VERSION) fail(ERROR.schema, 'unsupported schemaVersion')
}

function portablePath(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || /[\\:\x00-\x1f<>"|?*]/.test(value)) fail(ERROR.path, 'relative portable path required')
  const parts = value.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || RESERVED_NAME.test(part))) fail(ERROR.path, value)
  return parts
}

function sourcePath(root, path) {
  const parts = portablePath(path)
  let current = root
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const entry = lstatSync(current)
    if (entry.isSymbolicLink()) fail(ERROR.link, path)
    if (index < parts.length - 1 && !entry.isDirectory()) fail(ERROR.path, path)
  }
  const actual = realpathSync(current)
  const inside = relative(root, actual)
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || !lstatSync(actual).isFile()) fail(ERROR.path, path)
  return actual
}

function json(root, path) {
  return JSON.parse(readFileSync(sourcePath(root, path), 'utf8'))
}

function fileMetadata(path) {
  const entry = lstatSync(path)
  if (!entry.isFile() || entry.isSymbolicLink()) fail(ERROR.link, 'regular file required')
  const bytes = readFileSync(path)
  return { size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function readExampleFile(file) {
  if (sourcePath(file.sourceRoot, relative(file.sourceRoot, file.sourcePath).split(sep).join('/')) !== file.sourcePath) fail(ERROR.path, file.id)
  const entry = lstatSync(file.sourcePath)
  if (!entry.isFile() || entry.isSymbolicLink()) fail(ERROR.link, file.id)
  const bytes = readFileSync(file.sourcePath)
  if (bytes.byteLength !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) fail(ERROR.integrity, file.id)
  return bytes
}

function provenance(value) {
  shape(value, ['kind', 'origin', 'rights'])
  if (!['synthetic', 'reviewed-local'].includes(value.kind)) fail(ERROR.schema, 'source kind not supported')
  text(value.origin, 'source origin')
  text(value.rights, 'source rights')
}

function validateFile(file) {
  shape(file, ['id', 'target', 'size', 'sha256', 'mediaType'], ['source', 'assetId', 'assetRevision', 'fileId'])
  identity(file.id)
  portablePath(file.target)
  text(file.mediaType, 'mediaType')
  if (!Number.isSafeInteger(file.size) || file.size < 0 || !HASH_PATTERN.test(file.sha256)) fail(ERROR.schema, 'invalid file integrity metadata')
  const local = Object.hasOwn(file, 'source')
  const shared = ['assetId', 'assetRevision', 'fileId'].some(key => Object.hasOwn(file, key))
  if (local === shared) fail(ERROR.reference, 'choose source or shared asset')
  if (local) portablePath(file.source)
  else {
    identity(file.assetId)
    identity(file.fileId)
    text(file.assetRevision, 'assetRevision')
  }
}

function checkTargets(files) {
  const ids = new Set()
  const targets = []
  for (const file of files) {
    if (ids.has(file.id)) fail(ERROR.reference, 'duplicate file id')
    ids.add(file.id)
    const target = file.target.normalize('NFC').toLowerCase()
    if (targets.some(previous => previous === target || previous.startsWith(target + '/') || target.startsWith(previous + '/'))) fail(ERROR.path, 'conflicting targets')
    targets.push(target)
  }
}

function sharedFile(root, reference) {
  const base = `assets/${reference.assetId}`
  const asset = json(root, `${base}/manifest.json`)
  shape(asset, ['schemaVersion', 'id', 'revision', 'source', 'files'])
  version(asset.schemaVersion)
  provenance(asset.source)
  if (asset.id !== reference.assetId || asset.revision !== reference.assetRevision) fail(ERROR.revision, reference.assetId)
  if (!Array.isArray(asset.files)) fail(ERROR.schema, 'asset files')
  const ids = new Set()
  for (const file of asset.files) {
    shape(file, ['id', 'source', 'size', 'sha256', 'mediaType'])
    identity(file.id)
    portablePath(file.source)
    if (ids.has(file.id)) fail(ERROR.reference, 'duplicate asset file id')
    ids.add(file.id)
  }
  const file = asset.files.find(entry => entry.id === reference.fileId)
  if (!file) fail(ERROR.reference, reference.fileId)
  if (file.sha256 !== reference.sha256 || file.size !== reference.size || file.mediaType !== reference.mediaType) fail(ERROR.integrity, reference.id)
  return sourcePath(root, `${base}/${file.source}`)
}

function project(root, reference) {
  identity(reference.key)
  const projectId = identity(reference.projectId)
  const base = `projects/${projectId}`
  const definition = json(root, `${base}/project.json`)
  shape(definition, ['schemaVersion', 'id', 'revision', 'name', 'description', 'source', 'files'])
  version(definition.schemaVersion)
  if (definition.id !== projectId) fail(ERROR.reference, projectId)
  text(definition.revision, 'project revision')
  if (reference.projectRevision !== undefined && reference.projectRevision !== definition.revision) fail(ERROR.revision, projectId)
  text(definition.name, 'project name')
  if (typeof definition.description !== 'string') fail(ERROR.schema, 'description')
  provenance(definition.source)
  if (!Array.isArray(definition.files)) fail(ERROR.schema, 'project files')
  definition.files.forEach(validateFile)
  checkTargets(definition.files)
  const files = definition.files.map(file => {
    const path = Object.hasOwn(file, 'source') ? sourcePath(root, `${base}/${file.source}`) : sharedFile(root, file)
    const resolved = { id: file.id, path: file.target, sourcePath: path, sourceRoot: root, mediaType: file.mediaType, size: file.size, sha256: file.sha256 }
    readExampleFile(resolved)
    return resolved
  })
  const { kind, origin, rights } = definition.source
  return { key: reference.key, id: projectId, revision: definition.revision, name: definition.name, description: definition.description, source: { kind, origin, rights }, files }
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

function resolveExample(options = {}) {
  shape(options, [], ['root', 'projectId', 'workspaceId', 'expectedDigest'])
  if (options.projectId !== undefined && options.workspaceId !== undefined) fail(ERROR.selection, 'projectId and workspaceId are exclusive')
  const root = realpathSync(resolve(options.root ?? EXAMPLE_ROOT))
  let selection
  let references
  if (options.workspaceId !== undefined) {
    const id = identity(options.workspaceId)
    const workspace = json(root, `workspaces/${id}.json`)
    shape(workspace, ['schemaVersion', 'id', 'revision', 'projects'])
    version(workspace.schemaVersion)
    if (workspace.id !== id) fail(ERROR.reference, id)
    text(workspace.revision, 'workspace revision')
    if (!Array.isArray(workspace.projects)) fail(ERROR.schema, 'workspace projects')
    for (const reference of workspace.projects) {
      shape(reference, ['key', 'projectId', 'projectRevision'])
      text(reference.projectRevision, 'projectRevision')
    }
    references = workspace.projects
    selection = { kind: 'workspace', id, revision: workspace.revision }
  } else {
    let id = options.projectId
    if (id === undefined) {
      const manifest = json(root, 'manifest.json')
      shape(manifest, ['schemaVersion', 'defaultProjectId'])
      version(manifest.schemaVersion)
      id = manifest.defaultProjectId
    }
    identity(id)
    references = [{ key: id, projectId: id }]
    selection = { kind: 'project', id }
  }
  const keys = new Set()
  const projects = references.map(reference => {
    if (keys.has(reference.key)) fail(ERROR.reference, 'duplicate project key')
    keys.add(reference.key)
    return project(root, reference)
  })
  if (selection.kind === 'project') selection.revision = projects[0].revision
  const identityData = { schemaVersion: SCHEMA_VERSION, selection, projects: projects.map(({ files, ...entry }) => ({ ...entry, files: files.map(({ sourcePath: _path, sourceRoot: _root, ...file }) => file) })) }
  const contentDigest = createHash('sha256').update(JSON.stringify(identityData)).digest('hex')
  if (options.expectedDigest !== undefined && options.expectedDigest !== contentDigest) fail(ERROR.integrity, 'frozen input differs')
  return freeze({ schemaVersion: SCHEMA_VERSION, selection, contentDigest, projects })
}

module.exports = { EXAMPLE_ROOT, ExampleError, resolveExample, readExampleFile, fileMetadata }
