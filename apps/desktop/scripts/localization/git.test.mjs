import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSources, generateDebt } from './git.mjs'

test('real Git fixture covers staged, unstaged, untracked, missing refs and debt tightening', () => {
  const root = mkdtempSync(join(tmpdir(), 'scholarseed-i18n-git-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const dir = join(root, 'apps/desktop/src/renderer/src')
  const file = join(dir, 'Page.tsx')
  const options = { root, debtPath: join(root, 'debt.json') }
  try {
    mkdirSync(dir, { recursive: true })
    git('init', '-q'); git('config', 'user.name', 'Contract Fixture'); git('config', 'user.email', 'fixture@example.invalid')
    writeFileSync(file, 'export const Page=()=> <div>Old</div>')
    git('add', '.'); git('commit', '-qm', 'fixture baseline')
    generateDebt(git('rev-parse', 'HEAD'), options)
    git('add', 'debt.json'); git('commit', '-qm', 'fixture reviewed debt')
    const base = git('rev-parse', 'HEAD')
    assert.deepEqual(checkSources(base, options).errors, [])
    const reviewedDebt = readFileSync(options.debtPath, 'utf8')
    const widened = JSON.parse(reviewedDebt)
    const path = Object.keys(widened.files)[0]
    widened.files[path].push(widened.files[path][0])
    widened.baseCommit = base
    writeFileSync(options.debtPath, JSON.stringify(widened))
    assert.match(checkSources(base, options).errors.join(), /debt must not expand/)
    git('add', 'debt.json')
    writeFileSync(options.debtPath, reviewedDebt)
    assert.match(checkSources(base, options).errors.join(), /debt must not expand.*\[index\]/)
    git('add', 'debt.json')
    writeFileSync(file, '\n\nexport const Page=()=> <div>Old</div>')
    assert.deepEqual(checkSources(base, options).errors, [])
    writeFileSync(file, 'export const Page=()=> <div>New</div>')
    assert.equal(checkSources(base, options).errors.length, 1)
    git('add', file)
    assert.equal(checkSources(base, options).errors.length, 1)
    writeFileSync(file, 'export const Page=()=> <div>Old</div>')
    assert.match(checkSources(base, options).errors.join(), /New \[index\]/)
    rmSync(file)
    assert.match(checkSources(base, options).errors.join(), /New \[index\]/)
    writeFileSync(file, 'export const Page=()=> <div>New</div>')
    writeFileSync(join(dir, 'New.tsx'), 'export const Added=()=> <div>中文</div>')
    assert.equal(checkSources(base, options).errors.length, 2)
    assert.throws(() => checkSources('missing-base', options))
    assert.throws(() => generateDebt(base, options), /already exists/)
    // Tightening cannot bless a replacement hardcoded message or duplicate occurrences.
    git('add', 'apps'); git('commit', '-qm', 'fixture changed')
    const tightened = generateDebt('HEAD', { ...options, tighten: true })
    assert.equal(Object.keys(tightened.files).length, 0)
    assert.equal(checkSources('HEAD', options).errors.length, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
