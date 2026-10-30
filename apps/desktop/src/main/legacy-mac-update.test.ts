import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  confirmLegacyMacUpdate,
  pendingLegacyMacUpdateToken,
  resourceDirectoryChanged,
  resourceDirectoryIdentity,
  watchResourceDirectory,
} from './legacy-mac-update.ts'

test('legacy macOS token writes the exact confirmation file expected by the old installer', () => {
  const home = mkdtempSync(join(tmpdir(), 'scholarseed-legacy-update-'))
  const token = randomUUID()
  try {
    assert.equal(
      pendingLegacyMacUpdateToken(['ScholarSeed', `--scholarseed-update-token=${token}`]),
      token
    )
    assert.equal(pendingLegacyMacUpdateToken(['ScholarSeed']), null)
    assert.throws(() => pendingLegacyMacUpdateToken(['--scholarseed-update-token=../wrong']))
    assert.throws(() =>
      pendingLegacyMacUpdateToken([
        `--scholarseed-update-token=${token}`,
        `--scholarseed-update-token=${token}`,
      ])
    )
    const path = confirmLegacyMacUpdate(home, token, '0.2.0')
    assert.equal(path, join(home, 'updates', `confirmed-${token}`))
    assert.equal(readFileSync(path, 'utf8'), '0.2.0\n')
    assert.throws(() => confirmLegacyMacUpdate(home, token, '0.2.0'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test(
  'resource watcher detects an installed App replaced while its process remains alive',
  {
    skip: process.platform !== 'darwin',
  },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'scholarseed-resource-'))
    const resources = join(root, 'ScholarSeed.app', 'Contents', 'Resources')
    const moved = join(root, 'ScholarSeed.app.scholarseed-failed', 'Contents')
    mkdirSync(resources, { recursive: true })
    let stop = () => {}
    try {
      const original = resourceDirectoryIdentity(resources)
      assert.equal(resourceDirectoryChanged(resources, original), false)
      const changed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('resource replacement was not detected')),
          2_000
        )
        stop = watchResourceDirectory(resources, () => {
          clearTimeout(timeout)
          resolve()
        })
      })
      renameSync(join(root, 'ScholarSeed.app'), join(root, 'ScholarSeed.app.scholarseed-failed'))
      mkdirSync(resources, { recursive: true })
      assert.equal(existsSync(join(moved, 'Resources')), true)
      assert.equal(resourceDirectoryChanged(resources, original), true)
      await changed
    } finally {
      stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
