import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { execFile } from 'node:child_process'
import { activationCommitGuard, ActivationExpired } from './update-authorization.ts'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile, symlink, truncate, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  SquirrelInstallation,
  assertSquirrelArchiveSize,
  discardOnTerminalSquirrelFailure,
  MAX_SQUIRREL_ARCHIVE_BYTES,
  readSquirrelHandoff,
  squirrelFeed,
  shipItDiagnostics,
  SQUIRREL_NATIVE_ERROR_EVENT,
  type SquirrelHandoff,
  type SquirrelArchive,
  type SquirrelNativeRequest,
  validSquirrelBinding,
} from './squirrel.ts'
import { inspectSquirrelStartup } from './squirrelstartup.ts'

const identity: SquirrelHandoff = {
  version: '0.2.0',
  buildNumber: '2026100902',
  candidate: 'build-two',
  at: 1,
  state: 'requested',
}
const run = promisify(execFile)
const FEED_ASSERTION_TIMEOUT_MS = 10_000

async function expectFeedRejection(t: Pick<TestContext, 'after'>, archive: SquirrelArchive) {
  await assert.rejects(async () => {
    const feed = await squirrelFeed(archive)
    t.after(() => feed.close())
  })
}
async function fixture(t: { after: (callback: () => Promise<void>) => void }): Promise<{
  directory: string
  record: string
  archive: SquirrelArchive
  bytes: Buffer
}> {
  const directory = await mkdtemp(join(tmpdir(), 'squirrel-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bytes = Buffer.alloc(200_000, 'a')
  const path = join(directory, 'application.zip')
  await writeFile(path, bytes)
  return {
    directory,
    record: join(directory, 'handoff.json'),
    bytes,
    archive: { path, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('hex') },
  }
}
class Updater extends EventEmitter {
  url = ''
  checks = 0
  quits = 0
  initializeError = false
  check = (): void => {}
  setFeedURL({ url }: { url: string }): void {
    this.url = url
    if (this.initializeError) this.emit('error', new Error('unsigned application'))
  }
  checkForUpdates(): void {
    this.checks++
    this.check()
  }
  quitAndInstall(): void {
    this.quits++
  }
}

class InstallationFixture extends SquirrelInstallation {
  constructor(
    updater: Updater,
    record: string,
    diagnostic: (event: string) => void,
    timeout?: number,
    bind: (identity: SquirrelHandoff) => Promise<SquirrelNativeRequest> = async (candidate) => {
      const source = {
        path: '/fixture/source',
        parent: { dev: 1, ino: 2, uid: 501 },
        item: { dev: 1, ino: 3, uid: 501 },
      }
      return { source, target: { ...source, path: '/fixture/target' }, binding: candidate.binding }
    }
  ) {
    super(updater, record, diagnostic, timeout, bind)
  }
}

test('loopback feed pins the archive and rejects wrong capability and browser origins', async (t) => {
  const { archive, bytes } = await fixture(t)
  const feed = await squirrelFeed(archive)
  try {
    const response = await fetch(feed.url)
    const payload = (await response.json()) as { url: string }
    assert.deepEqual(Buffer.from(await (await fetch(payload.url)).arrayBuffer()), bytes)
    assert.equal((await fetch(new URL('/unknown', feed.url))).status, 404)
    assert.equal(
      (await fetch(feed.url, { headers: { Origin: 'https://example.com' } })).status,
      404
    )
    await writeFile(archive.path, Buffer.alloc(bytes.length, 'b'))
    await assert.rejects(async () => {
      await (await fetch(payload.url)).arrayBuffer()
    })
  } finally {
    await feed.close()
  }
})

test('feed refuses altered bytes before opening the server', async (t) => {
  const { archive } = await fixture(t)
  await expectFeedRejection(t, { ...archive, sha512: '0'.repeat(128) })
})

test(
  'native no-follow feed opening refuses archive symlinks',
  {
    skip:
      process.platform === 'win32' &&
      'O_NOFOLLOW is unavailable on Windows; its updater is Velopack, not Squirrel.Mac',
  },
  async (t) => {
    const { archive, directory } = await fixture(t)
    const link = join(directory, 'link.zip')
    await symlink(archive.path, link)
    await expectFeedRejection(t, { ...archive, path: link })
  }
)

test('unexpected feed success fails its assertion without retaining the test process', async (t) => {
  const { archive, directory } = await fixture(t)
  const entry = join(directory, 'assertion.test.mjs')
  await writeFile(
    entry,
    `
    import assert from 'node:assert/strict';
    import { test } from 'node:test';
    import { squirrelFeed } from ${JSON.stringify(new URL('./squirrel.ts', import.meta.url).href)};
    ${expectFeedRejection.toString()}
    test('expected assertion failure', async (context) => {
      await expectFeedRejection(context, ${JSON.stringify(archive)});
    });
  `
  )
  const environment = { ...process.env }
  delete environment.NODE_TEST_CONTEXT
  await assert.rejects(
    run(
      process.execPath,
      ['--experimental-transform-types', '--test', '--test-reporter=tap', entry],
      {
        timeout: FEED_ASSERTION_TIMEOUT_MS,
        env: environment,
      }
    ),
    (error: Error & { code?: number; signal?: string; stdout?: string }) => {
      assert.equal(error.code, 1)
      assert.equal(error.signal, null)
      assert.match(error.stdout ?? '', /Missing expected rejection/)
      return true
    }
  )
})

test('native archive size bounds reject CFData growth to 2 GiB', () => {
  assert.doesNotThrow(() => assertSquirrelArchiveSize(1))
  assert.doesNotThrow(() => assertSquirrelArchiveSize(MAX_SQUIRREL_ARCHIVE_BYTES))
  for (const size of [0, -1, 1.5, NaN, Infinity, MAX_SQUIRREL_ARCHIVE_BYTES + 1, 1742843921])
    assert.throws(() => assertSquirrelArchiveSize(size), /smaller than 1 GiB/)
})

test('oversized cached ZIP fails before authorization or native handoff', async (t) => {
  const { archive, record } = await fixture(t)
  const size = MAX_SQUIRREL_ARCHIVE_BYTES + 1
  await truncate(archive.path, size)
  const oversized = { ...archive, size }
  await assert.rejects(squirrelFeed(oversized), /smaller than 1 GiB/)
  const updater = new Updater()
  const installation = new InstallationFixture(updater, record, () => {})
  let authorizations = 0
  await assert.rejects(
    installation.prepare(oversized, identity, async () => {
      authorizations++
      return () => {}
    }),
    /smaller than 1 GiB/
  )
  assert.equal(authorizations, 0)
  assert.equal(updater.url, '')
  assert.equal(updater.checks, 0)
  assert.equal(updater.quits, 0)
  await assert.rejects(access(record))
})

test('authorization and native initialization failures do not consume a handoff', async (t) => {
  const { archive, record } = await fixture(t)
  const updater = new Updater()
  const owner = new InstallationFixture(updater, record, () => {})
  await assert.rejects(
    owner.prepare(archive, identity, async () => {
      throw new Error('revoked')
    }),
    /revoked/
  )
  assert.equal(owner.committed, false)
  assert.equal(updater.checks, 0)
  assert.equal(readSquirrelHandoff(record), null)
  updater.initializeError = true
  await assert.rejects(
    owner.prepare(archive, identity, async () => () => {}),
    /initialization failed/
  )
  assert.equal(owner.committed, false)
  assert.equal(updater.checks, 0)
  assert.equal(readSquirrelHandoff(record), null)
  owner.dispose()
  assert.equal(updater.listenerCount('error'), 0)
})

test('durable identity precedes official check; download completion alone never quits', async (t) => {
  const { archive, record, bytes } = await fixture(t)
  const updater = new Updater()
  const events: string[] = []
  const owner = new InstallationFixture(updater, record, (event) => events.push(event))
  let transfer: Promise<void> | undefined
  updater.check = () => {
    assert.equal(readSquirrelHandoff(record)?.candidate, identity.candidate)
    assert.equal(owner.committed, true)
    transfer = (async () => {
      const feed = (await (await fetch(updater.url)).json()) as { url: string }
      assert.deepEqual(Buffer.from(await (await fetch(feed.url)).arrayBuffer()), bytes)
      updater.emit('update-downloaded')
    })()
  }
  const first = owner.prepare(archive, identity, async () => () => {})
  assert.equal(
    owner.prepare(archive, { ...identity, candidate: 'newer' }, async () => () => {}),
    first
  )
  await first
  await transfer
  assert.equal(updater.checks, 1)
  assert.equal(updater.quits, 0)
  assert.equal(owner.ready, true)
  assert.equal(readSquirrelHandoff(record)?.state, 'downloaded')
  await assert.rejects(
    owner.prepare(archive, { ...identity, candidate: 'newer' }, async () => () => {}),
    /consumed/
  )
  const beforeQuit = Date.now()
  owner.quitAndInstall()
  assert.equal(readSquirrelHandoff(record)?.state, 'installing')
  assert.ok(readSquirrelHandoff(record)!.at >= beforeQuit)
  updater.emit('error', new Error('late ShipIt failure'))
  assert.equal(updater.quits, 1)
  assert.equal(events.at(-1), 'native-outcome-unknown')
  assert.equal(readSquirrelHandoff(record)?.state, 'installing')
  assert.equal(owner.committed, true)
})

test('native request binding precedes readiness and survives the installing record', async (t) => {
  const { archive, record } = await fixture(t)
  const updater = new Updater()
  const capture = {
    path: '/fixture/source',
    parent: { dev: 1, ino: 2, uid: 501 },
    item: { dev: 1, ino: 3, uid: 501 },
  }
  const binding: SquirrelNativeRequest = {
    source: capture,
    target: { ...capture, path: '/fixture/target' },
  }
  let release: (value: typeof binding) => void
  let bindingStarted: () => void
  const started = new Promise<void>((resolve) => {
    bindingStarted = resolve
  })
  const owner = new InstallationFixture(
    updater,
    record,
    () => {},
    undefined,
    async (candidate) => {
      assert.equal(candidate.candidate, identity.candidate)
      binding.binding = candidate.binding
      bindingStarted!()
      return new Promise<typeof binding>((resolve) => {
        release = resolve
      })
    }
  )
  updater.check = () => updater.emit('update-downloaded')
  const preparing = owner.prepare(archive, identity, async () => () => {})
  await started
  assert.equal(owner.ready, false)
  assert.equal(readSquirrelHandoff(record)?.state, 'requested')
  assert.throws(() => owner.quitAndInstall(), /not ready/)
  release!(binding)
  await preparing
  owner.quitAndInstall()
  assert.deepEqual(readSquirrelHandoff(record)?.nativeRequest, binding)
  assert.equal(readSquirrelHandoff(record)?.state, 'installing')
})

test('a native error while request binding is pending cannot publish a late downloaded success', async (t) => {
  const { archive, record } = await fixture(t)
  const updater = new Updater()
  let release: () => void
  let bindingStarted: () => void
  const started = new Promise<void>((resolve) => {
    bindingStarted = resolve
  })
  const owner = new InstallationFixture(
    updater,
    record,
    () => {},
    undefined,
    async () => {
      bindingStarted!()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      throw new Error('old binding must not publish')
    }
  )
  updater.check = () => updater.emit('update-downloaded')
  const preparing = owner.prepare(archive, identity, async () => () => {})
  await started
  const rejected = assert.rejects(preparing, /outcome unknown/)
  updater.emit('error', new Error('native failed'))
  await rejected
  release!()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(owner.ready, false)
  assert.equal(readSquirrelHandoff(record)?.state, 'failed')
})

test('request binding rejection and timeout persist pregrant failure without granting installation', async (t) => {
  for (const timeout of [false, true]) {
    const { archive, record } = await fixture(t)
    const updater = new Updater()
    let started: () => void
    const bindingStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let release: () => void
    const owner = new InstallationFixture(
      updater,
      record,
      () => {},
      100,
      async () => {
        started!()
        if (timeout)
          await new Promise<void>((resolve) => {
            release = resolve
          })
        throw new Error('binding unavailable')
      }
    )
    updater.check = () => updater.emit('update-downloaded')
    const rejection = assert.rejects(
      owner.prepare(archive, identity, async () => () => {}),
      /binding unavailable|outcome unknown/
    )
    await bindingStarted
    await rejection
    if (timeout) release!()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(owner.committed, true)
    assert.equal(owner.ready, false)
    assert.equal(readSquirrelHandoff(record)?.state, 'failed')
    assert.equal(readSquirrelHandoff(record)?.nativeRequest, undefined)
    assert.equal(
      await inspectSquirrelStartup(readSquirrelHandoff(record)!, '/missing', 'fixture', '/missing'),
      'failed'
    )
    assert.throws(() => owner.quitAndInstall(), /not ready/)
  }
})

test('a successful binder arriving after timeout cannot restore ready or issue an install grant', async (t) => {
  const { archive, record } = await fixture(t)
  const updater = new Updater()
  let release: (value: SquirrelNativeRequest) => void
  let bound: SquirrelHandoff
  let started: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  const owner = new InstallationFixture(
    updater,
    record,
    () => {},
    100,
    async (candidate) => {
      bound = candidate
      started!()
      return new Promise<SquirrelNativeRequest>((resolve) => {
        release = resolve
      })
    }
  )
  updater.check = () => updater.emit('update-downloaded')
  const rejected = assert.rejects(
    owner.prepare(archive, identity, async () => () => {}),
    /outcome unknown/
  )
  await entered
  await rejected
  const source = {
    path: '/fixture/source',
    parent: { dev: 1, ino: 2, uid: 501 },
    item: { dev: 1, ino: 3, uid: 501 },
  }
  release!({ source, target: { ...source, path: '/fixture/target' }, binding: bound!.binding })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(readSquirrelHandoff(record)?.state, 'failed')
  assert.equal(owner.ready, false)
  assert.throws(() => owner.quitAndInstall(), /not ready/)
  assert.equal(updater.quits, 0)
})

test('feed binds the exact ZIP and candidate attempt before native handoff', async (t) => {
  const { archive, record } = await fixture(t)
  const updater = new Updater()
  let observed: SquirrelHandoff
  const owner = new InstallationFixture(
    updater,
    record,
    () => {},
    undefined,
    async (candidate) => {
      observed = candidate
      const feed = (await (await fetch(updater.url)).json()) as { name: string }
      assert.deepEqual(JSON.parse(feed.name), candidate.binding)
      assert.equal(candidate.binding?.candidate, identity.candidate)
      assert.equal(candidate.binding?.sha512, archive.sha512)
      assert.equal(candidate.binding?.size, archive.size)
      throw new Error('stop before permission')
    }
  )
  updater.check = () => updater.emit('update-downloaded')
  await assert.rejects(
    owner.prepare(archive, identity, async () => () => {}),
    /stop before permission/
  )
  const binding = observed!.binding!
  await assert.rejects(
    squirrelFeed(archive, { ...binding, sha512: '0'.repeat(128) }),
    /verified ZIP/
  )
  for (const invalid of [
    { requestId: [binding.requestId] },
    { sha512: [binding.sha512] },
    { requestId: {} },
    { schema: true },
    { size: 1.5 },
    { candidate: [] },
  ])
    assert.equal(validSquirrelBinding({ ...binding, ...invalid }), false)
  for (const state of ['requested', 'downloaded'] as const)
    assert.equal(
      await inspectSquirrelStartup({ ...observed!, state }, '/missing', 'fixture', '/missing'),
      'failed'
    )
  assert.equal(
    await inspectSquirrelStartup(
      { ...observed!, state: 'installing' },
      '/missing',
      'fixture',
      '/missing'
    ),
    'unconfirmed'
  )
})

test('native signature rejection before download completion never permits restart', async (t) => {
  const { archive, record } = await fixture(t)
  const updater = new Updater()
  const owner = new InstallationFixture(updater, record, () => {})
  updater.check = () => updater.emit('error', new Error('native signature rejected'))
  await assert.rejects(
    owner.prepare(archive, identity, async () => () => {}),
    /outcome unknown/
  )
  assert.equal(owner.ready, false)
  assert.equal(owner.committed, true)
  assert.throws(() => owner.quitAndInstall(), /not ready/)
  assert.equal(updater.quits, 0)
})

test('errors after download completion revoke readiness without releasing the handoff', async (t) => {
  for (const timing of ['during-cleanup', 'after-prepare', 'check-throws'] as const) {
    const { archive, record } = await fixture(t)
    const updater = new Updater()
    const owner = new InstallationFixture(updater, record, () => {})
    updater.check = () => {
      updater.emit('update-downloaded')
      if (timing === 'during-cleanup')
        queueMicrotask(() => updater.emit('error', new Error('late native error')))
      if (timing === 'check-throws') throw new Error('native check failed after download')
    }
    const prepared = owner.prepare(archive, identity, async () => () => {})
    if (timing === 'after-prepare') {
      await prepared
      assert.equal(owner.ready, true)
      updater.emit('error', new Error('late native error'))
    } else {
      await assert.rejects(prepared, /outcome unknown|native check failed/)
    }
    assert.equal(owner.ready, false, timing)
    assert.equal(owner.committed, true, timing)
    assert.equal(readSquirrelHandoff(record)?.state, 'failed')
    assert.throws(() => owner.quitAndInstall(), /not ready/)
    assert.equal(updater.quits, 0)
    await assert.rejects(
      owner.prepare(archive, { ...identity, candidate: 'newer' }, async () => () => {}),
      /consumed/
    )
    assert.throws(() => owner.dispose(), /consumed/)
  }
})

test('native error and timeout retain the consumed handoff; neither authorizes a quit', async (t) => {
  for (const timeout of [false, true]) {
    const { archive, record } = await fixture(t)
    const updater = new Updater()
    if (!timeout) updater.check = () => updater.emit('error', new Error('native failed'))
    const owner = new InstallationFixture(updater, record, () => {}, 20)
    await assert.rejects(
      owner.prepare(archive, identity, async () => () => {}),
      /outcome unknown/
    )
    assert.equal(owner.committed, true)
    assert.equal(readSquirrelHandoff(record)?.state, 'failed')
    await assert.rejects(
      owner.prepare(archive, { ...identity, candidate: 'replacement' }, async () => () => {}),
      /consumed/
    )
    updater.emit('update-downloaded')
    assert.equal(owner.ready, false)
    assert.throws(() => owner.quitAndInstall(), /not ready/)
    assert.throws(() => owner.dispose(), /consumed/)
  }
})

test('corrupt recovery state is not treated as no pending installation', async (t) => {
  const { record } = await fixture(t)
  assert.equal(readSquirrelHandoff(record), null)
  await writeFile(record, '{partial')
  assert.throws(() => readSquirrelHandoff(record))
  await writeFile(record, JSON.stringify({ ...identity, buildNumber: '../../escape' }))
  assert.throws(() => readSquirrelHandoff(record))
})

test('ShipIt diagnostics are bounded, deduplicated and never follow unrelated files', async (t) => {
  const { directory } = await fixture(t)
  const logs = join(directory, 'org.scholarseed.app.ShipIt')
  await mkdir(logs)
  await writeFile(join(logs, 'ShipIt_stdout.log'), 'a'.repeat(100_000))
  await writeFile(join(logs, 'ShipItState.plist'), 'private state')
  await symlink(join(logs, 'ShipItState.plist'), join(logs, 'ShipIt_stderr.log'))
  const result = await shipItDiagnostics(directory, 'org.scholarseed.app')
  assert.equal(result.length, 1)
  assert.equal(result[0].text.length, 64 * 1024)
  assert.deepEqual(await shipItDiagnostics(directory, 'org.scholarseed.app'), [])
  await writeFile(join(logs, 'Squirrel_timing.log'), '[squirrel-timing] stage=unzip event=end')
  const timing = await shipItDiagnostics(directory, 'org.scholarseed.app')
  assert.deepEqual(
    timing.map((item) => item.name),
    ['Squirrel_timing.log']
  )
  assert.match(timing[0].text, /stage=unzip/)
  await assert.rejects(shipItDiagnostics(directory, '../escape'))
})

test('native quit failure after a possible grant stays unresolved and cannot regain restart authority', async (t) => {
  const { archive, record } = await fixture(t)
  const updater = new Updater()
  updater.check = () => updater.emit('update-downloaded')
  updater.quitAndInstall = () => {
    throw new Error('quit failed')
  }
  const owner = new InstallationFixture(updater, record, () => {})
  await owner.prepare(archive, identity, async () => () => {})
  assert.throws(() => owner.quitAndInstall(), /quit failed/)
  assert.equal(owner.ready, false)
  assert.equal(owner.committed, true)
  assert.equal(readSquirrelHandoff(record)?.state, 'installing')
  assert.throws(() => owner.quitAndInstall(), /not ready/)
})

test('failure recording cannot throw out of the native error listener', async (t) => {
  const { archive, record } = await fixture(t)
  const updater = new Updater()
  updater.check = () => updater.emit('update-downloaded')
  const events: string[] = []
  const owner = new InstallationFixture(updater, record, (event) => events.push(event))
  await owner.prepare(archive, identity, async () => () => {})
  await rm(record)
  await mkdir(record)
  assert.doesNotThrow(() => updater.emit('error', new Error('native failed')))
  assert.equal(owner.ready, false)
  assert.equal(owner.committed, true)
  assert.ok(events.includes('handoff-failure-write-failed'))
})

test('terminal native failure consumes the launch context discard exactly once', () => {
  let calls = 0
  const discard = (outcome?: 'failed'): void => {
    assert.equal(outcome, 'failed')
    calls += 1
  }
  let remaining = discardOnTerminalSquirrelFailure('handoff-requested', discard)
  assert.equal(remaining, discard)
  assert.equal(calls, 0)
  remaining = discardOnTerminalSquirrelFailure(SQUIRREL_NATIVE_ERROR_EVENT, remaining)
  assert.equal(remaining, undefined)
  assert.equal(calls, 1)
  assert.equal(discardOnTerminalSquirrelFailure(SQUIRREL_NATIVE_ERROR_EVENT, remaining), undefined)
  assert.equal(calls, 1)
})

for (const outcome of [
  'success',
  'expired-once',
  'expired-twice',
  'offline',
  'cancelled',
  'native-error',
] as const) {
  test(`fresh Squirrel authorization after feed preparation: ${outcome}`, async (t) => {
    const { archive, record } = await fixture(t)
    const updater = new Updater()
    const owner = new InstallationFixture(updater, record, () => {})
    const controller = new AbortController()
    let now = 0
    let requests = 0
    let pending!: () => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      pending = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    updater.setFeedURL = ({ url }) => {
      updater.url = url
      now += 183_000 // Expensive native preparation precedes issuance.
    }
    updater.check = () => updater.emit('update-downloaded')
    const work = owner.prepare(archive, identity, async () => {
      controller.signal.throwIfAborted()
      requests++
      assert.ok(updater.url)
      assert.equal(now >= 183_000, true)
      // The pinned feed is fully prepared and readable before the network request.
      assert.equal((await fetch(updater.url)).status, 200)
      entered()
      await waiting
      if (outcome === 'offline') throw new Error('offline')
      const guard = activationCommitGuard(
        now + 60_000,
        () => now,
        () => now
      )
      if (outcome === 'expired-twice' || (outcome === 'expired-once' && requests === 1))
        now += 60_001
      return () => {
        controller.signal.throwIfAborted()
        guard()
      }
    })
    await started
    assert.equal(owner.committed, false)
    assert.equal(updater.checks, 0)
    assert.equal(readSquirrelHandoff(record), null)
    if (outcome === 'cancelled') controller.abort(new Error('cancelled'))
    if (outcome === 'native-error') updater.emit('error', new Error('native failed while waiting'))
    pending()
    if (outcome === 'success' || outcome === 'expired-once') {
      await work
      assert.equal(owner.ready, true)
      assert.equal(updater.checks, 1)
      assert.equal(requests, outcome === 'expired-once' ? 2 : 1)
    } else {
      await assert.rejects(
        work,
        outcome === 'expired-twice' ? ActivationExpired : /offline|cancelled|initialization failed/
      )
      assert.equal(owner.committed, false)
      assert.equal(updater.checks, 0)
      assert.equal(readSquirrelHandoff(record), null)
      assert.equal(requests, outcome === 'expired-twice' ? 2 : 1)
      await assert.rejects(fetch(updater.url), /fetch failed/)
      // The same verified package can be retried without a new download.
      await owner.prepare(archive, identity, async () => () => {})
      assert.equal(owner.ready, true)
    }
  })
}
