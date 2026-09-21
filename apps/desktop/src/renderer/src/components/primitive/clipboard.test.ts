import assert from 'node:assert/strict'
import test from 'node:test'
import { writeClipboard, writeClipboardContent } from './clipboard.ts'

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

test('rich clipboard sends Markdown and previewable HTML through the desktop bridge', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  try {
    let received: { text: string; html: string } | undefined
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        scholarseed: {
          writeClipboardContent: async (payload: typeof received) => {
            received = payload
            return { ok: true }
          }
        }
      }
    })
    await writeClipboardContent('# 报告', '<h1>报告</h1>')
    assert.deepEqual(received, { text: '# 报告', html: '<h1>报告</h1>' })
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
