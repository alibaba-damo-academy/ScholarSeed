import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { resolveExample, readExampleFile } from '../../../scripts/shared/examples.cjs'
import { PreviewFiles } from './files.ts'
import { ProjectSimulation } from './project.ts'
import { createPreviewService } from './service.ts'

const ROOT = '/preview/examples'
const SEED = { id: 'example-project', name: 'Example project', root: `${ROOT}/project`, layout: 'managed' as const, available: true, created_at: 1 }

test('empty VFS is explicit and reset preserves the selected seed', () => {
  const files = new PreviewFiles()
  assert.deepEqual(files.manifest(), [])
  files.write('created.md', new TextEncoder().encode('created'))
  files.reset()
  assert.deepEqual(files.manifest(), [])
})

test('shared project seed consumes public identities and isolates writable instances', () => {
  const first = new PreviewFiles('example')
  const second = new PreviewFiles('example')
  const project = resolveExample().projects[0]
  assert.deepEqual(first.manifest().map(file => file.path), project.files.map(file => file.path).sort())
  for (const file of project.files) assert.deepEqual(first.read(file.path).bytes, new Uint8Array(readExampleFile(file)))
  first.write('sample.md', new TextEncoder().encode('isolated edit'))
  assert.notDeepEqual(first.read('sample.md').bytes, second.read('sample.md').bytes)
  first.reset()
  assert.deepEqual(first.manifest(), second.manifest())
})

test('created projects remain empty rather than inheriting either sample inventory', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const projects = new ProjectSimulation(ROOT, [SEED])
  try {
    assert.ok(projects.files(SEED.id).read('sample.md').bytes.length)
    const identity = projects.create('Empty project')
    context.mock.timers.tick(25)
    context.mock.timers.tick(250)
    await Promise.resolve()
    await Promise.resolve()
    const operation = projects.operation(identity)
    assert.equal(operation.state, 'succeeded')
    assert.ok(operation.result && 'id' in operation.result)
    assert.deepEqual(projects.files(operation.result.id).manifest(), [])
  } finally { projects.dispose() }
})

test('home projects expose the shared example while format scenes keep their reviewed inventory', async () => {
  const service = createPreviewService()
  const server = createServer((request, response) => service.middleware(request, response, () => response.writeHead(404).end()))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const headers = { 'x-preview-instance': 'shared-example', 'content-type': 'application/json' }
  try {
    const reset = await fetch(origin + '/__preview/reset', { method: 'POST', headers, body: JSON.stringify({ scene: 'home-states', pageId: 'page-home' }) })
    assert.equal(reset.status, 200)
    const response = await fetch(origin + '/api/resource/list?project=preview-project', { headers })
    assert.equal(response.status, 200)
    const listing = await response.json() as { items: { path: string }[] }
    assert.deepEqual(listing.items.map(file => file.path).sort(), resolveExample().projects[0].files.map(file => file.path).sort())
    const raw = await fetch(origin + '/api/resource/raw?project=preview-project&path=sample.md', { headers })
    assert.equal(await raw.text(), readExampleFile(resolveExample().projects[0].files.find(file => file.id === 'document')!).toString())
    const formats = new PreviewFiles('reviewed')
    assert.ok(formats.read('sample.pdf').bytes.length)
    assert.ok(formats.read('sample.docx').bytes.length)
  } finally {
    service.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
