import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8, type Zippable } from 'fflate'
import { verifyApplicationArchive } from './archive.ts'

const APP = 'ScholarSeed.app/'
const CONTENT = `${APP}Contents/Info.plist`
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_OFFSET = 42
const NAME_OFFSET = 46
const CENTRAL_EXPANDED_OFFSET = 24
const LOCAL_EXPANDED_OFFSET = 22
const LOCAL_NAME_OFFSET = 26
const LOCAL_EXTRA_OFFSET = 28
const LOCAL_HEADER_BYTES = 30
const RESERVED_DEFLATE_BLOCK = 0x07
const EMPTY = new Uint8Array()
const LINK = { os: 3, attrs: (0xa1ff << 16) >>> 0 }
async function fixture(
  t: { after: (f: () => Promise<void>) => void },
  entries: Zippable,
  mutate?: (bytes: Buffer) => void
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'update-archive-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'application.zip')
  const bytes = Buffer.from(zipSync(entries, { level: 0 }))
  mutate?.(bytes)
  await writeFile(path, bytes)
  return path
}
const canonical = (): Zippable => ({ [APP]: EMPTY, [CONTENT]: strToU8('signed app fixture') })
test('stored ZIP retains root app, metadata and in-app framework links', async (t) => {
  const path = await fixture(t, {
    ...canonical(),
    [`${APP}Contents/Frameworks/Example.framework/Versions/A/binary`]: strToU8('Mach-O fixture'),
    [`${APP}Contents/Frameworks/Example.framework/Versions/Current`]: [strToU8('A'), LINK],
    [`${APP}Contents/Frameworks/Example.framework/binary`]: [
      strToU8('Versions/Current/binary'),
      LINK,
    ],
    '__MACOSX/': EMPTY,
    '__MACOSX/ScholarSeed.app/': EMPTY,
    '__MACOSX/ScholarSeed.app/._Contents': strToU8('metadata'),
  })
  await verifyApplicationArchive(path)
})
test('archive rejects other bundles, traversal, duplicates and filesystem-equivalent names', async (t) => {
  for (const name of [
    'Other.app/Contents/Info.plist',
    `${APP}../Other.app/a`,
    `${APP}Contents\\escape`,
    `${APP}Contents/info.plist`,
    `${APP}Contents/e\u0301`,
    '/absolute/a',
    '__MACOSX/Other.app/a',
  ]) {
    const entries = { ...canonical(), [`${APP}Contents/é`]: EMPTY, [name]: EMPTY }
    await assert.rejects(verifyApplicationArchive(await fixture(t, entries)))
  }
  await assert.rejects(
    verifyApplicationArchive(
      await fixture(t, {
        ...canonical(),
        [`${APP}Contents/file`]: EMPTY,
        [`${APP}Contents/file/child`]: EMPTY,
      })
    )
  )
})
test('escaping and cyclic links cannot redirect ditto outside the app', async (t) => {
  for (const target of ['../../outside', '/Users/test', 'loop', '..\\escape']) {
    const path = await fixture(t, {
      ...canonical(),
      [`${APP}Contents/loop`]: [strToU8(target), LINK],
    })
    await assert.rejects(verifyApplicationArchive(path))
  }
  const path = await fixture(t, {
    ...canonical(),
    [`${APP}Contents/a`]: [strToU8('B/outside'), LINK],
    [`${APP}Contents/b`]: [strToU8('../..'), LINK],
  })
  await assert.rejects(verifyApplicationArchive(path))
})
test('central/local disagreement, aliased offsets and truncated bytes fail before extraction', async (t) => {
  for (const mutate of [
    (bytes: Buffer) => {
      const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
      bytes[central + NAME_OFFSET] ^= 1
    },
    (bytes: Buffer) => {
      const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
      bytes.writeUInt32LE(1, central + LOCAL_OFFSET)
    },
    (bytes: Buffer) => {
      bytes.writeUInt32LE(CENTRAL_SIGNATURE, bytes.length - 22)
    },
  ])
    await assert.rejects(verifyApplicationArchive(await fixture(t, canonical(), mutate)))
})
test('deflated app entries remain supported and aborted inspection stops', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'update-deflated-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'application.zip')
  await writeFile(path, zipSync(canonical(), { level: 6 }))
  await verifyApplicationArchive(path)
  await assert.rejects(verifyApplicationArchive(path, AbortSignal.abort()))
})

test('deflated framework links enforce their declared output size', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'update-deflated-links-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'application.zip')
  const target = 'Versions/Current/binary'
  const archive = Buffer.from(
    zipSync(
      {
        ...canonical(),
        [`${APP}Contents/Frameworks/Example.framework/binary`]: [strToU8(target), LINK],
      },
      { level: 6 }
    )
  )
  await writeFile(path, archive)
  await verifyApplicationArchive(path)
  const central = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  const local = archive.readUInt32LE(central + LOCAL_OFFSET)
  for (const size of [target.length - 1, target.length + 1]) {
    const changed = Buffer.from(archive)
    changed.writeUInt32LE(size, central + CENTRAL_EXPANDED_OFFSET)
    changed.writeUInt32LE(size, local + LOCAL_EXPANDED_OFFSET)
    await writeFile(path, changed)
    await assert.rejects(verifyApplicationArchive(path))
  }
  const changed = Buffer.from(archive)
  const payload =
    local +
    LOCAL_HEADER_BYTES +
    changed.readUInt16LE(local + LOCAL_NAME_OFFSET) +
    changed.readUInt16LE(local + LOCAL_EXTRA_OFFSET)
  changed[payload] = RESERVED_DEFLATE_BLOCK
  await writeFile(path, changed)
  await assert.rejects(verifyApplicationArchive(path))
})
