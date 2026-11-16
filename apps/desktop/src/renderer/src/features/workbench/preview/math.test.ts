import assert from 'node:assert/strict'
import test from 'node:test'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

import { mathPreview, MATHML_NS, WORD_MATH_NS } from './math.ts'

Object.assign(globalThis, { DOMParser, XMLSerializer })

function xml(value: string): XMLDocument {
  return new DOMParser().parseFromString(value, 'application/xml') as unknown as XMLDocument
}

function archive(math: string, prefix = 'm'): Uint8Array {
  return zipSync({
    'word/document.xml': strToU8(
      `<root xmlns:${prefix}="${WORD_MATH_NS}"><${prefix}:oMath>${math}</${prefix}:oMath></root>`
    ),
    'word/styles.xml': strToU8('<styles>unchanged</styles>'),
  })
}

function run(text: string, prefix = 'm'): string {
  return `<${prefix}:r><${prefix}:t>${text}</${prefix}:t></${prefix}:r>`
}

function scripts(prefix = 'm'): string {
  return `<${prefix}:sSubSup><${prefix}:e>${run('3', prefix)}</${prefix}:e><${prefix}:sub>${run('−0.4', prefix)}</${prefix}:sub><${prefix}:sup>${run('+0.6', prefix)}</${prefix}:sup></${prefix}:sSubSup>`
}

function marker(bytes: Uint8Array): string {
  return (
    xml(strFromU8(unzipSync(bytes)['word/document.xml'])).getElementsByTagNameNS(
      WORD_MATH_NS,
      'oMath'
    )[0].textContent ?? ''
  )
}

function rendered(token: string, namespace = MATHML_NS): Element {
  return xml(`<root><math xmlns="${namespace}"><mi>${token}</mi></math></root>`).documentElement
}

for (const prefix of ['m', 'equations']) {
  test(`combined scripts preserve operands and role order with ${prefix} namespace`, () => {
    const source = archive(run('1.2', prefix) + scripts(prefix), prefix)
    const before = Uint8Array.from(source)
    const projected = mathPreview(source)
    const token = marker(projected.bytes)
    const root = projected.restore([rendered(token)])[0] as Element
    const combined = root.getElementsByTagNameNS(MATHML_NS, 'msubsup')[0]
    assert.deepEqual(
      Array.from(combined.childNodes).map((node) => node.textContent),
      ['3', '−0.4', '+0.6']
    )
    assert.equal(root.textContent, '1.23−0.4+0.6')
    assert.ok(!root.textContent.includes(token))
    assert.deepEqual(source, before)
    assert.deepEqual(
      unzipSync(projected.bytes)['word/styles.xml'],
      unzipSync(source)['word/styles.xml']
    )
  })
}

test('natural nested scripts keep their source tree beside combined scripts', () => {
  const nested = `<m:sSup><m:e><m:sSub><m:e>${run('x')}</m:e><m:sub>${run('i')}</m:sub></m:sSub></m:e><m:sup>${run('2')}</m:sup></m:sSup>`
  const projected = mathPreview(archive(nested + scripts()))
  const root = projected.restore([rendered(marker(projected.bytes))])[0] as Element
  const outer = root.getElementsByTagNameNS(MATHML_NS, 'msup')[0]
  assert.equal(outer.getElementsByTagNameNS(MATHML_NS, 'msub').length, 1)
  assert.equal(root.getElementsByTagNameNS(MATHML_NS, 'msubsup').length, 1)
})

test('namespace identity is parsed rather than matched as raw URI bytes', () => {
  const parts = unzipSync(archive(scripts()))
  parts['word/document.xml'] = strToU8(
    strFromU8(parts['word/document.xml']).replace('/2006/math', '/20&#48;6/math')
  )
  const projected = mathPreview(zipSync(parts))
  const result = projected.restore([rendered(marker(projected.bytes))])[0] as Element
  assert.equal(result.getElementsByTagNameNS(MATHML_NS, 'msubsup').length, 1)
})

test('whole-root projection preserves accents, fractions, roots and composed fonts', () => {
  const styled = '<m:r><m:rPr><m:sty m:val="b"/><m:scr m:val="script"/></m:rPr><m:t>F</m:t></m:r>'
  const accent = `<m:acc><m:accPr><m:chr m:val="&#x0303;"/></m:accPr><m:e>${styled}</m:e></m:acc>`
  const fraction = `<m:f><m:num>${run('a')}</m:num><m:den>${run('b')}</m:den></m:f>`
  const squareRoot = `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${run('z')}</m:e></m:rad>`
  const projected = mathPreview(archive(accent + fraction + squareRoot))
  const root = projected.restore([rendered(marker(projected.bytes))])[0] as Element
  assert.equal(root.getElementsByTagNameNS(MATHML_NS, 'mover')[0].textContent, 'ℱ\u0303')
  assert.ok(
    root
      .getElementsByTagNameNS(MATHML_NS, 'mtext')[0]
      .getAttribute('style')
      ?.includes('font-weight:bold')
  )
  assert.deepEqual(
    Array.from(root.getElementsByTagNameNS(MATHML_NS, 'mfrac')[0].childNodes).map(
      (node) => node.textContent
    ),
    ['a', 'b']
  )
  assert.equal(root.getElementsByTagNameNS(MATHML_NS, 'msqrt')[0].textContent, 'z')
})

test('one source root can be absent or repeated by pagination without moving its operands', () => {
  const projected = mathPreview(archive(scripts()))
  const token = marker(projected.bytes)
  const root = xml(
    `<root><math xmlns="${MATHML_NS}"><mi>${token}</mi></math><math xmlns="${MATHML_NS}"><mi>${token}</mi></math></root>`
  ).documentElement
  const result = projected.restore([root])[0] as Element
  assert.equal(result.getElementsByTagNameNS(MATHML_NS, 'msubsup').length, 2)
  assert.equal(result.textContent, '3−0.4+0.63−0.4+0.6')
  assert.equal(
    projected.restore([xml('<root>hidden revision</root>').documentElement])[0].textContent,
    'hidden revision'
  )
})

test('script and fraktur retain explicitly combined italic styling', () => {
  for (const script of ['script', 'fraktur']) {
    for (const style of ['i', 'bi']) {
      const text = `<m:r><m:rPr><m:sty m:val="${style}"/><m:scr m:val="${script}"/></m:rPr><m:t>F</m:t></m:r>`
      const projected = mathPreview(archive(scripts() + text))
      const result = projected.restore([rendered(marker(projected.bytes))])[0] as Element
      const runs = Array.from(result.getElementsByTagNameNS(MATHML_NS, 'mtext'))
      const value = runs.find((node) => node.textContent === (script === 'script' ? 'ℱ' : '𝔉'))!
      assert.ok(value.getAttribute('style')?.includes('font-style:italic'))
      assert.equal(
        Boolean(value.getAttribute('style')?.includes('font-weight:bold')),
        style === 'bi'
      )
    }
  }
})

test('unrestored or misplaced identities fail before mounting', () => {
  const projected = mathPreview(archive(scripts()))
  const token = marker(projected.bytes)
  assert.throws(() => projected.restore([rendered(`${token}unexpected`)]), /Unresolved/)
  assert.throws(() => projected.restore([rendered(token, 'urn:wrong')]), /Unresolved/)
  const split = xml(
    `<root><math xmlns="${MATHML_NS}"><mi>${token.slice(0, 20)}</mi><mi>${token.slice(20)}</mi></math></root>`
  ).documentElement
  assert.equal(
    (projected.restore([split])[0] as Element).getElementsByTagNameNS(MATHML_NS, 'msubsup').length,
    1
  )
})

test('unhandled nested structures are rejected instead of dropping their content', () => {
  const projected = mathPreview(
    archive(`<m:acc><m:e><m:unknown>${run('important')}</m:unknown></m:e></m:acc>`)
  )
  assert.throws(
    () => projected.restore([rendered(marker(projected.bytes))]),
    /Unsupported equation/
  )
})

test('extra shape children and properties cannot silently disappear', () => {
  for (const value of [
    scripts().replace('</m:sSubSup>', `<m:foo>${run('LOST')}</m:foo></m:sSubSup>`),
    scripts().replace('<m:sSubSup>', '<m:sSubSup m:unknown="LOST">'),
    scripts().replace('<m:e>', '<m:sSubSupPr><m:unknown m:val="1"/></m:sSubSupPr><m:e>'),
    scripts() +
      `<m:f><m:fPr><m:type m:val="lin"/></m:fPr><m:num>${run('a')}</m:num><m:den>${run('b')}</m:den></m:f>`,
    scripts() + `<m:r><m:rPr><m:sty m:val="unknown"/></m:rPr><m:t>x</m:t></m:r>`,
  ]) {
    const projected = mathPreview(archive(value))
    assert.throws(
      () => projected.restore([rendered(marker(projected.bytes))]),
      /Unsupported equation/
    )
  }
})

test('healthy reader mathematics uses its existing bytes and rendering path', () => {
  const source = archive(`<m:sSub><m:e>${run('x')}</m:e><m:sub>${run('i')}</m:sub></m:sSub>`)
  const projected = mathPreview(source)
  assert.equal(projected.bytes, source)
  const node = rendered('native reader content')
  assert.equal(projected.restore([node])[0], node)
})
