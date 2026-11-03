const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { childExitCode } = require('../../../../scripts/shared/execution.cjs')

const DESKTOP = path.resolve(__dirname, '../..')
const TEST_GLOBS = Object.freeze({
  '*.test.ts': { directory: '', recursive: false },
  'src/**/*.test.ts': { directory: 'src', recursive: true },
  'preview/*.test.ts': { directory: 'preview', recursive: false },
  'e2e/fixtures/*.test.ts': { directory: 'e2e/fixtures', recursive: false },
})
const TEST_FILES = Object.freeze([
  '../../scripts/shared/__tests__/lease.test.cjs',
  '../../scripts/dev/__tests__/desktop.test.cjs',
  '../../scripts/shared/__tests__/timing.test.cjs',
  '../../scripts/pre/__tests__/toolchain-install.test.cjs',
  '../../scripts/cd/__tests__/updater-session.test.cjs',
  '../../scripts/shared/__tests__/dependencies.test.cjs',
  'scripts/pre/__tests__/electron.test.cjs',
  'scripts/dev/__tests__/lease.test.cjs',
  'scripts/shared/__tests__/temporary-cleanup.test.cjs',
  'scripts/cd/__tests__/build.test.cjs',
  'scripts/cd/__tests__/signer.test.cjs',
  'scripts/cd/__tests__/wheels.test.cjs',
  'scripts/cd/__tests__/velobundle.test.mjs',
  'scripts/cd/__tests__/fonts.test.cjs',
  'scripts/dev/__tests__/development.test.mjs',
  'scripts/dev/__tests__/supervision.test.mjs',
  'scripts/dev/__tests__/worker.test.cjs',
  'scripts/shared/__tests__/native.test.cjs',
  'scripts/shared/__tests__/styles.test.cjs',
  'scripts/pre/__tests__/office.test.cjs',
  'scripts/ci/__tests__/reuse.test.mjs',
  'scripts/ci/__tests__/commands.test.cjs',
  'scripts/ci/__tests__/lifecycle.test.cjs',
  'scripts/ci/__tests__/types.test.cjs',
  ...Object.keys(TEST_GLOBS),
])
const NODE_ARGS = Object.freeze(['--experimental-transform-types', '--test'])

function walkTestFiles(directory, relative, recursive) {
  return fs
    .readdirSync(path.join(directory, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const child = relative ? path.join(relative, entry.name) : entry.name
      if (entry.isDirectory())
        return recursive && entry.name !== 'node_modules'
          ? walkTestFiles(directory, child, recursive)
          : []
      return entry.isFile() && entry.name.endsWith('.test.ts')
        ? [child.split(path.sep).join('/')]
        : []
    })
}

function expandTestGlob(pattern, directory = DESKTOP) {
  if (!Object.hasOwn(TEST_GLOBS, pattern)) throw new Error(`unsupported test glob: ${pattern}`)
  const scope = TEST_GLOBS[pattern]
  return walkTestFiles(directory, scope.directory, scope.recursive).sort()
}

function testFiles(directory = DESKTOP) {
  return [
    ...new Set(
      TEST_FILES.flatMap((filename) => {
        if (!filename.includes('*')) return [filename]
        const matches = expandTestGlob(filename, directory)
        if (!matches.length) throw new Error(`no test files match glob: ${filename}`)
        return matches
      })
    ),
  ]
}

function invocation(coverage = false, forwarded = []) {
  const args = [...NODE_ARGS, '--test-concurrency=1', ...TEST_FILES, ...forwarded]
  return {
    executable: process.execPath,
    args: coverage
      ? [path.join(DESKTOP, 'node_modules/c8/bin/c8.js'), process.execPath, ...args]
      : args,
  }
}

function main(argv = process.argv.slice(2), { launch = spawnSync } = {}) {
  const coverage = argv[0] === '--coverage'
  const command = invocation(coverage, coverage ? argv.slice(1) : argv)
  const result = launch(command.executable, command.args, {
    cwd: DESKTOP,
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  })
  if (result.error) throw result.error
  return childExitCode(result)
}

module.exports = {
  DESKTOP,
  TEST_FILES,
  TEST_GLOBS,
  NODE_ARGS,
  expandTestGlob,
  testFiles,
  invocation,
  main,
}
if (require.main === module) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(`[desktop:test] ${error.message}`)
    process.exitCode = 1
  }
}
