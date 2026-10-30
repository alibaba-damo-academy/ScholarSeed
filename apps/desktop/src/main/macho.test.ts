import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readMachArchitectures } from './macho.ts'

const ARM64 = 0x0100000c
const X64 = 0x01000007

function thin(cpu = ARM64, little = true, wide = true): Buffer {
  const b = Buffer.alloc(wide ? 32 : 28)
  const put = (value: number, offset: number): void => {
    if (little) b.writeUInt32LE(value, offset)
    else b.writeUInt32BE(value, offset)
  }
  put(wide ? 0xfeedfacf : 0xfeedface, 0)
  put(cpu, 4)
  put(0, 8)
  put(2, 12)
  return b
}

function fat(wide = false, little = false): Buffer {
  const b = Buffer.alloc(256)
  const put = (value: number, offset: number): void => {
    if (little) b.writeUInt32LE(value, offset)
    else b.writeUInt32BE(value, offset)
  }
  put(wide ? 0xcafebabf : 0xcafebabe, 0)
  put(2, 4)
  for (const [index, cpu] of [ARM64, X64].entries()) {
    const entry = 8 + index * (wide ? 32 : 20)
    const offset = 128 + index * 64
    put(cpu, entry)
    if (wide) {
      if (little) {
        b.writeBigUInt64LE(BigInt(offset), entry + 8)
        b.writeBigUInt64LE(32n, entry + 16)
      } else {
        b.writeBigUInt64BE(BigInt(offset), entry + 8)
        b.writeBigUInt64BE(32n, entry + 16)
      }
    } else {
      put(offset, entry + 8)
      put(32, entry + 12)
    }
    thin(cpu).copy(b, offset)
  }
  return b
}

async function inspect(bytes: Buffer, signal?: AbortSignal): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'macho-'))
  try {
    const file = join(dir, 'app binary')
    await writeFile(file, bytes)
    return await readMachArchitectures(file, signal)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

for (const little of [true, false]) {
  test(`thin arm64/x64 executable headers, little=${little}`, async () => {
    assert.deepEqual(await inspect(thin(ARM64, little)), ['arm64'])
    assert.deepEqual(await inspect(thin(X64, little)), ['x86_64'])
    assert.deepEqual(await inspect(thin(7, little, false)), [])
  })
  for (const wide of [false, true]) {
    test(`universal headers, wide=${wide}, little=${little}`, async () => {
      assert.deepEqual(await inspect(fat(wide, little)), ['arm64', 'x86_64'])
    })
  }
}

test('wrong architecture is not reported as compatible', async () => {
  assert.equal((await inspect(thin(X64))).includes('arm64'), false)
})

test('empty, unknown, truncated and non-executable headers fail closed', async () => {
  for (const length of [0, 4, 7, 8, 27, 31]) {
    await assert.rejects(inspect(thin().subarray(0, length)), /Mach-O/)
  }
  await assert.rejects(inspect(Buffer.alloc(32)), /Mach-O/)
  const library = thin()
  library.writeUInt32LE(6, 12)
  await assert.rejects(inspect(library), /Mach-O/)
  const commands = thin()
  commands.writeUInt32LE(1, 20)
  await assert.rejects(inspect(commands), /Mach-O/)
})

test('fat table bounds, slice overlap, header consistency and alignment fail closed', async () => {
  const mutations = [
    (b: Buffer) => b.writeUInt32BE(0, 4),
    (b: Buffer) => b.writeUInt32BE(65, 4),
    (b: Buffer) => b.writeUInt32BE(0xffffffff, 4),
    (b: Buffer) => b.writeUInt32BE(8, 16),
    (b: Buffer) => b.writeUInt32BE(250, 16),
    (b: Buffer) => b.writeUInt32BE(0xffffffff, 20),
    (b: Buffer) => b.writeUInt32BE(0, 20),
    (b: Buffer) => b.writeUInt32BE(128, 36),
    (b: Buffer) => b.writeUInt32BE(X64, 8),
    (b: Buffer) => b.writeUInt32BE(1, 12),
    (b: Buffer) => b.writeUInt32BE(32, 24),
    (b: Buffer) => b.writeUInt32BE(8, 24),
    (b: Buffer) => b.fill(0, 128, 160),
  ]
  for (const mutate of mutations) {
    const b = fat()
    mutate(b)
    await assert.rejects(inspect(b), /Mach-O/)
  }
  await assert.rejects(inspect(fat().subarray(0, 40)), /Mach-O/)
})

test('fat64 unsafe integers and nonzero reserved fields fail closed', async () => {
  for (const offset of [16, 24]) {
    const b = fat(true)
    b.writeBigUInt64BE(0xffffffffffffffffn, offset)
    await assert.rejects(inspect(b), /Mach-O/)
  }
  const b = fat(true)
  b.writeUInt32BE(1, 36)
  await assert.rejects(inspect(b), /Mach-O/)
})

test('cancellation remains cancellation', async () => {
  const controller = new AbortController()
  const reason = new Error('candidate superseded')
  controller.abort(reason)
  await assert.rejects(inspect(thin(), controller.signal), (error) => error === reason)
})

test('updater uses the header reader and retains independent trust gates', () => {
  const source = readFileSync(new URL('./updater.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\/usr\/bin\/lipo/)
  assert.match(source, /await readMachArchitectures\(/)
  assert.match(source, /await verifyNotarization\(/)
  assert.match(source, /classifyMacosTrust\(identity/)
})

test(
  'reads the actual macOS executable without developer tools',
  {
    skip: process.platform !== 'darwin',
  },
  async () => {
    assert.ok(
      (await readMachArchitectures(process.execPath)).includes(
        process.arch === 'arm64' ? 'arm64' : 'x86_64'
      )
    )
    assert.ok(
      (await readMachArchitectures('/bin/ls')).includes(
        process.arch === 'arm64' ? 'arm64' : 'x86_64'
      )
    )
  }
)
