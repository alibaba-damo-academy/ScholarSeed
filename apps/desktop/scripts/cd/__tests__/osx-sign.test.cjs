const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { test } = require('node:test')

test('osx-sign scans large resource trees under a low descriptor limit', { skip: process.platform === 'win32' }, context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'osx-sign-scan-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const framework = path.join(directory, 'Nested.framework')
  fs.mkdirSync(framework)
  for (let index = 0; index < 1024; index++) {
    fs.writeFileSync(path.join(framework, `${index}.bin`), Buffer.from([0, 1, 2, 3]))
  }
  fs.writeFileSync(path.join(framework, 'README.txt'), 'ordinary text')
  fs.writeFileSync(path.join(framework, 'old.cstemp'), 'temporary signature')
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const { walkAsync } = require(process.argv[1]);
    walkAsync(process.argv[2]).then(files => {
      assert.equal(files.length, 1025);
      assert.equal(new Set(files).size, 1025);
      assert.ok(files.includes(path.join(process.argv[2], 'Nested.framework')));
      assert.ok(!files.some(file => file.endsWith('.txt')));
      assert.ok(!fs.existsSync(path.join(process.argv[2], 'Nested.framework/old.cstemp')));
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `
  const result = spawnSync('/bin/bash', ['-c', 'ulimit -n 64; exec "$@"', 'scan-test',
    process.execPath, '-e', script, path.resolve(__dirname, '../osx-sign.cjs'), directory], {
    encoding: 'utf8', timeout: 30_000,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
})
