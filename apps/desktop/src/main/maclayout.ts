import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { MacZipIntegrityError } from './maccomponentfailure.ts'

const MAGIC = Buffer.from('SSZIP1\0')
const RECORD_BYTES = 25
const END = 255
// A member can contribute multiple component ranges. This includes the terminating record.
const MAX_RECORDS = 1_048_576
const BUFFER_BYTES = 256 * 1024

export interface MacZipSource {
  file: FileHandle
  bytes: number
}

class LayoutReader {
  private chunk: Buffer = Buffer.alloc(0)
  constructor(private readonly chunks: AsyncIterator<Buffer>) {}

  async take(maximum: number): Promise<Buffer> {
    if (!this.chunk.length) {
      const next = await this.chunks.next()
      if (next.done) return Buffer.alloc(0)
      this.chunk = next.value
    }
    const bytes = this.chunk.subarray(0, maximum)
    this.chunk = this.chunk.subarray(bytes.length)
    return bytes
  }

  async header(length: number): Promise<Buffer> {
    const first = await this.take(length)
    if (first.length === length) return first
    const bytes = Buffer.allocUnsafe(length)
    first.copy(bytes)
    let filled = first.length
    while (filled < length) {
      const next = await this.take(length - filled)
      if (!next.length) throw new Error('Truncated ZIP layout header')
      filled += next.copy(bytes, filled)
    }
    return bytes
  }
}

/** Coalesce the many small local headers and member ranges before writing to disk. */
class ZipWriter {
  private readonly buffer = Buffer.allocUnsafe(BUFFER_BYTES)
  private used = 0
  private written = 0
  private readonly hash = createHash('sha512')
  constructor(
    private readonly file: FileHandle,
    private readonly expectedSize: number
  ) {}

  checkRange(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.expectedSize - this.written)
      throw new Error('ZIP layout exceeds release size')
  }

  async append(bytes: Buffer): Promise<void> {
    this.checkRange(bytes.length)
    this.written += bytes.length
    let position = 0
    while (position < bytes.length) {
      const count = bytes.copy(this.buffer, this.used, position)
      position += count
      this.used += count
      if (this.used === this.buffer.length) await this.flush()
    }
  }

  private async flush(): Promise<void> {
    const data = this.buffer.subarray(0, this.used)
    this.hash.update(data)
    await this.file.writeFile(data)
    this.used = 0
  }

  async verify(sha512: string): Promise<void> {
    if (this.used) await this.flush()
    if (this.written !== this.expectedSize || this.hash.digest('hex') !== sha512)
      throw new MacZipIntegrityError('Reconstructed ZIP differs from release metadata')
  }
}

export async function assembleMacZip(
  output: FileHandle,
  layout: MacZipSource,
  components: MacZipSource[],
  expected: { file_size: number; sha512: string },
  signal: AbortSignal
): Promise<void> {
  const writer = new ZipWriter(output, expected.file_size)
  const scratch = Buffer.allocUnsafe(BUFFER_BYTES)
  await pipeline(
    layout.file.createReadStream({ start: 0, end: layout.bytes - 1, autoClose: false }),
    createGunzip(),
    async (source: AsyncIterable<Buffer>) => {
      const reader = new LayoutReader(source[Symbol.asyncIterator]())
      if (!(await reader.header(MAGIC.length)).equals(MAGIC))
        throw new Error('Invalid ZIP layout magic')
      for (let record = 0; record < MAX_RECORDS; record++) {
        signal.throwIfAborted()
        const header = await reader.header(RECORD_BYTES)
        let literal = Number(header.readBigUInt64LE(0))
        const index = header[8]
        let offset = Number(header.readBigUInt64LE(9))
        let length = Number(header.readBigUInt64LE(17))
        writer.checkRange(literal + length)
        while (literal > 0) {
          signal.throwIfAborted()
          const bytes = await reader.take(literal)
          if (!bytes.length) throw new Error('Truncated ZIP layout literal')
          await writer.append(bytes)
          literal -= bytes.length
        }
        if (index === END) {
          if (offset || length || (await reader.take(1)).length)
            throw new Error('Invalid ZIP layout end')
          await writer.verify(expected.sha512)
          return
        }
        const component = components[index]
        if (
          !component ||
          !Number.isSafeInteger(offset) ||
          !length ||
          offset > component.bytes - length
        )
          throw new Error('Invalid ZIP component range')
        while (length > 0) {
          signal.throwIfAborted()
          const { bytesRead } = await component.file.read(
            scratch,
            0,
            Math.min(length, scratch.length),
            offset
          )
          if (!bytesRead) throw new Error('Truncated ZIP component')
          await writer.append(scratch.subarray(0, bytesRead))
          offset += bytesRead
          length -= bytesRead
        }
      }
      throw new Error('ZIP layout record limit exceeded')
    },
    { signal }
  )
}
