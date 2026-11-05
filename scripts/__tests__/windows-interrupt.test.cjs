const assert = require('node:assert/strict')
const { ChildProcess } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { launchLong } = require('../shared/execution.cjs')

test('Windows console interrupt allows child cleanup before returning', { skip: process.platform !== 'win32' }, async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-interrupt-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ready = path.join(directory, 'ready')
  const stopping = path.join(directory, 'stopping')
  const cleaned = path.join(directory, 'cleaned')
  const kill = context.mock.method(ChildProcess.prototype, 'kill')
  const program = `
    const fs = require('node:fs');
    fs.writeFileSync(process.argv[1], 'ready');
    const timer = setInterval(() => {
      if (!fs.existsSync(process.argv[2])) return;
      clearInterval(timer);
      setTimeout(() => fs.writeFileSync(process.argv[3], 'cleaned'), 100);
    }, 10);
  `
  const result = launchLong(process.execPath, ['-e', program, ready, stopping, cleaned], { stdio: 'ignore' })
  const rejection = assert.rejects(result, error => error.exitCode === 130)
  const deadline = Date.now() + 5000
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(fs.existsSync(ready))
  // 模拟同控制台子进程已开始处理 Ctrl+C。
  fs.writeFileSync(stopping, 'stopping')
  process.emit('SIGINT')
  await rejection
  assert.equal(kill.mock.callCount(), 0)
  assert.equal(fs.readFileSync(cleaned, 'utf8'), 'cleaned')
})
