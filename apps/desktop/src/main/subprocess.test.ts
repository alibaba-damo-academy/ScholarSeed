import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import {
  requireCommandAsync,
  runCommandAsync,
  startDetachedProcess,
  stopChildProcess,
} from './subprocess.ts'

// bug 87253073：外部命令挂起时安装链无限等待。超时与取消是这条不变量的强制层，
// 这里用一条真的不退出的子进程证明上限生效、子进程被回收。
const HANG_SECONDS = '30'
const SUCCESS_COMMAND_TIMEOUT_MS = 15_000

test('detached handoff rejects an OS spawn failure', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'scholarseed-detached-missing-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  await assert.rejects(startDetachedProcess(join(directory, 'missing-helper'), []), {
    code: 'ENOENT',
  })
})

test('detached handoff observes creation without waiting for helper completion', async (t) => {
  const child = await startDetachedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  t.after(async () => {
    await stopChildProcess(child, 0)
  })
  assert.ok(child.pid)
  assert.equal(child.exitCode, null)
  assert.equal(child.signalCode, null)
  // The caller can now hand off ownership; spawn alone is not readiness.
  await stopChildProcess(child, 0)
  assert.ok(child.exitCode !== null || child.signalCode !== null)
})

test('owned pipe EOF requests graceful exit and stop still waits for cleanup', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'scholarseed-parent-stop-'))
  const marker = join(directory, 'closed')
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    process.stdin.resume();
    process.stdin.on('end', () => setTimeout(() => {
      require('node:fs').writeFileSync(process.argv[1], 'closed');
      process.exit(0);
    }, 100));
    process.send('ready');
  `,
      marker,
    ],
    { stdio: ['pipe', 'ignore', 'ignore', 'ipc'] }
  )
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    rmSync(directory, { recursive: true, force: true })
  })
  await once(child, 'message')
  let requests = 0
  const request = (): void => {
    requests++
    child.stdin!.end()
  }
  const stopping = stopChildProcess(child, SUCCESS_COMMAND_TIMEOUT_MS, request)
  assert.equal(stopChildProcess(child, SUCCESS_COMMAND_TIMEOUT_MS, request), stopping)
  assert.equal(existsSync(marker), false)
  await stopping
  assert.equal(requests, 1)
  assert.equal(child.exitCode, 0)
  assert.equal(child.signalCode, null)
  assert.equal(readFileSync(marker, 'utf8'), 'closed')
})

test('stopChildProcess shares the stop operation and waits for the real child exit', async (t) => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    process.send('ready');
  `,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
  )
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  await once(child, 'message')
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  // killed becomes true now, even on POSIX where the child ignores SIGTERM.
  child.kill('SIGTERM')
  assert.equal(child.killed, true)
  const stopping = stopChildProcess(child, 100)
  assert.equal(stopChildProcess(child, 100), stopping)
  await stopping
  assert.equal(exited, true)
  if (process.platform !== 'win32') assert.equal(child.signalCode, 'SIGKILL')
  await stopChildProcess(child, 100)
})

test('stopChildProcess observes graceful exit without waiting for the force deadline', async (t) => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
    process.send('ready');
  `,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
  )
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  await once(child, 'message')
  await stopChildProcess(child, SUCCESS_COMMAND_TIMEOUT_MS)
  assert.ok(child.exitCode !== null || child.signalCode !== null)
  if (process.platform !== 'win32') assert.equal(child.exitCode, 0)
})

test('cancelled command rejects only after its owned process has exited', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'scholarseed-command-stop-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const pidFile = join(directory, 'pid')
  const controller = new AbortController()
  const pending = runCommandAsync(
    process.execPath,
    [
      '-e',
      `
    require('node:fs').writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 1000);
  `,
      pidFile,
    ],
    { signal: controller.signal, timeoutMs: SUCCESS_COMMAND_TIMEOUT_MS }
  )
  const result = assert.rejects(pending, /command aborted/)
  const deadline = Date.now() + SUCCESS_COMMAND_TIMEOUT_MS
  while (!existsSync(pidFile) && Date.now() < deadline) await delay(10)
  assert.equal(existsSync(pidFile), true)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  controller.abort()
  await result
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('runCommandAsync pipes input without a shell for the cancellable mount probe', async () => {
  const result = await runCommandAsync(
    process.execPath,
    ['-e', 'process.stdin.pipe(process.stdout)'],
    {
      input: '<plist>mount metadata</plist>',
      timeoutMs: SUCCESS_COMMAND_TIMEOUT_MS,
    }
  )
  assert.equal(result.stdout, '<plist>mount metadata</plist>')
  assert.equal(result.status, 0)
})

function hangCommand(): [string, string[]] {
  return [process.execPath, ['-e', `setTimeout(() => {}, ${HANG_SECONDS}000)`]]
}

test('runCommandAsync kills a hanging child once its timeout elapses', async () => {
  const [executable, args] = hangCommand()
  const startedAt = Date.now()
  await assert.rejects(
    () => runCommandAsync(executable, args, { timeoutMs: 300 }),
    /timed out after 300ms/
  )
  assert.ok(Date.now() - startedAt < 5000, 'timeout must bound the wait')
})

test('runCommandAsync rejects when the signal aborts mid-command', async () => {
  const [executable, args] = hangCommand()
  const controller = new AbortController()
  const pending = runCommandAsync(executable, args, { signal: controller.signal })
  setTimeout(() => controller.abort(), 150)
  await assert.rejects(() => pending, /command aborted/)
})

test('runCommandAsync rejects immediately for an already-aborted signal', async () => {
  const [executable, args] = hangCommand()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => runCommandAsync(executable, args, { signal: controller.signal }),
    /aborted before start/
  )
})

test('runCommandAsync still resolves successful output', async () => {
  // 成功路径的上限只防真挂起，不设贴边值：门禁并发下 node 启动抖动不该造成假失败。
  const result = await runCommandAsync(process.execPath, ['-e', 'process.stdout.write("ok\\n")'], {
    timeoutMs: SUCCESS_COMMAND_TIMEOUT_MS,
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'ok')
})

test('requireCommandAsync keeps fail-closed semantics and names the step', async () => {
  await assert.rejects(
    () =>
      requireCommandAsync(process.execPath, ['-e', 'process.exit(3)'], 'DMG verification', {
        timeoutMs: SUCCESS_COMMAND_TIMEOUT_MS,
      }),
    /DMG verification failed/
  )
})

test('requireCommandAsync reports the timed-out step by label', async () => {
  const [executable, args] = hangCommand()
  await assert.rejects(
    () => requireCommandAsync(executable, args, 'Gatekeeper assessment', { timeoutMs: 300 }),
    /Gatekeeper assessment failed: command timed out after 300ms/
  )
})
