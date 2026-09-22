#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const repo = path.resolve(__dirname, '..')
const links = [
  ['.codex/skills', '../.agents/skills'],
  ['.claude/skills', '../.agents/skills'],
  ['CLAUDE.md', 'AGENTS.md']
]
let fixed = 0
for (const [link, target] of links) {
  const filename = path.join(repo, link)
  try {
    const stat = fs.lstatSync(filename)
    if (stat.isSymbolicLink() && fs.readlinkSync(filename) === target) continue
    fs.rmSync(filename, { recursive: true, force: true })
  } catch { /* missing link will be recreated */ }
  fs.symlinkSync(target, filename, link.endsWith('/skills') && process.platform === 'win32' ? 'junction' : undefined)
  fixed += 1
}
console.log(fixed ? `fixed ${fixed} symlink(s)` : 'symlinks OK')
if (process.platform !== 'win32') {
  const { spawnSync } = require('node:child_process')
  spawnSync('bash', ['scripts/install-git-hooks.sh'], { cwd: repo, stdio: 'inherit' })
}
