import assert from 'node:assert/strict'
import fs, {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { extname, join, toNamespacedPath } from 'node:path'
import test, { type TestContext } from 'node:test'
import childProcess, { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import type { BackendHandle } from './backend.ts'
import { RUNTIME_ENTRIES, RUNTIME_COMPONENT_KINDS } from '../../runtime/components.cjs'
import { RotatingFileLog } from './logfile.ts'
import { isFirstRun, resolveStartupBudgetMs, writeStartupMarker } from './startupmarker.ts'

const directory = mkdtempSync(join(tmpdir(), 'browser-startup-'))
mkdirSync(join(directory, 'resources'))
const manifest = JSON.parse(
  readFileSync(new URL('../../resources/product.json', import.meta.url), 'utf8')
)
const manifestPath = join(directory, 'resources', 'product.json')
writeFileSync(
  manifestPath,
  JSON.stringify({ ...manifest, features: { ...manifest.features, browser: false } })
)
const sourceRoot = new URL('../', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.startsWith(sourceRoot) &&
      context.parentURL.endsWith('.ts') &&
      specifier.startsWith('.') &&
      !extname(specifier)
    )
      return nextResolve(`${specifier}.ts`, context)
    return specifier === 'electron'
      ? { url: 'browser-test:electron', shortCircuit: true }
      : nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    return url === 'browser-test:electron'
      ? {
          format: 'module',
          shortCircuit: true,
          source: `export const app = { isPackaged: false, getVersion: () => "0.3.0", getAppPath: () => ${JSON.stringify(directory)}, getPath: () => ${JSON.stringify(directory)} };`,
        }
      : nextLoad(url, context)
  },
})
const backend = await import('./backend.ts')

test('same-build startup survives slow preparation beyond the former overall deadline', async (context) => {
  const home = mkdtempSync(join(directory, 'existing-marker-'))
  context.after(() => rmSync(home, { recursive: true, force: true }))
  const identity = { version: '0.3.0', buildNumber: '202611021300' }
  writeStartupMarker(home, identity)
  const firstRun = isFirstRun(home, identity)
  assert.equal(firstRun, false)
  const originalFetch = globalThis.fetch
  const logs: string[] = []
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  try {
    globalThis.fetch = async () =>
      ({
        ok: Date.now() >= 55_000,
        json: async () => ({ ok: true, features: { browser: false } }),
      }) as Response
    const ready = backend.waitForHealth(
      'http://127.0.0.1',
      resolveStartupBudgetMs(firstRun, false, 90_000),
      (line) => logs.push(line)
    )
    for (let second = 0; second < 56; second++) {
      context.mock.timers.tick(1_000)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    assert.equal(await ready, true)
    assert.match(logs.join(''), /backend healthy/)
  } finally {
    globalThis.fetch = originalFetch
    context.mock.timers.reset()
  }
})

test('same-build startup still fails when preparation and readiness exhaust the total budget', async (context) => {
  const home = mkdtempSync(join(directory, 'expired-marker-'))
  context.after(() => rmSync(home, { recursive: true, force: true }))
  const identity = { version: '0.3.0', buildNumber: '202611021300' }
  writeStartupMarker(home, identity)
  const originalFetch = globalThis.fetch
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  try {
    globalThis.fetch = async () => ({ ok: false }) as Response
    const budget = resolveStartupBudgetMs(isFirstRun(home, identity), false, 90_000)
    assert.equal(budget, 135_000)
    let settled = false
    const ready = backend
      .waitForHealth('http://127.0.0.1', budget, () => {})
      .then((value) => {
        settled = true
        return value
      })
    for (let second = 0; second < 136; second++) {
      context.mock.timers.tick(1_000)
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (second === 89) assert.equal(settled, false)
    }
    assert.equal(settled, true)
    assert.equal(await ready, false)
  } finally {
    globalThis.fetch = originalFetch
    context.mock.timers.reset()
  }
})

test('Skill Python probe rejects missing executables and does not launch after cancellation', async () => {
  const stop = new AbortController()
  const diagnostics: string[] = []
  const log = (line: string) => diagnostics.push(line)
  assert.equal(
    await backend.probeSkillPython(
      join(directory, 'missing'),
      directory,
      directory,
      {},
      stop.signal,
      log
    ),
    false
  )
  assert.match(diagnostics.join(''), /"event":"spawn-error"/)
  assert.match(diagnostics.join(''), /ENOENT/)
  assert.match(diagnostics.join(''), /"event":"finished"/)
  diagnostics.length = 0
  stop.abort()
  assert.equal(
    await backend.probeSkillPython(process.execPath, directory, directory, {}, stop.signal, log),
    false
  )
  assert.match(diagnostics.join(''), /"event":"cancelled-before-spawn"/)
  assert.doesNotMatch(diagnostics.join(''), /"event":"spawned"/)
})

test(
  'Skill Python diagnostics retain bounded stderr tails and the actual exit status',
  { skip: process.platform === 'win32' },
  async () => {
    const executable = join(directory, 'probe-error')
    writeFileSync(
      executable,
      "#!/bin/sh\nprintf 'discarded-prefix' >&2\nprintf '%20000s' ' ' >&2\nprintf 'ModuleNotFoundError: missing_skill_module\\n' >&2\nexit 7\n"
    )
    chmodSync(executable, 0o755)
    const diagnostics: string[] = []
    assert.equal(
      await backend.probeSkillPython(
        executable,
        directory,
        directory,
        { PRIVATE_TOKEN: 'must-not-be-logged' },
        new AbortController().signal,
        (line) => diagnostics.push(line)
      ),
      false
    )
    const output = diagnostics.join('')
    assert.match(output, /ModuleNotFoundError: missing_skill_module/)
    assert.match(output, /"stderrTruncated":true/)
    assert.match(output, /"code":7/)
    assert.match(output, /"signal":null/)
    assert.doesNotMatch(output, /discarded-prefix|must-not-be-logged|PRIVATE_TOKEN/)
    assert.ok(output.length < 12_000)
  }
)

test(
  'Skill Python cold start can exceed the previous outer deadline',
  { skip: process.platform === 'win32' },
  async () => {
    const executable = join(directory, 'probe-cold')
    writeFileSync(executable, '#!/bin/sh\nsleep 16\nexit 0\n')
    chmodSync(executable, 0o755)
    assert.equal(
      await backend.probeSkillPython(
        executable,
        directory,
        directory,
        {},
        new AbortController().signal
      ),
      true
    )
  }
)

test('Skill Python diagnostics preserve native system error codes', async (context) => {
  const failure = Object.assign(new Error('ERR_PROCESS_FAMILY_ASSIGN'), {
    code: 'ERR_PROCESS_FAMILY_ASSIGN',
    systemCode: 5,
  })
  const spawning = context.mock.method(childProcess, 'spawn', () => {
    throw failure
  })
  syncBuiltinESMExports()
  const diagnostics: string[] = []
  try {
    await assert.rejects(
      backend.probeSkillPython(
        process.execPath,
        directory,
        directory,
        {},
        new AbortController().signal,
        (line) => diagnostics.push(line)
      ),
      failure
    )
    assert.match(diagnostics.join(''), /"errorCode":"ERR_PROCESS_FAMILY_ASSIGN"/)
    assert.match(diagnostics.join(''), /"systemCode":5/)
  } finally {
    spawning.mock.restore()
    syncBuiltinESMExports()
  }
})

test(
  'Skill Python successful probes preserve their result and diagnostic checkpoint',
  { skip: process.platform === 'win32' },
  async () => {
    const executable = join(directory, 'probe-success')
    writeFileSync(executable, "#!/bin/sh\nprintf 'launcher resolved\\n' >&2\nexit 0\n")
    chmodSync(executable, 0o755)
    const diagnostics: string[] = []
    assert.equal(
      await backend.probeSkillPython(
        executable,
        directory,
        directory,
        {},
        new AbortController().signal,
        (line) => diagnostics.push(line)
      ),
      true
    )
    assert.match(diagnostics.join(''), /launcher resolved/)
    assert.match(diagnostics.join(''), /"code":0/)
    assert.match(diagnostics.join(''), /"ready":true/)
  }
)

test(
  'Skill Python timeout is distinguishable from an ordinary nonzero exit',
  { skip: process.platform === 'win32' },
  async (context) => {
    const executable = join(directory, 'probe-timeout')
    writeFileSync(executable, '#!/bin/sh\nexec /bin/sleep 30\n')
    chmodSync(executable, 0o755)
    const diagnostics: string[] = []
    context.mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const result = backend.probeSkillPython(
        executable,
        directory,
        directory,
        {},
        new AbortController().signal,
        (line) => diagnostics.push(line)
      )
      context.mock.timers.tick(90_000)
      assert.equal(await result, false)
      assert.match(diagnostics.join(''), /"event":"timed-out"/)
      assert.match(diagnostics.join(''), /"signal":"SIGKILL"/)
    } finally {
      context.mock.timers.reset()
    }
  }
)

test(
  'Skill Python diagnostic capture failure does not change readiness',
  { skip: process.platform === 'win32' },
  async (context) => {
    const executable = join(directory, 'probe-no-diagnostics')
    writeFileSync(executable, '#!/bin/sh\nexit 0\n')
    chmodSync(executable, 0o755)
    const capture = context.mock.method(fs, 'mkdtempSync', () => {
      throw new Error('diagnostic directory unavailable')
    })
    syncBuiltinESMExports()
    const diagnostics: string[] = []
    try {
      assert.equal(
        await backend.probeSkillPython(
          executable,
          directory,
          directory,
          {},
          new AbortController().signal,
          (line) => diagnostics.push(line)
        ),
        true
      )
      assert.match(diagnostics.join(''), /"event":"diagnostic-capture-error"/)
      assert.match(diagnostics.join(''), /"ready":true/)
    } finally {
      capture.mock.restore()
      syncBuiltinESMExports()
    }
  }
)

test(
  'Skill Python cancellation joins its actual process',
  { skip: process.platform === 'win32' },
  async () => {
    const executable = join(directory, 'probe')
    const pidFile = join(directory, 'probe.pid')
    writeFileSync(executable, `#!/bin/sh\necho $$ > '${pidFile}'\nexec /bin/sleep 30\n`)
    chmodSync(executable, 0o755)
    const stop = new AbortController()
    const diagnostics: string[] = []
    const result = backend.probeSkillPython(
      executable,
      directory,
      directory,
      {},
      stop.signal,
      (line) => diagnostics.push(line)
    )
    try {
      const deadline = Date.now() + 5_000
      while (!existsSync(pidFile) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(existsSync(pidFile), true)
    } finally {
      stop.abort()
    }
    assert.equal(await result, false)
    assert.match(diagnostics.join(''), /"event":"cancelled"/)
    assert.match(diagnostics.join(''), /"signal":"SIGKILL"/)
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  }
)

function ownedHandle(proc: ChildProcess): BackendHandle {
  return {
    python: null,
    port: 0,
    baseUrl: '',
    proc,
    ready: Promise.resolve(true),
    exited: new Promise((resolve) =>
      proc.once('exit', (code, signal) => resolve({ code, signal }))
    ),
    error: null,
    stopping: false,
    agentTransport: null,
    storageLaunch: null,
  }
}

test('backend shutdown allows actual cleanup longer than the former four second limit', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => process.exit(0), 4200)); console.log('ready')",
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )
  await once(child.stdout!, 'data')
  const handle = ownedHandle(child)
  const closing = backend.stopBackend(handle)
  assert.equal(backend.stopBackend(handle), closing)
  await closing
  assert.equal(child.exitCode, 0)
  assert.equal(child.signalCode, null)
})

test('failed exit allows ordinary cleanup but update rejects the cached failed result', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.stdin.resume(); process.stdin.on('end', () => process.exit(7)); console.log('ready')",
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )
  await once(child.stdout!, 'data')
  const handle = ownedHandle(child)
  const result = await backend.stopBackend(handle)
  assert.equal(result.kind, backend.BackendStopKind.FailedExit)
  assert.throws(() => backend.requireCleanBackendStop(result), /shutdown incomplete: code=7/)
  assert.equal(await backend.stopBackend(handle), result)
  assert.throws(() => backend.requireCleanBackendStop(result), /shutdown incomplete: code=7/)
})

test('backend stop retries a real owned child after its stop request fails', async (context) => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); console.log('ready')",
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  })
  await once(child.stdout!, 'data')
  const handle = ownedHandle(child)
  const request = context.mock.method(child.stdin!, 'end', () => {
    throw new Error('stop request failed')
  })
  await assert.rejects(backend.stopBackend(handle), /stop request failed/)
  assert.equal(child.exitCode, null)
  assert.equal(child.signalCode, null)
  request.mock.restore()
  const retry = backend.stopBackend(handle)
  assert.equal(backend.stopBackend(handle), retry)
  assert.equal((await retry).kind, backend.BackendStopKind.Clean)
  assert.equal(child.exitCode, 0)
})

// A controlled child keeps the OS-exit acknowledgement separate from kill().
// No real PID is signalled; the production stop deadline is advanced by the clock.
function delayedChild(context: TestContext) {
  const child = new childProcess.ChildProcess()
  Object.defineProperty(child, 'pid', { value: 12345 })
  child.stdin = new PassThrough()
  const kill = context.mock.method(child, 'kill', () => true)
  context.mock.timers.enable({ apis: ['setTimeout'] })
  return { child, kill, handle: ownedHandle(child) }
}

async function exhaustStop(context: TestContext, stop: Promise<unknown>) {
  const rejected = assert.rejects(stop, /child did not exit after SIGKILL/)
  context.mock.timers.runAll()
  context.mock.timers.runAll()
  await rejected
}

test('backend stop retries after timeout and a late forced exit, preserving update rejection', async (context) => {
  const { child, kill, handle } = delayedChild(context)
  const first = backend.stopBackend(handle)
  assert.equal(backend.stopBackend(handle), first)
  await exhaustStop(context, first)
  assert.equal(kill.mock.callCount(), 1)
  Object.defineProperty(child, 'signalCode', { value: 'SIGKILL' })
  child.emit('exit', null, 'SIGKILL')
  const retry = backend.stopBackend(handle)
  assert.notEqual(retry, first)
  assert.equal(backend.stopBackend(handle), retry)
  const result = await retry
  assert.equal(result.kind, backend.BackendStopKind.FailedExit)
  assert.throws(() => backend.requireCleanBackendStop(result), /shutdown incomplete/)
  assert.equal(backend.stopBackend(handle), retry)
  assert.equal(kill.mock.callCount(), 1)
})

test('backend stop retries still wait for exit and propagate another timeout', async (context) => {
  const { child, kill, handle } = delayedChild(context)
  const first = backend.stopBackend(handle)
  await exhaustStop(context, first)
  const second = backend.stopBackend(handle)
  assert.notEqual(second, first)
  assert.equal(backend.stopBackend(handle), second)
  await exhaustStop(context, second)
  assert.equal(kill.mock.callCount(), 2)
  assert.equal(child.exitCode, null)
  assert.equal(child.signalCode, null)
  const third = backend.stopBackend(handle)
  Object.defineProperty(child, 'exitCode', { value: 0 })
  child.emit('exit', 0, null)
  assert.equal((await third).kind, backend.BackendStopKind.Clean)
})

test('backend stop retries resource cleanup without treating an exited child as fully drained', async () => {
  const child = new childProcess.ChildProcess()
  Object.defineProperty(child, 'pid', { value: 12345 })
  Object.defineProperty(child, 'exitCode', { value: 0 })
  const handle = ownedHandle(child)
  let attempts = 0
  handle.agentTransport = {
    async close() {
      if (++attempts < 3) throw new Error('transport still draining')
    },
  } as NonNullable<typeof handle.agentTransport>
  await assert.rejects(backend.stopBackend(handle), /transport still draining/)
  await assert.rejects(backend.stopBackend(handle), /transport still draining/)
  const result = await backend.stopBackend(handle)
  assert.equal(attempts, 3)
  assert.equal(result.kind, backend.BackendStopKind.Clean)
  assert.equal(await backend.stopBackend(handle), result)
  assert.equal(attempts, 3)
})

test('backend preserves the default project seed and independently decodes UTF-8 fragments', async (context) => {
  const entry = new URL('./backend.ts?stream-contract', import.meta.url).href
  const replacements = new Map([
    ['./resources.ts', `export const applicationResources = () => ${JSON.stringify(directory)};`],
    ['./source.ts', 'export const captureSourceBaseline = async () => undefined;'],
    [
      '../../../../scripts/shared/python.cjs',
      `export const verifyDevelopmentPythonAsync = async () => ({ python: '3.12', sqlite: '3', base_prefix: ${JSON.stringify(directory)}, scripts: ${JSON.stringify(directory)} });`,
    ],
    ['../../runtime/python.cjs', 'export const writeSkillPythonLauncher = () => {};'],
    [
      '../../runtime/codex.cjs',
      `export const resolveVendoredCodex = async () => ({ path: ${JSON.stringify(process.execPath)} });`,
    ],
    [
      '../../runtime/texlive.cjs',
      'export const vendoredTexliveLocation = () => { throw new Error("no TeX needed for output contract"); };',
    ],
    [
      './storage',
      `export const desktopHome = () => ${JSON.stringify(directory)}; export const desktopStorage = () => ({ home: ${JSON.stringify(directory)}, workspace: ${JSON.stringify(directory)}, createWorkspace: false });`,
    ],
    ['./writer', 'export const desktopDirectoryWriter = () => ({ close() {} });'],
  ])
  const fixture = registerHooks({
    resolve(specifier, resolveContext, nextResolve) {
      if (resolveContext.parentURL !== entry) return nextResolve(specifier, resolveContext)
      const replacement = replacements.get(specifier)
      const resolved = new URL(extname(specifier) ? specifier : `${specifier}.ts`, import.meta.url)
      return replacement
        ? {
            url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(resolved.href)}; ${replacement}`)}`,
            shortCircuit: true,
          }
        : specifier.startsWith('.') && !extname(specifier)
          ? nextResolve(resolved.href, resolveContext)
          : nextResolve(specifier, resolveContext)
    },
  })
  const originalEnvironment = { ...process.env }
  const output: string[] = []
  let serveArgs: readonly string[] = []
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = new childProcess.ChildProcess()
  Object.defineProperties(child, {
    stdin: { value: new PassThrough() },
    stdout: { value: stdout },
    stderr: { value: stderr },
  })
  let releaseHealth!: (response: Response) => void
  context.mock.method(
    globalThis,
    'fetch',
    () =>
      new Promise<Response>((resolve) => {
        releaseHealth = resolve
      })
  )
  const spawning = context.mock.method(
    childProcess,
    'spawn',
    (_command: string, args?: readonly string[]) => {
      if (args?.includes('--parent-stdin')) {
        serveArgs = args
        return child
      }
      const probe = new childProcess.ChildProcess()
      Object.defineProperty(probe, 'stdin', { value: new PassThrough() })
      queueMicrotask(() => {
        probe.emit('error', new Error('probe not part of stream contract'))
        probe.emit('close', 1, null)
      })
      return probe
    }
  )
  syncBuiltinESMExports()
  process.env.SCHOLARSEED_PYTHON = process.execPath
  process.env.SCHOLARSEED_REPO = directory
  let handle: BackendHandle | undefined
  let streaming: typeof backend | undefined
  try {
    streaming = (await import(entry)) as typeof backend
    handle = streaming.startBackend((line) => output.push(line), {
      port: 0,
      defaultProjectName: 'Default Project',
    })
    while (!handle.proc && !handle.error)
      await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(handle.proc, child, output.join(''))
    const seedFlag = serveArgs.indexOf('--default-project-name')
    assert.notEqual(seedFlag, -1)
    assert.equal(serveArgs[seedFlag + 1], 'Default Project')
    const expectedOut = 'stdout: 中文目录 😀\n'
    const expectedErr = 'stderr: 编译失败 🚀\n'
    const outBytes = Buffer.from(expectedOut)
    const errBytes = Buffer.from(expectedErr)
    const firstOutput = output.length
    let decodedOut = ''
    let decodedErr = ''
    const delivered = (bytes: Buffer, stream: PassThrough): string => {
      const before = output.length
      stream.write(bytes)
      return output
        .slice(before)
        .filter((line) => !line.startsWith('[startup]'))
        .join('')
    }
    for (let index = 0; index < Math.max(outBytes.length, errBytes.length); index++) {
      if (index < outBytes.length)
        decodedOut += delivered(outBytes.subarray(index, index + 1), stdout)
      if (index < errBytes.length)
        decodedErr += delivered(errBytes.subarray(index, index + 1), stderr)
    }
    const outEnded = once(stdout, 'end')
    const errEnded = once(stderr, 'end')
    stdout.end()
    stderr.end()
    await Promise.all([outEnded, errEnded])
    assert.equal(decodedOut, expectedOut)
    assert.equal(decodedErr, expectedErr)
    const expected = output
      .slice(firstOutput)
      .filter((line) => !line.startsWith('[startup]'))
      .join('')
    assert.doesNotMatch(expected, /\uFFFD/)
    Object.defineProperty(child, 'exitCode', { value: 7 })
    child.emit('exit', 7, null)
    child.emit('close', 7, null)
    assert.equal(await handle.ready, false)
    assert.equal(handle.error?.kind, 'exited')
    assert.equal(
      handle.error && 'detail' in handle.error ? handle.error.detail : null,
      expected.trim()
    )
  } finally {
    releaseHealth?.({
      ok: true,
      json: async () => ({ ok: true, features: { browser: false } }),
    } as Response)
    if (handle?.proc) {
      if (child.exitCode === null) {
        stdout.end()
        stderr.end()
        Object.defineProperty(child, 'exitCode', { value: 7 })
        child.emit('exit', 7, null)
        child.emit('close', 7, null)
      }
      await streaming?.stopBackend(handle)
    }
    spawning.mock.restore()
    syncBuiltinESMExports()
    fixture.deregister()
    for (const key of Object.keys(process.env))
      if (!(key in originalEnvironment)) delete process.env[key]
    Object.assign(process.env, originalEnvironment)
  }
})

test.after(() => {
  hooks.deregister()
  rmSync(directory, { recursive: true, force: true })
})

test('all startup consumers share one immutable product snapshot after the file changes', () => {
  const config = backend.resolveProductConfig(() => undefined)
  assert.equal(config.features.browser, false)
  writeFileSync(
    manifestPath,
    JSON.stringify({ ...manifest, features: { ...manifest.features, browser: true } })
  )
  assert.equal(
    backend.resolveProductConfig(() => undefined),
    config
  )
  assert.equal(backend.resolveProductConfig(() => undefined).features.browser, false)
  assert.equal(Object.isFrozen(config.features), true)
})

test('readiness policy errors fail immediately rather than being swallowed as health timeout', async () => {
  const original = globalThis.fetch
  let attempts = 0
  globalThis.fetch = async () => {
    attempts += 1
    return { ok: true, json: async () => ({ ok: true, features: { browser: true } }) } as Response
  }
  try {
    await assert.rejects(
      backend.waitForHealth('http://127.0.0.1', 100, () => undefined),
      /browser_feature_policy_mismatch/
    )
    assert.equal(attempts, 1)
    const logs: string[] = []
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) }) as Response
    assert.equal(
      await backend.waitForHealth('http://127.0.0.1', 100, (line) => logs.push(line), 'attach'),
      true
    )
    assert.match(logs.join(''), /remote unknown, local browser disabled/)
  } finally {
    globalThis.fetch = original
  }
})

test('packaged Windows resolves versioned components and does not expand files in backend startup', async () => {
  const { app } = await import('electron')
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  const mutableApp = app as unknown as { isPackaged: boolean; getAppPath(): string }
  const originalAppPath = mutableApp.getAppPath
  mutableApp.isPackaged = true
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  const current = join(directory, 'current')
  mutableApp.getAppPath = () => join(current, 'resources', 'app.asar')
  const components = join(current, 'resources', 'components')
  mkdirSync(components, { recursive: true })
  const runtimeManifest = {
    schema: 1,
    domain: 'scholarseed.runtime-components',
    product_id: 'scholarseed',
    bundle_id: 'com.scholarseed.desktop',
    app_id: 'scholarseed',
    target: 'win32-x86_64',
    components: RUNTIME_COMPONENT_KINDS.map((kind) => ({
      kind,
      version: '1.0.0-r1',
      contentId: 'a'.repeat(64),
      archive: `${kind}.zip`,
      archiveSha256: 'b'.repeat(64),
      archiveBytes: 1,
      expandedBytes: 1,
      fileCount: 1,
      entry: RUNTIME_ENTRIES[kind],
      files: [
        {
          path:
            kind === 'texlive' ? `${RUNTIME_ENTRIES[kind]}/kpsewhich.exe` : RUNTIME_ENTRIES[kind],
          size: 1,
          sha256: 'c'.repeat(64),
        },
      ],
    })),
  }
  writeFileSync(
    join(components, 'runtime.json'),
    JSON.stringify({
      schema: 1,
      key_id: '',
      signature: '',
      manifest: Buffer.from(JSON.stringify(runtimeManifest)).toString('base64'),
    })
  )
  Object.defineProperty(process, 'resourcesPath', {
    value: join(directory, 'runtime', 'electron', '44.3.0-r1', 'resources'),
    configurable: true,
  })
  const originalPython = process.env.SCHOLARSEED_PYTHON
  delete process.env.SCHOLARSEED_PYTHON
  try {
    const logs: string[] = []
    const diagnosticPath = join(directory, 'startup.log')
    const lifecycle = new RotatingFileLog(diagnosticPath)
    const handle = backend.startBackend((line) => logs.push(line), {
      port: 0,
      lifecycleLog: (line) => lifecycle.write(line),
    })
    assert.equal(await handle.ready, false)
    const pythonRoot = join(directory, 'runtime', 'python', '1.0.0-r1', 'python')
    assert.deepEqual(handle.error, {
      kind: 'pythonMissing',
      path: toNamespacedPath(join(pythonRoot, 'python.exe')),
    })
    assert.equal(handle.proc, null)
    assert.equal(backend.runtimeStoreRoot(), join(directory, 'runtime'))
    assert.equal(existsSync(join(directory, 'runtime')), false)
    assert.match(logs.join(''), /python not found/)
    mkdirSync(pythonRoot, { recursive: true })
    writeFileSync(join(pythonRoot, 'python.exe'), '')
    const damaged = backend.startBackend(
      (line) => {
        if (line.startsWith('[backend-startup]')) throw new Error('stdout unavailable')
      },
      { port: 0, lifecycleLog: (line) => lifecycle.write(line) }
    )
    assert.equal(await damaged.ready, false)
    assert.equal(damaged.error?.kind, 'startupFailed')
    assert.match(JSON.stringify(damaged.error), /powershell.*pwsh/)
    assert.equal(damaged.proc, null)
    await lifecycle.end()
    const entries = readFileSync(diagnosticPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line.slice('[backend-startup] '.length)))
    const failures = entries.filter((entry) => entry.event === 'failed')
    assert.equal(failures.length, 2)
    assert.equal(failures[0].phase, 'python-entry')
    assert.equal(failures[0].failure, 'pythonMissing')
    assert.equal(failures[1].phase, 'runtime-entries')
    assert.equal(failures[1].failure, 'startupFailed')
    assert.equal(failures[1].backendPid, null)
    assert.equal(failures[1].error.code, 'ENOENT')
    assert.match(failures[1].error.stack, /powershell.*pwsh/)
    assert.notEqual(failures[0].attemptId, failures[1].attemptId)
    for (const failure of failures) {
      assert.ok(failure.elapsedMs >= failure.phaseElapsedMs)
      assert.ok(
        entries.some(
          (entry) =>
            entry.event === 'started' &&
            entry.attemptId === failure.attemptId &&
            entry.phase === failure.phase
        )
      )
    }
  } finally {
    mutableApp.isPackaged = false
    mutableApp.getAppPath = originalAppPath
    Object.defineProperty(process, 'platform', originalPlatform)
    if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources)
    else delete (process as unknown as { resourcesPath?: string }).resourcesPath
    if (originalPython === undefined) delete process.env.SCHOLARSEED_PYTHON
    else process.env.SCHOLARSEED_PYTHON = originalPython
  }
})

test('managed startup uses basic health while attach preserves complete diagnostics', async () => {
  const original = globalThis.fetch
  const endpoints: string[] = []
  globalThis.fetch = async (input) => {
    endpoints.push(String(input))
    return {
      ok: true,
      json: async () => ({ ok: true, features: { browser: false } }),
    } as Response
  }
  try {
    assert.equal(await backend.waitForHealth('http://127.0.0.1', 100, () => undefined), true)
    assert.equal(
      await backend.waitForHealth('http://127.0.0.1', 100, () => undefined, 'attach'),
      true
    )
    assert.deepEqual(endpoints, [
      'http://127.0.0.1/api/healthz/backend',
      'http://127.0.0.1/api/healthz',
    ])
  } finally {
    globalThis.fetch = original
  }
})

test(
  'TeX resolution failure reaches the durable lifecycle sink before backend spawn',
  {
    skip: process.platform !== 'darwin',
  },
  async () => {
    const { app } = await import('electron')
    const mutableApp = app as unknown as { isPackaged: boolean }
    const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    const originalPython = process.env.SCHOLARSEED_PYTHON
    const file = join(directory, 'tex-preparation.log')
    mutableApp.isPackaged = true
    Object.defineProperty(process, 'resourcesPath', { value: directory, configurable: true })
    // Node is deliberately not a valid bundled Python. The earlier TeX resolution
    // must still be recorded, even when startup never gets as far as spawning Serve.
    process.env.SCHOLARSEED_PYTHON = process.execPath
    try {
      const transient: string[] = []
      const handle = backend.startBackend((line) => transient.push(line), {
        port: 0,
        lifecycleLog: (line) => appendFileSync(file, line),
      })
      assert.equal(await handle.ready, false)
      assert.equal(handle.proc, null)
      const saved = readFileSync(file, 'utf8')
      assert.match(saved, /TeX preparation started/)
      assert.match(saved, /ERROR TeX preparation failed.*xelatex/)
      for (const line of saved.trim().split('\n')) assert.ok(transient.join('').includes(line))
    } finally {
      mutableApp.isPackaged = false
      if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources)
      else delete (process as unknown as { resourcesPath?: string }).resourcesPath
      if (originalPython === undefined) delete process.env.SCHOLARSEED_PYTHON
      else process.env.SCHOLARSEED_PYTHON = originalPython
    }
  }
)
