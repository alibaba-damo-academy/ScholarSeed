const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const OPEN_ATTEMPTS = 21
const OPEN_DELAY_MS = 250
const OPEN_BUDGET_MS = 5000
const LOCK_ERRORS = new Set(['EBUSY', 'EACCES', 'EPERM'])
const sleeper = new Int32Array(new SharedArrayBuffer(4))

// Retry only acquisition: callers must never replay a partially completed write.
function openExecutable(filename, flags, stage) {
  const started = performance.now()
  for (let attempt = 1; ; attempt++) {
    try { return fs.openSync(filename, flags) }
    catch (error) {
      const remaining = OPEN_BUDGET_MS - (performance.now() - started)
      const retry = process.platform === 'win32' && LOCK_ERRORS.has(error.code) &&
        attempt < OPEN_ATTEMPTS && remaining > 0
      console.log(`[file-open] ${JSON.stringify({ stage, file: path.basename(filename),
        event: retry ? 'retry' : 'failed', code: error.code, attempt,
        maxAttempts: OPEN_ATTEMPTS, elapsedMs: Math.round(performance.now() - started) })}`)
      if (!retry) throw error
      Atomics.wait(sleeper, 0, 0, Math.min(OPEN_DELAY_MS, remaining))
    }
  }
}

module.exports = { openExecutable }
