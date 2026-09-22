import assert from 'node:assert/strict'
import test from 'node:test'

import { SKILL_CATALOG_CHANGED_EVENT } from '../../../../skills.ts'
import { watchAccountAccess } from './access.ts'

test('account access updates existing subscribers and ignores a stale login response after logout', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  const target = Object.assign(new EventTarget(), { scholarseed: { getApiBase: () => '' } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target })
  const requests: Array<(response: Response) => void> = []
  globalThis.fetch = () => new Promise<Response>((resolve) => requests.push(resolve))
  const snapshots: Array<{ authenticated: boolean; revision: number }> = []
  const settle = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)) }
  const respond = (index: number, auth: boolean): void => requests[index](new Response(JSON.stringify({ auth })))
  const stop = watchAccountAccess(true, (snapshot) => snapshots.push(snapshot))
  try {
    assert.equal(snapshots.at(-1)?.authenticated, false)
    target.dispatchEvent(new Event('scholarseed:auth-required'))
    respond(0, true)
    await settle()
    assert.equal(snapshots.at(-1)?.authenticated, false)
    target.dispatchEvent(new Event('scholarseed:auth-restored'))
    respond(1, true)
    await settle()
    assert.equal(snapshots.at(-1)?.authenticated, true)
    const revision = snapshots.at(-1)!.revision
    target.dispatchEvent(new Event(SKILL_CATALOG_CHANGED_EVENT))
    assert.equal(snapshots.at(-1)?.authenticated, true)
    assert.ok(snapshots.at(-1)!.revision > revision)
    target.dispatchEvent(new Event('scholarseed:auth-required'))
    assert.equal(snapshots.at(-1)?.authenticated, false)
    stop()
    const count = snapshots.length
    target.dispatchEvent(new Event('scholarseed:auth-restored'))
    assert.equal(snapshots.length, count)
  } finally {
    stop()
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
