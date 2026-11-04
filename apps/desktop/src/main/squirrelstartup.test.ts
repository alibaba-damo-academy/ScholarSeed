import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, chmod, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import {
  classifySquirrelStartup,
  inspectSquirrelStartup,
  settleSquirrelStartup,
  SQUIRREL_INSTALLATION_WINDOW_MS,
  squirrelAdmission,
  readSquirrelFailure,
  bindSquirrelRequest,
  inspectSquirrelIdle,
  squirrelHelpersAbsent,
  squirrelLaunchSuperseded,
} from './squirrelstartup.ts'
import type { SquirrelHandoff } from './squirrel.ts'

const now = 1_800_000_000_000
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

test('superseded recovery refuses active user or root helpers and incomplete process evidence', () => {
  assert.equal(
    squirrelHelpersAbsent(' 501 /Applications/ScholarSeed.app/Contents/MacOS/ScholarSeed\n', 501),
    true
  )
  for (const processes of [
    '',
    'truncated',
    '0 /Applications/App.app/ShipIt',
    '501 /cache/ShipIt',
  ]) {
    assert.equal(squirrelHelpersAbsent(processes, 501), false)
  }
  assert.equal(squirrelHelpersAbsent('502 /Applications/Other.app/ShipIt\r\n', 501), true)
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
      assert.equal(await inspectSquirrelIdle(cache, bundle), false)
      await rm(join(directory, 'ShipItState.plist'))
      await chmod(directory, 0o777)
      assert.equal(await inspectSquirrelIdle(cache, bundle), false)
      await chmod(directory, 0o700)
      await rm(directory, { recursive: true })
      await symlink(cache, directory)
      assert.equal(await inspectSquirrelIdle(cache, bundle), false)
      assert.equal(await inspectSquirrelIdle(cache, '../invalid'), false)
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
    const directory = await mkdtemp(join(tmpdir(), 'squirrel-binding-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const target = join(directory, 'live', 'Example.app')
    const source = join(directory, 'request', 'Example.app')
    const bundle = 'org.scholarseed.binding'
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
        installationAuthorized: false,
      })
    )
    const bound = await bindSquirrelRequest(directory, bundle, target, current)
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
  'native probe distinguishes terminal restoration from installation without admitting a live helper',
  { skip: process.platform !== 'darwin', timeout: 30_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'squirrel-probe-'))
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
    const source = join(directory, 'request', 'Example.app')
    await mkdir(source, { recursive: true })
    await chmod(dirname(source), 0o700)
    await writeFile(
      join(cache, 'ShipItState.plist'),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>targetBundleURL</key><string>${pathToFileURL(application).href}/</string><key>updateBundleURL</key><string>${pathToFileURL(source).href}</string></dict></plist>`
    )
    const acknowledgement = join(dirname(source), '.scholarseed-prepare.plist')
    await writeFile(acknowledgement, JSON.stringify(terminalRecord(source, application)), {
      mode: 0o600,
    })
    const helper = spawn(join(framework, 'Resources', 'ShipIt'), [], {
      stdio: 'ignore',
    })
    owned.helper = helper
    await once(helper, 'spawn')
    const current = {
      ...handoff,
      at: Date.now(),
      nativeRequest: terminalRecord(source, application),
    }
    assert.equal(await inspectSquirrelStartup(current, directory, bundle, application), 'restoring')
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
    await rm(acknowledgement)
    assert.equal(
      await inspectSquirrelStartup(current, directory, bundle, application),
      'unconfirmed'
    )
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
