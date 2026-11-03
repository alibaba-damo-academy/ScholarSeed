import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
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

function fixture(responses: number[], failDialog = false, failRelaunch = false) {
  const actions: string[] = []
  const dialogs: Record<string, unknown>[] = []
  const logs: string[] = []
  const copies: string[] = []
  const errors: string[] = []
  let ready!: () => void
  const readiness = new Promise<void>((resolve) => {
    ready = resolve
  })
  const dependencies = {
    electron: {
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
    './localization': { startupAdmissionText: () => text },
  }
  const exports: Record<string, unknown> = {}
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports,
      process: { platform: 'darwin', arch: 'arm64' },
      require: (name: keyof typeof dependencies) => {
        assert.ok(Object.hasOwn(dependencies, name), `unadmitted dependency: ${name}`)
        return dependencies[name]
      },
    }
  )
  const recover = exports.recoverStartupAdmission as (
    error: unknown,
    headless: boolean,
    log: (line: string) => void
  ) => Promise<void>
  const run = (headless = false) =>
    recover(new Error('directory was replaced'), headless, (line) => logs.push(line))
  return { run, ready, actions, dialogs, logs, copies, errors }
}

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
