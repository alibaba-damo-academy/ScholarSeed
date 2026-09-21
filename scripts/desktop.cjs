#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repo = path.resolve(__dirname, '..')
const desktop = path.join(repo, 'apps', 'desktop')
const electronPackage = path.join(desktop, 'node_modules', 'electron', 'package.json')

function run(args) {
  const result = spawnSync('npm', args, {
    cwd: repo,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status)
}

function ensureDependencies() {
  if (fs.existsSync(electronPackage)) return
  console.log('[desktop] apps/desktop/node_modules is missing; running npm ci...')
  run(['--prefix', 'apps/desktop', 'ci', '--no-audit', '--no-fund'])
}

const [command, ...forwarded] = process.argv.slice(2)
if (!command) {
  console.error('usage: node scripts/desktop.cjs <npm-script> [-- ...args]')
  process.exit(2)
}

ensureDependencies()
run(['--prefix', 'apps/desktop', 'run', command, '--', ...forwarded])
