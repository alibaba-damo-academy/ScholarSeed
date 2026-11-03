import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { StartupState, STARTUP_PHASE } from '../startup.ts'

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
const functions = [
  'reportStartupFailure',
  'closeStartupScreen',
  'revealStartupWorkbench',
  'startPreparedBackend',
  'windowPresentationAllowed',
  'revealMainWindow',
  'activateAttention',
  'deliverAttentionActivation',
]
const selected = parsed.statements
  .filter(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      functions.includes(statement.name.text)
  )
  .map((statement) => statement.getText(parsed))
  .join('\n')
let beforeQuit = ''
const entries: Record<string, string> = {}
function visit(node: ts.Node): void {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(parsed) === 'app.on' &&
    ts.isStringLiteral(node.arguments[0]) &&
    node.arguments[0].text === 'before-quit'
  ) {
    beforeQuit = node.arguments[1].getText(parsed)
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(parsed) === 'app.on' &&
    ts.isStringLiteral(node.arguments[0]) &&
    ['activate', 'second-instance'].includes(node.arguments[0].text)
  )
    entries[node.arguments[0].text] = node.arguments[1].getText(parsed)
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(parsed) === 'windowsNotifications.show'
  ) {
    const options = node.arguments[1]
    if (ts.isObjectLiteralExpression(options)) {
      const click = options.properties.find(
        (property) => ts.isPropertyAssignment(property) && property.name.getText(parsed) === 'click'
      )
      if (click && ts.isPropertyAssignment(click)) entries.toast = click.initializer.getText(parsed)
    }
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(parsed) === 'notification.on' &&
    ts.isStringLiteral(node.arguments[0]) &&
    node.arguments[0].text === 'click'
  )
    entries.notification = node.arguments[1].getText(parsed)
  if (ts.isPropertyAssignment(node) && node.name.getText(parsed) === 'revealWindow')
    entries[`revealWindow:${node.pos}`] = node.initializer.getText(parsed)
  if (
    ts.isPropertyAssignment(node) &&
    node.name.getText(parsed) === 'activate' &&
    node.initializer.getText(parsed) === 'activateAttention'
  )
    entries.attention = node.initializer.getText(parsed)
  ts.forEachChild(node, visit)
}
visit(parsed)
assert.ok(beforeQuit)

function fixture(visible: boolean, headless = false, minimized = false) {
  const actions: string[] = []
  const updateSnapshots: Record<string, unknown>[] = []
  const parent = {
    isVisible: () => visible,
    isMinimized: () => minimized,
    isDestroyed: () => false,
    show: () => {
      actions.push('workbench')
    },
    restore: () => {
      actions.push('restore')
    },
    focus: () => {
      actions.push('focus')
    },
    isEnabled: () => true,
    isFocused: () => false,
    id: 1,
    webContents: {
      send: () => {
        actions.push('notification-click')
      },
    },
  }
  let resolveClose: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve
  })
  let failed = false
  let closing = false
  const surface = {
    fail: () => {
      failed = true
      actions.push('failure')
      return true
    },
    failed: () => failed,
    isClosing: () => closing,
    reveal: () => {
      actions.push('failure-reveal')
      return true
    },
    close: () => {
      closing = true
      return closed
    },
  }
  const context = {
    actions,
    parent,
    startupScreen: surface as typeof surface | null,
    startupScreenStartedAt: null,
    appQuitting: false,
    windowsUpdateMaintenanceActive: false,
    macUpdateMaintenanceActive: false,
    headless,
    startupFailureReports: 0,
    initialWindowLoad: null,
    pushLog: () => undefined,
    logWindowLifecycle: () => undefined,
    aliveMainWindow: () => parent,
    mainWindow: parent,
    mainWindowHiding: {
      cancel: () => {
        actions.push('hide-cancel')
      },
    },
    setLoginWindowVisible: null,
    MACOS_PLATFORM: 'darwin',
    process: { platform: 'darwin' },
    findNotificationUrl: () => null,
    findCallbackUrl: () => null,
    activeNotifications: new Set(),
    pendingAttentionId: null as string | null,
    attentionRendererReady: true,
    ATTENTION_CLICK_CHANNEL: 'attention-click',
    notification: {},
    input: { sessionId: 'test' },
    mainLocalization: () => ({ getFixedT: () => () => 'localized error' }),
    applyMainLanguage: async () => undefined,
    DEFAULT_LANGUAGE: 'zh',
    startupState: new StartupState(() => undefined),
    STARTUP_PHASE,
    prepareManagedRuntime: async () => false,
    startManagedBackend: async () => {
      actions.push('backend')
      return true
    },
    COMPONENT_TIMING: {},
    ComponentTimer: class {
      start() {
        return () => undefined
      }
      finish() {}
    },
    openStartupScreen: () => {
      actions.push('open')
      if (!context.startupScreen) {
        closing = false
        context.startupScreen = surface
      }
    },
    ensureBackendForWindow: async () => {
      actions.push('ensure-backend')
      return true
    },
    createWindow: async () => {
      actions.push('create-window')
    },
    finishApplicationShutdown: async () => {
      actions.push('drain')
    },
    dialog: {
      showMessageBox: async (owner: unknown) => {
        assert.equal(owner, parent)
        actions.push('parent-dialog')
      },
    },
    app: {
      whenReady: () => Promise.resolve(),
      getVersion: () => '0.2.0',
      exit: (code: number) => {
        actions.push(`exit:${code}`)
      },
      quit: () => {
        actions.push('quit')
      },
      focus: () => {
        actions.push('app-focus')
      },
    },
    runtimePreparation: null,
    browserVaultIpc: null,
    browserVault: null,
    updateInstallBlockingSince: null,
    updateInstallationInProgress: false,
    updateRestartRequested: false,
    currentUpdateSnapshot: () => ({ phase: 'installing' }),
    publishUpdateSnapshot: (snapshot: Record<string, unknown>) => {
      updateSnapshots.push(snapshot)
    },
    backendQuitFinished: false,
    backendQuitPending: false,
    backgroundUpdateTimerStopped: false,
    backgroundUpdateTimer: null,
    PREPARATION_QUIT_TIMEOUT_MS: 15_000,
    updatePreparation: { running: false, stop: async () => undefined },
    armBackgroundUpdateCheck: () => undefined,
    preferenceQuiescence: {
      allowInteraction: () => {
        actions.push('allow-interaction')
      },
      prepare: () => Promise.resolve(),
      resume: () => undefined,
      isPreparing: () => false,
    },
    Promise,
    Date,
    setTimeout,
    clearTimeout,
    setImmediate: (callback: () => void): void => {
      setImmediate(callback)
    },
  }
  const entrySource = Object.entries(entries)
    .map(([name, callback]) => `${JSON.stringify(name)}: (${callback})`)
    .join(',')
  const code = ts.transpileModule(
    selected + `\nthis.beforeQuit = (${beforeQuit}); this.entries = {${entrySource}};`,
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }
  ).outputText
  runInNewContext(
    code +
      '\nthis.report = reportStartupFailure; this.close = closeStartupScreen; this.reveal = revealStartupWorkbench; this.prepare = startPreparedBackend;',
    context
  )
  const api = context as typeof context & {
    report(title: string, message: string): void
    close(): Promise<void>
    reveal(window: typeof parent, usable?: () => boolean): Promise<boolean>
    prepare(): Promise<boolean>
    deliverAttentionActivation(): void
    beforeQuit(event: { preventDefault(): void }): void
    entries: Record<string, (...args: unknown[]) => void>
  }
  return { api, actions, surface, resolveClose: resolveClose!, updateSnapshots }
}

for (const readyAt of ['before-close', 'during-close', 'after-close']) {
  test(`startup notification is delivered once when renderer is ready ${readyAt}`, async () => {
    const current = fixture(false)
    current.api.attentionRendererReady = readyAt === 'before-close'
    current.api.entries.attention('pending-notification')
    assert.equal(current.api.pendingAttentionId, 'pending-notification')
    assert.equal(current.actions.includes('notification-click'), false)

    const handoff = current.api.reveal(current.api.parent)
    if (readyAt === 'during-close') {
      current.api.attentionRendererReady = true
      current.api.deliverAttentionActivation()
      assert.equal(current.actions.includes('notification-click'), false)
    }
    current.resolveClose()
    assert.equal(await handoff, true)
    if (readyAt === 'after-close') {
      assert.equal(current.actions.includes('notification-click'), false)
      current.api.attentionRendererReady = true
      current.api.deliverAttentionActivation()
    }
    assert.equal(current.api.pendingAttentionId, null)
    assert.equal(current.actions.filter((action) => action === 'notification-click').length, 1)
    assert.ok(current.actions.indexOf('workbench') < current.actions.indexOf('notification-click'))
    current.api.deliverAttentionActivation()
    assert.equal(current.actions.filter((action) => action === 'notification-click').length, 1)
  })
}

test('a superseded startup handoff retains the pending notification without dispatch', async () => {
  const current = fixture(false)
  current.api.entries.attention('pending-notification')
  let usable = true
  const handoff = current.api.reveal(current.api.parent, () => usable)
  usable = false
  current.resolveClose()
  assert.equal(await handoff, false)
  assert.equal(current.api.pendingAttentionId, 'pending-notification')
  assert.equal(current.actions.includes('notification-click'), false)
})

test('registered foreground entries regain normal behavior after startup ownership is released', async () => {
  for (const name of Object.keys(entries)) {
    const current = fixture(false, false, true)
    current.api.startupScreen = null
    if (name === 'second-instance') current.api.entries[name](null, [])
    else current.api.entries[name]('foreground')
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.ok(current.actions.includes('workbench'), name)
    assert.ok(current.actions.includes('focus'), name)
    if (['toast', 'notification'].includes(name))
      assert.ok(current.actions.includes('notification-click'), name)
  }
})

test('an invalid initial renderer cannot reveal the workbench before or after startup closure', async () => {
  const alreadyFailed = fixture(false)
  assert.equal(await alreadyFailed.api.reveal(alreadyFailed.api.parent, () => false), false)
  assert.deepEqual(alreadyFailed.actions, [])
  const lateFailure = fixture(false)
  let usable = true
  const handoff = lateFailure.api.reveal(lateFailure.api.parent, () => usable)
  usable = false
  lateFailure.resolveClose()
  assert.equal(await handoff, false)
  assert.equal(lateFailure.actions.includes('workbench'), false)
})

test('a constructed but hidden main window cannot capture startup failure in an invisible sheet', async () => {
  const current = fixture(false)
  current.api.report('failure', 'detail')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(current.actions, ['open', 'failure'])
})

test('a visible main window receives only an asynchronously parented error', async () => {
  const current = fixture(true)
  current.api.startupScreen = null
  current.api.report('failure', 'detail')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(current.actions, ['parent-dialog'])
})

test('a minimized main window cannot capture startup failure in an inaccessible sheet', async () => {
  const current = fixture(true, false, true)
  current.api.report('failure', 'detail')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(current.actions, ['open', 'failure'])
})

test('main retains the startup surface until its native closed completion', async () => {
  const current = fixture(false)
  const completion = current.api.close()
  assert.equal(current.api.startupScreen, current.surface)
  current.resolveClose()
  await completion
  assert.equal(current.api.startupScreen, null)
})

test('failure waits for a closing surface before creating its replacement', async () => {
  const current = fixture(false)
  const handoff = current.api.reveal(current.api.parent)
  current.api.report('failure', 'detail')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(current.actions, [])
  assert.equal(current.api.startupScreen, current.surface)
  current.resolveClose()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(await handoff, false)
  assert.deepEqual(current.actions, ['open', 'failure'])
  assert.equal(current.api.startupScreen, current.surface)
})

test('Dock activation without a main window cannot restart a failed or starting product', async () => {
  for (const failed of [false, true]) {
    const current = fixture(false)
    current.api.aliveMainWindow = () => null as unknown as typeof current.api.parent
    if (failed) current.surface.fail()
    current.actions.length = 0
    current.api.entries.activate()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(current.actions, ['failure-reveal'])
  }
})

test('a new quit during native failure-surface closure suppresses its replacement', async () => {
  const current = fixture(false)
  const handoff = current.api.reveal(current.api.parent)
  current.api.report('failure', 'detail')
  await new Promise<void>((resolve) => setImmediate(resolve))
  current.api.appQuitting = true
  current.resolveClose()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(current.actions, [])
  assert.equal(current.api.startupFailureReports, 0)
  assert.equal(await handoff, false)
})

test('Dock recovery without a main window rechecks ownership after backend readiness', async () => {
  for (const changed of ['none', 'quit', 'failed'] as const) {
    const current = fixture(false)
    current.api.startupScreen = null
    current.api.aliveMainWindow = () => null as unknown as typeof current.api.parent
    let finish: (ready: boolean) => void
    current.api.ensureBackendForWindow = () =>
      new Promise<boolean>((resolve) => {
        finish = resolve
      })
    current.api.entries.activate()
    if (changed === 'quit') current.api.appQuitting = true
    if (changed === 'failed') {
      current.surface.fail()
      current.api.startupScreen = current.surface
    }
    finish!(true)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(current.actions.includes('create-window'), changed === 'none')
  }
})

test('failed quit preparation while a real workbench handoff awaits closure cannot reveal the hidden workbench', async () => {
  const current = fixture(false)
  const handoff = current.api.reveal(current.api.parent)
  current.api.preferenceQuiescence.prepare = async () => {
    throw new Error('flush failed')
  }
  current.api.beforeQuit({ preventDefault: () => undefined })
  await new Promise<void>((resolve) => setImmediate(resolve))
  current.resolveClose()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(await handoff, false)
  assert.deepEqual(current.actions, ['open', 'failure'])
})

test('headless failure drains the owned runtime before a nonzero exit and shows no surface', async () => {
  const current = fixture(false, true)
  current.api.report('failure', 'detail')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(current.actions, ['drain', 'exit:1'])
})

test('a failure during application shutdown does not resurrect a window', async () => {
  const current = fixture(false)
  current.api.appQuitting = true
  current.api.report('failure', 'detail')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(current.actions, [])
})

test('runtime preparation failure remains terminal and late main readiness cannot replace its failure surface', async () => {
  const current = fixture(false)
  current.surface.fail()
  assert.equal(await current.api.prepare(), false)
  assert.equal(current.api.startupState.snapshot().phase, STARTUP_PHASE.failed)
  assert.equal(await current.api.reveal(current.api.parent), false)
  assert.deepEqual(current.actions, ['failure'])
  assert.equal(current.api.startupScreen, current.surface)
})

test('successful workbench handoff waits for native startup closure before clearing its reference', async () => {
  const current = fixture(false)
  const completion = current.api.reveal(current.api.parent)
  assert.deepEqual(current.actions, [])
  assert.equal(current.api.startupScreen, current.surface)
  current.resolveClose()
  assert.equal(await completion, true)
  assert.deepEqual(current.actions, ['workbench'])
  assert.equal(current.api.startupScreen, null)
})

test('quit request blocks late workbench and failure visibility while preference quiescence is pending', async () => {
  const current = fixture(false)
  let resumeQuit: () => void
  current.api.preferenceQuiescence.prepare = () =>
    new Promise<void>((resolve) => {
      resumeQuit = resolve
    })
  current.api.beforeQuit({
    preventDefault: () => {
      current.actions.push('quit-held')
    },
  })
  assert.equal(current.api.appQuitting, true)
  assert.equal(await current.api.reveal(current.api.parent), false)
  current.api.report('failure', 'late')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(current.actions, ['quit-held'])
  resumeQuit!()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(current.actions, ['quit-held', 'drain', 'quit'])
})

test('failed shutdown preparation restores display admission and reports its recovery error', async () => {
  const current = fixture(false)
  current.api.preferenceQuiescence.prepare = async () => {
    throw new Error('preference flush failed')
  }
  current.api.beforeQuit({
    preventDefault: () => {
      current.actions.push('quit-held')
    },
  })
  assert.equal(current.api.appQuitting, true)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(current.api.appQuitting, false)
  assert.equal(current.api.backendQuitPending, false)
  assert.deepEqual(current.actions, ['quit-held', 'open', 'failure'])
})

for (const maintenance of [
  'windowsUpdateMaintenanceActive',
  'macUpdateMaintenanceActive',
] as const) {
  test(`failed shutdown during ${maintenance} retains maintenance and reports activation recovery`, async () => {
    const current = fixture(false)
    assert.equal(current.api[maintenance], false)
    current.api[maintenance] = true
    current.api.preferenceQuiescence.prepare = async () => {
      throw new Error('maintenance flush failed')
    }
    current.api.preferenceQuiescence.resume = () => {
      assert.fail('an unconfirmed update must not resume storage writes')
    }
    current.api.beforeQuit({ preventDefault: () => undefined })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(current.api.appQuitting, false)
    assert.equal(current.api.backendQuitPending, false)
    assert.equal(current.api[maintenance], true)
    assert.deepEqual(
      current.updateSnapshots.map((snapshot) => ({ ...snapshot })),
      [
        {
          phase: 'failed',
          installation: undefined,
          installStage: undefined,
          errorFallback: 'activation_recovery_required',
          errorOrigin: 'install',
        },
      ]
    )
    assert.ok(current.actions.includes('allow-interaction'))
    assert.ok(!current.actions.includes('quit'))
  })
}

for (const preparingUpdate of [false, true]) {
  test(`settled shutdown resumes native quit on a later event turn, update preparation=${preparingUpdate}`, async () => {
    const current = fixture(true)
    const continuations: Array<() => void> = []
    let nativeEventActive = true
    let preferenceCalls = 0
    let preparationStops = 0
    current.api.setImmediate = (callback) => {
      continuations.push(callback)
    }
    current.api.preferenceQuiescence.prepare = async () => {
      preferenceCalls++
    }
    current.api.updatePreparation.running = preparingUpdate
    current.api.updatePreparation.stop = async () => {
      preparationStops++
    }
    current.api.app.quit = () => {
      current.actions.push(nativeEventActive ? 'native-reentry' : 'native-quit')
      current.api.beforeQuit({
        preventDefault: () => {
          current.actions.push('unexpected-veto')
        },
      })
    }
    const request = () =>
      current.api.beforeQuit({
        preventDefault: () => {
          current.actions.push('quit-held')
        },
      })
    request()
    request()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(current.actions, ['quit-held', 'quit-held', 'drain'])
    assert.equal(continuations.length, 1)
    assert.equal(current.api.backendQuitFinished, true)
    assert.equal(preferenceCalls, 1)
    assert.equal(preparationStops, Number(preparingUpdate))
    nativeEventActive = false
    continuations.shift()!()
    assert.deepEqual(current.actions, ['quit-held', 'quit-held', 'drain', 'native-quit'])
    assert.equal(preferenceCalls, 1)
    assert.equal(continuations.length, 0)
  })
}

test('failed backend drain restores presentation without scheduling a native quit', async () => {
  const current = fixture(false)
  const continuations: Array<() => void> = []
  current.api.setImmediate = (callback) => {
    continuations.push(callback)
  }
  current.api.finishApplicationShutdown = async () => {
    current.actions.push('drain')
    throw new Error('backend drain failed')
  }
  current.api.beforeQuit({
    preventDefault: () => {
      current.actions.push('quit-held')
    },
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(current.api.backendQuitFinished, false)
  assert.equal(current.api.backendQuitPending, false)
  assert.equal(current.api.appQuitting, false)
  assert.equal(continuations.length, 0)
  assert.deepEqual(current.actions, ['quit-held', 'drain', 'open', 'failure'])
})

for (const phase of ['quitting', 'headless', 'quiescing', 'closing', 'failed', 'starting']) {
  test(`all registered foreground entries respect ${phase} presentation ownership`, async () => {
    const current = fixture(false, phase === 'headless', true)
    current.api.appQuitting = phase === 'quitting'
    current.api.preferenceQuiescence.isPreparing = () => phase === 'quiescing'
    current.surface.isClosing = () => phase === 'closing'
    if (phase === 'failed') current.surface.fail()
    current.actions.length = 0
    for (const [name, entry] of Object.entries(current.api.entries)) {
      if (name === 'second-instance') entry(null, [])
      else entry('foreground')
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.ok(Object.keys(current.api.entries).length >= 5)
    assert.equal(
      current.actions.some((action) =>
        [
          'workbench',
          'restore',
          'focus',
          'notification-click',
          'hide-cancel',
          'app-focus',
        ].includes(action)
      ),
      false
    )
    if (phase === 'failed') assert.ok(current.actions.includes('failure-reveal'))
  })
}
