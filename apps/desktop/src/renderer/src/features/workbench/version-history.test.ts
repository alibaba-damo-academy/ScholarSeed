import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const history = readFileSync(new URL('./VersionHistory.tsx', import.meta.url), 'utf8')
const comparison = readFileSync(new URL('./VersionDiff.tsx', import.meta.url), 'utf8')
const resourceApi = readFileSync(new URL('../resources/api.ts', import.meta.url), 'utf8')
const messages = ['zh', 'en'].map(language => JSON.parse(readFileSync(
  new URL(`../../../../localization/locales/${language}/workbench.json`, import.meta.url),
  'utf8'
)).history)

test('version history uses the compact management interaction hierarchy', () => {
  assert.match(history, /SearchBox/)
  assert.match(history, /DropdownMenu/)
  assert.match(history, /data-testid="version-history-row-action"/)
  assert.match(history, /data-testid="version-history-restore"/)
  assert.match(history, /previewResourceVersionDelete/)
  assert.match(history, /updateResourceVersionAlias/)
  assert.doesNotMatch(history, /fetchResourceDeliveries/)
  assert.doesNotMatch(history, /saveResourceVersionAs/)
  assert.doesNotMatch(history, /history\.download/)
  assert.doesNotMatch(history, /<Tabs/)
})

test('version history keeps every hook before its unavailable return', () => {
  const unavailableReturn = history.indexOf('if (!available) return null')
  const lastHook = history.lastIndexOf('React.useEffect(')

  assert.ok(unavailableReturn > lastHook, 'an unavailable version projection must not change the hook count')
  assert.match(history, /if \(!available \|\| !open\) return undefined/)
})

test('successful version mutations use the transient top-right toast', () => {
  assert.match(history, /useToast\(\)/)
  assert.match(history, /toast\(\{ title: <HistoryNoticeText notice=\{success\} \/>, tone: 'success' \}\)/)
  assert.doesNotMatch(history, /setNotice\(\{ key: 'history\.(?:restored|aliasSaved|deleted)'/)
})

test('resource client exposes alias, filtering, and preflighted deletion contracts', () => {
  assert.match(resourceApi, /metadata_revision/)
  assert.match(resourceApi, /total: number/)
  assert.match(resourceApi, /q\?: string/)
  assert.match(resourceApi, /updateResourceVersionAlias/)
  assert.match(resourceApi, /previewResourceVersionDelete/)
  assert.match(resourceApi, /deleteResourceVersion/)
  assert.match(resourceApi, /Idempotency-Key/)
})

test('version management copy is complete in both locales', () => {
  for (const historyMessages of messages) {
    assert.equal(typeof historyMessages.search, 'string')
    assert.equal(typeof historyMessages.alias, 'string')
    assert.equal(typeof historyMessages.deleteVersion, 'string')
    assert.equal(typeof historyMessages.deleteDeliveryImpact_other, 'string')
    assert.equal(typeof historyMessages.current, 'string')
    assert.equal(typeof historyMessages.today, 'string')
    assert.equal(typeof historyMessages.yesterday, 'string')
  }
})

test('text and Office history open one special comparison tab against the frozen current version', () => {
  assert.match(history, /currentVersionId/)
  assert.match(history, /act\.openVersionDiff\(\{/)
  assert.match(history, /setOpen\(false\)/)
  assert.doesNotMatch(history, /buildHistoryDiff/)
  assert.doesNotMatch(history, /session\.viewer === 'office'/)
})

test('text comparison headers constrain long paths without shrinking version labels', () => {
  const textHeader = comparison.slice(comparison.indexOf('{!office && <header'), comparison.indexOf('{failed &&'))
  assert.equal((textHeader.match(/className="flex min-w-0 items-center/g) ?? []).length, 2)
  assert.equal((textHeader.match(/<strong className="shrink-0">/g) ?? []).length, 2)
  assert.equal((textHeader.match(/<EllipsisText wrapperClassName="ml-\[var\(--vds-space-2\)\] flex-1"/g) ?? []).length, 2)
  assert.equal((textHeader.match(/tooltipPortalled/g) ?? []).length, 2)
  assert.doesNotMatch(textHeader, /<span/)
})
