/** Streaming SSE frame decoding shared by product POST clients. */
const SSE_DATA_FIELD = 'data:'
const SSE_COMMENT_PREFIX = ':'

function completedSseFrame(line: string, data: string[]): string | null {
  const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
  if (!normalized) {
    if (data.length === 0) return null
    const payload = data.join('\n')
    data.splice(0, data.length)
    return payload
  }
  if (normalized.startsWith(SSE_COMMENT_PREFIX) || !normalized.startsWith(SSE_DATA_FIELD)) {
    return null
  }
  const value = normalized.slice(SSE_DATA_FIELD.length)
  data.push(value.startsWith(' ') ? value.slice(1) : value)
  return null
}

export async function* sseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const data: string[] = []
  let buffered = ''
  let reachedEnd = false
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) {
        reachedEnd = true
        break
      }
      buffered += decoder.decode(next.value, { stream: true })
      let newline = buffered.indexOf('\n')
      while (newline >= 0) {
        const frame = completedSseFrame(buffered.slice(0, newline), data)
        buffered = buffered.slice(newline + 1)
        if (frame !== null) yield frame
        newline = buffered.indexOf('\n')
      }
    }
    buffered += decoder.decode()
    if (buffered) {
      const frame = completedSseFrame(buffered, data)
      if (frame !== null) yield frame
    }
    if (data.length > 0) yield data.join('\n')
  } finally {
    if (!reachedEnd) {
      try {
        await reader.cancel()
      } catch {
        // The transport may already be closed after a malformed frame.
      }
    }
    reader.releaseLock()
  }
}
