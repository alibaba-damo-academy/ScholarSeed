import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

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

test('native skill handler preserves JSON content type and adds only the host capability', async () => {
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
    URL,
    Headers,
    apiBase: 'http://127.0.0.1:9000',
    isMainWindowSender: () => true,
    HOST_PROCESS_HEADER: 'X-Test-Host-Key',
    backendHostProcessKey: () => 'test-key',
  }
  const handler = new Function(...Object.keys(dependencies), compiled + '\nreturn handler;')(
    ...Object.values(dependencies)
  )
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
