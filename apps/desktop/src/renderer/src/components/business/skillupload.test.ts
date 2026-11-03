import assert from 'node:assert/strict'
import test from 'node:test'
import { strFromU8, unzipSync } from 'fflate'
import { droppedSkillFiles, packageSkillDirectory } from './skillupload.ts'

function entry(relativePath: string, content: string): File {
  return Object.assign(new File([content], relativePath.split('/').at(-1)!), {
    webkitRelativePath: relativePath,
  })
}

test('directory upload preserves nested resources and binary bytes in the existing ZIP flow', async () => {
  const archive = await packageSkillDirectory([
    entry('my-skill/SKILL.md', '# Instructions'),
    entry('my-skill/references/中文.md', 'Evidence'),
    entry('my-skill/scripts/run.py', 'print(1)'),
  ])
  assert.equal(archive.name, 'my-skill.zip')
  const files = unzipSync(new Uint8Array(await archive.arrayBuffer()))
  assert.deepEqual(Object.keys(files), ['SKILL.md', 'references/中文.md', 'scripts/run.py'])
  assert.equal(strFromU8(files['references/中文.md']), 'Evidence')
  assert.equal(strFromU8(files['scripts/run.py']), 'print(1)')
})

test('directory upload rejects empty, mixed-root, traversal and duplicate selections', async () => {
  for (const files of [
    [],
    [entry('one/SKILL.md', ''), entry('two/file.txt', '')],
    [entry('one/../file.txt', '')],
    [entry('one/SKILL.md', ''), entry('one/SKILL.md', '')],
    [entry('one/file\\name', '')],
  ]) {
    await assert.rejects(packageSkillDirectory(files))
  }
})

test('folder drops drain every directory-reader batch and preserve nested paths', async () => {
  function leaf(name: string): FileSystemEntry {
    return {
      isFile: true,
      isDirectory: false,
      name,
      file: (resolve: (file: File) => void) => resolve(new File([name], name)),
    } as unknown as FileSystemEntry
  }
  function directory(name: string, batches: FileSystemEntry[][]): FileSystemEntry {
    return {
      isFile: false,
      isDirectory: true,
      name,
      createReader: () => {
        const remaining = [...batches, []]
        return {
          readEntries: (resolve: (entries: FileSystemEntry[]) => void) =>
            resolve(remaining.shift()!),
        }
      },
    } as unknown as FileSystemEntry
  }
  const root = directory('folder', [
    [leaf('SKILL.md')],
    [directory('references', [[leaf('guide.md')]])],
  ])
  const transfer = { items: [{ webkitGetAsEntry: () => root }] } as unknown as DataTransfer
  const files = await droppedSkillFiles(transfer)
  assert.deepEqual(
    files.map((file) => file.webkitRelativePath),
    ['folder/SKILL.md', 'folder/references/guide.md']
  )
  assert.equal(await files[1].text(), 'guide.md')
  await assert.rejects(
    droppedSkillFiles({
      items: [{ webkitGetAsEntry: () => root }, { webkitGetAsEntry: () => leaf('extra.md') }],
    } as unknown as DataTransfer)
  )
})
