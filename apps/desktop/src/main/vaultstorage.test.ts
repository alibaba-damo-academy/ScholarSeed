import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createStorageConsumer,
  FixedStorageHelper,
  type StorageHelper,
  type StorageLaunchProjection,
} from './vaultstorage.ts'
import { VaultOwner } from './vault.ts'

const projection: StorageLaunchProjection = {
  python: 'owned-python',
  cwd: 'owned-cwd',
  env: {},
  profileId: 'a'.repeat(64),
}
const fixtureBudgets = {
  version: 1,
  headerBytes: 16 * 1024,
  payloadBytes: { vault: 16 * 1024 * 1024, downloads: 4 * 1024 * 1024 },
}
const fixtureMutations = {
  budget: () => fixtureBudgets.payloadBytes.vault,
  replace: async () => {
    throw new Error('unexpected fixture mutation')
  },
  removeConfirmed: async () => {
    throw new Error('unexpected fixture mutation')
  },
  inspect: async () => {
    throw new Error('unexpected fixture mutation')
  },
}
function targetPython(cwd: string, platform: NodeJS.Platform = process.platform): string {
  return join(
    cwd,
    '.venv',
    platform === 'win32' ? 'Scripts' : 'bin',
    platform === 'win32' ? 'python.exe' : 'python'
  )
}

async function protocolFixture(
  source: string,
  exercise: (helper: FixedStorageHelper) => Promise<void>
) {
  const cwd = fileURLToPath(new URL('../../../../', import.meta.url))
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'storage-schema-')))
  const packageDirectory = join(home, 'service', 'cli')
  mkdirSync(packageDirectory, { recursive: true })
  writeFileSync(join(home, 'service', '__init__.py'), '')
  writeFileSync(join(packageDirectory, '__init__.py'), '')
  writeFileSync(join(packageDirectory, 'dependency.py'), 'VALUE = 1\n')
  writeFileSync(
    join(packageDirectory, 'browser.py'),
    `import sys,struct,json,os,service.cli.dependency
def receive():
 size=struct.unpack('!I',sys.stdin.buffer.read(4))[0]
 return json.loads(sys.stdin.buffer.read(size))
def send(request,fields):
 header={'version':1,'requestId':request['requestId'],'payloadLength':0,**fields}
 body=json.dumps(header).encode()
 os.write(1,struct.pack('!I',len(body))+body)
request=receive()
${source}
sys.stdin.buffer.read()
`
  )
  const helper = new FixedStorageHelper({
    python: targetPython(cwd),
    cwd: home,
    env: {
      ...process.env,
      PYTHONPATH: home,
      SCHOLARSEED_HOME: home,
      PYTHONDONTWRITEBYTECODE: undefined,
    },
    profileId: 'a'.repeat(64),
  })
  try {
    await exercise(helper)
    assert.equal(existsSync(join(packageDirectory, '__pycache__')), false)
  } finally {
    helper.close()
    await helper.exited
    rmSync(home, { recursive: true, force: true })
  }
}

test('Main enum fields reject arrays, objects, numbers and null and close the malformed helper', async (context) => {
  for (const [field, valid] of Object.entries({
    code: 'busy',
    outcome: 'committed',
    durability: 'namespace-synced',
    verb: 'replace',
  })) {
    for (const value of [[valid], { value: valid }, 1, null]) {
      await context.test(`${field}:${JSON.stringify(value)}`, async () => {
        const fields =
          field === 'code'
            ? { code: value }
            : {
                operationId: 'operation',
                sequence: 1,
                verb: 'replace',
                outcome: 'committed',
                durability: 'namespace-synced',
                resultPresence: 'absent',
                result: { digest: null, identity: null },
                [field]: value,
              }
        const source =
          field === 'code'
            ? `send(request,json.loads(${JSON.stringify(JSON.stringify(fields))}))`
            : `send(request,{'sessionId':'session','profileId':request['profileId'],'budgets':json.loads(${JSON.stringify(JSON.stringify(fixtureBudgets))})})
request=receive()
send(request,json.loads(${JSON.stringify(JSON.stringify(fields))}))`
        await protocolFixture(source, async (helper) => {
          if (field !== 'code') await helper.handshake()
          await assert.rejects(
            field === 'code' ? helper.handshake() : helper.inspect('vault', 'operation', 1),
            (error) =>
              error instanceof Error && /browser_storage_(unknown|invalid)/.test(error.message)
          )
          await helper.exited
        })
      })
    }
  }
})

test('Main adopts bounded versioned owner budgets and rejects unknown, missing, malformed or oversized budgets', async (context) => {
  const invalid = [
    undefined,
    null,
    [],
    { ...fixtureBudgets, extra: 1 },
    { headerBytes: 16384, payloadBytes: fixtureBudgets.payloadBytes },
    { ...fixtureBudgets, version: [1] },
    { ...fixtureBudgets, headerBytes: [16384] },
    { ...fixtureBudgets, headerBytes: 16385 },
    { ...fixtureBudgets, payloadBytes: { vault: 1 } },
    { ...fixtureBudgets, payloadBytes: { ...fixtureBudgets.payloadBytes, other: 1 } },
    { ...fixtureBudgets, payloadBytes: { vault: 64 * 1024 * 1024 + 1, downloads: 1 } },
    { ...fixtureBudgets, payloadBytes: { vault: null, downloads: 1 } },
  ]
  for (const budgets of [fixtureBudgets, ...invalid]) {
    await context.test(JSON.stringify(budgets) ?? 'missing', async () => {
      const encoded = JSON.stringify({
        sessionId: 'session',
        profileId: 'a'.repeat(64),
        ...(budgets === undefined ? {} : { budgets }),
      })
      await protocolFixture(
        `send(request,json.loads(${JSON.stringify(encoded)}))`,
        async (helper) => {
          if (budgets === fixtureBudgets) await helper.handshake()
          else {
            await assert.rejects(helper.handshake())
            await helper.exited
          }
        }
      )
    })
  }
})

test('owner projected kind budget bounds requests instead of duplicated Main defaults', async () => {
  const budgets = { ...fixtureBudgets, payloadBytes: { vault: 1, downloads: 2 } }
  await protocolFixture(
    `send(request,{'sessionId':'session','profileId':request['profileId'],'budgets':json.loads(${JSON.stringify(JSON.stringify(budgets))})})`,
    async (helper) => {
      await helper.handshake()
      await assert.rejects(
        helper.replace(
          'vault',
          {
            bytes: Buffer.alloc(0),
            digest: null,
            token: 'token',
            operationId: 'operation',
            sequence: 1,
          },
          Buffer.alloc(2)
        ),
        /browser_storage_quota/
      )
    }
  )
})

test('malformed real helper handshake cannot publish consumer availability', async () => {
  await protocolFixture(`send(request,{'code':['busy']})`, async (helper) => {
    const handle = { storageLaunch: projection, ready: Promise.resolve(true), stopping: false }
    const publications: boolean[] = []
    const consumer = createStorageConsumer({
      enabled: true,
      current: () => true,
      ensureBackend: async () => true,
      backend: () => handle,
      createHelper: () => helper,
      publish: (value) => publications.push(value),
    })
    await consumer.activate()
    assert.equal(consumer.available(), false)
    assert.equal(publications.includes(true), false)
    await helper.exited
    consumer.close()
  })
})

test('test orchestration locates the configured target venv interpreter on both platforms', () => {
  assert.equal(targetPython('root', 'win32'), join('root', '.venv', 'Scripts', 'python.exe'))
  assert.equal(targetPython('root', 'darwin'), join('root', '.venv', 'bin', 'python'))
})

function fixture(enabled: boolean | undefined, invalidateAt?: string) {
  const calls: string[] = []
  let live = true
  const invoke = (name: string) => {
    calls.push(name)
    if (name === invalidateAt) live = false
  }
  const helper: StorageHelper = {
    ...fixtureMutations,
    exited: new Promise(() => undefined),
    handshake: async () => {
      invoke('handshake')
    },
    read: async (kind) => {
      invoke(kind)
      return {
        bytes: Buffer.alloc(0),
        digest: null,
        token: 'token',
        operationId: 'operation',
        sequence: 1,
      }
    },
    close: () => {
      invoke('close')
    },
  }
  const handle = { stopping: false, ready: Promise.resolve(true), storageLaunch: projection }
  const consumer = createStorageConsumer({
    enabled,
    current: () => live,
    ensureBackend: async () => {
      invoke('ensure')
      return true
    },
    backend: () => handle,
    createHelper: () => {
      invoke('factory')
      return helper
    },
    publish: (available) => {
      invoke(`publish:${available}`)
    },
  })
  return { consumer, calls }
}

test('off and missing guard precede every factory/backend/path/storage side effect', async () => {
  for (const enabled of [false, undefined]) {
    const { consumer, calls } = fixture(enabled)
    await consumer.activate()
    consumer.close()
    consumer.close()
    assert.deepEqual(calls, [])
    assert.equal(consumer.available(), false)
  }
})

test('on consumer checks owner after ensure, handshake, and each fixed read', async () => {
  for (const invalidateAt of ['ensure', 'handshake', 'vault', 'downloads']) {
    const { consumer, calls } = fixture(true, invalidateAt)
    await consumer.activate()
    assert.equal(consumer.available(), false)
    assert.equal(calls.includes('publish:true'), false)
    assert.equal(calls.filter((name) => name === 'close').length, invalidateAt === 'ensure' ? 0 : 1)
    if (invalidateAt === 'handshake') assert.equal(calls.includes('vault'), false)
    if (invalidateAt === 'vault') assert.equal(calls.includes('downloads'), false)
  }
})

test('on production consumer reads both fixed kinds and retains only availability', async () => {
  const { consumer, calls } = fixture(true)
  await consumer.activate()
  assert.equal(consumer.available(), true)
  assert.deepEqual(calls, ['ensure', 'factory', 'handshake', 'vault', 'downloads', 'publish:true'])
  consumer.close()
  consumer.close()
  assert.equal(calls.filter((name) => name === 'close').length, 1)
})

test('bound fixed-kind ports serialize both consumers, cap total queue at 16 and skip revoked queued requests', async () => {
  let release: () => void = () => undefined
  let blocked = false
  let calls = 0
  let concurrent = 0
  let maximum = 0
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const helper: StorageHelper = {
    ...fixtureMutations,
    exited: new Promise(() => undefined),
    handshake: async () => undefined,
    close: () => undefined,
    read: async () => {
      calls++
      concurrent++
      maximum = Math.max(maximum, concurrent)
      if (blocked) await waiting
      concurrent--
      return {
        bytes: Buffer.alloc(0),
        digest: null,
        token: 'token',
        operationId: 'operation',
        sequence: 1,
      }
    },
  }
  const backend = { storageLaunch: projection, ready: Promise.resolve(true), stopping: false }
  const consumer = createStorageConsumer({
    enabled: true,
    current: () => true,
    ensureBackend: async () => true,
    backend: () => backend,
    createHelper: () => helper,
    publish: () => undefined,
  })
  await consumer.activate()
  const vault = consumer.bind('vault')!
  const downloads = consumer.bind('downloads')!
  blocked = true
  let valid = true
  const requests = [
    vault.read(),
    downloads.read(() => valid),
    ...Array.from({ length: 14 }, () => downloads.read()),
  ]
  const settled = Promise.allSettled(requests)
  await assert.rejects(vault.read(), /busy/)
  valid = false
  release()
  const results = await settled
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 15)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  assert.equal(calls, 17)
  assert.equal(maximum, 1)
  consumer.revoke()
  assert.equal(vault.current(), false)
  await assert.rejects(downloads.read(), /unavailable/)
  consumer.close()
})

test('ready false and attach without trusted projection do not create helpers', async () => {
  for (const [storageLaunch, ready] of [
    [null, true],
    [projection, false],
  ] as const) {
    const handle = { storageLaunch, ready: Promise.resolve(ready), stopping: false }
    let factories = 0
    const consumer = createStorageConsumer({
      enabled: true,
      current: () => true,
      ensureBackend: async () => true,
      backend: () => handle,
      createHelper: () => {
        factories++
        throw new Error('unexpected factory')
      },
      publish: () => undefined,
    })
    await consumer.activate()
    assert.equal(factories, 0)
    assert.equal(consumer.available(), false)
  }
})

test('backend replacement during ready await prevents factory construction', async () => {
  let resolveReady: (value: boolean) => void = () => undefined
  const handle = {
    storageLaunch: projection,
    ready: new Promise<boolean>((resolve) => {
      resolveReady = resolve
    }),
    stopping: false,
  }
  let backend = handle
  let factories = 0
  const consumer = createStorageConsumer({
    enabled: true,
    current: () => true,
    ensureBackend: async () => true,
    backend: () => backend,
    createHelper: () => {
      factories++
      throw new Error('unexpected')
    },
    publish: () => undefined,
  })
  const activating = consumer.activate()
  await Promise.resolve()
  backend = { ...handle, ready: Promise.resolve(true) }
  resolveReady(true)
  await activating
  assert.equal(factories, 0)
})

test('revoke during each helper await closes exactly once and late results cannot publish', async () => {
  for (const stage of ['handshake', 'vault', 'downloads']) {
    let release: () => void = () => undefined
    let started: () => void = () => undefined
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const reached = new Promise<void>((resolve) => {
      started = resolve
    })
    let closes = 0
    const publications: boolean[] = []
    const checkpoint = async (name: string) => {
      if (name === stage) {
        started()
        await waiting
      }
    }
    const handle = { storageLaunch: projection, ready: Promise.resolve(true), stopping: false }
    const helper: StorageHelper = {
      ...fixtureMutations,
      exited: new Promise(() => undefined),
      handshake: () => checkpoint('handshake'),
      read: async (kind) => {
        await checkpoint(kind)
        return {
          bytes: Buffer.alloc(0),
          digest: null,
          token: 'token',
          operationId: 'operation',
          sequence: 1,
        }
      },
      close: () => {
        closes++
      },
    }
    const consumer = createStorageConsumer({
      enabled: true,
      current: () => true,
      ensureBackend: async () => true,
      backend: () => handle,
      createHelper: () => helper,
      publish: (available) => publications.push(available),
    })
    const activating = consumer.activate()
    await reached
    consumer.revoke()
    release()
    await activating
    consumer.close()
    assert.equal(closes, 1)
    assert.equal(consumer.available(), false)
    assert.deepEqual(publications, [])
  }
})

test('unexpected helper exit retires live consumer availability', async () => {
  let exit: () => void = () => undefined
  const exited = new Promise<void>((resolve) => {
    exit = resolve
  })
  const handle = { storageLaunch: projection, ready: Promise.resolve(true), stopping: false }
  const helper: StorageHelper = {
    ...fixtureMutations,
    exited,
    handshake: async () => undefined,
    read: async () => ({
      bytes: Buffer.alloc(0),
      digest: null,
      token: 'token',
      operationId: 'operation',
      sequence: 1,
    }),
    close: () => undefined,
  }
  const publications: boolean[] = []
  const consumer = createStorageConsumer({
    enabled: true,
    current: () => true,
    ensureBackend: async () => true,
    backend: () => handle,
    createHelper: () => helper,
    publish: (available) => publications.push(available),
  })
  await consumer.activate()
  assert.equal(consumer.available(), true)
  exit()
  await Promise.resolve()
  assert.equal(consumer.available(), false)
  assert.deepEqual(publications, [true, false])
})

test('real Main transport uses exact Python/Home and cooperates with second helper CAS', async () => {
  const cwd = fileURLToPath(new URL('../../../../', import.meta.url))
  const container = realpathSync(mkdtempSync(join(tmpdir(), 'fixed-browser-store-')))
  const home = join(container, 'home')
  const preparation = spawnSync(
    targetPython(cwd),
    [
      '-c',
      `import os,sys
from pathlib import Path
from service.platform import storage
parent=Path(sys.argv[1])
if os.name=='nt':
 directory=storage.open_directory(parent,())
 try:
  handle=storage.windows.open_relative(directory.native_handles[-1],'home',directory=True,disposition=storage.windows.CREATE,access=storage.windows.READ|storage.windows.WRITE|storage.windows.READ_CONTROL|storage.windows.SYNCHRONIZE,share=storage.windows.SHARE_READ|storage.windows.SHARE_WRITE)
  storage.windows.close(handle)
 finally: directory.close()
else: (parent/'home').mkdir(mode=0o700)
`,
      container,
    ],
    { cwd, env: { ...process.env, PYTHONPATH: join(cwd, 'apps', 'serve') }, timeout: 10_000 }
  )
  if (preparation.status !== 0) {
    rmSync(container, { recursive: true, force: true })
    throw new Error(
      `isolated private Home preparation failed: ${preparation.error ?? preparation.stderr.toString()}`
    )
  }
  const launch = {
    python: targetPython(cwd),
    cwd,
    env: { ...process.env, SCHOLARSEED_HOME: home, PYTHONPATH: join(cwd, 'apps', 'serve') },
    profileId: createHash('sha256').update(home).digest('hex'),
  }
  const first = new FixedStorageHelper(launch)
  const second = new FixedStorageHelper(launch)
  let consumer: ReturnType<typeof createStorageConsumer> | null = null
  const vault = new VaultOwner({ current: () => true, debug: () => null, publish: () => undefined })
  try {
    await first.handshake()
    await second.handshake()
    const before = await first.read('vault')
    const concurrent = await second.read('vault')
    assert.equal(before.digest, null)
    assert.equal(concurrent.digest, null)
    const body = Buffer.from([0, 10, 13, 255])
    const results = await Promise.allSettled([
      first.replace('vault', before, body),
      second.replace('vault', concurrent, body),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejection = results.find((result) => result.status === 'rejected')
    assert.ok(rejection?.status === 'rejected' && /conflict|busy/.test(String(rejection.reason)))
    const observed = await second.read('vault')
    assert.deepEqual(observed.bytes, body)
    assert.equal((await second.removeConfirmed('vault', observed)).outcome, 'committed')
    const winner = results.find((result) => result.status === 'fulfilled')
    assert.ok(winner?.status === 'fulfilled')
    assert.equal(
      (await first.inspect('vault', winner.value.operationId, winner.value.sequence)).outcome,
      'committed'
    )
    assert.equal((await first.read('vault')).digest, null)
    const backend = { storageLaunch: launch, ready: Promise.resolve(true), stopping: false }
    consumer = createStorageConsumer({
      enabled: true,
      current: () => true,
      ensureBackend: async () => true,
      backend: () => backend,
      createHelper: (projection) => new FixedStorageHelper(projection),
      publish: (available) => {
        if (!available) void vault.bindStore(null)
      },
    })
    await consumer.activate()
    const port = consumer.bind('vault')
    assert.ok(port)
    assert.equal(port.kind, 'vault')
    assert.equal(port.budget, fixtureBudgets.payloadBytes.vault)
    await vault.bindStore(port)
    const password = 'actual fixed store master 123'
    assert.equal(
      (await vault.submit(await vault.begin('create', () => true), password, password, () => true))
        .ok,
      true
    )
    const encrypted = await second.read('vault')
    assert.equal(encrypted.bytes.subarray(0, 8).toString(), 'SSVLTBIN')
    assert.equal(encrypted.bytes.includes(Buffer.from(password)), false)
    vault.lock()
    assert.equal(
      (await vault.submit(await vault.begin('unlock', () => true), password, undefined, () => true))
        .ok,
      true
    )
    const old = await port.read()
    const foreign = await second.read('vault')
    await second.replace('vault', foreign, Buffer.from('concurrent opaque winner'))
    await assert.rejects(port.replace(old, Buffer.from('must not overwrite')), /conflict/)
    assert.equal((await second.read('vault')).bytes.toString(), 'concurrent opaque winner')
    consumer.revoke()
    assert.equal(port.current(), false)
    assert.equal(vault.listMetadata(), null)
    await assert.rejects(port.read(), /unavailable/)
    assert.deepEqual(readdirSync(home), ['service'])
  } finally {
    vault.dispose()
    consumer?.close()
    first.close()
    second.close()
    await Promise.all([first.exited, second.exited])
    rmSync(container, { recursive: true, force: true })
  }
})

test(
  'Main transport accepts fragmented frames and closes unsolicited, oversized, exit and deadline helpers',
  { timeout: 40000 },
  async () => {
    const cwd = fileURLToPath(new URL('../../../../', import.meta.url))
    for (const scenario of ['fragmented', 'unsolicited', 'oversized', 'exit', 'deadline']) {
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'storage-lifecycle-')))
      const packageDirectory = join(home, 'service', 'cli')
      mkdirSync(packageDirectory, { recursive: true })
      writeFileSync(join(home, 'service', '__init__.py'), '')
      writeFileSync(join(packageDirectory, '__init__.py'), '')
      writeFileSync(
        join(packageDirectory, 'browser.py'),
        `import sys,struct,json,os,time
size=struct.unpack('!I',sys.stdin.buffer.read(4))[0]
request=json.loads(sys.stdin.buffer.read(size))
scenario=${JSON.stringify(scenario)}
if scenario=='exit': sys.exit(0)
if scenario=='deadline':
 time.sleep(35)
else:
 header={'version':1,'requestId':request['requestId'],'payloadLength':0,'sessionId':'session','profileId':request['profileId'],'budgets':json.loads(${JSON.stringify(JSON.stringify(fixtureBudgets))})}
 body=json.dumps(header).encode()
 frame=struct.pack('!I',len(body))+body
 if scenario=='oversized': frame=struct.pack('!I',16385)
 if scenario=='fragmented':
  for byte in frame:
   os.write(1,bytes([byte]))
   time.sleep(0.001)
 else: os.write(1,frame)
 if scenario=='unsolicited':
  time.sleep(0.1)
  os.write(1,frame)
 sys.stdin.buffer.read()
`
      )
      const helper = new FixedStorageHelper({
        python: targetPython(cwd),
        cwd: home,
        env: { ...process.env, PYTHONPATH: home, SCHOLARSEED_HOME: home },
        profileId: 'a'.repeat(64),
      })
      try {
        if (scenario === 'fragmented') await helper.handshake()
        else if (scenario === 'unsolicited') {
          await helper.handshake()
          await helper.exited
        } else await assert.rejects(helper.handshake())
      } finally {
        helper.close()
        await helper.exited
        rmSync(home, { recursive: true, force: true })
      }
    }
  }
)

test(
  'Main strict binary reader rejects malformed helper response without hanging or leaking stderr',
  { timeout: 5000 },
  async () => {
    const cwd = fileURLToPath(new URL('../../../../', import.meta.url))
    for (const scenario of ['duplicate', 'extra', 'utf8', 'payload', 'trailing', 'unknowncode']) {
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'storage-frame-')))
      const packageDirectory = join(home, 'service', 'cli')
      mkdirSync(packageDirectory, { recursive: true })
      writeFileSync(join(home, 'service', '__init__.py'), '')
      writeFileSync(join(packageDirectory, '__init__.py'), '')
      writeFileSync(
        join(packageDirectory, 'browser.py'),
        `import sys,struct,json,os
size=struct.unpack('!I',sys.stdin.buffer.read(4))[0]
request=json.loads(sys.stdin.buffer.read(size))
header={'version':1,'requestId':request['requestId'],'payloadLength':0,'sessionId':'session','profileId':request['profileId'],'budgets':json.loads(${JSON.stringify(JSON.stringify(fixtureBudgets))})}
scenario=${JSON.stringify(scenario)}
if scenario=='extra': header['path']='/not-allowed'
if scenario=='payload': header['payloadLength']=1
if scenario=='unknowncode': header={'version':1,'requestId':request['requestId'],'payloadLength':0,'code':'not-real'}
body=json.dumps(header).encode()
if scenario=='duplicate': body=body[:-1]+b',"version":1}'
if scenario=='utf8': body=b'\\xff'
os.write(2,b'secret-never-log')
os.write(1,struct.pack('!I',len(body))+body+(b'x' if scenario=='trailing' else b''))
sys.stdin.buffer.read()
`
      )
      const helper = new FixedStorageHelper({
        python: targetPython(cwd),
        cwd: home,
        env: { ...process.env, PYTHONPATH: home, SCHOLARSEED_HOME: home },
        profileId: 'a'.repeat(64),
      })
      try {
        await assert.rejects(
          helper.handshake(),
          (error) => error instanceof Error && !error.message.includes('secret-never-log')
        )
      } finally {
        helper.close()
        await helper.exited
        rmSync(home, { recursive: true, force: true })
      }
    }
  }
)

test('consumer drain joins retired helpers, active requests and activation before allowing reuse', async () => {
  let finishEnsure!: () => void
  let finishRead!: () => void
  const ensure = new Promise<void>((resolve) => {
    finishEnsure = resolve
  })
  const read = new Promise<void>((resolve) => {
    finishRead = resolve
  })
  const endings: Array<() => void> = []
  let blockEnsure = false
  let blockRead = false
  let helpers = 0
  const backend = { ready: Promise.resolve(true), stopping: false, storageLaunch: projection }
  const consumer = createStorageConsumer({
    enabled: true,
    current: () => true,
    ensureBackend: async () => {
      if (blockEnsure) await ensure
      return true
    },
    backend: () => backend,
    createHelper: () => {
      helpers++
      const exited = new Promise<void>((resolve) => {
        endings.push(resolve)
      })
      return {
        ...fixtureMutations,
        exited,
        close: () => undefined,
        handshake: async () => undefined,
        read: async () => {
          if (blockRead) await read
          return {
            bytes: Buffer.alloc(0),
            digest: null,
            token: 'token',
            operationId: 'operation',
            sequence: 1,
          }
        },
      }
    },
    publish: () => undefined,
  })
  await consumer.activate()
  await consumer.activate() // The first helper has retired but has not exited.
  const port = consumer.bind('vault')!
  blockRead = true
  const request = port.read()
  const rejected = assert.rejects(request, /browser_storage_unavailable/)
  await new Promise<void>((resolve) => setImmediate(resolve))
  blockEnsure = true
  const activation = consumer.activate()
  let drained = false
  const drain = consumer.drain().then(() => {
    drained = true
  })
  await consumer.activate()
  assert.equal(helpers, 2)
  endings.forEach((finish) => finish())
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(drained, false, 'helper exit alone does not finish request or startup')
  finishRead()
  await rejected
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(drained, false, 'startup remains owned until ensureBackend settles')
  finishEnsure()
  await activation
  await drain
  assert.equal(helpers, 2, 'revoked startup must not create a late helper')
  consumer.close()
  await consumer.drain()
})
