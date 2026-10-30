const fs = require('node:fs')
const TIMEOUT_MS = 5_000
const RETRY_DELAY_MS = 250
const RETRYABLE = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM', 'ETXTBSY'])
function removeTemporary(directory, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let diagnosed = false
  for (;;) {
    try { fs.rmSync(directory, { recursive: true, force: true }); return }
    catch (error) {
      if (!diagnosed) {
        console.warn(`[cleanup-error] ${JSON.stringify({ code: error.code, syscall: error.syscall, path: error.path })}`)
        diagnosed = true
      }
      if (!RETRYABLE.has(error.code) || Date.now() >= deadline) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_DELAY_MS)
    }
  }
}
module.exports = { removeTemporary, TIMEOUT_MS }
