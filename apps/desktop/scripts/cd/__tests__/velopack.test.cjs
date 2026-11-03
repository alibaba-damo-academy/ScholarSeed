const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { packVersion, compareVersions, envelope, packArguments, releaseManifest, packageKeys } = require('../velopack.cjs')
const { libraries } = require('../../../native/libraries.cjs')
test('Velopack versions preserve product ordering and same-version build ordering', () => {
  assert.equal(packVersion('0.2.1', '202610161200'), '0.2.1-build.202610161200')
  assert.equal(compareVersions('0.2.1-build.202610161200', '0.2.1-build.202610161201'), -1)
  assert.equal(compareVersions('0.2.2-build.202510161200', '0.2.1-build.202610161201'), 1)
  assert.throws(() => packVersion('0.2.1+abc', '202610161200'))
})
test('Velopack envelope authenticates exact bytes and rejects a mismatched embedded key', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'velopack-signature-'))
  try {
    const key = crypto.generateKeyPairSync('ed25519')
    const filename = path.join(directory, 'key.pem')
    fs.writeFileSync(filename, key.privateKey.export({format:'pem',type:'pkcs8'}))
    const publicRaw = key.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64')
    const result = envelope({files:[{path:'lib/app/a',size:1,sha256:'a'.repeat(64)}]}, {key_id:'test'}, filename, {test: publicRaw})
    assert.equal(crypto.verify(null, Buffer.from(result.manifest, 'base64'), key.publicKey, Buffer.from(result.signature, 'base64')), true)
    assert.throws(() => envelope({}, {key_id:'other'}, filename, {test: publicRaw}))
    assert.equal(envelope({}, null).signature, '')
  } finally { fs.rmSync(directory, {recursive:true,force:true}) }
})
test('Windows packs personal Setup and full/delta with SDK checks enabled', () => {
  const args = packArguments({path:'C:\\app'}, {appId:'scholarseed',productName:'ScholarSeed',product:{config:{update_channel:'preview'}},icon:'icon.ico'}, 'C:\\out', '0.2.1-build.202610161200')
  assert.equal(args[args.indexOf('--packId')+1], 'scholarseed')
  assert.ok(!args.includes('--msi'))
  assert.ok(!args.includes('--instLocation'))
  assert.equal(args[args.indexOf('--delta')+1], 'BestSpeed')
  assert.ok(!args.includes('--skipVeloAppCheck'))
  assert.ok(args.includes('--exclude'))
  assert.ok(args.includes('--noDefaultExclude'))
  const exclude = new RegExp(args[args.indexOf('--exclude') + 1])
  for (const filename of ['python/python312.pdb', 'python/DLLs/libcrypto-3-x64.pdb', 'runtime.dll', 'createdump', 'data.nupkg'])
    assert.equal(exclude.test(filename), false, `frozen component member must be retained: ${filename}`)
  assert.deepEqual(libraries('darwin'), ['lease.node','fonts.node','notarization.node'])
  assert.deepEqual(libraries('win32'), ['lease.node','fonts.node','notification.node','velopack.node'])
})
test('Velopack installation identity stays separate from service bundle identity', () => {
  const manifest = releaseManifest({ appId: 'scholarseed', version: '0.2.1', archType: 'windows-amd64',
    product: { config: { product_id: 'scholarseed', bundle_id: 'com.scholarseed.desktop', update_channel: 'release', build_number: '202610161200' } } },
    '0.2.1-build.202610161200', [], [], null)
  const decoded = JSON.parse(Buffer.from(envelope(manifest, null).manifest, 'base64'))
  assert.equal(decoded.app_id, 'scholarseed')
  assert.equal(decoded.product_id, 'scholarseed')
  assert.equal(decoded.bundle_id, 'com.scholarseed.desktop')
})

test('Velopack package signing keys remain independent from installer activation keys', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'velopack-trust-'))
  try {
    const key = crypto.generateKeyPairSync('ed25519').publicKey
    const other = crypto.generateKeyPairSync('ed25519').publicKey
    const raw = key.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
    const filename = path.join(directory, 'keys.json')
    fs.writeFileSync(filename, JSON.stringify({ release: raw }))
    assert.throws(() => packageKeys(filename, { online: key.export({ format: 'pem', type: 'spki' }) }), /must be distinct/)
    assert.deepEqual(packageKeys(filename, { online: other.export({ format: 'pem', type: 'spki' }) }), { release: raw })
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
