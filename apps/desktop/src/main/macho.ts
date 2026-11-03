import { open } from 'node:fs/promises'

// Layouts: Apple cctools include/mach-o/{loader,fat}.h. This is an
// architecture gate only; codesign and notarization remain separate gates.
const WORD = 4
const PREFIX_SIZE = 8
const CPU_OFFSET = 4
const SUBTYPE_OFFSET = 8
const FILETYPE_OFFSET = 12
const COMMAND_BYTES_OFFSET = 20
const MH_EXECUTE = 2
const MAX_SLICES = 64
const CPU_NAMES = new Map([
  [0x01000007, 'x86_64'],
  [0x0100000c, 'arm64'],
])
const THIN = new Map([
  [0xfeedface, { little: false, size: 28 }],
  [0xcefaedfe, { little: true, size: 28 }],
  [0xfeedfacf, { little: false, size: 32 }],
  [0xcffaedfe, { little: true, size: 32 }],
])
const FAT = new Map([
  [0xcafebabe, { little: false, wide: false, size: 20 }],
  [0xbebafeca, { little: true, wide: false, size: 20 }],
  [0xcafebabf, { little: false, wide: true, size: 32 }],
  [0xbfbafeca, { little: true, wide: true, size: 32 }],
])
const FAT_OFFSET = 8
const FAT_SIZE32 = 12
const FAT_SIZE64 = 16
const FAT_ALIGN32 = 16
const FAT_ALIGN64 = 24
const FAT_RESERVED64 = 28
const MAX_ALIGN32 = 31
const MAX_ALIGN64 = 63
const READ_MODE = 'r'

function invalid(): never {
  throw new Error('invalid or truncated Mach-O executable')
}

function uint(buffer: Buffer, offset: number, little: boolean): number {
  return little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
}

/** Bounded positional reads: never load an entire executable or invoke a
 * developer tool. Fat entries must describe real, non-overlapping thin slices.
 * Cancellation propagates unchanged and the descriptor is always closed.
 */
export async function readMachArchitectures(path: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted()
  const file = await open(path, READ_MODE)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) invalid()
    const read = async (offset: number, length: number): Promise<Buffer> => {
      signal?.throwIfAborted()
      if (offset < 0 || length < 0 || offset > stat.size - length) invalid()
      const buffer = Buffer.alloc(length)
      let done = 0
      while (done < length) {
        signal?.throwIfAborted()
        const { bytesRead } = await file.read(buffer, done, length - done, offset + done)
        if (!bytesRead) invalid()
        done += bytesRead
      }
      signal?.throwIfAborted()
      return buffer
    }
    const thin = async (
      offset: number,
      length: number
    ): Promise<{ cpu: number; subtype: number }> => {
      if (length < PREFIX_SIZE) invalid()
      const prefix = await read(offset, PREFIX_SIZE)
      const layout = THIN.get(prefix.readUInt32BE())
      if (!layout || length < layout.size) invalid()
      const header = await read(offset, layout.size)
      if (
        uint(header, FILETYPE_OFFSET, layout.little) !== MH_EXECUTE ||
        uint(header, COMMAND_BYTES_OFFSET, layout.little) > length - layout.size
      )
        invalid()
      return {
        cpu: uint(header, CPU_OFFSET, layout.little),
        subtype: uint(header, SUBTYPE_OFFSET, layout.little),
      }
    }
    const prefix = await read(0, PREFIX_SIZE)
    const magic = prefix.readUInt32BE()
    const layout = FAT.get(magic)
    const cpus: number[] = []
    if (!layout) {
      cpus.push((await thin(0, stat.size)).cpu)
    } else {
      const count = uint(prefix, WORD, layout.little)
      if (!count || count > MAX_SLICES) invalid()
      const tableEnd = PREFIX_SIZE + count * layout.size
      const table = await read(PREFIX_SIZE, count * layout.size)
      const ranges: Array<{ start: number; end: number }> = []
      for (let index = 0; index < count; index++) {
        const entry = table.subarray(index * layout.size, (index + 1) * layout.size)
        const wide = (offset: number): bigint =>
          layout.little ? entry.readBigUInt64LE(offset) : entry.readBigUInt64BE(offset)
        const startBig = layout.wide
          ? wide(FAT_OFFSET)
          : BigInt(uint(entry, FAT_OFFSET, layout.little))
        const sizeBig = layout.wide
          ? wide(FAT_SIZE64)
          : BigInt(uint(entry, FAT_SIZE32, layout.little))
        const alignment = uint(entry, layout.wide ? FAT_ALIGN64 : FAT_ALIGN32, layout.little)
        if (
          startBig < BigInt(tableEnd) ||
          sizeBig < BigInt(PREFIX_SIZE) ||
          startBig + sizeBig > BigInt(stat.size) ||
          alignment > (layout.wide ? MAX_ALIGN64 : MAX_ALIGN32) ||
          startBig % (1n << BigInt(alignment)) !== 0n ||
          (layout.wide && uint(entry, FAT_RESERVED64, layout.little) !== 0)
        )
          invalid()
        const start = Number(startBig)
        const size = Number(sizeBig)
        const end = start + size
        if (ranges.some((range) => start < range.end && end > range.start)) invalid()
        ranges.push({ start, end })
        const slice = await thin(start, size)
        if (
          slice.cpu !== uint(entry, 0, layout.little) ||
          slice.subtype !== uint(entry, WORD, layout.little)
        )
          invalid()
        cpus.push(slice.cpu)
      }
    }
    return [...new Set(cpus.flatMap((cpu) => CPU_NAMES.get(cpu) ?? []))]
  } finally {
    await file.close()
  }
}
