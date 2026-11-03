const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')
const os = require('node:os')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const fixture = require('./notarization.fixture.json')
const library = process.env.SCHOLARSEED_NOTARIZATION_LIBRARY
assert.ok(library && path.isAbsolute(library), 'select the compiled offline ticket verifier')
const native = require(library)
const ticket = Buffer.from(fixture.ticket, 'base64')
const hashes = [Buffer.from(fixture.cdhash, 'hex')]
const invalid = (error) => error.code === 'ERR_NOTARIZATION_UNTRUSTED'
const FAT_MAGIC = 0xcafebabe
const FAT_MAGIC_64 = 0xcafebabf
const MACHO_MAGIC_64 = 0xfeedfacf
const FAT_HEADER_SIZE = 8
const FAT_ARCH_SIZE = 20
const FAT_ARCH_64_SIZE = 32
const MACHO_FLAGS_OFFSET = 24
const MH_NOUNDEFS = 1

// The fat header and inter-slice padding are not signed. Each supported
// little-endian Mach-O slice's header is covered by its own code signature.
function signedHeaderOffsets(bytes) {
  const magic = bytes.readUInt32BE(0)
  let slices = [0]
  if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
    const count = bytes.readUInt32BE(4)
    const stride = magic === FAT_MAGIC ? FAT_ARCH_SIZE : FAT_ARCH_64_SIZE
    assert.ok(count > 0 && FAT_HEADER_SIZE + count * stride <= bytes.length)
    slices = Array.from({ length: count }, (_, index) => {
      const entry = FAT_HEADER_SIZE + index * stride
      const offset =
        magic === FAT_MAGIC
          ? bytes.readUInt32BE(entry + 8)
          : Number(bytes.readBigUInt64BE(entry + 8))
      assert.ok(Number.isSafeInteger(offset) && offset >= FAT_HEADER_SIZE + count * stride)
      return offset
    })
  }
  return slices.map((offset) => {
    assert.ok(offset + MACHO_FLAGS_OFFSET + 4 <= bytes.length)
    assert.equal(bytes.readUInt32LE(offset), MACHO_MAGIC_64, 'expected a 64-bit Mach-O slice')
    return offset + MACHO_FLAGS_OFFSET
  })
}

async function rejects(bytes, digests = hashes) {
  await assert.rejects(async () => native.verify(bytes, digests), invalid)
}

test('real Apple-signed ticket verifies without a network lookup or ticket-cache verdict', async () => {
  await native.verify(ticket, hashes)
})

test('every architecture must be explicitly covered by the signed ticket', async () => {
  await rejects(ticket, [Buffer.alloc(20)])
  await rejects(ticket, [...hashes, Buffer.alloc(20)])
  await rejects(ticket, [])
  await rejects(ticket, [Buffer.alloc(19)])
  await rejects(ticket, Array(9).fill(hashes[0]))
})

test('truncation, size limits and unrecognized ticket layouts fail closed', async () => {
  for (const length of [0, 1, 15, 16, 39, ticket.length - 1])
    await rejects(ticket.subarray(0, length))
  await rejects(Buffer.alloc(1024 * 1024 + 1))
  for (const offset of [0, 4, 8, 12, 16]) {
    const changed = Buffer.from(ticket)
    changed[offset] ^= 0xff
    await rejects(changed)
  }
})

test('certificate substitution, signed content corruption and signature corruption are rejected', async () => {
  const content = 16 + ticket.readUInt32LE(8)
  const signature = content + ticket.readUInt32LE(12)
  for (const offset of [
    60,
    290,
    700,
    content + 16,
    content + 50,
    signature + 6,
    ticket.length - 1,
  ]) {
    const changed = Buffer.from(ticket)
    changed[offset] ^= 1
    await rejects(changed)
  }
})

test('a transplanted digest cannot turn an authentic ticket into authorization for another build', async () => {
  const changed = Buffer.from(ticket)
  const content = 16 + ticket.readUInt32LE(8)
  const hash = Buffer.alloc(20, 0x42)
  hash.copy(changed, content + 25)
  await rejects(changed, [hash])
})

test('unknown flags, digest types and count overflows are rejected', async () => {
  const content = 16 + ticket.readUInt32LE(8)
  for (const offset of [
    content,
    content + 4,
    content + 6,
    content + 8,
    content + 12,
    content + 24,
  ]) {
    const changed = Buffer.from(ticket)
    changed[offset] ^= 0xff
    await rejects(changed)
  }
})

test('worker copies input before callers can mutate it', async () => {
  const bytes = Buffer.from(ticket)
  const digest = Buffer.from(hashes[0])
  const verification = native.verify(bytes, [digest])
  bytes.fill(0)
  digest.fill(0)
  await verification
})

test('a prior success never authorizes a later malformed ticket', async () => {
  await native.verify(ticket, hashes)
  await rejects(Buffer.alloc(ticket.length))
})

test('system code signature passes offline and signed header tampering in every slice is rejected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-signature-'))
  try {
    const executable = path.join(root, 'true')
    await fs.copyFile('/usr/bin/true', executable)
    await native.verifySignature(executable)
    const verify = (file) =>
      execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', file], {
        stdio: 'pipe',
        timeout: 10000,
      })
    verify(executable)
    const bytes = await fs.readFile(executable)
    for (const offset of signedHeaderOffsets(bytes)) {
      const changed = Buffer.from(bytes)
      // Toggle MH_NOUNDEFS without damaging load-command sizes or slice layout.
      changed[offset] ^= MH_NOUNDEFS
      const corrupted = path.join(root, `true-${offset}`)
      await fs.writeFile(corrupted, changed, { mode: 0o700 })
      assert.throws(
        () => verify(corrupted),
        (error) =>
          error.status !== 0 && /code or signature have been modified/.test(String(error.stderr))
      )
      await assert.rejects(native.verifySignature(corrupted), invalid)
    }
    await assert.rejects(async () => native.verifySignature('relative'), invalid)
    await assert.rejects(native.verifySignature(path.join(root, 'missing')), invalid)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a cryptographically valid ticket signed by a foreign certificate is rejected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foreign-ticket-'))
  try {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const key = path.join(root, 'key.pem')
    const cert = path.join(root, 'cert.der')
    await fs.writeFile(key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    execFileSync(
      '/usr/bin/openssl',
      [
        'req',
        '-new',
        '-x509',
        '-key',
        key,
        '-outform',
        'DER',
        '-out',
        cert,
        '-subj',
        '/CN=Software Ticket Signing/O=Apple Inc.',
      ],
      { stdio: 'pipe', timeout: 10000 }
    )
    const certificate = await fs.readFile(cert)
    const sequenceHeader = Buffer.from([
      0x30,
      0x82,
      (certificate.length * 2) >> 8,
      (certificate.length * 2) & 255,
    ])
    const chain = Buffer.concat([sequenceHeader, certificate, certificate])
    const contentOffset = 16 + ticket.readUInt32LE(8)
    const content = ticket.subarray(contentOffset, contentOffset + ticket.readUInt32LE(12))
    const header = Buffer.from(ticket.subarray(0, 16))
    header.writeUInt32LE(chain.length, 8)
    const message = Buffer.concat([header, chain, content])
    const signature = crypto.sign('sha256', message, privateKey)
    assert.equal(crypto.verify('sha256', message, publicKey, signature), true)
    const slot = Buffer.alloc(72)
    signature.copy(slot)
    await rejects(Buffer.concat([message, slot]))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
