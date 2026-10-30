const sourceDirectory = require('node:path').dirname(__dirname)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const test = require('node:test')

async function launch(t, args, { command = process.execPath, timeout = 5000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-progress-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const spec = { id: 'probe', command, args, cwd: root, shell: false, timeout,
    progress: path.join(root, 'progress'), stdout: path.join(root, 'stdout'),
    stderr: path.join(root, 'stderr'), result: path.join(root, 'result.json') }
  fs.mkdirSync(spec.progress)
  const request = path.join(root, 'request.json')
  fs.writeFileSync(request, JSON.stringify(spec))
  const child = spawn(process.execPath, [path.join(sourceDirectory, 'progress.cjs'), request], {
    env: { ...process.env, CI_PROGRESS_DIRECTORY: spec.progress }, stdio: ['ignore', 'pipe', 'pipe']
  })
  let live = false
  let log = ''
  child.stderr.on('data', bytes => { log += bytes; if (child.exitCode === null) live = true })
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  return { code, live, log, result: JSON.parse(fs.readFileSync(spec.result)),
    stdout: fs.readFileSync(spec.stdout, 'utf8'), stderr: fs.readFileSync(spec.stderr, 'utf8') }
}

test('progress is visible before exit and preserves raw output and nonzero status', async t => {
  const result = await launch(t, ['-e', `const fs=require('fs'),p=require('path');
    fs.writeFileSync(p.join(process.env.CI_PROGRESS_DIRECTORY,'child.jsonl'),JSON.stringify({kind:'case',id:'中文',status:'starting',pid:process.pid})+'\\n');
    process.stdout.write('raw report');process.stderr.write('raw diagnostic');setTimeout(()=>process.exit(37),700)`])
  assert.equal(result.code, 37)
  assert.equal(result.result.status, 37)
  assert.equal(result.live, true)
  assert.match(result.log, /case 中文 starting/)
  assert.equal(result.stdout, 'raw report')
  assert.equal(result.stderr, 'raw diagnostic')
})
test('spawn failure and timeout remain failures with explicit diagnostics', async t => {
  const missing = await launch(t, [], { command: path.join(os.tmpdir(), 'missing-ci-executable') })
  assert.equal(missing.code, 1)
  assert.equal(missing.result.error.code, 'ENOENT')
  const timeout = await launch(t, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 })
  assert.equal(timeout.code, 1)
  assert.equal(timeout.result.error.code, 'ETIMEDOUT')
})


test('malformed progress remains a failure with visible diagnostics', async t => {
  const result = await launch(t, ['-e', `const fs=require('fs'),p=require('path');
    fs.writeFileSync(p.join(process.env.CI_PROGRESS_DIRECTORY,'child.jsonl'),'invalid\\n');
    setInterval(()=>{},1000)`])
  assert.equal(result.code, 1)
  assert.equal(result.result.error.code, 'EPROGRESS')
  assert.match(result.log, /runner failed code=EPROGRESS/)
})

test('failure forwards complete stdout and stderr, success stays quiet', async t => {
  const text = '首个诊断\n' + 'x'.repeat(100000) + '\n末尾诊断';
  for (const exit of [0, 23]) {
    const result = await launch(t, ['-e', `process.stdout.write('首个诊断\\n'+'x'.repeat(100000)+'\\n末尾诊断');process.stderr.write('stderr detail');process.exitCode=${exit}`])
    assert.equal(result.code, exit)
    assert.equal(result.stdout, text)
    assert.equal(result.stderr, 'stderr detail')
    if (exit) {
      assert.ok(result.log.includes(text))
      assert.match(result.log, /stderr detail/)
    } else assert.equal(result.log, '')
  }
})

test('timeout forwards diagnostics emitted before termination', async t => {
  const result = await launch(t, ['-e', "process.stderr.write('before timeout\\n');setInterval(()=>{},1000)"], { timeout: 1000 })
  assert.equal(result.code, 1)
  assert.match(result.log, /before timeout/)
})
