import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { citationDisplay } from './display.ts'

test('citation URLs decode Chinese paths, queries and fragments for display', () => {
  const url = 'https://example.com/%E4%B8%AD%E6%96%87?q=%E6%9D%A5%E6%BA%90#%E7%89%87%E6%AE%B5'
  assert.deepEqual(citationDisplay({ title: url, url }), {
    title: 'https://example.com/中文?q=来源#片段',
    url: 'https://example.com/中文?q=来源#片段',
  })
})

test('citation display preserves native Chinese and English URLs', () => {
  for (const url of [
    'https://example.com/中文?q=来源#片段',
    'https://example.com/source?q=paper#part',
  ]) {
    assert.deepEqual(citationDisplay({ title: url, url }), { title: url, url })
  }
})

test('only URL fallback titles are decoded, including surrounding whitespace', () => {
  const url = 'https://example.com/%E4%B8%AD'
  assert.equal(citationDisplay({ title: ` ${url} `, url }).title, 'https://example.com/中')
  const title = '中文页面 100% %E4%B8%AD'
  assert.deepEqual(citationDisplay({ title, url }), { title, url: 'https://example.com/中' })
})

test('citation display preserves encoded URI delimiters', () => {
  const url = 'https://example.com/%E4%B8%AD%2F%3F%23%26%3D%3B%2C%3A%40%2B%24'
  const readable = 'https://example.com/中%2F%3F%23%26%3D%3B%2C%3A%40%2B%24'
  assert.deepEqual(citationDisplay({ title: url, url }), { title: readable, url: readable })
})

test('malformed citation URL encodings fall back without throwing', () => {
  for (const suffix of ['%E4%B8', '%ZZ', '%', '%FF', '%E4%B8%AD%']) {
    const url = `https://example.com/${suffix}`
    assert.deepEqual(citationDisplay({ title: url, url }), { title: url, url })
  }
})

test('citation display decodes only one layer', () => {
  const url = 'https://example.com/%25E4%25B8%25AD'
  const readable = 'https://example.com/%E4%B8%AD'
  assert.deepEqual(citationDisplay({ title: url, url }), { title: readable, url: readable })
})

test('citation URLs that decode to control characters retain the original text', () => {
  for (const suffix of ['%00', '%09', '%0A', '%0D', '%1F', '%7F', '%C2%80', '%C2%9F']) {
    const url = `https://example.com/%E4%B8%AD${suffix}`
    assert.deepEqual(citationDisplay({ title: url, url }), { title: url, url })
  }
})

test('citation display does not change the source or its citation matching URLs', () => {
  const url = 'https://example.com/%E4%B8%AD'
  const source = Object.freeze({ title: url, url, citation_urls: Object.freeze([url]) })
  citationDisplay(source)
  assert.deepEqual(source, { title: url, url, citation_urls: [url] })
})

test('citation evidence renders the server projection and keeps an explicit original entry', () => {
  const source =
    readFileSync(new URL('./Citations.tsx', import.meta.url), 'utf8') +
    '\n' +
    readFileSync(new URL('../../components/business/Citation.tsx', import.meta.url), 'utf8')

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
  const source =
    readFileSync(new URL('./Citations.tsx', import.meta.url), 'utf8') +
    '\n' +
    readFileSync(new URL('../../components/business/Citation.tsx', import.meta.url), 'utf8')
  const directory = source.slice(
    source.indexOf('projected.map'),
    source.indexOf('</PopoverContent></Popover></div>')
  )

  assert.match(directory, /data-citation-source-entry/)
  assert.match(source, /role="list"\s+tabIndex=\{0\}/)
  assert.match(source, /citations\.sourceCount/)
  assert.match(directory, /role="listitem"/)
  assert.match(directory, /<CitationLink/)
  assert.match(directory, /<WebCitationLink/)
  assert.doesNotMatch(directory, /<EvidenceContent/)
})

test('web citations reuse the citation trigger and open only the projected source URL', () => {
  const source =
    readFileSync(new URL('./Citations.tsx', import.meta.url), 'utf8') +
    '\n' +
    readFileSync(new URL('../../components/business/Citation.tsx', import.meta.url), 'utf8')

  assert.match(source, /function openWebSource/)
  assert.match(source, /window\.scholarseed\.openExternal\(url\)/)
  assert.match(source, /NUMBERED_CITATION_CLASS/)
  assert.doesNotMatch(source, /NUMBERED_CITATION_CLASS = 'ml-0\.5/)
  assert.match(source, /source\.search_kind === 'paper'/)
  assert.match(source, /onClick=\{\(\) => openWebSource\(source\.url\)\}/)
  assert.match(source, /<PopoverTrigger asChild>/)
  assert.doesNotMatch(
    source,
    /onClick=\{\(\) => openWebSource\(source\.url\)\}.*data-citation-label/
  )
})

test('Markdown offers only registered citation URLs to the citation renderer', () => {
  const source = readFileSync(
    new URL('../../components/primitive/Markdown.tsx', import.meta.url),
    'utf8'
  )
  const anchor = source.slice(
    source.indexOf('a: ({ node: _node'),
    source.indexOf('img: ({ node: _node')
  )

  assert.match(anchor, /properties\[CITATION_MARKER\]/)
  assert.doesNotMatch(anchor, /citationUrls\.has\(href\)/)
})

test('citation adapters retain answer hashing, range binding and authenticated navigation outside shared views', () => {
  const host = readFileSync(new URL('./Citations.tsx', import.meta.url), 'utf8')
  const view = readFileSync(
    new URL('../../components/business/Citation.tsx', import.meta.url),
    'utf8'
  )
  assert.match(host, /await sha256Text\(text\)/)
  assert.match(host, /range\?\.start \?\? 0/)
  assert.match(host, /range\?\.end \?\? 0/)
  assert.match(host, /workspace\.revealCitation\(source, source\.matches\[0\]\)/)
  assert.match(host, /previewUrl=\{citationPreviewUrl\}/)
  assert.doesNotMatch(
    view,
    /window\.scholarseed|resolveCitation|sha256Text|from ['"].*\/(?:api|store|workspace)['"]|useApp\(/
  )
})
