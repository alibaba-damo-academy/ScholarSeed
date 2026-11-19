import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { inventory } from './inventory.mjs'

const SCRIPT = fileURLToPath(new URL('./inventory.mjs', import.meta.url))
let root
before(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'reflect-inventory-'))
  await mkdir(join(root, 'work-records/task/nested'), { recursive: true })
  await mkdir(join(root, 'work-records/reflections'), { recursive: true })
  await mkdir(join(root, 'work-records/task/reflections'), { recursive: true })
  await writeFile(join(root, 'work-records/task/z.md'), 'secret body')
  await writeFile(join(root, 'work-records/task/nested/a.md'), 'abc')
  await writeFile(join(root, 'work-records/task/ignore.txt'), 'ignored')
  await writeFile(join(root, 'outside.md'), 'outside')
  await mkdir(join(root, '.ai/work-records/task'), { recursive: true })
  await writeFile(join(root, '.ai/work-records/task/result.md'), 'local')
  await symlink(join(root, 'work-records/task'), join(root, '.ai/work-records/alias'))
  await symlink(join(root, 'outside.md'), join(root, 'work-records/task/link.md'))
  await symlink(join(root, 'work-records/task/nested'), join(root, 'work-records/task/linkdir'))
  await symlink(join(root, 'work-records/task'), join(root, 'work-records/alias'))
  await symlink(root, join(root, 'root-alias'))
})
after(async () => { await rm(root, { recursive: true, force: true }) })

test('sorted metadata only, overlap deduplicated, symlinks excluded', async () => {
  const result = await inventory({ root, scopes: ['work-records/task', 'work-records/task/z.md'] })
  assert.deepEqual(result.files, [
    { path: 'work-records/task/nested/a.md', size: 3 },
    { path: 'work-records/task/z.md', size: 11 }
  ])
  assert.equal(result.truncated, false)
  assert.deepEqual(result.exclusions.map(entry => entry.reason), ['symlink', 'symlink', 'reflections'])
  assert.equal(JSON.stringify(result).includes('secret body'), false)
  assert.equal('total' in result, false)
})
test('explicit file and limit boundary', async () => {
  assert.equal((await inventory({ root, scopes: ['work-records/task/z.md'] })).files.length, 1)
  const result = await inventory({ root, scopes: ['work-records/task'], limit: 1 })
  assert.equal(result.files.length, 1)
  assert.equal(result.truncated, true)
  assert.equal((await inventory({ root, scopes: ['work-records/task'], limit: 2 })).truncated, false)
  assert.equal((await inventory({ root, scopes: ['work-records/task'], limit: 200 })).files.length, 2)
})

test('local records support explicit selection alongside historical records', async () => {
  const result = await inventory({ root, scopes: ['.ai/work-records/task', 'work-records/task/z.md'] })
  assert.deepEqual(result.files, [
    { path: '.ai/work-records/task/result.md', size: 5 },
    { path: 'work-records/task/z.md', size: 11 }
  ])
  for (const scope of ['.ai/work-records', '.ai/work-records/', '.ai/work-records/../outside.md', '.ai/work-records/reflections/report.md', '.ai/work-records/alias']) {
    await assert.rejects(inventory({ root, scopes: [scope] }), undefined, scope)
  }
})
test('invalid scopes fail closed', async () => {
  for (const scope of ['work-records', 'work-records/reflections', 'work-records/reflections/report.md', 'work-records/task/../outside.md', 'work-records//task', '/work-records/task', 'outside.md', 'work-records/task/missing.md', 'work-records/alias', 'work-records/alias/nested', 'work-records/task/link.md']) {
    await assert.rejects(inventory({ root, scopes: [scope] }), undefined, scope)
  }
  await assert.rejects(inventory({ root, scopes: [] }))
  for (const limit of [0, -1, 201, 1.5, '2', NaN]) {
    await assert.rejects(inventory({ root, scopes: ['work-records/task'], limit }))
  }
  await assert.rejects(inventory({ root: join(root, 'missing'), scopes: ['work-records/task'] }))
  await assert.rejects(inventory({ root: join(root, 'root-alias'), scopes: ['work-records/task'] }))
  await assert.rejects(inventory({ root, scopes: ['work-records/task/reflections'] }))
})
test('import has no CLI output or scope discovery side effects', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./inventory.mjs', import.meta.url).href)})`], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})
test('CLI preserves successful metadata and nonzero stderr errors', () => {
  const success = spawnSync(process.execPath, [SCRIPT, '--root', root, '--limit', '1', 'work-records/task'], { encoding: 'utf8' })
  assert.equal(success.status, 0)
  assert.equal(JSON.parse(success.stdout).truncated, true)
  assert.equal(success.stderr, '')
  for (const args of [[], ['--root', root], ['--root', root, '--limit', '201', 'work-records/task'], ['--root', root, '--limit', '1.5', 'work-records/task'], ['--root', root, '--unknown', 'work-records/task'], ['--root', root, 'work-records/missing']]) {
    const failure = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
    assert.notEqual(failure.status, 0)
    assert.notEqual(failure.stderr, '')
    assert.equal(failure.stdout, '')
  }
})
