const sourceDirectory = require('node:path').dirname(__dirname)
const { test } = require('node:test')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

test('component bytecode is frozen and consumed after relocation by real Python', () => {
  const root = path.resolve(sourceDirectory, '../../../..')
  const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  execFileSync(python, ['-I', '-B', path.join(__dirname, 'bytecode_test.py')], {
    cwd: root, stdio: 'pipe', timeout: 30000
  })
})
