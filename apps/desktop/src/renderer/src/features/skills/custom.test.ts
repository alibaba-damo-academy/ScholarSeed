import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CUSTOM_INVALID,
  customConfig,
  isCustomTimeout,
  parseCustomImport,
  serializeCustom,
} from './custom.ts'

test('optional timeout validation shares the inclusive millisecond boundary with the form', () => {
  for (const value of [undefined, null, 1000, 30000]) {
    assert.equal(isCustomTimeout(value), true)
    assert.doesNotThrow(() => customConfig('Local', { command: 'npx', timeout: value }))
  }
  for (const value of [30, 0, 999, -1000, 1000.5, NaN, Infinity, true, '1000']) {
    assert.equal(isCustomTimeout(value), false)
    assert.throws(() => customConfig('Local', { command: 'npx', timeout: value }), {
      message: CUSTOM_INVALID,
    })
  }
})

test('remote URL parse failures use the configuration error contract in form and JSON modes', () => {
  for (const transport of ['http', 'sse']) {
    for (const url of ['', '   ', 'not-a-url', '/relative/mcp', 'https://', 'https://[invalid']) {
      assert.throws(() => customConfig('Remote', { transport, url }), {
        message: CUSTOM_INVALID,
      })
      assert.throws(
        () => parseCustomImport(JSON.stringify({ mcpServers: { Remote: { transport, url } } })),
        { message: CUSTOM_INVALID, entry: 'Remote' }
      )
    }
    const url = 'https://example.com/mcp'
    const server = customConfig('Remote', { transport, url })
    assert.equal(server.transport, transport)
    if (server.transport !== 'stdio') assert.equal(server.url, url)
  }
})

test('imports multiple HTTP and STDIO declarations with connection intent', () => {
  const rows = parseCustomImport(
    JSON.stringify({
      mcpServers: {
        remote: {
          type: 'streamable-http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer private' },
        },
        local: { command: 'node', args: ['path with spaces', ''], env: { API_KEY: 'private' } },
      },
    })
  )
  assert.equal(rows.length, 2)
  assert.equal(rows[0].enabled, true)
  assert.equal(rows[1].transport, 'stdio')
  if (rows[1].transport === 'stdio') assert.deepEqual(rows[1].args, ['path with spaces', ''])
})

test('invalid batch is rejected rather than silently dropping unsupported configuration', () => {
  for (const value of [
    { mcpServers: { one: { type: 'unknown', url: 'https://example.com/sse' } } },
    { mcpServers: { one: { url: 'https://example.com/mcp', timeout: 999 } } },
    { mcpServers: { one: { command: 'node', args: 'not-array' } } },
    { mcpServers: { one: { url: 'https://example.com/mcp?api_key=secret' } } },
    {
      mcpServers: { one: { url: 'https://example.com/mcp', headers: { Authorization: 'a\r\nb' } } },
    },
    { mcpServers: { ONE: { command: 'node' }, one: { command: 'node' } } },
    { mcpServers: {} },
    { mcpServers: { one: { command: 'node' } }, other: {} },
  ])
    assert.throws(() => parseCustomImport(JSON.stringify(value)))
})

test('form and JSON roundtrip preserves metadata, timeout and ordered arguments', () => {
  const [original] = parseCustomImport(
    JSON.stringify({
      mcpServers: {
        Local: {
          command: 'node',
          args: ['with spaces', '', '--last'],
          description: 'Research tools',
          timeout: 1250,
          env: { TOKEN: '' },
        },
      },
    })
  )
  assert.deepEqual(parseCustomImport(serializeCustom(original)), [original])
})

test('legacy SSE import remains distinct from streamable HTTP', () => {
  const [server] = parseCustomImport(
    JSON.stringify({ mcpServers: { Events: { type: 'sse', url: 'https://example.com/sse' } } })
  )
  assert.equal(server.transport, 'sse')
  assert.deepEqual(parseCustomImport(serializeCustom(server)), [server])
})

test('working directories preserve POSIX, drive and UNC paths without host conversion', () => {
  for (const cwd of [
    '/Users/research/work',
    'C:\\Research Files\\work',
    '\\\\server\\share\\work',
  ]) {
    const [server] = parseCustomImport(
      JSON.stringify({ mcpServers: { local: { command: 'python', cwd } } })
    )
    assert.equal(server.transport, 'stdio')
    if (server.transport === 'stdio') assert.equal(server.cwd, cwd)
  }
  assert.throws(() =>
    parseCustomImport(
      JSON.stringify({ mcpServers: { local: { command: 'python', cwd: 'relative/path' } } })
    )
  )
})

test('startup timeout is independent and survives custom JSON round trips', () => {
  const server = customConfig('Slow', {
    url: 'https://example.com/mcp',
    startup_timeout: 1250,
    timeout: 9000,
  })
  assert.equal(server.startup_timeout, 1250)
  assert.equal(parseCustomImport(serializeCustom(server))[0].startup_timeout, 1250)
  assert.equal(server.timeout, 9000)
  for (const startup_timeout of [true, 0, 999, 1.5, '1000', Infinity]) {
    assert.throws(() => customConfig('Bad', { url: 'https://example.com/mcp', startup_timeout }), {
      message: CUSTOM_INVALID,
    })
  }
  assert.equal(
    customConfig('Default', { url: 'https://example.com/mcp' }).startup_timeout,
    undefined
  )
})
