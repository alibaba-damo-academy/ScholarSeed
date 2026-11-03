import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parsePdfeManifest,
  pdfeTargetUrl,
  readPdfeTarget,
  isPdfeTargetUrl,
  pdfeDockWidth,
} from './pdfe.ts'

const manifest = {
  schema: 1,
  origin: 'http://127.0.0.1:5175',
  instance: 'native-owned',
  initial: { pageId: 'page-home', sceneId: 'home-browse' },
  pages: [
    { id: 'page-home', scenes: ['home-browse'], available: true, components: false },
    {
      id: 'development-components',
      scenes: ['components-states'],
      available: true,
      components: true,
    },
    { id: 'page-placeholder', scenes: ['placeholder'], available: false, components: false },
  ],
}

test('PDFE dock width rejects invalid IPC data and clamps to its native container', () => {
  assert.equal(pdfeDockWidth(1280, 420), 420)
  assert.equal(pdfeDockWidth(1280, 100), 320)
  assert.equal(pdfeDockWidth(1280, 900), 640)
  assert.equal(pdfeDockWidth(1040, 900), 520)
  for (const width of [null, '420', NaN, Infinity, {}])
    assert.throws(() => pdfeDockWidth(1280, width))
  for (const available of [0, -1, NaN, Infinity]) assert.throws(() => pdfeDockWidth(available, 420))
})

test('native PDFE accepts only frozen same-origin catalog targets, never renderer-provided URLs', () => {
  const parsed = parsePdfeManifest(manifest)
  const target = readPdfeTarget(parsed, {
    pageId: 'development-components',
    sceneId: 'components-states',
  })
  const url = pdfeTargetUrl(parsed, target, 'product')
  assert.equal(url.origin, manifest.origin)
  assert.equal(url.searchParams.get('dev'), 'components')
  assert.equal(url.searchParams.get('pdfe'), 'product')
  assert.equal(url.searchParams.get('previewInstance'), manifest.instance)
  assert.equal(pdfeTargetUrl(parsed, parsed.initial, 'controls').searchParams.has('dev'), false)
  for (const value of [
    null,
    {},
    { pageId: 'page-home', sceneId: 'other' },
    { pageId: 'page-placeholder', sceneId: 'placeholder' },
    { pageId: 'page-home', sceneId: 'home-browse', url: 'https://foreign.test' },
  ]) {
    assert.throws(() => readPdfeTarget(parsed, value))
  }
})

test('native PDFE rejects foreign origins, credentials, duplicate catalog identities and missing initial scenes', () => {
  for (const origin of [
    'https://foreign.test',
    'http://localhost:5175',
    'http://user@127.0.0.1:5175',
    'http://127.0.0.1:5175/path',
  ])
    assert.throws(() => parsePdfeManifest({ ...manifest, origin }))
  assert.throws(() =>
    parsePdfeManifest({ ...manifest, pages: [...manifest.pages, manifest.pages[0]] })
  )
  assert.throws(() =>
    parsePdfeManifest({ ...manifest, initial: { pageId: 'page-home', sceneId: 'other' } })
  )
  assert.throws(() => parsePdfeManifest({ ...manifest, instance: '../personal' }))
})

test('native sender URLs bind the role, instance and complete query while preserving in-document anchors', () => {
  const parsed = parsePdfeManifest(manifest)
  const product = pdfeTargetUrl(parsed, parsed.initial, 'product')
  assert.equal(isPdfeTargetUrl(parsed, product.href, 'product'), true)
  assert.equal(isPdfeTargetUrl(parsed, product.href + '#main-content', 'product'), true)
  assert.equal(isPdfeTargetUrl(parsed, product.href, 'controls'), false)
  for (const query of ['&previewInstance=foreign', '&unexpected=value', '&page=page-home'])
    assert.equal(isPdfeTargetUrl(parsed, product.href + query, 'product'), false)
  product.username = 'foreign'
  assert.equal(isPdfeTargetUrl(parsed, product.href, 'product'), false)
})
