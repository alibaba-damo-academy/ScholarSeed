const sourceDirectory = require('node:path').dirname(__dirname)
const { test } = require('node:test')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

test('component archive inventory checks actual ZIP bytes on the target Python', () => {
  const root = path.resolve(sourceDirectory, '../../../..')
  const python = process.platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python')
  execFileSync(python, ['-I', '-B', path.join(__dirname, 'archive_inventory_test.py')], {
    cwd: root, stdio: 'pipe', timeout: 30000
  })
})
