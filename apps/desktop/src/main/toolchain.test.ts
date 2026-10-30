import assert from 'node:assert/strict'
import test from 'node:test'
import { bundledToolResources } from './toolchain.ts'

const bin = 'C:\\Users\\test\\AppData\\Local\\Programs\\ScholarSeed\\resources\\backend\\bin'
const python = 'C:\\Users\\test\\.scholarseed\\runtime\\python\\reviewed\\python\\python.exe'
const libraries =
  'C:\\Users\\test\\AppData\\Local\\Programs\\ScholarSeed\\resources\\backend\\pylibs'

test('component layout declares only launcher, selected Python and frozen libraries', () => {
  assert.deepEqual(JSON.parse(bundledToolResources('win32', bin, python, libraries)), [
    { kind: 'launchers', path: bin },
    { kind: 'python', path: python.slice(0, -'\\python.exe'.length) },
    { kind: 'libraries', path: libraries },
  ])
})

test('flat package does not invent a pylibs root', () => {
  assert.equal(JSON.parse(bundledToolResources('win32', bin, python)).length, 2)
})

test('macOS does not project a Windows ACL declaration', () => {
  assert.equal(bundledToolResources('darwin', '/bundle/bin', '/bundle/python/bin/python3'), '')
})

test('relative roots, drive roots and unknown interpreter are rejected', () => {
  for (const bad of ['bin', 'C:\\']) assert.throws(() => bundledToolResources('win32', bad, python))
  assert.throws(() => bundledToolResources('win32', bin, 'C:\\custom\\tool.exe'))
})

test('Windows execution closure includes PowerShell, Node engine and TeX data', () => {
  const components = {
    powershell: 'C:\\App\\runtime\\powershell\\reviewed\\powershell\\pwsh.exe',
    electron: 'C:\\App\\runtime\\electron\\reviewed\\ScholarSeedEngine.exe',
    texlive: 'C:\\App\\runtime\\texlive\\reviewed\\texlive\\bin\\windows',
  }
  const resources = JSON.parse(bundledToolResources('win32', bin, python, libraries, components))
  assert.deepEqual(resources.slice(3), [
    { kind: 'powershell', path: 'C:\\App\\runtime\\powershell\\reviewed\\powershell' },
    { kind: 'electron', path: 'C:\\App\\runtime\\electron\\reviewed' },
    { kind: 'texlive', path: 'C:\\App\\runtime\\texlive\\reviewed\\texlive' },
  ])
})
