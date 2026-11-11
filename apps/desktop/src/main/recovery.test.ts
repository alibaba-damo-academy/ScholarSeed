import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./admission.ts', import.meta.url), 'utf8')
const text = {
  title: 'recovery',
  message: 'cannot start',
  detail: 'records retained',
  retry: 'retry',
  copy: 'copy',
  quit: 'quit',
}

function fixture(
  responses: number[],
  failDialog = false,
  failRelaunch = false,
  platform = 'darwin'
) {
  const actions: string[] = []
  const dialogs: Record<string, unknown>[] = []
  const logs: string[] = []
  const copies: string[] = []
  const errors: string[] = []
  const systemLogs: string[][] = []
  const notifications: Record<string, unknown>[] = []
  const notificationInstances: { listeners: Map<string, () => void> }[] = []
  const timerCancellations: unknown[] = []
  let notificationFailure = false
  let loggerFailure = false
  let loggerPending = false
  let ready!: () => void
  const readiness = new Promise<void>((resolve) => {
    ready = resolve
  })
  const dependencies = {
    electron: {
      Notification: class {
        static isSupported() {
          return true
        }
        listeners = new Map<string, () => void>()
        constructor(options: Record<string, unknown>) {
          notifications.push(options)
          notificationInstances.push(this)
        }
        once(event: string, listener: () => void) {
          this.listeners.set(event, listener)
        }
        show() {
          if (notificationFailure) throw new Error('notification unavailable')
          this.listeners.get('show')?.()
        }
      },
      app: {
        whenReady: () => readiness,
        getVersion: () => '0.3.0',
        relaunch: (...args: unknown[]) => {
          assert.deepEqual(args, [], 'preserve Electron launch arguments without overrides')
          actions.push('relaunch')
          if (failRelaunch) throw new Error('relaunch failed')
        },
        quit: () => actions.push('quit'),
        exit: (code: number) => actions.push(`exit:${code}`),
      },
      clipboard: {
        writeText: (value: string) => {
          copies.push(value)
        },
      },
      dialog: {
        showMessageBox: async (options: Record<string, unknown>) => {
          dialogs.push(options)
          if (failDialog) throw new Error('native dialog failed')
          assert.ok(responses.length, 'unexpected extra recovery prompt')
          return { response: responses.shift() }
        },
        showErrorBox: (title: string, detail: string) => errors.push(`${title}: ${detail}`),
      },
    },
    './localization': {
      startupAdmissionText: () => ({
        ...text,
        installing: 'installing',
        restoring: 'restoring',
        unconfirmed: 'unconfirmed',
      }),
    },
    './redaction': { redactDiagnosticError: () => ({ message: 'redacted failure' }) },
    'node:child_process': {
      execFile: async (executable: string, args: string[]) => {
        assert.equal(executable, '/usr/bin/logger')
        systemLogs.push(Array.from(args))
        if (loggerFailure) throw new Error('logger unavailable')
        if (loggerPending) await new Promise<void>(() => undefined)
      },
    },
    'node:util': { promisify: (value: unknown) => value },
  }
  const exports: Record<string, unknown> = {}
  const context = createContext({
    exports,
    process: {
      platform,
      arch: 'arm64',
      pid: 123,
      stderr: { write: (value: string) => logs.push(value) },
    },
    setTimeout,
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
      timerCancellations.push(timer)
      clearTimeout(timer)
    },
    require: (name: keyof typeof dependencies) => {
      assert.ok(Object.hasOwn(dependencies, name), `unadmitted dependency: ${name}`)
      return dependencies[name]
    },
  })
  runInContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context
  )
  const recover = exports.recoverStartupAdmission as (
    error: unknown,
    headless: boolean,
    log: (line: string) => void,
    updatePending?: boolean
  ) => Promise<void>
  const run = (headless = false, updatePending = false) =>
    recover(new Error('directory was replaced'), headless, (line) => logs.push(line), updatePending)
  const refuse = (status: string, headless = false) => {
    const Failure = exports.MacStartupAdmissionError as new (
      status: string,
      cause?: unknown
    ) => Error
    return recover(new Failure(status, new Error('unsafe update evidence')), headless, (line) =>
      logs.push(line)
    )
  }
  return {
    repairDiagnostic: exports.reportMacRepair as (
      stage: string,
      hasSelection: boolean,
      result?: object,
      failure?: unknown
    ) => Promise<void>,
    run,
    refuse,
    ready,
    actions,
    dialogs,
    logs,
    copies,
    errors,
    systemLogs,
    notifications,
    notificationInstances,
    timerCancellations,
    retainedNotifications: () => runInContext('activeNotifications.size', context) as number,
    failReports: () => {
      notificationFailure = true
      loggerFailure = true
    },
    hangLogger: () => {
      loggerPending = true
    },
  }
}

test('repair entry diagnostics use only the OS logger and allowlisted fields before admission', async () => {
  const current = fixture([])
  await current.repairDiagnostic('begin', true)
  await current.repairDiagnostic('completed', true, {
    requestId: 'a'.repeat(64),
    targetBuild: '202611101000',
    home: '/private/home',
  })
  await current.repairDiagnostic('failed', false, undefined, new Error('/private/home/secret'))
  const records = current.systemLogs.map((args) => JSON.parse(args.at(-1)!))
  assert.deepEqual(
    records.map((record) => record.stage),
    ['begin', 'completed', 'failed']
  )
  assert.equal(records[0].hasSelection, true)
  assert.equal(records[1].requestId, 'a'.repeat(64))
  assert.equal(records[1].targetBuild, '202611101000')
  assert.equal(records[2].error.message, 'redacted failure')
  assert.equal(JSON.stringify(records).includes('/private/home'), false)
  assert.deepEqual(current.actions, [])
  assert.equal(current.dialogs.length, 0)
})

test('admission recovery waits for app readiness and quit is the Escape/close action', async () => {
  const f = fixture([2])
  const pending = f.run()
  assert.equal(f.dialogs.length, 0)
  f.ready()
  await pending
  assert.deepEqual(f.actions, ['quit'])
  assert.equal(f.dialogs[0].cancelId, 2)
  assert.deepEqual(Array.from(f.dialogs[0].buttons as string[]), ['retry', 'copy', 'quit'])
  assert.match(String(f.dialogs[0].detail), /records retained/)
  assert.match(String(f.dialogs[0].detail), /directory was replaced/)
})

test('copy keeps recovery open; retry relaunches with unchanged arguments and then quits', async () => {
  const f = fixture([1, 0])
  f.ready()
  await f.run()
  assert.equal(f.dialogs.length, 2)
  assert.equal(f.copies.length, 1)
  assert.match(f.copies[0], /ScholarSeed 0.3.0 \(darwin\/arm64\)/)
  assert.match(f.copies[0], /directory was replaced/)
  assert.deepEqual(f.actions, ['relaunch', 'quit'])
  assert.equal(f.errors.length, 0)
})

test('native dialog or relaunch failure still shows an OS error before quitting', async () => {
  for (const [dialog, relaunch] of [
    [true, false],
    [false, true],
  ]) {
    const f = fixture([0], dialog, relaunch)
    f.ready()
    await f.run()
    assert.equal(f.errors.length, 1)
    assert.match(f.errors[0], /directory was replaced/)
    assert.equal(f.actions.at(-1), 'quit')
    assert.equal(
      f.actions.some((action) => action.startsWith('exit:')),
      false
    )
  }
})

test('headless callers get a diagnostic and nonzero exit without creating a UI', async () => {
  const f = fixture([])
  await f.run(true)
  assert.deepEqual(f.actions, ['exit:1'])
  assert.equal(f.dialogs.length, 0)
  assert.match(f.logs[0], /admission refused/)
})

for (const status of ['installing', 'restoring', 'failed', 'unconfirmed']) {
  test(`unresolved update ${status} reports outside product storage and exits without a blocking dialog`, async () => {
    const current = fixture([])
    current.ready()
    await current.refuse(status)
    assert.deepEqual(current.actions, ['exit:1'])
    assert.equal(current.dialogs.length, 0)
    assert.equal(current.errors.length, 0)
    assert.equal(current.notifications.length, 1)
    assert.equal(current.notifications[0].body, status === 'failed' ? 'unconfirmed' : status)
    assert.equal(current.systemLogs.length, 1)
    assert.equal(
      current.systemLogs[0][1],
      ['installing', 'restoring'].includes(status) ? 'user.notice' : 'user.err'
    )
    const record = JSON.parse(current.systemLogs[0].at(-1)!)
    assert.equal(record.status, status)
    assert.equal(record.component, 'ScholarSeedStartup')
    assert.equal(record.pid, 123)
    assert.equal(record.version, '0.3.0')
    assert.equal(record.error.message, 'redacted failure')
  })
}

test('shown notifications stay retained for the existing reporting budget, not an extra grace delay', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const current = fixture([])
  current.ready()
  const pending = current.refuse('installing')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(current.actions, [])
  assert.equal(current.retainedNotifications(), 1)
  context.mock.timers.tick(1999)
  assert.deepEqual(current.actions, [])
  assert.equal(current.retainedNotifications(), 1)
  context.mock.timers.tick(1)
  await pending
  assert.deepEqual(current.actions, ['exit:1'])
  assert.equal(current.retainedNotifications(), 0)
  const cancellations = current.timerCancellations.length
  current.notificationInstances[0].listeners.get('failed')!()
  assert.equal(current.timerCancellations.length, cancellations)
})

test('late app readiness uses only the remaining reporting budget', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const current = fixture([])
  const pending = current.refuse('installing')
  context.mock.timers.tick(1900)
  current.ready()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(current.retainedNotifications(), 1)
  context.mock.timers.tick(99)
  assert.deepEqual(current.actions, [])
  context.mock.timers.tick(1)
  await pending
  assert.deepEqual(current.actions, ['exit:1'])
  assert.equal(current.retainedNotifications(), 0)
})

test('notification failure completes and releases ownership exactly once despite a late event', async () => {
  const current = fixture([])
  current.ready()
  const pending = current.refuse('restoring')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(current.retainedNotifications(), 1)
  const fail = current.notificationInstances[0].listeners.get('failed')!
  fail()
  await pending
  assert.equal(current.retainedNotifications(), 0)
  const cancellations = current.timerCancellations.length
  fail()
  assert.equal(current.timerCancellations.length, cancellations)
  assert.deepEqual(current.actions, ['exit:1'])
})

test('failed diagnostics cannot retain a refused update process or open a fallback dialog', async () => {
  const current = fixture([])
  current.failReports()
  current.ready()
  await current.refuse('unconfirmed')
  assert.deepEqual(current.actions, ['exit:1'])
  assert.equal(current.dialogs.length, 0)
  assert.equal(current.errors.length, 0)
  assert.equal(current.retainedNotifications(), 0)
})

test('headless update refusals persist diagnostics without waiting for app readiness', async () => {
  const current = fixture([])
  await current.refuse('unconfirmed', true)
  assert.deepEqual(current.actions, ['exit:1'])
  assert.equal(current.notifications.length, 0)
  assert.equal(current.systemLogs.length, 1)
})

test('notification readiness cannot hold the target application indefinitely', async () => {
  const current = fixture([])
  await current.refuse('installing')
  assert.deepEqual(current.actions, ['exit:1'])
  current.ready()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(current.notifications.length, 0)
})

test('a profile restoration failure in a pending transaction cannot retain the target app', async () => {
  const current = fixture([])
  current.ready()
  await current.run(false, true)
  assert.deepEqual(current.actions, ['exit:1'])
  assert.equal(current.dialogs.length, 0)
  assert.equal(JSON.parse(current.systemLogs[0].at(-1)!).status, 'unconfirmed')
})

test('Windows startup recovery never invokes the macOS logger or notification exit path', async () => {
  const current = fixture([2], false, false, 'win32')
  current.ready()
  await current.refuse('unconfirmed')
  assert.deepEqual(current.actions, ['quit'])
  assert.equal(current.dialogs.length, 1)
  assert.equal(current.systemLogs.length, 0)
  assert.equal(current.notifications.length, 0)
})

test('an unresponsive system logger cannot indefinitely retain a refused update process', async () => {
  const current = fixture([])
  current.hangLogger()
  await current.refuse('unconfirmed', true)
  assert.deepEqual(current.actions, ['exit:1'])
  assert.equal(current.dialogs.length, 0)
})
