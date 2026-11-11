import assert from 'node:assert/strict'
import { constants, tmpdir } from 'node:os'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import * as repair from './repair.ts'

function fixture(context: test.TestContext, options: { refuse?: boolean; busy?: boolean } = {}) {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'repair-entry-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const paths = ['Old.app', 'Helper.app', 'home', 'profile', 'workspace'].map((name) => {
    const path = join(root, name)
    mkdirSync(path)
    return path
  })
  const [application, helper, home, userData, workspace] = paths
  const events: string[] = []
  const selected = [helper]
  const answers = [0]
  const messages: unknown[] = []
  const exports: Record<string, Function> = {}
  const dependencies = {
    electron: {
      app: { whenReady: async () => {} },
      dialog: {
        showOpenDialog: async () => ({
          canceled: !selected.length,
          filePaths: selected.length ? [selected.shift()] : [],
        }),
        showMessageBox: async (message: unknown) => {
          messages.push(message)
          events.push('confirm')
          return { response: answers.shift() ?? 1 }
        },
      },
    },
    'node:fs': { realpathSync },
    'node:os': { constants },
    './localization.ts': { mainLocalization: () => ({ getFixedT: () => (key: string) => key }) },
    './repair.ts': {
      ...repair,
      verifyRepairApplication: async () => {
        events.push('signature')
        if (options.refuse) throw new Error('signature refused')
      },
      planInstalledUpdate: async () => {
        events.push('plan')
      },
      repairExecutable: async () => join(helper, 'Contents', 'MacOS', 'ScholarSeed'),
      repairInstalledUpdate: async () => {
        events.push('repair')
        if (options.busy)
          throw Object.assign(new Error('busy'), {
            code: 'ERR_TERMINAL_PARK',
            systemCode: constants.errno.EBUSY,
          })
        return { startup: {} }
      },
    },
  }
  runInNewContext(
    ts.transpileModule(readFileSync(new URL('./rescue.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports,
      require: (name: keyof typeof dependencies) => {
        assert.ok(name in dependencies, name)
        return dependencies[name]
      },
    }
  )
  return {
    exports,
    events,
    paths,
    selected,
    answers,
    messages,
    scope: {
      application,
      repairApplication: application,
      coordinator: root,
      applicationSupport: root,
      cache: root,
      bundleId: 'com.scholarseed.desktop',
      expectedTeam: 'KYG3VP6NVH',
      selection: { home, userData, workspace },
    },
  }
}

test('live repair entry verifies capability and plans before asking to interrupt work', async (context) => {
  const current = fixture(context)
  const launch = await current.exports.prepareRepair(current.scope, {})
  assert.deepEqual(current.events, ['signature', 'plan', 'confirm'])
  assert.equal(launch.execPath, join(current.paths[1], 'Contents', 'MacOS', 'ScholarSeed'))
  assert.deepEqual(Array.from(launch.args), [
    `--repair-update-target=${current.paths[0]}`,
    `--repair-update-home=${current.paths[2]}`,
    `--repair-update-user-data=${current.paths[3]}`,
    `--repair-update-workspace=${current.paths[4]}`,
  ])
  assert.equal(current.events.includes('repair'), false)
})

test('untrusted helper never plans, requests shutdown or mutates an update', async (context) => {
  const current = fixture(context, { refuse: true })
  await assert.rejects(current.exports.prepareRepair(current.scope, {}), /signature refused/)
  assert.deepEqual(current.events, ['signature'])
})

test('cancel leaves the running application and transaction untouched', async (context) => {
  const current = fixture(context)
  current.answers[0] = 1
  assert.equal(await current.exports.prepareRepair(current.scope, {}), null)
  assert.deepEqual(current.events, ['signature', 'plan', 'confirm'])
})

test('wizard bounds explicit busy retries and never relaunches on refusal', async (context) => {
  const current = fixture(context, { busy: true })
  current.selected.splice(0, 1, current.paths[0], ...current.paths.slice(2))
  current.answers.splice(0, 1, 0, 0, 0)
  const scope = { ...current.scope, repairApplication: current.paths[1] }
  const logs: string[] = []
  assert.equal(
    await current.exports.runRepairWizard(
      scope,
      {},
      () => assert.fail('not repaired'),
      (message: string) => logs.push(message)
    ),
    false
  )
  assert.equal(current.events.filter((event) => event === 'repair').length, 3)
  assert.equal(logs.length, 3)
})

test('only proven native occupancy permits another repair attempt', (context) => {
  const current = fixture(context)
  assert.equal(
    current.exports.repairBusy({ code: 'ERR_TERMINAL_PARK', systemCode: constants.errno.EBUSY }),
    true
  )
  for (const code of ['ERR_TERMINAL_RELEASE', 'ERR_TERMINAL_ARGUMENT', 'ERR_TERMINAL_STATE'])
    assert.equal(current.exports.repairBusy({ code, systemCode: constants.errno.EBUSY }), false)
  assert.equal(
    current.exports.repairBusy({ code: 'ERR_TERMINAL_PARK', systemCode: constants.errno.ESTALE }),
    false
  )
  const refused = {
    code: 'qualification_refused',
    nativeCode: 'ERR_TERMINAL_PARK',
    systemCode: constants.errno.EBUSY,
    mutationPerformed: false,
    committed: false,
  }
  assert.equal(current.exports.repairBusy(refused), true)
  assert.equal(current.exports.repairBusy({ ...refused, mutationPerformed: true }), false)
  assert.equal(current.exports.repairBusy({ ...refused, committed: true }), false)
})
