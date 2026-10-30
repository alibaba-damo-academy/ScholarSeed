import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { PreferenceQuiescence, type PreferenceShutdownRequest } from '../../quiescence.ts'
import { preserveFrozenPreferences } from './quiescence.ts'

test('frozen preferences cannot change while unrelated session state continues updating', () => {
  const before = {
    lang: 'zh',
    theme: 'dark',
    reasoningPreferences: {},
    recentFiles: [],
    projectLayouts: { first: { open: false } },
    workbenchLayout: { open: false },
    activeSession: 'first',
  }
  const after = {
    lang: 'en',
    theme: 'light',
    reasoningPreferences: { model: 'high' },
    recentFiles: [],
    projectLayouts: { first: { open: true } },
    workbenchLayout: { open: true },
    activeSession: 'second',
  }
  assert.deepEqual(preserveFrozenPreferences(before, after), { ...before, activeSession: 'second' })
})

// Execute the actual Store subscription: IPC clones request objects, and an exit
// may upgrade a maintenance request while its original save is still pending.
const store = ts.createSourceFile(
  'store.tsx',
  readFileSync(new URL('./store.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)
const effects: string[] = []
function visit(node: ts.Node): void {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(store) === 'useEffect' &&
    node.getText(store).includes('bridge.onPreferenceShutdownRequest')
  )
    effects.push(node.getText(store))
  ts.forEachChild(node, visit)
}
visit(store)
assert.equal(effects.length, 1)
const subscription = ts.transpileModule(effects[0], {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

for (const upgradePending of [false, true]) {
  test(`maintenance leaves cancel/recovery interactive and retains the save fence (upgrade pending: ${upgradePending})`, async () => {
    const body = { inert: false }
    let listener!: (request: PreferenceShutdownRequest) => void
    let cleanup!: () => void
    let frozen = false
    let runtimeQuiescing = false
    let prepares = 0
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const owner = new PreferenceQuiescence((request) => listener(structuredClone(request)))
    runInNewContext(subscription, {
      document: { body },
      console,
      useEffect: (effect: () => () => void) => {
        cleanup = effect()
      },
      flushSync: (callback: () => void) => callback(),
      set: (patch: { runtimeQuiescing: boolean }) => {
        runtimeQuiescing = patch.runtimeQuiescing
      },
      preferenceWriter: {
        current: {
          resume: () => {
            frozen = false
          },
          prepareShutdown: async () => {
            frozen = true
            prepares += 1
            await pending
            return { writerId: 'renderer', acknowledgedRevision: 0 }
          },
        },
      },
      window: {
        scholarseed: {
          onPreferenceShutdownRequest: (callback: typeof listener) => {
            listener = callback
            return () => {}
          },
          getPreferenceShutdownRequest: async () => owner.register(),
          respondPreferenceShutdown: async (reply: unknown) => owner.accept(reply),
        },
      },
    })
    const saved = owner.prepare(undefined, 'maintenance')
    assert.equal(frozen, true)
    assert.equal(runtimeQuiescing, true, 'background reads stop before shutdown acknowledgement')
    assert.equal(body.inert, false, 'cancel and failure recovery must remain reachable')
    listener(structuredClone(owner.register()))
    if (upgradePending) assert.equal(owner.prepare(), saved)
    release()
    await saved
    assert.equal(prepares, 1, 'mode upgrade and cloned IPC delivery must not flush again')
    await assert.rejects(
      owner.save(undefined, async () => {}),
      /ERR_PREFERENCES_FROZEN/
    )
    assert.equal(body.inert, upgradePending)
    if (!upgradePending) {
      // Failed backend recovery deliberately retains the fence, not a page-wide lock.
      assert.equal(frozen, true)
      assert.equal(body.inert, false)
      await owner.prepare()
      assert.equal(body.inert, true)
      assert.equal(prepares, 1)
    }
    owner.allowInteraction()
    assert.equal(runtimeQuiescing, true, 'failed runtime recovery cannot resume background reads')
    assert.equal(body.inert, false)
    assert.equal(frozen, true, 'failed shutdown must not reopen writes into a stopped backend')
    await assert.rejects(
      owner.save(undefined, async () => {}),
      /ERR_PREFERENCES_FROZEN/
    )
    assert.equal(prepares, 1)
    owner.resume()
    assert.equal(runtimeQuiescing, false)
    assert.equal(frozen, false)
    assert.equal(body.inert, false)
    cleanup()
  })
}
