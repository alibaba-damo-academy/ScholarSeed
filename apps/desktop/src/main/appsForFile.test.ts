import assert from 'node:assert/strict'
import childProcess, { type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { appsForFile, openPathWith } from './appsForFile.ts'

test('open-with preserves application names and paths across every UTF-8 byte boundary', async (context) => {
  const application = { name: '书深 😀', path: '/Applications/书深 😀.app', isDefault: true }
  const payload = Buffer.from(JSON.stringify({ default: application.path, apps: [application] }))
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
  const spawning = context.mock.method(childProcess, 'spawn', () => {
    queueMicrotask(() => {
      for (const byte of payload) child.stdout.write(Buffer.from([byte]))
      child.stdout.end()
      setImmediate(() => child.emit('close', 0))
    })
    return child as unknown as ChildProcess
  })
  syncBuiltinESMExports()
  try {
    assert.deepEqual(await appsForFile('/中文目录/论文.pdf'), [application])
  } finally {
    spawning.mock.restore()
    syncBuiltinESMExports()
  }
})

test('open-with retains a Unicode launch failure split across stderr chunks', async (context) => {
  const diagnostic = '无法打开中文目录中的文件 😀'
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
  const spawning = context.mock.method(childProcess, 'spawn', () => {
    queueMicrotask(() => {
      for (const byte of Buffer.from(diagnostic)) child.stderr.write(Buffer.from([byte]))
      child.stderr.end()
      setImmediate(() => child.emit('close', 1))
    })
    return child as unknown as ChildProcess
  })
  syncBuiltinESMExports()
  try {
    assert.deepEqual(await openPathWith('/中文目录/论文.pdf', '/Applications/书深.app'), {
      ok: false,
      error: diagnostic,
    })
  } finally {
    spawning.mock.restore()
    syncBuiltinESMExports()
  }
})
