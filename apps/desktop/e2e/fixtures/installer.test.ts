import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installFromArtifact, installerSha256, selectMacApp } from './installer.ts'

test('DMG must contain exactly the named application', () => {
  assert.equal(selectMacApp(['ScholarSeed.app', 'Applications']), 'ScholarSeed.app')
  assert.throws(() => selectMacApp(['Applications']), /exactly one/)
  assert.throws(() => selectMacApp(['ScholarSeed.app', 'Other.app']), /exactly one/)
})

test('installer digest changes with installer bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'installer-digest-test-'))
  try {
    const installer = join(directory, 'product.dmg')
    writeFileSync(installer, 'original')
    assert.equal(installerSha256(installer), createHash('sha256').update('original').digest('hex'))
    writeFileSync(installer, 'changed')
    assert.notEqual(installerSha256(installer), createHash('sha256').update('original').digest('hex'))
    assert.throws(() => installFromArtifact(installer, directory,
      createHash('sha256').update('original').digest('hex')), /SHA-256 changed/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a mountable empty DMG fails during installed-app selection', {
  skip: process.platform !== 'darwin'
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'empty-dmg-test-'))
  try {
    const installer = join(directory, 'empty.dmg')
    const source = join(directory, 'empty-source')
    mkdirSync(source)
    execFileSync('hdiutil', ['create', '-srcfolder', source, '-volname', 'Empty',
      '-format', 'UDZO', installer])
    assert.throws(() => installFromArtifact(installer, directory, installerSha256(installer)),
      /exactly one ScholarSeed.app/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
