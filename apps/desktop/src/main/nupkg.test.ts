import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import {
  readPackageMember,
  parsePackageKeys,
  updateCacheDirectory,
  patchDirectory,
  verifyPackageEnvelope,
  packagePath,
  assertWindowsPath,
  assertNewerPackage,
  verifyPackageAsset,
  verifyPackageInventory,
  verifyApplicationPaths,
  verifyDeltaPackagePaths,
  type PackageManifest,
} from './nupkg.ts'

const pair = generateKeyPairSync('ed25519')
const keys = {
  release: pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
}
const identity = {
  product_id: 'scholarseed',
  bundle_id: 'com.scholarseed.desktop',
  arch_type: 'windows-amd64',
  channel: 'preview',
  app_id: 'scholarseed',
}
const bytes = strToU8('signed app')
const member = {
  path: 'lib/app/ScholarSeed.exe',
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
}
function manifest(): PackageManifest {
  return {
    schema: 1,
    domain: 'scholarseed.velopack-release',
    ...identity,
    version: '0.2.0',
    build_number: '202610160001',
    pack_version: '0.2.0-build.202610160001',
    base_version: null,
    assets: [
      {
        FileName: 'ScholarSeed-0.2.0-full.nupkg',
        Version: '0.2.0-build.202610160001',
        Type: 'Full',
        Size: 10,
        SHA256: 'a'.repeat(64),
      },
    ],
    files: [member],
  }
}
function envelope(value: PackageManifest) {
  const payload = Buffer.from(JSON.stringify(value))
  return {
    schema: 1,
    key_id: 'release',
    manifest: payload.toString('base64'),
    signature: sign(null, payload, pair.privateKey).toString('base64'),
  }
}
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'velopack-contract-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
test('release trust binds exact bytes, publisher key, domain and installation identity', () => {
  const value = envelope(manifest())
  assert.equal(
    verifyPackageEnvelope(value, parsePackageKeys(keys), identity).pack_version,
    '0.2.0-build.202610160001'
  )
  assert.throws(
    () =>
      verifyPackageEnvelope(
        { ...value, signature: Buffer.alloc(64).toString('base64') },
        keys,
        identity
      ),
    /signature/
  )
  assert.throws(() => verifyPackageEnvelope(value, {}, identity), /trusted/)
  assert.throws(
    () => verifyPackageEnvelope(value, keys, { ...identity, channel: 'release' }),
    /channel/
  )
  assert.throws(
    () => verifyPackageEnvelope(value, keys, { ...identity, app_id: identity.bundle_id }),
    /app_id/
  )
  assert.throws(
    () => verifyPackageEnvelope(value, keys, { ...identity, bundle_id: identity.app_id }),
    /bundle_id/
  )
  assert.throws(
    () => verifyPackageEnvelope(envelope({ ...manifest(), domain: 'different' }), keys, identity),
    /domain/
  )
})
test('signed inventory rejects case collisions, reserved names and file-directory aliases', () => {
  for (const path of [
    'lib/app/scholarseed.EXE',
    'lib/app/NUL.txt',
    'lib/app/ScholarSeed.exe/child',
  ]) {
    assert.throws(() =>
      verifyPackageEnvelope(
        envelope({ ...manifest(), files: [member, { ...member, path }] }),
        keys,
        identity
      )
    )
  }
})
test('delta requires one signed base and unique target full asset', () => {
  const value = manifest()
  assert.throws(
    () =>
      verifyPackageEnvelope(
        envelope({
          ...value,
          assets: [...value.assets, { ...value.assets[0], Type: 'Delta', FileName: 'delta.nupkg' }],
        }),
        keys,
        identity
      ),
    /assets/
  )
  assert.throws(
    () =>
      verifyPackageEnvelope(
        envelope({
          ...value,
          assets: [...value.assets, { ...value.assets[0], FileName: 'another.nupkg' }],
        }),
        keys,
        identity
      ),
    /assets/
  )
})
test('Windows paths reject traversal, streams, device names and ambiguous normalization', () => {
  for (const name of [
    '../x',
    'x/../y',
    'x\\y',
    'C:/x',
    '/x',
    'x:',
    'aux.log',
    'x./y',
    'x /y',
    'x//y',
    'com¹.txt',
  ])
    assert.throws(() => packagePath(name))
  assert.equal(packagePath('lib/app/resources/书深.txt'), 'lib/app/resources/书深.txt')
  assertWindowsPath('C:\\Apps\\ScholarSeed\\current', 'resources/app.asar')
  assert.throws(() => assertWindowsPath('C:\\' + 'x'.repeat(240), 'resources/app.asar'), /limit/)
})
test('technical build version ordering rejects equal, older and malformed targets', () => {
  assertNewerPackage('0.2.0-build.202610160002', '0.2.0-build.202610160001')
  assertNewerPackage('0.3.0-build.202610150001', '0.2.9-build.202610160001')
  for (const target of [
    '0.2.0-build.202610160001',
    '0.1.9-build.202610170001',
    '0.2.0+202610170001',
  ])
    assert.throws(() => assertNewerPackage(target, '0.2.0-build.202610160001'))
})
test('final member verification accepts changed ZIP compression but rejects changed content', async () =>
  fixture(async (directory) => {
    const path = join(directory, 'package.nupkg')
    for (const level of [0, 6] as const) {
      await writeFile(path, zipSync({ [member.path]: bytes }, { level }))
      await verifyPackageInventory(path, manifest(), ['C:\\App\\current'])
    }
    await writeFile(path, zipSync({ [member.path]: strToU8('changed!!!') }))
    await assert.rejects(
      verifyPackageInventory(path, manifest(), ['C:\\App\\current']),
      /digest|member/
    )
    await writeFile(path, zipSync({ [member.path]: bytes, 'lib/app/unexpected.exe': bytes }))
    await assert.rejects(
      verifyPackageInventory(path, manifest(), ['C:\\App\\current']),
      /unexpected/
    )
  }))
test('raw asset verification rejects modified transport bytes before native SDK consumption', async () =>
  fixture(async (directory) => {
    const path = join(directory, 'asset.nupkg')
    await writeFile(path, bytes)
    const asset = { ...manifest().assets[0], Size: bytes.length, SHA256: member.sha256 }
    await verifyPackageAsset(path, asset)
    await writeFile(path, strToU8('bad'))
    await assert.rejects(verifyPackageAsset(path, asset), /digest/)
  }))

test('package cache belongs to the explicit installation', () => {
  assert.equal(
    updateCacheDirectory('C:/Users/name/AppData/Local/scholarseed'),
    'C:\\Users\\name\\AppData\\Local\\scholarseed\\packages'
  )
  assert.throws(() => updateCacheDirectory('relative'), /invalid update cache/)
})

test('full extraction strips package prefix while delta checks its actual deeper paths', async () => {
  await fixture(async (directory) => {
    const root = 'C:/updates/' + 'a'.repeat(192)
    const name = 'lib/app/' + 'b'.repeat(48)
    const value = { ...manifest(), files: [{ ...member, path: name }] }
    verifyApplicationPaths(value, [root])
    assert.throws(() => assertWindowsPath(root, name), /compatibility limit/)
    const archive = join(directory, 'delta.nupkg')
    await writeFile(archive, zipSync({ [name + '.zsdiff']: strToU8('patch') }))
    await assert.rejects(verifyDeltaPackagePaths(archive, [root]), /compatibility limit/)
    await verifyDeltaPackagePaths(archive, ['C:/short'])
    await assert.rejects(
      verifyDeltaPackagePaths(archive, ['C:/short', root]),
      /compatibility limit/
    )
  })
})

test('default personal and global cache paths fit full and actual delta extraction', async () => {
  const local = 'C:/Users/Administrator/AppData/Local'
  const roots = [local + '/scholarseed', 'C:/Program Files/scholarseed']
  const staging = '/VelopackTemp/tmp_0000000000000000'
  const temp = local + '/Temp'
  const member = 'python/' + 'a'.repeat(151)
  assert.equal(member.length, 158)
  const patchRoots = roots.map((root) => {
    assertWindowsPath(root + '/current', member)
    const cache = updateCacheDirectory(root)
    assertWindowsPath(cache + staging, member)
    const patch = patchDirectory(root, cache + '/Update.exe', cache + staging, temp)
    assert.equal(patch, temp.replaceAll('/', '\\') + '\\velopack_0000000000000000')
    assertWindowsPath(patch + '/_work', 'lib/app/' + member)
    return patch
  })
  await fixture(async (directory) => {
    const archive = join(directory, 'delta.nupkg')
    await writeFile(archive, zipSync({ ['lib/app/' + member + '.zsdiff']: strToU8('patch') }))
    await verifyDeltaPackagePaths(archive, patchRoots)
  })
})

test('flat runtime executables share signed inventory and application path checks', async () => {
  await fixture(async (directory) => {
    const paths = ['python/python.exe', 'texlive/bin/windows/xelatex.exe', 'powershell/pwsh.exe']
    const files = paths.map((path) => ({ ...member, path: 'lib/app/' + path }))
    const value = { ...manifest(), files }
    verifyApplicationPaths(value, ['C:/app/current', 'C:/cache/VelopackTemp/tmp_0000000000000000'])
    const archive = join(directory, 'full.nupkg')
    const contents = Object.fromEntries(files.map((file) => [file.path, bytes]))
    await writeFile(archive, zipSync(contents))
    await verifyPackageInventory(archive, value, [])
    contents[files[0].path] = strToU8('tampered runtime')
    await writeFile(archive, zipSync(contents))
    await assert.rejects(verifyPackageInventory(archive, value, []), /member/)
    assert.throws(
      () => verifyApplicationPaths(value, ['C:/' + 'a/'.repeat(130)]),
      /compatibility limit/
    )
  })
})

test('fixed SDK layout rejects missing or unsupported application prefixes', () => {
  const missing = { ...manifest(), files: [{ ...member, path: 'scholarseed.nuspec' }] }
  const old = { ...manifest(), files: [{ ...member, path: 'lib/net45/ScholarSeed.exe' }] }
  assert.throws(() => verifyApplicationPaths(missing, []), /no lib\/app/)
  assert.throws(() => verifyApplicationPaths(old, []), /no lib\/app/)
  assert.throws(() => verifyPackageEnvelope(envelope(missing), keys, identity), /no lib\/app/)
  assert.throws(
    () => verifyApplicationPaths({ ...manifest(), files: [member, ...old.files] }, []),
    /unsupported application member prefix/
  )
})

test('official updater, execution stub and NuGet metadata remain in the signed inventory', async () => {
  await fixture(async (directory) => {
    const paths = [
      'lib/app/ScholarSeed.exe',
      'lib/app/Squirrel.exe',
      'lib/app/书深_ExecutionStub.exe',
      'scholarseed.nuspec',
      '[Content_Types].xml',
      '_rels/.rels',
      'setup.ico',
    ]
    const files = paths.map((path) => ({ ...member, path }))
    const value = { ...manifest(), files }
    verifyPackageEnvelope(envelope(value), keys, identity)
    const archive = join(directory, 'full.nupkg')
    const contents = Object.fromEntries(paths.map((name) => [name, bytes]))
    await writeFile(archive, zipSync(contents))
    await verifyPackageInventory(archive, value, [])
    for (const target of paths.slice(1)) {
      await writeFile(archive, zipSync({ ...contents, [target]: strToU8('tampered') }))
      await assert.rejects(verifyPackageInventory(archive, value, []), /member/)
    }
  })
})

test('exact runtime metadata is read from verified package with signed size and digest binding', async () =>
  fixture(async (directory) => {
    const path = join(directory, 'app.nupkg')
    const runtime = Buffer.from('{"runtime":"signed"}')
    const name = 'lib/app/resources/components/runtime.json'
    const metadata = {
      path: name,
      size: runtime.length,
      sha256: createHash('sha256').update(runtime).digest('hex'),
    }
    const signed = { ...manifest(), files: [metadata] }
    await writeFile(path, zipSync({ [name]: runtime }))
    assert.deepEqual(await readPackageMember(path, signed, name, 1024), runtime)
    await assert.rejects(readPackageMember(path, signed, name, 1), /oversized/)
    await writeFile(path, zipSync({ [name]: Buffer.alloc(runtime.length) }))
    await assert.rejects(readPackageMember(path, signed, name, 1024), /digest/)
  }))
