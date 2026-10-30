// Process-local proof of the trusted DMG -> ZIP conversion. Disk state is only a hint.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { verifyApplicationArchive } from './archive.ts'
import { assertSquirrelArchiveSize, type SquirrelArchive } from './squirrel.ts'
import type { LatestVersionMeta } from '../updates.ts'

export class PreparedArtifactChangedError extends Error {}

export function preparedIdentity(meta: LatestVersionMeta): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        meta.id,
        meta.product_id,
        meta.version,
        meta.build_number,
        meta.arch_type,
        meta.sha512.toLowerCase(),
        meta.file_size,
        meta.team_id,
        meta.bundle_id,
        meta.channel,
      ])
    )
    .digest('hex')
}

async function digest(
  path: string,
  expectedSize: number | undefined,
  signal?: AbortSignal
): Promise<SquirrelArchive> {
  if (process.platform !== 'darwin') throw new Error('macOS prepared archive only')
  signal?.throwIfAborted()
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  ).catch((error: NodeJS.ErrnoException) => {
    if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EMLINK'].includes(error.code ?? ''))
      throw new PreparedArtifactChangedError('Prepared artifact path changed', { cause: error })
    throw error
  })
  try {
    const before = await file.stat()
    if (
      !before.isFile() ||
      before.size <= 0 ||
      (expectedSize !== undefined && before.size !== expectedSize)
    )
      throw new PreparedArtifactChangedError('Invalid prepared artifact size or type')
    if (expectedSize === undefined) assertSquirrelArchiveSize(before.size)
    const hash = createHash('sha512')
    let size = 0
    for await (const chunk of file.createReadStream({ autoClose: false, signal })) {
      size += chunk.length
      if (size > before.size) throw new PreparedArtifactChangedError('Prepared artifact grew')
      hash.update(chunk)
    }
    const after = await file.stat()
    if (size !== before.size || after.size !== before.size)
      throw new PreparedArtifactChangedError('Prepared artifact changed')
    signal?.throwIfAborted()
    return Object.freeze({ path, size, sha512: hash.digest('hex') })
  } finally {
    await file.close()
  }
}

async function verifySource(
  meta: LatestVersionMeta,
  path: string,
  signal?: AbortSignal
): Promise<void> {
  const actual = await digest(path, meta.file_size, signal)
  if (actual.sha512 !== meta.sha512.toLowerCase())
    throw new PreparedArtifactChangedError('Prepared DMG digest differs')
}

export class PreparedArchive {
  private readonly release: string
  private constructor(
    private readonly meta: Readonly<LatestVersionMeta>,
    private readonly source: string,
    readonly archive: Readonly<SquirrelArchive>
  ) {
    this.release = preparedIdentity(meta)
  }

  /** Only the preparation owner supplies generate: it verifies the exact read-only
   * mounted source and invokes the system archiver. Never restore this proof from JSON.
   */
  static async create(
    meta: LatestVersionMeta,
    source: string,
    archive: string,
    generate: () => Promise<void>,
    signal?: AbortSignal
  ): Promise<PreparedArchive> {
    const candidate = Object.freeze({ ...meta })
    await verifySource(candidate, source, signal)
    await generate()
    signal?.throwIfAborted()
    const before = await digest(archive, undefined, signal)
    await verifyApplicationArchive(archive, signal)
    const after = await digest(archive, before.size, signal)
    if (before.sha512 !== after.sha512)
      throw new PreparedArtifactChangedError('Prepared ZIP changed during inspection')
    await verifySource(candidate, source, signal)
    return new PreparedArchive(candidate, source, after)
  }

  matches(meta: LatestVersionMeta, archive: SquirrelArchive): boolean {
    return (
      this.release === preparedIdentity(meta) &&
      this.archive.path === archive.path &&
      this.archive.size === archive.size &&
      this.archive.sha512 === archive.sha512.toLowerCase()
    )
  }

  /** Reverify the attached Apple-signed ticket on the very same DMG that
   * generated this ZIP, never on a mutable cached application directory. Native
   * Squirrel performs current nested/strict signature checks on its actual extraction.
   */
  async revalidate(
    inspectSource: () => Promise<void>,
    signal?: AbortSignal
  ): Promise<SquirrelArchive> {
    await verifySource(this.meta, this.source, signal)
    await this.verifyArchive(signal)
    await inspectSource()
    signal?.throwIfAborted()
    await verifySource(this.meta, this.source, signal)
    return await this.verifyArchive(signal)
  }

  private async verifyArchive(signal?: AbortSignal): Promise<SquirrelArchive> {
    const actual = await digest(this.archive.path, this.archive.size, signal)
    if (actual.sha512 !== this.archive.sha512)
      throw new PreparedArtifactChangedError('Prepared ZIP digest differs')
    return this.archive
  }
}
