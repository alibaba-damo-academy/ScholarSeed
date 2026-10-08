import assert from 'node:assert/strict'
import { test } from 'node:test'

import { requireCommandAsync, runCommandAsync } from './subprocess.ts'

// bug 87253073：外部命令挂起时安装链无限等待。超时与取消是这条不变量的强制层，
// 这里用一条真的不退出的子进程证明上限生效、子进程被回收。
const HANG_SECONDS = '30'
const SUCCESS_COMMAND_TIMEOUT_MS = 15_000

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
