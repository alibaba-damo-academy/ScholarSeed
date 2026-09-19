import assert from 'node:assert/strict'
import test from 'node:test'
import { scenePatterns, changeScenes, matchingScenes } from './scenes.ts'

test('scene unions deduplicate shared formats', () => {
  const patterns = scenePatterns(['reading', 'office'])
  assert.equal(patterns.filter(value => value === '*.pdf').length, 1)
})
test('code scene covers common source and configuration files without admitting logs', () => {
  const patterns = scenePatterns(['code'])
  assert.deepEqual(
    ['*.py', '*.r', '*.java', '*.c', '*.cpp', '*.h', '*.sh', '*.js', '*.jsx', '*.ts', '*.tsx', '*.html', '*.css', '*.yaml', '*.yml', '*.toml', '*.xml'].filter(pattern => !patterns.includes(pattern)),
    []
  )
  assert.equal(patterns.includes('*.log'), false)
})
test('removing office retains reading PDF and custom rules', () => {
  const initial = [...scenePatterns(['reading', 'office']), 'notes/**', '*.custom']
  assert.deepEqual(changeScenes(initial, ['reading', 'office'], ['reading']), [...scenePatterns(['reading']), 'notes/**', '*.custom'])
})
test('existing custom configurations are never identified as presets', () => {
  assert.deepEqual(matchingScenes(['*.pdf']), [])
  assert.deepEqual(matchingScenes(scenePatterns(['reading', 'data'])), ['reading', 'data'])
})
