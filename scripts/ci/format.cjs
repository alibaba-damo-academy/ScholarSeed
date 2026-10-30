const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const child = require('node:child_process')
const { developmentPython } = require('../shared/python.cjs')
const leases = require('../shared/lease.cjs')

const DEFAULT_PATHS = [
  'apps/serve/service', 'apps/serve/tests', 'packages/runtime/scholarseed_runtime',
  'packages/damoatrace/damoatrace', 'packages/adapters/codex/scholarseed_codex',
  'tests', 'scripts'
]
const DEFAULT_VENV = '.venv'
const MODULES = ['isort', 'black']
const CHECK_OPTIONS = new Set(['--check', '-c'])
const HELP_OPTIONS = new Set(['--help', '-h'])
const CACHE_PREFIX = 'scholarseed-format-check-'

function format(repo, args, environment = process.env, options = {}) {
  const paths = []
  let check = false
  for (const argument of args) {
    if (CHECK_OPTIONS.has(argument)) check = true
    else if (HELP_OPTIONS.has(argument)) { console.log('format.cjs [--check] [PATH ...]'); return 0 }
    else if (argument.startsWith('-')) {
      const error = new Error(`unknown option: ${argument}`)
      error.exitCode = 2
      throw error
    }
    else paths.push(argument)
  }
  if (!paths.length) paths.push(...DEFAULT_PATHS.filter(filename => fs.existsSync(path.join(repo, filename))))
  if (!paths.length) throw new Error('no formatter paths')
  const interpreter = developmentPython(repo, environment.VENV || DEFAULT_VENV, { ...options, environment })
  const cache = check ? fs.mkdtempSync(path.join(os.tmpdir(), CACHE_PREFIX)) : null
  const env = { ...environment, PYTHONDONTWRITEBYTECODE: '1', ...(cache ? { BLACK_CACHE_DIR: cache } : {}) }
  const resource = path.resolve(repo, environment.VENV || DEFAULT_VENV)
  let lease = null
  try {
    const run = (command, argv, stdio = 'inherit') => {
      const result = child.spawnSync(command, argv, { cwd: repo, env, stdio, windowsHide: true })
      if (result.error) return { ...result, status: 1 }
      return result
    }
    const ready = () => MODULES.every(module => run(interpreter, ['-m', module, '--version'], 'pipe').status === 0)
    lease = leases.acquire({ mode: 'read', resources: [resource] })
    if (!ready()) {
      lease.release()
      lease = null
      if (check) throw new Error('formatter unavailable; run pnpm ops pre install python explicitly')
      const prepared = run(process.execPath, [path.join(repo, 'scripts/shared/python.cjs'), 'prepare-dev'])
      if (prepared.status !== 0) return prepared.status ?? 1
      lease = leases.acquire({ mode: 'read', resources: [resource] })
      if (!ready()) throw new Error('formatter still unavailable after preparation')
    }
    const commands = [
      ['-m', 'isort', ...(check ? ['--check-only', '--diff'] : []), ...paths],
      ['-m', 'black', ...(check ? ['--check', '--diff'] : []), ...paths],
      [path.join(repo, 'scripts/ci/imports.py'), ...paths]
    ]
    for (const argv of commands) {
      const result = run(interpreter, argv)
      if (result.status !== 0) return result.status ?? 1
    }
    return 0
  } finally {
    lease?.release()
    if (cache) fs.rmSync(cache, { recursive: true })
  }
}
module.exports = { format }
if (require.main === module) {
  try { process.exitCode = format(path.resolve(__dirname, '../..'), process.argv.slice(2)) }
  catch (error) { console.error(`[formatter] ${error.message}`); process.exitCode = error.exitCode ?? 1 }
}
