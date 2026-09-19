import assert from 'node:assert/strict'
import test from 'node:test'
import { writeClipboard } from './clipboard.ts'

test('clipboard uses the desktop bridge and reports real native failures', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  try {
    let nativeText = '', browserText = ''
    const bridge = { writeClipboard: async (text: string) => { nativeText = text; return { ok: true } } }
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { scholarseed: bridge } })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text: string) => { browserText = text } } } })
    await writeClipboard('figure explanation')
    assert.equal(nativeText, 'figure explanation')
    assert.equal(browserText, '')
    bridge.writeClipboard = async () => ({ ok: false })
    await assert.rejects(writeClipboard('failed'), /clipboard_write_failed/)
    assert.equal(browserText, '')
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
    await writeClipboard('browser explanation')
    assert.equal(browserText, 'browser explanation')
  } finally {
    for (const [key, descriptor] of [['window', originalWindow], ['navigator', originalNavigator]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
