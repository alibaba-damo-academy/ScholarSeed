const path = require('node:path')
const { spawn } = require('node:child_process')

const START_BYTE = 1
const FRAME_BYTES = 4096
const DEADLINE_MS = 40000
const REFUSED_EXIT = 125
const SIGNALS = new Set(['SIGINT', 'SIGTERM'])
const LOOPBACK = '127.0.0.1'

function argumentsFor(argv) {
  if (argv.length !== 8 || argv[0] !== '--executable' || argv[2] !== '--root' ||
      argv[4] !== '--port' || argv[6] !== '--profile' || !/^[0-9]+$/.test(argv[5]) ||
      Number(argv[5]) < 1 || Number(argv[5]) > 65535 ||
      [argv[1], argv[3], argv[7]].some(value => !path.isAbsolute(value) || value.includes('\0')))
    throw new Error('invalid private development worker arguments')
  return { executable: argv[1], root: argv[3], port: Number(argv[5]), profile: argv[7] }
}

function main(argv = process.argv.slice(2)) {
  const settings = argumentsFor(argv)
  if (!process.send) throw new Error('private development worker requires its inherited IPC channel')
  let child
  let refused = false
  let granted = false
  let finished = false
  let buffer = Buffer.alloc(0)
  const report = (value, completed = () => {}) => {
    if (process.connected) process.send(value, () => completed())
    else completed()
  }
  const finish = status => {
    finished = true
    clearTimeout(timer)
    buffer.fill(0)
    buffer = Buffer.alloc(0)
    process.exitCode = status
    process.stdin.destroy()
    if (process.connected) process.disconnect()
  }
  const reject = () => {
    if (finished) return
    refused = true
    clearTimeout(timer)
    buffer.fill(0)
    buffer = Buffer.alloc(0)
    report({ phase: 'refused', code: REFUSED_EXIT })
    if (!child) finish(REFUSED_EXIT)
  }
  const timer = setTimeout(reject, DEADLINE_MS)
  process.on('message', value => {
    if (finished) return
    if (!value || JSON.stringify(value).length > FRAME_BYTES || Object.keys(value).length !== 2 ||
        value.operation !== 'stop' || !SIGNALS.has(value.signal)) { reject(); return }
    if (!child) { finish(value.signal === 'SIGINT' ? 130 : 143); return }
    child.kill(value.signal)
  })
  process.stdin.on('data', chunk => {
    if (finished) return
    if (child || refused) { reject(); return }
    if (!granted) {
      if (!chunk.length || chunk[0] !== START_BYTE) { reject(); return }
      granted = true
      chunk = chunk.subarray(1)
    }
    if (buffer.length + chunk.length > FRAME_BYTES) { reject(); return }
    buffer = Buffer.concat([buffer, chunk])
    const boundary = buffer.indexOf(10)
    if (boundary < 0) return
    if (boundary !== buffer.length - 1) { reject(); return }
    clearTimeout(timer)
    const env = { ...process.env }
    delete env.NODE_OPTIONS
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_CHANNEL_FD
    delete env.NODE_CHANNEL_SERIALIZATION_MODE
    delete env.NODE_UNIQUE_ID
    child = spawn(settings.executable, [settings.root,
      `--remote-debugging-port=${settings.port}`, `--remote-debugging-address=${LOOPBACK}`,
      `--user-data-dir=${settings.profile}`, '--development-control'], {
      cwd: settings.root, env, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true, detached: false
    })
    child.stdin.on('error', () => {})
    child.once('spawn', () => { report({ phase: 'spawned', pid: child.pid }) })
    child.once('error', () => { reject() })
    child.once('close', (status, signal) => {
      child.stdin.destroy()
      report({ phase: 'closed', pid: child.pid ?? null, status, signal }, () => {
        finish(refused ? REFUSED_EXIT : status ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1))
      })
    })
    const bootstrap = buffer
    buffer = Buffer.alloc(0)
    child.stdin.write(bootstrap, () => { bootstrap.fill(0) })
    process.stdin.pause()
  })
  process.stdin.once('end', () => { if (!child) reject() })
  process.stdin.once('error', reject)
  process.once('disconnect', () => {
    if (!child && !finished) { clearTimeout(timer); finish(REFUSED_EXIT) }
  })
  report({ phase: 'waiting', pid: process.pid })
}

module.exports = { argumentsFor, main, START_BYTE, FRAME_BYTES }
if (require.main === module) {
  try { main() }
  catch { process.exitCode = REFUSED_EXIT }
}
