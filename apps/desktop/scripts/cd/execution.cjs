// SecAssessment (spctl) does not complete the first-exec scan on macOS 13.
// Wait for a fixed, side-effect-free handshake before running short functional probes.
const { spawn } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const { executableDigest } = require('../shared/digest.cjs')
const { containedFile } = require('./browser.cjs')
const { BROWSER_NODE_RELATIVE } = require('../../runtime/browser.cjs')

const START_TIMEOUT_MS = 300_000
const EXIT_TIMEOUT_MS = 30_000
const OUTPUT_BYTES = 4096
const PREFIX = '[mac-execution]'
const READY = 'scholarseed-execution-ready'
const SCRIPT = `process.stdout.write(${JSON.stringify(READY + '\n')})`
const ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' }

function waitForExecution(executable, args, options = {}) {
  const { startTimeout = START_TIMEOUT_MS, exitTimeout = EXIT_TIMEOUT_MS,
    log = record => console.log(`${PREFIX} ${JSON.stringify(record)}`) } = options
  return new Promise((resolve, reject) => {
    const started = performance.now()
    let readyAt = null
    let stdout = ''
    let stderr = ''
    let failure = null
    const child = spawn(executable, args, { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    log({ stage: 'start', pid: child.pid, timeout_ms: startTimeout })
    const fail = error => {
      if (failure) return
      failure = error
      // Only our exact handshake child is owned; never kill by name or unmount here.
      child.kill('SIGKILL')
    }
    let timer = setTimeout(() => fail(new Error('macOS first execution did not become ready')), startTimeout)
    child.once('error', error => { failure ||= error })
    child.stdout.on('data', data => {
      stdout += data.toString('utf8')
      if (stdout.length > OUTPUT_BYTES) return fail(new Error('execution handshake output exceeded limit'))
      if (stdout === READY + '\n' && readyAt === null) {
        readyAt = performance.now()
        clearTimeout(timer)
        timer = setTimeout(() => fail(new Error('execution handshake did not exit after readiness')), exitTimeout)
        log({ stage: 'ready', pid: child.pid, seconds: (readyAt - started) / 1000 })
      }
    })
    child.stderr.on('data', data => { stderr = (stderr + data.toString('utf8')).slice(-OUTPUT_BYTES) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (!failure && (code !== 0 || signal || readyAt === null || stdout !== READY + '\n')) {
        failure = new Error('execution handshake failed')
      }
      const evidence = { stage: 'exit', status: failure ? 'failed' : 'passed', pid: child.pid,
        seconds: (performance.now() - started) / 1000,
        ready_seconds: readyAt === null ? null : (readyAt - started) / 1000, code, signal }
      log({ ...evidence, ...(failure ? { error: failure.message, stderr } : {}) })
      if (failure) reject(Object.assign(failure, { evidence }))
      else resolve(evidence)
    })
  })
}

async function verifyExecution(resources, frozen) {
  if (!frozen || frozen.path !== BROWSER_NODE_RELATIVE) throw new Error('frozen execution input is missing')
  const executable = containedFile(resources, frozen.path)
  if (await executableDigest(executable) !== frozen.executable_sha256) {
    throw new Error('execution input differs from frozen browser Node')
  }
  return waitForExecution(executable, ['-e', SCRIPT])
}

module.exports = { verifyExecution, waitForExecution, READY }
