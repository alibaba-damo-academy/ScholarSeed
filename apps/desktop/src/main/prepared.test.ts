import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { PreparedArchive, PreparedArtifactChangedError } from './prepared.ts'
import { squirrelFeed } from './squirrel.ts'
import type { LatestVersionMeta } from '../updates.ts'

const macOnly = { skip: process.platform !== 'darwin' }
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'prepared-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const source = join(directory, 'source.dmg')
  const archive = join(directory, 'application.zip')
  const application = join(directory, 'ScholarSeed.app')
  mkdirSync(application)
  writeFileSync(join(application, 'content'), 'original')
  const bytes = Buffer.from('unit fixture for a digest-bound source; not a signed DMG')
  writeFileSync(source, bytes)
  const meta: LatestVersionMeta = {
    id: 'release-a',
    product_id: 'scholarseed',
    bundle_id: 'com.scholarseed.desktop',
    version: '0.2.0',
    build_number: '202610131417',
    arch_type: 'darwin-arm64',
    sha512: createHash('sha512').update(bytes).digest('hex'),
    file_size: bytes.length,
    channel: 'preview',
    team_id: 'TEAM',
  }
  const generate = async () => {
    execFileSync('/usr/bin/ditto', [
      '-c',
      '-k',
      '--sequesterRsrc',
      '--keepParent',
      application,
      archive,
    ])
  }
  const create = (operation = generate, signal?: AbortSignal) =>
    PreparedArchive.create(meta, source, archive, operation, signal)
  return { directory, source, archive, application, meta, generate, create, bytes }
}

test(
  'a real final ZIP is the only feed input; fresh source trust still runs',
  macOnly,
  async (t) => {
    const f = fixture(t)
    const receipt = await f.create()
    assert.equal(receipt.matches(f.meta, receipt.archive), true)
    // No retained writable application is trusted or needed by the receipt.
    rmSync(f.application, { recursive: true })
    let checks = 0
    const final = await receipt.revalidate(async () => {
      checks++
    })
    assert.equal(checks, 1)
    const feed = await squirrelFeed(final)
    try {
      const manifest = (await (await fetch(feed.url)).json()) as { url: string }
      const bytes = Buffer.from(await (await fetch(manifest.url)).arrayBuffer())
      assert.deepEqual(bytes, readFileSync(f.archive))
    } finally {
      await feed.close()
    }
  }
)

test('wrong source fails before conversion and before current trust', macOnly, async (t) => {
  const f = fixture(t)
  let generated = false
  writeFileSync(f.source, Buffer.alloc(f.bytes.length, 'x'))
  await assert.rejects(
    f.create(async () => {
      generated = true
    }),
    /DMG digest/
  )
  assert.equal(generated, false)
  writeFileSync(f.source, f.bytes)
  const receipt = await f.create()
  writeFileSync(f.source, Buffer.alloc(f.bytes.length, 'x'))
  let inspected = false
  await assert.rejects(
    receipt.revalidate(async () => {
      inspected = true
    }),
    /DMG digest/
  )
  assert.equal(inspected, false)
})

test(
  'source changes during conversion or live trust never acquire a receipt or authorization input',
  macOnly,
  async (t) => {
    const f = fixture(t)
    await assert.rejects(
      f.create(async () => {
        await f.generate()
        writeFileSync(f.source, Buffer.alloc(f.bytes.length, 'x'))
      }),
      /DMG digest/
    )
    writeFileSync(f.source, f.bytes)
    const receipt = await f.create()
    await assert.rejects(
      receipt.revalidate(async () => {
        writeFileSync(f.source, Buffer.alloc(f.bytes.length, 'x'))
      }),
      /DMG digest/
    )
  }
)

test('ZIP tampering before or during current trust is rejected', macOnly, async (t) => {
  for (const during of [false, true]) {
    const f = fixture(t)
    const receipt = await f.create()
    const corrupt = () => {
      const bytes = readFileSync(f.archive)
      bytes[0] ^= 1
      writeFileSync(f.archive, bytes)
    }
    if (!during) corrupt()
    let inspected = false
    await assert.rejects(
      receipt.revalidate(async () => {
        inspected = true
        if (during) corrupt()
      }),
      /ZIP digest/
    )
    assert.equal(inspected, during)
  }
})

test(
  'container traversal/symlink escape is rejected before a conversion receipt',
  macOnly,
  async (t) => {
    const f = fixture(t)
    symlinkSync('../outside', join(f.application, 'escape'))
    await assert.rejects(f.create(), /canonical/)
  }
)

test(
  'signing or notarization failure is final and never retried or bypassed',
  macOnly,
  async (t) => {
    const f = fixture(t)
    let checks = 0
    const fail = async () => {
      checks++
      throw new Error('untrusted or indeterminate')
    }
    await assert.rejects(f.create(fail), /untrusted/)
    assert.equal(checks, 1)
    const receipt = await f.create()
    await assert.rejects(receipt.revalidate(fail), /untrusted/)
    assert.equal(checks, 2)
  }
)

test(
  'cancellation before or during conversion/current trust prevents handoff',
  macOnly,
  async (t) => {
    const f = fixture(t)
    const before = new AbortController()
    before.abort()
    await assert.rejects(f.create(f.generate, before.signal), { name: 'AbortError' })
    const during = new AbortController()
    await assert.rejects(
      f.create(async () => {
        await f.generate()
        during.abort()
      }, during.signal),
      { name: 'AbortError' }
    )
    const receipt = await f.create()
    const current = new AbortController()
    await assert.rejects(
      receipt.revalidate(async () => {
        current.abort()
      }, current.signal),
      { name: 'AbortError' }
    )
  }
)

test(
  'receipt snapshots release and archive identity; disk hints cannot reconstruct trust',
  macOnly,
  async (t) => {
    const f = fixture(t)
    const original = { ...f.meta }
    const receipt = await f.create()
    f.meta.id = 'other'
    assert.equal(receipt.matches(f.meta, receipt.archive), false)
    assert.equal(receipt.matches(original, { ...receipt.archive, path: 'other' }), false)
    assert.equal(receipt.matches(original, { ...receipt.archive, sha512: '0'.repeat(128) }), false)
    assert.equal(
      receipt.matches(original, { ...receipt.archive, size: receipt.archive.size + 1 }),
      false
    )
    assert.ok(Object.isFrozen(receipt.archive))
    // A cold owner has to invoke create (including generation and source gates),
    // even if all on-disk fields describe an existing ZIP.
    let conversions = 0
    f.meta.id = original.id
    await f.create(async () => {
      conversions++
      await f.generate()
    })
    assert.equal(conversions, 1)
  }
)

test('symlink source and ZIP files cannot stand in for verified artifacts', macOnly, async (t) => {
  const f = fixture(t)
  const link = join(f.directory, 'source-link')
  symlinkSync(f.source, link)
  await assert.rejects(
    PreparedArchive.create(f.meta, link, f.archive, f.generate),
    PreparedArtifactChangedError
  )
  const receipt = await f.create()
  const other = join(f.directory, 'other.zip')
  writeFileSync(other, readFileSync(f.archive))
  rmSync(f.archive)
  symlinkSync(other, f.archive)
  await assert.rejects(
    receipt.revalidate(async () => {}),
    PreparedArtifactChangedError
  )
})

test(
  'cancelled or rejected live checks preserve the final ZIP for a fresh retry',
  macOnly,
  async (t) => {
    const f = fixture(t)
    let conversions = 0
    const receipt = await f.create(async () => {
      conversions++
      await f.generate()
    })
    const bytes = readFileSync(f.archive)
    const controller = new AbortController()
    await assert.rejects(
      receipt.revalidate(async () => {
        controller.abort()
      }, controller.signal)
    )
    await assert.rejects(
      receipt.revalidate(async () => {
        throw new Error('ticket unavailable')
      })
    )
    let checks = 0
    const retry = await receipt.revalidate(async () => {
      checks++
    })
    assert.equal(conversions, 1)
    assert.equal(checks, 1)
    assert.equal(receipt.matches(f.meta, retry), true)
    assert.deepEqual(readFileSync(retry.path), bytes)
  }
)
