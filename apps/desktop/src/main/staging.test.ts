import assert from 'node:assert/strict'
import test from 'node:test'

import {
  installerExtension,
  planUpdatePrune,
  stagedInstallerName,
  updateArtifactKind,
} from './staging.ts'
import type { UpdateArtifactEntry } from './staging.ts'

const KEEP = 'scholarseed-0.3.0-202609200900.dmg'
const OLD = 'scholarseed-0.2.0-202609162329.dmg'

function file(name: string): UpdateArtifactEntry {
  return { name, directory: false, empty: false }
}

function directory(name: string, empty: boolean): UpdateArtifactEntry {
  return { name, directory: true, empty }
}

test('replacement pruning keeps both the usable ready payload and current attempt', () => {
  const obsolete = 'scholarseed-0.1.0-202609150900.dmg'
  const entries = [file(KEEP), file(OLD), file(obsolete), file('user.pdf')]
  assert.deepEqual(planUpdatePrune(entries, KEEP, [OLD]).files, [obsolete])
  assert.deepEqual(planUpdatePrune(entries, KEEP).files, [OLD, obsolete])
})

test('安装包扩展名按平台分派', () => {
  assert.equal(installerExtension('win32'), '.exe')
  assert.equal(installerExtension('darwin'), '.dmg')
  assert.equal(installerExtension('linux'), '.dmg')
})

test('暂存包名由发布身份确定性生成，不带随机后缀', () => {
  assert.equal(stagedInstallerName('0.2.0', '202609162329', 'darwin'), OLD)
  assert.equal(
    stagedInstallerName('0.2.0', '202609162329', 'win32'),
    'scholarseed-0.2.0-202609162329.exe'
  )
  assert.equal(
    stagedInstallerName('0.2.0', '202609162329', 'darwin'),
    stagedInstallerName('0.2.0', '202609162329', 'darwin')
  )
})

test('只认领本模块命名的条目，其余归 other', () => {
  assert.equal(updateArtifactKind(OLD), 'payload')
  assert.equal(updateArtifactKind('scholarseed-0.2.0-202609162329.exe'), 'payload')
  assert.equal(updateArtifactKind('scholarseed-0.2.0-202609162329.zip'), 'other')
  assert.equal(updateArtifactKind('mount-1f0c2a4e'), 'mount')
  assert.equal(updateArtifactKind('install-1f0c2a4e.sh'), 'script')
  assert.equal(updateArtifactKind('install-1f0c2a4e.dmg'), 'other')
  assert.equal(updateArtifactKind('notes.txt'), 'other')
})

test('清场保留目标包，回收其它身份的包与空挂载点', () => {
  const plan = planUpdatePrune(
    [file(KEEP), file(OLD), directory('mount-1f0c2a4e', true), file('install-1f0c2a4e.sh')],
    KEEP
  )
  assert.deepEqual(plan.files, [OLD])
  assert.deepEqual(plan.directories, ['mount-1f0c2a4e'])
})

test('有非空挂载点时整轮不动：安装还在跑，脚本随时要用它带来的包', () => {
  const plan = planUpdatePrune(
    [file(KEEP), file(OLD), directory('mount-1f0c2a4e', false), directory('mount-empty', true)],
    KEEP
  )
  assert.deepEqual(plan, { files: [], directories: [] })
})

test('安装脚本、用户文件与同名目录都不被当暂存包删', () => {
  const plan = planUpdatePrune(
    [file('install-1f0c2a4e.sh'), file('notes.txt'), directory(OLD, true), file(KEEP)],
    KEEP
  )
  assert.deepEqual(plan, { files: [], directories: [] })
})

test('目录里只有目标包时不产生任何动作', () => {
  assert.deepEqual(planUpdatePrune([file(KEEP)], KEEP), { files: [], directories: [] })
  assert.deepEqual(planUpdatePrune([], KEEP), { files: [], directories: [] })
})

test('mutable staged metadata cannot address paths outside the update cache', () => {
  for (const invalid of ['../old', 'x/../../other', 'x\\..\\other', '', 'x'.repeat(129)]) {
    assert.throws(() => stagedInstallerName(invalid, '2026100901'), /Invalid staged release/)
    assert.throws(() => stagedInstallerName('0.2.0', invalid), /Invalid staged release/)
  }
})
