import { createWriteStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { finished } from 'node:stream/promises'

function openLog(path, evidence) {
  const stream = createWriteStream(path, { flags: 'a', mode: 0o600 })
  const flushed = finished(stream, { cleanup: true }).catch((error) => evidence.abort(error))
  return { stream, flushed }
}

export function captureOutput(inputs, path, evidence, onLine) {
  const { stream, flushed } = openLog(path, evidence)
  const readers = []
  for (const input of inputs) {
    // Both pipes honor the shared file's backpressure. Parse each source separately.
    input.pipe(stream, { end: false })
    if (onLine) {
      const reader = createInterface({ input })
      reader.on('error', (error) => evidence.abort(error))
      reader.on('line', (line) => {
        if (evidence.signal.aborted) return
        try {
          onLine(line)
        } catch (error) {
          evidence.abort(error)
        }
      })
      readers.push(reader)
    } else {
      input.on('error', (error) => evidence.abort(error))
    }
  }
  stream.on('error', () => {
    // A failed destination cannot drain. Let the owned processes finish shutting down.
    for (const input of inputs) input.resume()
  })
  return () => {
    for (const reader of readers) reader.close()
    for (const input of inputs) {
      input.unpipe(stream)
      input.resume()
    }
    stream.end()
    return flushed
  }
}

export function createTimeline(path, records, evidence) {
  const { stream, flushed } = openLog(path, evidence)
  let next = 0
  let closing = false
  function writeAvailable() {
    if (stream.destroyed || stream.writableEnded) return
    try {
      // Reuse the report's records as the backlog instead of queueing serialized copies.
      while (!stream.writableNeedDrain && next < records.length) {
        stream.write(`${JSON.stringify(records[next++])}\n`)
      }
      if (closing && next === records.length) stream.end()
    } catch (error) {
      stream.destroy(error)
    }
  }
  stream.on('drain', writeAvailable)
  return {
    emit(event, data = {}) {
      records.push({ ...data, observedAt: Date.now(), event })
      writeAvailable()
    },
    finish() {
      closing = true
      writeAvailable()
      return flushed
    },
  }
}
