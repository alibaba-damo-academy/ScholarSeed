import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import type { DomainNative } from '../../native/domains.cjs'
import { test } from 'node:test'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacyHome, transferLegacyHome } from './legacy.ts'

function homes(): { root: string; source: string; target: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ss-legacy-')))
  const source = join(root, 'old'),
    target = join(root, 'new')
  mkdirSync(source)
  mkdirSync(target)
  mkdirSync(join(source, 'nested'))
  writeFileSync(join(source, 'config.json'), '{"owned":true}')
  writeFileSync(join(source, 'nested', 'document.txt'), 'user document')
  return { root, source, target }
}

test('legacy transfer preserves source and never replays it over subsequent current writes', () => {
  const { root, source, target } = homes()
  try {
    assert.deepEqual(transferLegacyHome(source, target), { files: 2, resumed: false })
    assert.equal(readFileSync(join(source, 'nested', 'document.txt'), 'utf8'), 'user document')
    assert.equal(readFileSync(join(target, 'nested', 'document.txt'), 'utf8'), 'user document')
    writeFileSync(join(target, 'config.json'), '{"newPreferences":true}')
    assert.equal(transferLegacyHome(source, target), null)
    assert.equal(readFileSync(join(target, 'config.json'), 'utf8'), '{"newPreferences":true}')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('all destination collisions are checked before the first file copy', () => {
  const { root, source, target } = homes()
  try {
    mkdirSync(join(target, 'nested'))
    writeFileSync(join(target, 'nested', 'document.txt'), 'different current document')
    assert.throws(() => transferLegacyHome(source, target), /conflict/)
    assert.equal(existsSync(join(target, 'config.json')), false)
    assert.equal(existsSync(join(target, '.desktop-legacy-migration.json')), false)
    assert.equal(
      readFileSync(join(target, 'nested', 'document.txt'), 'utf8'),
      'different current document'
    )
    assert.equal(readFileSync(join(source, 'nested', 'document.txt'), 'utf8'), 'user document')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

for (const interrupted of ['copy', 'publication', 'source changed'] as const) {
  test(`legacy transfer recovers a recorded interruption: ${interrupted}`, () => {
    const { root, source, target } = homes()
    try {
      transferLegacyHome(source, target)
      const journal = join(target, '.desktop-legacy-migration.json')
      const record = JSON.parse(readFileSync(journal, 'utf8'))
      record.phase = 'copying'
      writeFileSync(journal, `${JSON.stringify(record)}\n`)
      if (interrupted === 'source changed') {
        writeFileSync(join(source, 'config.json'), 'later legacy changes')
        assert.throws(() => transferLegacyHome(source, target), /recovery record/)
        assert.equal(readFileSync(join(target, 'config.json'), 'utf8'), '{"owned":true}')
        return
      }
      const stage = join(target, `.desktop-legacy-stage-${record.id}-0`)
      if (interrupted === 'copy') {
        rmSync(join(target, 'config.json'))
        writeFileSync(stage, 'partial')
      } else {
        linkSync(join(target, 'config.json'), stage)
      }
      assert.deepEqual(transferLegacyHome(source, target), { files: 2, resumed: true })
      assert.equal(existsSync(stage), false)
      assert.equal(readFileSync(join(target, 'config.json'), 'utf8'), '{"owned":true}')
      assert.equal(readFileSync(join(source, 'config.json'), 'utf8'), '{"owned":true}')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

for (const mode of [
  'normal',
  'interrupted retirement',
  'new source file',
  'missing destination',
] as const) {
  test(`native legacy retirement: ${mode}`, async (t) => {
    const library = process.env.SCHOLARSEED_LEASE_LIBRARY
    if (!library) return t.skip('actual compiled directory library required')
    const native = createRequire(import.meta.url)(library) as DomainNative
    const { root, source, target } = homes()
    const coordinator = join(root, 'coordinator')
    try {
      if (mode !== 'normal') transferLegacyHome(source, target)
      if (mode === 'interrupted retirement') rmSync(join(source, 'config.json'))
      if (mode === 'new source file') {
        writeFileSync(join(source, 'new-user-file'), 'must survive')
        await assert.rejects(
          migrateLegacyHome(native, coordinator, source, target),
          /source changed/
        )
        assert.equal(readFileSync(join(source, 'new-user-file'), 'utf8'), 'must survive')
        assert.equal(existsSync(join(source, 'config.json')), true)
        return
      }
      if (mode === 'missing destination') {
        rmSync(join(target, 'nested', 'document.txt'))
        await assert.rejects(migrateLegacyHome(native, coordinator, source, target))
        assert.equal(readFileSync(join(source, 'nested', 'document.txt'), 'utf8'), 'user document')
        assert.equal(existsSync(join(source, 'config.json')), true)
        return
      }
      const result = await migrateLegacyHome(native, coordinator, source, target)
      assert.equal(result?.retired, mode === 'normal' ? 2 : 1)
      assert.deepEqual(readdirSync(source), [])
      assert.equal(readFileSync(join(target, 'nested', 'document.txt'), 'utf8'), 'user document')
      assert.equal(
        JSON.parse(readFileSync(join(target, '.desktop-legacy-migration.json'), 'utf8')).phase,
        'retired'
      )
      writeFileSync(join(target, 'config.json'), 'new active settings')
      assert.equal(await migrateLegacyHome(native, coordinator, source, target), null)
      assert.equal(readFileSync(join(target, 'config.json'), 'utf8'), 'new active settings')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
