import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('search results use overlay scrollbars without asymmetric gutter compensation', () => {
  const source = readFileSync(new URL('./Matches.tsx', import.meta.url), 'utf8')
  assert.match(source, /<ScrollArea\s+overlay\s+overlayScrollOnly/)
  assert.match(source, /viewportClassName="[^"]*px-\[var\(--vds-space-5\)\]/)
  assert.doesNotMatch(source, /\[scrollbar-gutter:stable\]|--vds-native-scrollbar-size/)
})

test('recommendations and abstracts fill the available row height and remain scrollable', () => {
  const source = readFileSync(new URL('./Matches.tsx', import.meta.url), 'utf8')
  assert.match(source, /<p tabIndex=\{0\} className=\{RESULT_BODY_CELL_CLASS\}>\s*\{paper\.reason/)
  assert.match(
    source,
    /<p tabIndex=\{0\} className=\{RESULT_BODY_CELL_CLASS\}>\s*\{paper\.abstract/
  )
  assert.match(source, /const RESULT_BODY_CELL_CLASS =\s*'[^']*self-stretch overflow-y-auto/)
})

test('search results retain only selection actions above the table', () => {
  const source = readFileSync(new URL('./Matches.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /i18nKey="search.summary"/)
  assert.doesNotMatch(source, /t\('search.paperCount'/)
  assert.doesNotMatch(source, /t\('search.output'\)/)
  assert.doesNotMatch(source, /<Collapsible/)
  const header = source.slice(source.indexOf('<header'), source.indexOf('</header>'))
  assert.doesNotMatch(header, /SEARCH_STATUS_KEYS|<h1|<Tag/)
  assert.doesNotMatch(source, /picked\.length > 0 \? \(\s*<header/)
  assert.match(source, /new Set\(papers\.map\(\(paper\) => paper\.paper_id\)\)/)
  assert.match(source, /selectionInitialized\.current \|\| papers\.length === 0/)
  assert.match(header, /disabled=\{exporting \|\| picked\.length === 0 \|\| !actions\.saveBibtex\}/)
  const joining = readFileSync(new URL('./JoinMenu.tsx', import.meta.url), 'utf8')
  assert.match(joining, /disabled=\{busy \|\| papers\.length === 0\}/)
  assert.doesNotMatch(header, /t\('batch.selected', \{ count: picked.length \}\)/)
  assert.match(header, /data-testid="search-export-bib"/)
  assert.match(source, /const joinable = picked\.filter\(canJoin\)/)
  assert.match(header, /<JoinBatch\s+papers=\{joinable\}/)
  assert.match(header, /<JoinLibraryMenu\s+papers=\{joinable\}/)
  assert.doesNotMatch(source, /<JoinLibraryMenu[\s\S]*?papers=\{\[(?:paper|focused)\]\}/)
  assert.match(source, /data-testid="literature-search-tab"/)
  assert.match(source, /<Alert tone="error" title=\{t\('search.streamFailed'\)\}/)
  assert.match(source, /description=\{failureMessage \?\? error\}/)
  const tableHeader = source.slice(
    source.indexOf('data-testid="search-table-header"'),
    source.indexOf('<Checkbox', source.indexOf('data-testid="search-table-header"'))
  )
  assert.match(tableHeader, /bg-\[var\(--vds-fill-4\)\]/)
  assert.match(tableHeader, /text-\[length:var\(--vds-font-body-lv2\)\]/)
  assert.match(tableHeader, /text-\[var\(--vds-text-tertiary\)\]/)
  assert.match(source, /<section className="[^"]*bg-transparent"/)
  const bodyCell = source.slice(
    source.indexOf('const RESULT_BODY_CELL_CLASS'),
    source.indexOf('export type ResultColumnSet')
  )
  assert.match(bodyCell, /text-\[length:var\(--vds-font-body-lv2\)\]/)
  assert.match(bodyCell, /text-\[var\(--vds-text-primary\)\]/)
  assert.match(bodyCell, /font-\[number:var\(--vds-fw-regular\)\]/)
  const metadata = source.slice(
    source.indexOf('function PaperMetadata'),
    source.indexOf('function PaperSourceLink')
  )
  assert.match(metadata, /identifiers\.push\(/)
  assert.match(metadata, /data-testid="search-paper-identifiers"/)
  assert.doesNotMatch(metadata, /text-\[var\(--vds-text-secondary\)\]/)
  assert.match(metadata, /text-\[length:var\(--vds-font-body-lv1\)\]/)
  assert.match(
    source,
    /<strong className="line-clamp-2 text-\[length:var\(--vds-font-body-lv2\)\] font-\[var\(--vds-fw-medium\)\] text-\[var\(--vds-text-primary\)\]"/
  )
})
