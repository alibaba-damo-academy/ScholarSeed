import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const apiSource = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
const dockSource = readFileSync(new URL('./Dock.tsx', import.meta.url), 'utf8')
const featureSource = readFileSync(new URL('./feature.tsx', import.meta.url), 'utf8')

test('unsupported project files do not fetch unavailable preview bytes', () => {
  assert.match(apiSource, /projection\.viewer !== 'unsupported'/)
  assert.match(apiSource, /contentKind: projection\.content_kind/)
})

test('unsupported viewer distinguishes binary and oversized files', () => {
  assert.match(dockSource, /contentKind: session\.contentKind/)
  assert.match(featureSource, /contentKind === 'oversized'/)
  assertLocalized(featureSource, "workbench", "viewer.oversized", ["{{path}} 文件过大，暂不支持内置预览。可用系统默认应用查看。", "{{path}} is too large for the built-in preview. Open it with the default system application."])
  assert.match(featureSource, /contentKind === 'binary'/)
  assertLocalized(featureSource, "workbench", "viewer.binary", ["{{path}} 是二进制文件，暂不支持内置预览。可用系统默认应用查看。", "{{path}} is a binary file and cannot be previewed here. Open it with the default system application."])
})


function assertLocalized(source: string, namespace: string, key: string, expected: string[]): void {
  assert.ok(source.includes(`'${key}'`), `source binds ${namespace}:${key}`)
  const labels = ['zh', 'en'].map(language => {
    const resource = JSON.parse(readFileSync(new URL(`../../../../localization/locales/${language}/${namespace}.json`, import.meta.url), 'utf8'))
    return key.split('.').reduce((value, part) => value[part], resource)
  })
  assert.deepEqual(labels, expected)
}
