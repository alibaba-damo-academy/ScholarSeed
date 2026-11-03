#!/usr/bin/env node
// L1 affected 路由: git diff -> 定向测试命令（proposal 139）。规则在 affected.policy.json，本文件只做解析与执行。
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '../..')
const POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, 'affected.policy.json'), 'utf8'))
const TEST_SUFFIXES = ['.test.ts', '.test.tsx', '.test.mjs', '.test.cjs']
const MAX_GREP_FILES = 40

function changedFiles(argv) {
  const baseIndex = argv.indexOf('--base')
  if (baseIndex >= 0 && (!argv[baseIndex + 1] || argv[baseIndex + 1].startsWith('--'))) {
    throw new Error('--base requires a ref')
  }
  const base = baseIndex >= 0 ? argv[baseIndex + 1] : 'HEAD'
  const range = base === 'HEAD' ? ['diff', '--name-only', '--diff-filter=ACMR'] :
    ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`]
  const tracked = spawnSync('git', range, { cwd: ROOT, encoding: 'utf8' })
  if (tracked.status !== 0) throw new Error(`git diff failed: ${tracked.stderr}`)
  const files = new Set(tracked.stdout.split('\n').filter(Boolean))
  if (base === 'HEAD') {
    const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'],
      { cwd: ROOT, encoding: 'utf8' })
    for (const file of untracked.stdout.split('\n').filter(Boolean)) files.add(file)
  }
  return [...files]
}

function adjacentTest(file) {
  const absolute = path.join(ROOT, file)
  for (const suffix of TEST_SUFFIXES) {
    const candidate = absolute.replace(/\.(tsx?|jsx?|mjs|cjs)$/, suffix)
    if (candidate !== absolute && fs.existsSync(candidate)) return path.relative(ROOT, candidate)
    const owned = path.join(path.dirname(absolute), '__tests__', path.basename(candidate))
    if (candidate !== absolute && fs.existsSync(owned)) return path.relative(ROOT, owned)
  }
  return null
}

function consumerTests(files) {
  const found = new Set()
  const candidates = files.filter(file => file.startsWith('apps/desktop/')).slice(0, MAX_GREP_FILES)
  for (const file of candidates) {
    const stem = path.basename(file).replace(/\.(tsx?|jsx?|mjs|cjs)$/, '')
    const grep = spawnSync('grep', ['-rl', `/${stem}'`, `--include=*.test.ts*`, '--include=*.test.mjs',
      '--include=*.test.cjs', 'apps/desktop'], { cwd: ROOT, encoding: 'utf8' })
    for (const hit of (grep.stdout || '').split('\n').filter(Boolean)) found.add(hit)
    const quoted = spawnSync('grep', ['-rl', `'${stem}`, `--include=*.test.ts*`, 'apps/desktop/src'],
      { cwd: ROOT, encoding: 'utf8' })
    for (const hit of (quoted.stdout || '').split('\n').filter(Boolean)) found.add(hit)
  }
  return [...found]
}

function ipcChannelsFor(file) {
  const absolute = path.join(ROOT, file)
  if (!fs.existsSync(absolute)) return []
  const source = fs.readFileSync(absolute, 'utf8')
  const pattern = new RegExp(POLICY.ipc.channelPattern, 'g')
  return [...source.matchAll(pattern)].map(match => match[1])
}

function ipcConsumers(channels) {
  const hits = new Set()
  for (const channel of channels) {
    for (const template of POLICY.ipc.consumerPatterns) {
      const needle = template.replaceAll('{channel}', channel)
      for (const root of POLICY.ipc.scanRoots) {
        const grep = spawnSync('grep', ['-rl', needle, root], { cwd: ROOT, encoding: 'utf8' })
        for (const hit of (grep.stdout || '').split('\n').filter(Boolean)) hits.add(hit)
      }
    }
  }
  return [...hits]
}

function pythonSuites() {
  // tests.run_all 只能以 apps/serve 为 cwd 解析（apps/serve/tests 是 regular package，
  // 会遮蔽根 namespace tests；与 CI stage cwd 一致）。SUITES + SLOW 都是可路由套件。
  const probe = spawnSync(path.join(ROOT, '.venv', 'bin', 'python'), ['-c',
    `import importlib; m = importlib.import_module('${POLICY.pythonSuites.discoverModule}');` +
    `print('\\n'.join(getattr(m, '${POLICY.pythonSuites.discoverAttr}') + getattr(m, 'SLOW', [])))`],
    { cwd: path.join(ROOT, 'apps/serve'), encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: [path.join(ROOT, 'apps/serve'), ROOT].join(path.delimiter) } })
  if (probe.status !== 0) throw new Error(`suite discovery failed: ${(probe.stderr || probe.stdout || '').slice(0, 200)}`)
  return probe.stdout.split('\n').filter(Boolean)
}

function suiteForSource(file, suites) {
  const stem = path.basename(file).replace(/\.py$/, '')
  return suites.find(suite => suite === stem || suite.endsWith(`.${stem}`)) || null
}

// source->suite: 同名套件优先，否则在套件源文件里按模块 import 反查（一次 grep -rl）。
// serve 内套件注册为裸名（tests. 前缀被遮蔽），根 tests/ 下是点分全名。
function suiteNameForPath(hit) {
  const normalized = hit.replace(/^apps\/serve\//, '').replace(/\.py$/, '').replaceAll('/', '.')
  return normalized.startsWith('tests.') ? normalized : `tests.${normalized}`
}

function suiteCandidatesForPath(hit) {
  const stem = path.basename(hit).replace(/\.py$/, '')
  return [stem, suiteNameForPath(hit)]
}

function pythonSuiteByImport(files, suites) {
  const selected = new Set()
  for (const file of files) {
    const exact = suiteForSource(file, suites)
    if (exact) { selected.add(exact); continue }
    const module = file.replace(/^apps\/serve\//, '').replace(/^packages\//, '')
      .replace(/\.py$/, '').replaceAll('/', '.')
    const roots = ['apps/serve/tests', 'tests']
    for (const root of roots) {
      // -- 终止选项解析：module 点分名可能以 -m/-t 开头，避免被 grep 当选项吞掉
      const grep = spawnSync('grep', ['-rl', '--include=contract_*.py', '--include=e2e_*.py',
        '--include=test_*.py', '--', module, root], { cwd: ROOT, encoding: 'utf8' })
      for (const hit of (grep.stdout || '').split('\n').filter(Boolean)) {
        const match = suiteCandidatesForPath(hit).find(name => suites.includes(name))
        if (match) selected.add(match)
      }
    }
  }
  return [...selected]
}

function plan(files) {
  const commands = []
  const desktopTests = new Set()
  const pythonFiles = []
  const unmatched = []
  const ipcFiles = files.filter(file => file.startsWith('apps/desktop/') &&
    /\b(ipc|preload|handoff|bridge)/i.test(path.basename(file)))
  for (const file of files) {
    const rule = POLICY.rules.find(item => new RegExp(item.match).test(file))
    if (!rule) { unmatched.push(file); continue }
    if (rule.resolve === 'adjacentTest') {
      const test = adjacentTest(file)
      const matches = test ? [test] : consumerTests([file])
      for (const match of matches) desktopTests.add(match)
      if (!matches.length) unmatched.push(file)
    } else if (rule.resolve === 'pythonSuiteBySourceStem') {
      pythonFiles.push(file)
    } else {
      unmatched.push(file)
    }
  }
  for (const file of ipcFiles) {
    for (const consumer of ipcConsumers(ipcChannelsFor(file))) {
      const test = adjacentTest(consumer)
      if (test) desktopTests.add(test)
    }
  }
  if (desktopTests.size) {
    commands.push({ cwd: 'apps/desktop',
      command: `node --experimental-transform-types --test ${[...desktopTests].map(t => t.replace(/^apps\/desktop\//, '')).join(' ')}` })
  }
  if (pythonFiles.length) {
    const suites = pythonSuites()
    const selected = pythonSuiteByImport(pythonFiles, suites)
    if (selected.length) {
      commands.push({ cwd: 'apps/serve', env: { PYTHONPATH: ROOT },
        command: `../../.venv/bin/python -m tests.run_all ${selected.map(s => `--only-suite ${s}`).join(' ')}` })
    } else for (const file of pythonFiles) unmatched.push(file)
  }
  return { commands, unmatched, fallback: unmatched.length ? POLICY.fallbackCommand : null }
}

function main(argv) {
  const json = argv.includes('--json')
  const files = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') continue
    if (argument === '--base') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) {
        throw new Error('--base requires a ref')
      }
      index += 1
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown option: ${argument}`)
    } else {
      files.push(argument)
    }
  }
  const targets = files.length ? files : changedFiles(argv)
  const result = plan(targets)
  if (json) process.stdout.write(`${JSON.stringify({ targets, ...result }, null, 2)}\n`)
  else {
    for (const item of result.commands) process.stdout.write(`# ${item.cwd}\n${item.command}\n`)
    if (result.fallback) process.stdout.write(`# unmatched(${result.unmatched.length}) -> ${result.fallback}\n`)
  }
  return result.commands.length || !result.fallback ? 0 : 3
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`[affected] ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = { changedFiles, adjacentTest, consumerTests, ipcChannelsFor, ipcConsumers, suiteForSource, plan }
