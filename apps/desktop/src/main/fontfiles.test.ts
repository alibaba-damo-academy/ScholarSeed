import assert from 'node:assert/strict'
import { mkdtemp, writeFile, link, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { OfficeFontFiles } from './fontfiles.ts'

test('repeated faces and hard links read each physical font file once per catalog', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'office-font-files-'))
  try {
    const first = join(directory, '中文字体.ttc')
    const alias = join(directory, 'alias.ttc')
    const second = join(directory, 'other.ttf')
    await writeFile(first, Buffer.from('true collection'))
    await link(first, alias)
    await writeFile(second, Buffer.from('true other'))
    const faces = [
      { path: first, postscriptName: 'Normal' },
      { path: alias, postscriptName: 'Bold' },
      { path: second, postscriptName: 'Other' },
    ]
    for (const multiplier of [1, 2, 3]) {
      const owner = new OfficeFontFiles(async () =>
        Array.from({ length: multiplier }, () => faces).flat()
      )
      const catalog = await owner.catalog()
      assert.equal(catalog.faceCount, 3)
      assert.equal(catalog.fonts.length, 2)
      assert.deepEqual(catalog.fonts[0].postscriptNames, ['Bold', 'Normal'])
      assert.equal(JSON.stringify(catalog).includes(directory), false)
      const bytes = await Promise.all(catalog.fonts.map((font) => owner.read(font.id)))
      assert.deepEqual(
        bytes.map((value) => Buffer.from(value).toString()),
        ['true collection', 'true other']
      )
      await assert.rejects(owner.read(first), /Unknown Office font/)
    }
  } finally {
    await rm(directory, { recursive: true })
  }
})

test('changed files and stale catalog IDs fail instead of loading an unverified font', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'office-font-files-'))
  try {
    const path = join(directory, 'font.ttf')
    await writeFile(path, 'true first')
    const owner = new OfficeFontFiles(async () => [{ path, postscriptName: 'Font' }])
    const first = await owner.catalog()
    await writeFile(path, 'true changed-size')
    await assert.rejects(owner.read(first.fonts[0].id), /font changed/)
    await owner.catalog()
    await assert.rejects(owner.read(first.fonts[0].id), /Unknown Office font/)
  } finally {
    await rm(directory, { recursive: true })
  }
})

test('simultaneous Office hosts share enumeration and keep unchanged source IDs readable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'office-font-files-'))
  try {
    const path = join(directory, 'font.ttf')
    await writeFile(path, 'true original')
    let enumerations = 0
    const owner = new OfficeFontFiles(async () => {
      enumerations++
      return [{ path, postscriptName: 'Font' }]
    })
    const [first, second] = await Promise.all([owner.catalog(), owner.catalog()])
    assert.equal(enumerations, 1)
    assert.equal(first.fonts[0].id, second.fonts[0].id)
    await owner.catalog()
    assert.equal(Buffer.from(await owner.read(first.fonts[0].id)).toString(), 'true original')
  } finally {
    await rm(directory, { recursive: true })
  }
})

test('cache identity survives restart and duplicate enumeration but changes with fonts and face selection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'office-font-identity-'))
  try {
    const path = join(directory, 'font.ttf')
    await writeFile(path, 'true original')
    const faces = [{ path, postscriptName: 'Font', faceIndex: 0 }]
    const owner = new OfficeFontFiles(async () => faces)
    const first = await owner.catalog()
    for (const multiplier of [1, 2, 3]) {
      const restarted = new OfficeFontFiles(async () =>
        Array.from({ length: multiplier }, () => faces).flat()
      )
      const next = await restarted.catalog()
      assert.notEqual(first.fonts[0].id, next.fonts[0].id)
      assert.equal(first.fingerprint, next.fingerprint)
    }
    faces[0].faceIndex = 1
    assert.notEqual((await owner.catalog()).fingerprint, first.fingerprint)
    faces[0].faceIndex = 0
    const other = join(directory, 'other.ttf')
    await writeFile(other, 'true other')
    faces.push({ path: other, postscriptName: 'Other', faceIndex: 0 })
    const added = await owner.catalog()
    assert.notEqual(added.fingerprint, first.fingerprint)
    faces.reverse()
    assert.equal((await owner.catalog()).fingerprint, added.fingerprint)
    faces.splice(
      faces.findIndex((face) => face.path === other),
      1
    )
    assert.equal((await owner.catalog()).fingerprint, first.fingerprint)
    await writeFile(path, 'true changed')
    assert.notEqual((await owner.catalog()).fingerprint, first.fingerprint)
    assert.throws(() => owner.assertFingerprint(first.fingerprint), /stale/)
  } finally {
    await rm(directory, { recursive: true })
  }
})
