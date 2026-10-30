import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { SubscriptionRequest, SubscriptionReply } from './subscriptions'
import { subscriptionAuthorizationUrl, subscriptionLoginPath } from './subscriptions.ts'

const MAIN_GUARD_FUNCTIONS = ['aliveMainWindow', 'isMainWindowSender']

function senderGuard(mainWindow: unknown) {
  const source = ts.createSourceFile(
    'index.ts',
    readFileSync(new URL('./main/index.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const declarations = source.statements.filter(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      MAIN_GUARD_FUNCTIONS.includes(statement.name?.text ?? '')
  )
  assert.equal(declarations.length, MAIN_GUARD_FUNCTIONS.length)
  const output = ts.transpileModule(
    declarations.map((statement) => statement.getText(source)).join('\n'),
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }
  ).outputText
  return runInNewContext(`${output}\nisMainWindowSender`, { mainWindow }) as (
    sender: unknown,
    senderFrame?: unknown
  ) => boolean
}

for (const scenario of [
  { name: 'main frame', frame: 'main', allowed: true },
  { name: 'child frame', frame: 'child', allowed: false },
  { name: 'detached frame', frame: null, allowed: false },
  { name: 'internal sender without a frame', frame: undefined, allowed: true },
  { name: 'foreign web contents', frame: 'main', foreign: true, allowed: false },
  { name: 'destroyed window', frame: 'main', windowDestroyed: true, allowed: false },
  { name: 'destroyed web contents', frame: 'main', contentsDestroyed: true, allowed: false },
  { name: 'missing window', frame: 'main', missing: true, allowed: false },
]) {
  test(`main-window subscription guard handles ${scenario.name}`, () => {
    const mainFrame = {}
    const webContents = { mainFrame, isDestroyed: () => scenario.contentsDestroyed ?? false }
    const mainWindow = { webContents, isDestroyed: () => scenario.windowDestroyed ?? false }
    const frame =
      scenario.frame === 'main' ? mainFrame : scenario.frame === 'child' ? {} : scenario.frame
    const guard = senderGuard(scenario.missing ? null : mainWindow)
    assert.equal(guard(scenario.foreign ? {} : webContents, frame), scenario.allowed)
  })
}

test('subscription browser capability rejects arbitrary external URLs and path injection', () => {
  const allowed =
    'https://auth.openai.com/api/accounts/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&code_challenge_method=S256'
  assert.equal(subscriptionAuthorizationUrl(allowed), allowed)
  for (const url of [
    allowed.replace('auth.openai.com', 'untrusted.example'),
    allowed.replace('https:', 'http:'),
    allowed.replace('127.0.0.1', 'localhost'),
    'file:///etc/passwd',
    'javascript:alert(1)',
  ]) {
    assert.throws(() => subscriptionAuthorizationUrl(url))
  }
  assert.equal(
    subscriptionLoginPath('personal-oauth-123'),
    '/api/settings/model-connections/personal-oauth-123/login'
  )
  for (const id of ['../auth/logout', 'personal-foo/bar', '', 'https://example.com'])
    assert.throws(() => subscriptionLoginPath(id))
})

test('subscription error codes retain localized presentation', () => {
  const main = readFileSync(new URL('./main/index.ts', import.meta.url), 'utf8')
  const consumer = readFileSync(
    new URL('./renderer/src/components/business/SubscriptionConnections.tsx', import.meta.url),
    'utf8'
  )
  // 源码形态契约：守卫与主机头一旦漂移，订阅 IPC 会静默降级。正则对换行空白容忍，
  // 以免整文件格式化（pre-commit prettier）把契约撞红。
  assert.match(
    main,
    /ipcMain\.handle\(\s*SUBSCRIPTION_CHANNEL,[\s\S]*?if \(!isMainWindowSender\(event\.sender, event\.senderFrame\)\)/
  )
  assert.match(
    main,
    /backendManaged && endpoint\.protocol === 'http:' && endpoint\.hostname === '127\.0\.0\.1'/
  )
  assert.match(
    main,
    /method: 'POST',\s*redirect: 'error',\s*headers: \{ \[HOST_PROCESS_HEADER\]: backendHostProcessKey\(\) \}/
  )
  for (const code of [
    'local_service_required',
    'login_failed',
    'window_closed',
    'authorization_open_failed',
  ]) {
    assert.ok(consumer.includes(`${code}: t('ipc.`))
  }
  assert.match(consumer, /ipc: result\.errorCode, detail: result\.error/)
  const labels = ['zh', 'en'].map(
    (language) =>
      JSON.parse(
        readFileSync(
          new URL(`./localization/locales/${language}/subscription.json`, import.meta.url),
          'utf8'
        )
      ).ipc
  )
  assert.equal(labels[0].windowClosed, '登录窗口已关闭。')
  assert.equal(labels[1].windowClosed, 'The sign-in window has closed.')
  assert.equal(labels[0].diagnostic, '{{message}} {{detail}}')
  assert.equal(labels[1].diagnostic, '{{message}} {{detail}}')
})

const AUTHORIZATION_URL =
  'https://auth.openai.com/api/accounts/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&code_challenge_method=S256'
const LOGIN: SubscriptionRequest = { action: 'login', connectionId: 'personal-oauth-123' }

// Execute the registered callback and its actual sender guards. No Electron,
// network request, real credential or external browser is used by this fixture.
function loginFixture(
  options: {
    managed?: boolean
    workbenchReady?: boolean
    base?: string
    responseOK?: boolean
    responseClosed?: boolean
    openedClosed?: boolean
    openFailure?: boolean
    authorizationURL?: string
  } = {}
) {
  const requests: { url: string; init: RequestInit }[] = []
  const opened: string[] = []
  let destroyed = false
  let windowDestroyed = false
  const frame = {}
  const sender = {
    mainFrame: frame,
    isDestroyed: () => destroyed,
    session: {
      fetch: async (url: string, init: RequestInit) => {
        requests.push({ url, init })
        if (options.responseClosed) destroyed = true
        return {
          ok: options.responseOK !== false,
          json: async () => ({
            transaction_id: 'tx/1',
            state: 'waiting',
            expires_at: 123,
            detail: 'upstream detail',
            issuer_token: 'must-not-cross-ipc',
            authorization_url: options.authorizationURL ?? AUTHORIZATION_URL,
          }),
        }
      },
    },
  }
  const event = { sender, senderFrame: frame as object | null | undefined }
  const main = ts.createSourceFile(
    'index.ts',
    readFileSync(new URL('./main/index.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const callbacks: ts.Expression[] = []
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(main) === 'ipcMain.handle' &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === 'SUBSCRIPTION_CHANNEL'
    )
      callbacks.push(node.arguments[1])
    ts.forEachChild(node, visit)
  }
  visit(main)
  assert.equal(callbacks.length, 1)
  const helpers = ['aliveMainWindow', 'isMainWindowSender', 'requireDesktopWorkbench'].map(
    (name) => {
      const matches = main.statements.filter(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === name
      )
      assert.equal(matches.length, 1)
      return matches[0].getText(main)
    }
  )
  const dependencies = {
    desktopWorkbenchReady: () => options.workbenchReady ?? true,
    mainWindow: { webContents: sender, isDestroyed: () => windowDestroyed },
    backendManaged: options.managed ?? true,
    apiBase: options.base ?? 'http://127.0.0.1:9000',
    subscriptionLoginPath,
    subscriptionAuthorizationUrl,
    HOST_PROCESS_HEADER: 'X-Test-Host-Key',
    backendHostProcessKey: () => 'test-process-key',
    shell: {
      openExternal: async (url: string) => {
        opened.push(url)
        if (options.openedClosed) destroyed = true
        if (options.openFailure) throw new Error('browser unavailable')
      },
    },
  }
  const compiled = ts.transpileModule(
    helpers.join('\n') + `\nconst handler = ${callbacks[0].getText(main)};`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }
  ).outputText
  const run = new Function(...Object.keys(dependencies), compiled + '\nreturn handler;')(
    ...Object.values(dependencies)
  ) as (
    event: { sender: typeof sender; senderFrame?: object | null },
    request: SubscriptionRequest
  ) => Promise<SubscriptionReply>
  return {
    run,
    event,
    requests,
    opened,
    destroyWindow: () => {
      windowDestroyed = true
    },
    destroySender: () => {
      destroyed = true
    },
  }
}

test('subscription login waits for workbench admission before network or browser IO', async () => {
  const fixture = loginFixture({ workbenchReady: false })
  await assert.rejects(fixture.run(fixture.event, LOGIN), /ERR_WORKBENCH_NOT_READY/)
  assert.deepEqual(fixture.requests, [])
  assert.deepEqual(fixture.opened, [])
})

test('subscription rejects other windows, subframes, missing frames and destroyed owners before IO', async (t) => {
  for (const scenario of [
    'other-window',
    'subframe',
    'null-frame',
    'missing-frame',
    'closed-window',
    'destroyed-sender',
  ]) {
    await t.test(scenario, async () => {
      const fx = loginFixture()
      if (scenario === 'other-window') fx.event.sender = { ...fx.event.sender }
      if (scenario === 'subframe') fx.event.senderFrame = {}
      if (scenario === 'null-frame') fx.event.senderFrame = null
      if (scenario === 'missing-frame') fx.event.senderFrame = undefined
      if (scenario === 'closed-window') fx.destroyWindow()
      if (scenario === 'destroyed-sender') fx.destroySender()
      await assert.rejects(fx.run(fx.event, LOGIN), /main application window/)
      assert.deepEqual(fx.requests, [])
      assert.deepEqual(fx.opened, [])
    })
  }
})

test('subscription requires the managed loopback HTTP backend', async () => {
  for (const options of [
    { managed: false },
    { base: 'https://127.0.0.1:9000' },
    { base: 'http://remote.example:9000' },
  ]) {
    const fx = loginFixture(options)
    assert.deepEqual(await fx.run(fx.event, { action: 'available' }), { available: false })
    assert.deepEqual(await fx.run(fx.event, LOGIN), {
      available: false,
      errorCode: 'local_service_required',
    })
    assert.deepEqual(fx.requests, [])
    assert.deepEqual(fx.opened, [])
  }
})

test('subscription posts with the host capability and returns only the public login fields', async () => {
  const fx = loginFixture()
  assert.deepEqual(await fx.run(fx.event, { action: 'available' }), { available: true })
  assert.equal(fx.requests.length, 0)
  assert.deepEqual(await fx.run(fx.event, LOGIN), {
    available: true,
    login: { transaction_id: 'tx/1', state: 'waiting', expires_at: 123, error: '' },
  })
  assert.deepEqual(fx.requests, [
    {
      url: 'http://127.0.0.1:9000/api/settings/model-connections/personal-oauth-123/login',
      init: {
        method: 'POST',
        redirect: 'error',
        headers: { 'X-Test-Host-Key': 'test-process-key' },
      },
    },
  ])
  assert.deepEqual(fx.opened, [AUTHORIZATION_URL])
})

test('subscription preserves backend error details without opening a browser', async () => {
  const fx = loginFixture({ responseOK: false })
  assert.deepEqual(await fx.run(fx.event, LOGIN), {
    available: true,
    errorCode: 'login_failed',
    error: 'upstream detail',
  })
  assert.equal(fx.requests.length, 1)
  assert.deepEqual(fx.opened, [])
})

test('subscription cancels a created transaction after window closure or authorization opening failure', async (t) => {
  for (const scenario of ['response-closed', 'opened-closed', 'browser-failed', 'invalid-url']) {
    await t.test(scenario, async () => {
      const fx = loginFixture({
        responseClosed: scenario === 'response-closed',
        openedClosed: scenario === 'opened-closed',
        openFailure: scenario === 'browser-failed',
        authorizationURL: scenario === 'invalid-url' ? 'https://untrusted.example/' : undefined,
      })
      const result = await fx.run(fx.event, LOGIN)
      assert.equal(
        result.errorCode,
        scenario.endsWith('closed') ? 'window_closed' : 'authorization_open_failed'
      )
      assert.equal(result.login, undefined)
      assert.equal(fx.requests.length, 2)
      assert.deepEqual(fx.requests[1], {
        url: 'http://127.0.0.1:9000/api/settings/model-connections/personal-oauth-123/login/tx%2F1',
        init: { method: 'DELETE', redirect: 'error' },
      })
      assert.equal(fx.opened.length, ['response-closed', 'invalid-url'].includes(scenario) ? 0 : 1)
    })
  }
})
