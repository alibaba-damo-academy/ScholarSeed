import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { manifestSigningPayload, verifyChromiumResources } from './chromiumresources.ts'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const trustedKeys = { release: publicKey.export({ format: 'pem', type: 'spki' }).toString() }

function fixtureManifest(platform: 'darwin' | 'win32', arch: 'arm64' | 'x64', executable: string, files: { path: string; contents: string }[]) {
  return {
    schemaVersion: 1,
    platform,
    arch,
    executable,
    provenance: {
      product: 'Chromium', version: '1.2.3', sourceUrl: 'https://example.org/chromium',
      licenseSpdx: 'BSD-3-Clause', licenseUrl: 'https://example.org/license'
    },
    files: files.map(file => ({ path: file.path, size: Buffer.byteLength(file.contents), sha256: createHash('sha256').update(file.contents).digest('hex') })),
    signature: { algorithm: 'ed25519', keyId: 'release', value: '' }
  }
}

async function signedFixture(platform: 'darwin' | 'win32', arch: 'arm64' | 'x64') {
  const resources = await mkdtemp(join(tmpdir(), 'scholarseed-chromium-resources-'))
  const bundle = join(resources, 'chromium')
  const executable = platform === 'win32' ? 'chrome.exe' : 'Chromium.app/Contents/MacOS/Chromium'
  const files = [
    { path: executable, contents: 'binary' },
    { path: 'resources.pak', contents: 'asset' }
  ].sort((left, right) => left.path.localeCompare(right.path, 'en'))
  for (const file of files) {
    await mkdir(join(bundle, file.path, '..'), { recursive: true })
    await writeFile(join(bundle, file.path), file.contents)
  }
  if (platform === 'darwin') await chmod(join(bundle, executable), 0o755)
  const manifest = fixtureManifest(platform, arch, executable, files)
  const save = async () => {
    manifest.signature.value = sign(null, manifestSigningPayload(manifest), privateKey).toString('base64')
    await writeFile(join(bundle, 'manifest.json'), JSON.stringify(manifest))
  }
  await save()
  return { resources, bundle, executable, manifest, save }
}

test('validates signed macOS arm64 and x64 resource inventories', async () => {
  for (const arch of ['arm64', 'x64'] as const) {
    const fixture = await signedFixture('darwin', arch)
    try {
      assert.equal(await verifyChromiumResources(fixture.resources, 'darwin', arch, trustedKeys), join(fixture.bundle, fixture.executable))
    } finally { await rm(fixture.resources, { recursive: true, force: true }) }
  }
})

test('validates signed Windows x64 resource inventory', async () => {
  const fixture = await signedFixture('win32', 'x64')
  try {
    assert.equal(await verifyChromiumResources(fixture.resources, 'win32', 'x64', trustedKeys), join(fixture.bundle, fixture.executable))
  } finally { await rm(fixture.resources, { recursive: true, force: true }) }
})

test('fails closed without an application-pinned signer or on tampered manifest metadata', async () => {
  const fixture = await signedFixture('darwin', 'arm64')
  try {
    await assert.rejects(verifyChromiumResources(fixture.resources, 'darwin', 'arm64', {}), /trusted signing key/)
    fixture.manifest.provenance.licenseUrl = 'https://attacker.invalid/license'
    await writeFile(join(fixture.bundle, 'manifest.json'), JSON.stringify(fixture.manifest))
    await assert.rejects(verifyChromiumResources(fixture.resources, 'darwin', 'arm64', trustedKeys), /signature/)
  } finally { await rm(fixture.resources, { recursive: true, force: true }) }
})

test('rejects wrong platform, unsupported architecture and malformed provenance', async () => {
  const fixture = await signedFixture('win32', 'x64')
  try {
    await assert.rejects(verifyChromiumResources(fixture.resources, 'darwin', 'arm64', trustedKeys), /platform|architecture/)
    await assert.rejects(verifyChromiumResources(fixture.resources, 'win32', 'arm64', trustedKeys), /unsupported|architecture/)
    fixture.manifest.provenance.licenseSpdx = ''
    await fixture.save()
    await assert.rejects(verifyChromiumResources(fixture.resources, 'win32', 'x64', trustedKeys), /provenance/)
  } finally { await rm(fixture.resources, { recursive: true, force: true }) }
})

test('rejects unlisted files, altered bytes and traversal paths', async () => {
  const fixture = await signedFixture('darwin', 'arm64')
  try {
    await writeFile(join(fixture.bundle, 'unexpected'), 'extra')
    await assert.rejects(verifyChromiumResources(fixture.resources, 'darwin', 'arm64', trustedKeys), /Unlisted/)
    await rm(join(fixture.bundle, 'unexpected'))
    await writeFile(join(fixture.bundle, 'resources.pak'), 'changed')
    await assert.rejects(verifyChromiumResources(fixture.resources, 'darwin', 'arm64', trustedKeys), /hash|size/)
    await writeFile(join(fixture.bundle, 'resources.pak'), 'asset')
    fixture.manifest.files[0].path = '../escape'
    await fixture.save()
    await assert.rejects(verifyChromiumResources(fixture.resources, 'darwin', 'arm64', trustedKeys), /path/)
  } finally { await rm(fixture.resources, { recursive: true, force: true }) }
})

test('rejects symlink escape rather than hashing an external file', async () => {
  const fixture = await signedFixture('darwin', 'arm64')
  try {
    await rm(join(fixture.bundle, 'resources.pak'))
    await symlink(join(fixture.resources, 'outside'), join(fixture.bundle, 'resources.pak'))
    await assert.rejects(verifyChromiumResources(fixture.resources, 'darwin', 'arm64', trustedKeys), /symlink|resource/)
  } finally { await rm(fixture.resources, { recursive: true, force: true }) }
})

test('validates a signed macOS Framework directory symlink without following it twice', async () => {
  const fixture = await signedFixture('darwin', 'arm64')
  try {
    await mkdir(join(fixture.bundle, 'Chromium.app/Contents/Frameworks/Versions/A'), { recursive: true })
    await writeFile(join(fixture.bundle, 'Chromium.app/Contents/Frameworks/Versions/A/library'), 'framework')
    await symlink('A', join(fixture.bundle, 'Chromium.app/Contents/Frameworks/Versions/Current'))
    fixture.manifest.files.push({ path: 'Chromium.app/Contents/Frameworks/Versions/A/library', size: 9, sha256: createHash('sha256').update('framework').digest('hex') })
    fixture.manifest.files.push({ path: 'Chromium.app/Contents/Frameworks/Versions/Current', target: 'A', kind: 'symlink' } as never)
    await fixture.save()
    assert.equal(await verifyChromiumResources(fixture.resources, 'darwin', 'arm64', trustedKeys), join(fixture.bundle, fixture.executable))
  } finally { await rm(fixture.resources, { recursive: true, force: true }) }
})

test('validates nested macOS Framework links through a signed link ancestor', async () => {
  const fixture = await signedFixture('darwin', 'arm64')
  try {
    const framework = 'Chromium.app/Contents/Frameworks/Chromium Framework.framework'
    const version = `${framework}/Versions/A`
    await mkdir(join(fixture.bundle, version, 'Resources'), { recursive: true })
    await writeFile(join(fixture.bundle, version, 'Chromium Framework'), 'framework')
    await writeFile(join(fixture.bundle, version, 'Resources', 'asset.pak'), 'asset')
    await symlink('A', join(fixture.bundle, framework, 'Versions/Current'))
    await symlink('Versions/Current/Chromium Framework', join(fixture.bundle, framework, 'Chromium Framework'))
    await symlink('Versions/Current/Resources', join(fixture.bundle, framework, 'Resources'))
    fixture.manifest.files.push(
      { path: `${version}/Chromium Framework`, size: 9, sha256: createHash('sha256').update('framework').digest('hex') },
      { path: `${version}/Resources/asset.pak`, size: 5, sha256: createHash('sha256').update('asset').digest('hex') },
      { path: `${framework}/Versions/Current`, target: 'A', kind: 'symlink' } as never,
      { path: `${framework}/Chromium Framework`, target: 'Versions/Current/Chromium Framework', kind: 'symlink' } as never,
      { path: `${framework}/Resources`, target: 'Versions/Current/Resources', kind: 'symlink' } as never
    )
    await fixture.save()
    assert.equal(await verifyChromiumResources(fixture.resources, 'darwin', 'arm64', trustedKeys), join(fixture.bundle, fixture.executable))
  } finally { await rm(fixture.resources, { recursive: true, force: true }) }
})

test('rejects a signed symlink ancestor switched outside the root before hashing its alias', async () => {
  const fixture = await signedFixture('darwin', 'arm64')
  const originalRealpath = fs.promises.realpath
  try {
    const versionDirectory = join(fixture.bundle, 'Chromium.app/Contents/Frameworks/Versions')
    const version = join(versionDirectory, 'A')
    const link = join(versionDirectory, 'Current')
    const outside = join(fixture.resources, 'outside')
    await mkdir(version, { recursive: true })
    await mkdir(outside)
    await writeFile(join(version, 'asset.pak'), 'inside')
    await writeFile(join(outside, 'asset.pak'), 'outside')
    await symlink('A', link)
    fixture.manifest.files.push(
      { path: 'Chromium.app/Contents/Frameworks/Versions/A/asset.pak', size: 6, sha256: createHash('sha256').update('inside').digest('hex') },
      { path: 'Chromium.app/Contents/Frameworks/Versions/Current', target: 'A', kind: 'symlink' } as never,
      { path: 'Chromium.app/Contents/Frameworks/Versions/Current/asset.pak', size: 7, sha256: createHash('sha256').update('outside').digest('hex') }
    )
    await fixture.save()
    let switched = false
    fs.promises.realpath = (async (...args: Parameters<typeof originalRealpath>) => {
      const result = await originalRealpath(args[0])
      if (String(args[0]) === link && !switched) {
        switched = true
        await rm(link)
        await symlink(outside, link)
      }
      return result
    }) as typeof originalRealpath
    syncBuiltinESMExports()
    await assert.rejects(verifyChromiumResources(fixture.resources, 'darwin', 'arm64', trustedKeys), /escapes root|changed during validation/)
    assert.equal(switched, true)
  } finally {
    fs.promises.realpath = originalRealpath
    syncBuiltinESMExports()
    await rm(fixture.resources, { recursive: true, force: true })
  }
})

test('rejects escaping and cyclic Framework symlinks', async () => {
  const fixture = await signedFixture('darwin', 'arm64')
  try {
    await symlink('../../', join(fixture.bundle, 'outside-link'))
    fixture.manifest.files.push({ path: 'outside-link', target: '../../', kind: 'symlink' } as never)
    await fixture.save()
    await assert.rejects(verifyChromiumResources(fixture.resources, 'darwin', 'arm64', trustedKeys), /symlink|resource/)
    await rm(join(fixture.bundle, 'outside-link'))
    await symlink('loop', join(fixture.bundle, 'loop'))
    fixture.manifest.files[fixture.manifest.files.length - 1] = { path: 'loop', target: 'loop', kind: 'symlink' } as never
    await fixture.save()
    await assert.rejects(verifyChromiumResources(fixture.resources, 'darwin', 'arm64', trustedKeys), /symlink|resource|ELOOP/)
  } finally { await rm(fixture.resources, { recursive: true, force: true }) }
})

test('rejects non-Ed25519 pinned public keys', async () => {
  const fixture = await signedFixture('win32', 'x64')
  try {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    await assert.rejects(verifyChromiumResources(fixture.resources, 'win32', 'x64', {
      release: rsa.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    }), /Ed25519/)
  } finally { await rm(fixture.resources, { recursive: true, force: true }) }
})

test('rejects Windows resource symlinks and macOS symlink executables', async () => {
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64']] as const) {
    const fixture = await signedFixture(platform, arch)
    try {
      await symlink('resources.pak', join(fixture.bundle, 'link'))
      fixture.manifest.files.push({ path: 'link', target: 'resources.pak', kind: 'symlink' } as never)
      await fixture.save()
      if (platform === 'win32') {
        await assert.rejects(verifyChromiumResources(fixture.resources, platform, arch, trustedKeys), /symlink|resource/)
      } else {
        assert.equal(await verifyChromiumResources(fixture.resources, platform, arch, trustedKeys), join(fixture.bundle, fixture.executable))
        await rm(join(fixture.bundle, fixture.executable))
        await symlink(join(fixture.bundle, 'resources.pak'), join(fixture.bundle, fixture.executable))
        await assert.rejects(verifyChromiumResources(fixture.resources, platform, arch, trustedKeys), /executable|regular file|symlink/)
      }
    } finally { await rm(fixture.resources, { recursive: true, force: true }) }
  }
})

test('rejects a Windows directory symlink ancestor even when its target remains inside the resource root', async () => {
  const fixture = await signedFixture('win32', 'x64')
  try {
    await mkdir(join(fixture.bundle, 'Versions/A'), { recursive: true })
    await writeFile(join(fixture.bundle, 'Versions/A/asset.pak'), 'asset')
    await symlink('A', join(fixture.bundle, 'Versions/Current'))
    fixture.manifest.files.push(
      { path: 'Versions/A/asset.pak', size: 5, sha256: createHash('sha256').update('asset').digest('hex') },
      { path: 'Versions/Current', target: 'A', kind: 'symlink' } as never,
      { path: 'Versions/Current/asset.pak', size: 5, sha256: createHash('sha256').update('asset').digest('hex') }
    )
    await fixture.save()
    await assert.rejects(verifyChromiumResources(fixture.resources, 'win32', 'x64', trustedKeys), /symlink|reparse/)
  } finally { await rm(fixture.resources, { recursive: true, force: true }) }
})
