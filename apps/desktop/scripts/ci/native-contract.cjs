const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { compileNative } = require('../shared/native.cjs')
const { ensurePrivateDirectory } = require('../shared/build-state.cjs')

const root = path.join(fs.realpathSync.native(os.tmpdir()), 'scholarseed-native-contract')
const run = fs.mkdtempSync(path.join(ensurePrivateDirectory(root), 'run-'))
const output = path.join(run, 'native')

compileNative({ directory: output, runDirectoryContract: true })
  .then(() => console.log(`[native-contract] passed: ${output}`))
  .catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
  .finally(() => fs.rmSync(run, { recursive: true, force: true }))
