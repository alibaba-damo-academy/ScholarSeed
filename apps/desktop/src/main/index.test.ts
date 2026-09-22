import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

test('pushLog does not send IPC through disposed renderer webContents', () => {
  assert.match(
    source,
    /mainWindow\s*&&\s*!mainWindow\.isDestroyed\(\)\s*&&\s*!mainWindow\.webContents\.isDestroyed\(\)/
  )
})
