const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawn, execFileSync } = require('node:child_process')
const { createInterface } = require('node:readline')
const { once } = require('node:events')
const crypto = require('node:crypto')
const asar = require('@electron/asar')
const { verifyAsarClosure } = require('../scripts/cd/closure.cjs')
const policy = require('./toolchain.json')
const { LIBRARIES, BUNDLED_LIBRARIES } = require('./libraries.cjs')
const { beginDomains, createDirectory, ensureDirectories } = require('./domains.cjs')
const texlive = require('../runtime/texlive.cjs')

const library = process.env.SCHOLARSEED_LEASE_LIBRARY
const electron = process.env.SCHOLARSEED_LEASE_ELECTRON
if (!library || !path.isAbsolute(library) || !electron || !path.isAbsolute(electron)) {
  throw new Error(
    'select actual compiled library and Electron through SCHOLARSEED_LEASE_LIBRARY/ELECTRON'
  )
}
const api = require(library)
const holder = path.join(__dirname, 'holder.cjs')
const PROCESS_TIMEOUT = 20000
assert.equal(process.versions.node, policy.node, 'run native contracts with the reviewed Node')

test(
  'Windows maintenance independently rebinds the real server without reopening startup',
  { skip: process.platform !== 'win32', timeout: PROCESS_TIMEOUT },
  async (t) => {
    const pipe = '\\\\.\\pipe\\scholarseed-updater-' + crypto.randomBytes(32).toString('hex')
    let connections = 0
    const server = net.createServer((socket) => {
      connections++
      t.after(() => socket.destroy())
      socket.on('error', () => {})
      socket.end(JSON.stringify({ connection: connections }) + '\n')
    })
    server.listen(pipe)
    await once(server, 'listening')
    t.after(() => server.close())
    const script = `const api=require(process.argv[1]);
      setImmediate(()=>{try {
        const first=api.maintenanceSession(process.argv[2],process.ppid);
        const startup=api.startupSession(process.argv[2],process.ppid);
        const retry=api.maintenanceSession(process.argv[2],process.ppid);
        let startupError;try{api.startupSession(process.argv[2],process.ppid)}catch(e){startupError=e.code}
        console.log(JSON.stringify({frames:[first,startup,retry].map(r=>JSON.parse(r.bytes)),
          owners:[first.ownerCreated,startup.ownerCreated,retry.ownerCreated],
          leaders:[first.leaderCreated,startup.leaderCreated,retry.leaderCreated],startupError}));
      }catch(e){console.error(e.code,e.systemCode);process.exitCode=1}})`
    const child = spawn(process.execPath, ['-e', script, library, pipe], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let output = '', errors = ''
    child.stdout.on('data', bytes => { output += bytes })
    child.stderr.on('data', bytes => { errors += bytes })
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, errors)
    const observed = JSON.parse(output)
    assert.deepEqual(observed.frames, [{ connection: 1 }, { connection: 2 }, { connection: 3 }])
    assert.equal(observed.startupError, 'ERR_LEASE_CLOSED')
    assert.equal(new Set(observed.owners).size, 1)
    assert.equal(new Set(observed.leaders).size, 1)
    assert.match(observed.owners[0], /^windows-[a-f0-9]{16}$/)
    assert.match(observed.leaders[0], /^windows-[a-f0-9]{16}$/)
  }
)

test(
  'Windows maintenance rejects the wrong server PID and can retry the verified server',
  { skip: process.platform !== 'win32', timeout: PROCESS_TIMEOUT },
  async (t) => {
    const pipe = '\\\\.\\pipe\\scholarseed-updater-' + crypto.randomBytes(32).toString('hex')
    const server = net.createServer((socket) => {
      t.after(() => socket.destroy())
      socket.on('error', () => {})
      socket.end('{}\n')
    })
    server.listen(pipe)
    await once(server, 'listening')
    t.after(() => server.close())
    const script = `const api=require(process.argv[1]);let refused;
      try{api.maintenanceSession(process.argv[2],process.pid)}catch(e){refused={code:e.code,systemCode:e.systemCode}}
      try{const r=api.maintenanceSession(process.argv[2],process.ppid);console.log(JSON.stringify({refused,frame:r.bytes.toString()}))}
      catch(e){console.error(e.code,e.systemCode);process.exitCode=1}`
    const child = spawn(process.execPath, ['-e', script, library, pipe], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let output = '', errors = ''
    child.stdout.on('data', bytes => { output += bytes })
    child.stderr.on('data', bytes => { errors += bytes })
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, errors)
    assert.deepEqual(JSON.parse(output), { refused: { code: 'ERR_LEASE_MAINTENANCE', systemCode: 5 }, frame: '{}\n' })
  }
)

test('maintenance session remains unavailable on macOS', { skip: process.platform === 'win32' }, () => {
  assert.throws(() => api.maintenanceSession('unused', process.pid), { code: 'ERR_LEASE_PLATFORM' })
})

test(
  'Windows startup reads the actual parent pipe before the child event loop runs',
  {
    skip: process.platform !== 'win32',
    timeout: PROCESS_TIMEOUT,
  },
  async (t) => {
    const pipe = '\\\\.\\pipe\\scholarseed-updater-' + crypto.randomBytes(32).toString('hex')
    const frame = JSON.stringify({ startup: 'native parent', unicode: '书深' }) + '\n'
    const server = net.createServer((socket) => {
      t.after(() => socket.destroy())
      socket.on('error', () => {})
      socket.write(frame.slice(0, 7))
      setTimeout(() => socket.write(frame.slice(7)), 20)
    })
    server.listen(pipe)
    await once(server, 'listening')
    t.after(() => server.close())
    const script = `const api=require(process.argv[1]);let timer=false;setTimeout(()=>timer=true,0);
    try {const r=api.startupSession(process.argv[2],process.ppid);let second;
      try{api.startupSession(process.argv[2],process.ppid)}catch(e){second=e.code}
      console.log(JSON.stringify({frame:r.bytes.toString('utf8'),owner:r.ownerCreated,leader:r.leaderCreated,timer,second}));
    }catch(e){console.error(e.code,e.systemCode);process.exitCode=1}`
    const child = spawn(process.execPath, ['-e', script, library, pipe], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    t.after(() => {
      if (child.exitCode === null) child.kill()
    })
    let output = '',
      errors = ''
    child.stdout.on('data', (bytes) => {
      output += bytes
    })
    child.stderr.on('data', (bytes) => {
      errors += bytes
    })
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, errors)
    const received = JSON.parse(output)
    assert.equal(received.frame, frame)
    assert.equal(received.timer, false)
    assert.equal(received.second, 'ERR_LEASE_CLOSED')
    assert.match(received.owner, /^windows-[a-f0-9]{16}$/)
    assert.match(received.leader, /^windows-[a-f0-9]{16}$/)
  }
)

test(
  'Windows startup refuses a live server with another expected parent identity',
  {
    skip: process.platform !== 'win32',
    timeout: PROCESS_TIMEOUT,
  },
  async (t) => {
    const pipe = '\\\\.\\pipe\\scholarseed-updater-' + crypto.randomBytes(32).toString('hex')
    const server = net.createServer((socket) => {
      t.after(() => socket.destroy())
      socket.on('error', () => {})
      socket.write('{}\n')
    })
    server.listen(pipe)
    await once(server, 'listening')
    t.after(() => server.close())
    const script = `try{require(process.argv[1]).startupSession(process.argv[2],process.pid);process.exitCode=2}
    catch(e){console.log(JSON.stringify({code:e.code,systemCode:e.systemCode}))}`
    const child = spawn(process.execPath, ['-e', script, library, pipe], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    t.after(() => {
      if (child.exitCode === null) child.kill()
    })
    let output = ''
    child.stdout.on('data', (bytes) => {
      output += bytes
    })
    const [code] = await once(child, 'exit')
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(output), { code: 'ERR_LEASE_STARTUP', systemCode: 5 })
  }
)

function directory(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-lease-')))
  t.after(() => fs.rmSync(root, { recursive: true }))
  return root
}

async function start(t, host, filename, mode, root, selectedLibrary = library) {
  const child = spawn(
    host,
    [
      // Electron creates this root before JS; setPath in the holder is too late for isolation.
      ...(host === electron ? [`--user-data-dir=${path.join(root, 'profile')}`] : []),
      ...(mode === 'gc' ? ['--expose-gc'] : []),
      holder,
      selectedLibrary,
      filename,
      mode,
    ],
    {
      env: { ...process.env, SCHOLARSEED_LEASE_PROFILE: path.join(root, 'profile') },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  )
  let stderr = ''
  child.stderr.on('data', (bytes) => {
    stderr = (stderr + bytes).slice(-8192)
  })
  const ended = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await ended
  })
  const lines = createInterface({ input: child.stdout })
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), PROCESS_TIMEOUT)
  let frame
  try {
    while (!frame) {
      const outcome = await Promise.race([
        once(lines, 'line', { signal: controller.signal }),
        ended.then((result) => {
          throw new Error(`holder ended: ${JSON.stringify(result)} ${stderr}`)
        }),
      ])
      if (outcome[0].trim()) frame = JSON.parse(outcome[0])
    }
  } finally {
    clearTimeout(deadline)
    lines.close()
  }
  assert.ok(frame.port > 0)
  assert.equal(typeof frame.token, 'string')
  return {
    versions: frame.versions,
    contents: frame.contents,
    async stop(kill = false) {
      if (kill) child.kill('SIGKILL')
      else {
        const socket = net.connect(frame.port, '127.0.0.1')
        socket.setTimeout(PROCESS_TIMEOUT, () => socket.destroy(new Error('holder close timeout')))
        socket.on('data', () => {})
        const closed = once(socket, 'close')
        socket.end(frame.token)
        await closed
      }
      let timer
      const result = await Promise.race([
        ended,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('holder did not exit')), PROCESS_TIMEOUT)
        }),
      ]).finally(() => clearTimeout(timer))
      if (!kill) assert.equal(result.code, 0, stderr)
    },
  }
}

test('native lock rejects invalid arguments, special leaves and hardlinks', (t) => {
  const root = directory(t)
  const filename = path.join(root, 'lock')
  for (const args of [
    [],
    [filename],
    ['relative.lock', false],
    [filename + '\0suffix', false],
    [filename, 'shared'],
    [filename, false, true],
  ]) {
    assert.throws(() => api.acquire(...args), { code: 'ERR_LEASE_ARGUMENT' })
  }
  assert.throws(
    () => api.acquire(root, false),
    (error) => error.code !== 'ERR_LEASE_BUSY'
  )
  assert.throws(() => api.acquire(path.join(root, 'missing', 'lock'), false), {
    code: 'ERR_LEASE_NATIVE',
  })
  fs.writeFileSync(filename, 'keep')
  const link = path.join(root, 'alias')
  fs.linkSync(filename, link)
  assert.throws(() => api.acquire(link, false), { code: 'ERR_LEASE_FILE' })
  assert.equal(fs.readFileSync(filename, 'utf8'), 'keep')
  fs.unlinkSync(link)
  const lease = api.acquire(filename, false)
  api.release(lease)
  assert.throws(() => api.release(lease), { code: 'ERR_LEASE_CLOSED' })
  assert.throws(() => api.release({}), { code: 'ERR_LEASE_ARGUMENT' })
})

test('symlink leaf cannot redirect a native lease', (t) => {
  const root = directory(t)
  const filename = path.join(root, 'target')
  const link = path.join(root, 'link')
  fs.writeFileSync(filename, 'keep')
  try {
    fs.symlinkSync(filename, link, 'file')
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM')
      return t.skip('host denies symbolic-link creation')
    throw error
  }
  assert.throws(() => api.acquire(link, false), { code: 'ERR_LEASE_FILE' })
  assert.equal(fs.readFileSync(filename, 'utf8'), 'keep')
})

for (const [name, host] of [
  ['Node', process.execPath],
  ['Electron', electron],
]) {
  for (const mode of [
    'shared',
    'exclusive',
    'environment',
    'directory',
    'directory-exclusive',
    'directory-environment',
  ]) {
    test(`${name} ${mode}: real process owns lock until close/death`, async (t) => {
      const root = directory(t)
      const filename = path.join(root, 'lock')
      const processOwner = await start(t, host, filename, mode, root)
      t.diagnostic(JSON.stringify(processOwner.versions))
      if (name === 'Electron') assert.equal(processOwner.versions.electron, policy.electron)
      else assert.equal(processOwner.versions.node, policy.node)
      if (!mode.endsWith('exclusive')) api.release(api.acquire(filename, false))
      else assert.throws(() => api.acquire(filename, false), { code: 'ERR_LEASE_BUSY' })
      assert.throws(() => api.acquire(filename, true), { code: 'ERR_LEASE_BUSY' })
      await processOwner.stop(mode.endsWith('environment'))
      api.release(api.acquire(filename, true))
    })
  }
}

test('GC does not release an orphaned live lease', async (t) => {
  const root = directory(t)
  const filename = path.join(root, 'lock')
  const processOwner = await start(t, process.execPath, filename, 'gc', root)
  assert.throws(() => api.acquire(filename, true), { code: 'ERR_LEASE_BUSY' })
  await processOwner.stop()
  api.release(api.acquire(filename, true))
})

test('directory identity and child lease lifetime are tied to opaque handles', (t) => {
  const root = directory(t)
  const first = api.pin(root, false)
  const second = api.pin(root, false)
  assert.match(api.identity(first), /^(posix|windows):[0-9a-f]{16}:[0-9a-f]{16,32}$/)
  assert.equal(api.identity(first), api.identity(second))
  for (const name of ['../escape', '.', '', 'a/b', 'x:stream', 'nul\0suffix', 'trailing.']) {
    assert.throws(() => api.acquireAt(first, name, false), { code: 'ERR_LEASE_ARGUMENT' })
  }
  const shared = api.acquireAt(first, 'occupancy', false)
  assert.throws(() => api.release(first), { code: 'ERR_LEASE_IN_USE' })
  assert.throws(() => api.acquireAt(second, 'occupancy', true), { code: 'ERR_LEASE_BUSY' })
  assert.throws(() => api.identity(shared), { code: 'ERR_LEASE_ARGUMENT' })
  api.release(shared)
  const exclusive = api.acquireAt(second, 'occupancy', true)
  api.release(exclusive)
  api.release(first)
  api.release(second)
  assert.throws(() => api.identity(first), { code: 'ERR_LEASE_CLOSED' })
  assert.throws(() => api.acquireAt(first, 'occupancy', false), { code: 'ERR_LEASE_CLOSED' })
})

test('directory creation is confined to the last component and rejects aliases', (t) => {
  const root = directory(t)
  const child = path.join(root, 'child')
  const pin = api.pin(child, true)
  api.release(pin)
  assert.ok(fs.statSync(child).isDirectory())
  assert.throws(() => api.pin(path.join(root, 'missing', 'nested'), true))
  assert.equal(fs.existsSync(path.join(root, 'missing')), false)
  const alias = path.join(root, 'alias')
  fs.symlinkSync(child, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => api.pin(alias, false))
  fs.mkdirSync(path.join(child, 'inside'))
  assert.throws(() => api.pin(path.join(alias, 'inside'), false))
  assert.throws(() => api.pin(root + '\0suffix', false), { code: 'ERR_LEASE_ARGUMENT' })
  assert.throws(() => api.pin(root, false, true), { code: 'ERR_LEASE_ARGUMENT' })
})

test('installation pins are existing-only and Windows-only', (t) => {
  const root = directory(t)
  const missing = path.join(root, 'missing')
  assert.throws(() => api.pin(missing, true, 'installation'), { code: 'ERR_LEASE_ARGUMENT' })
  assert.equal(fs.existsSync(missing), false)
  if (process.platform !== 'win32') {
    assert.throws(() => api.pin(root, false, 'installation'), { code: 'ERR_LEASE_ARGUMENT' })
    const parent = api.pin(root, false)
    assert.throws(() => api.pinChild(parent, 'missing'), { code: 'ERR_LEASE_UNSUPPORTED' })
    api.release(parent)
  } else {
    const installation = path.join(root, 'installation')
    const created = api.pin(installation, true)
    api.release(created)
    const parent = api.pin(installation, false, 'installation')
    assert.throws(() => api.pinChild(parent, 'missing'))
    assert.equal(fs.existsSync(missing), false)
    api.release(parent)
  }
})

test('Windows installation child capabilities retain strict roots and parent lifetimes',
  { skip: process.platform !== 'win32' }, (t) => {
    const root = directory(t)
    const ancestor = path.join(root, 'shared')
    const original = api.pin(ancestor, true)
    api.createChild(original, 'installation')
    api.release(original)
    const installation = path.join(ancestor, 'installation')
    execFileSync('C:/Windows/System32/icacls.exe', [ancestor, '/grant', '*S-1-1-0:(M)'])
    const data = api.pin(installation, false)
    api.release(data)
    const parent = api.pin(installation, false, 'installation')
    api.createChild(parent, 'runtime')
    const runtime = api.pinChild(parent, 'runtime')
    assert.deepEqual(api.lineage(runtime).slice(0, -1), api.lineage(parent))
    assert.throws(() => api.release(parent), { code: 'ERR_LEASE_IN_USE' })
    api.createChild(runtime, '.archives')
    const archives = api.pinChild(runtime, '.archives')
    assert.throws(() => api.release(runtime), { code: 'ERR_LEASE_IN_USE' })
    assert.throws(() => fs.renameSync(installation, installation + '-moved'))
    for (const name of ['', '.', '..', '../escape', 'a/b', 'a\\b', 'a:stream', 'trailing.', 'trailing '])
      assert.throws(() => api.pinChild(runtime, name), { code: 'ERR_LEASE_ARGUMENT' })
    const alias = path.join(installation, 'alias')
    fs.symlinkSync(path.join(installation, 'runtime'), alias, 'junction')
    assert.throws(() => api.pinChild(parent, 'alias'))
    api.release(archives)
    const runtimePath = path.join(installation, 'runtime')
    execFileSync('C:/Windows/System32/icacls.exe', [runtimePath, '/grant', '*S-1-1-0:(M)'])
    assert.throws(() => api.listAt(runtime, 16, 4096), { code: 'ERR_LEASE_PERMISSION' })
    api.release(runtime)
    assert.throws(() => api.pinChild(runtime, '.archives'), { code: 'ERR_LEASE_CLOSED' })
    assert.throws(() => api.pinChild(parent, 'runtime'), { code: 'ERR_LEASE_PERMISSION' })
    assert.throws(() => api.createChild(parent, 'runtime'), { code: 'ERR_LEASE_PERMISSION' })
    execFileSync('C:/Windows/System32/icacls.exe', [installation, '/grant', '*S-1-1-0:(M)'])
    assert.throws(() => api.listAt(parent, 16, 4096), { code: 'ERR_LEASE_PERMISSION' })
    api.release(parent)
    assert.throws(() => api.pinChild(parent, 'runtime'), { code: 'ERR_LEASE_CLOSED' })
    assert.throws(() => api.pin(installation, false, 'installation'), { code: 'ERR_LEASE_PERMISSION' })
    const project = api.pin(installation, false, 'project')
    assert.throws(() => api.pinChild(project, 'runtime'), { code: 'ERR_LEASE_ARGUMENT' })
    api.release(project)
  })

test('directory pins enforce platform rename semantics without redirecting relative IO', (t) => {
  const root = directory(t)
  const original = path.join(root, 'original')
  const moved = path.join(root, 'moved')
  fs.mkdirSync(original)
  const nested = path.join(original, 'nested')
  fs.mkdirSync(nested)
  const pin = api.pin(nested, false)
  const identity = api.identity(pin)
  if (process.platform === 'win32') {
    assert.throws(() => fs.renameSync(original, moved))
    api.release(pin)
    fs.renameSync(original, moved)
  } else {
    fs.renameSync(original, moved)
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(nested, 'occupancy'), 'replacement must survive')
    const lease = api.acquireAt(pin, 'occupancy', true)
    assert.equal(api.identity(pin), identity)
    assert.equal(
      fs.readFileSync(path.join(nested, 'occupancy'), 'utf8'),
      'replacement must survive'
    )
    assert.ok(fs.existsSync(path.join(moved, 'nested', 'occupancy')))
    api.release(lease)
    api.release(pin)
  }
})

test('relative lease open follows a renamed leaf pin instead of its replaced path', (t) => {
  const root = directory(t)
  const original = path.join(root, 'original')
  const moved = path.join(root, 'moved')
  fs.mkdirSync(original)
  const pin = api.pin(original, false)
  let lease
  try {
    fs.renameSync(original, moved)
    fs.mkdirSync(original)
    lease = api.acquireAt(pin, 'occupancy', true)
    assert.equal(fs.existsSync(path.join(original, 'occupancy')), false)
    assert.equal(fs.existsSync(path.join(moved, 'occupancy')), true)
    assert.throws(() => api.acquire(path.join(moved, 'occupancy'), true), {
      code: 'ERR_LEASE_BUSY',
    })
    const replacement = api.acquire(path.join(original, 'occupancy'), true)
    api.release(replacement)
  } finally {
    if (lease) api.release(lease)
    api.release(pin)
  }
})

for (const [name, host] of [
  ['Node', process.execPath],
  ['Electron', electron],
]) {
  test(`${name} keeps an existing relative lock on the renamed directory`, async (t) => {
    const root = directory(t)
    const original = path.join(root, 'original')
    fs.mkdirSync(original)
    fs.writeFileSync(path.join(original, 'occupancy'), 'permanent coordination file')
    const owner = await start(t, host, original, 'relative-replaced', root)
    const movedLock = path.join(original + '-moved', 'occupancy')
    assert.equal(fs.existsSync(path.join(original, 'occupancy')), false)
    // Inspect size without reading the locked byte on Windows.
    assert.equal(fs.statSync(movedLock).size, Buffer.byteLength('permanent coordination file'))
    assert.throws(() => api.acquire(movedLock, true), { code: 'ERR_LEASE_BUSY' })
    await owner.stop()
    assert.equal(fs.readFileSync(movedLock, 'utf8'), 'permanent coordination file')
    api.release(api.acquire(movedLock, true))
  })
}

test('bound publication persists exact bytes and never replaces an existing record', (t) => {
  const root = directory(t)
  const pin = api.pin(root, false)
  const bytes = Buffer.concat([Buffer.from('family-书深'), Buffer.from([0, 255])])
  try {
    api.createAt(pin, 'family.manifest', bytes)
    assert.deepEqual(api.readAt(pin, 'family.manifest', bytes.length), bytes)
    assert.throws(() => api.createAt(pin, 'family.manifest', Buffer.from('replacement')), {
      code: 'ERR_LEASE_EXISTS',
    })
    assert.deepEqual(fs.readFileSync(path.join(root, 'family.manifest')), bytes)
    const full = Buffer.alloc(1024 * 1024, 37)
    api.createAt(pin, 'full.manifest', full)
    assert.deepEqual(api.readAt(pin, 'full.manifest', full.length), full)
  } finally {
    api.release(pin)
  }
  const reopened = api.pin(root, false)
  try {
    assert.deepEqual(api.readAt(reopened, 'family.manifest', bytes.length), bytes)
  } finally {
    api.release(reopened)
  }
})

test('bound publication validates inputs before creating any metadata', (t) => {
  const root = directory(t)
  const pin = api.pin(root, false)
  try {
    for (const value of ['', 'text', null, {}, Buffer.alloc(0), Buffer.alloc(1024 * 1024 + 1)]) {
      assert.throws(() => api.createAt(pin, 'invalid.manifest', value), {
        code: 'ERR_LEASE_ARGUMENT',
      })
    }
    for (const name of ['../outside', 'a/b', 'a\\b', '.hidden', 'upperCase', 'trail.', 'a\0b']) {
      assert.throws(() => api.createAt(pin, name, Buffer.from('data')), {
        code: 'ERR_LEASE_ARGUMENT',
      })
    }
    assert.throws(() => api.createAt({}, 'invalid.manifest', Buffer.from('data')), {
      code: 'ERR_LEASE_ARGUMENT',
    })
    assert.throws(() => api.createAt(pin, 'invalid.manifest', Buffer.from('data'), true), {
      code: 'ERR_LEASE_ARGUMENT',
    })
    assert.deepEqual(fs.readdirSync(root), [])
  } finally {
    api.release(pin)
  }
  assert.throws(() => api.createAt(pin, 'closed.manifest', Buffer.from('data')), {
    code: 'ERR_LEASE_CLOSED',
  })
  assert.deepEqual(fs.readdirSync(root), [])
})

test('bound publication cannot replace directories or hardlinked metadata', (t) => {
  const root = directory(t)
  fs.mkdirSync(path.join(root, 'folder'))
  fs.writeFileSync(path.join(root, 'source'), 'keep')
  fs.linkSync(path.join(root, 'source'), path.join(root, 'alias'))
  const pin = api.pin(root, false)
  try {
    for (const name of ['folder', 'alias']) {
      assert.throws(() => api.createAt(pin, name, Buffer.from('new')))
    }
    assert.equal(fs.readFileSync(path.join(root, 'source'), 'utf8'), 'keep')
    assert.equal(fs.readFileSync(path.join(root, 'alias'), 'utf8'), 'keep')
    assert.equal(fs.statSync(path.join(root, 'folder')).isDirectory(), true)
  } finally {
    api.release(pin)
  }
})

test('bound read distinguishes missing, empty and exact binary bytes without creating files', (t) => {
  const root = directory(t)
  const pin = api.pin(root, false)
  try {
    assert.equal(api.readAt(pin, 'storage-config.json', 1024), null)
    assert.deepEqual(fs.readdirSync(root), [])
    const filename = path.join(root, 'storage-config.json')
    fs.writeFileSync(filename, '')
    assert.deepEqual(api.readAt(pin, 'storage-config.json', 1), Buffer.alloc(0))
    const bytes = Buffer.concat([Buffer.from('{"dataHome":"书深"}'), Buffer.from([0, 255])])
    fs.writeFileSync(filename, bytes)
    assert.deepEqual(api.readAt(pin, 'storage-config.json', bytes.length), bytes)
    assert.throws(() => api.readAt(pin, 'storage-config.json', bytes.length - 1), {
      code: 'ERR_LEASE_SIZE',
    })
    assert.deepEqual(fs.readFileSync(filename), bytes)
    fs.writeFileSync(filename, Buffer.alloc(1024 * 1024, 65))
    assert.equal(api.readAt(pin, 'storage-config.json', 1024 * 1024).length, 1024 * 1024)
    fs.appendFileSync(filename, 'x')
    assert.throws(() => api.readAt(pin, 'storage-config.json', 1024 * 1024), {
      code: 'ERR_LEASE_SIZE',
    })
  } finally {
    api.release(pin)
  }
})

test('bound read validates limits, leaf names and directory capability before IO', (t) => {
  const root = directory(t)
  const pin = api.pin(root, false)
  try {
    for (const limit of [0, -1, 0.5, 1.5, NaN, Infinity, 1024 * 1024 + 1, '10', null]) {
      assert.throws(() => api.readAt(pin, 'storage-config.json', limit), {
        code: 'ERR_LEASE_ARGUMENT',
      })
    }
    for (const name of [
      '',
      '.',
      '..',
      '../escape',
      'a/b',
      'a\\b',
      'a:stream',
      'a\0b',
      '.hidden',
      'a'.repeat(129),
    ]) {
      assert.throws(() => api.readAt(pin, name, 1024), { code: 'ERR_LEASE_ARGUMENT' })
    }
    assert.throws(() => api.readAt(pin, 'storage-config.json'), { code: 'ERR_LEASE_ARGUMENT' })
    assert.throws(() => api.readAt(pin, 'storage-config.json', 1024, true), {
      code: 'ERR_LEASE_ARGUMENT',
    })
    assert.throws(() => api.readAt({}, 'storage-config.json', 1024), { code: 'ERR_LEASE_ARGUMENT' })
    assert.deepEqual(fs.readdirSync(root), [])
    const file = api.acquireAt(pin, 'lock', false)
    try {
      assert.throws(() => api.readAt(file, 'storage-config.json', 1024), {
        code: 'ERR_LEASE_ARGUMENT',
      })
    } finally {
      api.release(file)
    }
  } finally {
    api.release(pin)
  }
  assert.throws(() => api.readAt(pin, 'storage-config.json', 1024), { code: 'ERR_LEASE_CLOSED' })
})

test('bound read accepts a read-only file without requiring write access', (t) => {
  const root = directory(t)
  const filename = path.join(root, 'model_profiles.json')
  fs.writeFileSync(filename, 'preserved')
  fs.chmodSync(filename, 0o400)
  const pin = api.pin(root, false)
  try {
    assert.equal(api.readAt(pin, 'model_profiles.json', 1024).toString(), 'preserved')
  } finally {
    api.release(pin)
    fs.chmodSync(filename, 0o600)
  }
})

test('bound read rejects directories, symbolic links and hardlinks without modifying their contents', (t) => {
  const root = directory(t)
  const pin = api.pin(root, false)
  const target = path.join(root, 'target')
  fs.writeFileSync(target, 'preserved')
  fs.symlinkSync(target, path.join(root, 'symbolic'), 'file')
  fs.symlinkSync(path.join(root, 'missing'), path.join(root, 'broken'), 'file')
  fs.linkSync(target, path.join(root, 'hard'))
  fs.mkdirSync(path.join(root, 'directory'))
  try {
    for (const name of ['symbolic', 'broken', 'hard', 'target', 'directory']) {
      assert.throws(() => api.readAt(pin, name, 1024))
    }
    assert.equal(fs.readFileSync(target, 'utf8'), 'preserved')
  } finally {
    api.release(pin)
  }
})

test('bound read rejects files with untrusted write authority', (t) => {
  const root = directory(t)
  const filename = path.join(root, 'pointer')
  fs.writeFileSync(filename, 'preserved')
  const pin = api.pin(root, false)
  try {
    if (process.platform === 'win32') {
      execFileSync('C:/Windows/System32/icacls.exe', [filename, '/grant', '*S-1-1-0:(M)'])
    } else fs.chmodSync(filename, 0o666)
    assert.throws(() => api.readAt(pin, 'pointer', 1024), { code: 'ERR_LEASE_PERMISSION' })
    assert.equal(fs.readFileSync(filename, 'utf8'), 'preserved')
  } finally {
    api.release(pin)
  }
})

if (process.platform === 'darwin') {
  test('bound read refuses a FIFO without waiting for a writer', async (t) => {
    const root = directory(t)
    execFileSync('/usr/bin/mkfifo', [path.join(root, 'pipe')])
    // A blocking native regression must time out in a child, not hang the runner.
    const owner = await start(t, process.execPath, root, 'read-fifo', root)
    await owner.stop()
  })
} else if (process.platform === 'win32') {
  test('bound read refuses an open writer and releases its own read handle', (t) => {
    const root = directory(t)
    const filename = path.join(root, 'pointer')
    fs.writeFileSync(filename, 'preserved')
    const pin = api.pin(root, false)
    try {
      const writer = fs.openSync(filename, 'r+')
      try {
        assert.throws(() => api.readAt(pin, 'pointer', 1024), { code: 'ERR_LEASE_NATIVE' })
      } finally {
        fs.closeSync(writer)
      }
      assert.equal(api.readAt(pin, 'pointer', 1024).toString(), 'preserved')
      const nextWriter = fs.openSync(filename, 'r+')
      fs.closeSync(nextWriter)
    } finally {
      api.release(pin)
    }
  })
}

for (const [name, host] of [
  ['Node', process.execPath],
  ['Electron', electron],
]) {
  test(`${name} reads the pinned object after its pathname is replaced`, async (t) => {
    const root = directory(t)
    const original = path.join(root, 'original')
    const bytes = Buffer.from('{"schemaVersion":1,"dataHome":"/书深"}')
    fs.mkdirSync(original)
    fs.writeFileSync(path.join(original, 'storage-config.json'), bytes)
    const owner = await start(t, host, original, 'read-replaced', root)
    assert.deepEqual(Buffer.from(owner.contents, 'base64'), bytes)
    assert.equal(fs.readFileSync(path.join(original, 'storage-config.json'), 'utf8'), 'replacement')
    await owner.stop()
  })
}

test('data ACL policy follows the platform while installation remains strict', (t) => {
  const root = directory(t)
  const parent = path.join(root, 'parent')
  const child = path.join(parent, 'child')
  fs.mkdirSync(child, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') {
    execFileSync('C:/Windows/System32/icacls.exe', [parent, '/grant', '*S-1-1-0:(OI)(CI)(M)'])
    for (const filename of [parent, child]) {
      const data = api.pin(filename, false)
      assert.equal(api.readAt(data, 'storage-config.json', 1024), null)
      api.createAt(data, 'record', Buffer.from('retained'))
      assert.equal(api.readAt(data, 'record', 1024).toString(), 'retained')
      api.release(data)
      assert.throws(() => api.pin(filename, false, 'installation'), { code: 'ERR_LEASE_PERMISSION' })
    }
  } else {
    fs.chmodSync(parent, 0o777)
    assert.throws(() => api.pin(parent, false), { code: 'ERR_LEASE_PERMISSION' })
    assert.throws(() => api.pin(child, false), { code: 'ERR_LEASE_PERMISSION' })
    fs.chmodSync(parent, 0o700)
    execFileSync('/bin/chmod', ['+a', 'everyone allow write,delete_child', parent])
    assert.throws(() => api.pin(parent, false), { code: 'ERR_LEASE_PERMISSION' })
    assert.throws(() => api.pin(child, false), { code: 'ERR_LEASE_PERMISSION' })
  }
})

test('relative lock opens reject hardlinks and preserve the linked file', (t) => {
  const root = directory(t)
  const target = path.join(root, 'target')
  fs.writeFileSync(target, 'preserve')
  fs.linkSync(target, path.join(root, 'occupancy'))
  const pin = api.pin(root, false)
  assert.throws(() => api.acquireAt(pin, 'occupancy', false))
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserve')
  api.release(pin)
})

test('actual Electron loads both exact unpacked ASAR libraries and holds its own lock', async (t) => {
  const root = directory(t)
  const source = path.join(root, 'source')
  const native = { libraries: BUNDLED_LIBRARIES.map((name, index) => ({
    path: name,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(library), LIBRARIES[index]))).digest('hex'),
  })) }
  fs.mkdirSync(path.join(source, 'out/main'), { recursive: true })
  fs.mkdirSync(path.join(source, 'out/preload'), { recursive: true })
  for (const item of native.libraries)
    fs.copyFileSync(path.join(path.dirname(library), path.posix.basename(item.path)), path.join(source, item.path))
  const generation = 'a'.repeat(64)
  const protectedRoot = path.join(source, 'out', 'protected', generation)
  const records = [['renderer/vault.html', 'local html'], ['preload/vault.js', 'require("electron")']].map(([name, content]) => {
    fs.mkdirSync(path.dirname(path.join(protectedRoot, name)), { recursive: true })
    fs.writeFileSync(path.join(protectedRoot, name), content)
    return { path: name, bytes: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex') }
  })
  const manifest = JSON.stringify({ version: 1, generation, files: records })
  fs.writeFileSync(path.join(protectedRoot, 'manifest.json'), manifest)
  const manifestSha = crypto.createHash('sha256').update(manifest).digest('hex')
  fs.writeFileSync(
    path.join(source, 'out/main/index.js'),
    `require("./fonts.node"); module.exports = require("./lease.node"); const binding = "scholarseed-protected-v1:${generation}:${manifestSha}";`
  )
  fs.writeFileSync(path.join(source, 'out/preload/index.js'), 'require("electron")')
  fs.writeFileSync(path.join(source, 'out/main/data-inspection.js'), 'module.exports = {}')
  fs.writeFileSync(path.join(source, 'package.json'), '{"main":"out/main/index.js"}')
  const archive = path.join(root, 'app.asar')
  await asar.createPackageWithOptions(source, archive, { unpack: '*.node' })
  const closure = verifyAsarClosure(root, native)
  assert.ok(
    native.libraries.every(item => closure.files.some(file => file.path === item.path && file.sha256 === item.sha256))
  )
  const filename = path.join(root, 'lock')
  const processOwner = await start(
    t,
    electron,
    filename,
    'shared',
    root,
    path.join(archive, 'out/main/index.js')
  )
  assert.equal(processOwner.versions.electron, policy.electron)
  assert.throws(() => api.acquire(filename, true), { code: 'ERR_LEASE_BUSY' })
  await processOwner.stop()
  api.release(api.acquire(filename, true))
})

test('lineage comes from retained ancestor handles and rejects invalid leases', (t) => {
  const root = directory(t)
  const child = path.join(root, 'child')
  fs.mkdirSync(child)
  const parent = api.pin(root, false)
  const pin = api.pin(child, false)
  assert.ok(
    api.lineage(parent).every((ancestor) => api.lineage(pin).slice(0, -1).includes(ancestor))
  )
  assert.equal(api.lineage(pin).at(-1), api.identity(pin))
  assert.throws(() => api.lineage({}), { code: 'ERR_LEASE_ARGUMENT' })
  const leaf = api.acquireAt(parent, 'plain', false)
  assert.throws(() => api.lineage(leaf), { code: 'ERR_LEASE_ARGUMENT' })
  api.release(leaf)
  api.release(pin)
  assert.throws(() => api.lineage(pin), { code: 'ERR_LEASE_CLOSED' })
  api.release(parent)
})

function domainFixture(t) {
  const root = directory(t)
  const coordinator = path.join(root, 'coordination')
  const home = path.join(root, 'home')
  const child = path.join(home, 'profile')
  const sibling = path.join(root, 'other-home')
  for (const item of [coordinator, home, child, sibling]) fs.mkdirSync(item)
  function selection(roots) {
    const file = path.join(root, crypto.randomBytes(8).toString('hex') + '.json')
    fs.writeFileSync(file, JSON.stringify({ coordinator, roots }))
    return file
  }
  return { root, coordinator, home, child, sibling, selection }
}

// Synthetic persistent memberships exercise the real maintenance reader; this
// fixture is not a family registration or retirement authority.
function familyRecords(fx, writer) {
  const pin = api.pin(writer, false)
  let lineage
  try {
    lineage = api.lineage(pin)
  } finally {
    api.release(pin)
  }
  const records = []
  for (const [index, identity] of lineage.entries()) {
    const encoded = identity.replaceAll(':', '-')
    const scope = index === lineage.length - 1 ? 'self' : 'descendants'
    const directory = path.join(fx.coordinator, 'domains-v1', encoded, scope)
    fs.mkdirSync(directory, { recursive: true })
    const record = path.join(directory, 'family.member')
    fs.writeFileSync(record, 'retained fixture', { flag: 'wx' })
    records.push({ record, encoded })
  }
  return records
}

for (const [writerKey, maintenanceKey] of [
  ['home', 'child'],
  ['child', 'home'],
]) {
  test(`persistent ${writerKey} family blocks ${maintenanceKey} maintenance after volatile drain`, (t) => {
    const fx = domainFixture(t)
    const writer = beginDomains(api, fx.coordinator, [fx[writerKey]])
    writer.occupy()
    const records = familyRecords(fx, fx[writerKey])
    writer.admit()
    writer.close()
    // Existing IX/IX admission serializes concurrent maintainers, so verify the
    // sibling's durable scan before retaining this maintainer's admission.
    const sibling = beginDomains(api, fx.coordinator, [fx.sibling], true)
    try {
      sibling.occupy()
    } finally {
      sibling.close()
    }
    const maintenance = beginDomains(api, fx.coordinator, [fx[maintenanceKey]], true)
    try {
      assert.throws(() => maintenance.occupy(), { code: 'ERR_LEASE_BUSY' })
      assert.throws(() => maintenance.occupy(), { code: 'ERR_LEASE_BUSY' })
      const coordinator = api.pin(fx.coordinator, false)
      try {
        for (const { record, encoded } of records) {
          const gate = api.acquireAt(coordinator, `${encoded}-families`, true)
          try {
            fs.unlinkSync(record)
          } finally {
            api.release(gate)
          }
        }
      } finally {
        api.release(coordinator)
      }
      maintenance.occupy()
    } finally {
      maintenance.close()
    }
    // A successful retry must release the original busy attempt as well.
    const next = beginDomains(api, fx.coordinator, [fx[maintenanceKey]], true)
    next.occupy()
    next.close()
  })
}

test('persistent records do not bypass shared writer admission or accept malformed cleanup', (t) => {
  const fx = domainFixture(t)
  const records = familyRecords(fx, fx.home)
  const writer = beginDomains(api, fx.coordinator, [fx.home])
  writer.occupy()
  writer.admit()
  writer.close()
  const own = records.at(-1).record
  fs.unlinkSync(own)
  fs.mkdirSync(own)
  const maintenance = beginDomains(api, fx.coordinator, [fx.home], true)
  try {
    assert.throws(
      () => maintenance.occupy(),
      (error) => error.code !== 'ERR_LEASE_BUSY'
    )
    assert.throws(() => maintenance.occupy(), /guarded admission/)
    assert.equal(fs.statSync(own).isDirectory(), true)
  } finally {
    maintenance.close()
  }
})

test('domain reads require occupied admission and use only the selected roots', (t) => {
  const fx = domainFixture(t)
  const bytes = Buffer.from('{"schemaVersion":1,"dataHome":"/书深"}')
  fs.writeFileSync(path.join(fx.home, 'storage-config.json'), bytes)
  const domain = beginDomains(api, fx.coordinator, [fx.home])
  try {
    assert.throws(() => domain.read(fx.home, 'storage-config.json', 1024), /occupied admission/)
    domain.occupy()
    assert.deepEqual(domain.read(fx.home, 'storage-config.json', 1024), bytes)
    assert.equal(domain.read(fx.home, 'absent', 1024), null)
    assert.equal(fs.existsSync(path.join(fx.home, 'absent')), false)
    domain.admit()
    assert.throws(() => domain.read(fx.home, 'storage-config.json', 1024), /occupied admission/)
  } finally {
    domain.close()
  }
  assert.throws(() => domain.read(fx.home, 'storage-config.json', 1024), /occupied admission/)
  const outside = beginDomains(api, fx.coordinator, [fx.home])
  outside.occupy()
  try {
    assert.throws(
      () => outside.read(fx.child, 'storage-config.json', 1024),
      /explicitly selected root/
    )
    assert.throws(() => outside.admit(), /only an occupied writer/)
  } finally {
    outside.close()
  }
})

test('maintenance can read only after occupancy and a read error forbids admission', (t) => {
  const fx = domainFixture(t)
  fs.writeFileSync(path.join(fx.home, 'pointer'), 'preserved')
  const maintenance = beginDomains(api, fx.coordinator, [fx.home], true)
  try {
    assert.throws(() => maintenance.read(fx.home, 'pointer', 1024), /occupied admission/)
    maintenance.occupy()
    assert.equal(maintenance.read(fx.home, 'pointer', 1024).toString(), 'preserved')
    assert.throws(() => maintenance.admit(), /only an occupied writer/)
  } finally {
    maintenance.close()
  }
  const failed = beginDomains(api, fx.coordinator, [fx.home])
  failed.occupy()
  assert.throws(() => failed.read(fx.home, 'pointer', 1), { code: 'ERR_LEASE_SIZE' })
  assert.throws(() => failed.admit(), /only an occupied writer/)
  assert.throws(() => failed.read(fx.home, 'pointer', 1024), /occupied admission/)
  assert.throws(() => beginDomains(api, fx.coordinator, [fx.home], true), {
    code: 'ERR_LEASE_BUSY',
  })
  failed.close()
  const recovered = beginDomains(api, fx.coordinator, [fx.home], true)
  recovered.occupy()
  recovered.close()
})

for (const boundary of ['before', 'after']) {
  test(`domain read rechecks every selected root ${boundary} reading bytes`, (t) => {
    const fx = domainFixture(t)
    fs.writeFileSync(path.join(fx.home, 'pointer'), 'preserved')
    let reads = 0
    function replace() {
      fs.renameSync(fx.sibling, fx.sibling + '-moved')
      fs.mkdirSync(fx.sibling)
    }
    const wrapped = {
      pin: api.pin,
      lineage: api.lineage,
      acquireAt: api.acquireAt,
      release: api.release,
      readAt(...args) {
        reads++
        const bytes = api.readAt(...args)
        if (boundary === 'after') replace()
        return bytes
      },
    }
    const domain = beginDomains(wrapped, fx.coordinator, [fx.home, fx.sibling])
    domain.occupy()
    try {
      if (boundary === 'before') replace()
      assert.throws(() => domain.read(fx.home, 'pointer', 1024), { code: 'ERR_DOMAIN_CHANGED' })
      assert.equal(reads, boundary === 'before' ? 0 : 1)
      assert.throws(() => domain.admit(), /only an occupied writer/)
      assert.throws(() => domain.read(fx.home, 'pointer', 1024), /occupied admission/)
      assert.equal(fs.readFileSync(path.join(fx.home, 'pointer'), 'utf8'), 'preserved')
    } finally {
      domain.close()
    }
  })
}

for (const [name, host] of [
  ['Node', process.execPath],
  ['Electron', electron],
]) {
  test(`${name} reads under domain qualification and retains it until close`, async (t) => {
    const fx = domainFixture(t)
    const bytes = Buffer.from('{"schemaVersion":1,"dataHome":"/书深"}')
    fs.writeFileSync(path.join(fx.home, 'storage-config.json'), bytes)
    const owner = await start(t, host, fx.selection([fx.home]), 'domain-read', fx.root)
    assert.deepEqual(Buffer.from(owner.contents, 'base64'), bytes)
    assert.throws(() => beginDomains(api, fx.coordinator, [fx.home], true), {
      code: 'ERR_LEASE_BUSY',
    })
    await owner.stop()
    const maintenance = beginDomains(api, fx.coordinator, [fx.home], true)
    maintenance.occupy()
    maintenance.close()
  })
  for (const boundary of ['native', 'before', 'after']) {
    test(`${name} uncertain ${boundary} read close retains domain qualification until death`, async (t) => {
      const fx = domainFixture(t)
      fs.writeFileSync(path.join(fx.home, 'storage-config.json'), '{}')
      const owner = await start(
        t,
        host,
        fx.selection([fx.home]),
        `domain-read-uncertain-${boundary}`,
        fx.root
      )
      assert.throws(() => beginDomains(api, fx.coordinator, [fx.home], true), {
        code: 'ERR_LEASE_BUSY',
      })
      await owner.stop(true)
      const maintenance = beginDomains(api, fx.coordinator, [fx.home], true)
      maintenance.occupy()
      maintenance.close()
    })
  }
}

for (const host of [process.execPath, electron]) {
  const name = host === electron ? 'Electron' : 'Node'
  for (const nested of ['writer-child', 'writer-parent']) {
    test(`${name} domain ${nested}: maintenance waits for actual writer exit`, async (t) => {
      const fx = domainFixture(t)
      const writerRoot = nested === 'writer-child' ? fx.child : fx.home
      const maintenanceRoot = nested === 'writer-child' ? fx.home : fx.child
      const holder = await start(t, host, fx.selection([writerRoot]), 'domain-write', fx.root)
      const maintenance = beginDomains(api, fx.coordinator, [maintenanceRoot], true)
      try {
        assert.throws(() => maintenance.occupy(), { code: 'ERR_LEASE_BUSY' })
        assert.throws(() => beginDomains(api, fx.coordinator, [writerRoot]), {
          code: 'ERR_LEASE_BUSY',
        })
        const unrelated = beginDomains(api, fx.coordinator, [fx.sibling])
        unrelated.occupy()
        unrelated.admit()
        unrelated.close()
        await holder.stop(nested === 'writer-child')
        maintenance.occupy()
        assert.throws(() => maintenance.admit(), /only an occupied writer/)
      } finally {
        maintenance.close()
      }
      const reopened = beginDomains(api, fx.coordinator, [writerRoot])
      reopened.occupy()
      reopened.admit()
      reopened.close()
    })
  }
  test(`${name} maintenance blocks nested writers but allows sibling writers`, async (t) => {
    const fx = domainFixture(t)
    const holder = await start(t, host, fx.selection([fx.home]), 'domain-maintain', fx.root)
    for (const roots of [[fx.child], [fx.home], [fx.sibling, fx.child]])
      assert.throws(() => beginDomains(api, fx.coordinator, roots), { code: 'ERR_LEASE_BUSY' })
    const unrelated = beginDomains(api, fx.coordinator, [fx.sibling])
    unrelated.occupy()
    unrelated.admit()
    unrelated.close()
    await holder.stop()
    const all = beginDomains(api, fx.coordinator, [fx.sibling, fx.home, fx.child], true)
    all.occupy()
    all.close()
  })
}

test('domain aliases and overlapping roots deduplicate, coordination cannot be inside a root', (t) => {
  const fx = domainFixture(t)
  const aliases = beginDomains(
    api,
    fx.coordinator,
    [fx.home, fx.child, process.platform === 'win32' ? fx.home.toUpperCase() : fx.home],
    true
  )
  aliases.occupy()
  aliases.close()
  assert.throws(() => aliases.occupy(), /guarded admission/)
  assert.throws(() => aliases.close(), /already closed/)
  assert.throws(() => beginDomains(api, fx.coordinator, [fx.root]), /outside every data root/)
  assert.throws(
    () => beginDomains(api, fx.coordinator, [fx.coordinator]),
    /outside every data root/
  )
  const files = fs.readdirSync(fx.coordinator)
  assert.ok(files.length > 0)
  const again = beginDomains(api, fx.coordinator, [fx.home])
  assert.throws(() => again.admit(), /only an occupied writer/)
  again.occupy()
  again.admit()
  again.close()
  const retained = new Set(fs.readdirSync(fx.coordinator))
  for (const file of files) {
    assert.ok(retained.has(file), `permanent coordination leaf was deleted: ${file}`)
  }
})

if (process.platform === 'darwin') {
  test('APFS firmlink ancestry includes both logical and physical parents', (t) => {
    // These are actual platform directories, opened read-only. All lock files
    // remain in the test-owned coordination directory; no system data is moved.
    const root = directory(t)
    const users = api.pin('/Users', false)
    const physical = api.pin('/System/Volumes/Data/Users', false)
    const volume = api.pin('/System/Volumes/Data', false)
    try {
      assert.equal(api.identity(users), api.identity(physical))
      for (const pin of [users, physical, volume]) {
        assert.equal(api.lineage(pin).at(-1), api.identity(pin))
        assert.equal(new Set(api.lineage(pin)).size, api.lineage(pin).length)
      }
      assert.ok(api.lineage(users).includes(api.identity(volume)))
      assert.deepEqual(new Set(api.lineage(users)), new Set(api.lineage(physical)))
      assert.throws(
        () => beginDomains(api, root, ['/System/Volumes/Data'], true),
        /outside every data root/
      )
    } finally {
      api.release(volume)
      api.release(physical)
      api.release(users)
    }
  })
}

if (process.platform === 'darwin') {
  test('physical firmlink writers also rendezvous with logical ancestor maintenance', (t) => {
    const root = directory(t)
    const writer = beginDomains(api, root, ['/System/Volumes/Data/usr/local'])
    writer.occupy()
    writer.admit()
    const maintenance = beginDomains(api, root, ['/usr'], true)
    try {
      assert.throws(() => maintenance.occupy(), { code: 'ERR_LEASE_BUSY' })
      writer.close()
      maintenance.occupy()
    } finally {
      maintenance.close()
    }
  })
}

test('ordinary writers may overlap; maintenance is conservatively serialized', (t) => {
  const fx = domainFixture(t)
  const parent = beginDomains(api, fx.coordinator, [fx.home])
  parent.occupy()
  parent.admit()
  const child = beginDomains(api, fx.coordinator, [fx.child])
  child.occupy()
  child.admit()
  child.close()
  parent.close()
  const first = beginDomains(api, fx.coordinator, [fx.home], true)
  first.occupy()
  try {
    assert.throws(() => beginDomains(api, fx.coordinator, [fx.sibling], true), {
      code: 'ERR_LEASE_BUSY',
    })
  } finally {
    first.close()
  }
  const second = beginDomains(api, fx.coordinator, [fx.sibling], true)
  second.occupy()
  second.close()
})

for (const boundary of ['begin', 'occupy', 'admit']) {
  for (const target of ['root', 'ancestor', 'coordinator']) {
    test(`namespace ${target} replacement at ${boundary} cannot admit stale domains`, (t) => {
      const fx = domainFixture(t)
      const sentinel = path.join(fx.child, 'sentinel')
      fs.writeFileSync(sentinel, 'preserve user data')
      let attempted = false
      let changed = false
      function replace() {
        attempted = true
        const original =
          target === 'coordinator' ? fx.coordinator : target === 'root' ? fx.child : fx.home
        const moved = original + '-moved'
        try {
          fs.renameSync(original, moved)
        } catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error
          t.diagnostic(`OS denied ${target} rename: ${error.code}`)
          return
        }
        changed = true
        t.diagnostic(`${target} rename succeeded; revalidation must reject the stale selection`)
        fs.mkdirSync(original)
        if (target === 'ancestor') {
          // Keep the selected leaf's actual identity unchanged: only its ancestor changes.
          fs.renameSync(path.join(moved, 'profile'), fx.child)
        }
      }
      const wrapped = {
        pin: api.pin,
        lineage: api.lineage,
        release: api.release,
        acquireAt(...args) {
          const handle = api.acquireAt(...args)
          if (
            !attempted &&
            args[1].includes(`-${boundary === 'begin' ? 'admission' : 'occupancy'}-`)
          )
            replace()
          return handle
        },
      }
      let domains
      const run = () => {
        domains = beginDomains(boundary === 'admit' ? api : wrapped, fx.coordinator, [fx.child])
        domains.occupy()
        if (boundary === 'admit') replace()
        domains.admit()
      }
      let failure
      try {
        run()
      } catch (error) {
        failure = error
      }
      if (changed) assert.equal(failure?.code, 'ERR_DOMAIN_CHANGED')
      else assert.equal(failure, undefined)
      assert.equal(attempted, true)
      if (domains) domains.close()
      const data =
        target === 'root' && changed ? path.join(fx.child + '-moved', 'sentinel') : sentinel
      assert.equal(fs.readFileSync(data, 'utf8'), 'preserve user data')
      const recovered = beginDomains(api, fx.coordinator, [fx.child], true)
      recovered.occupy()
      recovered.close()
      if (target === 'coordinator' && changed) {
        const old = beginDomains(api, fx.coordinator + '-moved', [fx.child], true)
        old.occupy()
        old.close()
      }
    })
  }
}

for (const host of [process.execPath, electron]) {
  for (const boundary of ['begin', 'occupy', 'admit', 'admission', 'cleanup', 'close']) {
    test(`${host === electron ? 'Electron' : 'Node'} uncertain ${boundary} close retains qualifications until death`, async (t) => {
      const fx = domainFixture(t)
      const holder = await start(
        t,
        host,
        fx.selection([fx.home, fx.sibling]),
        `domain-uncertain-${boundary}`,
        fx.root
      )
      assert.throws(() => beginDomains(api, fx.coordinator, [fx.home, fx.sibling], true), {
        code: 'ERR_LEASE_BUSY',
      })
      await holder.stop(true)
      const recovered = beginDomains(api, fx.coordinator, [fx.home, fx.sibling], true)
      recovered.occupy()
      recovered.close()
    })
  }
}

test('only a missing directory open is classified as missing', (t) => {
  const root = directory(t)
  assert.throws(() => api.pin(path.join(root, 'absent', 'child'), false), {
    code: 'ERR_LEASE_MISSING',
  })
  const file = path.join(root, 'file')
  fs.writeFileSync(file, 'preserve')
  assert.throws(
    () => api.pin(path.join(file, 'child'), false),
    (error) => error.code !== 'ERR_LEASE_MISSING'
  )
  assert.throws(() => api.createChild({}, 'child'), { code: 'ERR_LEASE_ARGUMENT' })
  assert.equal(fs.readFileSync(file, 'utf8'), 'preserve')
})

test('native child creation is single-level, idempotent and preserves existing contents', (t) => {
  const root = directory(t)
  const parent = api.pin(root, false)
  try {
    for (const invalid of [
      '',
      '.',
      '..',
      'a/b',
      'bad\0name',
      ...(process.platform === 'win32' ? ['a\\b', 'a:b', 'name.', 'name '] : []),
    ])
      assert.throws(() => api.createChild(parent, invalid), { code: 'ERR_LEASE_ARGUMENT' })
    const identity = api.createChild(parent, '.profile-中文')
    const child = path.join(root, '.profile-中文')
    fs.writeFileSync(path.join(child, 'sentinel'), 'user data')
    assert.equal(api.createChild(parent, '.profile-中文'), identity)
    const pin = api.pin(child, false)
    assert.equal(api.identity(pin), identity)
    api.release(pin)
    assert.equal(fs.readFileSync(path.join(child, 'sentinel'), 'utf8'), 'user data')
    fs.writeFileSync(path.join(root, 'file'), 'keep')
    assert.throws(() => api.createChild(parent, 'file'))
    assert.equal(fs.readFileSync(path.join(root, 'file'), 'utf8'), 'keep')
  } finally {
    api.release(parent)
  }
  assert.throws(() => api.createChild(parent, 'closed'), { code: 'ERR_LEASE_CLOSED' })
})

test('native relative creation follows held parent identity after namespace replacement', (t) => {
  const root = directory(t)
  const original = path.join(root, 'parent')
  const moved = path.join(root, 'moved')
  fs.mkdirSync(original)
  const parent = api.pin(original, false)
  let renamed = false
  try {
    try {
      fs.renameSync(original, moved)
      renamed = true
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error
      t.diagnostic('OS blocked parent rename')
    }
    if (renamed) fs.mkdirSync(original)
    const identity = api.createChild(parent, 'created')
    const actual = path.join(renamed ? moved : original, 'created')
    const child = api.pin(actual, false)
    assert.equal(api.identity(child), identity)
    api.release(child)
    if (renamed) assert.equal(fs.existsSync(path.join(original, 'created')), false)
  } finally {
    api.release(parent)
  }
})

test('preparation creates one level per qualification even when coordinator is below the ancestor', (t) => {
  const fx = domainFixture(t)
  const desired = path.join(fx.root, 'new-home', 'profile', 'session')
  ensureDirectories(api, fx.coordinator, [desired, desired])
  assert.deepEqual(fs.readdirSync(desired), [])
  const domains = beginDomains(api, fx.coordinator, [desired])
  domains.occupy()
  domains.admit()
  domains.close()
  assert.throws(
    () => createDirectory(api, fx.coordinator, fx.root, 'coordination'),
    /outside every data root/
  )
})

test('invalid suffixes are rejected before any directory preparation', (t) => {
  const fx = domainFixture(t)
  const valid = path.join(fx.root, 'must-not-exist')
  for (const suffix of ['..', '.', '', 'a\0b']) {
    assert.throws(() => ensureDirectories(api, fx.coordinator, [valid, valid + path.sep + suffix]))
    assert.equal(fs.existsSync(valid), false)
  }
})

test('directory preparation refuses a symlink instead of treating it as absence', (t) => {
  const fx = domainFixture(t)
  const alias = path.join(fx.sibling, 'alias')
  fs.symlinkSync(fx.home, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(
    () => ensureDirectories(api, fx.coordinator, [path.join(alias, 'new-child')]),
    (error) => error.code !== 'ERR_LEASE_MISSING'
  )
  assert.equal(fs.existsSync(path.join(fx.home, 'new-child')), false)
  const pin = api.pin(fx.sibling, false)
  try {
    assert.throws(() => api.createChild(pin, 'alias'))
  } finally {
    api.release(pin)
  }
})

test('post-creation namespace changes fail without writing to the replacement parent', (t) => {
  const fx = domainFixture(t)
  let changed = false
  const wrapped = {
    pin: api.pin,
    lineage: api.lineage,
    acquireAt: api.acquireAt,
    release: api.release,
    createChild(...args) {
      const identity = api.createChild(...args)
      try {
        fs.renameSync(fx.home, fx.home + '-moved')
        changed = true
      } catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error
      }
      if (changed) fs.mkdirSync(fx.home)
      return identity
    },
  }
  let error
  try {
    createDirectory(wrapped, fx.coordinator, fx.home, 'new-child')
  } catch (caught) {
    error = caught
  }
  if (changed) {
    assert.equal(error?.code, 'ERR_DOMAIN_CHANGED')
    assert.equal(fs.existsSync(path.join(fx.home, 'new-child')), false)
    assert.ok(fs.existsSync(path.join(fx.home + '-moved', 'new-child')))
  } else {
    assert.equal(error, undefined)
    t.diagnostic('OS blocked parent rename')
  }
})

for (const host of [process.execPath, electron]) {
  const name = host === electron ? 'Electron' : 'Node'
  test(`${name} active writer permits child creation but ancestor maintenance blocks it`, async (t) => {
    const fx = domainFixture(t)
    const selection = fx.selection([fx.home])
    const writer = await start(t, host, selection, 'domain-write', fx.root)
    ensureDirectories(api, fx.coordinator, [path.join(fx.home, 'allowed', 'nested')])
    await writer.stop()
    const maintainer = await start(t, host, selection, 'domain-maintain', fx.root)
    const blocked = path.join(fx.home, 'blocked')
    assert.throws(() => ensureDirectories(api, fx.coordinator, [blocked]), {
      code: 'ERR_LEASE_BUSY',
    })
    assert.equal(fs.existsSync(blocked), false)
    await maintainer.stop()
    ensureDirectories(api, fx.coordinator, [blocked])
  })
  for (const boundary of ['native', 'selected']) {
    test(`${name} uncertain creation ${boundary} close retains qualification until death`, async (t) => {
      const fx = domainFixture(t)
      const owner = await start(
        t,
        host,
        fx.selection([fx.home]),
        `creation-uncertain-${boundary}`,
        fx.root
      )
      assert.throws(() => beginDomains(api, fx.coordinator, [fx.home], true), {
        code: 'ERR_LEASE_BUSY',
      })
      await owner.stop(true)
      const maintenance = beginDomains(api, fx.coordinator, [fx.home], true)
      maintenance.occupy()
      maintenance.close()
    })
  }
}

test('Node and Electron concurrent creators converge on one real child identity', async (t) => {
  const fx = domainFixture(t)
  const gate = path.join(fx.root, 'creation-go')
  const files = [fx.selection([fx.home]), fx.selection([fx.home])]
  for (const file of files)
    fs.writeFileSync(file, JSON.stringify({ coordinator: fx.coordinator, roots: [fx.home], gate }))
  const pending = [
    start(t, process.execPath, files[0], 'creation-race', fx.root),
    start(t, electron, files[1], 'creation-race', fx.root),
  ]
  const settled = Promise.allSettled(pending)
  const deadline = Date.now() + PROCESS_TIMEOUT
  try {
    while (!files.every((file) => fs.existsSync(file + '.ready'))) {
      if (Date.now() >= deadline) throw new Error('creators did not both reach qualified creation')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    fs.writeFileSync(gate, 'go')
    const owners = await Promise.all(pending)
    const identities = files.map((file) => fs.readFileSync(file + '.identity', 'utf8'))
    assert.equal(identities[0], identities[1])
    const pin = api.pin(path.join(fx.home, 'same-child'), false)
    assert.equal(api.identity(pin), identities[0])
    api.release(pin)
    assert.deepEqual(fs.readdirSync(path.join(fx.home, 'same-child')), [])
    await Promise.all(owners.map((owner) => owner.stop()))
  } finally {
    fs.writeFileSync(gate, 'go')
    await settled
  }
})

test('Node and Electron first coordinator creation retains one shared lock namespace', async (t) => {
  const root = directory(t)
  const coordinator = path.join(root, 'coordinator')
  const gate = path.join(root, 'coordinator-go')
  const files = [path.join(root, 'node.json'), path.join(root, 'electron.json')]
  for (const file of files) fs.writeFileSync(file, JSON.stringify({ coordinator, gate }))
  const pending = [
    start(t, process.execPath, files[0], 'coordinator-race', root),
    start(t, electron, files[1], 'coordinator-race', root),
  ]
  const settled = Promise.allSettled(pending)
  let pin
  try {
    const deadline = Date.now() + PROCESS_TIMEOUT
    while (!files.every((file) => fs.existsSync(file + '.ready'))) {
      if (Date.now() >= deadline) throw new Error('coordinator creators did not reach barrier')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(fs.existsSync(coordinator), false)
    fs.writeFileSync(gate, 'go')
    const owners = await Promise.all(pending)
    const lineages = owners.map((owner) => JSON.parse(Buffer.from(owner.contents, 'base64')))
    assert.deepEqual(lineages[0], lineages[1])
    pin = api.pin(coordinator, false)
    assert.deepEqual(api.lineage(pin), lineages[0])
    for (const owner of owners) {
      assert.throws(() => api.acquireAt(pin, 'shared-slot', true), { code: 'ERR_LEASE_BUSY' })
      await owner.stop()
    }
    const exclusive = api.acquireAt(pin, 'shared-slot', true)
    api.release(exclusive)
    assert.equal(fs.statSync(path.join(coordinator, 'shared-slot')).isFile(), true)
  } finally {
    fs.writeFileSync(gate, 'go')
    await settled
    if (pin) api.release(pin)
  }
})

test('each new level participates in fresh admission before the next mkdir', (t) => {
  const fx = domainFixture(t)
  const first = path.join(fx.home, 'first')
  const target = path.join(first, 'second')
  let maintenance
  const wrapped = {
    pin: api.pin,
    lineage: api.lineage,
    acquireAt: api.acquireAt,
    release: api.release,
    createChild(...args) {
      const identity = api.createChild(...args)
      if (!maintenance) {
        maintenance = beginDomains(api, fx.coordinator, [first], true)
        maintenance.occupy()
      }
      return identity
    },
  }
  try {
    assert.throws(() => ensureDirectories(wrapped, fx.coordinator, [target]), {
      code: 'ERR_LEASE_BUSY',
    })
    assert.equal(fs.existsSync(first), true)
    assert.equal(fs.existsSync(target), false)
  } finally {
    maintenance?.close()
  }
  ensureDirectories(api, fx.coordinator, [target])
})

test('bound inventory returns complete repeated scans with safe own prototype names', (t) => {
  const root = directory(t)
  const pin = api.pin(root, false)
  try {
    assert.deepEqual(api.listAt(pin, 3, 6), {})
    api.createAt(pin, 'first', Buffer.from('abc'))
    api.createAt(pin, '__proto__', Buffer.from('def'))
    fs.writeFileSync(path.join(root, 'empty'), '')
    for (let scan = 0; scan < 2; scan++) {
      const records = api.listAt(pin, 3, 6)
      assert.equal(Object.getPrototypeOf(records), Object.prototype)
      assert.equal(Object.hasOwn(records, '__proto__'), true)
      assert.deepEqual(Object.keys(records).sort(), ['__proto__', 'empty', 'first'])
      assert.deepEqual(records.first, Buffer.from('abc'))
      assert.deepEqual(records.__proto__, Buffer.from('def'))
      assert.deepEqual(records.empty, Buffer.alloc(0))
    }
    assert.throws(() => api.listAt(pin, 2, 6), { code: 'ERR_LEASE_SIZE' })
    assert.throws(() => api.listAt(pin, 3, 5), { code: 'ERR_LEASE_SIZE' })
    assert.throws(() => api.listAt(pin, 3, 2), { code: 'ERR_LEASE_SIZE' })
    assert.deepEqual(fs.readFileSync(path.join(root, 'first')), Buffer.from('abc'))
  } finally {
    api.release(pin)
  }
  assert.throws(() => api.listAt(pin, 3, 6), { code: 'ERR_LEASE_CLOSED' })
})

test('bound inventory validates bounds and rejects unsafe record names and types', (t) => {
  const root = directory(t)
  const pin = api.pin(root, false)
  try {
    for (const [count, size] of [
      [0, 1],
      [4097, 1],
      [1.5, 1],
      [true, 1],
      [1, 0],
      [1, 1048577],
      [1, NaN],
      [1, Infinity],
    ]) {
      assert.throws(() => api.listAt(pin, count, size), { code: 'ERR_LEASE_ARGUMENT' })
    }
    assert.throws(() => api.listAt({}, 1, 1), { code: 'ERR_LEASE_ARGUMENT' })
    assert.throws(() => api.listAt(pin, 1, 1, true), { code: 'ERR_LEASE_ARGUMENT' })
    for (const name of ['invalid name', '.hidden', 'upperCase', 'trail.']) {
      // Windows normalizes trailing dots through ordinary Win32 creation.
      if (process.platform === 'win32' && name === 'trail.') continue
      fs.writeFileSync(path.join(root, name), 'keep')
      assert.throws(() => api.listAt(pin, 1, 16), { code: 'ERR_LEASE_ARGUMENT' })
      fs.unlinkSync(path.join(root, name))
    }
    fs.mkdirSync(path.join(root, 'folder'))
    assert.throws(() => api.listAt(pin, 1, 16), {
      code: process.platform === 'win32' ? 'ERR_LEASE_NATIVE' : 'ERR_LEASE_FILE',
    })
    fs.rmdirSync(path.join(root, 'folder'))
    fs.writeFileSync(path.join(root, 'original'), 'keep')
    fs.linkSync(path.join(root, 'original'), path.join(root, 'hard'))
    assert.throws(() => api.listAt(pin, 2, 16), {
      code: process.platform === 'win32' ? 'ERR_LEASE_DIRECTORY' : 'ERR_LEASE_FILE',
    })
    assert.equal(fs.readFileSync(path.join(root, 'original'), 'utf8'), 'keep')
  } finally {
    api.release(pin)
  }
})

if (process.platform === 'darwin') {
  test('bound inventory follows retained parent identity and rejects symlink records', (t) => {
    const root = directory(t)
    const source = path.join(root, 'source')
    const moved = path.join(root, 'moved')
    fs.mkdirSync(source)
    const pin = api.pin(source, false)
    try {
      api.createAt(pin, 'record', Buffer.from('original'))
      fs.renameSync(source, moved)
      fs.mkdirSync(source)
      fs.writeFileSync(path.join(source, 'record'), 'replacement')
      assert.deepEqual(api.listAt(pin, 1, 8), { record: Buffer.from('original') })
      fs.symlinkSync(path.join(source, 'record'), path.join(moved, 'link'))
      assert.throws(() => api.listAt(pin, 2, 100), { code: 'ERR_LEASE_NATIVE' })
      assert.equal(fs.readFileSync(path.join(source, 'record'), 'utf8'), 'replacement')
    } finally {
      api.release(pin)
    }
  })
}

test('family maintenance holds real exclusive activity while obtaining a fresh grant', async (t) => {
  const fx = domainFixture(t)
  const name = 'a'.repeat(64),
    payload = 'b'.repeat(64)
  // Synthetic records test the reader and locking lifecycle only. Actual grant
  // authority is exercised separately through the native original-Job broker.
  const records = familyRecords(fx, fx.home).map(({ record }) => {
    const renamed = path.join(path.dirname(record), name)
    fs.renameSync(record, renamed)
    fs.writeFileSync(renamed, payload)
    return renamed
  })
  const held = beginDomains(api, fx.coordinator, [fx.home], true)
  let resolveGrant
  let calls = 0
  const pending = held.occupyFamily(async (bindings) => {
    calls++
    assert.equal(bindings.length, 1)
    assert.equal(bindings[0].path, fx.home)
    assert.throws(() => beginDomains(api, fx.coordinator, [fx.home]), { code: 'ERR_LEASE_BUSY' })
    assert.throws(() => held.close(), /authorization/)
    return new Promise((resolve) => {
      resolveGrant = resolve
    })
  })
  resolveGrant({ [name]: payload })
  await pending
  assert.equal(calls, 1)
  held.check()
  assert.throws(() => held.admit(), /writer/)
  held.close()
  const unrelated = beginDomains(api, fx.coordinator, [fx.home], true)
  try {
    // A valid current-family grant never exempts unknown or changed records.
    const foreign = path.join(path.dirname(records.at(-1)), 'c'.repeat(64))
    fs.writeFileSync(foreign, 'd'.repeat(64))
    await assert.rejects(
      unrelated.occupyFamily(async () => ({ [name]: payload })),
      { code: 'ERR_LEASE_BUSY' }
    )
    fs.unlinkSync(foreign)
    await assert.rejects(
      unrelated.occupyFamily(async () => ({ [name]: 'e'.repeat(64) })),
      { code: 'ERR_LEASE_BUSY' }
    )
    await unrelated.occupyFamily(async () => ({ [name]: payload }))
    unrelated.check()
  } finally {
    unrelated.close()
  }
})

test('interrupted mutation blocks parent and descendant writers after volatile locks close', (t) => {
  const fx = domainFixture(t)
  const nested = path.join(fx.child, 'nested')
  fs.mkdirSync(nested)
  const first = beginDomains(api, fx.coordinator, [fx.child], true)
  first.occupy()
  first.reserveMutation('contract-migration-owner')
  first.close() // Intent remains; this is not a process-crash acceptance test.
  const deferredDirectory = path.join(fx.child, 'logs')
  assert.throws(() => ensureDirectories(api, fx.coordinator, [deferredDirectory]), {
    code: 'ERR_LEASE_BUSY',
  })
  assert.equal(fs.existsSync(deferredDirectory), false)
  for (const root of [fx.home, fx.child, nested]) {
    const writer = beginDomains(api, fx.coordinator, [root])
    try {
      writer.occupy()
      assert.throws(() => writer.admit(), { code: 'ERR_LEASE_BUSY' })
    } finally {
      writer.close()
    }
  }
  const sibling = beginDomains(api, fx.coordinator, [fx.sibling])
  sibling.occupy()
  sibling.admit()
  sibling.close()
  const foreign = beginDomains(api, fx.coordinator, [fx.child], true)
  foreign.occupy()
  assert.throws(() => foreign.reserveMutation('different-owner'), { code: 'ERR_LEASE_BUSY' })
  foreign.close()
  const recovery = beginDomains(api, fx.coordinator, [fx.child], true)
  recovery.occupy()
  const intent = recovery.reserveMutation('contract-migration-owner')
  intent.finish()
  recovery.close()
  ensureDirectories(api, fx.coordinator, [deferredDirectory])
  assert.equal(fs.statSync(deferredDirectory).isDirectory(), true)
  const writer = beginDomains(api, fx.coordinator, [nested])
  writer.occupy()
  writer.admit()
  writer.close()
})


test('project role accepts shared data while private pins and coordination remain strict', (t) => {
  const root = directory(t)
  const project = path.join(root, 'shared')
  fs.mkdirSync(project, { mode: 0o700 })
  fs.writeFileSync(path.join(project, 'record'), 'project data')
  if (process.platform === 'win32') {
    execFileSync('C:/Windows/System32/icacls.exe', [project, '/grant', '*S-1-1-0:(OI)(CI)(M)'])
  } else {
    fs.chmodSync(project, 0o777)
    fs.chmodSync(path.join(project, 'record'), 0o666)
  }
  assert.throws(() => api.pin(project, false), { code: 'ERR_LEASE_PERMISSION' })
  assert.throws(() => api.pin(project, false, 'unknown'), { code: 'ERR_LEASE_ARGUMENT' })
  const pin = api.pin(project, false, 'project')
  try {
    assert.equal(api.readAt(pin, 'record', 1024).toString(), 'project data')
    assert.equal(api.listAt(pin, 16, 1024).record.toString(), 'project data')
    assert.throws(() => api.acquireAt(pin, 'record', false), { code: 'ERR_LEASE_PERMISSION' })
    api.createChild(pin, 'child')
    const child = api.pin(path.join(project, 'child'), false, 'project')
    api.release(child)
    fs.linkSync(path.join(project, 'record'), path.join(project, 'hardlink'))
    assert.throws(() => api.readAt(pin, 'hardlink', 1024), { code: process.platform === 'win32' ? 'ERR_LEASE_DIRECTORY' : 'ERR_LEASE_FILE' })
    fs.unlinkSync(path.join(project, 'hardlink'))
  } finally {
    api.release(pin)
  }
  const coordinator = path.join(root, 'coordinator')
  fs.mkdirSync(coordinator, { mode: 0o700 })
  const lease = beginDomains(api, coordinator, [project], false, { [project]: 'project' })
  try {
    lease.occupy()
    assert.equal(lease.read(project, 'record', 1024).toString(), 'project data')
    lease.check()
    lease.admit()
  } finally { lease.close() }
})


test('project role preserves OS read denial and reparse rejection', (t) => {
  const root = directory(t)
  const data = path.join(root, 'record')
  fs.writeFileSync(data, 'protected data')
  const pin = api.pin(root, false, 'project')
  try {
    if (process.platform === 'win32') {
      execFileSync('C:/Windows/System32/icacls.exe', [data, '/deny', '*S-1-1-0:(RD)'])
    } else {
      execFileSync('/bin/chmod', ['+a', 'everyone deny read', data])
    }
    try { assert.throws(() => api.readAt(pin, 'record', 1024), { code: 'ERR_LEASE_NATIVE' }) }
    finally {
      if (process.platform === 'win32') execFileSync('C:/Windows/System32/icacls.exe', [data, '/remove:d', '*S-1-1-0'])
      else execFileSync('/bin/chmod', ['-a', 'everyone deny read', data])
    }
    const target = path.join(root, 'target')
    const alias = path.join(root, 'alias')
    fs.mkdirSync(target, { mode: 0o700 })
    fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => api.pin(alias, false, 'project'), { code: 'ERR_LEASE_DIRECTORY' })
    assert.equal(api.readAt(pin, 'record', 1024).toString(), 'protected data')
  } finally { api.release(pin) }
})

for (const host of [process.execPath, electron]) {
  test(`macOS TeX rebuild waits for ${host === electron ? 'Electron' : 'Node'} consumer exit`,
    { skip: process.platform !== 'darwin' }, async t => {
      const fx = domainFixture(t)
      const writableRoot = path.join(fx.child, '2026')
      fs.mkdirSync(writableRoot)
      const options = { binDirectory: path.join(fx.root, 'old', 'bin'), writableRoot,
        version: '2026', platform: 'darwin', archiveSha256: 'a'.repeat(64), environment: {} }
      const env = texlive.prepareTexliveEnvironment(options)
      const marker = path.join(env.TEXMFVAR, 'keep')
      fs.writeFileSync(marker, 'active compiler state')
      const owner = await start(t, host, fx.selection([fx.home]), 'domain-write', fx.root)
      const maintenance = beginDomains(api, fx.coordinator, [writableRoot], true)
      try {
        assert.throws(() => maintenance.occupy(), { code: 'ERR_LEASE_BUSY' })
        assert.equal(fs.readFileSync(marker, 'utf8'), 'active compiler state')
        await owner.stop()
        maintenance.occupy()
        const moved = { ...options, binDirectory: path.join(fx.root, 'moved', 'bin') }
        texlive.rebuildTexliveEnvironment(moved)
        maintenance.check()
        assert.equal(texlive.texliveEnvironmentCurrent(moved), true)
        assert.equal(fs.existsSync(marker), false)
        assert.throws(() => beginDomains(api, fx.coordinator, [fx.home]), { code: 'ERR_LEASE_BUSY' })
      } finally {
        maintenance.close()
      }
    })
}
