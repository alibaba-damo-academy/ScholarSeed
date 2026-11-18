import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { validatePluginBinding } from './main/skills.ts'

import {
  SKILLS_PATH,
  SKILL_SURFACE_CONVERSATION,
  SKILL_SURFACE_SETTINGS,
  skillRequest,
} from './skills.ts'

test('skill updates bind the local name and both installed and offered versions', () => {
  const request = skillRequest({
    operation: 'marketplace-update',
    name: 'paper-tools',
    version: '2.0',
    expectedVersion: '1.0',
  })
  assert.equal(request.path, `${SKILLS_PATH}/paper-tools/update`)
  assert.equal(request.init.method, 'POST')
  assert.deepEqual(JSON.parse(String(request.init.body)), {
    version: '2.0',
    expectedVersion: '1.0',
  })
})

test('marketplace labels and filters preserve remote identity and language in device requests', () => {
  assert.equal(
    skillRequest({ operation: 'marketplace-labels', locale: 'zh-CN' }).path,
    `${SKILLS_PATH}/marketplace/labels?locale=zh-CN`
  )
  const request = skillRequest({
    operation: 'marketplace',
    query: 'paper',
    cursor: '2',
    label: 'research',
    locale: 'zh',
  })
  const url = new URL(request.path, 'http://localhost')
  assert.equal(url.searchParams.get('label'), 'research')
  assert.equal(url.searchParams.get('locale'), 'zh')
  assert.equal(url.searchParams.get('cursor'), '2')
  assert.equal(url.searchParams.get('include_attribution'), 'false')
  assert.equal(
    skillRequest({
      operation: 'marketplace-attribution',
      namespace: 'research',
      slug: 'paper--review',
      version: '1.2.3',
    }).path,
    `${SKILLS_PATH}/marketplace/items/research/paper--review/attribution?version=1.2.3`
  )
  assert.match(
    skillRequest({ operation: 'list', surface: SKILL_SURFACE_SETTINGS, locale: 'en' }).path,
    /locale=en/
  )
})

test('marketplace installation forwards the chosen activation preference', () => {
  for (const enabled of [false, true]) {
    const request = skillRequest({
      operation: 'marketplace-install',
      slug: 'paper-tools',
      version: '1.0',
      enabled,
    })
    assert.deepEqual(JSON.parse(String(request.init.body)), { version: '1.0', enabled })
  }
})

test('delivery actions bind the original session and request without renderer filesystem paths', () => {
  for (const action of ['status', 'check', 'skip', 'directory'] as const) {
    const request = {
      operation: 'plugin-delivery' as const,
      session: 'session-one',
      request: 'request-one',
      action,
    }
    const mapped = skillRequest(request)
    assert.equal(mapped.path, `${SKILLS_PATH}/plugins/delivery`)
    assert.equal(mapped.init.method, 'POST')
    assert.deepEqual(JSON.parse(String(mapped.init.body)), request)
  }
})

test('plugin confirmation binds exact candidate digest and explicit grants', () => {
  const request = {
    operation: 'plugin-confirm' as const,
    candidate: 'opaque',
    sha256: 'digest',
    grants: ['skills.list'],
    confirmed: true as const,
  }
  const mapped = skillRequest(request)
  assert.equal(mapped.path, `${SKILLS_PATH}/plugins/confirm`)
  assert.equal(mapped.init.method, 'POST')
  assert.deepEqual(JSON.parse(String(mapped.init.body)), request)
  assert.deepEqual(mapped.init.headers, { 'Content-Type': 'application/json' })
})

test('plugin UI lookup requests its fixed interaction reference rather than current installation', () => {
  const reference = {
    plugin: 'research',
    component: 'card',
    fingerprint: 'revision-one',
    binding: 'interaction-one',
  }
  const mapped = skillRequest({ operation: 'plugin-open', reference })
  assert.equal(mapped.path, `${SKILLS_PATH}/plugins/binding`)
  assert.equal(mapped.init.method, 'POST')
  assert.deepEqual(JSON.parse(String(mapped.init.body)), { reference })
  assert.equal(
    skillRequest({ operation: 'plugin-preview-installed', name: '../other' }).path,
    `${SKILLS_PATH}/..%2Fother/plugin`
  )
})

test('component RPC and draft writes carry the immutable reference through bounded host routes', () => {
  const reference = {
    plugin: 'methods',
    component: 'compare',
    fingerprint: 'v1',
    binding: 'binding-one',
  }
  const call = skillRequest({ operation: 'plugin-call', reference, action: 'list', values: {} })
  assert.equal(call.path, `${SKILLS_PATH}/plugins/action`)
  assert.deepEqual(JSON.parse(String(call.init.body)), { reference, action: 'list', values: {} })
  const draft = skillRequest({
    operation: 'plugin-draft',
    reference,
    session_id: 'session-one',
    expected_revision: 2,
    values: { selected: ['a'] },
  })
  assert.equal(draft.path, `${SKILLS_PATH}/plugins/draft`)
  assert.deepEqual(JSON.parse(String(draft.init.body)), {
    reference,
    session_id: 'session-one',
    expected_revision: 2,
    values: { selected: ['a'] },
  })
})

test('requests the conversation skill surface without changing the base management route', () => {
  assert.deepEqual(skillRequest({ operation: 'list' }), {
    path: SKILLS_PATH,
    init: { method: 'GET' },
  })
  assert.deepEqual(skillRequest({ operation: 'list', surface: SKILL_SURFACE_CONVERSATION }), {
    path: `${SKILLS_PATH}?surface=conversation`,
    init: { method: 'GET' },
  })
  assert.deepEqual(skillRequest({ operation: 'list', surface: SKILL_SURFACE_SETTINGS }), {
    path: `${SKILLS_PATH}?surface=settings`,
    init: { method: 'GET' },
  })
})

test('marketplace operations stay inside the device skill route with encoded identities', () => {
  assert.deepEqual(
    skillRequest({ operation: 'marketplace', query: 'paper & data', cursor: 'next' }),
    {
      path: `${SKILLS_PATH}/marketplace?query=paper+%26+data&cursor=next`,
      init: { method: 'GET' },
    }
  )
  assert.deepEqual(
    skillRequest({ operation: 'marketplace-detail', slug: 'paper-tools', version: '1.0' }),
    {
      path: `${SKILLS_PATH}/marketplace/items/paper-tools?version=1.0`,
      init: { method: 'GET' },
    }
  )
  assert.deepEqual(
    skillRequest({ operation: 'marketplace-install', slug: 'paper-tools', version: '1.0' }),
    {
      path: `${SKILLS_PATH}/marketplace/items/paper-tools/install`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: '1.0' }),
      },
    }
  )
  assert.throws(() =>
    skillRequest({ operation: 'remote-url', url: 'http://evil.example' } as never)
  )
})

function nativeSkillHandler(overrides: Record<string, unknown> = {}) {
  const source = ts.createSourceFile(
    'index.ts',
    readFileSync(new URL('./main/index.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const callbacks: ts.Expression[] = []
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'ipcMain.handle' &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === 'SKILLS_CHANNEL'
    )
      callbacks.push(node.arguments[1])
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.equal(callbacks.length, 1)
  const compiled = ts.transpileModule(`const handler = ${callbacks[0].getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const dependencies = {
    skillRequest,
    validatePluginBinding,
    URL,
    Headers,
    apiBase: 'http://127.0.0.1:9000',
    isMainWindowSender: () => true,
    HOST_PROCESS_HEADER: 'X-Test-Host-Key',
    backendHostProcessKey: () => 'test-key',
    ...overrides,
  }
  return new Function(...Object.keys(dependencies), compiled + '\nreturn handler;')(
    ...Object.values(dependencies)
  )
}

test('native skill handler preserves JSON content type and adds only the host capability', async () => {
  const handler = nativeSkillHandler()
  let captured: RequestInit | undefined
  const event = {
    sender: {
      session: {
        fetch: async (_url: string, init: RequestInit) => {
          captured = init
          return { status: 200, text: async () => '{}' }
        },
      },
    },
  }
  await handler(event, { operation: 'marketplace-install', slug: 'paper-tools', version: '1.0' })
  const headers = new Headers(captured?.headers)
  assert.equal(headers.get('content-type'), 'application/json')
  assert.equal(headers.get('X-Test-Host-Key'), 'test-key')
  assert.equal(headers.get('authorization'), null)
  assert.equal(captured?.redirect, 'error')
})

test('lease validation aborts status-only requests before checking current ownership', async () => {
  for (const status of [200, 403]) {
    for (const revoked of [false, true]) {
      let current = true
      let aborted = false
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024))
            controller.close()
          },
        }),
        { status }
      )
      const handler = nativeSkillHandler({
        plugins: {
          valid: () => current,
          reference: () => ({
            plugin: 'review',
            component: 'card',
            fingerprint: 'fixed',
            binding: 'bound',
          }),
        },
      })
      const result = await handler(
        {
          sender: {
            session: {
              fetch: async (_url: string, init: RequestInit) => {
                assert.ok(init.signal)
                assert.equal(init.signal.aborted, false)
                init.signal.addEventListener('abort', () => {
                  aborted = true
                  if (revoked) current = false
                })
                return response
              },
            },
          },
        },
        {
          operation: 'plugin-valid',
          lease: 'active-lease',
        }
      )
      assert.equal(aborted, true, `binding request leaked for status ${status}`)
      assert.equal(response.bodyUsed, true)
      assert.deepEqual(result, { status: revoked ? 410 : status, body: '{}' })
    }
  }
})
