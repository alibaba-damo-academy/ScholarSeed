import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { TestContext } from 'node:test'
import type { ElectronApplication } from '@playwright/test'

type Acquisition = { ok: true; application: ElectronApplication } | { ok: false; error: unknown }
const CLOSE_GRACE_MS = 5_000
const run = promisify(execFile)

async function closeApplication(application: ElectronApplication) {
  const timer = new AbortController()
  try {
    const result = await Promise.race([
      application.close().then(() => 'closed'),
      setTimeout(CLOSE_GRACE_MS, 'expired', { signal: timer.signal, ref: false }),
    ])
    if (result === 'closed') return
    const child = application.process()
    const pid = child.pid
    if (!pid || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(CLOSE_GRACE_MS) })
    const kill = async () => {
      if (process.platform === 'win32') {
        await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: CLOSE_GRACE_MS })
      } else {
        // Playwright starts Electron as the leader of a dedicated process group.
        process.kill(-pid, 'SIGKILL')
      }
    }
    await Promise.all([
      exited,
      kill().catch((error) => {
        if (child.exitCode === null && child.signalCode === null) throw error
      }),
    ])
  } finally {
    timer.abort()
  }
}

export function nativeFixture(
  context: Pick<TestContext, 'after' | 'signal'>,
  cleanup: () => void | Promise<void>
) {
  let acquisition: Promise<Acquisition> | undefined
  let closing: Promise<void> | undefined

  async function release() {
    const result = await acquisition
    if (result?.ok) await closeApplication(result.application)
    for (let attempt = 0; ; attempt++) {
      try {
        await cleanup()
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (
          process.platform !== 'win32' ||
          attempt === 5 ||
          !['EBUSY', 'EPERM'].includes(code ?? '')
        )
          throw error
        await setTimeout(100 * (attempt + 1))
      }
    }
  }

  function close() {
    closing ??= release()
    return closing
  }

  context.after(close)
  context.signal.addEventListener('abort', () => void close().catch(() => {}), { once: true })

  return {
    async launch(create: () => Promise<ElectronApplication>) {
      context.signal.throwIfAborted()
      assert.equal(acquisition, undefined, 'native fixture already acquired')
      assert.equal(closing, undefined, 'native fixture already closing')
      acquisition = Promise.resolve()
        .then(create)
        .then(
          (application) => ({ ok: true, application }),
          (error) => ({ ok: false, error })
        )
      const result = await acquisition
      if (!result.ok) throw result.error
      context.signal.throwIfAborted()
      assert.equal(closing, undefined, 'native fixture closed during acquisition')
      return result.application
    },
    close,
  }
}
