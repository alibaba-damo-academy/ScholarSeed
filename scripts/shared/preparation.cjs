const { createHash } = require('node:crypto')
const { lstatSync, realpathSync } = require('node:fs')
const { basename, isAbsolute, relative, resolve, sep } = require('node:path')
const { setTimeout: wait } = require('node:timers/promises')
const { readExampleFile } = require('./examples.cjs')

const PREPARATION = Object.freeze({
  schemaVersion: 1,
  requestTimeoutMs: 30_000,
  operationTimeoutMs: 90_000,
  pollIntervalMs: 100,
  accepted: 202,
  unavailable: 503,
  ready: 'ready',
  failed: 'failed',
  preparing: 'preparing',
  operationQueued: 'queued',
  operationRunning: 'running',
  operationSucceeded: 'succeeded',
  projects: '/api/content/projects',
  catalogQuery: 'includeArchived=true',
  operation: '/api/content/operations/',
  tree: '/api/resource/tree',
  write: '/api/resource/write',
  node: '/api/resource/node',
  import: '/api/resource/import',
  raw: '/api/resource/raw',
})
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]'])
const TEXT_MEDIA = new Set(['application/json', 'application/xml', 'application/javascript'])
const BINARY_MEDIA = new Set(['application/pdf', 'image/png', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
const DECODER = new TextDecoder('utf-8', { fatal: true })
const OPERATION_PATTERN = /^[a-f0-9]{32}$/

class PreparationError extends Error {
  constructor(code, receipt) {
    super(code)
    this.name = 'PreparationError'
    this.code = code
    this.receipt = receipt
  }
}

function reject(code) { throw new Error(code) }

function endpoint(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') reject('preparation_endpoint_invalid')
  return url.origin
}

function directory(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) reject('preparation_workspace_absolute_required')
  const path = resolve(value)
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) reject('preparation_workspace_link_or_invalid')
  return path
}

function inside(root, path) {
  if (typeof path !== 'string' || !isAbsolute(path)) reject('preparation_project_root_invalid')
  const tail = relative(root, resolve(path))
  if (!tail || tail === '..' || tail.startsWith('..' + sep) || isAbsolute(tail)) reject('preparation_project_outside_workspace')
  return resolve(path)
}

function nodePath(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || /[\\:\x00-\x1f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) reject('preparation_resource_path_invalid')
  return value
}

function inputs(plan) {
  if (!plan || plan.schemaVersion !== PREPARATION.schemaVersion || !Array.isArray(plan.projects) || typeof plan.contentDigest !== 'string') reject('preparation_plan_invalid')
  return plan.projects.map(project => ({
    project,
    files: project.files.map(file => {
      const bytes = readExampleFile(file)
      nodePath(file.path)
      if (BINARY_MEDIA.has(file.mediaType)) {
        if (basename(file.sourcePath) !== file.path.split('/').at(-1)) reject('preparation_binary_name_mismatch')
        return { file, content: null }
      }
      if (!file.mediaType.startsWith('text/') && !TEXT_MEDIA.has(file.mediaType)) reject('preparation_binary_not_supported')
      let content
      try { content = DECODER.decode(bytes) } catch { reject('preparation_utf8_required') }
      if (content.includes('\0') || !Buffer.from(content, 'utf8').equals(bytes)) reject('preparation_utf8_required')
      return { file, content }
    }),
  }))
}

async function prepareExample({ baseUrl, workspace, plan, signal } = {}) {
  const receipt = { status: PREPARATION.preparing, contentDigest: plan?.contentDigest ?? '', selection: plan?.selection ?? null, workspace: '', projects: [] }
  try {
    const base = endpoint(baseUrl)
    const root = directory(workspace)
    receipt.workspace = root
    const prepared = inputs(plan)
    const timeout = AbortSignal.timeout(PREPARATION.operationTimeoutMs)
    const operationSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    operationSignal.throwIfAborted()
    const request = async (path, method = 'GET', body) => {
      const response = await fetch(base + path, {
        method,
        redirect: 'error',
        signal: AbortSignal.any([operationSignal, AbortSignal.timeout(PREPARATION.requestTimeoutMs)]),
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      })
      return response
    }
    const json = async (path, method = 'GET', body) => {
      const response = await request(path, method, body)
      if (!response.ok) reject(`preparation_http_${response.status}`)
      return response.json()
    }
    const listing = await json(`${PREPARATION.projects}?${PREPARATION.catalogQuery}`)
    if (!listing || typeof listing !== 'object' || Array.isArray(listing) || !Array.isArray(listing.projects) || listing.projects.some(project => !project || typeof project !== 'object' || Array.isArray(project) || typeof project.id !== 'string' || !project.id.trim())) reject('preparation_catalog_invalid')
    const currentIds = new Set(listing.projects.map(project => project.id))
    if (currentIds.size !== listing.projects.length) reject('preparation_catalog_invalid')
    if (directory(listing.workspaceRoot) !== root) reject('preparation_workspace_mismatch')
    if (prepared.length === 0 && currentIds.size !== 0) reject('preparation_workspace_not_empty')
    for (const { project, files } of prepared) {
      const name = prepared.length > 1 ? `${project.name} (${project.key})` : project.name
      const preview = await json(`${PREPARATION.projects}/directory?name=${encodeURIComponent(name)}`)
      const expectedRoot = inside(root, preview.root)
      const submitted = await request(PREPARATION.projects, 'POST', { name })
      if (submitted.status !== PREPARATION.accepted) reject(`preparation_creation_status_${submitted.status}`)
      const command = await submitted.json()
      if (!OPERATION_PATTERN.test(command.operation)) reject('preparation_operation_invalid')
      const record = { key: project.key, templateId: project.id, templateRevision: project.revision, operation: command.operation, id: '', name: '', root: '', files: [] }
      receipt.projects.push(record)
      let created
      while (!created) {
        const response = await request(PREPARATION.operation + command.operation)
        if (response.status !== PREPARATION.unavailable) {
          if (!response.ok) reject(`preparation_operation_http_${response.status}`)
          const result = await response.json()
          if (result.operation !== command.operation) reject('preparation_operation_identity_mismatch')
          if (result.state === PREPARATION.failed) reject('preparation_product_creation_failed')
          if (result.state === PREPARATION.operationSucceeded) {
            if (!result.result || typeof result.result !== 'object' || Array.isArray(result.result)) reject('preparation_operation_result_invalid')
            created = result.result
          }
          else if (![PREPARATION.operationQueued, PREPARATION.operationRunning].includes(result.state)) reject('preparation_operation_state_invalid')
        }
        if (!created) await wait(PREPARATION.pollIntervalMs, undefined, { signal: operationSignal })
      }
      if (!created || typeof created.id !== 'string' || !created.id || typeof created.name !== 'string' || currentIds.has(created.id)) reject('preparation_project_identity_invalid')
      const createdRoot = inside(root, created.root)
      if (createdRoot !== expectedRoot || directory(createdRoot) !== createdRoot) reject('preparation_project_root_mismatch')
      currentIds.add(created.id)
      Object.assign(record, { id: created.id, name: created.name, root: createdRoot })
      const tree = await json(`${PREPARATION.tree}?project=${encodeURIComponent(created.id)}`)
      if (tree.root !== createdRoot || !Array.isArray(tree.nodes) || tree.total !== 0 || tree.nodes.length !== 0 || Object.keys(tree.linked_roots ?? {}).length !== 0) reject('preparation_resource_root_not_empty')
      const resourceRoot = tree.resource_root === '' ? '' : nodePath(tree.resource_root)
      const createdFolders = new Set()
      for (const { file, content } of files) {
        const path = nodePath(resourceRoot ? `${resourceRoot}/${file.path}` : file.path)
        const parts = file.path.split('/')
        let parent = resourceRoot
        for (const name of parts.slice(0, -1)) {
          const folder = nodePath(parent ? `${parent}/${name}` : name)
          if (!createdFolders.has(folder)) {
            const result = await json(PREPARATION.node, 'POST', { project: created.id, action: 'create_folder', parent, name })
            if (result.node?.path !== folder || result.node?.kind !== 'dir') reject('preparation_folder_invalid')
            createdFolders.add(folder)
          }
          parent = folder
        }
        if (content === null) {
          readExampleFile(file)
          const imported = await json(PREPARATION.import, 'POST', { project: created.id, mode: 'copy', sources: [file.sourcePath], target_dir: parent })
          if (imported.status !== 'completed' || imported.mode !== 'copy' || imported.project_id !== created.id || !Array.isArray(imported.imported) || imported.imported.length !== 1 || imported.imported[0].path !== path || imported.imported[0].kind !== 'file') reject('preparation_import_invalid')
        } else {
          const written = await json(PREPARATION.write, 'POST', { project: created.id, path, content })
          if (written.saved !== true || written.path !== path) reject('preparation_write_invalid')
        }
        const raw = await request(`${PREPARATION.raw}?project=${encodeURIComponent(created.id)}&path=${encodeURIComponent(path)}`)
        if (!raw.ok) reject(`preparation_readback_http_${raw.status}`)
        const bytes = Buffer.from(await raw.arrayBuffer())
        if (bytes.byteLength !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) reject('preparation_readback_integrity')
        record.files.push({ id: file.id, path, relativePath: file.path, sha256: file.sha256, size: file.size, mediaType: file.mediaType })
      }
    }
    receipt.status = PREPARATION.ready
    return receipt
  } catch (error) {
    receipt.status = PREPARATION.failed
    throw new PreparationError(error instanceof Error ? error.message : 'preparation_failed', receipt)
  }
}

module.exports = { PreparationError, prepareExample }
