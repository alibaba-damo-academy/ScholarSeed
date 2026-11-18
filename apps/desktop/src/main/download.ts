import { createWriteStream, existsSync, rmSync, statfsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { UpdateTransportError } from './retry.ts'

const HTTP_OK = 200
const HTTP_PARTIAL_CONTENT = 206
const HTTP_RANGE_NOT_SATISFIABLE = 416
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000

/** 已落盘的部分就是续传起点；完整或超长的文件各有自己的处置。 */
function resumePointOf(destination: string, expectedSize: number): number {
  if (!existsSync(destination)) return 0
  const size = statSync(destination).size
  if (size === expectedSize) return expectedSize
  if (size > expectedSize) {
    // 比发布元数据还大，不是同一个包：不能拿它当续传起点。
    rmSync(destination, { force: true })
    return 0
  }
  return size
}

export function assertDownloadSpace(destination: string, expectedSize: number): void {
  const remaining = expectedSize - resumePointOf(destination, expectedSize)
  if (remaining > 0) assertUpdateSpace(dirname(destination), BigInt(remaining))
}

export function assertUpdateSpace(path: string, needed: bigint): void {
  const { bavail, bsize } = statfsSync(path, { bigint: true })
  if (bavail * bsize < needed)
    throw Object.assign(new Error('ENOSPC: insufficient space for the update'), { code: 'ENOSPC' })
}

/**
 * Stream the package to disk with an idle timeout for headers and body bytes.
 *
 * resumeFrom > 0 时发 Range 请求：206 追加、200 表示服务端没理会 Range（签名链接
 * 换了对象之类），此时必须截断重写 —— 把两段不同来源的字节拼在一起只会得到一个
 * 哈希永远对不上的文件。
 */
async function streamToFile(
  url: string,
  destination: string,
  expectedSize: number,
  resumeFrom: number,
  onProgress: (percent: number, receivedBytes: number) => void,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number
): Promise<number> {
  const timeout = new AbortController()
  const downloadSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
  const stall = () => timeout.abort(new DOMException('Update download stalled', 'TimeoutError'))
  let timer = setTimeout(stall, idleTimeoutMs)
  const refreshTimeout = () => {
    clearTimeout(timer)
    timer = setTimeout(stall, idleTimeoutMs)
  }
  try {
    const response = await fetch(url, {
      signal: downloadSignal,
      ...(resumeFrom > 0 ? { headers: { Range: `bytes=${resumeFrom}-` } } : {}),
    })
    if (response.status === HTTP_RANGE_NOT_SATISFIABLE) {
      await response.body?.cancel()
      return response.status
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new UpdateTransportError(response.status)
    }
    const partial = response.status === HTTP_PARTIAL_CONTENT
    const start = partial ? resumeFrom : 0
    const contentLength = response.headers.get('content-length')
    if (contentLength && Number(contentLength) !== expectedSize - start) {
      await response.body.cancel()
      throw new Error('download Content-Length differs from release metadata')
    }
    refreshTimeout()
    const output = createWriteStream(destination, { flags: partial ? 'a' : 'w' })
    let received = start
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (chunk.length > 0) refreshTimeout()
        received += chunk.length
        if (received > expectedSize) {
          callback(new Error('download exceeds release size'))
          return
        }
        onProgress(Math.min(100, Math.round((received / expectedSize) * 100)), received)
        callback(null, chunk)
      },
    })
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      counter,
      output,
      { signal: downloadSignal }
    )
    if (received !== expectedSize || statSync(destination).size !== expectedSize) {
      throw new Error(`download size mismatch: got ${received}, expected ${expectedSize}`)
    }
    return response.status
  } catch (error) {
    downloadSignal.throwIfAborted()
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function downloadWithProgress(
  url: string,
  destination: string,
  expectedSize: number,
  onProgress: (percent: number, receivedBytes: number) => void,
  signal?: AbortSignal,
  idleTimeoutMs = DOWNLOAD_IDLE_TIMEOUT_MS
): Promise<void> {
  const resumeFrom = resumePointOf(destination, expectedSize)
  if (resumeFrom === expectedSize) {
    // 上一轮已经下完了（客户端在校验前被关掉）：不必再走一次网络。
    onProgress(100, expectedSize)
    return
  }
  onProgress(Math.min(100, Math.round((resumeFrom / expectedSize) * 100)), resumeFrom)
  const status = await streamToFile(
    url,
    destination,
    expectedSize,
    resumeFrom,
    onProgress,
    signal,
    idleTimeoutMs
  )
  if (status === HTTP_RANGE_NOT_SATISFIABLE) {
    rmSync(destination, { force: true })
    const fresh = await streamToFile(
      url,
      destination,
      expectedSize,
      0,
      onProgress,
      signal,
      idleTimeoutMs
    )
    if (fresh !== HTTP_OK) throw new Error(`download HTTP ${fresh}`)
    return
  }
  if (status !== HTTP_OK && status !== HTTP_PARTIAL_CONTENT) {
    throw new Error(`download HTTP ${status}`)
  }
}
