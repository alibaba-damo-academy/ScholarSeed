import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('citation evidence renders the server projection and keeps an explicit original entry', () => {
  const source = readFileSync(new URL('./Citations.tsx', import.meta.url), 'utf8')

  assert.match(source, /presentation\.mode === 'structured_text'/)
  assert.match(source, /presentation\.mode === 'region_image'/)
  assert.match(source, /presentation\.precision === 'page'/)
  assert.match(source, /citations\.manualCheck/)
  assert.match(source, /citations\.displayUnavailable/)
  assert.match(source, /citations\.viewOriginal/)
  assert.match(source, /\[overflow-wrap:break-word\]/)
  assert.doesNotMatch(source, /whitespace-pre-wrap \[overflow-wrap:anywhere\]/)
})

test('source popover renders a directory and defers evidence to each citation card', () => {
  const source = readFileSync(new URL('./Citations.tsx', import.meta.url), 'utf8')
  const directory = source.slice(source.indexOf('projected.map'), source.indexOf('</PopoverContent></Popover></div>'))

  assert.match(directory, /data-citation-source-entry/)
  assert.match(source, /role="list" tabIndex=\{0\}/)
  assert.match(source, /citations\.sourceCount/)
  assert.match(directory, /role="listitem"/)
  assert.match(directory, /<CitationLink/)
  assert.match(directory, /<WebCitationLink/)
  assert.doesNotMatch(directory, /<EvidenceContent/)
})

test('web citations reuse the citation trigger and open only the projected source URL', () => {
  const source = readFileSync(new URL('./Citations.tsx', import.meta.url), 'utf8')

  assert.match(source, /function openWebSource/)
  assert.match(source, /window\.scholarseed\.openExternal\(url\)/)
  assert.match(source, /NUMBERED_CITATION_CLASS/)
  assert.doesNotMatch(source, /NUMBERED_CITATION_CLASS = 'ml-0\.5/)
  assert.match(source, /source\.search_kind === 'paper'/)
  assert.match(source, /\{source\.url\}/)
  assert.match(source, /<PopoverTrigger asChild>/)
  assert.doesNotMatch(source, /onClick=\{\(\) => openWebSource\(source\.url\)\}.*data-citation-label/)
})

test('Markdown offers only registered citation URLs to the citation renderer', () => {
  const source = readFileSync(new URL('../../components/primitive/Markdown.tsx', import.meta.url), 'utf8')
  const anchor = source.slice(source.indexOf("a: ({ node: _node"), source.indexOf("img: ({ node: _node"))

  assert.match(anchor, /isCitationUrl\(href\)/)
  assert.match(anchor, /citationUrls\.has\(href\)/)
})
