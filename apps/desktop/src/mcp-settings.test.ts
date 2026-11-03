import assert from 'node:assert/strict'
import test from 'node:test'

import { mcpSettingsRequest } from './mcp-settings.ts'

test('connector operations use a fixed host-only route, never a renderer-provided URL', () => {
  const request = mcpSettingsRequest({
    operation: 'connector',
    id: 'github',
    action: { operation: 'login' },
  })
  assert.equal(request.path, '/api/settings/connectors/github')
  assert.equal(request.init.method, 'POST')
  assert.deepEqual(JSON.parse(String(request.init.body)), { operation: 'login' })
  for (const id of [
    '../callback',
    'https://evil.example',
    'github?secret=private',
    'github/callback',
  ]) {
    assert.throws(() =>
      mcpSettingsRequest({ operation: 'connector', id, action: { operation: 'login' } })
    )
  }
})

test('catalog and existing custom MCP settings retain separate routes', () => {
  assert.equal(mcpSettingsRequest({ operation: 'connectors' }).path, '/api/settings/connectors')
  assert.equal(mcpSettingsRequest({ operation: 'status' }).path, '/api/settings/mcp')
})
