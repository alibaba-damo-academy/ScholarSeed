const fs = require('node:fs')

const STREAMS = ['stdout', 'stderr']
const CHUNK_BYTES = 64 * 1024

function filename(lock, scope, stream) {
  return `${lock}.${scope}.${stream}.log`
}

// A detached Windows process cannot inherit its parent's console handles.
// Independent readers leave the child writers usable even if the console dies.
function openOutput(lock, scope, interval, targets = process) {
  const handles = []
  const readers = []
  const stdio = ['ignore']
  let timer
  let error
  function forward(final = false) {
    for (const reader of readers) {
      const end = fs.fstatSync(reader.fd).size
      while (reader.position < end && (final || !reader.target.writableNeedDrain)) {
        const bytes = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - reader.position))
        const length = fs.readSync(reader.fd, bytes, 0, bytes.length, reader.position)
        if (!length) break
        reader.position += length
        reader.target.write(bytes.subarray(0, length))
      }
    }
  }
  try {
    for (const stream of STREAMS) {
      const file = filename(lock, scope, stream)
      const writer = fs.openSync(file, 'wx', 0o600)
      handles.push(writer)
      stdio.push(writer)
      const fd = fs.openSync(file, 'r')
      handles.push(fd)
      readers.push({ fd, target: targets[stream], position: 0 })
    }
    timer = setInterval(() => {
      try { forward() }
      catch (cause) { error = cause; clearInterval(timer) }
    }, interval)
    timer.unref()
  } catch (cause) {
    for (const fd of handles) fs.closeSync(fd)
    throw cause
  }
  return {
    stdio,
    close() {
      clearInterval(timer)
      try {
        if (error) throw error
        forward(true)
      } finally {
        for (const fd of handles) fs.closeSync(fd)
      }
    }
  }
}

function removeOutput(lock, scope) {
  for (const stream of STREAMS) fs.rmSync(filename(lock, scope, stream), { force: true })
}

module.exports = { openOutput, removeOutput }
