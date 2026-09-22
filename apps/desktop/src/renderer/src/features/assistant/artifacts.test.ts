import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./Artifacts.tsx', import.meta.url), 'utf8')
const zh = JSON.parse(readFileSync(new URL('../../../../localization/locales/zh/assistant.json', import.meta.url), 'utf8'))
const en = JSON.parse(readFileSync(new URL('../../../../localization/locales/en/assistant.json', import.meta.url), 'utf8'))

test('agent artifact actions share one menu model across right-click and overflow entry points', () => {
  assert.match(source, /<ContextMenu[\s\S]*<ContextMenuTrigger asChild>/)
  assert.match(source, /<DropdownMenu[\s\S]*data-testid="artifact-more-actions"/)
  assert.match(source, /<ArtifactMenuItems \{\.\.\.menuProps\} kind="context" \/>/)
  assert.match(source, /<ArtifactMenuItems \{\.\.\.menuProps\} kind="dropdown" \/>/)
})

test('agent artifact menu exposes the requested actions and localized labels', () => {
  for (const id of ['import', 'openWith', 'saveAs', 'copyPath', 'reveal']) {
    assert.match(source, new RegExp(`artifact-\\$\\{kind\\}-${id === 'openWith' ? 'open-with' : id.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`))
  }
  for (const catalog of [zh, en]) {
    for (const key of ['import', 'openWith', 'saveAs', 'copyPath', 'revealInFinder', 'revealInFileManager']) {
      assert.equal(typeof catalog.artifactEntry[key], 'string')
      assert.ok(catalog.artifactEntry[key].length > 0)
    }
  }
})
