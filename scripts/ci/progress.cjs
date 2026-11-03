// Stream progress from a synchronous stage's owned child without altering its raw reports.
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const HEARTBEAT_MS = 10000
const POLL_MS = 200
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

async function forwardFailure(spec) {
  for (const name of ['stdout', 'stderr']) {
    process.stderr.write(`[ci:failure] ${spec.id} ${name} (${spec[name]})\n`)
    for await (const chunk of fs.createReadStream(spec[name])) {
      if (!process.stderr.write(chunk)) await once(process.stderr, 'drain')
    }
    process.stderr.write(`\n[ci:failure] ${spec.id} ${name} end\n`)
  }
}

function run(spec) {
  const started = Date.now()
  const offsets = new Map()
  const active = new Map()
  let lastHeartbeat = started
  const log = message => process.stderr.write(`[ci:progress] [${new Date().toISOString()}] ${spec.id} ${message}\n`)
  const poll = () => {
    for (const name of fs.readdirSync(spec.progress)) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(spec.progress, name)
      const offset = offsets.get(name) || 0
      const bytes = fs.readFileSync(file)
      const end = bytes.lastIndexOf(10)
      if (end < offset) continue
      for (const line of bytes.subarray(offset, end + 1).toString('utf8').trim().split('\n')) {
        const event = JSON.parse(line)
        const key = `${event.pid}:${event.kind}:${event.id}`
        if (event.status === 'starting') active.set(key, event)
        else active.delete(key)
        log(`${event.kind} ${event.id} ${event.status}${event.durationMs == null ? '' : ` ${(event.durationMs / 1000).toFixed(3)}s`} pid=${event.pid}`)
      }
      offsets.set(name, end + 1)
    }
    if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
      lastHeartbeat = Date.now()
      log(`running elapsed=${((lastHeartbeat - started) / 1000).toFixed(1)}s active=${[...active.values()].map(event => event.id).join(', ') || 'child process'}`)
    }
  }
  const stdout = fs.openSync(spec.stdout, 'w')
  const stderr = fs.openSync(spec.stderr, 'w')
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: process.env,
    shell: spec.shell, timeout: spec.timeout, windowsHide: true })
  let error
  const counts = { stdout: 0, stderr: 0 }
  for (const [name, fd] of [['stdout', stdout], ['stderr', stderr]]) {
    child[name].on('data', chunk => {
      counts[name] += chunk.length
      if (counts[name] > MAX_OUTPUT_BYTES) {
        error = { code: 'ENOBUFS', message: `${name} exceeded output limit` }
        child.kill()
      } else fs.writeSync(fd, chunk)
    })
  }
  child.on('error', value => { error = { code: value.code, message: value.message } })
  const timer = setInterval(() => {
    try { poll() } catch (value) { error = { code: 'EPROGRESS', message: value.message }; child.kill() }
  }, POLL_MS)
  child.on('close', async (status, signal) => {
    clearInterval(timer)
    try { poll() } catch (value) { error = { code: 'EPROGRESS', message: value.message } }
    fs.closeSync(stdout)
    fs.closeSync(stderr)
    if (signal === 'SIGTERM' && !error) error = { code: 'ETIMEDOUT', message: 'stage terminated' }
    if (error) log(`runner failed code=${error.code}: ${error.message}`)
    if (error || status !== 0) {
      try { await forwardFailure(spec) } catch (value) {
        error ||= { code: 'EOUTPUT', message: value.message }
        log(`failure output forwarding failed: ${value.message}`)
      }
    }
    fs.writeFileSync(spec.result, JSON.stringify({ status, signal, error }))
    process.exitCode = error ? 1 : status ?? 1
  })
}
module.exports = { run, HEARTBEAT_MS }
if (require.main === module) run(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')))
