import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PreviewMcp, PreviewMcpError, PREVIEW_MCP } from './mcp.ts'

const HTTP_SERVER = { id: 'test-http', transport: 'http', name: 'Mock configuration', enabled: true, url: 'https://arbitrary.example.invalid/mcp' }
const replacement = (expected_revision: number, servers: unknown[] = [HTTP_SERVER]) => ({ expected_revision, servers, wait_for_application: true })

test('MCP configuration persists only instance memory with honest non-executed statuses and revision fences', async () => {
  const owner = new PreviewMcp()
  const empty = await owner.read()
  assert.deepEqual(empty.configuration, { schema_version: 1, revision: 0, servers: [] })
  assert.equal(empty.state, 'saved')
  const input = replacement(0)
  const saved = await owner.replace(input)
  input.servers.length = 0
  assert.equal(saved.configuration.revision, 1)
  assert.equal(saved.servers[0].state, 'failed')
  assert.equal(saved.servers[0].tool_count, null)
  assert.equal(saved.servers[0].safe_error, PREVIEW_MCP.runtimeNotExecuted)
  assert.deepEqual(saved.configuration.servers[0], { ...HTTP_SERVER, headers: {}, header_secrets: {} })
  saved.configuration.servers.length = 0
  assert.equal((await owner.read()).configuration.servers.length, 1)
  await assert.rejects(owner.replace(replacement(0)), (error: PreviewMcpError) => error.status === 409 && error.message === PREVIEW_MCP.conflict)
  const disabled = await owner.replace(replacement(1, [{ ...HTTP_SERVER, enabled: false }, { id: 'stdio', transport: 'stdio', command: 'anything', args: ['--nothing-executed'], environment: {} }]))
  assert.equal(disabled.servers[0].state, 'disabled')
  assert.equal(disabled.servers[0].safe_error, '')
  assert.equal(disabled.servers[1].state, 'failed')
  assert.equal((await new PreviewMcp().read()).configuration.revision, 0)
  assert.equal((await owner.replace(replacement(2, []))).configuration.servers.length, 0)
})

test('MCP rejects malformed DTOs and credential-bearing maps or URLs without echoing input', async () => {
  const owner = new PreviewMcp()
  const invalid: unknown[] = [null, [], {}, { ...replacement(0), extra: true }, { ...replacement(0), expected_revision: true }, { ...replacement(0), expected_revision: -1 }, { ...replacement(0), wait_for_application: 'true' }, replacement(0, [HTTP_SERVER, HTTP_SERVER]), replacement(0, [{ ...HTTP_SERVER, enabled: 'yes' }]), replacement(0, [{ ...HTTP_SERVER, unknown: true }]), replacement(0, [{ ...HTTP_SERVER, id: '../bad' }]), replacement(0, [{ ...HTTP_SERVER, url: 'file:///private' }]), replacement(0, [{ ...HTTP_SERVER, url: 'https://username:password@example.invalid' }]), replacement(0, [{ ...HTTP_SERVER, url: 'https://example.invalid/#fragment' }]), replacement(0, [{ ...HTTP_SERVER, url: 'https://example.invalid/ white' }]), replacement(0, [{ transport: 'stdio', id: 'stdio', command: ' ', args: [] }]), replacement(0, [{ transport: 'stdio', id: 'stdio', command: 'echo', args: [1] }])]
  for (const payload of invalid) await assert.rejects(owner.replace(payload), (error: PreviewMcpError) => error.status === 422 && error.message === PREVIEW_MCP.invalid)
  for (const codePoint of Array.from({ length: 32 }, (_, index) => index)) {
    await assert.rejects(owner.replace(replacement(0, [{ ...HTTP_SERVER, url: `https://example.invalid/${String.fromCodePoint(codePoint)}path` }])), (error: PreviewMcpError) => error.status === 422 && error.message === PREVIEW_MCP.invalid, `URL control character ${codePoint}`)
  }
  for (const server of [{ ...HTTP_SERVER, headers: { 'X-Private': 'must-not-be-echoed' } }, { ...HTTP_SERVER, header_secrets: { Authorization: 'must-not-be-echoed' } }, { id: 'stdio', transport: 'stdio', command: 'echo', environment: { TOKEN: 'must-not-be-echoed' } }, { id: 'stdio', transport: 'stdio', command: 'echo', environment_secrets: { TOKEN: 'must-not-be-echoed' } }, { ...HTTP_SERVER, url: 'https://example.invalid/?token=must-not-be-echoed' }]) {
    await assert.rejects(owner.replace(replacement(0, [server])), (error: PreviewMcpError) => error.status === 403 && error.message === PREVIEW_MCP.credentialsUnsupported && !error.message.includes('must-not-be-echoed'))
  }
  assert.equal((await owner.read()).configuration.revision, 0)
})

test('MCP fail-once only consumes a valid revision-fenced write and leaves the original draft retryable', async () => {
  const owner = new PreviewMcp({ read: 'normal', write: 'fail-once' })
  await assert.rejects(owner.replace(replacement(2)), (error: PreviewMcpError) => error.status === 409)
  await assert.rejects(owner.replace({}), (error: PreviewMcpError) => error.status === 422)
  await assert.rejects(owner.replace(replacement(0)), (error: PreviewMcpError) => error.status === 503 && error.message === PREVIEW_MCP.writeFailure)
  assert.equal((await owner.read()).configuration.revision, 0)
  assert.equal((await owner.replace(replacement(0))).configuration.revision, 1)
  const failed = new PreviewMcp({ read: 'failed', write: 'normal' })
  for (const attempt of [0, 1]) {
    await assert.rejects(failed.read(), (error: PreviewMcpError) => error.status === 503 && error.message === PREVIEW_MCP.readFailure, `read attempt ${attempt}`)
  }
})

test('MCP delayed reads and writes are bounded, concurrent writes fenced, and dispose/abort cancel old effects', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewMcp({ read: 'delayed', write: 'delayed' })
  let completed = false
  const reading = owner.read().then(value => { completed = true; return value })
  context.mock.timers.tick(PREVIEW_MCP.delayMs - 1)
  await Promise.resolve()
  assert.equal(completed, false)
  context.mock.timers.tick(1)
  await reading
  const first = owner.replace(replacement(0))
  const stale = owner.replace(replacement(0)).then(() => 'unexpected', (error: PreviewMcpError) => error.status)
  context.mock.timers.tick(PREVIEW_MCP.delayMs)
  assert.equal((await first).configuration.revision, 1)
  assert.equal(await stale, 409)
  const controller = new AbortController()
  const aborted = owner.replace(replacement(1, []), controller.signal)
  controller.abort()
  await assert.rejects(aborted, (error: PreviewMcpError) => error.status === 410)
  const pendingRead = owner.read()
  const pendingWrite = owner.replace(replacement(1, []))
  owner.dispose()
  await assert.rejects(pendingRead, (error: PreviewMcpError) => error.status === 410)
  await assert.rejects(pendingWrite, (error: PreviewMcpError) => error.status === 410)
  context.mock.timers.tick(PREVIEW_MCP.delayMs)
  await assert.rejects(owner.read(), (error: PreviewMcpError) => error.status === 410)
})
