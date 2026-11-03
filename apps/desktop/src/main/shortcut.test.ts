import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cleanupNotificationShortcut,
  isLegacyNotificationShortcut,
  type ShortcutFiles,
} from './shortcut.ts'
const launcher = String.raw`C:\Users\a\AppData\Local\scholarseed\current\ScholarSeed.exe`
const engine = String.raw`C:\Users\a\AppData\Local\scholarseed\runtime\electron\44.3.0-r1\ScholarSeedEngine.exe`
const programs = String.raw`C:\Users\a\AppData\Roaming\Microsoft\Windows\Start Menu\Programs`
const id = 'velopack.scholarseed'
const legacy = { target: engine, args: '', appUserModelId: id }
const installed = { target: launcher, args: '', appUserModelId: id }
test('matches only this installation engine and installer identity', () => {
  assert.equal(isLegacyNotificationShortcut(legacy, installed, launcher), true)
  assert.equal(
    isLegacyNotificationShortcut({ ...legacy, target: engine.toUpperCase() }, installed, launcher),
    true
  )
  for (const change of [
    { appUserModelId: 'foreign' },
    { args: '--app other' },
    { target: engine.replace('Local', 'Local2') },
    { target: engine.replace('ScholarSeedEngine.exe', 'electron.exe') },
    { target: launcher },
    { target: String.raw`D:\ScholarSeedEngine.exe` },
    { target: engine.replace('44.3.0-r1', '..') },
  ])
    assert.equal(isLegacyNotificationShortcut({ ...legacy, ...change }, installed, launcher), false)
  for (const change of [
    { appUserModelId: 'foreign' },
    { args: '--profile other' },
    { target: engine },
  ])
    assert.equal(isLegacyNotificationShortcut(legacy, { ...installed, ...change }, launcher), false)
})
function fixture() {
  const removed: string[] = []
  const io: ShortcutFiles = {
    physical: (p) => p,
    read: (p) => Buffer.from(p),
    regular: () => true,
    remove: (p) => removed.push(p),
  }
  const shell = {
    readShortcutLink: (p: string) => (p.endsWith('Electron.lnk') ? legacy : installed),
  }
  return { removed, io, shell }
}
test('removes only exact legacy shortcut after confirming stable launcher', () => {
  const f = fixture()
  assert.equal(cleanupNotificationShortcut(programs, launcher, f.shell, f.io), 'removed')
  assert.deepEqual(f.removed, [programs + '\\Electron.lnk'])
})
test('preserves links with redirected directories, targets or nonregular files', () => {
  for (const redirected of [programs, launcher, engine, programs + '\\Electron.lnk']) {
    const f = fixture()
    f.io.physical = (p) => (p === redirected ? 'D:\\foreign' : p)
    assert.equal(cleanupNotificationShortcut(programs, launcher, f.shell, f.io), 'preserved')
    assert.deepEqual(f.removed, [])
  }
  const f = fixture()
  f.io.regular = () => false
  assert.equal(cleanupNotificationShortcut(programs, launcher, f.shell, f.io), 'preserved')
})
test('changed shortcut bytes are not deleted', () => {
  const f = fixture()
  let n = 0
  f.io.read = () => Buffer.from(String(n++))
  assert.equal(cleanupNotificationShortcut(programs, launcher, f.shell, f.io), 'preserved')
  assert.deepEqual(f.removed, [])
})
test('missing shortcuts are harmless, access errors are not hidden', () => {
  const f = fixture()
  f.io.read = () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  }
  assert.equal(cleanupNotificationShortcut(programs, launcher, f.shell, f.io), 'absent')
  f.io.regular = () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' })
  }
  assert.throws(() => cleanupNotificationShortcut(programs, launcher, f.shell, f.io), /denied/)
})

test('upgrade cleans an owned link to a removed engine version', () => {
  const f = fixture()
  f.io.physical = (p) => {
    if (p === engine || p === engine.slice(0, engine.lastIndexOf('\\')))
      throw Object.assign(new Error('old version removed'), { code: 'ENOENT' })
    return p
  }
  assert.equal(cleanupNotificationShortcut(programs, launcher, f.shell, f.io), 'removed')
})
