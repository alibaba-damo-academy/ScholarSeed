import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, chmod, copyFile, symlink, writeFile, rm, rename } from 'node:fs/promises'
import { constants as osConstants, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import {
  classifySquirrelStartup,
  inspectSquirrelStartup,
  settleSquirrelStartup,
  SQUIRREL_INSTALLATION_WINDOW_MS,
  squirrelAdmission,
  readSquirrelFailure,
  bindSquirrelRequest,
  inspectSquirrelIdle,
  inspectCancelledSquirrelPreparation,
  inspectRestoredSquirrelInstallation,
  verifySquirrelReplacement,
  squirrelHelpersAbsent,
  squirrelLaunchSuperseded,
  legacySquirrelPublisherAbsent,
  squirrelPreparedDevice,
} from './squirrelstartup.ts'
import type { SquirrelHandoff } from './squirrel.ts'

const now = 1_800_000_000_000

test('legacy publisher inventory rejects another copy and incomplete process evidence', () => {
  const app = '/Applications/Example.app/Contents/MacOS/Example'
  const current = `12 ${app}\n13 /usr/bin/true\n`
  assert.equal(legacySquirrelPublisherAbsent(current, 12, app), true)
  assert.equal(legacySquirrelPublisherAbsent(current + '14 /other copy/Example\n', 12, app), false)
  assert.equal(legacySquirrelPublisherAbsent(current + '14 Example\n', 12, app), false)
  assert.equal(legacySquirrelPublisherAbsent(current + '14 /unknown/ShipIt\n', 12, app), false)
  assert.equal(legacySquirrelPublisherAbsent(current + 'malformed\n', 12, app), false)
  assert.equal(legacySquirrelPublisherAbsent('13 /usr/bin/true\n', 12, app), false)
})
test('superseded build evidence requires a strictly later valid build than both endpoints', () => {
  const expected = { sourceBuild: '202610271711', targetBuild: '202610271723' }
  assert.equal(squirrelLaunchSuperseded('202610280721', expected), true)
  for (const build of ['', 'unknown', '202610271711', '202610271723', '202610260000']) {
    assert.equal(squirrelLaunchSuperseded(build, expected), false)
  }
  assert.equal(
    squirrelLaunchSuperseded('202610280721', { targetBuild: expected.targetBuild }),
    false
  )
  assert.equal(
    squirrelLaunchSuperseded('202610280721', { ...expected, sourceBuild: '202610290000' }),
    false
  )
})

test('superseded recovery scopes helpers to the installed and bound candidate applications', async () => {
  const helpers = [
    '/Applications/Scholar Seed.app/Contents/ShipIt',
    '/cache/candidate/Contents/ShipIt',
  ]
  const canonical = async (path: string) => path
  for (const owner of [0, 501]) {
    assert.equal(
      await squirrelHelpersAbsent(
        `${owner} /Applications/VS Code.app/Contents/ShipIt`,
        501,
        helpers,
        canonical
      ),
      true
    )
    for (const helper of helpers)
      assert.equal(
        await squirrelHelpersAbsent(`${owner} ${helper}`, 501, helpers, canonical),
        false
      )
  }
  assert.equal(
    await squirrelHelpersAbsent('501 /alias/ShipIt', 501, helpers, async () => helpers[0]),
    false
  )
  assert.equal(await squirrelHelpersAbsent('501 ShipIt', 501, helpers, canonical), false)
  assert.equal(
    await squirrelHelpersAbsent('501 /unknown/ShipIt', 501, helpers, async () => {
      throw new Error('unavailable')
    }),
    false
  )
})

test('superseded recovery refuses active user or root helpers and incomplete process evidence', async () => {
  const helpers = ['/Applications/App.app/ShipIt', '/cache/ShipIt']
  assert.equal(
    await squirrelHelpersAbsent(
      ' 501 /Applications/ScholarSeed.app/Contents/MacOS/ScholarSeed\n',
      501,
      helpers
    ),
    true
  )
  for (const processes of [
    '',
    'truncated',
    '0 /Applications/App.app/ShipIt',
    '501 /cache/ShipIt',
  ]) {
    assert.equal(await squirrelHelpersAbsent(processes, 501, helpers), false)
  }
  assert.equal(
    await squirrelHelpersAbsent('502 /Applications/Other.app/ShipIt\r\n', 501, helpers),
    true
  )
  for (const uid of [0, 501, 502]) {
    assert.equal(
      await squirrelHelpersAbsent(`${uid} /cache/unknown/ShipIt\n`, 501, helpers, undefined, true),
      uid === 502
    )
  }
})

test(
  'superseded native inspection refuses pending requests and unsafe cache entries',
  { skip: process.platform !== 'darwin' },
  async () => {
    const cache = realpathSync(await mkdtemp(join(tmpdir(), 'squirrel-idle-')))
    const bundle = 'fixture.scholarseed'
    const directory = join(cache, `${bundle}.ShipIt`)
    try {
      await mkdir(directory, { mode: 0o700 })
      await writeFile(join(directory, 'ShipItState.plist'), 'pending')
      assert.equal(await inspectSquirrelIdle(cache, bundle, application, null), false)
      await rm(join(directory, 'ShipItState.plist'))
      await chmod(directory, 0o777)
      assert.equal(await inspectSquirrelIdle(cache, bundle, application, null), false)
      await chmod(directory, 0o700)
      await rm(directory, { recursive: true })
      await symlink(cache, directory)
      assert.equal(await inspectSquirrelIdle(cache, bundle, application, null), false)
      assert.equal(await inspectSquirrelIdle(cache, '../invalid', application, null), false)
    } finally {
      await rm(cache, { recursive: true, force: true })
    }
  }
)
const application = join(tmpdir(), 'Scholar Seed.app')
const protocolBinding = {
  schema: 1 as const,
  requestId: 'a'.repeat(64),
  candidate: 'candidate',
  sha512: 'b'.repeat(128),
  size: 100,
}
const handoff: SquirrelHandoff = {
  version: '0.2.0',
  buildNumber: '202610131554',
  candidate: 'candidate',
  at: now - 1000,
  state: 'installing',
  binding: protocolBinding,
}
const evidence = {
  application,
  executable: join(
    application,
    'Contents',
    'Frameworks',
    'Squirrel.framework',
    'Resources',
    'ShipIt'
  ),
  uid: 501,
  target: pathToFileURL(application).href + '/',
  processes: `  501 ${join(application, 'Contents', 'Frameworks', 'Squirrel.framework', 'Resources', 'ShipIt')}\n`,
}

function terminalRecord(source: string, target: string) {
  const identity = (path: string) => {
    const stat = lstatSync(path)
    return { dev: stat.dev, ino: stat.ino, uid: stat.uid }
  }
  const capture = (path: string) => ({
    path,
    item: identity(path),
    parent: identity(dirname(path)),
  })
  return {
    schema: 1,
    ready: false,
    code: 9,
    binding: protocolBinding,
    source: capture(realpathSync(source)),
    target: capture(realpathSync(target)),
  }
}
test('active matching installation is pending without granting backend admission', () => {
  assert.equal(classifySquirrelStartup(handoff, evidence, now), 'installing')
  assert.equal(
    classifySquirrelStartup({ ...handoff, state: 'downloaded' }, evidence, now),
    'installing'
  )
})
test('encoded native paths and CRLF process evidence retain exact installation identity', () => {
  assert.match(evidence.target, /Scholar%20Seed\.app/)
  assert.equal(
    classifySquirrelStartup(
      handoff,
      {
        ...evidence,
        target: evidence.target + '\r\n',
        processes: `\r\n  ${evidence.uid} ${evidence.executable}\r\n`,
      },
      now
    ),
    'installing'
  )
  assert.equal(
    classifySquirrelStartup(
      handoff,
      {
        ...evidence,
        target: pathToFileURL(join(dirname(application), 'Other.app')).href,
      },
      now
    ),
    'unconfirmed'
  )
})
test('failed and uncommitted handoffs cannot look like an active installation', () => {
  for (const state of ['failed', 'requested'] as const)
    assert.equal(
      classifySquirrelStartup({ ...handoff, state }, evidence, now),
      state === 'failed' ? 'failed' : 'unconfirmed'
    )
})
test('missing or mismatched native evidence remains unconfirmed', () => {
  for (const changed of [
    { processes: '' },
    { uid: 502 },
    { target: 'file:///Applications/Other.app/' },
    { target: 'https://example.com/app' },
    { target: 'file://other-host/Applications/Scholar%20Seed.app/' },
    { processes: '501 /other/ShipIt' },
    {
      processes:
        '501 /Applications/Scholar Seed.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt-other',
    },
    { processes: '501 ShipIt' },
  ])
    assert.equal(classifySquirrelStartup(handoff, { ...evidence, ...changed }, now), 'unconfirmed')
})
test('expired and future handoffs never gain a new pending interval on restart', () => {
  for (const at of [now + 1, now - SQUIRREL_INSTALLATION_WINDOW_MS - 1])
    assert.equal(classifySquirrelStartup({ ...handoff, at }, evidence, now), 'unconfirmed')
  assert.equal(
    classifySquirrelStartup(handoff, evidence, now + SQUIRREL_INSTALLATION_WINDOW_MS),
    'unconfirmed'
  )
  assert.equal(handoff.at, now - 1000)
})

test('invalid probe context stays unconfirmed and explicit failure needs no probe', async () => {
  assert.equal(
    await inspectSquirrelStartup(handoff, '/nonexistent', 'invalid/bundle', application),
    'unconfirmed'
  )
  assert.equal(
    await inspectSquirrelStartup(
      { ...handoff, state: 'failed' },
      '/nonexistent',
      'invalid/bundle',
      application
    ),
    'failed'
  )
})

test('startup gate exits without a startup window or notice delay before product admission', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const bootstrap = source.slice(source.indexOf('async function bootstrap()'))
  const gate = bootstrap.slice(
    bootstrap.indexOf('if (updater.macHandoffCommitted())'),
    bootstrap.indexOf('const attachUrl')
  )
  assert.match(gate, /await updater\.macStartupStatus\(pushLog\)/)
  assert.match(gate, /status === 'failed'/)
  assert.match(gate, /app\.exit\(0\)/)
  assert.doesNotMatch(gate, /startManagedBackend|waitForHealth|setTimeout|openStartupScreen/)
  const entry = source.slice(source.indexOf('async function startDesktop()'))
  assert.ok(entry.indexOf('updater.macStartupAdmission(') < entry.indexOf('publishStorage('))
  assert.ok(
    entry.indexOf('updater.macStartupAdmission(') < entry.indexOf('coordinationReclamation.run(')
  )
})

test('unresolved source launches exit regardless of the age or missing native process evidence', () => {
  const current = { version: '0.2.0', buildNumber: '202610121200' }
  for (const state of ['requested', 'downloaded', 'installing'] as const) {
    for (const status of ['installing', 'unconfirmed'] as const) {
      assert.equal(squirrelAdmission(current, { ...handoff, state }, status), 'exit')
      assert.equal(squirrelAdmission(current, { ...handoff, state, at: 0 }, status), 'exit')
    }
  }
  assert.equal(squirrelAdmission(current, handoff, 'failed'), 'failed')
})

test('only the installed target or a newer build may pass a consumed handoff', () => {
  for (const buildNumber of [handoff.buildNumber, '202610141200']) {
    assert.equal(
      squirrelAdmission({ version: handoff.version, buildNumber }, handoff, 'unconfirmed'),
      'allow'
    )
  }
  assert.equal(
    squirrelAdmission({ version: 'unknown', buildNumber: '' }, handoff, 'unconfirmed'),
    'exit'
  )
  assert.equal(
    squirrelAdmission({ version: '0.2.0', buildNumber: '' }, null, 'unconfirmed'),
    'allow'
  )
})

test('privileged helper evidence is recognized without accepting another user or installation', () => {
  assert.equal(
    classifySquirrelStartup(
      handoff,
      {
        ...evidence,
        processes: `0 ${evidence.executable}\n`,
      },
      now
    ),
    'installing'
  )
  assert.equal(
    classifySquirrelStartup(
      handoff,
      {
        ...evidence,
        processes: `502 ${evidence.executable}\n`,
      },
      now
    ),
    'unconfirmed'
  )
})

test('legacy failures and unbound acknowledgements cannot claim the new no-grant protocol', async () => {
  const legacy = { ...handoff, binding: undefined, state: 'failed' as const }
  assert.equal(classifySquirrelStartup(legacy, evidence, now), 'unconfirmed')
  assert.equal(
    await inspectSquirrelStartup(legacy, '/missing', 'fixture', '/missing'),
    'unconfirmed'
  )
  assert.equal(
    await readSquirrelFailure('file:///missing', '/missing', {
      source: {
        path: '/missing',
        parent: { dev: 1, ino: 2, uid: 501 },
        item: { dev: 1, ino: 3, uid: 501 },
      },
      target: {
        path: '/missing',
        parent: { dev: 1, ino: 2, uid: 501 },
        item: { dev: 1, ino: 3, uid: 501 },
      },
    }),
    false
  )
})

test(
  'native terminal acknowledgement is identity-bound and rejects replaced or unsafe records',
  {
    skip: process.platform !== 'darwin',
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'squirrel-terminal-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const source = join(directory, 'request', 'Example.app')
    const target = join(directory, 'live', 'Example.app')
    await mkdir(source, { recursive: true })
    await mkdir(target, { recursive: true })
    await chmod(dirname(source), 0o700)
    const record = terminalRecord(source, target)
    const ack = join(dirname(source), '.scholarseed-prepare.plist')
    const url = pathToFileURL(source).href
    const publish = async (value: unknown) => {
      await writeFile(ack, JSON.stringify(value), { mode: 0o600 })
    }
    assert.equal(await readSquirrelFailure(url, target, record), false)
    await publish(record)
    assert.equal(await readSquirrelFailure(url, target, record), true)
    assert.equal(await readSquirrelFailure(url, target), false)
    assert.equal(
      await readSquirrelFailure(url, target, {
        ...record,
        source: { ...record.source, item: { ...record.source.item, ino: 1 } },
      }),
      false
    )
    await publish({ ...record, ready: true })
    assert.equal(await readSquirrelFailure(url, target, record), false)
    await publish({
      ...record,
      target: { ...record.target, item: { ...record.target.item, ino: 1 } },
    })
    assert.equal(await readSquirrelFailure(url, target, record), false)
    await publish(record)
    await chmod(ack, 0o666)
    assert.equal(await readSquirrelFailure(url, target, record), false)
    await rm(ack)
    await writeFile(ack + '.real', JSON.stringify(record))
    await symlink(ack + '.real', ack)
    assert.equal(await readSquirrelFailure(url, target, record), false)
  }
)

test(
  'missing native state fails closed through the command probe',
  { skip: process.platform !== 'darwin' },
  async () => {
    assert.equal(
      await inspectSquirrelStartup(handoff, '/nonexistent', 'com.scholarseed.desktop', application),
      'unconfirmed'
    )
  }
)

test(
  'downloaded request binding matches the candidate release and refuses old request identities',
  {
    skip: process.platform !== 'darwin',
  },
  async (t) => {
    const directory = realpathSync(await mkdtemp(join(tmpdir(), 'squirrel-binding-')))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const target = join(directory, 'live', 'Example.app')
    const bundle = 'org.scholarseed.binding'
    const source = join(directory, `${bundle}.ShipIt`, 'request', 'Example.app')
    const binding = {
      schema: 1 as const,
      requestId: 'a'.repeat(64),
      candidate: handoff.candidate,
      sha512: 'b'.repeat(128),
      size: 100,
    }
    const current = { ...handoff, binding }
    const state = join(directory, `${bundle}.ShipIt`, 'ShipItState.plist')
    await mkdir(join(source, 'Contents', 'Resources'), { recursive: true })
    await mkdir(target, { recursive: true })
    await mkdir(dirname(state), { recursive: true })
    await chmod(dirname(source), 0o700)
    await writeFile(
      join(source, 'Contents', 'Resources', 'product.json'),
      JSON.stringify({ build_number: handoff.buildNumber })
    )
    await writeFile(
      join(source, 'Contents', 'Info.plist'),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${handoff.version}</string></dict></plist>`
    )
    await writeFile(
      state,
      JSON.stringify({
        updateBundleURL: pathToFileURL(source).href,
        targetBundleURL: pathToFileURL(target).href,
        binding,
        bundleIdentifier: bundle,
        launchAfterInstallation: false,
        installationAuthorized: false,
      })
    )
    const bound = await bindSquirrelRequest(directory, bundle, target, current)
    const alternateOwner = join(directory, `${bundle}.ShipIt.next`)
    await mkdir(alternateOwner, { mode: 0o700 })
    const alternateState = join(alternateOwner, 'ShipItState.plist')
    const primaryBytes = readFileSync(state)
    await writeFile(alternateState, primaryBytes)
    const next = { ...current, alternate: true as const }
    await assert.rejects(bindSquirrelRequest(directory, bundle, target, next), /source differs/)
    const alternateSource = join(alternateOwner, 'request', 'Example.app')
    await mkdir(join(alternateSource, 'Contents', 'Resources'), { recursive: true })
    for (const file of ['Contents/Resources/product.json', 'Contents/Info.plist'])
      await copyFile(join(source, file), join(alternateSource, file))
    const nextState = {
      ...JSON.parse(primaryBytes.toString()),
      updateBundleURL: pathToFileURL(alternateSource).href,
    }
    await writeFile(alternateState, JSON.stringify(nextState))
    const nextBound = await bindSquirrelRequest(directory, bundle, target, next)
    assert.equal(nextBound.source.path, realpathSync(alternateSource))
    const nextPreparation = join(alternateOwner, 'CandidatePreparation')
    const nextCandidate = join(nextPreparation, 'shipit-candidate.fixture', 'Example.app')
    await mkdir(nextCandidate, { recursive: true, mode: 0o700 })
    const nextCapture = (path: string) => {
      const { dev, ino, uid } = lstatSync(path)
      return { dev, ino, uid }
    }
    const receipt = (path: string) =>
      JSON.stringify({
        schema: '1',
        record: {
          state: 'ready',
          binding,
          source: nextBound.source,
          target: nextBound.target,
          candidate: { path, item: nextCapture(path), parent: nextCapture(dirname(path)) },
        },
      })
    const nextJournal = join(nextPreparation, 'journal.plist')
    await writeFile(nextJournal, receipt(source), { mode: 0o600 })
    assert.equal(
      (await bindSquirrelRequest(directory, bundle, target, next, directory)).prepared,
      undefined
    )
    await writeFile(nextJournal, receipt(nextCandidate))
    assert.equal(
      (await bindSquirrelRequest(directory, bundle, target, next, directory)).prepared?.path,
      nextCandidate
    )
    await writeFile(
      alternateState,
      JSON.stringify({ ...nextState, bundleIdentifier: bundle + '.next' })
    )
    await assert.rejects(bindSquirrelRequest(directory, bundle, target, next), /binding differs/)
    const owner = join(dirname(state), 'CandidatePreparation')
    const prepared = join(directory, 'native-copy', 'Example.app')
    await mkdir(owner, { mode: 0o700 })
    await mkdir(prepared, { recursive: true })
    const identity = (path: string) => {
      const { dev, ino, uid } = lstatSync(path)
      return { dev, ino, uid }
    }
    const native = {
      state: 'ready',
      binding,
      source: bound.source,
      target: bound.target,
      candidate: {
        path: realpathSync(prepared),
        parent: identity(dirname(prepared)),
        item: identity(prepared),
      },
    }
    const journal = join(owner, 'journal.plist')
    await writeFile(journal, JSON.stringify({ schema: '1', record: native }), { mode: 0o600 })
    execFileSync('/usr/bin/plutil', ['-convert', 'binary1', journal])
    const ready = await bindSquirrelRequest(directory, bundle, target, current, directory)
    assert.equal(squirrelPreparedDevice(ready.prepared), identity(prepared).dev)
    await rename(prepared, prepared + '.old')
    await mkdir(prepared)
    assert.equal(squirrelPreparedDevice(ready.prepared), undefined)
    assert.equal(
      (await bindSquirrelRequest(directory, bundle, target, current, directory)).prepared,
      undefined
    )
    await assert.rejects(
      bindSquirrelRequest(directory, bundle, target, {
        ...current,
        candidate: 'different-id-same-release',
      }),
      /binding differs/
    )
    for (const changed of [
      { candidate: 'other' },
      { requestId: 'c'.repeat(64) },
      { sha512: 'd'.repeat(128) },
      { size: 101 },
    ])
      await assert.rejects(
        bindSquirrelRequest(directory, bundle, target, {
          ...current,
          binding: { ...binding, ...changed },
        }),
        /binding differs/
      )
    const record = { ...terminalRecord(source, target), binding }
    await writeFile(join(dirname(source), '.scholarseed-prepare.plist'), JSON.stringify(record), {
      mode: 0o600,
    })
    assert.equal(await readSquirrelFailure(pathToFileURL(source).href, target, bound), true)
    assert.equal(
      await readSquirrelFailure(pathToFileURL(source).href, target, {
        ...bound,
        source: { ...bound.source, path: bound.source.path + '.other' },
      }),
      false
    )
    await assert.rejects(
      bindSquirrelRequest(directory, bundle, target, { ...current, buildNumber: '202610220001' }),
      /candidate changed or differs/
    )
    await assert.rejects(
      bindSquirrelRequest(directory, bundle, target, { ...current, version: '0.3.0' }),
      /candidate changed or differs/
    )
    await chmod(state, 0o666)
    await assert.rejects(
      bindSquirrelRequest(directory, bundle, target, current),
      /Unsafe native request/
    )
  }
)

// OS contract fixture only: this is not a signed Squirrel update acceptance test.
test(
  'ordinary exit allows a fresh request only with bound native cancellation and stable evidence',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const cache = realpathSync(await mkdtemp(join(tmpdir(), 'squirrel-cancelled-')))
    t.after(() => rm(cache, { recursive: true, force: true }))
    const bundle = 'org.scholarseed.cancelled'
    const application = join(cache, 'Installed.app')
    const owner = join(cache, `${bundle}.ShipIt`)
    const source = join(owner, 'update.fixture', 'Candidate.app')
    const statePath = join(owner, 'ShipItState.plist')
    const ackPath = join(dirname(source), '.scholarseed-prepare.plist')
    const helper = join(application, 'Contents/Frameworks/Squirrel.framework/Resources/ShipIt')
    await mkdir(dirname(helper), { recursive: true })
    await writeFile(helper, 'fixture: never executed')
    await mkdir(source, { recursive: true, mode: 0o700 })
    await mkdir(join(source, 'Contents', 'Resources'), { recursive: true })
    await writeFile(
      join(source, 'Contents', 'Resources', 'product.json'),
      JSON.stringify({ build_number: handoff.buildNumber })
    )
    await writeFile(
      join(source, 'Contents', 'Info.plist'),
      JSON.stringify({ CFBundleShortVersionString: handoff.version })
    )

    const exited = spawn('/usr/bin/true')
    await once(exited, 'exit')
    assert.ok(exited.pid)
    const native = terminalRecord(source, application)
    const current: SquirrelHandoff = {
      ...handoff,
      sourcePid: exited.pid,
      state: 'downloaded',
      nativeRequest: native,
    }
    const request = {
      bundleIdentifier: bundle,
      binding: native.binding,
      targetBundleURL: pathToFileURL(application).href,
      updateBundleURL: pathToFileURL(source).href,
      installationAuthorized: false,
      launchAfterInstallation: false,
      useUpdateBundleName: true,
    }
    const ack = { ...native, code: osConstants.errno.ECANCELED }
    const inspect = (entry = current) =>
      inspectCancelledSquirrelPreparation(cache, bundle, application, entry)
    const requested = { ...current, state: 'requested' as const, nativeRequest: undefined }

    await writeFile(statePath, JSON.stringify(request), { mode: 0o600 })
    assert.equal(await inspect(), null)
    assert.equal(await inspect(requested), null)
    await writeFile(ackPath, JSON.stringify(ack), { mode: 0o600 })
    assert.equal(await inspect({ ...current, sourcePid: process.pid }), null)
    assert.equal(await inspect({ ...current, state: 'installing' }), null)
    const proof = await inspect()
    assert.equal(proof?.(), true)
    assert.equal((await inspect(requested))?.(), true)
    assert.equal(await inspect({ ...requested, binding: undefined }), null)

    await writeFile(statePath + '.replacement', JSON.stringify(request), { mode: 0o600 })
    await rename(statePath + '.replacement', statePath)
    assert.equal(proof?.(), false)
    for (const authorization of [
      { installationAuthorized: true, launchAfterInstallation: true },
      { installationAuthorized: false, launchAfterInstallation: true },
    ]) {
      await writeFile(statePath, JSON.stringify({ ...request, ...authorization }))
      assert.equal(await inspect(), null)
      assert.equal(await inspect(requested), null)
    }
    await writeFile(statePath, JSON.stringify(request))
    await writeFile(ackPath, JSON.stringify({ ...ack, code: osConstants.errno.EIO }))
    assert.equal(await inspect(), null)
    assert.equal(
      await inspectSquirrelIdle(cache, bundle, application, current, undefined, true),
      false
    )
  }
)

test(
  'superseded inspection accepts only a stable bound native failure and preserves records',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const directory = realpathSync(await mkdtemp(join(tmpdir(), 'superseded-failure-')))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const application = join(directory, 'Example App.app')
    const helper = join(application, 'Contents/Frameworks/Squirrel.framework/Resources/ShipIt')
    const bundle = 'org.scholarseed.failure'
    const cache = join(directory, `${bundle}.ShipIt`)
    const source = join(cache, 'request', 'Example.app')
    await mkdir(dirname(helper), { recursive: true })
    await writeFile(helper, 'fixture: never executed')
    await mkdir(source, { recursive: true })
    await chmod(dirname(source), 0o700)
    await chmod(cache, 0o700)
    const state = join(cache, 'ShipItState.plist')
    const ack = join(dirname(source), '.scholarseed-prepare.plist')
    const native = terminalRecord(source, application)
    const current = { ...handoff, nativeRequest: native }
    const request = {
      bundleIdentifier: bundle,
      binding: native.binding,
      targetBundleURL: pathToFileURL(application).href + '/',
      updateBundleURL: pathToFileURL(source).href + '/',
      installationAuthorized: true,
      launchAfterInstallation: true,
      useUpdateBundleName: true,
    }
    await writeFile(state, JSON.stringify(request), { mode: 0o600 })
    assert.equal(await inspectSquirrelIdle(directory, bundle, application, current), false)
    await writeFile(ack, JSON.stringify(native), { mode: 0o600 })
    const original = [readFileSync(state), readFileSync(ack)]
    assert.equal(await inspectSquirrelIdle(directory, bundle, application, current), true)
    assert.equal(await inspectSquirrelIdle(directory, bundle, application, current), true)
    assert.deepEqual([readFileSync(state), readFileSync(ack)], original)
    for (const patch of [
      { bundleIdentifier: 'other.bundle' },
      { binding: { ...native.binding, requestId: 'f'.repeat(64) } },
      { targetBundleURL: pathToFileURL(source).href },
      { updateBundleURL: pathToFileURL(application).href },
    ]) {
      await writeFile(state, JSON.stringify({ ...request, ...patch }))
      assert.equal(await inspectSquirrelIdle(directory, bundle, application, current), false)
    }
    await writeFile(state, original[0])
    const inspectOrphan = (candidate: string, observed: boolean) =>
      inspectSquirrelIdle(directory, bundle, application, null, async () => {}, false, {
        candidate,
        observedLaunch: (requestedSource, requestedTarget) =>
          observed && requestedSource === source && requestedTarget === application,
      })
    assert.equal(await inspectOrphan(native.binding.candidate, true), true)
    assert.equal(await inspectOrphan(native.binding.candidate, false), false)
    assert.equal(await inspectOrphan('another-candidate', true), false)
    const alternateOwner = cache + '.next'
    const alternateSource = join(alternateOwner, 'request', 'Example.app')
    const alternateState = join(alternateOwner, 'ShipItState.plist')
    await mkdir(alternateSource, { recursive: true, mode: 0o700 })
    const alternateRequest = JSON.stringify({
      ...request,
      updateBundleURL: pathToFileURL(alternateSource).href,
    })
    await writeFile(alternateState, alternateRequest, { mode: 0o600 })
    const orphan = (
      observedLaunch: (source: string, target: string, alternate: boolean) => boolean,
      verifyReplacement?: (path: string) => Promise<void>
    ) =>
      inspectSquirrelIdle(directory, bundle, application, null, verifyReplacement, false, {
        candidate: native.binding.candidate,
        observedLaunch,
      })
    assert.equal(await orphan(() => true), false)
    const observedAlternate = (value: string, _: string, slot: boolean) =>
      slot && value === alternateSource
    const verifyBothSlots = t.mock.fn(async (path: string) => {
      assert.equal(path, application)
    })
    assert.equal(await orphan(observedAlternate, verifyBothSlots), true)
    assert.equal(verifyBothSlots.mock.callCount(), 1)
    const failedVerification = t.mock.fn(async () => {
      throw new Error('untrusted replacement')
    })
    assert.equal(await orphan(observedAlternate, failedVerification), false)
    assert.equal(failedVerification.mock.callCount(), 1)
    assert.equal(
      await orphan((_, __, slot) => {
        if (!slot) writeFileSync(alternateState, alternateRequest + '\n')
        return !slot
      }),
      false
    )
    await rm(alternateOwner, { recursive: true })
    await writeFile(state, JSON.stringify({ ...request, installationAuthorized: false }))
    assert.equal(await inspectOrphan(native.binding.candidate, true), false)
    await writeFile(state, original[0])
    await writeFile(ack, JSON.stringify({ ...native, ready: true }))
    assert.equal(await inspectSquirrelIdle(directory, bundle, application, current), false)
    await writeFile(ack, JSON.stringify({ ...native, code: 0 }))
    assert.equal(await inspectSquirrelIdle(directory, bundle, application, current), false)
    await writeFile(ack, original[1])
    assert.equal(
      await inspectSquirrelIdle(directory, bundle, application, {
        ...current,
        nativeRequest: undefined,
      }),
      false
    )
    await chmod(state, 0o666)
    assert.equal(await inspectSquirrelIdle(directory, bundle, application, current), false)
    await chmod(state, 0o600)
    await chmod(cache, 0o777)
    assert.equal(await inspectSquirrelIdle(directory, bundle, application, current), false)
    await chmod(cache, 0o700)
    await rename(application, application + '.previous')
    await mkdir(dirname(helper), { recursive: true })
    await writeFile(helper, 'replacement fixture')
    await assert.rejects(
      verifySquirrelReplacement(application, bundle, 'A1B2C3D4E5', '202611101200')
    )
    assert.equal(await readSquirrelFailure(request.updateBundleURL, application, native), false)
    assert.equal(await inspectSquirrelIdle(directory, bundle, application, current), false)
    let verified = 0
    const verify = async (path: string) => {
      assert.equal(path, application)
      verified++
    }
    assert.equal(await inspectSquirrelIdle(directory, bundle, application, current, verify), true)
    assert.equal(verified, 1)
    assert.deepEqual([readFileSync(state), readFileSync(ack)], original)
    assert.equal(
      await inspectSquirrelIdle(directory, bundle, application, current, async () => {
        throw new Error('wrong signing team')
      }),
      false
    )
    await writeFile(
      ack,
      JSON.stringify({ ...native, target: terminalRecord(source, application).target })
    )
    assert.equal(await inspectSquirrelIdle(directory, bundle, application, current, verify), false)
    await writeFile(ack, original[1])
    assert.equal(
      await inspectSquirrelIdle(directory, bundle, application, current, async () => {
        await rename(application, application + '.changed')
        await mkdir(dirname(helper), { recursive: true })
        await writeFile(helper, 'raced replacement')
      }),
      false
    )
    await rm(state)
    assert.equal(await inspectSquirrelIdle(directory, bundle, application, current), true)
    assert.equal(
      await inspectSquirrelIdle(directory, bundle, application, current, async () => {
        throw new Error('replacement validation failed with no native state')
      }),
      false
    )
  }
)

// OS contract fixture only: this is not a signed Squirrel update acceptance test.
test(
  'native probe distinguishes terminal restoration from installation without admitting a live helper',
  { skip: process.platform !== 'darwin', timeout: 30_000 },
  async (t) => {
    const directory = realpathSync(await mkdtemp(join(tmpdir(), 'squirrel-probe-')))
    const owned: { helper?: ReturnType<typeof spawn> } = {}
    t.after(async () => {
      const helper = owned.helper
      if (helper && helper.exitCode === null && helper.signalCode === null) {
        const exited = once(helper, 'exit')
        helper.kill()
        await exited
      }
      await rm(directory, { recursive: true, force: true })
    })
    const application = join(directory, 'Example App.app')
    const framework = join(application, 'Contents', 'Frameworks', 'Squirrel.framework')
    const resources = join(framework, 'Versions', 'A', 'Resources')
    await mkdir(resources, { recursive: true })
    await symlink('Versions/A/Resources', join(framework, 'Resources'))
    const executable = join(resources, 'ShipIt')
    // Compile an owned executable: copying an Apple platform binary can retain
    // a code-signing identity that macOS refuses to run outside its system path.
    const probe = join(directory, 'probe.c')
    await writeFile(probe, '#include <unistd.h>\nint main(void) { for (;;) pause(); }\n')
    execFileSync('/usr/bin/xcrun', ['clang', probe, '-o', executable], { timeout: 30_000 })
    await chmod(executable, 0o700)
    const bundle = 'org.scholarseed.probe'
    const cache = join(directory, `${bundle}.ShipIt`)
    await mkdir(cache)
    const source = join(cache, 'request', 'Example.app')
    await mkdir(source, { recursive: true })
    await chmod(dirname(source), 0o700)
    const statePath = join(cache, 'ShipItState.plist')
    const request = {
      targetBundleURL: pathToFileURL(application).href,
      updateBundleURL: pathToFileURL(source).href,
      binding: protocolBinding,
      bundleIdentifier: bundle,
      installationAuthorized: true,
      launchAfterInstallation: true,
      useUpdateBundleName: true,
    }
    await writeFile(statePath, JSON.stringify(request), { mode: 0o600 })
    const acknowledgement = join(dirname(source), '.scholarseed-prepare.plist')
    await writeFile(acknowledgement, JSON.stringify(terminalRecord(source, application)), {
      mode: 0o600,
    })
    const helper = spawn(join(framework, 'Resources', 'ShipIt'), [], {
      stdio: 'ignore',
    })
    owned.helper = helper
    await once(helper, 'spawn')
    const publisher = spawn('/usr/bin/true')
    await once(publisher, 'exit')
    assert.ok(publisher.pid)
    const current: SquirrelHandoff = {
      ...handoff,
      sourcePid: publisher.pid,
      at: Date.now(),
      nativeRequest: terminalRecord(source, application),
    }
    const inspect = (entry = current) =>
      inspectRestoredSquirrelInstallation(directory, bundle, application, entry)
    assert.equal(await inspectSquirrelStartup(current, directory, bundle, application), 'restoring')
    assert.equal(await inspect(), null)
    assert.equal(await inspectSquirrelIdle(directory, bundle, application, current), false)
    await rm(acknowledgement)
    assert.equal(
      await inspectSquirrelStartup(current, directory, bundle, application),
      'installing'
    )
    await writeFile(acknowledgement, JSON.stringify(terminalRecord(source, application)), {
      mode: 0o600,
    })
    const exited = once(helper, 'exit')
    helper.kill()
    await exited
    assert.equal(await inspectSquirrelStartup(current, directory, bundle, application), 'failed')
    assert.equal(await inspectSquirrelIdle(directory, bundle, application, current), true)
    const proof = await inspect()
    assert.equal(proof?.(), true)
    assert.equal(await inspect({ ...current, sourcePid: process.pid }), null)
    assert.equal(await inspect({ ...current, state: 'downloaded' }), null)
    const legacy = { ...current, sourcePid: undefined }
    assert.equal(await inspect(legacy), null)
    let publisherAbsent = true
    const legacyProof = await inspectRestoredSquirrelInstallation(
      directory,
      bundle,
      application,
      legacy,
      () => publisherAbsent
    )
    assert.equal(legacyProof?.(), true)
    publisherAbsent = false
    assert.equal(legacyProof?.(), false)
    assert.equal(
      await inspectRestoredSquirrelInstallation(
        directory,
        bundle,
        application,
        legacy,
        () => publisherAbsent
      ),
      null
    )
    for (const [root, expected] of [
      [join(directory, 'Other App.app'), true],
      [source, false],
    ] as const) {
      const other = join(root, 'Contents/Frameworks/Squirrel.framework/Resources/ShipIt')
      await mkdir(dirname(other), { recursive: true })
      await copyFile(executable, other)
      const active = spawn(other, [], { stdio: 'ignore' })
      owned.helper = active
      await once(active, 'spawn')
      assert.equal(proof?.(), expected)
      assert.equal(await inspectSquirrelIdle(directory, bundle, application, current), expected)
      assert.equal(
        await inspectSquirrelStartup(current, directory, bundle, application),
        expected ? 'failed' : 'restoring'
      )
      if (expected) {
        // macOS can still report a live image whose executable no longer resolves.
        await rm(other)
        const status = await inspectSquirrelStartup(current, directory, bundle, application)
        assert.equal(status, 'restoring')
        const oldBuild = { version: '0.2.0', buildNumber: '202610130001' }
        assert.equal(squirrelAdmission(oldBuild, current, status), 'exit')
      }
      const stopped = once(active, 'exit')
      active.kill()
      await stopped
      assert.equal(await inspectSquirrelStartup(current, directory, bundle, application), 'failed')
    }
    const failure = readFileSync(acknowledgement)
    await rm(acknowledgement)
    assert.equal(proof?.(), false)
    assert.equal(await inspect(), null)
    assert.equal(
      await inspectSquirrelStartup(current, directory, bundle, application),
      'unconfirmed'
    )
    await writeFile(acknowledgement, failure, { mode: 0o600 })
    assert.equal(proof?.(), false)
    for (const changed of [
      { installationAuthorized: false },
      { launchAfterInstallation: false },
      { binding: { ...request.binding, requestId: 'f'.repeat(64) } },
    ]) {
      await writeFile(statePath, JSON.stringify({ ...request, ...changed }))
      assert.equal(await inspect(), null)
    }
    await writeFile(statePath, JSON.stringify(request))
    const restored = await inspect()
    assert.equal(restored?.(), true)
    await rename(join(application, 'Contents'), join(application, 'PreviousContents'))
    await mkdir(dirname(executable), { recursive: true })
    await symlink('Versions/A/Resources', join(framework, 'Resources'))
    await copyFile(executable.replace('/Contents/', '/PreviousContents/'), executable)
    assert.equal(restored?.(), false)
    await rename(application, application + '.previous')
    await mkdir(dirname(executable), { recursive: true })
    await symlink('Versions/A/Resources', join(framework, 'Resources'))
    await copyFile(executable.replace(application, application + '.previous'), executable)
    assert.equal(await inspect(), null)
  }
)

test('startup waits for native launch to settle and retains terminal evidence requirements', async () => {
  let probes = 0
  assert.equal(
    await settleSquirrelStartup(async () => (++probes < 3 ? 'installing' : 'failed')),
    'failed'
  )
  assert.equal(probes, 3)
  probes = 0
  assert.equal(
    await settleSquirrelStartup(async () => {
      probes++
      return 'unconfirmed'
    }),
    'unconfirmed'
  )
  assert.equal(probes, 1)
  probes = 0
  assert.equal(
    await settleSquirrelStartup(async () => (++probes < 2 ? 'installing' : 'unconfirmed')),
    'unconfirmed'
  )
  assert.equal(probes, 2)
})

test('terminal restoration waits for helper exit before granting failed admission', async () => {
  let probes = 0
  assert.equal(
    await settleSquirrelStartup(async () => (++probes < 3 ? 'restoring' : 'failed')),
    'failed'
  )
  assert.equal(probes, 3)
  assert.equal(
    squirrelAdmission({ version: '0.2.0', buildNumber: '202610130001' }, handoff, 'restoring'),
    'exit'
  )
})

test('native settling deadline retains installing status and never grants failure admission', async () => {
  assert.equal(await settleSquirrelStartup(async () => 'installing'), 'installing')
})
