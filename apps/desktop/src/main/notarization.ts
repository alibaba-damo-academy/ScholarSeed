import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'

export const NOTARIZATION_TICKET_LIMIT = 1024 * 1024
const TICKET_PATH = ['Contents', 'CodeResources']
const NATIVE_UNTRUSTED = 'ERR_NOTARIZATION_UNTRUSTED'
const NATIVE_UNAVAILABLE = 'ERR_NOTARIZATION_UNAVAILABLE'

export class NotarizationError extends Error {
  constructor(
    readonly verdict: 'untrusted' | 'unavailable' | 'indeterminate',
    message: string
  ) {
    super(message)
    this.name = 'NotarizationError'
  }
}

export interface OfflineNotarization {
  verifySignature(appPath: string): Promise<void>
  verify(ticket: Buffer, hashes: Buffer[]): Promise<void>
}

/** Only SHA-256 code directories are supported by the offline ticket contract.
 * Obtain one independently from codesign for every architecture in the target.
 */
export function notarizationHash(metadata: string): Buffer {
  const normalized = metadata.replace(/\r\n/g, '\n')
  const hashes = [...normalized.matchAll(/^CDHash=([0-9a-fA-F]{40})$/gm)]
  if (!/^Hash type=sha256 size=32$/m.test(normalized) || hashes.length !== 1)
    throw new NotarizationError('untrusted', 'Missing or unsupported target code directory digest')
  return Buffer.from(hashes[0][1], 'hex')
}

/** Read the exact attached ticket rather than trusting a cached notarization result.
 * The native worker owns a copy and cannot mutate the source. Cancellation and
 * timeouts stop the caller; any remaining read-only trust evaluation cannot install.
 */
export async function verifyNotarization(check: {
  appPath: string
  hashes: Buffer[]
  native: OfflineNotarization | undefined
  timeoutMs: number
  signal?: AbortSignal
}): Promise<void> {
  check.signal?.throwIfAborted()
  if (!check.native)
    throw new NotarizationError('unavailable', 'Offline Apple ticket verifier is unavailable')
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const verify = async (): Promise<void> => {
    await check.native!.verifySignature(check.appPath)
    check.signal?.throwIfAborted()
    const file = await open(
      join(check.appPath, ...TICKET_PATH),
      constants.O_RDONLY | constants.O_NOFOLLOW
    )
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size <= 0 || stat.size > NOTARIZATION_TICKET_LIMIT)
        throw new NotarizationError('untrusted', 'Invalid attached Apple ticket size or type')
      const ticket = Buffer.alloc(stat.size)
      let done = 0
      while (done < ticket.length) {
        check.signal?.throwIfAborted()
        const { bytesRead } = await file.read(ticket, done, ticket.length - done, done)
        if (!bytesRead) throw new NotarizationError('untrusted', 'Truncated attached Apple ticket')
        done += bytesRead
      }
      check.signal?.throwIfAborted()
      await check.native!.verify(ticket, check.hashes)
      check.signal?.throwIfAborted()
    } finally {
      await file.close()
    }
  }
  try {
    await Promise.race([
      verify(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new NotarizationError('indeterminate', 'Offline ticket verification timed out')),
          check.timeoutMs
        )
        abort = () => reject(check.signal!.reason)
        check.signal?.addEventListener('abort', abort, { once: true })
        if (check.signal?.aborted) abort()
      }),
    ])
    check.signal?.throwIfAborted()
  } catch (error) {
    check.signal?.throwIfAborted()
    if (error instanceof NotarizationError) throw error
    const code = (error as NodeJS.ErrnoException)?.code
    const verdict =
      code === NATIVE_UNAVAILABLE
        ? 'unavailable'
        : [NATIVE_UNTRUSTED, 'ENOENT', 'ELOOP'].includes(code ?? '')
          ? 'untrusted'
          : 'indeterminate'
    throw new NotarizationError(
      verdict,
      `Offline Apple ticket verification failed: ${String(error)}`
    )
  } finally {
    if (timer) clearTimeout(timer)
    if (abort) check.signal?.removeEventListener('abort', abort)
  }
}
